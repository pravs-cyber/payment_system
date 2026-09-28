import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

if (!config.databaseUrl) {
  console.error('No database URL configured. Set DATABASE_URL (or POSTGRES_URL from the Supabase integration).');
}

// Local Docker/dev Postgres runs without TLS; Supabase (and any remote host) requires it.
// sslmode is stripped from the URL and TLS is configured explicitly, because recent
// versions of pg treat `sslmode=require` as full CA verification, which fails against
// Supabase's pooler certificate chain.
function buildPoolConfig(rawUrl) {
  if (!rawUrl) return {};
  const url = new URL(rawUrl);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');

  const localHosts = ['localhost', '127.0.0.1', 'postgres', 'db'];
  const disableSsl = sslmode === 'disable' || process.env.PGSSL === 'disable' ||
    (localHosts.includes(url.hostname) && !sslmode);

  return {
    connectionString: url.toString(),
    ssl: disableSsl ? false : { rejectUnauthorized: false },
    // Serverless functions each hold their own pool; keep it small so we don't
    // exhaust Supabase connection limits. Use the pooler URL (port 6543) on Vercel.
    max: config.isVercel ? 3 : 10,
    idleTimeoutMillis: config.isVercel ? 5000 : 30000,
    connectionTimeoutMillis: 10000
  };
}

export const pool = new Pool(buildPoolConfig(config.databaseUrl));
pool.on('error', err => console.error('Postgres pool error:', err.message));

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
