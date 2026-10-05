import { act, render, screen } from '@testing-library/preact';
import { TOAST_DURATION_MS, Toasts, showToast, toasts } from '../../src/ui/toast';

beforeEach(() => {
  vi.useFakeTimers();
  toasts.value = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const show = (...args: Parameters<typeof showToast>) => act(() => showToast(...args));
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

it('shows a toast for four seconds', async () => {
  expect(TOAST_DURATION_MS).toBe(4000);
  render(<Toasts />);
  await show('Готово');
  expect(screen.getByText('Готово')).toBeTruthy();

  await advance(3999);
  expect(screen.queryByText('Готово')).not.toBeNull();
  await advance(1);
  expect(screen.queryByText('Готово')).toBeNull();
});

it('stacks toasts and removes each one on its own time', async () => {
  render(<Toasts />);
  await show('Первое');
  await advance(3000);
  await show('Второе');
  expect(screen.queryByText('Первое')).not.toBeNull();
  expect(screen.queryByText('Второе')).not.toBeNull();

  await advance(1000);
  expect(screen.queryByText('Первое')).toBeNull();
  expect(screen.queryByText('Второе')).not.toBeNull();
});

it('keeps two equal texts apart', async () => {
  render(<Toasts />);
  await show('Дубль');
  await show('Дубль');
  expect(screen.getAllByText('Дубль')).toHaveLength(2);
});

it('marks the kind: info by default, errors are announced as alerts', async () => {
  render(<Toasts />);
  await show('обычное');
  await show('удалось', 'success');
  await show('сломалось', 'error');

  expect(screen.getByText('обычное').getAttribute('data-kind')).toBe('info');
  expect(screen.getByText('удалось').getAttribute('data-kind')).toBe('success');
  const failed = screen.getByText('сломалось');
  expect(failed.getAttribute('data-kind')).toBe('error');
  expect(failed.getAttribute('role')).toBe('alert');
  expect(screen.getByText('обычное').getAttribute('role')).toBe('status');
});
