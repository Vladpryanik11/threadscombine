import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { db } from '../../src/storage/db';
import { listJournal } from '../../src/storage/journal';
import { parsePageUrl } from '../../src/threads/page';
import { createActiveTabTracker, type ActiveTabTracker } from '../../src/threads/active-tab';

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const FEED = 'https://www.threads.com/';
const PROFILE = 'https://www.threads.com/@zuck';

/** What the content script of each tab reports as its current address; a tab without an entry has no content script. */
const contentScripts = new Map<number, string>();
const trackers: ActiveTabTracker[] = [];

beforeEach(async () => {
  contentScripts.clear();
  await fakeBrowser.windows.create({ focused: true }); // `tabs.query({ currentWindow })` needs a current window
  await db.delete();
  await db.open();
});

afterEach(() => {
  while (trackers.length > 0) trackers.pop()!.dispose();
  vi.restoreAllMocks();
});

/** `fakeBrowser` has no `tabs.sendMessage`: answer `page:get` the way the content script does. */
function stubContentScripts() {
  return vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (tabId: number) => {
    const href = contentScripts.get(tabId);
    if (href === undefined) throw new Error(NO_RECEIVER);
    return { ok: true, value: parsePageUrl(href) };
  });
}

function track(): ActiveTabTracker {
  const tracker = createActiveTabTracker();
  trackers.push(tracker);
  return tracker;
}

async function openTab(url: string | undefined, options: { active?: boolean; contentScript?: boolean } = {}) {
  const { active = true, contentScript = true } = options;
  const tab = await fakeBrowser.tabs.create({ url, active });
  if (url !== undefined && contentScript) contentScripts.set(tab.id!, url);
  return tab;
}

/** The fake `tabs.update` stores whatever it is given, `status` included, though the typings do not list it. */
const updateTab = (tabId: number, props: Partial<Browser.tabs.Tab>) =>
  fakeBrowser.tabs.update(tabId, props as Browser.tabs.UpdateProperties);

const fromTab = (id: number) => ({ tab: { id } as Browser.tabs.Tab });

const pageChanged = (payload: unknown, tabId?: number) =>
  fakeBrowser.runtime.onMessage.trigger(
    { __tc: 1, kind: 'broadcast', type: 'page:changed', payload },
    tabId === undefined ? {} : fromTab(tabId),
    vi.fn(),
  );

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('state of the active tab', () => {
  it('starts as loading', async () => {
    stubContentScripts();
    const tracker = track();
    expect(tracker.state.value).toEqual({ status: 'loading' });
    await tracker.refresh();
  });

  it.each([undefined, 'chrome://newtab/', 'https://example.com/'])(
    'url %s → not_threads without throwing',
    async (url) => {
      const sendMessage = stubContentScripts();
      await openTab(url);
      const tracker = track();
      await tracker.refresh();
      expect(tracker.state.value).toEqual({ status: 'not_threads' });
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it('not_threads when there is no active tab at all', async () => {
    stubContentScripts();
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value).toEqual({ status: 'not_threads' });
  });

  it('is ready with the page the content script reports', async () => {
    const sendMessage = stubContentScripts();
    const tab = await openTab(PROFILE);
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value).toEqual({
      status: 'ready',
      tabId: tab.id,
      page: { kind: 'profile', url: PROFILE, username: 'zuck' },
    });
    expect(sendMessage).toHaveBeenCalledWith(tab.id, expect.objectContaining({ type: 'page:get' }));
  });

  it('needs_reload when the content script is missing, without a journal entry', async () => {
    stubContentScripts();
    const tab = await openTab(FEED, { contentScript: false });
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value).toEqual({ status: 'needs_reload', tabId: tab.id });
    expect(await listJournal()).toEqual([]);
  });

  it('needs_reload on any other messaging error, and the text goes to the journal', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('boom'));
    const tab = await openTab(FEED);
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value).toEqual({ status: 'needs_reload', tabId: tab.id });
    const entries = await listJournal();
    expect(entries.length).toBeGreaterThan(0); // the tracker's own first evaluation may have logged it too
    for (const entry of entries) expect(entry).toMatchObject({ level: 'warn', area: 'messaging', message: 'boom' });
  });

  it('needs_reload when the content script answers with an error', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ ok: false, error: 'handler failed' } as never);
    await openTab(FEED);
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value.status).toBe('needs_reload');
    expect((await listJournal())[0]).toMatchObject({ level: 'warn', area: 'messaging', message: 'handler failed' });
  });

  it('not_threads (and a journal entry) when the tab query itself fails', async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockRejectedValue(new Error('no window'));
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value).toEqual({ status: 'not_threads' });
    expect((await listJournal())[0]).toMatchObject({ level: 'warn', area: 'messaging', message: 'no window' });
  });
});

describe('a tab that is still loading', () => {
  it('is loading, not needs_reload, while the content script is not there yet; the script reporting in makes it ready', async () => {
    stubContentScripts();
    const tab = await openTab(FEED, { contentScript: false });
    await updateTab(tab.id!, { status: 'loading' });
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value).toEqual({ status: 'loading' });
    expect(await listJournal()).toEqual([]);

    await pageChanged(parsePageUrl(FEED), tab.id);
    expect(tracker.state.value).toMatchObject({ status: 'ready', tabId: tab.id, page: { kind: 'feed' } });
  });

  it('goes loading → ready over a whole page load, and never shows needs_reload on the way', async () => {
    stubContentScripts();
    const tab = await openTab(FEED);
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value.status).toBe('ready');
    const seen: string[] = [];
    const stopWatching = tracker.state.subscribe((value) => seen.push(value.status));

    // a full load of another page starts: the content script of the new document does not exist yet
    contentScripts.delete(tab.id!);
    await updateTab(tab.id!, { status: 'loading', url: PROFILE });
    await vi.waitFor(() => expect(tracker.state.value).toEqual({ status: 'loading' }));
    await pause();
    expect(tracker.state.value).toEqual({ status: 'loading' });

    // the script is injected at document_idle, and the load completes
    contentScripts.set(tab.id!, PROFILE);
    await updateTab(tab.id!, { status: 'complete' });
    await vi.waitFor(() => expect(tracker.state.value).toMatchObject({ status: 'ready', tabId: tab.id }));
    stopWatching();
    expect(seen).toContain('loading');
    expect(seen).not.toContain('needs_reload');
  });

  it('stays needs_reload for a tab that has finished loading without a content script', async () => {
    stubContentScripts();
    const tab = await openTab(FEED, { contentScript: false });
    await updateTab(tab.id!, { status: 'complete' });
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value).toEqual({ status: 'needs_reload', tabId: tab.id });
  });

  it('is ready at once when the content script already answers, loading or not', async () => {
    stubContentScripts();
    const tab = await openTab(FEED);
    await updateTab(tab.id!, { status: 'loading' });
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value).toMatchObject({ status: 'ready', tabId: tab.id });
  });
});

describe('re-evaluation', () => {
  it('follows page:changed of the active tab only', async () => {
    stubContentScripts();
    const active = await openTab(FEED);
    const other = await openTab(FEED, { active: false });
    const tracker = track();
    await tracker.refresh();
    const changed = parsePageUrl(PROFILE);

    await pageChanged(changed, other.id);
    await pageChanged(changed); // not from a tab at all
    expect(tracker.state.value).toMatchObject({ status: 'ready', page: { kind: 'feed' } });

    await pageChanged(changed, active.id);
    expect(tracker.state.value).toEqual({ status: 'ready', tabId: active.id, page: changed });
  });

  it('turns needs_reload into ready when the content script of the active tab reports in', async () => {
    stubContentScripts();
    const tab = await openTab(FEED, { contentScript: false });
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value.status).toBe('needs_reload');

    await pageChanged(parsePageUrl(FEED), tab.id);
    expect(tracker.state.value).toMatchObject({ status: 'ready', tabId: tab.id });
  });

  it('re-evaluates on tab activation', async () => {
    stubContentScripts();
    await openTab('https://example.com/');
    const threads = await openTab(PROFILE, { active: false });
    const tracker = track();
    await tracker.refresh();
    expect(tracker.state.value.status).toBe('not_threads');

    await fakeBrowser.tabs.update(threads.id!, { active: true });
    await vi.waitFor(() => expect(tracker.state.value).toMatchObject({ status: 'ready', tabId: threads.id }));
  });

  it('ignores a broadcast of the tab that has just been left', async () => {
    stubContentScripts();
    const left = await openTab(FEED);
    const entered = await openTab(PROFILE, { active: false });
    const tracker = track();
    await tracker.refresh();
    await pause(); // let the evaluation the tracker started by itself finish

    // the evaluation after the switch is held right where it asks which tab is active
    const query = fakeBrowser.tabs.query.bind(fakeBrowser.tabs) as (info: unknown) => Promise<unknown>;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async (info: unknown) => {
      await gate;
      return query(info);
    }) as never);

    await fakeBrowser.tabs.update(entered.id!, { active: true });
    await pageChanged(parsePageUrl('https://www.threads.com/@old'), left.id);
    release();
    await vi.waitFor(() => expect(tracker.state.value).toMatchObject({ status: 'ready', tabId: entered.id }));
    await pause();
    expect(tracker.state.value).toMatchObject({ tabId: entered.id, page: { username: 'zuck' } });
  });

  it('re-evaluates when the active tab changes its address or finishes loading', async () => {
    stubContentScripts();
    const tab = await openTab(FEED);
    const tracker = track();
    await tracker.refresh();
    const asActive = { ...tab, active: true };

    contentScripts.set(tab.id!, PROFILE);
    await fakeBrowser.tabs.onUpdated.trigger(tab.id!, { url: PROFILE }, asActive);
    await vi.waitFor(() => expect(tracker.state.value).toMatchObject({ page: { kind: 'profile' } }));

    contentScripts.set(tab.id!, 'https://www.threads.com/search?q=кино');
    await fakeBrowser.tabs.onUpdated.trigger(tab.id!, { status: 'complete' }, asActive);
    await vi.waitFor(() => expect(tracker.state.value).toMatchObject({ page: { kind: 'search', query: 'кино' } }));
  });

  it('ignores updates of other tabs and updates that change neither address nor loading state', async () => {
    stubContentScripts();
    const tab = await openTab(FEED);
    const other = await openTab(FEED, { active: false });
    const tracker = track();
    await tracker.refresh();
    await pause(); // let the evaluation the tracker started by itself finish
    const sendMessage = vi.mocked(fakeBrowser.tabs.sendMessage);
    sendMessage.mockClear();

    await fakeBrowser.tabs.onUpdated.trigger(other.id!, { url: PROFILE }, { ...other, active: false });
    await fakeBrowser.tabs.onUpdated.trigger(tab.id!, { status: 'loading' }, { ...tab, active: true });
    await fakeBrowser.tabs.onUpdated.trigger(tab.id!, { title: 'Threads' }, { ...tab, active: true });
    await pause();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('drops the answer of an older evaluation that finishes after a newer one', async () => {
    const first = await openTab(FEED);
    const second = await openTab(PROFILE, { active: false });
    let answerFirst: (reply: unknown) => void = () => {};
    const sendMessage = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((tabId: number) => {
      if (tabId === first.id) return new Promise((resolve) => (answerFirst = resolve));
      return Promise.resolve({ ok: true, value: parsePageUrl(PROFILE) });
    });
    // the evaluation started by the tracker itself is stuck waiting for the first tab
    const tracker = track();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    await fakeBrowser.tabs.update(second.id!, { active: true });
    await vi.waitFor(() => expect(tracker.state.value).toMatchObject({ status: 'ready', tabId: second.id }));

    answerFirst({ ok: true, value: parsePageUrl(FEED) });
    await pause();
    expect(tracker.state.value).toMatchObject({ status: 'ready', tabId: second.id, page: { kind: 'profile' } });
  });
});

describe('dispose', () => {
  it('unsubscribes from tab events and broadcasts', async () => {
    stubContentScripts();
    const tracker = createActiveTabTracker();
    await tracker.refresh();
    expect(fakeBrowser.tabs.onActivated.hasListeners()).toBe(true);
    expect(fakeBrowser.tabs.onUpdated.hasListeners()).toBe(true);
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(true);

    tracker.dispose();
    expect(fakeBrowser.tabs.onActivated.hasListeners()).toBe(false);
    expect(fakeBrowser.tabs.onUpdated.hasListeners()).toBe(false);
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(false);
  });

  it('does not publish the answer of an evaluation that was in flight', async () => {
    await openTab(FEED);
    let answer: (reply: unknown) => void = () => {};
    const sendMessage = vi
      .spyOn(fakeBrowser.tabs, 'sendMessage')
      .mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const tracker = createActiveTabTracker();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    tracker.dispose();
    answer({ ok: true, value: parsePageUrl(FEED) });
    await pause();
    expect(tracker.state.value).toEqual({ status: 'loading' });
  });
});
