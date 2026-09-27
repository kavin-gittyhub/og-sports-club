import { query } from '../db.js';
import { DEFAULT_SETTINGS } from '../db/seed.js';

let cache = null;
let cacheAt = 0;

export async function getSettings() {
  if (cache && Date.now() - cacheAt < 15_000) return cache;
  const { rows } = await query('SELECT key, value FROM settings');
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) out[r.key] = { ...(out[r.key] || {}), ...r.value };
  cache = out;
  cacheAt = Date.now();
  return out;
}

export async function saveSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
  cache = null;
}
