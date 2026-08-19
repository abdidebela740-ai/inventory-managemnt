// =============================================================================
// PharmaTrack v2 — stockout-risk.js
// "📉 Stockout Risk" — NATIONAL-LEVEL ONLY (no per-plant breakdown).
//
// RULE (per product decision)
// ----------------------------
//   Every material in scope is classified into ONE of five MOS bands, where
//   National MOS is EXACTLY mos.js's existing computeNationalMOS():
//       National MOS = (SOH at every plant, including HO01)
//                     ÷ (AMC at every BRANCH plant, excluding HO01)
//
//   status = "out"       → National MOS < 1 month        → STOCKOUT
//                           (already exhausted or nearly so — not a future
//                           "risk," this needs emergency action now)
//   status = "high"      → 1 ≤ National MOS < 3 month     → HIGH RISK
//   status = "medium"    → 3 ≤ National MOS < 6 month     → MEDIUM RISK
//   status = "optimal"   → 6 ≤ National MOS < 12 month    → OPTIMAL
//   status = "overstock" → National MOS ≥ 12 month        → OVERSTOCK
//
//   atRisk (boolean) = status is "out" or "high", i.e. MOS < 3 — kept for
//   backward compatibility with filtering/sorting logic that predates the
//   5-way split (this is the same "needs attention soon" boundary the old
//   single at-risk threshold used to represent).
//
// SCOPE DECISIONS (confirmed)
// ---------------------------
//   - Thresholds are fixed constants (see STOCKOUT_*_THRESHOLD below), not UI
//     inputs.
//   - Respects the global sidebar Person Filter (rows are still scoped by it,
//     same as every other MOS-derived page) — but the Person column itself is
//     NOT displayed on this page or in its export.
//   - ONLY these three material types are ever in scope, regardless of the
//     Type dropdown selection: ZME, ZMS, ZLC. Any other type (e.g. ZMD) is
//     excluded from this page entirely, even under "All Types."
//   - Materials with National MOS = null (no branch committed at all) or
//     = Infinity (stock but zero branch demand) are EXCLUDED from this page —
//     there's no finite MOS to place in a band.
//   - No Material Group filter — removed per product decision.
//   - NO ETB value anywhere on this page, NO chart — KPIs + table only.
//   - KPI row shows a per-type at-risk breakdown (ZME / ZMS / ZLC counts,
//     Stockout + High Risk only) instead of an average-MOS figure.
//
// Requires: script.js (fmtQty, escHtml, wireTableExport, downloadCSV,
//           downloadExcel, PAGE_RENDERERS, renderPage, currentPage,
//           personFilter, rawDf)
//           mos.js (HUB_PLANT, mosMerged, mosPlants, buildMosSohMap,
//           computeNationalMOS, getMosFilteredRows, fmtMosVal)
// Must be loaded AFTER both script.js and mos.js.
// =============================================================================

const STOCKOUT_OUT_THRESHOLD     = 1;  // months — below this: STOCKOUT
const STOCKOUT_HIGH_THRESHOLD    = 3;  // months — below this (and >= out): HIGH RISK; also the "at risk" / expiry cross-check ceiling
const STOCKOUT_MEDIUM_THRESHOLD  = 6;  // months — below this (and >= high): MEDIUM RISK
const STOCKOUT_OPTIMAL_THRESHOLD = 12; // months — below this (and >= medium): OPTIMAL; at/above this: OVERSTOCK
const STOCKOUT_ALLOWED_TYPES = new Set(["ZME", "ZMS", "ZLC"]); // page scope is fixed to these three

// Classify a finite National MOS value into one of the five status bands.
function stkoClassifyStatus(mos) {
  if (mos < STOCKOUT_OUT_THRESHOLD)     return "out";
  if (mos < STOCKOUT_HIGH_THRESHOLD)    return "high";
  if (mos < STOCKOUT_MEDIUM_THRESHOLD)  return "medium";
  if (mos < STOCKOUT_OPTIMAL_THRESHOLD) return "optimal";
  return "overstock";
}
// Severity order across the FULL range, worst (0) to best (4). Used to detect
// a band downgrade anywhere in the range — Overstock→Optimal, Optimal→Medium,
// Medium→High, High→Stockout — not just crossings into the <3mo zone.
const STKO_BAND_RANK = { out: 0, high: 1, medium: 2, optimal: 3, overstock: 4 };

// ── EXPIRY-ADJUSTED RISK (extra cross-check signal, does NOT alter the core
//    National MOS rule or "confirmed" status thresholds above) ───────────────
// National MOS is pure quantity ÷ consumption — it has no idea how much of
// that SOH is about to expire. A material can show MOS >= 4 ("ok") today and
// still be quietly heading toward a stockout the moment a big batch expires.
//
// This reuses buildExpiryMap()/monthsUntil() from expiry-risk.js — the SAME
// earliest-batch-per-plant expiry basis used on the Overstock & Expiry Risk
// page — so the two pages agree on what "expiring soon" means.
//
//   expiringQty  = national SOH (all plants incl. HO01) whose earliest-
//                  expiring batch falls within the next STOCKOUT_OPTIMAL_THRESHOLD
//                  months (already-expired batches count too — they're gone).
//                  This spans the FULL band range, not just the 3mo High-Risk
//                  window, so a downgrade anywhere in the range can be seen.
//   expiringQty_0_3mo / expiringQty_3_6mo / expiringQty_6_12mo =
//                  the same national expiringQty split into the three bands
//                  planners actually act on differently. A batch that's
//                  already expired (negative months left) is folded into the
//                  0–3mo tier — it's the most urgent case, not a separate one.
//                  These three always sum to expiringQty.
//   nearestExpiry = the single earliest expiry date found across ALL plants
//                  for this material (Date, or null if no plant has expiry
//                  data at all) — tracked independent of the 12mo threshold,
//                  since planners want to see the soonest date a material is
//                  exposed to even if it's further out than the window above.
//   adjustedMos  = (totalSoh - expiringQty) ÷ totalAmc
//                  → what National MOS becomes once that soon-to-expire
//                  stock is excluded from the count.
//   exprAdjustedStatus = adjustedMos run through the SAME 5-tier classifier
//                  (stkoClassifyStatus) as the headline status — "Expiry-
//                  Adjusted MOS" always shows the real band, not a raw
//                  threshold check.
//   exprAdjustedRisk = true whenever exprAdjustedStatus is a WORSE band than
//                  the material's current status — checked across the FULL
//                  range (Overstock→Optimal, Optimal→Medium, Medium→High,
//                  High→Stockout), not only crossings into the <3mo zone.
//                  i.e. any material whose coverage would drop a tier once
//                  its soon-to-expire stock is excluded gets flagged.
//   nearTermDriver = true when AT LEAST ONE contributing batch behind
//                  expiringQty is inside the <3mo High-Risk window (this
//                  includes already-expired batches). Lets the table/export
//                  distinguish "this adjusted-risk flag is driven by stock
//                  expiring imminently" from "...driven only by mid/long-
//                  range (3–12mo) expiry" — the urgency signal a flat
//                  expiringQty total loses.
// Tiers within the threshold window that the caller cares about for the
// urgency breakdown. Fixed to the same STOCKOUT_HIGH/MEDIUM_THRESHOLD
// boundaries used everywhere else on this page, so "0–3mo" here always
// means the same thing as the High-Risk band, etc.
function buildNationalExpiryDetailMap(thresholdMonths) {
  // code -> { expiringQty, expiringQty_0_3mo, expiringQty_3_6mo,
  //           expiringQty_6_12mo, nearestExpiry, nearTermDriver }
  const map = new Map();
  if (typeof buildExpiryMap !== "function") return map; // expiry-risk.js not loaded
  const expiryMap = buildExpiryMap(); // from expiry-risk.js: code -> plant -> {expiry, qtySum, valSum}
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const [code, plantMap] of expiryMap.entries()) {
    let expiringQty = 0;
    let qty0to3 = 0, qty3to6 = 0, qty6to12 = 0;
    let nearestExpiry = null;
    let nearTermDriver = false;

    for (const plant in plantMap) {
      const entry = plantMap[plant];
      if (!entry.expiry) continue; // no expiry data at this plant — can't judge, skip

      // Nearest expiry is tracked across ALL plants regardless of whether it
      // falls inside thresholdMonths — it's a standalone urgency signal, not
      // just a byproduct of the expiringQty cutoff.
      if (nearestExpiry === null || entry.expiry < nearestExpiry) nearestExpiry = entry.expiry;

      const left = monthsUntil(entry.expiry, today); // from expiry-risk.js
      if (left === null || left >= thresholdMonths) continue;

      // BUGFIX-EXPIRY-QTY: entry.qtySum is the plant's TOTAL stock of this
      // material across every batch, not just the one that's actually near
      // expiry — using it here was inflating expiring-qty by every far-dated
      // batch riding along at the same plant. entry.earliestQty is scoped to
      // only the batch(es) tied for the earliest expiry date, which is what
      // "expiring" is supposed to mean.
      const nearQty = entry.earliestQty || 0;
      expiringQty += nearQty;

      // Already-expired batches (left < 0) fold into the 0–3mo tier — same
      // "it's already gone" logic as the top-level expiringQty comment above.
      if (left < STOCKOUT_HIGH_THRESHOLD) {
        qty0to3 += nearQty;
        nearTermDriver = true; // at least one contributing batch is <3mo out
      } else if (left < STOCKOUT_MEDIUM_THRESHOLD) {
        qty3to6 += nearQty;
      } else {
        qty6to12 += nearQty;
      }
    }

    if (expiringQty > 0 || nearestExpiry !== null) {
      map.set(code, {
        expiringQty,
        expiringQty_0_3mo: qty0to3,
        expiringQty_3_6mo: qty3to6,
        expiringQty_6_12mo: qty6to12,
        nearestExpiry,
        nearTermDriver,
      });
    }
  }
  return map;
}

// ── BUILD THE NATIONAL STOCKOUT-RISK SNAPSHOT ─────────────────────────────────
// Returns an array of { code, desc, type, totalSoh, totalAmc, mos, atRisk, status,
//   expiringQty, adjustedMos, exprAdjustedStatus, exprAdjustedRisk,
//   expiringQty_0_3mo, expiringQty_3_6mo, expiringQty_6_12mo,
//   nearestExpiry, nearTermDriver } — see the field-by-field comment block
// above buildNationalExpiryDetailMap() for what each expiry-related field means.
// status: "out"       → MOS < 1        → STOCKOUT
//         "high"      → 1 ≤ MOS < 3    → HIGH RISK
//         "medium"    → 3 ≤ MOS < 6    → MEDIUM RISK
//         "optimal"   → 6 ≤ MOS < 12   → OPTIMAL
//         "overstock" → MOS ≥ 12       → OVERSTOCK
// Only ZME/ZMS/ZLC types are ever included, and only materials where National
// MOS is a real, finite number (null/Infinity dropped).
function buildStockoutSnapshot(typeFilter, searchQ) {
  if (typeof mosMerged === "undefined" || !mosMerged.length) return [];

  const sohMap = buildMosSohMap();          // from mos.js

  // getMosFilteredRows() already applies the global personFilter before
  // type/search, exactly like MOS by Plant / Expiry Risk.
  let rows = (typeof getMosFilteredRows === "function")
    ? getMosFilteredRows(typeFilter || "", searchQ || "")
    : mosMerged.filter(r => (!typeFilter || r.type === typeFilter));

  // Hard scope: only ZME/ZMS/ZLC, regardless of the dropdown value —
  // "All Types" on this page still means "all of ZME/ZMS/ZLC," never ZMD
  // or anything else.
  rows = rows.filter(r => STOCKOUT_ALLOWED_TYPES.has(r.type));

  // Widened to STOCKOUT_OPTIMAL_THRESHOLD (12mo) so the cross-check works
  // across the FULL range, not just the <3mo High-Risk boundary — a batch
  // expiring in month 5 or month 10 can still pull an Overstock or Optimal
  // material down a tier, and a 3mo window would never have seen it.
  const expiryDetailMap = buildNationalExpiryDetailMap(STOCKOUT_OPTIMAL_THRESHOLD);

  const out = [];
  for (const r of rows) {
    const nat = computeNationalMOS(r, sohMap); // from mos.js
    if (nat.mos === null || nat.mos === Infinity) continue; // no basis / no real demand

    const status = stkoClassifyStatus(nat.mos);
    const atRisk = status === "out" || status === "high"; // MOS < 3

    // Expiry-adjusted cross-check — doesn't affect status/atRisk above.
    // The adjusted MOS is run through the SAME 5-tier classifier as the
    // headline status (stkoClassifyStatus), so "Expiry-Adjusted MOS" always
    // shows the real band that value falls into — never a bare threshold
    // check — and stays in lockstep with the Stockout/High/Medium/Optimal/
    // Overstock definitions if those bands ever change.
    const detail = expiryDetailMap.get(r.code) || null;
    const rawExpiringQty = detail ? detail.expiringQty : 0;
    const expiringQty     = Math.min(rawExpiringQty, nat.totalSoh); // guard vs basis mismatch
    const adjustedMos      = (expiringQty > 0 && nat.totalAmc > 0)
      ? (nat.totalSoh - expiringQty) / nat.totalAmc
      : null;
    const exprAdjustedStatus = adjustedMos !== null ? stkoClassifyStatus(adjustedMos) : null;
    // Flag ANY downgrade across the full band range once near-expiry stock
    // is excluded — Overstock→Optimal, Optimal→Medium, Medium→High,
    // High→Stockout all count, not just crossings into the <3mo zone.
    const exprAdjustedRisk = exprAdjustedStatus !== null
      && STKO_BAND_RANK[exprAdjustedStatus] < STKO_BAND_RANK[status];

    const nearTermDriver   = detail ? detail.nearTermDriver : false;
    const expiringQty_3_6mo  = detail ? detail.expiringQty_3_6mo : 0;
    const expiringQty_6_12mo = detail ? detail.expiringQty_6_12mo : 0;

    // Plain-string version of the driver badge, precomputed here (rather than
    // in the export column's fmt) because the export helper's fmt callback
    // only ever receives the raw cell value, not the row — see the export
    // columns below. Mirrors stkoExpiryDriverCell()'s tier-based logic
    // exactly, so the export never shows "Long-Range" when the 6–12mo tier
    // is actually empty.
    //
    // Shown for ANY material with expiring stock (expiringQty > 0), not just
    // ones where it drags the status band down — a material can have real
    // expiring stock and still stay comfortably in its current band (e.g.
    // Overstock with a small slice expiring). exprAdjustedRisk (separate
    // field, unchanged) is what differentiates "just some expiring stock" —
    // no downgrade — from "this expiring stock is bad enough to demote the
    // band" — see stkoExpiryDriverCell()'s styling split.
    let expiryDriverLabel = "";
    if (expiringQty > 0) {
      if (nearTermDriver) {
        expiryDriverLabel = `Near-Term (<${STOCKOUT_HIGH_THRESHOLD}mo)`;
      } else {
        const hasMid  = expiringQty_3_6mo > 0;
        const hasLong = expiringQty_6_12mo > 0;
        expiryDriverLabel = (hasMid && hasLong)
          ? `Mid/Long-Range (${STOCKOUT_HIGH_THRESHOLD}-${STOCKOUT_OPTIMAL_THRESHOLD}mo)`
          : hasLong
            ? `Long-Range (${STOCKOUT_MEDIUM_THRESHOLD}-${STOCKOUT_OPTIMAL_THRESHOLD}mo)`
            : `Mid-Range (${STOCKOUT_HIGH_THRESHOLD}-${STOCKOUT_MEDIUM_THRESHOLD}mo)`;
      }
    }

    out.push({
      code: r.code, desc: r.desc, type: r.type,
      isMerged: r.isMerged, origCodes: r.origCodes,
      totalSoh: nat.totalSoh, totalAmc: nat.totalAmc, mos: nat.mos,
      atRisk, status,
      expiringQty, adjustedMos, exprAdjustedStatus, exprAdjustedRisk,
      // Tiered breakdown, nearest expiry, and near-term-driver flag — raw,
      // not capped by the totalSoh guard above (that guard only protects
      // the adjustedMos math; the tiers/date are reporting-only signals).
      expiringQty_0_3mo: detail ? detail.expiringQty_0_3mo : 0,
      expiringQty_3_6mo, expiringQty_6_12mo,
      nearestExpiry: detail ? detail.nearestExpiry : null,
      nearTermDriver, expiryDriverLabel,
    });
  }
  return out;
}

// ── CLICKABLE KPI CARDS ────────────────────────────────────────────────────────
// Clicking a KPI card on this page filters the table below to just the
// materials behind that number. Clicking the same (active) card again clears
// the filter. filterKey values: "out" | "high" | "medium" | "optimal" |
// "overstock" | "ZME" | "ZMS" | "ZLC" | "exprAdj" | "all" (the "Materials
// Screened" card, which always resets).
let stkoCardFilter = null;

// ── FORMATTING HELPERS ────────────────────────────────────────────────────────
function stkoKpiCard(label, value, sub, color, filterKey) {
  if (!filterKey) {
    return `<div class="kpi-card"><div class="kpi-label">${escHtml(label)}</div><div class="kpi-value" style="color:var(--${color||'blue'})">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  }
  const isActive = stkoCardFilter === filterKey;
  const activeStyle = isActive ? `border-color:var(--${color||'blue'});box-shadow:0 0 0 1px var(--${color||'blue'})` : "";
  return `<div class="kpi-card" data-stko-filter="${escHtml(filterKey)}" role="button" tabindex="0"
      style="cursor:pointer;${activeStyle}" title="Click to show these items in the table below">
    <div class="kpi-label">${escHtml(label)}</div>
    <div class="kpi-value" style="color:var(--${color||'blue'})">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}
  </div>`;
}
function stkoKpiRow(cards) {
  const el = document.getElementById("stko-kpis");
  if (el) el.innerHTML = cards.join("");
}
// MOS cell text color: "out" (<1mo) gets the strongest red, "high" (1–3mo)
// standard red, "medium" (3–6mo) amber, "optimal" (6–12mo) green,
// "overstock" (>=12mo) blue.
function stkoMosCellStyle(status) {
  if (status === "out")       return "color:var(--red);font-weight:800";
  if (status === "high")      return "color:var(--red);font-weight:700";
  if (status === "medium")    return "color:var(--amber);font-weight:700";
  if (status === "optimal")   return "color:var(--green);font-weight:600";
  if (status === "overstock") return "color:var(--blue);font-weight:700";
  return "color:var(--text)";
}
function stkoStatusBadge(status) {
  if (status === "out")       return '<span class="stko-badge stko-badge-out">STOCKOUT</span>';
  if (status === "high")      return '<span class="stko-badge stko-badge-risk">HIGH RISK</span>';
  if (status === "medium")    return '<span class="stko-badge stko-badge-medium">MEDIUM RISK</span>';
  if (status === "optimal")   return '<span class="stko-badge stko-badge-ok">OPTIMAL</span>';
  if (status === "overstock") return '<span class="stko-badge stko-badge-overstock">OVERSTOCK</span>';
  return '<span class="stko-badge">—</span>';
}
function stkoStatusLabel(status) {
  if (status === "out")       return "Stockout";
  if (status === "high")      return "High Risk";
  if (status === "medium")    return "Medium Risk";
  if (status === "optimal")   return "Optimal";
  if (status === "overstock") return "Overstock";
  return "—";
}
// Expiry-adjusted MOS cell: shows "—" when there's no expiry basis to judge.
// Otherwise the adjusted value is colored/weighted per its OWN classified
// band (exprAdjustedStatus) — same 5-tier styling as the main MOS column.
// The status badge itself now lives in its own "Expiry-Adjusted Status"
// column (stkoExprAdjStatusCell) instead of stacking onto this cell — same
// split the main MOS/Status columns already use.
function stkoExprAdjCell(r) {
  if (r.adjustedMos === null) return '<span style="color:var(--muted)">—</span>';
  const style = stkoMosCellStyle(r.exprAdjustedStatus);
  return `<span style="${style}">${fmtMosVal(r.adjustedMos)}</span>`;
}
// Dedicated Expiry-Adjusted Status column — same badge as the main Status
// column (stkoStatusBadge), just driven by exprAdjustedStatus instead of
// status. "—" when there's no expiry basis to judge (adjustedMos is null).
function stkoExprAdjStatusCell(r) {
  if (r.adjustedMos === null) return '<span style="color:var(--muted)">—</span>';
  return stkoStatusBadge(r.exprAdjustedStatus);
}

// Dedicated severity-driver column, shown right after Expiry-Adjusted Status.
// Blank ("—") only when there's NO expiring stock at all. Applies to every
// material with expiringQty > 0 — not just ones where it drags the band
// down — but the two cases are styled differently so they stay easy to
// tell apart at a glance:
//   ⚠ amber "…EXPIRY" badge   → exprAdjustedRisk true: this expiring stock
//                                is enough to demote the status band.
//   ⋯ muted "…expiry watch"   → material has expiring stock, but the band
//                                stays the same either way (e.g. an
//                                Overstock item with a small slice expiring
//                                early still lands in Overstock/Optimal
//                                after adjustment).
//
// Label picks whichever tier(s) actually hold the expiring qty — NOT just a
// near-term/not-near-term binary — so "long-range" is never shown unless the
// 6–12mo tier genuinely has stock in it:
//   NEAR-TERM EXPIRY      → nearTermDriver true (some qty is <3mo out,
//                           including already-expired stock).
//   MID-RANGE EXPIRY      → all qty sits in the 3–6mo tier; 6–12mo empty.
//   LONG-RANGE EXPIRY     → all qty sits in the 6–12mo tier; 3–6mo empty.
//   MID/LONG-RANGE EXPIRY → qty is split across BOTH the 3–6mo and 6–12mo tiers.
function stkoExpiryDriverCell(r) {
  if (!(r.expiringQty > 0)) return '<span style="color:var(--muted)">—</span>';

  let rangeLabel;
  if (r.nearTermDriver) {
    rangeLabel = "NEAR-TERM EXPIRY";
  } else {
    const hasMid  = (r.expiringQty_3_6mo || 0) > 0;
    const hasLong = (r.expiringQty_6_12mo || 0) > 0;
    rangeLabel = (hasMid && hasLong) ? "MID/LONG-RANGE EXPIRY"
      : hasLong ? "LONG-RANGE EXPIRY"
      : "MID-RANGE EXPIRY";
  }
  const title = `${fmtQty(r.expiringQty_0_3mo)} units <${STOCKOUT_HIGH_THRESHOLD}mo, `
    + `${fmtQty(r.expiringQty_3_6mo)} units ${STOCKOUT_HIGH_THRESHOLD}-${STOCKOUT_MEDIUM_THRESHOLD}mo, `
    + `${fmtQty(r.expiringQty_6_12mo)} units ${STOCKOUT_MEDIUM_THRESHOLD}-${STOCKOUT_OPTIMAL_THRESHOLD}mo nationally`
    + (r.exprAdjustedRisk ? " — drops the status band once excluded" : " — status band unchanged once excluded");

  if (r.exprAdjustedRisk) {
    return `<span class="stko-badge stko-badge-expadj" style="background:rgba(245,158,11,.15);color:var(--amber)" title="${title}">⚠ ${rangeLabel}</span>`;
  }
  // Has expiring stock, but adjusting for it doesn't change the band —
  // deliberately muted/no-warning-icon so it doesn't read as urgent.
  return `<span class="stko-badge" style="background:rgba(148,163,184,.15);color:var(--muted)" title="${title}">⋯ ${rangeLabel} (no band change)</span>`;
}

// Formats a Date (or date-like value) as "12 Aug 2026"; "—" for null/invalid.
// Self-contained — doesn't assume a shared date formatter exists elsewhere.
function stkoFmtDate(d) {
  if (!d) return "—";
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Nearest-expiry cell: the date itself, colored red when it's the reason
// nearTermDriver is true (i.e. it falls inside the <3mo window), so the
// urgency is visible without opening the Expiry-Adjusted MOS tooltip.
function stkoNearestExpiryCell(r) {
  if (!r.nearestExpiry) return '<span style="color:var(--muted)">—</span>';
  const style = r.nearTermDriver ? "color:var(--red);font-weight:700" : "";
  return `<span style="${style}">${stkoFmtDate(r.nearestExpiry)}</span>`;
}

// Compact tiered expiringQty cell: "0–3mo / 3–6mo / 6–12mo" units, each
// colored by urgency, so the FULL breakdown a downgrade is drawn from is
// visible at a glance instead of just the collapsed total.
function stkoExpiringTierCell(r) {
  const t0 = r.expiringQty_0_3mo || 0, t1 = r.expiringQty_3_6mo || 0, t2 = r.expiringQty_6_12mo || 0;
  if (t0 + t1 + t2 <= 0) return '<span style="color:var(--muted)">—</span>';
  const seg = (qty, color) => qty > 0
    ? `<span style="color:var(--${color});font-weight:600">${fmtQty(qty)}</span>`
    : '<span style="color:var(--muted)">0</span>';
  return `${seg(t0, "red")} / ${seg(t1, "amber")} / ${seg(t2, "blue")}`;
}


// ── FEAT-STKO-FREEZE: freeze-panes for the Stockout Risk table ─────────────
// Self-contained (not routed through script.js's shared buildTable()) —
// same pattern Branch Comparison's own "Material Across Branches" tab uses:
// freezes the first 3 columns (Material Code, Description, Type) and the
// header row, independently toggleable via ⇔ / ⇕ icons in the top-left
// header cell.
let stkoColFreezeOn = false;
let stkoRowFreezeOn = false;
const STKO_FREEZE_COL_MAX_IDX = 2; // first three columns: idx 0, 1, 2

// Builds the table HTML directly (rather than calling buildTable()) so the
// frozen columns/header can carry the data-freeze-col markup and the
// top-left toggle icons.
function stkoBuildFreezeTable(rows, cols, rowClass) {
  if (!rows.length) return '<div class="alert-info">No data to display.</div>';
  const thead = `<thead><tr>${cols.map((c, i) => {
    const freezeAttr = i <= STKO_FREEZE_COL_MAX_IDX ? ` data-freeze-col="${i}"` : "";
    const pins = i === 0
      ? `<span class="freeze-toggle-btn freeze-cols-btn" id="stko-freeze-col-toggle" role="button" tabindex="0" title="Freeze first 3 columns (horizontal scroll)">⇔</span>` +
        `<span class="freeze-toggle-btn freeze-header-btn" id="stko-freeze-row-toggle" role="button" tabindex="0" title="Freeze header row (vertical scroll)">⇕</span>`
      : "";
    return `<th${freezeAttr}>${escHtml(c.label)}${pins}</th>`;
  }).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(row => {
    const cls = rowClass ? rowClass(row) : "";
    return `<tr class="${cls}">${cols.map((c, i) => {
      // Pass both the cell value AND the full row so fmt functions can cross-check sibling fields
      const raw     = c.fmt ? c.fmt(row[c.key], row) : (row[c.key] ?? "");
      const val     = c.raw ? raw : escHtml(String(raw));
      const cellCls = c.cellClass || "";
      const freezeAttr = i <= STKO_FREEZE_COL_MAX_IDX ? ` data-freeze-col="${i}"` : "";
      return `<td class="${cellCls}"${freezeAttr}>${val}</td>`;
    }).join("")}</tr>`;
  }).join("")}</tbody>`;
  return `<div style="color:var(--muted);font-size:12px;margin-bottom:6px">⇔ freeze first 3 columns · ⇕ freeze header row — click either icon in the top-left header cell</div>
    <div class="tbl-wrap tbl-wrap-freeze"><table>${thead}${tbody}</table></div>`;
}

// Measures the rendered widths of the frozen columns and stamps cumulative
// pixel offsets onto their `left` style so position:sticky lines them up —
// widths vary with content/theme/font, so a fixed CSS value can't be used.
// Only relevant to column freeze; row freeze needs no offset math since the
// header just sticks to top:0.
function stkoComputeFreezeOffsets(table) {
  const headCells = [...table.querySelectorAll("thead th[data-freeze-col]")]
    .sort((a, b) => Number(a.dataset.freezeCol) - Number(b.dataset.freezeCol));
  let offset = 0;
  const leftByIdx = {};
  headCells.forEach(th => {
    th.style.left = offset + "px";
    leftByIdx[th.dataset.freezeCol] = offset;
    offset += th.getBoundingClientRect().width;
  });
  table.querySelectorAll("tbody td[data-freeze-col]").forEach(td => {
    td.style.left = leftByIdx[td.dataset.freezeCol] + "px";
  });
}

// Column freeze (⇔) — independent of row freeze.
function setStkoColFreeze(on) {
  stkoColFreezeOn = on;
  const table = document.querySelector("#stko-table table");
  const btn   = document.getElementById("stko-freeze-col-toggle");
  if (!table) return;
  if (on) {
    table.classList.add("freeze-cols");
    if (btn) { btn.classList.add("active"); btn.setAttribute("aria-pressed", "true"); }
    stkoComputeFreezeOffsets(table);
  } else {
    table.classList.remove("freeze-cols");
    if (btn) { btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); }
    table.querySelectorAll("[data-freeze-col]").forEach(el => { el.style.left = ""; });
  }
}

// Row freeze (⇕) — independent of column freeze.
function setStkoRowFreeze(on) {
  stkoRowFreezeOn = on;
  const table = document.querySelector("#stko-table table");
  const btn   = document.getElementById("stko-freeze-row-toggle");
  if (!table) return;
  if (on) {
    table.classList.add("freeze-header");
    if (btn) { btn.classList.add("active"); btn.setAttribute("aria-pressed", "true"); }
  } else {
    table.classList.remove("freeze-header");
    if (btn) { btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); }
  }
}

// Wires both toggles and re-applies whatever freeze state was active before
// this re-render (filter/search/card-click changes rebuild #stko-table's
// innerHTML, which would otherwise silently drop it).
function wireStkoFreezeToggle() {
  const colBtn = document.getElementById("stko-freeze-col-toggle");
  const rowBtn = document.getElementById("stko-freeze-row-toggle");

  if (colBtn) {
    colBtn.addEventListener("click", (e) => { e.stopPropagation(); setStkoColFreeze(!stkoColFreezeOn); });
    colBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setStkoColFreeze(!stkoColFreezeOn); }
    });
  }
  if (rowBtn) {
    rowBtn.addEventListener("click", (e) => { e.stopPropagation(); setStkoRowFreeze(!stkoRowFreezeOn); });
    rowBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setStkoRowFreeze(!stkoRowFreezeOn); }
    });
  }
  if (stkoColFreezeOn) setStkoColFreeze(true);
  if (stkoRowFreezeOn) setStkoRowFreeze(true);
}

// ── MAIN RENDER ────────────────────────────────────────────────────────────────
function renderStockoutRisk() {
  const hasInventory = typeof rawDf !== "undefined" && rawDf.length > 0;
  const hasAmc        = typeof mosMerged !== "undefined" && mosMerged.length > 0;

  if (!hasInventory || !hasAmc) {
    const noDataEl = document.getElementById("stko-no-data");
    if (noDataEl) {
      if (!hasAmc && !hasInventory) {
        noDataEl.innerHTML = 'Upload the <b>main inventory Excel</b> and <b>AMC.xlsx</b> (📐 AMC upload in the sidebar) to enable this analysis.';
      } else if (!hasAmc) {
        noDataEl.innerHTML = 'Upload <b>AMC.xlsx</b> (📐 AMC upload in the sidebar) to enable this analysis — the main inventory file is already loaded.';
      } else {
        noDataEl.innerHTML = 'Upload the <b>main inventory Excel</b> to enable this analysis — AMC.xlsx is already loaded.';
      }
      noDataEl.style.display = "block";
    }
    document.getElementById("stko-content").style.display = "none";
    return;
  }
  document.getElementById("stko-no-data").style.display  = "none";
  document.getElementById("stko-content").style.display  = "block";

  const searchEl     = document.getElementById("stko-search");
  const typeEl       = document.getElementById("stko-type");

  const searchQ    = searchEl ? searchEl.value.trim() : "";
  const typeVal    = typeEl   ? typeEl.value.trim()   : "";

  const snapshot = buildStockoutSnapshot(typeVal, searchQ);

  const screenedCount = snapshot.length;
  const atRiskRows     = snapshot.filter(r => r.atRisk);                // MOS < 3 (out + high combined)
  const outRows        = snapshot.filter(r => r.status === "out");       // MOS < 1
  const highRows       = snapshot.filter(r => r.status === "high");      // 1 ≤ MOS < 3
  const mediumRows     = snapshot.filter(r => r.status === "medium");    // 3 ≤ MOS < 6
  const optimalRows    = snapshot.filter(r => r.status === "optimal");   // 6 ≤ MOS < 12
  const overstockRows  = snapshot.filter(r => r.status === "overstock"); // MOS ≥ 12
  const exprAdjRows    = snapshot.filter(r => r.exprAdjustedRisk);       // looks safe today, but not once near-expiry stock excluded

  // ── Per-type breakdown (ZME / ZMS / ZLC), split by status ──────────────────
  const countByType = {
    ZME: { out: 0, high: 0 },
    ZMS: { out: 0, high: 0 },
    ZLC: { out: 0, high: 0 },
  };
  atRiskRows.forEach(r => {
    const t = countByType[r.type];
    if (!t) return;
    if (r.status === "out") t.out++;
    else if (r.status === "high") t.high++;
  });
  const totalByType = {
    ZME: countByType.ZME.out + countByType.ZME.high,
    ZMS: countByType.ZMS.out + countByType.ZMS.high,
    ZLC: countByType.ZLC.out + countByType.ZLC.high,
  };
  const TYPE_LABELS = { ZME: "Medicines", ZMS: "Medical Supplies", ZLC: "ZLC" };
  const typeSub = (t) => `${TYPE_LABELS[t]} · ${countByType[t].out.toLocaleString()} stockout · ${countByType[t].high.toLocaleString()} high risk`;

  // ── KPIs ──────────────────────────────────────────────────────────────────
  stkoKpiRow([
    stkoKpiCard("Materials Screened", screenedCount.toLocaleString(), "ZME · ZMS · ZLC · National MOS only", "blue", "all"),
    stkoKpiCard(`Stockout (<${STOCKOUT_OUT_THRESHOLD}mo)`, outRows.length.toLocaleString(), "Needs emergency action now", "red", "out"),
    stkoKpiCard(`High Risk (${STOCKOUT_OUT_THRESHOLD}–${STOCKOUT_HIGH_THRESHOLD}mo)`, highRows.length.toLocaleString(), "Window to act before it runs out", "red", "high"),
    stkoKpiCard(`Medium Risk (${STOCKOUT_HIGH_THRESHOLD}–${STOCKOUT_MEDIUM_THRESHOLD}mo)`, mediumRows.length.toLocaleString(), "Worth monitoring", "amber", "medium"),
    stkoKpiCard(`Optimal (${STOCKOUT_MEDIUM_THRESHOLD}–${STOCKOUT_OPTIMAL_THRESHOLD}mo)`, optimalRows.length.toLocaleString(), "Healthy coverage band", "green", "optimal"),
    stkoKpiCard(`Overstock (≥${STOCKOUT_OPTIMAL_THRESHOLD}mo)`, overstockRows.length.toLocaleString(), "More than a year of cover on hand", "blue", "overstock"),
    stkoKpiCard("ZME Flagged", totalByType.ZME.toLocaleString(), typeSub("ZME"), "amber", "ZME"),
    stkoKpiCard("ZMS Flagged", totalByType.ZMS.toLocaleString(), typeSub("ZMS"), "purple", "ZMS"),
    stkoKpiCard("ZLC Flagged", totalByType.ZLC.toLocaleString(), typeSub("ZLC"), "blue", "ZLC"),
    stkoKpiCard("⚠ Expiry-Adjusted Risk", exprAdjRows.length.toLocaleString(), `Would drop a band once stock expiring within ${STOCKOUT_OPTIMAL_THRESHOLD}mo is excluded`, "amber", "exprAdj"),
  ]);

  // ── TABLE ──────────────────────────────────────────────────────────────────
  // No more "At-risk only" / "Expiry-Adjusted Risk" checkboxes — the table
  // always starts from the full snapshot. Narrowing now happens only via the
  // KPI-card filter below (click a card to scope the table to it).
  const baseRows = snapshot;

  // ── Apply the active KPI-card filter (if any) on top of the above ──────────
  // "all" (Materials Screened) always resets to the full snapshot.
  let cardFilteredRows = baseRows;
  let cardFilterLabel = null;
  if (stkoCardFilter === "all") {
    cardFilteredRows = snapshot;
  } else if (stkoCardFilter === "out") {
    cardFilteredRows = outRows;
    cardFilterLabel = `Stockout (<${STOCKOUT_OUT_THRESHOLD}mo)`;
  } else if (stkoCardFilter === "high") {
    cardFilteredRows = highRows;
    cardFilterLabel = `High Risk (${STOCKOUT_OUT_THRESHOLD}–${STOCKOUT_HIGH_THRESHOLD}mo)`;
  } else if (stkoCardFilter === "medium") {
    cardFilteredRows = mediumRows;
    cardFilterLabel = `Medium Risk (${STOCKOUT_HIGH_THRESHOLD}–${STOCKOUT_MEDIUM_THRESHOLD}mo)`;
  } else if (stkoCardFilter === "optimal") {
    cardFilteredRows = optimalRows;
    cardFilterLabel = `Optimal (${STOCKOUT_MEDIUM_THRESHOLD}–${STOCKOUT_OPTIMAL_THRESHOLD}mo)`;
  } else if (stkoCardFilter === "overstock") {
    cardFilteredRows = overstockRows;
    cardFilterLabel = `Overstock (≥${STOCKOUT_OPTIMAL_THRESHOLD}mo)`;
  } else if (stkoCardFilter === "ZME" || stkoCardFilter === "ZMS" || stkoCardFilter === "ZLC") {
    cardFilteredRows = atRiskRows.filter(r => r.type === stkoCardFilter);
    cardFilterLabel = `${stkoCardFilter} Flagged (stockout + high risk)`;
  } else if (stkoCardFilter === "exprAdj") {
    cardFilteredRows = exprAdjRows;
    cardFilterLabel = "Expiry-Adjusted Risk";
  }

  const tableRows = cardFilteredRows.slice().sort((a, b) => (a.desc || "").localeCompare(b.desc || "")); // alphabetical by description, default

  const cardFilterBanner = document.getElementById("stko-card-filter-banner");
  if (cardFilterBanner) {
    cardFilterBanner.innerHTML = cardFilterLabel
      ? `<div class="alert-info" style="margin:0 0 0.5rem;display:flex;align-items:center;justify-content:space-between;gap:0.6rem">
           <span>Showing <b>${tableRows.length.toLocaleString()}</b> item${tableRows.length === 1 ? "" : "s"} for: <b>${escHtml(cardFilterLabel)}</b></span>
           <button type="button" id="stko-clear-card-filter" class="apply-btn secondary small" style="padding:0.2rem 0.6rem">✕ Clear</button>
         </div>`
      : "";
  }

  const cols = [
    { key: "code", label: "Material Code",
      fmt: (v, r) => r.isMerged
        ? `<span class="col-mat-code mat-code-clickable" data-drill-mat="${escHtml(v)}" title="Click to see Stock Concentration for this material">${escHtml(v)}</span><span class="mat-mapped-badge" title="Merged from: ${escHtml(r.origCodes)}">MERGED</span>`
        : `<span class="col-mat-code mat-code-clickable" data-drill-mat="${escHtml(v)}" title="Click to see Stock Concentration for this material">${escHtml(v)}</span>`,
      raw: true, cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "type", label: "Type" },
    { key: "totalSoh", label: "National SOH", fmt: fmtQty },
    { key: "totalAmc", label: "National AMC", fmt: fmtQty },
    { key: "mos", label: "National MOS",
      fmt: (v, r) => `<span style="${stkoMosCellStyle(r.status)}">${fmtMosVal(v)}</span>`, raw: true },
    { key: "adjustedMos", label: "Expiry-Adjusted MOS",
      fmt: (v, r) => stkoExprAdjCell(r), raw: true },
    { key: "exprAdjustedRisk", label: "Expiry Driver",
      fmt: (v, r) => stkoExpiryDriverCell(r), raw: true },
    { key: "nearestExpiry", label: "Nearest Expiry",
      fmt: (v, r) => stkoNearestExpiryCell(r), raw: true },
    { key: "expiringQty", label: "Expiring Qty (0–3 / 3–6 / 6–12mo)",
      fmt: (v, r) => stkoExpiringTierCell(r), raw: true },
    { key: "status", label: "Status", fmt: (v) => stkoStatusBadge(v), raw: true },
    { key: "exprAdjustedStatus", label: "Expiry-Adjusted Status",
      fmt: (v, r) => stkoExprAdjStatusCell(r), raw: true },
  ];

  const stkoRowClass = (row) => {
    if (row.status === "out") return "row-stocked-out";
    if (row.status === "high") return "row-critical";
    if (row.exprAdjustedRisk) return "row-expiry-adjusted";
    if (row.status === "overstock") return "row-overstock";
    return "";
  };
  document.getElementById("stko-table").innerHTML = tableRows.length
    ? stkoBuildFreezeTable(tableRows, cols, stkoRowClass)
    : '<div class="alert-info" style="margin:0.5rem 0">✓ No materials match the current filters at national stockout risk.</div>';
  if (tableRows.length) wireStkoFreezeToggle();

  // ── EXPORT ────────────────────────────────────────────────────────────────
  // Export columns mirror the on-screen `cols` above. The on-screen cell
  // packs the adjusted MOS value + its classified band into one cell
  // (stkoExprAdjCell); the export keeps them as two plain columns instead,
  // since the export helper's fmt callback only ever receives the raw cell
  // value here (not the row), matching this file's existing export pattern.
  const exportCols = [
    { key: "code", label: "Material Code" },
    { key: "desc", label: "Description" },
    { key: "type", label: "Type" },
    { key: "totalSoh", label: "National SOH", fmt: v => Number(v || 0).toFixed(2) },
    { key: "totalAmc", label: "National AMC", fmt: v => Number(v || 0).toFixed(2) },
    { key: "mos", label: "National MOS", fmt: v => Number(v).toFixed(2) },
    { key: "adjustedMos", label: "Expiry-Adjusted MOS", fmt: v => v === null ? "" : Number(v).toFixed(2) },
    { key: "expiryDriverLabel", label: "Expiry Driver" },
    { key: "exprAdjustedRisk", label: "Expiry Driver Changes Status?", fmt: v => v ? "Yes" : "No" },
    { key: "nearestExpiry", label: "Nearest Expiry Date", fmt: v => v ? stkoFmtDate(v) : "" },
    { key: "expiringQty_0_3mo", label: `Expiring Qty (0-${STOCKOUT_HIGH_THRESHOLD}mo)`, fmt: v => Number(v || 0).toFixed(2) },
    { key: "expiringQty_3_6mo", label: `Expiring Qty (${STOCKOUT_HIGH_THRESHOLD}-${STOCKOUT_MEDIUM_THRESHOLD}mo)`, fmt: v => Number(v || 0).toFixed(2) },
    { key: "expiringQty_6_12mo", label: `Expiring Qty (${STOCKOUT_MEDIUM_THRESHOLD}-${STOCKOUT_OPTIMAL_THRESHOLD}mo)`, fmt: v => Number(v || 0).toFixed(2) },
    { key: "status", label: "Status", fmt: v => stkoStatusLabel(v) },
    { key: "exprAdjustedStatus", label: "Expiry-Adjusted Status", fmt: v => v === null ? "" : stkoStatusLabel(v) },
  ];

  const dlRow = document.getElementById("stko-dl-row");
  if (dlRow) {
    dlRow.innerHTML = '<button class="dl-btn">⬇ CSV</button><button class="dl-btn">⬇ Excel</button>';
    dlRow.querySelectorAll(".dl-btn")[0].onclick = () => downloadCSV(tableRows,   exportCols, "national_stockout_risk.csv");
    dlRow.querySelectorAll(".dl-btn")[1].onclick = () => downloadExcel(tableRows, exportCols, "national_stockout_risk.xlsx");
  }
}

// ── MATERIAL CODE SEARCH SUGGESTIONS ────────────────────────────────────────
// Lightweight autocomplete dropdown for #stko-search, styled to match the
// existing "Who's Responsible?" search (reuses its who-resp-* CSS classes —
// see index.html). Self-contained: does not depend on who-responsible.js,
// so it works even if that page/module isn't loaded.
let stkoSuggestActiveIdx = -1;
let stkoSuggestItems = [];

// Suggestion source respects the page's fixed type scope (ZME/ZMS/ZLC only),
// same as the table itself — no point suggesting a code you can't see here.
function stkoSuggestionSource() {
  if (typeof mosMerged === "undefined" || !mosMerged.length) return [];
  const seen = new Set();
  const out = [];
  for (const r of mosMerged) {
    if (!STOCKOUT_ALLOWED_TYPES.has(r.type)) continue;
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    out.push({ code: r.code, desc: r.desc || "", type: r.type });
  }
  return out;
}

function stkoHighlight(text, q) {
  const s = String(text || "");
  if (!q) return escHtml(s);
  const idx = s.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return escHtml(s);
  return escHtml(s.slice(0, idx)) + "<mark>" + escHtml(s.slice(idx, idx + q.length)) + "</mark>" + escHtml(s.slice(idx + q.length));
}

// Suggestions box is position:fixed (see CSS), so it needs manual placement
// under the input, re-run on open/scroll/resize.
function stkoPositionSuggestions(input, box) {
  const rect = input.getBoundingClientRect();
  box.style.left  = rect.left + "px";
  box.style.top   = (rect.bottom + 4) + "px";
  box.style.width = rect.width + "px";
}

function stkoCloseSuggestions() {
  const box = document.getElementById("stko-search-suggestions");
  if (box) { box.classList.remove("open"); box.innerHTML = ""; }
  stkoSuggestActiveIdx = -1;
  stkoSuggestItems = [];
}

function stkoRenderSuggestions(query) {
  const input = document.getElementById("stko-search");
  const box   = document.getElementById("stko-search-suggestions");
  if (!input || !box) return;

  const q = query.trim();
  if (!q) { stkoCloseSuggestions(); return; }

  const ql = q.toLowerCase();
  const matches = stkoSuggestionSource().filter(m =>
    m.code.toLowerCase().includes(ql) || m.desc.toLowerCase().includes(ql)
  );
  // Codes starting with the query rank first, then description matches, each alphabetical.
  matches.sort((a, b) => {
    const aStarts = a.code.toLowerCase().startsWith(ql) ? 0 : 1;
    const bStarts = b.code.toLowerCase().startsWith(ql) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.code.localeCompare(b.code);
  });

  stkoSuggestItems = matches.slice(0, 25);
  stkoSuggestActiveIdx = -1;

  box.innerHTML = stkoSuggestItems.length
    ? stkoSuggestItems.map((m, i) =>
        `<div class="who-resp-item" data-idx="${i}">
           <div class="who-resp-item-code">${stkoHighlight(m.code, q)}</div>
           <div class="who-resp-item-desc">${stkoHighlight(m.desc, q)} · ${escHtml(m.type)}</div>
         </div>`
      ).join("")
    : '<div class="who-resp-empty">No matching materials</div>';

  stkoPositionSuggestions(input, box);
  box.classList.add("open");
}

function stkoSelectSuggestion(idx) {
  const item = stkoSuggestItems[idx];
  if (!item) return;
  const input = document.getElementById("stko-search");
  if (input) input.value = item.code;
  stkoCloseSuggestions();
  renderStockoutRisk();
}

function stkoSetActiveSuggestion(idx) {
  const box = document.getElementById("stko-search-suggestions");
  if (!box) return;
  const items = box.querySelectorAll(".who-resp-item");
  items.forEach(el => el.classList.remove("who-resp-active"));
  if (idx >= 0 && items[idx]) {
    items[idx].classList.add("who-resp-active");
    items[idx].scrollIntoView({ block: "nearest" });
  }
  stkoSuggestActiveIdx = idx;
}

// ── WIRE INTO PAGE_RENDERERS AND EVENT LISTENERS ──────────────────────────────
(function wireStockoutRiskModule() {
  function extend() {
    if (typeof PAGE_RENDERERS !== "undefined") {
      PAGE_RENDERERS["stockout-risk"] = renderStockoutRisk;
    }

    const _origRenderPage = window.renderPage;
    window.renderPage = function (id) {
      if (id === "stockout-risk") {
        currentPage = id;
        document.getElementById("landingView").style.display = "none";
        document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
        const pg = document.getElementById("page-stockout-risk");
        if (pg) pg.style.display = "block";
        document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
        try { renderStockoutRisk(); } catch (e) { console.error(e); }
        return;
      }
      _origRenderPage(id);
    };

    const filterMap = {
      "stko-apply": renderStockoutRisk,
      "stko-clear": () => {
        const s = document.getElementById("stko-search");            if (s) s.value = "";
        const t = document.getElementById("stko-type");              if (t) t.value = "";
        stkoCardFilter = null;
        renderStockoutRisk();
      },
    };

    document.body.addEventListener("click", (e) => {
      const btn = e.target.closest("button[id]");
      if (!btn) return;
      const fn = filterMap[btn.id];
      if (fn) { e.stopPropagation(); fn(); }
    }, true);

    // ── Click on a Stockout Risk KPI card → filter the table to those items ──
    // Clicking the already-active card (or its "✕ Clear" banner button) resets
    // the filter back to the normal search/type/checkbox view.
    function applyStkoCardFilter(el) {
      const key = el.dataset.stkoFilter;
      if (!key) return;
      stkoCardFilter = (stkoCardFilter === key) ? null : key;
      renderStockoutRisk();
      const table = document.getElementById("stko-table");
      if (table) table.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    document.body.addEventListener("click", (e) => {
      if (e.target.closest("#stko-clear-card-filter")) {
        stkoCardFilter = null;
        renderStockoutRisk();
        return;
      }
      const card = e.target.closest("#stko-kpis [data-stko-filter]");
      if (card) applyStkoCardFilter(card);
    });
    document.body.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest("#stko-kpis [data-stko-filter]");
      if (card) { e.preventDefault(); applyStkoCardFilter(card); }
    });

    // Material code search: autocomplete suggestions + Enter-to-apply
    const searchInput = document.getElementById("stko-search");
    const suggestBox  = document.getElementById("stko-search-suggestions");
    if (searchInput) {
      searchInput.addEventListener("input", () => stkoRenderSuggestions(searchInput.value));
      searchInput.addEventListener("focus", () => { if (searchInput.value.trim()) stkoRenderSuggestions(searchInput.value); });
      searchInput.addEventListener("keydown", (e) => {
        const open = !!(suggestBox && suggestBox.classList.contains("open") && stkoSuggestItems.length);
        if (e.key === "ArrowDown" && open) {
          e.preventDefault();
          stkoSetActiveSuggestion(Math.min(stkoSuggestActiveIdx + 1, stkoSuggestItems.length - 1));
        } else if (e.key === "ArrowUp" && open) {
          e.preventDefault();
          stkoSetActiveSuggestion(Math.max(stkoSuggestActiveIdx - 1, 0));
        } else if (e.key === "Enter") {
          if (open && stkoSuggestActiveIdx >= 0) {
            e.preventDefault();
            stkoSelectSuggestion(stkoSuggestActiveIdx);
          } else {
            stkoCloseSuggestions();
            renderStockoutRisk();
          }
        } else if (e.key === "Escape" && open) {
          stkoCloseSuggestions();
        }
      });
    }
    if (suggestBox) {
      suggestBox.addEventListener("click", (e) => {
        const item = e.target.closest(".who-resp-item[data-idx]");
        if (item) stkoSelectSuggestion(Number(item.dataset.idx));
      });
    }
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".stko-search-wrap")) stkoCloseSuggestions();
    });
    window.addEventListener("resize", () => {
      if (suggestBox && suggestBox.classList.contains("open") && searchInput) stkoPositionSuggestions(searchInput, suggestBox);
    });
    window.addEventListener("scroll", () => {
      if (suggestBox && suggestBox.classList.contains("open") && searchInput) stkoPositionSuggestions(searchInput, suggestBox);
    }, true);

    // Re-render if currently on this page and either source file changes
    const fileInput  = document.getElementById("fileInput");
    const mosAmcInput = document.getElementById("mosAmcFileInput");
    [fileInput, mosAmcInput].forEach(inp => {
      if (!inp) return;
      inp.addEventListener("change", () => {
        setTimeout(() => { if (currentPage === "stockout-risk") renderStockoutRisk(); }, 350);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", extend);
  } else {
    extend();
  }
})();
