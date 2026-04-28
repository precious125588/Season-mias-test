# MIAS MDX Pairing Server — v2.0 Reliability Patch

## What changed

The pairing server was rewritten to make sessions **actually real and complete** before they're handed out. It also handles WhatsApp's flaky pair-code endpoint better.

### 1. Real session validation before delivery
Before, the server read `creds.json` 3 seconds after `connection === "open"` and shipped whatever it found. If WhatsApp hadn't flushed all the keys yet (which happens on slow links), you got a half-baked session that the bot couldn't reconnect with.

Now the server **polls for a real session for up to 8 seconds**, checking that ALL six required fields are present:
- `noiseKey` ✓
- `signedIdentityKey` ✓
- `signedPreKey` ✓
- `registrationId` (must be a number) ✓
- `me.id` (must exist) ✓
- `account` ✓

If any are missing after 8s, the server returns a clear error instead of shipping a broken session.

### 2. Better browser fingerprint + pair-code timing
- Uses `Browsers.windows("Chrome")` — what WhatsApp's pair endpoint accepts most reliably right now
- Waits 3s after socket creation before requesting the pair code (so the noise handshake completes first)
- Adds `qrTimeout: 60_000` so QR codes don't expire mid-scan

### 3. Auto-reconnect with cap
Pair code flow now retries up to 3 times on `restartRequired` (515) without spamming. After that, it gives up cleanly.

### 4. Cleaner session output
- Sends only `creds.json` base64-encoded (smaller, faster)
- Format: `prezzy_<base64(creds.json)>` — what your bot's `restoreSession` expects
- Two messages sent to user's DM:
  1. The raw SESSION_ID (easy to copy)
  2. Explainer with phone confirmation + verification badges

### 5. Cleaner error handling
- Phone validation up front (rejects junk before opening a socket)
- Each session goes in its own `_sessions/...` subfolder so concurrent users don't clash
- Always cleans up the auth dir, even on errors
- Silent ignore for known-noisy WhatsApp errors (515, 503, etc.)

### 6. Faster timeouts
| Option | Before | After |
|---|---|---|
| `defaultQueryTimeoutMs` | 60s | 30s |
| `connectTimeoutMs` | 60s | 30s |
| `keepAliveIntervalMs` | 30s | 25s |

## What did NOT change

- Routes: `/`, `/healthz`, `/pair?number=...`, `/qr`, `/validate` — same names, same params
- `pair.html` — your existing UI is untouched
- Output format: `prezzy_<base64>` — exactly what your bot reads
- `package.json` deps — same Baileys version, same engines
- Render / Railway deploy config — drop-in replacement

## Deploy

Same as before:
```bash
npm install
npm start
```

The server listens on `process.env.PORT || 3000`.
