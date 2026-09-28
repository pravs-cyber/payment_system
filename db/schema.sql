CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  business_type TEXT NOT NULL DEFAULT 'ecommerce',
  website TEXT,
  country TEXT NOT NULL DEFAULT 'IN',
  currency TEXT NOT NULL DEFAULT 'INR',
  webhook_url TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')),
  payment_provider TEXT NOT NULL DEFAULT 'simulator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL DEFAULT 'test',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wallets (
  merchant_id TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  available_paise BIGINT NOT NULL DEFAULT 0,
  pending_paise BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  merchant_order_id TEXT NOT NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL,
  provider TEXT,
  provider_payment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, merchant_order_id)
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT,
  provider_payout_id TEXT,
  reference_id TEXT,
  utr TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  debit_paise BIGINT NOT NULL DEFAULT 0,
  credit_paise BIGINT NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((debit_paise = 0) <> (credit_paise = 0))
);

CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_merchant ON payouts(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_merchant ON ledger_entries(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_keys_merchant ON api_keys(merchant_id);

-- Idempotency responses for POST /v1/payments and POST /v1/payouts (replaces Redis).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Supabase exposes the public schema through its REST Data API using the
-- publishable/anon key. Enabling RLS with no policies blocks that path entirely;
-- the PayFlow API connects as the table owner, which is unaffected by RLS.
-- (Harmless on the local Docker Postgres.)
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Provider integration (Cashfree / simulator), state machines, double-entry
-- ledger, webhooks, retries, reconciliation, security. All statements are
-- idempotent so this file can be re-run against an existing database.
-- ---------------------------------------------------------------------------
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS provider_account_id TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payout_beneficiary_id TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payout_account_name TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payout_account_last4 TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payout_ifsc TEXT;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_order_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_session TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS customer_ref TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS poll_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ;

ALTER TABLE payouts ADD COLUMN IF NOT EXISTS beneficiary_id TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS status_code TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Idempotency enforced by the database, not just the response cache.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_idem ON payouts(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_poll ON payments(next_poll_at) WHERE next_poll_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payouts_retry ON payouts(next_retry_at) WHERE next_retry_at IS NOT NULL;

-- Double-entry: every entry belongs to an account and a transaction; each
-- transaction's debits equal its credits. Pre-existing rows default to the
-- merchant_payable account and have no txn_id.
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS account TEXT NOT NULL DEFAULT 'merchant_payable';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS txn_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ledger_txn ON ledger_entries(txn_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(merchant_id, account);

-- Every payment attempt reported by the provider (a Cashfree order can have
-- several attempts; a failed attempt can be followed by a successful one).
CREATE TABLE IF NOT EXISTS payment_attempts (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider_attempt_id TEXT,
  status TEXT NOT NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attempts_payment ON payment_attempts(payment_id);

-- Webhook inbox: dedupes deliveries (exactly-once processing), keeps the
-- verified event for retries, and parks poison events as DEAD_LETTER.
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_type TEXT,
  reference_id TEXT,
  event JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webhooks_status ON webhook_events(status, received_at);

-- Provider-side records kept by the internal simulator, so reconciliation
-- compares PayFlow against an independent source even without Cashfree.
CREATE TABLE IF NOT EXISTS simulator_records (
  kind TEXT NOT NULL,
  reference TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL,
  status_code TEXT,
  amount_paise BIGINT NOT NULL,
  utr TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, reference)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulator_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
