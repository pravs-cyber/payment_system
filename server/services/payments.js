import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../providers/cashfree-format.js';
import { ACCOUNTS, platformFee, postTransaction } from './ledger.js';
import { getIdempotent, saveIdempotent } from './idempotency.js';
import { audit } from './security.js';

// Payment state machine. Only these transitions are legal; the transition is applied with
// SELECT ... FOR UPDATE inside one DB transaction together with its ledger + wallet effects,
// so a duplicated or concurrent webhook can never post the same money twice.
//   CREATED -> PENDING (order created at PSP, customer can pay)
//   PENDING -> SUCCESS | FAILED | CANCELLED | EXPIRED | MANUAL_REVIEW
//   FAILED / CANCELLED -> SUCCESS (customer retried within the same PSP order) | EXPIRED
//   SUCCESS -> REFUNDED
//   MANUAL_REVIEW -> SUCCESS | FAILED (operator decision)
export const PAYMENT_TRANSITIONS = {
  CREATED: ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW'],
  PENDING: ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW'],
  FAILED: ['SUCCESS', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW'],
  CANCELLED: ['SUCCESS', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW'],
  SUCCESS: ['REFUNDED'],
  MANUAL_REVIEW: ['SUCCESS', 'FAILED'],
  EXPIRED: [],
  REFUNDED: []
};
const TERMINAL_FOR_POLLING = ['SUCCESS', 'REFUNDED', 'EXPIRED', 'MANUAL_REVIEW'];
const MAX_AMOUNT_PAISE = 10_00_000 * 100; // ₹10,00,000 per payment

const makeId = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const badRequest = message => Object.assign(new Error(message), { status: 400 });

export function publicPayment(p) {
  return {
    paymentId: p.id,
    orderId: p.merchant_order_id,
    amount: Number(p.amount_paise),
    currency: p.currency,
    status: p.status,
    provider: p.provider,
    providerPaymentId: p.provider_payment_id,
    failureReason: p.failure_reason || null,
    createdAt: p.created_at,
    updatedAt: p.updated_at
  };
}

export function checkoutUrl(baseUrl, paymentId) {
  return `${baseUrl}/checkout?payment=${encodeURIComponent(paymentId)}`;
}

function validateCustomer(customer = {}, providerName) {
  const phone = customer.phone ? String(customer.phone).replace(/[\s-]/g, '').replace(/^\+91/, '') : null;
  if (providerName === 'cashfree' && !/^\d{10}$/.test(phone || '')) {
    throw badRequest('customer.phone (10 digits) is required');
  }
  if (customer.email && !/^\S+@\S+\.\S{2,}$/.test(String(customer.email))) throw badRequest('customer.email is invalid');
  const id = customer.id && /^[A-Za-z0-9_-]{3,50}$/.test(String(customer.id))
    ? String(customer.id)
    : `cust_${crypto.createHash('sha256').update(String(customer.email || phone || crypto.randomUUID())).digest('hex').slice(0, 20)}`;
  return { id, phone: phone || '9999999999', email: customer.email ? String(customer.email) : null,
    name: customer.name ? String(customer.name).slice(0, 100) : null };
}

async function createAtProvider(payment, customer, baseUrl) {
  const provider = getProvider(payment.provider);
  const notifyUrl = payment.provider === 'cashfree' && config.publicBaseUrl.startsWith('https://')
    ? `${config.publicBaseUrl}/v1/webhooks/cashfree/payments` : null;
  let lastError;
  // Order creation is idempotent at the PSP (same order_id + idempotency key), so transient
  // errors are retried in-line with backoff before giving up.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await provider.createPayment({ payment, customer, returnUrl: checkoutUrl(baseUrl, payment.id), notifyUrl });
      const { rows } = await query(
        `UPDATE payments SET status='PENDING', provider_payment_id=$2, provider_order_id=$3, checkout_session=$4,
                failure_reason=NULL, next_poll_at=now() + interval '2 minutes', updated_at=now()
         WHERE id=$1 AND status IN ('CREATED','FAILED') RETURNING *`,
        [payment.id, result.providerPaymentId, result.providerOrderId, JSON.stringify(result.checkout)]
      );
      return rows[0] || payment;
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProviderError) || !error.retryable || attempt === 3) break;
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  await query(`UPDATE payments SET failure_reason=$2, updated_at=now() WHERE id=$1`, [payment.id, lastError.message]);
  throw Object.assign(new Error(`Payment provider error: ${lastError.message}`), { status: lastError.status === 400 ? 400 : 502 });
}

export async function createPayment(merchant, body, idempotencyKey, baseUrl) {
  if (!idempotencyKey) throw badRequest('Idempotency-Key header is required');
  const cacheKey = `${merchant.id}:payment:${idempotencyKey}`;
  const cached = await getIdempotent(cacheKey);
  if (cached) return { replayed: true, body: cached };

  const { amount, currency = merchant.currency || 'INR', orderId, customer, simulation } = body || {};
  const amountPaise = Number(amount);
  if (!Number.isInteger(amountPaise) || amountPaise < 100 || amountPaise > MAX_AMOUNT_PAISE) {
    throw badRequest('amount must be an integer in paise between 100 and 100000000');
  }
  if (!orderId || !/^[A-Za-z0-9_-]{1,64}$/.test(String(orderId))) throw badRequest('orderId is required (letters, digits, _ or -, max 64)');
  if (currency !== 'INR') throw badRequest('Only INR is supported');

  const providerName = getProvider().name;
  const cust = validateCustomer(customer, providerName);

  let payment;
  const existing = await query(`SELECT * FROM payments WHERE merchant_id=$1 AND merchant_order_id=$2`, [merchant.id, String(orderId)]);
  if (existing.rows[0]) {
    payment = existing.rows[0];
    const resumable = !payment.provider_payment_id && ['CREATED', 'FAILED'].includes(payment.status) &&
      payment.idempotency_key === idempotencyKey && Number(payment.amount_paise) === amountPaise;
    if (!resumable) throw Object.assign(new Error('A payment for this orderId already exists'), { status: 409 });
  } else {
    const { rows } = await query(
      `INSERT INTO payments (id, merchant_id, merchant_order_id, amount_paise, currency, status, provider, customer_ref, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'CREATED',$6,$7,$8) RETURNING *`,
      [makeId('pay'), merchant.id, String(orderId), amountPaise, currency, providerName, cust.id, idempotencyKey]
    );
    payment = rows[0];
  }

  payment = await createAtProvider(payment, cust, baseUrl);

  // Test-only shortcut for the simulator: completes the hosted checkout on the customer's
  // behalf. The result still arrives through a signed webhook. Ignored for real providers.
  if (simulation && payment.provider === 'internal_simulator') {
    await getProvider('internal_simulator').completePayment(payment.id, simulation);
    payment = (await query(`SELECT * FROM payments WHERE id=$1`, [payment.id])).rows[0];
  }

  const response = {
    ...publicPayment(payment),
    checkout: { url: checkoutUrl(baseUrl, payment.id), ...(payment.checkout_session ? JSON.parse(payment.checkout_session) : {}) },
    customer: { id: cust.id }
  };
  await saveIdempotent(cacheKey, response);
  return { replayed: false, body: response };
}

// Applies a provider-reported status (webhook or polling) through the state machine.
export async function applyPaymentUpdate({ paymentId, status, providerAttemptId = null, amountPaise = null,
  failureReason = null, source }) {
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [paymentId]);
    const payment = rows[0];
    if (!payment) return { applied: false, reason: 'unknown payment' };

    if (providerAttemptId || status !== payment.status) {
      await client.query(
        `INSERT INTO payment_attempts (payment_id, provider_attempt_id, status, failure_reason) VALUES ($1,$2,$3,$4)`,
        [paymentId, providerAttemptId, status, failureReason]);
    }
    if (status === payment.status) return { applied: false, reason: 'no change', status };

    let target = status;
    let reason = failureReason;
    // Never credit a merchant for an amount different from what was ordered.
    if (target === 'SUCCESS' && amountPaise != null && amountPaise !== Number(payment.amount_paise)) {
      target = 'MANUAL_REVIEW';
      reason = `Amount mismatch: provider reported ${amountPaise}, expected ${payment.amount_paise}`;
    }
    if (!(PAYMENT_TRANSITIONS[payment.status] || []).includes(target)) {
      return { applied: false, reason: `illegal transition ${payment.status} -> ${target}` };
    }

    await client.query(
      `UPDATE payments SET status=$2, failure_reason=$3, updated_at=now(),
              next_poll_at = CASE WHEN $2 = ANY($4::text[]) THEN NULL ELSE next_poll_at END
       WHERE id=$1`,
      [paymentId, target, target === 'SUCCESS' ? null : reason, TERMINAL_FOR_POLLING]
    );

    if (target === 'SUCCESS') {
      const gross = Number(payment.amount_paise);
      const fee = platformFee(gross);
      await postTransaction(client, {
        merchantId: payment.merchant_id, referenceType: 'payment', referenceId: payment.id,
        description: 'Payment captured',
        entries: [
          { account: ACCOUNTS.PSP_CLEARING, debit: gross },
          { account: ACCOUNTS.MERCHANT_PAYABLE, credit: gross - fee },
          { account: ACCOUNTS.FEE_REVENUE, credit: fee }
        ]
      });
      await client.query(
        `INSERT INTO wallets (merchant_id, available_paise) VALUES ($1,$2)
         ON CONFLICT (merchant_id) DO UPDATE SET available_paise = wallets.available_paise + EXCLUDED.available_paise, updated_at=now()`,
        [payment.merchant_id, gross - fee]);
    }
    if (target === 'MANUAL_REVIEW') {
      await audit('system', 'payment.manual_review', payment.id, { reason, source }, client);
    }
    return { applied: true, from: payment.status, to: target };
  });
}

export async function refundPayment(merchant, paymentId) {
  const { rows } = await query(`SELECT * FROM payments WHERE id=$1 AND merchant_id=$2`, [paymentId, merchant.id]);
  const payment = rows[0];
  if (!payment) throw Object.assign(new Error('Payment not found'), { status: 404 });
  if (payment.status !== 'SUCCESS') throw Object.assign(new Error('Only successful payments can be refunded'), { status: 409 });

  const net = Number(payment.amount_paise) - platformFee(Number(payment.amount_paise));
  // Reserve the balance first so a refund can't be issued against money already paid out.
  await withTransaction(async client => {
    const p = (await client.query(`SELECT status FROM payments WHERE id=$1 FOR UPDATE`, [paymentId])).rows[0];
    if (p.status !== 'SUCCESS') throw Object.assign(new Error('Only successful payments can be refunded'), { status: 409 });
    const w = await client.query(
      `SELECT available_paise FROM wallets WHERE merchant_id=$1 FOR UPDATE`, [merchant.id]);
    if (!w.rows[0] || Number(w.rows[0].available_paise) < net) {
      throw Object.assign(new Error('Insufficient merchant balance for refund'), { status: 409 });
    }
  });
  const refund = await getProvider(payment.provider).refundPayment({ payment });

  await withTransaction(async client => {
    const upd = await client.query(
      `UPDATE payments SET status='REFUNDED', updated_at=now() WHERE id=$1 AND status='SUCCESS' RETURNING id`, [paymentId]);
    if (!upd.rowCount) throw Object.assign(new Error('Payment was modified concurrently'), { status: 409 });
    const w = await client.query(
      `UPDATE wallets SET available_paise = available_paise - $2, updated_at=now()
       WHERE merchant_id=$1 AND available_paise >= $2 RETURNING merchant_id`, [merchant.id, net]);
    if (!w.rowCount) throw Object.assign(new Error('Insufficient merchant balance for refund'), { status: 409 });
    await postTransaction(client, {
      merchantId: merchant.id, referenceType: 'refund', referenceId: paymentId, description: 'Payment refunded',
      entries: [{ account: ACCOUNTS.MERCHANT_PAYABLE, debit: net }, { account: ACCOUNTS.PSP_CLEARING, credit: net }]
    });
  });
  await audit(`merchant:${merchant.id}`, 'payment.refunded', paymentId, { net });
  return { paymentId, refundId: refund.id, status: 'REFUNDED', refundedPaise: net };
}
