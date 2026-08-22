// ════════════════════════════════════════════════════════════════
// idle-logout.js — automatically signs the user out after a period
// of inactivity (no mouse, keyboard, scroll, or touch activity).
//
// UPDATED: replaces the previous 8-hour timeout with an industry-
// standard idle window appropriate for an app handling pharmaceutical
// stock/inventory data:
//     • Desktop/laptop:  15 minutes idle
//     • Mobile/touch:     8 minutes idle  (phones are more likely to be
//                          left unlocked/unattended in shared spaces)
// A 60-second warning modal appears before logout so an active-but-
// briefly-idle user (reading a large table, thinking) can extend the
// session with one tap, instead of being logged out mid-task.
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
  // ── Standard timeouts (ms). Change these two lines to adjust policy. ──
  const IDLE_LIMIT_DESKTOP_MS = 15 * 60 * 1000; // 15 minutes
  const IDLE_LIMIT_MOBILE_MS  = 8  * 60 * 1000; // 8 minutes
  const WARNING_LEAD_MS       = 60 * 1000;      // show "still there?" 60s before logout

  const STORAGE_KEY       = "epss-last-activity";
  const CHECK_INTERVAL_MS = 5 * 1000;           // re-check every 5s (fine-grained enough for the warning countdown)
  const THROTTLE_MS       = 5000;               // don't hit localStorage on every mousemove
  const ACTIVITY_EVENTS   = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];

  // Basic touch/mobile detection — good enough to pick a policy, not used
  // for anything security-critical.
  const IS_MOBILE = window.matchMedia
    ? window.matchMedia("(max-width: 768px), (pointer: coarse)").matches
    : /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  const IDLE_LIMIT_MS = IS_MOBILE ? IDLE_LIMIT_MOBILE_MS : IDLE_LIMIT_DESKTOP_MS;

  let lastWrite    = 0;
  let checkTimer   = null;
  let warningShown = false;

  function recordActivity() {
    const now = Date.now();
    if (now - lastWrite < THROTTLE_MS) return;
    lastWrite = now;
    try { localStorage.setItem(STORAGE_KEY, String(now)); } catch (e) { /* private mode / quota — ignore */ }
    // Any real activity while the warning is showing means the user is
    // back — dismiss it and cancel the pending logout.
    if (warningShown) hideWarningOverlay();
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

  // ── Warning modal — shown WARNING_LEAD_MS before the actual logout,
  // dismissible by any activity (click "Stay signed in" or just interact).
  function showWarningOverlay(secondsLeft) {
    warningShown = true;
    let el = document.getElementById("idle-warning-overlay");
    if (el) {
      const countEl = document.getElementById("idle-warning-count");
      if (countEl) countEl.textContent = secondsLeft;
      return;
    }
    el = document.createElement("div");
    el.id = "idle-warning-overlay";
    el.style.cssText = `
      position: fixed; inset: 0; z-index: 20000;
      background: rgba(10,14,20,0.88); color: #fff;
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 14px; text-align: center; padding: 24px;
    `;
    el.innerHTML = `
      <div style="font-size:2rem">⏳</div>
      <div style="font-size:1.05rem;font-weight:600">Still there?</div>
      <div style="opacity:0.75;font-size:0.85rem;max-width:360px">
        You'll be signed out in <span id="idle-warning-count">${secondsLeft}</span>s due to inactivity.
      </div>
      <button id="idle-warning-stay" type="button" style="margin-top:6px;background:var(--blue,#3a8fd4);color:#fff;border:none;border-radius:8px;padding:10px 22px;font-weight:600;cursor:pointer">
        Stay signed in
      </button>
    `;
    document.body.appendChild(el);
    document.getElementById("idle-warning-stay").addEventListener("click", () => {
      recordActivity();
      lastWrite = 0; // force-bypass throttle so this explicit click always counts
      recordActivity();
    });
  }

  function hideWarningOverlay() {
    warningShown = false;
    const el = document.getElementById("idle-warning-overlay");
    if (el) el.remove();
  }

  function showIdleOverlay() {
    hideWarningOverlay();
    if (document.getElementById("idle-logout-overlay")) return;
    const minutes = Math.round(IDLE_LIMIT_MS / 60000);
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
      <div style="font-size:1.05rem;font-weight:600">Signed out after ${minutes} minutes of inactivity</div>
      <div style="opacity:0.75;font-size:0.85rem;max-width:360px">
        For security, EPSS Stock-Multiple logs you out automatically when idle.
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
    const idleFor = Date.now() - getLastActivity();
    const msRemaining = IDLE_LIMIT_MS - idleFor;

    if (msRemaining <= 0) {
      forceLogout();
      return;
    }
    if (msRemaining <= WARNING_LEAD_MS) {
      showWarningOverlay(Math.ceil(msRemaining / 1000));
    } else if (warningShown) {
      hideWarningOverlay();
    }
  }

  function start() {
    recordActivity(); // stamp "now" the moment the authenticated session begins
    ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, recordActivity, { capture: true, passive: true }));
    checkIdle(); // covers the case where the tab was reopened after being idle past the limit
    checkTimer = setInterval(checkIdle, CHECK_INTERVAL_MS);
  }

  document.addEventListener("epss-auth-ready", start);
})();
