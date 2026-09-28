# PayFlow — Generic Payment Infrastructure Hackathon Project

PayFlow is a multi-tenant payment infrastructure layer. Any e-commerce application can onboard as a merchant, receive an API key, and use the same payment, wallet, payout and reconciliation APIs.

## Hackathon implementation

The project intentionally uses **internal payment and payout simulators** so the complete flow can run locally without Razorpay/RazorpayX credentials.

The provider layer is isolated, so a real PSP/bank adapter can be added later without changing the merchant-facing API.

## Architecture

```text
Merchant Applications
        |
        v
   PayFlow API
        |
  +-----+------+----------------+
  |            |                |
Payments     Ledger          Payouts
  |            |                |
  v            v                v
Internal     PostgreSQL      Internal
Simulator                    Simulator
```

All state (including idempotency keys) lives in PostgreSQL, so the same code runs in
Docker Compose and as a stateless Vercel serverless function.

## Merchant onboarding

1. Open `/merchant-dashboard.html`.
2. Fill in business name, owner, email and business details.
3. PayFlow creates a `merchant_id`.
4. PayFlow generates a test API key.
5. Only the API-key hash is stored in PostgreSQL.
6. A wallet is created automatically for the merchant.
7. The merchant can immediately use `/v1/payments` and `/v1/payouts`.

Production systems would add KYC/business verification, key rotation, audit controls and stronger authentication before activating a merchant.

## Run locally

```bash
docker compose down -v
docker compose up --build
```

Open:

- Merchant Portal: `http://localhost:8080/merchant-dashboard.html`
- Integration docs: `http://localhost:8080/payflow-integration.html`
- API: `http://localhost:8000`
- Health: `http://localhost:8080/health`

Containers: `frontend` (nginx, serves `/public` pages and proxies `/health` + `/v1/*`),
`backend` (Express API), `postgres` (initialised from `db/schema.sql`).

Verify the whole flow end-to-end:

```bash
./scripts/smoke-test.sh                          # local
./scripts/smoke-test.sh https://YOUR-APP.vercel.app   # production
```

`down -v` is used when moving from an older schema because it recreates the PostgreSQL volume with the current merchant tables. Do not use it if you need to preserve old local database data.

## Main APIs

```text
POST /v1/merchants
GET  /v1/merchant
GET  /v1/dashboard

POST /v1/payments
GET  /v1/payments/:id
POST /v1/payments/:id/refund

GET  /v1/wallet
POST /v1/payouts
GET  /v1/payouts/:id
GET  /v1/reconciliation
GET  /v1/reconciliation/payouts/:id
```

`GET /v1/reconciliation` checks that the wallet balance (available + pending) equals the
merchant's ledger net position. `GET /v1/reconciliation/payouts/:id` checks the payout
row, simulator reference/UTR and ledger debit agree.

Ledger postings: a captured payment credits the gross amount and debits the 1% platform
fee; a payout debits the paid-out amount; a refund debits the merchant's net credit.

## Deploying on Vercel + Supabase

`api/index.js` wraps the Express app as one serverless function; `vercel.json` rewrites
`/health` and `/v1/*` to it, so the API URLs are identical to local.

1. In the Supabase SQL editor, run `db/schema.sql` (safe to re-run). It enables Row Level
   Security on every PayFlow table so they are not reachable through Supabase's public
   Data API; the backend connects as the table owner and is unaffected.
2. In Vercel → Project → Settings → Environment Variables set `DATABASE_URL` to the
   Supabase **transaction pooler** connection string (port 6543). If the Vercel Supabase
   integration is installed, `POSTGRES_URL` is used automatically instead.
3. Deploy, then run `./scripts/smoke-test.sh https://YOUR-APP.vercel.app`.

## Merchant isolation

Every merchant-owned resource contains `merchant_id`. API-key authentication resolves the merchant before querying payments, wallets, payouts or ledger entries. This prevents one merchant from accessing another merchant's financial data.

## Payment simulator

`POST /v1/payments` accepts a demo-only `simulation` value:

```text
success
pending
failed
timeout
```

This is for demonstrating payment state handling during the hackathon. It does not represent a real payment rail.

## Payout simulator

Payouts reserve funds from the merchant wallet and return a simulated provider payout ID and UTR. No real bank transfer occurs.
