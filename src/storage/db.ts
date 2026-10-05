import Dexie, { type Table } from 'dexie';

export const DB_NAME = 'threadscombine';
export const DB_VERSION = 1;

export interface JournalEntry {
  id?: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  area: string;
  message: string;
  details?: unknown;
}

export interface Account {
  id: string; // crypto.randomUUID()
  name: string; // 1–40 characters after trimming
  threadsUsername: string; // '' or [a-z0-9._]{1,30}: no «@», lower case; unique among accounts
  color: string; // from the 8-colour palette, cycling
  createdAt: number;
}

export interface SpendRecord {
  id?: number;
  ts: number;
  accountId: string;
  purpose: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export class TcDatabase extends Dexie {
  journal!: Table<JournalEntry, number>;
  accounts!: Table<Account, string>;
  spend!: Table<SpendRecord, number>;

  constructor() {
    super(DB_NAME);
    // Each later part adds its tables with a new `this.version(n).stores({...})`, raises DB_VERSION to `n`
    // (tests/storage/db.test.ts fails otherwise) and never edits this one.
    this.version(1).stores({
      journal: '++id, ts, level, area',
      accounts: 'id, createdAt',
      spend: '++id, ts, accountId, purpose',
    });
  }
}

export const db = new TcDatabase();
