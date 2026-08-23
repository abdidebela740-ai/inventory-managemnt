// ════════════════════════════════════════════════════════════════
// pwa-mobile-nav.js — small, additive mobile-only behaviors layered on
// top of the app's EXISTING drawer (#sidebar / #sidebar-overlay /
// #mobile-menu-btn, wired up inline in index.html) and its EXISTING
// filter bars (.filter-bar). This script never re-implements the
// drawer's open/close logic and never creates a second hamburger
// button or backdrop — it only:
//
//   1. Locks background scroll while the drawer is open (the inline
//      toggle script adds/removes the "open" class on #sidebar but
//      never touched body scroll, so the page behind the drawer could
//      still scroll — this watches that class and fixes it).
//   2. Closes the drawer on Escape, for keyboards/accessibility.
//   3. Collapses each .filter-bar into a "Filters" accordion by
//      default on phones, so filter selects don't dominate the screen
//      before the user asks to see them. Apply/Clear buttons are never
//      moved — only the OTHER children of .filter-bar are wrapped into
//      a .mobile-filter-fields container — so this can never reorder
//      or detach the actual filter controls or their event listeners.
//   4. Back-fills a data-label attribute onto any table cell that
//      doesn't already have one (buildTable() in script.js stamps this
//      itself; a few hand-built tables elsewhere don't), which the
//      mobile card-view CSS (style.css, ≤640px) relies on to turn a
//      wide table row into a labeled "field: value" card.
//   5. Injects a per-table "▤ Table view" toggle so a user can opt back
//      into the classic scrollable table instead of the card view.
//   6. Injects a persistent bottom tab bar (Dashboard / Risks / Stock /
//      Requests / More) for the highest-frequency modules. Its buttons
//      call the app's own navReset() (script.js) directly and share the
//      .nav-btn[data-page] class so they participate in the app's
//      existing active-state highlighting — without re-implementing
//      routing or active-state logic from scratch.
//
// Everything here is gated on window.matchMedia("(max-width: 640px)"),
// matching the same breakpoint style.css already uses for its
// "RESPONSIVE — MOBILE" block, and every visual effect is driven by
// CSS classes that only DO anything inside that same breakpoint (see
// style.css). Above 640px this file is a no-op.
// ════════════════════════════════════════════════════════════════

(function mobileEnhancements() {
  const MQ = window.matchMedia("(max-width: 640px)");

  // ── 1 & 2: drawer scroll-lock + Escape-to-close ──────────────────
  function initDrawerEnhancements() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (!sidebar || sidebar.dataset.mobileNavEnhanced === "1") return;
    sidebar.dataset.mobileNavEnhanced = "1";

    const syncScrollLock = () => {
      const isOpen = sidebar.classList.contains("open");
      document.body.classList.toggle("mobile-drawer-locked", isOpen && MQ.matches);
    };

    // The inline toggle script only ever adds/removes the "open" class —
    // observing it here keeps this in sync without touching that script.
    new MutationObserver(syncScrollLock).observe(sidebar, {
      attributes: true,
      attributeFilter: ["class"],
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && MQ.matches && sidebar.classList.contains("open") && overlay) {
        overlay.click(); // reuses the app's own close logic
      }
    });
  }

  // ── 3: filter-bar → collapsed-by-default accordion ───────────────
  function wrapFilterBar(bar) {
    if (bar.dataset.mobileWrapped === "1") return;

    const fieldEls = Array.from(bar.children).filter(
      (el) => !(el.tagName === "BUTTON" && el.classList.contains("apply-btn"))
    );
    if (!fieldEls.length) return; // nothing to collapse (action-only bar)

    bar.dataset.mobileWrapped = "1";

    const fieldsWrap = document.createElement("div");
    fieldsWrap.className = "mobile-filter-fields";
    bar.insertBefore(fieldsWrap, fieldEls[0]);
    fieldEls.forEach((el) => fieldsWrap.appendChild(el));

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "mobile-filter-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML =
      '<span class="mft-label">🔍 Filters</span><span class="mft-chevron">▾</span>';
    bar.insertBefore(toggle, fieldsWrap);
    bar.classList.add("mobile-collapsed");

    toggle.addEventListener("click", () => {
      const stillCollapsed = bar.classList.toggle("mobile-collapsed");
      toggle.setAttribute("aria-expanded", String(!stillCollapsed));
    });
  }

  function initFilterAccordions() {
    if (!MQ.matches) return;
    document.querySelectorAll(".filter-bar").forEach(wrapFilterBar);
  }

  // ── 4: back-fill data-label on tables NOT built by buildTable() ──
  // buildTable() (script.js) already stamps data-label on every <td> at
  // render time — covers the vast majority of tables app-wide. A handful
  // of pages (pending-dispatch.js, stockout-risk.js's freeze-header
  // tables) build their <table> markup by hand and have no data-label.
  // Rather than edit each of those files, this walks any table missing
  // labels and derives them from its own <thead> th text, so the mobile
  // card-view CSS (style.css, ≤640px, ".tbl-wrap:not(.force-table-view)")
  // works identically for every table in the app.
  function backfillDataLabels(table) {
    if (table.dataset.labelsBackfilled === "1") return;
    const headRow = table.querySelector("thead tr");
    if (!headRow) return;
    const labels = Array.from(headRow.children).map(th => th.textContent.trim());
    if (!labels.length) return;
    table.querySelectorAll("tbody tr").forEach(tr => {
      Array.from(tr.children).forEach((td, i) => {
        if (!td.hasAttribute("data-label") && labels[i] !== undefined) {
          td.setAttribute("data-label", labels[i]);
        }
      });
    });
    table.dataset.labelsBackfilled = "1";
  }

  // ── 5: "▤ Table view" toggle — lets a user opt back into the classic
  // scrollable table instead of the card view, per table, on demand.
  function ensureTableViewToggle(wrap) {
    if (wrap.querySelector(".tbl-view-toggle")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tbl-view-toggle";
    btn.textContent = "▤ Table view";
    btn.addEventListener("click", () => {
      const isTable = wrap.classList.toggle("force-table-view");
      btn.textContent = isTable ? "▥ Card view" : "▤ Table view";
    });
    wrap.style.position = wrap.style.position || "relative";
    wrap.insertBefore(btn, wrap.firstChild);
  }

  // Runs the two enhancements above over every table currently in the DOM.
  // Cheap (skips tables already processed via dataset flags / existing
  // toggle check) so it's safe to call often.
  function enhanceTables() {
    document.querySelectorAll(".tbl-wrap").forEach(wrap => {
      const table = wrap.querySelector("table");
      if (table) backfillDataLabels(table);
      ensureTableViewToggle(wrap);
    });
    // A few tables in this app render outside a .tbl-wrap (e.g.
    // pending-dispatch.js's raw <table> blocks) — still worth labeling
    // for the card CSS, just no toggle button (nowhere safe to anchor one
    // without risking overlapping that page's own custom header controls).
    document.querySelectorAll("table:not(.tbl-wrap table)").forEach(backfillDataLabels);
  }

  // Re-run whenever the page content changes (new render, filter apply,
  // page switch) — the app re-renders pages by replacing innerHTML wholesale
  // rather than through a single central hook, so observing #main is the
  // one place that reliably catches every case.
  function initTableEnhancer() {
    const main = document.getElementById("main");
    if (!main || main.dataset.tableEnhancerAttached === "1") return;
    main.dataset.tableEnhancerAttached = "1";
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; enhanceTables(); });
    };
    new MutationObserver(schedule).observe(main, { childList: true, subtree: true });
    schedule();
  }

  // ── 6: bottom tab bar — Dashboard / Risks / Stock / Requests / More.
  // Buttons for real pages reuse the existing `.nav-btn[data-page]` class
  // so script.js's own DOMContentLoaded listener (which wires EVERY
  // .nav-btn[data-page] it finds to navReset()) picks these up for free —
  // no extra routing/active-state code needed here. Layout/visibility
  // (mobile-only) lives entirely in style.css (#mobile-bottom-nav block).
  const BOTTOM_NAV_ITEMS = [
    { page: "dashboard",      icon: "📊", label: "Dashboard" },
    { page: "stockout-risk",  icon: "📉", label: "Risks" },
    { page: "natl-table",     icon: "🗂️", label: "Stock" },
    { page: "request-analysis", icon: "🧾", label: "Requests" },
  ];
  function buildBottomNav() {
    if (document.getElementById("mobile-bottom-nav")) return;
    const main = document.getElementById("main");
    if (!main) return;

    const nav = document.createElement("nav");
    nav.id = "mobile-bottom-nav";
    nav.setAttribute("aria-label", "Primary");

    BOTTOM_NAV_ITEMS.forEach(item => {
      const btn = document.createElement("button");
      btn.type = "button";
      // Shares the sidebar's .nav-btn class purely so the app's existing
      // "toggle .active on whichever .nav-btn matches currentPage" logic
      // (navReset()/renderPage() in script.js, which re-queries ALL
      // .nav-btn[data-page] elements live on every navigation) picks this
      // button up automatically for active-state highlighting.
      //
      // NOTE: the click→navReset() WIRING itself is done explicitly below,
      // not inherited — script.js only attaches that listener once, to
      // whatever .nav-btn elements exist at its own DOMContentLoaded, which
      // fires (scripts execute in document order when deferred) BEFORE
      // this bottom nav is built. Without this explicit listener the
      // buttons would highlight correctly but never actually navigate.
      btn.className = "nav-btn";
      btn.dataset.page = item.page;
      btn.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener("click", () => {
        if (typeof navReset === "function") navReset(item.page);
        // Mirror index.html's own "close drawer on nav click" behavior
        // (inline script) for these buttons too — that inline listener
        // only ever wired the .nav-btn elements that existed when IT ran,
        // which is before this bottom nav is built, so it can't reach
        // these buttons on its own.
        const sidebar = document.getElementById("sidebar");
        if (sidebar && sidebar.classList.contains("open") && MQ.matches) {
          const overlay = document.getElementById("sidebar-overlay");
          if (overlay) overlay.click();
        }
      });
      nav.appendChild(btn);
    });

    // "More" isn't a page — it opens the existing hamburger drawer, reusing
    // its own open/close logic (index.html) rather than duplicating it.
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "bottom-nav-more-btn";
    moreBtn.innerHTML = `<span class="nav-icon">☰</span><span>More</span>`;
    moreBtn.addEventListener("click", () => {
      const menuBtn = document.getElementById("mobile-menu-btn");
      if (menuBtn) menuBtn.click();
    });
    nav.appendChild(moreBtn);

    document.body.appendChild(nav);
  }

  function init() {
    initDrawerEnhancements();
    initFilterAccordions();
    buildBottomNav();
    initTableEnhancer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // The app shows/hides #sidebar and page content (visibility:hidden →
  // visible) once auth resolves, and filter bars for gated pages may not
  // exist until then either — re-run defensively once that happens.
  document.addEventListener("epss-auth-ready", init);

  // Re-check on tablet/desktop rotation into or out of the phone range
  // (matchMedia listeners don't retroactively wrap/unwrap existing bars —
  // .mobile-filter-fields uses display:contents above 640px, so an
  // already-wrapped bar stays visually identical on desktop with no
  // further action needed).
  MQ.addEventListener("change", initFilterAccordions);
})();
