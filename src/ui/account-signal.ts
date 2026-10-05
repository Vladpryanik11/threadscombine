import { signal } from '@preact/signals';
import { liveQuery } from 'dexie';
import { getActiveAccount, listAccounts } from '../storage/accounts';
import type { Account } from '../storage/db';
import { log } from '../storage/journal';
import { onSettingsChanged } from '../storage/settings';

/** Every account, oldest first. */
export const accounts = signal<Account[]>([]);
/** The account of `settings.activeAccountId`; `null` until `initAccountSignals` has resolved it. */
export const activeAccount = signal<Account | null>(null);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Fills both signals and keeps them in step with the database and the settings.
 * Returns the function that stops following.
 */
export async function initAccountSignals(): Promise<() => void> {
  let disposed = false;
  // Every resolution reads the newest state, so the one that started last is the one to publish.
  let generation = 0;
  let latest: Promise<void> = Promise.resolve();

  const resolveActive = async (): Promise<void> => {
    const mine = ++generation;
    try {
      const account = await getActiveAccount();
      if (!disposed && mine === generation) activeAccount.value = account;
    } catch (error) {
      await log('error', 'accounts', `Не удалось определить активный аккаунт: ${errorText(error)}`);
    }
  };
  const update = (): void => {
    latest = resolveActive();
  };

  const stopSettings = onSettingsChanged(update);

  let listArrived: () => void = () => {};
  const firstList = new Promise<void>((resolve) => {
    listArrived = resolve;
  });
  // the async wrapper turns a synchronous throw of the query into a rejection, which liveQuery reports as an error
  const subscription = liveQuery(async () => listAccounts()).subscribe({
    next: (list) => {
      accounts.value = list;
      update();
      listArrived();
    },
    error: (error: unknown) => {
      void log('error', 'accounts', `Не удалось прочитать список аккаунтов: ${errorText(error)}`);
      listArrived();
    },
  });

  await firstList;
  // Creating the first account makes the list change again, which starts one more resolution.
  let seen: Promise<void>;
  do {
    seen = latest;
    await seen;
  } while (seen !== latest);

  return () => {
    disposed = true;
    stopSettings();
    subscription.unsubscribe();
  };
}
