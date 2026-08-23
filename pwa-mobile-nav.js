// ════════════════════════════════════════════════════════════════
// pwa-mobile-nav.js — turns the existing #sidebar into an off-canvas
// drawer on small screens (≤900px) by injecting a hamburger button
// and a tap-to-close backdrop. Desktop is completely unaffected:
// this script only ever adds/removes the "mobile-open" class, and
// pwa-mobile.css only positions the sidebar as a drawer inside a
// max-width media query.
//
// Load AFTER auth.js/script.js (defer, end of body is fine) so the
// sidebar element already exists.
// ════════════════════════════════════════════════════════════════

(function mobileNavModule() {
  const BREAKPOINT = 900;

  function isMobile() {
    return window.innerWidth <= BREAKPOINT;
  }

  function init() {
    const sidebar = document.getElementById("sidebar");
    const main = document.getElementById("main");
    if (!sidebar) return; // page has no sidebar (e.g. login screen state)

    // ── Backdrop (click to close) ──
    let backdrop = document.querySelector(".mobile-sidebar-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "mobile-sidebar-backdrop";
      document.body.appendChild(backdrop);
    }

    // ── Hamburger toggle button ──
    let toggle = document.getElementById("mobile-menu-toggle");
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.id = "mobile-menu-toggle";
      toggle.type = "button";
      toggle.className = "mobile-menu-toggle";
      toggle.setAttribute("aria-label", "Open menu");
      toggle.textContent = "☰";
      // Insert at the very start of <main> so it sits at the top of the
      // content area regardless of the page's own header markup.
      if (main) {
        main.prepend(toggle);
      } else {
        document.body.prepend(toggle);
      }
    }

    function openDrawer() {
      sidebar.classList.add("mobile-open");
      backdrop.classList.add("active");
      document.body.style.overflow = "hidden"; // prevent background scroll
    }

    function closeDrawer() {
      sidebar.classList.remove("mobile-open");
      backdrop.classList.remove("active");
      document.body.style.overflow = "";
    }

    toggle.addEventListener("click", () => {
      sidebar.classList.contains("mobile-open") ? closeDrawer() : openDrawer();
    });
    backdrop.addEventListener("click", closeDrawer);

    // Auto-close the drawer whenever a nav link/button inside the
    // sidebar is tapped, so picking a page doesn't leave the drawer open.
    const nav = document.getElementById("nav");
    if (nav) {
      nav.addEventListener("click", (e) => {
        if (isMobile() && (e.target.closest("button") || e.target.closest("a"))) {
          closeDrawer();
        }
      });
    }

    // If the viewport is resized past the breakpoint (e.g. tablet
    // rotation, or a desktop window), make sure we're not stuck in a
    // "drawer open" state that no longer applies.
    window.addEventListener("resize", () => {
      if (!isMobile()) closeDrawer();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // The app shows/hides #sidebar (visibility:hidden → visible) once auth
  // resolves; re-run init defensively once that happens too.
  document.addEventListener("epss-auth-ready", init);
})();
