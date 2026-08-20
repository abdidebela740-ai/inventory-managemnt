// ════════════════════════════════════════════════════════════════
// settings-menu.js — top-right Settings menu (theme/font) + Profile menu
//
// • Settings menu (#settings-menu-wrap, top-right, next to Profile) — 6
//   named themes (Belize, Belize Deep, High Contrast Black, High Contrast
//   White, Horizon, Quartz Dark) as a single dropdown, a quick Dark/Light
//   switch for the common case, and whole-app font family / font size.
// • Profile menu (#profile-menu-wrap, top-right) — who's signed in (name,
//   with an email fallback), their role badge, Change password, Sign out.
//
// A tiny blocking script in <head> already applies the saved theme/font
// before first paint (to avoid a flash); this file wires up both panels'
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

  // ── Profile info (name / email / role badge / avatar initials) ─────────
  function initialsFor(user) {
    const name = (user && user.full_name || "").trim();
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      const first = parts[0] ? parts[0][0] : "";
      const last  = parts.length > 1 ? parts[parts.length - 1][0] : "";
      const initials = (first + last).toUpperCase();
      if (initials) return initials;
    }
    const email = (user && user.email || "").trim();
    return email ? email[0].toUpperCase() : "?";
  }

  function refreshAccountInfo() {
    const nameEl  = document.getElementById("profile-name");
    const emailEl = document.getElementById("profile-email");
    const badgeEl = document.getElementById("profile-role-badge");
    const avatarBtnEl = document.getElementById("profile-avatar");
    const avatarLgEl  = document.getElementById("profile-avatar-lg");
    const user = window.APP_USER;

    if (!user) {
      if (nameEl)  nameEl.textContent  = "Not signed in";
      if (emailEl) emailEl.textContent = "";
      if (badgeEl) { badgeEl.textContent = ""; badgeEl.style.display = "none"; }
      if (avatarBtnEl) avatarBtnEl.textContent = "–";
      if (avatarLgEl)  avatarLgEl.textContent  = "–";
      return;
    }

    // Display name prefers full_name; falls back to email when empty.
    const displayName = (user.full_name && user.full_name.trim()) ? user.full_name.trim() : user.email;
    if (nameEl) nameEl.textContent = displayName || "Signed in";

    // Only show a separate email line when it isn't already the display name.
    if (emailEl) emailEl.textContent = (displayName === user.email) ? "" : (user.email || "");

    if (badgeEl) {
      const badge = (typeof roleBadgeText === "function") ? roleBadgeText() : (window.isAdmin ? "Admin" : "User");
      badgeEl.textContent = badge || "";
      badgeEl.style.display = badge ? "" : "none";
    }

    const initials = initialsFor(user);
    if (avatarBtnEl) avatarBtnEl.textContent = initials;
    if (avatarLgEl)  avatarLgEl.textContent  = initials;
  }

  async function handleSignOut() {
    const sc = window.supabaseClient;
    if (sc && sc.auth && typeof sc.auth.signOut === "function") {
      try { await sc.auth.signOut(); } catch (e) { console.error("[settings-menu] sign-out failed:", e); }
    }
    profileDropdown.close();
  }

  // ── Change password ─────────────────────────────────────────────────────
  function setCpMessage(text, kind) {
    const el = document.getElementById("profile-cp-message");
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("is-error", "is-success");
    if (kind) el.classList.add(kind === "error" ? "is-error" : "is-success");
  }

  function toggleChangePasswordPanel(forceOpen) {
    const panel = document.getElementById("profile-change-password-panel");
    const btn   = document.getElementById("profile-change-password-btn");
    if (!panel || !btn) return;
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : panel.hidden;
    panel.hidden = !shouldOpen;
    btn.setAttribute("aria-expanded", String(shouldOpen));
    if (!shouldOpen) {
      setCpMessage("");
      const pw1 = document.getElementById("profile-new-password");
      const pw2 = document.getElementById("profile-new-password-confirm");
      if (pw1) pw1.value = "";
      if (pw2) pw2.value = "";
    }
  }

  async function handleChangePasswordSubmit() {
    const pw1El = document.getElementById("profile-new-password");
    const pw2El = document.getElementById("profile-new-password-confirm");
    const submitBtn = document.getElementById("profile-cp-submit");
    if (!pw1El || !pw2El) return;

    const pw1 = pw1El.value;
    const pw2 = pw2El.value;

    if (!pw1 || !pw2) {
      setCpMessage("Enter and confirm a new password.", "error");
      return;
    }
    if (pw1 !== pw2) {
      setCpMessage("Passwords don't match.", "error");
      return;
    }
    if (pw1.length < 6) {
      setCpMessage("Password must be at least 6 characters.", "error");
      return;
    }

    const sc = window.supabaseClient;
    if (!sc || !sc.auth || typeof sc.auth.updateUser !== "function") {
      setCpMessage("Not available right now — please try again later.", "error");
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Updating…"; }
    setCpMessage("");

    const { error } = await sc.auth.updateUser({ password: pw1 });

    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Update password"; }

    if (error) {
      setCpMessage(error.message || "Could not update password.", "error");
      return;
    }

    setCpMessage("Password updated.", "success");
    pw1El.value = "";
    pw2El.value = "";
  }

  // ── Panel open/close ─────────────────────────────────────────────────
  // Generic dropdown factory — used for both the Profile menu and the
  // Settings menu, which are independent, separately-triggered panels
  // that share the same open/close/outside-click/Escape mechanics.
  function makeDropdown(wrapId, btnId, panelId, onClose) {
    function onOutsideClick(e) {
      const wrap = document.getElementById(wrapId);
      if (wrap && !wrap.contains(e.target)) close();
    }
    function onEscape(e) {
      if (e.key === "Escape") close();
    }
    function open() {
      const panel = document.getElementById(panelId);
      const btn   = document.getElementById(btnId);
      if (!panel || !btn) return;
      panel.classList.add("open");
      btn.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      document.addEventListener("click", onOutsideClick, true);
      document.addEventListener("keydown", onEscape);
    }
    function close() {
      const panel = document.getElementById(panelId);
      const btn   = document.getElementById(btnId);
      if (!panel || !btn) return;
      panel.classList.remove("open");
      btn.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onEscape);
      if (onClose) onClose();
    }
    function toggle() {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      if (panel.classList.contains("open")) close();
      else open();
    }
    return { open, close, toggle };
  }

  const profileDropdown  = makeDropdown("profile-menu-wrap", "profile-menu-btn", "profile-menu-panel",
    () => toggleChangePasswordPanel(false));
  const settingsDropdown = makeDropdown("settings-menu-wrap", "settings-menu-btn", "settings-menu-panel");

  // ── Wiring ─────────────────────────────────────────────────────────────
  function wire() {
    // Profile menu open/close
    const avatarBtn = document.getElementById("profile-menu-btn");
    if (avatarBtn) avatarBtn.addEventListener("click", (e) => { e.stopPropagation(); profileDropdown.toggle(); });

    // Settings menu open/close (top-right, next to Profile)
    const settingsBtn = document.getElementById("settings-menu-btn");
    if (settingsBtn) settingsBtn.addEventListener("click", (e) => { e.stopPropagation(); settingsDropdown.toggle(); });

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

    // Change password
    const cpToggleBtn = document.getElementById("profile-change-password-btn");
    if (cpToggleBtn) cpToggleBtn.addEventListener("click", () => toggleChangePasswordPanel());
    const cpSubmitBtn = document.getElementById("profile-cp-submit");
    if (cpSubmitBtn) cpSubmitBtn.addEventListener("click", handleChangePasswordSubmit);
    const cpConfirmField = document.getElementById("profile-new-password-confirm");
    if (cpConfirmField) {
      cpConfirmField.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); handleChangePasswordSubmit(); }
      });
    }

    // Sign out
    const signOutBtn = document.getElementById("profile-signout-btn");
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
