import { query } from '../db.js';

export async function audit({ db = { query }, actor, action, entityType, entityId, details = {}, ip }) {
  try {
    await db.query(
      `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, details, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor?.id || null, actor?.role || 'system', action, entityType || null, entityId ? String(entityId) : null, JSON.stringify(details), ip || null]
    );
  } catch (err) {
    console.error('[audit] failed to write', action, err.message);
  }
}
