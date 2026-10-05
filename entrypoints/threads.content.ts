import { defineContentScript } from 'wxt/utils/define-content-script';
import { startContentScript } from '../src/threads/content-main';

export default defineContentScript({
  matches: ['https://*.threads.com/*', 'https://*.threads.net/*'],
  runAt: 'document_idle',
  main(ctx) {
    // After the extension is reloaded or removed this script outlives it: stop it, so that it does not poll and
    // fail for as long as the tab stays open.
    ctx.onInvalidated(startContentScript());
  },
});
