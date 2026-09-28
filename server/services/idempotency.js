import { query } from '../db.js';

// Response cache for Idempotency-Key replays (table in db/schema.sql).
// Duplicate *processing* is additionally blocked by unique constraints
// (payments: merchant_id+merchant_order_id, payouts: merchant_id+idempotency_key).
export async function getIdempotent(key) {
  if (!key) return null;
  const { rows } = await query(
    `SELECT response FROM idempotency_keys WHERE key = $1 AND expires_at > now()`, [key]);
  return rows[0]?.response ?? null;
}

export async function saveIdempotent(key, value, ttlSeconds = 86400) {
  if (!key) return;
  await query(
    `INSERT INTO idempotency_keys (key, response, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
    [key, JSON.stringify(value), ttlSeconds]
  );
}
