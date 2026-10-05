import type { AiError, AiErrorCode } from './types';

const MAX_DETAIL_LENGTH = 200;

export interface AiErrorContext {
  model?: string;
  timeoutSec?: number;
  status?: number;
  detail?: string;
  period?: 'day' | 'month';
  limitUsd?: number;
}

function budgetMessage({ period, limitUsd }: AiErrorContext): string {
  const tail = 'Измените лимит в настройках';
  if (period === undefined || limitUsd === undefined) return `Достигнут лимит расходов. ${tail}`;
  const label = period === 'day' ? 'дневной' : 'месячный';
  return `Достигнут ${label} лимит расходов ($${limitUsd.toFixed(2)}). ${tail}`;
}

function messageFor(code: AiErrorCode, ctx: AiErrorContext): string {
  switch (code) {
    case 'no_key':
      return 'Укажите ключ OpenRouter в настройках';
    case 'no_model':
      return 'Выберите модель в настройках';
    case 'budget_exceeded':
      return budgetMessage(ctx);
    case 'bad_key':
      return 'Неверный ключ OpenRouter';
    case 'no_credits':
      return 'На балансе OpenRouter закончились деньги';
    case 'rate_limited':
      return 'OpenRouter ограничил частоту запросов, попробуйте через минуту';
    case 'model_unavailable':
      return ctx.model === undefined ? 'Модель сейчас недоступна' : `Модель ${ctx.model} сейчас недоступна`;
    case 'timeout':
      return ctx.timeoutSec === undefined
        ? 'Модель не ответила вовремя'
        : `Модель не ответила за ${ctx.timeoutSec} с`;
    case 'network':
      return 'Нет связи с OpenRouter';
    case 'bad_output':
      return 'Модель вернула ответ в неверном формате';
    case 'cancelled':
      return 'Остановлено';
    case 'unknown':
      return ctx.detail
        ? `Ошибка OpenRouter: ${ctx.detail.slice(0, MAX_DETAIL_LENGTH)}`
        : 'Ошибка OpenRouter';
  }
}

/** Builds an error with its Russian text. The request key never takes part in a message. */
export function aiError(code: AiErrorCode, ctx: AiErrorContext = {}): AiError {
  const error: AiError = { code, message: messageFor(code, ctx) };
  if (ctx.status !== undefined) error.status = ctx.status;
  if (ctx.model !== undefined) error.model = ctx.model;
  return error;
}

/** `error.message` of an OpenRouter JSON error body, otherwise the body itself. */
function errorDetail(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const { error } = parsed;
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const { message } = error;
        if (typeof message === 'string' && message !== '') return message;
      }
    }
  } catch {
    // not JSON — the body itself is the detail
  }
  return bodyText;
}

export function classifyHttpError(status: number, bodyText: string, model: string): AiError {
  const detail = errorDetail(bodyText);
  const ctx = { model, status, detail };
  if (status === 401 || status === 403) return aiError('bad_key', ctx);
  if (status === 402) return aiError('no_credits', ctx);
  if (status === 429) return aiError('rate_limited', ctx);
  if (status === 404) return aiError('model_unavailable', ctx);
  if (status === 400 && /model/i.test(detail)) return aiError('model_unavailable', ctx);
  if (status >= 500) return aiError('model_unavailable', ctx);
  return aiError('unknown', ctx);
}

/** Errors a fallback model can cure; everything else ends the chain at once. */
export const SWITCHABLE: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'rate_limited',
  'model_unavailable',
  'timeout',
  'network',
  'bad_output',
]);

export class AiFailure extends Error {
  readonly error: AiError;

  constructor(error: AiError) {
    super(error.message);
    this.name = 'AiFailure';
    this.error = error;
  }
}
