import { browser } from 'wxt/browser';
import { z } from 'zod';
import { AiFailure, aiError } from './errors';
import type { ModelInfo } from './types';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const MODELS_CACHE_KEY = 'modelsCache';
export const MODELS_CACHE_TTL_MS = 86_400_000;

const cacheSchema = z.object({
  fetchedAt: z.number(),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      promptPricePerM: z.number(),
      completionPricePerM: z.number(),
      contextLength: z.number(),
      supportsStructuredOutputs: z.boolean(),
      supportsReasoning: z.boolean(),
    }),
  ),
});

type Cache = z.infer<typeof cacheSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** OpenRouter prices are USD per token as decimal strings; "-1" or garbage means unknown → 0. */
function pricePerMillion(perToken: unknown): number {
  const price = typeof perToken === 'string' ? Number(perToken) : perToken;
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return 0;
  return Number((price * 1_000_000).toPrecision(12)); // shed binary-float noise: 1.5e-7 → 0.15
}

function parseModel(entry: unknown): ModelInfo | undefined {
  if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '') return undefined;
  const architecture = isRecord(entry.architecture) ? entry.architecture : {};
  if (!stringList(architecture.output_modalities).includes('text')) return undefined;
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const parameters = stringList(entry.supported_parameters);
  const context = entry.context_length;
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
    promptPricePerM: pricePerMillion(pricing.prompt),
    completionPricePerM: pricePerMillion(pricing.completion),
    contextLength: typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : 0,
    supportsStructuredOutputs: parameters.includes('structured_outputs'),
    supportsReasoning: parameters.includes('reasoning'),
  };
}

/** Text-output models of a `GET /models` response; tolerant of missing or odd fields. */
export function parseModelsResponse(json: unknown): ModelInfo[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  const models: ModelInfo[] = [];
  for (const entry of json.data) {
    const model = parseModel(entry);
    if (model) models.push(model);
  }
  return models;
}

async function readCache(): Promise<Cache | undefined> {
  const stored = await browser.storage.local.get(MODELS_CACHE_KEY);
  const parsed = cacheSchema.safeParse(stored[MODELS_CACHE_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/** The catalog is public: no Authorization header, so the key never goes to /models. */
async function fetchModels(fetchFn: typeof fetch): Promise<ModelInfo[]> {
  const response = await fetchFn(`${OPENROUTER_BASE}/models`);
  if (!response.ok) throw new AiFailure(aiError('network', { status: response.status }));
  const models = parseModelsResponse(await response.json());
  // A response without a single text model is not a catalog; caching it would hide the real one for a day.
  if (models.length === 0) throw new AiFailure(aiError('network'));
  return models;
}

/**
 * The model catalog, cached in `chrome.storage.local` for 24 hours. When OpenRouter cannot be
 * reached it serves the stale cache; with no cache either it throws `AiFailure('network')`.
 */
export async function listModels(
  opts: { force?: boolean; now?: () => number; fetchFn?: typeof fetch } = {},
): Promise<ModelInfo[]> {
  const now = opts.now ?? Date.now;
  const cache = await readCache();
  if (cache && !opts.force) {
    const age = now() - cache.fetchedAt;
    if (age >= 0 && age < MODELS_CACHE_TTL_MS) return cache.models;
  }
  try {
    const models = await fetchModels(opts.fetchFn ?? fetch);
    try {
      await browser.storage.local.set({ [MODELS_CACHE_KEY]: { fetchedAt: now(), models } });
    } catch {
      // the cache is an optimisation: a failed write must not lose the catalog just fetched
    }
    return models;
  } catch (error) {
    if (cache) return cache.models;
    throw error instanceof AiFailure ? error : new AiFailure(aiError('network'));
  }
}

export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((model) => model.id === id);
}
