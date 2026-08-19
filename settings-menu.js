// ════════════════════════════════════════════════════════════════
// settings-menu.js — top-right ⚙️ Settings dropdown
//
// Sections:
//   • Appearance  — 6 named themes (Belize, Belize Deep, High Contrast
//                   Black, High Contrast White, Horizon, Quartz Dark) as
//                   a single dropdown, plus a quick Dark/Light switch for
//                   the common case.
//   • Font style & size — applies to the whole app (root font-family /
//                   font-size; nearly everything else uses `inherit`
//                   or rem units, so this cascades everywhere).
//   • Account     — shows the signed-in user and a Sign out button.
//
// A tiny blocking script in <head> already applies the saved theme/font
// before first paint (to avoid a flash); this file wires up the menu's
// interactivity and keeps everything in sync afterwards.
//
// Runs standalone — only reaches into auth.js's window.supabaseClient /
// window.APP_USER when they exist, so load order relative to auth.js
// doesn't matter beyond "sometime after <head>".
// ════════════════════════════════════════════════════════════════

(function settingsMenuModule() {
  const THEME_STORAGE_KEY = "epss-theme";
  const FONT_FAMILY_KEY   = "epss-font-family";
  const FONT_SIZE_KEY     = "epss-font-size";

  // "belize-deep" = default dark theme (no data-theme attribute).
  const LIGHT_FAMILY_THEMES = new Set(["belize", "hc-white", "horizon"]);

  const FONT_FAMILIES = {
    jakarta: "'Plus Jakarta Sans', 'Inter', sans-serif",
    inter:   "'Inter', sans-serif",
    system:  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    georgia: "Georgia, 'Times New Roman', serif",
    mono:    "'IBM Plex Mono', monospace",
  };

  const FONT_SIZES = { small: "13px", medium: "14px", large: "16px", xlarge: "18px" };

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ── Theme ──────────────────────────────────────────────────────────────
  function currentTheme() {
    return safeGet(THEME_STORAGE_KEY) || "belize-deep";
  }

  function applyTheme(value, persist) {
    const ROOT = document.documentElement;
    if (value === "belize-deep") {
      ROOT.removeAttribute("data-theme");
    } else {
      ROOT.setAttribute("data-theme", value);
    }
    if (persist) safeSet(THEME_STORAGE_KEY, value);
    syncThemeUI(value);
  }

  function syncThemeUI(value) {
    const select = document.getElementById("settings-theme-select");
    if (select) select.value = value;
    const toggle = document.getElementById("settings-dark-light-switch");
    if (toggle) toggle.checked = LIGHT_FAMILY_THEMES.has(value);
  }

  // ── Font ───────────────────────────────────────────────────────────────
  function applyFontFamily(key, persist) {
    const stack = FONT_FAMILIES[key];
    if (!stack) return;
    document.documentElement.style.setProperty("--app-font-family", stack);
    if (persist) safeSet(FONT_FAMILY_KEY, key);
    const sel = document.getElementById("settings-font-family");
    if (sel) sel.value = key;
  }

  function applyFontSize(key, persist) {
    const size = FONT_SIZES[key];
    if (!size) return;
    document.documentElement.style.fontSize = size;
    if (persist) safeSet(FONT_SIZE_KEY, key);
    const sel = document.getElementById("settings-font-size");
    if (sel) sel.value = key;
  }

  // ── Account info ───────────────────────────────────────────────────────
  function refreshAccountInfo() {
    const el = document.getElementById("settings-account-info");
    if (!el) return;
    if (window.APP_USER) {
      const roleLabel = window.isAdmin ? "🛡️ Admin" : "👁️ Viewer";
      el.textContent = `${roleLabel} · ${window.APP_USER.email}`;
    } else {
      el.textContent = "Not signed in";
    }
  }

  async function handleSignOut() {
    const sc = window.supabaseClient;
    if (sc && sc.auth && typeof sc.auth.signOut === "function") {
      try { await sc.auth.signOut(); } catch (e) { console.error("[settings-menu] sign-out failed:", e); }
    }
    closePanel();
  }

  // ── Panel open/close ─────────────────────────────────────────────────
  function openPanel() {
    const panel = document.getElementById("settings-menu-panel");
    const btn   = document.getElementById("settings-menu-btn");
    if (!panel || !btn) return;
    panel.classList.add("open");
    btn.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutsideClick, true);
    document.addEventListener("keydown", onEscape);
  }

  function closePanel() {
    const panel = document.getElementById("settings-menu-panel");
    const btn   = document.getElementById("settings-menu-btn");
    if (!panel || !btn) return;
    panel.classList.remove("open");
    btn.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutsideClick, true);
    document.removeEventListener("keydown", onEscape);
  }

  function togglePanel() {
    const panel = document.getElementById("settings-menu-panel");
    if (!panel) return;
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  }

  function onOutsideClick(e) {
    const wrap = document.getElementById("settings-menu-wrap");
    if (wrap && !wrap.contains(e.target)) closePanel();
  }

  function onEscape(e) {
    if (e.key === "Escape") closePanel();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  function wire() {
    const gearBtn = document.getElementById("settings-menu-btn");
    if (gearBtn) gearBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(); });

    // Theme select
    const themeSelect = document.getElementById("settings-theme-select");
    if (themeSelect) {
      themeSelect.addEventListener("change", () => applyTheme(themeSelect.value, true));
    }

    // Quick Dark/Light switch — jumps straight to the Belize / Belize Deep pair
    const quickToggle = document.getElementById("settings-dark-light-switch");
    if (quickToggle) {
      quickToggle.addEventListener("change", () => {
        applyTheme(quickToggle.checked ? "belize" : "belize-deep", true);
      });
    }

    // Font style
    const fontFamilySel = document.getElementById("settings-font-family");
    if (fontFamilySel) {
      fontFamilySel.addEventListener("change", () => applyFontFamily(fontFamilySel.value, true));
    }

    // Font size
    const fontSizeSel = document.getElementById("settings-font-size");
    if (fontSizeSel) {
      fontSizeSel.addEventListener("change", () => applyFontSize(fontSizeSel.value, true));
    }

    // Sign out
    const signOutBtn = document.getElementById("settings-signout-btn");
    if (signOutBtn) signOutBtn.addEventListener("click", handleSignOut);

    // Sync controls to whatever the pre-paint script already applied
    syncThemeUI(currentTheme());
    const savedFontFamily = safeGet(FONT_FAMILY_KEY) || "jakarta";
    const savedFontSize   = safeGet(FONT_SIZE_KEY) || "medium";
    if (fontFamilySel) fontFamilySel.value = savedFontFamily;
    if (fontSizeSel) fontSizeSel.value = savedFontSize;

    refreshAccountInfo();
    document.addEventListener("epss-auth-ready", refreshAccountInfo);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
