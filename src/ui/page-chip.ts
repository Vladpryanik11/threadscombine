import type { ActiveTabState } from '../threads/active-tab';

/** Text of the page chip for the state of the active tab. */
export function pageChipLabel(state: ActiveTabState): string {
  switch (state.status) {
    case 'loading':
      return '…';
    case 'not_threads':
      return 'Откройте Threads';
    case 'needs_reload':
      return 'Обновите вкладку';
    case 'ready': {
      const { kind, username, query } = state.page;
      switch (kind) {
        case 'feed':
          return 'Лента';
        case 'profile':
          return username ? `Профиль @${username}` : 'Профиль';
        case 'post':
          return username ? `Пост @${username}` : 'Пост';
        case 'search':
          return query ? `Поиск „${query}“` : 'Поиск';
        case 'other':
          return 'Threads';
      }
    }
  }
}
