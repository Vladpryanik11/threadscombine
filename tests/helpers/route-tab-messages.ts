import { fakeBrowser } from 'wxt/testing/fake-browser';

/**
 * `fakeBrowser` does not implement `tabs.sendMessage`. This stub delivers the message to the
 * `runtime.onMessage` listeners the way Chrome delivers it to a content script: it waits for
 * `sendResponse` when a listener returns `true`, resolves `undefined` when no listener
 * answers, and rejects with Chrome's error when nothing is listening at all.
 */
export function routeTabMessagesToRuntime(): void {
  vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async (_tabId: number, message: unknown) => {
    const { onMessage } = fakeBrowser.runtime;
    if (!onMessage.hasListeners()) {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }
    let sendResponse: (response: unknown) => void = () => {};
    const response = new Promise((resolve) => {
      sendResponse = resolve;
    });
    const results = await onMessage.trigger(message, { id: fakeBrowser.runtime.id }, sendResponse);
    return results.some((result) => (result as unknown) === true) ? response : undefined;
  });
}
