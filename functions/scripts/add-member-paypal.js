/**
 * One-off script: create/update a members document for a PayPal subscriber
 * when the doc was never created (e.g. user never reached /process return URL).
 *
 * Run from functions directory with Firebase credentials, e.g.:
 *   cd functions && node scripts/add-member-paypal.js
 * Or with a service account key:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json node scripts/add-member-paypal.js
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({ projectId: "bridgechampions" });
}

const db = admin.firestore();

const UID = "6f8yg6ZVoOUZgMJ7LpRcBr2iq9H2";
const SUBSCRIPTION_ID = "I-WDJ2FULXHCBS"; // PayPal Recurring Payment ID
// Current period end: payment was 1 March 2026, so next billing ~1 April 2026
const SUBSCRIPTION_EXPIRES = new Date("2026-04-01T00:00:00.000Z");

async function main() {
  const ref = db.collection("members").doc(UID);
  await ref.set(
    {
      subscriptionId: SUBSCRIPTION_ID,
      subscriptionExpires: admin.firestore.Timestamp.fromDate(SUBSCRIPTION_EXPIRES),
      subscriptionActive: true,
      paymentMethod: "paypal",
    },
    { merge: true }
  );
  console.log("Done. members/%s updated.", UID);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
