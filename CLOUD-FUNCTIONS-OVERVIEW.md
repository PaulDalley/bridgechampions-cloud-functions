# Cloud Functions overview

Your backend is **Firebase Cloud Functions (1st Gen)** in `us-central1`. They are not deprecated—they’re the current production API. You don’t need to remove or “redo” them unless you want to change how the backend works.

## What the app uses (keep these)

| Function | Used by |
|----------|--------|
| `contactUs` | Contact form |
| `sendWelcomeEmail` | Firebase Auth (runs on new sign-up) |
| `stripeCreateCheckoutSession` | Stripe checkout |
| `stripeVerifyCheckoutSession` | After Stripe checkout (HomePage) |
| `stripeCancelSubscription` | Profile / Settings – cancel Stripe |
| `stripeWebhookHandler` | Stripe (webhooks from Stripe’s servers) |
| `paypalCancelSubscription` | Profile / Settings – cancel PayPal |
| `ipnHandler` | PayPal IPN |
| `process` | PayPal flow |
| `storePayPalPendingPromo` | PayPal promo flow |
| `getPayPalButton` | PayPal |
| `validateUserToken` | Premium / Coupons |
| `generateUserTokens` | DBComp (admin/tokens) |
| `adminCreateUserAndGrantAccess` | Settings – admin |
| `adminEmailAllOrSubscribers` | Settings – email users |
| `articlesCounterIncrement` / `articlesCounterDecrement` | Firestore (articles) |
| `quizzesCounterIncrement` / `quizzesCounterDecrement` | Firestore (quizzes) |
| `scheduledSyncStripeSubscriptions` | Scheduled sync |
| `manualActivateSubscription` | Admin (if you use it) |

## Optional / possibly unused

- **`updateDailyFree`** – Call in `App.js` is commented out; safe to remove from code and delete the function if you don’t use it.
- **`stripeSubscribeTokenHandler`** – Old Stripe flow; app now uses `stripeCreateCheckoutSession`. Only remove if you’re sure no client still calls it.
- **`activateBillingPlan`** / **`monthlyBilling`** – Legacy billing; only remove if you’ve fully moved to Stripe/PayPal flows above.

## What you can do

1. **Just fix config (recommended)**  
   - In Cloud Console, remove **GMAIL_EMAIL** and **GMAIL_PASSWORD** (you did this).  
   - Update **STRIPE_KEY_LIVE** (and **STRIPE_WEBHOOK_SECRET_LIVE** if the webhook secret changed).  
   No need to remove or redo the functions.

2. **Delete a single function**  
   Only delete one if you also remove or change every place in the app that calls it (see table above). Deleting a function that the app still calls will break that feature.

3. **“Redo” = redeploy from this repo**  
   From `ishbridge-41-cloud-functions` run:  
   `npm install` then `npm run deploy` (or `firebase deploy --only functions`).  
   That redeploys the same functions with the code in this repo. Env vars are set in the **Cloud Console**, not in the repo, so after deploy you still need to set/update them there (Stripe, PayPal, etc.).

4. **Migrate to 2nd Gen**  
   Google’s newer style (Cloud Run–based). Bigger change: code and deployment config would need updating; only do this if you have a concrete reason (e.g. longer timeouts, different scaling).

**Summary:** The functions themselves are current. Clean up env vars (Gmail removed, Stripe updated) and optionally remove one or two unused functions after checking the app doesn’t call them.

## Promo codes (safeguards)

- **`blue` = `harbourview`** on the server for `validateUserToken`, `stripeCreateCheckoutSession`, and PayPal IPN — so codes work even when one UI sends `BLUE` and Firestore only has `harbourview`.
- **`validateUserToken`** returns a **whitelist of JSON-safe fields** from each token doc so stray Firestore types (e.g. Timestamps) cannot break the endpoint with a 500.
- If anything throws while validating **harbourview / blue / goldy**, the handler still returns the **30-day safety-net** JSON instead of failing closed (business-critical promos).
