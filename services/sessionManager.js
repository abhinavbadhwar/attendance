/**
 * Holds the state of every currently-live attendance session, keyed by
 * "teacherId:classId" -- so different teachers, or one teacher's different
 * classes, each get their own independent QR/roster/device-lock state and
 * never interfere with each other.
 *
 * Anti-sharing layers (per class):
 *   1. Roster check      -> only a roll number in that class's roster can be used.
 *   2. Network check     -> checked in server.js: request must come from the
 *                           classroom's WiFi, if ALLOWED_NETWORK_IPS is set.
 *   3. Rotating QR       -> the QR's token refreshes every ROTATE_MS. A photo
 *                           of it stops working shortly after. The PREVIOUS
 *                           token also stays valid for one more cycle (a
 *                           grace window) so an in-progress check-in isn't
 *                           rejected just because the display refreshed.
 *   4. One-time-per-roll -> each roll number can only be marked present ONCE
 *                           per day. Seeded from Firestore on session start.
 *   5. Device lock + proxy flagging -> each phone can only ever be used to
 *                           mark ONE roll number present per day (also
 *                           seeded from Firestore). Reuse attempts are
 *                           BLOCKED and logged, visible live to the teacher.
 *   6. Session lifetime  -> the QR is only valid while that class's session
 *                           is active.
 */

const { nanoid } = require('nanoid');

const ROTATE_MS = Number(process.env.TOKEN_ROTATE_SECONDS || 30) * 1000;

const sessions = new Map(); // key -> state object

function freshState() {
  return {
    sessionId: null,
    active: false,
    currentToken: null,
    previousToken: null,
    tokenIssuedAt: null,
    rotateTimer: null,
    dateStr: null,
    roster: [],
    presentRollNumbers: new Set(),
    deviceRollMap: new Map(),
    proxyFlags: [],
  };
}

function getState(key) {
  if (!sessions.has(key)) sessions.set(key, freshState());
  return sessions.get(key);
}

function startSession(key, { dateStr, roster, presentRollNumbers = [], deviceClaims = {} }) {
  const state = getState(key);
  state.sessionId = nanoid(10);
  state.active = true;
  state.dateStr = dateStr;
  state.roster = roster;
  state.presentRollNumbers = new Set(presentRollNumbers);
  state.deviceRollMap = new Map(Object.entries(deviceClaims));
  state.proxyFlags = [];
  state.previousToken = null;
  rotateToken(key);
  clearInterval(state.rotateTimer);
  state.rotateTimer = setInterval(() => rotateToken(key), ROTATE_MS);
  return state.sessionId;
}

function rotateToken(key) {
  const state = getState(key);
  state.previousToken = state.currentToken;
  state.currentToken = nanoid(24);
  state.tokenIssuedAt = Date.now();
  return state.currentToken;
}

function endSession(key) {
  const state = getState(key);
  clearInterval(state.rotateTimer);
  const summary = {
    sessionId: state.sessionId,
    dateStr: state.dateStr,
    roster: state.roster,
    presentRollNumbers: state.presentRollNumbers,
    proxyFlags: state.proxyFlags,
  };
  state.active = false;
  state.currentToken = null;
  state.previousToken = null;
  state.sessionId = null;
  return summary;
}

function getStatus(key) {
  const state = getState(key);
  return {
    active: state.active,
    sessionId: state.sessionId,
    presentCount: state.presentRollNumbers.size,
    totalCount: state.roster.length,
    presentList: state.roster
      .filter((r) => state.presentRollNumbers.has(r.rollNumber))
      .map((r) => r.name),
    tokenAgeMs: state.tokenIssuedAt ? Date.now() - state.tokenIssuedAt : null,
    rotateMs: ROTATE_MS,
    proxyFlags: state.proxyFlags,
  };
}

function validateScan(key, { sessionId, token, rollNumber, deviceId }) {
  const state = getState(key);
  if (!state.active) {
    return { ok: false, reason: 'No attendance session is currently open.' };
  }
  if (sessionId !== state.sessionId) {
    return { ok: false, reason: 'This QR code is from a different session. Please scan the code currently on screen.' };
  }
  if (token !== state.currentToken && token !== state.previousToken) {
    return {
      ok: false,
      reason: 'This QR code has expired (it refreshes automatically). Please scan the code currently on screen.',
    };
  }
  if (!deviceId) {
    return { ok: false, reason: 'Could not identify this device. Please reload the page and try again.' };
  }

  const student = state.roster.find((r) => r.rollNumber === String(rollNumber).trim());
  if (!student) {
    return { ok: false, reason: 'Roll number not found in this class roster.' };
  }
  if (state.presentRollNumbers.has(student.rollNumber)) {
    return { ok: false, reason: 'This roll number has already been marked present.' };
  }

  const claimedByThisDevice = state.deviceRollMap.get(deviceId);
  if (claimedByThisDevice && claimedByThisDevice !== student.rollNumber) {
    const alreadyClaimedStudent = state.roster.find((r) => r.rollNumber === claimedByThisDevice);
    const flag = {
      triedRollNumber: student.rollNumber,
      triedName: student.name,
      alreadyClaimedRollNumber: claimedByThisDevice,
      alreadyClaimedName: alreadyClaimedStudent ? alreadyClaimedStudent.name : claimedByThisDevice,
      timestamp: Date.now(),
    };
    state.proxyFlags.push(flag);
    return {
      ok: false,
      reason: 'This device has already been used to mark a different student present. Each phone can only check in its own owner.',
      proxyFlag: flag,
    };
  }

  return { ok: true, student };
}

function markScanSuccessful(key, rollNumber, deviceId) {
  const state = getState(key);
  state.presentRollNumbers.add(rollNumber);
  state.deviceRollMap.set(deviceId, rollNumber);
}

function getRawState(key) {
  return getState(key);
}

module.exports = {
  startSession,
  endSession,
  getStatus,
  validateScan,
  markScanSuccessful,
  rotateToken,
  getRawState,
};