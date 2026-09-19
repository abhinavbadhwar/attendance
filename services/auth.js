/**
 * Teacher accounts and login sessions.
 *
 * Collections used:
 *   teachers/{teacherId}   -- teacherId is the lowercased email
 *     { name, email, passwordHash, createdAt }
 *
 *   sessions/{sessionToken}  -- a login session (different from an attendance
 *                               "session" elsewhere in this app)
 *     { teacherId, name, createdAt }
 *
 * Sessions are stored in Firestore (not just in memory) so a teacher stays
 * logged in even if the free server briefly restarts.
 */

const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { getDb } = require('./db');

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

async function signup({ name, email, password }) {
  if (!name || !email || !password) {
    const err = new Error('Name, email and password are all required.');
    err.code = 'MISSING_FIELDS';
    throw err;
  }
  if (String(password).length < 6) {
    const err = new Error('Password must be at least 6 characters.');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  const database = getDb();
  const teacherId = normalizeEmail(email);
  const ref = database.collection('teachers').doc(teacherId);
  const existing = await ref.get();
  if (existing.exists) {
    const err = new Error('An account with this email already exists.');
    err.code = 'EMAIL_TAKEN';
    throw err;
  }
  const passwordHash = await bcrypt.hash(String(password), 10);
  await ref.set({
    name: String(name).trim(),
    email: teacherId,
    passwordHash,
    createdAt: new Date().toISOString(),
  });
  return { teacherId };
}

async function login({ email, password }) {
  const database = getDb();
  const teacherId = normalizeEmail(email);
  const ref = database.collection('teachers').doc(teacherId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('Incorrect email or password.');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }
  const data = snap.data();
  const valid = await bcrypt.compare(String(password), data.passwordHash);
  if (!valid) {
    const err = new Error('Incorrect email or password.');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }
  const token = nanoid(32);
  await database.collection('sessions').doc(token).set({
    teacherId,
    name: data.name,
    createdAt: new Date().toISOString(),
  });
  return { token, teacherId, name: data.name };
}

/** Returns { teacherId, name } for a valid session token, or null. */
async function getTeacherFromToken(token) {
  if (!token) return null;
  const database = getDb();
  const snap = await database.collection('sessions').doc(String(token)).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function logout(token) {
  if (!token) return;
  const database = getDb();
  await database.collection('sessions').doc(String(token)).delete();
}

module.exports = { signup, login, getTeacherFromToken, logout };