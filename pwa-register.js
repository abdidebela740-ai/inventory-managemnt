// ════════════════════════════════════════════════════════════════
// pwa-register.js — registers the service worker safely, manages the
// "Add to Home Screen" install prompt, and shows a small toast when a
// new version has been downloaded and is ready to activate.
//
// Load this with <script src="js/pwa-register.js" defer></script>
// near the END of <body> (after your other app scripts is fine — it
// does not depend on auth.js or supabaseClient).
//
// Safe by design:
//   • Does nothing if the browser has no Service Worker support
//     (e.g. some in-app browsers) — app keeps working normally.
//   • Wrapped in try/catch so a registration failure never breaks
//     the rest of the page.
//   • Runs after window "load" so it never competes with/blocks the
//     app's own first paint or data fetches.
// ════════════════════════════════════════════════════════════════

(function pwaRegisterModule() {
  // Resolved relative to THIS script's own folder-independent location —
  // sw.js lives next to index.html at the project root, and this script
  // is loaded from index.html/pharma-alloc.html, so a bare relative path
  // (no leading "/") resolves correctly regardless of whether the site is
  // hosted at the domain root or under a sub-path (e.g. /epss/).
  const SW_URL = "sw.js";
  const SW_SCOPE = "./";

  // ── 1) Register the service worker ────────────────────────────
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      console.info("[pwa] Service workers not supported in this browser.");
      return;
    }
    if (location.protocol !== "https:" && location.hostname !== "localhost") {
      console.warn("[pwa] Service workers require HTTPS (or localhost). Skipping registration on:", location.origin);
      return;
    }

    window.addEventListener("load", async () => {
      try {
        const registration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
        console.info("[pwa] Service worker registered:", registration.scope);

        // Detect a NEW service worker taking over control (e.g. after an
        // update) and prompt the user to refresh instead of silently
        // swapping app code under them mid-session.
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              showUpdateToast(registration);
            }
          });
        });

        // Periodically check for updates (covers PWAs left open for days).
        setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000); // hourly
      } catch (err) {
        console.warn("[pwa] Service worker registration failed:", err);
      }
    });

    // If a new SW takes control (after skipWaiting), reload once so the
    // page is served entirely by the new version (no mixed old/new assets).
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }

  // ── 2) "New version available" toast ──────────────────────────
  function showUpdateToast(registration) {
    if (document.getElementById("pwa-update-toast")) return;
    const toast = document.createElement("div");
    toast.id = "pwa-update-toast";
    toast.style.cssText = `
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 30000; background: #12192a; color: #fff; border: 1px solid #22304a;
      border-radius: 12px; padding: 12px 16px; display: flex; align-items: center;
      gap: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.85rem; box-shadow: 0 8px 24px rgba(0,0,0,0.35); max-width: 92vw;
    `;
    toast.innerHTML = `
      <span>A new version of EPSS Stock is ready.</span>
      <button id="pwa-update-btn" type="button" style="background:#3d94e0;color:#fff;border:none;
        border-radius:8px;padding:7px 14px;font-weight:600;cursor:pointer;font-size:0.82rem;white-space:nowrap;">
        Update now
      </button>
      <button id="pwa-update-dismiss" type="button" style="background:transparent;color:#8291a6;border:none;
        cursor:pointer;font-size:1rem;line-height:1;padding:0 2px;">✕</button>
    `;
    document.body.appendChild(toast);

    document.getElementById("pwa-update-btn").addEventListener("click", () => {
      const waiting = registration.waiting;
      if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
      toast.remove();
    });
    document.getElementById("pwa-update-dismiss").addEventListener("click", () => toast.remove());
  }

  // ── 3) "Add to Home Screen" install prompt (Android/Chrome/Edge) ─
  // iOS Safari does NOT support beforeinstallprompt — see the manual
  // "Add to Home Screen" instructions shown separately for iOS users.
  let deferredInstallPrompt = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // stop the automatic mini-infobar
    deferredInstallPrompt = event;
    document.dispatchEvent(new CustomEvent("epss-pwa-installable"));
    maybeShowInstallButton();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    const btn = document.getElementById("pwa-install-btn");
    if (btn) btn.style.display = "none";
    console.info("[pwa] App installed.");
  });

  // Shows a floating install button if the page doesn't already have its
  // own #pwa-install-btn wired up (see index.html snippet for a nicer,
  // in-sidebar version — this is just a safe fallback).
  function maybeShowInstallButton() {
    let btn = document.getElementById("pwa-install-btn");
    if (btn) {
      btn.style.display = "inline-flex";
      return;
    }
    // No custom button found in the page — inject a minimal floating one.
    btn = document.createElement("button");
    btn.id = "pwa-install-btn";
    btn.type = "button";
    btn.textContent = "⬇ Install App";
    btn.style.cssText = `
      position: fixed; right: 16px; bottom: 16px; z-index: 25000;
      background: #3d94e0; color: #fff; border: none; border-radius: 999px;
      padding: 10px 18px; font-weight: 600; font-size: 0.85rem; cursor: pointer;
      box-shadow: 0 6px 18px rgba(0,0,0,0.3); font-family: inherit;
    `;
    btn.addEventListener("click", promptInstall);
    document.body.appendChild(btn);
  }

  // Exposed globally so a custom button anywhere in the app (sidebar,
  // settings menu, etc.) can just call window.promptPwaInstall().
  async function promptInstall() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.info("[pwa] Install prompt outcome:", outcome);
    deferredInstallPrompt = null;
    const btn = document.getElementById("pwa-install-btn");
    if (btn) btn.style.display = "none";
  }
  window.promptPwaInstall = promptInstall;
  window.isPwaInstallable = () => !!deferredInstallPrompt;

  // ── 4) Kick things off ─────────────────────────────────────────
  registerServiceWorker();
})();
