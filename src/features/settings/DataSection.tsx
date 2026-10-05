import { useEffect, useRef, useState } from 'preact/hooks';
import {
  BackupError,
  backupFileName,
  buildBackup,
  clearAllData,
  parseBackup,
  restoreBackup,
  type BackupFile,
} from '../../storage/backup';
import { log } from '../../storage/journal';
import { Button, Section, Toggle } from '../../ui/components';
import { downloadJson } from '../../ui/download';
import { showToast } from '../../ui/toast';

const UNEXPECTED_ERROR = 'Не удалось выполнить действие';
const CLEAR_CONFIRM_MS = 3000;

/**
 * Shows why an action failed. A `BackupError` speaks for itself, in its own words: after a restore it may be about
 * a failure that came when the data was already in place, so nothing is added to it. Anything else is journaled
 * (the journal masks keys) and shown as a general text.
 */
async function reportFailure(error: unknown): Promise<void> {
  if (error instanceof BackupError) {
    showToast(error.message, 'error');
    return;
  }
  await log('error', 'ui', `Данные: ${error instanceof Error ? error.message : String(error)}`);
  showToast(UNEXPECTED_ERROR, 'error');
}

interface ControlProps {
  /** An action is under way: the controls wait for it. */
  busy: boolean;
  /** Runs an action with the failures reported. */
  run: (action: () => Promise<void>) => Promise<void>;
}

// -------------------------------------------------------------------- export

function ExportControl({ busy, run }: ControlProps) {
  const [includeKey, setIncludeKey] = useState(false);

  return (
    <div class="tc-row">
      <Button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            downloadJson(backupFileName(new Date()), await buildBackup({ includeKey }));
          })
        }
      >
        Экспорт
      </Button>
      <Toggle label="Включить ключ OpenRouter" checked={includeKey} onChange={setIncludeKey} />
    </div>
  );
}

// -------------------------------------------------------------------- import

interface ChosenFile {
  name: string;
  backup: BackupFile;
}

/** Choose a backup file, then «Заменить» (after a question) or «Объединить» with it. */
function ImportControl({ busy, run }: ControlProps) {
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const [confirming, setConfirming] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);

  // the question takes the place of the button that had the focus: the focus goes to the safe answer, and back
  useEffect(() => {
    if (confirming) {
      asked.current = true;
      cancelButton.current?.focus();
    } else if (asked.current) {
      replaceButton.current?.focus();
    }
  }, [confirming]);

  const choose = (input: HTMLInputElement): void => {
    const file = input.files?.[0];
    input.value = ''; // the browser stays silent when the same file is chosen again unless the choice is emptied
    if (!file) return;
    setChosen(null); // whatever was chosen before is no longer the choice
    setConfirming(false);
    void run(async () => {
      setChosen({ name: file.name, backup: parseBackup(await file.text()) });
    });
  };

  const restore = (mode: 'replace' | 'merge'): void => {
    if (!chosen) return;
    const { backup } = chosen;
    setConfirming(false); // on a failure the choice stays, to try again
    void run(async () => {
      const { rows } = await restoreBackup(backup, mode);
      setChosen(null);
      showToast(`Импортировано записей: ${rows}`, 'success');
    });
  };

  return (
    <div class="tc-stack">
      <div class="tc-row">
        <Button disabled={busy} onClick={() => picker.current?.click()}>
          Импорт
        </Button>
        <input
          ref={picker}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Файл резервной копии"
          onChange={(event) => choose(event.currentTarget)}
        />
        {chosen && <span class="tc-hint tc-data__file">{`Файл: ${chosen.name}`}</span>}
      </div>
      {chosen &&
        (confirming ? (
          <div class="tc-row">
            <span>Все текущие данные будут заменены. Продолжить?</span>
            <Button variant="danger" disabled={busy} onClick={() => restore('replace')}>
              Да, заменить
            </Button>
            <Button ref={cancelButton} disabled={busy} onClick={() => setConfirming(false)}>
              Отмена
            </Button>
          </div>
        ) : (
          <div class="tc-row">
            <Button ref={replaceButton} variant="danger" disabled={busy} onClick={() => setConfirming(true)}>
              Заменить
            </Button>
            <Button disabled={busy} onClick={() => restore('merge')}>
              Объединить
            </Button>
          </div>
        ))}
    </div>
  );
}

// --------------------------------------------------------------------- clear

/** «Очистить всё»: the first press asks to be pressed again, for three seconds. */
function ClearControl({ busy, run }: ControlProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CLEAR_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const press = (): void => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    void run(async () => {
      await clearAllData();
      showToast('Данные очищены', 'success');
    });
  };

  return (
    <div class="tc-row">
      <Button variant="danger" disabled={busy} onClick={press}>
        {armed ? 'Нажмите ещё раз для подтверждения' : 'Очистить всё'}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------- section

/** Export to a file, import from one (replacing or merging) and wiping everything. */
export function DataSection() {
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      await reportFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Данные">
      <div class="tc-stack">
        <ExportControl busy={busy} run={run} />
        <ImportControl busy={busy} run={run} />
        <ClearControl busy={busy} run={run} />
      </div>
    </Section>
  );
}
