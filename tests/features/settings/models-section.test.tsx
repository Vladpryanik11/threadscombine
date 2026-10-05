import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { AiFailure, listModels, type ModelInfo } from '../../../src/ai';
import { aiError } from '../../../src/ai/errors';
import { ModelsSection } from '../../../src/features/settings/ModelsSection';
import { db } from '../../../src/storage/db';
import { getSettings, updateSettings, type Settings } from '../../../src/storage/settings';
import { initSettingsSignal, settings } from '../../../src/ui/settings-signal';
import { Toasts, toasts } from '../../../src/ui/toast';

vi.mock('../../../src/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai')>()),
  listModels: vi.fn(),
}));

const model = (id: string, name: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name,
  promptPricePerM: 0.1,
  completionPricePerM: 0.5,
  contextLength: 1000,
  supportsStructuredOutputs: false,
  supportsReasoning: false,
  ...extra,
});

const CATALOG = [
  model('zeta/model', 'Zeta'),
  model('alpha/model', 'Alpha', { supportsReasoning: true }),
  model('openai/gpt-6-luna', 'GPT-6 Luna'),
  model('beta/model', 'Beta'),
  model('gamma/model', 'Gamma'),
];

let stop: (() => void) | undefined;

/** Stores the settings, starts the signal the way the panel does, and gives the catalog. */
async function setUp(patch: Partial<Omit<Settings, 'version'>> = {}, catalog: ModelInfo[] = CATALOG) {
  vi.mocked(listModels).mockResolvedValue(catalog);
  await updateSettings(patch);
  stop = await initSettingsSignal();
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  toasts.value = [];
  vi.mocked(listModels).mockReset();
});

afterEach(() => {
  cleanup();
  stop?.();
  stop = undefined;
  settings.value = null;
  vi.restoreAllMocks();
});

const select = (name: string) => screen.getByLabelText(name) as HTMLSelectElement;
const optionTexts = (name: string) => [...select(name).options].map((o) => o.textContent);
const chosen = (name: string) => select(name).selectedOptions[0]?.textContent;
const stored = () => getSettings();
/** Waits for the catalog to arrive: the main list then has more than the one saved/placeholder option. */
const loaded = () => waitFor(() => expect(select('Основная модель').options.length).toBeGreaterThan(1));

describe('the main model', () => {
  it('lists the catalog with prices, recommended first', async () => {
    await setUp({ model: 'alpha/model' });
    render(<ModelsSection />);
    await loaded();

    expect(optionTexts('Основная модель')).toEqual([
      'GPT-6 Luna — $0.1 / $0.5 за 1M · рекомендуем',
      'Alpha — $0.1 / $0.5 за 1M',
      'Beta — $0.1 / $0.5 за 1M',
      'Gamma — $0.1 / $0.5 за 1M',
      'Zeta — $0.1 / $0.5 за 1M',
    ]);
    expect(chosen('Основная модель')).toBe('Alpha — $0.1 / $0.5 за 1M');
  });

  it('shows a saved model missing from the catalog', async () => {
    await setUp({ model: 'gone/model' });
    render(<ModelsSection />);
    await loaded();

    expect(chosen('Основная модель')).toBe('gone/model (нет в каталоге)');
    expect(select('Основная модель').value).toBe('gone/model');
    expect(optionTexts('Основная модель')).toHaveLength(CATALOG.length + 1);
  });

  it('asks to choose a model while none is chosen', async () => {
    await setUp();
    render(<ModelsSection />);
    await loaded();

    expect(chosen('Основная модель')).toBe('Выберите модель');
    fireEvent.change(select('Основная модель'), { target: { value: 'beta/model' } });
    await waitFor(async () => expect((await stored()).model).toBe('beta/model'));
    await waitFor(() => expect(optionTexts('Основная модель')).not.toContain('Выберите модель'));
  });

  it('narrows the list by the search text, keeping the chosen model in it', async () => {
    await setUp({ model: 'zeta/model' });
    render(<ModelsSection />);
    await loaded();

    fireEvent.input(screen.getByLabelText('Поиск модели'), { target: { value: 'GAM' } });
    expect(optionTexts('Основная модель')).toEqual([
      'Zeta — $0.1 / $0.5 за 1M', // the chosen one stays so that the list does not lie about the value
      'Gamma — $0.1 / $0.5 за 1M',
    ]);
    expect(select('Основная модель').value).toBe('zeta/model');

    fireEvent.input(screen.getByLabelText('Поиск модели'), { target: { value: 'nothing like it' } });
    expect(optionTexts('Основная модель')).toEqual(['Zeta — $0.1 / $0.5 за 1M']);
  });

  it('saves the model chosen from the list', async () => {
    await setUp({ model: 'alpha/model' });
    render(<ModelsSection />);
    await loaded();

    fireEvent.change(select('Основная модель'), { target: { value: 'gamma/model' } });
    await waitFor(async () => expect((await stored()).model).toBe('gamma/model'));
  });

  it('drops the new main model from the fallbacks', async () => {
    await setUp({ model: 'alpha/model', fallbackModels: ['gamma/model'] });
    render(<ModelsSection />);
    await loaded();

    fireEvent.change(select('Основная модель'), { target: { value: 'gamma/model' } });
    await waitFor(async () => expect((await stored()).fallbackModels).toEqual([]));
    await waitFor(() => expect(chosen('Запасная модель 1')).toBe('Не выбрана'));
  });
});

describe('reasoning', () => {
  it('disables reasoning when the main model does not support it', async () => {
    await setUp({ model: 'beta/model' });
    render(<ModelsSection />);
    await loaded();

    expect(select('Рассуждение').disabled).toBe(true);
    expect(screen.getByText('Модель не поддерживает рассуждение')).toBeTruthy();
  });

  it('disables reasoning when the main model is not in the catalog', async () => {
    await setUp({ model: 'gone/model' });
    render(<ModelsSection />);
    await loaded();

    expect(select('Рассуждение').disabled).toBe(true);
    expect(screen.getByText('Модель не поддерживает рассуждение')).toBeTruthy();
  });

  it('lets a supporting model be given a level, and saves it', async () => {
    await setUp({ model: 'alpha/model' });
    render(<ModelsSection />);
    await loaded();

    expect(select('Рассуждение').disabled).toBe(false);
    expect(screen.queryByText('Модель не поддерживает рассуждение')).toBeNull();
    expect(optionTexts('Рассуждение')).toEqual(['Выкл', 'Низкое', 'Среднее', 'Высокое']);

    fireEvent.change(select('Рассуждение'), { target: { value: 'medium' } });
    await waitFor(async () => expect((await stored()).reasoning).toBe('medium'));
  });

  it('does not claim anything about reasoning before the catalog has answered', async () => {
    await setUp({ model: 'alpha/model' });
    vi.mocked(listModels).mockReturnValue(new Promise(() => {}));
    render(<ModelsSection />);

    expect(select('Рассуждение').disabled).toBe(true);
    expect(screen.queryByText('Модель не поддерживает рассуждение')).toBeNull();
  });
});

describe('fallback models', () => {
  it('is on by default and can be switched off, which hides the choices', async () => {
    await setUp({ model: 'alpha/model' });
    render(<ModelsSection />);
    await loaded();

    const toggle = screen.getByRole('switch', { name: 'Запасные модели' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByLabelText('Запасная модель 1')).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(async () => expect((await stored()).fallbackEnabled).toBe(false));
    await waitFor(() => expect(screen.queryByLabelText('Запасная модель 1')).toBeNull());
  });

  it('offers at most two fallbacks and never the main model', async () => {
    await setUp({ model: 'alpha/model' });
    render(<ModelsSection />);
    await loaded();

    // only the first choice at first, and it does not offer the main model
    expect(screen.queryByLabelText('Запасная модель 2')).toBeNull();
    expect(optionTexts('Запасная модель 1')).toHaveLength(1 + CATALOG.length - 1); // «Не выбрана» + all but the main
    expect(select('Запасная модель 1').querySelector('option[value="alpha/model"]')).toBeNull();

    fireEvent.change(select('Запасная модель 1'), { target: { value: 'beta/model' } });
    await waitFor(async () => expect((await stored()).fallbackModels).toEqual(['beta/model']));
    // the second choice appears, offering neither the main model nor the first fallback
    await waitFor(() => expect(screen.getByLabelText('Запасная модель 2')).toBeTruthy());
    const second = select('Запасная модель 2');
    expect(second.querySelector('option[value="alpha/model"]')).toBeNull();
    expect(second.querySelector('option[value="beta/model"]')).toBeNull();

    fireEvent.change(second, { target: { value: 'gamma/model' } });
    await waitFor(async () => expect((await stored()).fallbackModels).toEqual(['beta/model', 'gamma/model']));
    await waitFor(() => {
      // and the first choice no longer offers the second fallback
      expect(select('Запасная модель 1').querySelector('option[value="gamma/model"]')).toBeNull();
      expect(select('Запасная модель 1').value).toBe('beta/model');
    });
    expect(screen.queryByLabelText('Запасная модель 3')).toBeNull();
    expect(screen.getAllByLabelText(/^Запасная модель \d$/)).toHaveLength(2);
  });

  it('shows a saved fallback that is missing from the catalog', async () => {
    await setUp({ model: 'alpha/model', fallbackModels: ['gone/model'] });
    render(<ModelsSection />);
    await loaded();

    expect(chosen('Запасная модель 1')).toBe('gone/model (нет в каталоге)');
  });

  it('can be cleared', async () => {
    await setUp({ model: 'alpha/model', fallbackModels: ['beta/model', 'gamma/model'] });
    render(<ModelsSection />);
    await loaded();

    fireEvent.change(select('Запасная модель 2'), { target: { value: '' } });
    await waitFor(async () => expect((await stored()).fallbackModels).toEqual(['beta/model']));
    fireEvent.change(select('Запасная модель 1'), { target: { value: '' } });
    await waitFor(async () => expect((await stored()).fallbackModels).toEqual([]));
  });
});

describe('the timeout', () => {
  const timeout = () => screen.getByLabelText('Таймаут, сек') as HTMLInputElement;

  it('shows the stored value and saves a new one on blur', async () => {
    await setUp({ requestTimeoutSec: 120 });
    render(<ModelsSection />);
    expect(timeout().value).toBe('120');

    fireEvent.input(timeout(), { target: { value: '45' } });
    fireEvent.blur(timeout());
    await waitFor(async () => expect((await stored()).requestTimeoutSec).toBe(45));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('saves on Enter', async () => {
    await setUp();
    render(<ModelsSection />);
    fireEvent.input(timeout(), { target: { value: '200' } });
    fireEvent.keyDown(timeout(), { key: 'Enter' });
    await waitFor(async () => expect((await stored()).requestTimeoutSec).toBe(200));
  });

  it.each(['5', '301', '', '90.5'])('refuses «%s» with the text under the field, and stores nothing', async (value) => {
    await setUp({ requestTimeoutSec: 60 });
    render(<ModelsSection />);
    fireEvent.input(timeout(), { target: { value } });
    fireEvent.blur(timeout());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Таймаут должен быть от 15 до 300 секунд');
    expect(timeout().value).toBe(value); // what was typed is kept for correcting
    expect((await stored()).requestTimeoutSec).toBe(60);
  });

  it('takes the text away once the value is corrected', async () => {
    await setUp();
    render(<ModelsSection />);
    fireEvent.input(timeout(), { target: { value: '5' } });
    fireEvent.blur(timeout());
    await screen.findByRole('alert');

    fireEvent.input(timeout(), { target: { value: '30' } });
    fireEvent.blur(timeout());
    await waitFor(async () => expect((await stored()).requestTimeoutSec).toBe(30));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the value again when it changes elsewhere', async () => {
    await setUp();
    render(<ModelsSection />);
    await act(async () => {
      await updateSettings({ requestTimeoutSec: 150 });
    });
    await waitFor(() => expect(timeout().value).toBe('150'));
  });
});

describe('the catalog', () => {
  it('shows the catalog error with a retry button', async () => {
    await setUp({ model: 'alpha/model' });
    vi.mocked(listModels).mockRejectedValue(new AiFailure(aiError('network')));
    render(<ModelsSection />);

    expect((await screen.findByRole('alert')).textContent).toContain('Нет связи с OpenRouter');
    expect(listModels).toHaveBeenCalledTimes(1);

    vi.mocked(listModels).mockResolvedValue(CATALOG);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await loaded();
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });

  it('says «Нет связи с OpenRouter» for an error that is not an AiFailure', async () => {
    await setUp();
    vi.mocked(listModels).mockRejectedValue(new Error('storage is gone'));
    render(<ModelsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('Нет связи с OpenRouter');
  });

  it('shows the text of an AiFailure as it is', async () => {
    await setUp();
    vi.mocked(listModels).mockRejectedValue(new AiFailure(aiError('rate_limited')));
    render(<ModelsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'OpenRouter ограничил частоту запросов, попробуйте через минуту',
    );
  });

  it('keeps the saved model visible, by its id, while the catalog is unknown', async () => {
    await setUp({ model: 'alpha/model' });
    vi.mocked(listModels).mockRejectedValue(new AiFailure(aiError('network')));
    render(<ModelsSection />);
    await screen.findByRole('alert');

    expect(chosen('Основная модель')).toBe('alpha/model'); // not «нет в каталоге»: nobody knows
    expect(select('Основная модель').disabled).toBe(true);
  });

  it('refreshes the list with force and shows what comes back', async () => {
    await setUp({ model: 'alpha/model' });
    render(<ModelsSection />);
    await loaded();
    expect(listModels).toHaveBeenLastCalledWith({ force: false });

    vi.mocked(listModels).mockResolvedValue([...CATALOG, model('new/model', 'Newcomer')]);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить список' }));
    await waitFor(() => expect(optionTexts('Основная модель')).toContain('Newcomer — $0.1 / $0.5 за 1M'));
    expect(listModels).toHaveBeenLastCalledWith({ force: true });
  });

  it('keeps the list when a refresh fails, and says why', async () => {
    await setUp({ model: 'alpha/model' });
    render(<ModelsSection />);
    await loaded();

    vi.mocked(listModels).mockRejectedValue(new AiFailure(aiError('network')));
    fireEvent.click(screen.getByRole('button', { name: 'Обновить список' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Нет связи с OpenRouter');
    expect(optionTexts('Основная модель')).toHaveLength(CATALOG.length);
  });

  it('does not start a second request while one is running', async () => {
    await setUp();
    vi.mocked(listModels).mockReturnValue(new Promise(() => {}));
    render(<ModelsSection />);
    const refresh = screen.getByRole('button', { name: 'Обновить список' }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('ignores an answer that arrives after the section went away', async () => {
    await setUp();
    let answer: (models: ModelInfo[]) => void = () => {};
    vi.mocked(listModels).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { unmount } = render(<ModelsSection />);
    unmount();
    await act(() => answer(CATALOG));
    expect(screen.queryByLabelText('Основная модель')).toBeNull();
  });
});

describe('saving trouble', () => {
  it('shows a toast when the storage refuses a choice', async () => {
    await setUp({ model: 'alpha/model' });
    render(
      <>
        <ModelsSection />
        <Toasts />
      </>,
    );
    await loaded();

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('disk gone'));
    fireEvent.change(select('Основная модель'), { target: { value: 'gamma/model' } });
    await screen.findByText('Не удалось сохранить настройки');
  });
});
