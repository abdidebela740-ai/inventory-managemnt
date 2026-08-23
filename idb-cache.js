// ════════════════════════════════════════════════════════════════
// idb-cache.js — MOBILE/PERF FIX
//
// Minimal IndexedDB wrapper used to cache the last successfully-downloaded
// file for each storage-sync.js "slot" (inventory / mapping / amc /
// incoming / transit / pendingDispatch), keyed by that slot's uploaded_at
// timestamp. This lets storage-sync.js:
//   1. On launch, show whatever was cached last session IMMEDIATELY
//      (no network round trip), then
//   2. Check Supabase metadata in the background and only re-download the
//      actual file if the remote uploaded_at has actually changed.
//
// Deliberately dependency-free and defensive: every method resolves to
// null/false instead of throwing when IndexedDB is unavailable (private
// browsing, very old browsers, storage disabled by policy, etc.), so
// callers never need their own try/catch just to stay working exactly as
// before this file existed.
// ════════════════════════════════════════════════════════════════

const EpssIdbCache = (function () {
  const DB_NAME    = "epss-file-cache";
  const DB_VERSION = 1;
  const STORE      = "slots";

  let dbPromise = null;

  function hasIDB() {
    return typeof indexedDB !== "undefined";
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    if (!hasIDB()) return Promise.resolve(null);
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "slot" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(null); // fail soft — caller treats as cache miss
    });
    return dbPromise;
  }

  // Returns { slot, uploadedAt (ISO string|null), filename, blob } | null
  async function get(slot) {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(slot);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  // record: { uploadedAt (ISO string|null), filename, blob }
  async function set(slot, record) {
    const db = await openDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(Object.assign({ slot }, record));
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function del(slot) {
    const db = await openDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(slot);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  return { get, set, delete: del };
})();

// Exposed as a plain global (matches how this app's other small modules —
// auth.js, filters.js, etc. — attach themselves via window.* rather than
// ES modules), so storage-sync.js can use it with zero build-step changes.
window.EpssIdbCache = EpssIdbCache;
