import { useEffect, useState } from 'preact/hooks';
import type { JournalEntry } from '../../storage/db';
import { clearJournal, formatJournal, listJournal, log } from '../../storage/journal';
import { Button, Section } from '../../ui/components';
import { showToast } from '../../ui/toast';

const SHOWN_ENTRIES = 100;
const COPIED_ENTRIES = 500;

const READ_FAILED = 'Не удалось прочитать журнал';
const COPY_FAILED = 'Не удалось скопировать журнал';
const CLEAR_FAILED = 'Не удалось очистить журнал';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The journal as the owner reads it: the newest entries, a copy of the whole of it, and a way to empty it. */
export function JournalSection() {
  /** `null` until the first read has gone through. */
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    try {
      setEntries(await listJournal(SHOWN_ENTRIES));
      setError(null);
    } catch (caught) {
      await log('error', 'ui', `Журнал: ${messageOf(caught)}`);
      setError(READ_FAILED);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const copyAll = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatJournal(await listJournal(COPIED_ENTRIES)));
      showToast('Журнал скопирован', 'success');
    } catch (caught) {
      await log('error', 'ui', `Журнал: ${messageOf(caught)}`);
      showToast(COPY_FAILED, 'error');
    }
  };

  const clear = async (): Promise<void> => {
    try {
      await clearJournal();
    } catch (caught) {
      await log('error', 'ui', `Журнал: ${messageOf(caught)}`);
      showToast(CLEAR_FAILED, 'error');
      return;
    }
    await reload();
  };

  return (
    <Section title="Журнал">
      <div class="tc-stack">
        <div class="tc-row">
          <Button onClick={() => void reload()}>Обновить</Button>
          <Button onClick={() => void copyAll()}>Скопировать всё</Button>
          <Button variant="danger" onClick={() => void clear()}>
            Очистить журнал
          </Button>
        </div>
        {error !== null && (
          <p class="tc-error" role="alert">
            {error}
          </p>
        )}
        {entries !== null &&
          (entries.length === 0 ? (
            <p class="tc-hint">Журнал пуст</p>
          ) : (
            <ul class="tc-journal" aria-label="Записи журнала">
              {entries.map((entry, index) => (
                <li key={entry.id ?? index} class="tc-journal__entry" data-level={entry.level}>
                  <span class="tc-journal__time">{new Date(entry.ts).toLocaleString('ru-RU')}</span>
                  <span class="tc-journal__level">{entry.level}</span>
                  <span class="tc-journal__area">{entry.area}</span>
                  <span class="tc-journal__message">{entry.message}</span>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </Section>
  );
}
