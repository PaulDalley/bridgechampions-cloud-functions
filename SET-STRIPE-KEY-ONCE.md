# Set Stripe key once (all functions get it)

Your code now uses **environment variables only** (`functions/.env` at deploy time).  
No `functions.config()` fallback for Stripe keys, to avoid silent key-source conflicts.

## Steps

1. **Open a terminal** and go to the cloud functions project:
   ```bash
   cd ishbridge-41-cloud-functions
   ```

2. **Log in and select project** (if needed):
   ```bash
   firebase login
   firebase use bridgechampions
   ```
   (Use your actual Firebase project ID if it’s different.)

3. **Set keys in `functions/.env`** (replace with real values, never commit):
   ```dotenv
   STRIPE_KEY_LIVE=sk_live_YOUR_NEW_KEY_HERE
   STRIPE_KEY_DEV=sk_test_YOUR_DEV_KEY
   STRIPE_WEBHOOK_SECRET_LIVE=whsec_YOUR_LIVE_SECRET
   STRIPE_WEBHOOK_SECRET_DEV=whsec_YOUR_DEV_SECRET
   ```

4. **Run env validation**:
   ```bash
   cd functions
   npm run check:env
   ```

5. **Deploy Stripe functions**:
   ```bash
   firebase deploy --only functions:stripeCreateCheckoutSession,functions:stripeVerifyCheckoutSession,functions:stripeCancelSubscription,functions:stripeWebhookHandler
   ```

After this, every Stripe function uses the same key source and deploy will fail early if the env is missing/placeholder.

**Security:** never paste real keys in chat/email or commit `functions/.env`.
