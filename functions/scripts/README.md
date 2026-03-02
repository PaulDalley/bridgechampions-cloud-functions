# One-off scripts

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
