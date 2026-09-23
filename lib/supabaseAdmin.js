import { createClient } from '@supabase/supabase-js';

let client;

function getClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url) throw new Error('SUPABASE_URL is missing from Vercel Environment Variables');
  if (!key) throw new Error('SUPABASE_SECRET_KEY is missing from Vercel Environment Variables');

  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return client;
}

export const supabaseAdmin = new Proxy({}, {
  get(_target, property) {
    return getClient()[property];
  }
});
