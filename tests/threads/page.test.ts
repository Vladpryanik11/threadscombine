import { isThreadsUrl, parsePageUrl } from '../../src/threads/page';

describe('parsePageUrl', () => {
  it.each([
    ['https://www.threads.com/', { kind: 'feed' }],
    ['https://threads.net/for_you', { kind: 'feed' }],
    ['https://www.threads.com/following/', { kind: 'feed' }],
    ['https://www.threads.com/@john.doe_1', { kind: 'profile', username: 'john.doe_1' }],
    ['https://www.threads.com/@zuck/replies', { kind: 'profile', username: 'zuck' }],
    ['https://www.threads.com/@zuck/media?xmt=abc#top', { kind: 'profile', username: 'zuck' }],
    ['https://www.threads.com/@zuck/post/DAbc_12-x', { kind: 'post', username: 'zuck', postId: 'DAbc_12-x' }],
    ['https://www.threads.com/@zuck/post/DAbc/media', { kind: 'post', username: 'zuck', postId: 'DAbc' }],
    [
      'https://www.threads.com/search?q=%D0%BC%D0%B0%D1%80%D0%BA%D0%B5%D1%82%D0%B8%D0%BD%D0%B3&serp_type=default',
      { kind: 'search', query: 'маркетинг' },
    ],
    ['https://www.threads.com/search', { kind: 'other' }],
    ['https://www.threads.com/search?q=%20%20', { kind: 'other' }],
    ['https://www.threads.com/settings', { kind: 'other' }],
  ])('%s', (url, expected) => expect(parsePageUrl(url)).toEqual({ url, ...expected }));

  it.each([
    ['https://example.com/@zuck', 'foreign host'],
    ['https://evilthreads.com/', 'look-alike host'],
    ['not a url', 'unparsable address'],
    ['', 'empty string'],
    ['chrome://newtab/', 'non-web protocol'],
    ['https://www.threads.com/@zuck/post', 'post path without an id'],
    ['https://www.threads.com/@zuck/likes', 'unknown profile subpath'],
    ['https://www.threads.com/@bad name', 'username with a forbidden character'],
    ['https://www.threads.com/for_you/more', 'feed path with extra segments'],
  ])('returns other for %s (%s)', (url) => expect(parsePageUrl(url)).toEqual({ url, kind: 'other' }));
});

it('parsePageUrl accepts plain http', () => {
  const url = 'http://threads.net/@zuck';
  expect(parsePageUrl(url)).toEqual({ url, kind: 'profile', username: 'zuck' });
});

it('isThreadsUrl', () => {
  expect(isThreadsUrl('https://www.threads.net/@a')).toBe(true);
  expect(isThreadsUrl('https://threads.com/')).toBe(true);
  expect(isThreadsUrl('https://evilthreads.com/')).toBe(false);
  expect(isThreadsUrl('chrome://newtab/')).toBe(false);
  expect(isThreadsUrl(undefined)).toBe(false);
});
