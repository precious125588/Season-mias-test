# Pairing Server v2.0.2 — Critical session-survival fix (Apr 2026)

## 🚨 The Bug
Bots paired via this server were **logging out within 1-2 seconds** of first connect, forcing the user into an infinite re-pair loop.

## 🎯 Root Cause
After delivering the SESSION_ID, the server called `sock.logout()`. In Baileys, `logout()` is **destructive** — it sends an `<iq type="set"><remove-companion-device/></iq>` to WhatsApp telling it to **unlink the companion device that was just paired**. So the SESSION_ID's underlying device was gone before the bot ever used it. WhatsApp then disconnected the bot as `loggedOut` (401) within seconds.

## ✅ The Fix
Replaced every `sock.logout()` call with a non-destructive WebSocket close:

```js
try { sock.ws?.close?.(); } catch {}
try { sock.end?.(undefined); } catch {}
```

This drops the link from the pairing server's side WITHOUT unlinking the device. The SESSION_ID stays valid and the bot connects cleanly.

## Files touched
- `server.mjs` — pair-code flow (line ~166, 200)
- `server.mjs` — QR flow (line ~320, 340)
- `server.mjs` — failure paths (line ~225)

## Compatible with
- MIAS MDX Bot v4.9.1+ (which also has a defensive safety-net for already-paired-with-old-server users)

> 🛠️ Powered by 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x ⚡
