# bdaystudio - v1 production build

## Current flow

Website -> choose theme -> choose package -> deployment extension -> add-ons -> customer details -> PayPal sandbox -> payment verified -> private media upload -> order ready for build.

Ko-fi remains a separate alternative route.
Custom orders go to Instagram.
Razorpay is intentionally not wired in yet.

## Supabase

Run `supabase/schema.sql` in Supabase SQL Editor. It is safe to re-run because it uses `if not exists` and `add column if not exists` for the new fields.

Storage bucket:
- `order-media` (private)

## Vercel environment variables

```text
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_ENV=sandbox
APP_URL=https://your-project.vercel.app
```

Never commit `.env` or any secret key.

## PayPal

The frontend uses the PayPal JavaScript SDK v6 sandbox. The backend creates and captures Orders API orders. The server calculates the price from the package/deployment/add-on catalog; it does not trust a browser-supplied total.

Before production:
- switch the SDK environment from sandbox to production
- use live PayPal credentials
- test approve/cancel/error flows
- configure/verify webhooks as needed
- test on desktop and mobile

## Customer media

No customer media is uploaded before payment. After successful payment, the site asks for the media and creates short-lived signed upload URLs for the private Supabase bucket.

The order keeps metadata in `order_media`; the actual files remain in Storage.

## Source files

Customers receive the finished Vercel URL, not the source repository.
