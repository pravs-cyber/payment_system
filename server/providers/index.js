import { config } from '../config.js';
import { InternalPaymentProvider } from './internal.js';
import { PayoutSimulator } from './payout-simulator.js';

// PayFlow is provider-agnostic. For the hackathon we use the built-in
// simulator so no external payment account is required.
export function getPaymentProvider() {
  return new InternalPaymentProvider();
}

export function getPayoutProvider() {
  return new PayoutSimulator();
}
