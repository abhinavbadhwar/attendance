/**
 * Holds the state of the currently-live attendance session (there's one class at a
 * time in this simple model — extend to a Map<sessionId, state> for multiple
 * simultaneous classes/rooms).
 *
 * Anti-sharing layers:
 *   1. Roster check     -> only a roll number in this class's roster can be used.
 *   2. Network check    -> checked in server.js: request must come from the
 *                          classroom's WiFi (matching a configured public IP).
 *   3. One-time-per-roll -> each roll number can only be marked present ONCE
 *                          per day. This is seeded from Firestore on session
 *                          start, so restarting the session mid-day never
 *                          resets it.
 *   4. Device lock + proxy flagging -> each scanning device (phone) can only
 *                          ever be used to mark ONE roll number present per
 *                          day. This is also seeded from Firestore on session
 *                          start for the same reason. Any attempt to reuse a
 *                          device for a second student is BLOCKED and logged
 *                          to proxyFlags, visible live to the teacher.
 *   5. Session lifetime -> the QR/token is only valid while the teacher's
 *                          session is active; ending the session invalidates
 *                          it entirely.
 *
 * The token itself is generated once per session (or on-demand via
 * `regenerateToken`, e.g. if a teacher suspects a leak) rather than rotating
 * automatically on a timer.
 */

const { nanoid } = require('nanoid');

const state = {
  sessionId: null,
  active: false,
  currentToken: null,
  tokenIssuedAt: null,
  dateStr: null,
  roster: [], // [{rollNumber, name}]
  presentRollNumbers: new Set(),
  deviceRollMap: new Map(), // deviceId -> rollNumber already claimed by that device (today)
  proxyFlags: [], // [{ triedRollNumber, triedName, alreadyClaimedRollNumber, alreadyClaimedName, timestamp }]
};

/**
 * Starts (or resumes) today's session.
 * presentRollNumbers and deviceClaims come from Firestore (via
 * firebase.ensureSessionDoc) so that restarting the session mid-day resumes
 * with the correct protections already in place, instead of resetting them.
 */
function startSession({ dateStr, roster, presentRollNumbers = [], deviceClaims = {} }) {
  state.sessionId = nanoid(10);
  state.active = true;
  state.dateStr = dateStr;
  state.roster = roster;
  state.presentRollNumbers = new Set(presentRollNumbers);
  state.deviceRollMap = new Map(Object.entries(deviceClaims));
  state.proxyFlags = [];
  regenerateToken();
  return state.sessionId;
}

/** Generates a fresh token. Called on session start, and optionally on demand
 *  by the teacher (e.g. "Regenerate QR" button) if a leak is suspected. */
function regenerateToken() {
  state.currentToken = nanoid(24);
  state.tokenIssuedAt = Date.now();
  return state.currentToken;
}

function endSession() {
  const summary = {
    sessionId: state.sessionId,
    dateStr: state.dateStr,
    roster: state.roster,
    presentRollNumbers: state.presentRollNumbers,
    proxyFlags: state.proxyFlags,
  };
  state.active = false;
  state.currentToken = null;
  state.sessionId = null;
  return summary;
}

function getStatus() {
  return {
    active: state.active,
    sessionId: state.sessionId,
    presentCount: state.presentRollNumbers.size,
    totalCount: state.roster.length,
    presentList: state.roster
      .filter((r) => state.presentRollNumbers.has(r.rollNumber))
      .map((r) => r.name),
    tokenAgeMs: state.tokenIssuedAt ? Date.now() - state.tokenIssuedAt : null,
    proxyFlags: state.proxyFlags,
  };
}

/**
 * Validates a scan attempt. Returns { ok: boolean, reason?: string, student?, proxyFlag? }.
 * The network-IP check happens in server.js (it needs request-level data this
 * module doesn't have); everything else funnels through here.
 */
function validateScan({ sessionId, token, rollNumber, deviceId }) {
  if (!state.active) {
    return { ok: false, reason: 'No attendance session is currently open.' };
  }
  if (sessionId !== state.sessionId || token !== state.currentToken) {
    return { ok: false, reason: 'This QR code is invalid or from a different session. Please scan the code currently on screen.' };
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

function markScanSuccessful(rollNumber, deviceId) {
  state.presentRollNumbers.add(rollNumber);
  state.deviceRollMap.set(deviceId, rollNumber);
}

function getRawState() {
  return state;
}

module.exports = {
  startSession,
  endSession,
  getStatus,
  validateScan,
  markScanSuccessful,
  regenerateToken,
  getRawState,
};