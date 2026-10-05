import { browser } from 'wxt/browser';
import { z } from 'zod';
import { AiFailure, generateJson, listModels, modelChain, streamText } from '../../src/ai';
import type { AiDeps, AiRequest, ModelInfo } from '../../src/ai';
import * as catalog from '../../src/ai/catalog';
import * as errors from '../../src/ai/errors';
import { db } from '../../src/storage/db';
import { listAccounts } from '../../src/storage/accounts';
import { formatJournal, listJournal } from '../../src/storage/journal';
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from '../../src/storage/settings';

const KEY = 'sk-or-v1-secret-key';
const NOW = new Date(2026, 9, 5, 12, 0, 0).getTime();
const DAY = 86_400_000;

const SECRET_QUESTION = 'СЕКРЕТНЫЙ ТЕКСТ ЗАПРОСА';
const SECRET_ANSWER = 'СЕКРЕТНЫЙ ТЕКСТ ОТВЕТА';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ fixtures

const settingsWith = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  openRouterKey: KEY,
  model: 'm/main',
  fallbackModels: ['m/fb'],
  ...over,
});

const modelInfo = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id,
  promptPricePerM: 1,
  completionPricePerM: 2,
  contextLength: 8000,
  supportsStructuredOutputs: false,
  supportsReasoning: false,
  ...over,
});

const req = (purpose = 'virality', extra: Partial<AiRequest> = {}): AiRequest => ({
  purpose,
  messages: [{ role: 'user', content: SECRET_QUESTION }],
  ...extra,
});

interface DepsOptions extends Partial<AiDeps> {
  settings?: Partial<Settings>;
  catalog?: ModelInfo[];
}

function makeDeps(fetchFn: typeof fetch, over: DepsOptions = {}): AiDeps {
  const { settings, catalog: models, ...rest } = over;
  return {
    getSettings: async () => settingsWith(settings),
    listModels: async () => models ?? [modelInfo('m/main'), modelInfo('m/fb')],
    getActiveAccountId: async () => 'acc-1',
    fetchFn,
    now: () => NOW,
    ...rest,
  };
}

// ----------------------------------------------------------- scripted OpenRouter

type Reply = Response | ((init: RequestInit) => Response | Promise<Response>);
type Body = { model: string; messages: Array<{ role: string; content: string }> } & Record<string, unknown>;

/** A fetch that answers each call to a model with the next reply scripted for that model. */
function scripted(script: Record<string, Reply[]>) {
  const calls: Body[] = [];
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push(body);
    const reply = script[body.model]?.shift();
    if (reply === undefined) throw new Error(`unscripted call to ${body.model}`);
    return typeof reply === 'function' ? reply(init ?? {}) : reply;
  }) as unknown as typeof fetch;
  return { fetchFn, calls, callsTo: (model: string) => calls.filter((call) => call.model === model) };
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5 };

const complete = (content: string, usage: object | null = USAGE): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage && { usage }) }), { status: 200 });

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

const stream = (deltas: string[], usage?: object): Response =>
  new Response(
    deltas.map((content) => sse({ choices: [{ delta: { content } }] })).join('') +
      (usage ? sse({ choices: [{ delta: {} }], usage }) : '') +
      'data: [DONE]\n\n',
    { status: 200 },
  );

const httpError = (status: number, message = 'oops'): Response =>
  new Response(JSON.stringify({ error: { message } }), { status });

/** Never answers; fails the way fetch does when the request signal aborts. */
const hang =
  (): Reply =>
  (init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

/** The user presses «Стоп» while the request is in flight: aborts, and the fetch fails as a real one does. */
const cancelledByUser =
  (controller: AbortController): Reply =>
  (init) => {
    controller.abort();
    return Promise.reject(init.signal?.reason);
  };

async function aiLog(): Promise<string[]> {
  const entries = await listJournal();
  return entries
    .filter((entry) => entry.area === 'ai')
    .reverse()
    .map((entry) => `${entry.level}: ${entry.message}`);
}

const spendRows = () => db.spend.orderBy('id').toArray();

// ------------------------------------------------------------------ modelChain

describe('modelChain', () => {
  it('is the main model followed by the fallbacks when they are enabled', () => {
    expect(modelChain(settingsWith({ fallbackModels: ['m/a', 'm/b'] }))).toEqual(['m/main', 'm/a', 'm/b']);
  });

  it('is only the main model when fallbacks are disabled', () => {
    expect(modelChain(settingsWith({ fallbackEnabled: false, fallbackModels: ['m/a'] }))).toEqual(['m/main']);
  });
});

// the types are re-exported too: the `import type` from '../../src/ai' above would not compile without them
it('re-exports listModels and AiFailure', () => {
  expect(listModels).toBe(catalog.listModels);
  expect(AiFailure).toBe(errors.AiFailure);
});

// ---------------------------------------------------------------- refusals

const schema = z.object({ title: z.string(), score: z.number() });
const VALID = JSON.stringify({ title: 'T', score: 3 });
/** What the facade sends for `schema`: the JSON Schema without the root `$schema` key. */
const SENT_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, score: { type: 'number' } },
  required: ['title', 'score'],
  additionalProperties: false,
};

describe('refusals before any request', () => {
  it('refuses without key or model, without asking the catalog or sending anything', async () => {
    const { fetchFn } = scripted({});
    const listModelsFn = vi.fn(async () => [modelInfo('m/main')]);
    const noKey = makeDeps(fetchFn, { settings: { openRouterKey: '' }, listModels: listModelsFn });
    const noModel = makeDeps(fetchFn, { settings: { model: '' }, listModels: listModelsFn });

    expect(await streamText(req(), vi.fn(), noKey)).toEqual({
      ok: false,
      error: { code: 'no_key', message: 'Укажите ключ OpenRouter в настройках' },
    });
    expect(await generateJson(req(), schema, 'S', noKey)).toMatchObject({ ok: false, error: { code: 'no_key' } });
    expect(await streamText(req(), vi.fn(), noModel)).toEqual({
      ok: false,
      error: { code: 'no_model', message: 'Выберите модель в настройках' },
    });
    expect(await generateJson(req(), schema, 'S', noModel)).toMatchObject({ ok: false, error: { code: 'no_model' } });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(listModelsFn).not.toHaveBeenCalled();
    expect(await aiLog()).toEqual([
      'error: virality: Укажите ключ OpenRouter в настройках',
      'error: virality: Укажите ключ OpenRouter в настройках',
      'error: virality: Выберите модель в настройках',
      'error: virality: Выберите модель в настройках',
    ]);
  });

  it('refuses over the daily budget but still allows the key check', async () => {
    await db.spend.add({ ts: NOW, accountId: 'acc-1', purpose: 'x', model: 'm/x', promptTokens: 1, completionTokens: 1, costUsd: 5 });
    const { fetchFn, calls } = scripted({ 'm/main': [stream(['ok'])] });
    const deps = makeDeps(fetchFn, { settings: { dailyBudgetUsd: 5 } });

    expect(await streamText(req('virality'), vi.fn(), deps)).toEqual({
      ok: false,
      error: {
        code: 'budget_exceeded',
        message: 'Достигнут дневной лимит расходов ($5.00). Измените лимит в настройках',
      },
    });
    expect(await generateJson(req('virality'), schema, 'S', deps)).toMatchObject({
      ok: false,
      error: { code: 'budget_exceeded' },
    });
    expect(fetchFn).not.toHaveBeenCalled();

    expect(await streamText(req('key-check'), vi.fn(), deps)).toMatchObject({ ok: true, value: 'ok' });
    expect(calls).toHaveLength(1);
  });

  it('names the monthly limit when only the month is used up, and does not try other models', async () => {
    await db.spend.add({ ts: NOW - 2 * DAY, accountId: 'acc-1', purpose: 'x', model: 'm/x', promptTokens: 1, completionTokens: 1, costUsd: 7 });
    const { fetchFn } = scripted({});
    const result = await streamText(
      req(),
      vi.fn(),
      makeDeps(fetchFn, { settings: { dailyBudgetUsd: 5, monthlyBudgetUsd: 7 } }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'budget_exceeded',
        message: 'Достигнут месячный лимит расходов ($7.00). Измените лимит в настройках',
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('checks the budget at the injected clock', async () => {
    await db.spend.add({ ts: NOW, accountId: 'acc-1', purpose: 'x', model: 'm/x', promptTokens: 1, completionTokens: 1, costUsd: 5 });
    const { fetchFn } = scripted({ 'm/main': [stream(['ok'])] });
    // tomorrow the day's limit starts from zero again
    const tomorrow = makeDeps(fetchFn, { settings: { dailyBudgetUsd: 5 }, now: () => NOW + DAY });
    expect(await streamText(req(), vi.fn(), tomorrow)).toMatchObject({ ok: true });
  });

  it('answers with an error, and does not reject, when the settings cannot be read', async () => {
    const { fetchFn } = scripted({});
    const listModelsFn = vi.fn(async () => [modelInfo('m/main')]);
    const deps = makeDeps(fetchFn, {
      getSettings: () => Promise.reject(new Error('storage down')),
      listModels: listModelsFn,
    });
    const refused = {
      ok: false,
      error: { code: 'unknown', message: 'Ошибка OpenRouter: Не удалось прочитать настройки' },
    };

    expect(await streamText(req(), vi.fn(), deps)).toEqual(refused);
    expect(await generateJson(req(), schema, 'S', deps)).toEqual(refused);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(listModelsFn).not.toHaveBeenCalled();
    const entries = (await listJournal()).filter((entry) => entry.area === 'ai' && entry.level === 'error');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.message).join(' | ')).toContain('Не удалось прочитать настройки');
    expect(entries.some((entry) => JSON.stringify(entry.details ?? null).includes('storage down'))).toBe(true);
  });

  it('fails open when the budget check cannot read the database', async () => {
    vi.spyOn(db.spend, 'where').mockImplementation(() => {
      throw new Error('db down');
    });
    const { fetchFn } = scripted({ 'm/main': [stream(['ok'])] });
    const result = await streamText(req(), vi.fn(), makeDeps(fetchFn, { settings: { dailyBudgetUsd: 5 } }));

    expect(result).toMatchObject({ ok: true, value: 'ok' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const entries = (await listJournal()).filter((entry) => entry.area === 'spend');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'error', details: { error: { message: 'db down' } } });
  });
});

// ---------------------------------------------------------------- the chain

describe('model chain', () => {
  const FAILURES: Record<string, { reply: Reply; settings?: Partial<Settings> }> = {
    rate_limited: { reply: httpError(429) },
    model_unavailable: { reply: httpError(503) },
    // the real request timer, made short: settings reach the facade unvalidated through deps
    timeout: { reply: hang(), settings: { requestTimeoutSec: 0.02 } },
    network: {
      reply: () => {
        throw new TypeError('fetch failed');
      },
    },
  };

  it.each(['rate_limited', 'model_unavailable', 'timeout', 'network'])(
    'switches to the next model on %s',
    async (code) => {
      const { reply, settings } = FAILURES[code]!;
      const { fetchFn, calls } = scripted({ 'm/main': [reply], 'm/fb': [stream(['При', 'вет'])] });
      const onDelta = vi.fn();

      const result = await streamText(req('key-check'), onDelta, makeDeps(fetchFn, { settings }));

      expect(result).toMatchObject({ ok: true, value: 'Привет', model: 'm/fb', switchedFrom: ['m/main'] });
      expect(calls.map((call) => call.model)).toEqual(['m/main', 'm/fb']);
      expect(onDelta.mock.calls).toEqual([['При'], ['вет']]);
      expect(await aiLog()).toEqual([`warn: key-check: m/main → ${code}`]);
    },
  );

  it.each([
    [401, 'bad_key'],
    [403, 'bad_key'],
    [402, 'no_credits'],
  ] as const)('does not switch on %i', async (status, code) => {
    const { fetchFn } = scripted({ 'm/main': [httpError(status)], 'm/fb': [stream(['x'])] });
    const result = await streamText(req(), vi.fn(), makeDeps(fetchFn));
    expect(result).toMatchObject({ ok: false, error: { code, model: 'm/main' } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not switch when the user cancels', async () => {
    const controller = new AbortController();
    const { fetchFn } = scripted({ 'm/main': [cancelledByUser(controller)], 'm/fb': [stream(['x'])] });

    const result = await streamText(req('virality', { signal: controller.signal }), vi.fn(), makeDeps(fetchFn));

    expect(result).toEqual({ ok: false, error: { code: 'cancelled', message: 'Остановлено', model: 'm/main' } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // stopping is not a fault: it must not look like one in the journal
    expect(await aiLog()).toEqual(['info: virality: Остановлено']);
  });

  it('does not switch after the stream has started', async () => {
    const { fetchFn } = scripted({
      'm/main': [new Response(sse({ choices: [{ delta: { content: 'При' } }] }) + sse({ error: { code: 502, message: 'upstream' } }))],
      'm/fb': [stream(['x'])],
    });
    const onDelta = vi.fn();

    const result = await streamText(req(), onDelta, makeDeps(fetchFn));

    expect(result).toMatchObject({ ok: false, error: { code: 'model_unavailable' } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onDelta.mock.calls).toEqual([['При']]);
    expect(await aiLog()).toEqual(['error: virality: Модель m/main сейчас недоступна']);
  });

  it('does not use fallbacks when they are disabled', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [httpError(429)], 'm/fb': [stream(['x'])] });
    const result = await streamText(req(), vi.fn(), makeDeps(fetchFn, { settings: { fallbackEnabled: false } }));
    expect(result).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(calls.map((call) => call.model)).toEqual(['m/main']);
  });

  it('returns the last error when every model fails', async () => {
    const { fetchFn, calls } = scripted({
      'm/main': [httpError(429)],
      'm/fb': [httpError(503)],
      'm/fb2': [
        () => {
          throw new TypeError('fetch failed');
        },
      ],
    });
    const result = await streamText(
      req(),
      vi.fn(),
      makeDeps(fetchFn, { settings: { fallbackModels: ['m/fb', 'm/fb2'] } }),
    );

    expect(result).toEqual({ ok: false, error: { code: 'network', message: 'Нет связи с OpenRouter', model: 'm/fb2' } });
    expect(calls.map((call) => call.model)).toEqual(['m/main', 'm/fb', 'm/fb2']);
    expect(await aiLog()).toEqual([
      'warn: virality: m/main → rate_limited',
      'warn: virality: m/fb → model_unavailable',
      'error: virality: Нет связи с OpenRouter',
    ]);
  });

  it('measures the whole time, switches included', async () => {
    let clock = 1_000;
    const { fetchFn } = scripted({
      'm/main': [() => ((clock += 400), httpError(503))],
      'm/fb': [() => ((clock += 250), stream(['x']))],
    });
    const result = await streamText(req(), vi.fn(), makeDeps(fetchFn, { now: () => clock }));
    expect(result).toMatchObject({ ok: true, elapsedMs: 650 });
  });

  it('keeps the key, the request and the answer out of the journal', async () => {
    const { fetchFn } = scripted({
      'm/main': [httpError(503, `boom ${SECRET_QUESTION}`)],
      'm/fb': [stream([SECRET_ANSWER])],
    });
    await streamText(req(), vi.fn(), makeDeps(fetchFn));
    const { fetchFn: failing } = scripted({ 'm/main': [httpError(401)], 'm/fb': [] });
    await streamText(req(), vi.fn(), makeDeps(failing));

    const journal = formatJournal(await listJournal());
    expect(journal).not.toContain(KEY);
    expect(journal).not.toContain(SECRET_QUESTION);
    expect(journal).not.toContain(SECRET_ANSWER);
    expect(journal).toContain('m/main → model_unavailable');
  });
});

// ------------------------------------------------------------------ the stream

describe('streamText', () => {
  it('survives a UI handler that throws and reports it once', async () => {
    const { fetchFn } = scripted({ 'm/main': [stream(['Пр', 'и', 'вет'])] });
    const onDelta = vi.fn(() => {
      throw new Error('ui exploded');
    });

    const result = await streamText(req(), onDelta, makeDeps(fetchFn));

    expect(result).toMatchObject({ ok: true, value: 'Привет', switchedFrom: [] });
    expect(onDelta).toHaveBeenCalledTimes(3);
    await vi.waitFor(async () => {
      const entries = (await listJournal()).filter((entry) => entry.area === 'ai');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: 'error',
        message: 'virality: ошибка в обработчике потока',
        details: { error: { message: 'ui exploded' } },
      });
    });
  });

  it('passes the request settings and cancel signal through to the call', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [stream(['x'])] });
    const controller = new AbortController();
    await streamText(
      req('virality', { temperature: 0.3, maxTokens: 50, signal: controller.signal }),
      vi.fn(),
      makeDeps(fetchFn),
    );
    expect(calls[0]).toMatchObject({ model: 'm/main', stream: true, temperature: 0.3, max_tokens: 50 });
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: SECRET_QUESTION }]);
  });

  it('sends reasoning only for models the catalog says support it', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [httpError(503)], 'm/fb': [stream(['x'])] });
    const deps = makeDeps(fetchFn, {
      settings: { reasoning: 'high' },
      catalog: [modelInfo('m/main', { supportsReasoning: true }), modelInfo('m/fb')],
    });
    await streamText(req(), vi.fn(), deps);
    expect(calls[0]).toMatchObject({ model: 'm/main', reasoning: { effort: 'high' } });
    expect(calls[1]).toMatchObject({ model: 'm/fb' });
    expect(calls[1]).not.toHaveProperty('reasoning');
  });

  it('treats a model that is missing from the catalog as having no capabilities', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [stream(['x'], { prompt_tokens: 1000, completion_tokens: 1000 })] });
    const result = await streamText(req(), vi.fn(), makeDeps(fetchFn, { settings: { reasoning: 'high' }, catalog: [] }));
    expect(calls[0]).not.toHaveProperty('reasoning');
    expect(result).toMatchObject({ ok: true, usage: { promptTokens: 1000, completionTokens: 1000, costUsd: 0 } });
    expect((await spendRows())[0]?.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------- catalog and timing

describe('catalog lookup', () => {
  // only the timers the facade itself uses are faked: IndexedDB keeps its real scheduling
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  it('does not wait for the catalog longer than 5 s, then runs without its capabilities', async () => {
    fakeTimers();
    const { fetchFn, calls } = scripted({ 'm/main': [complete(VALID, { prompt_tokens: 1000, completion_tokens: 1000 })] });
    const deps = makeDeps(fetchFn, { settings: { reasoning: 'high' }, listModels: () => new Promise(() => {}) });

    const pending = generateJson(req(), schema, 'S', deps);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toMatchObject({ ok: true, value: { title: 'T', score: 3 }, usage: { costUsd: 0 } });
    expect(calls[0]).not.toHaveProperty('reasoning');
    expect(calls[0]).not.toHaveProperty('response_format');
    expect(calls[0]?.messages[0]?.role).toBe('system');
    expect(vi.getTimerCount()).toBe(0);
    expect((await spendRows())[0]?.costUsd).toBe(0);
    expect(await aiLog()).toEqual(['warn: virality: каталог моделей недоступен']);
  });

  it('carries on when the catalog fails', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [stream(['x'])] });
    const deps = makeDeps(fetchFn, {
      settings: { reasoning: 'high' },
      listModels: async () => {
        throw new AiFailure(errors.aiError('network'));
      },
    });
    expect(await streamText(req(), vi.fn(), deps)).toMatchObject({ ok: true });
    expect(calls[0]).not.toHaveProperty('reasoning');
    expect(await aiLog()).toEqual(['warn: virality: каталог моделей недоступен']);
  });

  it('carries on when listModels throws synchronously', async () => {
    const { fetchFn } = scripted({ 'm/main': [stream(['x'])] });
    const deps = makeDeps(fetchFn, {
      listModels: () => {
        throw new Error('sync');
      },
    });
    expect(await streamText(req(), vi.fn(), deps)).toMatchObject({ ok: true });
  });

  it('leaves no timer behind when the catalog answers at once', async () => {
    fakeTimers();
    const { fetchFn } = scripted({ 'm/main': [stream(['x'])] });
    expect(await streamText(req(), vi.fn(), makeDeps(fetchFn))).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not raise when a late catalog failure arrives after the timeout', async () => {
    fakeTimers();
    let rejectCatalog: (reason: unknown) => void = () => {};
    const { fetchFn } = scripted({ 'm/main': [stream(['x'])] });
    const deps = makeDeps(fetchFn, {
      listModels: () =>
        new Promise((_resolve, reject) => {
          rejectCatalog = reject;
        }),
    });
    const pending = streamText(req(), vi.fn(), deps);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ ok: true });
    rejectCatalog(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
  });
});

// -------------------------------------------------------------------- spend

describe('spend', () => {
  it('records every answered call under the active account, the repair call included', async () => {
    const { fetchFn } = scripted({
      'm/main': [
        complete('это не JSON', { prompt_tokens: 100, completion_tokens: 50 }),
        complete(VALID, { prompt_tokens: 120, completion_tokens: 60, cost: 0.001 }),
      ],
    });
    const result = await generateJson(req(), schema, 'S', makeDeps(fetchFn));

    const rows = await spendRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ts: NOW,
      accountId: 'acc-1',
      purpose: 'virality',
      model: 'm/main',
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(rows[0]?.costUsd).toBeCloseTo((100 * 1 + 50 * 2) / 1_000_000, 12); // catalog prices: no cost reported
    expect(rows[1]).toMatchObject({ promptTokens: 120, completionTokens: 60, costUsd: 0.001, accountId: 'acc-1' });
    // the result carries the usage of the last successful call
    expect(result).toMatchObject({ ok: true, usage: { promptTokens: 120, completionTokens: 60, costUsd: 0.001 } });
  });

  it('fills the cost of the result from the catalog when OpenRouter reports none', async () => {
    const { fetchFn } = scripted({ 'm/main': [stream(['x'], { prompt_tokens: 1000, completion_tokens: 1000 })] });
    const result = await streamText(req(), vi.fn(), makeDeps(fetchFn));
    expect(result).toMatchObject({ ok: true, usage: { promptTokens: 1000, completionTokens: 1000 } });
    expect(result.ok && result.usage?.costUsd).toBeCloseTo(0.003, 12);
  });

  it('records a failed call that was billed, then the fallback that answered', async () => {
    const { fetchFn } = scripted({
      // 200 with no text: billed, but the model gave nothing
      'm/main': [stream([], { prompt_tokens: 40, completion_tokens: 0, cost: 0.0004 })],
      'm/fb': [stream(['ok'], { prompt_tokens: 40, completion_tokens: 3 })],
    });
    const result = await streamText(req(), vi.fn(), makeDeps(fetchFn));

    expect(result).toMatchObject({ ok: true, model: 'm/fb', switchedFrom: ['m/main'], usage: { completionTokens: 3 } });
    const rows = await spendRows();
    expect(rows.map((row) => [row.model, row.costUsd])).toEqual([
      ['m/main', 0.0004],
      ['m/fb', expect.closeTo((40 * 1 + 3 * 2) / 1_000_000, 12)],
    ]);
  });

  it('records the spend of a call that failed in the middle of the stream', async () => {
    const { fetchFn } = scripted({
      'm/main': [
        new Response(
          sse({ choices: [{ delta: { content: 'ab' } }], usage: { prompt_tokens: 7, completion_tokens: 1, cost: 0.5 } }) +
            sse({ error: { code: 502, message: 'cut' } }),
        ),
      ],
    });
    const result = await streamText(req(), vi.fn(), makeDeps(fetchFn));
    expect(result).toMatchObject({ ok: false });
    expect(await spendRows()).toMatchObject([{ model: 'm/main', promptTokens: 7, completionTokens: 1, costUsd: 0.5 }]);
  });

  it('records nothing for an answer without usage, and the result has none', async () => {
    const { fetchFn } = scripted({ 'm/main': [complete(VALID, null)] });
    const result = await generateJson(req(), schema, 'S', makeDeps(fetchFn));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.usage).toBeUndefined();
    expect(await spendRows()).toEqual([]);
  });

  it('records the key check too, and nothing for requests that were never sent', async () => {
    const { fetchFn } = scripted({ 'm/main': [stream(['ok'], USAGE)] });
    await streamText(req('key-check'), vi.fn(), makeDeps(fetchFn));
    await streamText(req(), vi.fn(), makeDeps(fetchFn, { settings: { openRouterKey: '' } }));
    expect(await spendRows()).toMatchObject([{ purpose: 'key-check' }]);
  });

  it('asks for the active account once per request and keeps it for every row', async () => {
    const ids = ['acc-1', 'acc-2'];
    const getActiveAccountId = vi.fn(async () => ids.shift() ?? 'acc-X');
    const { fetchFn } = scripted({
      'm/main': [complete('не JSON'), complete('и снова не JSON')],
      'm/fb': [complete(VALID)],
    });
    await generateJson(req(), schema, 'S', makeDeps(fetchFn, { getActiveAccountId }));
    expect(getActiveAccountId).toHaveBeenCalledTimes(1);
    expect((await spendRows()).map((row) => row.accountId)).toEqual(['acc-1', 'acc-1', 'acc-1']);
  });

  it('still sends the request when the active account cannot be read', async () => {
    const { fetchFn } = scripted({ 'm/main': [stream(['ok'], USAGE)] });
    const deps = makeDeps(fetchFn, {
      getActiveAccountId: async () => {
        throw new Error('db down');
      },
    });
    expect(await streamText(req(), vi.fn(), deps)).toMatchObject({ ok: true });
    expect(await spendRows()).toMatchObject([{ accountId: '' }]);
    const entries = (await listJournal()).filter((entry) => entry.area === 'spend');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('error');
  });
});

// ------------------------------------------------------------- generateJson

describe('generateJson', () => {
  const structured = [modelInfo('m/main', { supportsStructuredOutputs: true }), modelInfo('m/fb')];

  it('asks capable models for a json_schema response', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [complete(VALID)] });
    const result = await generateJson(req(), schema, 'Verdict', makeDeps(fetchFn, { catalog: structured }));

    expect(result).toMatchObject({ ok: true, value: { title: 'T', score: 3 }, model: 'm/main', switchedFrom: [] });
    expect(calls[0]).toMatchObject({
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'Verdict', strict: true, schema: SENT_SCHEMA } },
    });
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: SECRET_QUESTION }]);
  });

  it('leaves the root $schema key out of the schema in both modes', async () => {
    const withFormat = scripted({ 'm/main': [complete(VALID)] });
    await generateJson(req(), schema, 'Verdict', makeDeps(withFormat.fetchFn, { catalog: structured }));
    const sent = withFormat.calls[0] as unknown as { response_format: { json_schema: { schema: object } } };
    expect(sent.response_format.json_schema.schema).not.toHaveProperty('$schema');
    expect(JSON.stringify(withFormat.calls[0])).not.toContain('$schema');

    const inPrompt = scripted({ 'm/main': [complete('x'), complete(VALID)] });
    await generateJson(req(), schema, 'Verdict', makeDeps(inPrompt.fetchFn));
    expect(JSON.stringify(inPrompt.calls[0])).not.toContain('$schema'); // the first request
    expect(JSON.stringify(inPrompt.calls[1])).not.toContain('$schema'); // and the repair request
  });

  it('embeds the schema in a new first system message otherwise', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [complete(VALID)] });
    await generateJson(req(), schema, 'Verdict', makeDeps(fetchFn));

    expect(calls[0]).not.toHaveProperty('response_format');
    expect(calls[0]?.messages).toEqual([
      {
        role: 'system',
        content: `Ответь только JSON по этой схеме, без пояснений:\n${JSON.stringify(SENT_SCHEMA)}`,
      },
      { role: 'user', content: SECRET_QUESTION },
    ]);
  });

  it('appends the schema to the system message the caller already has, without touching the request', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [complete(VALID)] });
    const messages = Object.freeze([
      Object.freeze({ role: 'system' as const, content: 'Ты редактор.' }),
      Object.freeze({ role: 'user' as const, content: SECRET_QUESTION }),
    ]) as unknown as AiRequest['messages'];

    await generateJson({ purpose: 'virality', messages }, schema, 'Verdict', makeDeps(fetchFn));

    expect(calls[0]?.messages).toHaveLength(2);
    expect(calls[0]?.messages[0]).toEqual({
      role: 'system',
      content: `Ты редактор.\n\nОтветь только JSON по этой схеме, без пояснений:\n${JSON.stringify(SENT_SCHEMA)}`,
    });
    expect(messages[0]?.content).toBe('Ты редактор.');
  });

  it('decides the JSON mode for each model of the chain', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [httpError(503)], 'm/fb': [complete(VALID)] });
    const catalogWithFallbackCapable = [modelInfo('m/main'), modelInfo('m/fb', { supportsStructuredOutputs: true })];
    const result = await generateJson(req(), schema, 'S', makeDeps(fetchFn, { catalog: catalogWithFallbackCapable }));

    expect(result).toMatchObject({ ok: true, model: 'm/fb', switchedFrom: ['m/main'] });
    expect(calls[0]).not.toHaveProperty('response_format');
    expect(calls[0]?.messages[0]?.role).toBe('system');
    expect(calls[1]).toHaveProperty('response_format.type', 'json_schema');
    expect(calls[1]?.messages).toEqual([{ role: 'user', content: SECRET_QUESTION }]);
  });

  it('takes the answer out of a code fence or surrounding prose', async () => {
    const { fetchFn } = scripted({ 'm/main': [complete('```json\n' + VALID + '\n```')] });
    expect(await generateJson(req(), schema, 'S', makeDeps(fetchFn))).toMatchObject({
      ok: true,
      value: { title: 'T', score: 3 },
    });
  });

  it('repairs a bad answer with one more request to the same model', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [complete('{"title":1}'), complete(VALID)] });
    const result = await generateJson(req(), schema, 'S', makeDeps(fetchFn));

    expect(result).toMatchObject({ ok: true, value: { title: 'T', score: 3 }, model: 'm/main', switchedFrom: [] });
    expect(calls).toHaveLength(2);
    const [first, repair] = calls.map((call) => call.messages);
    expect(repair).toHaveLength(first!.length + 2);
    expect(repair?.slice(0, first!.length)).toEqual(first);
    expect(repair?.[first!.length]).toEqual({ role: 'assistant', content: '{"title":1}' });
    const instruction = repair?.[first!.length + 1];
    expect(instruction?.role).toBe('user');
    expect(instruction?.content).toMatch(/^Исправь формат ответа\. Ошибки проверки: .*title.*score.* Верни только JSON\.$/s);
  });

  it('describes an answer that is not JSON at all in the repair request', async () => {
    const { fetchFn, calls } = scripted({ 'm/main': [complete('просто слова'), complete(VALID)] });
    await generateJson(req(), schema, 'S', makeDeps(fetchFn));
    expect(calls[1]?.messages.at(-1)?.content).toBe(
      'Исправь формат ответа. Ошибки проверки: ответ не является корректным JSON. Верни только JSON.',
    );
  });

  it('keeps the schema instruction and response_format in the repair request', async () => {
    const plain = scripted({ 'm/main': [complete('x'), complete(VALID)] });
    await generateJson(req(), schema, 'S', makeDeps(plain.fetchFn));
    expect(plain.calls[1]?.messages[0]?.content).toContain('Ответь только JSON по этой схеме');

    const capable = scripted({ 'm/main': [complete('x'), complete(VALID)] });
    await generateJson(req(), schema, 'Verdict', makeDeps(capable.fetchFn, { catalog: structured }));
    expect(capable.calls[1]).toHaveProperty('response_format.json_schema.name', 'Verdict');
  });

  it('keeps the long list of problems short in the repair request', async () => {
    const wide = z.object(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, z.string()])));
    const { fetchFn, calls } = scripted({ 'm/main': [complete('{}'), complete('{}')] });
    await generateJson(req(), wide, 'S', makeDeps(fetchFn, { settings: { fallbackEnabled: false } }));
    expect(calls[1]?.messages.at(-1)?.content.length).toBeLessThan(700);
  });

  it('repairs one bad answer, then gives bad_output and switches', async () => {
    const { fetchFn, calls, callsTo } = scripted({
      'm/main': [complete('мусор'), complete('{"title":"only"}')],
      'm/fb': [complete(VALID)],
    });
    const result = await generateJson(req(), schema, 'S', makeDeps(fetchFn));

    expect(result).toMatchObject({ ok: true, value: { title: 'T', score: 3 }, model: 'm/fb', switchedFrom: ['m/main'] });
    expect(callsTo('m/main')).toHaveLength(2);
    expect(calls.map((call) => call.model)).toEqual(['m/main', 'm/main', 'm/fb']);
    expect(await aiLog()).toEqual(['warn: virality: m/main → bad_output']);
    expect(await spendRows()).toHaveLength(3);
  });

  it('ends with bad_output when the last model cannot produce the format either', async () => {
    const { fetchFn } = scripted({ 'm/main': [complete('x'), complete('y')], 'm/fb': [complete('z'), complete('w')] });
    const result = await generateJson(req(), schema, 'S', makeDeps(fetchFn));

    expect(result).toEqual({
      ok: false,
      error: { code: 'bad_output', message: 'Модель вернула ответ в неверном формате', model: 'm/fb' },
    });
    expect(await aiLog()).toEqual([
      'warn: virality: m/main → bad_output',
      'error: virality: Модель вернула ответ в неверном формате',
    ]);
    expect(formatJournal(await listJournal())).not.toContain(SECRET_QUESTION);
  });

  it('switches when the repair request itself fails with a switchable error', async () => {
    const { fetchFn, calls } = scripted({
      'm/main': [complete('не JSON'), httpError(503)],
      'm/fb': [complete(VALID)],
    });
    const result = await generateJson(req(), schema, 'S', makeDeps(fetchFn));
    expect(result).toMatchObject({ ok: true, model: 'm/fb', switchedFrom: ['m/main'] });
    expect(calls.map((call) => call.model)).toEqual(['m/main', 'm/main', 'm/fb']);
  });

  it('stops at once when the repair request fails with a fatal error', async () => {
    const { fetchFn } = scripted({ 'm/main': [complete('не JSON'), httpError(402)], 'm/fb': [complete(VALID)] });
    const result = await generateJson(req(), schema, 'S', makeDeps(fetchFn));
    expect(result).toMatchObject({ ok: false, error: { code: 'no_credits' } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('passes the cancel signal to every request, repair included', async () => {
    const controller = new AbortController();
    const { fetchFn } = scripted({ 'm/main': [complete('не JSON'), cancelledByUser(controller)] });
    const result = await generateJson(
      req('virality', { signal: controller.signal }),
      schema,
      'S',
      makeDeps(fetchFn),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------- default dependencies

describe('default dependencies', () => {
  it('reads the settings, the catalog and the active account from the real modules', async () => {
    await browser.storage.local.set({
      [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, openRouterKey: KEY, model: 'm/main', reasoning: 'low' },
    });
    const bodies: Body[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'm/main',
                name: 'Main',
                pricing: { prompt: '0.000001', completion: '0.000002' },
                context_length: 8000,
                architecture: { output_modalities: ['text'] },
                supported_parameters: ['reasoning'],
              },
            ],
          }),
        );
      }
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return stream(['ok'], { prompt_tokens: 1000, completion_tokens: 1000 });
    }) as unknown as typeof fetch;

    const result = await streamText(req(), vi.fn(), { fetchFn });

    expect(result).toMatchObject({ ok: true, value: 'ok', model: 'm/main' });
    expect(result.ok && result.usage?.costUsd).toBeCloseTo(0.003, 12);
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'low' } });
    const [account] = await listAccounts();
    expect(await spendRows()).toMatchObject([{ accountId: account?.id, model: 'm/main' }]);
  });
});
