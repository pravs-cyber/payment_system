import { config, requireEnv } from '../config.js';

const BASE = 'https://api.razorpay.com/v1';

function authHeaders(extra = {}) {
  const key = requireEnv('RAZORPAYX_KEY_ID', config.razorpayxKeyId);
  const secret = requireEnv('RAZORPAYX_KEY_SECRET', config.razorpayxKeySecret);
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  return { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...extra };
}

/**
 * Uses RazorpayX's composite payout endpoint so a merchant integration only
 * needs one PayFlow payout call. RazorpayX creates/uses the contact and fund
 * account and then creates the payout.
 */
export async function createBankPayout({
  amountPaise, name, email, phone, accountNumber, ifsc,
  referenceId, mode = 'IMPS', purpose = 'payout', idempotencyKey
}) {
  const accountNumberForRazorpayX = requireEnv(
    'RAZORPAYX_ACCOUNT_NUMBER',
    config.razorpayxAccountNumber
  );

  const response = await fetch(`${BASE}/payouts`, {
    method: 'POST',
    headers: authHeaders({ 'X-Payout-Idempotency': idempotencyKey }),
    body: JSON.stringify({
      account_number: accountNumberForRazorpayX,
      amount: amountPaise,
      currency: 'INR',
      mode,
      purpose,
      reference_id: referenceId,
      fund_account: {
        account_type: 'bank_account',
        bank_account: {
          name,
          ifsc,
          account_number: accountNumber
        },
        contact: {
          name,
          email,
          contact: phone,
          type: 'customer',
          reference_id: referenceId
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.description || JSON.stringify(data));
  }
  return data;
}

export async function fetchPayout(payoutId) {
  const response = await fetch(`${BASE}/payouts/${encodeURIComponent(payoutId)}`, {
    headers: authHeaders()
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.description || 'Payout lookup failed');
  return data;
}
