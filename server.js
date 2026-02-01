import express from "express";
import fs from "fs";
import path from "path";
import webpush from "web-push";

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(process.cwd(), "data");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const SYNC_FILE = path.join(DATA_DIR, "synced-entries.json");
const VAPID_FILE = path.join(DATA_DIR, "vapid.json");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

ensureDir(DATA_DIR);

function getVapid() {
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:whisperlock@example.com";

  if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv, subject };

  const stored = readJson(VAPID_FILE, null);
  if (stored?.publicKey && stored?.privateKey) return stored;

  const keys = webpush.generateVAPIDKeys();
  const out = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
  writeJson(VAPID_FILE, out);
  return out;
}

const vapid = getVapid();
webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(process.cwd(), "public"), { extensions: ["html"] }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/vapidPublicKey", (_req, res) => res.json({ key: vapid.publicKey }));

app.post("/api/subscribe", (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ ok: false });

  const subs = readJson(SUBS_FILE, []);
  const exists = subs.some((s) => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push(sub);
    writeJson(SUBS_FILE, subs);
  }
  res.json({ ok: true });
});

app.post("/api/sync", async (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (entries.length === 0) return res.json({ ok: true, syncedIds: [] });

  const now = new Date().toISOString();
  const stored = readJson(SYNC_FILE, []);
  const syncedIds = [];

  for (const e of entries) {
    if (!e?.id) continue;
    syncedIds.push(e.id);
    // ne spremamo audio/voice — samo tekst i meta
    stored.push({ ...e, syncedAt: now });
  }
  writeJson(SYNC_FILE, stored);

  const subs = readJson(SUBS_FILE, []);
  const payload = JSON.stringify({
    title: "Moj tajni dnevnik",
    body: `Backup završen: ${syncedIds.length} unosa`,
    url: "/"
  });

  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch {
      // ignore invalid/expired subscription
    }
  }
  writeJson(SUBS_FILE, stillValid);

  res.json({ ok: true, syncedIds, syncedAt: now });
});

// (Opcionalno, ali zgodno za demo push-a)
app.post("/api/push-test", async (_req, res) => {
  const subs = readJson(SUBS_FILE, []);
  const payload = JSON.stringify({ title: "Moj tajni dnevnik", body: "Test push je stigao ✅", url: "/" });

  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch {}
  }
  writeJson(SUBS_FILE, stillValid);

  res.json({ ok: true });
});

app.listen(PORT);