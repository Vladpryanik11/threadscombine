import type { ComponentChildren, JSX, TargetedInputEvent } from 'preact';

type Attributes<Tag extends keyof JSX.IntrinsicElements> = Omit<JSX.IntrinsicElements[Tag], 'class' | 'className'>;

const join = (...names: Array<string | undefined>): string => names.filter(Boolean).join(' ');

export type ButtonProps = Attributes<'button'> & {
  variant?: 'default' | 'primary' | 'danger';
  class?: string;
};

/** A button that does not submit forms unless told to. */
export function Button({ variant = 'default', class: className, ...rest }: ButtonProps) {
  return <button type="button" class={join('tc-btn', `tc-btn--${variant}`, className)} {...rest} />;
}

export type TextFieldProps = Omit<Attributes<'input'>, 'value' | 'onInput' | 'type' | 'role'> & {
  type?: 'text' | 'password' | 'search' | 'number';
  /** Visible caption; without it the field stands alone and should carry an `aria-label`. */
  label?: string;
  value: string;
  onInput: (value: string) => void;
  class?: string;
};

export function TextField({ label, type = 'text', value, onInput, class: className, ...rest }: TextFieldProps) {
  // Preact types `<input>` as a union keyed by `type`, which a variable `type` cannot select a member of.
  const attributes = {
    type,
    class: join('tc-input', className),
    value,
    onInput: (event: TargetedInputEvent<HTMLInputElement>) => onInput(event.currentTarget.value),
    ...rest,
  } as JSX.IntrinsicElements['input'];
  if (label === undefined) return <input {...attributes} />;
  return (
    <label class="tc-field">
      <span class="tc-field__label">{label}</span>
      <input {...attributes} />
    </label>
  );
}

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, checked, onChange, disabled }: ToggleProps) {
  return (
    <label class="tc-toggle">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export interface SectionProps {
  title: string;
  children?: ComponentChildren;
}

export function Section({ title, children }: SectionProps) {
  return (
    <section class="tc-section">
      <h2 class="tc-section__title">{title}</h2>
      {children}
    </section>
  );
}
