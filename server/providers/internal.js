import crypto from 'node:crypto';

export async function createPayment({ amount, currency, paymentId, simulation = 'success' }) {
  const normalized = String(simulation || 'success').toLowerCase();
  if (normalized === 'timeout') {
    await new Promise(resolve => setTimeout(resolve, 250));
    return { id: `sim_${crypto.randomUUID()}`, status: 'TIMEOUT', amount, currency };
  }

  const statusMap = {
    success: 'SUCCESS',
    pending: 'PENDING',
    failed: 'FAILED'
  };

  return {
    id: `sim_${crypto.randomUUID()}`,
    paymentId,
    status: statusMap[normalized] || 'SUCCESS',
    amount,
    currency
  };
}

export async function refundPayment({ paymentId }) {
  return {
    id: `ref_${crypto.randomUUID()}`,
    paymentId,
    status: 'REFUNDED'
  };
}

export async function createPayout({ amountPaise, mode, referenceId, beneficiary }) {
  const last4 = String(beneficiary.accountNumber).slice(-4);
  return {
    id: `sim_po_${crypto.randomUUID()}`,
    status: 'SUCCESS',
    utr: `SIM${Date.now()}`,
    mode,
    amountPaise,
    referenceId,
    beneficiaryLast4: last4
  };
}

export async function fetchPayout(payoutId) {
  return {
    id: payoutId,
    status: 'SUCCESS',
    utr: `SIM${Date.now()}`
  };
}
