/** The first ``` fence of the text, with or without a `json` tag; its inner text. */
const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

const CLOSING = { '{': '}', '[': ']' } as const;

/** From the first `{` or `[` to the last bracket that closes it. */
function sliceByBrackets(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const closing = CLOSING[text[start] as keyof typeof CLOSING];
  const end = text.lastIndexOf(closing);
  return end > start ? text.slice(start, end + 1) : undefined;
}

function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** The text as it is, otherwise the part between its outer brackets. */
function parseDocument(text: string): { value: unknown } | undefined {
  const whole = text.trim();
  const sliced = sliceByBrackets(whole);
  return tryParse(whole) ?? (sliced === undefined ? undefined : tryParse(sliced));
}

/**
 * The JSON document in a model's answer: the inside of a ```json … ``` fence if there is one,
 * otherwise the text from the first `{`/`[` to its last closing bracket. Throws `SyntaxError`
 * when no document can be read from it.
 */
export function extractJson(text: string): unknown {
  const fenced = FENCE.exec(text)?.[1];
  const found = (fenced === undefined ? undefined : parseDocument(fenced)) ?? parseDocument(text);
  if (!found) throw new SyntaxError('No JSON document in the text');
  return found.value;
}
