import { paypalClientToken } from '../../lib/paypal.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const host =
      req.headers['x-forwarded-host'] ||
      req.headers.host ||
      '';

    // PayPal expects the root domain, not https:// and not a path.
    const domain = host
      .split(':')[0]
      .replace(/^www\./, '');

    const clientToken = await paypalClientToken(domain);

    return res.status(200).json({ clientToken });
  } catch (error) {
    console.error('PayPal client token error:', error);

    return res.status(500).json({
      error: error.message || 'Could not initialize PayPal checkout'
    });
  }
}