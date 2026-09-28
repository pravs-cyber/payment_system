import { createClient } from '@supabase/supabase-js';

let client;

function getClient() {
  if (client) return client;

  const rawUrl = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();

  if (!rawUrl) {
    throw new Error('SUPABASE_URL is missing from Vercel Environment Variables');
  }
  if (!key) {
    throw new Error('SUPABASE_SECRET_KEY is missing from Vercel Environment Variables');
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('SUPABASE_URL is invalid. Use https://YOUR_PROJECT_REF.supabase.co');
  }

  if (!url.protocol.startsWith('http') || !url.hostname.endsWith('.supabase.co')) {
    throw new Error('SUPABASE_URL must be the project URL, e.g. https://YOUR_PROJECT_REF.supabase.co');
  }

  // Keep the project URL clean. Do not put /rest/v1 or another API path here.
  url.pathname = '';
  url.search = '';
  url.hash = '';

  client = createClient(url.toString().replace(/\/$/, ''), key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return client;
}

export const supabaseAdmin = new Proxy({}, {
  get(_target, property) {
    return getClient()[property];
  }
});
