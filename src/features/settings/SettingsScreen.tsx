import { settings } from '../../ui/settings-signal';
import { AccountsSection } from './AccountsSection';
import { KeySection } from './KeySection';
import { ModelsSection } from './ModelsSection';
import { SpendSection } from './SpendSection';
import { ThemeSection } from './ThemeSection';

/** The «Настройки» tab; task 15 adds the remaining sections below these. */
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
      <AccountsSection />
      <SpendSection />
    </div>
  );
}
