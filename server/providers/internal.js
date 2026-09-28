import crypto from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import {
  ProviderError, toRupees, signWebhook, verifyWebhookSignature, parsePaymentWebhook, parsePayoutWebhook
} from './cashfree-format.js';

// Internal simulator: an offline stand-in for a PSP, kept for development, Docker and tests.
// It behaves like a real provider rather than a shortcut:
//   * payments start PENDING and are completed by the customer on a hosted checkout page;
//   * results arrive as HMAC-signed, Cashfree-format webhooks, processed by the same
//     verification + state-machine code as real Cashfree webhooks;
//   * it keeps its own provider-side records (simulator_records), so reconciliation
//     compares PayFlow against an independent source.
// No real money moves.

let webhookSink = null;
export function setWebhookSink(fn) { webhookSink = fn; }

const newId = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

async function upsertRecord(kind, reference, { providerId, status, statusCode = null, amountPaise, utr = null }) {
  const { rows } = await query(
    `INSERT INTO simulator_records (kind, reference, provider_id, status, status_code, amount_paise, utr)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (kind, reference) DO UPDATE
       SET status=EXCLUDED.status, status_code=EXCLUDED.status_code,
           utr=COALESCE(EXCLUDED.utr, simulator_records.utr), updated_at=now()
     RETURNING *`,
    [kind, reference, providerId, status, statusCode, amountPaise, utr]
  );
  return rows[0];
}

async function getRecord(kind, reference) {
  const { rows } = await query(`SELECT * FROM simulator_records WHERE kind=$1 AND reference=$2`, [kind, reference]);
  return rows[0] || null;
}

async function deliver(kind, event) {
  if (!webhookSink) throw new Error('Simulator webhook sink not registered');
  const rawBody = JSON.stringify(event);
  const timestamp = String(Date.now());
  const headers = { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signWebhook(rawBody, timestamp, config.simulatorWebhookSecret) };
  return webhookSink(kind, rawBody, headers);
}

const PAYMENT_OUTCOMES = {
  success: { status: 'SUCCESS', type: 'PAYMENT_SUCCESS_WEBHOOK', message: 'Simulated payment successful' },
  failed: { status: 'FAILED', type: 'PAYMENT_FAILED_WEBHOOK', message: 'Simulated bank decline' },
  cancelled: { status: 'USER_DROPPED', type: 'PAYMENT_USER_DROPPED_WEBHOOK', message: 'Customer closed the checkout' }
};

export const simulatorProvider = {
  name: 'internal_simulator',

  async createPayment({ payment }) {
    const providerId = newId('simord');
    await upsertRecord('payment', payment.id, { providerId, status: 'PENDING', amountPaise: Number(payment.amount_paise) });
    return {
      status: 'PENDING',
      providerPaymentId: providerId,
      providerOrderId: payment.id,
      checkout: { type: 'simulator', mode: 'test' }
    };
  },

  // Called by the hosted checkout page (customer action) or by the API's test `simulation` shortcut.
  //   success | failed | cancelled -> provider state changes and a signed webhook is delivered
  //   timeout -> provider records SUCCESS but the webhook is "lost" (recovered by the polling job)
  async completePayment(paymentId, outcome) {
    const record = await getRecord('payment', paymentId);
    if (!record) throw new ProviderError('Unknown payment at simulator', { status: 404 });
    const key = String(outcome || 'success').toLowerCase();
    if (key === 'pending') return { delivered: false };
    const lostWebhook = key === 'timeout';
    const o = PAYMENT_OUTCOMES[lostWebhook ? 'success' : key];
    if (!o) throw new ProviderError(`Unknown simulation outcome: ${outcome}`, { status: 400 });

    const attemptId = newId('simpay');
    await upsertRecord('payment', paymentId, {
      providerId: record.provider_id, status: o.status === 'USER_DROPPED' ? 'CANCELLED' : o.status,
      amountPaise: Number(record.amount_paise)
    });
    if (lostWebhook) return { delivered: false };
    const result = await deliver('payment', {
      type: o.type,
      event_time: new Date().toISOString(),
      data: {
        order: { order_id: paymentId, order_amount: toRupees(Number(record.amount_paise)), order_currency: 'INR' },
        payment: { cf_payment_id: attemptId, payment_status: o.status, payment_message: o.message,
          payment_amount: toRupees(Number(record.amount_paise)) }
      }
    });
    return { delivered: true, result };
  },

  async fetchPayment(payment) {
    const r = await getRecord('payment', payment.id);
    return r ? { status: r.status, amountPaise: Number(r.amount_paise), raw: r.status } : null;
  },

  async refundPayment({ payment }) {
    const r = await getRecord('payment', payment.id);
    if (r) await upsertRecord('payment', payment.id, { providerId: r.provider_id, status: 'REFUNDED', amountPaise: Number(r.amount_paise) });
    return { id: newId('simref'), status: 'SUCCESS' };
  },

  verifyPaymentWebhook(rawBody, headers) { verifyWebhookSignature(rawBody, headers, config.simulatorWebhookSecret); },
  verifyPayoutWebhook(rawBody, headers) { verifyWebhookSignature(rawBody, headers, config.simulatorWebhookSecret); },
  parsePaymentWebhook,
  parsePayoutWebhook,

  async createBeneficiary({ beneficiaryId, accountNumber }) {
    await upsertRecord('beneficiary', beneficiaryId, {
      providerId: beneficiaryId, status: 'VERIFIED',
      statusCode: String(accountNumber).slice(-4), amountPaise: 0
    });
    return { beneficiaryId };
  },

  // Accepts the transfer (RECEIVED -> PROCESSING), then settles it and delivers a signed
  // TRANSFER_* webhook, like Cashfree. Beneficiary accounts ending in 0000 fail at the bank.
  async createPayout({ payout, beneficiaryId }) {
    const bene = await getRecord('beneficiary', beneficiaryId);
    if (!bene) throw new ProviderError('Beneficiary does not exist at simulator', { status: 404, code: 'beneficiary_not_found' });
    const providerId = newId('simtr');
    await upsertRecord('payout', payout.id, { providerId, status: 'RECEIVED', statusCode: 'RECEIVED', amountPaise: Number(payout.amount_paise) });
    const accepted = { status: 'PROCESSING', statusCode: 'RECEIVED', providerPayoutId: providerId, utr: null, amountPaise: Number(payout.amount_paise) };

    const fails = bene.status_code === '0000';
    const settled = fails
      ? { status: 'FAILED', status_code: 'INVALID_ACCOUNT_FAIL', status_description: 'Simulated: beneficiary account is invalid' }
      : { status: 'SUCCESS', status_code: 'COMPLETED', transfer_utr: `SIMUTR${Date.now()}`, status_description: 'Simulated transfer completed' };
    await upsertRecord('payout', payout.id, { providerId, status: settled.status, statusCode: settled.status_code,
      amountPaise: Number(payout.amount_paise), utr: settled.transfer_utr || null });
    accepted.afterAccept = () => deliver('payout', {
      type: fails ? 'TRANSFER_FAILED' : 'TRANSFER_ACKNOWLEDGED',
      event_time: new Date().toISOString(),
      data: { transfer_id: payout.id, cf_transfer_id: providerId, transfer_amount: toRupees(Number(payout.amount_paise)),
        beneficiary_details: { beneficiary_id: beneficiaryId }, ...settled }
    });
    return accepted;
  },

  // Simulates the beneficiary bank returning funds after a successful payout.
  async reversePayout(payoutId) {
    const r = await getRecord('payout', payoutId);
    if (!r || r.status !== 'SUCCESS') throw new ProviderError('Only completed payouts can be reversed', { status: 409 });
    await upsertRecord('payout', payoutId, { providerId: r.provider_id, status: 'REVERSED', statusCode: 'RETURNED_FROM_BENEFICIARY', amountPaise: Number(r.amount_paise) });
    return deliver('payout', {
      type: 'TRANSFER_REVERSED', event_time: new Date().toISOString(),
      data: { transfer_id: payoutId, cf_transfer_id: r.provider_id, status: 'REVERSED', status_code: 'RETURNED_FROM_BENEFICIARY',
        status_description: 'Simulated: returned by beneficiary bank', transfer_amount: toRupees(Number(r.amount_paise)) }
    });
  },

  async fetchPayout(payout) {
    const r = await getRecord('payout', payout.id);
    if (!r) return null;
    const { mapTransferStatus } = await import('./cashfree-format.js');
    return {
      status: mapTransferStatus(r.status, r.status_code), statusCode: r.status_code, providerPayoutId: r.provider_id,
      utr: r.utr, amountPaise: Number(r.amount_paise), raw: `${r.status}/${r.status_code}`,
      failureReason: ['FAILED', 'REVERSED'].includes(r.status) ? r.status_code : null
    };
  }
};
