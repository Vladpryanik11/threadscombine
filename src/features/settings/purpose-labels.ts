/** What each AI request purpose is called on screen. Later parts add their own purposes here. */
const PURPOSE_LABELS: ReadonlyMap<string, string> = new Map([['key-check', 'Проверка ключа']]);

/** The name of a purpose for the owner; a purpose without one is shown as it is. */
export function purposeLabel(purpose: string): string {
  return PURPOSE_LABELS.get(purpose) ?? purpose;
}
