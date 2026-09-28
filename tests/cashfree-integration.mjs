// End-to-end test of PAYMENT_PROVIDER=cashfree against the local Cashfree mock.
//   DATABASE_URL=postgresql://... node tests/cashfree-integration.mjs
// Starts the mock and a PayFlow server, then exercises: order creation, signed webhooks,
// duplicate/tampered/late/missed webhooks, amount mismatch, beneficiary registration,
// payouts incl. 5xx retries, failures, reversals, dead-lettering, and reconciliation.
import { spawn } from 'node:child_process';
import pg from 'pg';
import { startMockCashfree } from './mock-cashfree.mjs';

const DB = process.env.DATABASE_URL;
if (!DB) { console.error('Set DATABASE_URL'); process.exit(2); }
const MOCK = 4010, APP = 8055, B = `http://127.0.0.1:${APP}`, M = `http://127.0.0.1:${MOCK}`;
const creds = { pg: { clientId: 'TEST_PG_ID', clientSecret: 'cfsk_pg_test_secret' },
  payout: { clientId: 'TEST_PO_ID', clientSecret: 'cfsk_po_test_secret' } };
const ADMIN = 'admin_test_key_123';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${name}${cond ? '' : '  ' + extra}`); };

const mock = await startMockCashfree({ port: MOCK, ...creds,
  pgWebhookUrl: `${B}/v1/webhooks/cashfree/payments`, payoutWebhookUrl: `${B}/v1/webhooks/cashfree/payouts` });
const app = spawn(process.execPath, ['server/app.js'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  PORT: String(APP), PAYMENT_PROVIDER: 'cashfree', CASHFREE_ENV: 'sandbox', CASHFREE_BASE_URL: M,
  CASHFREE_PG_CLIENT_ID: creds.pg.clientId, CASHFREE_PG_CLIENT_SECRET: creds.pg.clientSecret,
  CASHFREE_PAYOUT_CLIENT_ID: creds.payout.clientId, CASHFREE_PAYOUT_CLIENT_SECRET: creds.payout.clientSecret,
  CASHFREE_PAYOUT_PUBLIC_KEY: mock.publicKey, ADMIN_API_KEY: ADMIN, JOBS_INTERVAL_MS: '0', PUBLIC_BASE_URL: B } });
let appLog = ''; app.stdout.on('data', d => appLog += d); app.stderr.on('data', d => appLog += d);
const db = new pg.Pool({ connectionString: DB });
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(200); }

async function api(method, path, body, headers = {}) {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const ctl = async (path, body) => (await fetch(M + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const run = Date.now();
let KEY; const auth = () => ({ authorization: `Bearer ${KEY}` });
const wallet = async () => (await api('GET', '/v1/wallet', null, auth())).body.wallet;
const payment = async id => (await api('GET', `/v1/payments/${id}`, null, auth())).body.payment;
const payout = async id => (await api('GET', `/v1/payouts/${id}`, null, auth())).body.payout;
const pay = (orderId, amount = 100000) => api('POST', '/v1/payments',
  { amount, orderId, customer: { phone: '9876543210', email: 'buyer@example.com', name: 'Test Buyer' } },
  { ...auth(), 'idempotency-key': `idem-${orderId}` });
const fastForward = () => db.query(`UPDATE payments SET next_poll_at=now() - interval '1 second' WHERE next_poll_at IS NOT NULL;
  UPDATE payouts SET next_retry_at=now() - interval '1 second', updated_at=now() - interval '1 minute' WHERE status IN ('CREATED','PROCESSING')`);
const jobs = async () => (await api('POST', '/v1/admin/jobs/run', null, { authorization: `Bearer ${ADMIN}` })).body;

try {
  console.log('Cashfree integration test (mock at ' + M + ')');
  const h = await api('GET', '/health');
  check('health reports cashfree sandbox', h.body.provider === 'cashfree' && h.body.providerEnv === 'sandbox', JSON.stringify(h.body));

  const mer = await api('POST', '/v1/merchants', { businessName: 'BdayStudio', ownerName: 'Owner', email: `cf${run}@example.com` });
  KEY = mer.body.credentials.apiKey;
  check('merchant onboarded', mer.status === 201);

  // ---------------- pay-in
  const noPhone = await api('POST', '/v1/payments', { amount: 5000, orderId: `np${run}` }, { ...auth(), 'idempotency-key': `np${run}` });
  check('cashfree requires customer phone (server-side validation)', noPhone.status === 400);

  const p1 = await pay(`o1${run}`);
  check('payment created at PSP -> PENDING', p1.status === 201 && p1.body.status === 'PENDING', JSON.stringify(p1.body));
  check('checkout session for Cashfree JS SDK returned', /^session_/.test(p1.body.checkout?.paymentSessionId || '') && p1.body.checkout.mode === 'sandbox');
  const order = mock.state.orders.get(p1.body.paymentId);
  check('order sent in rupees with idempotency key', order?.order_amount === 1000 && /^[0-9a-f-]{36}$/.test(order.idem || ''), JSON.stringify(order?.view));
  const replay = await pay(`o1${run}`);
  check('Idempotency-Key replay -> same payment, one PSP order', replay.body.paymentId === p1.body.paymentId && mock.state.orders.size === 1);

  const w0 = await ctl('/__control/pay', { order_id: p1.body.paymentId, outcome: 'success', duplicate: true });
  check('signed PAYMENT_SUCCESS webhook accepted', w0.webhook.status === 200 && w0.webhook.body.to === 'SUCCESS', JSON.stringify(w0.webhook));
  check('duplicate webhook delivery ignored (exactly-once)', w0.webhook.duplicate.body.duplicate === true);
  check('payment SUCCESS, wallet credited once (net of 1% fee)', (await payment(p1.body.paymentId)).status === 'SUCCESS' && Number((await wallet()).available_paise) === 99000);

  const p2 = await pay(`o2${run}`, 50000);
  const tam = await ctl('/__control/pay', { order_id: p2.body.paymentId, outcome: 'failed', tamper: true });
  check('tampered webhook signature rejected (401), no state change', tam.webhook.status === 401 && (await payment(p2.body.paymentId)).status === 'PENDING');
  await ctl('/__control/pay', { order_id: p2.body.paymentId, outcome: 'failed' });
  check('failed attempt -> FAILED', (await payment(p2.body.paymentId)).status === 'FAILED');
  await ctl('/__control/pay', { order_id: p2.body.paymentId, outcome: 'success' });
  const p2d = await api('GET', `/v1/payments/${p2.body.paymentId}`, null, auth());
  check('customer retry on same order: FAILED -> SUCCESS, attempts recorded', p2d.body.payment.status === 'SUCCESS' && p2d.body.attempts.length >= 2);
  check('wallet credited for late success', Number((await wallet()).available_paise) === 99000 + 49500);

  const p3 = await pay(`o3${run}`, 20000);
  await ctl('/__control/pay', { order_id: p3.body.paymentId, outcome: 'success', amountOverride: 1 });
  check('amount mismatch in webhook -> MANUAL_REVIEW, no credit', (await payment(p3.body.paymentId)).status === 'MANUAL_REVIEW' && Number((await wallet()).available_paise) === 148500);

  const p4 = await pay(`o4${run}`, 30000);
  await ctl('/__control/pay', { order_id: p4.body.paymentId, outcome: 'success', deliverWebhook: false });
  check('lost webhook: payment still PENDING', (await payment(p4.body.paymentId)).status === 'PENDING');
  await fastForward(); const j1 = await jobs();
  check('polling job recovers missed webhook -> SUCCESS', (await payment(p4.body.paymentId)).status === 'SUCCESS' && j1.paymentsUpdated >= 1, JSON.stringify(j1));
  let available = 148500 + 29700;

  // ---------------- pay-out
  const acct = await api('POST', '/v1/merchant/payout-account', { name: 'BdayStudio Owner', accountNumber: '026291800001191', ifsc: 'YESB0000262' }, auth());
  const bene = mock.state.benes.get(acct.body.payoutAccount?.beneficiaryId);
  check('beneficiary registered at Cashfree Payouts (with X-Cf-Signature 2FA)', acct.status === 201 && bene?.beneficiary_instrument_details.bank_account_number === '026291800001191', JSON.stringify(acct.body));
  const stored = (await db.query(`SELECT row_to_json(m)::text AS j FROM merchants m WHERE id=$1`, [mer.body.credentials.merchantId])).rows[0].j;
  check('PayFlow stores only last 4 digits of the bank account', !stored.includes('026291800001191') && stored.includes('"payout_account_last4":"1191"'));

  const po = (amount, k) => api('POST', '/v1/payouts', { amount, mode: 'IMPS' }, { ...auth(), 'idempotency-key': `po-${k}-${run}` });
  const o1 = await po(50000, 'a');
  check('payout accepted by provider -> PROCESSING, funds reserved', o1.body.status === 'PROCESSING' && Number((await wallet()).pending_paise) === 50000, JSON.stringify(o1.body));
  await ctl('/__control/transfer', { transfer_id: o1.body.payoutId, status: 'SUCCESS', status_code: 'SENT_TO_BENEFICIARY' });
  check('SUCCESS+SENT_TO_BENEFICIARY is not final (still PROCESSING)', (await payout(o1.body.payoutId)).status === 'PROCESSING');
  await ctl('/__control/transfer', { transfer_id: o1.body.payoutId, status: 'SUCCESS', status_code: 'COMPLETED' });
  const o1d = await payout(o1.body.payoutId);
  check('TRANSFER_ACKNOWLEDGED (SUCCESS+COMPLETED) -> SUCCESS with UTR', o1d.status === 'SUCCESS' && /^CFUTR/.test(o1d.utr || ''));
  available -= 50000;
  check('wallet settled: available debited, pending cleared', Number((await wallet()).available_paise) === available && Number((await wallet()).pending_paise) === 0);

  await ctl('/__control/flags', { transferFail5xxNotRecorded: 1 });
  const o2 = await po(10000, 'b');
  check('5xx before transfer recorded -> PROCESSING, not failed', o2.body.status === 'PROCESSING');
  await fastForward(); const j2 = await jobs();
  check('retry job: status check finds nothing -> resubmits once', j2.payoutsResubmitted === 1 && mock.state.transfers.has(o2.body.payoutId), JSON.stringify(j2));

  await ctl('/__control/flags', { transferFail5xxRecorded: 1 });
  const o3 = await po(10000, 'c');
  await fastForward(); const j3 = await jobs();
  const posts = mock.state.log.filter(l => l === 'POST /payout/transfers').length;
  check('5xx after transfer recorded -> job checks status, no duplicate transfer', j3.payoutsResubmitted === 0 && posts === 4, `posts=${posts} ${JSON.stringify(j3)}`);
  await ctl('/__control/transfer', { transfer_id: o3.body.payoutId, status: 'SUCCESS', status_code: 'COMPLETED' });
  check('recovered payout completes via webhook', (await payout(o3.body.payoutId)).status === 'SUCCESS');
  available -= 20000; // o2 (reserved) + o3 (paid)

  const o4 = await po(15000, 'd');
  await ctl('/__control/transfer', { transfer_id: o4.body.payoutId, status: 'FAILED', status_code: 'INVALID_ACCOUNT_FAIL', status_description: 'Invalid account' });
  check('TRANSFER_FAILED -> FAILED, funds released to available', (await payout(o4.body.payoutId)).status === 'FAILED' && Number((await wallet()).available_paise) === available);

  await ctl('/__control/transfer', { transfer_id: o1.body.payoutId, status: 'REVERSED', status_code: 'RETURNED_FROM_BENEFICIARY' });
  available += 50000;
  check('TRANSFER_REVERSED after SUCCESS -> REVERSED, funds credited back', (await payout(o1.body.payoutId)).status === 'REVERSED' && Number((await wallet()).available_paise) === available);

  const t = await ctl('/__control/webhook-test', {});
  check('dashboard test webhook (LOW_BALANCE_ALERT) acknowledged with 200', t.status === 200 && t.body.ignored === 'LOW_BALANCE_ALERT');

  // dead letter: o2 never reaches a terminal state
  await db.query(`UPDATE payouts SET attempts=8 WHERE id=$1`, [o2.body.payoutId]); await fastForward(); await jobs();
  check('unconfirmable payout -> MANUAL_REVIEW (dead letter), funds stay reserved',
    (await payout(o2.body.payoutId)).status === 'MANUAL_REVIEW' && Number((await wallet()).pending_paise) === 10000);

  // ---------------- reconciliation
  const rec = await api('GET', '/v1/reconciliation/provider', null, auth());
  const mism = rec.body.items.filter(i => i.result !== 'MATCH');
  check('provider reconciliation: only the reviewed items mismatch', rec.body.summary.total === 8 &&
    mism.map(i => i.id).sort().join() === [p3.body.paymentId, o2.body.payoutId].sort().join(), JSON.stringify(rec.body.summary) + JSON.stringify(mism));
  const intr = await api('GET', '/v1/reconciliation', null, auth());
  check('internal reconciliation: wallet == ledger, every transaction balanced', intr.body.matched === true, JSON.stringify(intr.body.checks));
  const adm = await api('GET', '/v1/admin/overview', null, { authorization: `Bearer ${ADMIN}` });
  check('admin overview lists manual-review queue', adm.body.manualReview.filter(r => r.merchant_id === mer.body.credentials.merchantId).length === 2);
  check('admin API rejects wrong key', (await api('GET', '/v1/admin/overview', null, { authorization: 'Bearer nope' })).status === 401);
} catch (error) {
  fail++; console.error(error); console.error(appLog.slice(-3000));
} finally {
  console.log(`\nPassed: ${pass}  Failed: ${fail}`);
  if (fail) console.log(appLog.slice(-2000));
  app.kill(); mock.server.close(); await db.end();
  process.exit(fail ? 1 : 0);
}
