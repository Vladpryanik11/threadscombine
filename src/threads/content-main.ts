import { browser } from 'wxt/browser';
import { broadcast, onTabRequest } from '../messaging/bus';
import { parsePageUrl } from './page';
import { watchUrl } from './url-watch';

export interface ContentScriptDeps {
  getHref?: () => string;
  target?: EventTarget;
}

/**
 * Reports the current Threads page to the side panel (now and on every address change) and
 * answers its requests. Returns a function that stops all of it.
 */
export function startContentScript(deps: ContentScriptDeps = {}): () => void {
  const { getHref = () => location.href, target } = deps;

  const report = (href: string) => {
    // Best effort: with the panel closed or the extension reloaded there is nobody to tell.
    broadcast('page:changed', parsePageUrl(href)).catch(() => {});
  };

  const stopPageGet = onTabRequest('page:get', () => parsePageUrl(getHref()));
  const stopPing = onTabRequest('ping', () => ({ version: browser.runtime.getManifest().version }));
  report(getHref());
  const stopWatching = watchUrl(getHref, report, { target });

  return () => {
    stopWatching();
    stopPing();
    stopPageGet();
  };
}
