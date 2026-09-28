import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { connectRedis } from './redis.js';
import { getCachedResponse, cacheResponse } from './idempotency.js';
import { getPaymentProvider, getPayoutProvider } from './providers/index.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

function apiKey(req) {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
}

async function merchantFromRequest(req, res) {
  const key = apiKey(req);
  if (!key) { res.status(401).json({ error: 'Bearer API key required' }); return null; }
  const { rows } = await query('SELECT * FROM merchants WHERE api_key = $1 AND active = true', [key]);
  if (!rows[0]) { res.status(401).json({ error: 'Invalid API key' }); return null; }
  return rows[0];
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'payflow-api' }));

app.post('/v1/merchants', async (req, res) => {
  try {
    const { name, email, webhookUrl = null } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
    const id = `mer_${crypto.randomUUID()}`;
    const key = `pk_test_${crypto.randomBytes(24).toString('hex')}`;
    const { rows } = await query(
      'INSERT INTO merchants(id,name,email,api_key,webhook_url) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,api_key,webhook_url',
      [id, name.trim(), email.trim(), key, webhookUrl]
    );
    return res.status(201).json({ merchant: rows[0] });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

app.post('/v1/payments', async (req, res) => {
  const merchant = await merchantFromRequest(req, res); if (!merchant) return;
  try {
    const idem = req.headers['idempotency-key'];
    if (!idem) return res.status(400).json({ error: 'Idempotency-Key is required' });
    const cached = await getCachedResponse(idem); if (cached) return res.status(cached.statusCode).json(cached.body);

    const { amount, currency = 'INR', orderId, behavior = 'success', provider } = req.body || {};
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || !orderId) return res.status(400).json({ error: 'amount and orderId are required' });

    const paymentId = `pay_${crypto.randomUUID()}`;
    const selectedProvider = provider || merchant.payment_provider || config.provider;
    await query('INSERT INTO payments(id,merchant_id,order_id,amount,currency,status,provider,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [paymentId, merchant.id, orderId, Number(amount), currency, 'CREATED', selectedProvider, idem]);

    const result = await getPaymentProvider(selectedProvider).createPayment({ amount: Number(amount), currency, reference: paymentId, behavior });
    await query('UPDATE payments SET provider_payment_id=$1,status=$2,updated_at=NOW() WHERE id=$3', [result.id, result.status, paymentId]);

    if (result.status === 'SUCCESS') {
      await query('BEGIN');
      try {
        await query('INSERT INTO ledger_entries(id,merchant_id,payment_id,type,amount,currency,description) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [`led_${crypto.randomUUID()}`, merchant.id, paymentId, 'CREDIT', Number(amount), currency, 'Payment received']);
        await query('UPDATE wallets SET available_balance=available_balance+$1,updated_at=NOW() WHERE merchant_id=$2', [Number(amount), merchant.id]);
        await query('COMMIT');
      } catch (e) { await query('ROLLBACK'); throw e; }
    }

    const body = { paymentId, merchantId: merchant.id, orderId, amount: Number(amount), currency, status: result.status, provider: selectedProvider, providerPaymentId: result.id };
    const response = { statusCode: 201, body };
    await cacheResponse(idem, response);
    return res.status(201).json(body);
  } catch (error) { console.error(error); return res.status(500).json({ error: error.message }); }
});

app.get('/v1/payments/:id', async (req, res) => {
  const merchant = await merchantFromRequest(req, res); if (!merchant) return;
  const { rows } = await query('SELECT id,order_id,amount,currency,status,provider,provider_payment_id,created_at,updated_at FROM payments WHERE id=$1 AND merchant_id=$2', [req.params.id, merchant.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payment not found' });
  return res.json({ payment: rows[0] });
});

app.post('/v1/payments/:id/refund', async (req, res) => {
  const merchant = await merchantFromRequest(req, res); if (!merchant) return;
  try {
    const { rows } = await query('SELECT * FROM payments WHERE id=$1 AND merchant_id=$2', [req.params.id, merchant.id]);
    const payment = rows[0]; if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status !== 'SUCCESS') return res.status(409).json({ error: 'Only successful payments can be refunded' });
    const amount = Number(req.body?.amount || payment.amount);
    const result = await getPaymentProvider(payment.provider).refund({ paymentId: payment.provider_payment_id, amount, currency: payment.currency });
    await query('UPDATE payments SET status=$1,updated_at=NOW() WHERE id=$2', ['REFUNDED', payment.id]);
    await query('INSERT INTO ledger_entries(id,merchant_id,payment_id,type,amount,currency,description) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [`led_${crypto.randomUUID()}`, merchant.id, payment.id, 'DEBIT', amount, payment.currency, 'Payment refund']);
    await query('UPDATE wallets SET available_balance=available_balance-$1,updated_at=NOW() WHERE merchant_id=$2', [amount, merchant.id]);
    return res.json({ paymentId: payment.id, refund: result, status: 'REFUNDED' });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

app.get('/v1/wallet', async (req, res) => {
  const merchant = await merchantFromRequest(req, res); if (!merchant) return;
  const { rows } = await query('SELECT merchant_id,available_balance,pending_balance,currency FROM wallets WHERE merchant_id=$1', [merchant.id]);
  return res.json({ wallet: rows[0] });
});

app.post('/v1/payouts', async (req, res) => {
  const merchant = await merchantFromRequest(req, res); if (!merchant) return;
  try {
    const idem = req.headers['idempotency-key'];
    if (!idem) return res.status(400).json({ error: 'Idempotency-Key is required' });
    const cached = await getCachedResponse(idem); if (cached) return res.status(cached.statusCode).json(cached.body);
    const amount = Number(req.body?.amount); const currency = req.body?.currency || 'INR';
    const bankAccountLast4 = String(req.body?.bankAccountLast4 || '');
    if (!Number.isFinite(amount) || amount <= 0 || bankAccountLast4.length !== 4) return res.status(400).json({ error: 'amount and bankAccountLast4 are required' });
    const { rows } = await query('SELECT * FROM wallets WHERE merchant_id=$1 FOR UPDATE', [merchant.id]);
    if (!rows[0] || Number(rows[0].available_balance) < amount) return res.status(409).json({ error: 'Insufficient balance' });
    const payoutId = `pout_${crypto.randomUUID()}`;
    const result = await getPayoutProvider().createPayout({ amount, currency, merchantId: merchant.id, bankAccountLast4 });
    await query('UPDATE wallets SET available_balance=available_balance-$1,pending_balance=pending_balance+$1,updated_at=NOW() WHERE merchant_id=$2', [amount, merchant.id]);
    await query('INSERT INTO payouts(id,merchant_id,amount,currency,status,provider,payment_provider_id,bank_account_last4,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [payoutId, merchant.id, amount, currency, result.status, config.payoutProvider, result.id, bankAccountLast4, idem]);
    const body = { payoutId, status: result.status, provider: config.payoutProvider, providerPayoutId: result.id, amount, currency };
    const response = { statusCode: 201, body }; await cacheResponse(idem, response);
    return res.status(201).json(body);
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

app.get('/v1/payouts/:id', async (req, res) => {
  const merchant = await merchantFromRequest(req, res); if (!merchant) return;
  const { rows } = await query('SELECT id,amount,currency,status,provider,payment_provider_id,bank_account_last4,created_at,updated_at FROM payouts WHERE id=$1 AND merchant_id=$2', [req.params.id, merchant.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payout not found' });
  return res.json({ payout: rows[0] });
});

app.get('/v1/reconciliation', async (req, res) => {
  const merchant = await merchantFromRequest(req, res); if (!merchant) return;
  const { rows } = await query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS amount FROM payments WHERE merchant_id=$1 GROUP BY status ORDER BY status`, [merchant.id]);
  return res.json({ merchantId: merchant.id, paymentSummary: rows });
});

app.listen(config.port, async () => {
  await connectRedis();
  console.log(`PayFlow API running on http://localhost:${config.port}`);
  console.log(`Payment provider: ${config.provider}`);
  console.log(`Payout provider: ${config.payoutProvider}`);
});
