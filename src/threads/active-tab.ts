import { signal, type ReadonlySignal } from '@preact/signals';
import { browser, type Browser } from 'wxt/browser';
import { onBroadcast, sendToTab } from '../messaging/bus';
import { MessagingError } from '../messaging/contract';
import { log } from '../storage/journal';
import { isThreadsUrl, type PageContext } from './page';

export type ActiveTabState =
  | { status: 'loading' }
  | { status: 'not_threads' }
  | { status: 'needs_reload'; tabId: number }
  | { status: 'ready'; tabId: number; page: PageContext };

export interface ActiveTabTracker {
  state: ReadonlySignal<ActiveTabState>;
  /** Looks at the active tab again. Never rejects. */
  refresh(): Promise<void>;
  /** Stops listening; an evaluation still in flight no longer publishes. */
  dispose(): void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Asks the content script of a tab which page it shows. A missing script is expected; anything else is journaled. */
async function readPage(tabId: number): Promise<ActiveTabState> {
  try {
    return { status: 'ready', tabId, page: await sendToTab(tabId, 'page:get') };
  } catch (error) {
    if (!(error instanceof MessagingError && error.code === 'no_content_script')) {
      await log('warn', 'messaging', errorText(error));
    }
    return { status: 'needs_reload', tabId };
  }
}

/**
 * Follows the active tab of the panel's window: not a Threads page, a Threads page without a
 * (live) content script, or a Threads page with the context its content script reported.
 */
export function createActiveTabTracker(): ActiveTabTracker {
  const state = signal<ActiveTabState>({ status: 'loading' });
  let activeTabId: number | undefined;
  // Bumped by every evaluation and every accepted broadcast: only the newest one may publish.
  let generation = 0;
  let disposed = false;

  async function refresh(): Promise<void> {
    const mine = ++generation;
    let next: ActiveTabState = { status: 'not_threads' };
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (mine === generation) activeTabId = tab?.id;
      if (tab?.id !== undefined && isThreadsUrl(tab.url)) {
        next = await readPage(tab.id);
        // A page that is still loading has no content script yet (it comes at document_idle): that is not
        // a reason to ask for a reload. The script's first broadcast, or the `complete` update, settles it.
        if (next.status === 'needs_reload' && tab.status === 'loading') next = { status: 'loading' };
      }
    } catch (error) {
      await log('warn', 'messaging', errorText(error));
    }
    if (disposed || mine !== generation) return;
    state.value = next;
  }

  const onActivated = (): void => {
    activeTabId = undefined; // until the evaluation knows which tab it is, no broadcast is trusted
    void refresh();
  };

  const onUpdated = (_tabId: number, changeInfo: Browser.tabs.OnUpdatedInfo, tab: Browser.tabs.Tab): void => {
    if (tab.active && (changeInfo.url !== undefined || changeInfo.status === 'complete')) void refresh();
  };

  // The content script reports its page itself: take it as it is, but only from the tab being watched.
  const stopBroadcasts = onBroadcast('page:changed', (page, sender) => {
    if (sender.tabId === undefined || sender.tabId !== activeTabId) return;
    generation++;
    state.value = { status: 'ready', tabId: sender.tabId, page };
  });

  browser.tabs.onActivated.addListener(onActivated);
  browser.tabs.onUpdated.addListener(onUpdated);
  void refresh();

  return {
    state,
    refresh,
    dispose() {
      disposed = true;
      stopBroadcasts();
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    },
  };
}
