// =============================================================================
// PharmaTrack v2 — mos.js
// MOS by Plant: Months of Stock = Stock-on-Hand ÷ Average Monthly Consumption.
//
// HO01 SPECIAL CASE
// -----------------
// HO01 is the central distribution hub. It does not consume stock itself —
// it only holds and ships it out to the 18 branch plants. So HO01 has no
// "AMC" of its own in any meaningful sense (its AMC column, if present in
// AMC.xlsx, is null/blank for every item).
//
// Using HO01's own (non-existent) consumption would make its MOS undefined
// or infinite, which tells a planner nothing useful. What actually matters
// operationally is: "how long can HO01 keep the whole network supplied at
// current demand?" So for HO01 specifically:
//
//     HO01 MOS = HO01 stock-on-hand ÷ SUM of every branch plant's AMC
//
// For every other (branch) plant, MOS uses the normal formula:
//
//     Plant MOS = Plant stock-on-hand ÷ that plant's own AMC
//
// Requires: script.js (fmtQty, escHtml, buildTable, downloadCSV, downloadExcel,
//           mappingTable, PLOTLY_LAYOUT, PLOTLY_CONFIG, waitForPlotly, rawDf,
//           PAGE_RENDERERS, renderPage, currentPage)
// Must be loaded AFTER script.js.
// =============================================================================

const HUB_PLANT = "HO01"; // the distribution hub — never has its own consumption

// ── MOS STATE ────────────────────────────────────────────────────────────────
let mosAmcRaw    = [];          // parsed rows from AMC.xlsx: { code, desc, type, person, amcs:{plant:val} }
let mosPlants    = [];          // ordered plant code list detected from AMC.xlsx
let mosMerged    = [];          // deduplicated AMC rows (mapping-aware), one per canonical material
let mosPersons   = [];          // sorted unique PERSON values from AMC.xlsx

// ── AMC FILE LOADER ───────────────────────────────────────────────────────────
function loadMosAmcFile(file) {
  const statusEl = document.getElementById("mosAmcFileStatus");
  const btnEl    = document.getElementById("mosAmcUploadBtnText");
  if (statusEl) statusEl.innerHTML = '<div class="status-loading">⏳ Parsing…</div>';

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb   = XLSX.read(e.target.result, { type: "array" });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

      if (!rows.length) throw new Error("AMC file is empty.");

      const META = ["Material Code", "Description", "Material Type Code", "PERSON"];
      const firstRow = rows[0];
      const detectedPlants = Object.keys(firstRow).filter(k => !META.includes(k));
      if (!detectedPlants.length) throw new Error("No plant columns found in AMC file.");

      // Normalize plant codes the SAME way buildMosSohMap() normalizes the
      // inventory file's "Plant" column (trim + uppercase). Without this,
      // any AMC column header that isn't already exact-case (e.g. "Ho01"
      // instead of "HO01", or with stray whitespace) silently fails to
      // match the SOH map's keys, and that plant's stock is dropped to 0
      // everywhere it's looked up — including in National SOH/MOS.
      mosPlants  = detectedPlants.map(p => String(p).trim().toUpperCase());
      mosAmcRaw  = rows.map(r => ({
        code:   String(r["Material Code"] || "").trim(),
        desc:   String(r["Description"]   || "").trim(),
        type:   String(r["Material Type Code"] || "").trim().toUpperCase(),
        person: String(r["PERSON"] || "").trim(),
        amcs: Object.fromEntries(
          detectedPlants.map(p => [String(p).trim().toUpperCase(), (r[p] == null || r[p] === "" || typeof r[p] === "string") ? null : Number(r[p])])
        ),
      }));

      // Expose sorted unique person list for the global person filter dropdown
      mosPersons = [...new Set(mosAmcRaw.map(r => r.person).filter(Boolean))].sort();
      if (typeof populatePersonFilter === "function") populatePersonFilter(mosPersons);

      mosMerged = buildMosMerged();

      const count = mosMerged.length;
      const hasHub = mosPlants.includes(HUB_PLANT);
      if (statusEl) statusEl.innerHTML =
        `<div class="status-ok">✓ LOADED</div><div class="status-name">${escHtml(file.name)}</div>` +
        `<div class="status-name" style="color:var(--green)">${count} items · ${detectedPlants.length} plants</div>` +
        (hasHub ? "" : `<div class="status-name" style="color:var(--amber)">⚠️ "${HUB_PLANT}" column not found — hub MOS rule won't apply</div>`);
      if (btnEl) btnEl.textContent = "📐 Change AMC File";

      document.getElementById("mos-no-amc").style.display  = "none";
      document.getElementById("mos-content").style.display = "block";

      if (currentPage === "mos-plant") renderMosPlant();

    } catch (err) {
      console.error("MOS AMC load error:", err);
      if (statusEl) statusEl.innerHTML = `<div class="status-error">⚠️ ${escHtml(err.message)}</div>`;
    }
  };
  reader.readAsArrayBuffer(file);
}

// ── DEDUPLICATION (mapping-aware) ─────────────────────────────────────────────
// Collapses multiple AMC source codes onto the same canonical target code when
// a mapping file is loaded, summing AMC per plant across duplicates — same
// approach used elsewhere in the app for inventory rows.
function buildMosMerged() {
  if (!mosAmcRaw.length) return [];

  const merged = new Map(); // canonicalCode → mergedRow

  for (const row of mosAmcRaw) {
    let canonical = row.code;
    let canonDesc = row.desc;

    if (mappingTable && mappingTable.size > 0) {
      // FIX-MOS-MAP-CASE: mappingTable's source keys are always uppercased
      // (loadMappingFile does src.toUpperCase()), but row.code is the AMC
      // file's code exactly as typed. A casing mismatch here (e.g. lowercase
      // in AMC.xlsx) makes this lookup miss even when a mapping genuinely
      // exists, silently leaving the material unmapped in mosMerged.
      const entry = mappingTable.get(String(row.code || "").trim().toUpperCase());
      if (entry) {
        canonical = entry.targetCode;
        canonDesc = entry.targetDesc || row.desc;
      }
    }

    if (!merged.has(canonical)) {
      merged.set(canonical, {
        code: canonical,
        origCodes: new Set([row.code]),
        desc: canonDesc,
        type: row.type,
        person: row.person || "",
        amcs: Object.fromEntries(mosPlants.map(p => [p, null])),
        isMerged: false,
      });
    }
    const m = merged.get(canonical);
    m.origCodes.add(row.code);
    if (m.origCodes.size > 1) m.isMerged = true;

    for (const p of mosPlants) {
      const v = row.amcs[p];
      if (v !== null && v !== undefined) {
        m.amcs[p] = (m.amcs[p] || 0) + v;
      }
    }
  }

  return Array.from(merged.values()).map(m => ({
    ...m,
    origCodes: [...m.origCodes].join(", "),
  }));
}

// ── SOH LOOKUP (from main inventory file) ─────────────────────────────────────
// materialCode → plantCode → Total Quantity on hand.
// Total Quantity = Unrestricted Stock + verified Stock in Transit (phantom/
// unverified transit excluded) + Stock in Quality Inspection — same definition
// and same getMappedQty/getVerifiedTransitQty helpers Branch Comparison's
// "Total Quantity" metric uses (see script.js matPlantMap[mat][pln].TotalQty),
// so the two pages agree on the same number for the same material.
function buildMosSohMap() {
  const map = new Map();
  // Use the mapping-reconciled base (mappedDf when a mapping file is loaded)
  // so materials that consolidate multiple source SAP codes into one target
  // code — via applyMaterialMapping() — are looked up under their canonical/
  // target code, same as Branch Comparison, National Table, and Expiry Risk.
  // rawDf rows never carry _mappedMaterial (that field only exists on
  // mappedDf's copies), so reading rawDf directly silently drops all stock
  // recorded under pre-mapping source codes.
  const base = (typeof getReconciledBase === "function")
    ? getReconciledBase()
    : (typeof rawDf !== "undefined" ? rawDf : []);
  if (!base.length) return map;
  for (const row of base) {
    const mat = String(row._mappedMaterial || row["Material"] || "").trim();
    const plt = String(row["Plant"] || "").trim().toUpperCase();
    if (!mat || !plt) continue;

    const unrestricted = (typeof getMappedQty === "function") ? getMappedQty(row, "Unrestricted Stock") : Number(row["Unrestricted Stock"] || 0);
    const transit       = (typeof getVerifiedTransitQty === "function") ? getVerifiedTransitQty(row) : Number(row["Stock in Transit"] || 0);
    const qc            = (typeof getMappedQty === "function") ? getMappedQty(row, "Stock in Quality Inspection") : Number(row["Stock in Quality Inspection"] || 0);
    const qty = (Number(unrestricted) || 0) + (Number(transit) || 0) + (Number(qc) || 0);

    if (!map.has(mat)) map.set(mat, {});
    map.get(mat)[plt] = (map.get(mat)[plt] || 0) + qty;
  }
  return map;
}

function mosSohFor(sohMap, row, plant) {
  return sohMap.get(row.code)?.[plant] ?? 0;
}

/**
 * Computes MOS for every plant, for one AMC row.
 * Returns an array of { plant, soh, amc, mos, isHub }.
 *
 * - For the hub plant (HO01): amc = sum of every branch plant's AMC for this
 *   item (nulls treated as 0 — a branch with no commitment contributes no
 *   demand). mos = HO01's SOH ÷ that total branch demand.
 * - For every other plant: amc = that plant's own AMC column value.
 *   mos = that plant's SOH ÷ its own AMC.
 *
 * mos is null when there's no basis to compute it (no AMC commitment at all,
 * i.e. the plant isn't expected to carry this item). mos is Infinity when
 * there IS stock but zero demand (can't run out, but also isn't moving).
 */
function computeRowMOS(row, sohMap) {
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT);
  const totalBranchAmc = branchPlants.reduce((s, p) => s + (row.amcs[p] || 0), 0);
  const anyBranchCommitted = branchPlants.some(p => row.amcs[p] !== null);

  return mosPlants.map(p => {
    const soh = mosSohFor(sohMap, row, p);
    const isHub = p === HUB_PLANT;

    if (isHub) {
      // Hub's own AMC column (if present) is ignored on purpose — HO01 doesn't
      // consume. Its "demand" is the total of what it has to ship out.
      if (!anyBranchCommitted) return { plant: p, soh, amc: null, mos: null, isHub };
      const mos = totalBranchAmc > 0 ? soh / totalBranchAmc : (soh > 0 ? Infinity : null);
      return { plant: p, soh, amc: totalBranchAmc, mos, isHub };
    }

    const amc = row.amcs[p];
    if (amc === null || amc === undefined) return { plant: p, soh, amc: null, mos: null, isHub };
    const mos = amc > 0 ? soh / amc : (soh > 0 ? Infinity : null);
    return { plant: p, soh, amc, mos, isHub };
  });
}

/**
 * National MOS — one network-wide number per item:
 *
 *     National MOS = (SOH at every plant, INCLUDING HO01)
 *                   ÷ (AMC at every BRANCH plant, EXCLUDING HO01)
 *
 * HO01 holds stock but doesn't consume it, so its warehouse stock is counted
 * as part of the network's total supply cushion (numerator), while its own
 * AMC column (which doesn't represent real demand) is excluded from the
 * denominator — only the branches' actual consumption represents real demand.
 *
 * Returns { totalSoh, totalAmc, mos, hasHo01 } where mos is:
 *   - null if no branch is committed to this item at all (no real demand to measure against)
 *   - Infinity if there's stock but zero branch demand
 *   - a number otherwise
 */
function computeNationalMOS(row, sohMap) {
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT);
  const totalBranchAmc = branchPlants.reduce((s, p) => s + (row.amcs[p] || 0), 0);
  const anyBranchCommitted = branchPlants.some(p => row.amcs[p] !== null);

  // FIX-NATL-SOH: SOH must cover ALL plants holding this material in the
  // inventory file — not just plants that happen to have a column in the
  // uploaded AMC file. Previously this summed mosPlants only, which silently
  // dropped stock sitting at any plant absent from the AMC upload (or whose
  // plant code didn't match an AMC column), undercounting national SOH.
  const allPlantsForRow = sohMap.get(row.code) || {};
  const totalSoh = Object.values(allPlantsForRow).reduce((s, v) => s + (Number(v) || 0), 0);
  const hasHo01  = mosPlants.includes(HUB_PLANT);

  if (!anyBranchCommitted) return { totalSoh, totalAmc: null, mos: null, hasHo01 };
  const mos = totalBranchAmc > 0 ? totalSoh / totalBranchAmc : (totalSoh > 0 ? Infinity : null);
  return { totalSoh, totalAmc: totalBranchAmc, mos, hasHo01 };
}

// ── FORMATTING HELPERS ────────────────────────────────────────────────────────
function mosNABadge() {
  return '<span class="amc-na-badge" title="Not committed — item not required at this plant">Not Committed</span>';
}

function fmtMosVal(mos) {
  if (mos === null || mos === undefined) return mosNABadge();
  if (mos === Infinity) return '<span style="color:var(--amber)">∞</span>';
  return `<b>${Number(mos).toFixed(1)}</b> mo`;
}

// Only rule requested: flag critical (< 1 month). Everything else is neutral.
function isMosCritical(mos) {
  return mos !== null && mos !== undefined && mos !== Infinity && mos < 1;
}

function mosCellStyle(mos) {
  return isMosCritical(mos) ? "color:var(--red);font-weight:700" : "color:var(--text)";
}

function getMosFilteredRows(typeFilter, searchQ) {
  if (!mosMerged.length) return [];
  let rows = mosMerged;
  // Global person filter — applied before any per-page filters
  if (typeof personFilter !== "undefined" && personFilter.size > 0) {
    rows = rows.filter(r => r.person && personFilter.has(r.person));
  }
  if (typeFilter) rows = rows.filter(r => r.type === typeFilter);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    rows = rows.filter(r => r.code.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q));
  }
  return rows;
}

function mosKpiCard(label, value, sub, color) {
  return `<div class="kpi-card"><div class="kpi-label">${escHtml(label)}</div><div class="kpi-value" style="color:var(--${color||'blue'})">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
}

// ── MAIN RENDER ────────────────────────────────────────────────────────────────
async function renderMosPlant() {
  await waitForPlotly();
  if (!mosMerged.length) return;

  const searchEl    = document.getElementById("mos-search");
  const plantEl     = document.getElementById("mos-plant-filter");
  const typeEl      = document.getElementById("mos-type");
  const criticalEl  = document.getElementById("mos-critical-only");

  const searchQ     = searchEl   ? searchEl.value.trim()  : "";
  const plantVal    = plantEl    ? plantEl.value.trim()   : "";
  const typeVal     = typeEl     ? typeEl.value.trim()    : "";
  const criticalOnly= criticalEl ? criticalEl.checked     : false;

  // Populate plant dropdown once
  if (plantEl && plantEl.options.length <= 1) {
    mosPlants.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p; opt.text = p === HUB_PLANT ? `${p} (Hub)` : p;
      plantEl.appendChild(opt);
    });
  }

  const sohMap = buildMosSohMap();
  const hasSoh = sohMap.size > 0;

  let rows = getMosFilteredRows(typeVal, searchQ);

  // Compute per-plant MOS for every row, plus one network-wide National MOS
  let scored = rows.map(r => ({
    ...r,
    _plantMos: computeRowMOS(r, sohMap),
    _national: computeNationalMOS(r, sohMap),
  }));

  // Plant-specific filter: only keep rows where that plant has a commitment
  if (plantVal) {
    scored = scored.filter(r => r._plantMos.find(m => m.plant === plantVal)?.amc !== null);
  }

  // Critical-only filter: at least one plant (or the selected plant) under 1mo
  if (criticalOnly) {
    scored = scored.filter(r => {
      const relevant = plantVal ? r._plantMos.filter(m => m.plant === plantVal) : r._plantMos;
      return relevant.some(m => isMosCritical(m.mos));
    });
  }

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const allEntries = scored.flatMap(r => plantVal ? r._plantMos.filter(m => m.plant === plantVal) : r._plantMos);
  const committedEntries = allEntries.filter(e => e.amc !== null);
  const criticalCount = committedEntries.filter(e => isMosCritical(e.mos)).length;
  const hubEntries = scored.map(r => r._plantMos.find(m => m.isHub)).filter(e => e && e.amc !== null);
  const hubCriticalCount = hubEntries.filter(e => isMosCritical(e.mos)).length;
  const nationalEntries = scored.map(r => r._national).filter(n => n.mos !== null);
  const nationalCriticalCount = nationalEntries.filter(n => isMosCritical(n.mos)).length;

  mosKpiRow([
    mosKpiCard("Items Screened", scored.length.toLocaleString(), typeVal || "All types", "blue"),
    mosKpiCard("National MOS Critical (<1mo)", nationalCriticalCount.toLocaleString(), `of ${nationalEntries.length.toLocaleString()} items with national MOS`, "red"),
    mosKpiCard("Plant-Item Pairs Critical (<1mo)", criticalCount.toLocaleString(), `of ${committedEntries.length.toLocaleString()} committed pairs`, "amber"),
    mosKpiCard(`${HUB_PLANT} Critical (<1mo)`, hubCriticalCount.toLocaleString(), "vs. total branch demand", "purple"),
    mosKpiCard("SOH Data Loaded", hasSoh ? "Yes" : "No", hasSoh ? "From inventory file" : "Upload inventory Excel for SOH", hasSoh ? "green" : "amber"),
  ]);

  if (!hasSoh) {
    document.getElementById("chart-mos-plant").innerHTML =
      '<div class="alert-info" style="margin:1rem 0">⚠️ Upload the main inventory Excel (sidebar) to provide stock-on-hand — MOS can\'t be computed from AMC alone.</div>';
    document.getElementById("mos-table").innerHTML = "";
    return;
  }

  // ── CHART: avg MOS per plant across screened items (capped for display) ──
  const displayPlants = plantVal ? [plantVal] : mosPlants;
  const plantAverages = displayPlants.map(p => {
    const vals = scored
      .map(r => r._plantMos.find(m => m.plant === p))
      .filter(e => e && e.amc !== null && e.mos !== null && e.mos !== Infinity);
    const avg = vals.length ? vals.reduce((s, e) => s + e.mos, 0) / vals.length : null;
    return { plant: p, avg, n: vals.length, isHub: p === HUB_PLANT };
  });

  Plotly.newPlot("chart-mos-plant", [{
    type: "bar",
    x: plantAverages.map(p => p.isHub ? `${p.plant} ★` : p.plant),
    y: plantAverages.map(p => p.avg ?? 0),
    marker: {
      color: plantAverages.map(p => p.avg !== null && p.avg < 1 ? "#f85149" : p.isHub ? "#8763cc" : "#3a8fd4"),
    },
    text: plantAverages.map(p => p.avg !== null ? `${p.avg.toFixed(1)}mo` : "—"),
    textposition: "outside",
    textfont: { size: 10 },
    hovertemplate: "<b>%{x}</b><br>Avg MOS: %{y:.1f} months<extra></extra>",
  }], {
    ...PLOTLY_LAYOUT,
    height: 360,
    margin: { l: 60, r: 30, t: 30, b: 80 },
    xaxis: { title: "Plant (★ = hub, MOS vs. total branch demand)", tickfont: { size: 10 } },
    yaxis: { title: "Average MOS (months)" },
    shapes: [{
      type: "line", x0: -0.5, x1: displayPlants.length - 0.5, y0: 1, y1: 1,
      line: { color: "#f85149", width: 1.5, dash: "dot" },
    }],
    annotations: [{
      x: displayPlants.length - 0.5, y: 1, xanchor: "right", yanchor: "bottom",
      text: "1mo critical line", showarrow: false, font: { color: "#f85149", size: 9 },
    }],
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  }, PLOTLY_CONFIG);

  // ── TABLE ────────────────────────────────────────────────────────────────────
  const cols = [
    { key: "code", label: "Material Code",
      fmt: (v, r) => r.isMerged
        ? `<span class="col-mat-code">${escHtml(v)}</span><span class="mat-mapped-badge" title="Merged from: ${escHtml(r.origCodes)}">MERGED</span>`
        : `<span class="col-mat-code">${escHtml(v)}</span>`,
      raw: true, cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "type", label: "Type" },
    { key: "_national", label: "National MOS",
      fmt: (v) => {
        if (!v || v.mos === null) return mosNABadge();
        const sohStr = `<span style="font-size:0.72em;color:var(--muted)"> · SOH ${fmtQty(v.totalSoh)}${v.hasHo01 ? ' (incl. ' + HUB_PLANT + ')' : ''}</span>`;
        const amcStr = `<span style="font-size:0.72em;color:var(--muted)"> · AMC ${fmtQty(v.totalAmc)} (branches)</span>`;
        return `<span style="${mosCellStyle(v.mos)}">${fmtMosVal(v.mos)}</span>${sohStr}${amcStr}`;
      },
      raw: true, cellClass: "col-mat-desc-wrap" },
    ...displayPlants.map(p => ({
      key: `_m_${p}`, label: p === HUB_PLANT ? `${p} (Hub)` : p,
      fmt: (v) => {
        if (!v || v.amc === null) return mosNABadge();
        const sohStr = `<span style="font-size:0.72em;color:var(--muted)"> · SOH ${fmtQty(v.soh)}</span>`;
        const amcLabel = v.isHub ? "Σ branch AMC" : "AMC";
        const amcStr = `<span style="font-size:0.72em;color:var(--muted)"> · ${amcLabel} ${fmtQty(v.amc)}</span>`;
        return `<span style="${mosCellStyle(v.mos)}">${fmtMosVal(v.mos)}</span>${sohStr}${amcStr}`;
      },
      raw: true,
    })),
  ];

  const tableRows = scored.map(r => ({
    ...r,
    ...Object.fromEntries(displayPlants.map(p => [`_m_${p}`, r._plantMos.find(m => m.plant === p)])),
  }));

  document.getElementById("mos-table").innerHTML = buildTable(
    tableRows, cols,
    (row) => {
      const relevant = plantVal ? [row[`_m_${plantVal}`]] : displayPlants.map(p => row[`_m_${p}`]);
      const nationalCritical = row._national && isMosCritical(row._national.mos);
      return (relevant.some(v => v && isMosCritical(v.mos)) || nationalCritical) ? "row-critical" : "";
    }
  );

  // ── EXPORT ────────────────────────────────────────────────────────────────────
  const exportRows = scored.flatMap(r =>
    r._plantMos.filter(m => !plantVal || m.plant === plantVal).map(m => ({
      code: r.code, desc: r.desc, type: r.type,
      nationalMos: r._national.mos, nationalSoh: r._national.totalSoh, nationalAmc: r._national.totalAmc,
      plant: m.plant, isHub: m.isHub ? "Yes (vs. total branch demand)" : "No",
      soh: m.soh, amc: m.amc, mos: m.mos,
    }))
  );
  const exportCols = [
    { key: "code", label: "Material Code" }, { key: "desc", label: "Description" }, { key: "type", label: "Type" },
    { key: "nationalMos", label: "National MOS (months)", fmt: v => v === null ? "N/A" : v === Infinity ? "Infinite" : Number(v).toFixed(2) },
    { key: "nationalSoh", label: "National SOH (all plants incl. " + HUB_PLANT + ")", fmt: v => Number(v || 0).toFixed(2) },
    { key: "nationalAmc", label: "National AMC (branches only)", fmt: v => v === null ? "N/A" : Number(v).toFixed(2) },
    { key: "plant", label: "Plant" }, { key: "isHub", label: "Hub Plant?" },
    { key: "soh", label: "Stock on Hand", fmt: v => Number(v || 0).toFixed(2) },
    { key: "amc", label: "AMC Used", fmt: v => v === null ? "Not Committed" : Number(v).toFixed(2) },
    { key: "mos", label: "MOS (months)", fmt: v => v === null ? "N/A" : v === Infinity ? "Infinite" : Number(v).toFixed(2) },
  ];
  const dlRow = document.getElementById("mos-dl-row");
  if (dlRow) {
    dlRow.innerHTML = '<button class="dl-btn">⬇ CSV</button><button class="dl-btn">⬇ Excel</button>';
    dlRow.querySelectorAll(".dl-btn")[0].onclick = () => downloadCSV(exportRows,   exportCols, "mos_by_plant.csv");
    dlRow.querySelectorAll(".dl-btn")[1].onclick = () => downloadExcel(exportRows, exportCols, "mos_by_plant.xlsx");
  }
}

function mosKpiRow(cards) {
  const el = document.getElementById("mos-kpis");
  if (el) el.innerHTML = cards.join("");
}

// ── WIRE INTO PAGE_RENDERERS AND EVENT LISTENERS ──────────────────────────────
(function wireMosModule() {
  function extend() {
    if (typeof PAGE_RENDERERS !== "undefined") {
      PAGE_RENDERERS["mos-plant"] = renderMosPlant;
    }

    // Allow this page to render even before the main inventory file is loaded,
    // same pattern used by the old AMC module — renderPage() normally bails
    // out early when rawDf is empty.
    const _origRenderPage = window.renderPage;
    window.renderPage = function (id) {
      if (id === "mos-plant") {
        currentPage = id;
        document.getElementById("landingView").style.display = "none";
        document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
        const pg = document.getElementById("page-mos-plant");
        if (pg) pg.style.display = "block";
        document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
        if (mosMerged.length) {
          try { renderMosPlant(); } catch (e) { console.error(e); }
        }
        return;
      }
      _origRenderPage(id);
    };

    const amcInput = document.getElementById("mosAmcFileInput");
    if (amcInput) {
      amcInput.addEventListener("change", e => {
        const f = e.target.files[0]; if (f) loadMosAmcFile(f);
        e.target.value = "";
      });
    }

    const filterMap = {
      "mos-apply": renderMosPlant,
      "mos-clear": () => {
        const s = document.getElementById("mos-search");         if (s) s.value = "";
        const p = document.getElementById("mos-plant-filter");   if (p) p.value = "";
        const t = document.getElementById("mos-type");           if (t) t.value = "";
        const c = document.getElementById("mos-critical-only");  if (c) c.checked = false;
        renderMosPlant();
      },
    };

    document.body.addEventListener("click", (e) => {
      const btn = e.target.closest("button[id]");
      if (!btn || !mosMerged.length) return;
      const fn = filterMap[btn.id];
      if (fn) { e.stopPropagation(); fn(); }
    }, true);

    // Recompute SOH-driven values whenever the main inventory file finishes
    // loading (rawDf changes) and the user is already on this page.
    const fileInput = document.getElementById("fileInput");
    if (fileInput) {
      fileInput.addEventListener("change", () => {
        setTimeout(() => {
          if (currentPage === "mos-plant" && mosMerged.length) renderMosPlant();
        }, 300);
      });
    }

    // Rebuild mosMerged when the mapping file changes, like the old AMC module did.
    const _origApplyMapping = window.applyMaterialMapping;
    if (_origApplyMapping) {
      window.applyMaterialMapping = function () {
        _origApplyMapping.apply(this, arguments);
        if (mosAmcRaw.length) {
          mosMerged = buildMosMerged();
          if (currentPage === "mos-plant") {
            try { renderMosPlant(); } catch (e) {}
          }
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
