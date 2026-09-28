import crypto from 'node:crypto';

// Cashfree wire-format helpers shared by the real Cashfree adapter and the
// internal simulator (which emits Cashfree-shaped, signed webhooks).

export class ProviderError extends Error {
  constructor(message, { status = 502, retryable = false, code = null, body = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
    this.body = body;
  }
}

export const toRupees = paise => Number((paise / 100).toFixed(2));
export const toPaise = rupees => Math.round(Number(rupees) * 100);

// Cashfree webhook signature: Base64(HMAC-SHA256(x-webhook-timestamp + rawBody, secret))
export function signWebhook(rawBody, timestamp, secret) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('base64');
}

export function verifyWebhookSignature(rawBody, headers, secret) {
  const signature = headers['x-webhook-signature'];
  const timestamp = headers['x-webhook-timestamp'];
  if (!secret) throw new ProviderError('Webhook secret not configured', { status: 500 });
  if (!signature || !timestamp || typeof rawBody !== 'string') {
    throw new ProviderError('Missing webhook signature headers or raw body', { status: 401 });
  }
  const expected = Buffer.from(signWebhook(rawBody, timestamp, secret));
  const received = Buffer.from(String(signature));
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    throw new ProviderError('Invalid webhook signature', { status: 401 });
  }
}

// PG payment_status -> PayFlow payment status
export function mapPaymentStatus(paymentStatus) {
  switch (String(paymentStatus || '').toUpperCase()) {
    case 'SUCCESS': return 'SUCCESS';
    case 'FAILED': return 'FAILED';
    case 'USER_DROPPED':
    case 'CANCELLED':
    case 'VOID': return 'CANCELLED';
    case 'PENDING': return 'PENDING';
    default: return null; // NOT_ATTEMPTED etc: no state change
  }
}

// Payouts V2 status/status_code -> PayFlow payout status.
// A transfer is final-successful only for SUCCESS + COMPLETED (Cashfree docs);
// SUCCESS + SENT_TO_BENEFICIARY is still in flight.
export function mapTransferStatus(status, statusCode) {
  const s = String(status || '').toUpperCase();
  const c = String(statusCode || '').toUpperCase();
  if (s === 'SUCCESS') return c === 'COMPLETED' ? 'SUCCESS' : 'PROCESSING';
  if (['FAILED', 'REJECTED', 'MANUALLY_REJECTED'].includes(s)) return 'FAILED';
  if (s === 'REVERSED') return 'REVERSED';
  return 'PROCESSING'; // RECEIVED, QUEUED, PENDING, APPROVAL_PENDING, VALIDATION_PENDING ...
}

// PG webhook (PAYMENT_SUCCESS_WEBHOOK / PAYMENT_FAILED_WEBHOOK / PAYMENT_USER_DROPPED_WEBHOOK)
export function parsePaymentWebhook(event) {
  const order = event?.data?.order;
  const payment = event?.data?.payment;
  if (!order?.order_id || !payment) return null;
  const status = mapPaymentStatus(payment.payment_status);
  if (!status) return null;
  return {
    kind: 'payment',
    type: event.type,
    reference: String(order.order_id),
    status,
    providerAttemptId: payment.cf_payment_id != null ? String(payment.cf_payment_id) : null,
    amountPaise: order.order_amount != null ? toPaise(order.order_amount) : null,
    failureReason: status === 'SUCCESS' ? null
      : (payment.payment_message || event.data?.error_details?.error_description || payment.payment_status),
    eventKey: `${event.type}:${order.order_id}:${payment.cf_payment_id}:${payment.payment_status}`
  };
}

// Payouts V2 webhook (TRANSFER_ACKNOWLEDGED / SUCCESS / FAILED / REVERSED / REJECTED)
export function parsePayoutWebhook(event) {
  const t = event?.data;
  if (!String(event?.type || '').startsWith('TRANSFER_') || !t?.transfer_id) return null; // e.g. LOW_BALANCE_ALERT test event
  return {
    kind: 'payout',
    type: event.type,
    reference: String(t.transfer_id),
    status: mapTransferStatus(t.status, t.status_code),
    statusCode: t.status_code || null,
    providerPayoutId: t.cf_transfer_id != null ? String(t.cf_transfer_id) : null,
    utr: t.transfer_utr || null,
    amountPaise: t.transfer_amount != null ? toPaise(t.transfer_amount) : null,
    failureReason: ['FAILED', 'REJECTED', 'REVERSED', 'MANUALLY_REJECTED'].includes(String(t.status).toUpperCase())
      ? (t.status_description || t.status_code) : null,
    eventKey: `${event.type}:${t.transfer_id}:${t.status}:${t.status_code}`
  };
}

// Deterministic UUID-shaped key (Cashfree PG's x-idempotency-key is UUID-formatted).
export function uuidFrom(text) {
  const h = crypto.createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
