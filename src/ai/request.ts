import type { Settings } from '../storage/settings';
import { OPENROUTER_BASE } from './catalog';
import { aiError, classifyHttpError } from './errors';
import { readSse } from './sse';
import type { AiError, AiRequest, Usage } from './types';

export interface CallOptions {
  model: string;
  supportsReasoning: boolean;
  settings: Pick<Settings, 'openRouterKey' | 'reasoning' | 'requestTimeoutSec'>;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

export type CallResult<T> =
  | { ok: true; value: T; usage?: Usage }
  // a failed call still carries the usage OpenRouter reported for it (empty answer, error mid-stream), because it is billed
  | { ok: false; error: AiError; gotFirstToken: boolean; usage?: Usage };

/** What the combined signal's `reason` is when the request timer, not the caller, aborted. */
const TIMEOUT_REASON = Symbol('request timeout');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function buildBody(
  req: AiRequest,
  opts: {
    model: string;
    stream: boolean;
    reasoning: Settings['reasoning'];
    supportsReasoning: boolean;
    responseFormat?: object;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: req.messages,
    stream: opts.stream,
    usage: { include: true },
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (opts.reasoning !== 'off' && opts.supportsReasoning) body.reasoning = { effort: opts.reasoning };
  if (opts.responseFormat !== undefined) body.response_format = opts.responseFormat;
  return body;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function parseUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const promptTokens = finiteNumber(value.prompt_tokens);
  const completionTokens = finiteNumber(value.completion_tokens);
  const costUsd = finiteNumber(value.cost);
  if (promptTokens === undefined && completionTokens === undefined && costUsd === undefined) return undefined;
  const usage: Usage = { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 };
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

/** An OpenRouter `{ error: { code, message } }` object (mid-stream chunk or a 200 body). */
function parseErrorObject(chunk: Record<string, unknown>, model: string): AiError | undefined {
  const { error } = chunk;
  if (!isRecord(error)) return undefined;
  const message = typeof error.message === 'string' ? error.message : '';
  const { code } = error;
  if (typeof code === 'number') return classifyHttpError(code, message, model);
  return aiError('unknown', { model, detail: message });
}

function firstChoice(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  const { choices } = chunk;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  return isRecord(choice) ? choice : undefined;
}

/** `choices[0].<part>.content` where `part` is `delta` (stream) or `message` (complete response). */
function contentOf(chunk: Record<string, unknown>, part: 'delta' | 'message'): string {
  const holder = firstChoice(chunk)?.[part];
  const content = isRecord(holder) ? holder.content : undefined;
  return typeof content === 'string' ? content : '';
}

/** Progress of one call that the failure path needs: has the user already seen text? */
interface Attempt {
  gotFirstToken: boolean;
}

type Consume = (response: Response, attempt: Attempt) => Promise<CallResult<string>>;

/**
 * One POST to `/chat/completions`. The timeout and `opts.signal` / `req.signal` share a single
 * signal that is handed to `fetch`, so it also stops a body that is still being read. A thrown
 * error is a timeout or cancel when that signal fired, and a lost connection otherwise.
 */
async function send(
  req: AiRequest,
  opts: CallOptions,
  body: Record<string, unknown>,
  consume: Consume,
): Promise<CallResult<string>> {
  const { model } = opts;
  const timeoutSec = opts.settings.requestTimeoutSec;
  const fetchFn = opts.fetchFn ?? fetch; // a local, so the browser's fetch is not called as a method
  const attempt: Attempt = { gotFirstToken: false };
  const fail = (error: AiError): CallResult<string> => failure(error, attempt);

  const timeout = new AbortController();
  const signals = [timeout.signal];
  if (opts.signal) signals.push(opts.signal);
  if (req.signal) signals.push(req.signal);
  const signal = AbortSignal.any(signals);
  const abortFailure = (): CallResult<string> =>
    fail(
      signal.reason === TIMEOUT_REASON
        ? aiError('timeout', { model, timeoutSec })
        : aiError('cancelled', { model }),
    );

  if (signal.aborted) return abortFailure();
  const timer = setTimeout(() => timeout.abort(TIMEOUT_REASON), timeoutSec * 1000);
  try {
    const response = await fetchFn(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.settings.openRouterKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'threadscombine',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return signal.aborted ? abortFailure() : fail(classifyHttpError(response.status, text, model));
    }
    return await consume(response, attempt);
  } catch {
    return signal.aborted ? abortFailure() : fail(aiError('network', { model }));
  } finally {
    clearTimeout(timer);
  }
}

function failure(error: AiError, attempt: Attempt, usage?: Usage): CallResult<string> {
  const result: CallResult<string> = { ok: false, error, gotFirstToken: attempt.gotFirstToken };
  if (usage) result.usage = usage;
  return result;
}

function finish(text: string, usage: Usage | undefined, model: string, attempt: Attempt): CallResult<string> {
  if (text === '') return failure(aiError('model_unavailable', { model }), attempt, usage);
  return usage ? { ok: true, value: text, usage } : { ok: true, value: text };
}

/** Streams the answer: every non-empty `delta.content` goes to `onDelta` as it arrives. */
export async function callStream(
  req: AiRequest,
  opts: CallOptions,
  onDelta: (chunk: string) => void,
): Promise<CallResult<string>> {
  const { model } = opts;
  const body = buildBody(req, {
    model,
    stream: true,
    reasoning: opts.settings.reasoning,
    supportsReasoning: opts.supportsReasoning,
  });
  return send(req, opts, body, async (response, attempt) => {
    if (!response.body) return finish('', undefined, model, attempt);
    let text = '';
    let usage: Usage | undefined;
    // leaving the loop early (an error chunk) makes readSse cancel the body
    for await (const data of readSse(response.body)) {
      const chunk = parseJson(data);
      if (!isRecord(chunk)) continue;
      const error = parseErrorObject(chunk, model);
      if (error) return failure(error, attempt, usage);
      const delta = contentOf(chunk, 'delta');
      if (delta !== '') {
        attempt.gotFirstToken = true;
        text += delta;
        onDelta(delta);
      }
      usage = parseUsage(chunk.usage) ?? usage;
    }
    return finish(text, usage, model, attempt);
  });
}

/** One non-streaming request; `responseFormat` goes into the body as `response_format`. */
export async function callComplete(
  req: AiRequest,
  opts: CallOptions & { responseFormat?: object },
): Promise<CallResult<string>> {
  const { model } = opts;
  const body = buildBody(req, {
    model,
    stream: false,
    reasoning: opts.settings.reasoning,
    supportsReasoning: opts.supportsReasoning,
    ...(opts.responseFormat !== undefined && { responseFormat: opts.responseFormat }),
  });
  return send(req, opts, body, async (response, attempt) => {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return finish('', undefined, model, attempt);
    const error = parseErrorObject(payload, model);
    if (error) return { ok: false, error, gotFirstToken: false };
    return finish(contentOf(payload, 'message'), parseUsage(payload.usage), model, attempt);
  });
}
