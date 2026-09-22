# Your steps only

Do these account/setup actions; the code side is prepared in the starter.

## 1. Supabase
- Create a Supabase project.
- Open SQL Editor.
- Run `supabase/schema.sql`.
- Copy the project URL and publishable key.
- Keep the Supabase secret key private.

## 2. PayPal
- Create/login to the PayPal Developer dashboard.
- Create a sandbox app first.
- Get the sandbox Client ID and Client Secret.
- Do NOT paste the secret into GitHub or the frontend.
- Later, create/use production credentials after testing.

## 3. Razorpay
- Create/login to Razorpay.
- Get test Key ID and Key Secret.
- Later create/configure the production credentials.
- Configure the webhook URL:
  /api/razorpay/webhook
- Use the webhook secret generated/configured in Razorpay.

## 4. Vercel
- Import the project/repository.
- Add the environment variables from `.env.example`.
- Deploy.
- Test with sandbox/test credentials first.

## 5. Business content
You still decide:
- final package prices
- deployment durations/prices
- add-on prices
- final theme names
- festival campaigns
- Instagram/Ko-fi copy

Everything else can be implemented in code.
