import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { AccountError, deleteAccount, updateAccount } from '../../storage/accounts';
import type { Account } from '../../storage/db';
import { log } from '../../storage/journal';
import { accounts } from '../../ui/account-signal';
import { Button, Section, TextField } from '../../ui/components';

const UNEXPECTED_ERROR = 'Не удалось выполнить действие';

/** The text for a failed action: a refusal of the accounts in its own words, anything else as a general one. */
async function failureText(error: unknown): Promise<string> {
  if (error instanceof AccountError) return error.message;
  await log('error', 'ui', `Аккаунты: ${error instanceof Error ? error.message : String(error)}`);
  return UNEXPECTED_ERROR;
}

/** The @username as the owner reads it; an account with none shows an empty field. */
const shownUsername = (username: string): string => (username === '' ? '' : `@${username}`);

interface AccountFieldProps {
  label: string;
  /** The saved value, in the form the field shows it. */
  stored: string;
  /** Saves the text and resolves to the value as saved, in the form the field shows it. */
  save: (draft: string) => Promise<string>;
}

/** A field that saves itself on blur or Enter and keeps the reason of a refusal under it. */
function AccountField({ label, stored, save }: AccountFieldProps) {
  const [draft, setDraft] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  // the account can change elsewhere (an import, another save): the field follows
  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  const commit = async (): Promise<void> => {
    if (draft === stored) return;
    try {
      setDraft(await save(draft));
      setError(null);
    } catch (caught) {
      setError(await failureText(caught));
    }
  };

  return (
    <div class="tc-stack tc-account-row__field">
      <TextField
        aria-label={label}
        placeholder={label}
        autocomplete="off"
        spellcheck={false}
        value={draft}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : errorId}
        onInput={(value) => {
          setDraft(value);
          setError(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit();
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

/** «Удалить», which asks for a confirmation in place before it deletes; not available for the last account. */
function DeleteControl({ account, onlyOne }: { account: Account; onlyOne: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  const hintId = useId();

  // the question takes the place of the button that had the focus: the focus goes to the safe answer, and back
  useEffect(() => {
    if (confirming) {
      asked.current = true;
      cancelButton.current?.focus();
    } else if (asked.current) {
      deleteButton.current?.focus();
    }
  }, [confirming]);

  const remove = async (): Promise<void> => {
    setDeleting(true);
    try {
      await deleteAccount(account.id); // the row goes away together with the account in the list
    } catch (caught) {
      setError(await failureText(caught));
      setConfirming(false);
      setDeleting(false);
    }
  };

  return (
    <div class="tc-stack">
      {confirming ? (
        <div class="tc-row">
          <span>Удалить аккаунт и все его данные?</span>
          <Button variant="danger" disabled={deleting} onClick={() => void remove()}>
            Удалить
          </Button>
          <Button ref={cancelButton} disabled={deleting} onClick={() => setConfirming(false)}>
            Отмена
          </Button>
        </div>
      ) : (
        <div class="tc-row">
          <Button
            ref={deleteButton}
            variant="danger"
            disabled={onlyOne}
            aria-describedby={onlyOne ? hintId : undefined}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            Удалить
          </Button>
          {onlyOne && (
            <span class="tc-hint" id={hintId}>
              Нельзя удалить последний аккаунт
            </span>
          )}
        </div>
      )}
      {error !== null && (
        <p class="tc-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AccountRow({ account, onlyOne }: { account: Account; onlyOne: boolean }) {
  return (
    <div class="tc-stack tc-account-row" role="group" aria-label={account.name}>
      <div class="tc-account-row__fields">
        <span class="tc-dot" aria-hidden="true" style={{ backgroundColor: account.color }} />
        <AccountField
          label="Имя аккаунта"
          stored={account.name}
          save={async (draft) => (await updateAccount(account.id, { name: draft })).name}
        />
        <AccountField
          label="@username"
          stored={shownUsername(account.threadsUsername)}
          save={async (draft) =>
            shownUsername((await updateAccount(account.id, { threadsUsername: draft })).threadsUsername)
          }
        />
      </div>
      <DeleteControl account={account} onlyOne={onlyOne} />
    </div>
  );
}

/** Rename an account, bind its @username on Threads, or delete it with everything that belongs to it. */
export function AccountsSection() {
  const list = accounts.value;
  return (
    <Section title="Аккаунты">
      <div class="tc-stack">
        {list.map((account) => (
          <AccountRow key={account.id} account={account} onlyOne={list.length <= 1} />
        ))}
      </div>
    </Section>
  );
}
