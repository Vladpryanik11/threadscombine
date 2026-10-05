import { browser, type Browser } from 'wxt/browser';
import { z } from 'zod';
import { log } from './journal';

export interface Settings {
  version: 1;
  openRouterKey: string; // '' by default
  model: string; // '' — no model chosen
  fallbackEnabled: boolean;
  fallbackModels: string[]; // up to 2, no duplicates, never the main model
  reasoning: 'off' | 'low' | 'medium' | 'high';
  requestTimeoutSec: number; // 15–300
  theme: 'auto' | 'light' | 'dark';
  activeAccountId: string; // '' — the first account
  dailyBudgetUsd: number | null; // null — no limit; otherwise 0.01–1000
  monthlyBudgetUsd: number | null; // null — no limit; otherwise 0.01–1000
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  openRouterKey: '',
  model: '',
  fallbackEnabled: true,
  fallbackModels: [],
  reasoning: 'off',
  requestTimeoutSec: 90,
  theme: 'auto',
  activeAccountId: '',
  dailyBudgetUsd: null,
  monthlyBudgetUsd: null,
};

export const SETTINGS_KEY = 'settings';

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

type FieldName = keyof Settings;
type PatchableField = Exclude<FieldName, 'version'>;

const MAX_FALLBACK_MODELS = 2;

const stripWhitespace = (text: string): string => text.replace(/\s+/g, '');
const roundToCents = (usd: number): number => Math.round(usd * 100) / 100;

const budget = z.number().min(0.01).max(1000).transform(roundToCents).nullable();

/** One schema per field, so a broken field can be repaired without touching the others. */
const FIELD_SCHEMAS = {
  version: z.literal(1),
  openRouterKey: z.string().transform(stripWhitespace),
  model: z.string(),
  fallbackEnabled: z.boolean(),
  fallbackModels: z.array(z.string()),
  reasoning: z.enum(['off', 'low', 'medium', 'high']),
  requestTimeoutSec: z.number().int().min(15).max(300),
  theme: z.enum(['auto', 'light', 'dark']),
  activeAccountId: z.string(),
  dailyBudgetUsd: budget,
  monthlyBudgetUsd: budget,
} satisfies { [K in FieldName]: z.ZodType<Settings[K]> };

// Order matters: `model` is resolved before `fallbackModels`, which is checked against it.
const FIELDS = Object.keys(FIELD_SCHEMAS) as FieldName[];
const PATCHABLE_FIELDS = FIELDS.filter((field): field is PatchableField => field !== 'version');

const TIMEOUT_MESSAGE = 'Таймаут должен быть от 15 до 300 секунд';
const LIMIT_MESSAGE = 'Лимит должен быть от $0.01 до $1000';
const INVALID_MESSAGE = 'Неверное значение настройки';

const ERROR_MESSAGES: Partial<Record<PatchableField, string>> = {
  requestTimeoutSec: TIMEOUT_MESSAGE,
  dailyBudgetUsd: LIMIT_MESSAGE,
  monthlyBudgetUsd: LIMIT_MESSAGE,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const freshDefaults = (): Settings => ({ ...DEFAULT_SETTINGS, fallbackModels: [...DEFAULT_SETTINGS.fallbackModels] });

/** No duplicates, never the main model, at most two. Only removes entries and keeps the order. */
function normalizeFallbackModels(models: string[], model: string): string[] {
  return [...new Set(models)].filter((m) => m !== model).slice(0, MAX_FALLBACK_MODELS);
}

// ---------------------------------------------------------------- migrations

const CURRENT_VERSION = 1;

/** `MIGRATIONS[n]` turns version n into version n + 1; a missing `version` counts as 0. */
const MIGRATIONS: Record<number, (settings: Record<string, unknown>) => Record<string, unknown>> = {
  0: (settings) => ({ ...settings, version: 1 }),
};

export function migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
  let current = raw;
  let version = typeof raw.version === 'number' ? raw.version : 0;
  while (version < CURRENT_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    current = step(current);
    version += 1;
  }
  return current;
}

// -------------------------------------------------------------- normalization

/**
 * Repairs the object field by field: an invalid field gets its default and its name goes to `repaired`.
 * A missing field is filled with the default silently. A key with stray whitespace, a budget with
 * fractions of a cent or an over-long fallback list is fixed and reported as repaired too.
 */
export function normalizeSettings(raw: unknown): { settings: Settings; repaired: string[] } {
  if (raw === undefined) return { settings: freshDefaults(), repaired: [] };
  if (!isRecord(raw)) return { settings: freshDefaults(), repaired: ['settings'] };

  const settings = freshDefaults();
  const target: Record<FieldName, unknown> = settings;
  const repaired: string[] = [];
  for (const field of FIELDS) {
    const stored = raw[field];
    if (stored === undefined) continue;
    const parsed = FIELD_SCHEMAS[field].safeParse(stored);
    if (!parsed.success) {
      repaired.push(field);
      continue;
    }
    let value: unknown = parsed.data;
    let changed = value !== stored;
    if (field === 'fallbackModels') {
      const models = normalizeFallbackModels(parsed.data as string[], settings.model);
      changed = models.length !== (parsed.data as string[]).length;
      value = models;
    }
    if (changed) repaired.push(field);
    target[field] = value;
  }
  return { settings, repaired };
}

const parseStored = (raw: unknown) =>
  normalizeSettings(isRecord(raw) ? migrateSettings(raw) : raw);

// ------------------------------------------------------------------- storage

// Reads and writes are queued: a repair triggered by a read must not overwrite a newer update,
// and two quick updates must not both start from the same stale copy.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function readSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const { settings, repaired } = parseStored(raw);
  if (repaired.length > 0) {
    // Field names only: the stored values (the key!) never go to the journal.
    await log('warn', 'settings', `Настройки исправлены: ${repaired.join(', ')}`, { fields: repaired });
    try {
      await browser.storage.local.set({ [SETTINGS_KEY]: settings });
    } catch {
      await log('error', 'settings', 'Не удалось сохранить исправленные настройки');
    }
  }
  return settings;
}

export function getSettings(): Promise<Settings> {
  return serialized(readSettings);
}

export function updateSettings(patch: Partial<Omit<Settings, 'version'>>): Promise<Settings> {
  return serialized(async () => {
    const next = await readSettings();
    const target: Record<FieldName, unknown> = next;
    for (const field of PATCHABLE_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      const parsed = FIELD_SCHEMAS[field].safeParse(value);
      if (!parsed.success) throw new SettingsError(ERROR_MESSAGES[field] ?? INVALID_MESSAGE);
      target[field] = parsed.data;
    }
    next.fallbackModels = normalizeFallbackModels(next.fallbackModels, next.model);
    await browser.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

/** Calls `cb` with the settings whenever they change in `chrome.storage.local`. Returns the unsubscribe function. */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, Browser.storage.StorageChange>, area: string): void => {
    const change = changes[SETTINGS_KEY];
    if (area !== 'local' || !change) return;
    cb(parseStored(change.newValue).settings);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
