// ════════════════════════════════════════════════════════════════
// idle-logout.js — automatically signs the user out after 8 hours
// of inactivity (no mouse, keyboard, scroll, or touch activity).
//
// Idle time is tracked via a timestamp in localStorage (not just a
// live in-memory timer), so it correctly counts inactivity even if
// the tab is closed and reopened, the laptop sleeps, or the user has
// multiple tabs open — any activity in ANY tab resets the clock for
// all of them, since they share the same origin's localStorage.
//
// Runs AFTER auth.js (needs window.supabaseClient) and listens for
// the same "epss-auth-ready" event storage-sync.js uses, so it only
// starts tracking once a real session exists.
// ════════════════════════════════════════════════════════════════

(function idleLogoutModule() {
  const IDLE_LIMIT_MS   = 8 * 60 * 60 * 1000; // 8 hours
  const STORAGE_KEY     = "epss-last-activity";
  const CHECK_INTERVAL_MS = 60 * 1000;        // re-check every minute
  const THROTTLE_MS     = 5000;               // don't hit localStorage on every mousemove
  const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];

  let lastWrite  = 0;
  let checkTimer = null;

  function recordActivity() {
    const now = Date.now();
    if (now - lastWrite < THROTTLE_MS) return;
    lastWrite = now;
    try { localStorage.setItem(STORAGE_KEY, String(now)); } catch (e) { /* private mode / quota — ignore */ }
  }

  function getLastActivity() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    const n = raw ? Number(raw) : Date.now();
    return Number.isFinite(n) ? n : Date.now();
  }

  function stopTracking() {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = null;
    ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, recordActivity, true));
  }

  function showIdleOverlay() {
    if (document.getElementById("idle-logout-overlay")) return;
    const el = document.createElement("div");
    el.id = "idle-logout-overlay";
    el.style.cssText = `
      position: fixed; inset: 0; z-index: 20000;
      background: rgba(10,14,20,0.92); color: #fff;
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 14px; text-align: center; padding: 24px;
    `;
    el.innerHTML = `
      <div style="font-size:2rem">⏱️</div>
      <div style="font-size:1.05rem;font-weight:600">Signed out after 8 hours of inactivity</div>
      <div style="opacity:0.75;font-size:0.85rem;max-width:360px">
        For security, PharmaTrack logs you out automatically when idle.
        Please log in again to continue.
      </div>
      <button id="idle-logout-relogin" type="button" style="margin-top:6px;background:var(--blue,#3a8fd4);color:#fff;border:none;border-radius:8px;padding:10px 22px;font-weight:600;cursor:pointer">
        Log in again
      </button>
    `;
    document.body.appendChild(el);
    document.getElementById("idle-logout-relogin").addEventListener("click", () => location.reload());
  }

  async function forceLogout() {
    stopTracking();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }

    const sc = window.supabaseClient;
    try {
      if (sc && sc.auth && typeof sc.auth.signOut === "function") await sc.auth.signOut();
    } catch (e) {
      console.error("[idle-logout] sign-out failed:", e);
    }
    showIdleOverlay();
  }

  function checkIdle() {
    if (Date.now() - getLastActivity() >= IDLE_LIMIT_MS) forceLogout();
  }

  function start() {
    recordActivity(); // stamp "now" the moment the authenticated session begins
    ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, recordActivity, { capture: true, passive: true }));
    checkIdle(); // covers the case where the tab was reopened after being idle >8h
    checkTimer = setInterval(checkIdle, CHECK_INTERVAL_MS);
  }

  document.addEventListener("epss-auth-ready", start);
})();
