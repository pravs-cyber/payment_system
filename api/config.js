export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.status(200).json({
    paypalClientId: process.env.PAYPAL_CLIENT_ID,
    paypalEnvironment: process.env.PAYPAL_ENV === 'production' ? 'production' : 'sandbox',
    supabaseUrl: process.env.SUPABASE_URL,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY
  });
}
