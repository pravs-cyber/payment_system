import { paypalClientToken } from '../../lib/paypal.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;

    const origin =
      process.env.APP_URL ||
      `${proto}://${host}`;

    const clientToken = await paypalClientToken(origin);

    return res.status(200).json({
      clientToken
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Could not initialize PayPal checkout'
    });
  }
}