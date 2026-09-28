import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { query, withTransaction } from './db.js';
import { config } from './config.js';
import { ensureMigrated } from './migrate.js';
import { getProvider } from './providers/index.js';
import { createPayment, refundPayment, publicPayment, checkoutUrl } from './services/payments.js';
import { createPayout, setPayoutAccount, publicPayout } from './services/payouts.js';
import { handleWebhook } from './services/webhooks.js';
import { runJobs } from './services/jobs.js';
import { internalReconciliation, providerReconciliation } from './services/reconciliation.js';
import { rateLimit, audit, clientIp } from './services/security.js';

const app = express();
app.set('trust proxy', true);
app.use(cors());
// Keep the exact raw body: webhook signatures are computed over it.
app.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

const makeId = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const createApiKey = () => `pk_test_${crypto.randomBytes(24).toString('hex')}`;
const hashApiKey = apiKey => crypto.createHash('sha256').update(apiKey).digest('hex');
const bearer = req => req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim() || null;
const baseUrl = req => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
// Wraps async handlers so thrown errors (with .status) become JSON responses.
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function publicMerchant(row) {
  return {
    id: row.id, businessName: row.business_name, ownerName: row.owner_name, email: row.email, phone: row.phone,
    businessType: row.business_type, website: row.website, country: row.country, currency: row.currency,
    webhookUrl: row.webhook_url, status: row.status, paymentProvider: getProvider().name,
    payoutAccount: row.payout_beneficiary_id
      ? { beneficiaryId: row.payout_beneficiary_id, name: row.payout_account_name, accountLast4: row.payout_account_last4, ifsc: row.payout_ifsc }
      : null,
    createdAt: row.created_at
  };
}

async function merchantFromRequest(req, res) {
  const apiKey = bearer(req);
  if (!apiKey) { res.status(401).json({ error: 'Bearer API key required' }); return null; }
  const keyHash = hashApiKey(apiKey);
  const { rows } = await query(
    `SELECT m.* FROM merchants m JOIN api_keys k ON k.merchant_id = m.id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND m.status = 'ACTIVE' LIMIT 1`, [keyHash]);
  if (!rows[0]) { res.status(401).json({ error: 'Invalid or revoked API key' }); return null; }
  query(`UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1`, [keyHash]).catch(() => {});
  return rows[0];
}
const withMerchant = fn => h(async (req, res) => { const m = await merchantFromRequest(req, res); if (m) return fn(req, res, m); });

function requireAdmin(req, res) {
  if (!config.adminApiKey) { res.status(503).json({ error: 'Admin API disabled: set ADMIN_API_KEY' }); return false; }
  if (!safeEqual(bearer(req), config.adminApiKey)) { res.status(401).json({ error: 'Invalid admin key' }); return false; }
  return true;
}
const withAdmin = fn => h(async (req, res) => { if (requireAdmin(req, res)) return fn(req, res); });

// ---------------------------------------------------------------- health / schema
app.get('/health', async (_req, res) => {
  try {
    await ensureMigrated();
    await query('SELECT 1');
    res.json({ status: 'ok', service: 'payflow-api', provider: getProvider().name,
      providerEnv: getProvider().name === 'cashfree' ? config.cashfree.env : 'test', database: 'connected' });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({ status: 'unhealthy', service: 'payflow-api', database: 'unreachable' });
  }
});

app.use('/v1', h(async (_req, _res, next) => { await ensureMigrated(); next(); }));

// Rate limits (Postgres-backed): per API key for merchant calls, per IP for public calls.
app.use('/v1', rateLimit(req => {
  if (req.path.startsWith('/webhooks/')) return null;
  const key = bearer(req);
  return key ? `key:${hashApiKey(key).slice(0, 32)}` : `ip:${clientIp(req)}`;
}, config.rateLimits.apiPerMinute, 60));

// ---------------------------------------------------------------- merchants
app.post('/v1/merchants', rateLimit(req => `onboard:${clientIp(req)}`, config.rateLimits.onboardingPerHour, 3600), h(async (req, res) => {
  const { businessName, ownerName, email, phone = null, businessType = 'ecommerce', website = null,
    country = 'IN', currency = 'INR', webhookUrl = null } = req.body || {};
  if (!businessName || !ownerName || !email) return res.status(400).json({ error: 'businessName, ownerName and email are required' });
  if (!/^\S+@\S+\.\S{2,}$/.test(String(email))) return res.status(400).json({ error: 'email is invalid' });

  const merchantId = makeId('mer');
  const apiKey = createApiKey();
  try {
    const merchant = await withTransaction(async client => {
      const { rows } = await client.query(
        `INSERT INTO merchants (id,business_name,owner_name,email,phone,business_type,website,country,currency,webhook_url,status,payment_provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11) RETURNING *`,
        [merchantId, businessName, ownerName, email, phone, businessType, website, country, currency, webhookUrl, getProvider().name]);
      await client.query(`INSERT INTO api_keys (merchant_id,key_prefix,key_hash,environment) VALUES ($1,$2,$3,'test')`,
        [merchantId, apiKey.slice(0, 18), hashApiKey(apiKey)]);
      await client.query(`INSERT INTO wallets (merchant_id) VALUES ($1)`, [merchantId]);
      await audit(`ip:${clientIp(req)}`, 'merchant.created', merchantId, { email }, client);
      return rows[0];
    });
    res.status(201).json({ merchant: publicMerchant(merchant),
      credentials: { merchantId, apiKey, warning: 'Save this API key now. PayFlow stores only its hash.' } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A merchant with this email already exists' });
    throw error;
  }
}));

app.get('/v1/merchant', withMerchant(async (_req, res, m) => res.json({ merchant: publicMerchant(m) })));

// Registers the merchant's settlement bank account with the payout provider (Cashfree beneficiary).
app.post('/v1/merchant/payout-account', withMerchant(async (req, res, m) => {
  res.status(201).json({ payoutAccount: await setPayoutAccount(m, req.body || {}) });
}));
app.get('/v1/merchant/payout-account', withMerchant(async (_req, res, m) => res.json({ payoutAccount: publicMerchant(m).payoutAccount })));

app.get('/v1/dashboard', withMerchant(async (_req, res, m) => {
  const [wallet, payments, payouts] = await Promise.all([
    query(`SELECT available_paise,pending_paise,updated_at FROM wallets WHERE merchant_id=$1`, [m.id]),
    query(`SELECT * FROM payments WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 20`, [m.id]),
    query(`SELECT * FROM payouts WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 20`, [m.id])
  ]);
  res.json({
    merchant: publicMerchant(m),
    wallet: wallet.rows[0] || { available_paise: 0, pending_paise: 0 },
    payments: payments.rows.map(p => ({ id: p.id, merchant_order_id: p.merchant_order_id, amount_paise: p.amount_paise,
      currency: p.currency, status: p.status, provider: p.provider, failure_reason: p.failure_reason, created_at: p.created_at })),
    payouts: payouts.rows.map(p => ({ id: p.id, amount_paise: p.amount_paise, currency: p.currency, status: p.status,
      status_code: p.status_code, mode: p.mode, provider_payout_id: p.provider_payout_id, utr: p.utr,
      failure_reason: p.failure_reason, created_at: p.created_at })),
    reconciliation: await internalReconciliation(m.id)
  });
}));

// ---------------------------------------------------------------- payments
function listParams(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
  return { limit, status };
}

app.post('/v1/payments', withMerchant(async (req, res, m) => {
  const result = await createPayment(m, req.body, req.header('Idempotency-Key'), baseUrl(req));
  res.status(result.replayed ? 200 : 201).json(result.body);
}));

app.get('/v1/payments', withMerchant(async (req, res, m) => {
  const { limit, status } = listParams(req);
  const { rows } = await query(
    `SELECT * FROM payments WHERE merchant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3`,
    [m.id, status, limit]);
  res.json({ payments: rows.map(publicPayment), count: rows.length });
}));

app.get('/v1/payments/:id', withMerchant(async (req, res, m) => {
  const { rows } = await query(`SELECT * FROM payments WHERE id=$1 AND merchant_id=$2`, [req.params.id, m.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payment not found' });
  const attempts = await query(`SELECT provider_attempt_id,status,failure_reason,created_at FROM payment_attempts
                                WHERE payment_id=$1 ORDER BY id`, [rows[0].id]);
  res.json({ payment: { ...publicPayment(rows[0]), checkoutUrl: checkoutUrl(baseUrl(req), rows[0].id) }, attempts: attempts.rows });
}));

app.post('/v1/payments/:id/refund', withMerchant(async (req, res, m) => res.json(await refundPayment(m, req.params.id))));

// ---------------------------------------------------------------- hosted checkout (customer-facing, public)
app.get('/v1/checkout/:paymentId', rateLimit(req => `checkout:${clientIp(req)}`, config.rateLimits.publicPerMinute, 60), h(async (req, res) => {
  const { rows } = await query(
    `SELECT p.id, p.amount_paise, p.currency, p.status, p.provider, p.checkout_session, p.merchant_order_id, m.business_name
     FROM payments p JOIN merchants m ON m.id = p.merchant_id WHERE p.id=$1`, [req.params.paymentId]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Payment not found' });
  res.json({ paymentId: p.id, merchantName: p.business_name, orderId: p.merchant_order_id, amount: Number(p.amount_paise),
    currency: p.currency, status: p.status, provider: p.provider,
    checkout: p.checkout_session ? JSON.parse(p.checkout_session) : null });
}));

// Simulator only: the "customer" completes the hosted checkout. Delivers a signed webhook.
app.post('/v1/checkout/:paymentId/simulate', rateLimit(req => `checkout:${clientIp(req)}`, config.rateLimits.publicPerMinute, 60), h(async (req, res) => {
  const { rows } = await query(`SELECT * FROM payments WHERE id=$1`, [req.params.paymentId]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Payment not found' });
  if (p.provider !== 'internal_simulator') return res.status(400).json({ error: 'Only simulator payments can be simulated' });
  if (!['PENDING', 'FAILED', 'CANCELLED'].includes(p.status)) return res.status(409).json({ error: `Payment is already ${p.status}` });
  await getProvider('internal_simulator').completePayment(p.id, req.body?.outcome || 'success');
  const after = (await query(`SELECT status FROM payments WHERE id=$1`, [p.id])).rows[0];
  res.json({ paymentId: p.id, status: after.status });
}));

// ---------------------------------------------------------------- wallet / ledger
app.get('/v1/wallet', withMerchant(async (_req, res, m) => {
  const { rows } = await query(`SELECT available_paise,pending_paise,updated_at FROM wallets WHERE merchant_id=$1`, [m.id]);
  res.json({ wallet: rows[0] || { available_paise: 0, pending_paise: 0 } });
}));

app.get('/v1/ledger', withMerchant(async (req, res, m) => {
  const { limit } = listParams(req);
  const { rows } = await query(
    `SELECT txn_id, account, reference_type, reference_id, debit_paise, credit_paise, description, created_at
     FROM ledger_entries WHERE merchant_id=$1 ORDER BY id DESC LIMIT $2`, [m.id, limit]);
  res.json({ entries: rows });
}));

// ---------------------------------------------------------------- payouts
app.post('/v1/payouts', withMerchant(async (req, res, m) => {
  const result = await createPayout(m, req.body, req.header('Idempotency-Key'));
  res.status(result.replayed ? 200 : 201).json(result.body);
}));

app.get('/v1/payouts', withMerchant(async (req, res, m) => {
  const { limit, status } = listParams(req);
  const { rows } = await query(
    `SELECT * FROM payouts WHERE merchant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3`,
    [m.id, status, limit]);
  res.json({ payouts: rows.map(publicPayout), count: rows.length });
}));

app.get('/v1/payouts/:id', withMerchant(async (req, res, m) => {
  const { rows } = await query(`SELECT * FROM payouts WHERE id=$1 AND merchant_id=$2`, [req.params.id, m.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payout not found' });
  res.json({ payout: publicPayout(rows[0]) });
}));

// Simulator only: beneficiary bank returns a completed payout (demonstrates reversal handling).
app.post('/v1/simulator/payouts/:id/reverse', withMerchant(async (req, res, m) => {
  const { rows } = await query(`SELECT * FROM payouts WHERE id=$1 AND merchant_id=$2`, [req.params.id, m.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payout not found' });
  if (rows[0].provider !== 'internal_simulator') return res.status(400).json({ error: 'Only simulator payouts can be reversed here' });
  await getProvider('internal_simulator').reversePayout(rows[0].id);
  res.json({ payout: publicPayout((await query(`SELECT * FROM payouts WHERE id=$1`, [rows[0].id])).rows[0]) });
}));

// ---------------------------------------------------------------- reconciliation
app.get('/v1/reconciliation', withMerchant(async (_req, res, m) => {
  const internal = await internalReconciliation(m.id);
  const [payments, payouts] = await Promise.all([
    query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_paise),0)::bigint AS amount_paise
           FROM payments WHERE merchant_id=$1 GROUP BY status ORDER BY status`, [m.id]),
    query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_paise),0)::bigint AS amount_paise
           FROM payouts WHERE merchant_id=$1 GROUP BY status ORDER BY status`, [m.id])
  ]);
  res.json({ merchantId: m.id, ...internal, payments: payments.rows, payouts: payouts.rows });
}));

app.get('/v1/reconciliation/provider', withMerchant(async (req, res, m) => {
  res.json(await providerReconciliation({ merchantId: m.id, limit: Math.min(Number(req.query.limit) || 50, 100) }));
}));

app.get('/v1/reconciliation/payouts/:id', withMerchant(async (req, res, m) => {
  const { rows } = await query(`SELECT * FROM payouts WHERE id=$1 AND merchant_id=$2`, [req.params.id, m.id]);
  const payout = rows[0];
  if (!payout) return res.status(404).json({ error: 'Payout not found' });
  const ledger = await query(
    `SELECT COALESCE(SUM(credit_paise),0)::bigint AS paid FROM ledger_entries
     WHERE merchant_id=$1 AND reference_type='payout' AND reference_id=$2 AND account='payout_funding'`, [m.id, payout.id]);
  const remote = await getProvider(payout.provider).fetchPayout(payout).catch(e => ({ error: e.message }));
  const checks = {
    providerRecordFound: Boolean(remote && !remote.error),
    providerStatusMatches: remote?.status === payout.status,
    providerAmountMatches: remote?.amountPaise == null || remote.amountPaise === Number(payout.amount_paise),
    ledgerMatchesStatus: payout.status === 'SUCCESS' ? Number(ledger.rows[0].paid) === Number(payout.amount_paise) : true
  };
  res.json({ matched: Object.values(checks).every(Boolean), source: payout.provider, checks,
    provider: remote, payout: publicPayout(payout) });
}));

// ---------------------------------------------------------------- webhooks (PSP -> PayFlow)
function webhookRoute(providerName, kind) {
  return h(async (req, res) => {
    const raw = typeof req.rawBody === 'string' ? req.rawBody : (typeof req.body === 'string' ? req.body : null);
    if (!raw) return res.status(400).json({ error: 'Raw request body unavailable for signature verification' });
    const result = await handleWebhook(providerName, kind, raw, req.headers);
    res.status(result.httpStatus).json(result.body);
  });
}
app.post('/v1/webhooks/cashfree/payments', webhookRoute('cashfree', 'payment'));
app.post('/v1/webhooks/cashfree/payouts', webhookRoute('cashfree', 'payout'));
app.post('/v1/webhooks/simulator/payments', webhookRoute('internal_simulator', 'payment'));
app.post('/v1/webhooks/simulator/payouts', webhookRoute('internal_simulator', 'payout'));

// ---------------------------------------------------------------- admin / operations
app.get('/v1/admin/overview', withAdmin(async (_req, res) => {
  const [merchants, payments, payouts, webhooks, review] = await Promise.all([
    query(`SELECT COUNT(*)::int AS count FROM merchants`),
    query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_paise),0)::bigint AS amount_paise FROM payments GROUP BY status ORDER BY status`),
    query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_paise),0)::bigint AS amount_paise FROM payouts GROUP BY status ORDER BY status`),
    query(`SELECT status, COUNT(*)::int AS count FROM webhook_events GROUP BY status ORDER BY status`),
    query(`SELECT 'payment' AS type, id, merchant_id, amount_paise, status, failure_reason AS reason, updated_at FROM payments WHERE status='MANUAL_REVIEW'
           UNION ALL
           SELECT 'payout', id, merchant_id, amount_paise, status, COALESCE(failure_reason,last_error), updated_at FROM payouts WHERE status='MANUAL_REVIEW'
           ORDER BY updated_at DESC LIMIT 50`)
  ]);
  const deadLetters = await query(`SELECT id, provider, kind, event_type, reference_id, attempts, last_error, received_at
                                   FROM webhook_events WHERE status='DEAD_LETTER' ORDER BY received_at DESC LIMIT 50`);
  res.json({ provider: getProvider().name, merchants: merchants.rows[0].count, payments: payments.rows, payouts: payouts.rows,
    webhooks: webhooks.rows, manualReview: review.rows, deadLetterWebhooks: deadLetters.rows });
}));

app.get('/v1/admin/reconciliation', withAdmin(async (req, res) => {
  const report = await providerReconciliation({ limit: Math.min(Number(req.query.limit) || 100, 200) });
  await audit('admin', 'reconciliation.run', null, report.summary);
  res.json(report);
}));

app.get('/v1/admin/audit', withAdmin(async (_req, res) => {
  const { rows } = await query(`SELECT actor, action, target, details, created_at FROM audit_log ORDER BY id DESC LIMIT 100`);
  res.json({ entries: rows });
}));

app.post('/v1/admin/jobs/run', withAdmin(async (_req, res) => res.json(await runJobs())));

// Vercel Cron (Authorization: Bearer $CRON_SECRET) -> retries, polling, reconciliation.
app.get('/v1/internal/cron', h(async (req, res) => {
  if (!config.cronSecret || !safeEqual(bearer(req), config.cronSecret)) return res.status(401).json({ error: 'Unauthorized' });
  const jobs = await runJobs({ limit: 50 });
  const recon = await providerReconciliation({ limit: 100, sinceHours: 48 });
  await audit('cron', 'reconciliation.run', null, recon.summary);
  res.json({ jobs, reconciliation: recon.summary });
}));

// Unknown routes and unhandled errors always return JSON (never an HTML page).
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500) console.error(error);
  // Don't leak database/internal details to API clients; they are in the server logs.
  res.status(status).json({ error: status < 500 || status === 501 || status === 502 ? error.message : 'Internal server error' });
});

export default app;

// Start an HTTP listener (and the background job loop) only when run directly (Docker / npm start).
// On Vercel the app is imported by api/index.js; jobs run via Vercel Cron or POST /v1/admin/jobs/run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(config.port, () => {
    console.log(`PayFlow API listening on :${config.port} (provider: ${getProvider().name})`);
    if (config.jobsIntervalMs > 0) {
      setInterval(() => runJobs().catch(e => console.error('Jobs failed:', e.message)), config.jobsIntervalMs).unref();
    }
  });
}
