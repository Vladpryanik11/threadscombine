import { z } from 'zod';
import { getActiveAccount } from '../storage/accounts';
import { log } from '../storage/journal';
import { getSettings, type Settings } from '../storage/settings';
import { checkBudget, computeCostUsd, recordSpend } from '../storage/spend';
import { findModel, listModels as fetchModels } from './catalog';
import { SWITCHABLE, aiError } from './errors';
import { extractJson } from './json';
import { callComplete, callStream, type CallOptions, type CallResult } from './request';
import type { AiError, AiRequest, AiResult, ChatMessage, ModelInfo, Usage } from './types';

export { listModels } from './catalog';
export { AiFailure } from './errors';
export type * from './types';

/** Everything the facade reads from the outside; each part can be replaced in tests. */
export interface AiDeps {
  getSettings?: () => Promise<Settings>;
  listModels?: () => Promise<ModelInfo[]>;
  getActiveAccountId?: () => Promise<string>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** A request must never wait for the model catalog longer than this. */
const CATALOG_TIMEOUT_MS = 5_000;
/** The key check is the one request that is allowed to go over the spend limits. */
const KEY_CHECK_PURPOSE = 'key-check';
const MAX_ISSUES = 5;
const MAX_ISSUES_LENGTH = 500;

const SCHEMA_INSTRUCTION = 'Ответь только JSON по этой схеме, без пояснений:';

/** The main model followed by the fallbacks, when they are enabled. */
export function modelChain(s: Settings): string[] {
  return [s.model, ...(s.fallbackEnabled ? s.fallbackModels : [])];
}

// ------------------------------------------------------------------ one call

/** What a request needs, fixed when it starts: the settings, catalog and account do not change midway. */
interface Run {
  req: AiRequest;
  settings: Settings;
  catalog: ModelInfo[] | undefined;
  accountId: string;
  fetchFn: typeof fetch | undefined;
  now: () => number;
}

/** One model of the chain, with what the catalog says about it (nothing when it is not there). */
interface Attempt {
  run: Run;
  model: string;
  info: ModelInfo | undefined;
}

type Prepared = { ok: true; run: Run } | { ok: false; error: AiError };

/** A failed read of the limits must not stop the owner from working: the request goes ahead. */
function checkLimits(settings: Settings, now: () => number): ReturnType<typeof checkBudget> {
  return checkBudget(settings, now()).catch(async (error: unknown) => {
    await log('error', 'spend', 'Не удалось проверить лимиты расходов, запрос отправлен', { error });
    return null;
  });
}

/** The catalog, or `undefined` when it fails or does not answer in time: then no model has any capability. */
async function loadCatalog(purpose: string, deps: AiDeps): Promise<ModelInfo[] | undefined> {
  const list = deps.listModels ?? (() => fetchModels(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), CATALOG_TIMEOUT_MS);
  });
  try {
    // the async wrapper turns a synchronous throw into a rejection; a rejection after the timeout is still handled by the race
    const models = await Promise.race([(async () => list())(), timedOut]);
    if (models) return models;
  } catch {
    // reported below, the same as a timeout
  } finally {
    clearTimeout(timer);
  }
  await log('warn', 'ai', `${purpose}: каталог моделей недоступен`);
  return undefined;
}

const defaultAccountId = async (): Promise<string> => (await getActiveAccount()).id;

/** Without a readable account the spend is still recorded (and counted by the limits), just not attributed. */
async function loadAccountId(deps: AiDeps): Promise<string> {
  try {
    return await (deps.getActiveAccountId ?? defaultAccountId)();
  } catch (error) {
    await log('error', 'spend', 'Не удалось определить активный аккаунт, расход запишется без него', { error });
    return '';
  }
}

/** The checks that refuse a request before anything is sent, then everything the request needs. */
async function prepare(req: AiRequest, deps: AiDeps, now: () => number): Promise<Prepared> {
  const settings = await (deps.getSettings ?? getSettings)();
  if (settings.openRouterKey === '') return { ok: false, error: aiError('no_key') };
  if (settings.model === '') return { ok: false, error: aiError('no_model') };
  if (req.purpose !== KEY_CHECK_PURPOSE) {
    const exceeded = await checkLimits(settings, now);
    if (exceeded) return { ok: false, error: aiError('budget_exceeded', exceeded) };
  }
  const catalog = await loadCatalog(req.purpose, deps);
  const accountId = await loadAccountId(deps);
  return { ok: true, run: { req, settings, catalog, accountId, fetchFn: deps.fetchFn, now } };
}

function callOptions({ run, model, info }: Attempt): CallOptions {
  return {
    model,
    supportsReasoning: info?.supportsReasoning ?? false,
    settings: run.settings,
    fetchFn: run.fetchFn,
  };
}

/** A billed call is a spend, whether or not its answer was any good. */
async function trackSpend(attempt: Attempt, result: CallResult<string>): Promise<CallResult<string>> {
  const { usage } = result;
  if (usage) {
    const { run, model, info } = attempt;
    await recordSpend({
      ts: run.now(),
      accountId: run.accountId,
      purpose: run.req.purpose,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: computeCostUsd(usage, info),
    });
  }
  return result;
}

async function fail(purpose: string, error: AiError): Promise<AiResult<never>> {
  // pressing «Стоп» is not a fault, so it does not go to the journal as one
  await log(error.code === 'cancelled' ? 'info' : 'error', 'ai', `${purpose}: ${error.message}`);
  return { ok: false, error };
}

/**
 * Runs `call` on the models of the chain in turn. A switchable error moves on to the next model,
 * unless the user has already been shown text; any other error, or the last model failing, ends the chain.
 */
async function runChain<T>(
  req: AiRequest,
  deps: AiDeps,
  call: (attempt: Attempt) => Promise<CallResult<T>>,
): Promise<AiResult<T>> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const prepared = await prepare(req, deps, now);
  if (!prepared.ok) return fail(req.purpose, prepared.error);

  const { run } = prepared;
  const chain = modelChain(run.settings);
  const switchedFrom: string[] = [];
  for (const [index, model] of chain.entries()) {
    const info = run.catalog && findModel(run.catalog, model);
    const result = await call({ run, model, info });
    if (result.ok) {
      const usage: Usage | undefined = result.usage && {
        ...result.usage,
        costUsd: computeCostUsd(result.usage, info),
      };
      return {
        ok: true,
        value: result.value,
        model,
        ...(usage && { usage }),
        switchedFrom,
        elapsedMs: now() - startedAt,
      };
    }
    const { error } = result;
    const canSwitch = index < chain.length - 1 && !result.gotFirstToken && SWITCHABLE.has(error.code);
    if (!canSwitch) return fail(req.purpose, error);
    switchedFrom.push(model);
    await log('warn', 'ai', `${req.purpose}: ${model} → ${error.code}`);
  }
  return fail(req.purpose, aiError('no_model')); // not reached: the chain always has the main model
}

// ---------------------------------------------------------------- streamText

/** A UI handler that throws must not look like a broken connection to the stream; the first failure is journaled. */
function guardDelta(purpose: string, onDelta: (chunk: string) => void): (chunk: string) => void {
  let reported = false;
  return (chunk) => {
    try {
      onDelta(chunk);
    } catch (error) {
      if (reported) return;
      reported = true;
      void log('error', 'ai', `${purpose}: ошибка в обработчике потока`, { error });
    }
  };
}

export function streamText(
  req: AiRequest,
  onDelta: (chunk: string) => void,
  deps: AiDeps = {},
): Promise<AiResult<string>> {
  const guarded = guardDelta(req.purpose, onDelta);
  return runChain(req, deps, async (attempt) =>
    trackSpend(attempt, await callStream(req, callOptions(attempt), guarded)),
  );
}

// -------------------------------------------------------------- generateJson

type Parsed<T> = { ok: true; value: T } | { ok: false; issues: string };

function describeIssues(error: z.ZodError): string {
  const shown = error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.map(String).join('.') || 'ответ'}: ${issue.message}`);
  if (error.issues.length > MAX_ISSUES) shown.push(`и ещё ${error.issues.length - MAX_ISSUES}`);
  return shown.join('; ').slice(0, MAX_ISSUES_LENGTH);
}

function parseAnswer<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  let data: unknown;
  try {
    data = extractJson(text);
  } catch {
    return { ok: false, issues: 'ответ не является корректным JSON' };
  }
  const result = schema.safeParse(data);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: describeIssues(result.error) };
}

/** The schema goes to the end of the system message, or into a new first one when there is none. */
function withSchemaPrompt(messages: ChatMessage[], jsonSchema: object): ChatMessage[] {
  const instruction = `${SCHEMA_INSTRUCTION}\n${JSON.stringify(jsonSchema)}`;
  const at = messages.findIndex((message) => message.role === 'system');
  if (at === -1) return [{ role: 'system', content: instruction }, ...messages];
  return messages.map((message, i) =>
    i === at ? { ...message, content: `${message.content}\n\n${instruction}` } : message,
  );
}

const answered = <T>(value: T, usage: Usage | undefined): CallResult<T> =>
  usage ? { ok: true, value, usage } : { ok: true, value };

/**
 * One model's try at a JSON answer: the request, then — if the answer does not pass the schema —
 * one more request to the same model that shows it its own answer and the problems found.
 */
async function askForJson<T>(
  attempt: Attempt,
  schema: z.ZodType<T>,
  schemaName: string,
  jsonSchema: object,
): Promise<CallResult<T>> {
  const { req } = attempt.run;
  const structured = attempt.info?.supportsStructuredOutputs === true;
  const options = {
    ...callOptions(attempt),
    ...(structured && {
      responseFormat: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: jsonSchema } },
    }),
  };
  const messages = structured ? req.messages : withSchemaPrompt(req.messages, jsonSchema);
  const ask = async (asked: ChatMessage[]): Promise<CallResult<string>> =>
    trackSpend(attempt, await callComplete({ ...req, messages: asked }, options));

  const first = await ask(messages);
  if (!first.ok) return first;
  const parsed = parseAnswer(first.value, schema);
  if (parsed.ok) return answered(parsed.value, first.usage);

  const second = await ask([
    ...messages,
    { role: 'assistant', content: first.value },
    {
      role: 'user',
      content: `Исправь формат ответа. Ошибки проверки: ${parsed.issues}. Верни только JSON.`,
    },
  ]);
  if (!second.ok) return second;
  const reparsed = parseAnswer(second.value, schema);
  if (reparsed.ok) return answered(reparsed.value, second.usage);
  return { ok: false, error: aiError('bad_output', { model: attempt.model }), gotFirstToken: false };
}

export async function generateJson<T>(
  req: AiRequest,
  schema: z.ZodType<T>,
  schemaName: string,
  deps: AiDeps = {},
): Promise<AiResult<T>> {
  const jsonSchema = z.toJSONSchema(schema);
  return runChain(req, deps, (attempt) => askForJson(attempt, schema, schemaName, jsonSchema));
}
