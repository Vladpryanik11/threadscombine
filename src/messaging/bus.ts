import { browser } from 'wxt/browser';
import { MessagingError, type Broadcasts, type TabRequests } from './contract';

interface Envelope {
  __tc: 1;
  kind: 'request' | 'broadcast';
  type: string;
  payload: unknown;
}

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEnvelope(message: unknown, kind: Envelope['kind'], type: string): message is Envelope {
  return isRecord(message) && message.__tc === 1 && message.kind === kind && message.type === type;
}

function isReply(value: unknown): value is Reply {
  return isRecord(value) && typeof value.ok === 'boolean';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNoReceiver(error: unknown): boolean {
  return NO_RECEIVER.test(errorText(error));
}

/** Panel -> content script of one tab. Rejects with `MessagingError`. */
export async function sendToTab<K extends keyof TabRequests>(
  tabId: number,
  type: K,
  payload?: TabRequests[K]['req'],
): Promise<TabRequests[K]['res']> {
  const envelope: Envelope = { __tc: 1, kind: 'request', type, payload };
  let reply: unknown;
  try {
    reply = await browser.tabs.sendMessage(tabId, envelope);
  } catch (error) {
    throw new MessagingError(isNoReceiver(error) ? 'no_content_script' : 'unknown', errorText(error));
  }
  if (!isReply(reply)) throw new MessagingError('unknown', `No reply to "${type}" from tab ${tabId}`);
  if (!reply.ok) throw new MessagingError('unknown', reply.error);
  return reply.value as TabRequests[K]['res'];
}

/** In the content script: answers requests of one type. Returns a function that unsubscribes. */
export function onTabRequest<K extends keyof TabRequests>(
  type: K,
  handler: (payload: TabRequests[K]['req']) => TabRequests[K]['res'] | Promise<TabRequests[K]['res']>,
): () => void {
  const listener = (message: unknown, _sender: unknown, sendResponse: (reply: Reply) => void) => {
    if (!isEnvelope(message, 'request', type)) return; // foreign or not ours: leave it to other listeners
    const result = (async () => handler(message.payload as TabRequests[K]['req']))();
    result.then(
      (value) => sendResponse({ ok: true, value }),
      (error: unknown) => sendResponse({ ok: false, error: errorText(error) }),
    );
    return true; // the reply is sent asynchronously
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

/**
 * Content script -> side panel. Resolves also when nobody listens (the panel is closed).
 * `runtime.sendMessage` is called synchronously, before the first `await`.
 */
export async function broadcast<K extends keyof Broadcasts>(type: K, payload: Broadcasts[K]): Promise<void> {
  const envelope: Envelope = { __tc: 1, kind: 'broadcast', type, payload };
  let reply: unknown;
  try {
    reply = await browser.runtime.sendMessage(envelope);
  } catch (error) {
    if (isNoReceiver(error)) return;
    throw new MessagingError('unknown', errorText(error));
  }
  if (isReply(reply) && !reply.ok) throw new MessagingError('unknown', reply.error);
}

/** In the side panel: receives broadcasts of one type. Returns a function that unsubscribes. */
export function onBroadcast<K extends keyof Broadcasts>(
  type: K,
  handler: (payload: Broadcasts[K], sender: { tabId?: number }) => void,
): () => void {
  const listener = (
    message: unknown,
    sender: { tab?: { id?: number } },
    sendResponse: (reply: Reply) => void,
  ) => {
    if (!isEnvelope(message, 'broadcast', type)) return;
    try {
      handler(message.payload as Broadcasts[K], { tabId: sender.tab?.id });
      sendResponse({ ok: true, value: undefined });
    } catch (error) {
      sendResponse({ ok: false, error: errorText(error) });
    }
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
