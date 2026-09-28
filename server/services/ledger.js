import { withTransaction } from '../db.js';

// 1% platform fee, kept by PayFlow at capture time.
export function platformFee(grossPaise) {
  return Math.floor(grossPaise * 0.01);
}

// Records a captured payment in the merchant ledger and credits the wallet atomically.
// Ledger: CREDIT gross, DEBIT platform fee  =>  net ledger movement == wallet credit,
// which is what /v1/reconciliation checks.
export async function postPaymentLedger({ merchantId, paymentId, grossPaise }) {
  const fee = platformFee(grossPaise);
  const merchantCredit = grossPaise - fee;

  return withTransaction(async client => {
    const { rows } = await client.query(
      `INSERT INTO ledger_entries
       (merchant_id, reference_type, reference_id, debit_paise, credit_paise, description)
       VALUES ($1,'payment',$2,0,$3,'Payment captured (gross)'), ($1,'fee',$2,$4,0,'PayFlow platform fee')
       RETURNING *`,
      [merchantId, paymentId, grossPaise, fee]
    );

    await client.query(
      `INSERT INTO wallets (merchant_id, available_paise)
       VALUES ($1,$2)
       ON CONFLICT (merchant_id)
       DO UPDATE SET available_paise = wallets.available_paise + EXCLUDED.available_paise,
                     updated_at = now()`,
      [merchantId, merchantCredit]
    );

    return rows;
  });
}

export async function reserveForPayout(client, merchantId, amountPaise) {
  const result = await client.query(
    `UPDATE wallets
     SET available_paise = available_paise - $2,
         pending_paise = pending_paise + $2,
         updated_at = now()
     WHERE merchant_id = $1 AND available_paise >= $2
     RETURNING *`,
    [merchantId, amountPaise]
  );
  if (!result.rowCount) throw new Error('Insufficient merchant balance');
  return result.rows[0];
}

export async function settlePayout(client, merchantId, amountPaise, success, payoutId = null) {
  if (success) {
    await client.query(
      `UPDATE wallets SET pending_paise = pending_paise - $2, updated_at = now()
       WHERE merchant_id = $1`,
      [merchantId, amountPaise]
    );
    if (payoutId) {
      await client.query(
        `INSERT INTO ledger_entries (merchant_id,reference_type,reference_id,debit_paise,credit_paise,description)
         VALUES ($1,'payout',$2,$3,0,'Merchant payout completed')`,
        [merchantId, payoutId, amountPaise]
      );
    }
  } else {
    await client.query(
      `UPDATE wallets SET pending_paise = pending_paise - $2,
       available_paise = available_paise + $2, updated_at = now()
       WHERE merchant_id = $1`,
      [merchantId, amountPaise]
    );
    // No ledger entry: the ledger is only debited when a payout settles successfully,
    // so releasing the reservation back to available balance needs no reversal.
  }
}
