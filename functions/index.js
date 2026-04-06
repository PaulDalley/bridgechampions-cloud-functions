// in two places: see ##** CHANGE BETWEEN DEV AND PROD HERE:
const functions = require("firebase-functions");
// const functions = require('firebase-functions');

// INITIAL NOTES BY GOOGLE:
// // Create and deploy your first functions
// // https://firebase.google.com/docs/functions/get-started
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

// const cors = require('cors')({origin: true});
const cors = require("cors");
const paypal = require("paypal-rest-sdk");
const admin = require("firebase-admin");

// PayPal API Configuration
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "YOUR_CLIENT_ID";
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || "YOUR_SECRET";
const PAYPAL_API_BASE = "https://api-m.paypal.com";

// Get PayPal access token
const getPayPalAccessToken = async () => {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await response.json();
  return data.access_token;
};
const url = require("url");

const querystring = require("querystring");
const request = require("request");
const randomString = require("randomstring");

// -- ##** 1) STRIPE API toggle from sandbox to live:
// -- SEE ##** STRIPE STUFF:
const stripeLive = true; //true;

// const stripe = require("stripe")(
//   stripeLive ?
//     functions.config().stripe_key.live :
//     functions.config().stripe_key.dev,
// );

// Initialize Stripe lazily (only when needed)
let stripe = null;
const maskedKeySuffix = (key) => {
  const s = String(key || "");
  return s.length > 6 ? s.slice(-6) : s;
};
const hasPlaceholderValue = (value) => {
  const s = String(value || "").toLowerCase();
  return !s || s.includes("your_") || s.includes("replace_me") || s.includes("xxxxx");
};
const getStripeKeyFromEnv = () => {
  const keyName = stripeLive ? "STRIPE_KEY_LIVE" : "STRIPE_KEY_DEV";
  const expectedPrefix = stripeLive ? "sk_live_" : "sk_test_";
  const stripeKey = String(process.env[keyName] || "").trim();

  if (!stripeKey) {
    throw new Error(`Stripe API key not configured. Set ${keyName} in functions/.env (or deployment env).`);
  }
  if (hasPlaceholderValue(stripeKey)) {
    throw new Error(`Stripe API key in ${keyName} looks like a placeholder value.`);
  }
  if (!stripeKey.startsWith(expectedPrefix)) {
    throw new Error(`Stripe key mode mismatch in ${keyName}. Expected prefix ${expectedPrefix}.`);
  }
  return { keyName, stripeKey };
};
const getStripe = () => {
  if (!stripe) {
    // Single source of truth: deployment environment variables only.
    const { keyName, stripeKey } = getStripeKeyFromEnv();
    stripe = require("stripe")(stripeKey);
    console.log(
      `Stripe initialized in ${stripeLive ? "LIVE" : "DEV"} mode from ${keyName} (suffix: ${maskedKeySuffix(stripeKey)})`
    );
  }
  return stripe;
};

// Stripe webhook secret helpers
// Supports:
// - env: STRIPE_WEBHOOK_SECRET_LIVE / STRIPE_WEBHOOK_SECRET_DEV
// - env (multi): STRIPE_WEBHOOK_SECRETS_LIVE / STRIPE_WEBHOOK_SECRETS_DEV (comma-separated)
// Single source of truth: deployment environment variables only.
const getStripeWebhookSecrets = () => {
  const mode = stripeLive ? "LIVE" : "DEV";

  const multiEnv = stripeLive
    ? process.env.STRIPE_WEBHOOK_SECRETS_LIVE
    : process.env.STRIPE_WEBHOOK_SECRETS_DEV;
  const singleEnv = stripeLive
    ? process.env.STRIPE_WEBHOOK_SECRET_LIVE
    : process.env.STRIPE_WEBHOOK_SECRET_DEV;

  const fromMulti = (multiEnv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const secrets = [
    ...fromMulti,
    ...(singleEnv ? [singleEnv.trim()] : []),
  ];

  const unique = Array.from(new Set(secrets)).filter(Boolean);
  if (unique.length === 0) {
    console.error(`[Stripe][Webhook] No webhook secrets configured for ${mode}. Set STRIPE_WEBHOOK_SECRET_${mode} (or STRIPE_WEBHOOK_SECRETS_${mode}).`);
  } else {
    console.log(`[Stripe][Webhook] Loaded ${unique.length} webhook secret(s) for ${mode}.`);
  }
  return unique;
};

// Map UI/Stripe metadata tierName -> canonical tier key used by the app
const normalizeTier = (tierName) => {
  const s = (tierName || "").toString().trim().toLowerCase();
  if (!s) return undefined;
  if (s.includes("premium")) return "premium";
  if (s.includes("basic")) return "basic";
  return undefined;
};

// Best-effort tier inference from Stripe subscription item details.
// Never default to premium here; unknown should remain undefined.
const inferTierFromSubscription = (subscription) => {
  const item = subscription?.items?.data?.[0];
  const metadataTier =
    normalizeTier(subscription?.metadata?.tierName) ||
    normalizeTier(subscription?.metadata?.tier);
  const nicknameTier = normalizeTier(item?.price?.nickname);
  const productTier =
    normalizeTier(item?.price?.product?.name) ||
    normalizeTier(item?.plan?.product?.name);
  const intervalTier = normalizeTier(item?.price?.recurring?.interval);
  // Only trust explicit tier-like strings. "month" etc. will normalize to undefined.
  return metadataTier || nicknameTier || productTier || intervalTier;
};

// const stripe = require('stripe')(functions.config().stripe_key.live);
// const planId = "prod_CaO9pAb9VQ0QNI"; // <- $15.99 / month plan

// ## TEST:
// const planId = "bc-test-plan"; // <- AUD$1 / day -- TEST MODE PLAN.
// ## LIVE:
// const planId = "bc-monthly-live-test"; // <- AUD $1 / day w/ 1 day trial - LIVE MODE TEST PLAN.
// const planId = "bc-monthly-regular";  // <- AUD $16.99 / month w/ 1 week free.
// const planId = "plan_CkV3jJcVNJtxip";

// MY STRIPE ACCOUNT:
// const planId = stripeLive
//   ? "price_1MhjTpERRei2smAFuWa8Xkj5" // NEW LIVE PRODUCT - 16.99 AUD per month (no trial, has coupon codes)
//   : "price_1MhjdEERRei2smAFwIsZPjGN"; // NEW TEST PRODUCT - 16.99 AUD per month (no trial, has coupon codes)

// PAULS STRIPE ACCOUNT:
const planId = stripeLive
  ? "price_1MmPl5E9mroRD7lKpCar9WE4" // NEW LIVE PRODUCT - 16.99 AUD per month (no trial, has coupon codes)
  : "price_1MlMZqE9mroRD7lK5leAmTaP"; // NEW TEST PRODUCT - 16.99 AUD per month (no trial, has coupon codes)

// OLD STUFF:
// ? "prod_NSensSrYoJzAcN" // NEW LIVE PRODUCT - 16.99 AUD per month (no trial, has coupon codes)
// : "prod_NSexEU62P4pcje"; // NEW TEST PRODUCT - 16.99 AUD per month (no trial, has coupon codes)

// -- ##** 2) IPN TOGGLE from sandbox to live for paypal buttons.
// -- SEE ##** IPN CODE:
const sandbox = false;
/** Production Postback URL */
const PRODUCTION_VERIFY_URI = "https://ipnpb.paypal.com/cgi-bin/webscr";
/** Sandbox Postback URL */
const SANDBOX_VERIFY_URI = "https://ipnpb.sandbox.paypal.com/cgi-bin/webscr";

// 1) 1 week trial period, regular subscription @ $16.99 AUD per month:

const PAYPAL_BUTTON_ADRESS_REGULAR_NOTRIAL_SANDBOX =
  "https://www.sandbox.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=379VSUFUTY68J";
//"https://www.sandbox.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=UC9ANHQ7BFCUS";

const PAYPAL_BUTTON_ADDRESS_REGULAR = // regular has a trial period
  "https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=7JV5CPTQV3KGU"; // NEW SHOULD WORK
//"https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=TMS3V9BYRDQEL";

const PAYPAL_BUTTON_ADDRESS_REGULAR_NOTRIAL =
  "https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=BRFTEQT2QRXV8"; // NEW SHOULD WORK
//"https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=RNJSXE33CZTQC";

// const PAYPAL_BUTTON_ADDRESS_REGULAR_NOTRIAL =
//     sandbox ?
//     PAYPAL_BUTTON_ADRESS_REGULAR_SANDBOX :
//     "https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=RNJSXE33CZTQC";

// 2) 1 week trial period, regular sub with 25% off first month @ $16.99 per month:
const _25offLive =
  "https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=WKMXVPLLLV9SY";
const _25offSandbox =
  "https://www.sandbox.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=P5MMBRSFFNTNL";
const PAYPAL_BUTTON_ADDRESS_25off = sandbox ? _25offSandbox : _25offLive;

// const _25offLiveNoTrial = "https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=RTBDM7A6HXTZN";
// const _50offLiveNoTrial = "https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=FCWFMHCDKYZ2N";

// 3) 1 week trial period, regular sub with 50% off first month @ $16.99 per month:
const _50offSandbox =
  "https://www.sandbox.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=A3PMT74HKKDQL";
const _50offLive =
  "https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=X2L6649DBZTE4";
const PAYPAL_BUTTON_ADDRESS_50off = sandbox ? _50offSandbox : _50offLive;

// -- 3) PAYPAL API toggle from sandbox to live for paypal API - not using atm.
const ENVIRONMENT = "PROD"; // "DEV" or "PROD"
const PAYMENT_SALE_COMPLETED_WEBHOOK_ID_DEV = "2YK87595HJ036134G";
const PAYMENT_SALE_COMPLETED_WEBHOOK_ID_PROD = "3PV436700G564981F";

const _firebase = {
  databaseURL: process.env.FB_DATABASE_URL,
  storageBucket: process.env.FB_STORAGE_BUCKET,
  apiKey: process.env.FB_API_KEY,
  authDomain: process.env.FB_AUTH_DOMAIN,
  projectId: process.env.FB_PROJECT_ID,
};

// admin.initializeApp(functions.config().firebase);

admin.initializeApp(_firebase);

const GLOBAL_URL = "https://bridgechampions.com";
const APP_NAME = "BridgeChampions.com";
const SUPPORT_EMAIL = "paul.dalley@hotmail.com";

const EMAIL_NOT_CONFIGURED_MESSAGE =
  "Email service is not configured for this endpoint in the current deployment.";

const SYSTEM_CARD_AI_MAX_TEXT = 4000;
const SYSTEM_CARD_AI_MAX_FIELDS = 400;

const parseJsonSafely = (raw) => {
  try {
    return JSON.parse(String(raw || ""));
  } catch (e) {
    return null;
  }
};

const normalizeConfidence = (value) => {
  const s = String(value || "").toLowerCase();
  if (s === "high" || s === "medium" || s === "low") return s;
  return "medium";
};

const normalizeAllowedFields = (arr) => {
  const fieldPattern = /^[A-Za-z0-9_]+$/;
  const out = Array.from(new Set((arr || [])
    .map((v) => String(v || "").trim())
    .filter(Boolean)))
    .filter((name) => fieldPattern.test(name))
    .slice(0, SYSTEM_CARD_AI_MAX_FIELDS);
  return out;
};

const extractJsonObjectFromText = (raw) => {
  const direct = parseJsonSafely(raw);
  if (direct) return direct;
  const text = String(raw || "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return parseJsonSafely(text.slice(first, last + 1));
};

exports.parseSystemCardAi = functions.https.onRequest((req, res) => {
  const corsFn = cors({ origin: true });
  corsFn(req, res, async () => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST." });
      return;
    }

    const body = req.body || {};
    const rawText = String(body.text || "").trim();
    const sectionTitle = String(body.sectionTitle || "").trim();
    const allowedFields = normalizeAllowedFields(body.allowedFields);
    if (!rawText) {
      res.status(400).json({ error: "Missing text." });
      return;
    }
    if (allowedFields.length === 0) {
      res.status(400).json({ error: "No allowed fields supplied." });
      return;
    }

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      res.status(503).json({ error: "AI service is not configured." });
      return;
    }
    const model = String(process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
    const truncatedText = rawText.slice(0, SYSTEM_CARD_AI_MAX_TEXT);

    const systemPrompt = [
      "You map bridge system notes to ABF system card fields.",
      "Return strict JSON only with shape:",
      '{"detections":[{"id":"string","title":"string","text":"string","targetFields":["field"],"confidence":"high|medium|low","rationale":"string"}],"followUps":[{"id":"string","question":"string","options":["string"],"targetFields":["field"]}]}',
      "Use only targetFields from the allowed list supplied by user.",
      "Keep text concise and card-ready (max 120 chars).",
      "If uncertain, omit the detection.",
      "Provide at most 10 detections and 3 follow-ups.",
    ].join(" ");

    const userPrompt = JSON.stringify({
      sectionTitle,
      allowedFields,
      input: truncatedText,
    });

    try {
      const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      const aiRaw = await aiRes.text();
      const aiData = parseJsonSafely(aiRaw);
      if (!aiRes.ok) {
        console.error("parseSystemCardAi upstream error:", aiRaw.slice(0, 500));
        res.status(502).json({ error: "AI provider request failed." });
        return;
      }

      const content = ((((aiData || {}).choices || [])[0] || {}).message || {}).content || "{}";
      const parsed = extractJsonObjectFromText(content) || {};
      const allowedSet = new Set(allowedFields);

      const detections = ((parsed.detections || []).slice(0, 10))
        .map((d, idx) => {
          const targetFields = ((d && d.targetFields) || [])
            .map((v) => String(v || "").trim())
            .filter((name) => allowedSet.has(name));
          const text = String((d && d.text) || "").trim().slice(0, 120);
          if (!text || targetFields.length === 0) return null;
          return {
            id: String((d && d.id) || `ai-det-${idx + 1}`),
            title: String((d && d.title) || "Detected agreement").trim().slice(0, 80),
            text,
            targetFields,
            confidence: normalizeConfidence(d && d.confidence),
            rationale: String((d && d.rationale) || "").trim().slice(0, 220),
          };
        })
        .filter(Boolean);

      const followUps = ((parsed.followUps || []).slice(0, 3))
        .map((q, idx) => {
          const targetFields = ((q && q.targetFields) || [])
            .map((v) => String(v || "").trim())
            .filter((name) => allowedSet.has(name));
          const options = ((q && q.options) || [])
            .map((v) => String(v || "").trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 8);
          const question = String((q && q.question) || "").trim().slice(0, 140);
          if (!question || options.length === 0 || targetFields.length === 0) return null;
          return {
            id: String((q && q.id) || `ai-q-${idx + 1}`),
            question,
            options,
            targetFields,
          };
        })
        .filter(Boolean);

      res.json({ detections, followUps });
    } catch (err) {
      console.error("parseSystemCardAi error:", err && err.message ? err.message : err);
      res.status(500).json({ error: "AI parse failed." });
    }
  });
});

exports.contactUs = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    contactUs(req, res);
  });
});
const contactUs = (req, res) => {
  const { uid, email, firstName, lastName, text } = req.body;
  console.log("contactUs called (email disabled):", {
    uid: uid || null,
    email: email || null,
    firstName: firstName || null,
    lastName: lastName || null,
    textLength: String(text || "").length,
  });
  // white-smalller: "https://firebasestorage.googleapis.com/v0/b/bridgechampions.appspot.com/o/logo-white-smaller.png?alt=media&token=335dce2a-bb25-49ef-bcd6-87ba38212bb6";
  // https://firebasestorage.googleapis.com/v0/b/bridgechampions.appspot.com/o/logo-small.png?alt=media&token=afba4c94-8e85-4d7f-99f7-73367ba160cb
  // black/gray: https://firebasestorage.googleapis.com/v0/b/bridgechampions.appspot.com/o/logo-small.png?alt=media&token=afba4c94-8e85-4d7f-99f7-73367ba160cb
  // white-larger: https://firebasestorage.googleapis.com/v0/b/bridgechampions.appspot.com/o/logo-small.png?alt=media&token=afba4c94-8e85-4d7f-99f7-73367ba160cb
  const messageBodyHtml = `
          <h2><strong>Thanks for contacting us ${firstName} ${lastName}, you will hear back from us shortly.</strong></h2>
          <p><strong>We will process your message as soon as we can and when we do we will contact you by email at ${email}.</strong></p>
          <h4>Your issue:</h4>
          <p>${text}</p>
          <br/>  
          <p>Thanks,<br/>
          From the team at BridgeChampions.com</p>
          <div><img src="https://firebasestorage.googleapis.com/v0/b/bridgechampions.appspot.com/o/logo-small.png?alt=media&token=afba4c94-8e85-4d7f-99f7-73367ba160cb"/></div>
    `;

  console.log("contactUs message preview (email disabled):", messageBodyHtml.slice(0, 220));
  return res.send(`Thanks! Your message was received. You can also contact ${SUPPORT_EMAIL}.`);
};

// Your company name to include in the emails
// TODO: Change this to your app or company name to customize the email sent.
// [START sendWelcomeEmail]
/**
 * Sends a welcome email to new user.
 */
// [START onCreateTrigger]
exports.sendWelcomeEmail = functions.auth.user().onCreate(event => {
  // [END onCreateTrigger]
  // [START eventAttributes]
  const user = event.data; // The Firebase user.
  const email = user.email; // The email of the user.
  const displayName = user.displayName; // The display name of the user.
  // [END eventAttributes]

  return sendWelcomeEmail(email, displayName);
});
// [END sendWelcomeEmail]

// Sends a welcome email to the given user.
function sendWelcomeEmail(email, displayName) {
  console.log("sendWelcomeEmail skipped:", {
    email: email || null,
    displayName: displayName || null,
    reason: EMAIL_NOT_CONFIGURED_MESSAGE,
  });
  return null;
}

// [START sendByeEmail]
/**
 * Send an account deleted email confirmation to users who delete their accounts.
 */
// [START onDeleteTrigger]
// exports.sendByeEmail = functions.auth.user().onDelete((event) => {
//     // [END onDeleteTrigger]
//     const user = event.data;
//
//     const email = user.email;
//     const displayName = user.displayName;
//
//     return sendGoodbyEmail(email, displayName);
// });
// [END sendByeEmail]

// Sends a goodbye email to the given user.
// function sendGoodbyEmail(email, displayName) {
//     const mailOptions = {
//         from: `${APP_NAME} <noreply@firebase.com>`,
//         to: email,
//     };
//
//     // The user unsubscribed to the newsletter.
//     mailOptions.subject = `Bye!`;
//     mailOptions.text = `Hey ${displayName || ''}!, We confirm that we have deleted your ${APP_NAME} account.`;
//     return mailTransport.sendMail(mailOptions).then(() => {
//         return console.log('Account deletion confirmation email sent to:', email);
//     });
// }

// ##** CHANGE BETWEEN DEV AND PROD HERE:
// Configure your environment
if (ENVIRONMENT === "DEV") {
  // ## DEVELOPMENT:
  paypal.configure({
    mode: "sandbox", // sandbox or live
    client_id: process.env.PAYPAL_CLIENT_ID_DEV,
    client_secret: process.env.PAYPAL_CLIENT_SECRET_DEV,
    // client_id: functions.config().paypal.client_id_dev, // run: firebase functions:config:set paypal.client_id="yourPaypalClientID"
    // client_secret: functions.config().paypal.client_secret_dev, // run: firebase functions:config:set paypal.client_secret="yourPaypalClientSecret"
  });
} else if (ENVIRONMENT === "PROD") {
  // ## PRODUCTION:
  paypal.configure({
    mode: "live", // sandbox or live
    client_id: process.env.PAYPAL_CLIENT_ID_PROD,
    client_secret: process.env.PAYPAL_CLIENT_SECRET_PROD,
    // client_id: functions.config().paypal.client_id_prod, // run: firebase functions:config:set paypal.client_id="yourPaypalClientID"
    // client_secret: functions.config().paypal.client_secret_prod, // run: firebase functions:config:set paypal.client_secret="yourPaypalClientSecret"
  });
}

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });

exports.articlesCounterIncrement = functions.firestore
  .document("articles/{articleId}")
  .onCreate(event => {
    const counterRef = admin.firestore().collection("counts").doc("counts");
    return counterRef.get().then(snapshot => {
      const incrementedCount = snapshot.data().articlesCount + 1;
      const data = { articlesCount: incrementedCount };
      return counterRef.update(data);
    });
  });

exports.articlesCounterDecrement = functions.firestore
  .document("articles/{articleId}")
  .onDelete(event => {
    const counterRef = admin.firestore().collection("counts").doc("counts");
    return counterRef.get().then(snapshot => {
      const decrementedCount = snapshot.data().articlesCount - 1;
      const data = { articlesCount: decrementedCount };
      return counterRef.update(data);
    });
  });

// TESTING TRANSACTION:
// exports.articlesCounterIncrement = functions.firestore
//     .document('articles/{articleId}')
//     .onCreate(event => {
//         const counterRef = admin.firestore().collection('counts').doc('counts');
//         const transaction = admin.firestore().runTransaction(t => {
//             return t.get(counterRef)
//                 .then(snapshot => {
//                     const incrementedCount = snapshot.data().articlesCount + 1;
//                     const data = { articlesCount: incrementedCount };
//                     t.update(counterRef, data);
//                 });
//         });
//     });

exports.quizzesCounterIncrement = functions.firestore
  .document("quizzes/{quizId}")
  .onCreate(event => {
    const counterRef = admin.firestore().collection("counts").doc("counts");
    return counterRef.get().then(snapshot => {
      const incrementedCount = snapshot.data().quizCount + 1;
      const data = { quizCount: incrementedCount };
      return counterRef.update(data);
    });
  });

exports.quizzesCounterDecrement = functions.firestore
  .document("quizzes/{quizId}")
  .onDelete(event => {
    const counterRef = admin.firestore().collection("counts").doc("counts");
    return counterRef.get().then(snapshot => {
      const DecrementedCount = snapshot.data().quizCount - 1;
      const data = { quizCount: DecrementedCount };
      return counterRef.update(data);
    });
  });

// ##** PAYPAL STUFF:

// Define the billing plan object:
const getBillingPlanObject = req => {
  const billingPlan = {
    name: "BridgeChampions.com Membership",
    description: "$16.99 Monthly subscription to BridgeChampions.com.",
    type: "INFINITE", // 'FIXED'
    payment_definitions: [
      {
        name: "Standard Plan",
        type: "REGULAR",
        frequency_interval: "1",
        frequency: "MONTH", // 'MONTH'/'DAY' ##**
        cycles: "0",
        amount: {
          currency: "USD", // 'USD'/'AUD'
          value: "16.99",
        },
      },
    ],
    merchant_preferences: {
      return_url: `${req.protocol}://${req.get("host")}/process`,
      cancel_url: `${GLOBAL_URL}/membership`,
      max_fail_attempts: "1", // '3',
      auto_bill_amount: "NO", // 'YES',
      initial_fail_amount_action: "CANCEL", // 'CONTINUE'
      // setup_fee: {
      //     currency: "USD",
      //     value: "15.99"
      // }
    },
  };
  return billingPlan;
};

// reference_id: req.body.uid, <- maybe breaking it.
const getBillingPlanAgreement = (req, billingPlanId) => {
  const isoDate = new Date();
  isoDate.setSeconds(isoDate.getSeconds() + 4);
  isoDate.toISOString().slice(0, 19) + "Z";
  const billingAgreementAttributes = {
    name: "BridgeChampions.com Membership",
    description: "$16.99 Monthly subscription to BridgeChampions.com.",
    start_date: isoDate,
    plan: {
      id: billingPlanId,
    },
    payer: {
      payment_method: "paypal",
    },
    // So IPN notifications include our uid and we can update the right member
    custom: req.body.uid || "",
    override_merchant_preferences: {
      return_url: `${req.protocol}://${req.get("host")}/process?uid=${
        req.body.uid
      }`,
    },
  };
  return billingAgreementAttributes;
};

exports.activateBillingPlan = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    billingPlanFn(req, res);
  });
});

// Create the billing plan
const billingPlanUpdateAttributes = [
  {
    op: "replace",
    path: "/",
    value: {
      state: "ACTIVE",
    },
  },
];
// const getBillingPlanAgreement = (req, billingPlanId) => {}
// const getBillingPlanObject = (req) => {}
const billingPlanFn = (req, outerRes) => {
  const uid = req.body.uid;
  if (uid) {
    admin.firestore().collection("members").doc(uid).set(
      { lastPayPalCheckoutStartedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    ).catch(err => console.warn("Ensure members doc (PayPal):", err.message));
  }
  const billingPlanAttributes = getBillingPlanObject(req);

  paypal.billingPlan.create(billingPlanAttributes, (error, billingPlan) => {
    if (error) {
      console.log("ERROR AT 1");
      console.log(error);
      outerRes.send(error);
    } else {
      console.log("Create Billing Plan Response");
      console.log(billingPlan);

      // Activate the plan by changing status to Active
      paypal.billingPlan.update(
        billingPlan.id,
        billingPlanUpdateAttributes,
        (error, response) => {
          if (error) {
            console.log("ERROR AT 2");
            console.log(error);
            outerRes.send(error);
          } else {
            console.log("Billing Plan state changed to " + billingPlan.state);
            console.log("Billing Plan id is: " + billingPlan.id);
            const billingAgreementAttributes = getBillingPlanAgreement(
              req,
              billingPlan.id
            );
            console.log("HERE ARE THE AGREEMENT ATTRIBUTES");
            console.log(billingAgreementAttributes);

            // store the plan id for this member with their uid as key:
            // const paypalRef = admin.firestore().collection('members').doc(uid);
            //
            // paypalRef.set({
            //         billingPlanId: billingPlan.id,
            //     }, {merge: true})
            //     .then(res => {
            //         console.log("SUCCESSFUL REF SET FOR", billingPlan.id);

            // Use activated billing plan to create agreement
            paypal.billingAgreement.create(
              billingAgreementAttributes,
              (error, billingAgreement) => {
                if (error) {
                  console.log("ERROR AT 3");
                  console.log(error);
                  outerRes.json({ error });
                } else {
                  console.log(
                    "Create Billing Agreement Response -- HERE IS THE AGREEMENT"
                  );
                  console.log(billingAgreement);

                  for (
                    let index = 0;
                    index < billingAgreement.links.length;
                    index++
                  ) {
                    if (billingAgreement.links[index].rel === "approval_url") {
                      const approval_url = billingAgreement.links[index].href;
                      console.log(
                        "For approving subscription via Paypal, first redirect user to"
                      );
                      console.log(approval_url);

                      console.log("Payment token is");
                      const token = url.parse(approval_url, true).query.token;
                      console.log(token);
                      outerRes.json({ approval_url, token });
                      return;

                      // const paypalRef = admin.firestore().collection('members').doc(uid);
                      // paypalRef.set({
                      //     billingPlanId: billingPlan.id,
                      //     token,
                      // }, {merge: true})
                      //     .then(res => {
                      //         console.log("SUCCESSFUL REF SET FOR", billingPlan.id);
                      //
                      //         // See billing_agreements/execute.js to see example for executing agreement
                      //         // after you have payment token
                      //         outerRes.json({approval_url, token});
                      //         return;
                      //     })
                      //     .catch(err => {
                      //         console.log(err);
                      //         res.redirect("https://bridgechampions.com/error");
                      //         return;
                      //     });
                    }
                  }
                }
              }
            );

            // return 1;    }) // <- these close the then
            // .catch(err => console.log(err));
          }
        }
      );
    }
  });
};

// PART 3: Callback to PROCESS PAYMENT FOR newly created subscription:
exports.process = functions.https.onRequest((req, res) => {
  const token = req.query.token;
  const uid = req.query.uid;
  console.log("PROCESSING THE PAYMENT NOW:", { hasToken: !!token, hasUid: !!uid, queryKeys: Object.keys(req.query || {}) });
  if (token && uid) {
    return executePaymentAgreement(token, uid, req, res);
  }

  // Hosted PayPal button flow: there is no billing-agreement token in return URL.
  // Subscription activation is handled asynchronously by IPN.
  if (!token && uid) {
    console.log("process: hosted-button return detected (no token). Redirecting to success; waiting for IPN.");
    return res.redirect("https://bridgechampions.com/success");
  }

  if (!uid) {
    // Some hosted-button return URLs may omit custom query params.
    // Do not hard-fail here; IPN handles actual activation.
    console.warn("process: missing uid on return; redirecting to success and awaiting IPN.");
    return res.redirect("https://bridgechampions.com/success");
  }

  // let uid;
  // let storedToken;
  // const membersRef = admin.firestore().collection('members');
  // membersRef.where("token", "==", token)
  //     .get()
  //     .then(snapshot => {
  //         if (snapshot.empty === false) {
  //             uid = snapshot.docs[0].id;
  //             storedToken = snapshot.docs[0].token;
  //             if (uid && storedToken === token) {
  //                 executePaymentAgreement(token, uid, req, res);
  //             }
  //
  //         }
  //         else {
  //             res.redirect(GLOBAL_URL + '/error');
  //             console.log(snapshot);
  //             return;
  //         }
  //         return;
  //     })
  //     .catch(err => {
  //         res.redirect(GLOBAL_URL + '/error');
  //         console.log(err);
  //         return;
  //     });
});

const executePaymentAgreement = (token, uid, req, res) => {
  const ref = admin.firestore().collection("members").doc(uid);

  paypal.billingAgreement.execute(token, {}, (error, billingAgreement) => {
    console.log("EXECUTING THiS AGREEMENT in billingAgreement.execute:");
    console.log(billingAgreement);
    if (error) {
      console.error(JSON.stringify(error));
      // throw error;
      return res.redirect("https://bridgechampions.com/error");
      // (`${req.protocol}://${req.get('host')}/error`); // replace with your url page error
    } else {
      console.log(JSON.stringify(billingAgreement));
      console.log("Billing Agreement Created Successfully");

      const date = new Date();
      // ##** EDITED HERE: from 31 to 1
      date.setDate(date.getDate() + 31);

      return ref
        .set(
          {
            subscriptionId: billingAgreement.id,
            subscriptionExpires: date,
            subscriptionActive: true,
            paymentMethod: "paypal",
          },
          { merge: true }
        )
        .then(r => {
          console.info("promise: ", r);
          // return res.redirect(`${req.protocol}://${req.get('host')}/success`); // replace with your url, page success
          return res.redirect("https://bridgechampions.com/success");
        })
        .catch(err => {
          console.log(err);
          // return res.redirect(`${req.protocol}://${req.get('host')}/error`);
          return res.redirect("https://bridgechampions.com/error");
        });
    }
  });
};

// exports.process = functions.https.onRequest((req, res) => {
//     const token = req.query.token;
//     console.log("PROCESSING THE PAYMENT NOW:");
//     console.log(token);
//
//     let uid;
//     let storedToken;
//     const membersRef = admin.firestore().collection('members');
//     membersRef.where("token", "==", token)
//         .get()
//         .then(snapshot => {
//             if (snapshot.empty === false) {
//                 uid = snapshot.docs[0].id;
//                 storedToken = snapshot.docs[0].token;
//                 if (uid && storedToken === token) {
//                     executePaymentAgreement(token, uid, req, res);
//                 }
//
//             }
//             return;
//         })
//         .catch(err => {
//             res.redirect(GLOBAL_URL + '/error');
//             console.log(err);
//             return;
//         });
// });
//
// const executePaymentAgreement = (token, uid, req, res) => {
//     const ref = admin.firestore().collection('members').doc(uid);
//
//     paypal.billingAgreement.execute(token, {}, (error, billingAgreement) => {
//         console.log("EXECUTING THiS AGREEMENT in billingAgreement.execute:");
//         console.log(billingAgreement);
//         if (error) {
//             console.error(JSON.stringify(error));
//             // throw error;
//             return res.redirect(`${req.protocol}://${req.get('host')}/error`); // replace with your url page error
//         } else {
//             console.log(JSON.stringify(billingAgreement));
//             console.log('Billing Agreement Created Successfully');
//             const date = new Date();
//             date.setDate(date.getDate() + 31);
//
//             return ref.set({
//                 'paid': true,
//                 'subscriptionExpires': date
//             }, {merge: true})
//                 .then(r => {
//                     console.info('promise: ', r)
//                     // return res.redirect(`${req.protocol}://${req.get('host')}/success`); // replace with your url, page success
//                     return res.redirect("https://bridgechampions.com/success");
//                 })
//                 .catch(err => {
//                     console.log(err);
//                     // return res.redirect(`${req.protocol}://${req.get('host')}/error`);
//                     return res.redirect("https://bridgechampions.com/error");
//                 });
//
//         }
//     });
// };

//
//
// const billingPlanFn = (req, res) => {
//     console.log("INCOMING REQUEST");
//     console.log(req);
//     console.log("INCOMING REQUEST METHOD");
//     console.log(req.method);
//     console.log("REQ BODY:");
//     console.log(req.body);
//     console.log("INCOMING REQUEST UID");
//     console.log(req.body.uid);
//     const uid = req.body.uid;
//     const originUrl = req.headers.origin;
//     const errorUrl = originUrl + '/error';
//
//     console.log("INCOMING REQUEST HEADERS");
//     console.log(req.headers);
//     // console.log(req.headers.uid);
//
//     const billingPlan = getBillingPlanObject(req);
//     paypal.billingPlan.create(billingPlan, (error, plan) => {
//         let billingPlanUpdateAttributes;
//
//         if (error) {
//             console.log("THERE IS AN ERROR HERE 1");
//             console.error(JSON.stringify(error));
//             // throw error;
//
//             // return res.redirect(`${req.protocol}://${req.get('host')}/error`);
//             return res.redirect(errorUrl);
//         } else {
//             // Activate the billing plan:
//             // Create billing plan patch object
//             billingPlanUpdateAttributes = [{
//                 op: 'replace',
//                 path: '/',
//                 value: {
//                     state: 'ACTIVE'
//                 }
//             }];
//
//             // Activate the plan by changing status to active
//             paypal.billingPlan.update(plan.id, billingPlanUpdateAttributes, (error, response) => {
//                 if (error) {
//                     console.log("THERE IS AN ERROR HERE 2");
//                     console.error(JSON.stringify(error));
//                     // throw error;
//                     // return res.redirect(`${req.protocol}://${req.get('host')}/error`);
//                     return res.redirect(errorUrl);
//                 } else {
//                     console.log('Billing plan created under ID: ' + plan.id);
//                     console.log('Billing plan state changed to ' + plan.state);
//
//                     // store the plan id for this member with their uid as key:
//                     const paypalRef = admin.firestore().collection('members').doc(uid);
//                     paypalRef.set({
//                         billingPlanId: plan.id,
//                     }, {merge: true})
//                         .then(() => {
//                             finishBillingAgreement(req, plan, res);
//                             return;
//                         })
//                         .catch((err) => {
//                             console.log("THERE WAS AN ERROR HERE X:");
//                             console.log(err);
//                             // throw error;
//                             // res.redirect(`${req.protocol}://${req.get('host')}/error`);
//                             return res.redirect(errorUrl);
//                         });
//                 }
//             });
//         }
//     });
// };
// const finishBillingAgreement = (req, plan, res) => {
//     const errorUrl = req.headers.origin + '/error';
//
//     const billingAgreementAttributes = getBillingPlanAgreement(req, plan.id);
//     console.log("HERE IS THE BILLING AGREEMENT PRESUBMISSION");
//     console.log(billingAgreementAttributes);
//
//     paypal.billingAgreement.create(billingAgreementAttributes,
//         (error, billingAgreement) => {
//             if (error) {
//                 console.log("THERE WAS AN ERROR HERE 3:");
//                 console.log(error);
//                 // throw error;
//                 // res.redirect(`${req.protocol}://${req.get('host')}/error`);
//                 // return res.redirect(errorUrl);
//                 cors(req, res, () => {
//                     res.redirect(errorUrl);
//                 })
//             } else {
//
//                 console.log("Create Billing Agreement Response - THE BILLING AGREEMENT:");
//                 console.log(billingAgreement);
//                 //console.log(billingAgreement);
//                 for (var index = 0; index < billingAgreement.links.length; index++) {
//                     if (billingAgreement.links[index].rel === 'approval_url') {
//                         var approval_url = billingAgreement.links[index].href;
//                         console.log("For approving subscription via Paypal, first redirect user to");
//                         console.log(approval_url);
//
//
//                         console.log("Payment token is");
//                         const token = url.parse(approval_url, true).query.token;
//                         console.log(token);
//
//                         // See billing_agreements/execute.js to see example for executing agreement
//                         // after you have payment token
//
//                         // const ref = admin.firestore().collection('paypal').doc(uid);
//                         // ref.set({
//                         //     'token':  token,
//                         // }, {merge: true})
//                         //     .then(snapshot => {
//                         //        console.log("successful write to paypal ref");
//                         //        console.log(snapshot);
//                         //     })
//                         //     .catch(err => console.log(err);
//
//                         res.json({approval_url, token});
//                         // res.redirect(approval_url);
//                     }
//                 }
//             }
//         });
// }

// saved in db as plan id: P-4UX40883FV8284831T54LC2A

// billing_agreement_id: 'I-C9PUKWW7EV62',
//                        I-C9PUKWW7EV62

// https://us-central1-bridgechampions.cloudfunctions.net/monthlyBilling
// ##** PAYMENT.SALE.COMPLETED webhook call for recurring subscription payments:
// - payment sale completed
exports.monthlyBilling = functions.https.onRequest((req, res) => {
  console.log("Webhook called monthlyBilling START:");
  console.log(req.body);
  console.log(req.headers);
  // console.log("MY WEBHOOKS:");
  // console.log(paypal.webhook.list());

  // STEP 1: validate the request:
  // -- this needs to return a promise or else it is undefined by the time...
  verifyWebhook(req, res);

  // // STEP 2: FETCH the users information and update their subscriptionExpires date:
  // // need to fetch the uid using the billingAgreementId:
  // // - req.body.resource.billing_agreement_id has it.
  // if (verified) {
  //     return getUIDWithBillingPlanId(req, res);
  // }
  // else {
  //     console.log("verification failed");
  //     return res.status('500').send("");
  // }
});

const verifyWebhook = (req, res) => {
  // const certURL = req.headers.paypal-cert-url;
  // const transmissionId = req.headers.paypal-transmission-id;
  // const transmissionSignature = req.headers.paypal-transmission-sig;
  // const transmissionTimestamp = req.headers.paypal-transmission-time;
  // const headers = {
  //     'paypal-auth-algo': 'SHA256withRSA',
  //     'paypal-cert-url': certURL,
  //     'paypal-transmission-id': transmissionId,
  //     'paypal-transmission-sig': transmissionSignature,
  //     'paypal-transmission-time': transmissionTimestamp
  // };

  const eventBody = req.body;
  // The webhookId is the ID of the configured webhook (can find this in the PayPal Developer Dashboard or
  // by doing a paypal.webhook.list()

  // ##** CHANGE BETWEEN DEV AND PROD HERE:
  // PAYMENT_SALE_COMPLETED_WEBHOOK_ID_PROD
  // const webhookId = PAYMENT_SALE_COMPLETED_WEBHOOK_ID_PROD;
  // PAYMENT_SALE_COMPLETED_WEBHOOK_ID_DEV
  // const webhookId = PAYMENT_SALE_COMPLETED_ID_DEV;
  const webhookId =
    ENVIRONMENT === "PROD"
      ? PAYMENT_SALE_COMPLETED_WEBHOOK_ID_PROD
      : PAYMENT_SALE_COMPLETED_WEBHOOK_ID_DEV;

  paypal.notification.webhookEvent.verify(
    req.headers,
    eventBody,
    webhookId,
    (error, response) => {
      if (error) {
        console.log("IN HERE TRYING TO VERIFY WEBHOOK 1:");
        console.info(error);
        return res.status("500").send("");
      } else {
        console.log(response);

        // Verification status must be SUCCESS
        if (response.verification_status === "SUCCESS") {
          console.log(
            "monthlyBilling verification was a success - the webhook event has been verified."
          );
          // STEP 2: FETCH the users information and update their subscriptionExpires date:
          // need to fetch the uid using the billingAgreementId:
          // - req.body.resource.billing_agreement_id has it.
          return getUIDWithBillingPlanId(req, res);
        } else {
          console.log("It was a failed verification");
          return res.status("500").send("");
        }
      }
    }
  );
};

const getUIDWithBillingPlanId = (req, res) => {
  const billingAgreementId = req.body.resource.billing_agreement_id;
  console.log("I have a billingAgreementId from the webhook request:");
  console.log(billingAgreementId);
  const ref = admin.firestore().collection("members");
  let uid;

  const billingPlanIdProp = "subscriptionId"; // 'billingPlanId'

  ref
    .where(billingPlanIdProp, "==", billingAgreementId)
    .get()
    .then(snapshot => {
      console.log(snapshot);
      // snapshot.forEach(doc => console.log(doc.data()));
      if (snapshot.empty === false) {
        uid = snapshot.docs[0].id;
        const memberData = snapshot.docs[0].data();
        console.log(
          "I HAVE FETCHED MEMBER DATA USING THE BILLING AGREEMENT ID:"
        );
        console.log(memberData);
        console.log(uid);
        return addMonthToSubscription(req, res, uid);
      } else {
        console.log("No billingPlanId or no match");
        return res.send("No matching billing plan was found.");
      }
    })
    .catch(err => {
      console.log(err);
      res.send(err);
    });
};

const addMonthToSubscription = (req, res, uid) => {
  const ref = admin.firestore().collection("members").doc(uid);
  const date = new Date();
  date.setDate(date.getDate() + 31);
  ref
    .set(
      {
        subscriptionExpires: date,
      },
      { merge: true }
    )
    .then(innerRes => {
      console.log("COMPLETED ADDING MONTH TO SUB FOR USER WITH UID:" + uid);
      return res.status("200").end();
    })
    .catch(err => {
      console.log(err);
      return res.status("500").send("");
    });
};

//
// const makeBillingAgreement = (req) => {
//     var isoDate = new Date();
//     isoDate.setSeconds(isoDate.getSeconds() + 4);
//     isoDate.toISOString().slice(0, 19) + 'Z';
//     let billingPlanId;
//     let billingAgreementAttributes;
//
//     admin.firestore().collection('paypal').doc('settings').get()
//         .then(snapshot => {
//             const data = snapshot.data();
//             billingPlanId = data.billingPlanId,
//
//             billingAgreementAttributes = {
//                 name: 'BridgeChampions.com Membership',
//                 description: "monthly subscription plan.",
//                 payer_id: req.body.uid, // <-- ##**
//                 start_date: isoDate,
//                 plan: {
//                     id: billingPlanId
//                 },
//                 payer: {
//                     payment_method: 'paypal'
//                 }
//             };
//             var links = {};
//
//         // Use activated billing plan to create agreement
//             paypal.billingAgreement.create(billingAgreementAttributes, function (error, billingAgreement){
//                 if (error){
//                     console.error(JSON.stringify(error));
//                     res.redirect(`${req.protocol}://${req.get('host')}/error`);
//                     // throw error;
//                 } else {
//                     // Capture HATEOAS links
//                     billingAgreement.links.forEach(function(linkObj){
//                         links[linkObj.rel] = {
//                             href: linkObj.href,
//                             method: linkObj.method
//                         };
//                     })
//
//                     // If redirect url present, redirect user
//                     if (links.hasOwnProperty('approval_url')){
//                         //REDIRECT USER TO links['approval_url'].href
//                         res.redirect(links['approval_url'].href);
//                     } else {
//                         console.error('no redirect URI present');
//                     }
//                 }
//             });
//
//         })
//
// };

//
// /**
//  * Expected in the body the amount
//  * Set up the payment information object
//  * Initialize the payment and redirect the user to the PayPal payment page
//  */
// exports.pay = functions.https.onRequest((req, res) => {
//     // 1.Set up a payment information object, Nuild PayPal payment request
//     const payReq = JSON.stringify({
//         intent: 'sale',
//         payer: {
//             payment_method: 'paypal'
//         },
//         redirect_urls: {
//             return_url: `${req.protocol}://${req.get('host')}/process`,
//             cancel_url: `${req.protocol}://${req.get('host')}/cancel`
//         },
//         transactions: [{
//             amount: {
//                 total: req.body.price,
//                 currency: 'USD'
//             },
//             // This is the payment transaction description. Maximum length: 127
//             description: req.body.uid, // req.body.id
//             // reference_id string .Optional. The merchant-provided ID for the purchase unit. Maximum length: 256.
//             // reference_id: req.body.uid,
//             custom: req.body.uid,
//             // soft_descriptor: req.body.uid
//             // "invoice_number": req.body.uid,A
//         }]
//     });
//     // 2.Initialize the payment and redirect the user.
//     paypal.payment.create(payReq, (error, payment) => {
//         const links = {};
//         if (error) {
//             console.error(error);
//             res.status('500').end();
//         } else {
//             // Capture HATEOAS links
//             payment.links.forEach((linkObj) => {
//                 links[linkObj.rel] = {
//                     href: linkObj.href,
//                     method: linkObj.method
//                 };
//             });
//             // If redirect url present, redirect user
//             if (links.hasOwnProperty('approval_url')) {
//                 // REDIRECT USER TO links['approval_url'].href
//                 console.info(links.approval_url.href);
//                 // res.json({"approval_url":links.approval_url.href});
//                 res.redirect(302, links.approval_url.href);
//             } else {
//                 console.error('no redirect URI present');
//                 res.status('500').end();
//             }
//         }
//     });
// });
//
// // 3.Complete the payment. Use the payer and payment IDs provided in the query string following the redirect.
// exports.process = functions.https.onRequest((req, res) => {
//     const paymentId = req.query.paymentId;
//     const payerId = {
//         payer_id: req.query.PayerID
//     };
//     paypal.payment.execute(paymentId, payerId, (error, payment) => {
//         if (error) {
//             console.error(error);
//             res.redirect(`${req.protocol}://${req.get('host')}/error`); // replace with your url page error
//         } else {
//             if (payment.state === 'approved') {
//                 console.info('payment completed successfully, description: ', payment.transactions[0].description);
//                 // console.info('req.custom: : ', payment.transactions[0].custom);
//                 // set paid status to True in RealTime Database
//                 const date = Date.now();
//                 const uid = payment.transactions[0].description;
//                 const ref = admin.database().ref('users/' + uid + '/');
//                 ref.push({
//                     'paid': true,
//                     // 'description': description,
//                     'date': date
//                 }).then(r => console.info('promise: ', r));
//                 res.redirect(`${req.protocol}://${req.get('host')}/success`); // replace with your url, page success
//             } else {
//                 console.warn('payment.state: not approved ?');
//                 // replace debug url
//                 res.redirect(`https://console.firebase.google.com/project/${process.env.GCLOUD_PROJECT}/functions/logs?search=&severity=DEBUG`);
//             }
//         }
//     });
// });

// ##** IPN CODE:
/**
 * Determine endpoint to post verification data to.
 *
 * @return {String}
 */
function getPaypalURI() {
  return sandbox ? SANDBOX_VERIFY_URI : PRODUCTION_VERIFY_URI;
}

/**
 * @param {Object} req Cloud Function request context for IPN notification event.
 * @param {Object} res Cloud Function response context.
 */
// exports.ipnHandler = function ipnHandler(req, res) {
exports.ipnHandler = functions.https.onRequest((req, res) => {
  console.log("IPN Notification Event Received");

  if (req.method !== "POST") {
    console.error("Request method not allowed.");
    res.status(405).send("Method Not Allowed");
    return;
  } else {
    // Return empty 200 response to acknowledge IPN post success.
    console.log("IPN Notification Event received successfully.");
    // res.status(200).end();
  }

  // JSON object of the IPN message consisting of transaction details.
  const ipnTransactionMessage = req.body;
  // Convert JSON ipn data to a query string since Google Cloud Function does not expose raw request data.
  const formUrlEncodedBody = querystring.stringify(ipnTransactionMessage);
  // Build the body of the verification post message by prefixing 'cmd=_notify-validate'.
  const verificationBody = `cmd=_notify-validate&${formUrlEncodedBody}`;

  console.log("DATA STUFF:");
  console.log(ipnTransactionMessage);
  console.log(formUrlEncodedBody);
  console.log(verificationBody);

  // EXTRACT INFO FROM THE TRANSACTION:
  // payment_gross || mc_gross
  const mc_amount1 = Number(ipnTransactionMessage.mc_amount1);
  const mc_amount2 = Number(ipnTransactionMessage.mc_amount2);
  const mc_amount3 = Number(ipnTransactionMessage.mc_amount3);

  const payment_gross = Number(ipnTransactionMessage.payment_gross);
  const mc_gross = Number(ipnTransactionMessage.mc_gross);
  let uid = ipnTransactionMessage.custom;
  const token = ipnTransactionMessage.invoice;
  console.log("FOR UID: ", uid);
  if (!uid) console.warn("IPN: custom (uid) is missing; will try to resolve by subscriptionId");
  if (!(ipnTransactionMessage && ipnTransactionMessage.btn_id)) console.warn("IPN: btn_id is missing; tier will default to basic");
  console.log("WITH TOKEN: ", token);
  console.log("WHO IS PAYING payment_gross: " + payment_gross);
  console.log("WHO IS PAYING mc_gross: " + mc_gross);

  console.log(`Verifying IPN: ${verificationBody}`);

  const options = {
    method: "POST",
    uri: getPaypalURI(),
    body: verificationBody,
  };

  // POST verification IPN data to paypal to validate.
  request(options, (error, response, body) => {
    console.log("IN POST VERIFICATION for IPN");
    console.log(response);
    console.log(body);
    console.log(error);

    if (
      !error &&
      (response.statusCode === "200" || response.statusCode === 200)
    ) {
      // Check the response body for validation results.
      if (body === "VERIFIED") {
        console.log(
          `Verified IPN: IPN message for Transaction ID: ${ipnTransactionMessage.txn_id} is verified.`
        );

        const eventTypeRaw = ipnTransactionMessage.txn_type || ipnTransactionMessage.transaction_type || "";
        const eventType = String(eventTypeRaw || "").trim();
        const paymentStatus = String(ipnTransactionMessage.payment_status || "").toLowerCase();
        console.log("EVENT TYPE IS: " + (eventType || "(none)"));
        console.log("PAYMENT STATUS IS: " + (paymentStatus || "(none)"));

        // Resolve uid: from IPN custom, or by looking up member by subscription id (for manually added members / old agreements without custom)
        const resolveUid = () => {
          if (uid) return Promise.resolve(uid);
          const subscrId = ipnTransactionMessage.subscr_id || ipnTransactionMessage.recurring_payment_id;
          if (!subscrId) return Promise.resolve(null);
          return admin.firestore().collection("members").where("subscriptionId", "==", subscrId).limit(1).get()
            .then(snap => (snap.empty ? null : snap.docs[0].id));
        };

        return resolveUid().then(resolvedUid => {
          const uidToUse = resolvedUid || uid;
          if (!uidToUse && eventType !== "recurring_payment_profile_cancel") {
            console.warn("IPN: no uid (custom) and could not resolve by subscription id; ignoring.");
            return res.status(200).end();
          }
          if (uidToUse && !uid) console.log("IPN: resolved uid from subscriptionId lookup:", uidToUse);

          // Some hosted-button IPNs arrive without txn_type. Normalize common payment statuses.
          // Ignore refunds/reversals/failed statuses so we never grant time on negative/failed transactions.
          if (["refunded", "reversed", "failed", "denied", "voided"].includes(paymentStatus)) {
            console.log("IPN: non-crediting status detected, ignoring:", paymentStatus);
            return res.status(200).end();
          }

          const applySignupDays = () => {
            // Check if token is a promo code (invoice from PayPal)
            if (token) {
              const tokenTrim = String(token || "").trim();
              const tokenLower = tokenTrim.toLowerCase();
              const tokenNoSpaces = tokenLower.replace(/\s+/g, "");
              const tokenUpper = tokenTrim.toUpperCase();
              const candidateTokenIds = promoTokenFirestoreDocIds(tokenTrim, tokenLower, tokenNoSpaces, tokenUpper);
              const isBlue = isBluePromoCode(tokenNoSpaces);
              const isGoldy = isGoldyPromoCode(tokenNoSpaces);

              const resolvePromoAndApply = () => {
                let promoDoc = null;
                let tokenIdUsed = null;
                return Promise.all(candidateTokenIds.map((id) =>
                  admin.firestore().collection("userTokens").doc(id).get()
                )).then((docs) => {
                  for (let i = 0; i < docs.length; i++) {
                    if (docs[i].exists) {
                      promoDoc = docs[i];
                      tokenIdUsed = candidateTokenIds[i];
                      break;
                    }
                  }
                  let extraDays = 0;
                  if (promoDoc && promoDoc.exists) {
                    const promoData = promoDoc.data();
                    extraDays = Number(promoData.daysFree) || 0;
                    if (isBlue || isGoldy) extraDays = 30;
                    if (!promoData.reusable && !promoData.testMode) {
                      admin.firestore().collection("userTokens").doc(tokenIdUsed).delete();
                      console.log(`Promo code ${tokenIdUsed} applied (single-use) and deleted: ${extraDays} free days`);
                    } else {
                      console.log(`Promo code ${tokenIdUsed} applied (reusable): ${extraDays} free days`);
                    }
                  } else if (isBlue || isGoldy) {
                    extraDays = 30;
                    console.log(`Promo code ${token} (normalized: ${tokenNoSpaces}) not in Firestore; applying safety-net 30 days`);
                  }
                  return checkIfTrialUsed(uidToUse).then((trialUsed) => {
                    let totalDays;
                    if (isBlue || isGoldy) {
                      // Partner codes: exactly one month free — do not add the usual 7-day trial on top.
                      totalDays = extraDays > 0 ? extraDays : 30;
                    } else {
                      const baseDays = 30;
                      const trialDays = trialUsed ? 0 : 7;
                      totalDays = baseDays + trialDays + extraDays;
                    }
                    console.log(`Total days for subscription: ${totalDays} (promo blue/goldy=${isBlue || isGoldy}, extraDays=${extraDays})`);
                    return addMonthToSubscriptionIPN(req, res, uidToUse, totalDays, ipnTransactionMessage);
                  });
                });
              };

              return resolvePromoAndApply().catch((err) => {
                console.log("Error processing promo code:", err);
                const fallbackDays = (isBlue || isGoldy) ? 30 : 0;
                return checkIfTrialUsed(uidToUse).then((trialUsed) => {
                  let totalDays;
                  if (isBlue || isGoldy) {
                    totalDays = fallbackDays;
                  } else {
                    const baseDays = 30;
                    const trialDays = trialUsed ? 0 : 7;
                    totalDays = baseDays + trialDays + fallbackDays;
                  }
                  return addMonthToSubscriptionIPN(req, res, uidToUse, totalDays, ipnTransactionMessage);
                });
              });
            }

            return checkIfTrialUsed(uidToUse).then((trialUsed) => {
              return addMonthToSubscriptionIPN(req, res, uidToUse, trialUsed ? 30 : 37, ipnTransactionMessage);
            });
          };

        switch (eventType) {
          case "recurring_payment_profile_cancel":
            return res.status(200).end();

          case "subscr_signup":
            return applySignupDays();

          case "web_accept":
            // Hosted buttons can send web_accept instead of subscr_signup.
            return applySignupDays();

          case "subscr_payment":
            if ((payment_gross || 0) <= 0 && (mc_gross || 0) <= 0) {
              res.status(200).end();
              return;
            }
            return addMonthToSubscriptionIPN(req, res, uidToUse, 30, ipnTransactionMessage);

          case "subscr_cancel":
            return admin
              .firestore()
              .collection("members")
              .doc(uidToUse)
              .update({
                subscriptionActive: false,
              })
              .then(r => {
                console.log("subcriptionActive for " + uidToUse + " set to false");
                return res.status(200).end();
              })
              .catch(err => {
                console.log(err);
                return res.status(400).end();
              });

          default:
            // Fallback for hosted-button IPNs that omit txn_type but still indicate a successful payment.
            if (!eventType && ["completed", "processed"].includes(paymentStatus)) {
              console.log("IPN: missing txn_type but successful payment status, applying signup-day logic.");
              return applySignupDays();
            }
            return res.status(200).end();
        }
        }); // end resolveUid().then(uidToUse => ...)

        // TODO: Implement post verification logic on ipnTransactionMessage
        // if (ipnTransactionMessage.txn_type === 'recurring_payment_profile_cancel') {
        //     res.status(200).end();
        //     return;
        // }
        // else if (ipnTransactionMessage.txn_type === 'subscr_signup') {
        //     addMonthToSubscriptionIPN(req, res, uid, 7);
        // }
        // else if (ipnTransactionMessage.txn_type === "subscr_payment") {
        //     if (payment_gross === 0 || mc_gross === 0) {
        //         res.status(200).end();
        //         return;
        //     }
        //     return addMonthToSubscriptionIPN(req, res, uid, 31);
        // }
        // else if (ipnTransactionMessage.txn_type === "subscr_cancel") {
        //     res.status(200).end();
        //     return admin.firestore().collection('members').doc(uid)
        //         .update({
        //             subscriptionActive: false,
        //         })
        //         .then(r => console.log("subcriptionActive for " + uid + " set to false"))
        //         .catch(err => console.log(err));
        // }
        // else {
        //     res.status(200).end();
        //     return;
        // }
      } else if (body === "INVALID") {
        console.error(
          `Invalid IPN: IPN message for Transaction ID: ${ipnTransactionMessage.txn_id} is invalid.`
        );
        return res.status(200).end();
      } else {
        console.error("Unexpected reponse body.");
        return res.status(200).end();
      }
    } else {
      // Error occured while posting to PayPal.
      console.error(error);
      console.log(body);
      return res.status(200).end();
    }
  });
});

const checkIfTrialUsed = (uid, callback = undefined) => {
  const ref = admin.firestore().collection("members").doc(uid);
  return ref
    .get()
    .then(snapshot => {
      console.log("The user with UID: " + uid + " has used his free trial");
      const data = snapshot.data();
      return data.trialUsed;
    })
    .catch(err => {
      console.log("The user with UID: " + uid + " was not found");
      console.log(err);
      return false;
    });
};

const addMonthToSubscriptionIPN = (req, res, uid, days, ipnTransactionMessage) => {
  const ref = admin.firestore().collection("members").doc(uid);
  const date = new Date();
  date.setDate(date.getDate() + days + 0.65);
  
  // Determine tier based on PayPal button ID
  let tier = "basic"; // default to basic
  if (ipnTransactionMessage && ipnTransactionMessage.btn_id) {
    const buttonId = ipnTransactionMessage.btn_id;
    if (buttonId === "YNKJMUC64MT5Q") {
      tier = "basic";
    } else if (buttonId === "PRUK4P42SGVDC") {
      tier = "premium";
    }
    console.log(`PayPal button ID: ${buttonId}, Setting tier: ${tier}`);
  } else {
    console.warn("addMonthToSubscriptionIPN: btn_id missing, tier defaulting to basic");
  }
  const subscrId = ipnTransactionMessage && (ipnTransactionMessage.subscr_id || ipnTransactionMessage.recurring_payment_id);
  const update = {
    subscriptionExpires: date,
    paymentMethod: "paypal",
    subscriptionActive: true,
    trialUsed: true,
    tier: tier,
  };
  if (subscrId) update.subscriptionId = subscrId;
  ref
    .set(
      update,
      { merge: true }
    )
    .then(innerRes => {
      console.log(
        "COMPLETED ADDING " + days + " TO SUB FOR USER WITH UID:" + uid
      );
      return res.status(200).end();
      // res.status(200).end();
      // return;
    })
    .catch(err => {
      console.log(err);
      // return;
      return res.status(500).end(); // .send("");
    });
};

const paypalDeleteUsedToken = token => {
  console.log("THERE IS A TOKEN that was used and is now being deleted");
  const tokensRef = admin.firestore().collection("userTokens").doc(token);
  admin.firestore().runTransaction(t => {
    return t
      .get(tokensRef)
      .then(doc => {
        if (doc.exists) {
          // res.send(200, doc.data());
          return t.delete(tokensRef);
          // return doc;
        } else {
          return doc;
        }
      })
      .then(res => {
        return res;
      })
      .catch(err => {
        console.log(err);
        return err;
      });
  });
};

// Stripe webhook secrets must be provided via env/functions.config() (see getStripeWebhookSecrets()).

const TRIAL_PERIOD_DAYS = 0; // Set to 7 to enable 7-day trial for new subscribers (see PARKED_7_DAY_TRIAL.md)

// Step 1: create the customer on Signup:
exports.stripeSubscribeTokenHandler = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    handleSubscribeToken(req, res);
  });
});

const handleSubscribeToken = (req, res) => {
  const { token, email, uid, coupon } = req.body;
  let freeDays = TRIAL_PERIOD_DAYS;
  const description = `${uid}`;
  console.log(token);
  console.log(email);
  console.log(description);
  console.log("WITH COUPON: " + coupon);

  if (coupon !== undefined) {
    const tokensRef = admin.firestore().collection("userTokens").doc(coupon);
    admin
      .firestore()
      .runTransaction(t => {
        return t.get(tokensRef).then(doc => {
          if (doc.exists) {
            // res.send(200, doc.data());
            t.delete(tokensRef);
            const tokenData = doc.data();
            let coupon = undefined;
            if (tokenData.daysFree) {
              // Promo defines the full trial — do not stack TRIAL_PERIOD_DAYS on top of daysFree.
              freeDays = Number(tokenData.daysFree);
            }
            if (tokenData.percentOffFirstMonth === "50%") {
              coupon = "_50_percent_off";
            } else if (tokenData.percentOffFirstMonth === "25%") {
              coupon = "_25_percent_off";
            }

            console.log(tokenData);
            console.log(freeDays);
            return createStripeSubscription(
              req,
              res,
              email,
              token,
              description,
              freeDays,
              uid,
              coupon
            );
          } else {
            return createStripeSubscription(
              req,
              res,
              email,
              token,
              description,
              freeDays,
              uid,
              undefined
            );
          }
        });
      })
      .then(res => {
        return res;
      })
      .catch(err => {
        console.log(err);
        return;
      });
  } else {
    return createStripeSubscription(
      req,
      res,
      email,
      token,
      description,
      freeDays,
      uid,
      undefined
    );
  }
};

const createStripeSubscription = (
  req,
  res,
  email,
  token,
  description,
  freeDays,
  uid,
  coupon
) => {
  if (freeDays > 0) {
    checkIfTrialUsed(uid)
      .then(answer => {
        if (answer) {
          console.log("FREE TRIAL USED - adding 0 free days");
          return createStripeSubscriptionX(
            req,
            res,
            email,
            token,
            description,
            0,
            uid,
            coupon
          );
        } else {
          console.log(
            "FREE TRIAL NOT USED - adding " + freeDays + " free days"
          );
          return createStripeSubscriptionX(
            req,
            res,
            email,
            token,
            description,
            freeDays,
            uid,
            coupon
          );
        }
      })
      .catch(err => {
        console.log(err);
        return createStripeSubscriptionX(
          req,
          res,
          email,
          token,
          description,
          freeDays,
          uid,
          coupon
        );
      });
  } else {
    return createStripeSubscriptionX(
      req,
      res,
      email,
      token,
      description,
      freeDays,
      uid,
      coupon
    );
  }
};

const createStripeSubscriptionX = (
  req,
  res,
  email,
  token,
  description,
  freeDays = 0,
  uid,
  coupon
) => {
  console.log(
    "Creating a subscription for " + uid + " with " + freeDays + " free days"
  );
  const customer = stripe.customers.create(
    {
      email,
      source: token,
      description,
    },
    (err, customer) => {
      if (err) {
        console.log(err);
        res.status(500).send(err);
        return;
      } else {
        console.log("Creating customer successful:");
        console.log(customer);
        const createSubscriptionObject = {
          customer: customer.id,
          items: [{ plan: planId }],
          metadata: { uid: uid },
          // description: description,
        };
        if (freeDays !== undefined && Number(freeDays) > 0) {
          createSubscriptionObject["trial_period_days"] = Number(freeDays);
        }
        if (coupon !== undefined) {
          createSubscriptionObject["coupon"] = coupon;
        }

        stripe.subscriptions.create(
          createSubscriptionObject,
          (err, subscription) => {
            if (err) {
              console.log("THERE WAS SOME ERROR");
              console.log(err);
              res.send(500, err);
              return;
            } else {
              console.log("Subscription successful:");
              console.log(subscription);
              return addMonthToSubscriptionStripe(
                req,
                res,
                uid,
                Number(freeDays),
                subscription
              );
              // res.status(200).send(subscription);
              // return;
            }
          }
        );
      }
    }
  );
};

// Modern Stripe Checkout Session creation
exports.stripeCreateCheckoutSession = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    handleCreateCheckoutSession(req, res);
  });
});

const handleCreateCheckoutSession = async (req, res) => {
  try {
    // Ensure body is parsed (Firebase may pass raw body; parse JSON if needed)
    let body = req.body;
    if ((body === undefined || body === null) && req.rawBody) {
      try {
        body = typeof req.rawBody === 'string' ? JSON.parse(req.rawBody) : JSON.parse(req.rawBody.toString());
      } catch (e) {
        console.warn("Could not parse request body:", e.message);
      }
    }
    body = body || {};
    console.log("Creating checkout session with body:", body, "coupon present:", !!body.coupon);
    const { priceId, email, uid, coupon, tierName } = body;
    
    const normalizedTier = normalizeTier(tierName);
    if (!priceId || !email || !uid || !normalizedTier) {
      console.error("Missing/invalid checkout parameters:", {
        priceId: !!priceId,
        email: !!email,
        uid: !!uid,
        tierName,
        normalizedTier,
      });
      return res.status(400).json({
        error: "Missing required parameters: priceId, email, uid, and valid tierName are required",
      });
    }

    // Ensure members doc exists so webhook/success can always update it (avoids "no doc" when webhook or success fails)
    try {
      await admin.firestore().collection("members").doc(uid).set(
        { lastCheckoutStartedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (ensureErr) {
      console.warn("Could not ensure members doc exists (non-fatal):", ensureErr.message);
    }

    // Build success and cancel URLs
    const baseUrl = req.headers.origin || 'https://bridgechampions.web.app';
    const successUrl = `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/membership?canceled=true`;
    
    console.log("Base URL:", baseUrl);
    console.log("Success URL:", successUrl);
    console.log("Cancel URL:", cancelUrl);

    // Create checkout session
    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      customer_email: email,
      metadata: {
        uid: uid,
        tierName: normalizedTier,
        promoCode: coupon || '', // Store promo code for webhook processing
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    };
    
    // Add subscription metadata (always include uid for webhook processing)
    sessionParams.subscription_data = {
      metadata: {
        uid: uid,
      },
    };

    // Add coupon if provided (promo token in Firestore)
    const couponTrimmed = (coupon && String(coupon).trim()) || "";
    if (couponTrimmed !== '') {
      try {
        // Try multiple Firestore doc IDs to handle legacy casing and spaces (e.g. "harbour view" -> harbourview).
        const couponTrim = couponTrimmed;
        const couponLower = couponTrim.toLowerCase();
        const couponNoSpaces = couponLower.replace(/\s+/g, '');
        const couponUpper = couponTrim.toUpperCase();
        if (couponNoSpaces === "harbourview") {
          return res.status(400).json({
            error: "Invalid promo code",
            details: "That promo code is no longer valid. Please use the current code (BLUE).",
          });
        }
        const isBlue = isBluePromoCode(couponNoSpaces);
        const isGoldy = isGoldyPromoCode(couponNoSpaces);

        const candidateTokenIds = promoTokenFirestoreDocIds(couponTrim, couponLower, couponNoSpaces, couponUpper);
        console.log(`Looking up promo token. entered="${couponTrim}" normalized="${couponNoSpaces}" candidates=${JSON.stringify(candidateTokenIds)}`);

        let tokenDoc = null;
        let tokenIdUsed = null;
        for (const tokenId of candidateTokenIds) {
          const docSnap = await admin.firestore().collection("userTokens").doc(tokenId).get();
          if (docSnap.exists) {
            tokenDoc = docSnap;
            tokenIdUsed = tokenId;
            break;
          }
        }

        // Safety-net promos: should always yield a 30-day free trial.
        // This prevents accidental immediate charges when the Firestore token is missing/misconfigured.
        if ((!tokenDoc || !tokenDoc.exists) && (isBlue || isGoldy)) {
          console.warn(
            `${couponLower.toUpperCase()} promo token not found in Firestore. Applying fallback 30-day trial to prevent immediate charge.`
          );
          tokenIdUsed = tokenIdUsed || couponLower;
          tokenDoc = {
            exists: true,
            data: () => ({ daysFree: 30, reusable: true, fallback: true }),
          };
        }

        if (tokenDoc && tokenDoc.exists) {
          const tokenData = tokenDoc.data() || {};
          console.log("Promo code token data:", tokenData);

          // Enforce promo tier compatibility with requested checkout tier.
          // Prevents mismatches like selecting Basic while using a Premium-only promo.
          const requestedTier = normalizedTier;
          const promoTier = normalizeTier(tokenData.tier || "");
          if (promoTier && requestedTier && promoTier !== requestedTier) {
            return res.status(400).json({
              error: "Promo code applies to a different tier",
              details: `This promo is valid for ${promoTier} only.`,
            });
          }

          // Persist both the entered code and the resolved Firestore token id for webhook processing.
          sessionParams.metadata = sessionParams.metadata || {};
          sessionParams.metadata.promoCodeEntered = couponTrim;
          sessionParams.metadata.promoTokenId = tokenIdUsed;
          // Back-compat with older webhook code paths:
          sessionParams.metadata.promoCode = tokenIdUsed;
          if (!sessionParams.subscription_data) sessionParams.subscription_data = {};
          if (!sessionParams.subscription_data.metadata) sessionParams.subscription_data.metadata = {};
          sessionParams.subscription_data.metadata.promoTokenId = tokenIdUsed;
          
          // Handle free days - add trial period (prioritize this over percentage discounts)
          // If daysFree is set, use trial period instead of charging immediately
          const effectiveDaysFree = (isBlue || isGoldy) ? 30 : tokenData.daysFree;

          if (effectiveDaysFree !== undefined && effectiveDaysFree !== null) {
            // Promo defines the full Stripe trial — do not stack TRIAL_PERIOD_DAYS (e.g. 7-day site trial) on top.
            const freeDays = Number(effectiveDaysFree);
            console.log(`Promo code daysFree: ${effectiveDaysFree} (override=${isBlue || isGoldy}), total trial days: ${freeDays}`);
            if (freeDays > 0) {
              // Ensure subscription_data exists
              if (!sessionParams.subscription_data) {
                sessionParams.subscription_data = {};
              }
              sessionParams.subscription_data.trial_period_days = freeDays;
              console.log(`Setting trial_period_days to ${freeDays} - user will NOT be charged immediately`);

              // Make it explicit on the Stripe-hosted Checkout page that $0 is due today.
              // Stripe will also show "Free trial" automatically when trial_period_days is set,
              // but this custom text helps reduce confusion.
              const billedOn = new Date();
              billedOn.setDate(billedOn.getDate() + freeDays);
              const billedOnStr = billedOn.toLocaleDateString("en-AU", {
                year: "numeric",
                month: "short",
                day: "numeric",
              });
              sessionParams.custom_text = sessionParams.custom_text || {};
              sessionParams.custom_text.submit = {
                message: `You will pay $0 today. Your first charge will be on ${billedOnStr} unless you cancel before then.`,
              };
            }
          } else {
            // Only apply percentage discounts if there's no daysFree (trial period)
            let stripeCoupon = undefined;
            if (tokenData.percentOffFirstMonth === "50%") {
              stripeCoupon = "_50_percent_off";
            } else if (tokenData.percentOffFirstMonth === "25%") {
              stripeCoupon = "_25_percent_off";
            }
            
            if (stripeCoupon) {
              sessionParams.discounts = [{ coupon: stripeCoupon }];
              console.log(`Applying percentage discount coupon: ${stripeCoupon}`);
            }
          }
          
          // Override price with token's stripePriceId (e.g. ausyouth = $20/month instead of $50)
          if (tokenData.stripePriceId && typeof tokenData.stripePriceId === "string" && tokenData.stripePriceId.startsWith("price_")) {
            sessionParams.line_items[0].price = tokenData.stripePriceId;
            console.log(`Promo overrides price to: ${tokenData.stripePriceId}`);
          }

          // Only delete the token if it's NOT a test/reusable token
          // Test tokens should have testMode: true or reusable: true in Firestore
          if (!tokenData.testMode && !tokenData.reusable) {
            // Delete the used token (will be done after successful checkout in webhook)
            // For now, we'll let the webhook handle deletion
          }
        } else if (!(isBlue || isGoldy)) {
          // Coupon was provided but not found in Firestore (and not a safety-net promo)
          // Reject so user isn't charged without their promo - avoids complaints
          console.warn(`Promo code "${couponTrim}" not found in Firestore`);
          return res.status(400).json({
            error: "Invalid promo code",
            details: "The promo code you entered was not found. Please check the spelling and try again, or proceed without a promo code.",
          });
        }
      } catch (couponError) {
        console.error("Error checking coupon:", couponError);
        // For harbourview/goldy we have fallback below. For others, fail rather than charge without promo.
        const couponForCheck = (coupon && String(coupon).trim()) || "";
        const norm = couponForCheck.toLowerCase().replace(/\s+/g, "");
        if (!isBluePromoCode(norm) && norm !== "goldy") {
          return res.status(500).json({
            error: "Could not verify promo code",
            details: "Please try again or contact support if the problem persists.",
          });
        }
        // harbourview/blue/goldy: fall through to safety net below
      }

      // Safety net: if they entered HARBOURVIEW or GOLDY but trial wasn't set (e.g. token lookup failed, or typo with space),
      // still give 30 days free so they are never charged immediately.
      const couponForFallback = couponTrimmed;
      const couponNormalizedForFallback = couponForFallback.toLowerCase().replace(/\s+/g, '');
      if ((isBluePromoCode(couponNormalizedForFallback) || couponNormalizedForFallback === "goldy") &&
          (!sessionParams.subscription_data || !sessionParams.subscription_data.trial_period_days)) {
        console.warn(`Safety net: applying 30-day trial for promo "${couponForFallback}" (normalized=${couponNormalizedForFallback}, trial was not set in coupon block).`);
        if (!sessionParams.subscription_data) sessionParams.subscription_data = {};
        sessionParams.subscription_data.trial_period_days = 30;
        const billedOn = new Date();
        billedOn.setDate(billedOn.getDate() + 30);
        const billedOnStr = billedOn.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" });
        sessionParams.custom_text = sessionParams.custom_text || {};
        sessionParams.custom_text.submit = {
          message: `You will pay $0 today. Your first charge will be on ${billedOnStr} unless you cancel before then.`,
        };
      }
    }
    
    // Validate priceId exists before creating session
    if (!priceId || !priceId.startsWith('price_')) {
      throw new Error(`Invalid price ID: ${priceId}`);
    }
    
    // Ensure subscription_data always has metadata (required for webhook)
    // Only include subscription_data if we have metadata or trial_period_days
    if (!sessionParams.subscription_data) {
      sessionParams.subscription_data = {};
    }
    
    // Always include metadata for webhook processing
    if (!sessionParams.subscription_data.metadata) {
      sessionParams.subscription_data.metadata = {};
    }
    sessionParams.subscription_data.metadata.uid = uid;
    
    // Clean up: remove subscription_data if it only has empty metadata
    if (Object.keys(sessionParams.subscription_data.metadata).length === 0 && 
        !sessionParams.subscription_data.trial_period_days) {
      delete sessionParams.subscription_data;
    }
    
    console.log("Session params (before Stripe call):", JSON.stringify(sessionParams, null, 2));
    console.log("Price ID being used:", priceId);
    console.log("Stripe live mode:", stripeLive);
    
    // Get Stripe instance (lazy initialization)
    const stripeInstance = getStripe();
    console.log("Stripe API initialized:", !!stripeInstance);
    
    let session;
    try {
      session = await stripeInstance.checkout.sessions.create(sessionParams);
    } catch (stripeError) {
      console.error("Stripe API error details:", {
        type: stripeError.type,
        code: stripeError.code,
        message: stripeError.message,
        param: stripeError.param,
        statusCode: stripeError.statusCode,
        raw: stripeError.raw ? stripeError.raw.message : 'N/A'
      });
      // Re-throw with more context
      throw new Error(`Stripe API error: ${stripeError.message} (${stripeError.type || 'Unknown'})`);
    }
    console.log("Checkout session created successfully:", session.id);
    console.log("Checkout URL:", session.url);
    
    res.status(200).json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    console.error('Error details:', {
      message: error.message,
      type: error.type,
      code: error.code,
      param: error.param,
      statusCode: error.statusCode,
      stack: error.stack
    });
    
    // Return more detailed error for debugging
    const errorResponse = {
      error: error.message || 'Failed to create checkout session',
      details: error.type || 'Unknown error',
      code: error.code || 'UNKNOWN'
    };
    
    // Don't expose internal errors to client, but log them
    if (error.type === 'StripeInvalidRequestError') {
      errorResponse.error = 'Invalid payment configuration. Please contact support.';
    }
    
    res.status(500).json(errorResponse);
  }
};

// Post-checkout verification/activation endpoint (webhook fallback)
// Purpose: give the client actionable feedback and still activate access even if the webhook is failing.
// Security: requires uid and checks it matches the session/subscription metadata.
exports.stripeVerifyCheckoutSession = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const rawSessionId = (req.body?.sessionId || req.body?.session_id || "").toString();
    const sessionId = rawSessionId
      .trim()
      // strip common accidental quoting
      .replace(/^['"]+/, "")
      .replace(/['"]+$/, "")
      // if a templated placeholder was somehow passed through, strip braces
      .replace(/[{}]/g, "");
    const uid = (req.body?.uid || "").toString().trim();

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing sessionId",
        debug: { received: rawSessionId ? String(rawSessionId).slice(0, 50) : "" },
      });
    }
    if (!uid) {
      return res.status(400).json({ ok: false, error: "Missing uid (user must be logged in)" });
    }
    if (sessionId === "CHECKOUT_SESSION_ID") {
      return res.status(400).json({
        ok: false,
        error: "Invalid sessionId: placeholder CHECKOUT_SESSION_ID was not replaced",
        debug: { sessionId },
      });
    }
    if (!sessionId.startsWith("cs_")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid sessionId format",
        debug: {
          sessionIdPrefix: sessionId.slice(0, 12),
          sessionIdLength: sessionId.length,
        },
      });
    }

    try {
      console.log("stripeVerifyCheckoutSession called:", {
        sessionIdPrefix: sessionId.slice(0, 12),
        sessionIdLength: sessionId.length,
        uidPresent: !!uid,
      });
      const stripeInstance = getStripe();

      // Retrieve session (expand subscription so we can compute expiry accurately)
      const session = await stripeInstance.checkout.sessions.retrieve(sessionId, {
        expand: ["subscription"],
      });

      const sessionUid = session?.metadata?.uid;
      const sessionMode = session?.mode;
      const tier = normalizeTier(session?.metadata?.tierName);

      if (sessionMode !== "subscription") {
        return res.status(400).json({
          ok: false,
          error: `Unexpected session mode: ${sessionMode || "unknown"}`,
          details: { sessionMode },
        });
      }

      if (!sessionUid) {
        return res.status(400).json({
          ok: false,
          error: "Session is missing uid in metadata (cannot safely activate)",
          details: { metadata: session?.metadata || null },
        });
      }

      if (sessionUid !== uid) {
        return res.status(403).json({
          ok: false,
          error: "This checkout session does not belong to the currently logged-in user",
          details: { sessionUid, uid },
        });
      }

      // Subscription can be id string or expanded object (depending on expand result)
      const subscription =
        typeof session.subscription === "string"
          ? await stripeInstance.subscriptions.retrieve(session.subscription)
          : session.subscription;

      const subscriptionId = subscription?.id || (typeof session.subscription === "string" ? session.subscription : null);
      const currentPeriodEnd = subscription?.current_period_end; // unix seconds
      const trialEnd = subscription?.trial_end; // unix seconds (nullable)
      const status = subscription?.status;

      // Determine access expiry based on Stripe's billing period end (most accurate)
      let expiresDate = null;
      if (typeof currentPeriodEnd === "number") {
        expiresDate = new Date(currentPeriodEnd * 1000);
      } else {
        // Fallback: 30 days from now (legacy behavior)
        expiresDate = new Date();
        expiresDate.setDate(expiresDate.getDate() + 30 + 0.65);
      }

      const expiresTimestamp = admin.firestore.Timestamp.fromDate(expiresDate);

      await admin
        .firestore()
        .collection("members")
        .doc(uid)
        .set(
          {
            subscriptionId: subscriptionId || "unknown",
            subscriptionExpires: expiresTimestamp,
            subscriptionActive: true,
            paymentMethod: "stripe",
            ...(tier ? { tier } : {}),
            // useful for support/debugging:
            stripeStatus: status || null,
            stripeTrialEnd: typeof trialEnd === "number" ? new Date(trialEnd * 1000).toISOString() : null,
            lastCheckoutSessionId: sessionId,
            lastCheckoutVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      return res.status(200).json({
        ok: true,
        message: "Subscription verified and access activated",
        data: {
          uid,
          sessionId,
          subscriptionId,
          tier: tier || null,
          stripeStatus: status,
          currentPeriodEnd: currentPeriodEnd || null,
          trialEnd: trialEnd || null,
          expiresIso: expiresDate.toISOString(),
        },
      });
    } catch (error) {
      console.error("stripeVerifyCheckoutSession error:", error);
      return res.status(500).json({
        ok: false,
        error: error.message || "Failed to verify checkout session",
        code: error.code || null,
        type: error.type || null,
      });
    }
  });
});

exports.stripeCancelSubscription = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    console.log("INCOMING REQ to cancel sub");
    console.log(req);
    console.log(req.body);
    return stripeCancelSubscriptionHandlerFn(req, res);
  });
});

const stripeCancelSubscriptionHandlerFn = (req, res) => {
  const uid = req.body && (req.body.uid != null) ? req.body.uid : null;
  if (!uid) {
    console.log("stripeCancelSubscription: missing uid in body", req.body);
    res.status(400).json({ ok: false, error: "Missing uid" });
    return Promise.resolve();
  }
  console.log("CANCELLING SUBSCRIPTION for member with uid: " + uid);

  return admin
    .firestore()
    .collection("members")
    .doc(uid)
    .get()
    .then(snapshot => {
      if (!snapshot.exists) {
        console.log("stripeCancelSubscription: no members doc for uid", uid);
        res.status(404).json({ ok: false, error: "Member not found" });
        return;
      }
      const memberData = snapshot.data();
      console.log(memberData);
      const subscriptionId = memberData && memberData.subscriptionId;
      if (!subscriptionId || typeof subscriptionId !== "string") {
        console.log("stripeCancelSubscription: no subscriptionId for uid", uid);
        return admin
          .firestore()
          .collection("members")
          .doc(uid)
          .update({ subscriptionActive: false })
          .then(() => {
            res.status(200).json({ ok: true, message: "No Stripe subscription; access cleared." });
          })
          .catch((err) => {
            console.log(err);
            res.status(500).json({ ok: false, error: err.message || "Failed to update member" });
          });
      }
      return cancelMemberSubscription(subscriptionId, res, uid);
    })
    .catch(err => {
      console.log(err);
      res.status(500).json({ ok: false, error: err.message || String(err) });
      return;
    });
};

const cancelMemberSubscription = (subscriptionId, res, uid) => {
  const stripeInstance = getStripe();
  // Cancel at period end so the user keeps access until their paid time runs out
  return stripeInstance.subscriptions
    .update(subscriptionId, { cancel_at_period_end: true })
    .then(subscription => {
      const periodEnd = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null;
      return admin
        .firestore()
        .collection("members")
        .doc(uid)
        .update({
          cancelAtPeriodEnd: true,
          ...(periodEnd && { subscriptionExpires: admin.firestore.Timestamp.fromDate(periodEnd) }),
        })
        .then(() => {
          console.log("Cancel at period end set for " + uid + "; access until " + (periodEnd ? periodEnd.toISOString() : "period end"));
          res.status(200).json({
            ok: true,
            cancelAtPeriodEnd: true,
            message: "Your subscription will end at the end of your current billing period. You will keep full access until then.",
            subscriptionExpires: periodEnd ? periodEnd.toISOString() : undefined,
          });
        })
        .catch(err => {
          console.log(err);
          res.status(500).json({ ok: false, error: err.message || "Failed to update member" });
        });
    })
    .catch(err => {
      console.log(err);
      const code = err && err.code;
      const isAlreadyCancelled = code === "resource_missing" || (err.message && err.message.toLowerCase().includes("no such subscription"));
      if (isAlreadyCancelled) {
        return admin
          .firestore()
          .collection("members")
          .doc(uid)
          .update({ subscriptionActive: false })
          .then(() => {
            res.status(200).json({ ok: true, message: "Subscription was already cancelled; access cleared." });
          })
          .catch((updateErr) => {
            console.log(updateErr);
            res.status(500).json({ ok: false, error: updateErr.message || String(updateErr) });
          });
      }
      res.status(500).json({ ok: false, error: err.message || String(err) });
      return;
    });
};

// prod_CaO9pAb9VQ0QNI <- planId
// createStripeCustomer = functions.auth.user().onCreate(event => {
// const createStripeCustomer = event => {
//     // user auth data
//     const user = event.data;
//     const uid = user.uid;
//     const userName = user.email.split("@")[0];
//     // register Stripe user
//     return stripe.customers.create({
//         email: user.email,
//         uid: user.uid,
//     })
//         .then(customer => {
//             console.log(customer);
//             /// update database with stripe customer id
//             const ref = admin.firestore().collection('membersData').doc(uid);
//             return ref.set({
//                 'stripeCustomerId': customer.id,
//                 'username': userName,
//                 'email': user.email,
//             }, {merge: true});
//         });
// };

// const CreatePlan = (uid) => {
//     // amount is in cents - 1599 = 15.99
//     const plan = stripe.plans.create({
//         product: {name: "BridgeChampions Subscription"},
//         id: "bc-basic-subscription",
//         object: "plan",
//         time: Date.now(),
//         currency: 'usd',
//         amount: '1599',
//         interval: 'month',
//         interval_count: 1,
//         livemode: stripeLIVE,
//         metadata: {
//           uid,
//         },
//         nickname: 'Basic Monthly',
//         amount: 0,
//     });
// }

// Helper: sync a Stripe subscription to Firestore members doc. Returns true if updated.
async function syncStripeSubscriptionToMember(subscription) {
  let uid = subscription.metadata?.uid;
  if (!uid) {
    const stripeInstance = getStripe();
    const sessions = await stripeInstance.checkout.sessions.list({ subscription: subscription.id, limit: 1 });
    if (sessions.data?.length) uid = sessions.data[0].metadata?.uid;
  }
  if (!uid && subscription.customer) {
    const stripeInstance = getStripe();
    const customer = typeof subscription.customer === "string"
      ? await stripeInstance.customers.retrieve(subscription.customer)
      : subscription.customer;
    const email = customer?.email;
    if (email) {
      const users = await admin.auth().listUsers(1000);
      const match = users.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
      if (match) uid = match.uid;
    }
  }
  if (!uid) return false;

  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
  const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
  const expiresDate = trialEnd || periodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const memberRef = admin.firestore().collection("members").doc(uid);
  const memberSnap = await memberRef.get();
  const data = memberSnap.exists ? memberSnap.data() : {};
  if (data.subscriptionActive === true && data.subscriptionExpires) return false;

  const inferredTier = inferTierFromSubscription(subscription);
  const updatePayload = {
    subscriptionId: subscription.id,
    subscriptionExpires: admin.firestore.Timestamp.fromDate(expiresDate),
    subscriptionActive: true,
    paymentMethod: "stripe",
    stripeStatus: subscription.status,
    ...(trialEnd && { stripeTrialEnd: trialEnd.toISOString() }),
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Never auto-upgrade by fallback. If tier can't be inferred, preserve existing Firestore tier.
  if (inferredTier) {
    updatePayload.tier = inferredTier;
  } else {
    console.warn(
      "Could not infer tier from Stripe subscription during sync; preserving existing tier",
      { subscriptionId: subscription.id, uid }
    );
  }

  await memberRef.set(updatePayload, { merge: true });
  return true;
}

// Scheduled: daily sync of Stripe subscriptions to Firestore (catches webhook/success-page misses)
async function runScheduledStripeSync() {
  const stripeInstance = getStripe();
  const subs = await stripeInstance.subscriptions.list({
    status: "all",
    limit: 100,
    expand: ["data.customer", "data.items.data.price", "data.items.data.price.product"],
  });
  let updated = 0;
  for (const sub of subs.data) {
    if (sub.status !== "trialing" && sub.status !== "active") continue;
    const didUpdate = await syncStripeSubscriptionToMember(sub);
    if (didUpdate) updated++;
  }
  console.log("Scheduled Stripe sync complete:", updated, "member(s) updated");
}

exports.stripeWebhookHandler = functions.https.onRequest((req, res) => {
  const sendOk = () => res.status(200).send("OK");
  console.log("stripeWebhookHandler called");
  const signature = req.headers["stripe-signature"];
  if (!signature) {
    console.error("Webhook error: Missing stripe-signature header");
    return res.status(400).send("Webhook Error: Missing stripe-signature header");
  }
  if (!req.rawBody) {
    console.error("Webhook error: Missing req.rawBody (raw request body required for signature verification)");
    return res.status(400).send("Webhook Error: Missing raw body");
  }

  let uid;
  let reconstructedEvent;

  try {
    // Get Stripe instance (lazy initialization)
    const stripeInstance = getStripe();
    if (!stripeInstance) {
      throw new Error("Stripe instance not initialized");
    }

    const secrets = getStripeWebhookSecrets();
    let lastErr = null;
    for (const secret of secrets) {
      try {
        reconstructedEvent = stripeInstance.webhooks.constructEvent(req.rawBody, signature, secret);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!reconstructedEvent) {
      throw lastErr || new Error("Unable to verify webhook signature (no secrets configured?)");
    }

    console.log("SUCCESSFUL RECONSTRUCTION - EVENT VALID:", reconstructedEvent.type);
  } catch (e) {
    console.error("Webhook signature verification failed:", e.message);
    console.error("Error details:", {
      message: e.message,
      type: e.type,
      stack: e.stack
    });
    // Log the signature for debugging (don't log the full signature in production)
    console.log("Received signature header:", signature ? "Present" : "Missing");
    console.log("Configured webhook secrets:", getStripeWebhookSecrets().length);
    res.status(400).send(`Webhook Error: ${e.message}`);
    return;
  }

  try {
  // Safe access to event payload ONLY after verification
  const eventObject = reconstructedEvent?.data?.object || {};
  const subscriptionId = eventObject.subscription;
  const amountPaid = eventObject.amount_paid;
  if (amountPaid !== undefined) {
    console.log("THIS MUCH WAS PAID: ", amountPaid);
  }

  switch (reconstructedEvent.type) {
    // Handle Stripe Checkout Session completed (for modern Checkout)
    case "checkout.session.completed":
      console.log("checkout.session.completed event received");
      const session = reconstructedEvent.data.object;
      const sessionUid = session.metadata?.uid;
      const sessionSubscriptionId = session.subscription;
      const sessionTier = normalizeTier(session.metadata?.tierName);
      
      if (!sessionUid) {
        console.error("❌ CRITICAL: No uid in session metadata!");
        console.error("Session metadata:", JSON.stringify(session.metadata, null, 2));
        console.error("Full session object keys:", Object.keys(session));
        // Still return 200 to Stripe so they don't retry, but log the error
        return sendOk();
      }

      console.log("Processing checkout session for uid:", sessionUid);
      console.log("Subscription ID:", sessionSubscriptionId);
      console.log("Tier from session metadata:", session.metadata?.tierName, "=>", sessionTier);

      // Store subscription ID and activate subscription. Use subscription's trial_end/period_end for correct promo expiry.
      const getExpiresFromSubscription = async () => {
        if (!sessionSubscriptionId) return null;
        try {
          const stripeInstance = getStripe();
          const sub = await stripeInstance.subscriptions.retrieve(sessionSubscriptionId, {
            expand: ["items.data.price"],
          });
          const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
          const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
          return trialEnd || periodEnd || null;
        } catch (e) {
          console.warn("Could not fetch subscription for expiry (fallback to 30 days):", e.message);
          return null;
        }
      };

      return getExpiresFromSubscription()
        .then(stripeExpires => {
          const fallbackDate = new Date();
          fallbackDate.setDate(fallbackDate.getDate() + 30 + 0.65);
          let subscriptionExpires = stripeExpires || fallbackDate;
          return admin.firestore().collection("members").doc(sessionUid).get()
            .then(docSnapshot => {
              if (docSnapshot.exists) {
                const docData = docSnapshot.data();
                let existingExpires = docData.subscriptionExpires;
                if (existingExpires && existingExpires.toDate) {
                  existingExpires = existingExpires.toDate();
                } else if (existingExpires && typeof existingExpires === "string") {
                  existingExpires = new Date(existingExpires);
                } else if (existingExpires && existingExpires.seconds) {
                  existingExpires = new Date(existingExpires.seconds * 1000);
                }
                if (existingExpires && subscriptionExpires < existingExpires) {
                  subscriptionExpires = existingExpires;
                }
              }
              const expiresTimestamp = subscriptionExpires instanceof Date
                ? admin.firestore.Timestamp.fromDate(subscriptionExpires)
                : subscriptionExpires;
              const payload = {
                subscriptionId: sessionSubscriptionId,
                subscriptionExpires: expiresTimestamp,
                subscriptionActive: true,
                paymentMethod: "stripe",
                trialUsed: true,
                ...(sessionTier ? { tier: sessionTier } : {}),
              };
              return admin.firestore().collection("members").doc(sessionUid).set(payload, { merge: true });
            });
        })
        .then(() => {
          console.log("✅ SUCCESS: Subscription activated for uid:", sessionUid);
          console.log("✅ Member document created/updated in Firestore");
          
          // Handle promo code deletion (only if not a test/reusable code)
          const promoTokenId = session.metadata?.promoTokenId || session.metadata?.promoCode;
          if (promoTokenId && promoTokenId !== '') {
            return admin.firestore().collection("userTokens").doc(promoTokenId).get()
              .then(promoDoc => {
                if (promoDoc.exists) {
                  const promoData = promoDoc.data();
                  // Only delete if NOT a test/reusable token
                  if (!promoData.testMode && !promoData.reusable) {
                    console.log("Deleting used promo token:", promoTokenId);
                    return admin.firestore().collection("userTokens").doc(promoTokenId).delete();
                  } else {
                    console.log("Keeping test/reusable promo token:", promoTokenId);
                  }
                }
              })
              .catch(err => {
                console.error("Error handling promo code deletion:", err);
                // Don't fail the whole process if promo deletion fails
              })
              .then(() => sendOk());
          } else {
            return sendOk();
          }
        })
        .catch(err => {
          console.error("❌ CRITICAL ERROR processing checkout session:", err);
          console.error("Error stack:", err.stack);
          console.error("Error details:", {
            message: err.message,
            code: err.code,
            uid: sessionUid,
            subscriptionId: sessionSubscriptionId
          });
          return res.status(500).send(`Error: ${err.message}`);
        });

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subObj = eventObject;
      if (subObj.status !== "trialing" && subObj.status !== "active") {
        return sendOk();
      }
      return syncStripeSubscriptionToMember(subObj)
        .then(updated => {
          if (updated) console.log("Synced subscription to member:", subObj.id);
          return sendOk();
        })
        .catch(err => {
          console.error("Error syncing subscription:", err);
          return res.status(500).send(err.message);
        });
    }

    case "customer.subscription.deleted": {
      const deletedSubId = eventObject.id;
      console.log("customer.subscription.deleted for subscription:", deletedSubId);
      return admin
        .firestore()
        .collection("members")
        .where("subscriptionId", "==", deletedSubId)
        .get()
        .then(snapshot => {
          if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            return doc.ref.update({
              subscriptionActive: false,
              cancelAtPeriodEnd: admin.firestore.FieldValue.delete(),
            }).then(() => {
              console.log("subscriptionActive set to false for uid:", doc.id);
              return sendOk();
            });
          }
          console.log("No member found for deleted subscription:", deletedSubId);
          return sendOk();
        })
        .catch(err => {
          console.error("Error handling subscription.deleted:", err);
          return res.status(500).send(err.message);
        });
    }

    case "invoice.created":
      return sendOk();
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      // case "charge.succeeded":
      if (amountPaid === 0) {
        console.log("Nothing was paid, do not add time");
        return sendOk();
      }

      console.log("invoice payment succeeded for event: ", reconstructedEvent.type);
      console.log("Subscription ID:", subscriptionId);

      return admin
        .firestore()
        .collection("members")
        .where("subscriptionId", "==", subscriptionId)
        .get()
        .then(snapshot => {
          if (snapshot.empty) {
            console.warn("invoice.payment_succeeded: no member found for subscriptionId:", subscriptionId);
            return sendOk();
          }
          uid = snapshot.docs[0].id;
          console.log("Adding month for uid:", uid);
          return addMonthToSubscriptionStripeWebhook(req, res, uid, sendOk);
        })
        .catch(err => {
          console.error("Error in invoice.payment_succeeded:", err);
          return res.status(500).send(err.message || "Internal error");
        });
    }

    // case "customer.subscription.deleted":

    default:
      console.log("Unhandled event type:", reconstructedEvent.type);
      return sendOk();
  }
  } catch (unhandledErr) {
    console.error("Stripe webhook unhandled error:", unhandledErr);
    if (!res.headersSent) {
      return res.status(500).send(unhandledErr.message || "Webhook handler error");
    }
  }
});

// Manual activation function for testing/fixing subscriptions
exports.manualActivateSubscription = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    const { uid, subscriptionId, days = 30, tier = "basic" } = req.body || {};
    
    if (!uid) {
      return res.status(400).json({ error: 'Missing uid parameter' });
    }

    try {
      const date = new Date();
      date.setDate(date.getDate() + days + 0.65);

      const memberRef = admin.firestore().collection("members").doc(uid);
      const memberDoc = await memberRef.get();

      const normalizedTier = normalizeTier(tier);
      if (!normalizedTier) {
        return res.status(400).json({ error: "Invalid tier. Use 'basic' or 'premium'." });
      }

      const updateData = {
        subscriptionId: subscriptionId || 'manual',
        subscriptionExpires: admin.firestore.Timestamp.fromDate(date),
        subscriptionActive: true,
        paymentMethod: subscriptionId ? "stripe" : "manual",
        tier: normalizedTier,
      };

      if (memberDoc.exists) {
        const docData = memberDoc.data();
        const existingExpires = docData.subscriptionExpires?.toDate ? docData.subscriptionExpires.toDate() : new Date(docData.subscriptionExpires);
        if (date > existingExpires) {
          updateData.subscriptionExpires = admin.firestore.Timestamp.fromDate(date);
        } else {
          updateData.subscriptionExpires = docData.subscriptionExpires;
        }
        await memberRef.update(updateData);
      } else {
        await memberRef.set(updateData);
      }

      res.status(200).json({ 
        success: true, 
        message: `Subscription activated for ${uid}`,
        subscriptionExpires: date.toISOString(),
        tier: normalizedTier
      });
    } catch (error) {
      console.error('Error activating subscription:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Admin-only: create (or fetch) a Firebase Auth user by email and grant access for N days.
// Secure: requires a valid Firebase ID token in Authorization: Bearer <token>.
exports.adminCreateUserAndGrantAccess = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    try {
      const authHeader = req.get("authorization") || req.get("Authorization") || "";
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        return res.status(401).json({ error: "Missing Authorization: Bearer <token>" });
      }

      const decoded = await admin.auth().verifyIdToken(match[1]);
      const callerUid = decoded.uid;

      // Admin check: allowlist OR users/{uid}.OK
      const ADMIN_UID_ALLOWLIST = [
        "LGoDI1jEsidKRyN5aVvcTFA8Svb2",
        "8vNtPo121PZmzbfivs7xInxu2a62",
      ];
      let callerIsAdmin = ADMIN_UID_ALLOWLIST.includes(callerUid);
      if (!callerIsAdmin) {
        const userDoc = await admin.firestore().collection("users").doc(callerUid).get();
        callerIsAdmin = userDoc.exists && userDoc.data() && userDoc.data().OK === true;
      }
      if (!callerIsAdmin) {
        return res.status(403).json({ error: "Forbidden: admin only" });
      }

      const { email, tier = "basic", days = 365 } = req.body || {};
      const emailStr = typeof email === "string" ? email.trim() : "";
      if (!emailStr) {
        return res.status(400).json({ error: "Missing email" });
      }

      const daysNum = Math.max(1, Math.min(3650, Number(days) || 365)); // cap at 10y
      const tierName = normalizeTier(tier);
      if (!tierName) {
        return res.status(400).json({ error: "Invalid tier. Use 'basic' or 'premium'." });
      }

      // Create or fetch the Auth user
      let userRecord;
      try {
        userRecord = await admin.auth().getUserByEmail(emailStr);
      } catch (e) {
        if (e && e.code === "auth/user-not-found") {
          userRecord = await admin.auth().createUser({ email: emailStr });
        } else {
          throw e;
        }
      }

      // Generate a password reset link so you can send it to them.
      const passwordResetLink = await admin.auth().generatePasswordResetLink(emailStr, {
        url: `${GLOBAL_URL}/login`,
      });

      // Grant access in members/{uid}
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + daysNum);

      await admin.firestore().collection("members").doc(userRecord.uid).set(
        {
          subscriptionId: `admin_grant_${Date.now()}`,
          subscriptionExpires: admin.firestore.Timestamp.fromDate(expiresAt),
          subscriptionActive: true,
          paymentMethod: "admin",
          tier: tierName,
          adminGrantedAt: admin.firestore.FieldValue.serverTimestamp(),
          adminGrantedBy: callerUid,
          adminGrantedDays: daysNum,
        },
        { merge: true }
      );

      return res.status(200).json({
        success: true,
        uid: userRecord.uid,
        email: emailStr,
        tier: tierName,
        subscriptionExpires: expiresAt.toISOString(),
        passwordResetLink,
      });
    } catch (error) {
      console.error("adminCreateUserAndGrantAccess error:", error);
      return res.status(500).json({ error: error.message || String(error) });
    }
  });
});

// Admin-only: return list of subscriber emails (members with active subscription).
exports.adminGetSubscriberEmails = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, async () => {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }
    try {
      const authHeader = req.get("authorization") || req.get("Authorization") || "";
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        return res.status(401).json({ error: "Missing Authorization: Bearer <token>" });
      }
      const decoded = await admin.auth().verifyIdToken(match[1]);
      const callerUid = decoded.uid;
      const ADMIN_UID_ALLOWLIST = [
        "LGoDI1jEsidKRyN5aVvcTFA8Svb2",
        "8vNtPo121PZmzbfivs7xInxu2a62",
      ];
      let callerIsAdmin = ADMIN_UID_ALLOWLIST.includes(callerUid);
      if (!callerIsAdmin) {
        const userDoc = await admin.firestore().collection("users").doc(callerUid).get();
        callerIsAdmin = userDoc.exists && userDoc.data() && userDoc.data().OK === true;
      }
      if (!callerIsAdmin) {
        return res.status(403).json({ error: "Forbidden: admin only" });
      }

      const membersSnap = await admin.firestore().collection("members").get();
      const now = Date.now();
      const emails = [];
      for (const doc of membersSnap.docs) {
        const data = doc.data();
        const uid = doc.id;
        const exp = data.subscriptionExpires;
        const expiresAt = exp
          ? (typeof exp.toMillis === "function"
            ? exp.toMillis()
            : (typeof exp.toDate === "function"
              ? exp.toDate().getTime()
              : new Date(exp).getTime()))
          : 0;
        const hasValidExpiry = expiresAt > now;
        const explicitlyActive = data && data.subscriptionActive === true;
        const hasFutureExpiry = data && exp != null && hasValidExpiry;
        const isActive = !!(explicitlyActive && hasValidExpiry) || !!hasFutureExpiry;
        if (!isActive) continue;
        const paymentMethod = (data.paymentMethod || "").toLowerCase();
        if (paymentMethod !== "stripe" && paymentMethod !== "paypal") continue;
        try {
          const userRecord = await admin.auth().getUser(uid);
          if (userRecord && userRecord.email) emails.push(userRecord.email);
        } catch (_) {}
      }
      return res.status(200).json({ emails, count: emails.length });
    } catch (err) {
      console.error("adminGetSubscriberEmails error:", err);
      return res.status(500).json({ error: err.message || String(err) });
    }
  });
});

function isPayingSubscriber(data, now) {
  const exp = data.subscriptionExpires;
  const expiresAt = exp
    ? (typeof exp.toMillis === "function"
      ? exp.toMillis()
      : (typeof exp.toDate === "function"
        ? exp.toDate().getTime()
        : new Date(exp).getTime()))
    : 0;
  const hasValidExpiry = expiresAt > now;
  const explicitlyActive = data && data.subscriptionActive === true;
  const hasFutureExpiry = data && exp != null && hasValidExpiry;
  const isActive = !!(explicitlyActive && hasValidExpiry) || !!hasFutureExpiry;
  if (!isActive) return false;
  const paymentMethod = (data.paymentMethod || "").toLowerCase();
  return paymentMethod === "stripe" || paymentMethod === "paypal";
}

// Admin-only: return emails of users who signed up since a date and are NOT paying subscribers.
exports.adminGetNonSubscriberEmailsSinceDate = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, async () => {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }
    try {
      const authHeader = req.get("authorization") || req.get("Authorization") || "";
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        return res.status(401).json({ error: "Missing Authorization: Bearer <token>" });
      }
      const decoded = await admin.auth().verifyIdToken(match[1]);
      const callerUid = decoded.uid;
      const ADMIN_UID_ALLOWLIST = [
        "LGoDI1jEsidKRyN5aVvcTFA8Svb2",
        "8vNtPo121PZmzbfivs7xInxu2a62",
      ];
      let callerIsAdmin = ADMIN_UID_ALLOWLIST.includes(callerUid);
      if (!callerIsAdmin) {
        const userDoc = await admin.firestore().collection("users").doc(callerUid).get();
        callerIsAdmin = userDoc.exists && userDoc.data() && userDoc.data().OK === true;
      }
      if (!callerIsAdmin) {
        return res.status(403).json({ error: "Forbidden: admin only" });
      }

      const sinceParam = (req.query && req.query.since) || "2025-01-01";
      const sinceDate = new Date(sinceParam);
      if (isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: "Invalid since date (use YYYY-MM-DD)" });
      }
      const sinceMs = sinceDate.getTime();
      const now = Date.now();

      const payingSubscriberUids = new Set();
      const membersSnap = await admin.firestore().collection("members").get();
      for (const doc of membersSnap.docs) {
        if (isPayingSubscriber(doc.data(), now)) payingSubscriberUids.add(doc.id);
      }

      const emails = [];
      let nextPageToken;
      do {
        const result = await admin.auth().listUsers(1000, nextPageToken);
        for (const u of result.users) {
          const created = u.metadata && u.metadata.creationTime ? new Date(u.metadata.creationTime).getTime() : 0;
          if (created < sinceMs) continue;
          if (payingSubscriberUids.has(u.uid)) continue;
          if (u.email) emails.push(u.email);
        }
        nextPageToken = result.pageToken;
      } while (nextPageToken);

      return res.status(200).json({ emails, count: emails.length });
    } catch (err) {
      console.error("adminGetNonSubscriberEmailsSinceDate error:", err);
      return res.status(500).json({ error: err.message || String(err) });
    }
  });
});

const addMonthToSubscriptionStripe = (req, res, uid, days, message) => {
  const ref = admin.firestore().collection("members").doc(uid);
  // ##** CHANGED THIS FROM days to 30 + days on initial processing of transaction:
  const _monthPlusFree = 30 + days;
  console.log("Adding " + days + " to " + uid + "'s subscription");
  const date = new Date();
  date.setDate(date.getDate() + _monthPlusFree + 0.65);

  // doing it in a batched transaction:
  // const transactionRef = admin.firestore().collection('members').doc(uid);
  return admin.firestore().runTransaction(transaction => {
    return transaction
      .get(ref)
      .then(docSnapshot => {
        if (docSnapshot.exists) {
          const docData = docSnapshot.data();
          // if (docData.subscriptionExpires > date) {
          //     date.setDate(docData.subscriptionExpires.getDate() + days + 0.65);
          // }
          const subscriptionExpires =
            date > docData.subscriptionExpires
              ? date
              : docData.subscriptionExpires;

          return transaction.update(ref, {
            subscriptionExpires,
            paymentMethod: "stripe",
            subscriptionId: message.id,
            subscriptionActive: true,
            trialUsed: true,
          });
        } else {
          return transaction.set(ref, {
            subscriptionExpires: date,
            paymentMethod: "stripe",
            subscriptionId: message.id,
            subscriptionActive: true,
            trialUsed: true,
          });
        }
      })
      .then(innerRes => {
        console.log(
          "COMPLETED ADDING " + days + " TO SUB FOR USER WITH UID: " + uid
        );
        return res.status(200).send(message);
        // res.status(200).end();
        // return;
      })
      .catch(err => {
        console.log(err);
        // return;
        return res.status(500).end(); // .send("");
      });
  });

  // doing it in a single write:

  // ref.set({
  //     'subscriptionExpires': date,
  //     'paymentMethod': 'stripe',
  //     'subscriptionId': message.id,
  // }, {merge: true})
  //     .then(innerRes => {
  //         console.log("COMPLETED ADDING MONTH TO SUB FOR USER WITH UID:" + uid);
  //         return res.status(200).send(message);
  //         // res.status(200).end();
  //         // return;
  //     })
  //     .catch(err => {
  //         console.log(err);
  //         // return;
  //         return res.status(500).end(); //.send("");
  //     });
};

const addMonthToSubscriptionStripeWebhook = (req, res, uid, daysOrSendOk = 30, maybeSendOk = null) => {
  const days = typeof daysOrSendOk === "number" ? daysOrSendOk : 30;
  const sendOk = typeof daysOrSendOk === "function" ? daysOrSendOk : (typeof maybeSendOk === "function" ? maybeSendOk : () => res.status(200).send("OK"));
  const ref = admin.firestore().collection("members").doc(uid);
  const date = new Date();
  date.setDate(date.getDate() + days + 0.65);

  return admin.firestore().runTransaction(transaction => {
    return transaction
      .get(ref)
      .then(docSnapshot => {
        if (docSnapshot.exists) {
          const docData = docSnapshot.data();
          const subscriptionExpires =
            date > docData.subscriptionExpires
              ? date
              : docData.subscriptionExpires;

          return transaction.update(ref, {
            subscriptionExpires,
            subscriptionActive: true,
            paymentMethod: "stripe",
          });
        } else {
          return transaction.set(ref, {
            subscriptionExpires: date,
            paymentMethod: "stripe",
            subscriptionActive: true,
          });
        }
      })
      .then(() => {
        console.log("COMPLETED ADDING MONTH TO SUB FOR USER WITH UID:", uid);
        return sendOk();
      })
      .catch(err => {
        console.error("addMonthToSubscriptionStripeWebhook error:", err);
        return res.status(500).send(err.message || "Transaction failed");
      });
  });

  // ref.set({
  //     'subscriptionExpires': date,
  // }, {merge: true})
  //     .then(innerRes => {
  //         console.log("COMPLETED ADDING MONTH TO SUB FOR USER WITH UID:" + uid);
  //         return res.send(200);
  //         // return res.status(200).end();
  //         // res.status(200).end();
  //         // return;
  //     })
  //     .catch(err => {
  //         console.log(err);
  //         return res.send(500);
  //         // return;
  //         // return res.status(500).end(); //.send("");
  //     });
};

// --- Promo helpers: keep validation/checkout/IPN behaviour aligned ---
// "blue" is the public promo code. The legacy string "harbourview" is no longer accepted (use "blue").
function isBluePromoCode(tokenNoSpaces) {
  return tokenNoSpaces === "blue";
}
function isGoldyPromoCode(tokenNoSpaces) {
  return tokenNoSpaces === "goldy";
}
/** Firestore doc ids to try (casing variants + blue → legacy harbourview document id in Firestore). */
function promoTokenFirestoreDocIds(tokenTrim, tokenLower, tokenNoSpaces, tokenUpper) {
  if (tokenNoSpaces === "harbourview") {
    return [];
  }
  const ids = new Set([tokenTrim, tokenLower, tokenNoSpaces, tokenUpper].filter(Boolean));
  if (isBluePromoCode(tokenNoSpaces)) {
    ["harbourview", "HARBOURVIEW", "Harbourview", "HarbourView"].forEach((id) => ids.add(id));
  }
  return Array.from(ids);
}
/**
 * Whitelist only JSON-safe fields the web app expects. Prevents 500s if a token doc
 * contains Firestore Timestamps, nested maps, or other non-JSON values.
 */
function buildSafeTokenResponseForClient(merged) {
  const src = merged && typeof merged === "object" ? merged : {};
  const out = {};
  if (src.daysFree !== undefined && src.daysFree !== null && src.daysFree !== "") {
    const d = Number(src.daysFree);
    if (Number.isFinite(d)) out.daysFree = d;
  }
  if (src.monthlyPrice !== undefined && src.monthlyPrice !== null && src.monthlyPrice !== "") {
    const mp = Number(src.monthlyPrice);
    if (Number.isFinite(mp)) out.monthlyPrice = mp;
  }
  if (src.reusable !== undefined) out.reusable = Boolean(src.reusable);
  if (typeof src.tier === "string" && src.tier.length) out.tier = src.tier;
  if (typeof src.stripePriceId === "string" && src.stripePriceId.length) out.stripePriceId = src.stripePriceId;
  if (typeof src.percentOffFirstMonth === "string") out.percentOffFirstMonth = src.percentOffFirstMonth;
  if (typeof src.paypalButtonUrl === "string") out.paypalButtonUrl = src.paypalButtonUrl;
  if (src.fallback === true) out.fallback = true;
  if (typeof src.canonicalTokenId === "string" && src.canonicalTokenId.length) out.canonicalTokenId = src.canonicalTokenId;
  return out;
}

/**
 * Never read req.body.token directly — req.body is often undefined until parsed.
 * jQuery $.post sends application/x-www-form-urlencoded (token=blue), not JSON — JSON.parse on rawBody fails unless we parse as querystring.
 */
function extractPromoTokenFromHttpRequest(req) {
  let body = req.body;
  if ((body === undefined || body === null) && req.rawBody) {
    try {
      const raw =
        typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8");
      try {
        body = JSON.parse(raw);
      } catch (e) {
        body = querystring.parse(raw);
      }
    } catch (e) {
      body = null;
    }
  }
  if (body === undefined || body === null) body = {};
  const fromBody = body.token != null ? String(body.token) : "";
  const fromQuery = req.query && req.query.token != null ? String(req.query.token) : "";
  return (fromBody || fromQuery).trim();
}

exports.validateUserToken = functions.https.onRequest((req, res) => {
  const corsFn = cors({ origin: true });
  corsFn(req, res, () => {
    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }
    const token = extractPromoTokenFromHttpRequest(req);
    const p = validateCouponToken(token, res);
    if (p && typeof p.catch === "function") {
      return p.catch((e) => {
        console.error("validateUserToken unhandled:", e);
        if (!res.headersSent) {
          res.status(500).json({ error: "server_error", message: String(e && e.message ? e.message : e) });
        }
      });
    }
    return p;
  });
});

const validateCouponToken = (token, res) => {
  const tokenTrim = String(token || "").trim();
  const tokenLower = tokenTrim.toLowerCase();
  const tokenNoSpaces = tokenLower.replace(/\s+/g, "");
  const tokenUpper = tokenTrim.toUpperCase();
  if (tokenNoSpaces === "harbourview") {
    return res.status(404).json({ error: "not_found" });
  }
  const candidateIds = promoTokenFirestoreDocIds(tokenTrim, tokenLower, tokenNoSpaces, tokenUpper);

  const tokensCol = admin.firestore().collection("userTokens");

  const sendTokenSuccess = (payload) => {
    const safe = buildSafeTokenResponseForClient(payload);
    // Never ship harbourview/blue/goldy without a positive daysFree (whitelist can drop bad Firestore types).
    if (isBluePromoCode(tokenNoSpaces) || isGoldyPromoCode(tokenNoSpaces)) {
      const d = Number(safe.daysFree);
      if (!Number.isFinite(d) || d < 1) {
        safe.daysFree = 30;
        safe.reusable = true;
        safe.fallback = true;
      }
      if (!safe.canonicalTokenId) {
        safe.canonicalTokenId = isGoldyPromoCode(tokenNoSpaces) ? "goldy" : "blue";
      }
    }
    return res.status(200).json(safe);
  };

  return (async () => {
    try {
      let foundDoc = null;
      let foundId = null;
      for (const id of candidateIds) {
        const snap = await tokensCol.doc(id).get();
        if (snap.exists) {
          foundDoc = snap;
          foundId = id;
          break;
        }
      }

      if (!foundDoc) {
        // Safety-net promos: always validate as 30 days free (harbourview / blue / goldy).
        if (isBluePromoCode(tokenNoSpaces) || isGoldyPromoCode(tokenNoSpaces)) {
          return sendTokenSuccess({
            daysFree: 30,
            reusable: true,
            fallback: true,
            canonicalTokenId: isGoldyPromoCode(tokenNoSpaces) ? "goldy" : "blue",
          });
        }
        return res.status(404).json({ error: "not_found" });
      }

      const responseObj = { ...(foundDoc.data() || {}) };
      const percentOffFirstMonth = responseObj.percentOffFirstMonth;

      responseObj.canonicalTokenId = foundId;

      // Safety-net promos: always at least 30 days free if doc is misconfigured.
      if (isBluePromoCode(tokenNoSpaces) || isGoldyPromoCode(tokenNoSpaces)) {
        const daysFreeNum = Number(responseObj.daysFree || 0);
        if (!daysFreeNum) {
          responseObj.daysFree = 30;
          responseObj.fallback = true;
          responseObj.reusable = true;
        }
      }

      // Harbourview family: valid for either tier (do not restrict tier).
      if (isBluePromoCode(tokenNoSpaces)) {
        delete responseObj.tier;
      }

      if (percentOffFirstMonth === "50%") {
        responseObj["paypalButtonUrl"] = PAYPAL_BUTTON_ADDRESS_50off;
      } else if (percentOffFirstMonth === "25%") {
        responseObj["paypalButtonUrl"] = PAYPAL_BUTTON_ADDRESS_25off;
      }

      return sendTokenSuccess(responseObj);
    } catch (err) {
      console.error("validateUserToken error:", err);
      // Last-resort: never brick harbourview/blue/goldy if serialization or Firestore hiccups.
      const t = String(token || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
      if (isBluePromoCode(t) || isGoldyPromoCode(t)) {
        console.warn("validateUserToken: error path harbourview-family fallback for token:", t);
        return sendTokenSuccess({
          daysFree: 30,
          reusable: true,
          fallback: true,
          canonicalTokenId: isGoldyPromoCode(t) ? "goldy" : "blue",
        });
      }
      return res.status(500).json({ error: "server_error", message: String(err && err.message ? err.message : err) });
    }
  })();
};

exports.generateUserTokens = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    return genUserTokens(req, res);
  });
});

const genUserTokens = (req, res) => {
  const body = req.body;
  console.log(req.body);
  const uid = body.uid;
  console.log("UID is trying to gen user tokens: ", uid);
  const OK = ["LGoDI1jEsidKRyN5aVvcTFA8Svb2", "8vNtPo121PZmzbfivs7xInxu2a62"];
  if (!OK.includes(uid)) {
    console.log("REJECTED");
    return res.send(400, "YOU DO NOT HAVE PERMISSION TO PERFORM THIS ACTION");
  }
  console.log("YOU ARE VERIFIED TO CREATE TOKENS");

  const batchWriter = admin.firestore().batch();
  // const tokensRef = admin.firestore().collection('userTokens');
  const howManyTokens = Number(body.howManyTokens);
  const daysFree = Number(body.daysFree);
  const referrer = body.referrer;
  const percentOffFirstMonth = body.percentOffFirstMonth;
  console.log("the batchWriter: ");
  console.log(batchWriter);

  // randomString.generate({
  //     length: 9,
  //     charset: 'alphanumeric'
  // })

  // generate(options)
  //      length - the length of the random string. (default: 32) [OPTIONAL]
  //      readable - exclude poorly readable chars: 0OIl. (default: false) [OPTIONAL]
  //      charset - define the character set for the string. (default: 'alphanumeric') [OPTIONAL]
  //           alphanumeric - [0-9 a-z A-Z]
  //           alphabetic - [a-z A-Z]
  //           numeric - [0-9]
  //           hex - [0-9 a-f]
  //           custom - any given characters
  // capitalization - define whether the output should be lowercase / uppercase only. (default: null) [OPTIONAL]
  //       lowercase
  //       uppercase

  const tokenStrings = [];
  for (let i = 0; i < howManyTokens; i++) {
    const tokenString = randomString.generate({
      length: 5,
      charset: "alphabetic",
      capitalization: "uppercase",
    });
    tokenStrings.push(tokenString);
    console.log("Creating a token for: ", tokenString);
    const thisTokenRef = admin
      .firestore()
      .collection("userTokens")
      .doc(tokenString);
    batchWriter.set(thisTokenRef, {
      daysFree: daysFree,
      referrer: referrer,
      percentOffFirstMonth: percentOffFirstMonth,
    });
  }

  return batchWriter
    .commit()
    .then(data => {
      console.log(data);
      console.log(tokenStrings);
      return res.json(tokenStrings);
    })
    .catch(err => {
      console.log(err);
      return res.send(err);
    });
};

exports.updateDailyFree = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    return updateDailyFreeX(req, res);
  });
});
const updateDailyFreeX = (req, res) => {
  console.log("CALLED updateDailyFree");
  console.log(req.body);
  if (req.body.key === "xoxo") {
    return updateDailies(res);
  } else {
    return res.send(500);
  }
};

exports.scheduledFunctionCrontab = functions.pubsub
  .schedule("5 11 * * *")
  .timeZone("America/New_York") // Users can choose timezone - default is UTC
  .onRun(context => {
    console.log("--- Daily UPDATE for quiz and articles ---");
    updateDailies(context);
  });

// Daily sync of Stripe subscriptions to Firestore (catches webhook/success-page misses)
exports.scheduledSyncStripeSubscriptions = functions.pubsub
  .schedule("0 7 * * *")
  .timeZone("America/New_York")
  .onRun(async () => {
    console.log("--- Daily Stripe subscription sync ---");
    try {
      await runScheduledStripeSync();
    } catch (err) {
      console.error("Scheduled Stripe sync failed:", err);
    }
  });

const updateDailies = res => {
  const quizzesRef = admin.firestore().collection("quizzes");
  const quizBodyRef = admin.firestore().collection("quiz");

  const articlesRef = admin.firestore().collection("articles");
  const articlesBodyRef = admin.firestore().collection("article");

  const freeDailyArticleRef = admin
    .firestore()
    .collection("freeDaily")
    .doc("article");
  const freeDailyQuizRef = admin
    .firestore()
    .collection("freeDaily")
    .doc("quiz");

  updateDaily(
    articlesRef,
    articlesBodyRef,
    freeDailyArticleRef,
    doUpdateTransactionArticle,
    "article"
  );
  updateDaily(
    quizzesRef,
    quizBodyRef,
    freeDailyQuizRef,
    doUpdateTransactionQuiz,
    "quiz"
  );
  // articlesRef.get()
  //     .then(docs => {
  //         // console.log(docs.docs);
  //         // console.log(docs.docs.length);
  //         // Math.floor(Math.random()*80) + 1;   --> range from 1-80.
  //         const idx = Math.floor(Math.random()*docs.docs.length);
  //         const id = docs.docs[idx];
  //         const metadata = docs.docs[idx].data();
  //         metadata.id = id;
  //         const bodyId = metadata.body;
  //         console.log("THE RANDOMLY CHOSEN ARTICLE IS: ");
  //         console.log(metadata);
  //         return doUpdateTransactionArticle(metadata, bodyId, articlesBodyRef, freeDailyArticleRef, 'article')
  //     })
  //     .catch(err => console.log(err));
  //
  // quizzesRef.get()
  //     .then(docs => {
  //         // console.log(docs.docs);
  //         // console.log(docs.docs.length);
  //         // Math.floor(Math.random()*80) + 1;   --> range from 1-80.
  //         const idx = Math.floor(Math.random()*docs.docs.length);
  //         const id = docs.docs[idx];
  //         const metadata = docs.docs[idx].data();
  //         metadata.id = id;
  //         const bodyId = metadata.body;
  //         console.log("THE RANDOMLY CHOSEN QUIZ IS: ");
  //         console.log(metadata);
  //         return doUpdateTransactionQuiz(metadata, bodyId, quizBodyRef, freeDailyQuizRef, 'quiz')
  //     })
  //    .catch(err => console.log(err));
};

updateDaily = (ref, bodyRef, freeDailyRef, doUpdateFunction, type) => {
  return ref
    .get()
    .then(docs => {
      // console.log(docs.docs);
      // console.log(docs.docs.length);
      // Math.floor(Math.random()*80) + 1;   --> range from 1-80.
      const idx = Math.floor(Math.random() * docs.docs.length);
      const id = docs.docs[idx];
      const metadata = docs.docs[idx].data();
      metadata.id = id;
      const bodyId = metadata.body;
      console.log("THE RANDOMLY CHOSEN " + type + " IS: ");
      console.log(metadata);
      return doUpdateFunction(metadata, bodyId, bodyRef, freeDailyRef, type);
    })
    .catch(err => console.log(err));
};

// const doUpdateTransaction = (metadata, bodyToFetch, fetchRef, dailyToUpdate, type) => {
//     admin.firestore().runTransaction(transaction => {
//         transaction.get(bodyToFetch).then(docSnapshot => {
//             const docData = docSnapshot.data();
//             switch(type) {
//                 case 'article':
//                     metadata.text = docData.body.text;
//                     return transaction.set(dailyToUpdate, metadata)
//                         // .then(res => res)
//                         // .catch(err => console.log(err));
//                     // return transaction.set(dailyToUpdate, {
//                     //     ...metadata,
//                     //     text: docData.body.text,
//                     // });
//                 case 'quiz':
//                     metadata.answers = docData.answers;
//                     metadata.answer = docData.answer;
//                     metadata.question = docData.question;
//                     return transaction.set(dailyToUpdate, metadata)
//                         // .then(res => res)
//                         // .catch(err => console.log(err));
//                     // return transaction.set(dailyToUpdate, {
//                     //     ...metadata,
//                     //     ...docData,
//                     // });
//             }
//
//         })
//             .then(res => {
//                 console.log("COMPLETED UPDATING DAILY TO: ", metadata.id);
//                 return res.send(200);
//                 // res.status(200).end();
//                 // return;
//             })
//             .catch(err => {
//                 console.log(err);
//                 // return;
//                 return res.status(500).end(); //.send("");
//             });
//     });
// }

const extractRelevantArticleMetadata = metadata => {
  const articleData = {
    difficulty: metadata.difficulty,
    createdAt: metadata.createdAt,
    teaser_board: metadata.teaser_board,
    title: metadata.title,
    body: metadata.body,
    category: metadata.category,
    teaser: metadata.teaser,
    updatedAt: metadata.updatedAt,
    text: metadata.text,
  };

  return articleData;
};

const doUpdateTransactionArticle = (
  metadata,
  bodyToFetch,
  fetchRef,
  dailyToUpdate,
  type
) => {
  console.log("fetching " + type + " with id: " + bodyToFetch);
  return admin.firestore().runTransaction(transaction => {
    return transaction
      .get(fetchRef.doc(bodyToFetch))
      .then(docSnapshot => {
        const docData = docSnapshot.data();
        console.log("Fetched data: ", docData);
        const newArticle = extractRelevantArticleMetadata(metadata);
        newArticle.text = docData.body.text;
        // metadata.text = docData.body.text;
        console.log("Setting free daily article to: ");
        console.log(newArticle);
        return transaction.set(dailyToUpdate, newArticle);
        // .then(res => res)
        // .catch(err => console.log(err));
        // return transaction.set(dailyToUpdate, {
        //     ...metadata,
        //     text: docData.body.text,
        // });
        // .then(res => res)
        // .catch(err => console.log(err));
        // return transaction.set(dailyToUpdate, {
        //     ...metadata,
        //     ...docData,
        // });
      })
      .then(result => {
        console.log("COMPLETED UPDATING DAILY TO: ", metadata.id);
        // return res.send(200);
        // res.status(200).end();
        // return;
      })
      .catch(err => {
        console.log(err);
        // return;
        // return res.status(500).end(); // .send("");
      });
  });
};

const extractRelevantQuizMetadata = metadata => {
  const quizData = {
    difficulty: metadata.difficulty,
    createdAt: metadata.createdAt,
    quizType: metadata.quizType,
    teaser_board: metadata.teaser_board,
    title: metadata.title,
    body: metadata.body,
    // category: metadata.category,
    teaser: metadata.teaser,
    updatedAt: metadata.updatedAt,
    answers: metadata.answers,
    answer: metadata.answer,
    question: metadata.question,
  };

  return quizData;
};

const doUpdateTransactionQuiz = (
  metadata,
  bodyToFetch,
  fetchRef,
  dailyToUpdate,
  type
) => {
  console.log("fetching " + type + " with id: " + bodyToFetch);
  return admin.firestore().runTransaction(transaction => {
    return transaction
      .get(fetchRef.doc(bodyToFetch))
      .then(docSnapshot => {
        const docData = docSnapshot.data();
        console.log("Fetched data: ", docData);
        const newQuiz = extractRelevantQuizMetadata(metadata);
        newQuiz.answers = docData.answers;
        newQuiz.answer = docData.answer;
        newQuiz.question = docData.question;
        console.log("Setting free daily quiz to: ");
        console.log(metadata);
        return transaction.set(dailyToUpdate, newQuiz);
        // .then(res => res)
        // .catch(err => console.log(err));
        // return transaction.set(dailyToUpdate, {
        //     ...metadata,
        //     ...docData,
        // });
      })
      .then(result => {
        console.log("COMPLETED UPDATING DAILY TO: ", metadata.id);
        // return res.send(200);
        // res.status(200).end();
        // return;
      })
      .catch(err => {
        console.log(err);
        // return;
        // return res.status(500).end(); // .send("");
      });
  });
};

// Generate PayPal button for bridgechampions.com/membership:
exports.getPayPalButton = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    getPayPalButtonFn(req, res);
  });
});
const getPayPalButtonFn = (req, res) => {
  const uid = req.body.uid;
  return checkIfTrialUsed(uid)
    .then(answer => {
      if (answer) {
        return res.send(200, { url: PAYPAL_BUTTON_ADDRESS_REGULAR_NOTRIAL });
      } else {
        return res.send(200, { url: PAYPAL_BUTTON_ADDRESS_REGULAR });
      }
    })
    .catch(err => {
      console.log(err);
      return res.send(200, { url: PAYPAL_BUTTON_ADDRESS_REGULAR_NOTRIAL });
    });
};

// Cancel PayPal subscription
exports.paypalCancelSubscription = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => paypalCancelSubscriptionHandler(req, res));
});

const paypalCancelSubscriptionHandler = async (req, res) => {
  const uid = req.body && (req.body.uid != null) ? req.body.uid : null;

  if (!uid) {
    return res.status(400).json({ error: 'Missing uid' });
  }

  try {
    console.log(`Attempting to cancel PayPal subscription for user: ${uid}`);
    
    const userDoc = await admin.firestore().collection('members').doc(uid).get();
    
    if (!userDoc.exists) {
      console.log('User not found');
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    const subscriptionId = userData.paypalSubscriptionId || userData.subscriptionId;
    
    if (!subscriptionId) {
      console.log('No PayPal subscription ID found for user');
      return res.status(400).json({ error: 'No PayPal subscription found' });
    }
    
    const accessToken = await getPayPalAccessToken();
    
    const cancelResponse = await fetch(
      `${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionId}/cancel`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reason: 'Customer requested cancellation'
        })
      }
    );
    
    if (cancelResponse.status === 204) {
      console.log(`Successfully cancelled PayPal subscription ${subscriptionId} for user ${uid}`);
      
      await admin.firestore().collection('members').doc(uid).update({
        subscriptionActive: false,
        paypalSubscriptionCancelled: true,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      return res.status(200).json({ 
        success: true, 
        message: 'Subscription cancelled successfully' 
      });
    } else {
      const errorData = await cancelResponse.json();
      console.error('PayPal API error:', errorData);
      return res.status(cancelResponse.status).json({ 
        error: 'Failed to cancel subscription', 
        details: errorData 
      });
    }
    
  } catch (error) {
    console.error('Error cancelling PayPal subscription:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    });
  }
};
