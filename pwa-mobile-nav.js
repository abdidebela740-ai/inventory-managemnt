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

  function init() {
    initDrawerEnhancements();
    initFilterAccordions();
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
