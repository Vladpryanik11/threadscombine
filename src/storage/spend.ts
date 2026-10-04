import type { ModelInfo, Usage } from '../ai/types';
import type { Settings } from './settings';
import { db, type SpendRecord } from './db';
import { log } from './journal';

const NANO = 1e9;

/** Dollars → whole nano-dollars, so sums and limit checks are exact integer arithmetic. */
const toNano = (usd: number): number => (Number.isFinite(usd) ? Math.round(usd * NANO) : 0);
const fromNano = (nano: number): number => nano / NANO;

/**
 * Cost of one call: the figure OpenRouter reported if there is one, otherwise the catalog prices,
 * otherwise 0 (unknown model).
 */
export function computeCostUsd(usage: Usage, model?: ModelInfo): number {
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) return usage.costUsd;
  if (!model) return 0;
  return (
    (usage.promptTokens * model.promptPricePerM + usage.completionTokens * model.completionPricePerM) /
    1_000_000
  );
}

/** Never throws: a failed write goes to the journal and the caller carries on. */
export async function recordSpend(r: Omit<SpendRecord, 'id'>): Promise<void> {
  try {
    await db.spend.add(r);
  } catch (error) {
    await log('error', 'spend', 'Не удалось записать расход', {
      purpose: r.purpose,
      model: r.model,
      error,
    });
  }
}

/** Start of the local calendar day containing `now`. */
export function dayStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Start of the local calendar month containing `now`. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function nextDayStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function nextMonthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/** All records of the calendar month containing `now`, read through the `ts` index. */
function monthRecords(now: number): Promise<SpendRecord[]> {
  return db.spend.where('ts').between(monthStart(now), nextMonthStart(now), true, false).toArray();
}

function todayNano(records: SpendRecord[], now: number): number {
  const from = dayStart(now);
  const to = nextDayStart(now);
  let sum = 0;
  for (const r of records) if (r.ts >= from && r.ts < to) sum += toNano(r.costUsd);
  return sum;
}

function monthNano(records: SpendRecord[]): number {
  let sum = 0;
  for (const r of records) sum += toNano(r.costUsd);
  return sum;
}

export interface SpendSummary {
  todayUsd: number;
  monthUsd: number;
  byPurpose: Array<{ purpose: string; usd: number }>;
  byAccount: Array<{ accountId: string; usd: number }>;
}

/** Nano-dollar totals per key, biggest first; equal amounts keep an alphabetical order. */
function groupBy(records: SpendRecord[], key: (r: SpendRecord) => string): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const r of records) totals.set(key(r), (totals.get(key(r)) ?? 0) + toNano(r.costUsd));
  return [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Today and the current month across all accounts; the lists cover the month. */
export async function spendSummary(now: number = Date.now()): Promise<SpendSummary> {
  const records = await monthRecords(now);
  return {
    todayUsd: fromNano(todayNano(records, now)),
    monthUsd: fromNano(monthNano(records)),
    byPurpose: groupBy(records, (r) => r.purpose).map(([purpose, nano]) => ({
      purpose,
      usd: fromNano(nano),
    })),
    byAccount: groupBy(records, (r) => r.accountId).map(([accountId, nano]) => ({
      accountId,
      usd: fromNano(nano),
    })),
  };
}

/** The first limit that is reached (spent ≥ limit), the daily one before the monthly one. */
export async function checkBudget(
  s: Pick<Settings, 'dailyBudgetUsd' | 'monthlyBudgetUsd'>,
  now: number = Date.now(),
): Promise<null | { period: 'day' | 'month'; limitUsd: number }> {
  if (s.dailyBudgetUsd === null && s.monthlyBudgetUsd === null) return null;
  const records = await monthRecords(now);
  if (s.dailyBudgetUsd !== null && todayNano(records, now) >= toNano(s.dailyBudgetUsd)) {
    return { period: 'day', limitUsd: s.dailyBudgetUsd };
  }
  if (s.monthlyBudgetUsd !== null && monthNano(records) >= toNano(s.monthlyBudgetUsd)) {
    return { period: 'month', limitUsd: s.monthlyBudgetUsd };
  }
  return null;
}
