import { readSse } from '../../src/ai/sse';

const encoder = new TextEncoder();

/** A byte stream that delivers each string as one chunk. */
function streamOf(chunks: string[], hooks: { onCancel?: () => void } = {}): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel: hooks.onCancel,
  });
}

async function collect(source: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('readSse', () => {
  it('yields data payloads across split chunks and stops at [DONE]', async () => {
    const s = streamOf([
      'data: {"a":',
      '1}\r\n\r\n: OPENROUTER PROCESSING\n\ndata: {"b":2}\n\n',
      'data: [DONE]\n\ndata: {"c":3}\n\n',
    ]);
    expect(await collect(readSse(s))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('survives a CRLF split between two chunks', async () => {
    const s = streamOf(['data: one\r', '\n\r', '\ndata: two\r\n', '\r\n']);
    expect(await collect(readSse(s))).toEqual(['one', 'two']);
  });

  it('skips comments, blank lines and other SSE fields', async () => {
    const s = streamOf([': keep-alive\n\nevent: ping\nid: 7\nretry: 100\n\ndata: x\n\n']);
    expect(await collect(readSse(s))).toEqual(['x']);
  });

  it('strips at most one space after the colon', async () => {
    const s = streamOf(['data:no-space\ndata:  two-spaces\n']);
    expect(await collect(readSse(s))).toEqual(['no-space', ' two-spaces']);
  });

  it('does not break a multi-byte character split between chunks', async () => {
    const bytes = encoder.encode('data: Работает\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8)); // cuts the second Cyrillic letter in half
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    expect(await collect(readSse(stream))).toEqual(['Работает']);
  });

  it('yields a last data line that has no trailing newline', async () => {
    expect(await collect(readSse(streamOf(['data: a\n', 'data: tail'])))).toEqual(['a', 'tail']);
  });

  it('ends quietly on an empty stream', async () => {
    expect(await collect(readSse(streamOf([])))).toEqual([]);
  });

  it('cancels the underlying stream when the consumer stops early', async () => {
    let cancelled = false;
    const s = streamOf(['data: 1\n\n', 'data: 2\n\n'], { onCancel: () => (cancelled = true) });
    for await (const item of readSse(s)) {
      expect(item).toBe('1');
      break;
    }
    expect(cancelled).toBe(true);
  });

  it('cancels the underlying stream at [DONE]', async () => {
    let cancelled = false;
    const s = streamOf(['data: [DONE]\n\n', 'data: late\n\n'], { onCancel: () => (cancelled = true) });
    expect(await collect(readSse(s))).toEqual([]);
    expect(cancelled).toBe(true);
  });

  it('propagates a read error', async () => {
    const s = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\n\n'));
        controller.error(new TypeError('network error'));
      },
    });
    await expect(collect(readSse(s))).rejects.toThrow('network error');
  });
});
