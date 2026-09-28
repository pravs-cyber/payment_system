import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { query, withTransaction } from './db.js';
import { getIdempotent, saveIdempotent } from './services/idempotency.js';
import { postPaymentLedger, reserveForPayout, settlePayout, platformFee } from './services/ledger.js';
import { createPayment as simulatePayment, refundPayment as simulateRefund, createPayout as simulatePayout } from './providers/internal.js';
import { config } from './config.js';

const app = express();
app.use(cors());
app.use(express.json());

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function createApiKey() {
  return `pk_test_${crypto.randomBytes(24).toString('hex')}`;
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function publicMerchant(row) {
  return {
    id: row.id,
    businessName: row.business_name,
    ownerName: row.owner_name,
    email: row.email,
    phone: row.phone,
    businessType: row.business_type,
    website: row.website,
    country: row.country,
    currency: row.currency,
    webhookUrl: row.webhook_url,
    status: row.status,
    paymentProvider: row.payment_provider,
    createdAt: row.created_at
  };
}

async function merchantFromRequest(req, res) {
  const authorization = req.header('Authorization');
  const apiKey = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!apiKey) {
    res.status(401).json({ error: 'Bearer API key required' });
    return null;
  }

  const keyHash = hashApiKey(apiKey);
  const { rows } = await query(
    `SELECT m.*
     FROM merchants m
     JOIN api_keys k ON k.merchant_id = m.id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND m.status = 'ACTIVE'
     LIMIT 1`,
    [keyHash]
  );

  if (!rows[0]) {
    res.status(401).json({ error: 'Invalid or revoked API key' });
    return null;
  }

  await query(`UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1`, [keyHash]);
  return rows[0];
}

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', service: 'payflow-api', provider: config.paymentProvider, database: 'connected' });
  } catch (error) {
    console.error('Health check database error:', error.message);
    res.status(503).json({ status: 'unhealthy', service: 'payflow-api', database: 'unreachable' });
  }
});

// Public merchant onboarding endpoint. In production this would also include KYC/business verification.
app.post('/v1/merchants', async (req, res) => {
  try {
    const {
      businessName,
      ownerName,
      email,
      phone = null,
      businessType = 'ecommerce',
      website = null,
      country = 'IN',
      currency = 'INR',
      webhookUrl = null
    } = req.body || {};

    if (!businessName || !ownerName || !email) {
      return res.status(400).json({ error: 'businessName, ownerName and email are required' });
    }

    const merchantId = makeId('mer');
    const apiKey = createApiKey();
    const keyHash = hashApiKey(apiKey);

    const result = await withTransaction(async client => {
      const merchant = await client.query(
        `INSERT INTO merchants
         (id,business_name,owner_name,email,phone,business_type,website,country,currency,webhook_url,status,payment_provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE','simulator')
         RETURNING *`,
        [merchantId, businessName, ownerName, email, phone, businessType, website, country, currency, webhookUrl]
      );

      await client.query(
        `INSERT INTO api_keys (merchant_id,key_prefix,key_hash,environment)
         VALUES ($1,$2,$3,'test')`,
        [merchantId, apiKey.slice(0, 18), keyHash]
      );

      await client.query(`INSERT INTO wallets (merchant_id) VALUES ($1)`, [merchantId]);
      return merchant.rows[0];
    });

    res.status(201).json({
      merchant: publicMerchant(result),
      credentials: {
        merchantId,
        apiKey,
        warning: 'Save this API key now. PayFlow stores only its hash.'
      }
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A merchant with this email already exists' });
    console.error(error);
    res.status(500).json({ error: 'Merchant onboarding failed' });
  }
});

app.get('/v1/merchant', async (req, res) => {
  try {
    const merchant = await merchantFromRequest(req, res);
    if (merchant) res.json({ merchant: publicMerchant(merchant) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to load merchant' });
  }
});

app.get('/v1/dashboard', async (req, res) => {
  try {
    const merchant = await merchantFromRequest(req, res);
    if (!merchant) return;

    const [wallet, payments, payouts, ledger] = await Promise.all([
      query(`SELECT available_paise,pending_paise,updated_at FROM wallets WHERE merchant_id=$1`, [merchant.id]),
      query(`SELECT id,merchant_order_id,amount_paise,currency,status,provider,created_at
             FROM payments WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 20`, [merchant.id]),
      query(`SELECT id,amount_paise,currency,status,mode,provider_payout_id,utr,created_at
             FROM payouts WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 20`, [merchant.id]),
      query(`SELECT COALESCE(SUM(credit_paise),0) AS credits, COALESCE(SUM(debit_paise),0) AS debits
             FROM ledger_entries WHERE merchant_id=$1`, [merchant.id])
    ]);

    res.json({
      merchant: publicMerchant(merchant),
      wallet: wallet.rows[0] || { available_paise: 0, pending_paise: 0 },
      payments: payments.rows,
      payouts: payouts.rows,
      ledgerSummary: ledger.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to load dashboard' });
  }
});

app.post('/v1/payments', async (req, res) => {
  try {
    const merchant = await merchantFromRequest(req, res);
    if (!merchant) return;

    const idem = req.header('Idempotency-Key');
    if (!idem) return res.status(400).json({ error: 'Idempotency-Key is required' });

    const existing = await getIdempotent(`${merchant.id}:payment:${idem}`);
    if (existing) return res.status(200).json(existing);

    const { amount, currency = merchant.currency, orderId, customer = {}, simulation = 'success' } = req.body || {};
    const amountPaise = Math.round(Number(amount));
    if (!Number.isInteger(amountPaise) || amountPaise < 100) {
      return res.status(400).json({ error: 'amount must be integer minor units and at least 100' });
    }
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const paymentId = makeId('pay');
    const providerResult = await simulatePayment({
      amount: amountPaise,
      currency,
      paymentId,
      simulation
    });

    await query(
      `INSERT INTO payments
       (id,merchant_id,merchant_order_id,amount_paise,currency,status,provider,provider_payment_id)
       VALUES ($1,$2,$3,$4,$5,$6,'internal_simulator',$7)`,
      [paymentId, merchant.id, orderId, amountPaise, currency, providerResult.status, providerResult.id]
    );

    if (providerResult.status === 'SUCCESS') {
      await postPaymentLedger({ merchantId: merchant.id, paymentId, grossPaise: amountPaise });
    }

    const response = {
      paymentId,
      status: providerResult.status,
      provider: 'internal_simulator',
      checkout: { checkoutUrl: `/merchant-dashboard.html?payment=${paymentId}` },
      customer
    };

    await saveIdempotent(`${merchant.id}:payment:${idem}`, response);
    res.status(201).json(response);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A payment for this orderId already exists' });
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/v1/payments/:id/refund', async (req, res) => {
  try {
    const merchant = await merchantFromRequest(req, res);
    if (!merchant) return;

    const { rows } = await query(`SELECT * FROM payments WHERE id=$1 AND merchant_id=$2`, [req.params.id, merchant.id]);
    const payment = rows[0];
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status !== 'SUCCESS') return res.status(409).json({ error: 'Only successful payments can be refunded' });

    // Reverse the merchant's net credit (gross minus the platform fee kept at capture).
    const refundPaise = Number(payment.amount_paise) - platformFee(Number(payment.amount_paise));
    const refund = await simulateRefund({ paymentId: payment.id });
    await withTransaction(async client => {
      const wallet = await client.query(
        `UPDATE wallets SET available_paise = available_paise - $2, updated_at=now()
         WHERE merchant_id=$1 AND available_paise >= $2 RETURNING merchant_id`,
        [merchant.id, refundPaise]
      );
      if (!wallet.rowCount) throw Object.assign(new Error('Insufficient merchant balance for refund'), { status: 409 });
      await client.query(`UPDATE payments SET status='REFUNDED', updated_at=now() WHERE id=$1`, [payment.id]);
      await client.query(
        `INSERT INTO ledger_entries (merchant_id,reference_type,reference_id,debit_paise,credit_paise,description)
         VALUES ($1,'refund',$2,$3,0,'Payment refunded')`,
        [merchant.id, payment.id, refundPaise]
      );
    });

    res.json({ paymentId: payment.id, refundId: refund.id, status: 'REFUNDED', refundedPaise: refundPaise });
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/v1/payments/:id', async (req, res) => {
  const merchant = await merchantFromRequest(req, res);
  if (!merchant) return;
  const { rows } = await query(
    `SELECT id,merchant_order_id,amount_paise,currency,status,provider,provider_payment_id,created_at,updated_at
     FROM payments WHERE id=$1 AND merchant_id=$2`,
    [req.params.id, merchant.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Payment not found' });
  res.json({ payment: rows[0] });
});

app.get('/v1/wallet', async (req, res) => {
  const merchant = await merchantFromRequest(req, res);
  if (!merchant) return;
  const { rows } = await query(`SELECT available_paise,pending_paise,updated_at FROM wallets WHERE merchant_id=$1`, [merchant.id]);
  res.json({ wallet: rows[0] || { available_paise: 0, pending_paise: 0 } });
});

app.post('/v1/payouts', async (req, res) => {
  try {
    const merchant = await merchantFromRequest(req, res);
    if (!merchant) return;

    const idem = req.header('Idempotency-Key');
    if (!idem) return res.status(400).json({ error: 'Idempotency-Key is required' });
    const existing = await getIdempotent(`${merchant.id}:payout:${idem}`);
    if (existing) return res.status(200).json(existing);

    const { amount, beneficiary, mode = 'IMPS' } = req.body || {};
    const amountPaise = Math.round(Number(amount));
    if (!Number.isInteger(amountPaise) || amountPaise < 100) return res.status(400).json({ error: 'Invalid amount' });
    if (!beneficiary?.name || !beneficiary?.accountNumber || !beneficiary?.ifsc) {
      return res.status(400).json({ error: 'beneficiary name, accountNumber and ifsc are required' });
    }

    const payoutId = makeId('po');
    await withTransaction(async client => {
      await reserveForPayout(client, merchant.id, amountPaise);
      await client.query(
        `INSERT INTO payouts (id,merchant_id,amount_paise,currency,status,mode,provider,reference_id)
         VALUES ($1,$2,$3,$4,'PROCESSING',$5,'internal_simulator',$6)`,
        [payoutId, merchant.id, amountPaise, merchant.currency, mode, payoutId]
      );
    });

    const provider = await simulatePayout({ amountPaise, mode, referenceId: payoutId, beneficiary });
    await query(
      `UPDATE payouts SET status='SUCCESS',provider_payout_id=$2,utr=$3,updated_at=now() WHERE id=$1`,
      [payoutId, provider.id, provider.utr]
    );
    await withTransaction(async client => settlePayout(client, merchant.id, amountPaise, true, payoutId));

    const response = {
      payoutId,
      status: 'SUCCESS',
      provider: 'internal_simulator',
      providerPayoutId: provider.id,
      utr: provider.utr,
      beneficiary: { name: beneficiary.name, accountLast4: String(beneficiary.accountNumber).slice(-4) }
    };
    await saveIdempotent(`${merchant.id}:payout:${idem}`, response);
    res.status(201).json(response);
  } catch (error) {
    console.error(error);
    res.status(error.message === 'Insufficient merchant balance' ? 409 : 500).json({ error: error.message });
  }
});

app.get('/v1/payouts/:id', async (req, res) => {
  const merchant = await merchantFromRequest(req, res);
  if (!merchant) return;
  const { rows } = await query(`SELECT * FROM payouts WHERE id=$1 AND merchant_id=$2`, [req.params.id, merchant.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payout not found' });
  res.json({ payout: rows[0] });
});

// Reconciles one payout: the provider (simulator) record, the payout row and the
// ledger debit must all agree on amount and status.
app.get('/v1/reconciliation/payouts/:id', async (req, res) => {
  const merchant = await merchantFromRequest(req, res);
  if (!merchant) return;
  const { rows } = await query(`SELECT * FROM payouts WHERE id=$1 AND merchant_id=$2`, [req.params.id, merchant.id]);
  const payout = rows[0];
  if (!payout) return res.status(404).json({ error: 'Payout not found' });

  const ledger = await query(
    `SELECT COALESCE(SUM(debit_paise),0)::bigint AS debited
     FROM ledger_entries WHERE merchant_id=$1 AND reference_type='payout' AND reference_id=$2`,
    [merchant.id, payout.id]
  );
  const ledgerDebited = Number(ledger.rows[0].debited);
  const checks = {
    providerReferencePresent: Boolean(payout.provider_payout_id && payout.utr),
    statusSettled: payout.status === 'SUCCESS',
    ledgerMatchesAmount: ledgerDebited === Number(payout.amount_paise)
  };
  res.json({
    matched: Object.values(checks).every(Boolean),
    source: 'internal_simulator',
    checks,
    ledgerDebitedPaise: ledgerDebited,
    payout
  });
});

// Merchant-level reconciliation: wallet balances must equal the ledger net position,
// and payment/payout totals are summarised by status.
app.get('/v1/reconciliation', async (req, res) => {
  const merchant = await merchantFromRequest(req, res);
  if (!merchant) return;
  const [wallet, ledger, payments, payouts] = await Promise.all([
    query(`SELECT available_paise,pending_paise FROM wallets WHERE merchant_id=$1`, [merchant.id]),
    query(`SELECT COALESCE(SUM(credit_paise),0)::bigint AS credits, COALESCE(SUM(debit_paise),0)::bigint AS debits
           FROM ledger_entries WHERE merchant_id=$1`, [merchant.id]),
    query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_paise),0)::bigint AS amount_paise
           FROM payments WHERE merchant_id=$1 GROUP BY status ORDER BY status`, [merchant.id]),
    query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_paise),0)::bigint AS amount_paise
           FROM payouts WHERE merchant_id=$1 GROUP BY status ORDER BY status`, [merchant.id])
  ]);
  const w = wallet.rows[0] || { available_paise: 0, pending_paise: 0 };
  const walletTotal = Number(w.available_paise) + Number(w.pending_paise);
  const ledgerNet = Number(ledger.rows[0].credits) - Number(ledger.rows[0].debits);
  res.json({
    merchantId: merchant.id,
    matched: walletTotal === ledgerNet,
    wallet: { availablePaise: Number(w.available_paise), pendingPaise: Number(w.pending_paise), totalPaise: walletTotal },
    ledger: { creditsPaise: Number(ledger.rows[0].credits), debitsPaise: Number(ledger.rows[0].debits), netPaise: ledgerNet },
    differencePaise: walletTotal - ledgerNet,
    payments: payments.rows,
    payouts: payouts.rows
  });
});

// Unknown routes and unhandled errors always return JSON (never an HTML page).
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  const status = error.status || error.statusCode || 500;
  // Don't leak database/internal details to API clients; they are in the server logs.
  res.status(status).json({ error: status < 500 ? error.message : 'Internal server error' });
});

export default app;

// Start an HTTP listener only when run directly (Docker / `npm start`).
// On Vercel the app is imported by api/index.js and invoked per request.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(config.port, () => console.log(`PayFlow API listening on :${config.port}`));
}
