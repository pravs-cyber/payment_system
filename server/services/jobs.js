import { query } from '../db.js';
import { getProvider } from '../providers/index.js';
import { applyPaymentUpdate } from './payments.js';
import { applyPayoutUpdate, submitPayout, MAX_PAYOUT_ATTEMPTS } from './payouts.js';
import { processStoredEvent, MAX_WEBHOOK_ATTEMPTS } from './webhooks.js';
import { audit } from './security.js';

const MAX_PAYMENT_POLLS = 12;
const backoff = n => Math.min(30 * 2 ** Math.max(0, n - 1), 3600);

// Background work (Chapter 27: retry queue + dead-letter queue), implemented as a
// Postgres-backed job so it runs the same on Docker (interval) and Vercel (cron / admin trigger):
//  1. payouts: check status of in-flight transfers, resubmit ones the provider never received,
//     move unconfirmable ones to MANUAL_REVIEW (dead letter) after MAX_PAYOUT_ATTEMPTS;
//  2. payments: poll the provider for payments whose webhook may have been missed;
//  3. webhooks: re-apply stored events whose processing failed.
let running = false;
export async function runJobs({ limit = 25 } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const summary = { payoutsChecked: 0, payoutsResubmitted: 0, payoutsToReview: 0, paymentsPolled: 0, paymentsUpdated: 0,
    webhooksRetried: 0, errors: [] };
  try {
    const payouts = await query(
      `SELECT * FROM payouts WHERE status IN ('CREATED','PROCESSING')
         AND (next_retry_at IS NULL OR next_retry_at <= now()) AND updated_at <= now() - interval '5 seconds'
       ORDER BY updated_at LIMIT $1`, [limit]);
    for (const p of payouts.rows) {
      summary.payoutsChecked++;
      try {
        if (p.attempts >= MAX_PAYOUT_ATTEMPTS) {
          await applyPayoutUpdate({ payoutId: p.id, status: 'MANUAL_REVIEW',
            failureReason: `Unconfirmed after ${p.attempts} attempts: ${p.last_error || 'no terminal status'}`, source: 'jobs' });
          summary.payoutsToReview++;
          continue;
        }
        const remote = await getProvider(p.provider).fetchPayout(p);
        if (!remote) { await submitPayout(p); summary.payoutsResubmitted++; continue; } // never reached the provider
        await applyPayoutUpdate({ payoutId: p.id, ...remote, source: 'poll' });
        if (remote.status === 'PROCESSING') {
          await query(`UPDATE payouts SET attempts=attempts+1, next_retry_at = now() + make_interval(secs => $2) WHERE id=$1`,
            [p.id, backoff(p.attempts + 1)]);
        }
      } catch (error) {
        summary.errors.push(`${p.id}: ${error.message}`);
        await query(`UPDATE payouts SET attempts=attempts+1, last_error=$2, next_retry_at = now() + make_interval(secs => $3) WHERE id=$1`,
          [p.id, error.message, backoff(p.attempts + 1)]);
      }
    }

    const payments = await query(
      `SELECT * FROM payments WHERE status IN ('PENDING','FAILED','CANCELLED') AND next_poll_at IS NOT NULL AND next_poll_at <= now()
       ORDER BY next_poll_at LIMIT $1`, [limit]);
    for (const p of payments.rows) {
      summary.paymentsPolled++;
      try {
        const remote = await getProvider(p.provider).fetchPayment(p);
        if (remote && remote.status && remote.status !== p.status && remote.status !== 'REFUNDED') {
          const r = await applyPaymentUpdate({ paymentId: p.id, status: remote.status, providerAttemptId: remote.providerAttemptId,
            amountPaise: remote.status === 'SUCCESS' ? remote.amountPaise : null, failureReason: remote.failureReason, source: 'poll' });
          if (r.applied) summary.paymentsUpdated++;
        }
        const attempts = p.poll_attempts + 1;
        await query(
          `UPDATE payments SET poll_attempts=$2,
                  next_poll_at = CASE WHEN status IN ('PENDING','FAILED','CANCELLED') AND $2 < $3
                                      THEN now() + make_interval(secs => $4) ELSE NULL END
           WHERE id=$1`, [p.id, attempts, MAX_PAYMENT_POLLS, backoff(attempts)]);
      } catch (error) {
        summary.errors.push(`${p.id}: ${error.message}`);
        await query(`UPDATE payments SET poll_attempts=poll_attempts+1, next_poll_at = now() + interval '5 minutes' WHERE id=$1`, [p.id]);
      }
    }

    const events = await query(
      `SELECT id, event FROM webhook_events WHERE status='FAILED' AND attempts < $1 ORDER BY received_at LIMIT $2`,
      [MAX_WEBHOOK_ATTEMPTS, limit]);
    for (const e of events.rows) { summary.webhooksRetried++; await processStoredEvent(e.id, e.event); }

    await query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'`);
    await query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
    if (summary.payoutsToReview) await audit('system', 'jobs.dead_lettered', null, { payouts: summary.payoutsToReview });
    return summary;
  } finally {
    running = false;
  }
}
