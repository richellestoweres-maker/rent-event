/**
 * RentEvent account deletion
 *
 * A customer, vendor or planner asks for deletion on account-settings.html,
 * which marks their account pending_deletion and files a deletion_requests
 * document. An admin then finishes it from the admin dashboard, which calls
 * this function.
 *
 * What it removes: the sign in, the user document, every profile document,
 * and every listing, so nothing about them stays visible. What it keeps:
 * booking requests and payment records, which the law and Stripe require
 * RentEvent to hold onto, and which are never shown to the public anyway.
 *
 * Entry point: deleteUserAccount
 */

import { http } from '@google-cloud/functions-framework';
import admin from 'firebase-admin';

if (!admin.apps.length) { admin.initializeApp(); }

/** Same admins as the Firestore rules. */
const ADMIN_USER_IDS = ['GBrIifV7FnOnXhXmgmG4lpMg4Lr1'];

const ALLOWED_ORIGINS = [
  'https://www.rentevent-app.com',
  'https://rentevent-app.com',
  'https://richellestoweres-maker.github.io',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost:5000',
  'http://127.0.0.1:5000'
];

function setCors(req, res) {
  const origin = req.get('origin') || '';
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

http('deleteUserAccount', async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  await handleDelete(req, res);
});

async function handleDelete(req, res) {
  try {
    const authHeader = req.get('Authorization') || '';
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) { res.status(401).json({ error: 'Missing auth token' }); return; }

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const callerUid = decoded.uid;

    // Admin comes from a custom claim or the allowlist, never from anything a
    // user can write into their own document.
    const isAdmin = decoded.admin === true || ADMIN_USER_IDS.includes(callerUid);
    if (!isAdmin) { res.status(403).json({ error: 'Admin access required' }); return; }

    const targetUid = String((req.body && req.body.uid) || '').trim();
    if (!targetUid) { res.status(400).json({ error: 'Missing uid' }); return; }
    if (targetUid === callerUid) { res.status(400).json({ error: 'Cannot delete your own account' }); return; }

    const db = admin.firestore();
    const removed = await deleteUserData(db, targetUid);

    await deleteAuthUser(targetUid);

    await db.collection('deletion_requests').doc(targetUid).set({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedBy: callerUid,
      removed
    }, { merge: true });

    res.status(200).json({ success: true, removed });
  } catch (error) {
    console.error('deleteUserAccount error:', error);
    res.status(500).json({ error: error.message || 'Internal error' });
  }
}

/** Deletes everything that identifies the person, and reports what went. */
async function deleteUserData(db, uid) {
  const removed = { profiles: 0, listings: 0, verification: 0, pushTokens: 0 };

  for (const name of ['users', 'vendor_profiles', 'planner_profiles', 'client_profiles']) {
    const ref = db.collection(name).doc(uid);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.delete();
      if (name !== 'users') removed.profiles += 1;
    }
  }

  const listings = await db.collection('listings').where('vendorId', '==', uid).get();
  for (const doc of listings.docs) {
    await doc.ref.delete();
    removed.listings += 1;
  }

  for (const name of ['vendorVerifications', 'verifiedVendors']) {
    const ref = db.collection(name).doc(uid);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.delete();
      removed.verification += 1;
    }
  }

  // Their uploaded insurance certificates.
  try {
    await admin.storage().bucket('rent-event-f7abd.firebasestorage.app')
      .deleteFiles({ prefix: 'verification/' + uid + '/' });
  } catch (error) {
    console.warn('Could not delete verification files for', uid, error.message);
  }

  const tokens = await db.collection('pushTokens').where('userId', '==', uid).get();
  for (const doc of tokens.docs) {
    await doc.ref.delete();
    removed.pushTokens += 1;
  }

  return removed;
}

async function deleteAuthUser(uid) {
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') { throw error; }
  }
}
