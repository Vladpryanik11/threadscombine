import { SWITCHABLE } from '../../src/ai/errors';
import { buildBody, callComplete, callStream } from '../../src/ai/request';
import type { CallOptions } from '../../src/ai/request';
import type { AiRequest } from '../../src/ai/types';

const encoder = new TextEncoder();
const KEY = 'sk-or-v1-k';
const URL = 'https://openrouter.ai/api/v1/chat/completions';

const req: AiRequest = { purpose: 't', messages: [{ role: 'user', content: 'hi' }] };

type FetchCall = { url: string; init: RequestInit };

/** An SSE response whose body is built from the given text chunks. */
function sseResponse(chunks: string[], hooks: { onCancel?: () => void } = {}): Response {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel: hooks.onCancel,
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Like real fetch: after the first chunks the body stays open and errors when the signal aborts. */
function stalledResponse(chunks: string[], signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200 });
}

/** A response whose body is fed by hand, and which errors when the signal aborts, as a real one does. */
function liveResponse(signal: AbortSignal | null | undefined) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal?.addEventListener('abort', () => c.error(signal.reason), { once: true });
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
  };
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function recordingFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function options(fetchFn: typeof fetch, extra: Partial<CallOptions> = {}): CallOptions {
  return {
    model: 'vendor/model',
    supportsReasoning: false,
    settings: { openRouterKey: KEY, reasoning: 'off', requestTimeoutSec: 15 },
    fetchFn,
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('buildBody', () => {
  it('builds the body with reasoning only for supporting models', () => {
    const r = { purpose: 't', messages: [{ role: 'user' as const, content: 'hi' }] };
    expect(buildBody(r, { model: 'm', stream: true, reasoning: 'high', supportsReasoning: true })).toMatchObject({
      reasoning: { effort: 'high' },
      usage: { include: true },
    });
    expect(buildBody(r, { model: 'm', stream: true, reasoning: 'high', supportsReasoning: false })).not.toHaveProperty(
      'reasoning',
    );
    expect(buildBody(r, { model: 'm', stream: false, reasoning: 'off', supportsReasoning: true })).not.toHaveProperty(
      'reasoning',
    );
  });

  it('carries model, messages and the stream flag; optional fields only when given', () => {
    const body = buildBody(req, { model: 'm', stream: false, reasoning: 'off', supportsReasoning: false });
    expect(body).toEqual({ model: 'm', messages: req.messages, stream: false, usage: { include: true } });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('response_format');
  });

  it('maps temperature, maxTokens (including 0) and response_format', () => {
    const responseFormat = { type: 'json_schema' };
    const body = buildBody(
      { ...req, temperature: 0, maxTokens: 256 },
      { model: 'm', stream: true, reasoning: 'low', supportsReasoning: true, responseFormat },
    );
    expect(body).toMatchObject({ temperature: 0, max_tokens: 256, response_format: responseFormat, reasoning: { effort: 'low' } });
  });
});

describe('callStream', () => {
  it('sends the key only as a bearer header to openrouter.ai', async () => {
    const { fetchFn, calls } = recordingFetch(() => sseResponse([delta('ok'), 'data: [DONE]\n\n']));
    const reasoning = { openRouterKey: KEY, reasoning: 'medium' as const, requestTimeoutSec: 15 };
    await callStream(req, options(fetchFn, { supportsReasoning: true, settings: reasoning }), () => {});
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.startsWith('https://openrouter.ai/api/v1/chat/completions')).toBe(true);
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'threadscombine',
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'vendor/model', stream: true, usage: { include: true }, reasoning: { effort: 'medium' } });
    expect(String(init.body)).not.toContain(KEY);
    expect(url).not.toContain(KEY);
  });

  it('streams deltas and returns text with usage', async () => {
    const { fetchFn } = recordingFetch(() =>
      sseResponse([
        ': OPENROUTER PROCESSING\n\n',
        delta('Ра'),
        delta('бо'),
        delta('тает'),
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"cost":0.0001}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const deltas: string[] = [];
    const result = await callStream(req, options(fetchFn), (chunk) => deltas.push(chunk));
    expect(deltas).toEqual(['Ра', 'бо', 'тает']);
    expect(result).toEqual({
      ok: true,
      value: 'Работает',
      usage: { promptTokens: 12, completionTokens: 3, costUsd: 0.0001 },
    });
  });

  it('omits usage and costUsd when the stream does not report them', async () => {
    const { fetchFn } = recordingFetch(() =>
      sseResponse([delta('a'), 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n']),
    );
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toEqual({ ok: true, value: 'a', usage: { promptTokens: 5, completionTokens: 1 } });

    const bare = recordingFetch(() => sseResponse([delta('a')]));
    expect(await callStream(req, options(bare.fetchFn), () => {})).toEqual({ ok: true, value: 'a' });
  });

  it('ignores chunks that are not JSON objects', async () => {
    const { fetchFn } = recordingFetch(() => sseResponse(['data: not json\n\n', 'data: 42\n\n', delta('x')]));
    expect(await callStream(req, options(fetchFn), () => {})).toEqual({ ok: true, value: 'x' });
  });

  it('maps a mid-stream error chunk and reports gotFirstToken', async () => {
    let cancelled = false;
    const { fetchFn } = recordingFetch(() =>
      sseResponse([delta('Ра'), 'data: {"error":{"code":429,"message":"x"}}\n\n', delta('late')], {
        onCancel: () => (cancelled = true),
      }),
    );
    const deltas: string[] = [];
    const result = await callStream(req, options(fetchFn), (chunk) => deltas.push(chunk));
    expect(result).toMatchObject({ ok: false, error: { code: 'rate_limited', status: 429, model: 'vendor/model' }, gotFirstToken: true });
    expect(deltas).toEqual(['Ра']);
    expect(cancelled).toBe(true);
  });

  it('keeps gotFirstToken false for an error chunk before any text', async () => {
    const { fetchFn } = recordingFetch(() =>
      sseResponse([delta(''), 'data: {"error":{"code":502,"message":"upstream"}}\n\n']),
    );
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toMatchObject({ ok: false, error: { code: 'model_unavailable', status: 502 }, gotFirstToken: false });
  });

  it('maps an error chunk whose code is not a number to model_unavailable while nothing has been streamed', async () => {
    const { fetchFn } = recordingFetch(() =>
      sseResponse(['data: {"error":{"code":"server_error","message":"boom"}}\n\n']),
    );
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'model_unavailable', message: 'Модель vendor/model сейчас недоступна', model: 'vendor/model' },
      gotFirstToken: false,
    });
    expect(SWITCHABLE.has('model_unavailable')).toBe(true);
  });

  it('keeps an error chunk whose code is not a number as unknown once text has been streamed', async () => {
    const { fetchFn } = recordingFetch(() =>
      sseResponse([delta('Ра'), 'data: {"error":{"code":"server_error","message":"boom"}}\n\n']),
    );
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unknown', message: 'Ошибка OpenRouter: boom' },
      gotFirstToken: true,
    });
  });

  it('maps HTTP errors before the stream starts', async () => {
    const { fetchFn } = recordingFetch(() => json({ error: { code: 401, message: 'No auth' } }, 401));
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_key', status: 401, model: 'vendor/model' }, gotFirstToken: false });
    expect(result).not.toHaveProperty('usage');

    const paid = recordingFetch(() => new Response('pay up', { status: 402 }));
    expect(await callStream(req, options(paid.fetchFn), () => {})).toMatchObject({
      ok: false,
      error: { code: 'no_credits' },
      gotFirstToken: false,
    });
  });

  it('empty completion is model_unavailable', async () => {
    const { fetchFn } = recordingFetch(() => sseResponse([delta(''), 'data: [DONE]\n\n']));
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toEqual({
      ok: false,
      error: { code: 'model_unavailable', message: 'Модель vendor/model сейчас недоступна', model: 'vendor/model' },
      gotFirstToken: false,
    });
  });

  it('keeps the usage of an empty completion on the failure', async () => {
    const { fetchFn } = recordingFetch(() =>
      sseResponse([
        delta(''),
        'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":900,"cost":0.004}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toEqual({
      ok: false,
      error: { code: 'model_unavailable', message: 'Модель vendor/model сейчас недоступна', model: 'vendor/model' },
      gotFirstToken: false,
      usage: { promptTokens: 30, completionTokens: 900, costUsd: 0.004 },
    });
  });

  it('keeps the usage seen before a mid-stream error chunk on the failure', async () => {
    const { fetchFn } = recordingFetch(() =>
      sseResponse([
        delta('Ра'),
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"cost":0.0003}}\n\n',
        'data: {"error":{"code":502,"message":"upstream"}}\n\n',
      ]),
    );
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'model_unavailable', status: 502 },
      gotFirstToken: true,
      usage: { promptTokens: 7, completionTokens: 2, costUsd: 0.0003 },
    });
  });

  it('a 200 without a body is model_unavailable', async () => {
    const { fetchFn } = recordingFetch(() => new Response(null, { status: 200 }));
    expect(await callStream(req, options(fetchFn), () => {})).toMatchObject({
      ok: false,
      error: { code: 'model_unavailable' },
      gotFirstToken: false,
    });
  });

  it('maps a network failure before the response to network', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toMatchObject({ ok: false, error: { code: 'network', message: 'Нет связи с OpenRouter' }, gotFirstToken: false });
  });

  it('maps a connection drop after the first delta to network with gotFirstToken', async () => {
    const { fetchFn } = recordingFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(delta('Ра')));
        },
        pull() {
          throw new TypeError('network error');
        },
      });
      return new Response(body, { status: 200 });
    });
    const result = await callStream(req, options(fetchFn), () => {});
    expect(result).toMatchObject({ ok: false, error: { code: 'network' }, gotFirstToken: true });
  });

  describe('timeout and cancel', () => {
    it('distinguishes timeout from user cancel', async () => {
      vi.useFakeTimers();
      const hanging = recordingFetch(
        ({ init }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          }),
      );
      const pending = callStream(req, options(hanging.fetchFn), () => {});
      await vi.advanceTimersByTimeAsync(14_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const timedOut = await pending;
      expect(timedOut).toMatchObject({
        ok: false,
        error: { code: 'timeout', message: 'Модель не ответила за 15 с', model: 'vendor/model' },
        gotFirstToken: false,
      });
      expect(vi.getTimerCount()).toBe(0);

      const controller = new AbortController();
      const cancelling = callStream(req, options(hanging.fetchFn, { signal: controller.signal }), () => {});
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      expect(await cancelling).toMatchObject({
        ok: false,
        error: { code: 'cancelled', message: 'Остановлено' },
        gotFirstToken: false,
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not send a request when the signal is already aborted', async () => {
      const { fetchFn, calls } = recordingFetch(() => sseResponse([delta('x')]));
      const result = await callStream(req, options(fetchFn, { signal: AbortSignal.abort() }), () => {});
      expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' }, gotFirstToken: false });
      expect(calls).toHaveLength(0);
    });

    it('honours the signal carried by the request as well', async () => {
      const { fetchFn, calls } = recordingFetch(() => sseResponse([delta('x')]));
      const result = await callStream({ ...req, signal: AbortSignal.abort() }, options(fetchFn), () => {});
      expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      expect(calls).toHaveLength(0);
    });

    it('a user cancel after the first token keeps gotFirstToken', async () => {
      const controller = new AbortController();
      const { fetchFn } = recordingFetch(({ init }) => stalledResponse([delta('Ра')], init.signal));
      const result = await callStream(req, options(fetchFn, { signal: controller.signal }), () => controller.abort());
      expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' }, gotFirstToken: true });
    });

    it('the timeout covers reading the stream', async () => {
      vi.useFakeTimers();
      const { fetchFn } = recordingFetch(({ init }) => stalledResponse([delta('Ра')], init.signal));
      const deltas: string[] = [];
      const pending = callStream(req, options(fetchFn), (chunk) => deltas.push(chunk));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: 'timeout', message: 'Модель не ответила за 15 с' },
        gotFirstToken: true,
      });
      expect(deltas).toEqual(['Ра']);
      expect(vi.getTimerCount()).toBe(0);
    });

    describe('is a timeout of silence', () => {
      it('lets a stream run longer than the timeout as long as data keeps coming', async () => {
        vi.useFakeTimers();
        let live!: ReturnType<typeof liveResponse>;
        const { fetchFn } = recordingFetch(({ init }) => (live = liveResponse(init.signal)).response);
        const deltas: string[] = [];
        const pending = callStream(req, options(fetchFn), (chunk) => deltas.push(chunk));

        for (const piece of ['a', 'b', 'c']) {
          await vi.advanceTimersByTimeAsync(14_000); // N - 1 s of nothing, then a data line
          live.push(delta(piece));
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(deltas).toEqual(['a', 'b', 'c']); // 42 s in, with a 15 s timeout
        live.push('data: [DONE]\n\n');
        expect(await pending).toEqual({ ok: true, value: 'abc' });
        expect(vi.getTimerCount()).toBe(0);
      });

      it('times out N s after the last data line and reports that text had begun', async () => {
        vi.useFakeTimers();
        let live!: ReturnType<typeof liveResponse>;
        const { fetchFn } = recordingFetch(({ init }) => (live = liveResponse(init.signal)).response);
        const pending = callStream(req, options(fetchFn), () => {});

        await vi.advanceTimersByTimeAsync(10_000);
        live.push(delta('Ра'));
        await vi.advanceTimersByTimeAsync(14_999);
        expect(vi.getTimerCount()).toBe(1); // 25 s since the start, but not yet 15 s of silence
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({
          ok: false,
          error: { code: 'timeout', message: 'Модель не ответила за 15 с', model: 'vendor/model' },
          gotFirstToken: true,
        });
        expect(vi.getTimerCount()).toBe(0);
      });

      it('is still N s from the start before the first data line', async () => {
        vi.useFakeTimers();
        const { fetchFn } = recordingFetch(({ init }) => stalledResponse([], init.signal));
        const pending = callStream(req, options(fetchFn), () => {});
        await vi.advanceTimersByTimeAsync(14_999);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' }, gotFirstToken: false });
      });

      it('is not restarted by a comment line', async () => {
        vi.useFakeTimers();
        let live!: ReturnType<typeof liveResponse>;
        const { fetchFn } = recordingFetch(({ init }) => (live = liveResponse(init.signal)).response);
        const pending = callStream(req, options(fetchFn), () => {});

        await vi.advanceTimersByTimeAsync(10_000);
        live.push(': OPENROUTER PROCESSING\n\n');
        await vi.advanceTimersByTimeAsync(4_999);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({
          ok: false,
          error: { code: 'timeout', message: 'Модель не ответила за 15 с' },
          gotFirstToken: false,
        });
      });

      it('is restarted by a data line that carries no text', async () => {
        vi.useFakeTimers();
        let live!: ReturnType<typeof liveResponse>;
        const { fetchFn } = recordingFetch(({ init }) => (live = liveResponse(init.signal)).response);
        const pending = callStream(req, options(fetchFn), () => {});

        await vi.advanceTimersByTimeAsync(14_000);
        live.push(delta('')); // e.g. a reasoning-only chunk
        await vi.advanceTimersByTimeAsync(14_000);
        live.push(delta('x'));
        live.push('data: [DONE]\n\n');
        expect(await pending).toEqual({ ok: true, value: 'x' });
      });
    });

    it('clears the timer after a normal response', async () => {
      vi.useFakeTimers();
      const { fetchFn } = recordingFetch(() => sseResponse([delta('x')]));
      expect((await callStream(req, options(fetchFn), () => {})).ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the timer after an HTTP error', async () => {
      vi.useFakeTimers();
      const { fetchFn } = recordingFetch(() => new Response('', { status: 500 }));
      expect((await callStream(req, options(fetchFn), () => {})).ok).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('uses the timeout from the settings', async () => {
      vi.useFakeTimers();
      const { fetchFn } = recordingFetch(({ init }) => stalledResponse([], init.signal));
      const pending = callStream(
        req,
        options(fetchFn, { settings: { openRouterKey: KEY, reasoning: 'off', requestTimeoutSec: 90 } }),
        () => {},
      );
      await vi.advanceTimersByTimeAsync(89_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ error: { code: 'timeout', message: 'Модель не ответила за 90 с' } });
    });
  });
});

describe('callComplete', () => {
  it('returns message content and usage and passes response_format', async () => {
    const responseFormat = { type: 'json_schema', json_schema: { name: 's', strict: true, schema: {} } };
    const { fetchFn, calls } = recordingFetch(() =>
      json({
        choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.002 },
      }),
    );
    const result = await callComplete(req, { ...options(fetchFn), responseFormat });
    expect(result).toEqual({
      ok: true,
      value: '{"ok":true}',
      usage: { promptTokens: 20, completionTokens: 5, costUsd: 0.002 },
    });
    const { url, init } = calls[0]!;
    expect(url).toBe(URL);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'threadscombine',
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ stream: false, usage: { include: true }, response_format: responseFormat });
  });

  it('omits response_format when none is given', async () => {
    const { fetchFn, calls } = recordingFetch(() => json({ choices: [{ message: { content: 'x' } }] }));
    expect(await callComplete(req, options(fetchFn))).toEqual({ ok: true, value: 'x' });
    expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty('response_format');
  });

  it('maps HTTP errors', async () => {
    const { fetchFn } = recordingFetch(() => json({ error: { message: 'Rate limit' } }, 429));
    expect(await callComplete(req, options(fetchFn))).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', status: 429, model: 'vendor/model' },
      gotFirstToken: false,
    });
  });

  it('maps an error object inside a 200 response', async () => {
    const { fetchFn } = recordingFetch(() => json({ error: { code: 402, message: 'no money' } }));
    expect(await callComplete(req, options(fetchFn))).toMatchObject({
      ok: false,
      error: { code: 'no_credits', status: 402 },
      gotFirstToken: false,
    });
  });

  it('maps an error object with a code that is not a number inside a 200 response to model_unavailable', async () => {
    const { fetchFn } = recordingFetch(() => json({ error: { code: 'server_error', message: 'boom' } }));
    expect(await callComplete(req, options(fetchFn))).toMatchObject({
      ok: false,
      error: { code: 'model_unavailable', model: 'vendor/model' },
      gotFirstToken: false,
    });
  });

  it('keeps the deadline of the whole call, however the body trickles in', async () => {
    vi.useFakeTimers();
    let live!: ReturnType<typeof liveResponse>;
    const { fetchFn } = recordingFetch(({ init }) => (live = liveResponse(init.signal)).response);
    const pending = callComplete(req, options(fetchFn));
    await vi.advanceTimersByTimeAsync(14_000);
    live.push(' '); // the body shows signs of life; the deadline does not move
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout', message: 'Модель не ответила за 15 с' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('empty content is model_unavailable', async () => {
    for (const payload of [{ choices: [{ message: { content: '' } }] }, { choices: [] }, {}, { choices: [{ message: { content: null } }] }]) {
      const { fetchFn } = recordingFetch(() => json(payload));
      expect(await callComplete(req, options(fetchFn))).toMatchObject({
        ok: false,
        error: { code: 'model_unavailable' },
        gotFirstToken: false,
      });
    }
  });

  it('keeps the usage of an empty completion on the failure', async () => {
    const { fetchFn } = recordingFetch(() =>
      json({
        choices: [{ message: { role: 'assistant', content: '' } }],
        usage: { prompt_tokens: 40, completion_tokens: 1200, cost: 0.01 },
      }),
    );
    expect(await callComplete(req, options(fetchFn))).toEqual({
      ok: false,
      error: { code: 'model_unavailable', message: 'Модель vendor/model сейчас недоступна', model: 'vendor/model' },
      gotFirstToken: false,
      usage: { promptTokens: 40, completionTokens: 1200, costUsd: 0.01 },
    });
  });

  it('maps a network failure, a timeout and a cancel', async () => {
    const down = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    expect(await callComplete(req, options(down))).toMatchObject({ ok: false, error: { code: 'network' }, gotFirstToken: false });

    vi.useFakeTimers();
    const { fetchFn } = recordingFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const slow = callComplete(req, options(fetchFn));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await slow).toMatchObject({ ok: false, error: { code: 'timeout', message: 'Модель не ответила за 15 с' } });

    const stopped = callComplete(req, options(fetchFn, { signal: controller.signal }));
    controller.abort();
    expect(await stopped).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the timeout covers reading the response body', async () => {
    vi.useFakeTimers();
    const { fetchFn } = recordingFetch(({ init }) => stalledResponse([], init.signal));
    const pending = callComplete(req, options(fetchFn));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' }, gotFirstToken: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
