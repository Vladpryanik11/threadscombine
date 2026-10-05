import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { sendToTab } from '../../src/messaging/bus';
import { startContentScript } from '../../src/threads/content-main';
import { routeTabMessagesToRuntime } from '../helpers/route-tab-messages';

const FEED = 'https://www.threads.com/';
const PROFILE = 'https://www.threads.com/@zuck';

const stops: Array<() => void> = [];

function start(deps: Parameters<typeof startContentScript>[0]) {
  const stop = startContentScript(deps);
  stops.push(stop);
  return stop;
}

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('answers page:get from the current href and broadcasts changes', async () => {
  let href = FEED;
  const target = new EventTarget();
  const sent = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
  const stop = start({ getHref: () => href, target });
  expect(sent).toHaveBeenCalledTimes(1);
  expect(sent).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'page:changed', payload: expect.objectContaining({ kind: 'feed' }) }),
  ); // initial
  href = PROFILE;
  target.dispatchEvent(new Event('popstate'));
  expect(sent).toHaveBeenCalledTimes(2);
  expect(sent).toHaveBeenLastCalledWith({
    __tc: 1,
    kind: 'broadcast',
    type: 'page:changed',
    payload: { kind: 'profile', url: PROFILE, username: 'zuck' },
  });

  routeTabMessagesToRuntime();
  await expect(sendToTab(1, 'page:get')).resolves.toEqual({ kind: 'profile', url: PROFILE, username: 'zuck' });
  href = 'https://www.threads.com/@zuck/post/C1x_Y-2';
  await expect(sendToTab(1, 'page:get')).resolves.toMatchObject({ kind: 'post', username: 'zuck', postId: 'C1x_Y-2' });
  stop();
});

it('answers ping with the extension version from the manifest', async () => {
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '1.2.3' } as Browser.runtime.Manifest);
  start({ getHref: () => FEED, target: new EventTarget() });
  routeTabMessagesToRuntime();
  await expect(sendToTab(1, 'ping')).resolves.toEqual({ version: '1.2.3' });
});

it('notices an address change by polling', () => {
  vi.useFakeTimers();
  let href = FEED;
  const sent = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
  start({ getHref: () => href, target: new EventTarget() });
  vi.advanceTimersByTime(2000);
  expect(sent).toHaveBeenCalledTimes(1);
  href = 'https://www.threads.com/search?q=cats';
  vi.advanceTimersByTime(500);
  expect(sent).toHaveBeenCalledTimes(2);
  expect(sent).toHaveBeenLastCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ kind: 'search', query: 'cats' }) }),
  );
});

it('keeps working when the report cannot be delivered', async () => {
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('Extension context invalidated.'));
  start({ getHref: () => FEED, target: new EventTarget() });
  // an unhandled rejection would fail the run
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it('stops answering and watching when stopped', async () => {
  vi.useFakeTimers();
  let href = FEED;
  const target = new EventTarget();
  const sent = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
  const stop = start({ getHref: () => href, target });
  stop();
  href = PROFILE;
  target.dispatchEvent(new Event('popstate'));
  vi.advanceTimersByTime(2000);
  expect(sent).toHaveBeenCalledTimes(1); // only the initial report

  routeTabMessagesToRuntime();
  await expect(sendToTab(1, 'page:get')).rejects.toMatchObject({ code: 'no_content_script' });
  await expect(sendToTab(1, 'ping')).rejects.toMatchObject({ code: 'no_content_script' });
});
