/**
 * One-off script: Sync Stripe trialing/active subscriptions to Firestore members.
 * Finds members who have a Stripe subscription but lack subscriptionActive/subscriptionExpires in Firestore.
 *
 * Run from functions directory:
 *   cd functions
 *   STRIPE_KEY_LIVE=sk_live_xxx GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json node scripts/sync-stripe-subscriptions-to-firestore.js
 *
 * Or if using Firebase config:
 *   firebase functions:config:get  # ensure stripe_key.live is set
 *   node scripts/sync-stripe-subscriptions-to-firestore.js
 *
 * Use --dry-run to see what would be updated without writing.
 */

const admin = require("firebase-admin");
const Stripe = require("stripe");

const DRY_RUN = process.argv.includes("--dry-run");

if (!admin.apps.length) {
  admin.initializeApp({ projectId: "bridgechampions" });
}

const db = admin.firestore();

let stripeKey = process.env.STRIPE_KEY_LIVE || process.env.STRIPE_SECRET_KEY;
if (!stripeKey && process.env.GCLOUD_PROJECT) {
  try {
    stripeKey = require("firebase-functions").config().stripe_key?.live;
  } catch (_) {}
}

if (!stripeKey) {
  console.error("Missing Stripe key. Set STRIPE_KEY_LIVE or ensure functions.config().stripe_key.live is set.");
  process.exit(1);
}

const stripe = new Stripe(stripeKey);

function normalizeTier(tierName) {
  if (!tierName || typeof tierName !== "string") return "premium";
  const t = tierName.toLowerCase();
  if (t.includes("basic")) return "basic";
  if (t.includes("premium")) return "premium";
  return "premium";
}

async function getUidFromCustomerEmail(email) {
  if (!email) return null;
  const users = await admin.auth().listUsers(1000);
  const match = users.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
  return match ? match.uid : null;
}

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN (no writes) ===" : "=== Syncing Stripe subscriptions to Firestore ===");

  const toFix = [];
  const subs = await stripe.subscriptions.list({
    status: "all",
    limit: 100,
    expand: ["data.customer", "data.items.data.price"],
  });

  for (const sub of subs.data) {
    if (sub.status !== "trialing" && sub.status !== "active") continue;

    let uid = sub.metadata?.uid;
    if (!uid) {
      const sessions = await stripe.checkout.sessions.list({ subscription: sub.id, limit: 1 });
      if (sessions.data?.length) uid = sessions.data[0].metadata?.uid;
    }
    if (!uid && typeof sub.customer === "object" && sub.customer?.email) {
      uid = await getUidFromCustomerEmail(sub.customer.email);
    }
    if (!uid) {
      console.log(`  Skip sub ${sub.id}: no uid in metadata or customer email (${sub.customer?.email || "no email"})`);
      continue;
    }

    const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
    const expiresDate = trialEnd || periodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const product = sub.items?.data?.[0]?.price?.product;
    let tier = "premium";
    if (typeof product === "object" && product?.name) {
      tier = normalizeTier(product.name);
    }

    const memberRef = db.collection("members").doc(uid);
    const memberSnap = await memberRef.get();
    const data = memberSnap.exists ? memberSnap.data() : {};
    const hasActive = data.subscriptionActive === true;
    const hasExpires = !!data.subscriptionExpires;

    if (hasActive && hasExpires) {
      console.log(`  OK uid=${uid}: already has subscriptionActive and subscriptionExpires`);
      continue;
    }

    toFix.push({
      uid,
      subscriptionId: sub.id,
      subscriptionExpires: expiresDate,
      subscriptionActive: true,
      paymentMethod: "stripe",
      tier,
      stripeStatus: sub.status,
      stripeTrialEnd: trialEnd ? trialEnd.toISOString() : null,
      customerEmail: typeof sub.customer === "object" ? sub.customer.email : null,
    });
  }

  console.log(`\nFound ${toFix.length} subscription(s) to sync.`);

  for (const fix of toFix) {
    const { uid, ...updateData } = fix;
    const payload = {
      ...updateData,
      subscriptionExpires: admin.firestore.Timestamp.fromDate(
        fix.subscriptionExpires instanceof Date ? fix.subscriptionExpires : new Date(fix.subscriptionExpires)
      ),
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    delete payload.customerEmail;

    console.log(`  ${DRY_RUN ? "[DRY RUN] Would update" : "Updating"} members/${uid}: subscriptionActive=true, expires=${fix.subscriptionExpires.toISOString()}`);
    if (!DRY_RUN) {
      await db.collection("members").doc(uid).set(payload, { merge: true });
    }
  }

  console.log(`\nDone. ${DRY_RUN ? "Run without --dry-run to apply." : `${toFix.length} member(s) updated.`}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
