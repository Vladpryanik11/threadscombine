import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { SpendSection } from '../../../src/features/settings/SpendSection';
import { purposeLabel } from '../../../src/features/settings/purpose-labels';
import { db, type Account } from '../../../src/storage/db';
import { listJournal } from '../../../src/storage/journal';
import { getSettings, updateSettings } from '../../../src/storage/settings';
import { recordSpend, spendSummary, type SpendSummary } from '../../../src/storage/spend';
import { accounts } from '../../../src/ui/account-signal';
import { initSettingsSignal, settings } from '../../../src/ui/settings-signal';

vi.mock('../../../src/storage/spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/storage/spend')>()),
  spendSummary: vi.fn(),
}));

const LIMIT_ERROR = 'Лимит должен быть от $0.01 до $1000';

const MAIN: Account = { id: 'main-id', name: 'Основной', threadsUsername: '', color: '#3b82f6', createdAt: 1 };

const summary = (extra: Partial<SpendSummary> = {}): SpendSummary => ({
  todayUsd: 0,
  monthUsd: 0,
  byPurpose: [],
  byAccount: [],
  ...extra,
});

/** A promise that is settled by hand, for answers that arrive in the wrong order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let stop: (() => void) | undefined;

/** Stores the settings, starts the signal the way the panel does, and gives the summary. */
async function setUp(patch: Parameters<typeof updateSettings>[0] = {}, answer: SpendSummary = summary()) {
  vi.mocked(spendSummary).mockResolvedValue(answer);
  await updateSettings(patch);
  stop = await initSettingsSignal();
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  accounts.value = [MAIN];
  vi.mocked(spendSummary).mockReset();
});

afterEach(() => {
  cleanup();
  stop?.();
  stop = undefined;
  settings.value = null;
  accounts.value = [];
  vi.restoreAllMocks();
});

const daily = () => screen.getByLabelText('Лимит в день, $') as HTMLInputElement;
const monthly = () => screen.getByLabelText('Лимит в месяц, $') as HTMLInputElement;
const typeInto = (field: HTMLInputElement, text: string) => fireEvent.input(field, { target: { value: text } });
const list = (name: string) => within(screen.getByRole('list', { name }));
const entries = (name: string) => list(name).getAllByRole('listitem').map((item) => item.textContent);

describe('purposeLabel', () => {
  it('names the key check and leaves every other purpose as it is', () => {
    expect(purposeLabel('key-check')).toBe('Проверка ключа');
    expect(purposeLabel('virality')).toBe('virality');
    expect(purposeLabel('')).toBe('');
  });

  it('does not take an inherited property for a known purpose', () => {
    expect(purposeLabel('constructor')).toBe('constructor');
    expect(purposeLabel('toString')).toBe('toString');
    expect(purposeLabel('__proto__')).toBe('__proto__');
  });
});

describe('the summary', () => {
  it('shows totals, purposes and accounts', async () => {
    await setUp(
      {},
      summary({
        todayUsd: 0.1234,
        monthUsd: 1.5,
        byPurpose: [{ purpose: 'key-check', usd: 0.01 }],
        byAccount: [{ accountId: 'gone', usd: 1.5 }],
      }),
    );
    render(<SpendSection />);

    expect(await screen.findByText('Сегодня: $0.12 · За месяц: $1.50')).toBeTruthy();
    expect(entries('За месяц по задачам')).toEqual(['Проверка ключа$0.01']);
    expect(entries('За месяц по аккаунтам')).toEqual(['Удалённый аккаунт$1.50']);
  });

  it('shows amounts below a cent with six decimals, so that a key check is seen to cost something', async () => {
    await setUp(
      {},
      summary({
        todayUsd: 0.000003,
        monthUsd: 0.00003,
        byPurpose: [{ purpose: 'key-check', usd: 0.00003 }],
        byAccount: [{ accountId: MAIN.id, usd: 0.0099 }],
      }),
    );
    render(<SpendSection />);

    expect(await screen.findByText('Сегодня: $0.000003 · За месяц: $0.000030')).toBeTruthy();
    expect(entries('За месяц по задачам')).toEqual(['Проверка ключа$0.000030']);
    expect(entries('За месяц по аккаунтам')).toEqual(['Основной$0.009900']);
  });

  it('keeps two decimals from one cent up, and for nothing at all', async () => {
    await setUp({}, summary({ todayUsd: 0.01, monthUsd: 0, byPurpose: [{ purpose: 'virality', usd: 12.345 }] }));
    render(<SpendSection />);

    expect(await screen.findByText('Сегодня: $0.01 · За месяц: $0.00')).toBeTruthy();
    expect(entries('За месяц по задачам')).toEqual(['virality$12.35']);
  });

  it('names the accounts that still exist and keeps the order of the summary', async () => {
    await setUp(
      {},
      summary({
        todayUsd: 0,
        monthUsd: 3.006,
        byPurpose: [
          { purpose: 'virality', usd: 2 },
          { purpose: 'key-check', usd: 1.006 },
        ],
        byAccount: [
          { accountId: 'gone', usd: 2 },
          { accountId: MAIN.id, usd: 1.006 },
        ],
      }),
    );
    render(<SpendSection />);

    await screen.findByText(/^Сегодня: /);
    expect(entries('За месяц по задачам')).toEqual(['virality$2.00', 'Проверка ключа$1.01']);
    expect(entries('За месяц по аккаунтам')).toEqual(['Удалённый аккаунт$2.00', 'Основной$1.01']);
  });

  it('turns an account into «Удалённый аккаунт» as soon as it is gone from the list', async () => {
    await setUp({}, summary({ monthUsd: 1, byAccount: [{ accountId: MAIN.id, usd: 1 }] }));
    render(<SpendSection />);
    await waitFor(() => expect(entries('За месяц по аккаунтам')).toEqual(['Основной$1.00']));

    accounts.value = [];

    await waitFor(() => expect(entries('За месяц по аккаунтам')).toEqual(['Удалённый аккаунт$1.00']));
  });

  it('leaves out a list that has nothing in it', async () => {
    await setUp();
    render(<SpendSection />);

    await screen.findByText('Сегодня: $0.00 · За месяц: $0.00');
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('За месяц по задачам')).toBeNull();
    expect(screen.queryByText('За месяц по аккаунтам')).toBeNull();
  });

  it('is read when the section opens, and again on «Обновить»', async () => {
    await setUp({}, summary({ monthUsd: 1 }));
    render(<SpendSection />);
    await screen.findByText('Сегодня: $0.00 · За месяц: $1.00');
    expect(spendSummary).toHaveBeenCalledTimes(1);

    vi.mocked(spendSummary).mockResolvedValue(summary({ todayUsd: 0.5, monthUsd: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));

    await screen.findByText('Сегодня: $0.50 · За месяц: $2.00');
    expect(spendSummary).toHaveBeenCalledTimes(2);
  });

  it('keeps the last answer that was asked for when answers arrive out of order', async () => {
    await setUp();
    const first = deferred<SpendSummary>();
    const second = deferred<SpendSummary>();
    vi.mocked(spendSummary).mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<SpendSection />);
    await waitFor(() => expect(spendSummary).toHaveBeenCalledTimes(1)); // the first read, still waiting for its answer
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));

    second.resolve(summary({ monthUsd: 2 }));
    await screen.findByText('Сегодня: $0.00 · За месяц: $2.00');
    first.resolve(summary({ monthUsd: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText('Сегодня: $0.00 · За месяц: $2.00')).toBeTruthy();
    expect(screen.queryByText('Сегодня: $0.00 · За месяц: $1.00')).toBeNull();
  });

  it('shows a general text when the summary cannot be read, keeps the earlier one, and journals the cause', async () => {
    await setUp({}, summary({ monthUsd: 1 }));
    render(<SpendSection />);
    await screen.findByText('Сегодня: $0.00 · За месяц: $1.00');

    vi.mocked(spendSummary).mockRejectedValue(new Error('disk gone'));
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Не удалось прочитать расходы');
    expect(screen.queryByText(/disk gone/)).toBeNull();
    expect(screen.getByText('Сегодня: $0.00 · За месяц: $1.00')).toBeTruthy();
    await waitFor(async () =>
      expect((await listJournal())[0]).toMatchObject({ level: 'error', area: 'ui', message: expect.stringContaining('disk gone') }),
    );

    vi.mocked(spendSummary).mockResolvedValue(summary({ monthUsd: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    await screen.findByText('Сегодня: $0.00 · За месяц: $4.00');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing of the totals, but the notice, when the first read fails', async () => {
    await setUp();
    vi.mocked(spendSummary).mockRejectedValue(new Error('disk gone'));
    render(<SpendSection />);

    expect((await screen.findByRole('alert')).textContent).toBe('Не удалось прочитать расходы');
    expect(screen.queryByText(/^Сегодня: /)).toBeNull();
    expect(screen.getByLabelText('Лимит в день, $')).toBeTruthy(); // the limits stay usable
  });
});

describe('following the spend', () => {
  const paid = (costUsd: number) =>
    recordSpend({
      ts: Date.now(),
      accountId: MAIN.id,
      purpose: 'key-check',
      model: 'm/x',
      promptTokens: 12,
      completionTokens: 3,
      costUsd,
    });

  it('shows what a paid call adds without pressing «Обновить»', async () => {
    const actual = await vi.importActual<typeof import('../../../src/storage/spend')>('../../../src/storage/spend');
    await setUp();
    vi.mocked(spendSummary).mockImplementation(() => actual.spendSummary()); // the real summary over the real table
    render(<SpendSection />);
    await screen.findByText('Сегодня: $0.00 · За месяц: $0.00');

    await paid(0.25);
    await screen.findByText('Сегодня: $0.25 · За месяц: $0.25');
    expect(entries('За месяц по задачам')).toEqual(['Проверка ключа$0.25']);
    expect(entries('За месяц по аккаунтам')).toEqual(['Основной$0.25']);

    await paid(0.5);
    await screen.findByText('Сегодня: $0.75 · За месяц: $0.75');
  });

  it('stops following when the section is gone', async () => {
    await setUp();
    const { unmount } = render(<SpendSection />);
    await waitFor(() => expect(spendSummary).toHaveBeenCalledTimes(1));

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20)); // Preact runs the clean-up a tick later
    await paid(0.25);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spendSummary).toHaveBeenCalledTimes(1);
  });
});

describe('the limits', () => {
  it('shows the stored limits, empty for «no limit»', async () => {
    await setUp({ dailyBudgetUsd: 1.5 });
    render(<SpendSection />);

    expect(daily().value).toBe('1.5');
    expect(monthly().value).toBe('');
  });

  it('saves a limit on blur and on Enter, each in its own field', async () => {
    await setUp();
    render(<SpendSection />);

    typeInto(daily(), '2');
    fireEvent.blur(daily());
    await waitFor(async () => expect((await getSettings()).dailyBudgetUsd).toBe(2));

    typeInto(monthly(), '30');
    fireEvent.keyDown(monthly(), { key: 'Enter' });
    await waitFor(async () => expect((await getSettings()).monthlyBudgetUsd).toBe(30));
    expect((await getSettings()).dailyBudgetUsd).toBe(2); // the other limit is not touched
  });

  it('saves an empty limit as no limit and shows validation errors', async () => {
    await setUp({ dailyBudgetUsd: 5, monthlyBudgetUsd: 50 });
    render(<SpendSection />);

    typeInto(daily(), '');
    fireEvent.blur(daily());
    await waitFor(async () => expect((await getSettings()).dailyBudgetUsd).toBeNull());
    expect(daily().value).toBe('');

    typeInto(monthly(), '0');
    fireEvent.blur(monthly());
    const error = await screen.findByText(LIMIT_ERROR);
    expect(error.getAttribute('role')).toBe('alert');
    expect(monthly().getAttribute('aria-describedby')).toBe(error.id);
    expect(monthly().getAttribute('aria-invalid')).toBe('true');
    expect(monthly().value).toBe('0'); // the text stays so that it can be corrected
    expect((await getSettings()).monthlyBudgetUsd).toBe(50);
    expect(within(daily().closest('.tc-stack') as HTMLElement).queryByRole('alert')).toBeNull(); // only its own field
  });

  it.each([['1000.01'], ['-3'], ['abc'], ['1.2.3'], ['0.001']])('refuses %j', async (text) => {
    await setUp();
    render(<SpendSection />);

    typeInto(daily(), text);
    fireEvent.blur(daily());

    await screen.findByText(LIMIT_ERROR);
    expect((await getSettings()).dailyBudgetUsd).toBeNull();
  });

  it('takes a comma as the decimal separator and shows the saved value back', async () => {
    await setUp();
    render(<SpendSection />);

    typeInto(daily(), ' 1,5 ');
    fireEvent.blur(daily());

    await waitFor(async () => expect((await getSettings()).dailyBudgetUsd).toBe(1.5));
    await waitFor(() => expect(daily().value).toBe('1.5'));
  });

  it('shows the stored form of a limit even when the stored value stays the same', async () => {
    await setUp({ dailyBudgetUsd: 1.5 });
    render(<SpendSection />);

    typeInto(daily(), '1,50');
    fireEvent.blur(daily());

    await waitFor(() => expect(daily().value).toBe('1.5'));
  });

  it('shows a limit as it was stored: rounded to cents', async () => {
    await setUp();
    render(<SpendSection />);

    typeInto(monthly(), '10.456');
    fireEvent.blur(monthly());

    await waitFor(() => expect(monthly().value).toBe('10.46'));
    expect((await getSettings()).monthlyBudgetUsd).toBe(10.46);
  });

  it('drops the error once the text is edited, and when a good value is saved', async () => {
    await setUp();
    render(<SpendSection />);
    typeInto(daily(), '0');
    fireEvent.blur(daily());
    await screen.findByText(LIMIT_ERROR);

    typeInto(daily(), '3');
    expect(screen.queryByText(LIMIT_ERROR)).toBeNull();

    typeInto(daily(), '0');
    fireEvent.blur(daily());
    await screen.findByText(LIMIT_ERROR);
    typeInto(daily(), '4');
    fireEvent.blur(daily());
    await waitFor(async () => expect((await getSettings()).dailyBudgetUsd).toBe(4));
    expect(screen.queryByText(LIMIT_ERROR)).toBeNull();
  });

  it('writes nothing when the text did not change', async () => {
    await setUp({ dailyBudgetUsd: 5 });
    const write = vi.spyOn(fakeBrowser.storage.local, 'set');
    render(<SpendSection />);

    fireEvent.blur(daily());
    fireEvent.keyDown(monthly(), { key: 'Enter' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(write).not.toHaveBeenCalled();
  });

  it('follows a limit that is changed elsewhere', async () => {
    await setUp();
    render(<SpendSection />);
    expect(daily().value).toBe('');

    await updateSettings({ dailyBudgetUsd: 7 });

    await waitFor(() => expect(daily().value).toBe('7'));
  });

  it('shows a general text when the limit cannot be saved for another reason', async () => {
    await setUp();
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('quota'));
    render(<SpendSection />);

    typeInto(daily(), '3');
    fireEvent.blur(daily());

    const error = await screen.findByRole('alert');
    expect(error.textContent).toBe('Не удалось сохранить настройки');
    expect(screen.queryByText(/quota/)).toBeNull();
  });
});

