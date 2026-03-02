/**
 * One-off: create members doc for UID XXuJXsPQUjaFKXrD9WUu3qXFrD73 (subscribed but doc never created).
 * Unknown if Stripe or PayPal – using stripe + 1 month expiry. Update in Firestore if needed.
 *
 * After running: look up this user in Stripe (Customers by email) or PayPal, get the real
 * subscriptionId (sub_xxx or I-xxx) and subscriptionExpires, then edit the doc in Firestore
 * so renewals and cancellation work.
 *
 * Run: cd functions && node scripts/add-member-XXuJXsPQUjaFKXrD9WUu3qXFrD73.js
 * Or: GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json node scripts/add-member-XXuJXsPQUjaFKXrD9WUu3qXFrD73.js
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({ projectId: "bridgechampions" });
}

const db = admin.firestore();

const UID = "XXuJXsPQUjaFKXrD9WUu3qXFrD73";
// 1 month from now – replace with real period end from Stripe/PayPal when you have it
const SUBSCRIPTION_EXPIRES = new Date();
SUBSCRIPTION_EXPIRES.setDate(SUBSCRIPTION_EXPIRES.getDate() + 31);

async function main() {
  const ref = db.collection("members").doc(UID);
  await ref.set(
    {
      subscriptionId: "PENDING_LOOKUP", // replace in Firestore with real sub_xxx or PayPal agreement id
      subscriptionExpires: admin.firestore.Timestamp.fromDate(SUBSCRIPTION_EXPIRES),
      subscriptionActive: true,
      paymentMethod: "stripe", // change to "paypal" in Firestore if it was PayPal
    },
    { merge: true }
  );
  console.log("Done. members/%s created. Update subscriptionId (and paymentMethod if PayPal) in Firestore.", UID);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
