// ════════════════════════════════════════════════════════════════
// auth.js — Supabase authentication + role gating
// Loaded BEFORE script.js / mos.js / etc. Shows a full landing +
// login page to signed-out visitors (sidebar & app stay hidden
// behind it), then exposes window.isAdmin / window.APP_USER and
// hides admin-only UI for non-admins once signed in.
// ════════════════════════════════════════════════════════════════

// ── 1) FILL THESE IN from Supabase Dashboard → Project Settings → API ──
const SUPABASE_URL      = "https://wkmyruayzdiemvupllsu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrbXlydWF5emRpZW12dXBsbHN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMDY5NjEsImV4cCI6MjEwMjY4Mjk2MX0.gSGaNqxWda-7AsmtjmaU82CR_XJrB3r1KRq449x_ltM";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabaseClient = supabaseClient; // used by storage-sync.js

window.APP_USER = null;   // { id, email, role }
window.isAdmin  = false;

// Tracks whether the user arrived via a password-recovery email link.
// Set as early as possible (see listener below) so we never auto-unlock
// the app using a recovery session before a new password is chosen.
let authRecoveryMode = false;

// ── Register the auth listener IMMEDIATELY, before anything else touches
// the session. Supabase parses the recovery link's URL fragment/params and
// fires PASSWORD_RECOVERY very early — sometimes before DOMContentLoaded —
// so if this listener is attached later (e.g. inside initAuth after a
// getSession() call), the event can be missed entirely and the user just
// lands on the normal page instead of the "set new password" form.
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT") {
    window.APP_USER = null;
    window.isAdmin  = false;
    location.reload(); // simplest way to fully reset in-memory app state
  }
  if (event === "PASSWORD_RECOVERY") {
    authRecoveryMode = true;
    // Overlay may not be injected yet if this fires before DOMContentLoaded;
    // showResetPasswordForm() is safe to call once initAuth() has run, and
    // initAuth() itself checks authRecoveryMode as a fallback (see below).
    if (document.getElementById("auth-overlay")) showResetPasswordForm();
  }
});

// ── 2) BUILD THE LANDING + LOGIN OVERLAY (injected, no HTML edits needed) ──
function injectAuthOverlay() {
  const el = document.createElement("div");
  el.id = "auth-overlay";
  el.innerHTML = `
    <nav id="auth-nav">
      <div class="auth-nav-inner">
        <div class="auth-nav-brand">
          <img src="epss-logo.png" alt="" />
          <span>EPSS Stock-Multiple</span>
        </div>
        <div class="auth-nav-links">
          <a href="#auth-about">About</a>
        </div>
        <button type="button" class="auth-nav-cta" id="auth-nav-login-btn">Log In</button>
      </div>
    </nav>

    <div id="auth-scroll">
      <section id="auth-hero">
        <div class="auth-hero-grid">
          <div class="auth-hero-text">
            <h1>Pharmaceutical Inventory Management and Operation</h1>
            <p>Track stock across every plant, catch expiry risk before it becomes loss— all from one dashboard.</p>
            <div class="auth-hero-actions">
              <button type="button" class="auth-btn-primary" id="auth-hero-signin-btn">→ Sign In</button>
            </div>
            <div class="auth-hero-pills">
              <span class="auth-pill">⏰ Expiry Tracking</span>
              <span class="auth-pill">📦 Open Outbound</span>
              <span class="auth-pill">🚚 Stock in Transit</span>
            </div>
          </div>

          <div class="auth-login-card" id="auth-login-card">
            <div class="auth-login-header">
              <span class="auth-login-icon">🔒</span>
              <h2>Login to EPSS Stock-Multiple Track</h2>
            </div>

            <form id="auth-form">
              <label class="auth-field-label" for="auth-email">Email Address</label>
              <input type="email" id="auth-email" placeholder="you@epss.gov.et" autocomplete="off" required />

              <label class="auth-field-label" for="auth-password">Password</label>
              <input type="password" id="auth-password" placeholder="••••••••" autocomplete="off" required />

              <label class="auth-remember-row">
                <input type="checkbox" id="auth-remember" checked />
                <span>Remember Me</span>
              </label>

              <button type="submit" id="auth-submit">→ Login</button>
              <button type="button" id="auth-forgot-btn">Forgot Your Password?</button>
            </form>

            <div id="auth-error"></div>
            <div id="auth-loading">Checking session…</div>
          </div>

          <div class="auth-login-card" id="auth-reset-card" style="display:none;">
            <div class="auth-login-header">
              <span class="auth-login-icon">🔑</span>
              <h2>Choose a new password</h2>
            </div>

            <form id="auth-reset-form">
              <label class="auth-field-label" for="auth-new-password">New Password</label>
              <input type="password" id="auth-new-password" placeholder="••••••••" autocomplete="new-password" minlength="6" required />

              <label class="auth-field-label" for="auth-new-password-confirm">Confirm New Password</label>
              <input type="password" id="auth-new-password-confirm" placeholder="••••••••" autocomplete="new-password" minlength="6" required />

              <button type="submit" id="auth-reset-submit">→ Update Password</button>
            </form>

            <div id="auth-reset-error"></div>
          </div>
        </div>
      </section>


        <div class="auth-section-inner auth-about-inner">
          <div>
            <span class="auth-hero-eyebrow">About</span>
            <h2>Built for EPSS Inventory Management</h2>
            <p>EPSS Stock-Multiple pulls inventory data into a single network-wide view — so decisions about redistribution, expiry risk are based on what's actually on the shelf.</p>
          </div>
          <button type="button" class="auth-btn-primary" id="auth-about-signin-btn">→ Sign In to Get Started</button>
        </div>
      </section>

      <footer id="auth-footer">© <span id="auth-year"></span> EPSS Stock-Multiple · Inventory Management</footer>
    </div>
  `;
  document.body.appendChild(el);

  const yearEl = el.querySelector("#auth-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const style = document.createElement("style");
  style.textContent = `
    #auth-overlay {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; flex-direction: column;
      background: var(--bg, #07090d);
      color: var(--text, #dce8f5);
      font-family: 'Inter', system-ui, sans-serif;
    }
    #auth-scroll { flex: 1; overflow-y: auto; }

    /* ── Top nav ── */
    #auth-nav {
      border-bottom: 1px solid var(--border, #1f2e44);
      background: var(--surface, #0e1420);
      flex-shrink: 0;
    }
    .auth-nav-inner {
      max-width: 1180px; margin: 0 auto;
      display: flex; align-items: center; gap: 1.2rem;
      padding: 0.8rem 1.5rem;
    }
    .auth-nav-brand { display: flex; align-items: center; gap: 0.6rem; font-weight: 700; font-size: 0.95rem; }
    .auth-nav-brand img { height: 30px; width: auto; display: block; }
    .auth-nav-links { display: flex; gap: 1.4rem; margin-left: auto; }
    .auth-nav-links a { color: var(--muted, #7a9ab8); text-decoration: none; font-size: 0.85rem; font-weight: 500; transition: color 0.15s; }
    .auth-nav-links a:hover { color: var(--text, #dce8f5); }
    .auth-nav-cta {
      background: var(--blue, #3d94e0); color: #fff; border: none;
      border-radius: 999px; padding: 0.5rem 1.1rem; font-size: 0.82rem;
      font-weight: 600; cursor: pointer; transition: opacity 0.15s; font-family: inherit;
    }
    .auth-nav-cta:hover { opacity: 0.88; }

    /* ── Hero ── */
    #auth-hero {
      background:
        radial-gradient(circle at 15% 20%, var(--blue-glow, rgba(61,148,224,0.22)) 0%, transparent 45%),
        radial-gradient(circle at 85% 80%, rgba(148,113,214,0.18) 0%, transparent 45%),
        var(--bg, #07090d);
      padding: 3.2rem 1.5rem;
    }
    .auth-hero-grid {
      max-width: 1180px; margin: 0 auto;
      display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 3rem; align-items: center;
    }
    .auth-hero-eyebrow {
      display: inline-block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em;
      color: var(--blue, #3d94e0); background: var(--blue-glow, rgba(61,148,224,0.16));
      border: 1px solid var(--blue-soft, #1b4a70); border-radius: 999px; padding: 0.3rem 0.75rem;
      margin-bottom: 1rem;
    }
    .auth-hero-text h1 {
      font-size: 2.5rem; line-height: 1.15; margin: 0 0 1rem; font-weight: 800;
      font-family: 'Plus Jakarta Sans', 'Inter', sans-serif;
    }
    .auth-hero-text p { font-size: 1rem; color: var(--muted, #7a9ab8); max-width: 46ch; margin: 0 0 1.6rem; line-height: 1.55; }
    .auth-hero-actions { display: flex; gap: 0.8rem; flex-wrap: wrap; margin-bottom: 1.6rem; }
    .auth-btn-primary, .auth-btn-secondary {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.75rem 1.4rem; border-radius: 999px; font-size: 0.88rem; font-weight: 700;
      cursor: pointer; text-decoration: none; font-family: inherit; border: none;
      transition: opacity 0.15s, transform 0.1s;
    }
    .auth-btn-primary { background: var(--blue, #3d94e0); color: #fff; }
    .auth-btn-primary:hover { opacity: 0.9; }
    .auth-btn-secondary { background: var(--surface2, #141c2b); color: var(--text, #dce8f5); border: 1px solid var(--border, #1f2e44); }
    .auth-btn-secondary:hover { border-color: var(--blue, #3d94e0); color: var(--blue, #3d94e0); }
    .auth-hero-pills { display: flex; flex-wrap: wrap; gap: 0.55rem; }
    .auth-pill {
      font-size: 0.74rem; font-weight: 600; color: var(--muted, #7a9ab8);
      background: var(--surface2, #141c2b); border: 1px solid var(--border, #1f2e44);
      border-radius: 999px; padding: 0.4rem 0.85rem;
    }

    /* ── Login card ── */
    .auth-login-card {
      background: var(--surface, #0e1420); border: 1px solid var(--border, #1f2e44);
      border-radius: var(--radius-lg, 14px); padding: 1.8rem 1.7rem;
      box-shadow: 0 20px 50px rgba(0,0,0,0.45);
    }
    .auth-login-header { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 1.4rem; }
    .auth-login-icon { font-size: 1.1rem; }
    .auth-login-header h2 { margin: 0; font-size: 1.05rem; font-weight: 700; }
    #auth-form, #auth-reset-form { display: flex; flex-direction: column; }
    .auth-field-label { font-size: 0.74rem; font-weight: 600; color: var(--muted, #7a9ab8); margin: 0.7rem 0 0.35rem; }
    .auth-field-label:first-child { margin-top: 0; }
    #auth-form input[type="email"], #auth-form input[type="password"],
    #auth-reset-form input[type="password"] {
      padding: 10px 12px; border-radius: var(--radius-md, 10px); border: 1.5px solid var(--border, #1f2e44);
      background: var(--surface2, #141c2b); color: var(--text, #dce8f5); font-size: 0.9rem; font-family: inherit;
      width: 100%; box-sizing: border-box;
    }
    #auth-form input:focus, #auth-reset-form input:focus { outline: none; border-color: var(--blue, #3d94e0); box-shadow: 0 0 0 3px var(--blue-glow, rgba(61,148,224,0.22)); }
    .auth-remember-row {
      display: flex; align-items: center; gap: 0.45rem; margin: 0.9rem 0 0.2rem;
      font-size: 0.78rem; color: var(--muted, #7a9ab8); cursor: pointer;
    }
    .auth-remember-row input { accent-color: var(--blue, #3d94e0); }
    #auth-submit {
      margin-top: 1rem; padding: 11px; border-radius: var(--radius-md, 10px); border: none;
      background: var(--blue, #3d94e0); color: #fff; font-weight: 700; font-size: 0.9rem;
      cursor: pointer; font-family: inherit; transition: opacity 0.15s;
    }
    #auth-submit:hover, #auth-reset-submit:hover { opacity: 0.9; }
    #auth-submit:disabled, #auth-reset-submit:disabled { opacity: 0.6; cursor: not-allowed; }
    #auth-reset-submit {
      margin-top: 1rem; padding: 11px; border-radius: var(--radius-md, 10px); border: none;
      background: var(--blue, #3d94e0); color: #fff; font-weight: 700; font-size: 0.9rem;
      cursor: pointer; font-family: inherit; transition: opacity 0.15s;
    }
    #auth-forgot-btn {
      background: none; border: none; color: var(--blue, #3d94e0); font-size: 0.78rem;
      cursor: pointer; margin-top: 0.8rem; text-decoration: underline; font-family: inherit; padding: 0;
    }
    #auth-error, #auth-reset-error { color: var(--red, #e04545); font-size: 0.8rem; margin-top: 0.9rem; min-height: 1em; text-align: center; }
    #auth-loading { display: none; color: var(--muted, #7a9ab8); font-size: 0.82rem; margin-top: 1rem; text-align: center; }
    #auth-loading.show { display: block; }

    /* ── About ── */
    #auth-about { padding: 3.2rem 1.5rem; background: var(--surface, #0e1420); border-top: 1px solid var(--border, #1f2e44); }
    .auth-section-inner { max-width: 1180px; margin: 0 auto; }
    .auth-about-inner {
      display: flex; align-items: center; justify-content: space-between; gap: 2rem; flex-wrap: wrap;
    }
    .auth-about-inner h2 { font-size: 1.4rem; margin: 0.4rem 0 0.7rem; font-family: 'Plus Jakarta Sans', sans-serif; }
    .auth-about-inner p { color: var(--muted, #7a9ab8); max-width: 56ch; line-height: 1.6; margin: 0; font-size: 0.9rem; }

    #auth-footer {
      text-align: center; padding: 1.4rem; font-size: 0.74rem; color: var(--dim, #4a6275);
      border-top: 1px solid var(--border, #1f2e44); background: var(--surface, #0e1420);
    }

    @media (max-width: 900px) {
      .auth-hero-grid { grid-template-columns: 1fr; }
      .auth-hero-text h1 { font-size: 2rem; }
    }
    @media (max-width: 640px) {
      .auth-nav-links { display: none; }
      .auth-about-inner { flex-direction: column; align-items: flex-start; }
    }
  `;
  document.head.appendChild(style);

  // Nav / hero CTAs scroll to + focus the login card
  const focusLogin = () => {
    document.getElementById("auth-login-card").scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => document.getElementById("auth-email").focus(), 350);
  };
  document.getElementById("auth-nav-login-btn").addEventListener("click", focusLogin);
  document.getElementById("auth-hero-signin-btn").addEventListener("click", focusLogin);
  document.getElementById("auth-about-signin-btn").addEventListener("click", focusLogin);

  // Smooth-scroll the in-page nav anchors
  el.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener("click", (e) => {
      const target = document.querySelector(a.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // Forgot password — instead of emailing a Supabase reset link, send the
  // user to WhatsApp with a pre-filled message containing their email, so
  // an admin can verify them and issue a new password manually.
  const SUPPORT_WHATSAPP_NUMBER = "251951112131"; // +251 95 111 2131, no leading 0/+ for wa.me links
  document.getElementById("auth-forgot-btn").addEventListener("click", () => {
    const errEl = document.getElementById("auth-error");
    const email = document.getElementById("auth-email").value.trim();
    if (!email) {
      errEl.style.color = "var(--red, #e04545)";
      errEl.textContent = "Enter your email above first, then click \"Forgot Your Password?\"";
      return;
    }
    const message = `Hi, I forgot my password for EPSS Stock-Multiple. My login email is: ${email}`;
    const waUrl = `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
    errEl.style.color = "var(--muted, #7a9ab8)";
    errEl.textContent = "Opening WhatsApp…";
    window.open(waUrl, "_blank", "noopener");
  });

  // Submit new password (shown after the user clicks the emailed reset link)
  document.getElementById("auth-reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw1    = document.getElementById("auth-new-password").value;
    const pw2    = document.getElementById("auth-new-password-confirm").value;
    const btn    = document.getElementById("auth-reset-submit");
    const errEl  = document.getElementById("auth-reset-error");
    errEl.textContent = "";

    if (pw1 !== pw2) {
      errEl.textContent = "Passwords don't match.";
      return;
    }
    if (pw1.length < 6) {
      errEl.textContent = "Password must be at least 6 characters.";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Updating…";

    const { error } = await supabaseClient.auth.updateUser({ password: pw1 });

    btn.disabled = false;
    btn.textContent = "→ Update Password";

    if (error) {
      errEl.textContent = error.message;
      return;
    }

    // Password updated — the recovery session is now a real session, log them in.
    authRecoveryMode = false;
    const { data: { session } } = await supabaseClient.auth.getSession();
    document.getElementById("auth-reset-card").style.display = "none";
    document.getElementById("auth-login-card").style.display = "";
    if (session) await loadProfileAndUnlock(session);
  });
}

// Switch the overlay into "set new password" mode
function showResetPasswordForm() {
  showAuthOverlay();
  const loginCard = document.getElementById("auth-login-card");
  const resetCard = document.getElementById("auth-reset-card");
  if (loginCard) loginCard.style.display = "none";
  if (resetCard) resetCard.style.display = "";
}

function showAuthOverlay() {
  const el = document.getElementById("auth-overlay");
  if (el) el.style.display = "flex";
  document.documentElement.style.overflow = "hidden";
  document.getElementById("auth-scroll").scrollTop = 0;
}
function hideAuthOverlay() {
  const el = document.getElementById("auth-overlay");
  if (el) el.style.display = "none";
  document.documentElement.style.overflow = "";
}

// ── 3) ROLE-GATED UI ──
// Joins an array of short phrases into a natural-language list with the
// given conjunction ("and" / "or") — "A", "A and B", "A, B, and C".
// Shared by Quick Lookup's subtitle and every GROUP_OVERVIEW_CONFIG entry
// below so a section's description always matches only the tool(s) the
// signed-in user can actually see, instead of a static sentence written
// for the full, un-gated set.
function joinPhrases(list, conjunction) {
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} ${conjunction} ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, ${conjunction} ${list[list.length - 1]}`;
}

// Per-group config for the "Inventory Ops" / "Quality & Risk" / "Analytics"
// overview pages (index.html #page-group-<key>): a fixed intro clause plus
// one short phrase per tool, in the order the tools appear on that page.
// updateGroupOverviewSubtitle() below keeps only the phrases for tools the
// signed-in user has access to (canAccessModule), same idea as Quick
// Lookup's subtitle handling.
const GROUP_OVERVIEW_CONFIG = {
  "inventory-ops": {
    prefix: "Track where physical stock actually is",
    order: ["pending-dispatch", "transit", "branch"],
    phrases: {
      "pending-dispatch": "deliveries waiting to go out",
      "transit": "goods still moving between plants",
      "branch": "how each branch's holdings compare to the rest",
    },
  },
  "quality-risk": {
    prefix: "Flag stock that needs attention before it turns into a loss",
    order: ["expiry", "qc", "expiry-risk", "stockout-risk"],
    phrases: {
      "expiry": "expiring batches",
      "qc": "items awaiting QC",
      "expiry-risk": "overstock exposed to expiry",
      "stockout-risk": "materials at risk of stocking out",
    },
  },
  "analytics": {
    prefix: "Deeper cuts of the data",
    order: ["natl-table", "concentration"],
    phrases: {
      "natl-table": "national-level stock & months of supply",
      "concentration": "where inventory value concentrates",
    },
  },
};

function updateGroupOverviewSubtitle(groupKey) {
  const cfg = GROUP_OVERVIEW_CONFIG[groupKey];
  if (!cfg) return;
  const subtitleEl = document.querySelector(`#page-group-${groupKey} .page-subtitle`);
  if (!subtitleEl) return;
  const visiblePhrases = cfg.order.filter(k => canAccessModule(k)).map(k => cfg.phrases[k]);
  subtitleEl.textContent = visiblePhrases.length
    ? `${cfg.prefix} — ${joinPhrases(visiblePhrases, "and")}.`
    : `${cfg.prefix}.`;
}

function applyRoleToUI() {
  // Data Upload is fixed to Admin-only by the access-level matrix (not a
  // per-user togglable permission like the other sidebar items).
  const adminSection = document.getElementById("admin-upload-section");
  if (adminSection) adminSection.style.display = window.isAdmin ? "" : "none";
  document.querySelectorAll(".upload-admin-only").forEach(el => {
    el.style.display = window.isAdmin ? "" : "none";
  });

  // Every other sidebar nav button is gated by the user's
  // sidebar_permissions (module keys match each button's data-page /
  // pharma-alloc.html link). Admin always sees everything.
  if (typeof canAccessModule === "function") {
    document.querySelectorAll(".nav-btn[data-page]").forEach(btn => {
      const key = btn.getAttribute("data-page");
      btn.style.display = canAccessModule(key) ? "" : "none";
    });
    const allocBtn = document.querySelector('.nav-btn[href="pharma-alloc.html"]');
    if (allocBtn) allocBtn.style.display = canAccessModule("allocation-tool") ? "" : "none";

    // SEC-ACCESS-GATE: the "Quality & Risk" / "Inventory Ops" / "Analytics"
    // group overview cards (index.html) are a second, independent entry
    // point into a module — separate from the sidebar nav-btn above — so
    // they need their own permission check here, or a user could still see
    // and click a card into a module whose nav-btn is hidden.
    document.querySelectorAll('.overview-card[data-goto]').forEach(card => {
      const key = card.dataset.goto;
      card.style.display = canAccessModule(key) ? "" : "none";
    });

    // Group overview subtitles: each of these pages has a static sentence
    // naming every tool in the section, which used to show even when a
    // user only had a subset of those tools granted. GROUP_OVERVIEW_CONFIG
    // rebuilds the subtitle from just the tool(s) this user can actually
    // see, same as Quick Lookup's subtitle just below.
    Object.keys(GROUP_OVERVIEW_CONFIG).forEach(updateGroupOverviewSubtitle);

    // Person Assigned — sidebar filter group, gated on its own module key
    // (not a nav-btn, so it isn't touched by the generic loop above).
    const personAssignedGroup = document.getElementById("person-assigned-group");
    if (personAssignedGroup) {
      personAssignedGroup.style.display = canAccessModule("person-assigned") ? "" : "none";
    }

    // Quick Lookup — "quick-lookup" is the parent switch for the whole
    // section: the sidebar entry (which isn't a nav-btn either, so it
    // needs its own check here) and the overview page it opens. The three
    // tools inside (Who's Responsible?, Shelf Life Look-up, New Received
    // Stock) each get their own sub-key so an admin can show the section
    // but hide individual tools — but only when the parent is on; if the
    // parent is off, everything under it is hidden regardless of the
    // sub-keys' own state.
    const canQuickLookup = canAccessModule("quick-lookup");
    const quickLookupGroup = document.getElementById("quick-lookup-group");
    if (quickLookupGroup) quickLookupGroup.style.display = canQuickLookup ? "" : "none";
    const quickLookupPage = document.getElementById("page-group-quick-lookup");
    if (quickLookupPage && !canQuickLookup) quickLookupPage.style.display = "none";

    const quickLookupCards = {
      "quick-lookup-card-who-responsible": "who-responsible",
      "quick-lookup-card-shelf-life": "shelf-life-lookup",
      "quick-lookup-card-new-received": "new-received-stock",
    };
    // Short phrase for each tool, used to build the group subtitle below so
    // it only ever describes the tool(s) this user can actually see —
    // instead of a static sentence naming all three regardless of which
    // sub-keys are actually granted.
    const quickLookupPhrases = {
      "who-responsible": "find who owns a material",
      "shelf-life-lookup": "check its shelf life",
      "new-received-stock": "see what's arrived recently",
    };
    const visiblePhrases = [];
    Object.entries(quickLookupCards).forEach(([elId, subKey]) => {
      const card = document.getElementById(elId);
      const visible = canQuickLookup && canAccessModule(subKey);
      if (card) card.style.display = visible ? "" : "none";
      if (visible) visiblePhrases.push(quickLookupPhrases[subKey]);
    });

    const quickLookupSubtitle = document.querySelector("#page-group-quick-lookup .page-subtitle");
    if (quickLookupSubtitle) {
      quickLookupSubtitle.textContent = visiblePhrases.length
        ? `Fast, one-off searches you can run without digging through a full report — ${joinPhrases(visiblePhrases, "or")}.`
        : "Fast, one-off searches you can run without digging through a full report.";
    }
  }

  // User Management — gated on canManageRoles() (Admin + Director + Deputy
  // Director), not on sidebar_permissions like the modules above, since
  // it's part of the Access Level matrix itself rather than a togglable
  // module. The button carries data-page="user-management" (so it gets
  // active-state highlighting and click-wiring like every other nav-btn),
  // which means the generic canAccessModule() loop above also touches it
  // and — since "user-management" isn't a real sidebar_permission key —
  // sets its own display:none for everyone. We override that here.
  if (typeof canManageRoles === "function") {
    const showUserMgmt = canManageRoles();
    const umGroup = document.getElementById("user-mgmt-group");
    const umDivider = document.getElementById("user-mgmt-divider");
    const umBtn = document.getElementById("user-mgmt-nav-btn");
    if (umGroup) umGroup.style.display = showUserMgmt ? "" : "none";
    if (umDivider) umDivider.style.display = showUserMgmt ? "" : "none";
    if (umBtn) umBtn.style.display = showUserMgmt ? "" : "none";
  }

  // Hide now-empty nav groups (all their buttons hidden) so the sidebar
  // doesn't show a bare section title with nothing under it.
  document.querySelectorAll(".nav-group[data-group]").forEach(group => {
    const buttons = group.querySelectorAll(".nav-btn");
    if (!buttons.length) return;
    const anyVisible = Array.from(buttons).some(b => b.style.display !== "none");
    group.style.display = anyVisible ? "" : "none";
  });

  // Sidebar user badge (role/email) removed — that info already lives in
  // the top-right Profile menu (see settings-menu.js), no need to
  // duplicate it here.
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ── 4) SESSION / PROFILE RESOLUTION ──
async function loadProfileAndUnlock(session) {
  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("role,email,full_name,status,data_scopes,sidebar_permissions,plant")
    .eq("id", session.user.id)
    .single();

  if (error) {
    console.error("Could not load profile:", error);
    const errEl = document.getElementById("auth-error");
    if (errEl) { errEl.style.color = "var(--red, #e04545)"; errEl.textContent = "Could not load your profile. Contact an admin."; }
    return;
  }

  if (profile.status === "inactive") {
    const errEl = document.getElementById("auth-error");
    if (errEl) { errEl.style.color = "var(--red, #e04545)"; errEl.textContent = "This account has been deactivated. Contact an admin."; }
    await supabaseClient.auth.signOut();
    return;
  }

  // FIX: normalize the role read from Supabase before comparing/storing it.
  // profile.role === "admin" used to be a strict, case-sensitive match — a
  // DB value of "Admin", "ADMIN", or "admin " (trailing space) would silently
  // fail this check, leaving window.isAdmin false and dropping the account
  // into scope-gated access (e.g. Q-type rows disappearing) with no error
  // shown anywhere. Trim + lowercase once here so every downstream check
  // (isAdmin, currentRole(), role-based UI) sees a clean value.
  const normalizedRole = String(profile.role || "").trim().toLowerCase();

  window.APP_USER = {
    id: session.user.id,
    email: profile.email || session.user.email,
    full_name: profile.full_name || "",
    role: normalizedRole,
    status: profile.status,
    // PLANT SCOPING: "HO01" (or unset) = sees every plant; any other code
    // restricts the user to that plant (+ the HO01 hub) app-wide — see
    // permissions.js (getUserPlant / isHeadOfficeUser / canAccessPlant /
    // getVisiblePlants) for the single source of truth this feeds. Normalized
    // the same way role is above (trim + uppercase) so a stray "ho01" or
    // trailing space in the DB doesn't silently fall through the "not HO01"
    // branch and lock a Head Office user down to nothing.
    plant: profile.plant ? String(profile.plant).trim().toUpperCase() : null,
    data_scopes: profile.data_scopes || [],
    sidebar_permissions: profile.sidebar_permissions || {},
  };
  window.isAdmin = normalizedRole === "admin";

  // Module catalog — needed by permissions.js (canAccessModule) and by the
  // sidebar renderer to know labels/icons/groups for every module key,
  // including ones added later without a code change (e.g. Warehouse/Quality).
  const { data: modules, error: modulesError } = await supabaseClient
    .from("app_modules")
    .select("key,label,icon,nav_group,sort_order,scoped,active")
    .order("sort_order", { ascending: true });
  window.APP_MODULES = modulesError ? [] : (modules || []);
  if (modulesError) console.error("Could not load app_modules:", modulesError);

  applyRoleToUI();
  hideAuthOverlay();
  // FIX-HARD-REFRESH-FLASH: #sidebar/#main are hidden (visibility:hidden)
  // by default straight in the HTML, BEFORE any JS runs. Only reveal them
  // here, after applyRoleToUI() has already hidden nav buttons the signed-in
  // user's role doesn't grant. Without this, on a normal page load the app
  // shell was hidden only by JS (removed once DOMContentLoaded/initAuth
  // fired and the auth overlay covered it) — on a hard refresh (Ctrl+Shift+R,
  // no cache), that JS takes longer to load/run than usual, so there was a
  // real window where the full sidebar (every module's nav button) sat
  // visible and clickable in the raw HTML before role-gating ever applied.
  const sidebarEl = document.getElementById("sidebar");
  const mainEl    = document.getElementById("main");
  if (sidebarEl) sidebarEl.style.visibility = "";
  if (mainEl)    mainEl.style.visibility    = "";

  // Tell the rest of the app auth is ready (storage-sync.js listens for this)
  document.dispatchEvent(new CustomEvent("epss-auth-ready", { detail: window.APP_USER }));
}

async function initAuth() {
  injectAuthOverlay();
  showAuthOverlay();

  const loadingEl = document.getElementById("auth-loading");
  loadingEl.classList.add("show");

  document.getElementById("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email    = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const btn      = document.getElementById("auth-submit");
    const errEl    = document.getElementById("auth-error");
    errEl.style.color = "var(--red, #e04545)";
    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Signing in…";

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

    btn.disabled = false;
    btn.textContent = "→ Login";

    if (error) {
      errEl.textContent = error.message;
      return;
    }
    await loadProfileAndUnlock(data.session);
  });

  if (authRecoveryMode) {
    // PASSWORD_RECOVERY already fired before the overlay existed — show the
    // reset form now instead of silently logging the user in below.
    loadingEl.classList.remove("show");
    showResetPasswordForm();
    return;
  }

  // Restore existing session (page refresh)
  const { data: { session } } = await supabaseClient.auth.getSession();
  loadingEl.classList.remove("show");
  if (session && !authRecoveryMode) await loadProfileAndUnlock(session);
}

document.addEventListener("DOMContentLoaded", initAuth);
