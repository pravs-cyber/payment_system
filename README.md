# bdaystudio – final checkout build

## Flow
1. Choose theme → theme is selected and page moves to Packages.
2. Choose package → moves to deployment extension.
3. Choose deployment extension → moves to Add-ons.
4. Select any add-ons → click **Continue to your details**.
5. Registration/details are completed before payment.
6. PayPal checkout is loaded only after details are complete.
7. PayPal approval is verified server-side by `/api/orders/capture` before the order is marked paid.
8. Media upload is available after successful payment.

## PayPal testing
This build uses PayPal's standard JavaScript SDK checkout flow instead of the previous v6 `start()` session flow. The client ID is safe to expose to the browser; the PayPal secret stays server-side in Vercel.

Use:
- `PAYPAL_ENV=sandbox`
- a Sandbox **Business** account as the seller
- a separate Sandbox **Personal** account as the buyer
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` from the same Sandbox app

The PayPal popup is normal checkout behavior. It is not a separate verification-only flow: the buyer logs in, approves the payment, then the server captures and verifies the payment.

## Vercel environment variables
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`)
- `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_ENV=sandbox` for testing

`SUPABASE_URL` is the project URL, e.g. `https://YOUR_PROJECT_REF.supabase.co` — not the REST API URL.
