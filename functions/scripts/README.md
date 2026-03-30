# One-off scripts

## audit-premium-access.js

Audits that everyone who should have premium access actually has it:
- **Stripe**: Compares active Premium subscriptions to Firestore `tier` (flags any with tier=basic)
- **Firestore**: Flags members with `subscriptionActive=true` but `tier=basic` or missing (may need manual review for PayPal)

**Run** from the `functions` directory:

```bash
cd functions

# Audit only (report mismatches)
GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json STRIPE_KEY_LIVE=sk_live_xxx node scripts/audit-premium-access.js

# Fix Stripe mismatches automatically (set tier=premium for Stripe Premium payers)
GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json STRIPE_KEY_LIVE=sk_live_xxx node scripts/audit-premium-access.js --fix

# Dry run (see what --fix would do, no writes)
node scripts/audit-premium-access.js --fix --dry-run
```

For Firestore-only suspicious members (e.g. PayPal), verify manually in Firebase Console and set `tier: "premium"` if they paid for Premium.

---

## Preventing sync gaps (automatic)

To avoid members having Stripe subscriptions but missing `subscriptionActive`/`subscriptionExpires`:

1. **Scheduled daily sync** – A Cloud Function `scheduledSyncStripeSubscriptions` runs daily at 7am ET and syncs any missing subscriptions.
2. **Webhook fallbacks** – The Stripe webhook now handles `customer.subscription.created` and `customer.subscription.updated` in addition to `checkout.session.completed`. Ensure your Stripe webhook endpoint is subscribed to these events (Stripe Dashboard → Webhooks → your endpoint → add events).

## sync-stripe-subscriptions-to-firestore.js

Syncs Stripe trialing/active subscriptions to Firestore `members` docs. Use when users have a Stripe subscription but their `members` doc only has `lastCheckoutStartedAt` (webhook or success-page verification didn't run).

**Run** from the `functions` directory:

```bash
cd functions

# Dry run first (see what would be updated, no writes)
STRIPE_KEY_LIVE=sk_live_xxx GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json node scripts/sync-stripe-subscriptions-to-firestore.js --dry-run

# Apply changes
STRIPE_KEY_LIVE=sk_live_xxx GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json node scripts/sync-stripe-subscriptions-to-firestore.js
```

Get your Stripe secret key from Stripe Dashboard → Developers → API keys. Use the **live** key (sk_live_...) for production.

---

## add-member-paypal.js

Creates or updates a `members` document for a PayPal subscriber when the doc was never created (e.g. they never reached the /process return URL after approving on PayPal).

**Run once** from the `functions` directory with Firebase credentials:

```bash
cd functions

# Option A: Use a service account key (download from Firebase Console → Project settings → Service accounts)
GOOGLE_APPLICATION_CREDENTIALS=path/to/bridgechampions-serviceAccountKey.json node scripts/add-member-paypal.js

# Option B: If you use gcloud and have set the project
gcloud auth application-default login
node scripts/add-member-paypal.js
```

Alternatively, create the document manually in Firebase Console → Firestore → `members` (see script for the exact field values).

---

## Verifying manually added members (webhook / recurring payment link)

If you created `members` docs by hand for people who had already paid (e.g. PayPal subscriber but doc never created), make sure they stay linked to the real recurring payment so **renewals and cancellation** work.

### How the link works

- **PayPal IPN (webhook):** When PayPal sends a renewal (or signup/cancel), it identifies the user either by:
  1. **`custom`** = Firebase uid (set when they started checkout). The handler updates `members/{uid}`.
  2. **Fallback:** If `custom` is missing (e.g. old agreement), the handler looks up **`members` where `subscriptionId` equals** the IPN’s subscription id (`subscr_id` / `recurring_payment_id`) and updates that doc.

So for **renewals** to apply to the right person, either:

- Their **document ID** is their real Firebase **uid** (so when PayPal sends `custom=uid`, we update that doc), **or**
- Their **`subscriptionId`** in the doc is the **exact** PayPal subscription id (I-xxx or recurring profile id) so the fallback lookup finds them.

### Checklist for the two members you added manually

1. **Firestore → `members`**  
   Open the doc for each user (by their **uid** as document ID).

2. **Confirm document ID = Firebase uid**  
   The doc’s ID must be their real auth uid (e.g. `6f8yg6ZVoOUZgMJ7LpRcBr2iq9H2`, `XXuJXsPQUjaFKXrD9WUu3qXFrD73`). If you created the doc under a different ID, the IPN can’t find them by `custom`; the fallback (by `subscriptionId`) will still work if the next step is correct.

3. **Confirm `subscriptionId` = real PayPal subscription id**  
   - For **PayPal:** In PayPal Dashboard → Recurring payments / Subscriptions, find their subscription and copy the **Subscription ID** (e.g. `I-WDJ2FULXHCBS`). Set `members/{uid}.subscriptionId` to that exact value.  
   - For **Stripe:** Use the Stripe subscription id (e.g. `sub_xxx`).  
   - If you left `subscriptionId` as `"PENDING_LOOKUP"` or a placeholder, **replace it** with the real id so that:
     - Renewals: IPN fallback can find the doc by `subscriptionId` when `custom` is missing.
     - Cancellation: “Cancel subscription” in your app uses this id to cancel in PayPal/Stripe.

4. **Confirm `paymentMethod`**  
   Set to `"paypal"` or `"stripe"` so the app and cancellation use the right provider.

5. **Confirm `subscriptionExpires`**  
   Should match the current period end (e.g. next billing date) so access doesn’t drop early.

### Code changes that help

- **New agreements:** The billing agreement now sends `custom: uid` to PayPal, so future IPNs will have `custom` and the right `members` doc will be updated by uid.
- **Existing agreements without `custom`:** The IPN handler now has a **fallback**: if `custom` is missing, it looks up `members` by `subscriptionId` (using the IPN’s `subscr_id` / `recurring_payment_id`). So as long as the manual member’s doc has the **correct `subscriptionId`**, their next renewal IPN will still update that doc.
