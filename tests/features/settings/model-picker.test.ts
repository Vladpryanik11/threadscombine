import {
  fallbackCandidates,
  filterModels,
  missingModelLabel,
  modelOptionLabel,
} from '../../../src/features/settings/model-picker';
import type { ModelInfo } from '../../../src/ai';

const model = (id: string, name: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name,
  promptPricePerM: 0,
  completionPricePerM: 0,
  contextLength: 1000,
  supportsStructuredOutputs: false,
  supportsReasoning: false,
  ...extra,
});

const CATALOG = [
  model('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
  model('openai/gpt-6-luna', 'GPT-6 Luna'),
  model('qwen/qwen3.8-flash', 'Qwen3.8 Flash'),
  model('meta/llama', 'Llama'),
];

describe('filterModels', () => {
  it('filters by id or name case-insensitively', () => {
    expect(filterModels(CATALOG, 'DEEP').map((m) => m.id)).toEqual(['deepseek/deepseek-v4.1-flash']);
    expect(filterModels(CATALOG, 'luna').map((m) => m.id)).toEqual(['openai/gpt-6-luna']); // by name
    expect(filterModels(CATALOG, 'QWEN/').map((m) => m.id)).toEqual(['qwen/qwen3.8-flash']); // by id
    expect(filterModels(CATALOG, 'flash').map((m) => m.id)).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'qwen/qwen3.8-flash',
    ]);
  });

  it('keeps every model for an empty or blank query', () => {
    expect(filterModels(CATALOG, '')).toEqual(CATALOG);
    expect(filterModels(CATALOG, '   ')).toEqual(CATALOG);
  });

  it('returns nothing when nothing matches and keeps extra fields of the models', () => {
    expect(filterModels(CATALOG, 'zzz')).toEqual([]);
    const marked = [{ ...CATALOG[0]!, recommended: true }];
    expect(filterModels(marked, 'deep')[0]?.recommended).toBe(true);
  });
});

describe('modelOptionLabel', () => {
  it('labels options with prices and the recommended mark', () =>
    expect(
      modelOptionLabel({
        ...model('openai/gpt-6-luna', 'GPT-6 Luna'),
        name: 'GPT-6 Luna',
        promptPricePerM: 0.1,
        completionPricePerM: 0.5,
        recommended: true,
      }),
    ).toBe('GPT-6 Luna — $0.1 / $0.5 за 1M · рекомендуем'));

  it('has no mark for other models', () => {
    const plain = model('a/b', 'Alpha', { promptPricePerM: 2, completionPricePerM: 8 });
    expect(modelOptionLabel(plain)).toBe('Alpha — $2 / $8 за 1M');
    expect(modelOptionLabel({ ...plain, recommended: false })).toBe('Alpha — $2 / $8 за 1M');
  });
});

describe('missingModelLabel', () => {
  it('names the id and says it is not in the catalog', () =>
    expect(missingModelLabel('gone/model')).toBe('gone/model (нет в каталоге)'));
});

describe('fallbackCandidates', () => {
  it('excludes the main model and the other fallback', () => {
    const ids = (models: ModelInfo[]) => models.map((m) => m.id);
    expect(ids(fallbackCandidates(CATALOG, 'openai/gpt-6-luna'))).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'qwen/qwen3.8-flash',
      'meta/llama',
    ]);
    expect(ids(fallbackCandidates(CATALOG, 'openai/gpt-6-luna', 'meta/llama'))).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'qwen/qwen3.8-flash',
    ]);
  });

  it('offers the whole catalog when nothing is chosen yet', () => {
    expect(fallbackCandidates(CATALOG, '', undefined)).toEqual(CATALOG);
    expect(fallbackCandidates(CATALOG, '', '')).toEqual(CATALOG);
  });
});
