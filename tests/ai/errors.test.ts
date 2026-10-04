import { AiFailure, SWITCHABLE, aiError, classifyHttpError } from '../../src/ai/errors';
import type { AiErrorCode } from '../../src/ai/types';

describe('classifyHttpError', () => {
  it.each([
    [401, 'bad_key', 'Неверный ключ OpenRouter'],
    [403, 'bad_key', 'Неверный ключ OpenRouter'],
    [402, 'no_credits', 'На балансе OpenRouter закончились деньги'],
    [429, 'rate_limited', 'OpenRouter ограничил частоту запросов, попробуйте через минуту'],
    [503, 'model_unavailable', 'Модель a/b сейчас недоступна'],
    [500, 'model_unavailable', 'Модель a/b сейчас недоступна'],
    [404, 'model_unavailable', 'Модель a/b сейчас недоступна'],
  ])('%i → %s', (status, code, message) =>
    expect(classifyHttpError(status, '{}', 'a/b')).toMatchObject({ code, message, status }),
  );

  it('400 mentioning the model is model_unavailable, other 400 is unknown with detail', () => {
    expect(classifyHttpError(400, '{"error":{"message":"No such model"}}', 'a/b').code).toBe(
      'model_unavailable',
    );
    expect(classifyHttpError(400, '{"error":{"message":"Bad things"}}', 'a/b').message).toBe(
      'Ошибка OpenRouter: Bad things',
    );
  });

  it('judges a 400 by the error text, not by unrelated fields of the body', () => {
    const body = '{"error":{"message":"Bad things","metadata":{"model":"a/b"}}}';
    expect(classifyHttpError(400, body, 'a/b')).toMatchObject({ code: 'unknown', status: 400 });
  });

  it('uses the raw body as detail when it is not a JSON error', () => {
    expect(classifyHttpError(418, 'I am a teapot', 'a/b')).toMatchObject({
      code: 'unknown',
      message: 'Ошибка OpenRouter: I am a teapot',
      status: 418,
    });
    expect(classifyHttpError(418, '{"error":"flat"}', 'a/b').message).toBe(
      'Ошибка OpenRouter: {"error":"flat"}',
    );
  });

  it('carries the model on the error', () =>
    expect(classifyHttpError(401, '{}', 'a/b').model).toBe('a/b'));
});

describe('aiError', () => {
  it('has the fixed texts of the spec', () => {
    const fixed: Array<[AiErrorCode, string]> = [
      ['no_key', 'Укажите ключ OpenRouter в настройках'],
      ['no_model', 'Выберите модель в настройках'],
      ['bad_key', 'Неверный ключ OpenRouter'],
      ['no_credits', 'На балансе OpenRouter закончились деньги'],
      ['rate_limited', 'OpenRouter ограничил частоту запросов, попробуйте через минуту'],
      ['network', 'Нет связи с OpenRouter'],
      ['bad_output', 'Модель вернула ответ в неверном формате'],
      ['cancelled', 'Остановлено'],
    ];
    for (const [code, message] of fixed) expect(aiError(code)).toEqual({ code, message });
  });

  it('timeout message has seconds', () =>
    expect(aiError('timeout', { timeoutSec: 90 }).message).toBe('Модель не ответила за 90 с'));

  it('model_unavailable names the model', () =>
    expect(aiError('model_unavailable', { model: 'x/y' })).toEqual({
      code: 'model_unavailable',
      message: 'Модель x/y сейчас недоступна',
      model: 'x/y',
    }));

  it('budget messages', () => {
    expect(aiError('budget_exceeded', { period: 'day', limitUsd: 5 }).message).toBe(
      'Достигнут дневной лимит расходов ($5.00). Измените лимит в настройках',
    );
    expect(aiError('budget_exceeded', { period: 'month', limitUsd: 20 }).message).toBe(
      'Достигнут месячный лимит расходов ($20.00). Измените лимит в настройках',
    );
    expect(aiError('budget_exceeded', { period: 'day', limitUsd: 0.5 }).message).toContain('($0.50)');
    expect(SWITCHABLE.has('budget_exceeded')).toBe(false);
  });

  it('unknown shows the detail cut to 200 characters', () => {
    expect(aiError('unknown', { detail: 'boom' }).message).toBe('Ошибка OpenRouter: boom');
    const long = aiError('unknown', { detail: 'x'.repeat(500) });
    expect(long.message).toBe(`Ошибка OpenRouter: ${'x'.repeat(200)}`);
  });

  it('reads sensibly when the context is missing', () => {
    expect(aiError('model_unavailable').message).toBe('Модель сейчас недоступна');
    expect(aiError('timeout').message).toBe('Модель не ответила вовремя');
    expect(aiError('budget_exceeded').message).toBe(
      'Достигнут лимит расходов. Измените лимит в настройках',
    );
    expect(aiError('unknown').message).toBe('Ошибка OpenRouter');
  });

  it('keeps the status when given', () =>
    expect(aiError('unknown', { detail: 'x', status: 418 }).status).toBe(418));
});

describe('SWITCHABLE', () => {
  it('holds exactly the errors a fallback model can cure', () =>
    expect([...SWITCHABLE].sort()).toEqual(
      ['bad_output', 'model_unavailable', 'network', 'rate_limited', 'timeout'].sort(),
    ));

  it.each([
    'no_key',
    'no_model',
    'budget_exceeded',
    'bad_key',
    'no_credits',
    'cancelled',
    'unknown',
  ] as const)('does not switch on %s', (code) => expect(SWITCHABLE.has(code)).toBe(false));
});

describe('AiFailure', () => {
  it('wraps the error and reads like it', () => {
    const error = aiError('network');
    const failure = new AiFailure(error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.error).toBe(error);
    expect(failure.message).toBe('Нет связи с OpenRouter');
    expect(failure.name).toBe('AiFailure');
  });
});
