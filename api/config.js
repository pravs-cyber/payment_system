export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const environment = process.env.PAYPAL_ENV === 'production' ? 'production' : 'sandbox';
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabasePublishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();

  if (!clientId) {
    return res.status(500).json({ error: 'PAYPAL_CLIENT_ID is missing from Vercel Environment Variables' });
  }
  if (!supabaseUrl) {
    return res.status(500).json({ error: 'SUPABASE_URL is missing from Vercel Environment Variables' });
  }
  if (!supabasePublishableKey) {
    return res.status(500).json({ error: 'SUPABASE_PUBLISHABLE_KEY is missing from Vercel Environment Variables' });
  }

  return res.status(200).json({
    paypalClientId: clientId,
    paypalEnvironment: environment,
    supabaseUrl: supabaseUrl.replace(/\/$/, ''),
    supabasePublishableKey
  });
}
