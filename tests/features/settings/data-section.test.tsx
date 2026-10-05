import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { DataSection } from '../../../src/features/settings/DataSection';
import {
  BackupError,
  buildBackup,
  clearAllData,
  parseBackup,
  restoreBackup,
  type BackupFile,
} from '../../../src/storage/backup';
import { db } from '../../../src/storage/db';
import { listJournal } from '../../../src/storage/journal';
import { downloadJson } from '../../../src/ui/download';
import { toasts } from '../../../src/ui/toast';

vi.mock('../../../src/storage/backup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/storage/backup')>()),
  buildBackup: vi.fn(),
  parseBackup: vi.fn(),
  restoreBackup: vi.fn(),
  clearAllData: vi.fn(),
}));

vi.mock('../../../src/ui/download', () => ({ downloadJson: vi.fn() }));

const BACKUP: BackupFile = {
  format: 'threadscombine-backup',
  formatVersion: 1,
  exportedAt: '2026-10-05T10:00:00.000Z',
  dbVersion: 1,
  settings: {},
  tables: {},
};

const UNEXPECTED_ERROR = 'Не удалось выполнить действие';
const REPLACE_QUESTION = 'Все текущие данные будут заменены. Продолжить?';
const CLEAR_AGAIN = 'Нажмите ещё раз для подтверждения';

beforeEach(async () => {
  await db.delete();
  await db.open();
  toasts.value = [];
  vi.mocked(buildBackup).mockReset().mockResolvedValue(BACKUP);
  vi.mocked(parseBackup).mockReset().mockReturnValue(BACKUP);
  vi.mocked(restoreBackup).mockReset().mockResolvedValue({ rows: 3 });
  vi.mocked(clearAllData).mockReset().mockResolvedValue(undefined);
  vi.mocked(downloadJson).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const button = (name: string) => screen.getByRole('button', { name });
const fileInput = () => screen.getByLabelText('Файл резервной копии') as HTMLInputElement;
const keyBox = () => screen.getByRole('switch', { name: 'Включить ключ OpenRouter' }) as HTMLInputElement;
const toastList = () => toasts.value.map(({ text, kind }) => ({ text, kind }));

/** Picks a file the way the browser reports it. */
function chooseFile(name = 'backup.json', text = '{"fake":true}'): File {
  const file = new File([text], name, { type: 'application/json' });
  fireEvent.change(fileInput(), { target: { files: [file] } });
  return file;
}

describe('export', () => {
  it('exports without the key by default', async () => {
    render(<DataSection />);
    expect(keyBox().checked).toBe(false);

    fireEvent.click(button('Экспорт'));

    await waitFor(() => expect(downloadJson).toHaveBeenCalledTimes(1));
    expect(buildBackup).toHaveBeenCalledWith({ includeKey: false });
    expect(downloadJson).toHaveBeenCalledWith(
      expect.stringMatching(/^threadscombine-backup-\d{4}-\d{2}-\d{2}\.json$/),
      BACKUP,
    );
  });

  it('exports with the key once the box is ticked', async () => {
    render(<DataSection />);
    fireEvent.click(keyBox());
    expect(keyBox().checked).toBe(true);

    fireEvent.click(button('Экспорт'));

    await waitFor(() => expect(downloadJson).toHaveBeenCalledTimes(1));
    expect(buildBackup).toHaveBeenCalledWith({ includeKey: true });
  });

  it('says so, without the cause, when the file cannot be made (the cause goes to the journal, key masked)', async () => {
    vi.mocked(buildBackup).mockRejectedValue(new Error('database is closed (sk-or-v1-abc123)'));
    render(<DataSection />);

    fireEvent.click(button('Экспорт'));

    await waitFor(() => expect(toastList()).toEqual([{ text: UNEXPECTED_ERROR, kind: 'error' }]));
    expect(downloadJson).not.toHaveBeenCalled();
    const [entry, ...rest] = await listJournal();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ level: 'error', area: 'ui' });
    expect(entry?.message).toContain('database is closed');
    expect(entry?.message).not.toContain('abc123');
  });
});

describe('import', () => {
  it('«Импорт» opens the file picker', () => {
    render(<DataSection />);
    const open = vi.spyOn(fileInput(), 'click');

    fireEvent.click(button('Импорт'));

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows the parse error for a foreign file and offers nothing to do with it', async () => {
    vi.mocked(parseBackup).mockImplementation(() => {
      throw new BackupError('Это не файл резервной копии threadscombine');
    });
    render(<DataSection />);

    chooseFile('photo.json', '{"hello":"world"}');

    await waitFor(() =>
      expect(toastList()).toEqual([{ text: 'Это не файл резервной копии threadscombine', kind: 'error' }]),
    );
    expect(parseBackup).toHaveBeenCalledWith('{"hello":"world"}');
    expect(screen.queryByRole('button', { name: 'Заменить' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Объединить' })).toBeNull();
    expect(await listJournal()).toEqual([]); // a refusal of the backup is the user's matter, not a fault
  });

  it('offers «Заменить» and «Объединить» for a good file, and drops them when a bad one is chosen next', async () => {
    render(<DataSection />);

    chooseFile('my-backup.json');
    await screen.findByRole('button', { name: 'Заменить' });
    expect(button('Объединить')).toBeTruthy();
    expect(screen.getByText(/my-backup\.json/)).toBeTruthy();
    expect(restoreBackup).not.toHaveBeenCalled();

    vi.mocked(parseBackup).mockImplementation(() => {
      throw new BackupError('Файл из более новой версии расширения');
    });
    chooseFile('newer.json');

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Заменить' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Объединить' })).toBeNull();
    expect(screen.queryByText(/my-backup\.json/)).toBeNull();
  });

  it('replace asks for confirmation before restoring', async () => {
    render(<DataSection />);
    chooseFile('backup.json', '{"a":1}');

    fireEvent.click(await screen.findByRole('button', { name: 'Заменить' }));

    expect(parseBackup).toHaveBeenCalledWith('{"a":1}');
    expect(screen.getByText(REPLACE_QUESTION)).toBeTruthy();
    expect(restoreBackup).not.toHaveBeenCalled();

    fireEvent.click(button('Да, заменить'));

    await waitFor(() => expect(toastList()).toEqual([{ text: 'Импортировано записей: 3', kind: 'success' }]));
    expect(restoreBackup).toHaveBeenCalledTimes(1);
    expect(restoreBackup).toHaveBeenCalledWith(BACKUP, 'replace');
    // the file is done with
    expect(screen.queryByText(REPLACE_QUESTION)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Заменить' })).toBeNull();
  });

  it('«Отмена» leaves the data alone and keeps the choice', async () => {
    render(<DataSection />);
    chooseFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Заменить' }));

    fireEvent.click(button('Отмена'));

    expect(screen.queryByText(REPLACE_QUESTION)).toBeNull();
    expect(button('Заменить')).toBeTruthy();
    expect(button('Объединить')).toBeTruthy();
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(toastList()).toEqual([]);
  });

  it('moves the focus to «Отмена» when asking and back to «Заменить» when declined', async () => {
    render(<DataSection />);
    chooseFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Заменить' }));
    await waitFor(() => expect(document.activeElement).toBe(button('Отмена')));

    fireEvent.click(button('Отмена'));

    await waitFor(() => expect(document.activeElement).toBe(button('Заменить')));
  });

  it('merge restores at once, without a question', async () => {
    render(<DataSection />);
    chooseFile();

    fireEvent.click(await screen.findByRole('button', { name: 'Объединить' }));

    await waitFor(() => expect(toastList()).toEqual([{ text: 'Импортировано записей: 3', kind: 'success' }]));
    expect(restoreBackup).toHaveBeenCalledWith(BACKUP, 'merge');
    expect(screen.queryByText(REPLACE_QUESTION)).toBeNull();
  });

  it('shows the text of a refused import as it is and lets the owner try again', async () => {
    // the text may be about a restore that went through half way: it is shown as written, not "nothing changed"
    const text = 'Не удалось импортировать файл: не записались настройки';
    vi.mocked(restoreBackup).mockRejectedValueOnce(new BackupError(text));
    render(<DataSection />);
    chooseFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Заменить' }));
    fireEvent.click(button('Да, заменить'));

    await waitFor(() => expect(toastList()).toEqual([{ text, kind: 'error' }]));
    expect(await listJournal()).toEqual([]);
    // the question is closed, the file is still the choice
    expect(screen.queryByText(REPLACE_QUESTION)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Объединить' }));
    await waitFor(() => expect(toasts.value).toHaveLength(2));
    expect(restoreBackup).toHaveBeenLastCalledWith(BACKUP, 'merge');
  });

  it('says so, without the cause, on an unexpected failure (the cause goes to the journal)', async () => {
    vi.mocked(restoreBackup).mockRejectedValue(new TypeError('x is not iterable'));
    render(<DataSection />);
    chooseFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Объединить' }));

    await waitFor(() => expect(toastList()).toEqual([{ text: UNEXPECTED_ERROR, kind: 'error' }]));
    const [entry] = await listJournal();
    expect(entry).toMatchObject({ level: 'error', area: 'ui' });
    expect(entry?.message).toContain('x is not iterable');
  });

  it('says so when the chosen file cannot be read', async () => {
    render(<DataSection />);
    const file = new File(['{}'], 'broken.json', { type: 'application/json' });
    vi.spyOn(file, 'text').mockRejectedValue(new DOMException('The requested file could not be read', 'NotReadableError'));

    fireEvent.change(fileInput(), { target: { files: [file] } });

    await waitFor(() => expect(toastList()).toEqual([{ text: UNEXPECTED_ERROR, kind: 'error' }]));
    expect(parseBackup).not.toHaveBeenCalled();
    expect((await listJournal())[0]?.message).toContain('The requested file could not be read');
  });

  it('resets the file input so that choosing the same file again works', async () => {
    render(<DataSection />);
    const input = fileInput();
    const reset = vi.fn();
    Object.defineProperty(input, 'value', { configurable: true, get: () => 'C:\\fakepath\\backup.json', set: reset });

    chooseFile();
    await screen.findByRole('button', { name: 'Заменить' });

    expect(reset).toHaveBeenCalledWith('');
  });
});

describe('clear all', () => {
  it('needs a second press', async () => {
    render(<DataSection />);

    fireEvent.click(button('Очистить всё'));

    expect(button(CLEAR_AGAIN)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Очистить всё' })).toBeNull();
    expect(clearAllData).not.toHaveBeenCalled();

    fireEvent.click(button(CLEAR_AGAIN));

    await waitFor(() => expect(toastList()).toEqual([{ text: 'Данные очищены', kind: 'success' }]));
    expect(clearAllData).toHaveBeenCalledTimes(1);
    expect(button('Очистить всё')).toBeTruthy(); // armed no more
  });

  it('takes the first press back after three seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<DataSection />);
    fireEvent.click(button('Очистить всё'));

    await act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(button(CLEAR_AGAIN)).toBeTruthy();

    await act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(button('Очистить всё')).toBeTruthy();

    // the late second press is a first one again
    fireEvent.click(button('Очистить всё'));
    expect(clearAllData).not.toHaveBeenCalled();
    expect(button(CLEAR_AGAIN)).toBeTruthy();
  });

  it('says so, without the cause, when clearing fails, and is disarmed', async () => {
    vi.mocked(clearAllData).mockRejectedValue(new Error('transaction aborted'));
    render(<DataSection />);

    fireEvent.click(button('Очистить всё'));
    fireEvent.click(button(CLEAR_AGAIN));

    await waitFor(() => expect(toastList()).toEqual([{ text: UNEXPECTED_ERROR, kind: 'error' }]));
    expect(button('Очистить всё')).toBeTruthy();
    expect((await listJournal())[0]?.message).toContain('transaction aborted');
  });
});
