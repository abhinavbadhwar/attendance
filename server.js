require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');

const auth = require('./services/auth');
const firebase = require('./services/firebase');
const sessionManager = require('./services/sessionManager');

const app = express();
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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
  if (ALLOWED_NETWORK_IPS.length === 0) return true;
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
  return new Date().toISOString().slice(0, 10);
}

function sessionKey(teacherId, classId) {
  return `${teacherId}:${classId}`;
}

// ---------- Auth middleware ----------
async function requireAuth(req, res, next) {
  try {
    const token = req.headers['x-teacher-token'];
    const teacher = await auth.getTeacherFromToken(token);
    if (!teacher) return res.status(401).json({ error: 'Not logged in.' });
    req.teacherId = teacher.teacherId;
    req.teacherName = teacher.name;
    next();
  } catch (err) {
    console.error('requireAuth failed:', err);
    res.status(500).json({ error: 'Authentication check failed.' });
  }
}

async function requireClass(req, res, next) {
  try {
    const classId = req.headers['x-class-id'];
    if (!classId) return res.status(400).json({ error: 'No class selected.' });
    const cls = await firebase.getClass(req.teacherId, classId);
    if (!cls) return res.status(403).json({ error: 'Class not found, or it does not belong to you.' });
    req.classId = classId;
    req.classInfo = cls;
    next();
  } catch (err) {
    console.error('requireClass failed:', err);
    res.status(500).json({ error: 'Class check failed.' });
  }
}

// ---------- Auth routes ----------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    await auth.signup({ name, email, password });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Signup failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await auth.login({ email, password });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Login failed.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = req.headers['x-teacher-token'];
  await auth.logout(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ teacherId: req.teacherId, name: req.teacherName });
});

// ---------- Class management ----------
app.post('/api/classes', requireAuth, async (req, res) => {
  try {
    const { subject, className } = req.body;
    if (!subject || !className) {
      return res.status(400).json({ error: 'Subject and class name are both required.' });
    }
    const cls = await firebase.createClass(req.teacherId, subject, className);
    res.json({ ok: true, class: cls });
  } catch (err) {
    console.error('POST /api/classes failed:', err);
    res.status(500).json({ error: 'Failed to create class.' });
  }
});

app.get('/api/classes', requireAuth, async (req, res) => {
  try {
    const classes = await firebase.getClasses(req.teacherId);
    res.json(classes);
  } catch (err) {
    console.error('GET /api/classes failed:', err);
    res.status(500).json({ error: 'Failed to load classes.' });
  }
});

// ---------- Roster management (teacher-only, scoped to their selected class) ----------
app.get('/api/roster', requireAuth, requireClass, async (req, res) => {
  try {
    const roster = await firebase.getRoster(req.teacherId, req.classId);
    res.json(roster);
  } catch (err) {
    console.error('GET /api/roster failed:', err);
    res.status(500).json({ error: 'Failed to load roster.' });
  }
});

app.post('/api/roster', requireAuth, requireClass, async (req, res) => {
  try {
    const { rollNumber, name } = req.body;
    if (!rollNumber || !name) {
      return res.status(400).json({ error: 'rollNumber and name are required.' });
    }
    await firebase.addOrUpdateStudent(req.teacherId, req.classId, rollNumber, name);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/roster failed:', err);
    res.status(500).json({ error: err.message || 'Failed to save student.' });
  }
});

app.post('/api/roster/bulk', requireAuth, requireClass, async (req, res) => {
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
      await firebase.addOrUpdateStudent(req.teacherId, req.classId, rollNumber, name);
      results.push({ rollNumber, name, ok: true });
    } catch (err) {
      console.error('bulk roster add failed for', rollNumber, err);
      results.push({ rollNumber, name, ok: false, error: err.message || 'Save failed.' });
    }
  }
  res.json({ results });
});

app.delete('/api/roster/:rollNumber', requireAuth, requireClass, async (req, res) => {
  try {
    await firebase.removeStudent(req.teacherId, req.classId, req.params.rollNumber);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/roster failed:', err);
    res.status(500).json({ error: 'Failed to remove student.' });
  }
});

// ---------- Teacher: start (or resume) today's session for their selected class ----------
app.post('/api/session/start', requireAuth, requireClass, async (req, res) => {
  try {
    const dateStr = todayStr();
    const { roster, presentRollNumbers, deviceClaims } = await firebase.ensureSessionDoc(
      req.teacherId,
      req.classId,
      dateStr
    );
    if (roster.length === 0) {
      return res.status(400).json({ error: 'Roster is empty. Add students first.' });
    }
    const key = sessionKey(req.teacherId, req.classId);
    const sessionId = sessionManager.startSession(key, { dateStr, roster, presentRollNumbers, deviceClaims });
    res.json({ sessionId, date: dateStr, studentCount: roster.length });
  } catch (err) {
    console.error('session/start failed:', err);
    res.status(500).json({ error: 'Failed to start session.' });
  }
});

app.get('/api/session/qr', requireAuth, requireClass, async (req, res) => {
  const key = sessionKey(req.teacherId, req.classId);
  const status = sessionManager.getStatus(key);
  if (!status.active) return res.status(400).json({ error: 'No active session.' });

  const state = sessionManager.getRawState(key);
  const attendUrl = `${BASE_URL}/attend.html?t=${encodeURIComponent(req.teacherId)}&c=${encodeURIComponent(
    req.classId
  )}&session=${state.sessionId}&token=${state.currentToken}`;
  const qrDataUrl = await QRCode.toDataURL(attendUrl, { margin: 3, width: 400, errorCorrectionLevel: 'H' });

  res.json({ qrImage: qrDataUrl, attendUrl, ...status });
});

app.post('/api/session/qr/regenerate', requireAuth, requireClass, (req, res) => {
  const key = sessionKey(req.teacherId, req.classId);
  const status = sessionManager.getStatus(key);
  if (!status.active) return res.status(400).json({ error: 'No active session.' });
  sessionManager.rotateToken(key);
  res.json({ ok: true });
});

app.get('/api/session/status', requireAuth, requireClass, (req, res) => {
  const key = sessionKey(req.teacherId, req.classId);
  res.json(sessionManager.getStatus(key));
});

app.post('/api/session/end', requireAuth, requireClass, async (req, res) => {
  try {
    const key = sessionKey(req.teacherId, req.classId);
    const summary = sessionManager.endSession(key);
    if (summary.roster.length > 0) {
      await firebase.finalizeAbsentees(req.teacherId, req.classId, summary.dateStr, summary.roster, summary.presentRollNumbers);
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

// ---------- Public: student-facing routes (no login -- identified by t/c in the QR link) ----------
app.get('/api/roster-lite', (req, res) => {
  const { t: teacherId, c: classId } = req.query;
  if (!teacherId || !classId) return res.status(400).json({ error: 'Invalid link.' });
  const key = sessionKey(teacherId, classId);
  const state = sessionManager.getRawState(key);
  res.json(state.roster.map((r) => ({ rollNumber: r.rollNumber, name: r.name })));
});

app.post('/api/attend', async (req, res) => {
  try {
    const { teacherId, classId, sessionId, token, rollNumber, deviceId } = req.body;
    if (!teacherId || !classId) {
      return res.status(400).json({ ok: false, reason: 'Invalid link.' });
    }

    const clientIp = normalizeIp(req.ip);
    if (!isIpAllowed(clientIp)) {
      return res.status(403).json({
        ok: false,
        reason: 'You must be connected to the classroom WiFi network to mark attendance.',
      });
    }

    const key = sessionKey(teacherId, classId);
    const check = sessionManager.validateScan(key, { sessionId, token, rollNumber, deviceId });
    if (!check.ok) {
      if (check.proxyFlag) {
        const state = sessionManager.getRawState(key);
        await firebase.appendProxyFlag(teacherId, classId, state.dateStr, check.proxyFlag);
      }
      return res.status(400).json({ ok: false, reason: check.reason });
    }

    const state = sessionManager.getRawState(key);
    await firebase.markPresent(teacherId, classId, state.dateStr, check.student.rollNumber, check.student.name);
    await firebase.recordDeviceClaim(teacherId, classId, state.dateStr, deviceId, check.student.rollNumber);
    sessionManager.markScanSuccessful(key, check.student.rollNumber, deviceId);

    res.json({ ok: true, name: check.student.name });
  } catch (err) {
    console.error('POST /api/attend failed:', err);
    res.status(500).json({ ok: false, reason: 'Server error while marking attendance.' });
  }
});

app.listen(PORT, () => {
  console.log(`Attendance server running at ${BASE_URL}`);
  console.log(`Login page: ${BASE_URL}/login.html`);
  if (ALLOWED_NETWORK_IPS.length === 0) {
    console.log('Network (WiFi) check: DISABLED');
  } else {
    console.log('Network (WiFi) check: enabled for', ALLOWED_NETWORK_IPS.join(', '));
  }
});