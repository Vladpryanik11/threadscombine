import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { ThemeSection } from '../../../src/features/settings/ThemeSection';
import { db } from '../../../src/storage/db';
import { getSettings, updateSettings } from '../../../src/storage/settings';
import { initSettingsSignal, settings } from '../../../src/ui/settings-signal';

let stop: () => void;

beforeEach(async () => {
  await db.delete();
  await db.open();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  cleanup();
  stop();
  settings.value = null;
});

const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;

it('offers auto, light and dark, and marks the stored one', async () => {
  await updateSettings({ theme: 'light' });
  stop = await initSettingsSignal();
  render(<ThemeSection />);

  expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
    'Авто',
    'Светлая',
    'Тёмная',
  ]);
  expect(radio('Светлая').checked).toBe(true);
  expect(radio('Авто').checked).toBe(false);
  expect(radio('Тёмная').checked).toBe(false);
});

it('saves the choice and applies it at once', async () => {
  stop = await initSettingsSignal();
  render(<ThemeSection />);
  expect(radio('Авто').checked).toBe(true);

  fireEvent.click(radio('Тёмная'));
  await waitFor(async () => expect((await getSettings()).theme).toBe('dark'));
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  await waitFor(() => expect(radio('Тёмная').checked).toBe(true));
});
