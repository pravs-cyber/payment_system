import { query } from '../db.js';
import { getProvider } from '../providers/index.js';
import { ACCOUNTS } from './ledger.js';

// 1) Internal: wallet balances vs ledger account balances, and every ledger transaction balanced.
export async function internalReconciliation(merchantId) {
  const [wallet, accounts, unbalanced] = await Promise.all([
    query(`SELECT available_paise, pending_paise FROM wallets WHERE merchant_id=$1`, [merchantId]),
    query(`SELECT account, COALESCE(SUM(credit_paise),0)::bigint AS credits, COALESCE(SUM(debit_paise),0)::bigint AS debits
           FROM ledger_entries WHERE merchant_id=$1 GROUP BY account ORDER BY account`, [merchantId]),
    query(`SELECT txn_id FROM ledger_entries WHERE merchant_id=$1 AND txn_id IS NOT NULL
           GROUP BY txn_id HAVING SUM(debit_paise) <> SUM(credit_paise)`, [merchantId])
  ]);
  const w = wallet.rows[0] || { available_paise: 0, pending_paise: 0 };
  const balance = name => {
    const a = accounts.rows.find(r => r.account === name);
    return a ? Number(a.credits) - Number(a.debits) : 0; // liability accounts: credit-normal
  };
  const checks = {
    availableMatchesMerchantPayable: Number(w.available_paise) === balance(ACCOUNTS.MERCHANT_PAYABLE),
    pendingMatchesPayoutInTransit: Number(w.pending_paise) === balance(ACCOUNTS.PAYOUT_IN_TRANSIT),
    allTransactionsBalanced: unbalanced.rowCount === 0
  };
  return {
    matched: Object.values(checks).every(Boolean),
    checks,
    wallet: { availablePaise: Number(w.available_paise), pendingPaise: Number(w.pending_paise) },
    ledgerAccounts: accounts.rows.map(r => ({ account: r.account, creditsPaise: Number(r.credits), debitsPaise: Number(r.debits),
      balancePaise: Number(r.credits) - Number(r.debits) })),
    unbalancedTransactions: unbalanced.rows.map(r => r.txn_id)
  };
}

// 2) External: every payment/payout compared with the provider's own record (Chapter 27:
//    reconciling internal state with the PSP). Statuses and amounts must agree.
const PAYMENT_EQUIV = { REFUNDED: ['REFUNDED', 'SUCCESS'] }; // Cashfree order stays PAID after refund
export async function providerReconciliation({ merchantId = null, limit = 50, sinceHours = 24 * 30 } = {}) {
  const filter = merchantId ? 'AND merchant_id=$3' : '';
  const params = merchantId ? [limit, sinceHours, merchantId] : [limit, sinceHours];
  const [payments, payouts] = await Promise.all([
    query(`SELECT * FROM payments WHERE status <> 'CREATED' AND created_at > now() - make_interval(hours => $2) ${filter}
           ORDER BY created_at DESC LIMIT $1`, params),
    query(`SELECT * FROM payouts WHERE status <> 'CREATED' AND created_at > now() - make_interval(hours => $2) ${filter}
           ORDER BY created_at DESC LIMIT $1`, params)
  ]);

  const compare = async (type, row) => {
    const base = { type, id: row.id, merchantId: row.merchant_id, provider: row.provider,
      internalStatus: row.status, internalAmount: Number(row.amount_paise) };
    try {
      const provider = getProvider(row.provider);
      const remote = type === 'payment' ? await provider.fetchPayment(row) : await provider.fetchPayout(row);
      if (!remote) return { ...base, providerStatus: null, providerAmount: null, result: 'MISSING_AT_PROVIDER' };
      const statusOk = remote.status === row.status || (PAYMENT_EQUIV[row.status] || []).includes(remote.status);
      const amountOk = remote.amountPaise == null || remote.amountPaise === Number(row.amount_paise);
      return { ...base, providerStatus: remote.status, providerRaw: remote.raw, providerAmount: remote.amountPaise,
        result: statusOk && amountOk ? 'MATCH' : 'MISMATCH' };
    } catch (error) {
      return { ...base, providerStatus: null, result: 'PROVIDER_ERROR', error: error.message };
    }
  };

  const items = [];
  const all = [...payments.rows.map(r => ['payment', r]), ...payouts.rows.map(r => ['payout', r])];
  for (let i = 0; i < all.length; i += 5) { // small concurrency to respect provider rate limits
    items.push(...await Promise.all(all.slice(i, i + 5).map(([t, r]) => compare(t, r))));
  }
  const count = r => items.filter(i => i.result === r).length;
  return {
    generatedAt: new Date().toISOString(),
    summary: { total: items.length, matched: count('MATCH'), mismatched: count('MISMATCH'),
      missingAtProvider: count('MISSING_AT_PROVIDER'), providerErrors: count('PROVIDER_ERROR') },
    items
  };
}
