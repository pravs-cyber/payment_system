import crypto from 'node:crypto';
import { query } from '../db.js';
import { getProvider } from '../providers/index.js';
import { setWebhookSink } from '../providers/internal.js';
import { applyPaymentUpdate } from './payments.js';
import { applyPayoutUpdate } from './payouts.js';
import { audit } from './security.js';

export const MAX_WEBHOOK_ATTEMPTS = 5;

// Webhook inbox, per Chapter 27: verify the signature over the raw body, record the event
// once (deliveries are deduplicated by a key derived from the event), then apply it through
// the payment/payout state machines. A failed apply is stored and retried by the jobs; after
// MAX_WEBHOOK_ATTEMPTS the event is parked as DEAD_LETTER for an operator.
export async function handleWebhook(providerName, kind, rawBody, headers) {
  const provider = getProvider(providerName);
  try {
    if (kind === 'payment') provider.verifyPaymentWebhook(rawBody, headers);
    else provider.verifyPayoutWebhook(rawBody, headers);
  } catch (error) {
    await audit(`provider:${provider.name}`, 'webhook.rejected', kind, { reason: error.message });
    return { httpStatus: error.status === 500 ? 500 : 401, body: { error: error.message } };
  }

  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return { httpStatus: 400, body: { error: 'Invalid JSON' } }; }
  const event = kind === 'payment' ? provider.parsePaymentWebhook(parsed) : provider.parsePayoutWebhook(parsed);
  if (!event) return { httpStatus: 200, body: { received: true, ignored: parsed?.type || 'unsupported event' } };

  const id = crypto.createHash('sha256').update(`${provider.name}:${event.eventKey}`).digest('hex');
  const inserted = await query(
    `INSERT INTO webhook_events (id, provider, kind, event_type, reference_id, event)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id, provider.name, kind, event.type, event.reference, JSON.stringify(event)]);
  if (!inserted.rowCount) {
    const { rows } = await query(`SELECT status FROM webhook_events WHERE id=$1`, [id]);
    if (['PROCESSED', 'DEAD_LETTER'].includes(rows[0]?.status)) {
      return { httpStatus: 200, body: { received: true, duplicate: true } };
    }
  }
  return processStoredEvent(id, event);
}

export async function processStoredEvent(id, event) {
  try {
    const result = event.kind === 'payment'
      ? await applyPaymentUpdate({ paymentId: event.reference, status: event.status, providerAttemptId: event.providerAttemptId,
          amountPaise: event.amountPaise, failureReason: event.failureReason, source: 'webhook' })
      : await applyPayoutUpdate({ payoutId: event.reference, status: event.status, statusCode: event.statusCode,
          providerPayoutId: event.providerPayoutId, utr: event.utr, amountPaise: event.amountPaise,
          failureReason: event.failureReason, source: 'webhook' });
    await query(`UPDATE webhook_events SET status='PROCESSED', attempts=attempts+1, processed_at=now(), last_error=$2 WHERE id=$1`,
      [id, result.applied ? null : result.reason]);
    return { httpStatus: 200, body: { received: true, ...result } };
  } catch (error) {
    console.error('Webhook processing failed:', error);
    const { rows } = await query(
      `UPDATE webhook_events SET attempts=attempts+1, last_error=$2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'DEAD_LETTER' ELSE 'FAILED' END
       WHERE id=$1 RETURNING status`, [id, error.message, MAX_WEBHOOK_ATTEMPTS]);
    if (rows[0]?.status === 'DEAD_LETTER') await audit('system', 'webhook.dead_letter', id, { error: error.message });
    // Non-2xx makes the provider redeliver; the stored copy is also retried by the jobs.
    return { httpStatus: 500, body: { error: 'Webhook processing failed; will retry' } };
  }
}

// The simulator delivers its signed webhooks through the same entry point.
setWebhookSink((kind, rawBody, headers) => handleWebhook('internal_simulator', kind, rawBody, headers));
