import Dexie from 'dexie';
import { db } from '../../src/storage/db';
import {
  ACCOUNT_COLORS,
  AccountError,
  DEFAULT_ACCOUNT_NAME,
  accountScopedTables,
  createAccount,
  deleteAccount,
  ensureDefaultAccount,
  getActiveAccount,
  listAccounts,
  normalizeUsername,
  setActiveAccount,
  updateAccount,
} from '../../src/storage/accounts';
import { getSettings, updateSettings } from '../../src/storage/settings';

// The core has no account-scoped table besides `spend`, so a later part's table is simulated here:
// `notes` has an `accountId` index and must be wiped together with its account.
beforeAll(() => {
  db.close();
  db.version(2).stores({ notes: '++id, accountId' });
});

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const spendFor = (accountId: string) => ({
  ts: Date.now(),
  accountId,
  purpose: 'x',
  model: 'm',
  promptTokens: 1,
  completionTokens: 1,
  costUsd: 0.01,
});

const LAST_ACCOUNT = 'Нельзя удалить последний аккаунт';
const NOT_FOUND = 'Аккаунт не найден';
const BAD_NAME = 'Имя аккаунта — от 1 до 40 символов';
const BAD_USERNAME = 'Неверный @username';
const TAKEN_USERNAME = 'Этот @username уже привязан к другому аккаунту';

describe('constants', () => {
  it('names the default account «Основной»', () => expect(DEFAULT_ACCOUNT_NAME).toBe('Основной'));

  it('has 8 distinct colors', () => {
    expect(ACCOUNT_COLORS).toHaveLength(8);
    expect(new Set(ACCOUNT_COLORS).size).toBe(8);
  });

  it('AccountError is an Error with its own name', () => {
    const error = new AccountError('x');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AccountError');
    expect(error.message).toBe('x');
  });
});

describe('normalizeUsername', () => {
  it.each([
    [' @John.Doe_1 ', 'john.doe_1'],
    ['', ''],
    ['@', ''],
    ['   ', ''],
    [' @ ', ''],
    ['kino', 'kino'],
    ['a'.repeat(30), 'a'.repeat(30)],
  ])('normalizes username %j', (input, output) => expect(normalizeUsername(input)).toBe(output));

  it.each(['john doe', 'a'.repeat(31), '@@john', 'jöhn', 'john-doe', 'jo/hn', '@ john'])(
    'rejects %j',
    (input) => {
      expect(() => normalizeUsername(input)).toThrow(AccountError);
      expect(() => normalizeUsername(input)).toThrow(BAD_USERNAME);
    },
  );
});

describe('ensureDefaultAccount', () => {
  it('creates «Основной» when there are no accounts', async () => {
    const account = await ensureDefaultAccount();
    expect(account).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Основной',
      threadsUsername: '',
      color: ACCOUNT_COLORS[0],
      createdAt: expect.any(Number),
    });
    expect(await db.accounts.toArray()).toEqual([account]);
  });

  it('returns the earliest account and creates nothing when accounts exist', async () => {
    const first = await createAccount({ name: 'Кино' });
    await createAccount({ name: 'Игры' });
    expect(await ensureDefaultAccount()).toEqual(first);
    expect(await db.accounts.count()).toBe(2);
  });

  it('does not create two «Основной» accounts when called concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureDefaultAccount()));
    expect(await db.accounts.count()).toBe(1);
    expect(new Set(results.map((account) => account.id)).size).toBe(1);
  });
});

describe('getActiveAccount', () => {
  it('creates «Основной» on first access and makes it active', async () => {
    const a = await getActiveAccount();
    expect(a.name).toBe('Основной');
    expect((await getSettings()).activeAccountId).toBe(a.id);
  });

  it('returns the account the settings point to', async () => {
    await ensureDefaultAccount();
    const b = await createAccount({ name: 'B' });
    await updateSettings({ activeAccountId: b.id });
    expect(await getActiveAccount()).toEqual(b);
    expect((await getSettings()).activeAccountId).toBe(b.id);
  });

  it('recovers when the active id points nowhere', async () => {
    const main = await ensureDefaultAccount();
    await createAccount({ name: 'B' });
    await updateSettings({ activeAccountId: 'gone' });
    expect((await getActiveAccount()).id).toBe(main.id);
    expect((await getSettings()).activeAccountId).toBe(main.id);
  });

  it('picks the earliest account when none is selected yet', async () => {
    const first = await createAccount({ name: 'Первый' });
    await createAccount({ name: 'Второй' });
    expect((await getActiveAccount()).id).toBe(first.id);
    expect((await getSettings()).activeAccountId).toBe(first.id);
  });
});

describe('setActiveAccount', () => {
  it('stores the id in the settings', async () => {
    await ensureDefaultAccount();
    const b = await createAccount({ name: 'B' });
    await setActiveAccount(b.id);
    expect((await getSettings()).activeAccountId).toBe(b.id);
    expect((await getActiveAccount()).id).toBe(b.id);
  });

  it('rejects an unknown account and leaves the selection alone', async () => {
    const main = await getActiveAccount();
    await expect(setActiveAccount('gone')).rejects.toThrow(NOT_FOUND);
    await expect(setActiveAccount('gone')).rejects.toBeInstanceOf(AccountError);
    expect((await getSettings()).activeAccountId).toBe(main.id);
  });
});

describe('createAccount', () => {
  it('stores a trimmed name and a normalized @username', async () => {
    const account = await createAccount({ name: '  Кино  ', threadsUsername: ' @Kino.Daily ' });
    expect(account).toMatchObject({ name: 'Кино', threadsUsername: 'kino.daily' });
    expect(account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.accounts.get(account.id)).toEqual(account);
  });

  it('leaves the @username empty when it is omitted', async () => {
    expect((await createAccount({ name: 'Кино' })).threadsUsername).toBe('');
  });

  it('accepts names of 1 and 40 characters', async () => {
    expect((await createAccount({ name: 'я' })).name).toBe('я');
    expect((await createAccount({ name: 'я'.repeat(40) })).name).toBe('я'.repeat(40));
  });

  it('rejects a bad username, a duplicate username and a bad name', async () => {
    expect(() => normalizeUsername('john doe')).toThrow('Неверный @username');
    await createAccount({ name: 'Кино', threadsUsername: 'kino' });
    await expect(createAccount({ name: 'Ещё', threadsUsername: '@KINO' })).rejects.toThrow(TAKEN_USERNAME);
    await expect(createAccount({ name: '   ' })).rejects.toThrow(BAD_NAME);
  });

  it('rejects an empty name, a 41-character name and a malformed @username with AccountError', async () => {
    await expect(createAccount({ name: '' })).rejects.toBeInstanceOf(AccountError);
    await expect(createAccount({ name: 'я'.repeat(41) })).rejects.toThrow(BAD_NAME);
    await expect(createAccount({ name: 'Кино', threadsUsername: 'john doe' })).rejects.toThrow(BAD_USERNAME);
    expect(await db.accounts.count()).toBe(0);
  });

  it('lets any number of accounts have no @username', async () => {
    await createAccount({ name: 'A' });
    await createAccount({ name: 'B', threadsUsername: '' });
    await createAccount({ name: 'C', threadsUsername: '@' });
    expect(await db.accounts.count()).toBe(3);
  });

  it('assigns colors in a cycle', async () => {
    const accounts = [await ensureDefaultAccount()];
    for (let i = 1; i < 9; i++) accounts.push(await createAccount({ name: `Аккаунт ${i}` }));
    expect(accounts.map((account) => account.color)).toEqual(
      Array.from({ length: 9 }, (_, i) => ACCOUNT_COLORS[i % 8]),
    );
    expect(accounts[8]?.color).toBe(ACCOUNT_COLORS[0]);
  });

  it('gives strictly increasing createdAt even when the clock does not move', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const first = await createAccount({ name: 'A' });
    const second = await createAccount({ name: 'B' });
    const third = await createAccount({ name: 'C' });
    expect([first.createdAt, second.createdAt, third.createdAt]).toEqual([1_000_000, 1_000_001, 1_000_002]);
    expect((await listAccounts()).map((account) => account.name)).toEqual(['A', 'B', 'C']);
  });

  it('does not let the clock go backwards past an existing account', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    await createAccount({ name: 'A' });
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const later = await createAccount({ name: 'B' });
    expect(later.createdAt).toBe(5_001);
  });

  it('keeps usernames unique when created concurrently', async () => {
    const results = await Promise.allSettled([
      createAccount({ name: 'A', threadsUsername: 'same' }),
      createAccount({ name: 'B', threadsUsername: '@SAME' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await db.accounts.count()).toBe(1);
  });
});

describe('listAccounts', () => {
  it('is empty before the first account', async () => expect(await listAccounts()).toEqual([]));

  it('returns accounts by createdAt, oldest first', async () => {
    await db.accounts.bulkAdd([
      { id: 'c', name: 'C', threadsUsername: '', color: '#000', createdAt: 30 },
      { id: 'a', name: 'A', threadsUsername: '', color: '#000', createdAt: 10 },
      { id: 'b', name: 'B', threadsUsername: '', color: '#000', createdAt: 20 },
    ]);
    expect((await listAccounts()).map((account) => account.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('updateAccount', () => {
  it('renames an account (trimmed) and returns it', async () => {
    const account = await createAccount({ name: 'Старое' });
    const updated = await updateAccount(account.id, { name: '  Новое  ' });
    expect(updated).toEqual({ ...account, name: 'Новое' });
    expect(await db.accounts.get(account.id)).toEqual(updated);
  });

  it('changes and clears the @username', async () => {
    const account = await createAccount({ name: 'A', threadsUsername: 'old' });
    expect((await updateAccount(account.id, { threadsUsername: ' @New.Name ' })).threadsUsername).toBe('new.name');
    expect((await updateAccount(account.id, { threadsUsername: '' })).threadsUsername).toBe('');
  });

  it('changes only the fields in the patch', async () => {
    const account = await createAccount({ name: 'A', threadsUsername: 'keep' });
    expect(await updateAccount(account.id, { name: 'B' })).toEqual({ ...account, name: 'B' });
    expect(await updateAccount(account.id, {})).toEqual({ ...account, name: 'B' });
  });

  it('may keep its own @username but not take another account’s', async () => {
    const a = await createAccount({ name: 'A', threadsUsername: 'alpha' });
    await createAccount({ name: 'B', threadsUsername: 'beta' });
    expect((await updateAccount(a.id, { threadsUsername: '@ALPHA' })).threadsUsername).toBe('alpha');
    await expect(updateAccount(a.id, { threadsUsername: 'Beta' })).rejects.toThrow(TAKEN_USERNAME);
    expect((await db.accounts.get(a.id))?.threadsUsername).toBe('alpha');
  });

  it('rejects a bad name or username and changes nothing', async () => {
    const account = await createAccount({ name: 'A', threadsUsername: 'alpha' });
    await expect(updateAccount(account.id, { name: '  ' })).rejects.toThrow(BAD_NAME);
    await expect(updateAccount(account.id, { name: 'я'.repeat(41) })).rejects.toThrow(BAD_NAME);
    await expect(updateAccount(account.id, { threadsUsername: 'a b' })).rejects.toThrow(BAD_USERNAME);
    await expect(updateAccount(account.id, { name: 'Ok', threadsUsername: 'a b' })).rejects.toThrow(BAD_USERNAME);
    expect(await db.accounts.get(account.id)).toEqual(account);
  });

  it('rejects an unknown account', async () => {
    await expect(updateAccount('gone', { name: 'X' })).rejects.toThrow(NOT_FOUND);
    await expect(updateAccount('gone', { name: 'X' })).rejects.toBeInstanceOf(AccountError);
  });
});

describe('accountScopedTables', () => {
  it('finds accountId tables except spend', () => {
    const test = new Dexie('scoped-test');
    test.version(1).stores({ notes: '++id, accountId', spend: '++id, accountId', other: '++id' });
    expect(accountScopedTables(test).map((t) => t.name)).toEqual(['notes']);
  });

  it('ignores tables where accountId is not an index of its own', () => {
    const test = new Dexie('scoped-test-2');
    test.version(1).stores({ plain: '++id, createdAt', compound: '++id, [accountId+ts]' });
    expect(accountScopedTables(test)).toEqual([]);
  });

  it('sees the tables of the real database', () => {
    expect(accountScopedTables(db).map((t) => t.name)).toEqual(['notes']);
  });
});

describe('deleteAccount', () => {
  it('refuses to delete the last account', async () => {
    const a = await ensureDefaultAccount();
    await expect(deleteAccount(a.id)).rejects.toThrow(LAST_ACCOUNT);
    await expect(deleteAccount(a.id)).rejects.toBeInstanceOf(AccountError);
    expect(await db.accounts.count()).toBe(1);
  });

  it('rejects an unknown account, even when only one account exists', async () => {
    await ensureDefaultAccount();
    await expect(deleteAccount('gone')).rejects.toThrow(NOT_FOUND);
    expect(await db.accounts.count()).toBe(1);
  });

  it('deleting the active account activates the earliest remaining and keeps spend', async () => {
    const main = await ensureDefaultAccount();
    const b = await createAccount({ name: 'B' });
    await setActiveAccount(b.id);
    await db.spend.add({ ts: Date.now(), accountId: b.id, purpose: 'x', model: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.01 });
    await deleteAccount(b.id);
    expect((await getActiveAccount()).id).toBe(main.id);
    expect(await db.spend.count()).toBe(1);
    expect((await getSettings()).activeAccountId).toBe(main.id);
  });

  it('picks the earliest of the remaining accounts, not just any', async () => {
    const main = await ensureDefaultAccount();
    const b = await createAccount({ name: 'B' });
    const c = await createAccount({ name: 'C' });
    await setActiveAccount(main.id);
    await deleteAccount(main.id);
    expect((await getSettings()).activeAccountId).toBe(b.id);
    await setActiveAccount(c.id);
    await deleteAccount(c.id);
    expect((await getSettings()).activeAccountId).toBe(b.id);
  });

  it('leaves the active account alone when another one is deleted', async () => {
    await ensureDefaultAccount();
    const b = await createAccount({ name: 'B' });
    const c = await createAccount({ name: 'C' });
    await setActiveAccount(b.id);
    await deleteAccount(c.id);
    expect((await getSettings()).activeAccountId).toBe(b.id);
    expect((await listAccounts()).map((account) => account.id)).not.toContain(c.id);
  });

  it('deletes the rows of the account in account-scoped tables and nobody else’s', async () => {
    const main = await ensureDefaultAccount();
    const b = await createAccount({ name: 'B' });
    const notes = db.table('notes');
    await notes.bulkAdd([
      { accountId: b.id, text: 'b1' },
      { accountId: b.id, text: 'b2' },
      { accountId: main.id, text: 'main' },
    ]);
    await deleteAccount(b.id);
    expect((await notes.toArray()).map((row) => row.text)).toEqual(['main']);
    expect(await db.accounts.get(b.id)).toBeUndefined();
    expect(await db.accounts.get(main.id)).toBeDefined();
  });

  it('never touches spend, whoever the rows belong to', async () => {
    const main = await ensureDefaultAccount();
    const b = await createAccount({ name: 'B' });
    await db.spend.bulkAdd([spendFor(b.id), spendFor(b.id), spendFor(main.id)]);
    await deleteAccount(b.id);
    expect(await db.spend.count()).toBe(3);
  });

  it('is atomic: when removing the account fails, its rows stay', async () => {
    await ensureDefaultAccount();
    const b = await createAccount({ name: 'B' });
    await setActiveAccount(b.id);
    await db.table('notes').add({ accountId: b.id, text: 'b1' });
    vi.spyOn(db.accounts, 'delete').mockRejectedValueOnce(new Error('boom'));

    await expect(deleteAccount(b.id)).rejects.toThrow('boom');

    expect(await db.table('notes').count()).toBe(1);
    expect(await db.accounts.get(b.id)).toBeDefined();
    // The selection moves only after a successful transaction.
    expect((await getSettings()).activeAccountId).toBe(b.id);
  });
});
