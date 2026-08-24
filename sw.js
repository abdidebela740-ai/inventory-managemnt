// ════════════════════════════════════════════════════════════════
// sw.js — Service Worker for EPSS Stock-Multiple
//
// Strategy:
//   • App shell / static assets (HTML, CSS, JS, icons, fonts) → Cache First,
//     falling back to network, then to the offline page for navigations.
//   • Supabase / any cross-origin API calls → Network First, falling back
//     to cache (read-only GETs only) or a JSON error payload.
//   • Third-party CDN libraries (xlsx, plotly, supabase-js) → Stale-While-
//     Revalidate: serve cached copy instantly, refresh in the background.
//
// IMPORTANT: bump CACHE_VERSION on every deploy that changes any cached
// file. This is what forces old clients to pick up new files.
// ════════════════════════════════════════════════════════════════

const CACHE_VERSION   = "v1.2.0";                 // ⬅ bump this on every release
const STATIC_CACHE    = `epss-static-${CACHE_VERSION}`;
const RUNTIME_CACHE   = `epss-runtime-${CACHE_VERSION}`;
const CDN_CACHE        = `epss-cdn-${CACHE_VERSION}`;
const OFFLINE_URL      = "offline.html";

// ── Files that make up the "app shell". Keep this list in sync with what
// actually ships. Missing a file here just means it's fetched normally on
// first load and cached afterwards — it will NOT break the install step,
// because we install files individually (see addAllSafe below).
const APP_SHELL = [
  "./",
  "index.html",
  "pharma-alloc.html",
  "offline.html",
  "style.css",
  "manifest.json",

  // Core app scripts
  "auth.js",
  "settings-menu.js",
  "idle-logout.js",
  "storage-sync.js",
  "pending-dispatch.js",
  "filters.js",
  "permissions.js",
  "user-management.js",
  "script.js",
  "mos.js",
  "storage-locations.js",
  "branch-demand.js",
  "request-analysis.js",
  "national-table.js",
  "expiry-risk.js",
  "stockout-risk.js",
  "who-responsible.js",
  "shelf-life.js",
  "alloc-script.js",

  // PERF FIX: worker + IndexedDB cache helper (see xlsx-worker.js,
  // idb-cache.js). Precached like any other app-shell script so the
  // off-main-thread parsing path is available immediately, including
  // offline / first-paint-before-network scenarios.
  "xlsx-worker.js",
  "idb-cache.js",

  // Mobile/PWA scripts
  "pwa-mobile.css",
  "pwa-mobile-nav.js",
  "pwa-register.js",

  // Icons
  "epss-logo.png",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];

// Third-party CDN assets used by the app (kept separate so they can use a
// different, longer-lived strategy without polluting the app-shell cache).
const CDN_URLS = [
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.26.0/plotly.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
];

// ════════════════════════════════════════════════════════════════
// INSTALL — pre-cache the app shell. Uses per-file catch so ONE missing
// or renamed file (e.g. you removed a page) never aborts the whole install.
// ════════════════════════════════════════════════════════════════
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("[sw] skip pre-cache (not found yet):", url, err.message);
          })
        )
      );
      // Pre-warm CDN cache too, best-effort.
      const cdnCache = await caches.open(CDN_CACHE);
      await Promise.all(
        CDN_URLS.map((url) =>
          fetch(url, { mode: "cors" })
            .then((res) => res.ok && cdnCache.put(url, res))
            .catch(() => {})
        )
      );
      // Activate this SW as soon as it finishes installing (no waiting on
      // old tabs to close). Combined with clients.claim() below.
      self.skipWaiting();
    })()
  );
});

// ════════════════════════════════════════════════════════════════
// ACTIVATE — clean up old-version caches, take control of open pages.
// ════════════════════════════════════════════════════════════════
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => ![STATIC_CACHE, RUNTIME_CACHE, CDN_CACHE].includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

// Any request that should NEVER be cached (auth/session mutations, writes).
function isNonCacheableApiCall(request, url) {
  if (request.method !== "GET") return true; // never cache POST/PUT/PATCH/DELETE
  if (url.pathname.includes("/auth/v1/")) return true; // supabase auth endpoints
  if (url.pathname.includes("/functions/v1/")) return true; // edge functions: always live
  return false;
}

function isSupabaseRequest(url) {
  return url.hostname.endsWith(".supabase.co");
}

function isCdnRequest(url) {
  return CDN_URLS.some((cdnUrl) => cdnUrl.startsWith(url.origin) || url.href.startsWith(cdnUrl.split("?")[0]));
}

// ── Network First (for Supabase reads: fresh data always wins, cache is
// only a fallback for brief network blips / offline viewing of last-seen data)
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // No cache, no network — return a structured JSON error so the app's
    // own error handling (not a browser error page) can react to it.
    return new Response(
      JSON.stringify({ error: true, offline: true, message: "You are offline. Showing no data for this request." }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ── Cache First (for static assets: instant load, network only on cache miss)
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    throw err;
  }
}

// ── Stale While Revalidate (for CDN libraries: instant load from cache,
// silently refreshed in background so updates are picked up next visit)
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse && networkResponse.ok) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);
  return cached || (await networkPromise) || Response.error();
}

// ════════════════════════════════════════════════════════════════
// FETCH — route each request to the right strategy.
// ════════════════════════════════════════════════════════════════
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET-navigable http(s) requests; let everything else
  // (chrome-extension:, blob:, websockets, etc.) pass through untouched.
  if (!request.url.startsWith("http")) return;

  // ── 1) Supabase API/database calls → Network First, never cache writes
  //       or auth/edge-function calls (always must hit the network live).
  if (isSupabaseRequest(url)) {
    if (isNonCacheableApiCall(request, url)) {
      // Let it hit the network directly; if it fails, surface the real
      // network error so auth.js / the app's own offline handling can react.
      event.respondWith(fetch(request));
      return;
    }
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  // ── 2) Third-party CDN libraries → Stale While Revalidate
  if (isCdnRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // ── 3) Page navigations (typing URL, reload, "Open app" from home screen)
  //       → try network first for freshest HTML, fall back to cache, then
  //       to the offline page if nothing is available at all.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          const cache = await caches.open(STATIC_CACHE);
          cache.put(request, networkResponse.clone());
          return networkResponse;
        } catch (err) {
          const cache = await caches.open(STATIC_CACHE);
          const cached = await cache.match(request) || await cache.match("index.html");
          return cached || cache.match(OFFLINE_URL);
        }
      })()
    );
    return;
  }

  // ── 4) Same-origin static assets (JS/CSS/images/fonts) → Cache First
  if (url.origin === self.location.origin) {
    event.respondWith(
      cacheFirst(request, STATIC_CACHE).catch(async () => {
        const cache = await caches.open(STATIC_CACHE);
        return (await cache.match(OFFLINE_URL)) || Response.error();
      })
    );
    return;
  }

  // ── 5) Anything else cross-origin (fonts, misc CDNs) → best-effort
  //       Stale While Revalidate so it still works offline once seen once.
  event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
});

// ════════════════════════════════════════════════════════════════
// MESSAGE — allow the page to trigger skipWaiting() from an
// "Update available" prompt (see pwa-register.js).
// ════════════════════════════════════════════════════════════════
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
