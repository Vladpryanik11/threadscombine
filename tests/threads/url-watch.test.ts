import { watchUrl } from '../../src/threads/url-watch';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('reports only changes, by polling and popstate, and stops', () => {
  let href = 'https://www.threads.com/';
  const seen: string[] = [];
  const target = new EventTarget();
  const stop = watchUrl(() => href, (h) => seen.push(h), { intervalMs: 500, target });
  vi.advanceTimersByTime(1000);
  expect(seen).toEqual([]);
  href = 'https://www.threads.com/@a';
  vi.advanceTimersByTime(500);
  expect(seen).toEqual(['https://www.threads.com/@a']);
  href = 'https://www.threads.com/@b';
  target.dispatchEvent(new Event('popstate'));
  expect(seen).toHaveLength(2);
  stop();
  href = 'https://www.threads.com/@c';
  vi.advanceTimersByTime(2000);
  target.dispatchEvent(new Event('popstate'));
  expect(seen).toHaveLength(2);
});

it('does not report the same value twice when popstate and the timer both see it', () => {
  let href = 'https://www.threads.com/';
  const seen: string[] = [];
  const target = new EventTarget();
  const stop = watchUrl(() => href, (h) => seen.push(h), { target });
  href = 'https://www.threads.com/@a';
  target.dispatchEvent(new Event('popstate'));
  vi.advanceTimersByTime(500);
  expect(seen).toEqual(['https://www.threads.com/@a']);
  stop();
});

it('polls every 500 ms by default', () => {
  let href = 'https://www.threads.com/';
  const seen: string[] = [];
  const stop = watchUrl(() => href, (h) => seen.push(h), { target: new EventTarget() });
  href = 'https://www.threads.com/@a';
  vi.advanceTimersByTime(499);
  expect(seen).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(seen).toEqual(['https://www.threads.com/@a']);
  stop();
});

it('listens to popstate on window when no target is given', () => {
  let href = 'https://www.threads.com/';
  const seen: string[] = [];
  const stop = watchUrl(() => href, (h) => seen.push(h));
  href = 'https://www.threads.com/@a';
  window.dispatchEvent(new Event('popstate'));
  expect(seen).toEqual(['https://www.threads.com/@a']);
  stop();
});
