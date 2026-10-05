import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  manifest: {
    name: 'threadscombine',
    description: 'Личный ИИ-помощник для Threads',
    permissions: ['storage', 'unlimitedStorage', 'sidePanel'],
    host_permissions: [
      'https://*.threads.com/*',
      'https://*.threads.net/*',
      'https://openrouter.ai/*',
    ],
    action: { default_title: 'threadscombine' },
  },
  vite: () => ({ plugins: [preact()] }),
});
