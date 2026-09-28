// Local mock of the Cashfree PG + Payouts V2 APIs, built from Cashfree's published docs,
// used to integration-test the real adapter (server/providers/cashfree.js) offline.
// It enforces auth headers, request shapes and Payouts 2FA (X-Cf-Signature), delivers
// HMAC-signed webhooks, and supports fault injection through /__control endpoints.
import http from 'node:http';
import crypto from 'node:crypto';

export function startMockCashfree({ port, pg, payout, pgWebhookUrl, payoutWebhookUrl }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const orders = new Map(), attempts = new Map(), benes = new Map(), transfers = new Map();
  const flags = { transferFail5xxNotRecorded: 0, transferFail5xxRecorded: 0 };
  const log = [];

  const sign = (raw, ts, secret) => crypto.createHmac('sha256', secret).update(ts + raw).digest('base64');
  async function deliver(url, secret, event, { tamper = false } = {}) {
    const raw = JSON.stringify(event); const ts = String(Date.now());
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-webhook-timestamp': ts, 'x-webhook-signature': tamper ? sign(raw + 'x', ts, secret) : sign(raw, ts, secret),
      'x-webhook-version': '2025-01-01' }, body: raw });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const err = (res, status, message, code = 'request_failed') => send(res, status, { message, code, type: 'invalid_request_error' });

  function auth(req, api) {
    const c = api === 'pg' ? pg : payout;
    if (req.headers['x-client-id'] !== c.clientId || req.headers['x-client-secret'] !== c.clientSecret) return 'authentication Failed';
    if (!req.headers['x-api-version']) return 'x-api-version missing';
    if (api === 'payout') {
      const sig = req.headers['x-cf-signature'];
      if (!sig) return 'Signature missing in the request';
      try {
        const plain = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(sig, 'base64')).toString();
        const [id, ts] = plain.split('.');
        if (id !== c.clientId || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return 'Signature mismatched';
      } catch { return 'Signature mismatched'; }
    }
    return null;
  }
  const transferView = t => ({ transfer_id: t.transfer_id, cf_transfer_id: t.cf_transfer_id, status: t.status, status_code: t.status_code,
    status_description: t.status_description || t.status_code, beneficiary_details: { beneficiary_id: t.beneficiary_id },
    transfer_amount: t.transfer_amount, transfer_mode: t.transfer_mode, transfer_utr: t.transfer_utr || null,
    added_on: t.added_on, updated_on: new Date().toISOString() });

  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    log.push(`${req.method} ${p}`);

    // ---------------- control
    if (p === '/__control/public-key') return send(res, 200, { publicKey });
    if (p === '/__control/flags') { Object.assign(flags, body); return send(res, 200, flags); }
    if (p === '/__control/pay') { // customer completes checkout
      const o = orders.get(body.order_id); if (!o) return err(res, 404, 'order not found');
      const cf_payment_id = String(Math.floor(Math.random() * 1e10));
      const payment_status = body.outcome === 'failed' ? 'FAILED' : body.outcome === 'dropped' ? 'USER_DROPPED' : 'SUCCESS';
      const a = { cf_payment_id, payment_status, payment_amount: o.order_amount, payment_time: new Date().toISOString(),
        payment_message: payment_status === 'SUCCESS' ? 'Transaction successful' : 'Declined by bank' };
      attempts.get(o.order_id).push(a);
      if (payment_status === 'SUCCESS') o.order_status = 'PAID';
      const type = { SUCCESS: 'PAYMENT_SUCCESS_WEBHOOK', FAILED: 'PAYMENT_FAILED_WEBHOOK', USER_DROPPED: 'PAYMENT_USER_DROPPED_WEBHOOK' }[payment_status];
      const event = { type, event_time: new Date().toISOString(), data: {
        order: { order_id: o.order_id, order_amount: body.amountOverride ?? o.order_amount, order_currency: 'INR', order_tags: o.order_tags },
        payment: a, customer_details: o.customer_details } };
      if (body.deliverWebhook === false) return send(res, 200, { delivered: false, event });
      const r = await deliver(pgWebhookUrl, pg.clientSecret, event, { tamper: body.tamper });
      if (body.duplicate) r.duplicate = await deliver(pgWebhookUrl, pg.clientSecret, event);
      return send(res, 200, { delivered: true, webhook: r, event });
    }
    if (p === '/__control/transfer') { // bank/Cashfree moves a transfer to a new state
      const t = transfers.get(body.transfer_id); if (!t) return err(res, 404, 'transfer not found');
      Object.assign(t, { status: body.status, status_code: body.status_code, status_description: body.status_description,
        transfer_utr: body.status === 'SUCCESS' ? (t.transfer_utr || `CFUTR${Date.now()}`) : t.transfer_utr });
      const type = body.type || { SUCCESS: body.status_code === 'COMPLETED' ? 'TRANSFER_ACKNOWLEDGED' : 'TRANSFER_SUCCESS',
        FAILED: 'TRANSFER_FAILED', REVERSED: 'TRANSFER_REVERSED', REJECTED: 'TRANSFER_REJECTED' }[body.status];
      if (body.deliverWebhook === false) return send(res, 200, { delivered: false });
      const r = await deliver(payoutWebhookUrl, payout.clientSecret, { type, event_time: new Date().toISOString(), data: transferView(t) });
      return send(res, 200, { delivered: true, webhook: r });
    }
    if (p === '/__control/webhook-test') { // dashboard "Test & Add Webhook" sends LOW_BALANCE_ALERT
      return send(res, 200, await deliver(payoutWebhookUrl, payout.clientSecret,
        { type: 'LOW_BALANCE_ALERT', event_time: new Date().toISOString(), data: { current_balance: '8.53', fundsource_id: 'CASHFREE_1' } }));
    }
    if (p === '/__control/state') return send(res, 200, { orders: [...orders.values()], transfers: [...transfers.values()], log });

    // ---------------- Payment Gateway
    if (p.startsWith('/pg/')) {
      const a = auth(req, 'pg'); if (a) return err(res, 401, a, 'authentication_error');
      if (req.method === 'POST' && p === '/pg/orders') {
        const { order_id, order_amount, order_currency, customer_details: cd = {} } = body;
        if (!/^[A-Za-z0-9_-]{3,45}$/.test(order_id || '')) return err(res, 400, 'order_id is invalid');
        if (!(Number(order_amount) >= 1)) return err(res, 400, 'order_amount should be greater than or equal to 1');
        if (!cd.customer_id || !/^\d{10}$/.test(cd.customer_phone || '')) return err(res, 400, 'customer_details.customer_phone : should be of length 10');
        if (orders.has(order_id)) {
          const o = orders.get(order_id);
          if (req.headers['x-idempotency-key'] && o.idem === req.headers['x-idempotency-key']) return send(res, 200, o.view);
          return err(res, 409, 'order with same id is already present', 'order_already_exists');
        }
        const o = { order_id, cf_order_id: String(Math.floor(Math.random() * 1e10)), order_amount: Number(order_amount),
          order_currency: order_currency || 'INR', order_status: 'ACTIVE', customer_details: cd, order_meta: body.order_meta,
          order_tags: body.order_tags, idem: req.headers['x-idempotency-key'],
          payment_session_id: `session_${crypto.randomBytes(24).toString('base64url')}` };
        o.view = { cf_order_id: o.cf_order_id, order_id, entity: 'order', order_currency: o.order_currency, order_amount: o.order_amount,
          order_status: 'ACTIVE', payment_session_id: o.payment_session_id, customer_details: cd, order_meta: body.order_meta };
        orders.set(order_id, o); attempts.set(order_id, []);
        return send(res, 200, o.view);
      }
      const m = p.match(/^\/pg\/orders\/([^/]+)(\/payments)?$/);
      if (req.method === 'GET' && m) {
        const o = orders.get(decodeURIComponent(m[1])); if (!o) return err(res, 404, 'order not found', 'order_not_found');
        if (m[2]) return send(res, 200, attempts.get(o.order_id));
        return send(res, 200, { ...o.view, order_status: o.order_status });
      }
    }

    // ---------------- Payouts V2
    if (p.startsWith('/payout/')) {
      const a = auth(req, 'payout'); if (a) return err(res, 403, a, 'authentication_error');
      if (req.method === 'POST' && p === '/payout/beneficiary') {
        const b = body, inst = b.beneficiary_instrument_details || {};
        if (!/^[A-Za-z0-9_|-]{1,50}$/.test(b.beneficiary_id || '') || !b.beneficiary_name || !inst.bank_account_number || !inst.bank_ifsc) {
          return err(res, 400, 'beneficiary details invalid', 'beneficiary_invalid');
        }
        if (benes.has(b.beneficiary_id)) return err(res, 409, 'Beneficiary already exists', 'beneficiary_id_already_exists');
        benes.set(b.beneficiary_id, b);
        return send(res, 201, { ...b, beneficiary_status: 'VERIFIED', added_on: new Date().toISOString() });
      }
      if (req.method === 'POST' && p === '/payout/transfers') {
        const { transfer_id, transfer_amount, beneficiary_details = {}, transfer_mode = 'banktransfer' } = body;
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(transfer_id || '')) return err(res, 400, 'transfer_id invalid', 'transfer_id_invalid');
        if (!(Number(transfer_amount) >= 1)) return err(res, 400, 'transfer_amount invalid', 'transfer_amount_invalid');
        if (!benes.has(beneficiary_details.beneficiary_id)) return err(res, 404, 'beneficiary does not exist', 'beneficiary_not_found');
        if (!['banktransfer', 'imps', 'neft', 'rtgs', 'upi'].includes(transfer_mode)) return err(res, 400, 'transfer_mode invalid');
        if (flags.transferFail5xxNotRecorded > 0) { flags.transferFail5xxNotRecorded--; return err(res, 502, 'bad gateway', 'bad_gateway'); }
        if (transfers.has(transfer_id)) return err(res, 409, 'transfer with same transfer_id already exists', 'transfer_id_already_exists');
        const t = { transfer_id, cf_transfer_id: String(Math.floor(Math.random() * 1e8)), status: 'RECEIVED', status_code: 'RECEIVED',
          transfer_amount: Number(transfer_amount), transfer_mode, beneficiary_id: beneficiary_details.beneficiary_id, added_on: new Date().toISOString() };
        transfers.set(transfer_id, t);
        if (flags.transferFail5xxRecorded > 0) { flags.transferFail5xxRecorded--; return err(res, 500, 'internal error', 'internal_error'); }
        return send(res, 200, transferView(t));
      }
      if (req.method === 'GET' && p === '/payout/transfers') {
        const t = transfers.get(url.searchParams.get('transfer_id'));
        return t ? send(res, 200, transferView(t)) : err(res, 404, 'transfer not found', 'transfer_not_found');
      }
    }
    err(res, 404, `mock: no route ${req.method} ${p}`);
  });
  return new Promise(resolve => server.listen(port, () => resolve({ server, publicKey, state: { orders, transfers, benes, log } })));
}
