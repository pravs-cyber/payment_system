import crypto from 'node:crypto';

export class PayoutSimulator {
  async createPayout({ amount, currency, merchantId, bankAccountLast4 }) {
    return {
      id: `pout_${crypto.randomUUID()}`,
      merchantId,
      amount,
      currency,
      bankAccountLast4,
      status: 'PROCESSING',
      utr: null
    };
  }
}
