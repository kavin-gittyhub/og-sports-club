import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { seedInitialData } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Apply pending SQL migrations (idempotent, safe to run on every boot). */
export async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    // Prevent two instances migrating at the same time.
    await client.query('SELECT pg_advisory_lock(7000)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const files = fs.readdirSync(path.join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(here, 'migrations', file), 'utf8');
      log(`[migrate] applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    await seedInitialData(client, { log });
  } finally {
    await client.query('SELECT pg_advisory_unlock(7000)').catch(() => {});
    client.release();
  }
}

// `npm run migrate`
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  migrate()
    .then(() => { console.log('[migrate] done'); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}
