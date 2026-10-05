import { useState } from 'preact/hooks';
import { AccountError, createAccount, setActiveAccount } from '../storage/accounts';
import type { Account } from '../storage/db';
import { log } from '../storage/journal';
import { accounts, activeAccount } from './account-signal';
import { Button, TextField } from './components';
import { showToast } from './toast';

const UNEXPECTED_ERROR = 'Не удалось выполнить действие';

function Dot({ color }: { color: string | undefined }) {
  return <span class="tc-dot" data-dot aria-hidden="true" style={{ backgroundColor: color ?? 'var(--tc-color-border)' }} />;
}

/** Runs one account action; a refusal is shown as a toast. Resolves to whether the action went through. */
async function attempt(action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    if (error instanceof AccountError) {
      showToast(error.message, 'error');
    } else {
      await log('error', 'accounts', error instanceof Error ? error.message : String(error));
      showToast(UNEXPECTED_ERROR, 'error');
    }
    return false;
  }
}

/** The active account in the top bar; opens the list of accounts and the form for a new one. */
export function AccountSwitcher() {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const active = activeAccount.value;

  const close = (): void => {
    setOpen(false);
    setCreating(false);
    setName('');
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    const done = await attempt(action);
    setBusy(false);
    if (done) close();
  };

  const select = async (account: Account): Promise<void> => {
    if (account.id === active?.id) close();
    else await run(() => setActiveAccount(account.id));
  };

  const create = (): Promise<void> =>
    run(async () => {
      const account = await createAccount({ name });
      await setActiveAccount(account.id);
    });

  return (
    <div class="tc-account">
      <button
        type="button"
        class="tc-account__trigger"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Dot color={active?.color} />
        <span class="tc-account__name">{active?.name ?? '…'}</span>
      </button>
      {open && (
        <div class="tc-account__menu">
          {accounts.value.map((account) => (
            <button
              key={account.id}
              type="button"
              class="tc-account__item"
              aria-current={account.id === active?.id ? 'true' : undefined}
              disabled={busy}
              onClick={() => void select(account)}
            >
              <Dot color={account.color} />
              <span class="tc-account__name">{account.name}</span>
            </button>
          ))}
          {creating ? (
            <div class="tc-account__new">
              <TextField
                value={name}
                onInput={setName}
                placeholder="Имя аккаунта"
                aria-label="Имя аккаунта"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !busy) void create();
                }}
              />
              <Button variant="primary" disabled={busy} onClick={() => void create()}>
                Создать
              </Button>
            </div>
          ) : (
            <button type="button" class="tc-account__item" onClick={() => setCreating(true)}>
              + Новый аккаунт
            </button>
          )}
        </div>
      )}
    </div>
  );
}
