import { db } from '../../src/storage/db';
import {
  JOURNAL_LIMIT,
  clearJournal,
  formatJournal,
  listJournal,
  log,
  redactSecrets,
} from '../../src/storage/journal';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('database', () => {
  it('creates all core tables', () =>
    expect(db.tables.map((t) => t.name).sort()).toEqual(['accounts', 'journal', 'spend']));
});

describe('log / listJournal', () => {
  it('keeps only the newest 500 entries', async () => {
    for (let i = 0; i < 505; i++) await log('info', 'test', `m${i}`);
    const all = await listJournal(1000);
    expect(all).toHaveLength(500);
    expect(all[0]!.message).toBe('m504');
    expect(all.at(-1)!.message).toBe('m5');
  });

  it('lists newest first and honours the limit', async () => {
    await log('info', 'a', 'first');
    await log('warn', 'b', 'second');
    await log('error', 'c', 'third');
    const two = await listJournal(2);
    expect(two.map((e) => e.message)).toEqual(['third', 'second']);
    expect(two[0]).toMatchObject({ level: 'error', area: 'c' });
    expect(typeof two[0]!.ts).toBe('number');
    expect(await listJournal()).toHaveLength(3);
  });

  it('clears the journal', async () => {
    await log('info', 'a', 'x');
    await clearJournal();
    expect(await listJournal()).toEqual([]);
  });

  it('masks OpenRouter keys in message and details', async () => {
    await log('error', 'ai', 'bad sk-or-v1-abc123', { header: 'Bearer sk-or-v1-abc123' });
    const [e] = await listJournal(1);
    expect(JSON.stringify(e)).not.toContain('abc123');
    expect(e!.message).toBe('bad sk-or-***');
    expect(e!.details).toEqual({ header: 'Bearer sk-or-***' });
  });

  it('stores details as plain data and omits them when absent', async () => {
    await log('info', 'a', 'with', { n: 1, list: ['x'] });
    await log('info', 'a', 'without');
    const [without, withDetails] = await listJournal(2);
    expect(withDetails!.details).toEqual({ n: 1, list: ['x'] });
    expect(without).not.toHaveProperty('details');
  });

  it('serializes circular, error and bigint details without throwing', async () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    await log('warn', 'a', 'circular', circular);
    await log('warn', 'a', 'error', new Error('boom sk-or-v1-secret'));
    await log('warn', 'a', 'bigint', { big: 10n });
    const [big, err, circ] = await listJournal(3);
    expect(circ!.details).toEqual({ name: 'loop', self: '[Circular]' });
    expect(err!.details).toEqual({ name: 'Error', message: 'boom sk-or-***' });
    expect(big!.details).toEqual({ big: '10' });
  });

  it('keeps the entry when details are merely shared, not circular', async () => {
    const shared = { v: 1 };
    await log('info', 'a', 'shared', { a: shared, b: shared });
    const [e] = await listJournal(1);
    expect(e!.details).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('still writes the message when details cannot be serialized', async () => {
    const hostile = {
      toJSON() {
        throw new Error('nope');
      },
    };
    await expect(log('error', 'a', 'kept', hostile)).resolves.toBeUndefined();
    const [e] = await listJournal(1);
    expect(e!.message).toBe('kept');
    expect(e).not.toHaveProperty('details');
  });

  it('never throws even if the db write fails', async () => {
    vi.spyOn(db.journal, 'add').mockRejectedValue(new Error('quota'));
    await expect(log('info', 'x', 'y')).resolves.toBeUndefined();
  });

  it('never throws even if trimming fails', async () => {
    vi.spyOn(db.journal, 'toCollection').mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(log('info', 'x', 'y')).resolves.toBeUndefined();
    vi.restoreAllMocks();
    expect((await listJournal(1))[0]!.message).toBe('y');
  });

  it('never throws on a non-string message', async () => {
    await expect(log('info', 'x', undefined as unknown as string)).resolves.toBeUndefined();
  });

  it('exposes the journal limit', () => expect(JOURNAL_LIMIT).toBe(500));
});

describe('redactSecrets', () => {
  it('masks every OpenRouter key and leaves other text alone', () => {
    expect(redactSecrets('a sk-or-v1-AbC_9-x and sk-or-v1-zzz!')).toBe('a sk-or-*** and sk-or-***!');
    expect(redactSecrets('sk-other-123 and plain')).toBe('sk-other-123 and plain');
  });
});

describe('formatJournal', () => {
  it('formats entries for copying', () => {
    const ts = new Date(2026, 9, 4, 12, 0, 5).getTime();
    expect(formatJournal([{ ts, level: 'error', area: 'ai', message: 'boom' }])).toBe(
      '2026-10-04 12:00:05 [error] ai: boom',
    );
  });

  it('puts details as JSON on the same line, one line per entry', () => {
    const a = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const b = new Date(2026, 11, 31, 23, 59, 59).getTime();
    expect(
      formatJournal([
        { ts: b, level: 'warn', area: 'sync', message: 'second', details: { code: 7 } },
        { ts: a, level: 'info', area: 'ui', message: 'first' },
      ]),
    ).toBe(
      '2026-12-31 23:59:59 [warn] sync: second {"code":7}\n2026-01-02 03:04:05 [info] ui: first',
    );
  });

  it('returns an empty string for no entries', () => expect(formatJournal([])).toBe(''));
});
