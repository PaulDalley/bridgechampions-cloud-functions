/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");
const REQUIRED_KEYS = [
  "STRIPE_KEY_LIVE",
  "STRIPE_KEY_DEV",
];
const OPTIONAL_KEYS = [
  "PAYPAL_CLIENT_ID_PROD",
  "PAYPAL_CLIENT_SECRET_PROD",
  "PAYPAL_CLIENT_ID_DEV",
  "PAYPAL_CLIENT_SECRET_DEV",
];

const parseEnv = (text) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
};

const looksPlaceholder = (v) => {
  const s = String(v || "").toLowerCase();
  return !s || s.includes("your_") || s.includes("replace_me") || s.includes("xxxxx");
};

const keyMask = (k) => {
  if (!k) return "(empty)";
  if (k.length <= 6) return "***";
  return `***${k.slice(-6)}`;
};

const fail = (msg) => {
  console.error(`\n[env-check] ${msg}\n`);
  process.exit(1);
};

if (!fs.existsSync(ENV_PATH)) {
  fail(`Missing ${ENV_PATH}. Create it before deploying.`);
}

const envText = fs.readFileSync(ENV_PATH, "utf8");
const env = parseEnv(envText);

for (const key of REQUIRED_KEYS) {
  if (!(key in env)) fail(`Missing ${key} in functions/.env`);
  if (looksPlaceholder(env[key])) fail(`${key} looks empty/placeholder`);
}

for (const key of OPTIONAL_KEYS) {
  const v = (env[key] || "").trim();
  if (!v) {
    console.warn(`[env-check] WARN: ${key} is not set (ok if PayPal is retired).`);
    continue;
  }
  if (looksPlaceholder(v)) {
    fail(`${key} looks empty/placeholder`);
  }
}

const liveWebhook = (env.STRIPE_WEBHOOK_SECRET_LIVE || "").trim();
const liveWebhookMulti = (env.STRIPE_WEBHOOK_SECRETS_LIVE || "").trim();
if (!liveWebhook && !liveWebhookMulti) {
  fail("Missing STRIPE_WEBHOOK_SECRET_LIVE (or STRIPE_WEBHOOK_SECRETS_LIVE) in functions/.env");
}

if (!env.STRIPE_KEY_LIVE.startsWith("sk_live_")) {
  fail("STRIPE_KEY_LIVE must start with sk_live_");
}
if (!env.STRIPE_KEY_DEV.startsWith("sk_test_")) {
  fail("STRIPE_KEY_DEV must start with sk_test_");
}
if (liveWebhook && !liveWebhook.startsWith("whsec_")) {
  fail("STRIPE_WEBHOOK_SECRET_LIVE must start with whsec_");
}
if (liveWebhookMulti) {
  const bad = liveWebhookMulti
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .find((s) => !s.startsWith("whsec_"));
  if (bad) fail("STRIPE_WEBHOOK_SECRETS_LIVE contains a value without whsec_ prefix");
}

const devWebhook = (env.STRIPE_WEBHOOK_SECRET_DEV || "").trim();
if (devWebhook && !devWebhook.startsWith("whsec_")) {
  fail("STRIPE_WEBHOOK_SECRET_DEV must start with whsec_");
}

console.log("[env-check] OK");
console.log(`[env-check] STRIPE_KEY_LIVE: ${keyMask(env.STRIPE_KEY_LIVE)}`);
console.log(`[env-check] STRIPE_KEY_DEV: ${keyMask(env.STRIPE_KEY_DEV)}`);
