const $ = (id) => document.getElementById(id);
const moodSel = document.getElementById("mood");
const netSide = document.getElementById("netSide");
const swSide = document.getElementById("swSide");
const scoreSide = document.getElementById("scoreSide");


const el = {
  installBtn: $("installBtn"),
  pushBtn: $("pushBtn"),
  pushTestBtn: $("pushTestBtn"),
  netBadge: $("netBadge"),
  swBadge: $("swBadge"),

  threshold: $("threshold"),
  thresholdVal: $("thresholdVal"),
  enrollBtn: $("enrollBtn"),
  pinSet: $("pinSet"),
  savePinBtn: $("savePinBtn"),
  setupHint: $("setupHint"),

  unlockVoiceBtn: $("unlockVoiceBtn"),
  lockBtn: $("lockBtn"),
  pinTry: $("pinTry"),
  unlockPinBtn: $("unlockPinBtn"),
  lockHint: $("lockHint"),

  vaultCard: $("vaultCard"),
  title: $("title"),
  body: $("body"),
  addBtn: $("addBtn"),
  syncBtn: $("syncBtn"),
  list: $("list")
};

const DB_NAME = "whisperlock-db";
const DB_VER = 1;
const STORE_PROFILE = "profile";
const STORE_VAULT = "vault";
const STORE_OUT = "outbox";

const PROFILE_ID = "main";
let unlocked = false;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + String(Math.random()).slice(2);
}

function setNetBadge() {
  const on = navigator.onLine;
  el.netBadge.textContent = on ? "ONLINE" : "OFFLINE";
  el.netBadge.style.background = on ? "rgba(0,200,170,.12)" : "rgba(255,77,109,.12)";
  el.netBadge.style.borderColor = on ? "rgba(0,200,170,.25)" : "rgba(255,77,109,.35)";
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROFILE)) db.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_VAULT)) db.createObjectStore(STORE_VAULT, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_OUT)) db.createObjectStore(STORE_OUT, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).put(val);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const req = t.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const req = t.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbDel(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function getProfile() {
  return (await idbGet(STORE_PROFILE, PROFILE_ID)) || null;
}
async function saveProfile(p) {
  await idbPut(STORE_PROFILE, p);
}

function showUnlocked(isUnlocked) {
  unlocked = isUnlocked;
  el.vaultCard.hidden = !isUnlocked;
  el.lockBtn.disabled = !isUnlocked;
  el.lockHint.textContent = isUnlocked ? "Otključano ✅" : "Zaključano.";
}

async function renderList() {
  const items = await idbGetAll(STORE_VAULT);
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  el.list.innerHTML = "";
  for (const it of items) {
    const div = document.createElement("div");
    div.className = "item";
    const status = it.syncedAt ? "SYNCED" : "LOCAL";
    div.innerHTML = `
      <div><strong>${status}</strong> · ${new Date(it.createdAt).toLocaleString()}</div>
      <div class="meta">${it.title || "—"} · ${it.body || "—"}</div>
    `;
    el.list.appendChild(div);
  }
}

/* ---- Install prompt ---- */
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  el.installBtn.hidden = false;
});
el.installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  el.installBtn.hidden = true;
});

/* ---- SW register ---- */
async function registerSW() {
  if (!("serviceWorker" in navigator)) {
    el.swBadge.textContent = "SW: n/a";
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    el.swBadge.textContent = "SW: ok";
    return reg;
  } catch {
    el.swBadge.textContent = "SW: error";
    return null;
  }
}

/* ---- Voice signature (demo) ---- */
async function recordSignature(ms = 2000) {
  const canMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!canMic) throw new Error("mic-unavailable");

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new Error("mic-denied");
  }

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);

  const freq = new Uint8Array(analyser.frequencyBinCount);
  const time = new Float32Array(analyser.fftSize);

  const bins = 32;
  const specAcc = new Float32Array(bins);
  let frames = 0;

  const energy = [];
  const start = performance.now();

  while (performance.now() - start < ms) {
    analyser.getByteFrequencyData(freq);
    analyser.getFloatTimeDomainData(time);

    const step = Math.floor(freq.length / bins);
    for (let b = 0; b < bins; b++) {
      let sum = 0;
      const from = b * step;
      const to = (b === bins - 1) ? freq.length : (b + 1) * step;
      for (let i = from; i < to; i++) sum += freq[i];
      specAcc[b] += (sum / Math.max(1, (to - from)));
    }

    let s = 0;
    for (let i = 0; i < time.length; i++) s += time[i] * time[i];
    energy.push(Math.sqrt(s / time.length));

    frames += 1;
    await new Promise((r) => requestAnimationFrame(r));
  }

  for (const tr of stream.getTracks()) tr.stop();
  await ctx.close().catch(() => {});

  const spec = Array.from(specAcc, (v) => v / Math.max(1, frames));

  const targetE = 20;
  const e = new Array(targetE).fill(0);
  const chunk = Math.max(1, Math.floor(energy.length / targetE));
  for (let i = 0; i < targetE; i++) {
    const from = i * chunk;
    const to = (i === targetE - 1) ? energy.length : (i + 1) * chunk;
    let sum = 0;
    for (let k = from; k < to; k++) sum += energy[k] || 0;
    e[i] = sum / Math.max(1, (to - from));
  }

  const vec = spec.concat(e).map((x) => Number.isFinite(x) ? x : 0);
  const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/* ---- PIN (hash) ---- */
async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function salt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---- Outbox + sync ---- */
async function queueOutbox(entry) {
  await idbPut(STORE_OUT, entry);

  // KLJUČNO: registriraj background sync odmah nakon spremanja u IndexedDB (kao u gradivu)
  // da radi i ako zatvoriš tab. 
  if ("serviceWorker" in navigator && "SyncManager" in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register("sync-whisperlock");
    } catch {
      // fallback je "Sync sada" gumb
    }
  }
}

async function flushOutbox(reg) {
  if (!navigator.onLine) return;

  const out = await idbGetAll(STORE_OUT);
  if (out.length === 0) return;

  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: out })
    });
    if (!res.ok) throw new Error("sync-failed");
    const data = await res.json();
    const syncedAt = data?.syncedAt || new Date().toISOString();
    const ids = Array.isArray(data?.syncedIds) ? data.syncedIds : [];

    for (const id of ids) {
      const all = await idbGetAll(STORE_VAULT);
      const found = all.find((x) => x.id === id);
      if (found) await idbPut(STORE_VAULT, { ...found, syncedAt });
      await idbDel(STORE_OUT, id);
    }
  } catch {
    if (reg?.sync) {
      try { await reg.sync.register("sync-whisperlock"); } catch {}
    }
  }
}

/* ---- Push ---- */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function enablePush(reg) {
  if (!reg || !("PushManager" in window) || !("Notification" in window)) return;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return;

  const r = await fetch("/api/vapidPublicKey");
  const { key } = await r.json();

  const applicationServerKey = urlBase64ToUint8Array(key);
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });

  await fetch("/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub })
  });

  el.pushTestBtn.disabled = false;
}

/* ---- UI ---- */
el.thresholdVal.textContent = el.threshold.value;
el.threshold.addEventListener("input", () => { el.thresholdVal.textContent = el.threshold.value; });

el.savePinBtn.addEventListener("click", async () => {
  const pin = (el.pinSet.value || "").trim();
  if (pin.length < 4 || pin.length > 8) {
    el.setupHint.textContent = "PIN mora imati 4–8 znamenki.";
    return;
  }
  const prof = (await getProfile()) || { id: PROFILE_ID };
  prof.pinSalt = salt();
  prof.pinHash = await sha256Hex(`${prof.pinSalt}:${pin}`);
  await saveProfile(prof);
  el.pinSet.value = "";
  el.setupHint.textContent = "PIN spremljen.";
});

el.enrollBtn.addEventListener("click", async () => {
  const prof = (await getProfile()) || { id: PROFILE_ID };
  try {
    const vec = await recordSignature(2000);
    prof.voiceTemplate = vec;
    prof.threshold = Number(el.threshold.value);
    await saveProfile(prof);
    el.setupHint.textContent = "Lock fraza spremljena. Otključavanje glasom je spremno.";
  } catch (e) {
    el.setupHint.textContent =
      e?.message === "mic-denied" ? "Mikrofon odbijen — koristi PIN." : "Mikrofon nije dostupan — koristi PIN.";
  }
});

el.unlockVoiceBtn.addEventListener("click", async () => {
  const prof = await getProfile();
  if (!prof?.voiceTemplate) {
    el.lockHint.textContent = "Nema spremljene lock fraze. Prvo postavi lock.";
    return;
  }
  try {
    const cur = await recordSignature(2000);
    const s = cosine(prof.voiceTemplate, cur);
    const thr = Number(prof.threshold || 0.92);
    if (s >= thr) {
      showUnlocked(true);
      el.lockHint.textContent = `Otključano glasom (score ${s.toFixed(2)}).`;
      await renderList();
    } else {
      showUnlocked(false);
      el.lockHint.textContent = `Nije prošlo (score ${s.toFixed(2)} < ${thr.toFixed(2)}). Probaj opet ili PIN.`;
    }
  } catch (e) {
    showUnlocked(false);
    el.lockHint.textContent =
      e?.message === "mic-denied" ? "Mikrofon odbijen — koristi PIN." : "Mikrofon nije dostupan — koristi PIN.";
  }
});

el.unlockPinBtn.addEventListener("click", async () => {
  const pin = (el.pinTry.value || "").trim();
  const prof = await getProfile();
  if (!prof?.pinSalt || !prof?.pinHash) {
    el.lockHint.textContent = "PIN nije postavljen.";
    return;
  }
  const h = await sha256Hex(`${prof.pinSalt}:${pin}`);
  if (h === prof.pinHash) {
    showUnlocked(true);
    el.lockHint.textContent = "Otključano PIN-om ✅";
    el.pinTry.value = "";
    await renderList();
  } else {
    showUnlocked(false);
    el.lockHint.textContent = "Pogrešan PIN.";
  }
});

el.lockBtn.addEventListener("click", () => showUnlocked(false));

el.addBtn.addEventListener("click", async () => {
  if (!unlocked) return;
  const title = (el.title.value || "").trim();
  const body = (el.body.value || "").trim();
  if (!title && !body) return;

  const entry = { id: uid(), title, body, createdAt: new Date().toISOString() };

  await idbPut(STORE_VAULT, entry);
  await queueOutbox(entry);
  el.title.value = "";
  el.body.value = "";
  await renderList();
});

(async function main() {
  setNetBadge();
  window.addEventListener("online", setNetBadge);
  window.addEventListener("offline", setNetBadge);

  const reg = await registerSW();

  el.syncBtn.addEventListener("click", async () => {
    await flushOutbox(reg);
    await renderList();
  });

  // Kad se vrati mreža, pokušaj sync + refresh liste
  window.addEventListener("online", async () => {
    await flushOutbox(reg);
    if (unlocked) await renderList();
  });

  // Push gumbi: graceful degradation
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    el.pushBtn.disabled = true;
    el.pushTestBtn.disabled = true;
  } else {
    el.pushBtn.addEventListener("click", async () => enablePush(reg));
    el.pushTestBtn.addEventListener("click", async () => {
      await fetch("/api/push-test", { method: "POST" });
    });
  }

  showUnlocked(false);
})();