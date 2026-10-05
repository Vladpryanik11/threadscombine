import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AiFailure, listModels } from '../../ai';
import { sortModelsForPicker } from '../../ai/recommended';
import type { Settings } from '../../storage/settings';
import { Button, Section, TextField, Toggle } from '../../ui/components';
import { settings } from '../../ui/settings-signal';
import { fallbackCandidates, filterModels, missingModelLabel, modelOptionLabel } from './model-picker';
import { saveSettings, saveSettingsOrToast, type SettingsPatch } from './save-settings';

type PickerModel = ReturnType<typeof sortModelsForPicker>[number];

const NO_CONNECTION = 'Нет связи с OpenRouter';

const REASONING_LEVELS: ReadonlyArray<{ value: Settings['reasoning']; label: string }> = [
  { value: 'off', label: 'Выкл' },
  { value: 'low', label: 'Низкое' },
  { value: 'medium', label: 'Среднее' },
  { value: 'high', label: 'Высокое' },
];

// ------------------------------------------------------------------- catalog

interface Catalog {
  /** The catalog in picker order; `null` until it has been read once. */
  models: PickerModel[] | null;
  /** Why the last read failed. The list of an earlier read, if any, stays. */
  error: string | null;
  loading: boolean;
  load: (force: boolean) => void;
}

/** The model catalog, read when the section opens and again on request; an answer that is out of date is dropped. */
function useCatalog(): Catalog {
  const [models, setModels] = useState<PickerModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const load = (force: boolean): void => {
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    void (async () => {
      let sorted: PickerModel[] | undefined;
      let failure: string | undefined;
      try {
        sorted = sortModelsForPicker(await listModels({ force }));
      } catch (caught) {
        failure = caught instanceof AiFailure ? caught.error.message : NO_CONNECTION;
      }
      if (request !== latest.current) return;
      if (sorted) setModels(sorted);
      if (failure !== undefined) setError(failure);
      setLoading(false);
    })();
  };

  useEffect(() => {
    load(false);
    return () => {
      latest.current += 1; // whatever is still on its way is no longer wanted
    };
  }, []);

  return { models, error, loading, load };
}

// ------------------------------------------------------------------- pickers

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ComponentChildren;
}

function SelectField({ label, value, onChange, disabled, children }: SelectFieldProps) {
  return (
    <label class="tc-field">
      <span class="tc-field__label">{label}</span>
      <select class="tc-input" value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {children}
      </select>
    </label>
  );
}

interface ModelOptionsProps {
  /** The whole catalog; `null` while it is not known. */
  catalog: PickerModel[] | null;
  /** The models to offer. */
  candidates: PickerModel[];
  /** The id the field holds. It is always among the options, so that the field never shows a model it does not hold. */
  selected: string;
  /** Text of the option for «nothing»; without it that option is not offered. */
  emptyLabel?: string;
}

function ModelOptions({ catalog, candidates, selected, emptyLabel }: ModelOptionsProps) {
  const listed = candidates.some((m) => m.id === selected);
  const known = catalog?.find((m) => m.id === selected);
  // with no catalog nobody can say the model is gone, so it stays a bare id
  const pinnedLabel = known ? modelOptionLabel(known) : catalog ? missingModelLabel(selected) : selected;
  return (
    <>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {selected !== '' && !listed && <option value={selected}>{pinnedLabel}</option>}
      {candidates.map((m) => (
        <option key={m.id} value={m.id}>
          {modelOptionLabel(m)}
        </option>
      ))}
    </>
  );
}

// ------------------------------------------------------------------- timeout

function TimeoutField({ stored }: { stored: number }) {
  const [draft, setDraft] = useState(String(stored));
  const [error, setError] = useState<string | null>(null);

  // the timeout can change elsewhere (an import): the field follows
  useEffect(() => {
    setDraft(String(stored));
  }, [stored]);

  const save = async (): Promise<void> => {
    if (draft === String(stored)) return;
    const result = await saveSettings({ requestTimeoutSec: Number(draft) });
    if (result.ok) {
      setError(null);
      setDraft(String(result.settings.requestTimeoutSec));
    } else {
      setError(result.message);
    }
  };

  return (
    <div class="tc-stack">
      <TextField
        label="Таймаут, сек"
        type="number"
        min={15}
        max={300}
        value={draft}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : 'tc-timeout-error'}
        onInput={(value) => {
          setDraft(value);
          setError(null);
        }}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save();
        }}
      />
      {error !== null && (
        <p class="tc-error" id="tc-timeout-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- section

function ModelsForm({ current }: { current: Settings }) {
  const { models, error, loading, load } = useCatalog();
  const [query, setQuery] = useState('');
  const { model, fallbackEnabled, fallbackModels, reasoning } = current;
  const [first = '', second = ''] = fallbackModels;

  const ready = models !== null;
  const all = models ?? [];
  const supportsReasoning = all.find((m) => m.id === model)?.supportsReasoning === true;

  const save = (patch: SettingsPatch): void => void saveSettingsOrToast(patch);
  const saveFallbacks = (a: string, b: string): void =>
    save({ fallbackModels: [a, b].filter((id) => id !== '') });

  return (
    <Section title="Модели">
      <div class="tc-stack">
        <TextField
          type="search"
          aria-label="Поиск модели"
          placeholder="Поиск по названию или id"
          disabled={!ready}
          value={query}
          onInput={setQuery}
        />
        <SelectField
          label="Основная модель"
          value={model}
          disabled={!ready}
          onChange={(value) => save({ model: value })}
        >
          <ModelOptions
            catalog={models}
            candidates={filterModels(all, query)}
            selected={model}
            emptyLabel={model === '' ? 'Выберите модель' : undefined}
          />
        </SelectField>

        <Toggle
          label="Запасные модели"
          checked={fallbackEnabled}
          onChange={(checked) => save({ fallbackEnabled: checked })}
        />
        {fallbackEnabled && (
          <>
            <SelectField
              label="Запасная модель 1"
              value={first}
              disabled={!ready}
              onChange={(value) => saveFallbacks(value, second)}
            >
              <ModelOptions
                catalog={models}
                candidates={fallbackCandidates(all, model, second)}
                selected={first}
                emptyLabel="Не выбрана"
              />
            </SelectField>
            {first !== '' && (
              <SelectField
                label="Запасная модель 2"
                value={second}
                disabled={!ready}
                onChange={(value) => saveFallbacks(first, value)}
              >
                <ModelOptions
                  catalog={models}
                  candidates={fallbackCandidates(all, model, first)}
                  selected={second}
                  emptyLabel="Не выбрана"
                />
              </SelectField>
            )}
          </>
        )}

        <SelectField
          label="Рассуждение"
          value={reasoning}
          disabled={!supportsReasoning}
          onChange={(value) => {
            const level = REASONING_LEVELS.find((l) => l.value === value);
            if (level) save({ reasoning: level.value });
          }}
        >
          {REASONING_LEVELS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        {ready && !supportsReasoning && <p class="tc-hint">Модель не поддерживает рассуждение</p>}

        <TimeoutField stored={current.requestTimeoutSec} />

        <div class="tc-row">
          <Button disabled={loading} onClick={() => load(true)}>
            Обновить список
          </Button>
          {loading && <span class="tc-hint">Загрузка списка…</span>}
        </div>
        {error !== null && (
          <div class="tc-row">
            <p class="tc-error" role="alert">
              {error}
            </p>
            <Button onClick={() => load(false)}>Повторить</Button>
          </div>
        )}
      </div>
    </Section>
  );
}

/** Which models the extension asks, in which order, and how long it waits for them. */
export function ModelsSection() {
  const current = settings.value;
  return current ? <ModelsForm current={current} /> : null;
}
