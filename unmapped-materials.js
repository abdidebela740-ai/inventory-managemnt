// =============================================================================
// PharmaTrack v2 — unmapped-materials.js
// "🧩 Unmapped Materials" — Admin-only report.
//
// Lists every distinct material currently in the uploaded inventory file that
// applyMaterialMapping() (script.js) could NOT match against the loaded
// Material Standardization mapping file — i.e. rows stamped `_isMapped:
// false`. These are the candidates that may still need a mapping entry added.
//
// Requires: script.js  (rawDf, mappedDf, mappingTable, mappingStats,
//           fmtQty, fmtETB, escHtml, buildTable, wireTableExport, sortBy,
//           setKpis, PAGE_RENDERERS)
//           filters.js  (getValuationType — ZME/ZMS/ZLC/ZMD suffix)
//           permissions.js (canAccessModule, passesUniversalExclusions,
//           getRowStockTypeLabel, getVisiblePlants)
// Must be loaded AFTER script.js, filters.js and permissions.js.
//
// ACCESS: Admin-only. Unlike most report pages, this is NOT something an
// Admin can grant a regular user via sidebar_permissions — see
// ADMIN_ONLY_MODULE_KEYS in permissions.js, same treatment as the Data
// Upload / Material Standardization mapping section itself, since this page
// exists to help curate that same mapping file.
// =============================================================================

// ── Build the aggregated list of unmapped materials ─────────────────────────
// One row per raw Material code (an unmapped code has no canonical/target
// code to merge under, so grouping is by the raw code as-is). Only
// meaningful once a mapping file is loaded — mappedDf/`_isMapped` only exist
// after applyMaterialMapping() has run, which script.js only ever calls when
// mappingTable.size > 0. Caller must check that before calling this.
//
// Applies the same universal data-membership rules every other page in the
// app enforces (passesUniversalExclusions — blank Special Stock Type values
// other than "Q", blank Inventory Valuation, non-medical codes/groups,
// excluded storage locations) — these apply to Admin too, so this list stays
// consistent with what Admin sees as "real" data everywhere else in the app.
// Deliberately does NOT run rows through canAccessRow()/data-scope
// filtering — this is an Admin-only curation tool over the WHOLE uploaded
// file, not a role-scoped data view.
function buildUnmappedMaterialRows(searchQ, stockTypeVal, valTypeVal, plantVal) {
  const base = (typeof mappedDf !== "undefined" && Array.isArray(mappedDf)) ? mappedDf : [];
  const q = String(searchQ || "").trim().toLowerCase();

  const matMap = new Map();
  base.forEach(row => {
    // _isMapped covers both a literal mapping-file entry AND a code that's
    // already canonical (it's used as someone else's Target elsewhere in
    // the mapping file — TARGET-AS-CANONICAL, see applyMaterialMapping() in
    // script.js). Either way it's not this page's concern.
    if (row._isMapped) return;
    if (typeof passesUniversalExclusions === "function" && !passesUniversalExclusions(row)) return;

    const code = String(row["Material"] || "").trim();
    if (!code) return;

    const stockType = (typeof getRowStockTypeLabel === "function") ? getRowStockTypeLabel(row) : "RDF";
    const valType    = (typeof getValuationType === "function") ? getValuationType(row) : "(None)";
    const plant      = String(row["Plant"] || "").trim().toUpperCase();

    if (stockTypeVal && stockType !== stockTypeVal) return;
    if (valTypeVal && valType !== valTypeVal) return;
    if (plantVal && plant !== plantVal) return;
    if (q) {
      const desc = String(row["Material Description"] || "").toLowerCase();
      if (!code.toLowerCase().includes(q) && !desc.includes(q)) return;
    }

    if (!matMap.has(code)) {
      matMap.set(code, {
        code,
        desc: row["Material Description"] || "",
        stockType,
        valType,
        plants: new Set(),
        qty: 0,
        val: 0,
      });
    }
    const entry = matMap.get(code);
    if (plant) entry.plants.add(plant);
    entry.qty += Number(row["Total Qty"] || 0);
    entry.val += Number(row["Total Value"] || 0);
  });

  return [...matMap.values()].map(r => ({
    ...r,
    plantList: [...r.plants].sort().join(", ") || "—",
  }));
}

function renderUnmappedMaterials() {
  const noDataEl    = document.getElementById("unmapped-no-data");
  const noMappingEl = document.getElementById("unmapped-no-mapping");
  const contentEl   = document.getElementById("unmapped-content");

  const hasInventory = typeof rawDf !== "undefined" && rawDf.length > 0;
  const hasMapping    = typeof mappingTable !== "undefined" && mappingTable.size > 0;

  if (!hasInventory) {
    if (noDataEl)    noDataEl.style.display    = "block";
    if (noMappingEl) noMappingEl.style.display = "none";
    if (contentEl)   contentEl.style.display   = "none";
    return;
  }
  if (noDataEl) noDataEl.style.display = "none";

  if (!hasMapping) {
    if (noMappingEl) noMappingEl.style.display = "block";
    if (contentEl)   contentEl.style.display   = "none";
    return;
  }
  if (noMappingEl) noMappingEl.style.display = "none";
  if (contentEl)   contentEl.style.display   = "block";

  const searchEl = document.getElementById("unmapped-search");
  const stypeEl  = document.getElementById("unmapped-stock-type");
  const vtypeEl  = document.getElementById("unmapped-val-type");
  const plantEl  = document.getElementById("unmapped-plant");

  // Populate the Plant dropdown once. Admin always has full plant access, so
  // getVisiblePlants() is just defence-in-depth here, not an active restriction.
  if (plantEl && plantEl.options.length <= 1) {
    const allPlants = [...new Set(
      (typeof mappedDf !== "undefined" ? mappedDf : [])
        .map(r => String(r["Plant"] || "").trim().toUpperCase())
        .filter(Boolean)
    )].sort();
    const visible = (typeof getVisiblePlants === "function") ? getVisiblePlants(allPlants) : allPlants;
    visible.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p; opt.text = p;
      plantEl.appendChild(opt);
    });
  }

  const searchQ  = searchEl ? searchEl.value.trim() : "";
  const stypeVal = stypeEl  ? stypeEl.value.trim()  : "";
  const vtypeVal = vtypeEl  ? vtypeEl.value.trim()  : "";
  const plantVal = plantEl  ? plantEl.value.trim()  : "";

  const rows = buildUnmappedMaterialRows(searchQ, stypeVal, vtypeVal, plantVal);

  // ── KPIs ────────────────────────────────────────────────────────────────
  const totalVal = rows.reduce((s, r) => s + r.val, 0);
  setKpis("unmapped-kpis", [
    ["Unmapped Materials", rows.length.toLocaleString(), "Distinct codes with no mapping entry", "amber"],
    ["Total Value",        fmtETB(totalVal),              "Sum of Total Value across unmapped codes", "red"],
    ["Mapping Coverage",   `${mappingStats ? mappingStats.valuePct : 0}%`, "Of total stock value already standardized", "green"],
  ]);

  // ── Table ───────────────────────────────────────────────────────────────
  const cols = [
    { key: "code",      label: "Material Code",        cellClass: "col-mat-code-wrap" },
    { key: "desc",      label: "Material Description",  cellClass: "col-mat-desc-wrap" },
    { key: "stockType", label: "Stock Type" },
    { key: "valType",   label: "Valuation Type" },
    { key: "plantList", label: "Plant(s)" },
    { key: "qty", label: "Total Qty",           fmt: fmtQty, rawKey: "qty", cellClass: "col-qty" },
    { key: "val", label: "Total Value (ETB)",   fmt: fmtETB, rawKey: "val", cellClass: "col-val" },
  ];
  const sorted = sortBy(rows, "val");
  const wrap = document.getElementById("unmapped-table-wrap");
  if (wrap) {
    wrap.innerHTML = sorted.length
      ? buildTable(sorted, cols, () => "", "", { id: "unmapped-export", title: "Unmapped Materials" })
      : '<div class="alert-info">✓ Every material in the current file matches an entry in the mapping file.</div>';
    if (sorted.length) wireTableExport("unmapped-export", sorted, cols, "unmapped_materials");
  }
}

// ── WIRE INTO PAGE_RENDERERS AND EVENT LISTENERS ─────────────────────────────
(function wireUnmappedMaterialsModule() {
  function extend() {
    // SEC-ACCESS-GATE: register into PAGE_RENDERERS only — the real
    // renderPage() (script.js) already runs canAccessModule("unmapped-materials")
    // before ever calling this, and that check is hard-gated to Admin only
    // (ADMIN_ONLY_MODULE_KEYS in permissions.js), so no separate guard is
    // needed — or safe to duplicate — here.
    if (typeof PAGE_RENDERERS !== "undefined") {
      PAGE_RENDERERS["unmapped-materials"] = renderUnmappedMaterials;
    }

    const filterMap = {
      "unmapped-apply": renderUnmappedMaterials,
      "unmapped-clear": () => {
        const s = document.getElementById("unmapped-search");     if (s) s.value = "";
        const t = document.getElementById("unmapped-stock-type"); if (t) t.value = "";
        const v = document.getElementById("unmapped-val-type");   if (v) v.value = "";
        const p = document.getElementById("unmapped-plant");      if (p) p.value = "";
        renderUnmappedMaterials();
      },
    };

    document.body.addEventListener("click", (e) => {
      const btn = e.target.closest("button[id]");
      if (btn && filterMap[btn.id]) filterMap[btn.id]();
    });

    const searchEl = document.getElementById("unmapped-search");
    if (searchEl) {
      searchEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") renderUnmappedMaterials();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", extend);
  } else {
    extend();
  }
})();

window.renderUnmappedMaterials = renderUnmappedMaterials;
