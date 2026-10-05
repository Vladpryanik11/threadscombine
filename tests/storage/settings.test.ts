import { fakeBrowser } from 'wxt/testing/fake-browser';
import { db } from '../../src/storage/db';
import { listJournal } from '../../src/storage/journal';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SettingsError,
  getSettings,
  migrateSettings,
  normalizeSettings,
  onSettingsChanged,
  updateSettings,
} from '../../src/storage/settings';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stored = async (): Promise<unknown> =>
  (await fakeBrowser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];

describe('defaults', () => {
  it('has the documented defaults', () =>
    expect(DEFAULT_SETTINGS).toEqual({
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
    }));

  it('stores under the "settings" key', () => expect(SETTINGS_KEY).toBe('settings'));
});

describe('getSettings', () => {
  it('returns defaults when nothing is stored', async () => expect(await getSettings()).toEqual(DEFAULT_SETTINGS));

  it('neither logs nor writes when nothing is stored', async () => {
    await getSettings();
    expect(await listJournal()).toEqual([]);
    expect(await stored()).toBeUndefined();
  });

  it('fills missing fields with defaults without calling that a repair', async () => {
    await fakeBrowser.storage.local.set({ settings: { version: 1, model: 'a/b' } });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, model: 'a/b' });
    expect(await listJournal()).toEqual([]);
  });

  it('migrates a stored unversioned object', async () => {
    await fakeBrowser.storage.local.set({ settings: { model: 'a/b', theme: 'dark' } });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, model: 'a/b', theme: 'dark' });
    expect(await listJournal()).toEqual([]);
  });

  it('repairs invalid fields and logs it', async () => {
    await fakeBrowser.storage.local.set({
      settings: { version: 1, theme: 'neon', requestTimeoutSec: 5, model: 'a/b', dailyBudgetUsd: -3 },
    });
    const s = await getSettings();
    expect(s).toMatchObject({ theme: 'auto', requestTimeoutSec: 90, model: 'a/b', dailyBudgetUsd: null });
    expect((await listJournal(5)).some((e) => e.area === 'settings' && e.level === 'warn')).toBe(true);
  });

  it('saves the repaired settings and then stays quiet', async () => {
    await fakeBrowser.storage.local.set({ settings: { version: 1, theme: 'neon', model: 'a/b' } });
    await getSettings();
    expect(await stored()).toEqual({ ...DEFAULT_SETTINGS, model: 'a/b' });
    await getSettings();
    expect(await listJournal()).toHaveLength(1);
  });

  it('logs only field names, never the stored key', async () => {
    await fakeBrowser.storage.local.set({
      settings: { version: 1, openRouterKey: ' sk-or-v1-secret ', theme: 'neon' },
    });
    await getSettings();
    const entries = await listJournal();
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(entries[0]!.details).toEqual({ fields: ['openRouterKey', 'theme'] });
  });

  it('replaces a non-object value with defaults and repairs it', async () => {
    await fakeBrowser.storage.local.set({ settings: 'garbage' });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await stored()).toEqual(DEFAULT_SETTINGS);
    expect((await listJournal(1))[0]).toMatchObject({ area: 'settings', level: 'warn' });
  });

  it('still returns the repaired settings if saving them fails', async () => {
    await fakeBrowser.storage.local.set({ settings: { version: 1, theme: 'neon' } });
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('quota'));
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('migrateSettings', () => {
  it('migrates an unversioned object to version 1 keeping known fields', () =>
    expect(migrateSettings({ model: 'a/b' })).toMatchObject({ version: 1, model: 'a/b' }));

  it('does not mutate its input', () => {
    const raw = { model: 'a/b' };
    migrateSettings(raw);
    expect(raw).toEqual({ model: 'a/b' });
  });

  it('leaves a current object as it is', () => {
    const raw = { version: 1, theme: 'dark' };
    expect(migrateSettings(raw)).toEqual(raw);
  });

  it('treats a non-numeric version as the conditional version 0', () =>
    expect(migrateSettings({ version: 'x', model: 'a/b' })).toMatchObject({ version: 1, model: 'a/b' }));
});

describe('normalizeSettings', () => {
  it('returns defaults for undefined without repairs', () =>
    expect(normalizeSettings(undefined)).toEqual({ settings: DEFAULT_SETTINGS, repaired: [] }));

  it('returns a fresh fallbackModels array, not the shared default', () => {
    const a = normalizeSettings(undefined).settings;
    a.fallbackModels.push('x/y');
    expect(DEFAULT_SETTINGS.fallbackModels).toEqual([]);
  });

  it.each([null, 'text', 5, ['a'], true])('repairs a non-object value (%j)', (raw) =>
    expect(normalizeSettings(raw)).toEqual({ settings: DEFAULT_SETTINGS, repaired: ['settings'] }));

  it('repairs field by field and names every repaired field', () => {
    const { settings, repaired } = normalizeSettings({
      version: 1,
      openRouterKey: 42,
      model: 'a/b',
      fallbackEnabled: 'yes',
      fallbackModels: 'm/a',
      reasoning: 'max',
      requestTimeoutSec: 90.5,
      theme: 'dark',
      activeAccountId: null,
      dailyBudgetUsd: '5',
      monthlyBudgetUsd: 2000,
    });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, model: 'a/b', theme: 'dark' });
    expect(repaired).toEqual([
      'openRouterKey',
      'fallbackEnabled',
      'fallbackModels',
      'reasoning',
      'requestTimeoutSec',
      'activeAccountId',
      'dailyBudgetUsd',
      'monthlyBudgetUsd',
    ]);
  });

  it('keeps valid values at the range edges', () => {
    const raw = { version: 1, requestTimeoutSec: 15, dailyBudgetUsd: 0.01, monthlyBudgetUsd: 1000 };
    expect(normalizeSettings(raw)).toEqual({ settings: { ...DEFAULT_SETTINGS, ...raw }, repaired: [] });
    expect(normalizeSettings({ requestTimeoutSec: 300 }).settings.requestTimeoutSec).toBe(300);
    expect(normalizeSettings({ requestTimeoutSec: 14 }).repaired).toEqual(['requestTimeoutSec']);
    expect(normalizeSettings({ requestTimeoutSec: 301 }).repaired).toEqual(['requestTimeoutSec']);
    expect(normalizeSettings({ dailyBudgetUsd: 0.009 }).repaired).toEqual(['dailyBudgetUsd']);
    expect(normalizeSettings({ dailyBudgetUsd: 1000.01 }).repaired).toEqual(['dailyBudgetUsd']);
  });

  it('rejects NaN and Infinity', () => {
    expect(normalizeSettings({ requestTimeoutSec: NaN }).repaired).toEqual(['requestTimeoutSec']);
    expect(normalizeSettings({ dailyBudgetUsd: Infinity }).repaired).toEqual(['dailyBudgetUsd']);
  });

  it('strips all whitespace from the key and reports it as repaired', () => {
    const { settings, repaired } = normalizeSettings({ openRouterKey: ' sk-or-v1-a b\n' });
    expect(settings.openRouterKey).toBe('sk-or-v1-ab');
    expect(repaired).toEqual(['openRouterKey']);
  });

  it('rounds a stored budget to cents and reports it', () => {
    const { settings, repaired } = normalizeSettings({ dailyBudgetUsd: 2.346 });
    expect(settings.dailyBudgetUsd).toBe(2.35);
    expect(repaired).toEqual(['dailyBudgetUsd']);
  });

  it('normalizes stored fallback models against the stored model', () => {
    const { settings, repaired } = normalizeSettings({
      model: 'm/main',
      fallbackModels: ['m/main', 'm/a', 'm/a', 'm/b', 'm/c'],
    });
    expect(settings.fallbackModels).toEqual(['m/a', 'm/b']);
    expect(repaired).toEqual(['fallbackModels']);
  });

  it('repairs a fallback list with a non-string entry as a whole', () =>
    expect(normalizeSettings({ fallbackModels: ['m/a', 5] })).toMatchObject({
      settings: { fallbackModels: [] },
      repaired: ['fallbackModels'],
    }));

  it('repairs a foreign version number to 1', () =>
    expect(normalizeSettings({ version: 2, model: 'a/b' })).toEqual({
      settings: { ...DEFAULT_SETTINGS, model: 'a/b' },
      repaired: ['version'],
    }));

  it('ignores unknown fields', () =>
    expect(normalizeSettings({ version: 1, extra: 1 })).toEqual({ settings: DEFAULT_SETTINGS, repaired: [] }));
});

describe('updateSettings', () => {
  it('strips whitespace from a pasted key', async () =>
    expect((await updateSettings({ openRouterKey: '  sk-or-v1-abc \n' })).openRouterKey).toBe('sk-or-v1-abc'));

  it('persists the result and keeps untouched fields', async () => {
    await updateSettings({ model: 'a/b' });
    const s = await updateSettings({ theme: 'dark' });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, model: 'a/b', theme: 'dark' });
    expect(await stored()).toEqual(s);
    expect(await getSettings()).toEqual(s);
  });

  it('normalizes fallback models', async () => {
    const s = await updateSettings({ model: 'm/main', fallbackModels: ['m/main', 'm/a', 'm/a', 'm/b', 'm/c'] });
    expect(s.fallbackModels).toEqual(['m/a', 'm/b']);
  });

  it('drops a new main model from the stored fallback models', async () => {
    await updateSettings({ model: 'm/main', fallbackModels: ['m/a', 'm/b'] });
    const s = await updateSettings({ model: 'm/a' });
    expect(s.fallbackModels).toEqual(['m/b']);
  });

  it('allows clearing the model', async () => {
    await updateSettings({ model: 'm/main' });
    expect((await updateSettings({ model: '' })).model).toBe('');
  });

  it('rejects an out-of-range timeout', async () =>
    await expect(updateSettings({ requestTimeoutSec: 301 })).rejects.toThrow('Таймаут должен быть от 15 до 300 секунд'));

  it.each([14, 15.5, NaN, '60'])('rejects the timeout %j', async (value) => {
    await expect(updateSettings({ requestTimeoutSec: value as number })).rejects.toBeInstanceOf(SettingsError);
  });

  it('accepts the timeout edges', async () => {
    expect((await updateSettings({ requestTimeoutSec: 15 })).requestTimeoutSec).toBe(15);
    expect((await updateSettings({ requestTimeoutSec: 300 })).requestTimeoutSec).toBe(300);
  });

  it('validates and rounds budgets', async () => {
    expect((await updateSettings({ dailyBudgetUsd: 1.234 })).dailyBudgetUsd).toBe(1.23);
    expect((await updateSettings({ monthlyBudgetUsd: null })).monthlyBudgetUsd).toBeNull();
    await expect(updateSettings({ dailyBudgetUsd: 0 })).rejects.toThrow('Лимит должен быть от $0.01 до $1000');
  });

  it.each([-1, 0.004, 1000.01, NaN, Infinity])('rejects the budget %j', async (value) => {
    await expect(updateSettings({ monthlyBudgetUsd: value })).rejects.toThrow('Лимит должен быть от $0.01 до $1000');
  });

  it('accepts the budget edges', async () => {
    expect((await updateSettings({ dailyBudgetUsd: 0.01 })).dailyBudgetUsd).toBe(0.01);
    expect((await updateSettings({ dailyBudgetUsd: 1000 })).dailyBudgetUsd).toBe(1000);
  });

  it('rejects unknown enum values', async () => {
    await expect(updateSettings({ theme: 'neon' as 'dark' })).rejects.toThrow('Неверное значение настройки');
    await expect(updateSettings({ reasoning: 'max' as 'high' })).rejects.toThrow('Неверное значение настройки');
  });

  it('rejects values of the wrong type', async () => {
    await expect(updateSettings({ model: 5 as unknown as string })).rejects.toThrow('Неверное значение настройки');
    await expect(updateSettings({ fallbackEnabled: 'yes' as unknown as boolean })).rejects.toThrow(
      'Неверное значение настройки',
    );
    await expect(updateSettings({ fallbackModels: 'a' as unknown as string[] })).rejects.toThrow(
      'Неверное значение настройки',
    );
  });

  it('throws SettingsError and saves nothing when any field is invalid', async () => {
    await expect(updateSettings({ theme: 'dark', requestTimeoutSec: 1 })).rejects.toBeInstanceOf(SettingsError);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores undefined fields, a version and unknown keys in the patch', async () => {
    await updateSettings({ model: 'a/b' });
    const patch = { theme: undefined, version: 7, extra: 1 } as unknown as Parameters<typeof updateSettings>[0];
    expect(await updateSettings(patch)).toEqual({ ...DEFAULT_SETTINGS, model: 'a/b' });
    expect(await stored()).not.toHaveProperty('extra');
  });

  it('builds on repaired settings when the stored ones are broken', async () => {
    await fakeBrowser.storage.local.set({ settings: { version: 1, model: 'a/b', theme: 'neon' } });
    expect(await updateSettings({ fallbackEnabled: false })).toEqual({
      ...DEFAULT_SETTINGS,
      model: 'a/b',
      fallbackEnabled: false,
    });
  });

  it('does not lose concurrent updates', async () => {
    await Promise.all([
      updateSettings({ theme: 'dark' }),
      updateSettings({ model: 'a/b' }),
      updateSettings({ reasoning: 'high' }),
    ]);
    expect(await getSettings()).toMatchObject({ theme: 'dark', model: 'a/b', reasoning: 'high' });
  });

  it('keeps working after a failed update', async () => {
    await expect(updateSettings({ requestTimeoutSec: 1 })).rejects.toBeInstanceOf(SettingsError);
    expect((await updateSettings({ theme: 'light' })).theme).toBe('light');
  });

  it('keeps the key out of the journal and error texts', async () => {
    await updateSettings({ openRouterKey: 'sk-or-v1-topsecret' });
    await expect(updateSettings({ theme: 'neon' as 'dark' })).rejects.toThrow(/^Неверное значение настройки$/);
    expect(JSON.stringify(await listJournal())).not.toContain('topsecret');
  });
});

describe('onSettingsChanged', () => {
  it('notifies subscribers on change', async () => {
    const cb = vi.fn();
    const off = onSettingsChanged(cb);
    await updateSettings({ theme: 'dark' });
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' })));
    off();
  });

  it('stops notifying after unsubscribe', async () => {
    const cb = vi.fn();
    onSettingsChanged(cb)();
    await updateSettings({ theme: 'dark' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores other keys and other storage areas', async () => {
    const cb = vi.fn();
    const off = onSettingsChanged(cb);
    await fakeBrowser.storage.local.set({ other: 1 });
    await fakeBrowser.storage.sync.set({ settings: { version: 1, theme: 'dark' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cb).not.toHaveBeenCalled();
    off();
  });

  it('passes a repaired copy of whatever was written', async () => {
    const cb = vi.fn();
    const off = onSettingsChanged(cb);
    await fakeBrowser.storage.local.set({ settings: { model: 'a/b', theme: 'neon' } });
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, model: 'a/b' }));
    off();
  });
});
