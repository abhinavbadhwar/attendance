require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');

const firebase = require('./services/firebase');
const sessionManager = require('./services/sessionManager');

const app = express();
// Needed so req.ip reflects the real visitor IP when running behind ngrok /
// a reverse proxy / hosting platform, instead of the proxy's own IP.
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --- Network (WiFi) check config ---
// Comma-separated list of allowed public IPs and/or CIDR ranges, e.g.
// "103.21.58.10,203.0.113.0/24". Leave ALLOWED_NETWORK_IPS empty to skip this
// check entirely (useful if your school's IP isn't static).
const ALLOWED_NETWORK_IPS = (process.env.ALLOWED_NETWORK_IPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function normalizeIp(ip) {
  if (!ip) return ip;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isIpAllowed(ip) {
  if (ALLOWED_NETWORK_IPS.length === 0) return true; // check disabled
  const clean = normalizeIp(ip);
  return ALLOWED_NETWORK_IPS.some((entry) => {
    if (entry.includes('/')) {
      const [range, prefixStr] = entry.split('/');
      const prefix = Number(prefixStr);
      const rangeLong = ipToLong(range);
      const ipLong = ipToLong(clean);
      if (rangeLong === null || ipLong === null) return false;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      return (rangeLong & mask) === (ipLong & mask);
    }
    return entry === clean;
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------- Roster management ----------
app.get('/api/roster', async (req, res) => {
  try {
    const roster = await firebase.getRoster();
    res.json(roster);
  } catch (err) {
    console.error('GET /api/roster failed:', err);
    res.status(500).json({ error: 'Failed to load roster. Check Firebase credentials.' });
  }
});

app.post('/api/roster', async (req, res) => {
  try {
    const { rollNumber, name } = req.body;
    if (!rollNumber || !name) {
      return res.status(400).json({ error: 'rollNumber and name are required.' });
    }
    await firebase.addOrUpdateStudent(rollNumber, name);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/roster failed:', err);
    res.status(500).json({ error: err.message || 'Failed to save student.' });
  }
});

// Bulk add: body { students: [{rollNumber, name}, ...] }. Adds each independently
// and reports per-row success/failure so one bad row doesn't hide the rest.
app.post('/api/roster/bulk', async (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: 'students must be a non-empty array.' });
  }
  const results = [];
  for (const s of students) {
    const rollNumber = (s.rollNumber || '').toString().trim();
    const name = (s.name || '').toString().trim();
    if (!rollNumber || !name) {
      results.push({ rollNumber, name, ok: false, error: 'Missing roll number or name.' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await firebase.addOrUpdateStudent(rollNumber, name);
      results.push({ rollNumber, name, ok: true });
    } catch (err) {
      console.error('bulk roster add failed for', rollNumber, err);
      results.push({ rollNumber, name, ok: false, error: err.message || 'Save failed.' });
    }
  }
  res.json({ results });
});

app.delete('/api/roster/:rollNumber', async (req, res) => {
  try {
    await firebase.removeStudent(req.params.rollNumber);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/roster failed:', err);
    res.status(500).json({ error: 'Failed to remove student.' });
  }
});

// ---------- Teacher: start (or resume) today's attendance session ----------
app.post('/api/session/start', async (req, res) => {
  try {
    const dateStr = todayStr();
    const { roster, presentRollNumbers, deviceClaims } = await firebase.ensureSessionDoc(dateStr);
    if (roster.length === 0) {
      return res.status(400).json({
        error: 'Roster is empty. Add students first (see the "Manage Roster" panel).',
      });
    }
    const sessionId = sessionManager.startSession({ dateStr, roster, presentRollNumbers, deviceClaims });
    res.json({ sessionId, date: dateStr, studentCount: roster.length });
  } catch (err) {
    console.error('session/start failed:', err);
    res.status(500).json({ error: 'Failed to start session. Check server logs / Firebase credentials.' });
  }
});

// ---------- Teacher: fetch the QR image for the current (static-per-session) token ----------
app.get('/api/session/qr', async (req, res) => {
  const status = sessionManager.getStatus();
  if (!status.active) return res.status(400).json({ error: 'No active session.' });

  const state = sessionManager.getRawState();
  const attendUrl = `${BASE_URL}/attend.html?session=${state.sessionId}&token=${state.currentToken}`;
  const qrDataUrl = await QRCode.toDataURL(attendUrl, {
    margin: 3,
    width: 400,
    errorCorrectionLevel: 'H',
  });

  res.json({ qrImage: qrDataUrl, attendUrl, ...status });
});

// ---------- Teacher: manually regenerate the QR (e.g. if a leak is suspected) ----------
app.post('/api/session/qr/regenerate', (req, res) => {
  const status = sessionManager.getStatus();
  if (!status.active) return res.status(400).json({ error: 'No active session.' });
  sessionManager.regenerateToken();
  res.json({ ok: true });
});

// ---------- Teacher: live status ----------
app.get('/api/session/status', (req, res) => {
  res.json(sessionManager.getStatus());
});

// ---------- Public: roster names for the student dropdown ----------
app.get('/api/roster-lite', (req, res) => {
  const state = sessionManager.getRawState();
  res.json(state.roster.map((r) => ({ rollNumber: r.rollNumber, name: r.name })));
});

// ---------- Student: submit a scan ----------
app.post('/api/attend', async (req, res) => {
  try {
    const { sessionId, token, rollNumber, deviceId } = req.body;

    // --- Check: network. Must be on the classroom's WiFi (if configured). ---
    const clientIp = normalizeIp(req.ip);
    if (!isIpAllowed(clientIp)) {
      return res.status(403).json({
        ok: false,
        reason: 'You must be connected to the classroom WiFi network to mark attendance.',
      });
    }

    // --- Checks: session/token validity, roster membership, one-time use, device lock ---
    const check = sessionManager.validateScan({ sessionId, token, rollNumber, deviceId });
    if (!check.ok) {
      // Persist proxy flags immediately so they survive even if the server
      // restarts before the session is ended.
      if (check.proxyFlag) {
        const state = sessionManager.getRawState();
        await firebase.appendProxyFlag(state.dateStr, check.proxyFlag);
      }
      return res.status(400).json({ ok: false, reason: check.reason });
    }

    // All checks passed -> write to Firestore and lock this roll number + device for today.
    const state = sessionManager.getRawState();
    await firebase.markPresent(state.dateStr, check.student.rollNumber, check.student.name);
    await firebase.recordDeviceClaim(state.dateStr, deviceId, check.student.rollNumber);
    sessionManager.markScanSuccessful(check.student.rollNumber, deviceId);

    res.json({ ok: true, name: check.student.name });
  } catch (err) {
    console.error('POST /api/attend failed:', err);
    res.status(500).json({ ok: false, reason: 'Server error while marking attendance.' });
  }
});

// ---------- Teacher: end session, finalize absentees in Firestore ----------
app.post('/api/session/end', async (req, res) => {
  try {
    const summary = sessionManager.endSession();
    if (summary.roster.length > 0) {
      await firebase.finalizeAbsentees(summary.dateStr, summary.roster, summary.presentRollNumbers);
    }
    res.json({
      ok: true,
      present: summary.roster.filter((r) => summary.presentRollNumbers.has(r.rollNumber)).map((r) => r.name),
      absent: summary.roster.filter((r) => !summary.presentRollNumbers.has(r.rollNumber)).map((r) => r.name),
      proxyFlags: summary.proxyFlags,
    });
  } catch (err) {
    console.error('session/end failed:', err);
    res.status(500).json({ error: 'Failed to finalize session.' });
  }
});

app.listen(PORT, () => {
  console.log(`Attendance server running at ${BASE_URL}`);
  console.log(`Teacher dashboard: ${BASE_URL}/teacher.html`);
  if (ALLOWED_NETWORK_IPS.length === 0) {
    console.log('Network (WiFi) check: DISABLED (set ALLOWED_NETWORK_IPS in .env to enable)');
  } else {
    console.log('Network (WiFi) check: enabled for', ALLOWED_NETWORK_IPS.join(', '));
  }
});