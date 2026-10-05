import { useEffect, useRef, useState } from 'preact/hooks';
import { streamText, type AiResult } from '../../ai';
import { keyCheckMessages } from '../../prompts/key-check';
import { log } from '../../storage/journal';
import { Button, Section, TextField } from '../../ui/components';
import { settings } from '../../ui/settings-signal';
import { saveSettingsOrToast } from './save-settings';

const KEYS_URL = 'https://openrouter.ai/keys';
const CHECK_FAILED = 'Не удалось выполнить проверку';

type Outcome =
  | { kind: 'ok'; answer: string; model: string; time: string; tokens?: string; cost?: string; switched: boolean }
  | { kind: 'error'; message: string };

/** What the owner is shown after a check: the answer with its model, time, tokens and cost, or the error text. */
function toOutcome(result: AiResult<string>): Outcome {
  if (!result.ok) return { kind: 'error', message: result.error.message };
  const { usage } = result;
  return {
    kind: 'ok',
    answer: result.value.trim() || '—',
    model: result.model,
    time: `${(result.elapsedMs / 1000).toFixed(1)} с`,
    ...(usage && { tokens: `${usage.promptTokens} + ${usage.completionTokens}` }),
    ...(usage?.costUsd !== undefined && { cost: `$${usage.costUsd.toFixed(6)}` }),
    switched: result.switchedFrom.length > 0,
  };
}

function CheckResult({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'error') {
    return (
      <p class="tc-error" role="alert">
        {outcome.message}
      </p>
    );
  }
  return (
    <div class="tc-check" role="status">
      <p class="tc-check__answer">{outcome.answer}</p>
      <dl class="tc-check__details">
        <dt>Модель</dt>
        <dd>{outcome.model}</dd>
        <dt>Время</dt>
        <dd>{outcome.time}</dd>
        {outcome.tokens !== undefined && (
          <>
            <dt>Токены</dt>
            <dd>{outcome.tokens}</dd>
          </>
        )}
        {outcome.cost !== undefined && (
          <>
            <dt>Стоимость</dt>
            <dd>{outcome.cost}</dd>
          </>
        )}
      </dl>
      {outcome.switched && <p class="tc-hint">{`Переключились на ${outcome.model}`}</p>}
    </div>
  );
}

/** The OpenRouter key: a field that saves itself, and a one-word request to see that it works. */
export function KeySection() {
  const stored = settings.value?.openRouterKey ?? '';
  const [draft, setDraft] = useState(stored);
  const [visible, setVisible] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const active = useRef<AbortController | null>(null);

  // the key can change elsewhere (an import): the field follows
  useEffect(() => {
    setDraft(stored);
  }, [stored]);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null; // what the stopped request reports is no longer shown
    },
    [],
  );

  const save = async (): Promise<void> => {
    if (draft === stored) return;
    const result = await saveSettingsOrToast({ openRouterKey: draft });
    if (result.ok) setDraft(result.settings.openRouterKey); // as stored: without stray whitespace
  };

  const check = async (): Promise<void> => {
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setOutcome(null);
    let next: Outcome;
    try {
      const result = await streamText(
        { purpose: 'key-check', messages: keyCheckMessages(), signal: controller.signal },
        () => undefined,
      );
      next = toOutcome(result);
    } catch (error) {
      await log('error', 'ai', `key-check: ${error instanceof Error ? error.message : String(error)}`);
      next = { kind: 'error', message: CHECK_FAILED };
    }
    if (active.current !== controller) return; // the section is gone
    active.current = null;
    setRunning(false);
    setOutcome(next);
  };

  return (
    <Section title="Ключ OpenRouter">
      <div class="tc-stack">
        <div class="tc-row">
          <TextField
            type={visible ? 'text' : 'password'}
            aria-label="Ключ OpenRouter"
            placeholder="sk-or-v1-…"
            autocomplete="off"
            spellcheck={false}
            value={draft}
            onInput={setDraft}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
            }}
          />
          <Button aria-pressed={visible} onClick={() => setVisible(!visible)}>
            {visible ? 'скрыть' : 'показать'}
          </Button>
        </div>
        <a class="tc-link" href={KEYS_URL} target="_blank" rel="noopener noreferrer">
          Где взять ключ
        </a>
        <div class="tc-row">
          {running ? (
            <Button onClick={() => active.current?.abort()}>Стоп</Button>
          ) : (
            <Button variant="primary" onClick={() => void check()}>
              Проверить
            </Button>
          )}
        </div>
        {outcome && <CheckResult outcome={outcome} />}
      </div>
    </Section>
  );
}
