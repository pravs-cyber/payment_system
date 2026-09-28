# PayFlow — Generic Payment Infrastructure Hackathon Project

PayFlow is a multi-tenant payment infrastructure layer. Any e-commerce application can onboard as a merchant, receive an API key, and use the same payment, wallet, payout and reconciliation APIs.

## How it works

```text
Merchant app ──POST /v1/payments──► PayFlow API ──create order──► PSP (Cashfree PG sandbox)
      ▲                                  ▲                              │ customer pays on PSP checkout
      │                                  └──── signed webhook ◄─────────┘
      │                        state machine ─► double-entry ledger ─► merchant wallet
      │
      └──POST /v1/payouts──► PayFlow ──transfer──► Cashfree Payouts ──► merchant bank
                                  ▲                        │
                                  └──── signed webhook ◄───┘
   retry / polling / dead-letter jobs · reconciliation PayFlow ⇄ PSP · admin console
```

Design points (System Design Interview, ch. 27):

- **External PSP, no card data.** Customers pay on Cashfree's hosted checkout; PayFlow never sees card/UPI details. Bank account numbers go only to the payout provider; PayFlow keeps the last 4 digits.
- **Webhooks decide outcomes.** `POST /v1/payments` returns `PENDING`; ledger and wallet move only when a signed webhook (HMAC-SHA256 over timestamp + raw body) or a status poll confirms it.
- **Exactly-once.** Webhooks are deduplicated in `webhook_events`; state transitions are guarded row-locked updates, so duplicate or concurrent deliveries cannot post money twice. `Idempotency-Key` is enforced by unique constraints as well as a response cache.
- **State machines.** Payments `CREATED → PENDING → SUCCESS | FAILED | CANCELLED | EXPIRED`, `FAILED → SUCCESS` (retry on the same order), `SUCCESS → REFUNDED`. Payouts `CREATED → PROCESSING → SUCCESS | FAILED`, `SUCCESS → REVERSED`. Amount mismatches go to `MANUAL_REVIEW`.
- **Double-entry ledger.** Accounts `psp_clearing`, `merchant_payable` (= wallet available), `payout_in_transit` (= wallet pending), `payout_funding`, `platform_fee_revenue`; every transaction sums to zero.
- **Retries and dead letters.** A Postgres-backed job polls payments whose webhook may have been lost, checks in-flight transfers (on 5xx it checks status instead of resubmitting, as Cashfree requires), resubmits transfers the provider never received (deduplicated by `transfer_id`), re-applies failed webhook events, and parks anything unconfirmable in `MANUAL_REVIEW`. Funds stay reserved rather than being released blindly.
- **Reconciliation.** Internal (wallet vs ledger, balanced transactions) and external (every payment/payout vs the provider's record) with an admin console at `/admin`.
- **Security.** API keys stored as SHA-256 hashes, admin key for operations, rate limiting and audit log in Postgres, RLS enabled on all tables, server-side amount validation, HSTS on Vercel.

`PAYMENT_PROVIDER=simulator` (default) runs the same flow offline against a built-in PSP simulator that behaves like Cashfree (pending orders, hosted checkout, signed webhooks, its own records for reconciliation). No real money moves in either mode unless Cashfree production keys are used.

## Run locally (Docker Compose)

```bash
docker compose down -v            # only when moving from an older schema
docker compose up --build
./scripts/smoke-test.sh           # simulator: full flow, expects "Failed: 0"
```

- Merchant portal: http://localhost:8080/merchant-dashboard
- Customer checkout: opened from the portal (`/checkout?payment=…`)
- Admin console: http://localhost:8080/admin (key: `local-admin-key` unless `ADMIN_API_KEY` is set)
- Health: http://localhost:8080/health

To use the Cashfree sandbox locally, put the variables below in a `.env` file next to `docker-compose.yaml` with `PAYMENT_PROVIDER=cashfree`. Cashfree cannot reach `localhost` for webhooks, so locally the polling job confirms payments (or expose the app with a tunnel and set `PUBLIC_BASE_URL`).

Offline test of the real Cashfree adapter against a spec-based mock (needs a Postgres):

```bash
DATABASE_URL=postgresql://payflow:payflow@localhost:5432/payflow npm run test:cashfree
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supabase **transaction pooler** URL (port 6543). `POSTGRES_URL` from the Vercel–Supabase integration also works. |
| `PAYMENT_PROVIDER` | yes for real PSP | `cashfree` or `simulator` (default) |
| `CASHFREE_ENV` | | `sandbox` (default) or `production` |
| `CASHFREE_PG_CLIENT_ID`, `CASHFREE_PG_CLIENT_SECRET` | with cashfree | Payment Gateway test keys (Cashfree dashboard → Developers → API keys, Test mode) |
| `CASHFREE_PAYOUT_CLIENT_ID`, `CASHFREE_PAYOUT_CLIENT_SECRET` | with cashfree | Payouts test keys. Webhooks are verified with this secret. |
| `CASHFREE_PAYOUT_PUBLIC_KEY` | on Vercel | Payouts 2FA public key (PEM; `\n` escapes allowed). Needed because Vercel has no static IP to whitelist. |
| `PUBLIC_BASE_URL` | recommended | e.g. `https://your-app.vercel.app`; used for checkout return and webhook URLs |
| `ADMIN_API_KEY` | recommended | Enables `/v1/admin/*` and the `/admin` console |
| `CRON_SECRET` | recommended | Vercel Cron sends it; authorises `/v1/internal/cron` |
| `SIMULATOR_WEBHOOK_SECRET` | if simulator in prod | Signing secret for simulator webhooks |
| `AUTO_MIGRATE` | | `true` (default): applies `db/schema.sql` (idempotent) on cold start |

## Deploy on Vercel + Supabase + Cashfree sandbox

1. Cashfree: create a merchant account, switch to **Test** mode, and copy Payment Gateway and Payouts API keys. In Payouts → Developers → Two-Factor Authentication choose **Public Key**, generate it, and keep the PEM.
2. Vercel → Settings → Environment Variables: set the variables above (`PAYMENT_PROVIDER=cashfree`). Deploy.
3. The first request applies the schema automatically (or run `db/schema.sql` in the Supabase SQL editor).
4. Cashfree dashboard webhooks:
   - Payment Gateway → Webhooks: `https://YOUR-APP.vercel.app/v1/webhooks/cashfree/payments` (orders also send this as `notify_url`)
   - Payouts (Test) → Developers → Webhooks, version **V2**: `https://YOUR-APP.vercel.app/v1/webhooks/cashfree/payouts`
5. Run `./scripts/smoke-test.sh https://YOUR-APP.vercel.app`, then open the printed checkout URL and pay with Cashfree's sandbox test card/UPI details.
6. Top up the Payouts **test** balance in the Cashfree dashboard before testing withdrawals.

Vercel Hobby runs cron once a day; use **Run retry jobs** in `/admin` (or `POST /v1/admin/jobs/run`) to trigger retries and polling on demand.

## Main APIs

```text
POST /v1/merchants                     GET  /v1/merchant          GET /v1/dashboard
POST /v1/merchant/payout-account       GET  /v1/merchant/payout-account

POST /v1/payments                      GET  /v1/payments          GET /v1/payments/:id
POST /v1/payments/:id/refund           (simulator only for now)
GET  /v1/checkout/:paymentId           public: hosted checkout data

GET  /v1/wallet                        GET  /v1/ledger
POST /v1/payouts                       GET  /v1/payouts           GET /v1/payouts/:id

GET  /v1/reconciliation                GET  /v1/reconciliation/provider
GET  /v1/reconciliation/payouts/:id

POST /v1/webhooks/cashfree/payments    POST /v1/webhooks/cashfree/payouts
GET  /v1/admin/overview                GET  /v1/admin/reconciliation
POST /v1/admin/jobs/run                GET  /v1/admin/audit
```

Every merchant-owned row carries `merchant_id`; API-key authentication resolves the merchant before any query, so one merchant cannot read another's data.
