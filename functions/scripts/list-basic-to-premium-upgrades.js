/**
 * List customers who upgraded from Basic ($25) to Premium ($50).
 *
 * Uses Stripe Events (customer.subscription.updated) to find price changes
 * from Basic price to Premium price. Also checks invoice history for
 * current Premium subscribers who had a Basic invoice in the past.
 *
 * Run from functions directory:
 *   cd functions
 *   STRIPE_KEY_LIVE=sk_live_xxx node scripts/list-basic-to-premium-upgrades.js
 *
 * Optional: GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json
 *   to resolve Stripe customer email -> Firebase uid.
 */

const Stripe = require("stripe");

// Price IDs from PremiumMembership.js (Basic $25, Premium $50)
const STRIPE_PRICE_BASIC = "price_1SXsQTE9mroRD7lKZAqvGZCD";
const STRIPE_PRICE_PREMIUM = "price_1SXVk6E9mroRD7lKIHxCKA7c";

function getPriceIdFromSubscription(sub) {
  const item = sub?.items?.data?.[0];
  const price = item?.price;
  return typeof price === "object" ? price?.id : price;
}

async function main() {
  const stripeKey = process.env.STRIPE_KEY_LIVE || process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error("Set STRIPE_KEY_LIVE (or STRIPE_SECRET_KEY) with your Stripe secret key.");
    process.exit(1);
  }
  const stripe = new Stripe(stripeKey);

  console.log("=== Basic ($25) → Premium ($50) upgrades ===\n");

  const upgrades = [];
  let hasMore = true;
  let startingAfter = undefined;

  // 1) Subscription updated events: find ones where price went Basic → Premium
  console.log("Scanning Stripe subscription.updated events...");
  while (hasMore) {
    const list = await stripe.events.list({
      type: "customer.subscription.updated",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const ev of list.data) {
      const obj = ev.data?.object;
      const prev = ev.data?.previous_attributes;
      if (!obj) continue;

      const currentPriceId = getPriceIdFromSubscription(obj);
      let previousPriceId = null;
      if (prev?.items?.data?.[0]?.price) {
        const p = prev.items.data[0].price;
        previousPriceId = typeof p === "object" ? p?.id : p;
      }
      if (prev?.items && Array.isArray(prev.items) && prev.items[0]?.price) {
        const p = prev.items[0].price;
        previousPriceId = typeof p === "object" ? p?.id : p;
      }

      if (previousPriceId === STRIPE_PRICE_BASIC && currentPriceId === STRIPE_PRICE_PREMIUM) {
        const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
        const subId = obj.id;
        const created = ev.created ? new Date(ev.created * 1000).toISOString() : "";
        upgrades.push({
          when: created,
          subscriptionId: subId,
          customerId,
          uid: obj.metadata?.uid || null,
        });
      }
    }

    hasMore = list.has_more;
    if (list.data.length) startingAfter = list.data[list.data.length - 1].id;
    else hasMore = false;
  }

  // Dedupe by subscription (same sub might have multiple update events)
  const bySub = new Map();
  for (const u of upgrades) {
    if (!bySub.has(u.subscriptionId)) bySub.set(u.subscriptionId, u);
  }
  const uniqueUpgrades = [...bySub.values()];

  // 2) Optionally: current Premium subs that have an older invoice with Basic (they may have upgraded via new checkout, so no subscription.updated)
  console.log("Checking current Premium subscribers for past Basic invoices...");
  const subs = await stripe.subscriptions.list({
    status: "all",
    limit: 100,
    expand: ["data.customer", "data.items.data.price"],
  });

  const premiumSubs = subs.data.filter((s) => {
    const priceId = getPriceIdFromSubscription(s);
    return priceId === STRIPE_PRICE_PREMIUM && (s.status === "active" || s.status === "trialing");
  });

  for (const sub of premiumSubs) {
    const subId = sub.id;
    if (bySub.has(subId)) continue; // already found via events

    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    const invoices = await stripe.invoices.list({
      subscription: subId,
      limit: 100,
      status: "paid",
    });

    let hadBasic = false;
    for (const inv of invoices.data) {
      for (const line of inv.lines?.data || []) {
        const priceId = line.price?.id;
        if (priceId === STRIPE_PRICE_BASIC) {
          hadBasic = true;
          break;
        }
      }
      if (hadBasic) break;
    }
    if (hadBasic) {
      uniqueUpgrades.push({
        when: "(from invoice history)",
        subscriptionId: subId,
        customerId,
        uid: sub.metadata?.uid || null,
      });
    }
  }

  // Report
  console.log("\n--- Upgrades (Basic $25 → Premium $50) ---\n");
  if (uniqueUpgrades.length === 0) {
    console.log("No upgrades found in Stripe (events or invoice history).");
    console.log("(If you recently added the $25/$50 tiers, events may only exist from that point on.)\n");
    return;
  }
  console.log(`Found ${uniqueUpgrades.length} upgrade(s):\n`);
  uniqueUpgrades.forEach((u, i) => {
    console.log(`${i + 1}. subscription=${u.subscriptionId} customer=${u.customerId} uid=${u.uid || "(none)"} at ${u.when}`);
  });
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
