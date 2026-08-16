# ⚡ PulseChat

A complete, modern real-time messenger — **real accounts, real messages, real video calls.**

PulseChat is a full-stack messaging application with a mobile-first web client (installable PWA) and a
Node.js + Socket.IO + SQLite backend. Two people can sign up on any two devices, find each other,
become contacts, exchange text and photo messages with read receipts, see presence in real time,
and hold one-to-one video calls over WebRTC.

---

## ✨ Feature checklist

| Area | What's implemented |
|---|---|
| **Accounts** | Email + password sign-up, login/logout, persistent sessions (rotating refresh tokens), password reset, profile (avatar, display name, bio) |
| **People** | Search registered users by name/email, friend requests (send / accept / decline), remove contacts |
| **Presence** | 🟢 Online / ⚪ Offline + last seen, updates instantly via sockets (close tab, lose connection, come back — all detected) |
| **Messaging** | Real-time text messages, timestamps, **sent / delivered / read** ticks, unread counters, permanent history with pagination, offline messages stored & delivered on reconnect, typing indicator |
| **Media** | Photo from gallery or camera, upload with progress bar, images rendered inline, tap for fullscreen, protected storage |
| **Calls** | One-to-one WebRTC video calls: incoming screen, accept/decline, end, mute, camera on/off, front/back camera switch, full-screen video + self preview, clear "unavailable" state, call history (incoming/outgoing/missed) |
| **Push** | Web Push (VAPID) notifications for new messages (no content leaked), friend requests, incoming calls — works in the background via the service worker |
| **UI** | Modern messenger design, bottom navigation on mobile / two-pane on desktop, dark + light themes, subtle animations, toasts for every error |
| **Security** | bcrypt password hashing, JWT + rotating refresh tokens, rate limiting, input validation, parameterized SQL, access-controlled media, per-conversation authorization |

---

## 🚀 Quick start

```bash
cd pulsechat
npm install
npm start            # → http://localhost:3000
```

Open `http://localhost:3000` in two different browsers (or a browser + phone on the same
network using your machine's LAN IP — e.g. `http://192.168.x.x:3000`), create two accounts, and
start messaging. Everything runs against the real backend — nothing is simulated.

> The server binds `0.0.0.0` so other devices on your network can connect. For **real**
> cross-device push notifications and camera access you need HTTPS — see *Deployment*.

### Run the test suites

```bash
npm run test:api     # 54 scenario tests: auth, contacts, presence, delivery, media, calls
npm run test:ui      # 21 browser tests with two headless users (incl. a real WebRTC call)
```

---

## 🏗 Architecture

```
pulsechat/
├── server/                    # Node.js backend (Express + Socket.IO + better-sqlite3)
│   ├── index.js               # entry, HTTP + socket wiring, WebRTC signaling, call timers
│   ├── config.js              # env-driven configuration
│   ├── db.js                  # SQLite schema + migrations (WAL mode)
│   ├── auth.js                # bcrypt, JWT access tokens, rotating refresh tokens
│   ├── helpers.js             # shared payload shaping (user summaries, conversation items)
│   ├── mailer.js              # SMTP (optional) / dev-console password reset delivery
│   ├── middleware/            # validation, error handling, secure image uploads
│   ├── routes/                # auth, users, contacts, messages, media, calls, push
│   └── realtime/              # presence registry, offline delivery, Web Push service
├── public/                    # frontend (vanilla ES modules, no build step)
│   ├── index.html / css/app.css
│   ├── js/                    # api, socket, state, rtc (WebRTC), media, notifications, views
│   ├── sw.js                  # service worker (background push)
│   └── assets/                # logo, PWA icons
├── data/                      # SQLite database + uploads (created at runtime)
└── test/                      # API + browser end-to-end suites
```

**Design decisions**

- **REST for writes, sockets for events.** Every mutation (send message, accept request…) goes
  through the REST API so it is validated, persisted and authorized in one place; Socket.IO is
  then used to *push* the result to the other user instantly. This avoids dual-write bugs.
- **Offline delivery.** Messages are written to SQLite first. When the recipient reconnects,
  the server marks them *delivered*, notifies the sender (`message:delivered`) and replays them
  to the recipient (`message:new`); the client also refetches lists on reconnect.
- **Presence.** A user is online while ≥ 1 socket is attached; last-seen is persisted on the
  final disconnect. Stale connections are handled by Socket.IO's ping/pong.
- **Media.** Uploads are validated by MIME *and* magic bytes, stored under random UUID names,
  and served through an authenticated endpoint that only lets conversation participants
  download message media (avatars are public by design).
- **Video calls.** WebRTC with Google STUN; signaling (offer/answer/ICE) relays over
  Socket.IO. Call state (ringing → active → completed/declined/missed/cancelled) is persisted
  for the Calls tab. Server enforces a 45 s ring timeout and rejects calls to offline users
  with an immediate `unavailable` event.

---

## 🔌 API overview (all under `/api`)

| Method & path | Purpose |
|---|---|
| `POST /auth/register` `login` `refresh` `logout` | accounts & sessions |
| `GET /auth/me`, `PATCH /auth/profile`, `POST /auth/password`, `POST /auth/avatar` | profile |
| `POST /auth/reset/request`, `POST /auth/reset/confirm` | password reset |
| `GET /users/search?q=`, `GET /users/:id` | user discovery |
| `GET /contacts`, `GET /contacts/requests`, `POST /contacts/requests`, `POST …/accept`, `POST …/decline`, `DELETE /contacts/:id` | contacts |
| `GET /conversations`, `POST /conversations`, `GET/POST /conversations/:id/messages`, `POST /conversations/:id/read` | messaging |
| `POST /media/upload`, `GET /media/:filename` | media |
| `GET /calls` | call history |
| `GET /push/vapid`, `POST /push/subscribe`, `POST /push/unsubscribe` | web push |

**Socket events** — server → client: `presence`, `message:new`, `message:delivered`,
`message:read`, `typing`, `contact:request|accepted|declined|removed`, `call:incoming|accepted|
declined|cancelled|timeout|unavailable|ended|error`, `signal`.
Client → server: `call:invite|accept|decline|cancel|end`, `signal`, `typing`.

---

## 🔒 Security notes

- Passwords hashed with **bcrypt (12 rounds)**; refresh tokens stored **hashed** and rotated on
  every use (reuse of a rotated token revokes the chain).
- Every SQL query is parameterized; every input is validated server-side; JSON bodies are
  strictly schema-checked.
- Rate limiting on auth endpoints and the API; Helmet security headers; CSP; no inline scripts.
- Users can only read conversations they participate in, only modify their own profile, and
  only send messages to their contacts.
- Message images are served only to conversation participants; uploads are checked by content
  signature, not just the declared MIME type.
- Push notification payloads never contain message text (privacy).

**Production checklist** — set `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`, serve over HTTPS,
configure `SMTP_URL` for password-reset emails, and add a **TURN server** for calls that must
work across strict NATs:

```
JWT_ACCESS_SECRET=…
JWT_REFRESH_SECRET=…
SMTP_URL=smtps://user:pass@smtp.example.com:465
APP_BASE_URL=https://pulsechat.example.com
TURN_URLS=turn:turn.example.com:3478?transport=udp   # future: wired into RTC iceServers
```

---

## 🔑 Sign in with Google (Gmail)

Google sign-in is built in and activates automatically when a Google OAuth **Client ID** is set:

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
   → **Create credentials** → **OAuth client ID** → application type **Web application**.
2. Add your site as an **Authorized JavaScript origin** (e.g. `http://localhost:3000` or
   `https://pulsechat.example.com`).
3. Set the Client ID on the server:

   ```bash
   GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com npm start
   ```

4. The login & register screens now show **"Continue with Google"**.

How it works: the browser's Google Identity Services button returns a signed ID token; the
server verifies it (signature, issuer, audience and `email_verified`) with `google-auth-library`
and creates or logs into the matching PulseChat account. Google profile pictures are downloaded
and stored in PulseChat's own storage. Google-only accounts have no password and can only sign
in via Google (they can also use **Forgot password** to set one).

> Demo logins are **disabled by default** — everyone registers their own account
> (or signs in with Google). If you want an instant "try it" login on a staging
> deployment, set `DEMO_ACCOUNTS=[{"email":"…","password":"…","displayName":"…"}]`.

---

## 🔔 Push notifications

The server auto-generates a VAPID key pair on first boot (`data/vapid.json`). In the app,
Profile → *Push notifications* runs the browser opt-in flow, registers the service worker
(`/sw.js`) and stores the subscription server-side. Notifications are sent when the recipient
is fully offline, and show in the notification tray even when the app is in the background.

Requirements: **HTTPS** (or localhost) and a browser with Push support. Inside embedded
previews (sandboxed iframes) the browser may block Push/Notification — the app gracefully
falls back to in-app toasts.

---

## 🧪 Dev/testing: reset the data

While developing, stale test accounts can block signup ("account already
exists"). Two ways to start fresh:

- **One click:** start the server with `ALLOW_RESET=1` — the login screen
  shows a **"Testing? Start fresh — wipe all data"** button that clears every
  account/message/media. (It also enables `POST /api/dev/reset`.)
- **Auto on boot:** start with `RESET_DB_ON_START=1` to wipe the database
  every time the server starts — every deploy begins blank.

Both are OFF by default; never enable them in production.

## 🧪 Testing

- `test/e2e.test.js` — API-level scenarios (register/login/refresh, search, presence,
  friend requests, online + offline delivery, read receipts, pagination, media access
  control, call signaling + history, authorization boundaries).
- `test/ui.test.js` — Puppeteer with two isolated browser contexts acting as two users,
  driving the real UI, including a live WebRTC video call between them.

---

## 📄 License

MIT — use it, learn from it, build on it.
