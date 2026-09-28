import crypto from 'node:crypto';
import { config } from '../config.js';
import {
  ProviderError, toRupees, toPaise, verifyWebhookSignature, mapPaymentStatus, mapTransferStatus,
  parsePaymentWebhook, parsePayoutWebhook, uuidFrom
} from './cashfree-format.js';

// Real PSP adapter: Cashfree Payment Gateway (pay-in) + Cashfree Payouts V2 (pay-out).
// Sandbox by default (CASHFREE_ENV=sandbox): real API calls and signed webhooks, test money.
const cf = () => config.cashfree;

// Payouts 2FA for hosts without a static IP (Vercel): RSA-OAEP("<clientId>.<unixSeconds>") with
// the public key from the Cashfree dashboard, base64, in X-Cf-Signature. Valid for 5 minutes.
function payoutSignature() {
  const data = Buffer.from(`${cf().payoutClientId}.${Math.floor(Date.now() / 1000)}`);
  return crypto.publicEncrypt(
    { key: cf().payoutPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, data
  ).toString('base64');
}

async function request(api, method, path, body, { idempotencyKey } = {}) {
  const isPg = api === 'pg';
  const clientId = isPg ? cf().pgClientId : cf().payoutClientId;
  const clientSecret = isPg ? cf().pgClientSecret : cf().payoutClientSecret;
  if (!clientId || !clientSecret) {
    throw new ProviderError(`Cashfree ${isPg ? 'Payment Gateway' : 'Payouts'} credentials are not configured`,
      { status: 500 });
  }
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'x-api-version': isPg ? cf().pgApiVersion : cf().payoutApiVersion
  };
  if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
  if (!isPg && cf().payoutPublicKey) headers['x-cf-signature'] = payoutSignature();

  const url = `${cf().baseUrl}${isPg ? '/pg' : '/payout'}${path}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    // Timeout / network failure: outcome unknown -> caller must check status, not blindly resubmit.
    throw new ProviderError(`Cashfree unreachable: ${error.message}`, { status: 0, retryable: true });
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok) {
    throw new ProviderError(`Cashfree ${res.status}: ${data.message || data.code || 'request failed'}`, {
      status: res.status, code: data.code || null, body: data,
      retryable: res.status >= 500 || res.status === 429
    });
  }
  return data;
}

export const cashfreeProvider = {
  name: 'cashfree',

  async createPayment({ payment, customer, returnUrl, notifyUrl }) {
    const order = await request('pg', 'POST', '/orders', {
      order_id: payment.id,
      order_amount: toRupees(Number(payment.amount_paise)),
      order_currency: payment.currency,
      customer_details: {
        customer_id: customer.id,
        customer_phone: customer.phone,
        ...(customer.email ? { customer_email: customer.email } : {}),
        ...(customer.name && customer.name.length >= 3 ? { customer_name: customer.name } : {})
      },
      order_meta: { return_url: returnUrl, ...(notifyUrl ? { notify_url: notifyUrl } : {}) },
      order_note: `PayFlow order ${payment.merchant_order_id}`.slice(0, 200),
      order_tags: { merchant_id: payment.merchant_id, merchant_order_id: String(payment.merchant_order_id).slice(0, 255) }
    }, { idempotencyKey: uuidFrom(`order:${payment.id}`) });

    return {
      status: 'PENDING',
      providerPaymentId: order.cf_order_id != null ? String(order.cf_order_id) : null,
      providerOrderId: order.order_id,
      checkout: { type: 'cashfree', paymentSessionId: order.payment_session_id, mode: cf().env }
    };
  },

  async fetchPayment(payment) {
    let order;
    try {
      order = await request('pg', 'GET', `/orders/${encodeURIComponent(payment.id)}`);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    const amountPaise = toPaise(order.order_amount);
    if (order.order_status === 'PAID') return { status: 'SUCCESS', amountPaise, raw: order.order_status };
    if (['EXPIRED', 'TERMINATED'].includes(order.order_status)) return { status: 'EXPIRED', amountPaise, raw: order.order_status };
    // ACTIVE: look at the latest attempt (a failed attempt does not end the order).
    const attempts = await request('pg', 'GET', `/orders/${encodeURIComponent(payment.id)}/payments`).catch(() => []);
    const latest = Array.isArray(attempts) ? attempts.sort((a, b) =>
      String(b.payment_time || '').localeCompare(String(a.payment_time || '')))[0] : null;
    const status = latest ? (mapPaymentStatus(latest.payment_status) || 'PENDING') : 'PENDING';
    return {
      status, amountPaise, raw: `${order.order_status}/${latest?.payment_status || 'NO_ATTEMPT'}`,
      providerAttemptId: latest?.cf_payment_id != null ? String(latest.cf_payment_id) : null,
      failureReason: latest?.payment_message || null
    };
  },

  async refundPayment() {
    throw new ProviderError('Refunds through Cashfree are not implemented yet', { status: 501 });
  },

  verifyPaymentWebhook(rawBody, headers) { verifyWebhookSignature(rawBody, headers, cf().pgClientSecret); },
  verifyPayoutWebhook(rawBody, headers) { verifyWebhookSignature(rawBody, headers, cf().payoutClientSecret); },
  parsePaymentWebhook,
  parsePayoutWebhook,

  // Registers the merchant's settlement bank account with Cashfree Payouts.
  async createBeneficiary({ beneficiaryId, name, accountNumber, ifsc, email, phone }) {
    await request('payout', 'POST', '/beneficiary', {
      beneficiary_id: beneficiaryId,
      beneficiary_name: name,
      beneficiary_instrument_details: { bank_account_number: accountNumber, bank_ifsc: ifsc },
      ...((email || phone) ? {
        beneficiary_contact_details: {
          ...(email ? { beneficiary_email: email } : {}),
          ...(phone ? { beneficiary_phone: phone } : {})
        }
      } : {})
    });
    return { beneficiaryId };
  },

  async createPayout({ payout, beneficiaryId }) {
    const t = await request('payout', 'POST', '/transfers', {
      transfer_id: payout.id,
      transfer_amount: toRupees(Number(payout.amount_paise)),
      transfer_currency: payout.currency || 'INR',
      transfer_mode: String(payout.mode || 'banktransfer').toLowerCase(),
      beneficiary_details: { beneficiary_id: beneficiaryId },
      transfer_remarks: 'PayFlow merchant payout'
    });
    return transferResult(t);
  },

  async fetchPayout(payout) {
    try {
      const t = await request('payout', 'GET', `/transfers?transfer_id=${encodeURIComponent(payout.id)}`);
      return transferResult(t);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }
};

function transferResult(t) {
  const status = mapTransferStatus(t.status, t.status_code);
  return {
    status,
    statusCode: t.status_code || null,
    providerPayoutId: t.cf_transfer_id != null ? String(t.cf_transfer_id) : null,
    utr: t.transfer_utr || null,
    amountPaise: t.transfer_amount != null ? toPaise(t.transfer_amount) : null,
    failureReason: ['FAILED', 'REVERSED'].includes(status) ? (t.status_description || t.status_code) : null,
    raw: `${t.status}/${t.status_code}`
  };
}
