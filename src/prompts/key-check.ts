import type { ChatMessage } from '../ai';

/** Id of the key-check prompt; the number goes up whenever the wording changes. */
export const KEY_CHECK_PROMPT_ID = 'key-check@1';

/** A question short enough to cost next to nothing, yet answered only if the key and the model work. */
export function keyCheckMessages(): ChatMessage[] {
  return [{ role: 'user', content: 'Ответь одним словом: работает' }];
}
