import type { Settings } from '../../storage/settings';
import { Section } from '../../ui/components';
import { settings } from '../../ui/settings-signal';
import { applyTheme } from '../../ui/theme';
import { saveSettingsOrToast } from './save-settings';

const THEMES: ReadonlyArray<{ value: Settings['theme']; label: string }> = [
  { value: 'auto', label: 'Авто' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
];

/** Auto follows the system; light and dark are fixed. */
export function ThemeSection() {
  const current = settings.value?.theme;

  const choose = async (theme: Settings['theme']): Promise<void> => {
    const result = await saveSettingsOrToast({ theme });
    if (result.ok) applyTheme(theme);
  };

  return (
    <Section title="Оформление">
      <div class="tc-row" role="radiogroup" aria-label="Тема">
        {THEMES.map(({ value, label }) => (
          <label key={value} class="tc-toggle">
            <input
              type="radio"
              name="tc-theme"
              value={value}
              checked={current === value}
              onChange={() => void choose(value)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </Section>
  );
}
