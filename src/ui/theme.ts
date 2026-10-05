import type { Settings } from '../storage/settings';

/** `theme.css` reads `data-theme` of the root: «auto» follows the system, «light» and «dark» are fixed. */
export function applyTheme(theme: Settings['theme'], root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', theme);
}
