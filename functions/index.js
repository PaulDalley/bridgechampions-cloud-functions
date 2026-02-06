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
const nodemailer = require("nodemailer");

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
const getStripe = () => {
  if (!stripe) {
    // Try environment variables first, then fall back to functions.config()
    let stripeKey = stripeLive ? process.env.STRIPE_KEY_LIVE : process.env.STRIPE_KEY_DEV;
    
    if (!stripeKey) {
      // Fall back to functions.config() (deprecated but still works)
      try {
        stripeKey = stripeLive 
          ? functions.config().stripe_key?.live 
          : functions.config().stripe_key?.dev;
      } catch (e) {
        console.error("Error accessing functions.config():", e);
      }
    }
    
    if (!stripeKey) {
      throw new Error(`Stripe API key not configured. Please set ${stripeLive ? 'STRIPE_KEY_LIVE' : 'STRIPE_KEY_DEV'} environment variable or use functions.config().stripe_key.${stripeLive ? 'live' : 'dev'}`);
    }
    
    stripe = require("stripe")(stripeKey);
    console.log(`Stripe initialized in ${stripeLive ? 'LIVE' : 'DEV'} mode`);
  }
  return stripe;
};

// Stripe webhook secret helpers
// Supports:
// - env: STRIPE_WEBHOOK_SECRET_LIVE / STRIPE_WEBHOOK_SECRET_DEV
// - env (multi): STRIPE_WEBHOOK_SECRETS_LIVE / STRIPE_WEBHOOK_SECRETS_DEV (comma-separated)
// - functions.config(): stripe_webhook_secret.live/dev (fallback)
// No hardcoded fallback: secrets must be configured via env or functions.config().
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

  let fromConfig = undefined;
  try {
    fromConfig = stripeLive
      ? functions.config().stripe_webhook_secret?.live
      : functions.config().stripe_webhook_secret?.dev;
  } catch (e) {
    // ignore
  }

  const secrets = [
    ...fromMulti,
    ...(singleEnv ? [singleEnv.trim()] : []),
    ...(fromConfig ? [String(fromConfig).trim()] : []),
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

// ## CONFIGURATION OF NODEMAILER WITH GMAIL ACCOUNT:
// const gmailEmail = functions.config().gmail.email;
// const gmailPassword = functions.config().gmail.password;

const gmailEmail = process.env.GMAIL_EMAIL;
const gmailPassword = process.env.GMAIL_PASSWORD;

let mailTransport = undefined;

try {
  mailTransport = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: gmailEmail,
      pass: gmailPassword,
    },
  });
} catch (e) {
  mailTransport = false;
}

exports.contactUs = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    contactUs(req, res);
  });
});
const contactUs = (req, res) => {
  const { uid, email, firstName, lastName, text } = req.body;
  const mailOptions = {
    from: `${APP_NAME} <${gmailEmail}>`,
    to: email,
    bcc: gmailEmail,
    subject: `Thank you for contacting us!`,
  };
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

  mailOptions.html = messageBodyHtml;

  if (mailTransport === undefined || mailTransport === false) {
    return res.send(
      "There was a problem sending your message. Please try again later."
    );
  }

  return mailTransport.sendMail(mailOptions).then(() => {
    // console.log('Contact Us email sent successfully for: ', email);
    return res.send("Thanks! Your message was received.");
  });
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
  const mailOptions = {
    from: `${APP_NAME} <team@bridgechampions.com>`,
    to: email,
    subject: `Welcome to ${APP_NAME}!`,
  };

  // logo-white-bigger: https://firebasestorage.googleapis.com/v0/b/bridgechampions.appspot.com/o/logo-white-smaller.png?alt=media&token=335dce2a-bb25-49ef-bcd6-87ba38212bb6
  const messageBodyHtml = `
          <h2><strong>Hey ${displayName || ""}!<br/></strong></h2>
          <h3><strong>Welcome to ${APP_NAME} - Winning Bridge made simple.</strong></h3>         
          <p><strong>From the team at BridgeChampions.com and our player contributors, we hope you will enjoy your membership and all of the content we intend to provide you.</strong></p>
          <p>It is a busy time for us as a new site and we hope you will join us for the journey as we introduce new features to meet our goals of providing one of the best online Bridge learning resources around.</p>
          <p>Your feedback and thoughts are very welcome, feel free to Contact us using the contact form.</p>
          <p>Thanks and welcome to our new community.</p>
          <div><img src="https://firebasestorage.googleapis.com/v0/b/bridgechampions.appspot.com/o/logo-white-smaller.png?alt=media&token=335dce2a-bb25-49ef-bcd6-87ba38212bb6"/></div>
    `;

  mailOptions.html = messageBodyHtml;

  if (mailTransport === undefined || mailTransport === false) {
    return;
  }

  return mailTransport.sendMail(mailOptions).then(() => {
    return console.log("New welcome email sent to:", email);
  });
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
  console.log("PROCESSING THE PAYMENT NOW:");
  executePaymentAgreement(token, uid, req, res);

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
  const uid = ipnTransactionMessage.custom;
  const token = ipnTransactionMessage.invoice;
  console.log("FOR UID: ", uid);
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

        const eventType = ipnTransactionMessage.txn_type;
        console.log("EVENT TYPE IS: " + eventType);
        // console.log("EVENT IS A subscr_signup?: " + (eventType==="subscr_signup"));
        // console.log("EVENT IS A subscr_payment: " + (eventType==="subscr_payment"));

        // ensure that if the payment was 0 and there was a token,
        // we delete the token so it cant be reused:
        // - payment_gross, token, mc_gross
        // if (token && (payment_gross === 0 || mc_gross === 0)) {
        //     paypalDeleteUsedToken(token);
        // }

        switch (eventType) {
          case "recurring_payment_profile_cancel":
            return res.status(200).end();

          case "subscr_signup":
            // Check if token is a promo code
            if (token) {
              return admin.firestore().collection("userTokens").doc(token).get()
                .then(promoDoc => {
                  let extraDays = 0;
                  
                  if (promoDoc.exists) {
                    const promoData = promoDoc.data();
                    extraDays = promoData.daysFree || 0;
                    
                    // Delete the promo code so it can't be reused
                    admin.firestore().collection("userTokens").doc(token).delete();
                    
                    console.log(`Promo code ${token} applied: ${extraDays} free days`);
                  }
                  
                  // Check if they've used trial before
                  return checkIfTrialUsed(uid).then(trialUsed => {
                    const baseDays = 30;
                    const trialDays = trialUsed ? 0 : 7;
                    const totalDays = baseDays + trialDays + extraDays;
                    
                    console.log(`Total days for subscription: ${totalDays} (base: ${baseDays}, trial: ${trialDays}, promo: ${extraDays})`);
                    return addMonthToSubscriptionIPN(req, res, uid, totalDays, ipnTransactionMessage);
                  });
                })
                .catch(err => {
                  console.log("Error processing promo code:", err);
                  return checkIfTrialUsed(uid).then(trialUsed => {
                    return addMonthToSubscriptionIPN(req, res, uid, trialUsed ? 30 : 37, ipnTransactionMessage);
                  });
                });
            } else {
              return checkIfTrialUsed(uid).then(trialUsed => {
                return addMonthToSubscriptionIPN(req, res, uid, trialUsed ? 30 : 37, ipnTransactionMessage);
              });
            }
          // return addMonthToSubscriptionIPN(req, res, uid, 7);

          case "subscr_payment":
            if (payment_gross === 0 && mc_gross === 0) {
              res.status(200).end();
              return;
            }
            return addMonthToSubscriptionIPN(req, res, uid, 30, ipnTransactionMessage);

          case "subscr_cancel":
            return admin
              .firestore()
              .collection("members")
              .doc(uid)
              .update({
                subscriptionActive: false,
              })
              .then(r => {
                console.log("subcriptionActive for " + uid + " set to false");
                return res.status(200).end();
              })
              .catch(err => {
                console.log(err);
                return res.status(400).end();
              });

          default:
            return res.status(200).end();
        }

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
  }
  
  ref
    .set(
      {
        subscriptionExpires: date,
        paymentMethod: "paypal",
        subscriptionActive: true,
        trialUsed: true,
        tier: tier,
      },
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

const TRIAL_PERIOD_DAYS = 0; // 7;

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
              freeDays += Number(tokenData.daysFree);
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
    console.log("Creating checkout session with body:", req.body);
    const { priceId, email, uid, coupon, tierName } = req.body;
    
    if (!priceId || !email || !uid) {
      console.error("Missing required parameters:", { priceId: !!priceId, email: !!email, uid: !!uid });
      return res.status(400).json({ error: 'Missing required parameters: priceId, email, and uid are required' });
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
        tierName: tierName || 'Premium',
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
    if (coupon && coupon !== '') {
      try {
        // Try multiple Firestore doc IDs to handle legacy casing.
        const couponTrim = String(coupon).trim();
        const couponLower = couponTrim.toLowerCase();
        const couponUpper = couponTrim.toUpperCase();
        const isHarbourview = couponLower === "harbourview";
        const isGoldy = couponLower === "goldy";

        const candidateTokenIds = Array.from(new Set([couponTrim, couponLower, couponUpper])).filter(Boolean);
        console.log(`Looking up promo token. entered="${couponTrim}" candidates=${JSON.stringify(candidateTokenIds)}`);

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
        if ((!tokenDoc || !tokenDoc.exists) && (isHarbourview || isGoldy)) {
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
          const effectiveDaysFree = (isHarbourview || isGoldy) ? 30 : tokenData.daysFree;

          if (effectiveDaysFree !== undefined && effectiveDaysFree !== null) {
            const freeDays = Number(effectiveDaysFree) + TRIAL_PERIOD_DAYS;
            console.log(`Promo code daysFree: ${effectiveDaysFree} (override=${isHarbourview || isGoldy}), total trial days: ${freeDays}`);
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
          
          // Only delete the token if it's NOT a test/reusable token
          // Test tokens should have testMode: true or reusable: true in Firestore
          if (!tokenData.testMode && !tokenData.reusable) {
            // Delete the used token (will be done after successful checkout in webhook)
            // For now, we'll let the webhook handle deletion
          }
        }
      } catch (couponError) {
        console.error("Error checking coupon:", couponError);
        // Continue without coupon if check fails
      }
    } else if (TRIAL_PERIOD_DAYS > 0) {
      // Check if trial already used
      try {
        const trialUsed = await checkIfTrialUsed(uid);
        if (!trialUsed) {
          sessionParams.subscription_data.trial_period_days = TRIAL_PERIOD_DAYS;

          const billedOn = new Date();
          billedOn.setDate(billedOn.getDate() + TRIAL_PERIOD_DAYS);
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
      } catch (trialError) {
        console.error("Error checking trial status:", trialError);
        // Continue without trial if check fails
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
  // console.log("INCOMING REQ to cancel sub");
  // console.log(req);
  // console.log(req.body);
  const uid = req.body.uid;
  console.log("CANCELLING SUBSCRIPTION for member with uid: " + uid);

  return admin
    .firestore()
    .collection("members")
    .doc(uid)
    .get()
    .then(snapshot => {
      // ## NOT THIS:
      // console.log(snapshot.docs);
      // snapshot.forEach(doc => console.log(doc.data()));
      // const memberData = snapshot.docs[0].data();

      // ## THIS:
      const memberData = snapshot.data();
      console.log(memberData);
      return cancelMemberSubscription(memberData.subscriptionId, res, uid);
    })
    .catch(err => {
      console.log(err);
      res.status(500).send(err);
      return;
    });
};

const cancelMemberSubscription = (subscriptionId, res, uid) => {
  stripe.subscriptions
    .del(subscriptionId)
    .then(confirmation => {
      admin
        .firestore()
        .collection("members")
        .doc(uid)
        .update({
          subscriptionActive: false,
        })
        .then(r =>
          console.log("subcriptionActive for " + uid + " set to false")
        )
        .catch(err => console.log(err));

      res.status(200).send(confirmation);
      return;
    })
    .catch(err => {
      console.log(err);
      res.status(500).send(err);
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
exports.stripeWebhookHandler = functions.https.onRequest((req, res) => {
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
        return res.send(200);
      }

      console.log("Processing checkout session for uid:", sessionUid);
      console.log("Subscription ID:", sessionSubscriptionId);
      console.log("Tier from session metadata:", session.metadata?.tierName, "=>", sessionTier);

      // Store subscription ID and activate subscription
      return admin
        .firestore()
        .collection("members")
        .doc(sessionUid)
        .get()
        .then(docSnapshot => {
          const days = 30; // Initial subscription period
          const date = new Date();
          date.setDate(date.getDate() + days + 0.65);

          if (docSnapshot.exists) {
            const docData = docSnapshot.data();
            // Handle Firestore Timestamp conversion
            let existingExpires = docData.subscriptionExpires;
            if (existingExpires && existingExpires.toDate) {
              existingExpires = existingExpires.toDate();
            } else if (existingExpires && typeof existingExpires === 'string') {
              existingExpires = new Date(existingExpires);
            } else if (existingExpires && existingExpires.seconds) {
              existingExpires = new Date(existingExpires.seconds * 1000);
            }
            
            const subscriptionExpires =
              date > existingExpires
                ? date
                : existingExpires;

            // Update existing member document
            // Ensure subscriptionExpires is a Firestore Timestamp
            const expiresTimestamp = subscriptionExpires instanceof Date 
              ? admin.firestore.Timestamp.fromDate(subscriptionExpires)
              : subscriptionExpires;
            
            return admin
              .firestore()
              .collection("members")
              .doc(sessionUid)
              .update({
                subscriptionId: sessionSubscriptionId,
                subscriptionExpires: expiresTimestamp,
                subscriptionActive: true,
                paymentMethod: "stripe",
                ...(sessionTier ? { tier: sessionTier } : {}),
              });
          } else {
            // Create new member document
            return admin
              .firestore()
              .collection("members")
              .doc(sessionUid)
              .set({
                subscriptionId: sessionSubscriptionId,
                subscriptionExpires: admin.firestore.Timestamp.fromDate(date),
                paymentMethod: "stripe",
                subscriptionActive: true,
                ...(sessionTier ? { tier: sessionTier } : {}),
              });
          }
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
              .then(() => res.send(200));
          } else {
            return res.send(200);
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
          // Return 500 so Stripe will retry
          return res.status(500).send(`Error: ${err.message}`);
        });

    // case "customer.subscription.deleted":
    case "invoice.created":
      return res.send(200);
    case "invoice.paid":
    case "invoice.payment_succeeded":
      // case "charge.succeeded":
      if (amountPaid === 0) {
        console.log("Nothing was paid, do not add time");
        return res.send(200);
      }

      console.log("invoice payment succeeded for event: ", reconstructedEvent.type);
      console.log("Adding month to subscription: ");
      console.log("Subscription ID:");
      console.log(subscriptionId);

      // TRYING TO GET METADATA FROM THE invoice paid event:
      // uidFromEvent = event.data.object.metadata.uid;
      // console.log("UID DELIVERED FROM EVENT OBJECT: ", uidFromEvent);
      // return addMonthToSubscriptionStripeWebhook(req, res, uidFromEvent);

      return admin
        .firestore()
        .collection("members")
        .where("subscriptionId", "==", subscriptionId)
        .get()
        .then(snapshot => {
          uid = snapshot.docs[0].id;
          console.log(uid);
          return addMonthToSubscriptionStripeWebhook(req, res, uid);
        })
        .catch(err => {
          console.log(err);
          return res.send(500);
        });

    // case "customer.subscription.deleted":

    default:
      console.log("SOME OTHER EVENT OCCURRED: ", reconstructedEvent.type);
      return res.send(200);
  }
});

// Manual activation function for testing/fixing subscriptions
exports.manualActivateSubscription = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    const { uid, subscriptionId, days = 30, tier = 'premium' } = req.body;
    
    if (!uid) {
      return res.status(400).json({ error: 'Missing uid parameter' });
    }

    try {
      const date = new Date();
      date.setDate(date.getDate() + days + 0.65);

      const memberRef = admin.firestore().collection("members").doc(uid);
      const memberDoc = await memberRef.get();

      const updateData = {
        subscriptionId: subscriptionId || 'manual',
        subscriptionExpires: admin.firestore.Timestamp.fromDate(date),
        subscriptionActive: true,
        paymentMethod: subscriptionId ? "stripe" : "manual",
        tier: tier,
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
        tier: tier
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

      const { email, tier = "premium", days = 365 } = req.body || {};
      const emailStr = typeof email === "string" ? email.trim() : "";
      if (!emailStr) {
        return res.status(400).json({ error: "Missing email" });
      }

      const daysNum = Math.max(1, Math.min(3650, Number(days) || 365)); // cap at 10y
      const tierName = tier === "basic" ? "basic" : "premium";

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

const addMonthToSubscriptionStripeWebhook = (req, res, uid, days = 30) => {
  const ref = admin.firestore().collection("members").doc(uid);
  const date = new Date();
  date.setDate(date.getDate() + days + 0.65);

  // const transactionRef = admin.firestore().collection('members').doc(uid);

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
      .then(innerRes => {
        console.log("COMPLETED ADDING MONTH TO SUB FOR USER WITH UID:" + uid);
        return res.send(200);
        // res.status(200).end();
        // return;
      })
      .catch(err => {
        console.log(err);
        // return;
        return res.send(500); // .send("");
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

exports.validateUserToken = functions.https.onRequest((req, res) => {
  const corsFn = cors();
  corsFn(req, res, () => {
    return validateCouponToken(req.body.token, res);
  });
});

const validateCouponToken = (token, res) => {
  const tokenTrim = String(token || "").trim();
  const tokenLower = tokenTrim.toLowerCase();
  const tokenUpper = tokenTrim.toUpperCase();
  const candidateIds = Array.from(new Set([tokenTrim, tokenLower, tokenUpper])).filter(Boolean);

  const tokensCol = admin.firestore().collection("userTokens");

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
        // Safety-net promos: should always validate as 30 days free.
        if (tokenLower === "harbourview" || tokenLower === "goldy") {
          return res.send(200, { daysFree: 30, reusable: true, fallback: true, canonicalTokenId: tokenLower });
        }
        return res.send(404);
      }

      const responseObj = foundDoc.data() || {};
      const percentOffFirstMonth = responseObj.percentOffFirstMonth;

      // Helpful for debugging/consistency downstream
      responseObj.canonicalTokenId = foundId;

      // Safety-net promos: should always be treated as 30 days free,
      // even if the Firestore doc exists but is missing/misconfigured.
      if (tokenLower === "harbourview" || tokenLower === "goldy") {
        const daysFreeNum = Number(responseObj.daysFree || 0);
        if (!daysFreeNum) {
          responseObj.daysFree = 30;
          responseObj.fallback = true;
          responseObj.reusable = true;
        }
      }

      if (percentOffFirstMonth === "50%") {
        responseObj["paypalButtonUrl"] = PAYPAL_BUTTON_ADDRESS_50off;
      } else if (percentOffFirstMonth === "25%") {
        responseObj["paypalButtonUrl"] = PAYPAL_BUTTON_ADDRESS_25off;
      }

      return res.send(200, responseObj);
    } catch (err) {
      console.error("validateUserToken error:", err);
      return res.send(404, err);
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
exports.paypalCancelSubscription = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const uid = req.body.uid;
  
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
    const subscriptionId = userData.paypalSubscriptionId;
    
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
});
