import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { JournalSection } from '../../../src/features/settings/JournalSection';
import { db, type JournalEntry } from '../../../src/storage/db';
import { formatJournal, listJournal } from '../../../src/storage/journal';
import { toasts } from '../../../src/ui/toast';

vi.mock('../../../src/storage/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/storage/journal')>();
  return { ...actual, listJournal: vi.fn(actual.listJournal) }; // the real journal, watched
});

const NOW = new Date(2026, 9, 5, 14, 3, 22).getTime();

/** Stores `count` entries, the oldest first: «запись 1» … «запись N». */
async function seed(count: number, extra: Partial<JournalEntry> = {}): Promise<void> {
  await db.journal.bulkAdd(
    Array.from({ length: count }, (_, index) => ({
      ts: NOW + index * 1000,
      level: 'info' as const,
      area: 'ai',
      message: `запись ${index + 1}`,
      ...extra,
    })),
  );
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await db.delete();
  await db.open();
  toasts.value = [];
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.mocked(listJournal).mockClear();
  vi.restoreAllMocks();
});

const button = (name: string) => screen.getByRole('button', { name });
const items = () => screen.queryAllByRole('listitem');
const messages = () => items().map((item) => item.querySelector('.tc-journal__message')?.textContent);

describe('the list', () => {
  it('lists entries newest first with time, level, area and text', async () => {
    await db.journal.bulkAdd([
      { ts: NOW, level: 'info', area: 'ai', message: 'старая запись' },
      { ts: NOW + 60_000, level: 'error', area: 'settings', message: 'новая запись' },
    ]);
    render(<JournalSection />);

    await waitFor(() => expect(items()).toHaveLength(2));
    expect(messages()).toEqual(['новая запись', 'старая запись']);
    const newest = within(items()[0]!);
    expect(newest.getByText('error')).toBeTruthy();
    expect(newest.getByText('settings')).toBeTruthy();
    expect(newest.getByText(new Date(NOW + 60_000).toLocaleString('ru-RU'))).toBeTruthy();
    expect(items()[0]!.getAttribute('data-level')).toBe('error');
    expect(items()[1]!.getAttribute('data-level')).toBe('info');
  });

  it('shows only the newest 100 entries', async () => {
    await seed(150);
    render(<JournalSection />);

    await waitFor(() => expect(items()).toHaveLength(100));
    expect(messages()[0]).toBe('запись 150');
    expect(messages()[99]).toBe('запись 51');
    expect(listJournal).toHaveBeenCalledWith(100);
  });

  it('says so when the journal is empty, but not before it has been read', async () => {
    render(<JournalSection />);
    expect(screen.queryByText('Журнал пуст')).toBeNull();

    await screen.findByText('Журнал пуст');
    expect(items()).toEqual([]);
  });

  it('says so when the journal cannot be read, and reads it on the next try', async () => {
    await seed(1);
    vi.mocked(listJournal).mockRejectedValueOnce(new Error('db closed'));
    render(<JournalSection />);

    expect((await screen.findByRole('alert')).textContent).toBe('Не удалось прочитать журнал');
    expect(items()).toEqual([]);

    fireEvent.click(button('Обновить'));

    // the failure is in the journal it could not show
    await waitFor(() => expect(messages()).toEqual(['Журнал: db closed', 'запись 1']));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('«Обновить»', () => {
  it('picks up the entries written since', async () => {
    await seed(1);
    render(<JournalSection />);
    await waitFor(() => expect(items()).toHaveLength(1));

    await db.journal.add({ ts: NOW + 5000, level: 'warn', area: 'ai', message: 'свежая запись' });
    expect(items()).toHaveLength(1); // nothing moves by itself

    fireEvent.click(button('Обновить'));

    await waitFor(() => expect(messages()).toEqual(['свежая запись', 'запись 1']));
  });
});

describe('«Скопировать всё»', () => {
  it('lists entries and copies the formatted journal', async () => {
    await seed(150, { details: { model: 'a/b' } });
    render(<JournalSection />);
    await waitFor(() => expect(items()).toHaveLength(100));

    fireEvent.click(button('Скопировать всё'));

    await waitFor(() => expect(toasts.value).toHaveLength(1));
    const expected = formatJournal(await db.journal.toCollection().reverse().limit(500).toArray());
    expect(listJournal).toHaveBeenLastCalledWith(500);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(expected.split('\n')).toHaveLength(150); // all of it, not only what the list shows
    expect(expected).toContain('{"model":"a/b"}');
    expect(toasts.value[0]).toMatchObject({ text: 'Журнал скопирован', kind: 'success' });
  });

  it('says so when the clipboard refuses, and leaves the cause in the journal', async () => {
    writeText.mockRejectedValue(new DOMException('Document is not focused', 'NotAllowedError'));
    render(<JournalSection />);
    await screen.findByText('Журнал пуст');

    fireEvent.click(button('Скопировать всё'));

    await waitFor(() => expect(toasts.value).toHaveLength(1));
    expect(toasts.value[0]).toMatchObject({ text: 'Не удалось скопировать журнал', kind: 'error' });
    await waitFor(async () => expect((await db.journal.toArray()).map((e) => e.area)).toEqual(['ui']));
    expect((await db.journal.toArray())[0]?.message).toContain('Document is not focused');
  });
});

describe('«Очистить журнал»', () => {
  it('empties the journal and the list', async () => {
    await seed(3);
    render(<JournalSection />);
    await waitFor(() => expect(items()).toHaveLength(3));

    fireEvent.click(button('Очистить журнал'));

    await screen.findByText('Журнал пуст');
    expect(items()).toEqual([]);
    expect(await db.journal.count()).toBe(0);
  });
});
