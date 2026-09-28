import 'dotenv/config';

// Accept the variable names used locally (DATABASE_URL) and the ones the
// Vercel <-> Supabase integration injects (POSTGRES_URL, POSTGRES_URL_NON_POOLING).
const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

export const config = {
  port: Number(process.env.PORT || 8000),
  databaseUrl,
  paymentProvider: process.env.PAYMENT_PROVIDER || 'simulator',
  isVercel: Boolean(process.env.VERCEL)
};
