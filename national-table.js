// =============================================================================
// PharmaTrack v2 — national-table.js
// National Stock & Expiry-Adjusted MOS — one row per material, network-wide.
//
// COLUMNS
// -------
//   SOH                      Total Quantity (Unrestricted + verified Transit +
//                            QC) across ALL plants, including HO01 — same
//                            numerator as mos.js's National MOS
//                            (computeNationalMOS().totalSoh) and the same
//                            "Total Quantity" metric shown on Branch
//                            Comparison's material tab, so the two pages
//                            agree on this material's total.
//   <6mo SOH Excluded        portion of SOH sitting in batches with LESS THAN
//                            6 months to expiry — this is the qty left out of
//                            the weighted-average shelf-life calc below (it's
//                            included in SOH but not in the shelf-life avg).
//   MOS                      SOH ÷ AMC, where AMC = sum of every BRANCH
//                            plant's own AMC (HO01 excluded — HO01 doesn't
//                            consume, see mos.js header comment). This is
//                            exactly mos.js's existing National MOS.
//   Shelf life in Month      QUANTITY-WEIGHTED AVERAGE months-to-expiry
//                            across every batch of this material, at every
//                            plant, nationally. (Per product decision: NOT
//                            earliest-batch-wins — a weighted average, so one
//                            near-expiry batch doesn't dominate the whole row.)
//   Adjusted SOH for Expiry  min(SOH, max(0, ShelfLife) × AMC) — the portion
//                            of SOH that can realistically be consumed before
//                            the (weighted-average) shelf life runs out. Same
//                            "safeQty" idea used in expiry-risk.js, just fed
//                            the weighted-average shelf life instead of the
//                            earliest-batch one.
//   Adjusted MOS for Expiry  Adjusted SOH ÷ AMC (equivalently min(MOS, ShelfLife))
//
// "New AMC", "Unit", "Proposed Forecast for 2020" and "Safety Stock" from the
// original mockup are intentionally NOT included — dropped per product decision.
//
// Requires: script.js (rawDf, mappingTable, fmtQty, escHtml, buildTable,
//           downloadCSV, downloadExcel, getReconciledBase, PAGE_RENDERERS,
//           renderPage, currentPage, personFilter)
//           mos.js (HUB_PLANT, mosMerged, mosPlants, buildMosSohMap,
//           computeNationalMOS, getMosFilteredRows, fmtMosVal, mosCellStyle,
//           mosNABadge, isMosCritical)
// Must be loaded AFTER both script.js and mos.js.
// =============================================================================

// ── NATIONAL SHELF-LIFE LOOKUP (qty-weighted avg months-to-expiry per material) ──
// Batches with LESS THAN 6 months remaining are excluded from the average
// entirely (not counted in either the numerator or denominator) — a
// near-expiry batch shouldn't drag down the shelf-life figure for a material
// that's mostly long-dated stock. If a material has NO batch with >= 6 months
// remaining, its shelf life is reported as 0 (per product decision), not N/A.
const NATL_SHELF_LIFE_FLOOR_MO = 6;

// Each map value is { shelf, excludedQty }:
//   shelf       — qty-weighted avg months-to-expiry (>= 6mo batches only), or
//                 0 if the material has batches but none qualify, or null if
//                 the material has no batches with expiry data at all.
//   excludedQty — total Unrestricted Stock qty across batches with LESS THAN
//                 6 months remaining (the qty left out of the shelf-life avg).
function buildNatlShelfLifeMap() {
  const out  = new Map();
  const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
  if (!base.length) return out;

  const MS_PER_DAY  = 24 * 60 * 60 * 1000;
  const DAYS_PER_MO = 30.44; // consistent with expiry-risk.js's date math
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const acc = new Map(); // code → { qtySum, weightedSum, hasAnyBatch, excludedQty }
  for (const row of base) {
    const mat = String(row._mappedMaterial || row["Material"] || "").trim();
    const qty = Number(row["Unrestricted Stock"] || 0);
    if (!mat || qty <= 0) continue;
    if (!(row._expiry instanceof Date) || isNaN(row._expiry)) continue;

    const mo = (row._expiry.getTime() - today.getTime()) / MS_PER_DAY / DAYS_PER_MO; // can be negative if expired
    if (!acc.has(mat)) acc.set(mat, { qtySum: 0, weightedSum: 0, hasAnyBatch: false, excludedQty: 0 });
    const e = acc.get(mat);
    e.hasAnyBatch = true;

    if (mo < NATL_SHELF_LIFE_FLOOR_MO) { // excluded — near-expiry batch, doesn't count toward the average
      e.excludedQty += qty;
      continue;
    }
    e.qtySum      += qty;
    e.weightedSum += qty * mo;
  }
  acc.forEach((v, k) => {
    // No batch with >= 6mo remaining → report 0, not N/A (per product decision).
    const shelf = v.qtySum > 0 ? v.weightedSum / v.qtySum : (v.hasAnyBatch ? 0 : null);
    out.set(k, { shelf, excludedQty: v.excludedQty });
  });
  return out;
}

// ── BUILD ONE ROW PER MATERIAL ────────────────────────────────────────────────
function buildNatlTableRows(typeFilter, searchQ) {
  if (typeof mosMerged === "undefined" || !mosMerged.length) return [];
  const sohMap   = buildMosSohMap();
  const shelfMap = buildNatlShelfLifeMap();
  const rows     = (typeof getMosFilteredRows === "function")
    ? getMosFilteredRows(typeFilter || "", searchQ || "")
    : mosMerged.filter(r => !typeFilter || r.type === typeFilter);

  return rows.map((r, i) => {
    const nat   = computeNationalMOS(r, sohMap); // { totalSoh, totalAmc, mos, hasHo01 }
    const soh   = nat.totalSoh;
    const amc   = nat.totalAmc;
    const mos   = nat.mos;
    const shelfEntry  = shelfMap.has(r.code) ? shelfMap.get(r.code) : null;
    const shelf       = shelfEntry ? shelfEntry.shelf : null;
    const excludedQty = shelfEntry ? shelfEntry.excludedQty : 0;

    let adjSoh = null, adjMos = null;
    if (amc !== null && shelf !== null) {
      const safeQty = Math.max(0, shelf) * amc;
      adjSoh = Math.min(soh, safeQty);
      adjMos = amc > 0 ? adjSoh / amc : (adjSoh > 0 ? Infinity : null);
    }

    return { sn: i + 1, code: r.code, desc: r.desc, type: r.type, isMerged: r.isMerged, origCodes: r.origCodes,
             soh, amc, mos, shelf, excludedQty, adjSoh, adjMos };
  });
}

function natlExportNum(v) { return v === null || v === undefined ? "" : Number(v.toFixed ? v.toFixed(2) : v); }
function natlExportMos(v) {
  if (v === null || v === undefined) return "Not Committed";
  if (v === Infinity) return "∞";
  return Number(v).toFixed(1);
}

function natlKpiRow(cards) {
  const el = document.getElementById("natl-kpis");
  if (el) el.innerHTML = cards.join("");
}

// ── RENDER ─────────────────────────────────────────────────────────────────────
function renderNatlTable() {
  const noAmcEl  = document.getElementById("natl-no-amc");
  const contentEl= document.getElementById("natl-content");
  if (typeof mosMerged === "undefined" || !mosMerged.length) {
    if (noAmcEl)   noAmcEl.style.display   = "block";
    if (contentEl) contentEl.style.display = "none";
    return;
  }
  if (noAmcEl)   noAmcEl.style.display   = "none";
  if (contentEl) contentEl.style.display = "block";

  const searchEl = document.getElementById("natl-search");
  const typeEl   = document.getElementById("natl-type");
  const searchQ  = searchEl ? searchEl.value.trim() : "";
  const typeVal  = typeEl   ? typeEl.value.trim()   : "";

  const sohMap   = buildMosSohMap();
  const hasSoh   = sohMap.size > 0;
  const data     = buildNatlTableRows(typeVal, searchQ);

  // ── KPIs ─────────────────────────────────────────────────────────────────────
  const withMos       = data.filter(d => d.mos !== null && d.mos !== Infinity);
  const criticalCount = withMos.filter(d => isMosCritical(d.mos)).length;
  const withShelf      = data.filter(d => d.shelf !== null);
  const avgShelf        = withShelf.length ? withShelf.reduce((s, d) => s + d.shelf, 0) / withShelf.length : null;
  const overstocked    = data.filter(d => d.adjMos !== null && d.mos !== null && d.mos !== Infinity && d.adjMos < d.mos).length;

  natlKpiRow([
    mosKpiCard("Materials", data.length.toLocaleString(), typeVal || "All types", "blue"),
    mosKpiCard("National MOS Critical (<1mo)", criticalCount.toLocaleString(), `of ${withMos.length.toLocaleString()} with national MOS`, "red"),
    mosKpiCard("At Expiry Risk", overstocked.toLocaleString(), "Adjusted MOS < MOS (some stock may expire unused)", "orange"),
    mosKpiCard("Avg Shelf Life", avgShelf !== null ? `${avgShelf.toFixed(1)} mo` : "N/A", `of ${withShelf.length.toLocaleString()} items with expiry data`, "purple"),
    mosKpiCard("SOH Data Loaded", hasSoh ? "Yes" : "No", hasSoh ? "From inventory file" : "Upload inventory Excel for SOH", hasSoh ? "green" : "amber"),
  ]);

  if (!hasSoh) {
    document.getElementById("natl-table").innerHTML =
      '<div class="alert-info" style="margin:1rem 0">⚠️ Upload the main inventory Excel (sidebar) to provide stock-on-hand.</div>';
    const dlRow = document.getElementById("natl-dl-row");
    if (dlRow) dlRow.innerHTML = "";
    return;
  }

  // ── TABLE ────────────────────────────────────────────────────────────────────
  const cols = [
    { key: "sn",   label: "SN" },
    { key: "code", label: "Material Code",
      fmt: (v, r) => r.isMerged
        ? `<span class="col-mat-code">${escHtml(v)}</span><span class="mat-mapped-badge" title="Merged from: ${escHtml(r.origCodes)}">MERGED</span>`
        : `<span class="col-mat-code">${escHtml(v)}</span>`,
      raw: true, cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Material Description", cellClass: "col-mat-desc-wrap" },
    { key: "soh", label: "SOH", fmt: v => fmtQty(v), cellClass: "col-qty" },
    { key: "excludedQty", label: "<6mo SOH Excluded",
      fmt: v => v > 0 ? `<b style="color:#b45309">${fmtQty(v)}</b>` : fmtQty(0), raw: true, cellClass: "col-qty" },
    { key: "adjSoh", label: "Adjusted SOH for Expiry",
      fmt: v => v === null ? mosNABadge() : fmtQty(v), raw: true, cellClass: "col-qty" },
    { key: "mos", label: "MOS",
      fmt: v => `<span style="${mosCellStyle(v)}">${fmtMosVal(v)}</span>`, raw: true },
    { key: "adjMos", label: "Adjusted MOS for Expiry",
      fmt: v => `<span style="${mosCellStyle(v)}">${fmtMosVal(v)}</span>`, raw: true },
    { key: "shelf", label: "Shelf life in Month",
      fmt: v => v === null ? mosNABadge() : `<b>${v.toFixed(1)}</b> mo`, raw: true },
  ];

  document.getElementById("natl-table").innerHTML = buildTable(
    data, cols,
    (row) => (isMosCritical(row.mos) || isMosCritical(row.adjMos)) ? "row-red" : "",
    "", {id:"natl-export", title:""}
  );

  // ── EXPORT ───────────────────────────────────────────────────────────────────
  const exportRows = data.map(d => ({
    code: d.code, desc: d.desc, type: d.type,
    soh: natlExportNum(d.soh),
    excludedQty: natlExportNum(d.excludedQty),
    adjSoh: d.adjSoh === null ? "N/A" : natlExportNum(d.adjSoh),
    mos: natlExportMos(d.mos),
    adjMos: natlExportMos(d.adjMos),
    shelf: d.shelf === null ? "N/A" : Number(d.shelf.toFixed(1)),
  }));
  const exportCols = [
    { key: "code", label: "Material Code" },
    { key: "desc", label: "Material Description" },
    { key: "type", label: "Type" },
    { key: "soh", label: "SOH / Total Qty (all plants incl. " + ((typeof HUB_PLANT !== "undefined") ? HUB_PLANT : "HO01") + ")" },
    { key: "excludedQty", label: "<6mo SOH Excluded (from shelf-life avg)" },
    { key: "adjSoh", label: "Adjusted SOH for Expiry" },
    { key: "mos", label: "MOS (months)" },
    { key: "adjMos", label: "Adjusted MOS for Expiry (months)" },
    { key: "shelf", label: "Shelf life in Month (qty-weighted avg)" },
  ];
  wireTableExport("natl-export", exportRows, exportCols, "national_stock_mos");
}

// ── WIRE INTO PAGE_RENDERERS AND EVENT LISTENERS ──────────────────────────────
(function wireNatlTableModule() {
  function extend() {
    if (typeof PAGE_RENDERERS !== "undefined") {
      PAGE_RENDERERS["natl-table"] = renderNatlTable;
    }

    // Same pattern used by mos.js — let this page render even before the main
    // inventory file is loaded (renderPage() normally bails when rawDf is empty).
    const _origRenderPage = window.renderPage;
    window.renderPage = function (id) {
      if (id === "natl-table") {
        currentPage = id;
        document.getElementById("landingView").style.display = "none";
        document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
        const pg = document.getElementById("page-natl-table");
        if (pg) pg.style.display = "block";
        document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
        if (typeof mosMerged !== "undefined" && mosMerged.length) {
          try { renderNatlTable(); } catch (e) { console.error(e); }
        }
        return;
      }
      _origRenderPage(id);
    };

    const filterMap = {
      "natl-apply": renderNatlTable,
      "natl-clear": () => {
        const s = document.getElementById("natl-search"); if (s) s.value = "";
        const t = document.getElementById("natl-type");   if (t) t.value = "";
        renderNatlTable();
      },
    };

    document.body.addEventListener("click", (e) => {
      const btn = e.target.closest("button[id]");
      if (!btn || typeof mosMerged === "undefined" || !mosMerged.length) return;
      const fn = filterMap[btn.id];
      if (fn) { e.stopPropagation(); fn(); }
    }, true);

    // Pressing Enter in the material search box applies the filter immediately,
    // same UX pattern as the global sidebar search.
    const searchInput = document.getElementById("natl-search");
    if (searchInput) {
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") renderNatlTable();
      });
    }

    // Re-render whenever the main inventory file finishes loading and the user
    // is already on this page (mirrors mos.js's fileInput listener).
    const fileInput = document.getElementById("fileInput");
    if (fileInput) {
      fileInput.addEventListener("change", () => {
        setTimeout(() => {
          if (currentPage === "natl-table" && typeof mosMerged !== "undefined" && mosMerged.length) renderNatlTable();
        }, 300);
      });
    }

    // Re-render whenever the AMC file finishes loading and the user is already
    // on this page (mos.js's own listener only re-renders the mos-plant page).
    const amcInput = document.getElementById("mosAmcFileInput");
    if (amcInput) {
      amcInput.addEventListener("change", () => {
        setTimeout(() => {
          if (currentPage === "natl-table" && typeof mosMerged !== "undefined" && mosMerged.length) renderNatlTable();
        }, 300);
      });
    }

    // Rebuild alongside mosMerged when the material mapping file changes.
    const _origApplyMapping = window.applyMaterialMapping;
    if (_origApplyMapping) {
      window.applyMaterialMapping = function () {
        _origApplyMapping.apply(this, arguments);
        if (currentPage === "natl-table" && typeof mosMerged !== "undefined" && mosMerged.length) {
          try { renderNatlTable(); } catch (e) {}
        }
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", extend);
  } else {
    extend();
  }
})();
