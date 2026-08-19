// =============================================================================
// PharmaTrack v2 — expiry-risk.js
// Overstock & Expiry Risk Analysis.
//
// CORE IDEA
// ---------
// For every plant + item, we know:
//   - SOH            stock-on-hand right now (Unrestricted + verified Transit
//                     + Quality Inspection — same definition as mos.js's
//                     buildMosSohMap(), so this page agrees with the rest
//                     of the app)
//   - AMC            average monthly consumption at that plant
//                     (HO01 uses total branch demand — see mos.js HUB rule)
//   - MOS            = SOH ÷ AMC   → months of stock at current pace
//   - shelfLeftMo    months remaining until the earliest-expiring batch
//                     at that plant expires
//
// An item is AT RISK at a plant when:  MOS > shelfLeftMo
//   (there's more stock than can possibly be consumed before it expires)
//
// AT-RISK QUANTITY is only the part that can't be saved by normal consumption:
//   atRiskQty = max(0, SOH - shelfLeftMo * AMC)
//   atRiskVal = atRiskQty * unitValue   (unitValue = Value of Unrestricted
//               Stock ÷ Unrestricted Stock, from the inventory file)
//
// REDISTRIBUTION (per item, independently — see design discussion):
//   Source  = any plant (including HO01) with atRiskQty > 0.
//   Recipient = any OTHER plant (HO01 excluded — it never receives) that is
//               NOT itself at risk (its own MOS <= its own shelfLeftMo).
//   Recipient headroom = max(0, shelfLeftMo_recipient * AMC_recipient - SOH_recipient)
//               → the most that plant could absorb without becoming at-risk.
//   Source's atRiskQty is split across eligible recipients PROPORTIONALLY by
//   recipient AMC, each allocation capped at that recipient's headroom.
//   Whatever can't be placed (no eligible recipients, or headroom exhausted)
//   becomes RESIDUAL RISK — the number that goes to the marketing director.
//
// Requires: script.js (rawDf, mappingTable, fmtETB, fmtQty, escHtml, buildTable,
//           downloadCSV, downloadExcel, PLOTLY_LAYOUT, PLOTLY_CONFIG, waitForPlotly,
//           PAGE_RENDERERS, renderPage, currentPage)
//           mos.js (HUB_PLANT, mosMerged, mosPlants, buildMosSohMap)
// Must be loaded AFTER both script.js and mos.js.
// =============================================================================

const MS_PER_DAY   = 24 * 60 * 60 * 1000;
const DAYS_PER_MO  = 30.44; // average month length, consistent with rest of app's date math

// ── BUILD EXPIRY LOOKUP (earliest batch expiry per material+plant) ───────────
// materialCode → plantCode → { expiry: Date|null, unitVal: number }
function buildExpiryMap() {
  const map = new Map();
  // Use getReconciledBase() so the person filter (and mapping) applies here too
  const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
  if (!base.length) return map;

  for (const row of base) {
    const mat = String(row._mappedMaterial || row["Material"] || "").trim();
    const plt = String(row["Plant"] || "").trim().toUpperCase();

    // FIX: qty/val must match mos.js's buildMosSohMap() definition of SOH
    // (Unrestricted + verified Transit + Quality Inspection), not just
    // Unrestricted Stock. Otherwise a material sitting entirely in QC status
    // at a plant gets skipped here (qty <= 0) even though its SOH — used a
    // few lines down via pm.soh — is nonzero, silently dropping it from the
    // whole Expiry Risk page while it still shows stock everywhere else.
    const unrestrictedQty = (typeof getMappedQty === "function") ? getMappedQty(row, "Unrestricted Stock") : Number(row["Unrestricted Stock"] || 0);
    const transitQty      = (typeof getVerifiedTransitQty === "function") ? getVerifiedTransitQty(row) : Number(row["Stock in Transit"] || 0);
    const qcQty            = (typeof getMappedQty === "function") ? getMappedQty(row, "Stock in Quality Inspection") : Number(row["Stock in Quality Inspection"] || 0);
    const qty = (Number(unrestrictedQty) || 0) + (Number(transitQty) || 0) + (Number(qcQty) || 0);

    const unrestrictedVal = (typeof getMappedVal === "function") ? getMappedVal(row, "Value of Unrestricted Stock") : Number(row["Value of Unrestricted Stock"] || 0);
    const transitVal      = (typeof getVerifiedTransitVal === "function") ? getVerifiedTransitVal(row) : Number(row["Value of Stock in Transit"] || 0);
    const qcVal            = (typeof getMappedVal === "function") ? getMappedVal(row, "Value of Stock in Quality Inspection") : Number(row["Value of Stock in Quality Inspection"] || 0);
    const val = (Number(unrestrictedVal) || 0) + (Number(transitVal) || 0) + (Number(qcVal) || 0);

    if (!mat || !plt || qty <= 0) continue;

    if (!map.has(mat)) map.set(mat, {});
    const plantMap = map.get(mat);
    if (!plantMap[plt]) plantMap[plt] = { expiry: null, valSum: 0, qtySum: 0, earliestQty: 0, earliestVal: 0 };

    const entry = plantMap[plt];
    entry.valSum += val;
    entry.qtySum += qty;

    // Earliest-expiring batch wins (pharma best practice, same rule used
    // elsewhere in this app when collapsing batches).
    //
    // BUGFIX-EXPIRY-QTY: qtySum/valSum above are running totals across EVERY
    // batch at this plant — they answer "how much stock is here in total"
    // (needed by unitValueFor() below). They do NOT answer "how much of that
    // stock is the batch that's actually expiring soonest." Callers that need
    // the latter (e.g. stockout-risk.js's expiring-qty tiers) must use
    // earliestQty/earliestVal instead, or they end up flagging a plant's
    // ENTIRE stock as "expiring soon" just because one batch there is.
    const exp = row._expiry instanceof Date && !isNaN(row._expiry) ? row._expiry : null;
    if (exp) {
      if (!entry.expiry || exp < entry.expiry) {
        // New strictly-earliest date — replace, don't accumulate onto
        // whatever batch(es) previously held that title.
        entry.expiry      = exp;
        entry.earliestQty = qty;
        entry.earliestVal = val;
      } else if (exp.getTime() === entry.expiry.getTime()) {
        // Tied for earliest — multiple batches sharing that exact date
        // legitimately all count.
        entry.earliestQty += qty;
        entry.earliestVal += val;
      }
    }
  }

  return map;
}

function monthsUntil(date, today) {
  if (!(date instanceof Date) || isNaN(date)) return null;
  const days = (date.getTime() - today.getTime()) / MS_PER_DAY;
  return days / DAYS_PER_MO; // can be negative if already expired
}

function unitValueFor(entry) {
  if (!entry || !entry.qtySum) return 0;
  return entry.valSum / entry.qtySum;
}

// ── BUILD THE FULL PLANT × ITEM RISK SNAPSHOT ─────────────────────────────────
// Returns an array of { code, desc, type, plant, isHub, soh, amc, mos,
//                        shelfLeftMo, unitVal, atRisk, atRiskQty, atRiskVal }
function buildRiskSnapshot(typeFilter, searchQ, plantFilter) {
  if (typeof mosMerged === "undefined" || !mosMerged.length) return [];

  const sohMap    = buildMosSohMap();   // from mos.js — materialCode → plant → SOH
  const expiryMap = buildExpiryMap();
  const today     = new Date();
  today.setHours(0, 0, 0, 0);

  // getMosFilteredRows already applies the global personFilter before type/search
  let rows = (typeof getMosFilteredRows === "function")
    ? getMosFilteredRows(typeFilter || "", searchQ || "")
    : mosMerged.filter(r => (!typeFilter || r.type === typeFilter));

  const out = [];
  for (const r of rows) {
    const plantMos = computeRowMOS(r, sohMap); // from mos.js — per-plant {plant,soh,amc,mos,isHub}

    for (const pm of plantMos) {
      if (plantFilter && pm.plant !== plantFilter) continue;
      if (pm.amc === null) continue; // not committed at this plant — no basis for risk
      if (!pm.soh || pm.soh <= 0) continue; // nothing on hand, nothing to risk

      const expEntry    = expiryMap.get(r.code)?.[pm.plant] || null;
      const shelfLeftMo  = expEntry ? monthsUntil(expEntry.expiry, today) : null;
      const unitVal      = unitValueFor(expEntry);

      // Need both a real MOS and a real shelf-life date to judge risk.
      if (shelfLeftMo === null || pm.mos === null || pm.mos === Infinity) continue;

      const atRisk    = pm.mos > shelfLeftMo;
      const safeQty    = Math.max(0, shelfLeftMo) * pm.amc; // qty consumable before expiry
      const atRiskQty  = atRisk ? Math.max(0, pm.soh - safeQty) : 0;
      const atRiskVal  = atRiskQty * unitVal;

      out.push({
        code: r.code, desc: r.desc, type: r.type,
        isMerged: r.isMerged, origCodes: r.origCodes,
        plant: pm.plant, isHub: pm.isHub,
        soh: pm.soh, amc: pm.amc, mos: pm.mos,
        shelfLeftMo, unitVal,
        atRisk, atRiskQty, atRiskVal,
        // headroom = how much MORE this plant could safely receive without
        // becoming at-risk itself (used as a recipient in redistribution)
        headroom: atRisk ? 0 : Math.max(0, safeQty - pm.soh),
      });
    }
  }
  return out;
}

// ── ECONOMIC REDISTRIBUTION CORRIDORS ─────────────────────────────────────────
// Ordered "sister branch" partners based on regional/economic proximity.
// When an item is at risk at a plant, we try placing it with these partner
// plants FIRST — one partner at a time, in the order listed below, filling
// each partner's headroom before moving to the next — and only fall back to
// the general national pool (proportional-by-AMC across all other eligible
// plants, same logic as before) once every listed partner for that plant
// has no headroom left.
//
// The redistribution engine otherwise only deals in plant CODES (from the
// AMC file), which don't carry city names, so matching here is done against
// each plant's display name ("Plant Name" from the inventory file),
// case-insensitively, as a substring match.
const ECONOMIC_PARTNERS = {
  "gambella":      ["jimma"],
  "jimma":         ["gambella"],
  "nekemte":       ["assosa"],
  "assosa":        ["nekemte"],
  "shire":         ["mekelle"],
  "mekelle":       ["shire"],
  "addis ababa 1": ["addis ababa 2", "adama"],
  "addis ababa 2": ["addis ababa 1"],
  "negele borena": ["hawassa"],
  "hawassa":       ["negele borena", "arba minch", "adama"],
  "arba minch":    ["hawassa"],
  "bahir dar":     ["gondar"],
  "gondar":        ["bahir dar"],
  "semera":        ["dessie"],
  "dessie":        ["semera"],
  "jijiga":        ["kebri dehar"],
  "kebri dehar":   ["jijiga"],
  "adama":         ["addis ababa 1", "hawassa"],
};

// Plant CODE → Plant NAME, built from rawDf (first non-empty name wins per
// code). Needed because redistribution rows only carry plant codes.
function buildPlantNameMap() {
  const map = new Map();
  const base = typeof rawDf !== "undefined" ? rawDf : [];
  for (const row of base) {
    const code = String(row["Plant"] || "").trim().toUpperCase();
    const name = String(row["Plant Name"] || "").trim();
    if (code && name && !map.has(code)) map.set(code, name);
  }
  return map;
}

// Returns the ECONOMIC_PARTNERS key that best matches a plant's display
// name (longest matching key wins, so "addis ababa 1" isn't shadowed by a
// shorter accidental match), or null if this plant isn't in any corridor.
function economicKeyForPlantName(plantName) {
  const p = String(plantName || "").trim().toLowerCase();
  if (!p) return null;
  let best = null;
  for (const key of Object.keys(ECONOMIC_PARTNERS)) {
    if (p.includes(key) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

function plantNameMatchesPartner(plantName, partnerKey) {
  return String(plantName || "").trim().toLowerCase().includes(partnerKey);
}

// ── REDISTRIBUTION ENGINE ─────────────────────────────────────────────────────
// Works per material code: sources = at-risk rows (any plant incl. HO01),
// recipients = non-at-risk rows at OTHER plants for the SAME material,
// excluding HO01 as a recipient.
//
// Each source's excess is placed in two tiers:
//   TIER 1 (route: "economic") — the source plant's listed economic-corridor
//     partners, tried one at a time in order; each partner absorbs as much
//     as its headroom allows before the next partner is tried.
//   TIER 2 (route: "national") — whatever's left after tier 1 (or the whole
//     amount, if the plant has no listed partners) is split proportionally
//     by AMC across all other eligible recipients, same as before.
// Anything still unplaced after both tiers becomes RESIDUAL RISK.
function computeRedistribution(snapshot) {
  const byCode = new Map();
  for (const row of snapshot) {
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push(row);
  }

  const plantNameMap  = buildPlantNameMap();
  const transfers      = [];          // individual source→recipient moves
  const residualByKey  = new Map();   // `${code}|${plant}` → remaining unplaced qty/val

  // Proportionally allocates `toPlace` units of `src`'s excess across `pool`
  // (eligible recipients with remaining headroom), capping each recipient at
  // its own headroom, re-allocating any leftover headroom across additional
  // rounds until either the amount is fully placed or the pool is exhausted.
  // Mutates each recipient's `.headroom` in place and pushes transfer
  // records tagged with `route`. Returns whatever couldn't be placed.
  function allocate(src, code, pool, toPlace, route) {
    pool = pool.filter(rc => rc.headroom > 0);
    while (pool.length && toPlace > 1e-9) {
      const totalAmc = pool.reduce((s, rc) => s + rc.amc, 0);
      let placedThisRound = 0;

      for (const rc of pool) {
        const share = totalAmc > 0 ? (rc.amc / totalAmc) * toPlace : toPlace / pool.length;
        const alloc = Math.min(share, rc.headroom);
        if (alloc <= 0) continue;

        transfers.push({
          code, desc: src.desc, type: src.type,
          fromPlant: src.plant, fromIsHub: src.isHub,
          toPlant: rc.plant,
          qty: alloc, val: alloc * src.unitVal,
          toMosAfter: rc.amc > 0 ? (rc.soh + alloc) / rc.amc : null,
          toShelfLeftMo: rc.shelfLeftMo,
          route,
        });
        rc.headroom -= alloc;
        placedThisRound += alloc;
      }

      toPlace -= placedThisRound;
      pool = pool.filter(rc => rc.headroom > 1e-9);
      // Safety valve: if a round places nothing (shouldn't happen given the
      // headroom>0 filter, but guards against float edge cases), stop.
      if (placedThisRound <= 1e-9) break;
    }
    return Math.max(0, toPlace);
  }

  function stashResidual(code, src, qty) {
    const key = `${code}|${src.plant}`;
    residualByKey.set(key, {
      code, desc: src.desc, type: src.type,
      plant: src.plant, isHub: src.isHub,
      qty, val: qty * src.unitVal,
      unitVal: src.unitVal,
    });
  }

  for (const [code, rows] of byCode) {
    const sources    = rows.filter(r => r.atRisk && r.atRiskQty > 0)
                            .sort((a, b) => b.atRiskVal - a.atRiskVal); // highest ETB exposure claims headroom first
    const recipients = rows.filter(r => !r.isHub && !r.atRisk && r.headroom > 0);

    for (const src of sources) {
      // Recipients must be a DIFFERENT plant than the source (can't redistribute to self)
      const eligible = recipients.filter(rc => rc.plant !== src.plant);
      let remaining = src.atRiskQty;

      if (!eligible.length || remaining <= 1e-9) {
        if (remaining > 0) stashResidual(code, src, remaining);
        continue;
      }

      // ── TIER 1: economic-corridor partners, one at a time, in order ──
      const srcName = plantNameMap.get(src.plant) || "";
      const econKey = economicKeyForPlantName(srcName);
      if (econKey) {
        for (const partnerKey of ECONOMIC_PARTNERS[econKey]) {
          if (remaining <= 1e-9) break;
          const partnerPool = eligible.filter(rc =>
            rc.headroom > 0 && plantNameMatchesPartner(plantNameMap.get(rc.plant) || "", partnerKey)
          );
          if (!partnerPool.length) continue;
          remaining = allocate(src, code, partnerPool, remaining, "economic");
        }
      }

      // ── TIER 2: national pool — any remaining eligible recipient ──
      if (remaining > 1e-9) {
        const nationalPool = eligible.filter(rc => rc.headroom > 0);
        remaining = allocate(src, code, nationalPool, remaining, "national");
      }

      remaining = Math.max(0, remaining);
      if (remaining > 0) stashResidual(code, src, remaining);
    }
  }

  return { transfers, residual: [...residualByKey.values()] };
}

// ── FORMATTING / FILTER HELPERS ────────────────────────────────────────────────
function exprKpiCard(label, value, sub, color) {
  return `<div class="kpi-card"><div class="kpi-label">${escHtml(label)}</div><div class="kpi-value" style="color:var(--${color||'blue'})">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
}
function exprKpiRow(id, cards) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = cards.join("");
}

// ── MAIN RENDER ────────────────────────────────────────────────────────────────
async function renderExpiryRisk() {
  await waitForPlotly();

  const hasInventory = typeof rawDf !== "undefined" && rawDf.length > 0;
  const hasAmc        = typeof mosMerged !== "undefined" && mosMerged.length > 0;

  if (!hasInventory || !hasAmc) {
    document.getElementById("exprisk-no-data").style.display = "block";
    document.getElementById("exprisk-content").style.display = "none";
    return;
  }
  document.getElementById("exprisk-no-data").style.display  = "none";
  document.getElementById("exprisk-content").style.display = "block";

  const searchEl = document.getElementById("exprisk-search");
  const plantEl  = document.getElementById("exprisk-plant");
  const typeEl   = document.getElementById("exprisk-type");
  const searchQ  = searchEl ? searchEl.value.trim() : "";
  const plantVal = plantEl  ? plantEl.value.trim()  : "";
  const typeVal  = typeEl   ? typeEl.value.trim()   : "";

  if (plantEl && plantEl.options.length <= 1 && typeof mosPlants !== "undefined") {
    mosPlants.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p; opt.text = p === HUB_PLANT ? `${p} (Hub)` : p;
      plantEl.appendChild(opt);
    });
  }

  // ── Build snapshot (unfiltered by plant, so redistribution can see all plants
  // for each item) then apply plant filter only to the BEFORE view ──────────────
  const fullSnapshot = buildRiskSnapshot(typeVal, searchQ, "");
  const beforeRows   = plantVal ? fullSnapshot.filter(r => r.plant === plantVal) : fullSnapshot;
  const atRiskBefore = beforeRows.filter(r => r.atRisk && r.atRiskQty > 0);

  // ── KPIs: BEFORE ──────────────────────────────────────────────────────────────
  const totalAtRiskQtyBefore = atRiskBefore.reduce((s, r) => s + r.atRiskQty, 0);
  const totalAtRiskValBefore = atRiskBefore.reduce((s, r) => s + r.atRiskVal, 0);
  exprKpiRow("exprisk-kpis-before", [
    exprKpiCard("Plant-Item Pairs At Risk", atRiskBefore.length.toLocaleString(), `MOS > shelf-life remaining`, "red"),
    exprKpiCard("At-Risk Value", fmtETB(totalAtRiskValBefore), "Ethiopian Birr exposure", "red"),
  ]);

  // ── CHART: BEFORE — items at risk aggregated across all plants (line chart) ──
  // Collapse plant-level rows into one entry per material (sum qty & val, keep
  // earliest shelf-life and worst MOS so the line reflects the true item-level risk).
  const itemRiskMap = new Map();
  for (const r of atRiskBefore) {
    if (!itemRiskMap.has(r.code)) {
      itemRiskMap.set(r.code, { code: r.code, desc: r.desc, atRiskQty: 0, atRiskVal: 0,
        shelfLeftMo: r.shelfLeftMo, mos: r.mos });
    }
    const e = itemRiskMap.get(r.code);
    e.atRiskQty  += r.atRiskQty;
    e.atRiskVal  += r.atRiskVal;
    // Worst-case shelf life (minimum across plants)
    if (r.shelfLeftMo !== null && (e.shelfLeftMo === null || r.shelfLeftMo < e.shelfLeftMo))
      e.shelfLeftMo = r.shelfLeftMo;
    // Highest MOS (most overstocked plant drives the risk score)
    if (r.mos !== null && (e.mos === null || r.mos > e.mos)) e.mos = r.mos;
  }
  const itemRiskArr = [...itemRiskMap.values()]
    .sort((a, b) => b.atRiskVal - a.atRiskVal)
    .slice(0, 30);

  if (itemRiskArr.length) {
    const labels = itemRiskArr.map(r => r.desc.length > 36 ? r.desc.slice(0, 36) + "…" : r.desc);
    Plotly.newPlot("chart-exprisk-before", [
      {
        // At-risk VALUE line (primary axis)
        type: "scatter", mode: "lines+markers",
        name: "At-Risk Value (ETB)",
        x: labels,
        y: itemRiskArr.map(r => r.atRiskVal),
        line: { color: "#f85149", width: 2.5 },
        marker: { color: "#f85149", size: 7 },
        hovertemplate: "<b>%{x}</b><br>At-risk value: ETB %{y:,.0f}<extra></extra>",
        yaxis: "y",
      },
      {
        // At-risk QTY line (secondary axis)
        type: "scatter", mode: "lines+markers",
        name: "At-Risk Qty (units)",
        x: labels,
        y: itemRiskArr.map(r => r.atRiskQty),
        line: { color: "#ffa657", width: 2, dash: "dot" },
        marker: { color: "#ffa657", size: 6 },
        hovertemplate: "<b>%{x}</b><br>At-risk qty: %{y:,.0f} units<extra></extra>",
        yaxis: "y2",
      },
    ], {
      ...PLOTLY_LAYOUT,
      height: 360,
      margin: { l: 60, r: 70, t: 24, b: 130 },
      xaxis: {
        tickangle: -38,
        tickfont: { size: 9.5 },
        showgrid: false,
      },
      // FIX-AXIS-LABELS: avoid "0M" ticks on the ETB axis when the range is under 1,000,000.
      yaxis:  { title: "At-Risk Value (ETB)", titlefont: { color: "#f85149" }, tickfont: { color: "#f85149" }, tickformat: "~s" },
      yaxis2: { title: "At-Risk Qty", titlefont: { color: "#ffa657" }, tickfont: { color: "#ffa657" },
                overlaying: "y", side: "right", showgrid: false },
      legend: { orientation: "h", y: 1.12, x: 0 },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    }, PLOTLY_CONFIG);
  } else {
    document.getElementById("chart-exprisk-before").innerHTML = "";
  }

  // ── TABLE: BEFORE ──────────────────────────────────────────────────────────────
  const beforeCols = [
    { key: "code", label: "Material Code",
      fmt: (v, r) => r.isMerged
        ? `<span class="col-mat-code">${escHtml(v)}</span><span class="mat-mapped-badge" title="Merged: ${escHtml(r.origCodes)}">MERGED</span>`
        : `<span class="col-mat-code">${escHtml(v)}</span>`,
      raw: true, cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "type", label: "Type" },
    { key: "plant", label: "Plant", fmt: (v, r) => r.isHub ? `<b>${escHtml(v)}</b> <span style="font-size:0.75em;color:var(--purple)">(Hub)</span>` : escHtml(v), raw: true },
    { key: "soh", label: "SOH", fmt: fmtQty },
    { key: "amc", label: r => "AMC", fmt: (v, r) => `${fmtQty(v)}${r.isHub ? ' <span style="font-size:0.7em;color:var(--muted)">(Σ branch)</span>' : ""}`, raw: true },
    { key: "mos", label: "MOS", fmt: v => `<b>${v.toFixed(1)}</b> mo` , raw:true },
    { key: "shelfLeftMo", label: "Shelf Life Left", fmt: v => v < 0 ? `<b style="color:var(--red)">EXPIRED</b>` : `<b>${v.toFixed(1)}</b> mo`, raw: true },
    { key: "atRiskQty", label: "At-Risk Qty", fmt: v => `<b style="color:var(--red)">${fmtQty(v)}</b>`, raw: true },
    { key: "atRiskVal", label: "At-Risk Value", fmt: v => `<b style="color:var(--red)">${fmtETB(v)}</b>`, raw: true },
  ];
  const sortedAtRiskBefore = [...atRiskBefore].sort((a,b)=>b.atRiskVal-a.atRiskVal);
  document.getElementById("exprisk-table-before").innerHTML = buildTable(
    sortedAtRiskBefore, beforeCols, () => "",
    "", {id:"exprisk-before-export", title:""}
  );

  // ── EXPORT (At-Risk Detail before redistribution) ───────────────────────────
  const beforeExportCols = [
    { key: "code", label: "Material Code" }, { key: "desc", label: "Description" }, { key: "type", label: "Type" },
    { key: "plant", label: "Plant" }, { key: "isHub", label: "Hub Plant?", fmt: v => v ? "Yes" : "No" },
    { key: "soh", label: "SOH (units)", fmt: v => Number(v).toFixed(2) },
    { key: "amc", label: "AMC (units/mo)", fmt: v => Number(v).toFixed(2) },
    { key: "mos", label: "MOS (months)", fmt: v => Number(v).toFixed(2) },
    { key: "shelfLeftMo", label: "Shelf Life Left (months)", fmt: v => Number(v).toFixed(2) },
    { key: "atRiskQty", label: "At-Risk Qty (units)", fmt: v => Number(v).toFixed(2) },
    { key: "atRiskVal", label: "At-Risk Value (ETB)", fmt: v => Number(v).toFixed(2) },
  ];
  if (sortedAtRiskBefore.length) wireTableExport("exprisk-before-export", sortedAtRiskBefore, beforeExportCols, "expiry_risk_at_risk_before");

  // ── REDISTRIBUTION (always computed on the FULL unfiltered snapshot, so the
  //    plan is correct regardless of the plant filter applied to the view) ──────
  const { transfers, residual } = computeRedistribution(fullSnapshot);
  const visTransfers = plantVal ? transfers.filter(t => t.fromPlant === plantVal || t.toPlant === plantVal) : transfers;

  const redistCols = [
    { key: "code", label: "Material Code", cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "fromPlant", label: "From",
      fmt: (v, r) => r.fromIsHub ? `<b style="color:var(--purple)">${escHtml(v)} (Hub)</b>` : `<b style="color:var(--amber)">${escHtml(v)}</b>`,
      raw: true },
    { key: "toPlant", label: "To", fmt: v => `<b style="color:var(--blue)">${escHtml(v)}</b>`, raw: true },
    { key: "route", label: "Route", raw: true,
      fmt: v => v === "economic"
        ? `<span class="badge badge-green">🔗 Economic Partner</span>`
        : `<span class="badge badge-blue">🌐 National Pool</span>` },
    { key: "qty", label: "Transfer Qty", fmt: fmtQty },
    { key: "val", label: "Transfer Value", fmt: fmtETB },
    { key: "toMosAfter", label: "Recipient MOS After", fmt: v => v===null ? "—" : `${v.toFixed(1)} mo`, raw: true },
    { key: "toShelfLeftMo", label: "Recipient Shelf Life", fmt: v => `${v.toFixed(1)} mo`, raw: true },
  ];
  const sortedTransfers = [...visTransfers].sort((a,b)=>b.val-a.val);
  document.getElementById("exprisk-redist-table").innerHTML = visTransfers.length
    ? buildTable(sortedTransfers, redistCols, () => "",
        "", {id:"exprisk-redist-export", title:""})
    : '<div class="alert-info" style="margin:0.5rem 0">No eligible transfers found — either nothing is at risk, or no recipient plant has safe headroom for the at-risk items.</div>';

  // ── EXPORT (Suggested Redistribution Plan) ──────────────────────────────────
  const redistExportCols = [
    { key: "code", label: "Material Code" }, { key: "desc", label: "Description" },
    { key: "fromPlant", label: "From Plant" }, { key: "fromIsHub", label: "From Is Hub?", fmt: v => v ? "Yes" : "No" },
    { key: "toPlant", label: "To Plant" },
    { key: "route", label: "Route", fmt: v => v === "economic" ? "Economic Partner" : "National Pool" },
    { key: "qty", label: "Transfer Qty (units)", fmt: v => Number(v).toFixed(2) },
    { key: "val", label: "Transfer Value (ETB)", fmt: v => Number(v).toFixed(2) },
    { key: "toMosAfter", label: "Recipient MOS After (months)", fmt: v => v===null ? "" : Number(v).toFixed(2) },
    { key: "toShelfLeftMo", label: "Recipient Shelf Life (months)", fmt: v => Number(v).toFixed(2) },
  ];
  if (sortedTransfers.length) wireTableExport("exprisk-redist-export", sortedTransfers, redistExportCols, "expiry_risk_redistribution_plan");

  // ── RESIDUAL (AFTER redistribution) — for marketing director ──────────────────
  const visResidual = plantVal ? residual.filter(r => r.plant === plantVal) : residual;
  const totalResidualQty = visResidual.reduce((s, r) => s + r.qty, 0);
  const totalResidualVal = visResidual.reduce((s, r) => s + r.val, 0);
  const hubResidual = visResidual.filter(r => r.isHub);

  const recoveredQty = totalAtRiskQtyBefore - residual.reduce((s,r)=>s+r.qty,0); // network-wide, for context
  const recoveredPct = totalAtRiskQtyBefore > 0
    ? (((totalAtRiskQtyBefore - residual.reduce((s,r)=>s+r.qty,0)) / totalAtRiskQtyBefore) * 100).toFixed(1)
    : "0.0";

  exprKpiRow("exprisk-kpis-after", [
    exprKpiCard("Residual At-Risk Qty", fmtQty(totalResidualQty), "Could not be placed anywhere safely", "red"),
    exprKpiCard("Residual At-Risk Value", fmtETB(totalResidualVal), "Recommend for private sale / discount channel", "red"),
    exprKpiCard("Recovered by Redistribution", `${recoveredPct}%`, "of network-wide at-risk qty resolved by transfer", "green"),
    exprKpiCard(`From ${HUB_PLANT}`, fmtQty(hubResidual.reduce((s,r)=>s+r.qty,0)), `${hubResidual.length} item(s) from the hub`, "purple"),
  ]);

  const afterCols = [
    { key: "code", label: "Material Code", cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "type", label: "Type" },
    { key: "plant", label: "Plant", fmt: (v, r) => r.isHub ? `<b>${escHtml(v)}</b> <span style="font-size:0.75em;color:var(--purple)">(Hub)</span>` : escHtml(v), raw: true },
    { key: "qty", label: "Residual Qty", fmt: v => `<b style="color:var(--red)">${fmtQty(v)}</b>`, raw: true },
    { key: "val", label: "Residual Value", fmt: v => `<b style="color:var(--red)">${fmtETB(v)}</b>`, raw: true },
    { key: "unitVal", label: "Unit Value", fmt: v => fmtETB(v) },
  ];
  // Exclude rows that round to 0 units when displayed (fmtQty has no decimal
  // places) — these are floating-point dust from the allocation math, not
  // real residual risk, so they'd just clutter the item list. The KPI totals
  // above are computed from the full unfiltered visResidual, so they still
  // reflect the true (negligible) leftover amount.
  const sortedResidual = [...visResidual].filter(r => Math.round(r.qty) !== 0).sort((a,b)=>b.val-a.val);
  document.getElementById("exprisk-table-after").innerHTML = sortedResidual.length
    ? buildTable(sortedResidual, afterCols, () => "", "", {id:"exprisk-export", title:""})
    : '<div class="alert-info" style="margin:0.5rem 0">✓ Nothing left over — redistribution fully resolves the at-risk stock for the current filters.</div>';

  // ── EXPORT (export the marketing-director residual list, the most actionable one) ──
  const exportCols = [
    { key: "code", label: "Material Code" }, { key: "desc", label: "Description" }, { key: "type", label: "Type" },
    { key: "plant", label: "Plant" }, { key: "isHub", label: "Hub Plant?", fmt: v => v ? "Yes" : "No" },
    { key: "qty", label: "Residual Qty (units)", fmt: v => Number(v).toFixed(2) },
    { key: "val", label: "Residual Value (ETB)", fmt: v => Number(v).toFixed(2) },
    { key: "unitVal", label: "Unit Value (ETB)", fmt: v => Number(v).toFixed(2) },
  ];
  if (sortedResidual.length) wireTableExport("exprisk-export", sortedResidual, exportCols, "expiry_risk_residual_for_marketing");
}

// ── WIRE INTO PAGE_RENDERERS AND EVENT LISTENERS ──────────────────────────────
(function wireExpiryRiskModule() {
  function extend() {
    if (typeof PAGE_RENDERERS !== "undefined") {
      PAGE_RENDERERS["expiry-risk"] = renderExpiryRisk;
    }

    const _origRenderPage = window.renderPage;
    window.renderPage = function (id) {
      if (id === "expiry-risk") {
        currentPage = id;
        document.getElementById("landingView").style.display = "none";
        document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
        const pg = document.getElementById("page-expiry-risk");
        if (pg) pg.style.display = "block";
        document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
        try { renderExpiryRisk(); } catch (e) { console.error(e); }
        return;
      }
      _origRenderPage(id);
    };

    const filterMap = {
      "exprisk-apply": renderExpiryRisk,
      "exprisk-clear": () => {
        const s = document.getElementById("exprisk-search"); if (s) s.value = "";
        const p = document.getElementById("exprisk-plant");  if (p) p.value = "";
        const t = document.getElementById("exprisk-type");   if (t) t.value = "";
        renderExpiryRisk();
      },
    };

    document.body.addEventListener("click", (e) => {
      const btn = e.target.closest("button[id]");
      if (!btn) return;
      const fn = filterMap[btn.id];
      if (fn) { e.stopPropagation(); fn(); }
    }, true);

    // Pressing Enter in the material search box applies the filter immediately,
    // same UX pattern as the global sidebar search.
    const searchInput = document.getElementById("exprisk-search");
    if (searchInput) {
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") renderExpiryRisk();
      });
    }

    // Re-render if currently on this page and either source file changes
    const fileInput    = document.getElementById("fileInput");
    const mosAmcInput   = document.getElementById("mosAmcFileInput");
    [fileInput, mosAmcInput].forEach(inp => {
      if (!inp) return;
      inp.addEventListener("change", () => {
        setTimeout(() => { if (currentPage === "expiry-risk") renderExpiryRisk(); }, 350);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", extend);
  } else {
    extend();
  }
})();
