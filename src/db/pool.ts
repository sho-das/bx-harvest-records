import { Pool, types } from 'pg';

/**
 * A3, enforced at the driver.
 *
 * By default `pg` turns a DATE column into a JavaScript Date at midnight in
 * the server's local timezone. This machine runs Asia/Kolkata, so a harvest
 * on 2026-03-12 comes back as 2026-03-11T18:30:00Z and prints as the 11th to
 * anything reading it in UTC. That is the timezone shift A3 exists to prevent,
 * and it would arrive silently as an off-by-one-day answer.
 *
 * DATE is handed back as the string Postgres wrote: '2026-03-12'. A harvest
 * happened on a day, so a day is what crosses the boundary.
 */
types.setTypeParser(types.builtins.DATE, (value: string) => value);

/**
 * One pool for the process. Raw SQL through the `pg` driver, no ORM (D1).
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * NUMERIC comes back from `pg` as a string, because a Postgres NUMERIC can hold
 * more digits than a JavaScript number. Every quantity in this file is a
 * kilogram figure with at most three decimal places, so Number() is exact here.
 * The conversion happens in one place so it can be found and changed.
 */
export function numericToNumber(value: string | null): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}
