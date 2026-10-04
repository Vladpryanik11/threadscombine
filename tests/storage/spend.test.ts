import { db, type SpendRecord } from '../../src/storage/db';
import { listJournal } from '../../src/storage/journal';
import {
  checkBudget,
  computeCostUsd,
  dayStart,
  monthStart,
  recordSpend,
  spendSummary,
} from '../../src/storage/spend';
import type { ModelInfo } from '../../src/ai/types';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const rec = (over: Partial<Omit<SpendRecord, 'id'>> = {}): Omit<SpendRecord, 'id'> => ({
  ts: new Date(2026, 9, 4, 9).getTime(),
  accountId: 'A',
  purpose: 'virality',
  model: 'm/x',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.01,
  ...over,
});

describe('computeCostUsd', () => {
  it('uses OpenRouter cost when present, otherwise catalog prices, otherwise zero', () => {
    const m = { promptPricePerM: 0.15, completionPricePerM: 0.6 } as ModelInfo;
    expect(computeCostUsd({ promptTokens: 1000, completionTokens: 1000, costUsd: 0.5 }, m)).toBe(0.5);
    expect(computeCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, m)).toBeCloseTo(0.75);
    expect(computeCostUsd({ promptTokens: 10, completionTokens: 10 })).toBe(0);
  });

  it('trusts a reported cost of zero (free model) over catalog prices', () => {
    const m = { promptPricePerM: 0.15, completionPricePerM: 0.6 } as ModelInfo;
    expect(computeCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000, costUsd: 0 }, m)).toBe(0);
  });

  it('ignores a reported cost that is not a finite number', () => {
    const m = { promptPricePerM: 1, completionPricePerM: 2 } as ModelInfo;
    expect(computeCostUsd({ promptTokens: 1_000_000, completionTokens: 0, costUsd: Number.NaN }, m)).toBe(1);
    expect(computeCostUsd({ promptTokens: 5, completionTokens: 5, costUsd: Number.NaN })).toBe(0);
  });
});

describe('dayStart / monthStart', () => {
  it('return the start of the local day and of the calendar month', () => {
    const now = new Date(2026, 9, 4, 15, 30, 12, 500).getTime();
    expect(dayStart(now)).toBe(new Date(2026, 9, 4).getTime());
    expect(monthStart(now)).toBe(new Date(2026, 9, 1).getTime());
  });

  it('are idempotent on their own result', () => {
    const d = new Date(2026, 0, 1).getTime();
    expect(dayStart(d)).toBe(d);
    expect(monthStart(d)).toBe(d);
  });
});

describe('spendSummary', () => {
  it('splits today and month by local calendar', async () => {
    const now = new Date(2026, 9, 4, 10).getTime();
    await recordSpend(rec({ ts: new Date(2026, 9, 4, 0, 1).getTime(), costUsd: 1, purpose: 'a', accountId: 'A' }));
    await recordSpend(rec({ ts: new Date(2026, 9, 3, 23, 59).getTime(), costUsd: 2, purpose: 'b', accountId: 'B' }));
    await recordSpend(rec({ ts: new Date(2026, 8, 30, 12).getTime(), costUsd: 4, purpose: 'a', accountId: 'A' }));
    expect(await spendSummary(now)).toEqual({
      todayUsd: 1,
      monthUsd: 3,
      byPurpose: [{ purpose: 'b', usd: 2 }, { purpose: 'a', usd: 1 }],
      byAccount: [{ accountId: 'B', usd: 2 }, { accountId: 'A', usd: 1 }],
    });
  });

  it('is all zeros and empty lists when nothing was spent', async () => {
    expect(await spendSummary(new Date(2026, 9, 4, 10).getTime())).toEqual({
      todayUsd: 0,
      monthUsd: 0,
      byPurpose: [],
      byAccount: [],
    });
  });

  it('sums without floating-point drift', async () => {
    const now = new Date(2026, 9, 4, 10).getTime();
    await recordSpend(rec({ costUsd: 0.1 }));
    await recordSpend(rec({ costUsd: 0.2 }));
    await recordSpend(rec({ costUsd: 0.000015 }));
    const s = await spendSummary(now);
    expect(s.todayUsd).toBe(0.300015);
    expect(s.monthUsd).toBe(0.300015);
    expect(s.byPurpose).toEqual([{ purpose: 'virality', usd: 0.300015 }]);
  });

  it('sorts lists by amount descending and covers all accounts', async () => {
    const now = new Date(2026, 9, 4, 10).getTime();
    await recordSpend(rec({ purpose: 'p1', accountId: 'A', costUsd: 1 }));
    await recordSpend(rec({ purpose: 'p2', accountId: 'B', costUsd: 3 }));
    await recordSpend(rec({ purpose: 'p3', accountId: 'C', costUsd: 2 }));
    await recordSpend(rec({ purpose: 'p2', accountId: 'A', costUsd: 1 }));
    const s = await spendSummary(now);
    expect(s.byPurpose).toEqual([
      { purpose: 'p2', usd: 4 },
      { purpose: 'p3', usd: 2 },
      { purpose: 'p1', usd: 1 },
    ]);
    expect(s.byAccount).toEqual([
      { accountId: 'B', usd: 3 },
      { accountId: 'A', usd: 2 },
      { accountId: 'C', usd: 2 },
    ]);
    expect(s.monthUsd).toBe(7);
  });

  it('ignores records after the end of the month of `now`', async () => {
    const now = new Date(2026, 9, 4, 10).getTime();
    await recordSpend(rec({ ts: new Date(2026, 10, 1, 0, 0).getTime(), costUsd: 5 }));
    await recordSpend(rec({ ts: new Date(2026, 9, 31, 23, 59).getTime(), costUsd: 1 }));
    const s = await spendSummary(now);
    expect(s.monthUsd).toBe(1);
    expect(s.todayUsd).toBe(0);
  });

  it('defaults `now` to the current time', async () => {
    await recordSpend(rec({ ts: Date.now(), costUsd: 0.5 }));
    expect((await spendSummary()).todayUsd).toBe(0.5);
  });
});

describe('checkBudget', () => {
  const now = new Date(2026, 9, 4, 10).getTime();

  beforeEach(async () => {
    await recordSpend(rec({ costUsd: 3 }));
  });

  it('checks the daily limit before the monthly one', async () => {
    expect(await checkBudget({ dailyBudgetUsd: 3, monthlyBudgetUsd: 2 }, now)).toEqual({
      period: 'day',
      limitUsd: 3,
    });
    expect(await checkBudget({ dailyBudgetUsd: null, monthlyBudgetUsd: 2 }, now)).toEqual({
      period: 'month',
      limitUsd: 2,
    });
    expect(await checkBudget({ dailyBudgetUsd: 5, monthlyBudgetUsd: null }, now)).toBeNull();
  });

  it('is reached at exactly the limit and not below it', async () => {
    expect(await checkBudget({ dailyBudgetUsd: 3, monthlyBudgetUsd: null }, now)).not.toBeNull();
    expect(await checkBudget({ dailyBudgetUsd: 3.01, monthlyBudgetUsd: null }, now)).toBeNull();
  });

  it('falls through to the month when only the month limit is reached', async () => {
    await recordSpend(rec({ ts: new Date(2026, 9, 1, 12).getTime(), costUsd: 4 }));
    expect(await checkBudget({ dailyBudgetUsd: 5, monthlyBudgetUsd: 7 }, now)).toEqual({
      period: 'month',
      limitUsd: 7,
    });
  });

  it('is null without limits', async () => {
    expect(await checkBudget({ dailyBudgetUsd: null, monthlyBudgetUsd: null }, now)).toBeNull();
  });

  it('is not fooled by float drift at the limit', async () => {
    await db.spend.clear();
    await recordSpend(rec({ costUsd: 0.1 }));
    await recordSpend(rec({ costUsd: 0.2 }));
    expect(await checkBudget({ dailyBudgetUsd: 0.3, monthlyBudgetUsd: null }, now)).toEqual({
      period: 'day',
      limitUsd: 0.3,
    });
  });

  it('counts spending of all accounts together', async () => {
    await db.spend.clear();
    await recordSpend(rec({ accountId: 'A', costUsd: 1 }));
    await recordSpend(rec({ accountId: 'B', costUsd: 1 }));
    expect(await checkBudget({ dailyBudgetUsd: 2, monthlyBudgetUsd: null }, now)).toEqual({
      period: 'day',
      limitUsd: 2,
    });
  });

  it('defaults `now` to the current time', async () => {
    await db.spend.clear();
    await recordSpend(rec({ ts: Date.now(), costUsd: 2 }));
    expect(await checkBudget({ dailyBudgetUsd: 2, monthlyBudgetUsd: null })).toEqual({
      period: 'day',
      limitUsd: 2,
    });
  });
});

describe('recordSpend', () => {
  it('stores the record as given', async () => {
    const r = rec({ costUsd: 0.25, model: 'a/b', promptTokens: 7, completionTokens: 3 });
    await recordSpend(r);
    expect(await db.spend.toArray()).toEqual([{ ...r, id: 1 }]);
  });

  it('never throws; the failure goes to the journal without key material', async () => {
    vi.spyOn(db.spend, 'add').mockRejectedValue(new Error('disk is full'));
    await expect(recordSpend(rec())).resolves.toBeUndefined();
    const [entry] = await listJournal(1);
    expect(entry).toMatchObject({ level: 'error', area: 'spend' });
    expect(JSON.stringify(entry)).toContain('disk is full');
  });
});
