# BdayStudio Razorpay Payment Patch

This patch replaces the old browser-side PayPal checkout flow with Razorpay Standard Checkout.

## Included changes

- Razorpay Standard Checkout on the website.
- INR and USD displayed together on package/order pricing.
- INR checkout and USD checkout selection.
- Server-side Razorpay order creation.
- Server-side Razorpay signature verification.
- Payment capture handling when a payment is still `authorized`.
- Supabase order status changes from `payment_pending/unpaid` to `paid` after verified capture.
- PayPal sandbox SDK removed from the storefront checkout.
- Festival section removed from the current storefront page.

## Existing files this patch expects

The project already needs these existing files from your current repo:

- `lib/supabaseAdmin.js`
- `lib/catalog.js`
- your existing Supabase setup and upload endpoints

## Vercel Environment Variables

Add these to the same Vercel project:

```text
RAZORPAY_KEY_ID=rzp_test_...       # use rzp_live_... for production
RAZORPAY_KEY_SECRET=...
BDAYSTUDIO_USD_TO_INR=90
```

`BDAYSTUDIO_USD_TO_INR` controls the storefront conversion used for the INR price. Change it once in Vercel instead of changing every package manually.

Do NOT put `RAZORPAY_KEY_SECRET` in the frontend.

## Current displayed prices at the default rate of ₹90/USD

- Mini: $5 / ₹450
- Classic: $9 / ₹810
- Deluxe: $15 / ₹1,350
- 30-day extension: +$2 / +₹180
- 90-day extension: +$5 / +₹450
- 1-year extension: +$10 / +₹900

The add-ons use the same fixed conversion.

## Checkout flow

Theme → Package → Deployment → Add-ons → Customer details → Razorpay Checkout → server verification → media upload.

Razorpay's Checkout receives a server-created `order_id`; the payment response is sent back to `/api/orders/verify`, where the signature is verified using the Razorpay secret before the order is marked paid.
