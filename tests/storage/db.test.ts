import { DB_VERSION, TcDatabase } from '../../src/storage/db';

describe('DB_VERSION', () => {
  // The backup refuses a file from a newer version by comparing against DB_VERSION: it must follow every `db.version(n)`.
  it('is the highest version the database declares', () => {
    expect(new TcDatabase().verno).toBe(DB_VERSION);
  });
});
