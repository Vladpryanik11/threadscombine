import { log } from '../../storage/journal';
import { SettingsError, updateSettings, type Settings } from '../../storage/settings';
import { showToast } from '../../ui/toast';

export type SettingsPatch = Parameters<typeof updateSettings>[0];

export type SaveResult = { ok: true; settings: Settings } | { ok: false; message: string };

const SAVE_FAILED = 'Не удалось сохранить настройки';

/**
 * Saves a change to the settings. A value the settings refuse comes back as their own text; any other failure
 * is journaled (its message only: the patch may hold the key) and comes back as a general one.
 */
export async function saveSettings(patch: SettingsPatch): Promise<SaveResult> {
  try {
    return { ok: true, settings: await updateSettings(patch) };
  } catch (error) {
    if (error instanceof SettingsError) return { ok: false, message: error.message };
    await log('error', 'settings', error instanceof Error ? error.message : String(error));
    return { ok: false, message: SAVE_FAILED };
  }
}

/** Like `saveSettings`, for controls with no room for a message of their own: a refusal is shown as a toast. */
export async function saveSettingsOrToast(patch: SettingsPatch): Promise<SaveResult> {
  const result = await saveSettings(patch);
  if (!result.ok) showToast(result.message, 'error');
  return result;
}
