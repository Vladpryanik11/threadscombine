import { signal } from '@preact/signals';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

export const TOAST_DURATION_MS = 4000;

export const toasts = signal<Toast[]>([]);

let nextId = 1;

/** Shows a short message for four seconds. */
export function showToast(text: string, kind: ToastKind = 'info'): void {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, text, kind }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }, TOAST_DURATION_MS);
}

export function Toasts() {
  return (
    <div class="tc-toasts">
      {toasts.value.map((toast) => (
        <div key={toast.id} class="tc-toast" data-kind={toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
