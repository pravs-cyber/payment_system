export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const environment = process.env.PAYPAL_ENV === 'production' ? 'production' : 'sandbox';

  if (!clientId) {
    return res.status(500).json({ error: 'PAYPAL_CLIENT_ID is missing from Vercel Environment Variables' });
  }

  return res.status(200).json({
    paypalClientId: clientId,
    paypalEnvironment: environment,
    supabaseUrl: process.env.SUPABASE_URL,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY
  });
}
