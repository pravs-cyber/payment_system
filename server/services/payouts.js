import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../providers/cashfree-format.js';
import { ACCOUNTS, postTransaction } from './ledger.js';
import { getIdempotent, saveIdempotent } from './idempotency.js';
import { audit } from './security.js';

// Payout state machine.
//   CREATED       funds reserved (available -> pending), not yet accepted by the provider
//   PROCESSING    accepted by the provider, awaiting a terminal result (webhook or polling)
//   SUCCESS       money credited to the merchant's bank (Cashfree SUCCESS + COMPLETED)
//   FAILED        provider/bank rejected it; reservation released back to available
//   REVERSED      bank returned the money after SUCCESS; credited back to available
//   MANUAL_REVIEW outcome could not be confirmed after max retries (dead letter). Funds
//                 stay reserved: releasing them without confirmation could pay out twice.
export const PAYOUT_TRANSITIONS = {
  CREATED: ['PROCESSING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW'],
  PROCESSING: ['SUCCESS', 'FAILED', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: ['PROCESSING', 'SUCCESS', 'FAILED'],
  SUCCESS: ['REVERSED'],
  FAILED: [],
  REVERSED: []
};
export const MAX_PAYOUT_ATTEMPTS = 8;
const backoffSeconds = attempts => Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);
const makeId = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const httpError = (status, message) => Object.assign(new Error(message), { status });

export async function setPayoutAccount(merchant, { name, accountNumber, ifsc, email, phone } = {}) {
  const acct = String(accountNumber || '').replace(/\s/g, '');
  const code = String(ifsc || '').toUpperCase();
  if (!name || String(name).trim().length < 3) throw httpError(400, 'Account holder name is required');
  if (!/^\d{6,18}$/.test(acct)) throw httpError(400, 'accountNumber must be 6-18 digits');
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) throw httpError(400, 'ifsc is invalid');
  const beneficiaryId = `bene_${merchant.id.slice(4, 16)}_${crypto.randomBytes(3).toString('hex')}`;
  // The full account number goes only to the provider; PayFlow keeps the last 4 digits.
  await getProvider().createBeneficiary({
    beneficiaryId, name: String(name).trim(), accountNumber: acct, ifsc: code,
    email: email || merchant.email, phone: phone || merchant.phone
  });
  await query(
    `UPDATE merchants SET payout_beneficiary_id=$2, payout_account_name=$3, payout_account_last4=$4, payout_ifsc=$5,
            provider_account_id=$2 WHERE id=$1`,
    [merchant.id, beneficiaryId, String(name).trim(), acct.slice(-4), code]);
  await audit(`merchant:${merchant.id}`, 'payout_account.set', merchant.id, { beneficiaryId, last4: acct.slice(-4), ifsc: code });
  return { beneficiaryId, name: String(name).trim(), accountLast4: acct.slice(-4), ifsc: code };
}

export function publicPayout(p) {
  return {
    payoutId: p.id, amount: Number(p.amount_paise), currency: p.currency, status: p.status, statusCode: p.status_code,
    mode: p.mode, provider: p.provider, providerPayoutId: p.provider_payout_id, utr: p.utr,
    failureReason: p.failure_reason, attempts: p.attempts, createdAt: p.created_at, updatedAt: p.updated_at
  };
}

export async function createPayout(merchant, body, idempotencyKey) {
  if (!idempotencyKey) throw httpError(400, 'Idempotency-Key header is required');
  const cacheKey = `${merchant.id}:payout:${idempotencyKey}`;
  const cached = await getIdempotent(cacheKey);
  if (cached) return { replayed: true, body: cached };

  const amountPaise = Number(body?.amount);
  if (!Number.isInteger(amountPaise) || amountPaise < 100) throw httpError(400, 'amount must be an integer in paise, at least 100');
  const mode = String(body?.mode || 'IMPS').toUpperCase();
  if (!['IMPS', 'NEFT', 'RTGS', 'UPI', 'BANKTRANSFER'].includes(mode)) throw httpError(400, 'mode must be IMPS, NEFT, RTGS, UPI or BANKTRANSFER');

  // Backwards compatible: an inline beneficiary registers the payout account first.
  if (body?.beneficiary && !merchant.payout_beneficiary_id) {
    const b = body.beneficiary;
    const acct = await setPayoutAccount(merchant, { name: b.name, accountNumber: b.accountNumber, ifsc: b.ifsc });
    merchant = { ...merchant, payout_beneficiary_id: acct.beneficiaryId };
  }
  if (!merchant.payout_beneficiary_id) throw httpError(400, 'Register a payout bank account first (POST /v1/merchant/payout-account)');

  const payoutId = makeId('po');
  let payout;
  try {
    payout = await withTransaction(async client => {
      const w = await client.query(
        `UPDATE wallets SET available_paise = available_paise - $2, pending_paise = pending_paise + $2, updated_at=now()
         WHERE merchant_id=$1 AND available_paise >= $2 RETURNING *`, [merchant.id, amountPaise]);
      if (!w.rowCount) throw httpError(409, 'Insufficient merchant balance');
      const { rows } = await client.query(
        `INSERT INTO payouts (id, merchant_id, amount_paise, currency, status, mode, provider, reference_id, beneficiary_id, idempotency_key)
         VALUES ($1,$2,$3,'INR','CREATED',$4,$5,$1,$6,$7) RETURNING *`,
        [payoutId, merchant.id, amountPaise, mode, getProvider().name, merchant.payout_beneficiary_id, idempotencyKey]);
      await postTransaction(client, {
        merchantId: merchant.id, referenceType: 'payout', referenceId: payoutId, description: 'Payout requested (funds reserved)',
        entries: [{ account: ACCOUNTS.MERCHANT_PAYABLE, debit: amountPaise }, { account: ACCOUNTS.PAYOUT_IN_TRANSIT, credit: amountPaise }]
      });
      return rows[0];
    });
  } catch (error) {
    if (error.code === '23505') { // same Idempotency-Key raced: return the existing payout
      const { rows } = await query(`SELECT * FROM payouts WHERE merchant_id=$1 AND idempotency_key=$2`, [merchant.id, idempotencyKey]);
      if (rows[0]) return { replayed: true, body: publicPayout(rows[0]) };
    }
    throw error;
  }
  await audit(`merchant:${merchant.id}`, 'payout.requested', payoutId, { amountPaise, mode });

  payout = await submitPayout(payout);
  const response = publicPayout(payout);
  await saveIdempotent(cacheKey, response);
  return { replayed: false, body: response };
}

// Sends the transfer to the provider. The provider dedupes on transfer_id (= payout id),
// so resubmitting the same payout can never create a second transfer.
export async function submitPayout(payout) {
  const provider = getProvider(payout.provider);
  await query(`UPDATE payouts SET attempts = attempts + 1, updated_at=now() WHERE id=$1`, [payout.id]);
  try {
    const result = await provider.createPayout({ payout, beneficiaryId: payout.beneficiary_id });
    await applyPayoutUpdate({ payoutId: payout.id, ...result, source: 'submit' });
    if (result.afterAccept) await result.afterAccept(); // simulator: delivers its signed webhook
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error.retryable || error.status === 409) {
      // Outcome unknown (timeout/5xx) or transfer already exists: per Cashfree guidance, do not
      // resend blindly. Mark PROCESSING; the retry job checks the transfer status first.
      await query(
        `UPDATE payouts SET status = CASE WHEN status='CREATED' THEN 'PROCESSING' ELSE status END,
                last_error=$2, next_retry_at = now() + make_interval(secs => $3), updated_at=now() WHERE id=$1`,
        [payout.id, error.message, 30]);
    } else {
      await applyPayoutUpdate({ payoutId: payout.id, status: 'FAILED', failureReason: error.message, source: 'submit' });
    }
  }
  return (await query(`SELECT * FROM payouts WHERE id=$1`, [payout.id])).rows[0];
}

export async function applyPayoutUpdate({ payoutId, status, statusCode = null, providerPayoutId = null, utr = null,
  amountPaise = null, failureReason = null, source }) {
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT * FROM payouts WHERE id=$1 FOR UPDATE`, [payoutId]);
    const payout = rows[0];
    if (!payout) return { applied: false, reason: 'unknown payout' };
    const amount = Number(payout.amount_paise);

    if (status === payout.status) {
      await client.query(
        `UPDATE payouts SET status_code=COALESCE($2,status_code), provider_payout_id=COALESCE($3,provider_payout_id),
                utr=COALESCE($4,utr), updated_at=now(),
                next_retry_at = CASE WHEN status='PROCESSING' THEN COALESCE(next_retry_at, now() + interval '60 seconds') ELSE next_retry_at END
         WHERE id=$1`, [payoutId, statusCode, providerPayoutId, utr]);
      return { applied: false, reason: 'no change', status };
    }
    let target = status;
    let reason = failureReason;
    if (target === 'SUCCESS' && amountPaise != null && amountPaise !== amount) {
      target = 'MANUAL_REVIEW';
      reason = `Amount mismatch: provider reported ${amountPaise}, expected ${amount}`;
    }
    if (!(PAYOUT_TRANSITIONS[payout.status] || []).includes(target)) {
      return { applied: false, reason: `illegal transition ${payout.status} -> ${target}` };
    }

    await client.query(
      `UPDATE payouts SET status=$2, status_code=COALESCE($3,status_code), provider_payout_id=COALESCE($4,provider_payout_id),
              utr=COALESCE($5,utr), failure_reason=$6, updated_at=now(),
              next_retry_at = CASE WHEN $2='PROCESSING' THEN now() + interval '60 seconds' ELSE NULL END
       WHERE id=$1`,
      [payoutId, target, statusCode, providerPayoutId, utr, ['FAILED', 'REVERSED', 'MANUAL_REVIEW'].includes(target) ? reason : null]);

    const m = payout.merchant_id;
    if (target === 'SUCCESS') {
      await client.query(`UPDATE wallets SET pending_paise = pending_paise - $2, updated_at=now() WHERE merchant_id=$1`, [m, amount]);
      await postTransaction(client, { merchantId: m, referenceType: 'payout', referenceId: payoutId, description: 'Payout completed',
        entries: [{ account: ACCOUNTS.PAYOUT_IN_TRANSIT, debit: amount }, { account: ACCOUNTS.PAYOUT_FUNDING, credit: amount }] });
    } else if (target === 'FAILED') {
      await client.query(`UPDATE wallets SET pending_paise = pending_paise - $2, available_paise = available_paise + $2, updated_at=now()
                          WHERE merchant_id=$1`, [m, amount]);
      await postTransaction(client, { merchantId: m, referenceType: 'payout', referenceId: payoutId, description: 'Payout failed, funds released',
        entries: [{ account: ACCOUNTS.PAYOUT_IN_TRANSIT, debit: amount }, { account: ACCOUNTS.MERCHANT_PAYABLE, credit: amount }] });
    } else if (target === 'REVERSED') {
      await client.query(`UPDATE wallets SET available_paise = available_paise + $2, updated_at=now() WHERE merchant_id=$1`, [m, amount]);
      await postTransaction(client, { merchantId: m, referenceType: 'payout', referenceId: payoutId, description: 'Payout reversed by bank',
        entries: [{ account: ACCOUNTS.PAYOUT_FUNDING, debit: amount }, { account: ACCOUNTS.MERCHANT_PAYABLE, credit: amount }] });
    } else if (target === 'MANUAL_REVIEW') {
      await audit('system', 'payout.manual_review', payoutId, { reason, source }, client);
    }
    return { applied: true, from: payout.status, to: target };
  });
}
