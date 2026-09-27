import pg from 'pg';
import { config } from './config.js';

// Return BIGINT/NUMERIC aggregates (COUNT, SUM) as JS numbers — all our sums fit comfortably.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// Keep DATE columns as plain 'YYYY-MM-DD' strings (no accidental TZ shifts).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DATABASE_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export const query = (text, params) => pool.query(text, params);

/** Run `fn(client)` inside a transaction. Rolls back on any thrown error. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Serialise every booking mutation for one facility group. Combined with the
 * EXCLUDE constraints this makes double bookings impossible even under heavy concurrency.
 */
export async function lockFacility(client, facilityGroupId) {
  await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [7001, facilityGroupId]);
}
