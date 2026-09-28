export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(200).json({
    clientId: process.env.PAYPAL_CLIENT_ID,
    environment: process.env.PAYPAL_ENV === 'production' ? 'production' : 'sandbox'
  });
}
