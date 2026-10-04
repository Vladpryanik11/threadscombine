export type PageKind = 'feed' | 'profile' | 'post' | 'search' | 'other';

export interface PageContext {
  kind: PageKind;
  url: string;
  username?: string;
  postId?: string;
  query?: string;
}

const THREADS_HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);
const FEED_PATHS = new Set(['for_you', 'following']);
const PROFILE_SUBPATHS = new Set(['replies', 'reposts', 'media']);
const USERNAME = /^@([A-Za-z0-9._]+)$/;
const POST_ID = /^[A-Za-z0-9_-]+$/;

function parseThreadsUrl(url: string | undefined): URL | undefined {
  if (url === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const isWeb = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  return isWeb && THREADS_HOSTS.has(parsed.hostname) ? parsed : undefined;
}

export function isThreadsUrl(url: string | undefined): boolean {
  return parseThreadsUrl(url) !== undefined;
}

export function parsePageUrl(url: string): PageContext {
  const parsed = parseThreadsUrl(url);
  if (!parsed) return { kind: 'other', url };

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const [first, second, third] = segments;

  if (first === undefined) return { kind: 'feed', url };
  if (segments.length === 1 && FEED_PATHS.has(first)) return { kind: 'feed', url };

  if (first === 'search' && segments.length === 1) {
    const query = parsed.searchParams.get('q')?.trim();
    return query ? { kind: 'search', url, query } : { kind: 'other', url };
  }

  const username = USERNAME.exec(first)?.[1];
  if (username === undefined) return { kind: 'other', url };

  if (segments.length === 1 || (segments.length === 2 && second !== undefined && PROFILE_SUBPATHS.has(second))) {
    return { kind: 'profile', url, username };
  }

  if (second === 'post' && third !== undefined && POST_ID.test(third)) {
    return { kind: 'post', url, username, postId: third };
  }

  return { kind: 'other', url };
}
