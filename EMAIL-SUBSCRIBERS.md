# Sending email to all users or subscribers

## Easiest way

1. Log in to **Bridge Champions** as an admin.
2. Go to **Settings** (your profile/settings page).
3. Scroll to **Admin Tools** → **Email users**.
4. Enter **Subject** and **Message**, then click:
   - **Email subscribers** — only people with an active subscription, or  
   - **Email all users** — everyone who has an account.

No tokens or command line needed.

---

## Which email account is used?

The same **Gmail account** that is used for the **Contact form** and **welcome emails**:

- It’s set in your Firebase Cloud Functions config as **GMAIL_EMAIL** and **GMAIL_PASSWORD** (or in `.env` / Firebase environment as `GMAIL_EMAIL` / `GMAIL_PASSWORD`).
- So whatever inbox you use for “Contact us” and new-user welcome emails is the one that **sends** these broadcast emails. Recipients will see that address as the sender.

To see or change it: Firebase Console → Project **bridgechampions** → Functions → select a function that sends email (e.g. `contactUs`) → Environment config / .env, or run `firebase functions:config:get` in the functions folder.

---

## Optional: call the function yourself (e.g. from a script)

## Deploy the function

From the `ishbridge-41-cloud-functions` folder:

```bash
firebase deploy --only functions:adminEmailAllOrSubscribers
```

(Or deploy all functions: `firebase deploy --only functions`.)

## How to call it

1. **Get your Firebase ID token** (while logged in to the app as admin):
   - In the browser console on bridgechampions.web.app (logged in as you), run:
     ```js
     firebase.auth().currentUser.getIdToken().then(t => console.log(t))
     ```
   - Copy the long token.

2. **Send a POST request** with your token and the email content.

   **URL:**  
   `https://us-central1-bridgechampions.cloudfunctions.net/adminEmailAllOrSubscribers`

   **Headers:**  
   - `Content-Type: application/json`  
   - `Authorization: Bearer <your-id-token>`

   **Body (JSON):**
   - `subject` – email subject line
   - `body` – HTML body (e.g. `<p>Hello everyone...</p>`)
   - `audience` – `"all"` (every Auth user) or `"subscribers"` (only members with an active subscription)

   **Example (curl):**
   ```bash
   curl -X POST "https://us-central1-bridgechampions.cloudfunctions.net/adminEmailAllOrSubscribers" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_ID_TOKEN_HERE" \
     -d '{"subject":"New content on Bridge Champions","body":"<p>Hi, we added new practice hands.</p>","audience":"subscribers"}'
   ```

3. **Response:**  
   `{ "sent": 42, "recipientCount": 42 }` (or an error if something failed).

## Notes

- **Gmail limits:** Sending is done in BCC batches of 50. Gmail has daily sending limits (e.g. 500/day on a free account). For very large lists, consider a dedicated email service (SendGrid, Mailchimp, etc.).
- **Subscribers** = Firestore `members` documents where `subscriptionExpires` is in the future. Their email is taken from Firebase Auth.
- **All users** = every Firebase Auth user (paginated automatically). Users without an email are skipped.
