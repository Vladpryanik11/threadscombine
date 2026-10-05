import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { db, type Account } from '../../src/storage/db';
import { createAccount, ensureDefaultAccount } from '../../src/storage/accounts';
import { listJournal } from '../../src/storage/journal';
import { getSettings } from '../../src/storage/settings';
import { AccountSwitcher } from '../../src/ui/AccountSwitcher';
import { accounts, activeAccount, initAccountSignals } from '../../src/ui/account-signal';
import { Toasts, toasts } from '../../src/ui/toast';

let main: Account;
let kino: Account;
let stop: () => void;

beforeEach(async () => {
  await db.delete();
  await db.open();
  accounts.value = [];
  activeAccount.value = null;
  toasts.value = [];
  main = await ensureDefaultAccount();
  kino = await createAccount({ name: 'Кино' });
  stop = await initAccountSignals();
});

afterEach(() => {
  stop();
  vi.restoreAllMocks();
});

function renderSwitcher() {
  render(
    <>
      <AccountSwitcher />
      <Toasts />
    </>,
  );
}

const trigger = (name: string) => screen.getByRole('button', { name });

it('shows the active account and switches on click', async () => {
  renderSwitcher();
  expect(trigger('Основной').textContent).toBe('Основной');
  expect(screen.queryByText('Кино')).toBeNull(); // the list is closed

  fireEvent.click(trigger('Основной'));
  fireEvent.click(screen.getByRole('button', { name: 'Кино' }));

  await waitFor(() => expect(screen.queryByRole('button', { name: 'Основной' })).toBeNull()); // the list closed
  await waitFor(() => expect(trigger('Кино').textContent).toBe('Кино'));
  expect((await getSettings()).activeAccountId).toBe(kino.id);
});

it('lists every account, marks the active one and paints the dot in its colour', async () => {
  renderSwitcher();
  fireEvent.click(trigger('Основной'));

  const items = screen.getAllByRole('button', { name: /^(Основной|Кино)$/ });
  expect(items.map((item) => item.textContent)).toEqual(['Основной', 'Основной', 'Кино']); // trigger, then the list
  expect(items[1]!.getAttribute('aria-current')).toBe('true');
  expect(items[2]!.getAttribute('aria-current')).toBeNull();

  const dot = (item: HTMLElement) => item.querySelector<HTMLElement>('[data-dot]')!.style.backgroundColor;
  expect(dot(items[0]!)).not.toBe('');
  expect(dot(items[2]!)).not.toBe(dot(items[1]!)); // another account, another colour
  expect(main.color).not.toBe(kino.color);
});

it('creates a new account and makes it active', async () => {
  renderSwitcher();
  fireEvent.click(trigger('Основной'));
  fireEvent.click(screen.getByRole('button', { name: '+ Новый аккаунт' }));
  fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Мемы' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull()); // the form closed
  const memes = accounts.value.find((a) => a.name === 'Мемы')!;
  await waitFor(() => expect(trigger('Мемы').textContent).toBe('Мемы'));
  expect((await getSettings()).activeAccountId).toBe(memes.id);
  expect(accounts.value).toHaveLength(3);
});

it('creates the account on Enter in the name field', async () => {
  renderSwitcher();
  fireEvent.click(trigger('Основной'));
  fireEvent.click(screen.getByRole('button', { name: '+ Новый аккаунт' }));
  const field = screen.getByRole('textbox');
  fireEvent.input(field, { target: { value: 'Музыка' } });
  fireEvent.keyDown(field, { key: 'Enter' });

  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  await waitFor(() => expect(trigger('Музыка').textContent).toBe('Музыка'));
});

it('shows the validation error as a toast and keeps the form open', async () => {
  renderSwitcher();
  fireEvent.click(trigger('Основной'));
  fireEvent.click(screen.getByRole('button', { name: '+ Новый аккаунт' }));
  fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

  const toast = await screen.findByText('Имя аккаунта — от 1 до 40 символов');
  expect(toast.getAttribute('data-kind')).toBe('error');
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(accounts.value).toHaveLength(2);
});

it('reports an unexpected failure to the journal and shows a general toast', async () => {
  vi.spyOn(db, 'transaction').mockRejectedValue(new Error('disk gone'));
  renderSwitcher();
  fireEvent.click(trigger('Основной'));
  fireEvent.click(screen.getByRole('button', { name: '+ Новый аккаунт' }));
  fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Мемы' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

  await screen.findByText('Не удалось выполнить действие');
  await waitFor(async () => expect((await listJournal())[0]).toMatchObject({ level: 'error', message: 'disk gone' }));
});

it('closes the list without writing when the active account is picked again', async () => {
  renderSwitcher();
  fireEvent.click(trigger('Основной'));
  const picked = screen.getAllByRole('button', { name: 'Основной' })[1]!;
  fireEvent.click(picked);

  expect(screen.queryByRole('button', { name: 'Кино' })).toBeNull();
  expect((await getSettings()).activeAccountId).toBe(main.id);
});
