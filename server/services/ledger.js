import crypto from 'node:crypto';
import { config } from '../config.js';

// Chart of accounts. Balances are tracked per merchant (merchant_id on every row).
//   psp_clearing          money held for us at the payment provider (pay-ins)
//   platform_fee_revenue  PayFlow's fee
//   merchant_payable      what PayFlow owes the merchant  == wallet.available
//   payout_in_transit     payouts sent to the provider, not yet final == wallet.pending
//   payout_funding        PayFlow's payout account at the provider
export const ACCOUNTS = Object.freeze({
  PSP_CLEARING: 'psp_clearing',
  FEE_REVENUE: 'platform_fee_revenue',
  MERCHANT_PAYABLE: 'merchant_payable',
  PAYOUT_IN_TRANSIT: 'payout_in_transit',
  PAYOUT_FUNDING: 'payout_funding'
});

export function platformFee(grossPaise) {
  return Math.floor((grossPaise * config.platformFeeBps) / 10000);
}

// Writes one balanced double-entry transaction inside the caller's DB transaction.
// entries: [{ account, debit } | { account, credit }]
export async function postTransaction(client, { merchantId, referenceType, referenceId, description, entries }) {
  const lines = entries.filter(e => (e.debit || 0) > 0 || (e.credit || 0) > 0);
  const debits = lines.reduce((s, e) => s + (e.debit || 0), 0);
  const credits = lines.reduce((s, e) => s + (e.credit || 0), 0);
  if (!lines.length || debits !== credits) {
    throw new Error(`Unbalanced ledger transaction for ${referenceType} ${referenceId}: ${debits} != ${credits}`);
  }
  const txnId = `txn_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
  for (const line of lines) {
    await client.query(
      `INSERT INTO ledger_entries
         (merchant_id, txn_id, account, reference_type, reference_id, debit_paise, credit_paise, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [merchantId, txnId, line.account, referenceType, referenceId, line.debit || 0, line.credit || 0, description]
    );
  }
  return txnId;
}
