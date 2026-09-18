/**
 * Firebase Firestore integration.
 *
 * Collections used:
 *
 *   roster/{rollNumber}
 *     { rollNumber: "101", name: "Aarav Sharma" }
 *
 *   attendance/{YYYY-MM-DD}
 *     {
 *       date: "2026-09-18",
 *       records: {
 *         "101": { name: "Aarav Sharma", status: "Present", markedAt: <timestamp> },
 *         "102": { name: "Diya Patel",  status: "Absent",  markedAt: null }
 *       },
 *       deviceClaims: { "<deviceId>": "101" },   // which roll number each phone has already claimed today
 *       proxyFlags: [ { triedRollNumber, triedName, alreadyClaimedRollNumber, alreadyClaimedName, timestamp } ]
 *     }
 *
 * Both "who's already present" and "which phone already claimed someone" are
 * persisted here, not just held in memory -- so restarting a session mid-day,
 * or the server briefly going to sleep and waking back up (normal on a free
 * hosting tier), can never silently reset those protections.
 */

const admin = require('firebase-admin');
const path = require('path');

let db = null;

function getDb() {
  if (db) return db;

  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  } else {
    const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH || './firebase-service-account.json';
    // eslint-disable-next-line global-require, import/no-dynamic-require
    serviceAccount = require(path.resolve(process.cwd(), keyPath));
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
  return db;
}

/** Returns the full class roster: [{ rollNumber, name }], sorted by roll number. */
async function getRoster() {
  const database = getDb();
  const snap = await database.collection('roster').get();
  return snap.docs
    .map((doc) => doc.data())
    .map((r) => ({ rollNumber: String(r.rollNumber), name: r.name }))
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber, undefined, { numeric: true }));
}

/** Adds a new student or updates an existing one (same roll number = update). */
async function addOrUpdateStudent(rollNumber, name) {
  const database = getDb();
  await database
    .collection('roster')
    .doc(String(rollNumber))
    .set({ rollNumber: String(rollNumber), name: String(name) });
}

/** Removes a student from the roster entirely. */
async function removeStudent(rollNumber) {
  const database = getDb();
  await database.collection('roster').doc(String(rollNumber)).delete();
}

/**
 * Ensures today's attendance document exists, pre-filled with every roster
 * student marked "Absent" (existing Present/Absent records are preserved if
 * the doc already exists from earlier today).
 * Returns { dateStr, roster, presentRollNumbers, deviceClaims } so the live
 * session can be correctly re-seeded even after a restart.
 */
async function ensureSessionDoc(dateStr) {
  const database = getDb();
  const roster = await getRoster();
  const ref = database.collection('attendance').doc(dateStr);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() : {};
  const existingRecords = existingData.records || {};

  const records = {};
  for (const student of roster) {
    records[student.rollNumber] = existingRecords[student.rollNumber] || {
      name: student.name,
      status: 'Absent',
      markedAt: null,
    };
  }
  await ref.set({ date: dateStr, records }, { merge: true });

  const presentRollNumbers = Object.keys(records).filter((rn) => records[rn].status === 'Present');
  const deviceClaims = existingData.deviceClaims || {};

  return { dateStr, roster, presentRollNumbers, deviceClaims };
}

/** Marks a single student Present for the given date. */
async function markPresent(dateStr, rollNumber, name) {
  const database = getDb();
  const ref = database.collection('attendance').doc(dateStr);
  await ref.set(
    {
      records: {
        [rollNumber]: {
          name,
          status: 'Present',
          markedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
    },
    { merge: true }
  );
}

/** Persists that this phone (deviceId) has now claimed this roll number today. */
async function recordDeviceClaim(dateStr, deviceId, rollNumber) {
  const database = getDb();
  const ref = database.collection('attendance').doc(dateStr);
  await ref.set(
    { deviceClaims: { [deviceId]: rollNumber } },
    { merge: true }
  );
}

/** Persists a new proxy-attempt flag immediately (not just at session end). */
async function appendProxyFlag(dateStr, flag) {
  const database = getDb();
  const ref = database.collection('attendance').doc(dateStr);
  await ref.set(
    { proxyFlags: admin.firestore.FieldValue.arrayUnion(flag) },
    { merge: true }
  );
}

/**
 * Finalizes a session: any roster student not in `presentRollNumbers` is
 * explicitly written as "Absent" for this date (covers students who never scanned).
 */
async function finalizeAbsentees(dateStr, roster, presentRollNumbers) {
  const database = getDb();
  const ref = database.collection('attendance').doc(dateStr);
  const updates = {};
  for (const student of roster) {
    if (!presentRollNumbers.has(student.rollNumber)) {
      updates[`records.${student.rollNumber}`] = {
        name: student.name,
        status: 'Absent',
        markedAt: null,
      };
    }
  }
  if (Object.keys(updates).length === 0) return;
  await ref.update(updates);
}

module.exports = {
  getRoster,
  addOrUpdateStudent,
  removeStudent,
  ensureSessionDoc,
  markPresent,
  recordDeviceClaim,
  appendProxyFlag,
  finalizeAbsentees,
};