export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const razorpayKeyId = process.env.RAZORPAY_KEY_ID?.trim();
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabasePublishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();

  if (!razorpayKeyId) {
    return res.status(500).json({ error: 'RAZORPAY_KEY_ID is missing from Vercel Environment Variables' });
  }
  if (!supabaseUrl) {
    return res.status(500).json({ error: 'SUPABASE_URL is missing from Vercel Environment Variables' });
  }
  if (!supabasePublishableKey) {
    return res.status(500).json({ error: 'SUPABASE_PUBLISHABLE_KEY is missing from Vercel Environment Variables' });
  }

  const displayExchangeRate = Number(process.env.BDAYSTUDIO_USD_TO_INR || 90);

  return res.status(200).json({
    razorpayKeyId,
    displayExchangeRate,
    supabaseUrl: supabaseUrl.replace(/\/$/, ''),
    supabasePublishableKey
  });
}
