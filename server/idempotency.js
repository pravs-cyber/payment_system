import { query } from '../db.js';

// Idempotency responses are stored in PostgreSQL (no Redis dependency), so the same
// behaviour works in Docker Compose and in stateless Vercel functions.
// The table is also declared in db/schema.sql; this guard covers databases that were
// initialised from an older schema.sql.
let ready;
function ensureTable() {
  ready ??= query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
  `).catch(error => { ready = undefined; throw error; });
  return ready;
}

export async function getIdempotent(key) {
  if (!key) return null;
  await ensureTable();
  const { rows } = await query(
    `SELECT response FROM idempotency_keys WHERE key = $1 AND expires_at > now()`,
    [key]
  );
  return rows[0]?.response ?? null;
}

export async function saveIdempotent(key, value, ttlSeconds = 86400) {
  if (!key) return;
  await ensureTable();
  await query(
    `INSERT INTO idempotency_keys (key, response, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
    [key, JSON.stringify(value), ttlSeconds]
  );
}
