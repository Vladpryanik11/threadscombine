import { settings } from '../../ui/settings-signal';
import { KeySection } from './KeySection';
import { ModelsSection } from './ModelsSection';
import { ThemeSection } from './ThemeSection';

/** The «Настройки» tab; tasks 14–15 add the remaining sections below these. */
export function SettingsScreen() {
  if (settings.value === null) {
    return (
      <div class="tc-settings" data-screen="settings">
        <p class="tc-error" role="alert">
          Не удалось прочитать настройки. Закройте панель и откройте её снова.
        </p>
      </div>
    );
  }
  return (
    <div class="tc-settings" data-screen="settings">
      <KeySection />
      <ModelsSection />
      <ThemeSection />
    </div>
  );
}
