# QR Attendance System (Anti-Sharing) — Firebase backend

A classroom attendance app: the teacher displays a QR code, students scan it with
their phone camera, and attendance is written straight into Firebase Firestore.
It's built specifically so that **sharing the QR image with someone outside
class does not work.**

## ⚠️ Read this first if the QR "doesn't open" on a phone

This is almost always a **reachability** problem, not a QR problem. The QR
encodes a link built from `BASE_URL` in your `.env` file. If that's still
`http://localhost:3000`, your phone has no idea what "localhost" means — to
a phone, that's itself, not your computer — so nothing loads.

**Fix: use ngrok (2 minutes, works from anywhere, gives you HTTPS too):**

1. Sign up free at [ngrok.com](https://ngrok.com), install it, run the one-time auth command they give you.
2. Start your server normally in one terminal: `npm start`
3. In a **second** terminal, run:
   ```bash
   ngrok http 3000
   ```
4. Ngrok prints a URL like `https://abcd1234.ngrok-free.app`. Put it in `.env`:
   ```
   BASE_URL=https://abcd1234.ngrok-free.app
   ```
5. Stop the server (`Ctrl+C`) and run `npm start` again so it picks up the new `.env`.
6. Open `https://abcd1234.ngrok-free.app/teacher.html`, start a session, and scan
   the QR — this now works from any phone, any network (WiFi or mobile data),
   anywhere in the world reachability-wise, with the security layers below
   restricting who it actually accepts.

**Before assuming the QR itself is broken**, open the exact `BASE_URL` link
directly in your iPhone's Safari browser. If Safari can't load it, no QR will
work either — fix that first.

**iPhone-specific checklist:**
- Use the native **Camera** app (not a random third-party scanner) — point it
  at the screen, a yellow banner should appear at the top; tap it.
- Settings → Camera → **Scan QR Codes** should be on (it is by default).
- The QR must be reasonably large and well-lit on screen — very small or glare-y
  displays are the second most common scan failure after point 1.

## How the anti-sharing protection works

There is **no countdown timer** — instead, five independent checks run on every
scan (in `server.js` and `services/sessionManager.js`), each targeting a
different way the QR could be misused:

| Problem | Fix |
|---|---|
| Student shares the QR with a friend on a different WiFi (e.g. sends it home, or to another school) | **Network check** — the request must come from the classroom's WiFi (matched against a configured public IP). Off-network requests are rejected outright. |
| Friend receives the QR and is nearby, but not actually in the room | **Geofencing** — the phone's GPS must be within `CLASSROOM_RADIUS_METERS` of the classroom's coordinates. |
| Friend isn't enrolled in this class at all | **Roster check** — the scan page requires selecting a name from the class roster stored in Firestore; anyone not on it can't submit. |
| One student scans repeatedly to mark absent friends present | **One-time-per-roll-number** — each roll number can be marked present only once per session. |
| One phone gets passed around to check in several people | **Device lock** — each phone (tracked via a random ID stored in its browser) can only ever be used to mark one roll number present per session. |
| QR reused after class ends, or the next day | **Session lifetime** — the token is only valid while the teacher's session is open; clicking "End Session" invalidates it completely. |

A teacher can also click **Regenerate QR** at any point (e.g. if they suspect
the image has leaked) to invalidate the old QR immediately without ending the
whole session.

None of these individually is unbeatable (e.g. GPS can in theory be spoofed by
determined users, and a shared WiFi guest network could include people outside
your specific classroom), but stacked together they cover realistic sharing
attempts without pressuring students to scan within a few seconds.

## Project structure

```
attendance-qr-system/
├── server.js                  # Express API + geofencing + network-IP check
├── services/
│   ├── firebase.js            # Firestore roster + attendance reads/writes
│   └── sessionManager.js      # Roster/one-time/device-lock logic
├── public/
│   ├── teacher.html           # Dashboard the teacher projects on screen (QR + roster management)
│   └── attend.html            # Page students land on after scanning
├── .env.example                # Copy to .env and fill in
└── package.json
```

## Firestore data model

```
roster/{rollNumber}
  { rollNumber: "101", name: "Aarav Sharma" }

attendance/{YYYY-MM-DD}
  {
    date: "2026-09-18",
    records: {
      "101": { name: "Aarav Sharma", status: "Present", markedAt: <timestamp> },
      "102": { name: "Diya Patel",  status: "Absent",  markedAt: null }
    }
  }
```

## 1. Create a Firebase project and enable Firestore

1. Go to the [Firebase Console](https://console.firebase.google.com/) → **Add project**.
2. **Build → Firestore Database** → **Create database** → pick a region → **Enable**.

## 2. Create a service account key

1. Project settings (gear icon) → **Service accounts** tab.
2. **Generate new private key** → confirm. A `.json` file downloads.
3. Rename it to `firebase-service-account.json` and place it in the project root
   (next to `server.js`). Don't commit or share this file — it's a credential.

## 3. Configure the app

```bash
cp .env.example .env
```

Edit `.env`:
- `BASE_URL` — see the reachability section at the top of this README. **This is the setting most likely to cause problems if skipped.**
- `FIREBASE_SERVICE_ACCOUNT_KEY_PATH` — leave as-is if you followed step 2.
- `CLASSROOM_LAT` / `CLASSROOM_LNG` — right-click your classroom on Google Maps to copy coordinates.
- `CLASSROOM_RADIUS_METERS` — 30–40m is reasonable for one room.
- `ALLOWED_NETWORK_IPS` — connect to your classroom WiFi, search "what is my ip"
  in a browser, and paste that IP here. Leave blank to skip this check if your
  school's IP changes often.

## 4. Install and run

```bash
npm install
npm start
```

## 5. Using it in class

1. Open `<BASE_URL>/teacher.html`.
2. Expand **Manage Class Roster**. Use **Paste a list** to add your whole class
   at once — one line per student as `rollNumber, Name`, e.g.:
   ```
   101, Aarav Sharma
   102, Diya Patel
   103, Rohan Mehta
   ```
   Or use **Add one** for single entries. You can also edit `roster` documents
   directly in the Firebase Console if you prefer.
3. Click **Start Attendance Session** — creates today's Firestore attendance
   document (everyone starts Absent) and shows the QR.
4. Students scan with their phone camera, pick their name, allow location, tap
   **Mark Present**.
5. Click **End Session** when done — anyone who never scanned stays Absent.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| QR doesn't open anything on the phone | `BASE_URL` isn't reachable from the phone — see the section at the top of this README. Test the exact `BASE_URL` link in Safari directly first. |
| "You must be connected to the classroom WiFi" | Either the phone genuinely isn't on that WiFi, or `ALLOWED_NETWORK_IPS` has a stale/wrong IP — re-check it, or leave it blank to disable this check temporarily. |
| Bulk roster add reports some rows failed | Check the exact error shown per row — most often a blank roll number or name after splitting on the comma. Fix that line and re-paste just the failed ones (the textarea auto-fills with only the failures). |
| "Location permission is required" and nothing happens | The page needs HTTPS to request GPS on a real phone — make sure `BASE_URL` starts with `https://` (ngrok gives you this automatically). |
| `Cannot find module 'firebase-admin'` | Run `npm install` again in the project folder. |
| Server crashes on start mentioning the key file | Confirm `firebase-service-account.json` is named exactly that and sits in the project root, not inside `services/`. |

## Optional further hardening

- **Real login instead of a name dropdown** — swap the roster dropdown for
  Google OAuth restricted to your school's email domain (Firebase
  Authentication supports this natively) so identity is verified, not
  self-declared.
- **Permanent hosting** — instead of running ngrok every class, deploy the
  server somewhere with a stable HTTPS URL (Render, Railway, Firebase Hosting +
  Cloud Run, etc.) so `BASE_URL` never changes.
- **Multiple simultaneous classes** — this demo tracks one active session at a
  time; extend `sessionManager.js` to a `Map` keyed by `sessionId`/room for
  several classes running attendance in parallel.
