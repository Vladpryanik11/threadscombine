import { effect } from '@preact/signals';
import { render } from 'preact';
import { log } from '../../src/storage/journal';
import { initAccountSignals } from '../../src/ui/account-signal';
import { initSettingsSignal, settings } from '../../src/ui/settings-signal';
import { applyTheme } from '../../src/ui/theme';
import '../../src/ui/theme.css';
import { App } from './App';

applyTheme('auto'); // until the stored choice is known
effect(() => {
  const current = settings.value;
  if (current) applyTheme(current.theme);
});

/** Both signals read local storage only; the panel opens once they hold the first values, or failed. */
async function start(): Promise<void> {
  const started = await Promise.allSettled([initSettingsSignal(), initAccountSignals()]);
  for (const result of started) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      await log('error', 'ui', reason instanceof Error ? reason.message : String(reason));
    }
  }
  render(<App />, document.getElementById('app')!);
}

void start();
