import { defineContentScript } from 'wxt/utils/define-content-script';
import { startContentScript } from '../src/threads/content-main';

export default defineContentScript({
  matches: ['https://*.threads.com/*', 'https://*.threads.net/*'],
  runAt: 'document_idle',
  main() {
    startContentScript();
  },
});
