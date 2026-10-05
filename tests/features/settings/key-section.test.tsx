import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { streamText, type AiResult } from '../../../src/ai';
import { aiError } from '../../../src/ai/errors';
import { KeySection } from '../../../src/features/settings/KeySection';
import { keyCheckMessages } from '../../../src/prompts/key-check';
import { db } from '../../../src/storage/db';
import { getSettings, updateSettings } from '../../../src/storage/settings';
import { initSettingsSignal, settings } from '../../../src/ui/settings-signal';
import { Toasts, toasts } from '../../../src/ui/toast';

vi.mock('../../../src/ai', () => ({ streamText: vi.fn() }));

const KEY = 'sk-or-v1-secret';

type Answer = Extract<AiResult<string>, { ok: true }>;

const answered = (extra: Partial<Answer> = {}): Answer => ({
  ok: true,
  value: 'Работает',
  model: 'deepseek/deepseek-v4.1-flash',
  usage: { promptTokens: 12, completionTokens: 3, costUsd: 0.00001 },
  switchedFrom: [],
  elapsedMs: 1234,
  ...extra,
});

const failed = (code: Parameters<typeof aiError>[0]): AiResult<string> => ({ ok: false, error: aiError(code) });

let stop: () => void;

beforeEach(async () => {
  await db.delete();
  await db.open();
  toasts.value = [];
  vi.mocked(streamText).mockReset();
  await updateSettings({ openRouterKey: KEY, model: 'deepseek/deepseek-v4.1-flash' });
  stop = await initSettingsSignal();
});

afterEach(() => {
  cleanup();
  stop();
  settings.value = null;
  vi.restoreAllMocks();
});

const field = () => screen.getByLabelText('Ключ OpenRouter') as HTMLInputElement;
const check = () => fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));

describe('the key field', () => {
  it('is a password field that «показать» turns into text and back', () => {
    render(<KeySection />);
    expect(field().type).toBe('password');
    expect(field().value).toBe(KEY);

    fireEvent.click(screen.getByRole('button', { name: 'показать' }));
    expect(field().type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'скрыть' }));
    expect(field().type).toBe('password');
  });

  it('links to the page where the key is issued, in a new tab', () => {
    render(<KeySection />);
    const link = screen.getByRole('link', { name: 'Где взять ключ' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://openrouter.ai/keys');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('saves a pasted key trimmed on blur', async () => {
    render(<KeySection />);
    fireEvent.input(field(), { target: { value: ' sk-or-v1-x ' } });
    fireEvent.blur(field());

    await waitFor(async () => expect((await getSettings()).openRouterKey).toBe('sk-or-v1-x'));
    await waitFor(() => expect(field().value).toBe('sk-or-v1-x'));
  });

  it('shows the stored form of the key again even when only the spaces around it were new', async () => {
    render(<KeySection />);
    fireEvent.input(field(), { target: { value: `  ${KEY}  ` } });
    fireEvent.blur(field());

    await waitFor(() => expect(field().value).toBe(KEY));
    expect((await getSettings()).openRouterKey).toBe(KEY);
  });

  it('saves on Enter', async () => {
    render(<KeySection />);
    fireEvent.input(field(), { target: { value: 'sk-or-v1-enter' } });
    fireEvent.keyDown(field(), { key: 'Enter' });

    await waitFor(async () => expect((await getSettings()).openRouterKey).toBe('sk-or-v1-enter'));
  });

  it('does not write anything when the key was not changed', async () => {
    const write = vi.spyOn(fakeBrowser.storage.local, 'set');
    render(<KeySection />);
    fireEvent.blur(field());
    fireEvent.keyDown(field(), { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(write).not.toHaveBeenCalled();
  });

  it('can clear the key', async () => {
    render(<KeySection />);
    fireEvent.input(field(), { target: { value: '' } });
    fireEvent.blur(field());
    await waitFor(async () => expect((await getSettings()).openRouterKey).toBe(''));
  });

  it('shows the stored key again when it changes elsewhere', async () => {
    render(<KeySection />);
    await act(async () => {
      await updateSettings({ openRouterKey: 'sk-or-v1-imported' });
    });
    await waitFor(() => expect(field().value).toBe('sk-or-v1-imported'));
  });

  it('tells about a save that failed, without the key', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('disk gone'));
    render(
      <>
        <KeySection />
        <Toasts />
      </>,
    );
    fireEvent.input(field(), { target: { value: 'sk-or-v1-new' } });
    fireEvent.blur(field());

    const toast = await screen.findByText('Не удалось сохранить настройки');
    expect(toast.textContent).not.toContain('sk-or-v1-new');
  });
});

describe('the key check', () => {
  it('asks a one-word question under the key-check purpose', async () => {
    vi.mocked(streamText).mockResolvedValue(answered());
    render(<KeySection />);
    check();

    await screen.findByText('Работает');
    expect(streamText).toHaveBeenCalledTimes(1);
    const [req] = vi.mocked(streamText).mock.calls[0]!;
    expect(req.purpose).toBe('key-check');
    expect(req.messages).toEqual(keyCheckMessages());
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('shows answer, time, tokens and cost on success', async () => {
    vi.mocked(streamText).mockResolvedValue(answered());
    const { container } = render(<KeySection />);
    check();

    await screen.findByText('Работает');
    expect(screen.getByText('deepseek/deepseek-v4.1-flash')).toBeTruthy();
    expect(screen.getByText('1.2 с')).toBeTruthy();
    expect(screen.getByText('12 + 3')).toBeTruthy();
    expect(screen.getByText('$0.000010')).toBeTruthy();
    expect(screen.queryByText(/Переключились/)).toBeNull();
    expect(container.textContent).not.toContain(KEY);
  });

  it('leaves out the tokens and the cost when there is no usage to report', async () => {
    const { usage: _usage, ...withoutUsage } = answered();
    vi.mocked(streamText).mockResolvedValue(withoutUsage);
    render(<KeySection />);
    check();

    await screen.findByText('Работает');
    expect(screen.queryByText('Токены')).toBeNull();
    expect(screen.queryByText('Стоимость')).toBeNull();
  });

  it('leaves out the cost alone when OpenRouter gave no price', async () => {
    vi.mocked(streamText).mockResolvedValue(answered({ usage: { promptTokens: 12, completionTokens: 3 } }));
    render(<KeySection />);
    check();

    await screen.findByText('12 + 3');
    expect(screen.queryByText('Стоимость')).toBeNull();
  });

  it('says which model took over when the chain switched', async () => {
    vi.mocked(streamText).mockResolvedValue(
      answered({ model: 'openai/gpt-6-luna', switchedFrom: ['deepseek/deepseek-v4.1-flash'] }),
    );
    render(<KeySection />);
    check();

    await screen.findByText('Переключились на openai/gpt-6-luna');
  });

  it('shows «Неверный ключ OpenRouter» on bad_key', async () => {
    vi.mocked(streamText).mockResolvedValue(failed('bad_key'));
    render(<KeySection />);
    check();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Неверный ключ OpenRouter');
    expect(screen.queryByText('Работает')).toBeNull();
  });

  it('turns «Проверить» into «Стоп» while it runs, and «Стоп» cancels the request', async () => {
    vi.mocked(streamText).mockImplementation(
      (req) =>
        new Promise((resolve) => {
          req.signal?.addEventListener('abort', () => resolve(failed('cancelled')));
        }),
    );
    render(<KeySection />);
    check();

    const stopButton = await screen.findByRole('button', { name: 'Стоп' });
    expect(screen.queryByRole('button', { name: 'Проверить' })).toBeNull();
    const signal = vi.mocked(streamText).mock.calls[0]![0].signal!;
    expect(signal.aborted).toBe(false);

    fireEvent.click(stopButton);
    expect(signal.aborted).toBe(true);
    await screen.findByText('Остановлено');
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeTruthy();
  });

  it('clears the previous result when a new check starts', async () => {
    vi.mocked(streamText).mockResolvedValueOnce(failed('bad_key')).mockReturnValueOnce(new Promise(() => {}));
    render(<KeySection />);
    check();
    await screen.findByText('Неверный ключ OpenRouter');

    check();
    await screen.findByRole('button', { name: 'Стоп' });
    expect(screen.queryByText('Неверный ключ OpenRouter')).toBeNull();
  });

  it('cancels a running check when the section goes away', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(streamText).mockImplementation((req) => {
      signal = req.signal;
      return new Promise(() => {});
    });
    const { unmount } = render(<KeySection />);
    check();
    await screen.findByRole('button', { name: 'Стоп' });
    expect(signal?.aborted).toBe(false);

    unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true)); // Preact runs effect clean-ups a tick later
  });

  it('survives a check that throws instead of answering', async () => {
    vi.mocked(streamText).mockRejectedValue(new Error('storage is gone'));
    render(<KeySection />);
    check();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Не удалось выполнить проверку');
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeTruthy();
  });
});
