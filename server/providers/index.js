import { config } from '../config.js';
import { cashfreeProvider } from './cashfree.js';
import { simulatorProvider } from './internal.js';

// PayFlow is provider-agnostic: every provider implements the same interface
// (createPayment, fetchPayment, refundPayment, verify*/parse* webhooks,
// createBeneficiary, createPayout, fetchPayout). PAYMENT_PROVIDER selects the
// one used for NEW payments/payouts; existing records keep the provider they
// were created with, so webhooks, polling and reconciliation always use the right one.
const providers = {
  cashfree: cashfreeProvider,
  internal_simulator: simulatorProvider,
  simulator: simulatorProvider
};

export function getProvider(name = config.paymentProvider) {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown payment provider: ${name}`);
  return provider;
}

export function activeProviderName() {
  return getProvider().name;
}
