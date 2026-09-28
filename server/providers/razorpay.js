import crypto from 'node:crypto';
import { config, requireEnv } from '../config.js';

const BASE = 'https://api.razorpay.com/v1';

function headers(extra = {}) {
  requireEnv('RAZORPAY_KEY_ID', config.razorpayKeyId);
  requireEnv('RAZORPAY_KEY_SECRET', config.razorpayKeySecret);
  const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
  return { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...extra };
}

export async function createRazorpayOrder({ amount, currency, receipt, notes }) {
  const response = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ amount, currency, receipt, notes })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.description || 'Razorpay order creation failed');
  return data;
}

export async function fetchRazorpayPayment(paymentId) {
  const response = await fetch(`${BASE}/payments/${encodeURIComponent(paymentId)}`, {
    headers: headers()
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.description || 'Razorpay payment lookup failed');
  return data;
}

export function verifyRazorpaySignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac('sha256', requireEnv('RAZORPAY_KEY_SECRET', config.razorpayKeySecret))
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

export function verifyRazorpayWebhook(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', requireEnv('RAZORPAY_WEBHOOK_SECRET', config.razorpayWebhookSecret))
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}
