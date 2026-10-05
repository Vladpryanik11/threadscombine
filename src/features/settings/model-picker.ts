import type { ModelInfo } from '../../ai';

/** Models whose id or name contains the text, ignoring case. An empty text keeps every model. */
export function filterModels<T extends ModelInfo>(models: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...models];
  return models.filter((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
}

/** «Name — $in / $out за 1M», with a mark for the models the picker recommends. */
export function modelOptionLabel(m: ModelInfo & { recommended?: boolean }): string {
  const label = `${m.name} — $${m.promptPricePerM} / $${m.completionPricePerM} за 1M`;
  return m.recommended ? `${label} · рекомендуем` : label;
}

/** A saved model the catalog no longer has. */
export function missingModelLabel(id: string): string {
  return `${id} (нет в каталоге)`;
}

/** What a fallback choice may offer: not the main model, and not the fallback chosen in the other slot. */
export function fallbackCandidates<T extends ModelInfo>(models: T[], main: string, otherFallback?: string): T[] {
  return models.filter((m) => m.id !== main && m.id !== otherFallback);
}
