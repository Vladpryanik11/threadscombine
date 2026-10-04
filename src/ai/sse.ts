const DONE = '[DONE]';

/** The payload of a `data:` line, or `undefined` for comments (`: …`), blank lines and other fields. */
function dataPayload(line: string): string | undefined {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!text.startsWith('data:')) return undefined;
  const payload = text.slice('data:'.length);
  return payload.startsWith(' ') ? payload.slice(1) : payload;
}

/**
 * Server-sent events: yields the payload of every `data:` line, in order, and ends at `[DONE]`
 * or when the stream ends. Lines end with `\n` or `\r\n` and may be split between chunks. The
 * body is cancelled whenever reading stops, whether at `[DONE]`, an error or an early `break`.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const payload = dataPayload(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (payload === DONE) return;
        if (payload !== undefined) yield payload;
      }
    }
    // a final line the server did not terminate
    const payload = dataPayload(buffer + decoder.decode());
    if (payload !== undefined && payload !== DONE) yield payload;
  } finally {
    // cancelling an errored or already finished stream rejects or no-ops; neither matters here
    reader.cancel().catch(() => undefined);
  }
}
