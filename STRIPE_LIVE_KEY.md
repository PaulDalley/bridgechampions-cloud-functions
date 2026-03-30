# Fix “Expired API Key” / StripeAuthenticationError (live)

If checkout shows **500** with **`Expired API Key provided: sk_live_...`**, Stripe has **revoked or rotated** that secret. Your Cloud Functions still use the old value.

## 1. Get a current secret key

1. [Stripe Dashboard](https://dashboard.stripe.com) → **Developers** → **API keys** (live mode).
2. **Reveal** or **Roll** the **Secret key** (`sk_live_...`).
3. Copy the new secret once (Stripe may not show it again).

## 2. Put it where your functions read it

Your code uses `getStripe()` in `functions/index.js`, which reads:

- `process.env.STRIPE_KEY_LIVE` when running in **live** mode.

Set **one** of these in the environment for the deployed functions (Google Cloud / Firebase), for example:

- **Google Cloud Console** → **Cloud Functions** → open a Stripe-related function → **Edit** → **Runtime, build…** → **Environment variables** → add `STRIPE_KEY_LIVE` = `sk_live_...`  
  (Apply consistently to functions that call Stripe, or use a shared secret / `.env` workflow your project already uses.)

(`functions.config()` fallback for Stripe key was removed to avoid key-source drift.)

## 3. Redeploy if required

- If you only **changed variables in the Cloud Console**, the next **cold start** may pick them up; if errors persist, **redeploy** the Stripe functions.
- If you used **`functions:config:set`**, you **must redeploy** for config to apply.

## 4. Webhook secret (if you rolled keys)

If Stripe prompted you to rotate **webhook signing secrets**, update `STRIPE_WEBHOOK_SECRET_LIVE` (or your multi-secret env) to match the **Webhook** endpoint in Stripe Dashboard.

---

Until the live secret is valid, **no** checkout path will work, regardless of promo codes or UI.
