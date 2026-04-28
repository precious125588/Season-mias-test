// ════════════════════════════════════════════════════════════════════
//  MIAS MDX — Pairing Server (v2.0 — Reliability Patch)
//  Generates real, validated SESSION_IDs for the bot.
//  Output format:  prezzy_<base64(creds.json)>
// ════════════════════════════════════════════════════════════════════
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pino from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Logger (silent for Baileys, info for app) ─────────────────────
const silentLogger = pino({ level: "fatal" }).child({ level: "fatal" });
const log = (...a) => console.log(new Date().toISOString().split("T")[1].slice(0, 8), "—", ...a);

// ─── Helpers ───────────────────────────────────────────────────────
function removeFile(fp) {
  try { if (fs.existsSync(fp)) fs.rmSync(fp, { recursive: true, force: true }); } catch {}
}

/**
 * Build the prezzy_ session string from a fully-paired auth dir.
 * Returns null if the creds aren't ready yet (e.g. keys not flushed).
 *
 * A "real" session must have:  noiseKey, signedIdentityKey,
 * signedPreKey, registrationId (number), me (object with id), account.
 * If any of these are missing, the bot will fail to reconnect — so we
 * refuse to hand out a half-baked session.
 */
function buildPrezzySession(dir) {
  try {
    const credsPath = path.join(dir, "creds.json");
    if (!fs.existsSync(credsPath)) return { ok: false, reason: "creds.json missing" };
    const raw = fs.readFileSync(credsPath, "utf8");
    let creds;
    try { creds = JSON.parse(raw); } catch { return { ok: false, reason: "creds.json invalid JSON" }; }

    const required = {
      noiseKey: !!creds.noiseKey,
      signedIdentityKey: !!creds.signedIdentityKey,
      signedPreKey: !!creds.signedPreKey,
      registrationId: typeof creds.registrationId === "number",
      me: !!creds.me?.id,
      account: !!creds.account,
    };
    const missing = Object.entries(required).filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) return { ok: false, reason: `incomplete creds (missing: ${missing.join(", ")})` };

    // Real, complete session.
    const sessionId = "prezzy_" + Buffer.from(raw).toString("base64");
    return { ok: true, sessionId, phone: creds.me.id.split("@")[0].split(":")[0], name: creds.me.name || "" };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/**
 * Wait for the session to be FULLY ready (all keys flushed to disk).
 * Polls every 250ms up to ~8s. Without this, a too-early read returns
 * partial creds and the bot fails to reconnect ("invalid session").
 */
async function waitForRealSession(dir, maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = buildPrezzySession(dir);
    if (r.ok) return r;
    await delay(250);
  }
  return buildPrezzySession(dir);
}

// ─── Serve pair.html at root ───────────────────────────────────────
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "pair.html")));

// ─── Health ────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ─── Pair Code Route ───────────────────────────────────────────────
app.get("/pair", async (req, res) => {
  let num = req.query.number;
  if (!num) return res.status(400).json({ error: "Missing ?number= parameter" });

  // Sanitise + validate phone number (E.164, no +)
  num = String(num).replace(/[^0-9]/g, "");
  const phone = pn("+" + num);
  if (!phone.isValid()) {
    return res.status(400).json({ error: "Invalid phone number. Use full international format (e.g. 2348012345678)" });
  }
  num = phone.getNumber("e164").replace("+", "");

  const dirs = path.join(__dirname, "_sessions", "pair_" + num + "_" + Date.now());
  removeFile(dirs);
  fs.mkdirSync(dirs, { recursive: true });

  let attempts = 0;
  const MAX_ATTEMPTS = 3;

  async function initiateSession() {
    attempts++;
    const { state, saveCreds } = await useMultiFileAuthState(dirs);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use bundled */ }

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
      printQRInTerminal: false,
      logger: silentLogger,
      // Browser fingerprint: WhatsApp pair-code endpoint accepts the
      // Chrome/Windows fingerprint most reliably right now.
      browser: Browsers.windows("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 30_000,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 250,
      qrTimeout: 60_000,
      getMessage: async () => ({ conversation: "" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, isNewLogin } = update;

      if (isNewLogin) log("🔐 New login via pair code — phone confirmed link");

      if (connection === "open") {
        log("✅ Connected — generating real session...");
        try {
          // Wait for ALL keys to be flushed to disk before encoding.
          // This is the critical fix for "session isn't real".
          const result = await waitForRealSession(dirs, 8000);
          if (!result.ok) {
            log("❌ Session not ready:", result.reason);
            if (!res.headersSent) res.status(500).json({ error: "Session generation failed: " + result.reason });
            try { await sock.logout().catch(() => {}); } catch {}
            removeFile(dirs);
            return;
          }

          const userJid = jidNormalizedUser(result.phone + "@s.whatsapp.net");

          // Send the SESSION_ID first, then the explainer.
          await sock.sendMessage(userJid, { text: result.sessionId });
          await sock.sendMessage(userJid, {
            text:
              `✅ *Your MIAS MDX SESSION_ID is ready!*\n\n` +
              `Copy the message above ☝️ and paste it into your bot's \`.env\` file as:\n\n` +
              `\`SESSION_ID=prezzy_...\`\n\n` +
              `🔐 Verified: registrationId, noiseKey, signedPreKey, account ✓\n` +
              `📱 Phone: +${result.phone}\n` +
              `⚠️ *Keep it private — never share with anyone.*\n\n` +
              `> ᴘᴏᴡᴇʀᴇᴅ ʙʏ *𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x* ⚡`,
          });
          log("📤 SESSION_ID delivered to +" + result.phone);

          if (!res.headersSent) res.json({ success: true, session: result.sessionId, phone: result.phone, message: "Session sent to your WhatsApp" });

          // Politely close the link from this side after a short pause
          // so the bot can reconnect with the new session cleanly.
          await delay(1500);
          try { await sock.logout(); } catch {}
        } catch (err) {
          log("❌ Error during session generation:", err?.message || err);
          if (!res.headersSent) res.status(500).json({ error: "Error generating session: " + (err?.message || err) });
        } finally {
          await delay(500);
          removeFile(dirs);
        }
      }

      if (connection === "close") {
        const sc = lastDisconnect?.error?.output?.statusCode;
        if (sc === DisconnectReason.loggedOut || sc === 401) {
          log("🚪 Logged out — clearing");
          removeFile(dirs);
        } else if (sc === DisconnectReason.restartRequired || sc === 515) {
          log("🔁 Restart required — reconnecting");
          if (attempts < MAX_ATTEMPTS) setTimeout(() => initiateSession().catch(() => {}), 1500);
        } else if (attempts < MAX_ATTEMPTS && !res.headersSent) {
          log(`🔁 Reconnect attempt ${attempts}/${MAX_ATTEMPTS} (code=${sc})`);
          setTimeout(() => initiateSession().catch(() => {}), 2000);
        }
      }
    });

    // Request the pairing code (only if not already registered)
    if (!sock.authState.creds.registered) {
      // Wait for the socket to be ready to accept the request.
      await delay(3000);
      try {
        let code = await sock.requestPairingCode(num);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        if (!res.headersSent) {
          log({ phone: num, code });
          res.json({ code, message: "Open WhatsApp → Linked Devices → Link with phone number → enter this code" });
        }
      } catch (err) {
        log("❌ Pairing code request failed:", err?.message || err);
        if (!res.headersSent) res.status(503).json({ error: "Failed to get pairing code. Check your number and try again." });
        try { await sock.logout().catch(() => {}); } catch {}
        removeFile(dirs);
      }
    }
  }

  try { await initiateSession(); } catch (err) {
    log("❌ initiateSession threw:", err?.message || err);
    if (!res.headersSent) res.status(503).json({ error: "Service unavailable" });
    removeFile(dirs);
  }
});

// ─── QR Code Route ─────────────────────────────────────────────────
app.get("/qr", async (_req, res) => {
  const sessionTag = Date.now().toString() + "_" + Math.random().toString(36).slice(2, 10);
  const dirs = path.join(__dirname, "_sessions", "qr_" + sessionTag);
  fs.mkdirSync(dirs, { recursive: true });

  let responseSent = false;
  let qrSent = false;
  let reconnectAttempts = 0;

  async function initiateSession() {
    const { state, saveCreds } = await useMultiFileAuthState(dirs);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use bundled */ }

    const socketConfig = {
      version,
      logger: silentLogger,
      browser: Browsers.windows("Chrome"),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 30_000,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 250,
      qrTimeout: 60_000,
      printQRInTerminal: false,
      getMessage: async () => ({ conversation: "" }),
    };

    let sock = makeWASocket(socketConfig);

    const handleUpdate = async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !qrSent) {
        qrSent = true;
        try {
          const qrDataURL = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: "M", type: "image/png", quality: 0.92, margin: 2,
            color: { dark: "#000000", light: "#FFFFFF" },
          });
          if (!responseSent) {
            responseSent = true;
            res.json({ qr: qrDataURL, message: "Open WhatsApp → Linked Devices → Link a Device → scan this code" });
            log("📷 QR sent — waiting for scan...");
          }
        } catch (e) {
          if (!responseSent) {
            responseSent = true;
            res.status(500).json({ error: "Failed to generate QR code: " + (e?.message || e) });
          }
        }
      }

      if (connection === "open") {
        log("✅ Connected via QR — generating real session...");
        try {
          const result = await waitForRealSession(dirs, 8000);
          if (!result.ok) {
            log("❌ Session not ready:", result.reason);
            try { await sock.logout().catch(() => {}); } catch {}
            return;
          }
          const userJid = jidNormalizedUser(result.phone + "@s.whatsapp.net");
          await sock.sendMessage(userJid, { text: result.sessionId });
          await sock.sendMessage(userJid, {
            text:
              `✅ *Your MIAS MDX SESSION_ID is ready!*\n\n` +
              `Copy the message above ☝️ and paste it into your bot's \`.env\` file as:\n\n` +
              `\`SESSION_ID=prezzy_...\`\n\n` +
              `🔐 Verified: registrationId, noiseKey, signedPreKey, account ✓\n` +
              `📱 Phone: +${result.phone}\n` +
              `⚠️ *Keep it private — never share with anyone.*\n\n` +
              `> ᴘᴏᴡᴇʀᴇᴅ ʙʏ *𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x* ⚡`,
          });
          log("📤 SESSION_ID delivered to +" + result.phone);
          await delay(1500);
          try { await sock.logout(); } catch {}
        } catch (e) {
          log("❌ QR flow error:", e?.message || e);
        } finally {
          setTimeout(() => removeFile(dirs), 10_000);
        }
      }

      if (connection === "close") {
        const sc = lastDisconnect?.error?.output?.statusCode;
        if (sc === DisconnectReason.loggedOut || sc === 401) {
          removeFile(dirs);
        } else if ((sc === 515 || sc === 503 || sc === DisconnectReason.restartRequired) && ++reconnectAttempts <= 3) {
          setTimeout(() => {
            try {
              sock = makeWASocket(socketConfig);
              sock.ev.on("connection.update", handleUpdate);
              sock.ev.on("creds.update", saveCreds);
            } catch {}
          }, 2000);
        } else if (!responseSent) {
          responseSent = true;
          res.status(503).json({ error: "Connection failed (code " + (sc || "unknown") + ")" });
        }
      }
    };

    sock.ev.on("connection.update", handleUpdate);
    sock.ev.on("creds.update", saveCreds);
  }

  try { await initiateSession(); } catch (err) {
    log("❌ initiateSession threw:", err?.message || err);
    if (!responseSent) { responseSent = true; res.status(503).json({ error: "Service unavailable" }); }
    removeFile(dirs);
  }
});

// ─── Validate Route ────────────────────────────────────────────────
// Lets the user paste a session string and see if it's "real".
app.post("/validate", (req, res) => {
  const { session } = req.body || {};
  if (!session || typeof session !== "string" || session.trim().length < 10) {
    return res.json({ valid: false, error: "Empty or too short" });
  }
  const raw = session.trim();
  try {
    const b64 = raw.startsWith("prezzy_") ? raw.slice(7) : raw;
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    // Support both creds-only AND legacy multi-file format
    let creds = parsed["creds.json"]
      ? (typeof parsed["creds.json"] === "string" ? JSON.parse(parsed["creds.json"]) : parsed["creds.json"])
      : parsed;
    const checks = {
      hasNoiseKey: !!creds.noiseKey,
      hasSignedIdentityKey: !!creds.signedIdentityKey,
      hasSignedPreKey: !!creds.signedPreKey,
      hasRegistrationId: typeof creds.registrationId === "number",
      isRegistered: creds.registered === true,
      hasMe: !!creds.me,
      hasAccount: !!creds.account,
    };
    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.keys(checks).length;
    const valid = passed >= 5;
    let phoneNumber = null;
    if (creds.me?.id) phoneNumber = creds.me.id.split("@")[0].split(":")[0];
    return res.json({
      valid, score: `${passed}/${total}`, phone: phoneNumber,
      registered: creds.registered || false, checks,
      message: valid ? "✅ Session is valid and ready to use!" : "❌ Session is invalid or corrupted. Generate a new one.",
    });
  } catch {
    return res.json({ valid: false, error: "Invalid format", message: "❌ Not a valid prezzy_ session string." });
  }
});

// ─── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`🚀 MIAS MDX Pairing Server v2.0 running on port ${PORT}`));

// ─── Global error handler ──────────────────────────────────────────
process.on("uncaughtException", (err) => {
  const e = String(err);
  const ignore = [
    "conflict", "not-authorized", "Socket connection timeout",
    "rate-overlimit", "Connection Closed", "Timed Out", "Value not found",
    "Stream Errored", "statusCode: 515", "statusCode: 503",
  ];
  if (ignore.some((i) => e.includes(i))) return;
  console.log("Caught exception:", err);
});
process.on("unhandledRejection", (r) => {
  const e = String(r?.message || r);
  if (/conflict|timeout|Connection Closed|rate-overlimit/i.test(e)) return;
  console.log("Unhandled rejection:", r);
});
