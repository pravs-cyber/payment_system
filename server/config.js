import 'dotenv/config';

// Accept the variable names used locally (DATABASE_URL) and the ones the
// Vercel <-> Supabase integration injects (POSTGRES_URL, POSTGRES_URL_NON_POOLING).
const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

const rawProvider = (process.env.PAYMENT_PROVIDER || 'simulator').trim().toLowerCase();
const paymentProvider = ['internal', 'internal_simulator', 'simulator'].includes(rawProvider) ? 'simulator' : rawProvider;

const cashfreeEnv = (process.env.CASHFREE_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;

export const config = {
  port: Number(process.env.PORT || 8000),
  databaseUrl,
  isVercel: Boolean(process.env.VERCEL),
  autoMigrate: process.env.AUTO_MIGRATE !== 'false',

  // 'simulator' (default, offline) or 'cashfree' (real PSP sandbox/production)
  paymentProvider,
  // Used to build webhook (notify) and customer return URLs sent to the PSP.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || (vercelUrl ? `https://${vercelUrl}` : '')).replace(/\/$/, ''),
  platformFeeBps: Number(process.env.PLATFORM_FEE_BPS || 100), // 100 bps = 1%

  cashfree: {
    env: cashfreeEnv,
    baseUrl: (process.env.CASHFREE_BASE_URL ||
      (cashfreeEnv === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com')).replace(/\/$/, ''),
    pgClientId: process.env.CASHFREE_PG_CLIENT_ID?.trim(),
    pgClientSecret: process.env.CASHFREE_PG_CLIENT_SECRET?.trim(),
    pgApiVersion: process.env.CASHFREE_PG_API_VERSION || '2025-01-01',
    payoutClientId: process.env.CASHFREE_PAYOUT_CLIENT_ID?.trim(),
    payoutClientSecret: process.env.CASHFREE_PAYOUT_CLIENT_SECRET?.trim(),
    // Needed on Vercel (dynamic IPs): Payouts 2FA via RSA public key -> X-Cf-Signature.
    payoutPublicKey: process.env.CASHFREE_PAYOUT_PUBLIC_KEY?.replace(/\\n/g, '\n').trim(),
    payoutApiVersion: process.env.CASHFREE_PAYOUT_API_VERSION || '2024-01-01'
  },

  simulatorWebhookSecret: process.env.SIMULATOR_WEBHOOK_SECRET || 'payflow-simulator-dev-secret',
  adminApiKey: process.env.ADMIN_API_KEY?.trim(),
  cronSecret: process.env.CRON_SECRET?.trim(),
  jobsIntervalMs: Number(process.env.JOBS_INTERVAL_MS || 15000),

  rateLimits: {
    apiPerMinute: Number(process.env.RATE_LIMIT_API_PER_MIN || 300),
    onboardingPerHour: Number(process.env.RATE_LIMIT_ONBOARD_PER_HOUR || 20),
    publicPerMinute: Number(process.env.RATE_LIMIT_PUBLIC_PER_MIN || 120)
  }
};
