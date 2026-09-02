// =============================================================================
// PharmaTrack v2 — request-analysis.js
// "🧾 Request Analysis" — self-serve sidebar tool. Any user (not just admins)
// uploads their OWN Transfer Requests Excel (Purchase Req Num, Poste, Material,
// Short Text, Requested Quantity, Stock on hand, Delivery date, Created By,
// Location, Plant) and instantly sees it reconciled against the currently-loaded
// HO01 (hub) stock. Nothing is saved to a shared database — the uploaded file
// lives only in this browser tab's memory, exactly like the person who
// uploaded it intended.
//
// STORAGE-LOCATION (COLD vs NON-COLD) MISMATCH CHECK
// ----------------------------------------------------
// The request file's "Location" column is the REQUESTING PLANT'S OWN
// storage-location code (e.g. "DEC1" = DE01's cold storage, "DEM1" = DE01's
// non-cold storage) — NOT an HO01 code. The rule: the temperature zone
// (cold vs non-cold) that Location belongs to at the requesting plant must
// match the temperature zone of wherever this material actually sits at
// HO01 right now:
//   - Plant requests to a COLD location → material MUST be stored at one of
//     HO01's cold locations (HOM3/HOM8/HOM9) and NOWHERE else at HO01.
//   - Plant requests to a NON-COLD location → material MUST be stored at a
//     non-cold HO01 location and NOT at any of HOM3/HOM8/HOM9.
//   - A material split across both a cold AND a non-cold location at HO01
//     at once is flagged either way — mixed storage is itself a problem.
// Each plant's cold-storage code(s) come from PLANT_COLD_STORAGE_LOCATIONS,
// a hand-maintained constant sourced from a one-off plant/storage-location
// reference list (storage.xlsx) — any OTHER code a plant uses is treated as
// non-cold. HO01's cold codes are HO01_COLD_LOCATIONS (HOM3/HOM8/HOM9).
// Where the material sits at HO01 is read live from the main inventory
// data's "Storage Location" column (any row, regardless of current stock
// qty — presence of the location is what counts, not live quantity).
// See classifyStorageMismatch() and buildHo01StorageLocationMap() below.
// If a request line has no Location, its Plant isn't in
// PLANT_COLD_STORAGE_LOCATIONS, or HO01 has no Storage Location data at all
// for that material, the check is inconclusive ("unknown") and NOT flagged
// as a mismatch.
//
// PLANT SCOPING
// -------------
// The uploaded file is always for ONE requesting plant at a time (a branch
// pasting its own transfer requests). The "Plant" column is used to:
//   1. Label the analysis ("Requesting Plant: GO01") for clarity.
//   2. Scope Tab 4 ("HO01 Stock Not Requested") criticality so it only flags
//      HO01 stock as critical when it's THIS branch (not some other branch)
//      that's running low — otherwise it would surface items that are fine
//      for the branch that actually uploaded the file.
// If a file somehow contains more than one distinct Plant value, the most
// frequent one is used for scoping and a warning is shown.
// "Created By" is carried through purely for visibility (shown as a column
// in the main Request vs Stock table) — it has no effect on the analysis.
//
// REQUEST TYPE SCOPING (RDF vs PROGRAM/Q)
// -----------------------------------------
// Every material can carry an RDF record, a Program(Q) record, or both (see
// PURCH-ORG-CHECK below). Per request line, the stream is resolved from
// that line's own "Purchasing Org." column: RD01 = RDF, HP02 = Program.
// This governs Tabs 1–3 and Tab 5, all of which are built per request line.
// Tab 4 ("HO01 Stock Not Requested") has no request line of its own to read
// a Purchasing Org. from — by definition, these are materials that never
// appear in the file at all. It's instead scoped by a single file-level
// Request Type, derived the same way reqPlant is: the most frequent
// resolvable Purchasing Org. family across every row in the file (majority
// RD01 -> RDF file, majority HP02 -> Program file; a warning is shown if
// both appear roughly evenly). Only HO01 stock carrying a record in that
// same stream is shown in Tab 4. If the file has no usable Purchasing Org.
// data at all, this is inconclusive and Tab 4 is left unscoped (unchanged
// from prior behavior).
//
// WHAT THIS ANALYSIS SHOWS
// -------------------------
// 1. Request vs Stock (side-by-side) — every request line, with the request
//    file's OWN "Stock on hand" column shown next to a LIVE recomputed HO01
//    stock figure (from the currently loaded main inventory), so any mismatch
//    between what the requester's system said and what HO01 actually has
//    right now is visible at a glance.
// 2. Suggested Code Corrections — request lines whose canonical material has
//    live stock at HO01, but NOT (only) under the exact code the requester
//    typed. The mapping file's target/"standard" code is used ONLY to figure
//    out which raw SAP codes belong to the same material — it is never
//    itself the suggestion, because it may not be a real, orderable SAP code
//    with its own stock record. The suggestion is always the actual raw SAP
//    code(s) that currently carry stock at HO01 for that material, each with
//    its own live quantity (in that code's own native unit, exactly as SAP
//    shows it — NOT the standardized/converted number used for totals). If
//    more than one raw code carries stock, ALL of them are surfaced together
//    (e.g. "115-ZOLE-0301-01 (120) or 115-ZOLE-0301-02 (15)") so a requester
//    isn't steered toward a nearly-empty code when a fuller one exists.
// 3. HO01 Stockout but Requested — request lines whose resolved material has
//    ZERO stock at HO01 right now.
// 4. HO01 Stock Not Requested — every material with stock at HO01 that does
//    NOT appear anywhere in the uploaded request file at all, scoped to the
//    file's own Request Type (RDF vs Program) — see REQUEST TYPE SCOPING
//    above.
// 5. MOS Evaluation (2–4 Month Window) — judges the REQUESTED QUANTITY on
//    each line against the same TARGET_MOS(4)/REQUEST_ELIGIBILITY_MOS(2)
//    fill window Branch Demand uses (branch-demand.js), using the
//    requesting plant's own live SOH + AMC, netted against anything already
//    in transit to it (Open Outbound / pending-dispatch.js). Every line is
//    tagged "Justified" (lands within the 2–4 month window), "Over-
//    Requested" (would push the branch above 4 months), "Under-Requested"
//    (still leaves the branch short of 4 months — flagged more strongly if
//    still below 2 after the request), "Not Eligible — Overstocked" (branch
//    is already at/above 4 months; shouldn't have requested at all), or
//    "No AMC Data" (no basis to judge — AMC file not loaded or this
//    material/branch has no commitment on file). See classifyMosVerdict().
//
// MATERIAL CODE MATCHING
// -----------------------
// Request file material codes (e.g. "115-ZOLE-0301-01") are NOT SAP codes.
// We resolve them the same way the rest of the app reconciles codes: via the
// existing Material Standardization mapping table (mappingTable, loaded via
// the sidebar's "⚗️ Material Standardization" upload). If a mapping entry
// exists, its target code identifies which OTHER raw SAP codes are the same
// material (for grouping/aggregation only — see point 2 above). If no
// mapping entry exists, we fall back to trying the raw code as-is (covers
// cases where a request already used the real SAP code).
//
// TOTALS VS. SUGGESTIONS — two different quantities, on purpose
// ----------------------------------------------------------------
// - "Live HO01 stock" for status/totals (Tab 1, Tab 3, Tab 4, KPIs) is always
//   the STANDARDIZED total across every raw code that maps to the canonical
//   material (sohMap from buildMosSohMap(), same converted numbers the rest
//   of the app uses) — this answers "is there stock, in total, right now."
// - "Suggested code" quantities (Tab 2) are the RAW, unconverted stock under
//   each individual SAP code (Unrestricted + verified Transit + QC, in that
//   code's own unit) — this answers "which exact code do I type into SAP,
//   and how much is really under it." Only codes with a live inventory row
//   and stock > 0 are ever suggested — nothing from the mapping table alone.
//
// Requires: script.js (rawDf, mappingTable, escHtml, fmtQty, kpiCard, buildTable,
//           wireTableExport, downloadCSV, downloadExcel, parseExpiryDate,
//           fmtLocalDate, getReconciledBase, PAGE_RENDERERS, renderPage, currentPage,
//           buildMultiSelect)
//           mos.js (HUB_PLANT, buildMosSohMap, mosMerged, fmtMosVal, mosNABadge)
//           branch-demand.js (TARGET_MOS, REQUEST_ELIGIBILITY_MOS — Tab 5 falls
//           back to literal 4/2 if unavailable, see REQAN_TARGET_MOS below)
//           pending-dispatch.js (getOpenOutboundRowsNational / getOpenOutboundRows
//           — Tab 5 degrades to "no outbound data" if neither is available)
// Must be loaded AFTER script.js, mos.js, branch-demand.js, and pending-dispatch.js.
// =============================================================================

(function requestAnalysisModule() {

  // ── STATE ──────────────────────────────────────────────────────────────────
  // Lives only in memory for this browser tab/session — never written to any
  // shared store. Re-uploading replaces it; closing the tab discards it.
  let reqRows   = [];   // parsed request lines
  let reqFileName = "";
  let reqPlant  = "";   // the (single) requesting plant this file is for
  let reqPlantMismatch = false; // true if the file had more than one distinct Plant value

  // REQUEST-TYPE-SCOPE: the file-level Request Type ("RDF" or "PROGRAM"),
  // derived the same way reqPlant is — from the most frequent resolvable
  // Purchasing Org. family (RD01 -> RDF, HP02 -> PROGRAM) across every row
  // in the uploaded file. Rows with no Purchasing Org., or an org other
  // than RD01/HP02, don't count toward this. Stays "" (inconclusive) when
  // the file has no usable Purchasing Org. data at all — in that case
  // nothing is scoped by request type and behavior is unchanged.
  // Used to scope Tab 4 ("HO01 Stock Not Requested"), since those rows have
  // no request line / Purchasing Org. of their own to read a stream from.
  let reqRequestType = "";
  let reqRequestTypeMismatch = false; // true if RD01 and HP02 both appear, roughly evenly

  // Material Type filter (e.g. ZME, ZMS…) — multi-select. Empty set = no
  // filter applied (show everything). Populated from the "Material Type"
  // column on the main inventory data (rawDf), keyed by canonical code, and
  // applies across all 4 tabs.
  let reqMatTypeFilter = new Set();

  // Material Group filter — same pattern as Material Type above, but sourced
  // from the literal "Material Group Name" column on the main inventory data
  // (rawDf), not a helper function. Multi-select; empty set = no filter.
  let reqMatGroupFilter = new Set();

  // FEAT-COPY-CODES: click-to-select on the "Requested Code" cells in Tab 1
  // (Request vs Stock table) so users can grab several material codes at
  // once without click-dragging across the whole table (which also grabs
  // Description/Qty/SOH text from other columns). Selecting persists across
  // re-renders (filter changes, etc.) by code value, not DOM node.
  let reqCodeCopySelection = new Set();


  const REQUIRED_COLS = [
    "Purchase Req Num", "Poste", "Material", "Short Text",
    "Requested Quantity", "Stock on hand", "Delivery date",
    "Created By", "Plant", "Location",
  ];

  // ── MOS EVALUATION (2–4 MONTH WINDOW) ───────────────────────────────────────
  // TAB 5 — evaluates every request line against the SAME target-fill window
  // Branch Demand uses (see branch-demand.js: TARGET_MOS=4, REQUEST_ELIGIBILITY_
  // MOS=2), so a request can be reconciled not just against "does HO01 have
  // stock" (Tabs 1/3) but against "SHOULD this branch be requesting this much,
  // right now, given its own current stock + AMC + anything already in
  // transit." Falls back to these literal values if branch-demand.js hasn't
  // loaded yet (script.js load order should prevent that in practice — see
  // file header — but this keeps the tab from throwing rather than degrading
  // silently to wrong numbers).
  const REQAN_TARGET_MOS      = (typeof TARGET_MOS !== "undefined") ? TARGET_MOS : 4;
  const REQAN_ELIGIBILITY_MOS = (typeof REQUEST_ELIGIBILITY_MOS !== "undefined") ? REQUEST_ELIGIBILITY_MOS : 2;

  // Open Outbound already committed to THIS requesting plant, keyed by
  // canonical code — mirrors brdBuildOpenOutboundMap() in branch-demand.js
  // (same source data, same national/unscoped read via
  // getOpenOutboundRowsNational so the number doesn't depend on who's
  // logged in), just narrowed to byPlant only since HO01's own available
  // pool isn't this tab's concern (Tabs 1/3 already show live HO01 SOH).
  function buildReqOpenOutboundMap() {
    const byPlant = new Map();
    const getRows = (typeof window.getOpenOutboundRowsNational === "function")
      ? window.getOpenOutboundRowsNational
      : window.getOpenOutboundRows;
    if (typeof getRows !== "function") return byPlant;
    let rowsOut;
    try { rowsOut = getRows(); } catch (e) { return byPlant; }
    if (!Array.isArray(rowsOut) || !rowsOut.length) return byPlant;
    rowsOut.forEach(r => {
      const plant = String(r.shipToParty || "").trim().slice(0, 4).toUpperCase();
      let code = String(r.material || "").trim().toUpperCase();
      if (!code || !plant) return;
      if (typeof mappingTable !== "undefined" && mappingTable.size > 0) {
        const entry = mappingTable.get(code);
        if (entry) code = entry.targetCode;
      }
      const qty = Number(r.qty) || 0;
      const key = `${plant}::${code}`;
      byPlant.set(key, (byPlant.get(key) || 0) + qty);
    });
    return byPlant;
  }

  // mosMerged (mos.js) can carry TWO rows for the same code — one per stream
  // (RDF / Q) — when a material is committed under both (see mos.js file
  // header, "Important Business Rule"). Pick the row matching this request
  // line's own funding family when we can tell; otherwise fall back to
  // whichever single row exists.
  function findAmcRowForCanonical(canonical, familyHint, reqPlantCode) {
    if (!canonical || typeof mosMerged === "undefined" || !mosMerged.length) return null;
    const candidates = mosMerged.filter(m => m.code === canonical);
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    const wantType = familyHint === "PROGRAM" ? "Q" : (familyHint === "RDF" ? "RDF" : null);
    if (wantType) {
      const match = candidates.find(m => m.type === wantType);
      if (match) return match;
    }
    // UNRESOLVED-STREAM-AMC-FALLBACK: we couldn't tell which stream this
    // request line belongs to (blank/invalid Purchasing Org. on a
    // dual-stream material — RDF AND Program both have a record for this
    // code). Blindly picking candidates[0] here used to silently report
    // "No AMC Data" whenever the AMC commitment for this branch actually
    // lived on the OTHER stream, even though the branch genuinely has an
    // AMC on file. Instead, prefer whichever stream actually carries a
    // real (non-null) AMC value for the requesting plant; only fall back
    // to candidates[0] when neither stream (or both, ambiguously) do.
    if (reqPlantCode) {
      const withAmc = candidates.filter(m => m.amcs && m.amcs[reqPlantCode] !== null && m.amcs[reqPlantCode] !== undefined);
      if (withAmc.length === 1) return withAmc[0];
    }
    return candidates[0];
  }

  // Classifies one request line's quantity against the 2–4 month window.
  //   "no-amc"      — branch has no AMC commitment for this material at all;
  //                    there's no basis to judge the request either way.
  //   "overstocked" — branch's CURRENT MOS is already >= TARGET_MOS (4); this
  //                    material shouldn't have been requested at all.
  //   "over"        — requested qty exceeds target need by more than
  //                    tolerance; would push the branch above 4 months.
  //   "under"       — requested qty falls short of target need by more than
  //                    tolerance; branch will still be below 4 months (and
  //                    flagged more strongly if still below 2 after this
  //                    request goes through).
  //   "justified"   — requested qty lands within tolerance of target need —
  //                    brings the branch to (approximately) the 4-month
  //                    target without overshooting.
  //   "constrained" — shown as "Priority-Blocked — HO01 Allocates 0 of X" (or
  //                    "Priority-Limited — HO01 Allocates Y of X"). FULL-
  //                    ALIGN-BRD: the requested qty is CORRECTLY sized
  //                    for the branch's own need (i.e. would otherwise be
  //                    "justified" or "under"), but Branch Demand's own
  //                    priority-tier allocation (brdComputeMaterialAllocation,
  //                    called with identical inputs — see brdAllocAvailable
  //                    above) shows HO01 cannot actually supply that much
  //                    once every other branch's competing need for this
  //                    material is served in priority order first. Replaces
  //                    what would otherwise show as a plain "Justified" or
  //                    "Under-Requested" verdict whenever the two tabs would
  //                    disagree, so this tab can never show a line as fully
  //                    fine when Branch Demand would actually give it 0 or a
  //                    partial amount.
  // Tolerance is 10% of target need (min 1 unit) so rounding in the
  // requester's own math doesn't get flagged as a false positive.
  function classifyMosVerdict({ hasAmc, mosNow, targetNeed, reqQty, projectedMos, outboundToBranch, allocInfo }) {
    const fmtMos = v => (v === null || v === undefined) ? "—" : (v === Infinity ? "∞" : v.toFixed(1));
    if (!hasAmc) {
      return { key: "no-amc", label: "No AMC Data",
        detail: `No AMC commitment on file for ${reqPlant || "this branch"} — can't evaluate the ${REQAN_ELIGIBILITY_MOS}–${REQAN_TARGET_MOS} month window without it.` };
    }
    if (mosNow !== null && mosNow !== undefined && mosNow >= REQAN_TARGET_MOS) {
      return { key: "overstocked", label: "Not Eligible — Overstocked",
        detail: `${reqPlant || "This branch"} is already at ${fmtMos(mosNow)} months — at/above the ${REQAN_TARGET_MOS}-month target, this line should not have been requested.` };
    }

    // ── FULL-ALIGN-BRD: can HO01 actually supply this, given every other
    // branch's competing priority-tier need for the same material right
    // now? Checked BEFORE the sizing verdict below so a shortfall always
    // wins over "the number itself was well-chosen" — a branch doesn't
    // benefit from a mathematically correct request HO01 can't fill.
    // allocInfo is null whenever brdAllocAvailable is false (branch-demand.js
    // not loaded / no AMC file) or this branch isn't in mosPlants — in
    // either case this check is silently skipped and behavior is unchanged
    // from before FULL-ALIGN-BRD.
    if (allocInfo && reqQty > 0) {
      const tol2 = Math.max(1, reqQty * 0.05);
      const shortBy = reqQty - allocInfo.allocQty;
      if (shortBy > tol2) {
        const fullyOut = allocInfo.allocQty <= 0.0001;
        return { key: "constrained",
          label: fullyOut
            ? `Priority-Blocked — HO01 Allocates 0 of ${fmtQty(reqQty)}`
            : `Priority-Limited — HO01 Allocates ${fmtQty(allocInfo.allocQty)} of ${fmtQty(reqQty)}`,
          detail: (fullyOut
            ? `${reqPlant || "This branch"} requested ${fmtQty(reqQty)}, which matches its own AMC-based need — but HO01's priority-tier allocation gives it 0, because every unit is already committed to higher-priority branches. `
            : `${reqPlant || "This branch"} requested ${fmtQty(reqQty)}, which matches its own AMC-based need — but HO01's priority-tier allocation only grants it ${fmtQty(allocInfo.allocQty)}; the rest is already committed to higher-priority branches. `)
            + allocInfo.explanation };
      }
    }

    const tol = Math.max(1, targetNeed * 0.1);
    const diff = reqQty - targetNeed;
    if (targetNeed <= 0 && reqQty > 0) {
      return { key: "over", label: "Over-Requested",
        detail: `Target need is already 0 (current stock${outboundToBranch > 0 ? " + open outbound" : ""} already covers the ${REQAN_TARGET_MOS}-month target) — the full ${fmtQty(reqQty)} requested appears unnecessary.` };
    }
    if (diff > tol) {
      return { key: "over", label: "Over-Requested",
        detail: `Requesting ${fmtQty(reqQty)} vs a target need of ${fmtQty(targetNeed)} would push ${reqPlant || "this branch"} to ${fmtMos(projectedMos)} months — above the ${REQAN_TARGET_MOS}-month target.` };
    }
    if (diff < -tol) {
      const stillCritical = projectedMos !== null && projectedMos !== Infinity && projectedMos < REQAN_ELIGIBILITY_MOS;
      return { key: "under", label: stillCritical ? "Under-Requested — Still Critical" : "Under-Requested",
        detail: `Requesting ${fmtQty(reqQty)} vs a target need of ${fmtQty(targetNeed)} leaves ${reqPlant || "this branch"} at ${fmtMos(projectedMos)} months` +
          (stillCritical ? ` — still below the ${REQAN_ELIGIBILITY_MOS}-month floor. Consider requesting more.` : `, short of the ${REQAN_TARGET_MOS}-month target.`)
          + (allocInfo ? ` HO01 can currently supply the full amount requested (${fmtQty(allocInfo.allocQty)} available at ${reqPlant || "this branch"}'s ${allocInfo.tierLabel} priority tier), so this is purely a request-sizing issue, not a stock-availability one.` : "") };
    }
    return { key: "justified", label: "Justified",
      detail: `Requested quantity brings ${reqPlant || "this branch"} to ${fmtMos(projectedMos)} months — within the ${REQAN_ELIGIBILITY_MOS}–${REQAN_TARGET_MOS} month target window.`
        + (allocInfo ? ` HO01 can currently supply it in full (${allocInfo.tierLabel} priority tier).` : "") };
  }

  function reqMosVerdictBadge(r) {
    const M = {
      "justified":   { bg: "rgba(48,168,95,0.14)",   color: "var(--green,#30a85f)", icon: "✓" },
      "over":        { bg: "rgba(217,119,6,0.14)",   color: "var(--amber,#d97706)", icon: "⬆" },
      "under":       { bg: "rgba(37,99,235,0.14)",   color: "var(--blue)",          icon: "⬇" },
      "overstocked": { bg: "rgba(220,38,38,0.14)",   color: "var(--red)",           icon: "🚫" },
      // FULL-ALIGN-BRD: request is correctly SIZED but Branch Demand's own
      // priority allocation can't (fully) SUPPLY it right now — distinct
      // amber/red pairing from "over"/"overstocked" so it reads as a
      // stock-availability problem, not a request-quality one.
      "constrained": { bg: "rgba(220,38,38,0.14)",   color: "var(--red)",           icon: "⚖️" },
      "no-amc":      { bg: "rgba(120,120,120,0.14)", color: "var(--muted)",         icon: "❓" },
    };
    const s = M[r.mosVerdictKey] || M["no-amc"];
    return `<span style="display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:0.72rem;font-weight:700;white-space:nowrap;background:${s.bg};color:${s.color}" title="${escHtml(r.mosVerdictDetail || "")}">${s.icon} ${escHtml(r.mosVerdictLabel)}</span>`;
  }

  // ── FILE PARSING ───────────────────────────────────────────────────────────
  function loadRequestFile(file) {
    const statusEl = document.getElementById("reqan-file-status");
    const btnEl    = document.getElementById("reqan-upload-btn-text");
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;
    }

    const reader = new FileReader();
    reader.onload = e => {
      setTimeout(() => {
        try {
          if (typeof XLSX === "undefined") {
            showReqError("Excel library failed to load (network/firewall likely blocked the CDN). Please check your connection and reload the page.");
            return;
          }
          const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
          const ws   = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
          if (!data.length) { showReqError("The uploaded file contains no data."); return; }

          const trimmed = data.map(row => {
            const r = {};
            for (const [k, v] of Object.entries(row)) r[String(k).trim()] = v;
            return r;
          });

          const colMap = {};
          Object.keys(trimmed[0]).forEach(k => { colMap[k.toLowerCase()] = k; });
          const missing = REQUIRED_COLS.filter(c => !colMap[c.toLowerCase()]);
          if (missing.length) {
            showReqError(`Missing columns: ${missing.join(", ")}. Found: ${Object.keys(trimmed[0]).join(", ")}`);
            return;
          }
          const get = (row, name) => row[colMap[name.toLowerCase()]];
          // Optional columns (not in REQUIRED_COLS) — older exports won't have
          // these yet, so look them up defensively instead of via get()/colMap,
          // which assumes the column exists.
          const getOpt = (row, name) => {
            const key = colMap[name.toLowerCase()];
            return key ? row[key] : "";
          };

          const parsed = trimmed
            .map(row => ({
              prNum:    String(get(row, "Purchase Req Num") ?? "").trim(),
              poste:    String(get(row, "Poste") ?? "").trim(),
              material: String(get(row, "Material") ?? "").trim(),
              shortText:String(get(row, "Short Text") ?? "").trim(),
              reqQty:   parseFloat(get(row, "Requested Quantity")) || 0,
              reqSoh:   parseFloat(get(row, "Stock on hand")) || 0,
              deliveryDate: (typeof parseExpiryDate === "function") ? parseExpiryDate(get(row, "Delivery date")) : null,
              createdBy: String(get(row, "Created By") ?? "").trim(),
              plant:     String(get(row, "Plant") ?? "").trim().toUpperCase(),
              location:  String(get(row, "Location") ?? "").trim().toUpperCase(),
              // Optional — present on newer exports. Used only to cross-check
              // against each material's Program Classification; see
              // purchOrgFamily()/classFamily() below. Blank when absent.
              purchasingOrg: String(getOpt(row, "Purchasing Org.") ?? "").trim().toUpperCase(),
            }))
            .filter(r => r.material);

          if (!parsed.length) { showReqError("No valid rows with a Material code were found."); return; }

          // This file is expected to be from ONE requesting plant. Take the
          // most frequent Plant value as the file's plant; flag if mixed.
          const plantCounts = new Map();
          parsed.forEach(r => { if (r.plant) plantCounts.set(r.plant, (plantCounts.get(r.plant) || 0) + 1); });
          const plantEntries = [...plantCounts.entries()].sort((a, b) => b[1] - a[1]);
          reqPlant = plantEntries.length ? plantEntries[0][0] : "";
          reqPlantMismatch = plantEntries.length > 1;

          if (!reqPlant) { showReqError("No Plant value found — every row is missing a Plant."); return; }

          // REQUEST-TYPE-SCOPE: same "most frequent wins" pattern as Plant
          // above, but over the resolvable Purchasing Org. family per row
          // (RD01 -> RDF, HP02 -> PROGRAM). Rows with a blank or
          // unrecognized Purchasing Org. don't count toward either side.
          const typeCounts = new Map();
          parsed.forEach(r => {
            const fam = purchOrgFamily(r.purchasingOrg);
            if (fam) typeCounts.set(fam, (typeCounts.get(fam) || 0) + 1);
          });
          const typeEntries = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
          reqRequestType = typeEntries.length ? typeEntries[0][0] : "";
          reqRequestTypeMismatch = typeEntries.length > 1;

          reqRows = parsed;
          reqFileName = file.name;

          if (statusEl) {
            const mismatchNote = reqPlantMismatch
              ? `<div class="status-name" style="color:var(--amber,#d97706)">⚠ Multiple Plant values found — using ${escHtml(reqPlant)} (most common) for scoping</div>`
              : "";
            const typeMismatchNote = reqRequestTypeMismatch
              ? `<div class="status-name" style="color:var(--amber,#d97706)">⚠ Both RD01 (RDF) and HP02 (Program) found — using ${escHtml(reqRequestType)} (most common) to scope "HO01 Stock Not Requested"</div>`
              : "";
            const typeLabel = reqRequestType
              ? ` · Request Type ${reqRequestType === "PROGRAM" ? "Program (Q)" : "RDF"}`
              : "";
            statusEl.innerHTML =
              `<div class="status-ok">✓ FILE LOADED</div>` +
              `<div class="status-name">${escHtml(file.name)} (${parsed.length.toLocaleString()} lines) · Plant ${escHtml(reqPlant)}${typeLabel}</div>` +
              mismatchNote + typeMismatchNote;
          }
          if (btnEl) btnEl.textContent = "📥 Change Request File";

          const clearBtn = document.getElementById("reqan-clear-file");
          if (clearBtn) clearBtn.style.display = "inline-flex";

          if (typeof renderPage === "function") renderPage("request-analysis");
        } catch (err) {
          showReqError(`Could not read Excel file: ${err.message}`);
        }
      }, 30);
    };
    reader.readAsArrayBuffer(file);
  }

  function showReqError(msg) {
    const statusEl = document.getElementById("reqan-file-status");
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ ${escHtml(msg)}</div>`;
    }
  }

  function clearRequestFile() {
    reqRows = [];
    reqFileName = "";
    reqPlant = "";
    reqPlantMismatch = false;
    reqRequestType = "";
    reqRequestTypeMismatch = false;
    const statusEl = document.getElementById("reqan-file-status");
    if (statusEl) { statusEl.style.display = "none"; statusEl.innerHTML = ""; }
    const btnEl = document.getElementById("reqan-upload-btn-text");
    if (btnEl) btnEl.textContent = "📥 Upload Request Excel";
    const clearBtn = document.getElementById("reqan-clear-file");
    if (clearBtn) clearBtn.style.display = "none";
    if (typeof renderPage === "function") renderPage("request-analysis");
  }

  // ── CODE RESOLUTION ────────────────────────────────────────────────────────
  // Resolves a request line's raw material code to a canonical SAP code using
  // the existing Material Standardization mapping table. Falls back to the
  // raw code (uppercased) when no mapping entry exists, in case the request
  // already used a real SAP code.
  function resolveRequestMaterial(rawCode, purchasingOrg) {
    const raw = String(rawCode || "").trim();
    if (!raw) return { canonical: "", desc: "", viaMapping: false, raw };
    const rawUpper = raw.toUpperCase();
    if (typeof mappingTable !== "undefined" && mappingTable.has(rawUpper)) {
      const stypeMap = mappingTable.get(rawUpper);
      // STOCK-TYPE-MAP BUGFIX: mappingTable is
      // Map<sourceCode -> Map<stockType("RDF"|"Q") -> {targetCode, targetDesc, factor}>>
      // (see loadMappingFile()/applyMaterialMapping() in script.js) —
      // mappingTable.get(code) returns that INNER Map, never the entry
      // object itself. This used to read `.targetCode`/`.targetDesc`
      // straight off that inner Map, which is always undefined (a Map
      // instance has no such properties) — silently producing an
      // undefined `canonical` for EVERY request line whose typed code had
      // ANY rule in the mapping file at all (the overwhelming majority
      // once a mapping file is loaded). That cascaded into a blank
      // Material Code cell, "0 in stock", and "Branch AMC Not Committed"
      // across the page for those lines — while lines whose code had NO
      // mapping-file rule (falling through to the raw-code branch below)
      // displayed correctly, exactly the pattern reported.
      //
      // Pick the sub-entry matching this request line's own funding
      // stream (RD01 -> RDF, HP02 -> Program/Q) when we can tell;
      // otherwise, if the code only has ONE stock-type rule on file, use
      // it (nothing to disambiguate) — same convention
      // applyMaterialMapping() already uses for inventory rows.
      const family = purchOrgFamily(purchasingOrg);
      const wantType = family === "PROGRAM" ? "Q" : (family === "RDF" ? "RDF" : null);
      const entry = (wantType && stypeMap.get(wantType))
        || (stypeMap.size === 1 ? [...stypeMap.values()][0] : null);
      if (entry) {
        return { canonical: entry.targetCode, desc: entry.targetDesc || "", viaMapping: true, raw };
      }
      // Multiple stock-type rules exist but we can't tell which one this
      // line is for — don't guess; fall through and treat as the raw code.
    }
    return { canonical: raw, desc: "", viaMapping: false, raw };
  }

  // Description lookup for canonical codes, sourced from the currently loaded
  // inventory (mapping-reconciled), so materials with no mapping-file target
  // description still show something readable.
  function buildCanonicalDescMap() {
    const out = new Map();
    const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
    base.forEach(row => {
      const code = String(row._mappedMaterial || row["Material"] || "").trim();
      if (!code || out.has(code)) return;
      const desc = String(row._mappedDesc || row["Material Description"] || "").trim();
      if (desc) out.set(code, desc);
    });
    return out;
  }

  // ── HO01 STOCK BY RAW SAP CODE (for Suggested Code Corrections) ────────────
  // Returns Map<canonicalCode, Array<{code, qty}>> — for every canonical
  // material, the individual raw SAP codes that currently carry stock at
  // HO01 and how much (RAW/native units, NOT converted), sorted highest
  // quantity first. Codes with zero or no stock are never included, so
  // anything in this map is, by construction, "actually in SAP right now."
  //
  // Deliberately mirrors buildMosSohMap()'s Total Quantity definition
  // (Unrestricted + verified Transit + QC) so the numbers agree with the
  // rest of the app — the only difference is grouping by the RAW code
  // (row["Material"]) instead of the canonical code, and using the raw
  // (pre-conversion) fields instead of the standardized _cv* fields, since
  // this needs to reflect exactly what's under that one specific SAP code.
  function buildHo01RawCodeMap(hub) {
    const map = new Map(); // canonical -> Map<rawCode, qty>
    const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
    base.forEach(row => {
      const plt = String(row["Plant"] || "").trim().toUpperCase();
      if (plt !== hub) return;

      const canonical = String(row._mappedMaterial || row["Material"] || "").trim();
      const rawCode   = String(row["Material"] || "").trim();
      if (!canonical || !rawCode) return;

      const unrestricted   = Number(row["Unrestricted Stock"] || 0);
      const rawTransit     = Number(row["Stock in Transit"] || 0);
      const phantomTransit = Number(row._phantomTransitQty || 0);
      const verifiedTransit = Math.max(0, rawTransit - phantomTransit);
      const qc              = Number(row["Stock in Quality Inspection"] || 0);
      const qty = unrestricted + verifiedTransit + qc;
      if (qty <= 0) return;

      if (!map.has(canonical)) map.set(canonical, new Map());
      const inner = map.get(canonical);
      inner.set(rawCode, (inner.get(rawCode) || 0) + qty);
    });

    const out = new Map();
    map.forEach((inner, canonical) => {
      const list = [...inner.entries()]
        .map(([code, qty]) => ({ code, qty }))
        .sort((a, b) => b.qty - a.qty);
      out.set(canonical, list);
    });
    return out;
  }

  // Canonical code -> total stock currently sitting "Stock in Quality
  // Inspection" at the hub, summed raw (native units) across every raw SAP
  // code that maps to that canonical material. This is stock that's
  // physically at HO01 but not yet released/usable — useful context next to
  // the live SOH figure, since it's already counted inside that total.
  function buildCanonicalQcMap(hub) {
    const out = new Map();
    const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
    base.forEach(row => {
      const plt = String(row["Plant"] || "").trim().toUpperCase();
      if (plt !== hub) return;
      const canonical = String(row._mappedMaterial || row["Material"] || "").trim();
      if (!canonical) return;
      const qc = Number(row["Stock in Quality Inspection"] || 0);
      if (!qc) return;
      out.set(canonical, (out.get(canonical) || 0) + qc);
    });
    return out;
  }

  // Canonical code -> Material Type (e.g. "ZME", "ZMS"…), sourced the same
  // way the rest of the app derives it (Dashboard/Transit/Expiry/QC filter
  // bars all use getValuationType(row) — see script.js — NOT a literal
  // "Material Type" column, which doesn't exist under that name in the SAP
  // export). This previously read row["Material Type"] directly, which was
  // always blank/undefined, so this map came back empty regardless of what
  // was loaded — the filter looked "connected" but could never resolve a
  // single type. Used to power the Material Type filter bar AND the
  // ZMD-EXCLUDE check below.
  //
  // ZMD-PRIORITY FIX: a canonical/mapped code can be an umbrella over
  // several raw SAP codes (that's the whole point of the mapping table).
  // If those raw codes carry DIFFERENT valuation types — one ZME, another
  // genuinely ZMD — a plain "first non-blank wins" pick is order-dependent:
  // whichever row happens to be encountered first in the loaded inventory
  // decides the type for the WHOLE canonical group. If a non-ZMD row won
  // that race, the group's ZMD raw code(s) become invisible to the
  // ZMD-EXCLUDE check everywhere in this file (Tabs 1–5, including MOS
  // Evaluation), since the check only ever sees the winning type. Since the
  // rule is "ZMD must not be seen at all," we instead let ZMD win no matter
  // what order rows are encountered in — a mixed group is excluded, not
  // shown under whichever other type happened to load first.
  function buildMaterialTypeMap() {
    const out = new Map();
    const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
    base.forEach(row => {
      const code = String(row._mappedMaterial || row["Material"] || "").trim();
      if (!code) return;
      if (out.get(code) === "ZMD") return; // already flagged ZMD for this canonical — that wins, stop overwriting
      const type = (typeof getValuationType === "function" ? String(getValuationType(row) || "") : "").trim().toUpperCase();
      if (!type || type === "(NONE)") return;
      if (type === "ZMD" || !out.has(code)) out.set(code, type);
    });
    return out;
  }

  // Canonical code -> Material Group, sourced directly from the literal
  // "Material Group Name" column on the main inventory data (rawDf) — this
  // is the real SAP field name used throughout script.js (Dashboard,
  // Branch Comparison, Expiry Risk, etc. all read row["Material Group Name"],
  // NOT "Material Group" — that key doesn't exist, which is why this filter
  // showed "Unavailable" even with data loaded). getReconciledBase() already
  // excludes non-medical groups (isNonMedicalGroup) before we ever see it,
  // same as every other Material Group control in the app. Keyed the same
  // way as buildCanonicalDescMap/buildMaterialTypeMap (first non-blank value
  // wins). Used to power the Material Group filter bar.
  function buildMaterialGroupMap() {
    const out = new Map();
    const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
    base.forEach(row => {
      const code = String(row._mappedMaterial || row["Material"] || "").trim();
      if (!code || out.has(code)) return;
      const group = String(row["Material Group Name"] || "").trim();
      if (group) out.set(code, group);
    });
    return out;
  }

  // ── STORAGE-LOCATION TEMPERATURE (COLD vs NON-COLD) RECONCILIATION ────────
  // Business rule: the temperature zone (cold vs non-cold) of the storage
  // location a REQUESTING PLANT is pulling into must match the temperature
  // zone of the storage location(s) the material actually sits in at HO01
  // right now. Cold-to-cold and non-cold-to-non-cold are fine; anything else
  // (including a material split across both a cold AND a non-cold location
  // at HO01 at once, which is itself a data-quality problem worth
  // surfacing) is flagged as a mismatch.
  //
  // HO01's own cold storage locations — hand-maintained constant, update by
  // hand if HO01 ever adds, renames, or retires a cold storage location.
  const HO01_COLD_LOCATIONS = ["HOM3", "HOM8", "HOM9"];

  // Each requesting plant's own cold-storage code(s) — hand-maintained
  // constant sourced from a one-off plant/storage-location reference list
  // (storage.xlsx), NOT any uploaded/live data. A plant can have more than
  // one cold code (e.g. HA01). Any OTHER storage-location code a plant uses
  // (not listed here) is treated as that plant's non-cold storage. Update
  // this table by hand if a plant's cold storage code ever changes.
  const PLANT_COLD_STORAGE_LOCATIONS = {
    AA01: ["AA1C"],
    AA02: ["AA2C"],
    AD01: ["ADC1"],
    AR01: ["AMC1"],
    AS01: ["ASC1"],
    BD01: ["BDC1"],
    DE01: ["DEC1"],
    DI01: ["DDC1"],
    GA01: ["GAC1"],
    GO01: ["GOC1"],
    HA01: ["HAC1", "HAC2"],
    JI01: ["JMC1"],
    JJ01: ["JJC1"],
    KD01: ["KDC1"],
    MK01: ["MKC1"],
    NB01: ["NBC1"],
    NK01: ["NKC1"],
    SE01: ["SEC1"],
    SH01: ["SHC1"],
  };

  // canonical material code -> Set of every "Storage Location" value HO01
  // has a row for, regardless of current stock quantity (per the clarified
  // requirement: presence of a location — not live stock — is what counts).
  function buildHo01StorageLocationMap(hub) {
    const out = new Map();
    const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
    base.forEach(row => {
      const plt = String(row["Plant"] || "").trim().toUpperCase();
      if (plt !== hub) return;
      const canonical = String(row._mappedMaterial || row["Material"] || "").trim();
      const loc = String(row["Storage Location"] || "").trim().toUpperCase();
      if (!canonical || !loc) return;
      if (!out.has(canonical)) out.set(canonical, new Set());
      out.get(canonical).add(loc);
    });
    return out;
  }

  // Classifies one request line's cold/non-cold storage-location alignment.
  //   status: "match" | "mismatch" | "unknown"
  //   "unknown" covers: no Location typed, the request's Plant isn't in
  //   PLANT_COLD_STORAGE_LOCATIONS, or HO01 has no Storage Location data at
  //   all for this material yet (nothing to compare against) — none of
  //   these are flagged as a mismatch, since there isn't enough information
  //   to say one way or the other.
  function classifyStorageMismatch(r, ho01LocMap) {
    if (!r.location) return { status: "unknown", reason: "No Location on request line" };

    const coldCodes = PLANT_COLD_STORAGE_LOCATIONS[r.plant];
    if (!coldCodes) return { status: "unknown", reason: `Plant ${r.plant} not in cold-storage reference table` };

    const isColdRequest = coldCodes.includes(r.location);

    const locSet = (r.canonical && ho01LocMap.get(r.canonical)) || new Set();
    if (locSet.size === 0) return { status: "unknown", reason: "No HO01 Storage Location data for this material", isColdRequest };

    const hasCold    = [...locSet].some(l => HO01_COLD_LOCATIONS.includes(l));
    const hasNonCold = [...locSet].some(l => !HO01_COLD_LOCATIONS.includes(l));

    // Mixed storage at HO01 (both cold and non-cold) is flagged regardless
    // of which zone the request itself wants — surfacing it is the point.
    const mismatch = isColdRequest ? hasNonCold : hasCold;

    return {
      status: mismatch ? "mismatch" : "match",
      isColdRequest,
      hasCold,
      hasNonCold,
      ho01Locations: [...locSet].sort().join(", "),
    };
  }

  // Canonical code -> responsible person, sourced from mosMerged (same
  // "r.person" field who-responsible.js / the global sidebar person filter
  // use) so "assigned to" here means the same thing it means everywhere
  // else in the app — NOT the request file's "Created By" column.
  function buildPersonMap() {
    const out = new Map();
    if (typeof mosMerged !== "undefined" && mosMerged.length) {
      mosMerged.forEach(r => { if (r.code) out.set(r.code, r.person || ""); });
    }
    return out;
  }

  // Canonical code -> Program Classification (RDF-CDSS / RDF-NON-CDSS /
  // Program-Reportable / Program-Non-Reportable), via mos.js's shared
  // buildCodeProgramClassMap() (see mos.js for the full contract) — same
  // classification shown/filterable on every other page (Dashboard, Expiry
  // Watchlist, MOS by Plant, Branch Demand, etc). Returns an empty map (no
  // throw) when the AMC file hasn't been loaded yet.
  function classificationMap() {
    return (typeof buildCodeProgramClassMap === "function") ? buildCodeProgramClassMap() : new Map();
  }

  // PURCH-ORG-CHECK: the request file's "Purchasing Org." column tells us
  // which of the two funding streams a line was sourced under — same
  // meaning as everywhere else in the app (Branch Demand, etc.): RD01 only
  // ever sources RDF materials, HP02 only ever sources Program materials.
  // We don't display the raw Classification value anymore (see PURCH-ORG-
  // CHECK column below), but we still need the underlying map internally to
  // catch requests where the typed Purchasing Org. doesn't match the family
  // its resolved material actually belongs to (e.g. an RDF-only item
  // requested under HP02) — that's a real data-quality problem worth
  // flagging even though we're not showing the classification text itself.
  const PURCH_ORG_FAMILY = { RD01: "RDF", HP02: "PROGRAM" };
  function purchOrgFamily(purchasingOrg) {
    return PURCH_ORG_FAMILY[String(purchasingOrg || "").trim().toUpperCase()] || "";
  }
  // Program Classification value -> broad family. "RDF-CDSS"/"RDF-NON-CDSS"
  // collapse to "RDF"; "Program-Reportable"/"Program-Non-Reportable" collapse
  // to "PROGRAM". Anything else (blank/unrecognized) is inconclusive.
  function classFamily(programClass) {
    const v = String(programClass || "").trim().toUpperCase();
    if (v.startsWith("RDF")) return "RDF";
    if (v.startsWith("PROGRAM")) return "PROGRAM";
    return "";
  }

  // PURCH-ORG-CHECK / DUAL-STREAM-FIX: a canonical code can legitimately
  // carry BOTH an RDF record and a separate Program(Q) record (see the LAW
  // comment on buildMosMerged in mos.js) — a material isn't "RDF" or
  // "Program", it can be both at once, each with its own AMC/classification
  // row. clsMap.get(canonical) alone only ever returns the FIRST-SEEN
  // classification for that code (see buildCodeProgramClassMap's own header
  // comment), so for a dual-stream code it silently picks one stream and
  // compares every request line for that material against only that one —
  // producing a false "mismatch" on the other stream's correctly-typed
  // lines. buildCodeProgramClassMap() also stores a TYPE-AWARE key
  // ("CODE\u241FRDF" / "CODE\u241FQ") for exactly this reason; this helper
  // checks both and returns every family the code is actually known to
  // belong to, falling back to the plain-code key only when neither
  // type-aware entry exists (single-stream / older-data case).
  function classFamiliesForCode(clsMap, canonical) {
    const out = new Set();
    if (!canonical || !clsMap) return out;
    const rdfCls = clsMap.get(canonical + "\u241F" + "RDF");
    const qCls   = clsMap.get(canonical + "\u241F" + "Q");
    if (rdfCls) out.add(classFamily(rdfCls));
    if (qCls)   out.add(classFamily(qCls));
    out.delete("");
    if (out.size === 0) {
      const plain = classFamily(clsMap.get(canonical));
      if (plain) out.add(plain);
    }
    return out;
  }

  // ── ROLE/SCOPE ACCESS FOR REQUEST LINES ────────────────────────────────────
  // The main inventory upload is already scoped per-user via
  // filterRowsByAccess() (permissions.js) — a role limited to certain
  // Special-Stock-Type/Valuation-Type combos (e.g. only R_ZME, never
  // Q_ZLC) never sees out-of-scope rows anywhere else in the app. The
  // Request Excel upload, though, has no Special Stock Type / Inventory
  // Valuation Type columns of its own to check directly — it's a PR/
  // request file, not raw inventory — so without this, a single uploaded
  // request file mixing ZME/ZLC/ZMS lines showed EVERY line regardless of
  // the signed-in user's scope, silently leaking materials that role is
  // not supposed to see (they'd just show up with a blank Material Type
  // and "0 in stock", which looks like missing data rather than a scope
  // restriction, and worse, still exposes the description/qty numbers).
  //
  // scopeExcludedMaterialCodes (script.js) already tracks every raw
  // Material code from the CURRENTLY LOADED main inventory file that this
  // user's role/data_scopes deny (as opposed to excludedMaterialCodes,
  // which is universal — denied for everyone). We extend it to canonical
  // codes too (via the mapping table, so a request line typed under a
  // different raw SAP code for the same scope-denied item is still
  // caught) and drop any request line whose resolved canonical falls in
  // that set, the same way ZMD items are already dropped below.
  function buildScopeExcludedCanonicalSet() {
    const out = new Set();
    if (typeof scopeExcludedMaterialCodes === "undefined") return out;
    scopeExcludedMaterialCodes.forEach(rawCode => {
      const code = String(rawCode || "").trim();
      if (!code) return;
      out.add(code);
      if (typeof mappingTable !== "undefined" && mappingTable.size > 0) {
        const stypeMap = mappingTable.get(code.toUpperCase());
        if (stypeMap) {
          stypeMap.forEach(entry => {
            if (entry.targetCode) out.add(String(entry.targetCode).trim());
          });
        }
      }
    });
    return out;
  }

  // ── CORE ANALYSIS ──────────────────────────────────────────────────────────
  function buildRequestAnalysis() {
    const hub    = (typeof HUB_PLANT === "function" || typeof HUB_PLANT !== "undefined") ? HUB_PLANT : "HO01";
    const sohMap = (typeof buildMosSohMap === "function") ? buildMosSohMap() : new Map();
    const descMap = buildCanonicalDescMap();
    const rawCodeMap = buildHo01RawCodeMap(hub); // canonical -> [{code, qty}], live SAP codes only
    const qcMap = buildCanonicalQcMap(hub); // canonical -> stock currently in Quality Inspection at hub
    const scopeExcludedCanonical = buildScopeExcludedCanonicalSet(); // codes this role is denied
    const personMap = buildPersonMap();
    const clsMap = classificationMap(); // canonical -> Program Classification
    const matTypeMap = buildMaterialTypeMap(); // canonical -> "ZME"/"ZMS"/…
    const matGroupMap = buildMaterialGroupMap(); // canonical -> "Material Group" value
    const ho01LocMap = buildHo01StorageLocationMap(hub); // canonical -> Set of HO01 Storage Location codes

    const requestedCanonical = new Set();

    // MOS EVALUATION inputs — built once, used per-row below. See "MOS
    // EVALUATION (2–4 MONTH WINDOW)" section near the top of this file.
    const mosEvalAvailable = typeof mosMerged !== "undefined" && mosMerged.length > 0;
    const openOutboundMap = buildReqOpenOutboundMap();

    // ── FULL ALIGNMENT WITH BRANCH DEMAND'S PRIORITY ALLOCATION ─────────────
    // FULL-ALIGN-BRD: previously this tab only judged whether the REQUESTED
    // QUANTITY was the right size for the branch's own MOS gap, in isolation
    // — it never checked whether HO01 actually has enough stock to give the
    // branch that amount once every OTHER branch's competing need for the
    // same material is weighed in priority order (Critical > High > Medium,
    // see branch-demand.js file header "PRIORITY ALLOCATION"). That meant a
    // line could show "Justified" here while Branch Demand's own allocation
    // gave the branch 0 or a partial amount for the exact same material,
    // because a more urgent branch used up HO01's available stock first.
    //
    // Rather than re-deriving that allocation math a second time (and
    // risking the two tabs drifting apart again), this calls Branch
    // Demand's OWN brdComputeMaterialAllocation() directly — the identical
    // function, with the identical inputs (sohMap, HO01 unrestricted/QC
    // breakdown, national open-outbound map, buffer) it uses on its own
    // page — so a "would HO01 actually give this branch the stock" verdict
    // here can never disagree with what Branch Demand itself would show for
    // that branch/material. Only degrades gracefully (brdAllocAvailable =
    // false) if branch-demand.js hasn't loaded yet or the AMC file isn't
    // uploaded — script.js load order (script.js → mos.js → branch-demand.js
    // → request-analysis.js) should prevent that in practice.
    const brdAllocAvailable = mosEvalAvailable
      && typeof brdComputeMaterialAllocation === "function"
      && typeof brdBuildHo01Breakdown === "function"
      && typeof brdBuildOpenOutboundMap === "function"
      && typeof mosPlants !== "undefined" && mosPlants.length > 0;
    // ho01BreakdownForAlloc / brdOpenOutboundForAlloc / brdBufferForAlloc are
    // the EXACT SAME three inputs brdComputeMaterialAllocation() is called
    // with on the Branch Demand page itself (see renderBranchDemand() there)
    // — not Request Analysis's own qcMap/openOutboundMap (buildReqOpenOutboundMap
    // above), which are shaped differently and used for other tabs.
    const ho01BreakdownForAlloc   = brdAllocAvailable ? brdBuildHo01Breakdown() : new Map();
    const brdOpenOutboundForAlloc = brdAllocAvailable ? brdBuildOpenOutboundMap() : { byPlant: new Map(), byCode: new Map() };
    // brdBufferMos is Branch Demand's own shared (Supabase-synced) buffer
    // setting — use it as-is so both tabs reserve the exact same HO01
    // buffer quantity; falls back to 0 (no reserve) if that page's setting
    // hasn't loaded in this session yet.
    const brdBufferForAlloc = (typeof brdBufferMos === "number" && !isNaN(brdBufferMos)) ? brdBufferMos : 0;
    // One allocation run per DISTINCT material (canonical+stream), not per
    // request line — brdComputeMaterialAllocation() computes every branch's
    // share for that material at once, so multiple request lines for the
    // same material (different branches, or duplicate lines) reuse one
    // cached result instead of re-running the tier waterfall repeatedly.
    const brdAllocCache = new Map(); // "CODE\u241FTYPE" -> brdComputeMaterialAllocation() result
    function getBrdAllocationForAmcRow(amcRow) {
      if (!brdAllocAvailable || !amcRow) return null;
      const key = `${amcRow.code}\u241F${amcRow.type || ""}`;
      if (brdAllocCache.has(key)) return brdAllocCache.get(key);
      let calc = null;
      try {
        calc = brdComputeMaterialAllocation(amcRow, sohMap, brdBufferForAlloc, ho01BreakdownForAlloc, brdOpenOutboundForAlloc);
      } catch (e) {
        calc = null; // never let an allocation edge case break the whole tab
      }
      brdAllocCache.set(key, calc);
      return calc;
    }
    // Given the AMC row and a requesting branch, returns everything
    // classifyMosVerdict() needs to judge stock AVAILABILITY (as opposed to
    // request SIZE): what that branch would actually be allocated for this
    // material under Branch Demand's own tier waterfall right now, plus a
    // human-readable explanation. Reuses branch-demand.js's OWN
    // brdPriorityExplanation() — same "line" object shape it builds for
    // itself (see brdBuildLines()) — so the wording matches Branch Demand's
    // own equity-audit tooltip exactly, not a re-paraphrased version of it.
    function getBrdAllocInfoForRow(amcRow, plantCode) {
      if (!brdAllocAvailable || !amcRow || !plantCode) return null;
      const calc = getBrdAllocationForAmcRow(amcRow);
      if (!calc) return null;
      const b = calc.perBranch.find(x => x.plant === plantCode);
      if (!b) return null; // plantCode not a recognized branch plant in mosPlants
      const lineForExplanation = {
        hasAmc: b.hasAmc, priorityTier: b.tier, priorityLabel: b.tierLabel,
        need: b.need, alloc: b.allocComputed, fillPct: b.fillPct,
        tierBreakdown: calc.tierBreakdown, availableHo: calc.availableHo,
        sohHo: calc.sohHo, outboundTotal: calc.outboundTotal, bufferQty: calc.bufferQty,
      };
      const explanation = (typeof brdPriorityExplanation === "function")
        ? brdPriorityExplanation(lineForExplanation)
        : `Priority tier: ${b.tierLabel}. HO01 available for this material: ${fmtQty(calc.availableHo)}.`;
      return {
        allocQty: b.allocComputed, tierKey: b.tier, tierLabel: b.tierLabel,
        availableHo: calc.availableHo, totalNeed: calc.totalNeed, isPartial: calc.isPartial,
        fillPct: b.fillPct, explanation,
      };
    }

    const rows = reqRows.map(r => {
      const resolved   = resolveRequestMaterial(r.material, r.purchasingOrg);
      const canonical  = resolved.canonical;

      // SCOPE-EXCLUDE-REQUEST-LINES: same role-scope enforcement the main
      // inventory upload already gets via filterRowsByAccess() — a
      // request file can freely mix ZME/ZLC/ZMS/etc lines even though the
      // signed-in user's role may only be scoped to some of them. Also
      // check the raw typed code directly (not just its resolved
      // canonical) in case it isn't recognized by the mapping table at
      // all, so a scope-denied raw code can't slip through unresolved.
      if (
        (canonical && scopeExcludedCanonical.has(canonical)) ||
        scopeExcludedCanonical.has(String(r.material || "").trim())
      ) return null;

      const inInventory = !!canonical && sohMap.has(canonical);
      // "Total" / status figures stay STANDARDIZED (converted, summed across
      // every raw code for this material) — this is unchanged and intentional.
      const liveHo01   = inInventory ? (sohMap.get(canonical)[hub] || 0) : 0;
      const desc       = r.shortText || resolved.desc || descMap.get(canonical) || "";
      // Description of the MAPPED/canonical material the live HO01 figure was
      // actually pulled for — separate from `desc` above, which prefers the
      // requester's own free-text Short Text. This always reflects the
      // canonical code's description (mapping table target, or live-inventory
      // lookup), so it stays accurate even when the requester's Short Text
      // doesn't match the resolved material.
      const mappedDesc = resolved.desc || descMap.get(canonical) || "";
      const qcHo01     = canonical ? (qcMap.get(canonical) || 0) : 0;
      // Live current stock at the REQUESTING plant itself (not HO01) — same
      // sohMap used for the HO01 figure, just keyed by the branch's own plant
      // code instead of the hub, so it reflects what's actually there right
      // now for comparison against what the request file claims.
      const liveReqPlant = (canonical && reqPlant && sohMap.has(canonical)) ? (sohMap.get(canonical)[reqPlant] || 0) : 0;
      const person     = canonical ? (personMap.get(canonical) || "") : "";
      const materialType = canonical ? (matTypeMap.get(canonical) || "") : "";
      const materialGroup = canonical ? (matGroupMap.get(canonical) || "") : "";

      // ZMD-EXCLUDE: per explicit scope, Request Analysis (same as Branch
      // Demand) only covers ZME/ZMS/ZLC valuation-type materials. A ZMD
      // item is dropped from the analysis entirely at this point — no row,
      // no mismatch check, no MOS eval, nothing — rather than being shown
      // with a warning. Filtered out of the final `rows` array below with
      // `.filter(Boolean)`.
      if (materialType === "ZMD") return null;

      // PURCH-ORG-CHECK / SINGLE-STREAM-SCOPE: once we know which stream a
      // line is FOR, everything shown/evaluated for that line should stay
      // inside that one stream — an RD01 line reports RDF only, an HP02
      // line reports Program only. Neither should surface, mix in, or get
      // compared against the material's OTHER stream at all.
      //
      // knownFamilies = every family this canonical code actually has an
      // AMC/classification record for (a code can genuinely have both —
      // see classFamiliesForCode above — but any ONE request line is only
      // ever for one of them).
      //
      // resolvedType decides which single stream this line belongs to:
      //   1. TRUST-PURCH-ORG: if the line has a typed Purchasing Org.,
      //      that's authoritative — RD01 always means RDF, HP02 always
      //      means Program(Q). Used directly, not gated behind whether
      //      the classification map (clsMap) happens to also carry an
      //      entry for that stream — clsMap and the AMC file (mosMerged)
      //      are built from the same source but can drift in edge cases,
      //      and gating here was silently blocking a correct RD01→RDF /
      //      HP02→Program lookup whenever that happened, making AMC data
      //      that genuinely exists on file show as "not committed".
      //   2. Otherwise (no usable Purchasing Org.), if the material only
      //      has ONE stream on file at all, use that (nothing to
      //      disambiguate).
      //   3. Otherwise (no usable Purchasing Org., material is dual-stream)
      //      stays unresolved — we genuinely don't know which side this
      //      line is, so we don't guess (see findAmcRowForCanonical's own
      //      fallback for that case).
      const purchOrgExpectedFamily = purchOrgFamily(r.purchasingOrg);
      const knownFamilies = classFamiliesForCode(clsMap, canonical);
      let resolvedFamily = "";
      if (purchOrgExpectedFamily) {
        resolvedFamily = purchOrgExpectedFamily;
      } else if (knownFamilies.size === 1) {
        resolvedFamily = [...knownFamilies][0];
      }
      const resolvedType = resolvedFamily === "PROGRAM" ? "Q" : (resolvedFamily === "RDF" ? "RDF" : "");

      // programClass now reflects ONLY the resolved stream — an RD01 line
      // never shows/carries the material's Program classification text (or
      // vice versa), even when the material has both on file.
      const programClass = resolvedType
        ? (clsMap.get(canonical + "\u241F" + resolvedType) || "")
        : (canonical ? (clsMap.get(canonical) || "") : "");

      // purchOrgActualFamily mirrors resolvedFamily now that programClass is
      // already single-stream — kept as its own variable for readability
      // and because downstream code/exports already expect this name.
      const purchOrgActualFamily = resolvedFamily;
      // A real mismatch: the typed Purchasing Org. doesn't correspond to
      // ANY family the material actually carries (e.g. RD01 typed on a
      // Program-only item). Inconclusive when either side is unknown.
      const purchOrgMismatch = !!(purchOrgExpectedFamily && knownFamilies.size > 0 && !knownFamilies.has(purchOrgExpectedFamily));

      // Storage Location cold/non-cold check: does the temperature zone of
      // the requesting plant's own Location (r.location, e.g. DEC1 = cold
      // for DE01) match the temperature zone of where this material
      // actually sits at HO01 right now (from Storage Location on the main
      // inventory data)? See classifyStorageMismatch() for the full rule.
      const storageCheck = classifyStorageMismatch({ location: r.location, plant: r.plant, canonical }, ho01LocMap);
      const locationMismatch = storageCheck.status === "mismatch";

      // ── MOS EVALUATION (2–4 month window) ─────────────────────────────
      // Judges the REQUESTED QUANTITY itself — not just whether HO01 has
      // stock (that's Tabs 1/3) — against the same TARGET_MOS(4)/
      // REQUEST_ELIGIBILITY_MOS(2) window Branch Demand fills to. Uses this
      // request line's own requesting plant (reqPlant) and its live AMC/SOH,
      // netted against anything already in transit to it (Open Outbound).
      // SINGLE-STREAM-SCOPE: use the same resolvedFamily as everything else
      // for this line, so the AMC row pulled for MOS eval is from the same
      // stream as the classification/Purch Org check above — never a mix.
      const familyHint = resolvedFamily;
      const amcRow = mosEvalAvailable ? findAmcRowForCanonical(canonical, familyHint, reqPlant) : null;
      const branchAmc = amcRow ? amcRow.amcs[reqPlant] : null;
      const hasAmc = branchAmc !== null && branchAmc !== undefined;
      const mosNow = hasAmc
        ? (branchAmc > 0 ? liveReqPlant / branchAmc : (liveReqPlant > 0 ? Infinity : null))
        : null;
      const outboundToBranch = (reqPlant && canonical)
        ? (openOutboundMap.get(`${reqPlant}::${canonical}`) || 0)
        : 0;
      const targetNeed = hasAmc
        ? Math.max(0, REQAN_TARGET_MOS * branchAmc - liveReqPlant - outboundToBranch)
        : null;
      const projectedSoh = liveReqPlant + outboundToBranch + (r.reqQty || 0);
      const projectedMos = hasAmc
        ? (branchAmc > 0 ? projectedSoh / branchAmc : (projectedSoh > 0 ? Infinity : null))
        : null;
      // FULL-ALIGN-BRD: this branch's actual share of HO01's priority-tier
      // allocation for this exact material right now — null whenever
      // brdAllocAvailable is false or reqPlant isn't a recognized branch
      // plant, in which case classifyMosVerdict() skips the availability
      // check entirely and behaves exactly as before FULL-ALIGN-BRD.
      const brdAllocInfo = hasAmc ? getBrdAllocInfoForRow(amcRow, reqPlant) : null;
      const mosVerdict = classifyMosVerdict({
        hasAmc, mosNow, targetNeed: targetNeed || 0, reqQty: r.reqQty || 0, projectedMos, outboundToBranch,
        allocInfo: brdAllocInfo,
      });

      let status;
      if (!canonical || !inInventory) status = "no-match";
      else if (liveHo01 <= 0)          status = "stockout";
      else                             status = "ok";

      // The SUGGESTION is a different thing: which actual, live SAP code(s)
      // carry that stock right now, in their own native quantities.
      //
      // A suggestion is only shown when the code the requester typed can NOT
      // fully cover the requested quantity by itself:
      //   - If the typed code alone already has enough stock to cover the
      //     requested qty, NO suggestion is shown — even if other codes also
      //     happen to carry stock for the same item (nothing to fix).
      //   - If the typed code has stock but not enough (partial) AND another
      //     live code exists for the same item, the suggestion combo
      //     includes the typed code itself plus the other code(s), so the
      //     requester sees the full combination needed to fulfill.
      //   - If the typed code has zero live stock but another code exists,
      //     that other code (or codes) is suggested — even if their combined
      //     total still doesn't fully cover the requested qty, since partial
      //     stock elsewhere is still useful to know.
      //   - If there's no OTHER live code at all (only the typed code, or
      //     nothing), there's nothing to suggest either way.
      const rawCandidates = canonical ? (rawCodeMap.get(canonical) || []) : [];
      const typedCode = String(r.material || "").trim().toUpperCase();
      const typedEntry = rawCandidates.find(c => c.code.toUpperCase() === typedCode);
      const typedQty = typedEntry ? typedEntry.qty : 0;
      const otherCandidates = rawCandidates.filter(c => c.code.toUpperCase() !== typedCode);

      const typedFullyCovers = typedQty > 0 && typedQty >= r.reqQty;
      const hasSuggestion = !typedFullyCovers && otherCandidates.length > 0;
      const suggestionCandidates = hasSuggestion
        ? (typedEntry ? [typedEntry, ...otherCandidates] : otherCandidates)
        : [];

      const sohMismatch = inInventory && Math.abs(liveHo01 - r.reqSoh) > 0.001;

      if (canonical && inInventory) requestedCanonical.add(canonical);

      return {
        ...r,
        canonical, desc, status, person, programClass, materialType, materialGroup,
        purchOrgExpectedFamily, purchOrgActualFamily, purchOrgMismatch,
        liveHo01, mappedDesc, qcHo01, liveReqPlant, sohMismatch,
        locationMismatch, storageCheckStatus: storageCheck.status,
        storageCheckHo01Locations: storageCheck.ho01Locations || "",
        storageCheckReason: storageCheck.reason || "",
        branchAmc, hasAmc, mosNow, outboundToBranch, targetNeed, projectedMos,
        mosVerdictKey: mosVerdict.key, mosVerdictLabel: mosVerdict.label, mosVerdictDetail: mosVerdict.detail,
        hasSuggestion,
        suggestedCode: hasSuggestion
          ? suggestionCandidates.map(c => `${c.code} (${fmtQty(c.qty)})`).join(" or ")
          : null,
        suggestedDesc: hasSuggestion ? (resolved.desc || descMap.get(canonical) || "") : null,
        suggestedTotal: hasSuggestion ? suggestionCandidates.reduce((s, c) => s + c.qty, 0) : 0,
      };
    }).filter(Boolean); // drops the ZMD-EXCLUDE `null`s above

    // ── DOUBLE REQUEST DETECTION ─────────────────────────────────────────────
    // Same physical item requested more than once in THIS file — same or
    // different raw code. Grouping key is the canonical code when resolvable;
    // when it isn't (no mapping match), we still group by the raw code as
    // typed, so exact-duplicate lines are caught even with no mapping loaded.
    const dupGroups = new Map(); // key -> array of row indices
    rows.forEach((r, i) => {
      const key = r.canonical || `__raw__${r.material.toUpperCase()}`;
      if (!dupGroups.has(key)) dupGroups.set(key, []);
      dupGroups.get(key).push(i);
    });
    rows.forEach((r, i) => {
      const key = r.canonical || `__raw__${r.material.toUpperCase()}`;
      const group = dupGroups.get(key);
      r.isDuplicate = group.length > 1;
      if (r.isDuplicate) {
        const siblings = group.filter(j => j !== i).map(j => rows[j]);
        r.duplicateCount = group.length;
        r.duplicateTotalQty = group.reduce((s, j) => s + (rows[j].reqQty || 0), 0);
        r.duplicateSiblingsLabel = siblings
          .map(s => `${s.material} · PR ${s.prNum}${s.poste ? "/" + s.poste : ""} (${fmtQty(s.reqQty)})`)
          .join("; ");
      } else {
        r.duplicateCount = 1;
        r.duplicateTotalQty = r.reqQty;
        r.duplicateSiblingsLabel = "";
      }
    });

    // HO01 stock that never shows up (under its canonical code) in the request at all
    //
    // FIX-SOH-STREAM-SPLIT: buildMosSohMap() (mos.js) now ALSO stores
    // stream-scoped entries under "code\u241Ftype" keys alongside each
    // plain-code entry, for MOS's per-stream SOH split. Those composite keys
    // aren't real material codes — skip them here or they'd surface as bogus
    // "codes" (with the separator character baked in) that never match
    // requestedCanonical and get misreported as unrequested HO01 stock.
    const ho01NotRequestedAll = [];
    sohMap.forEach((plantMap, code) => {
      if (code.includes("\u241F")) return;
      // ZMD-EXCLUDE: same scope restriction as the request-line rows above
      // — ZMD items don't belong in Request Analysis at all, including this
      // "idle at HO01" list.
      if ((matTypeMap.get(code) || "") === "ZMD") return;

      // REQUEST-TYPE-SCOPE: this list has no per-row Purchasing Org. to
      // resolve a stream from (there's no request line at all — that's the
      // whole point of this tab), so it's scoped by the file-level
      // reqRequestType derived in loadRequestFile() instead: RD01-majority
      // files ("RDF") only see items with an RDF record; HP02-majority
      // files ("PROGRAM") only see items with a Program(Q) record. A
      // material split across both streams still only counts if the
      // in-scope stream is one of them. When reqRequestType is unknown
      // (file has no usable Purchasing Org. data at all), this check is
      // inconclusive and every item is left in, same as before.
      if (reqRequestType) {
        const codeFamilies = classFamiliesForCode(clsMap, code);
        if (!codeFamilies.has(reqRequestType)) return;
      }

      const qty = plantMap[hub] || 0;
      if (qty > 0 && !requestedCanonical.has(code)) {
        ho01NotRequestedAll.push({ code, desc: descMap.get(code) || "", qty, person: personMap.get(code) || "", programClass: clsMap.get(code) || "", materialType: matTypeMap.get(code) || "", materialGroup: matGroupMap.get(code) || "" });
      }
    });

    // Per clarified requirement: only surface items where THIS request file's
    // own requesting plant (reqPlant) — never HO01 itself, the hub has no
    // consumption of its own — is running critical (MOS < 1 month). This is
    // now scoped to reqPlant specifically (not "any branch"), since the
    // analysis is always for one requesting plant vs HO01. Requires the AMC
    // file (MOS by Plant page) to be loaded — mosMerged/computeRowMOS/
    // isMosCritical come from mos.js.
    const mosDataLoaded = typeof mosMerged !== "undefined" && mosMerged.length > 0
      && typeof computeRowMOS === "function" && typeof isMosCritical === "function";

    let ho01NotRequested = [];
    if (mosDataLoaded) {
      ho01NotRequested = ho01NotRequestedAll
        .map(r => {
          // STREAM-AWARE-AMC: was previously mosMerged.find(m => m.code ===
          // r.code) — unscoped, so a dual-stream material (RDF AND
          // Program(Q) both on file) could silently grab whichever
          // stream's row happened to come first, computing "not critical"
          // (or the wrong critical branch) off the WRONG stream's AMC —
          // same class of bug already fixed for request lines' own MOS
          // Evaluation. There's no per-row Purchasing Org. here (there's
          // no request line at all for these items), so use the file's
          // own reqRequestType (RD01-majority file → RDF, HP02-majority →
          // Program) as the stream hint instead.
          const amcRow = findAmcRowForCanonical(r.code, reqRequestType, reqPlant);
          // No AMC commitment data at all for this material -> can't confirm
          // it's critical anywhere, so don't flag it (avoids false positives).
          const criticalBranches = amcRow
            ? computeRowMOS(amcRow, sohMap).filter(p =>
                !p.isHub &&
                String(p.plant || "").trim().toUpperCase() === reqPlant &&
                isMosCritical(p.mos))
            : [];
          return { ...r, criticalBranches };
        })
        .filter(r => r.criticalBranches.length > 0)
        // Most urgent (lowest MOS among its critical branches) first.
        .sort((a, b) => Math.min(...a.criticalBranches.map(c => c.mos)) - Math.min(...b.criticalBranches.map(c => c.mos)));
    }

    // All distinct Material Types present in this analysis (request lines +
    // HO01 stock not requested), sorted alphabetically — powers the filter
    // bar's option list. Blank/unknown types are excluded from the list
    // itself (there's nothing meaningful to filter on for them), but their
    // rows remain visible whenever the filter is inactive.
    const availableMatTypes = [...new Set([
      ...rows.map(r => r.materialType),
      ...ho01NotRequestedAll.map(r => r.materialType),
    ].filter(Boolean))].sort();

    // FIX-MATTYPE-EMPTY (corrected): an earlier version of this fallback
    // quietly offered ZME/ZMS/ZLC/ZMD as clickable options whenever
    // availableMatTypes came back empty — but every row's materialType is
    // ALSO "" in that exact situation (matTypeMap has nothing to key off
    // of, see buildMaterialTypeMap()), so those options matched zero rows
    // and made the filter look broken ("I picked ZME and everything
    // disappeared"). Surface the real reason instead: whether Material Type
    // could be resolved for ANY material at all (matTypeMap wasn't empty).
    const matTypeDataAvailable = matTypeMap.size > 0;

    // Same idea as availableMatTypes/matTypeDataAvailable above, for Material
    // Group. Routed through the central materialGroupFilterOptions() helper
    // (permissions.js) — same choke point every other Material Group dropdown
    // in the app now goes through — sourced from getReconciledBase() (the
    // authoritative, already access-filtered main inventory data) rather than
    // rebuilt from the downstream request-line objects. "Data available" still
    // just means at least one material could be resolved to a group at all.
    const availableMatGroups = (typeof materialGroupFilterOptions === "function")
      ? materialGroupFilterOptions(typeof getReconciledBase === "function" ? getReconciledBase() : [])
      : [...new Set([
          ...rows.map(r => r.materialGroup),
          ...ho01NotRequestedAll.map(r => r.materialGroup),
        ].filter(Boolean))].sort();
    const matGroupDataAvailable = matGroupMap.size > 0;

    return {
      // ho01NotRequestedAll is returned in full (not just its .length) so the
      // render step can re-scope its "idle at HO01 in total" KPI subtext to
      // whichever person is active in the sidebar filter — see PERSON-SCOPED
      // DASHBOARD KPIS below. ho01NotRequestedAllCount is kept alongside it
      // for any other caller that only wants the unfiltered total.
      rows, ho01NotRequested, ho01NotRequestedAll, ho01NotRequestedAllCount: ho01NotRequestedAll.length, mosDataLoaded,
      availableMatTypes, matTypeDataAvailable,
      availableMatGroups, matGroupDataAvailable,
      mosEvalAvailable,
    };
  }

  // ── MATERIAL TYPE FILTER BAR ────────────────────────────────────────────────
  // Multi-select dropdown injected inline next to the existing status filter
  // (reqan-status-filter). Same searchable checkbox-dropdown control used for
  // Material Type / Material Group / Plant everywhere else in the app (see
  // script.js's buildMultiSelect() + the .ms-wrap/.ms-btn/.ms-dropdown markup
  // on the Material tab) rather than a bespoke panel, so it looks and behaves
  // consistently. Rebuilt on every render so its option list stays in sync
  // with whatever Material Types are actually present in the currently
  // loaded data; checked state is preserved via reqMatTypeFilter.
  function renderMatTypeFilterBar(types, dataAvailable) {
    const statusEl = document.getElementById("reqan-status-filter");
    if (!statusEl || !statusEl.parentElement) return;

    // FIX-MATTYPE-LOOK: match the same labeled-box pattern the Material tab
    // and Branch Comparison use for their multi-selects (a small "nav-label"
    // caption sitting above the .ms-wrap button), instead of a bare unlabeled
    // button — that's what made this control look out of place next to the
    // rest of the filter bar.
    let outer = document.getElementById("reqan-mattype-outer");
    if (!outer) {
      outer = document.createElement("div");
      outer.id = "reqan-mattype-outer";
      outer.style.cssText =
        "display:inline-flex;flex-direction:column;gap:5px;margin-left:0.5rem;vertical-align:bottom;min-width:170px;";
      outer.innerHTML =
        `<div class="nav-label" style="font-size:var(--fs-2xs)">Material Type</div>` +
        `<div class="ms-wrap" id="reqan-mattype-wrap" style="min-width:0;width:100%">` +
          `<button class="ms-btn" type="button" style="width:100%">All Material Types <span class="ms-arrow">▾</span></button>` +
          `<div class="ms-dropdown" id="reqan-mattype-dd"></div>` +
        `</div>`;
      statusEl.parentElement.insertBefore(outer, statusEl.nextSibling);
    }
    const wrap = document.getElementById("reqan-mattype-wrap");
    const btn  = wrap ? wrap.querySelector(".ms-btn") : null;

    // FIX-MATTYPE-NO-DATA: don't show ZME/ZMS/ZLC/ZMD (or any options) as
    // if they'll filter something when they can't — that's what caused
    // "I picked an item and everything disappeared." Material Type can only
    // ever be resolved from the main inventory data's "Material Type"
    // column (buildMaterialTypeMap()); if that data isn't loaded/reconciled
    // this session, disable the control entirely and say why, rather than
    // pretending it works.
    let note = document.getElementById("reqan-mattype-note");
    if (!dataAvailable) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "";
        btn.innerHTML = "Unavailable <span class=\"ms-arrow\">▾</span>";
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
      }
      if (!note) {
        note = document.createElement("div");
        note.id = "reqan-mattype-note";
        note.style.cssText = "font-size:var(--fs-2xs);color:var(--dim);max-width:220px;line-height:1.3;";
        note.textContent = "Load the main inventory file to enable filtering by Material Type.";
        outer.appendChild(note);
      }
      return; // nothing to wire up — leave any previously-checked filter as is
    }
    if (note) note.remove();
    if (btn) { btn.disabled = false; btn.style.opacity = ""; btn.style.cursor = ""; }

    // buildMultiSelect() fully rebuilds the search box + checkbox list each
    // call, so we re-seed the checked state from reqMatTypeFilter afterward
    // (this control isn't tied to the pageFilters store buildMultiSelect
    // normally reads its initial selection from).
    buildMultiSelect("reqan-mattype-wrap", "reqan-mattype-dd", types, "All Material Types");
    const dd = document.getElementById("reqan-mattype-dd");
    if (dd) {
      dd.querySelectorAll(".ms-item input").forEach(cb => {
        cb.checked = reqMatTypeFilter.has(cb.value);
      });
    }
    // Re-render from the checked state we just restored (also refreshes the
    // button label / selected-count badge).
    if (wrap._refreshOptions) wrap._refreshOptions();
  }

  // ── MATERIAL GROUP FILTER BAR ───────────────────────────────────────────────
  // Identical control/pattern to renderMatTypeFilterBar() above, just sourced
  // from the literal "Material Group Name" column instead of getValuationType().
  // Anchored right after the Material Type filter bar so the two sit
  // together in the filter row.
  function renderMatGroupFilterBar(groups, dataAvailable) {
    const mtOuter = document.getElementById("reqan-mattype-outer");
    const statusEl = document.getElementById("reqan-status-filter");
    const anchor = mtOuter || statusEl;
    if (!anchor || !anchor.parentElement) return;

    let outer = document.getElementById("reqan-matgroup-outer");
    if (!outer) {
      outer = document.createElement("div");
      outer.id = "reqan-matgroup-outer";
      outer.style.cssText =
        "display:inline-flex;flex-direction:column;gap:5px;margin-left:0.5rem;vertical-align:bottom;min-width:170px;";
      outer.innerHTML =
        `<div class="nav-label" style="font-size:var(--fs-2xs)">Material Group</div>` +
        `<div class="ms-wrap" id="reqan-matgroup-wrap" style="min-width:0;width:100%">` +
          `<button class="ms-btn" type="button" style="width:100%">All Material Groups <span class="ms-arrow">▾</span></button>` +
          `<div class="ms-dropdown" id="reqan-matgroup-dd"></div>` +
        `</div>`;
      anchor.parentElement.insertBefore(outer, anchor.nextSibling);
    }
    const wrap = document.getElementById("reqan-matgroup-wrap");
    const btn  = wrap ? wrap.querySelector(".ms-btn") : null;

    let note = document.getElementById("reqan-matgroup-note");
    if (!dataAvailable) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "";
        btn.innerHTML = "Unavailable <span class=\"ms-arrow\">▾</span>";
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
      }
      if (!note) {
        note = document.createElement("div");
        note.id = "reqan-matgroup-note";
        note.style.cssText = "font-size:var(--fs-2xs);color:var(--dim);max-width:220px;line-height:1.3;";
        note.textContent = "Load the main inventory file to enable filtering by Material Group.";
        outer.appendChild(note);
      }
      return;
    }
    if (note) note.remove();
    if (btn) { btn.disabled = false; btn.style.opacity = ""; btn.style.cursor = ""; }

    buildMultiSelect("reqan-matgroup-wrap", "reqan-matgroup-dd", groups, "All Material Groups");
    const dd = document.getElementById("reqan-matgroup-dd");
    if (dd) {
      dd.querySelectorAll(".ms-item input").forEach(cb => {
        cb.checked = reqMatGroupFilter.has(cb.value);
      });
    }
    if (wrap._refreshOptions) wrap._refreshOptions();
  }

  // ── COPY SELECTED CODES TOOLBAR ─────────────────────────────────────────────
  // Lets users click individual material-code cells — across ALL 4 tabs
  // (Request vs Stock, Suggested Code Corrections, HO01 Stockout, HO01 Not
  // Requested) — to build up a multi-code selection, then copy just those
  // codes (one per line) to the clipboard. Clicking is scoped to the
  // .col-mat-code-wrap cell (or the specific .col-mat-code span, for cells
  // that hold more than one code, like Suggested Code Corrections' "X or Y"
  // list), so it never grabs Description/Qty/SOH text from other columns the
  // way click-dragging across a row would. Selection is shared across tabs
  // (tracked in reqCodeCopySelection by code text, not DOM identity or tab),
  // so you can pick codes from more than one tab and copy them together —
  // every tab's toolbar shows the same live count.
  const REQ_CODE_TABLE_IDS = ["reqan-table-all", "reqan-table-suggest", "reqan-table-stockout", "reqan-table-notreq", "reqan-table-mos"];

  function renderCopyCodesToolbars() {
    REQ_CODE_TABLE_IDS.forEach(id => {
      const tableEl = document.getElementById(id);
      if (!tableEl || !tableEl.parentElement) return;
      let bar = document.getElementById(id + "-copybar");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = id + "-copybar";
        bar.className = "reqan-copycode-bar";
        bar.style.cssText =
          "display:none;align-items:center;gap:0.6rem;margin-bottom:0.6rem;" +
          "padding:0.5rem 0.75rem;background:var(--surface2);border:1px solid var(--border2);" +
          "border-radius:var(--radius-sm);font-size:0.78rem;";
        bar.innerHTML =
          `<span class="reqan-copycode-count" style="color:var(--text);font-weight:600"></span>` +
          `<button class="reqan-copycode-btn dl-btn" type="button" style="padding:3px 12px">⧉ Copy Codes</button>` +
          `<button class="reqan-copycode-clear" type="button" style="background:none;border:none;color:var(--blue);cursor:pointer;font-size:0.76rem;padding:0">Clear selection</button>` +
          `<span style="color:var(--dim);font-size:0.72rem;margin-left:auto">Tip: click a code to select it — click again to deselect. Selection carries across tabs.</span>`;
        tableEl.parentElement.insertBefore(bar, tableEl);
      }
    });
    updateCopyCodesToolbars();
  }

  function updateCopyCodesToolbars() {
    const n = reqCodeCopySelection.size;
    document.querySelectorAll(".reqan-copycode-bar").forEach(bar => {
      bar.style.display = n > 0 ? "flex" : "none";
      const countEl = bar.querySelector(".reqan-copycode-count");
      if (countEl) countEl.textContent = `${n} code${n === 1 ? "" : "s"} selected`;
    });
  }

  // Re-applies the "picked" highlight to whichever code cells/spans (by
  // text, not DOM identity) are currently in reqCodeCopySelection — needed
  // every time buildTable() replaces a table's innerHTML. Highlights the
  // specific .col-mat-code span when a cell holds more than one code (e.g.
  // Suggested Code Corrections' "X or Y" cells), otherwise the whole cell.
  function applyCopySelectionHighlight() {
    const sel = REQ_CODE_TABLE_IDS.map(id => `#${id} td.col-mat-code-wrap`).join(", ");
    document.querySelectorAll(sel).forEach(td => {
      td.style.cursor = "pointer";
      const spans = td.querySelectorAll(".col-mat-code");
      const targets = spans.length ? [...spans] : [td];
      targets.forEach(el => {
        const code = el.textContent.trim();
        const picked = reqCodeCopySelection.has(code);
        el.style.background = picked ? "var(--accent-glow)" : "";
        el.style.outline = picked ? "1px solid var(--blue)" : "";
        el.style.borderRadius = picked ? "3px" : "";
        el.title = picked ? "Click to deselect" : "Click to select for copying";
      });
    });
  }

  // Copies text to the clipboard, falling back to a hidden textarea +
  // execCommand for browsers/contexts where navigator.clipboard is
  // unavailable (e.g. non-HTTPS).
  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopyToClipboard(text));
    } else {
      fallbackCopyToClipboard(text);
    }
  }
  function fallbackCopyToClipboard(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (err) { /* no-op */ }
    document.body.removeChild(ta);
  }

  // ── SMALL HELPERS ──────────────────────────────────────────────────────────
  function reqStatusBadge(status) {
    const M = {
      "ok":        { bg: "rgba(48,168,95,0.14)",  color: "var(--green,#30a85f)", label: "✓ In Stock at HO01" },
      "stockout":  { bg: "rgba(220,38,38,0.14)",  color: "var(--red)",           label: "🚫 HO01 Stockout" },
      "no-match":  { bg: "rgba(120,120,120,0.14)",color: "var(--muted)",         label: "❓ No SAP Match" },
    };
    const s = M[status] || M["no-match"];
    return `<span style="display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:0.72rem;font-weight:700;white-space:nowrap;background:${s.bg};color:${s.color}">${s.label}</span>`;
  }

  function fmtReqDate(d) {
    if (typeof fmtLocalDate === "function" && d instanceof Date && !isNaN(d)) return fmtLocalDate(d);
    return d instanceof Date && !isNaN(d) ? d.toLocaleDateString() : "—";
  }

  function reqKpi(label, value, sub, color) {
    return (typeof kpiCard === "function")
      ? kpiCard(label, value, sub, color)
      : `<div class="kpi-card ${color}"><div class="kpi-label">${escHtml(label)}</div><div class="kpi-value">${escHtml(String(value))}</div><div class="kpi-sub">${escHtml(sub)}</div></div>`;
  }

  // ── RENDER ─────────────────────────────────────────────────────────────────
  function renderRequestAnalysis() {
    const emptyEl   = document.getElementById("reqan-empty");
    const noInvEl   = document.getElementById("reqan-no-inventory");
    const contentEl = document.getElementById("reqan-content");
    if (!emptyEl || !contentEl) return;

    if (!reqRows.length) {
      emptyEl.style.display   = "block";
      noInvEl.style.display   = "none";
      contentEl.style.display = "none";
      return;
    }
    emptyEl.style.display = "none";

    if (typeof rawDf === "undefined" || !rawDf.length) {
      noInvEl.style.display   = "block";
      contentEl.style.display = "none";
      return;
    }
    noInvEl.style.display   = "none";
    contentEl.style.display = "block";

    const searchEl = document.getElementById("reqan-search");
    const statusEl = document.getElementById("reqan-status-filter");
    const clsEl    = document.getElementById("reqan-program-class");
    if (typeof applyProgramClassAccessToSelect === "function") applyProgramClassAccessToSelect(clsEl);
    const searchQ  = searchEl ? searchEl.value.trim().toLowerCase() : "";
    const statusF  = statusEl ? statusEl.value : "";
    const clsF     = clsEl ? clsEl.value : "";

    const {
      rows, ho01NotRequested, ho01NotRequestedAll, mosDataLoaded,
      availableMatTypes, matTypeDataAvailable,
      availableMatGroups, matGroupDataAvailable,
      mosEvalAvailable,
    } = buildRequestAnalysis();

    renderMatTypeFilterBar(availableMatTypes, matTypeDataAvailable);
    renderMatGroupFilterBar(availableMatGroups, matGroupDataAvailable);

    const matches = r => {
      if (!searchQ) return true;
      return r.material.toLowerCase().includes(searchQ)
          || (r.canonical || "").toLowerCase().includes(searchQ)
          || (r.desc || "").toLowerCase().includes(searchQ);
    };

    // Material Type filter (ZME, ZMS…) — multi-select, applies to all 4
    // tabs. Empty selection = no filtering.
    const matTypeActive = reqMatTypeFilter.size > 0;
    const matTypeMatches = r => !matTypeActive || reqMatTypeFilter.has(r.materialType);

    // Material Group filter — same shape as Material Type, applies to all 4 tabs.
    const matGroupActive = reqMatGroupFilter.size > 0;
    const matGroupMatches = r => !matGroupActive || reqMatGroupFilter.has(r.materialGroup);

    // "Assigned to" = the same global sidebar person filter used everywhere
    // else in the app (who-responsible.js, dashboard, expiry-risk, etc.) —
    // NOT the request file's "Created By" column. Applies to every tab here,
    // since it's a property of the MATERIAL, not of the request line.
    const personActive = typeof personFilter !== "undefined" && personFilter.size > 0;
    const personMatches = r => !personActive || (r.person && personFilter.has(r.person));

    // Program Classification (CDSS/Reportable) filter — same "reqan-program-class"
    // dropdown already role-gated above via applyProgramClassAccessToSelect();
    // this is the piece that actually applies the chosen value, so the
    // control isn't display-only. Applies to every tab, same as Material
    // Type / Material Group, since classification is a property of the
    // material, not of the request line.
    const clsMatches = r => !clsF || r.programClass === clsF;

    let filteredRows = rows.filter(r => matches(r) && personMatches(r) && matTypeMatches(r) && matGroupMatches(r) && clsMatches(r));
    if (statusF) filteredRows = filteredRows.filter(r => r.status === statusF);

    const suggestionRows = rows.filter(r => r.hasSuggestion && matches(r) && personMatches(r) && matTypeMatches(r) && matGroupMatches(r) && clsMatches(r));
    const stockoutRows   = rows.filter(r => r.status === "stockout" && matches(r) && personMatches(r) && matTypeMatches(r) && matGroupMatches(r) && clsMatches(r));
    const notRequested   = ho01NotRequested.filter(r =>
      (!searchQ || r.code.toLowerCase().includes(searchQ) || (r.desc || "").toLowerCase().includes(searchQ))
      && personMatches(r) && matTypeMatches(r) && matGroupMatches(r) && clsMatches(r)
    );
    // TAB 5: MOS Evaluation — same base filter set as Tabs 2/3 (search,
    // person, Material Type/Group, Program Classification), deliberately NOT
    // gated by the HO01 status filter (statusF) — a line can be over- or
    // under-requested regardless of whether HO01 happens to have stock for
    // it right now.
    const mosEvalRows = rows.filter(r => matches(r) && personMatches(r) && matTypeMatches(r) && matGroupMatches(r) && clsMatches(r));

    // ── KPIs (PERSON-SCOPED DASHBOARD KPIS) ────────────────────────────────
    // These 6 cards used to be built off the raw, unfiltered `rows` /
    // `ho01NotRequestedAll` — so the "👤 Filtered to items assigned to X"
    // banner below claimed "every tab on this page reflects this" while the
    // dashboard numbers silently stayed plant-wide. They're now built off
    // person-scoped subsets so the cards match the tables underneath them.
    // (Search text / status / Material Type / Material Group filters are
    // deliberately NOT folded in here — this scoping is specifically for the
    // "assigned to" person filter, same as the rest of this page's tabs.)
    const personRows = rows.filter(personMatches);
    const personNotRequestedAll = ho01NotRequestedAll.filter(personMatches);

    const dupLineCount   = personRows.filter(r => r.isDuplicate).length;
    const dupGroupCount  = new Set(personRows.filter(r => r.isDuplicate).map(r => r.canonical || `__raw__${r.material.toUpperCase()}`)).size;
    const locMismatchCount = personRows.filter(r => r.locationMismatch).length;
    document.getElementById("reqan-kpis").innerHTML = [
      reqKpi("Request Lines Uploaded", personRows.length.toLocaleString(), reqFileName ? `${reqFileName} · Plant ${reqPlant}` : "", "blue"),
      reqKpi("HO01 Stockout (Requested)", personRows.filter(r => r.status === "stockout").length.toLocaleString(), "Zero HO01 stock right now", "red"),
      reqKpi("Suggested Code Corrections", personRows.filter(r => r.hasSuggestion).length.toLocaleString(), "Stock exists under a different code", "amber"),
      reqKpi("Possible Double Requests", `${dupLineCount.toLocaleString()} lines / ${dupGroupCount.toLocaleString()} items`, "Same item requested more than once — same or different code", "amber"),
      reqKpi("Storage Location Mismatches", locMismatchCount.toLocaleString(), "Cold/non-cold zone at requesting plant doesn't match HO01's zone for this material", "red"),
      reqKpi("Critical & Not Requested", notRequested.length.toLocaleString(),
        mosDataLoaded
          ? `Branch MOS < 1mo, absent from this request (${personNotRequestedAll.length.toLocaleString()} idle at HO01 in total)`
          : "Load an AMC file (MOS by Plant page) to compute this",
        "purple"),
    ].join("");

    if (!(typeof mappingTable !== "undefined" && mappingTable.size > 0)) {
      document.getElementById("reqan-mapping-banner").innerHTML =
        `<div class="alert-warning" style="margin-bottom:0.8rem;font-size:0.78rem">⚠️ No Material Standardization mapping file is loaded — code-mismatch suggestions can't be computed, and any request material code that isn't already an exact SAP code will show as "No SAP Match".</div>`;
    } else {
      document.getElementById("reqan-mapping-banner").innerHTML = "";
    }

    if (personActive) {
      const names = [...personFilter].join(", ");
      const banner = document.getElementById("reqan-mapping-banner");
      if (banner) {
        banner.innerHTML += `<div class="alert-info" style="margin-bottom:0.8rem;font-size:0.78rem">👤 Filtered to items assigned to <b>${escHtml(names)}</b> (sidebar person filter) — every tab on this page reflects this.</div>`;
      }
    }

    // ── TAB 1: Request vs Stock (side-by-side) ─────────────────────────────
    const cols1 = [
      { key: "prNum", label: "PR Num" },
      { key: "poste", label: "Poste" },
      { key: "createdBy", label: "Created By" },
      { key: "material", label: "Requested Code",
        fmt: (v, r) => r.hasSuggestion
          ? `<span class="col-mat-code">${escHtml(v)}</span><span class="mat-desc-badge" title="This stock currently sits under a different live SAP code — see Suggested Code Corrections tab">≠ CODE</span>`
          : `<span class="col-mat-code">${escHtml(v)}</span>`,
        raw: true, cellClass: "col-mat-code-wrap" },
      { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
      { key: "purchasingOrg", label: "Purchasing Org.",
        fmt: (v, r) => {
          if (!v) return "—";
          if (r.purchOrgMismatch) {
            const title = `Classification on file is ${r.programClass || "unclassified"} (${r.purchOrgActualFamily} family), but Purchasing Org. ${escHtml(v)} expects ${r.purchOrgExpectedFamily}`;
            return `<span style="display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:0.72rem;font-weight:700;white-space:nowrap;background:rgba(220,38,38,0.14);color:var(--red)" title="${title}">⚠ ${escHtml(v)} — class mismatch</span>`;
          }
          return escHtml(v);
        },
        raw: true },
      { key: "reqQty", label: "Requested Qty", fmt: v => fmtQty(v), cellClass: "col-qty" },
      { key: "reqSoh", label: "SOH (per Request File)", fmt: v => fmtQty(v), cellClass: "col-qty" },
      { key: "liveHo01", label: "SOH (HO01)",
        fmt: (v, r) => r.sohMismatch ? `<b style="color:var(--amber)">${fmtQty(v)}</b>` : fmtQty(v),
        raw: true, cellClass: "col-qty" },
      { key: "liveReqPlant", label: `SOH (${reqPlant || "Requesting Plant"})`, fmt: v => fmtQty(v), cellClass: "col-qty" },
      { key: "location", label: "Requested Location",
        fmt: (v, r) => {
          if (!v) return "—";
          if (r.locationMismatch) {
            const zone = r.storageCheckStatus === "mismatch" && r.storageCheckHo01Locations
              ? `HO01 has this material at: ${r.storageCheckHo01Locations}`
              : "Cold/non-cold zone mismatch vs HO01";
            return `<span style="display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:0.72rem;font-weight:700;white-space:nowrap;background:rgba(220,38,38,0.14);color:var(--red)" title="${escHtml(zone)}">⚠ ${escHtml(v)} — storage mismatch</span>`;
          }
          return escHtml(v);
        },
        raw: true },
      { key: "mappedDesc", label: "Description (mapped, HO01)", cellClass: "col-mat-desc-wrap" },
      { key: "qcHo01", label: "Under Quality Inspection (HO01)", fmt: v => v > 0 ? fmtQty(v) : "—", cellClass: "col-qty" },
      { key: "status", label: "Status", fmt: v => reqStatusBadge(v), raw: true },
      { key: "isDuplicate", label: "Duplicate Check",
        fmt: (v, r) => v
          ? `<span style="display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:0.72rem;font-weight:700;white-space:nowrap;background:rgba(217,119,6,0.14);color:var(--amber,#d97706)" title="${escHtml(r.duplicateSiblingsLabel)}">⚠ Requested ${r.duplicateCount}× (combined ${fmtQty(r.duplicateTotalQty)})</span>`
          : "",
        raw: true },
    ];
    document.getElementById("reqan-table-all").innerHTML = buildTable(
      filteredRows, cols1,
      (row) => row.status === "stockout" ? "row-red" : (row.hasSuggestion ? "row-amber" : ""),
      "", { id: "reqan-export-all", title: "" }
    );
    wireTableExport("reqan-export-all", filteredRows.map(r => ({
      prNum: r.prNum, poste: r.poste, createdBy: r.createdBy, material: r.material, canonical: r.canonical, desc: r.desc,
      purchasingOrg: r.purchasingOrg || "", purchOrgMismatch: r.purchOrgMismatch ? "Yes" : "No",
      reqQty: r.reqQty, reqSoh: r.reqSoh, liveHo01: r.liveHo01, liveReqPlant: r.liveReqPlant,
      location: r.location, locationMismatch: r.locationMismatch ? "Yes" : "No",
      storageCheckStatus: r.storageCheckStatus, storageCheckHo01Locations: r.storageCheckHo01Locations,
      mappedDesc: r.mappedDesc, qcHo01: r.qcHo01,
      deliveryDate: fmtReqDate(r.deliveryDate), status: r.status,
      isDuplicate: r.isDuplicate ? "Yes" : "No", duplicateCount: r.duplicateCount,
      duplicateTotalQty: r.duplicateTotalQty, duplicateSiblingsLabel: r.duplicateSiblingsLabel,
    })), [
      { key: "prNum", label: "Purchase Req Num" }, { key: "poste", label: "Poste" },
      { key: "createdBy", label: "Created By" },
      { key: "material", label: "Requested Code" }, { key: "canonical", label: "Resolved SAP Code" },
      { key: "desc", label: "Description" },
      { key: "purchasingOrg", label: "Purchasing Org." },
      { key: "purchOrgMismatch", label: "Purchasing Org. vs Classification Mismatch?" },
      { key: "reqQty", label: "Requested Quantity" },
      { key: "reqSoh", label: "Stock on Hand (Request File)" }, { key: "liveHo01", label: "Stock on Hand (HO01)" },
      { key: "liveReqPlant", label: `Stock on Hand (${reqPlant || "Requesting Plant"})` },
      { key: "location", label: "Requested Location" },
      { key: "locationMismatch", label: "Storage Zone Mismatch? (Cold vs Non-Cold, Plant vs HO01)" },
      { key: "storageCheckStatus", label: "Storage Check Status" },
      { key: "storageCheckHo01Locations", label: "HO01 Storage Location(s) For This Material" },
      { key: "mappedDesc", label: "Description (mapped, HO01)" },
      { key: "qcHo01", label: "Under Quality Inspection (HO01)" },
      { key: "deliveryDate", label: "Delivery Date" }, { key: "status", label: "Status" },
      { key: "isDuplicate", label: "Possible Duplicate?" }, { key: "duplicateCount", label: "Times Requested" },
      { key: "duplicateTotalQty", label: "Combined Requested Qty" }, { key: "duplicateSiblingsLabel", label: "Other Lines (Same Item)" },
    ], "request_analysis_all_lines");

    // ── TAB 2: Suggested Code Corrections ───────────────────────────────────
    const cols2 = [
      { key: "prNum", label: "PR Num" },
      { key: "material", label: "Code As Requested", cellClass: "col-mat-code-wrap" },
      { key: "shortText", label: "Description (as requested)" },
      { key: "suggestedCode", label: "Request Under This SAP Code Instead",
        // suggestedCode is a string like "115-ZOLE-0301-01 (120) or 115-ZOLE-0301-02 (15)" —
        // each is a real, live SAP code with its OWN native-unit quantity, not the
        // standardized/mapped code. Split it back apart just for per-code styling.
        fmt: v => String(v || "").split(" or ").map(part => {
          const m = part.match(/^(.*)\s\((.*)\)$/);
          const code = m ? m[1] : part;
          const qty  = m ? m[2] : "";
          return `<span class="col-mat-code mat-code-clickable">${escHtml(code)}</span>` +
                 (qty ? `<span class="mat-mapped-badge" title="Live HO01 stock under this exact SAP code">${escHtml(qty)}</span>` : "");
        }).join(' <span style="opacity:0.6">or</span> '),
        raw: true, cellClass: "col-mat-code-wrap" },
      { key: "suggestedDesc", label: "Description" },
      { key: "purchasingOrg", label: "Purchasing Org.",
        fmt: (v, r) => {
          if (!v) return "—";
          if (r.purchOrgMismatch) {
            const title = `Classification on file is ${r.programClass || "unclassified"} (${r.purchOrgActualFamily} family), but Purchasing Org. ${escHtml(v)} expects ${r.purchOrgExpectedFamily}`;
            return `<span style="display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:0.72rem;font-weight:700;white-space:nowrap;background:rgba(220,38,38,0.14);color:var(--red)" title="${title}">⚠ ${escHtml(v)} — class mismatch</span>`;
          }
          return escHtml(v);
        },
        raw: true },
      { key: "suggestedTotal", label: "Combined HO01 Stock (Suggested Codes)", fmt: v => fmtQty(v), cellClass: "col-qty" },
      { key: "reqQty", label: "Requested Qty", fmt: v => fmtQty(v), cellClass: "col-qty" },
    ];
    document.getElementById("reqan-table-suggest").innerHTML = buildTable(
      suggestionRows, cols2, () => "row-amber", "", { id: "reqan-export-suggest", title: "" }
    );
    wireTableExport("reqan-export-suggest", suggestionRows.map(r => ({
      prNum: r.prNum, material: r.material, shortText: r.shortText,
      suggestedCode: r.suggestedCode, suggestedDesc: r.suggestedDesc,
      purchasingOrg: r.purchasingOrg || "", purchOrgMismatch: r.purchOrgMismatch ? "Yes" : "No",
      suggestedTotal: r.suggestedTotal, reqQty: r.reqQty,
    })), [
      { key: "prNum", label: "Purchase Req Num" }, { key: "material", label: "Code As Requested" },
      { key: "shortText", label: "Description (as requested)" }, { key: "suggestedCode", label: "Request Under This SAP Code Instead" },
      { key: "suggestedDesc", label: "Description" },
      { key: "purchasingOrg", label: "Purchasing Org." },
      { key: "purchOrgMismatch", label: "Purchasing Org. vs Classification Mismatch?" },
      { key: "suggestedTotal", label: "Combined HO01 Stock (Suggested Codes)" },
      { key: "reqQty", label: "Requested Qty" },
    ], "request_analysis_suggested_codes");

    // ── TAB 3: HO01 Stockout but Requested ──────────────────────────────────
    const cols3 = [
      { key: "prNum", label: "PR Num" },
      { key: "poste", label: "Poste" },
      { key: "canonical", label: "Material Code", cellClass: "col-mat-code-wrap" },
      { key: "desc", label: "Description" },
      { key: "purchasingOrg", label: "Purchasing Org.",
        fmt: (v, r) => {
          if (!v) return "—";
          if (r.purchOrgMismatch) {
            const title = `Classification on file is ${r.programClass || "unclassified"} (${r.purchOrgActualFamily} family), but Purchasing Org. ${escHtml(v)} expects ${r.purchOrgExpectedFamily}`;
            return `<span style="display:inline-block;padding:0.15rem 0.55rem;border-radius:999px;font-size:0.72rem;font-weight:700;white-space:nowrap;background:rgba(220,38,38,0.14);color:var(--red)" title="${title}">⚠ ${escHtml(v)} — class mismatch</span>`;
          }
          return escHtml(v);
        },
        raw: true },
      { key: "reqQty", label: "Requested Qty", fmt: v => fmtQty(v), cellClass: "col-qty" },
      { key: "deliveryDate", label: "Delivery Date", fmt: v => fmtReqDate(v) },
    ];
    document.getElementById("reqan-table-stockout").innerHTML = buildTable(
      stockoutRows, cols3, () => "row-red", "", { id: "reqan-export-stockout", title: "" }
    );
    wireTableExport("reqan-export-stockout", stockoutRows.map(r => ({
      prNum: r.prNum, poste: r.poste, canonical: r.canonical, desc: r.desc,
      purchasingOrg: r.purchasingOrg || "", purchOrgMismatch: r.purchOrgMismatch ? "Yes" : "No",
      reqQty: r.reqQty, deliveryDate: fmtReqDate(r.deliveryDate),
    })), [
      { key: "prNum", label: "Purchase Req Num" }, { key: "poste", label: "Poste" },
      { key: "canonical", label: "Material Code" }, { key: "desc", label: "Description" },
      { key: "purchasingOrg", label: "Purchasing Org." },
      { key: "purchOrgMismatch", label: "Purchasing Org. vs Classification Mismatch?" },
      { key: "reqQty", label: "Requested Qty" }, { key: "deliveryDate", label: "Delivery Date" },
    ], "request_analysis_ho01_stockout");

    // ── TAB 4: HO01 Stock Not Requested (branch-critical only) ─────────────
    if (!mosDataLoaded) {
      document.getElementById("reqan-table-notreq").innerHTML =
        `<div class="alert-warning" style="margin:0.8rem 0;font-size:0.8rem">⚠️ No AMC file is loaded, so branch consumption (MOS) can't be computed. This list only shows HO01 stock that's absent from the request AND critical (branch MOS &lt; 1 month) — load an AMC file on the "📐 MOS by Plant" page, then come back here.</div>`;
    } else {
      const cols4 = [
        { key: "code", label: "Material Code", cellClass: "col-mat-code-wrap" },
        { key: "desc", label: "Description" },
        { key: "qty", label: "HO01 Stock on Hand", fmt: v => fmtQty(v), cellClass: "col-qty" },
        { key: "criticalBranches", label: "Critical At (Branch MOS < 1mo)",
          fmt: v => v.map(c => `<span style="display:inline-block;margin:1px 3px 1px 0;padding:0.1rem 0.4rem;border-radius:999px;font-size:0.7rem;font-weight:700;background:rgba(220,38,38,0.14);color:var(--red)">${escHtml(c.plant)} · ${c.mos === Infinity ? "∞" : Number(c.mos).toFixed(1)}mo</span>`).join(""),
          raw: true },
      ];
      document.getElementById("reqan-table-notreq").innerHTML = buildTable(
        notRequested, cols4, () => "row-red", "", { id: "reqan-export-notreq", title: "" }
      );
      wireTableExport("reqan-export-notreq", notRequested.map(r => ({
        code: r.code, desc: r.desc,
        qty: r.qty,
        criticalBranches: r.criticalBranches.map(c => `${c.plant} (${c.mos === Infinity ? "Infinite" : Number(c.mos).toFixed(2)}mo)`).join("; "),
      })), [
        { key: "code", label: "Material Code" }, { key: "desc", label: "Description" },
        { key: "qty", label: "HO01 Stock on Hand" },
        { key: "criticalBranches", label: "Critical At (Branch MOS < 1mo)" },
      ], "request_analysis_ho01_not_requested");
    }

    // ── TAB 5: MOS Evaluation (2–4 Month Window) ────────────────────────────
    // Judges each request line's QUANTITY — not just whether HO01 has stock
    // for it — against the same TARGET_MOS(4)/REQUEST_ELIGIBILITY_MOS(2)
    // window Branch Demand fills branches to, netting out anything already
    // in transit (Open Outbound) exactly the way brdComputeMaterialAllocation()
    // does. See classifyMosVerdict() near the top of this file for the
    // verdict rules.
    if (!mosEvalAvailable) {
      document.getElementById("reqan-table-mos").innerHTML =
        `<div class="alert-warning" style="margin:0.8rem 0;font-size:0.8rem">⚠️ No AMC file is loaded, so branch consumption (MOS) can't be computed. Load an AMC file on the "📐 MOS by Plant" page, then come back here to evaluate whether each requested quantity fits the ${REQAN_ELIGIBILITY_MOS}–${REQAN_TARGET_MOS} month target window.</div>`;
      const mosKpiEl = document.getElementById("reqan-mos-kpis");
      if (mosKpiEl) mosKpiEl.innerHTML = "";
    } else {
      const countBy = key => mosEvalRows.filter(r => r.mosVerdictKey === key).length;
      const mosKpiEl = document.getElementById("reqan-mos-kpis");
      if (mosKpiEl) {
        mosKpiEl.innerHTML = [
          reqKpi("Justified", countBy("justified").toLocaleString(), `Within the ${REQAN_ELIGIBILITY_MOS}–${REQAN_TARGET_MOS} month target window`, "green"),
          reqKpi("Over-Requested", countBy("over").toLocaleString(), `Would push branch above ${REQAN_TARGET_MOS} months`, "amber"),
          reqKpi("Under-Requested", countBy("under").toLocaleString(), `Leaves branch short of the ${REQAN_TARGET_MOS}-month target`, "blue"),
          reqKpi("Not Eligible — Overstocked", countBy("overstocked").toLocaleString(), `Branch already at/above ${REQAN_TARGET_MOS} months`, "red"),
          reqKpi("No AMC Data", countBy("no-amc").toLocaleString(), "Can't evaluate — no branch AMC commitment on file", "purple"),
        ].join("");
      }

      const cols5 = [
        { key: "prNum", label: "PR Num" },
        { key: "canonical", label: "Material Code", cellClass: "col-mat-code-wrap" },
        { key: "desc", label: "Description" },
        { key: "reqQty", label: "Requested Qty", fmt: v => fmtQty(v), cellClass: "col-qty" },
        { key: "liveReqPlant", label: `${reqPlant || "Branch"} SOH (Now)`, fmt: v => fmtQty(v), cellClass: "col-qty" },
        { key: "branchAmc", label: "Branch AMC",
          fmt: (v, r) => r.hasAmc ? fmtQty(v) : mosNABadge(), raw: true, cellClass: "col-qty" },
        { key: "mosNow", label: "Current MOS",
          fmt: (v, r) => r.hasAmc ? fmtMosVal(v) : mosNABadge(), raw: true, cellClass: "col-qty" },
        { key: "outboundToBranch", label: "Already In Transit (Open Outbound)",
          fmt: v => v > 0 ? fmtQty(v) : "—", cellClass: "col-qty" },
        { key: "targetNeed", label: `Target Need (to ${REQAN_TARGET_MOS}mo)`,
          fmt: (v, r) => r.hasAmc ? fmtQty(v) : "—", cellClass: "col-qty" },
        { key: "projectedMos", label: "Projected MOS After Request",
          fmt: (v, r) => r.hasAmc ? fmtMosVal(v) : mosNABadge(), raw: true, cellClass: "col-qty" },
        { key: "mosVerdictLabel", label: "Verdict",
          fmt: (v, r) => reqMosVerdictBadge(r), raw: true },
      ];
      document.getElementById("reqan-table-mos").innerHTML = buildTable(
        mosEvalRows, cols5,
        (row) => row.mosVerdictKey === "overstocked" ? "row-red" : (row.mosVerdictKey === "over" ? "row-amber" : (row.mosVerdictKey === "under" ? "row-blue" : "")),
        "", { id: "reqan-export-mos", title: "" }
      );
      wireTableExport("reqan-export-mos", mosEvalRows.map(r => ({
        prNum: r.prNum, canonical: r.canonical, desc: r.desc, reqQty: r.reqQty,
        branchSoh: r.liveReqPlant, branchAmc: r.hasAmc ? r.branchAmc : "N/A",
        mosNow: r.hasAmc ? (r.mosNow === Infinity ? "Infinite" : Number(r.mosNow).toFixed(2)) : "N/A",
        outboundToBranch: r.outboundToBranch,
        targetNeed: r.hasAmc ? r.targetNeed : "N/A",
        projectedMos: r.hasAmc ? (r.projectedMos === Infinity ? "Infinite" : Number(r.projectedMos).toFixed(2)) : "N/A",
        verdict: r.mosVerdictLabel, verdictDetail: r.mosVerdictDetail,
      })), [
        { key: "prNum", label: "Purchase Req Num" }, { key: "canonical", label: "Material Code" },
        { key: "desc", label: "Description" }, { key: "reqQty", label: "Requested Qty" },
        { key: "branchSoh", label: `${reqPlant || "Branch"} SOH (Now)` }, { key: "branchAmc", label: "Branch AMC" },
        { key: "mosNow", label: "Current MOS" },
        { key: "outboundToBranch", label: "Already In Transit (Open Outbound)" },
        { key: "targetNeed", label: `Target Need (to ${REQAN_TARGET_MOS}mo)` },
        { key: "projectedMos", label: "Projected MOS After Request" },
        { key: "verdict", label: "Verdict" }, { key: "verdictDetail", label: "Verdict Detail" },
      ], "request_analysis_mos_evaluation");
    }

    // FEAT-COPY-CODES: (re)build the toolbar for every tab that has a code
    // column and re-apply highlighting, since buildTable() just replaced
    // each table's DOM. Done once here (not per-tab above) since all 5
    // table elements exist by this point in the render.
    renderCopyCodesToolbars();
    applyCopySelectionHighlight();

    // ── Tab counts (badges in tab labels) ───────────────────────────────────
    setTabCount("reqan-tab-count-all", filteredRows.length);
    setTabCount("reqan-tab-count-suggest", suggestionRows.length);
    setTabCount("reqan-tab-count-stockout", stockoutRows.length);
    setTabCount("reqan-tab-count-notreq", mosDataLoaded ? notRequested.length : 0);
    setTabCount("reqan-tab-count-mos", mosEvalAvailable ? mosEvalRows.length : 0);
  }

  function setTabCount(id, n) {
    const el = document.getElementById(id);
    if (el) el.textContent = n.toLocaleString();
  }

  // ── TAB SWITCHING ──────────────────────────────────────────────────────────
  function switchTab(tab) {
    document.querySelectorAll(".reqan-tab-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll(".reqan-tab-panel").forEach(p => {
      p.style.display = p.id === `reqan-tab-${tab}` ? "block" : "none";
    });
  }

  // ── WIRING ─────────────────────────────────────────────────────────────────
  function wire() {
    const fileInput = document.getElementById("requestAnalysisFileInput");
    if (fileInput) {
      fileInput.addEventListener("change", e => {
        const f = e.target.files[0];
        if (f) loadRequestFile(f);
        e.target.value = "";
      });
    }

    document.body.addEventListener("click", (e) => {
      if (e.target.closest("#reqan-clear-file")) { e.preventDefault(); clearRequestFile(); return; }

      const tabBtn = e.target.closest(".reqan-tab-btn");
      if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }

      if (e.target.id === "reqan-apply") { renderRequestAnalysis(); return; }
      if (e.target.id === "reqan-clear") {
        const s = document.getElementById("reqan-search"); if (s) s.value = "";
        const st = document.getElementById("reqan-status-filter"); if (st) st.value = "";
        const cl = document.getElementById("reqan-program-class"); if (cl) cl.value = "";
        reqMatTypeFilter.clear();
        const mtWrap = document.getElementById("reqan-mattype-wrap");
        if (mtWrap && mtWrap._clearSelected) mtWrap._clearSelected();
        reqMatGroupFilter.clear();
        const mgWrap = document.getElementById("reqan-matgroup-wrap");
        if (mgWrap && mgWrap._clearSelected) mgWrap._clearSelected();
        renderRequestAnalysis();
        return;
      }
      // Open/close and outside-click-to-close for the Material Type dropdown
      // are handled by buildMultiSelect()'s own listeners (same as every
      // other .ms-wrap control in the app) — nothing to wire here.

      // FEAT-COPY-CODES: click a material-code cell (any of the 4 tabs) to
      // toggle it into the copy selection — scoped to just the code
      // cell/span, so clicking never grabs Description/Qty/SOH from other
      // columns the way a click-drag text selection across the row would.
      // For cells holding more than one code (Suggested Code Corrections'
      // "X or Y" list), the specific .col-mat-code span clicked is used so
      // the two codes in that cell can be selected independently.
      const codeCell = e.target.closest(REQ_CODE_TABLE_IDS.map(id => `#${id} td.col-mat-code-wrap`).join(", "));
      if (codeCell) {
        const codeSpan = e.target.closest(".col-mat-code") || codeCell.querySelector(".col-mat-code");
        const code = (codeSpan ? codeSpan.textContent : codeCell.textContent).trim();
        if (code) {
          if (reqCodeCopySelection.has(code)) reqCodeCopySelection.delete(code);
          else reqCodeCopySelection.add(code);
          applyCopySelectionHighlight();
          updateCopyCodesToolbars();
        }
        return;
      }
      if (e.target.classList && e.target.classList.contains("reqan-copycode-btn")) {
        copyTextToClipboard([...reqCodeCopySelection].join("\n"));
        const btn = e.target;
        const original = btn.textContent;
        btn.textContent = "✓ Copied";
        setTimeout(() => { btn.textContent = original; }, 1200);
        return;
      }
      if (e.target.classList && e.target.classList.contains("reqan-copycode-clear")) {
        reqCodeCopySelection.clear();
        applyCopySelectionHighlight();
        updateCopyCodesToolbars();
        return;
      }
    });

    document.body.addEventListener("change", (e) => {
      // Material Type filter — checkbox lives inside the shared .ms-dropdown
      // control built by buildMultiSelect(); sync our Set from whatever's
      // currently checked and re-render.
      if (e.target.closest && e.target.closest("#reqan-mattype-dd") && e.target.type === "checkbox") {
        const wrap = document.getElementById("reqan-mattype-wrap");
        const selected = wrap && wrap._getSelected ? wrap._getSelected() : [];
        reqMatTypeFilter = new Set(selected);
        renderRequestAnalysis();
      }
      if (e.target.closest && e.target.closest("#reqan-matgroup-dd") && e.target.type === "checkbox") {
        const wrap = document.getElementById("reqan-matgroup-wrap");
        const selected = wrap && wrap._getSelected ? wrap._getSelected() : [];
        reqMatGroupFilter = new Set(selected);
        renderRequestAnalysis();
      }
    });

    const searchInput = document.getElementById("reqan-search");
    if (searchInput) {
      searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") renderRequestAnalysis(); });
    }

    // Re-render if already on this page when inventory or mapping data changes.
    const mainFileInput = document.getElementById("fileInput");
    if (mainFileInput) {
      mainFileInput.addEventListener("change", () => {
        setTimeout(() => { if (currentPage === "request-analysis") renderRequestAnalysis(); }, 300);
      });
    }
    const mappingInput = document.getElementById("mappingFileInput");
    if (mappingInput) {
      mappingInput.addEventListener("change", () => {
        setTimeout(() => { if (currentPage === "request-analysis") renderRequestAnalysis(); }, 300);
      });
    }
    // Re-render when the global "assigned to" sidebar person filter changes
    // (same dropdown who-responsible.js's "View all of X's items" button
    // drives), so this page's tabs stay scoped to whoever is selected there.
    const personFilterEl = document.getElementById("global-person-filter");
    if (personFilterEl) {
      personFilterEl.addEventListener("change", () => {
        if (currentPage === "request-analysis") renderRequestAnalysis();
      });
    }

    // SEC-ACCESS-GATE: this module used to monkey-patch window.renderPage
    // with its own unguarded branch for "request-analysis" (to let it
    // render before rawDf was loaded), which bypassed the
    // canAccessModule() permission check in the real renderPage()
    // (script.js) entirely. renderPage() now has its own rawDf exemption
    // for this page id, so registering into PAGE_RENDERERS is all that's
    // needed here.
    if (typeof PAGE_RENDERERS !== "undefined") {
      PAGE_RENDERERS["request-analysis"] = renderRequestAnalysis;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
