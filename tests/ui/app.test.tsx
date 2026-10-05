import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { Signal } from '@preact/signals';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../../entrypoints/sidepanel/App';
import { listModels } from '../../src/ai';
import type { ModelInfo } from '../../src/ai/types';
import { db, type Account } from '../../src/storage/db';
import { listJournal } from '../../src/storage/journal';
import { DEFAULT_SETTINGS } from '../../src/storage/settings';
import type { ActiveTabState } from '../../src/threads/active-tab';
import { accounts, activeAccount } from '../../src/ui/account-signal';
import { settings } from '../../src/ui/settings-signal';
import { showToast, toasts } from '../../src/ui/toast';

interface FakeTracker {
  state: Signal<ActiveTabState>;
  refresh: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const created = vi.hoisted(() => [] as unknown[]);

vi.mock('../../src/threads/active-tab', async () => {
  const { signal } = await import('@preact/signals');
  return {
    createActiveTabTracker: () => {
      const tracker = { state: signal({ status: 'not_threads' }), refresh: vi.fn(), dispose: vi.fn() };
      created.push(tracker);
      return tracker;
    },
  };
});

vi.mock('../../src/ui/settings-signal', async () => {
  const { signal } = await import('@preact/signals');
  return { settings: signal(null) };
});

vi.mock('../../src/ui/account-signal', async () => {
  const { signal } = await import('@preact/signals');
  return { accounts: signal([]), activeAccount: signal(null) };
});

vi.mock('../../src/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ai')>()),
  listModels: vi.fn(),
}));

const ACCOUNT: Account = { id: 'a1', name: 'Основной', threadsUsername: '', color: '#3b82f6', createdAt: 1 };

const TABS = ['Аналитика', 'Контент', 'Комментарии', 'Клиенты', 'Чат', 'Настройки'];

const PLACEHOLDERS: Record<string, string> = {
  Аналитика: 'Скоро: сбор постов из ленты, профиля и поиска, таблица и разбор того, что заходит.',
  Контент: 'Скоро: разбор вирусности и генерация веток в вашем стиле.',
  Комментарии: 'Скоро: черновики ответов под постами в выбранном стиле.',
  Клиенты: 'Скоро: поиск людей, которым нужен ваш продукт.',
  Чат: 'Скоро: чат, где ИИ сам запускает инструменты.',
};

const model = (id: string, name: string): ModelInfo => ({
  id,
  name,
  promptPricePerM: 0,
  completionPricePerM: 0,
  contextLength: 1000,
  supportsStructuredOutputs: false,
  supportsReasoning: false,
});

const tracker = () => created[created.length - 1] as FakeTracker;
const tab = (name: string) => screen.getByRole('tab', { name });
const selectedTab = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');

beforeEach(async () => {
  created.length = 0;
  localStorage.clear();
  toasts.value = [];
  settings.value = { ...DEFAULT_SETTINGS };
  accounts.value = [];
  activeAccount.value = ACCOUNT;
  vi.mocked(listModels).mockReset().mockResolvedValue([]); // an empty catalog unless a test says otherwise
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tabs', () => {
  it('shows six tabs and the analytics placeholder by default', () => {
    render(<App />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(TABS);
    expect(selectedTab()?.textContent).toBe('Аналитика');
    expect(screen.getByText(PLACEHOLDERS['Аналитика']!)).toBeTruthy();
  });

  it.each(Object.keys(PLACEHOLDERS))('«%s» shows its own placeholder and no other', (name) => {
    render(<App />);
    fireEvent.click(tab(name));
    expect(selectedTab()?.textContent).toBe(name);
    expect(screen.getByText(PLACEHOLDERS[name]!)).toBeTruthy();
    expect(screen.getAllByText(/^Скоро: /)).toHaveLength(1);
  });

  it('«Настройки» shows the settings screen instead of a placeholder', () => {
    const { container } = render(<App />);
    fireEvent.click(tab('Настройки'));
    expect(container.querySelector('[data-screen="settings"]')).not.toBeNull();
    expect(screen.queryByText(/^Скоро: /)).toBeNull();
  });

  it('«Настройки» lists the key, models and theme sections', () => {
    render(<App />);
    fireEvent.click(tab('Настройки'));
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Ключ OpenRouter', 'Модели', 'Оформление']);
  });

  it('«Настройки» says so when the settings could not be read', () => {
    settings.value = null;
    render(<App />);
    fireEvent.click(tab('Настройки'));
    expect(screen.getByRole('alert').textContent).toContain('Не удалось прочитать настройки');
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('remembers the selected tab', () => {
    render(<App />);
    fireEvent.click(tab('Чат'));
    expect(localStorage.getItem('tc.activeTab')).toBe('chat');

    cleanup();
    render(<App />);
    expect(selectedTab()?.textContent).toBe('Чат');
    expect(screen.getByText(PLACEHOLDERS['Чат']!)).toBeTruthy();
  });

  it('falls back to analytics for an unknown stored value', () => {
    localStorage.setItem('tc.activeTab', 'bogus');
    render(<App />);
    expect(selectedTab()?.textContent).toBe('Аналитика');
  });

  it('works when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<App />);
    expect(selectedTab()?.textContent).toBe('Аналитика');
    fireEvent.click(tab('Клиенты'));
    expect(selectedTab()?.textContent).toBe('Клиенты');
  });
});

describe('model chip', () => {
  it('says «Модель не выбрана» and opens settings', () => {
    render(<App />);
    expect(selectedTab()?.textContent).toBe('Аналитика');
    expect(listModels).not.toHaveBeenCalled(); // the chip has no model to look up (the settings screen reads the catalog itself)
    fireEvent.click(screen.getByRole('button', { name: 'Модель не выбрана' }));
    expect(selectedTab()?.textContent).toBe('Настройки');
  });

  it('shows the model id at once and its catalog name once the catalog resolves', async () => {
    let resolveCatalog: (models: ModelInfo[]) => void = () => {};
    vi.mocked(listModels).mockReturnValue(new Promise((resolve) => (resolveCatalog = resolve)));
    settings.value = { ...DEFAULT_SETTINGS, model: 'openai/gpt-x' };
    render(<App />);
    expect(screen.getByRole('button', { name: 'openai/gpt-x' })).toBeTruthy();

    await act(() => resolveCatalog([model('a/b', 'Другая'), model('openai/gpt-x', 'GPT X')]));
    await screen.findByRole('button', { name: 'GPT X' });
    expect(screen.queryByRole('button', { name: 'openai/gpt-x' })).toBeNull();
  });

  it('keeps the id when the catalog fails or does not know the model', async () => {
    settings.value = { ...DEFAULT_SETTINGS, model: 'openai/gpt-x' };
    vi.mocked(listModels).mockRejectedValue(new Error('offline'));
    render(<App />);
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'openai/gpt-x' })).toBeTruthy();

    cleanup();
    vi.mocked(listModels).mockResolvedValue([model('a/b', 'Другая')]);
    render(<App />);
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'openai/gpt-x' })).toBeTruthy();
  });

  it('follows a change of the model, showing the new id until the catalog names it', async () => {
    vi.mocked(listModels)
      .mockResolvedValueOnce([model('a/b', 'Первая'), model('c/d', 'Вторая')])
      .mockReturnValueOnce(new Promise(() => {})); // the second look at the catalog never answers
    settings.value = { ...DEFAULT_SETTINGS, model: 'a/b' };
    render(<App />);
    await screen.findByRole('button', { name: 'Первая' });

    await act(() => {
      settings.value = { ...DEFAULT_SETTINGS, model: 'c/d' };
    });
    expect(screen.getByRole('button', { name: 'c/d' })).toBeTruthy();

    await act(() => {
      settings.value = { ...DEFAULT_SETTINGS, model: '' };
    });
    expect(screen.getByRole('button', { name: 'Модель не выбрана' })).toBeTruthy();
  });

  it('ignores a late catalog answer for a model that is no longer selected', async () => {
    let answerForFirst: (models: ModelInfo[]) => void = () => {};
    vi.mocked(listModels)
      .mockReturnValueOnce(new Promise((resolve) => (answerForFirst = resolve)))
      .mockResolvedValueOnce([model('a/b', 'Первая'), model('c/d', 'Вторая')]);
    settings.value = { ...DEFAULT_SETTINGS, model: 'a/b' };
    render(<App />);
    await act(() => {
      settings.value = { ...DEFAULT_SETTINGS, model: 'c/d' };
    });
    await screen.findByRole('button', { name: 'Вторая' });

    await act(() => answerForFirst([model('a/b', 'Первая')]));
    await new Promise((resolve) => setTimeout(resolve, 30)); // let a (wrong) re-render happen
    expect(screen.getByRole('button', { name: 'Вторая' })).toBeTruthy();
  });

  it('does not claim a model before the settings are loaded', () => {
    settings.value = null;
    render(<App />);
    expect(screen.getByRole('button', { name: 'Модель не выбрана' })).toBeTruthy();
  });
});

describe('page chip', () => {
  it.each<[ActiveTabState, string]>([
    [{ status: 'loading' }, '…'],
    [{ status: 'not_threads' }, 'Откройте Threads'],
    [{ status: 'ready', tabId: 1, page: { kind: 'profile', url: 'u', username: 'zuck' } }, 'Профиль @zuck'],
  ])('shows %o as «%s»', (state, label) => {
    render(<App />);
    act(() => {
      tracker().state.value = state;
    });
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Обновить' })).toBeNull();
  });

  it('offers to reload the tab when the content script is missing', async () => {
    const reload = vi.spyOn(fakeBrowser.tabs, 'reload').mockResolvedValue(undefined);
    render(<App />);
    act(() => {
      tracker().state.value = { status: 'needs_reload', tabId: 7 };
    });
    expect(screen.getByText('Обновите вкладку')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(reload).toHaveBeenCalledWith(7);
  });

  it('journals a failed reload instead of throwing', async () => {
    vi.spyOn(fakeBrowser.tabs, 'reload').mockRejectedValue(new Error('tab closed'));
    render(<App />);
    act(() => {
      tracker().state.value = { status: 'needs_reload', tabId: 7 };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    await waitFor(async () =>
      expect((await listJournal())[0]).toMatchObject({ level: 'warn', area: 'ui', message: expect.stringContaining('tab closed') }),
    );
  });
});

describe('lifecycle', () => {
  it('starts one tracker and disposes it when the panel closes', async () => {
    const { unmount } = render(<App />);
    expect(created).toHaveLength(1);
    expect(tracker().dispose).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(tracker().dispose).toHaveBeenCalledTimes(1)); // Preact runs effect clean-ups a tick later
  });

  it('renders the toasts', async () => {
    render(<App />);
    await act(() => showToast('Сохранено', 'success'));
    expect(screen.getByText('Сохранено')).toBeTruthy();
  });
});
