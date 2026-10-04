import type { Dexie, Table } from 'dexie';
import { db, type Account } from './db';
import { getSettings, updateSettings } from './settings';

export const DEFAULT_ACCOUNT_NAME = 'Основной';

/** A new account takes `ACCOUNT_COLORS[number of existing accounts % 8]`. */
export const ACCOUNT_COLORS: readonly string[] = [
  '#3b82f6',
  '#ef4444',
  '#22c55e',
  '#f59e0b',
  '#a855f7',
  '#14b8a6',
  '#ec4899',
  '#f97316',
];

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

const MAX_NAME_LENGTH = 40;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;

const NAME_MESSAGE = 'Имя аккаунта — от 1 до 40 символов';
const USERNAME_MESSAGE = 'Неверный @username';
const USERNAME_TAKEN_MESSAGE = 'Этот @username уже привязан к другому аккаунту';
const NOT_FOUND_MESSAGE = 'Аккаунт не найден';
const LAST_ACCOUNT_MESSAGE = 'Нельзя удалить последний аккаунт';

/** Trims blanks, drops a leading «@», lower-cases. Empty stays `''`; anything but `[a-z0-9._]{1,30}` is rejected. */
export function normalizeUsername(input: string): string {
  const username = input.trim().replace(/^@/, '').toLowerCase();
  if (username === '') return '';
  if (!USERNAME_PATTERN.test(username)) throw new AccountError(USERNAME_MESSAGE);
  return username;
}

function normalizeName(input: string): string {
  const name = input.trim();
  const length = [...name].length; // characters as the owner sees them, not UTF-16 units
  if (length < 1 || length > MAX_NAME_LENGTH) throw new AccountError(NAME_MESSAGE);
  return name;
}

// -------------------------------------------------- transaction-bound helpers
// These read and write `db.accounts` and are only called inside a `rw` transaction on it,
// so the checks and the writes that follow them cannot interleave with another caller.

/** Throws when another account (not `exceptId`) already has this @username. `''` is never taken. */
async function assertUsernameFree(username: string, exceptId?: string): Promise<void> {
  if (username === '') return;
  const taken = await db.accounts.filter((a) => a.threadsUsername === username && a.id !== exceptId).count();
  if (taken > 0) throw new AccountError(USERNAME_TAKEN_MESSAGE);
}

async function insertAccount(name: string, threadsUsername: string): Promise<Account> {
  const count = await db.accounts.count();
  const newest = await db.accounts.orderBy('createdAt').last();
  const account: Account = {
    id: crypto.randomUUID(),
    name,
    threadsUsername,
    // `count % length` is always inside the palette.
    color: ACCOUNT_COLORS[count % ACCOUNT_COLORS.length]!,
    // Strictly after every existing account, even within one millisecond or with a clock gone back:
    // "the earliest account" must stay unambiguous.
    createdAt: Math.max(Date.now(), (newest?.createdAt ?? 0) + 1),
  };
  await db.accounts.add(account);
  return account;
}

// ------------------------------------------------------------------ accounts

/** No accounts yet → creates «Основной». Returns the earliest account. Safe to call concurrently. */
export function ensureDefaultAccount(): Promise<Account> {
  return db.transaction('rw', db.accounts, async () => {
    const earliest = await db.accounts.orderBy('createdAt').first();
    return earliest ?? insertAccount(DEFAULT_ACCOUNT_NAME, '');
  });
}

/** Oldest first. */
export function listAccounts(): Promise<Account[]> {
  return db.accounts.orderBy('createdAt').toArray();
}

export async function createAccount(input: { name: string; threadsUsername?: string }): Promise<Account> {
  const name = normalizeName(input.name);
  const threadsUsername = normalizeUsername(input.threadsUsername ?? '');
  return db.transaction('rw', db.accounts, async () => {
    await assertUsernameFree(threadsUsername);
    return insertAccount(name, threadsUsername);
  });
}

export async function updateAccount(
  id: string,
  patch: { name?: string; threadsUsername?: string },
): Promise<Account> {
  const name = patch.name === undefined ? undefined : normalizeName(patch.name);
  const threadsUsername = patch.threadsUsername === undefined ? undefined : normalizeUsername(patch.threadsUsername);
  return db.transaction('rw', db.accounts, async () => {
    const current = await db.accounts.get(id);
    if (!current) throw new AccountError(NOT_FOUND_MESSAGE);
    if (threadsUsername !== undefined) await assertUsernameFree(threadsUsername, id);
    const updated: Account = {
      ...current,
      name: name ?? current.name,
      threadsUsername: threadsUsername ?? current.threadsUsername,
    };
    await db.accounts.put(updated);
    return updated;
  });
}

/** Tables with an `accountId` index — everything that belongs to one account — except `spend`. */
export function accountScopedTables(database: Dexie): Table[] {
  return database.tables.filter(
    (table) => table.name !== 'spend' && table.schema.indexes.some((index) => index.name === 'accountId'),
  );
}

/**
 * Deletes the account and its rows in the account-scoped tables in one transaction. `spend` stays:
 * the money accounting is not reset by tidying up accounts. If the active account goes, the earliest
 * remaining one becomes active (after the transaction: the selection lives in `chrome.storage`).
 */
export async function deleteAccount(id: string): Promise<void> {
  const scoped = accountScopedTables(db);
  await db.transaction('rw', [db.accounts, ...scoped], async () => {
    if (!(await db.accounts.get(id))) throw new AccountError(NOT_FOUND_MESSAGE);
    if ((await db.accounts.count()) <= 1) throw new AccountError(LAST_ACCOUNT_MESSAGE);
    for (const table of scoped) await table.where('accountId').equals(id).delete();
    await db.accounts.delete(id);
  });

  if ((await getSettings()).activeAccountId !== id) return;
  const [earliest] = await listAccounts();
  if (earliest) await updateSettings({ activeAccountId: earliest.id });
}

// -------------------------------------------------------------------- active

/** The account from `settings.activeAccountId`; empty or dangling → the earliest one, and that is saved. */
export async function getActiveAccount(): Promise<Account> {
  const { activeAccountId } = await getSettings();
  const active = activeAccountId === '' ? undefined : await db.accounts.get(activeAccountId);
  if (active) return active;
  const earliest = await ensureDefaultAccount();
  await updateSettings({ activeAccountId: earliest.id });
  return earliest;
}

export async function setActiveAccount(id: string): Promise<void> {
  if (!(await db.accounts.get(id))) throw new AccountError(NOT_FOUND_MESSAGE);
  await updateSettings({ activeAccountId: id });
}
