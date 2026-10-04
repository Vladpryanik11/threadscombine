import config from '../wxt.config';

it('declares exactly the permissions from the spec', () => {
  const m = config.manifest as Record<string, unknown>;
  expect(m.permissions).toEqual(['storage', 'unlimitedStorage', 'sidePanel']);
  expect(m.host_permissions).toEqual([
    'https://*.threads.com/*',
    'https://*.threads.net/*',
    'https://openrouter.ai/*',
  ]);
});
