import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import contentScript from '../../entrypoints/threads.content';

/** A context that only remembers what the script wants to run when the extension is reloaded or removed. */
function fakeContext() {
  const listeners: Array<() => void> = [];
  const ctx = {
    onInvalidated: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return () => {};
    }),
  } as unknown as ContentScriptContext;
  return { ctx, invalidate: () => listeners.splice(0).forEach((listener) => listener()) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('stops answering and watching when the extension context is invalidated', async () => {
  vi.useFakeTimers();
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
  const { ctx, invalidate } = fakeContext();

  await contentScript.main(ctx);

  expect(ctx.onInvalidated).toHaveBeenCalledTimes(1);
  expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(true);
  expect(vi.getTimerCount()).toBe(1); // the address poll

  invalidate();

  expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
