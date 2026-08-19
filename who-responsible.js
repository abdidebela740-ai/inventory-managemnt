// =============================================================================
// PharmaTrack v2 — who-responsible.js
// "🔎 Who's Responsible?" — sidebar search that answers, for any material:
// who owns it, how much sits at the hub, how many branches carry it, its
// National MOS, and (when expiry-risk.js is loaded) how many at-risk items
// across the WHOLE portfolio belong to that same responsible person.
//
// Requires: script.js (rawDf, personFilter, fmtQty, fmtETB, escHtml, renderPage)
//           mos.js (mosMerged, HUB_PLANT, buildMosSohMap, computeNationalMOS,
//           fmtMosVal)
// Optional: expiry-risk.js (buildRiskSnapshot) — powers the "At-Risk Items"
//           tile and its "View at-risk items" button. Degrades gracefully
//           (tile shows "—") if expiry-risk.js isn't loaded.
// Must be loaded AFTER both script.js and mos.js.
// =============================================================================

(function whoResponsibleModule() {
  const MAX_SUGGESTIONS = 8;

  let activeIndex = -1;
  let currentMatches = [];

  // ── Wrap the first match of `q` inside `text` in a <mark> for highlighting ──
  function highlight(text, q) {
    const safe = escHtml(String(text ?? ""));
    if (!q) return safe;
    const idx = String(text ?? "").toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return safe;
    const raw = String(text ?? "");
    const before = escHtml(raw.slice(0, idx));
    const match  = escHtml(raw.slice(idx, idx + q.length));
    const after  = escHtml(raw.slice(idx + q.length));
    return `${before}<mark>${match}</mark>${after}`;
  }

  // ── Find matching materials from the AMC-derived master list ──────────────
  // Prefix matches (code or description starts with the query) are ranked
  // above mid-string matches, e.g. typing "c" surfaces codes/names starting
  // with "c" first, then "ce" narrows further, etc.
  function findMatches(query) {
    if (typeof mosMerged === "undefined" || !mosMerged.length) return { rows: [], noData: true };
    const q = query.trim().toLowerCase();
    if (!q) return { rows: [], noData: false };

    let pool = mosMerged;
    if (typeof personFilter !== "undefined" && personFilter.size > 0) {
      pool = pool.filter(r => r.person && personFilter.has(r.person));
    }

    const starts = [];
    const contains = [];
    for (const r of pool) {
      const code = String(r.code || "").toLowerCase();
      const desc = String(r.desc || "").toLowerCase();
      if (code.startsWith(q) || desc.startsWith(q)) starts.push(r);
      else if (code.includes(q) || desc.includes(q)) contains.push(r);
      if (starts.length + contains.length >= MAX_SUGGESTIONS * 4) break; // cheap early-out on huge lists
    }
    return { rows: [...starts, ...contains].slice(0, MAX_SUGGESTIONS), noData: false };
  }

  // ── Suggestions dropdown ───────────────────────────────────────────────────
  function positionSuggestions() {
    const input = document.getElementById("who-resp-input");
    const box   = document.getElementById("who-resp-suggestions");
    if (!input || !box) return;
    const r = input.getBoundingClientRect();
    box.style.left  = `${r.left}px`;
    box.style.top   = `${r.bottom + 4}px`;
    box.style.width = `${r.width}px`;
  }

  function closeSuggestions() {
    const box = document.getElementById("who-resp-suggestions");
    if (!box) return;
    box.classList.remove("open");
    box.innerHTML = "";
    currentMatches = [];
    activeIndex = -1;
  }

  function renderSuggestions(query) {
    const box = document.getElementById("who-resp-suggestions");
    if (!box) return;

    const { rows, noData } = findMatches(query);
    currentMatches = rows;
    activeIndex = -1;

    if (noData) {
      box.innerHTML = `<div class="who-resp-empty">Upload <b>AMC.xlsx</b> in the sidebar to enable this search.</div>`;
      positionSuggestions();
      box.classList.add("open");
      return;
    }
    if (!rows.length) {
      box.innerHTML = query.trim()
        ? `<div class="who-resp-empty">No matching materials.</div>`
        : "";
      positionSuggestions();
      box.classList.toggle("open", !!query.trim());
      return;
    }

    const q = query.trim();
    box.innerHTML = rows.map((r, i) => `
      <div class="who-resp-item" data-idx="${i}" data-code="${escHtml(r.code)}">
        <span class="who-resp-item-code">${highlight(r.code, q)}</span>
        <span class="who-resp-item-desc">${highlight(r.desc || "—", q)}</span>
      </div>
    `).join("");
    positionSuggestions();
    box.classList.add("open");
  }

  function setActive(idx) {
    const items = document.querySelectorAll("#who-resp-suggestions .who-resp-item");
    items.forEach(el => el.classList.remove("who-resp-active"));
    if (idx >= 0 && idx < items.length) {
      items[idx].classList.add("who-resp-active");
      items[idx].scrollIntoView({ block: "nearest" });
    }
    activeIndex = idx;
  }

  // ── At-risk items assigned to a given person ──────────────────────────────
  // Cross-references expiry-risk.js's buildRiskSnapshot(): counts distinct
  // materials (across all plants) that are currently AT RISK (more stock on
  // hand than can be consumed before expiry) and assigned to `person`.
  //
  // buildRiskSnapshot() -> getMosFilteredRows() already applies whatever
  // person is in the GLOBAL sidebar personFilter, which is usually NOT the
  // person this card is about. We temporarily swap the global filter to
  // exactly this person, read the snapshot, then restore it — safe because
  // buildRiskSnapshot() is fully synchronous (no awaits in between).
  function computeAtRiskForPerson(person) {
    if (!person) return null;
    if (typeof buildRiskSnapshot !== "function" || typeof personFilter === "undefined") return null;

    const savedFilter = personFilter;
    let snapshot;
    try {
      personFilter = new Set([person]);
      snapshot = buildRiskSnapshot("", "", "");
    } catch (e) {
      console.error("[who-responsible] computeAtRiskForPerson failed:", e);
      return null;
    } finally {
      personFilter = savedFilter;
    }

    const atRiskRows = snapshot.filter(r => r.atRisk);
    const codes = new Set(atRiskRows.map(r => r.code));
    const totalVal = atRiskRows.reduce((s, r) => s + (r.atRiskVal || 0), 0);
    return { materialCount: codes.size, totalVal };
  }

  // ── Build the data shown in the result card ────────────────────────────────
  function buildCardData(code) {
    const r = mosMerged.find(m => m.code === code);
    if (!r) return null;

    const hub    = (typeof HUB_PLANT !== "undefined") ? HUB_PLANT : "HO01";
    const sohMap = (typeof buildMosSohMap === "function") ? buildMosSohMap() : new Map();
    const plantMap = sohMap.get(code) || {};
    const ho01Soh = plantMap[hub] || 0;

    // Universe of branch plants = every plant code seen in the inventory file,
    // excluding the hub — so the denominator always reflects the currently
    // loaded data, not a hardcoded plant count.
    const branchPlants = new Set();
    if (typeof rawDf !== "undefined") {
      rawDf.forEach(row => {
        const p = String(row["Plant"] || "").trim().toUpperCase();
        if (p && p !== hub) branchPlants.add(p);
      });
    }
    let withStock = 0;
    branchPlants.forEach(p => { if ((plantMap[p] || 0) > 0) withStock++; });

    const nat = (typeof computeNationalMOS === "function") ? computeNationalMOS(r, sohMap) : null;

    const atRisk = r.person ? computeAtRiskForPerson(r.person) : null;

    return {
      code: r.code,
      desc: r.desc,
      person: r.person || "",
      ho01Soh,
      branchesWithStock: withStock,
      branchesTotal: branchPlants.size,
      nationalMos: nat ? nat.mos : null,
      nationalSoh: nat ? nat.totalSoh : null,
      atRiskCount: atRisk ? atRisk.materialCount : null,
      atRiskVal: atRisk ? atRisk.totalVal : null,
    };
  }

  // ── Result modal ───────────────────────────────────────────────────────────
  function escHandler(e) { if (e.key === "Escape") closeModal(); }

  function closeModal() {
    const overlay = document.getElementById("who-resp-modal-overlay");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", escHandler);
  }

  function applyPersonFilter(person) {
    const sel = document.getElementById("global-person-filter");
    if (!sel) return;
    sel.value = person;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function showCard(code) {
    const data = buildCardData(code);
    if (!data) return;
    closeSuggestions();

    const mosDisplay = (typeof fmtMosVal === "function")
      ? fmtMosVal(data.nationalMos)
      : (data.nationalMos === null ? "—" : String(data.nationalMos));
    const personLabel = data.person || "Not assigned";

    const overlay = document.createElement("div");
    overlay.id = "who-resp-modal-overlay";
    overlay.className = "who-resp-modal-overlay";
    overlay.innerHTML = `
      <div class="who-resp-modal" role="dialog" aria-modal="true" aria-label="Who's responsible for ${escHtml(data.code)}">
        <button class="who-resp-modal-close" id="who-resp-modal-close" type="button" aria-label="Close">✕</button>
        <div class="who-resp-modal-header">
          <div class="who-resp-modal-code">${escHtml(data.code)}</div>
          <div class="who-resp-modal-desc">${escHtml(data.desc || "—")}</div>
        </div>
        <div class="who-resp-modal-grid">
          <div class="who-resp-stat">
            <div class="who-resp-stat-label">👤 Person Assigned</div>
            <div class="who-resp-stat-value">${escHtml(personLabel)}</div>
          </div>
          <div class="who-resp-stat">
            <div class="who-resp-stat-label">🏬 HO01 Stock on Hand</div>
            <div class="who-resp-stat-value">${fmtQty(data.ho01Soh)}</div>
          </div>
          <div class="who-resp-stat">
            <div class="who-resp-stat-label">🌍 Branches with Stock</div>
            <div class="who-resp-stat-value">${data.branchesWithStock} / ${data.branchesTotal}</div>
          </div>
          <div class="who-resp-stat">
            <div class="who-resp-stat-label">📐 National MOS</div>
            <div class="who-resp-stat-value">${mosDisplay}</div>
          </div>
          <div class="who-resp-stat">
            <div class="who-resp-stat-label">🏦 National SOH</div>
            <div class="who-resp-stat-value">${data.nationalSoh === null ? "—" : fmtQty(data.nationalSoh)}</div>
          </div>
        </div>
        ${data.person
          ? `<button type="button" class="apply-btn who-resp-view-all" id="who-resp-view-all">View all of ${escHtml(data.person)}'s items →</button>`
          : `<div class="alert-info" style="margin-top:0.2rem">No responsible person on file for this material.</div>`}
        ${(data.person && data.atRiskCount)
          ? `<button type="button" class="apply-btn who-resp-view-at-risk" id="who-resp-view-at-risk">View ${escHtml(data.person)}'s at-risk items →</button>`
          : ""}
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    document.getElementById("who-resp-modal-close").addEventListener("click", closeModal);
    const viewAllBtn = document.getElementById("who-resp-view-all");
    if (viewAllBtn) {
      viewAllBtn.addEventListener("click", () => {
        applyPersonFilter(data.person);
        closeModal();
      });
    }
    const viewAtRiskBtn = document.getElementById("who-resp-view-at-risk");
    if (viewAtRiskBtn) {
      viewAtRiskBtn.addEventListener("click", () => {
        applyPersonFilter(data.person);
        closeModal();
        // Same "click the real nav button" convention script.js uses elsewhere
        // (e.g. dashboard KPI card drilldowns) so currentPage/nav highlighting
        // stay in sync, rather than calling renderPage() directly.
        const navBtn = document.querySelector('.nav-btn[data-page="expiry-risk"]');
        if (navBtn) navBtn.click();
      });
    }
    document.addEventListener("keydown", escHandler);
  }

  function selectMatch(idx) {
    const m = currentMatches[idx];
    if (!m) return;
    showCard(m.code);
    const input = document.getElementById("who-resp-input");
    if (input) input.value = "";
    closeSuggestions();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function wire() {
    const input = document.getElementById("who-resp-input");
    const box   = document.getElementById("who-resp-suggestions");
    if (!input || !box) return;

    input.addEventListener("input", () => renderSuggestions(input.value));
    input.addEventListener("focus", () => { if (input.value.trim()) renderSuggestions(input.value); });

    input.addEventListener("keydown", (e) => {
      const items = document.querySelectorAll("#who-resp-suggestions .who-resp-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!items.length) return;
        setActive(activeIndex < items.length - 1 ? activeIndex + 1 : 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!items.length) return;
        setActive(activeIndex > 0 ? activeIndex - 1 : items.length - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIndex >= 0) selectMatch(activeIndex);
        else if (currentMatches.length) selectMatch(0);
      } else if (e.key === "Escape") {
        closeSuggestions();
        input.blur();
      }
    });

    box.addEventListener("click", (e) => {
      const item = e.target.closest(".who-resp-item[data-idx]");
      if (!item) return;
      selectMatch(Number(item.dataset.idx));
    });

    document.addEventListener("click", (e) => {
      if (e.target === input || box.contains(e.target)) return;
      closeSuggestions();
    });

    window.addEventListener("resize", () => { if (box.classList.contains("open")) positionSuggestions(); });
    window.addEventListener("scroll", () => { if (box.classList.contains("open")) positionSuggestions(); }, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
