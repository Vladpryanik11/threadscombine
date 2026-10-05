import { fakeBrowser } from 'wxt/testing/fake-browser';
import { db, type Account, type JournalEntry, type SpendRecord } from '../../src/storage/db';
import {
  BackupError,
  backupFileName,
  buildBackup,
  clearAllData,
  parseBackup,
  restoreBackup,
  type BackupFile,
} from '../../src/storage/backup';
import {
  createAccount,
  ensureDefaultAccount,
  getActiveAccount,
  listAccounts,
  setActiveAccount,
} from '../../src/storage/accounts';
import { listJournal, log } from '../../src/storage/journal';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../../src/storage/settings';

// A later part's table: the backup walks `db.tables`, so it must travel without any change in backup.ts.
// The version number is the test's own, far from any version a real part will declare.
beforeAll(() => {
  db.close();
  db.version(1000).stores({ notes: '++id, accountId' });
});

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOT_A_BACKUP = 'Это не файл резервной копии threadscombine';
const TOO_NEW = 'Файл из более новой версии расширения';
const IMPORT_FAILED = 'Не удалось импортировать файл';

const journalRow = (message: string, id?: number): JournalEntry => ({
  ...(id === undefined ? {} : { id }),
  ts: 1,
  level: 'info',
  area: 't',
  message,
});

const accountRow = (id: string, name: string, createdAt: number): Account => ({
  id,
  name,
  threadsUsername: '',
  color: '#3b82f6',
  createdAt,
});

const spendRow = (accountId: string): SpendRecord => ({
  ts: Date.now(),
  accountId,
  purpose: 'x',
  model: 'm',
  promptTokens: 1,
  completionTokens: 1,
  costUsd: 0.01,
});

/** A valid file with no rows; tests override the parts they care about. */
const fileWith = (patch: Partial<BackupFile> = {}): BackupFile => ({
  format: 'threadscombine-backup',
  formatVersion: 1,
  exportedAt: '2026-10-04T00:00:00.000Z',
  dbVersion: 1,
  settings: {},
  tables: { journal: [], accounts: [], spend: [] },
  ...patch,
});

const messages = async (): Promise<string[]> => (await listJournal(100)).map((e) => e.message);

describe('buildBackup', () => {
  it('exports all tables and hides the key unless asked', async () => {
    await updateSettings({ openRouterKey: 'sk-or-v1-x', model: 'a/b' });
    await log('info', 't', 'hello');
    await ensureDefaultAccount();
    const f = await buildBackup({ includeKey: false });
    expect(f).toMatchObject({ format: 'threadscombine-backup', formatVersion: 1, dbVersion: 1 });
    expect(f.settings.openRouterKey).toBeUndefined();
    expect(f.settings.model).toBe('a/b');
    expect(f.tables.journal).toHaveLength(1);
    expect(f.tables.accounts).toHaveLength(1);
    expect(f.tables).toHaveProperty('spend');
    expect((await buildBackup({ includeKey: true })).settings.openRouterKey).toBe('sk-or-v1-x');
  });

  it('puts a table of a later part into the file without any change', async () => {
    await db.table('notes').bulkAdd([{ accountId: 'a' }, { accountId: 'b' }]);
    expect((await buildBackup({ includeKey: false })).tables.notes).toHaveLength(2);
  });

  it('stamps the export time as an ISO date', async () => {
    const f = await buildBackup({ includeKey: false });
    expect(new Date(f.exportedAt).toISOString()).toBe(f.exportedAt);
  });
});

describe('backupFileName', () => {
  it('names the file by local date', () =>
    expect(backupFileName(new Date(2026, 9, 4))).toBe('threadscombine-backup-2026-10-04.json'));

  it('pads month and day', () =>
    expect(backupFileName(new Date(2026, 0, 5))).toBe('threadscombine-backup-2026-01-05.json'));
});

describe('parseBackup', () => {
  it.each(['not json', '{"foo":1}', JSON.stringify({ format: 'threadsai', tables: {} })])(
    'rejects a foreign file %s',
    (text) => expect(() => parseBackup(text)).toThrow(NOT_A_BACKUP),
  );

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', []],
    ['an unknown format', { ...fileWith(), format: 'other' }],
    ['formatVersion 2', { ...fileWith(), formatVersion: 2 }],
    ['a missing formatVersion', { ...fileWith(), formatVersion: undefined }],
    ['dbVersion 0', { ...fileWith(), dbVersion: 0 }],
    ['a fractional dbVersion', { ...fileWith(), dbVersion: 1.5 }],
    ['a string dbVersion', { ...fileWith(), dbVersion: '1' }],
    ['missing tables', { ...fileWith(), tables: undefined }],
    ['tables as an array', { ...fileWith(), tables: [] }],
    ['a table that is not an array', { ...fileWith(), tables: { journal: {} } }],
    ['settings that are not an object', { ...fileWith(), settings: 'x' }],
    ['a missing exportedAt', { ...fileWith(), exportedAt: undefined }],
  ])('rejects a file with %s', (_name, value) =>
    expect(() => parseBackup(JSON.stringify(value))).toThrow(NOT_A_BACKUP),
  );

  it('rejects a file from a newer version', () =>
    expect(() => parseBackup(JSON.stringify(fileWith({ dbVersion: 99 })))).toThrow(TOO_NEW));

  it('reads back what buildBackup wrote', async () => {
    await ensureDefaultAccount();
    await log('info', 't', 'hello');
    const file = await buildBackup({ includeKey: true });
    expect(parseBackup(JSON.stringify(file))).toEqual(JSON.parse(JSON.stringify(file)));
  });

  it('throws a BackupError', () => {
    expect(() => parseBackup('nope')).toThrow(BackupError);
  });
});

describe('restoreBackup', () => {
  it('replace restores data and settings but keeps the current key when the file has none', async () => {
    // The state that goes into the file.
    await ensureDefaultAccount();
    const work = await createAccount({ name: 'Рабочий', threadsUsername: 'work' });
    await setActiveAccount(work.id);
    await updateSettings({ openRouterKey: 'sk-or-v1-file', model: 'a/b', theme: 'dark', dailyBudgetUsd: 5 });
    await log('info', 't', 'from file');
    await db.spend.add(spendRow(work.id));
    await db.table('notes').add({ accountId: work.id, text: 'note' });
    const file = await buildBackup({ includeKey: false });

    // The state that gets replaced.
    await db.journal.clear();
    await log('info', 't', 'local');
    await db.accounts.clear();
    await db.spend.clear();
    await db.table('notes').clear();
    const local = await ensureDefaultAccount();
    await updateSettings({
      openRouterKey: 'sk-or-v1-local',
      model: 'c/d',
      theme: 'light',
      dailyBudgetUsd: null,
      activeAccountId: local.id,
    });

    expect(await restoreBackup(file, 'replace')).toEqual({ rows: 5 });

    expect(await messages()).toEqual(['from file']);
    expect((await listAccounts()).map((a) => a.name)).toEqual(['Основной', 'Рабочий']);
    expect(await db.spend.count()).toBe(1);
    expect(await db.table('notes').count()).toBe(1);
    expect(await getSettings()).toMatchObject({
      openRouterKey: 'sk-or-v1-local',
      model: 'a/b',
      theme: 'dark',
      dailyBudgetUsd: 5,
      activeAccountId: work.id,
    });
    expect((await getActiveAccount()).id).toBe(work.id);
  });

  it('replace takes the key from the file when it has one', async () => {
    await updateSettings({ openRouterKey: 'sk-or-v1-local' });
    const file = await buildBackup({ includeKey: true });
    await updateSettings({ openRouterKey: 'sk-or-v1-other' });
    await restoreBackup({ ...file, settings: { ...file.settings, openRouterKey: 'sk-or-v1-file' } }, 'replace');
    expect((await getSettings()).openRouterKey).toBe('sk-or-v1-file');
  });

  it('replace keeps the current key when the key in the file is empty', async () => {
    await updateSettings({ openRouterKey: 'sk-or-v1-local' });
    await restoreBackup(fileWith({ settings: { openRouterKey: '  ', model: 'a/b' } }), 'replace');
    expect(await getSettings()).toMatchObject({ openRouterKey: 'sk-or-v1-local', model: 'a/b' });
  });

  it('replace repairs broken settings from the file field by field', async () => {
    await updateSettings({ model: 'old/model', theme: 'dark' });
    await restoreBackup(
      fileWith({
        settings: { model: 'm/x', theme: 'neon', requestTimeoutSec: 5, openRouterKey: ' sk-or-v1-f ile\n' } as never,
      }),
      'replace',
    );
    expect(await getSettings()).toMatchObject({
      model: 'm/x',
      theme: DEFAULT_SETTINGS.theme,
      requestTimeoutSec: DEFAULT_SETTINGS.requestTimeoutSec,
      openRouterKey: 'sk-or-v1-file',
    });
  });

  it('replace with a file without accounts leaves «Основной» active', async () => {
    const other = await createAccount({ name: 'Другой' });
    await setActiveAccount(other.id);
    await restoreBackup(
      fileWith({ settings: { activeAccountId: other.id }, tables: { journal: [], accounts: [], spend: [] } }),
      'replace',
    );
    const accounts = await listAccounts();
    expect(accounts.map((a) => a.name)).toEqual(['Основной']);
    expect((await getActiveAccount()).id).toBe(accounts[0]!.id);
    expect((await getSettings()).activeAccountId).toBe(accounts[0]!.id);
  });

  it('replace makes the earliest account active when the file points at a missing one', async () => {
    await restoreBackup(
      fileWith({
        settings: { activeAccountId: 'ghost' },
        tables: { journal: [], accounts: [accountRow('late', 'Поздний', 20), accountRow('early', 'Ранний', 10)], spend: [] },
      }),
      'replace',
    );
    expect((await getActiveAccount()).id).toBe('early');
    expect((await getSettings()).activeAccountId).toBe('early');
  });

  it('merge upserts rows and leaves settings alone', async () => {
    const local = await ensureDefaultAccount();
    await updateSettings({ openRouterKey: 'sk-or-v1-local', model: 'keep/me' });
    await db.journal.bulkAdd([journalRow('old', 1), journalRow('local only', 2)]);

    const file = fileWith({
      settings: { openRouterKey: 'sk-or-v1-file', model: 'other/model', theme: 'dark' },
      tables: { journal: [journalRow('new', 1), journalRow('added', 7)], accounts: [], spend: [] },
    });
    expect(await restoreBackup(file, 'merge')).toEqual({ rows: 2 });

    const journal = await db.journal.orderBy('id').toArray();
    expect(journal.map((e) => [e.id, e.message])).toEqual([
      [1, 'new'],
      [2, 'local only'],
      [7, 'added'],
    ]);
    expect(await getSettings()).toMatchObject({ openRouterKey: 'sk-or-v1-local', model: 'keep/me', theme: 'auto' });
    expect((await listAccounts()).map((a) => a.id)).toEqual([local.id]);
  });

  it('merge adds the accounts of the file next to the local ones', async () => {
    const local = await ensureDefaultAccount();
    await restoreBackup(
      fileWith({ tables: { journal: [], accounts: [accountRow('from-file', 'Из файла', local.createdAt + 5)], spend: [] } }),
      'merge',
    );
    expect((await listAccounts()).map((a) => a.id)).toEqual([local.id, 'from-file']);
    expect((await getActiveAccount()).id).toBe(local.id);
  });

  it('skips tables the database does not have and writes a warning', async () => {
    const file = fileWith({
      tables: { journal: [journalRow('from file')], accounts: [], spend: [], from_the_future: [{ id: 1 }] },
    });
    expect(await restoreBackup(file, 'replace')).toEqual({ rows: 1 });
    const entries = await listJournal(10);
    expect(entries.map((e) => e.message)).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: 'warn', area: 'backup' });
    expect(entries[0]!.message).toContain('from_the_future');
    expect(entries[1]!.message).toBe('from file');
  });

  it('rolls back when a write fails', async () => {
    await log('info', 't', 'keep me');
    const file = await buildBackup({ includeKey: false });
    vi.spyOn(db.Table.prototype, 'bulkAdd').mockRejectedValue(new Error('disk'));
    await expect(restoreBackup(file, 'replace')).rejects.toThrow('Не удалось импортировать файл');
    expect((await listJournal(10)).some((e) => e.message === 'keep me')).toBe(true);
  });

  it('reports the reason with a BackupError and leaves every table and the settings as they were', async () => {
    await updateSettings({ model: 'before' });
    await ensureDefaultAccount();
    await createAccount({ name: 'Второй' });
    await log('info', 't', 'keep me');
    const file = await buildBackup({ includeKey: false });
    await db.spend.add(spendRow('a'));

    vi.spyOn(db.Table.prototype, 'bulkAdd').mockRejectedValue(new Error('disk'));
    await expect(
      restoreBackup({ ...file, settings: { ...file.settings, model: 'after' } }, 'replace'),
    ).rejects.toMatchObject({ name: 'BackupError', message: `${IMPORT_FAILED}: disk` });

    expect(await messages()).toEqual(['keep me']);
    expect(await listAccounts()).toHaveLength(2);
    expect(await db.spend.count()).toBe(1);
    expect((await getSettings()).model).toBe('before');
  });

  it('rolls back every table when a row of a later table is invalid', async () => {
    await log('info', 't', 'keep me');
    const file = fileWith({
      tables: { journal: [journalRow('from file')], accounts: [{ name: 'no id' }], spend: [] },
    });
    await expect(restoreBackup(file, 'replace')).rejects.toThrow(IMPORT_FAILED);
    expect(await messages()).toEqual(['keep me']);
    expect(await db.accounts.count()).toBe(0);
  });

  it('rolls back a merge as well', async () => {
    await log('info', 't', 'keep me');
    const file = fileWith({
      tables: { journal: [journalRow('from file')], accounts: [{ name: 'no id' }], spend: [] },
    });
    await expect(restoreBackup(file, 'merge')).rejects.toThrow(IMPORT_FAILED);
    expect(await messages()).toEqual(['keep me']);
  });

  it('keeps the restored data and reports an error when the settings cannot be saved', async () => {
    await updateSettings({ model: 'before' });
    const file = fileWith({
      settings: { model: 'after/x' },
      tables: { journal: [journalRow('from file')], accounts: [], spend: [] },
    });
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('quota'));
    await expect(restoreBackup(file, 'replace')).rejects.toMatchObject({
      name: 'BackupError',
      message: `${IMPORT_FAILED}: quota`,
    });
    vi.restoreAllMocks();

    expect(await messages()).toEqual(['from file']);
    expect((await getSettings()).model).toBe('before');
  });

  it('restores what buildBackup exported', async () => {
    await ensureDefaultAccount();
    await createAccount({ name: 'Второй' });
    await log('info', 't', 'one');
    await db.table('notes').add({ accountId: 'x' });
    const file = parseBackup(JSON.stringify(await buildBackup({ includeKey: true })));
    const before = {
      accounts: await listAccounts(),
      journal: await db.journal.toArray(),
      notes: await db.table('notes').toArray(),
    };

    await clearAllData();
    await restoreBackup(file, 'replace');

    expect(await listAccounts()).toEqual(before.accounts);
    expect(await db.journal.toArray()).toEqual(before.journal);
    expect(await db.table('notes').toArray()).toEqual(before.notes);
  });
});

describe('clearAllData', () => {
  it('wipes data, keeps the key and recreates «Основной»', async () => {
    await updateSettings({ openRouterKey: 'sk-or-v1-keep', model: 'a/b', theme: 'dark', dailyBudgetUsd: 3 });
    await ensureDefaultAccount();
    const extra = await createAccount({ name: 'Второй' });
    await setActiveAccount(extra.id);
    await log('info', 't', 'gone');
    await db.spend.add(spendRow(extra.id));
    await db.table('notes').add({ accountId: extra.id });

    await clearAllData();

    expect(await listJournal(10)).toEqual([]);
    expect(await db.spend.count()).toBe(0);
    expect(await db.table('notes').count()).toBe(0);
    const accounts = await listAccounts();
    expect(accounts.map((a) => a.name)).toEqual(['Основной']);
    expect(accounts[0]!.id).not.toBe(extra.id);
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, openRouterKey: 'sk-or-v1-keep' });
    expect((await getActiveAccount()).id).toBe(accounts[0]!.id);
  });
});
