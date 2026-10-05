import { fakeBrowser } from 'wxt/testing/fake-browser';
import { db } from '../../src/storage/db';
import {
  DEFAULT_ACCOUNT_NAME,
  createAccount,
  deleteAccount,
  ensureDefaultAccount,
  setActiveAccount,
} from '../../src/storage/accounts';
import { DEFAULT_SETTINGS, SETTINGS_KEY, getSettings, updateSettings } from '../../src/storage/settings';
import { accounts, activeAccount, initAccountSignals } from '../../src/ui/account-signal';
import { initSettingsSignal, settings } from '../../src/ui/settings-signal';

const stops: Array<() => void> = [];

beforeEach(async () => {
  await db.delete();
  await db.open();
  settings.value = null;
  accounts.value = [];
  activeAccount.value = null;
});

afterEach(() => {
  while (stops.length > 0) stops.pop()!();
  vi.restoreAllMocks();
});

const keep = (stop: () => void) => {
  stops.push(stop);
  return stop;
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('settings signal', () => {
  it('holds the stored settings once initialised', async () => {
    await updateSettings({ model: 'a/b' });
    keep(await initSettingsSignal());
    expect(settings.value).toEqual(await getSettings());
    expect(settings.value?.model).toBe('a/b');
  });

  it('follows changes and stops after the returned function is called', async () => {
    const stop = keep(await initSettingsSignal());
    await updateSettings({ theme: 'dark' });
    await vi.waitFor(() => expect(settings.value?.theme).toBe('dark'));

    stop();
    expect(fakeBrowser.storage.onChanged.hasListeners()).toBe(false);
    await updateSettings({ theme: 'light' });
    await pause();
    expect(settings.value?.theme).toBe('dark');
  });

  it('keeps a change that arrives while the first read is still running', async () => {
    const read = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (keys: string) => Promise<unknown>;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let readStarted: () => void = () => {};
    const staleRead = new Promise<void>((resolve) => (readStarted = resolve));
    vi.spyOn(fakeBrowser.storage.local, 'get').mockImplementationOnce((async (keys: string) => {
      const stale = await read(keys);
      readStarted();
      await gate;
      return stale;
    }) as never);

    const started = initSettingsSignal();
    await staleRead; // the first read has seen the old settings
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, model: 'new/model' } });
    await vi.waitFor(() => expect(settings.value?.model).toBe('new/model'));
    release();
    keep(await started);
    expect(settings.value?.model).toBe('new/model');
  });
});

describe('settings signal when storage fails', () => {
  it('rejects and leaves no listener behind', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValueOnce(new Error('disk gone'));
    await expect(initSettingsSignal()).rejects.toThrow('disk gone');
    expect(fakeBrowser.storage.onChanged.hasListeners()).toBe(false);
  });
});

describe('account signals', () => {
  it('creates «Основной» on a first run and makes it the active account', async () => {
    keep(await initAccountSignals());
    expect(accounts.value.map((a) => a.name)).toEqual([DEFAULT_ACCOUNT_NAME]);
    expect(activeAccount.value).toEqual(accounts.value[0]);
    expect((await getSettings()).activeAccountId).toBe(accounts.value[0]!.id);
  });

  it('lists accounts oldest first and follows new ones', async () => {
    await ensureDefaultAccount();
    keep(await initAccountSignals());
    expect(accounts.value.map((a) => a.name)).toEqual([DEFAULT_ACCOUNT_NAME]);

    await createAccount({ name: 'Кино' });
    await vi.waitFor(() => expect(accounts.value.map((a) => a.name)).toEqual([DEFAULT_ACCOUNT_NAME, 'Кино']));
    expect(activeAccount.value?.name).toBe(DEFAULT_ACCOUNT_NAME);
  });

  it('follows the active account', async () => {
    await ensureDefaultAccount();
    const movies = await createAccount({ name: 'Кино' });
    keep(await initAccountSignals());

    await setActiveAccount(movies.id);
    await vi.waitFor(() => expect(activeAccount.value).toEqual(movies));
  });

  it('moves to the earliest account when the active one is deleted', async () => {
    const main = await ensureDefaultAccount();
    const movies = await createAccount({ name: 'Кино' });
    await setActiveAccount(movies.id);
    keep(await initAccountSignals());
    expect(activeAccount.value?.id).toBe(movies.id);

    await deleteAccount(movies.id);
    await vi.waitFor(() => expect(activeAccount.value?.id).toBe(main.id));
    expect(accounts.value.map((a) => a.id)).toEqual([main.id]);
  });

  it('repairs a dangling active account id', async () => {
    const main = await ensureDefaultAccount();
    await updateSettings({ activeAccountId: 'gone' });
    keep(await initAccountSignals());
    expect(activeAccount.value?.id).toBe(main.id);
    expect((await getSettings()).activeAccountId).toBe(main.id);
  });

  it('stops following after the returned function is called', async () => {
    await ensureDefaultAccount();
    const stop = keep(await initAccountSignals());
    stop();
    expect(fakeBrowser.storage.onChanged.hasListeners()).toBe(false);

    const movies = await createAccount({ name: 'Кино' });
    await setActiveAccount(movies.id);
    await pause();
    expect(accounts.value.map((a) => a.name)).toEqual([DEFAULT_ACCOUNT_NAME]);
    expect(activeAccount.value?.name).toBe(DEFAULT_ACCOUNT_NAME);
  });

  describe('when a resolution of the active account is slow', () => {
    /** Makes reads of the account with this id wait until `release` is called. */
    function holdReadsOf(id: string) {
      const read = db.accounts.get.bind(db.accounts) as (key: string) => Promise<unknown>;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const spy = vi.spyOn(db.accounts, 'get').mockImplementation(((key: string) =>
        key === id ? gate.then(() => read(key)) : read(key)) as never);
      return { release: () => release(), requested: () => spy.mock.calls.some(([key]) => (key as unknown) === id) };
    }

    it('publishes the newest resolution even when an older one finishes later', async () => {
      const main = await ensureDefaultAccount();
      const movies = await createAccount({ name: 'Кино' });
      keep(await initAccountSignals());
      const held = holdReadsOf(movies.id);

      await updateSettings({ activeAccountId: movies.id }); // the resolution for «Кино» starts and waits
      await vi.waitFor(() => expect(held.requested()).toBe(true));
      await updateSettings({ activeAccountId: main.id }); // the owner changed their mind
      await pause();

      held.release();
      await pause();
      expect(activeAccount.value?.id).toBe(main.id);
    });

    it('does not publish a resolution that finishes after the signals were stopped', async () => {
      const main = await ensureDefaultAccount();
      const movies = await createAccount({ name: 'Кино' });
      const stop = keep(await initAccountSignals());
      const held = holdReadsOf(movies.id);

      await updateSettings({ activeAccountId: movies.id });
      await vi.waitFor(() => expect(held.requested()).toBe(true));
      stop();
      held.release();
      await pause();
      expect(activeAccount.value?.id).toBe(main.id);
    });
  });

  it('still resolves, with an empty list, when the database cannot be read', async () => {
    vi.spyOn(db.accounts, 'orderBy').mockImplementation(() => {
      throw new Error('disk gone');
    });
    keep(await initAccountSignals());
    expect(accounts.value).toEqual([]);
    expect(activeAccount.value).toBeNull();
  });
});
