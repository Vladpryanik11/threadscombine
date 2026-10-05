import { pageChipLabel } from '../../src/ui/page-chip';
import type { ActiveTabState } from '../../src/threads/active-tab';

const ready = (page: Extract<ActiveTabState, { status: 'ready' }>['page']): ActiveTabState => ({
  status: 'ready',
  tabId: 1,
  page,
});

it.each<[ActiveTabState, string]>([
  [ready({ kind: 'feed', url: 'u' }), 'Лента'],
  [ready({ kind: 'profile', url: 'u', username: 'zuck' }), 'Профиль @zuck'],
  [ready({ kind: 'post', url: 'u', username: 'zuck', postId: 'X' }), 'Пост @zuck'],
  [ready({ kind: 'search', url: 'u', query: 'маркетинг' }), 'Поиск „маркетинг“'],
  [ready({ kind: 'other', url: 'u' }), 'Threads'],
  [{ status: 'not_threads' }, 'Откройте Threads'],
  [{ status: 'needs_reload', tabId: 1 }, 'Обновите вкладку'],
  [{ status: 'loading' }, '…'],
])('%o → %s', (state, label) => {
  expect(pageChipLabel(state)).toBe(label);
});

it.each<[string, ActiveTabState, string]>([
  ['profile without a username', ready({ kind: 'profile', url: 'u' }), 'Профиль'],
  ['post without a username', ready({ kind: 'post', url: 'u' }), 'Пост'],
  ['search without a query', ready({ kind: 'search', url: 'u' }), 'Поиск'],
])('does not print "undefined" for a %s', (_name, state, label) => {
  expect(pageChipLabel(state)).toBe(label);
});
