import { fireEvent, render, screen } from '@testing-library/preact';
import { Button, Section, TextField, Toggle } from '../../src/ui/components';

describe('Button', () => {
  it('is a plain button that never submits a form by itself', () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Нажать</Button>
      </form>,
    );
    const button = screen.getByRole('button', { name: 'Нажать' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('takes a variant and an extra class, and passes other attributes on', () => {
    render(
      <Button variant="danger" class="extra" disabled>
        Удалить
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Удалить' }) as HTMLButtonElement;
    expect(button.className).toContain('tc-btn--danger');
    expect(button.className).toContain('extra');
    expect(button.disabled).toBe(true);
  });

  it('can still be told to submit', () => {
    render(<Button type="submit">Отправить</Button>);
    expect(screen.getByRole('button', { name: 'Отправить' }).getAttribute('type')).toBe('submit');
  });
});

describe('TextField', () => {
  it('reports the typed text as a string', () => {
    const onInput = vi.fn();
    render(<TextField value="" onInput={onInput} aria-label="Имя" />);
    fireEvent.input(screen.getByRole('textbox', { name: 'Имя' }), { target: { value: 'Кино' } });
    expect(onInput).toHaveBeenCalledWith('Кино');
  });

  it('shows the given value and is a password field on request', () => {
    const { container } = render(<TextField value="секрет" onInput={() => {}} type="password" aria-label="Ключ" />);
    const input = container.querySelector('input')!;
    expect(input.value).toBe('секрет');
    expect(input.type).toBe('password');
  });

  it('ties the caption to the input', () => {
    render(<TextField label="Таймаут, сек" value="90" onInput={() => {}} />);
    expect((screen.getByLabelText('Таймаут, сек') as HTMLInputElement).value).toBe('90');
  });
});

describe('Toggle', () => {
  it('reports the new state as a boolean', () => {
    const onChange = vi.fn();
    render(<Toggle label="Запасные модели" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Запасные модели' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows its state and can be disabled', () => {
    render(<Toggle label="Рассуждение" checked disabled onChange={() => {}} />);
    const toggle = screen.getByRole('switch', { name: 'Рассуждение' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
  });
});

describe('Section', () => {
  it('has a heading and holds its content', () => {
    render(
      <Section title="Оформление">
        <p>внутри</p>
      </Section>,
    );
    expect(screen.getByRole('heading', { name: 'Оформление' })).toBeTruthy();
    expect(screen.getByText('внутри')).toBeTruthy();
  });
});
