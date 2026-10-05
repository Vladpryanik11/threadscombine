import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  MODELS_CACHE_KEY,
  MODELS_CACHE_TTL_MS,
  OPENROUTER_BASE,
  findModel,
  listModels,
  parseModelsResponse,
} from '../../src/ai/catalog';
import { AiFailure } from '../../src/ai/errors';
import { RECOMMENDED_MODEL_IDS, sortModelsForPicker } from '../../src/ai/recommended';
import type { ModelInfo } from '../../src/ai/types';

const RESPONSE = {
  data: [
    {
      id: 'vendor/cheap-text',
      name: 'Vendor: Cheap Text',
      context_length: 128000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.00000015', completion: '0.0000006' },
      supported_parameters: ['temperature', 'max_tokens'],
    },
    {
      id: 'vendor/image-only',
      name: 'Vendor: Image Only',
      context_length: 4096,
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      pricing: { prompt: '0.00001', completion: '0.00002' },
      supported_parameters: [],
    },
    {
      id: 'vendor/thinker',
      name: 'Vendor: Thinker',
      context_length: 200000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['reasoning', 'structured_outputs', 'tools'],
    },
  ],
};

const CHEAP: ModelInfo = {
  id: 'vendor/cheap-text',
  name: 'Vendor: Cheap Text',
  promptPricePerM: 0.15,
  completionPricePerM: 0.6,
  contextLength: 128000,
  supportsStructuredOutputs: false,
  supportsReasoning: false,
};

const THINKER: ModelInfo = {
  id: 'vendor/thinker',
  name: 'Vendor: Thinker',
  promptPricePerM: 3,
  completionPricePerM: 15,
  contextLength: 200000,
  supportsStructuredOutputs: true,
  supportsReasoning: true,
};

const okResponse = (body: unknown = RESPONSE): Response => new Response(JSON.stringify(body));

const storedCache = async (): Promise<unknown> =>
  (await fakeBrowser.storage.local.get(MODELS_CACHE_KEY))[MODELS_CACHE_KEY];

const offline = vi.fn(async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseModelsResponse', () => {
  it('parses text models with per-million prices and capabilities', () => {
    const models = parseModelsResponse(RESPONSE);
    expect(models).toEqual([CHEAP, THINKER]);
    expect(models.find((m) => m.id === 'vendor/image-only')).toBeUndefined();
  });

  it('keeps prices exact: 0.00000015 $/token is 0.15 $/M', () =>
    expect(parseModelsResponse(RESPONSE)[0]?.promptPricePerM).toBe(0.15));

  it('treats unknown prices as 0', () => {
    const entry = (pricing: unknown) => ({
      id: 'a/b',
      name: 'A',
      context_length: 1,
      architecture: { output_modalities: ['text'] },
      pricing,
      supported_parameters: [],
    });
    for (const pricing of [
      { prompt: '-1', completion: '-1' },
      { prompt: 'free', completion: '' },
      { prompt: null, completion: undefined },
      {},
      undefined,
    ]) {
      expect(parseModelsResponse({ data: [entry(pricing)] })[0]).toMatchObject({
        promptPricePerM: 0,
        completionPricePerM: 0,
      });
    }
  });

  it('is defensive about malformed input', () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse('nope')).toEqual([]);
    expect(parseModelsResponse({})).toEqual([]);
    expect(parseModelsResponse({ data: 'x' })).toEqual([]);
    expect(
      parseModelsResponse({
        data: [
          null,
          'str',
          { name: 'no id', architecture: { output_modalities: ['text'] } },
          { id: '', architecture: { output_modalities: ['text'] } },
          { id: 'no/arch' },
          { id: 'bad/arch', architecture: { output_modalities: 'text' } },
        ],
      }),
    ).toEqual([]);
  });

  it('fills missing optional fields with safe defaults', () =>
    expect(
      parseModelsResponse({ data: [{ id: 'a/b', architecture: { output_modalities: ['text'] } }] }),
    ).toEqual([
      {
        id: 'a/b',
        name: 'a/b',
        promptPricePerM: 0,
        completionPricePerM: 0,
        contextLength: 0,
        supportsStructuredOutputs: false,
        supportsReasoning: false,
      },
    ]));
});

describe('listModels', () => {
  it('requests the public catalog without credentials', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okResponse());
    await listModels({ fetchFn });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`${OPENROUTER_BASE}/models`);
    expect(JSON.stringify(init ?? {})).not.toMatch(/authorization|bearer/i);
  });

  it('caches for 24h and refetches with force or after expiry', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    let now = 1_000_000;
    const opts = { fetchFn, now: () => now };

    expect(await listModels(opts)).toEqual([CHEAP, THINKER]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await storedCache()).toEqual({ fetchedAt: 1_000_000, models: [CHEAP, THINKER] });

    now += MODELS_CACHE_TTL_MS - 1;
    expect(await listModels(opts)).toEqual([CHEAP, THINKER]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await listModels({ ...opts, force: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    now += MODELS_CACHE_TTL_MS + 1;
    await listModels(opts);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('refetches when the cache is from the future (clock moved back)', async () => {
    await fakeBrowser.storage.local.set({
      [MODELS_CACHE_KEY]: { fetchedAt: 9_000_000, models: [CHEAP] },
    });
    const fetchFn = vi.fn(async () => okResponse());
    expect(await listModels({ fetchFn, now: () => 1_000 })).toEqual([CHEAP, THINKER]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale cache when offline', async () => {
    await fakeBrowser.storage.local.set({ [MODELS_CACHE_KEY]: { fetchedAt: 0, models: [CHEAP] } });
    const now = () => MODELS_CACHE_TTL_MS * 3;
    expect(await listModels({ fetchFn: offline, now })).toEqual([CHEAP]);
    expect(await listModels({ fetchFn: offline, now, force: true })).toEqual([CHEAP]);
  });

  it('fails with a network AiFailure when offline without a cache', async () => {
    const failure = await listModels({ fetchFn: offline }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiFailure);
    expect((failure as AiFailure).error).toMatchObject({
      code: 'network',
      message: 'Нет связи с OpenRouter',
    });
  });

  it('treats an HTTP error like being offline', async () => {
    const fetchFn = vi.fn(async () => new Response('down', { status: 503 }));
    const failure = (await listModels({ fetchFn }).catch((e: unknown) => e)) as AiFailure;
    expect(failure).toBeInstanceOf(AiFailure);
    expect(failure.error).toMatchObject({ code: 'network', status: 503 });

    await fakeBrowser.storage.local.set({ [MODELS_CACHE_KEY]: { fetchedAt: 0, models: [CHEAP] } });
    expect(await listModels({ fetchFn, now: () => MODELS_CACHE_TTL_MS * 2 })).toEqual([CHEAP]);
  });

  it('does not cache a response that holds no text models', async () => {
    const empty = vi.fn(async () => okResponse({ data: [] }));
    const failure = await listModels({ fetchFn: empty }).catch((e: unknown) => e);
    expect((failure as AiFailure).error.code).toBe('network');
    expect(await storedCache()).toBeUndefined();

    const html = vi.fn(async () => new Response('<html></html>'));
    const notJson = await listModels({ fetchFn: html }).catch((e: unknown) => e);
    expect((notJson as AiFailure).error.code).toBe('network');
  });

  it('ignores a corrupt cache entry', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    for (const junk of ['x', { fetchedAt: 'now', models: [] }, { fetchedAt: 1, models: [{ id: 5 }] }]) {
      await fakeBrowser.storage.local.set({ [MODELS_CACHE_KEY]: junk });
      expect(await listModels({ fetchFn, now: () => 2 })).toEqual([CHEAP, THINKER]);
    }
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('still returns the fresh catalog when the cache cannot be written', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('quota'));
    expect(await listModels({ fetchFn: async () => okResponse() })).toEqual([CHEAP, THINKER]);
  });
});

describe('findModel', () => {
  it('finds a model by id', () => {
    expect(findModel([CHEAP, THINKER], 'vendor/thinker')).toBe(THINKER);
    expect(findModel([CHEAP, THINKER], 'nope')).toBeUndefined();
  });
});

describe('sortModelsForPicker', () => {
  const make = (id: string, name: string): ModelInfo => ({ ...CHEAP, id, name });

  it('puts existing recommended models first, in list order, the rest by name', () => {
    const [first, second, third] = RECOMMENDED_MODEL_IDS;
    const models = [
      make('z/zeta', 'Zeta'),
      make(third, 'Qwen Flash'),
      make('a/alpha', 'alpha'),
      make(first, 'DeepSeek Flash'),
      make('m/mid', 'Mid'),
    ];
    const sorted = sortModelsForPicker(models);
    expect(sorted.map((m) => m.id)).toEqual([first, third, 'a/alpha', 'm/mid', 'z/zeta']);
    expect(sorted.map((m) => m.recommended)).toEqual([true, true, false, false, false]);
    expect(sorted.map((m) => m.id)).not.toContain(second);
  });

  it('flags only ids that are present in the catalog and does not mutate the input', () => {
    const models = [make('b/two', 'Two'), make('a/one', 'One')];
    const copy = [...models];
    expect(sortModelsForPicker(models).every((m) => !m.recommended)).toBe(true);
    expect(models).toEqual(copy);
    expect(sortModelsForPicker([])).toEqual([]);
  });

  it('keeps the model data intact', () => {
    const [id] = RECOMMENDED_MODEL_IDS;
    expect(sortModelsForPicker([make(id, 'X')])[0]).toEqual({ ...make(id, 'X'), recommended: true });
  });
});
