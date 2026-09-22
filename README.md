# bdaystudio production starter

This is the starting backend structure for the bdaystudio storefront.

## What is already prepared

- Current bdaystudio showcase as `index.html`
- Supabase database schema
- Private Supabase Storage bucket for order media
- Server-side PayPal create/capture routes
- Server-side Razorpay order creation + signed webhook route
- Server-side order creation route
- Environment-variable template
- Vercel-compatible `/api` structure

## What you need to do

1. Create the Supabase project.
2. Run `supabase/schema.sql` in Supabase SQL Editor.
3. Create PayPal developer/sandbox credentials.
4. Create Razorpay credentials.
5. Create/connect the Vercel project.
6. Add the variables from `.env.example` to Vercel.
7. Test payments in sandbox/test mode before production.
8. Add production credentials only after the checkout flow is tested.

## Security

Never commit `.env`, PayPal secrets, Razorpay secrets, or the Supabase secret key.

The Supabase secret key bypasses Row Level Security and must stay server-side.
The PayPal client secret must stay server-side.
The Razorpay key secret must stay server-side.

## Current business flow

Standard order:
theme -> package -> deployment -> add-ons -> checkout -> payment -> order -> independent deployment.

Custom order:
Instagram DM -> discuss scope -> custom quote -> payment -> order.

Customers do not receive source files.
