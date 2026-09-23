const base = process.env.PAYPAL_ENV === 'production'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

function requireCredential(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from Vercel Environment Variables`);
  return value;
}

export async function paypalAccessToken() {
  const clientId = requireCredential('PAYPAL_CLIENT_ID');
  const clientSecret = requireCredential('PAYPAL_CLIENT_SECRET');
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: 'grant_type=client_credentials'
  });

  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    throw new Error(`PayPal authentication returned ${response.status}: ${raw.slice(0, 200)}`);
  }

  if (!response.ok || !data.access_token) {
    throw new Error(`PayPal authentication failed (${response.status}): ${data.error_description || data.error || JSON.stringify(data)}`);
  }

  return data.access_token;
}

export async function paypalRequest(path, options = {}) {
  const token = await paypalAccessToken();
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch {
    throw new Error(`PayPal API returned ${response.status}: ${raw.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`PayPal API ${response.status}: ${data.message || data.error_description || data.error || JSON.stringify(data)}`);
  }

  return data;
}
