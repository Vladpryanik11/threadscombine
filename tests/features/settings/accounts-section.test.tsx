import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { AccountsSection } from '../../../src/features/settings/AccountsSection';
import { createAccount, ensureDefaultAccount } from '../../../src/storage/accounts';
import { db, type Account } from '../../../src/storage/db';
import { listJournal } from '../../../src/storage/journal';
import { accounts, activeAccount, initAccountSignals } from '../../../src/ui/account-signal';

const CONFIRM_TEXT = 'Удалить аккаунт и все его данные?';

let main: Account;
let kino: Account;
let stop: () => void;

beforeEach(async () => {
  await db.delete();
  await db.open();
  accounts.value = [];
  activeAccount.value = null;
  main = await ensureDefaultAccount();
  kino = await createAccount({ name: 'Кино', threadsUsername: 'kino' });
  stop = await initAccountSignals();
});

afterEach(() => {
  cleanup();
  stop();
  accounts.value = [];
  activeAccount.value = null;
  vi.restoreAllMocks();
});

/** The row of one account. */
const row = (name: string) => within(screen.getByRole('group', { name }));
const nameField = (name: string) => row(name).getByLabelText('Имя аккаунта') as HTMLInputElement;
const usernameField = (name: string) => row(name).getByLabelText('@username') as HTMLInputElement;
const stored = async (id: string) => (await db.accounts.get(id))!;

describe('the list', () => {
  it('has a row per account, oldest first, each with its colour, name and @username', () => {
    render(<AccountsSection />);

    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Основной', 'Кино']);
    expect(nameField('Кино').value).toBe('Кино');
    expect(usernameField('Кино').value).toBe('@kino');
    expect(usernameField('Основной').value).toBe(''); // nothing bound yet
    expect(usernameField('Основной').placeholder).toBe('@username');

    const dot = (name: string) => screen.getByRole('group', { name }).querySelector<HTMLElement>('.tc-dot')!;
    expect(dot('Основной').style.backgroundColor).not.toBe('');
    expect(dot('Кино').style.backgroundColor).not.toBe(dot('Основной').style.backgroundColor);
  });

  it('follows the accounts when one is added elsewhere', async () => {
    render(<AccountsSection />);
    await createAccount({ name: 'Мемы' });

    await waitFor(() => expect(screen.getByRole('group', { name: 'Мемы' })).toBeTruthy());
  });
});

describe('renaming and binding', () => {
  it('renames an account and binds a username', async () => {
    render(<AccountsSection />);

    fireEvent.input(nameField('Основной'), { target: { value: 'Кино 2' } });
    fireEvent.blur(nameField('Основной'));
    await waitFor(async () => expect((await stored(main.id)).name).toBe('Кино 2'));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Кино 2' })).toBeTruthy());

    fireEvent.input(usernameField('Кино 2'), { target: { value: '@Kino2' } });
    fireEvent.blur(usernameField('Кино 2'));
    await waitFor(async () => expect((await stored(main.id)).threadsUsername).toBe('kino2'));
    await waitFor(() => expect(usernameField('Кино 2').value).toBe('@kino2')); // as stored
    expect((await stored(main.id)).name).toBe('Кино 2'); // the name was not touched by the second save
  });

  it('saves on Enter as well', async () => {
    render(<AccountsSection />);

    fireEvent.input(nameField('Кино'), { target: { value: '  Кино 3  ' } });
    fireEvent.keyDown(nameField('Кино'), { key: 'Enter' });

    await waitFor(async () => expect((await stored(kino.id)).name).toBe('Кино 3'));
    await waitFor(() => expect(nameField('Кино 3').value).toBe('Кино 3')); // without the stray blanks
  });

  it('shows the stored form of a text even when the stored value stays the same', async () => {
    render(<AccountsSection />);

    fireEvent.input(nameField('Кино'), { target: { value: 'Кино ' } });
    fireEvent.blur(nameField('Кино'));

    await waitFor(() => expect(nameField('Кино').value).toBe('Кино'));
  });

  it('clears a binding when the field is emptied', async () => {
    render(<AccountsSection />);

    fireEvent.input(usernameField('Кино'), { target: { value: '' } });
    fireEvent.blur(usernameField('Кино'));

    await waitFor(async () => expect((await stored(kino.id)).threadsUsername).toBe(''));
  });

  it('writes nothing when nothing changed', async () => {
    const put = vi.spyOn(db.accounts, 'put');
    render(<AccountsSection />);

    fireEvent.blur(nameField('Кино'));
    fireEvent.keyDown(usernameField('Кино'), { key: 'Enter' });
    fireEvent.blur(usernameField('Основной'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(put).not.toHaveBeenCalled();
  });

  it('shows a duplicate username error under the field and stores nothing', async () => {
    render(<AccountsSection />);

    fireEvent.input(usernameField('Основной'), { target: { value: '@Kino' } });
    fireEvent.blur(usernameField('Основной'));

    const error = await within(screen.getByRole('group', { name: 'Основной' })).findByText(
      'Этот @username уже привязан к другому аккаунту',
    );
    expect(error.getAttribute('role')).toBe('alert');
    expect(usernameField('Основной').getAttribute('aria-describedby')).toBe(error.id);
    expect(usernameField('Основной').getAttribute('aria-invalid')).toBe('true');
    expect(usernameField('Основной').value).toBe('@Kino'); // the text stays so that it can be corrected
    expect((await stored(main.id)).threadsUsername).toBe('');
    expect(within(screen.getByRole('group', { name: 'Кино' })).queryByRole('alert')).toBeNull(); // only its own row
  });

  it('shows the name error under the name field, and drops it once the text is edited', async () => {
    render(<AccountsSection />);

    fireEvent.input(nameField('Кино'), { target: { value: '   ' } });
    fireEvent.blur(nameField('Кино'));

    await row('Кино').findByText('Имя аккаунта — от 1 до 40 символов');
    expect((await stored(kino.id)).name).toBe('Кино');

    fireEvent.input(nameField('Кино'), { target: { value: 'Кино 4' } });
    expect(row('Кино').queryByRole('alert')).toBeNull();
  });

  it('shows the username error for a malformed @username', async () => {
    render(<AccountsSection />);

    fireEvent.input(usernameField('Кино'), { target: { value: '@не так' } });
    fireEvent.blur(usernameField('Кино'));

    await row('Кино').findByText('Неверный @username');
  });

  it('shows a general text for an unexpected failure and journals the cause', async () => {
    vi.spyOn(db.accounts, 'put').mockRejectedValue(new Error('disk gone'));
    render(<AccountsSection />);

    fireEvent.input(nameField('Кино'), { target: { value: 'Кино 5' } });
    fireEvent.blur(nameField('Кино'));

    const error = await row('Кино').findByRole('alert');
    expect(error.textContent).toBe('Не удалось выполнить действие');
    expect(screen.queryByText(/disk gone/)).toBeNull();
    await waitFor(async () =>
      expect((await listJournal())[0]).toMatchObject({ level: 'error', area: 'ui', message: expect.stringContaining('disk gone') }),
    );
  });
});

describe('deleting', () => {
  it('deletes after confirmation only', async () => {
    render(<AccountsSection />);
    const kinoRow = () => row('Кино');

    fireEvent.click(kinoRow().getByRole('button', { name: 'Удалить' }));
    expect(kinoRow().getByText(CONFIRM_TEXT)).toBeTruthy();
    expect(await db.accounts.count()).toBe(2); // nothing is deleted by the first click
    expect(kinoRow().getAllByRole('button').map((b) => b.textContent)).toEqual(['Удалить', 'Отмена']);

    fireEvent.click(kinoRow().getByRole('button', { name: 'Отмена' }));
    expect(kinoRow().queryByText(CONFIRM_TEXT)).toBeNull();
    expect(screen.getByRole('group', { name: 'Кино' })).toBeTruthy();
    expect(await db.accounts.count()).toBe(2);

    fireEvent.click(kinoRow().getByRole('button', { name: 'Удалить' }));
    fireEvent.click(kinoRow().getByRole('button', { name: 'Удалить' })); // the one that confirms
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Кино' })).toBeNull());
    expect(await db.accounts.get(kino.id)).toBeUndefined();
    expect(screen.getByRole('group', { name: 'Основной' })).toBeTruthy();
  });

  it('asks only about the account whose button was pressed', () => {
    render(<AccountsSection />);

    fireEvent.click(row('Кино').getByRole('button', { name: 'Удалить' }));

    expect(screen.getAllByText(CONFIRM_TEXT)).toHaveLength(1);
    expect(row('Основной').queryByText(CONFIRM_TEXT)).toBeNull();
  });

  it('puts the focus on «Отмена» when asking, and back on «Удалить» when cancelled', async () => {
    render(<AccountsSection />);

    fireEvent.click(row('Кино').getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(document.activeElement).toBe(row('Кино').getByRole('button', { name: 'Отмена' })));

    fireEvent.click(row('Кино').getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(document.activeElement).toBe(row('Кино').getByRole('button', { name: 'Удалить' })));
  });

  it('makes the earliest remaining account active when the active one is deleted', async () => {
    await waitFor(() => expect(activeAccount.value?.id).toBe(main.id));
    render(<AccountsSection />);

    fireEvent.click(row('Основной').getByRole('button', { name: 'Удалить' }));
    fireEvent.click(row('Основной').getByRole('button', { name: 'Удалить' }));

    await waitFor(() => expect(screen.queryByRole('group', { name: 'Основной' })).toBeNull());
    await waitFor(() => expect(activeAccount.value?.id).toBe(kino.id));
  });

  it('disables delete for the only account and says why', async () => {
    await db.accounts.delete(kino.id);
    render(<AccountsSection />);

    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(1));
    const button = row('Основной').getByRole('button', { name: 'Удалить' }) as HTMLButtonElement;
    const hint = row('Основной').getByText('Нельзя удалить последний аккаунт');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);

    fireEvent.click(button);
    expect(screen.queryByText(CONFIRM_TEXT)).toBeNull();
  });

  it('does not mention the last-account rule while there are several', () => {
    render(<AccountsSection />);

    expect(screen.queryByText('Нельзя удалить последний аккаунт')).toBeNull();
    for (const name of ['Основной', 'Кино']) {
      expect((row(name).getByRole('button', { name: 'Удалить' }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('shows a refusal of the storage under the row and closes the question', async () => {
    stop(); // the list stops following the database, so that it can be out of date
    render(<AccountsSection />);
    await db.accounts.delete(kino.id);

    fireEvent.click(row('Кино').getByRole('button', { name: 'Удалить' }));
    fireEvent.click(row('Кино').getByRole('button', { name: 'Удалить' }));

    const error = await row('Кино').findByRole('alert');
    expect(error.textContent).toBe('Аккаунт не найден');
    expect(row('Кино').queryByText(CONFIRM_TEXT)).toBeNull();
    expect((row('Кино').getByRole('button', { name: 'Удалить' }) as HTMLButtonElement).disabled).toBe(false); // can be tried again
  });

  it('shows a general text, and journals the cause, when deleting fails unexpectedly', async () => {
    vi.spyOn(db.accounts, 'delete').mockRejectedValue(new Error('disk gone'));
    render(<AccountsSection />);

    fireEvent.click(row('Кино').getByRole('button', { name: 'Удалить' }));
    fireEvent.click(row('Кино').getByRole('button', { name: 'Удалить' }));

    const error = await row('Кино').findByRole('alert');
    expect(error.textContent).toBe('Не удалось выполнить действие');
    expect(row('Кино').queryByText(CONFIRM_TEXT)).toBeNull(); // the question is closed, the account stays
    expect(await db.accounts.get(kino.id)).toBeDefined();
    await waitFor(async () => expect((await listJournal())[0]).toMatchObject({ level: 'error', area: 'ui' }));
  });
});
