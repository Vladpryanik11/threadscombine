import { signal } from '@preact/signals';
import { getSettings, onSettingsChanged, type Settings } from '../storage/settings';

/** The stored settings; `null` until `initSettingsSignal` has read them. */
export const settings = signal<Settings | null>(null);

/** Loads the settings and keeps the signal in step with storage. Returns the function that stops following. */
export async function initSettingsSignal(): Promise<() => void> {
  let changed = false;
  const stop = onSettingsChanged((next) => {
    changed = true;
    settings.value = next;
  });
  try {
    const stored = await getSettings();
    if (!changed) settings.value = stored; // a change that arrived meanwhile is newer
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
