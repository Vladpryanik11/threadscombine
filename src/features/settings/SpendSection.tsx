import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { log } from '../../storage/journal';
import type { Settings } from '../../storage/settings';
import { spendSummary, watchSpend, type SpendSummary } from '../../storage/spend';
import { accounts } from '../../ui/account-signal';
import { Button, Section, TextField } from '../../ui/components';
import { settings } from '../../ui/settings-signal';
import { purposeLabel } from './purpose-labels';
import { saveSettings } from './save-settings';

const READ_FAILED = 'Не удалось прочитать расходы';
const DELETED_ACCOUNT = 'Удалённый аккаунт';

const money = (usd: number): string => `$${usd.toFixed(2)}`;

// ------------------------------------------------------------------- summary

interface SpendState {
  /** The summary of the last read that went through; `null` until there is one. */
  summary: SpendSummary | null;
  /** Why the last read failed. The summary of an earlier read, if any, stays. */
  error: string | null;
  reload: () => void;
}

/**
 * The spend summary, read when the section opens, whenever the spend changes (a paid AI call, e.g. the key check
 * above) and on request; an answer that is out of date is dropped.
 */
function useSpendSummary(): SpendState {
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = (): void => {
    const request = ++latest.current;
    setError(null);
    void (async () => {
      let next: SpendSummary | undefined;
      let failure: string | undefined;
      try {
        next = await spendSummary();
      } catch (caught) {
        await log('error', 'ui', `Расходы: ${caught instanceof Error ? caught.message : String(caught)}`);
        failure = READ_FAILED;
      }
      if (request !== latest.current) return;
      if (next) setSummary(next);
      if (failure !== undefined) setError(failure);
    })();
  };

  useEffect(() => {
    const stopWatching = watchSpend(reload); // reads now, and again after every spend
    return () => {
      stopWatching();
      latest.current += 1; // whatever is still on its way is no longer wanted
    };
  }, []);

  return { summary, error, reload };
}

interface SpendRow {
  key: string;
  label: string;
  usd: number;
}

function SpendList({ title, rows }: { title: string; rows: SpendRow[] }) {
  const titleId = useId();
  if (rows.length === 0) return null;
  return (
    <div class="tc-stack">
      <span class="tc-field__label" id={titleId}>
        {title}
      </span>
      <ul class="tc-spend-list" aria-labelledby={titleId}>
        {rows.map((row) => (
          <li key={row.key}>
            <span>{row.label}</span>
            <span>{money(row.usd)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// -------------------------------------------------------------------- limits

type LimitKey = 'dailyBudgetUsd' | 'monthlyBudgetUsd';

const shownLimit = (limit: number | null): string => (limit === null ? '' : String(limit));

/**
 * The text of a limit field as a value for the settings: empty is «no limit», a comma may stand for the point.
 * What is no number goes on as `NaN`, which the settings refuse with their own text.
 */
function parseLimit(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed.replace(',', '.'));
}

interface LimitInputProps {
  label: string;
  field: LimitKey;
  stored: Settings[LimitKey];
}

/** A limit that saves itself on blur or Enter, with the reason of a refusal under it. */
function LimitInput({ label, field, stored }: LimitInputProps) {
  const [draft, setDraft] = useState(shownLimit(stored));
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  // the limit can change elsewhere (an import): the field follows
  useEffect(() => {
    setDraft(shownLimit(stored));
  }, [stored]);

  const save = async (): Promise<void> => {
    if (draft === shownLimit(stored)) return;
    const limit = parseLimit(draft);
    const patch = field === 'dailyBudgetUsd' ? { dailyBudgetUsd: limit } : { monthlyBudgetUsd: limit };
    const result = await saveSettings(patch);
    if (result.ok) {
      setError(null);
      setDraft(shownLimit(result.settings[field])); // as stored: rounded to cents
    } else {
      setError(result.message);
    }
  };

  return (
    <div class="tc-stack">
      <TextField
        label={label}
        inputMode="decimal"
        autocomplete="off"
        value={draft}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : errorId}
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
        <p class="tc-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- section

/** What the AI has cost: today and this month, by task and by account, and the limits that stop it. */
export function SpendSection() {
  const { summary, error, reload } = useSpendSummary();
  const current = settings.value;
  const names = new Map(accounts.value.map((account) => [account.id, account.name]));

  return (
    <Section title="Расходы">
      <div class="tc-stack">
        <div class="tc-row">
          {summary && <span>{`Сегодня: ${money(summary.todayUsd)} · За месяц: ${money(summary.monthUsd)}`}</span>}
          <Button onClick={reload}>Обновить</Button>
        </div>
        {error !== null && (
          <p class="tc-error" role="alert">
            {error}
          </p>
        )}
        {summary && (
          <>
            <SpendList
              title="По задачам"
              rows={summary.byPurpose.map(({ purpose, usd }) => ({ key: purpose, label: purposeLabel(purpose), usd }))}
            />
            <SpendList
              title="По аккаунтам"
              rows={summary.byAccount.map(({ accountId, usd }) => ({
                key: accountId,
                label: names.get(accountId) ?? DELETED_ACCOUNT,
                usd,
              }))}
            />
          </>
        )}
        {current && (
          <>
            <LimitInput label="Лимит в день, $" field="dailyBudgetUsd" stored={current.dailyBudgetUsd} />
            <LimitInput label="Лимит в месяц, $" field="monthlyBudgetUsd" stored={current.monthlyBudgetUsd} />
          </>
        )}
      </div>
    </Section>
  );
}
