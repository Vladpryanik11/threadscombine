export interface WatchUrlOptions {
  intervalMs?: number;
  target?: EventTarget;
}

/**
 * Reports changes of the address in a single-page app: checks `getHref` on a timer and on
 * `popstate`, and calls `onChange` only when the value differs from the last one seen.
 * Returns a function that stops watching.
 */
export function watchUrl(
  getHref: () => string,
  onChange: (href: string) => void,
  opts: WatchUrlOptions = {},
): () => void {
  const { intervalMs = 500, target = window } = opts;
  let last = getHref();

  const check = () => {
    const href = getHref();
    if (href === last) return;
    last = href;
    onChange(href);
  };

  const timer = setInterval(check, intervalMs);
  target.addEventListener('popstate', check);

  return () => {
    clearInterval(timer);
    target.removeEventListener('popstate', check);
  };
}
