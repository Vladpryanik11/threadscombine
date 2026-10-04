import { db, type JournalEntry } from './db';

export const JOURNAL_LIMIT = 500;

const OPENROUTER_KEY = /sk-or-[A-Za-z0-9_-]+/g;

/** Masks OpenRouter keys; the key must never reach the journal or a copied report. */
export function redactSecrets(text: string): string {
  return text.replace(OPENROUTER_KEY, 'sk-or-***');
}

/**
 * JSON.stringify that cannot throw on circular references, bigint or Error values.
 * Returns `undefined` when there is nothing to store or serialization fails.
 */
function safeStringify(value: unknown): string | undefined {
  const ancestors: object[] = [];
  try {
    return JSON.stringify(value, function (this: unknown, _key: string, current: unknown) {
      if (typeof current === 'bigint') return current.toString();
      if (current instanceof Error) return { name: current.name, message: current.message };
      if (typeof current !== 'object' || current === null) return current;
      // `this` is the holder of `current`: drop the finished branches from the path.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(current)) return '[Circular]';
      ancestors.push(current);
      return current;
    });
  } catch {
    return undefined;
  }
}

/** Plain, secret-free copy of `details`; `undefined` when absent or not serializable. */
function maskDetails(details: unknown): unknown {
  const json = safeStringify(details);
  if (json === undefined) return undefined;
  return JSON.parse(redactSecrets(json));
}

/** Appends an entry and keeps the newest `JOURNAL_LIMIT`. Never throws. */
export async function log(
  level: JournalEntry['level'],
  area: string,
  message: string,
  details?: unknown,
): Promise<void> {
  try {
    const entry: JournalEntry = {
      ts: Date.now(),
      level,
      area: redactSecrets(String(area)),
      message: redactSecrets(String(message)),
    };
    const masked = maskDetails(details);
    if (masked !== undefined) entry.details = masked;
    await db.journal.add(entry);
    const stale = await db.journal.toCollection().reverse().offset(JOURNAL_LIMIT).primaryKeys();
    if (stale.length > 0) await db.journal.bulkDelete(stale);
  } catch {
    // Logging must never break the caller.
  }
}

/** Newest entries first. */
export function listJournal(limit: number = JOURNAL_LIMIT): Promise<JournalEntry[]> {
  return db.journal.toCollection().reverse().limit(limit).toArray();
}

export async function clearJournal(): Promise<void> {
  await db.journal.clear();
}

const pad = (n: number): string => String(n).padStart(2, '0');

function formatTime(ts: number): string {
  const d = new Date(ts);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** One line per entry: `YYYY-MM-DD HH:mm:ss [level] area: message {details-as-json}` (local time). */
export function formatJournal(entries: JournalEntry[]): string {
  return entries
    .map((e) => {
      const details = e.details === undefined ? undefined : safeStringify(e.details);
      const line = `${formatTime(e.ts)} [${e.level}] ${e.area}: ${e.message}`;
      return redactSecrets(details === undefined ? line : `${line} ${details}`);
    })
    .join('\n');
}
