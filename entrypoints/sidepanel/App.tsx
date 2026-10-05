import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { Placeholder } from '../../src/features/placeholders/Placeholder';
import { SettingsScreen } from '../../src/features/settings/SettingsScreen';
import { listModels } from '../../src/ai';
import { findModel } from '../../src/ai/catalog';
import { log } from '../../src/storage/journal';
import { createActiveTabTracker, type ActiveTabState } from '../../src/threads/active-tab';
import { AccountSwitcher } from '../../src/ui/AccountSwitcher';
import { Button } from '../../src/ui/components';
import { pageChipLabel } from '../../src/ui/page-chip';
import { settings } from '../../src/ui/settings-signal';
import { Toasts } from '../../src/ui/toast';

export type TabId = 'analytics' | 'content' | 'comments' | 'leads' | 'chat' | 'settings';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'analytics', label: 'Аналитика' },
  { id: 'content', label: 'Контент' },
  { id: 'comments', label: 'Комментарии' },
  { id: 'leads', label: 'Клиенты' },
  { id: 'chat', label: 'Чат' },
  { id: 'settings', label: 'Настройки' },
];

const PLACEHOLDERS: Record<Exclude<TabId, 'settings'>, string> = {
  analytics: 'Скоро: сбор постов из ленты, профиля и поиска, таблица и разбор того, что заходит.',
  content: 'Скоро: разбор вирусности и генерация веток в вашем стиле.',
  comments: 'Скоро: черновики ответов под постами в выбранном стиле.',
  leads: 'Скоро: поиск людей, которым нужен ваш продукт.',
  chat: 'Скоро: чат, где ИИ сам запускает инструменты.',
};

const TAB_KEY = 'tc.activeTab';
const DEFAULT_TAB: TabId = 'analytics';

function readStoredTab(): TabId {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    return TABS.find((tab) => tab.id === stored)?.id ?? DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

function storeTab(id: TabId): void {
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    // remembering the tab is a convenience, not a requirement
  }
}

async function reloadTab(tabId: number): Promise<void> {
  try {
    await browser.tabs.reload(tabId);
  } catch (error) {
    await log('warn', 'ui', `Не удалось обновить вкладку: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Name of the model in the OpenRouter catalog; `undefined` until the catalog answers or when it cannot say. */
function useModelName(modelId: string): string | undefined {
  const [found, setFound] = useState<{ id: string; name: string }>();
  useEffect(() => {
    if (modelId === '') return;
    let current = true;
    void (async () => {
      try {
        const info = findModel(await listModels(), modelId);
        if (current && info) setFound({ id: modelId, name: info.name });
      } catch {
        // the chip keeps showing the id
      }
    })();
    return () => {
      current = false;
    };
  }, [modelId]);
  return found?.id === modelId ? found.name : undefined;
}

function PageChip({ state }: { state: ActiveTabState }) {
  return (
    <span class="tc-chip">
      <span>{pageChipLabel(state)}</span>
      {state.status === 'needs_reload' && (
        <Button class="tc-chip__action" onClick={() => void reloadTab(state.tabId)}>
          Обновить
        </Button>
      )}
    </span>
  );
}

function ModelChip({ onOpen }: { onOpen: () => void }) {
  const modelId = settings.value?.model ?? '';
  const name = useModelName(modelId);
  return (
    <button type="button" class="tc-chip tc-chip--button" onClick={onOpen}>
      {modelId === '' ? 'Модель не выбрана' : (name ?? modelId)}
    </button>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>(readStoredTab);
  const [tracker] = useState(createActiveTabTracker);
  useEffect(() => () => tracker.dispose(), [tracker]);

  const select = (id: TabId): void => {
    setTab(id);
    storeTab(id);
  };

  return (
    <div class="tc-app">
      <header class="tc-topbar">
        <AccountSwitcher />
        <PageChip state={tracker.state.value} />
        <ModelChip onOpen={() => select('settings')} />
      </header>
      <nav class="tc-tabs" role="tablist">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tc-tab-${id}`}
            class="tc-tab"
            aria-selected={tab === id}
            aria-controls="tc-tabpanel"
            onClick={() => select(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div class="tc-content" role="tabpanel" id="tc-tabpanel" aria-labelledby={`tc-tab-${tab}`}>
        {tab === 'settings' ? <SettingsScreen /> : <Placeholder text={PLACEHOLDERS[tab]} />}
      </div>
      <Toasts />
    </div>
  );
}
