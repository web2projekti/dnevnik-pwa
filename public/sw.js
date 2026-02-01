const APP_CACHE = "wl-app-shell-v1";
const API_CACHE = "wl-api-v1";

const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/sw.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

const DB_NAME = "whisperlock-db";
const DB_VER = 1;
const STORE_VAULT = "vault";
const STORE_OUT = "outbox";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VAULT)) db.createObjectStore(STORE_VAULT, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_OUT)) db.createObjectStore(STORE_OUT, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
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
async function idbPut(store, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).put(val);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
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

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(PRECACHE);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === APP_CACHE || k === API_CACHE) ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

async function cacheFirst(req) {
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(API_CACHE);
  const hit = await cache.match(req);

  const fetchPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  return hit || (await fetchPromise) || new Response(JSON.stringify({ ok: false }), {
    headers: { "Content-Type": "application/json" }
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.mode === "navigate") {
    event.respondWith(cacheFirst("/index.html"));
    return;
  }

  if (url.pathname.startsWith("/api/") && req.method === "GET") {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (req.method === "GET") event.respondWith(cacheFirst(req));
});

self.addEventListener("sync", (event) => {
  if (event.tag !== "sync-whisperlock") return;

  event.waitUntil((async () => {
    const out = await idbGetAll(STORE_OUT);
    if (out.length === 0) return;

    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: out })
    });
    if (!res.ok) return;

    const data = await res.json();
    const syncedAt = data?.syncedAt || new Date().toISOString();
    const ids = Array.isArray(data?.syncedIds) ? data.syncedIds : [];

    const vault = await idbGetAll(STORE_VAULT);
    for (const id of ids) {
      const found = vault.find((x) => x.id === id);
      if (found) await idbPut(STORE_VAULT, { ...found, syncedAt });
      await idbDel(STORE_OUT, id);
    }
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = { title: "WhisperLock", body: "Obavijest.", url: "/" };
    try { if (event.data) data = event.data.json(); } catch {}
    await self.registration.showNotification(data.title || "WhisperLock", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { await c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});