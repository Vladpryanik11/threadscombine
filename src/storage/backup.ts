import type { Table } from 'dexie';
import { z } from 'zod';
import { ensureDefaultAccount, getActiveAccount } from './accounts';
import { DB_VERSION, db } from './db';
import { log, redactSecrets } from './journal';
import {
  DEFAULT_SETTINGS,
  getSettings,
  migrateSettings,
  normalizeSettings,
  updateSettings,
  type Settings,
} from './settings';

export interface BackupFile {
  format: 'threadscombine-backup';
  formatVersion: 1;
  exportedAt: string;
  dbVersion: number;
  settings: Partial<Settings>;
  tables: Record<string, unknown[]>;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const NOT_A_BACKUP_MESSAGE = 'Это не файл резервной копии threadscombine';
const TOO_NEW_MESSAGE = 'Файл из более новой версии расширения';
const IMPORT_FAILED_MESSAGE = 'Не удалось импортировать файл';

/** What the settings queue accepts: every field but `version`, and the key only when `withKey`. */
function settingsPatch(settings: Settings, withKey: boolean): Parameters<typeof updateSettings>[0] {
  const { version, openRouterKey, ...rest } = settings;
  return withKey ? { ...rest, openRouterKey } : rest;
}

// -------------------------------------------------------------------- export

/** Every table of the database (so tables of later parts need no change here) plus the settings. */
export async function buildBackup(opts: { includeKey: boolean }): Promise<BackupFile> {
  const tables: Record<string, unknown[]> = {};
  // One read transaction: the tables in the file belong to the same moment.
  await db.transaction('r', db.tables, async () => {
    for (const table of db.tables) tables[table.name] = await table.toArray();
  });
  const settings: Partial<Settings> = { ...(await getSettings()) };
  if (!opts.includeKey) delete settings.openRouterKey;
  return {
    format: 'threadscombine-backup',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    dbVersion: DB_VERSION,
    settings,
    tables,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `threadscombine-backup-YYYY-MM-DD.json` with the local date. */
export function backupFileName(date: Date): string {
  return `threadscombine-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

// -------------------------------------------------------------------- import

// Only the shape is checked here. The settings are repaired field by field on import, and a row that
// the database refuses fails the transaction, which leaves the database as it was.
const BACKUP_SCHEMA = z.object({
  format: z.literal('threadscombine-backup'),
  formatVersion: z.literal(1),
  exportedAt: z.string(),
  dbVersion: z.number().int().positive(),
  settings: z.record(z.string(), z.unknown()),
  tables: z.record(z.string(), z.array(z.unknown())),
});

export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError(NOT_A_BACKUP_MESSAGE);
  }
  const parsed = BACKUP_SCHEMA.safeParse(raw);
  if (!parsed.success) throw new BackupError(NOT_A_BACKUP_MESSAGE);
  if (parsed.data.dbVersion > DB_VERSION) throw new BackupError(TOO_NEW_MESSAGE);
  return parsed.data as BackupFile;
}

function importFailed(error: unknown): BackupError {
  const reason = error instanceof Error ? error.message : String(error);
  return new BackupError(`${IMPORT_FAILED_MESSAGE}: ${redactSecrets(reason)}`);
}

/**
 * `replace` empties every table and loads the file; `merge` upserts its rows by primary key.
 * All tables are written in one Dexie transaction, so a failure leaves the database as it was.
 * The settings live in `chrome.storage`, outside that transaction, so `replace` writes them after it
 * commits: if that write fails the data stays restored and a `BackupError` is thrown all the same.
 */
export async function restoreBackup(file: BackupFile, mode: 'replace' | 'merge'): Promise<{ rows: number }> {
  const known = new Map<string, Table>(db.tables.map((table) => [table.name, table]));
  const writes: { table: Table; rows: unknown[] }[] = [];
  const skipped: string[] = [];
  for (const [name, rows] of Object.entries(file.tables)) {
    const table = known.get(name);
    if (table) writes.push({ table, rows });
    else skipped.push(name);
  }

  try {
    await db.transaction('rw', db.tables, async () => {
      if (mode === 'replace') for (const table of db.tables) await table.clear();
      for (const { table, rows } of writes) {
        if (mode === 'replace') await table.bulkAdd(rows);
        else await table.bulkPut(rows);
      }
    });
  } catch (error) {
    throw importFailed(error);
  }

  // After the commit, so that a `replace` does not wipe the entry it has just written.
  if (skipped.length > 0) {
    await log('warn', 'backup', `Таблицы из файла пропущены, их нет в базе: ${skipped.join(', ')}`, {
      tables: skipped,
    });
  }

  try {
    if (mode === 'replace') {
      const { settings } = normalizeSettings(migrateSettings(file.settings));
      // A key comes from the file only when it has one; otherwise the current key stays.
      await updateSettings(settingsPatch(settings, settings.openRouterKey !== ''));
    }
    await ensureDefaultAccount();
    await getActiveAccount();
  } catch (error) {
    throw importFailed(error);
  }

  return { rows: writes.reduce((sum, { rows }) => sum + rows.length, 0) };
}

// --------------------------------------------------------------------- clear

/** Empties every table, resets the settings (the key stays) and brings «Основной» back. */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
  await updateSettings(settingsPatch(DEFAULT_SETTINGS, false));
  await ensureDefaultAccount();
}
