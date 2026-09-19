/**
 * Class, roster, and attendance data -- all scoped under the teacher who owns
 * it, so multiple teachers (or one teacher's multiple subjects) never see or
 * affect each other's data.
 *
 * Collections used:
 *
 *   teachers/{teacherId}/classes/{classId}
 *     { subject, className, createdAt }
 *
 *   teachers/{teacherId}/classes/{classId}/roster/{rollNumber}
 *     { rollNumber, name }
 *
 *   teachers/{teacherId}/classes/{classId}/attendance/{YYYY-MM-DD}
 *     {
 *       date, records: { [rollNumber]: { name, status, markedAt } },
 *       deviceClaims: { [deviceId]: rollNumber },
 *       proxyFlags: [ { triedRollNumber, triedName, alreadyClaimedRollNumber, alreadyClaimedName, timestamp } ]
 *     }
 */

const { getDb, admin } = require('./db');

function classRef(teacherId, classId) {
  return getDb().collection('teachers').doc(teacherId).collection('classes').doc(classId);
}

/** Creates a new class for this teacher. Returns { classId, subject, className }. */
async function createClass(teacherId, subject, className) {
  const database = getDb();
  const ref = database.collection('teachers').doc(teacherId).collection('classes').doc();
  const data = {
    subject: String(subject).trim(),
    className: String(className).trim(),
    createdAt: new Date().toISOString(),
  };
  await ref.set(data);
  return { classId: ref.id, ...data };
}

/** Lists all classes belonging to this teacher. */
async function getClasses(teacherId) {
  const database = getDb();
  const snap = await database.collection('teachers').doc(teacherId).collection('classes').get();
  return snap.docs.map((doc) => ({ classId: doc.id, ...doc.data() }));
}

/** Returns { subject, className } if this class exists and belongs to this teacher, else null. */
async function getClass(teacherId, classId) {
  const snap = await classRef(teacherId, classId).get();
  if (!snap.exists) return null;
  return snap.data();
}

/** Returns the full class roster: [{ rollNumber, name }], sorted by roll number. */
async function getRoster(teacherId, classId) {
  const snap = await classRef(teacherId, classId).collection('roster').get();
  return snap.docs
    .map((doc) => doc.data())
    .map((r) => ({ rollNumber: String(r.rollNumber), name: r.name }))
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber, undefined, { numeric: true }));
}

/** Adds a new student or updates an existing one (same roll number = update). */
async function addOrUpdateStudent(teacherId, classId, rollNumber, name) {
  await classRef(teacherId, classId)
    .collection('roster')
    .doc(String(rollNumber))
    .set({ rollNumber: String(rollNumber), name: String(name) });
}

/** Removes a student from the roster entirely. */
async function removeStudent(teacherId, classId, rollNumber) {
  await classRef(teacherId, classId).collection('roster').doc(String(rollNumber)).delete();
}

/**
 * Ensures today's attendance document exists for this class, pre-filled with
 * every roster student marked "Absent" (existing records for today are kept).
 * Returns { dateStr, roster, presentRollNumbers, deviceClaims }.
 */
async function ensureSessionDoc(teacherId, classId, dateStr) {
  const roster = await getRoster(teacherId, classId);
  const ref = classRef(teacherId, classId).collection('attendance').doc(dateStr);
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
async function markPresent(teacherId, classId, dateStr, rollNumber, name) {
  const ref = classRef(teacherId, classId).collection('attendance').doc(dateStr);
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
async function recordDeviceClaim(teacherId, classId, dateStr, deviceId, rollNumber) {
  const ref = classRef(teacherId, classId).collection('attendance').doc(dateStr);
  await ref.set({ deviceClaims: { [deviceId]: rollNumber } }, { merge: true });
}

/** Persists a new proxy-attempt flag immediately (not just at session end). */
async function appendProxyFlag(teacherId, classId, dateStr, flag) {
  const ref = classRef(teacherId, classId).collection('attendance').doc(dateStr);
  await ref.set({ proxyFlags: admin.firestore.FieldValue.arrayUnion(flag) }, { merge: true });
}

/**
 * Finalizes a session: any roster student not in `presentRollNumbers` is
 * explicitly written as "Absent" for this date.
 */
async function finalizeAbsentees(teacherId, classId, dateStr, roster, presentRollNumbers) {
  const ref = classRef(teacherId, classId).collection('attendance').doc(dateStr);
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
  createClass,
  getClasses,
  getClass,
  getRoster,
  addOrUpdateStudent,
  removeStudent,
  ensureSessionDoc,
  markPresent,
  recordDeviceClaim,
  appendProxyFlag,
  finalizeAbsentees,
};