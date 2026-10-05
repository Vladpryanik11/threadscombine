import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MessagingError } from '../../src/messaging/contract';
import { broadcast, onBroadcast, onTabRequest, sendToTab } from '../../src/messaging/bus';
import type { PageContext } from '../../src/threads/page';
import { routeTabMessagesToRuntime } from '../helpers/route-tab-messages';

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const page: PageContext = { kind: 'profile', url: 'https://www.threads.com/@zuck', username: 'zuck' };

afterEach(() => {
  vi.restoreAllMocks();
});

const fromTab = (id: number) => ({ tab: { id } as Browser.tabs.Tab });

function triggerBroadcast(sendResponse = vi.fn()) {
  return fakeBrowser.runtime.onMessage.trigger(
    { __tc: 1, kind: 'broadcast', type: 'page:changed', payload: page },
    fromTab(7),
    sendResponse,
  );
}

describe('sendToTab / onTabRequest', () => {
  it('round-trips a typed request to a tab', async () => {
    onTabRequest('ping', () => ({ version: '9.9.9' }));
    routeTabMessagesToRuntime();
    await expect(sendToTab(1, 'ping')).resolves.toEqual({ version: '9.9.9' });
  });

  it('sends the tab id and an envelope', async () => {
    onTabRequest('ping', () => ({ version: '1.0.0' }));
    routeTabMessagesToRuntime();
    await sendToTab(7, 'ping');
    expect(fakeBrowser.tabs.sendMessage).toHaveBeenCalledWith(7, {
      __tc: 1,
      kind: 'request',
      type: 'ping',
      payload: undefined,
    });
  });

  it('awaits an async handler and lets handlers for other types stay silent', async () => {
    onTabRequest('ping', () => ({ version: '1.0.0' }));
    onTabRequest('page:get', async () => page);
    routeTabMessagesToRuntime();
    await expect(sendToTab(1, 'page:get')).resolves.toEqual(page);
    await expect(sendToTab(1, 'ping')).resolves.toEqual({ version: '1.0.0' });
  });

  it.each([
    ['the full Chrome text', NO_RECEIVER],
    ['"Could not establish connection"', 'Could not establish connection.'],
    ['"Receiving end does not exist"', 'Receiving end does not exist'],
  ])('maps a missing content script (%s) to no_content_script', async (_name, text) => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error(text));
    await expect(sendToTab(1, 'page:get')).rejects.toMatchObject({ code: 'no_content_script' });
    await expect(sendToTab(1, 'page:get')).rejects.toBeInstanceOf(MessagingError);
  });

  it('maps a tab without any listener to no_content_script', async () => {
    routeTabMessagesToRuntime();
    await expect(sendToTab(1, 'ping')).rejects.toMatchObject({ code: 'no_content_script' });
  });

  it('maps other Chrome errors to unknown and keeps their text', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('No tab with id: 5.'));
    const error = await sendToTab(5, 'ping').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessagingError);
    expect(error).toMatchObject({ code: 'unknown', message: 'No tab with id: 5.' });
  });

  it('propagates handler errors as MessagingError unknown', async () => {
    onTabRequest('ping', () => {
      throw new Error('handler exploded');
    });
    routeTabMessagesToRuntime();
    const error = await sendToTab(1, 'ping').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessagingError);
    expect(error).toMatchObject({ code: 'unknown', message: 'handler exploded' });
  });

  it('propagates async handler rejections as MessagingError unknown', async () => {
    onTabRequest('page:get', () => Promise.reject(new Error('async boom')));
    routeTabMessagesToRuntime();
    await expect(sendToTab(1, 'page:get')).rejects.toMatchObject({ code: 'unknown', message: 'async boom' });
  });

  it('rejects with unknown when nobody in the tab handles that type', async () => {
    onTabRequest('page:get', () => page);
    routeTabMessagesToRuntime();
    await expect(sendToTab(1, 'ping')).rejects.toMatchObject({ code: 'unknown' });
  });

  it('stops answering after the unsubscribe function is called', async () => {
    const off = onTabRequest('ping', () => ({ version: '1.0.0' }));
    routeTabMessagesToRuntime();
    off();
    await expect(sendToTab(1, 'ping')).rejects.toMatchObject({ code: 'no_content_script' });
  });

  it('ignores foreign messages without blocking other listeners', async () => {
    onTabRequest('ping', () => ({ version: '1.0.0' }));
    const results = await fakeBrowser.runtime.onMessage.trigger({ hello: 'world' }, {}, vi.fn());
    expect(results).toEqual([undefined]);
    const withoutMarker = { kind: 'request', type: 'ping', payload: undefined }; // right shape, no __tc
    expect(await fakeBrowser.runtime.onMessage.trigger(withoutMarker, {}, vi.fn())).toEqual([undefined]);
    const sendResponse = vi.fn();
    await fakeBrowser.runtime.onMessage.trigger('just a string', {}, sendResponse);
    await fakeBrowser.runtime.onMessage.trigger(null, {}, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('broadcast / onBroadcast', () => {
  it('delivers broadcasts with the sender tab id', async () => {
    const handler = vi.fn();
    onBroadcast('page:changed', handler);
    const sendResponse = vi.fn();
    const results = await triggerBroadcast(sendResponse);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(page, { tabId: 7 });
    expect(results).toEqual([true]);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, value: undefined });
  });

  it('delivers a broadcast sent through runtime.sendMessage; the sender has no tab id outside a tab', async () => {
    const handler = vi.fn();
    onBroadcast('page:changed', handler);
    await expect(broadcast('page:changed', page)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith(page, { tabId: undefined });
  });

  it('ignores foreign messages, requests of the same type and broadcasts of other types', async () => {
    const handler = vi.fn();
    onBroadcast('page:changed', handler);
    const sendResponse = vi.fn();
    const trigger = (message: unknown) => fakeBrowser.runtime.onMessage.trigger(message, fromTab(7), sendResponse);

    expect(await trigger({ kind: 'broadcast', type: 'page:changed', payload: page })).toEqual([undefined]); // no __tc
    expect(await trigger({ __tc: 2, kind: 'broadcast', type: 'page:changed', payload: page })).toEqual([undefined]);
    expect(await trigger({ __tc: 1, kind: 'request', type: 'page:changed', payload: page })).toEqual([undefined]);
    expect(await trigger({ __tc: 1, kind: 'broadcast', type: 'something:else', payload: page })).toEqual([undefined]);
    expect(await trigger(undefined)).toEqual([undefined]);

    expect(handler).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('stops delivering after the unsubscribe function is called', async () => {
    const handler = vi.fn();
    const off = onBroadcast('page:changed', handler);
    off();
    await triggerBroadcast();
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports a throwing handler back to the sender as unknown', async () => {
    onBroadcast('page:changed', () => {
      throw new Error('panel exploded');
    });
    await expect(broadcast('page:changed', page)).rejects.toMatchObject({ code: 'unknown', message: 'panel exploded' });
  });

  it('sends an envelope through runtime.sendMessage, calling it before any await', () => {
    const sent = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    void broadcast('page:changed', page);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith({ __tc: 1, kind: 'broadcast', type: 'page:changed', payload: page });
  });

  it('resolves when nobody listens (the panel is closed)', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error(NO_RECEIVER));
    await expect(broadcast('page:changed', page)).resolves.toBeUndefined();
  });

  it('resolves when the panel is open but nothing is subscribed to that type', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await expect(broadcast('page:changed', page)).resolves.toBeUndefined();
  });

  it('rejects with unknown for other send errors', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('Extension context invalidated.'));
    const error = await broadcast('page:changed', page).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessagingError);
    expect(error).toMatchObject({ code: 'unknown', message: 'Extension context invalidated.' });
  });
});
