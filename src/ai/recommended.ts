import type { ModelInfo } from './types';

/** Starting list; shown first in the picker, but only when the live catalog has the model. */
export const RECOMMENDED_MODEL_IDS = [
  'deepseek/deepseek-v4.1-flash',
  'openai/gpt-6-luna',
  'qwen/qwen3.8-flash',
] as const;

export function sortModelsForPicker(models: ModelInfo[]): Array<ModelInfo & { recommended: boolean }> {
  const recommended: Array<ModelInfo & { recommended: boolean }> = [];
  for (const id of RECOMMENDED_MODEL_IDS) {
    const model = models.find((m) => m.id === id);
    if (model) recommended.push({ ...model, recommended: true });
  }
  const rest = models
    .filter((m) => !(RECOMMENDED_MODEL_IDS as readonly string[]).includes(m.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ ...m, recommended: false }));
  return [...recommended, ...rest];
}
