/**
 * Audit script: Check that everyone who should have premium access actually has it.
 *
 * Compares:
 * 1. Stripe: active/trialing subscriptions with Premium product -> Firestore tier
 * 2. Firestore: members with subscriptionActive but tier=basic or missing (possible mismatches)
 *
 * Run from functions directory:
 *   cd functions
 *   STRIPE_KEY_LIVE=sk_live_xxx GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json node scripts/audit-premium-access.js
 *
 * Use --fix to apply tier corrections for Stripe-premium members who have tier=basic in Firestore.
 *   node scripts/audit-premium-access.js --fix
 */

const admin = require("firebase-admin");
const Stripe = require("stripe");

const DRY_RUN = process.argv.includes("--dry-run");
const FIX = process.argv.includes("--fix");

// Price IDs from PremiumMembership.js
const STRIPE_PRICE_PREMIUM = "price_1SXVk6E9mroRD7lKIHxCKA7c";
const STRIPE_PRICE_BASIC = "price_1SXsQTE9mroRD7lKZAqvGZCD";

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

  const stripe = stripeKey ? new Stripe(stripeKey) : null;

  console.log("=== Premium Access Audit ===\n");

  const stripeMismatches = [];
  const firestoreSuspicious = [];

  // 1. Stripe: Check active/trialing Premium subs
  if (stripe) {
    console.log("Checking Stripe subscriptions...");
    const subs = await stripe.subscriptions.list({
      status: "all",
      limit: 100,
      expand: ["data.customer", "data.items.data.price"],
    });

    for (const sub of subs.data) {
      if (sub.status !== "trialing" && sub.status !== "active") continue;

      const price = sub.items?.data?.[0]?.price;
      const priceId = price?.id;
      const product = price?.product;
      const productName = typeof product === "object" ? product?.name : null;
      const tier = priceId === STRIPE_PRICE_BASIC ? "basic" : priceId === STRIPE_PRICE_PREMIUM ? "premium" : normalizeTier(productName);

      if (tier !== "premium") continue;

      let uid = sub.metadata?.uid;
      if (!uid) {
        const sessions = await stripe.checkout.sessions.list({ subscription: sub.id, limit: 1 });
        if (sessions.data?.length) uid = sessions.data[0].metadata?.uid;
      }
      if (!uid && typeof sub.customer === "object" && sub.customer?.email) {
        uid = await getUidFromCustomerEmail(sub.customer.email);
      }
      if (!uid) {
        console.log(`  Skip Stripe sub ${sub.id}: no uid (Premium product)`);
        continue;
      }

      const memberSnap = await db.collection("members").doc(uid).get();
      const data = memberSnap.exists ? memberSnap.data() : {};
      const firestoreTier = data.tier || "basic";
      const subscriptionActive = data.subscriptionActive === true;

      if (firestoreTier !== "premium" || !subscriptionActive) {
        stripeMismatches.push({
          uid,
          subscriptionId: sub.id,
          stripeTier: "premium",
          firestoreTier,
          subscriptionActive,
          customerEmail: typeof sub.customer === "object" ? sub.customer.email : null,
        });
      }
    }
    console.log(`  Found ${stripeMismatches.length} Stripe Premium subscriber(s) with wrong/missing Firestore tier.\n`);
  } else {
    console.log("Skipping Stripe (no STRIPE_KEY_LIVE).\n");
  }

  // 2. Firestore: Members with active sub but tier=basic or missing
  console.log("Checking Firestore members...");
  const membersSnap = await db.collection("members").get();
  const now = Date.now();

  for (const doc of membersSnap.docs) {
    const data = doc.data();
    if (!data.subscriptionActive) continue;

    const exp = data.subscriptionExpires;
    const expiresAt = exp ? (exp.toMillis ? exp.toMillis() : new Date(exp).getTime()) : 0;
    if (expiresAt > 0 && expiresAt < now) continue;

    const tier = data.tier || "basic";
    if (tier !== "premium") {
      firestoreSuspicious.push({
        uid: doc.id,
        tier: tier || "(missing)",
        paymentMethod: data.paymentMethod || "(unknown)",
        subscriptionExpires: exp ? (exp.toDate ? exp.toDate().toISOString() : exp) : null,
      });
    }
  }
  console.log(`  Found ${firestoreSuspicious.length} Firestore member(s) with subscriptionActive but tier != premium.\n`);

  // Report
  console.log("--- REPORT ---\n");

  if (stripeMismatches.length > 0) {
    console.log("STRIPE PREMIUM BUT FIRESTORE WRONG (should have premium):");
    stripeMismatches.forEach((m) => {
      console.log(`  uid=${m.uid} | Firestore tier="${m.firestoreTier}" subscriptionActive=${m.subscriptionActive} | Stripe sub=${m.subscriptionId} | ${m.customerEmail || ""}`);
    });
    console.log("");
  }

  if (firestoreSuspicious.length > 0) {
    console.log("FIRESTORE: subscriptionActive but tier != premium (may need manual review):");
    firestoreSuspicious.forEach((m) => {
      console.log(`  uid=${m.uid} | tier="${m.tier}" | paymentMethod=${m.paymentMethod} | expires=${m.subscriptionExpires || "?"}`);
    });
    console.log("");
  }

  if (stripeMismatches.length === 0 && firestoreSuspicious.length === 0) {
    console.log("No mismatches found. All premium payers appear to have correct access.\n");
    return;
  }

  // Fix Stripe mismatches if requested
  if (FIX && stripeMismatches.length > 0) {
    console.log("--- APPLYING FIXES (Stripe Premium -> Firestore tier=premium) ---\n");
    for (const m of stripeMismatches) {
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would set members/${m.uid}: tier=premium, subscriptionActive=true`);
      } else {
        await db.collection("members").doc(m.uid).set(
          { tier: "premium", subscriptionActive: true },
          { merge: true }
        );
        console.log(`  Updated members/${m.uid}: tier=premium, subscriptionActive=true`);
      }
    }
    console.log(`\nDone. ${DRY_RUN ? "Run without --dry-run to apply." : `${stripeMismatches.length} member(s) fixed.`}`);
  } else if (stripeMismatches.length > 0) {
    console.log("To fix Stripe mismatches automatically, run: node scripts/audit-premium-access.js --fix");
    console.log("(Use --dry-run first to see what would change.)\n");
  }

  if (firestoreSuspicious.length > 0) {
    console.log("For Firestore-only suspicious members (PayPal etc), verify manually in Firebase Console.");
    console.log("If they paid for Premium, edit their members doc: set tier=premium.\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
