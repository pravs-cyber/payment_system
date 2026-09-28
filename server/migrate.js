import fs from 'node:fs';
import { pool } from './db.js';
import { config } from './config.js';

// Applies db/schema.sql once per process. Every statement in it is idempotent,
// and an advisory lock serialises concurrent cold starts (e.g. several Vercel
// instances), so an existing Supabase database is upgraded on first request.
let migrated;
export function ensureMigrated() {
  if (!config.autoMigrate) return Promise.resolve();
  migrated ??= (async () => {
    const sql = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(727274)');
      await client.query("SET LOCAL client_min_messages = 'warning'");
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  })().catch(error => { migrated = undefined; throw error; });
  return migrated;
}
