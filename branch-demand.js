// =============================================================================
// PharmaTrack v2 — branch-demand.js
// "Branch Demand" (Branch Request Helper) — module key: branch-demand
//
// PURPOSE
// -------
// Helps branches and supply specialists:
//   1. Look up branch SOH and Head Office (HO01) SOH per material.
//   2. Compute how much a branch should request so that
//      SOH_branch + request ≈ TARGET_MOS (5) months of AMC.
//   3. When HO01 stock is insufficient to cover every requesting branch,
//      allocate it fairly (proportional to need) instead of zeroing everyone.
//   4. Let a supervisor approve lines and export a SAP requisition template
//      (existing/source material codes + conversion factor) for copy-paste
//      into SAP.
//
// STOCK TYPE (RDF vs Health Program) → Storage Location / Purchasing Group /
// Purch. Organization
// ---------------------------------------------------------------------------
//   A requisition line's SAP header fields are NOT free text — they're
//   derived from the material's own classification plus the destination
//   branch's stock records, per this rule set (see request-analysis.js /
//   Request Analysis tab for the same Q-vs-R classification used here):
//
//     Stock Type prefix (from "Special Stock Type" on the underlying SAP
//     row, same logic as getRowScopeCode() in permissions.js):
//       Special Stock Type "Q"  → prefix "Q" (Health Program Drugs)
//       Special Stock Type else → prefix "R" (RDF Drugs)
//
//     Purchasing Group = prefix + Inventory Valuation Type suffix:
//       R_ZME → RD1   Q_ZME → HP1
//       R_ZMS → RD2   Q_ZMS → HP2
//       R_ZLC → RD3   Q_ZLC → HP3
//       R_ZMD → RD4   Q_ZMD → HP4
//     (see PURCHASING_GROUP_MAP below)
//
//     Purch. Organization = RD01 for any RDF (R-prefix) item, HP02 for any
//     Health Program (Q-prefix) item (see PURCH_ORG_MAP below).
//
//     Storage Location = the storage location the material is (or, for a
//     brand-new line, would be) held in AT THE REQUESTING BRANCH PLANT —
//     never HO01's own storage location. Resolved by looking at the
//     branch's own stock rows for that material; if the branch has never
//     stocked it before, we fall back to the storage location most
//     commonly used at that branch for other materials of the same Q/R +
//     valuation-type classification, and flag the line as "inferred" so a
//     human can double-check before approving. See brdStorageLocationForBranch().
//
//   Because RDF and Health Program lines take different Purchasing Group /
//   Purch. Organization codes, the Branch Demand toolbar has a Stock Type
//   filter (brd-stocktype) so a user works — and exports — one stock type
//   at a time rather than a mixed sheet.
//
// FORMULAS (do not change without updating the spec doc / manual test list)
// ---------------------------------------------------------------------------
//   need_b        = max(0, TARGET_MOS * AMC_b - SOH_b)           [rule 1]
//   available_HO  = max(0, SOH_HO01 - buffer)                    [rule 3]
//   total_need    = Σ need_b over every REQUESTING branch for this material
//   if total_need == 0        → alloc_b = 0
//   if total_need <= avail_HO → alloc_b = need_b                 (HO enough)
//   else                      → alloc_b = need_b * (avail_HO / total_need),
//                                capped at need_b                 [rule 4]
//   Rounded to whole units via the "largest remainder" method so
//   Σ alloc_b ≤ available_HO exactly, preferring to give partial > 0 over 0
//   to branches with a real (if small) need whenever HO still has stock.
//
//   REQUEST ELIGIBILITY (Request Form tab only — Analysis still shows every
//   branch × material line regardless): a branch may actually submit a
//   request for a line if and only if
//     (a) its current months of stock < REQUEST_ELIGIBILITY_MOS (3), AND
//     (b) HO01 actually has stock for it (available_HO > 0).
//   The fill TARGET stays TARGET_MOS (5) either way — eligibility only
//   gates *whether* a line is offered for request, not how much is
//   recommended once it is. Previously-approved/manually-edited lines stay
//   visible even if they no longer meet the threshold, so nothing already
//   in progress silently disappears. See brdIsRequestEligible().
//
// MAPPED vs SOURCE CODES
// -----------------------
//   All planning math above runs on the MAPPED/canonical code (same space as
//   mosMerged / mappedDf) — never on raw SAP codes directly, so branches that
//   share a standardized material line up correctly. The SAP export step
//   converts back to a SOURCE code using the mapping factor in the same
//   direction applyMaterialMapping() uses (cvQty = rawQty * factor, so
//   rawQty = cvQty / factor). When more than one source code maps to the
//   same target, v1 exports the "primary" source code — the one holding the
//   most HO01 stock right now — rather than splitting proportionally; this
//   keeps the SAP paste sheet to one line per material, which matches how a
//   requisition is normally typed in. See brdPrimarySource().
//
// Requires (must be loaded AFTER all of these):
//   script.js  (rawDf, mappedDf, mappingTable, escHtml, fmtQty, buildTable,
//               kpiCard, setKpis, canAccessRow via permissions.js, getReconciledBase)
//   mos.js     (HUB_PLANT, mosPlants, mosMerged, mosSohFor, buildMosSohMap,
//               fmtMosVal, mosCellStyle, mosNABadge)
//   permissions.js (canAccessModule, currentRole, computeIsAdmin, isDirectorLike)
// =============================================================================

const TARGET_MOS = 5; // constant for v1 — do not expose as user-editable yet
const REQUEST_ELIGIBILITY_MOS = 3; // a branch may REQUEST a line only below this MOS — see file header

// ── HO01 STOCK BREAKDOWN (Unrestricted vs Quality Inspection) ──────────────
// buildMosSohMap() (mos.js) deliberately lumps Unrestricted + verified
// Transit + QC into one "Total Quantity" figure so every other page (Branch
// Comparison, National Table, Expiry Risk, main MOS view...) agrees on the
// same SOH number. Branch Demand can't reuse that number for HO01 though:
// stock still sitting in Quality Inspection hasn't been released yet, so it
// is NOT actually available to allocate or ship to a branch. This builds a
// second, HO01-only map (canonical code -> { unrestricted, qc }) so the
// allocation math and the table can tell "usable now" apart from "exists but
// stuck in QC" — see brdComputeMaterialAllocation() and brdBuildLines().
function brdBuildHo01Breakdown() {
  const map = new Map();
  const base = (typeof getReconciledBase === "function")
    ? getReconciledBase()
    : (typeof rawDf !== "undefined" ? rawDf : []);
  if (!base.length) return map;
  for (const row of base) {
    const plt = String(row["Plant"] || "").trim().toUpperCase();
    if (plt !== HUB_PLANT) continue;
    const mat = String(row._mappedMaterial || row["Material"] || "").trim();
    if (!mat) continue;
    const unrestricted = (typeof getMappedQty === "function") ? getMappedQty(row, "Unrestricted Stock") : Number(row["Unrestricted Stock"] || 0);
    const qc            = (typeof getMappedQty === "function") ? getMappedQty(row, "Stock in Quality Inspection") : Number(row["Stock in Quality Inspection"] || 0);
    if (!map.has(mat)) map.set(mat, { unrestricted: 0, qc: 0 });
    const entry = map.get(mat);
    entry.unrestricted += Number(unrestricted) || 0;
    entry.qc            += Number(qc) || 0;
  }
  return map;
}

// ── STOCK TYPE → SAP HEADER FIELD LOOKUP TABLES (see file header) ──────────
// Keyed by the same "PREFIX_SUFFIX" scope code getRowScopeCode() produces
// (e.g. "R_ZME", "Q_ZLC") so the two stay in lockstep with the rest of the
// app's Q/RDF access-control logic instead of duplicating it.
const PURCHASING_GROUP_MAP = {
  R_ZME: "RD1", R_ZMS: "RD2", R_ZLC: "RD3", R_ZMD: "RD4",
  Q_ZME: "HP1", Q_ZMS: "HP2", Q_ZLC: "HP3", Q_ZMD: "HP4",
};
const PURCH_ORG_MAP = { R: "RD01", Q: "HP02" };
const STOCK_TYPE_LABEL = { R: "RDF", Q: "Health Program (Q)" };

// ── STATE ────────────────────────────────────────────────────────────────────
let brdSelectedPlant = "";        // "" = All Branches (only offered to roles that may see it)
let brdBuffer         = 0;        // HO01 buffer, configurable, default 0
let brdStockType      = "";       // "" = All, "R" = RDF, "Q" = Health Program — see file header
let brdCodes          = [];       // explicit user-pasted canonical/mapped codes (empty = auto-load)
// brdDraft: Map<"PLANT::CODE", { approved:boolean, manualAlloc:number|null }>
// Keyed by plant+code so edits/approvals survive a Recalculate (which only
// rebuilds the underlying computed numbers, never this map).
let brdDraft = new Map();

function brdDraftKey(plant, code) { return `${plant}::${code}`; }

// ── ROLE / CAPABILITY HELPERS ───────────────────────────────────────────────
// Per spec: branch_demand_officer gets a read-only recommendation view
// (locked to their own plant when known); team_leader/director/deputy
// director/admin get the full plant selector + multi-branch view + editing +
// approval + export. Admin/Director-like already bypass most gating
// elsewhere in the app, so we mirror that here rather than inventing a new
// rule.
function brdCanEdit() {
  return (typeof computeIsAdmin === "function" && computeIsAdmin())
      || (typeof isDirectorLike === "function" && isDirectorLike())
      || (typeof currentRole === "function" && currentRole() === "team_leader");
}
function brdCanSeeAllBranches() { return brdCanEdit(); }
// window.APP_USER doesn't carry a "plant" field in the current profile
// schema — this checks defensively so a future column drops in without a
// code change; today it will simply fall back to the plant dropdown, which
// is the explicitly-allowed v1 fallback ("if plant is known on profile, use
// it; else plant dropdown").
function brdLockedPlant() {
  return (window.APP_USER && window.APP_USER.plant) ? String(window.APP_USER.plant).trim().toUpperCase() : null;
}

// ── SOURCE-CODE / FACTOR RESOLUTION FOR SAP EXPORT ──────────────────────────
// See file header comment for the "primary source" choice rationale.
function brdPrimarySource(mappedCode) {
  if (!mappingTable || mappingTable.size === 0) {
    return { sourceCode: mappedCode, factor: 1, allSourceCodes: [mappedCode] };
  }
  const candidates = [];
  mappingTable.forEach((entry, srcCode) => {
    if (entry.targetCode === mappedCode) candidates.push({ srcCode, factor: entry.factor });
  });
  if (!candidates.length) return { sourceCode: mappedCode, factor: 1, allSourceCodes: [mappedCode] };
  if (candidates.length === 1) {
    return { sourceCode: candidates[0].srcCode, factor: candidates[0].factor, allSourceCodes: [candidates[0].srcCode] };
  }
  const base = (mappingTable.size > 0 ? mappedDf : rawDf) || [];
  const qtyBySource = {};
  base.forEach(r => {
    const plt = String(r["Plant"] || "").trim().toUpperCase();
    if (plt !== HUB_PLANT) return;
    const src = String(r["Material"] || "").trim().toUpperCase();
    if (!candidates.some(c => c.srcCode === src)) return;
    const qty = (Number(r["Unrestricted Stock"]) || 0) + (Number(r["Stock in Transit"]) || 0) + (Number(r["Stock in Quality Inspection"]) || 0);
    qtyBySource[src] = (qtyBySource[src] || 0) + qty;
  });
  let best = candidates[0], bestQty = -1;
  candidates.forEach(c => {
    const q = qtyBySource[c.srcCode] || 0;
    if (q > bestQty) { bestQty = q; best = c; }
  });
  return { sourceCode: best.srcCode, factor: best.factor, allSourceCodes: candidates.map(c => c.srcCode) };
}

// ── STOCK TYPE CLASSIFICATION (Q/RDF + valuation type) FOR ONE MATERIAL ─────
// Reuses getRowScopeCode() from permissions.js (the same function that
// drives row-level access control) so "what counts as RDF vs Health
// Program" is defined in exactly one place in the app. Falls back to an
// inline copy of that logic only if permissions.js somehow isn't loaded.
function brdScopeCodeForRow(row) {
  if (typeof getRowScopeCode === "function") return getRowScopeCode(row);
  const sst = String(row["Special Stock Type"] || "").trim().toUpperCase();
  const prefix = sst === "Q" ? "Q" : "R";
  const valType = (typeof getValuationType === "function")
    ? getValuationType(row)
    : String(row["Inventory Valuation Type"] || "").trim().toUpperCase();
  const known = ["ZME", "ZMS", "ZLC", "ZMD"];
  return known.includes(valType) ? `${prefix}_${valType}` : null;
}

// Classifies a MAPPED material code as RDF or Health Program (+ valuation
// type), by looking at its underlying source rows. When more than one
// source code (or more than one row) maps to the same target, the row
// holding the most stock at HO01 is used as the representative — same
// "primary wins" convention as brdPrimarySource() — since a mapped code is
// expected to be a single, consistent classification in practice; this
// just makes the tie-break deterministic if the data is ever messy.
// Returns { scope, prefix, suffix } — any of which may be null if no
// classifiable row can be found (e.g. code not present in the current
// upload), in which case callers should treat the line as unclassified
// rather than silently guessing RD01/HP02.
function brdMaterialScope(mappedCode) {
  const src  = brdPrimarySource(mappedCode);
  const base = (mappingTable && mappingTable.size > 0 ? mappedDf : rawDf) || [];
  const candidateRows = base.filter(r => src.allSourceCodes.includes(String(r["Material"] || "").trim().toUpperCase()));
  const hubRows = candidateRows.filter(r => String(r["Plant"] || "").trim().toUpperCase() === HUB_PLANT);
  const rows = hubRows.length ? hubRows : candidateRows;
  if (!rows.length) return { scope: null, prefix: null, suffix: null };
  let best = rows[0], bestQty = -1;
  rows.forEach(r => {
    const qty = (Number(r["Unrestricted Stock"]) || 0) + (Number(r["Stock in Transit"]) || 0) + (Number(r["Stock in Quality Inspection"]) || 0);
    if (qty > bestQty) { bestQty = qty; best = r; }
  });
  const scope = brdScopeCodeForRow(best);
  if (!scope) return { scope: null, prefix: null, suffix: null };
  const [prefix, suffix] = scope.split("_");
  return { scope, prefix, suffix };
}

// ── STORAGE LOCATION AT THE REQUESTING BRANCH (see file header) ────────────
// Best-effort fallback: the storage location most commonly used at this
// plant for OTHER materials sharing the same Q/RDF + valuation-type scope
// — used only when the branch has no existing stock record at all for this
// exact material (so there's nothing to read a real storage location from).
function brdInferStorageLocation(plant, scopeCode) {
  if (!scopeCode) return "";
  const base = (mappingTable && mappingTable.size > 0 ? mappedDf : rawDf) || [];
  const counts = {};
  base.forEach(r => {
    if (String(r["Plant"] || "").trim().toUpperCase() !== plant) return;
    const sloc = String(r["Storage Location"] || "").trim().toUpperCase();
    if (!sloc) return;
    if (brdScopeCodeForRow(r) !== scopeCode) return;
    counts[sloc] = (counts[sloc] || 0) + 1;
  });
  let best = "", bestCount = -1;
  Object.entries(counts).forEach(([sloc, c]) => { if (c > bestCount) { bestCount = c; best = sloc; } });
  return best;
}

// Resolves the Storage Location a line should use: real branch stock record
// first (picking the location holding the most stock, if the material sits
// in more than one), inferred fallback second. `inferred:true` means the
// caller should surface this for human review before the line is approved.
function brdStorageLocationForBranch(mappedCode, plant, scopeCode) {
  const src  = brdPrimarySource(mappedCode);
  const base = (mappingTable && mappingTable.size > 0 ? mappedDf : rawDf) || [];
  const branchRows = base.filter(r =>
    String(r["Plant"] || "").trim().toUpperCase() === plant &&
    src.allSourceCodes.includes(String(r["Material"] || "").trim().toUpperCase()) &&
    String(r["Storage Location"] || "").trim() !== ""
  );
  if (branchRows.length) {
    const qtyBySloc = {};
    branchRows.forEach(r => {
      const sloc = String(r["Storage Location"]).trim().toUpperCase();
      const qty = (Number(r["Unrestricted Stock"]) || 0) + (Number(r["Stock in Transit"]) || 0) + (Number(r["Stock in Quality Inspection"]) || 0);
      qtyBySloc[sloc] = (qtyBySloc[sloc] || 0) + qty;
    });
    let bestLoc = "", bestQty = -1;
    Object.entries(qtyBySloc).forEach(([sloc, q]) => { if (q > bestQty) { bestQty = q; bestLoc = sloc; } });
    return { loc: bestLoc, inferred: false };
  }
  const inferredLoc = brdInferStorageLocation(plant, scopeCode);
  return { loc: inferredLoc, inferred: !!inferredLoc };
}

// ── NEAREST EXPIRY DATE AT THE REQUESTING BRANCH (Request Form tab only) ───
// A branch deciding how much to request also wants to know how soon its
// OWN existing stock of that material expires, so it doesn't over-request
// on top of stock that's about to lapse. This looks across every source
// row for the material at that branch (with real quantity on hand) and
// returns the soonest expiry date found. Tries several common SAP
// column-name variants since the exact header can differ by export
// template — extend EXPIRY_DATE_FIELDS if your data uses a different one
// and this keeps showing "—".
const EXPIRY_DATE_FIELDS = [
  "SLED/BBD", "SLED", "Shelf Life Exp. Date", "Shelf Life Expiration Date",
  "Expiration Date", "Expiry Date", "Best Before Date", "BBD", "Exp. Date",
];
function brdRowExpiryDate(row) {
  for (const f of EXPIRY_DATE_FIELDS) {
    const raw = row[f];
    if (raw === undefined || raw === null || raw === "") continue;
    const d = raw instanceof Date ? raw : new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}
function brdNearestExpiryForBranch(mappedCode, plant) {
  const src  = brdPrimarySource(mappedCode);
  const base = (mappingTable && mappingTable.size > 0 ? mappedDf : rawDf) || [];
  let nearest = null;
  base.forEach(r => {
    if (String(r["Plant"] || "").trim().toUpperCase() !== plant) return;
    if (!src.allSourceCodes.includes(String(r["Material"] || "").trim().toUpperCase())) return;
    const qty = (Number(r["Unrestricted Stock"]) || 0) + (Number(r["Stock in Quality Inspection"]) || 0);
    if (qty <= 0) return; // only batches actually holding stock
    const d = brdRowExpiryDate(r);
    if (d && (!nearest || d < nearest)) nearest = d;
  });
  return nearest;
}
// Compact pill for the Nearest Expiry column — colour flags urgency the
// same way the rest of the app does (red = critical, amber = watch).
function brdFmtExpiry(d) {
  if (!d) return `<span class="brd-status-pill brd-status-muted">—</span>`;
  const days = Math.round((d - new Date()) / 86400000);
  let cls = "brd-status-green";
  if (days <= 90) cls = "brd-status-red";
  else if (days <= 180) cls = "brd-status-amber";
  const label = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
  return `<span class="brd-status-pill ${cls}" title="${days} day(s) from today">${escHtml(label)}</span>`;
}

// ── REQUEST ELIGIBILITY (see file header) ───────────────────────────────────
function brdIsRequestEligible(line) {
  return !!line.hasAmc && line.mosNow !== null && line.mosNow !== undefined
      && line.mosNow < REQUEST_ELIGIBILITY_MOS
      && (line.availableHo || 0) > 0;
}

// ── ROUNDING: largest-remainder method ──────────────────────────────────────
// Rounds a set of ideal (float) allocations to whole units so their sum never
// exceeds capTotal, without ever pushing any single value above its own cap.
// Leftover whole units (from flooring) go to the branches with the largest
// fractional remainder first — this is what makes "prefer partial > 0 over
// zero when HO still has stock" hold in practice.
function brdLargestRemainderRound(idealValues, caps, capTotal) {
  const floors = idealValues.map(v => Math.max(0, Math.floor(v)));
  const used = floors.reduce((a, b) => a + b, 0);
  const idealSum = idealValues.reduce((a, b) => a + b, 0);
  let remaining = Math.floor(Math.min(capTotal, idealSum)) - used;
  if (remaining <= 0) return floors;
  const order = idealValues
    .map((v, i) => ({ i, frac: v - Math.floor(v), room: caps[i] - floors[i] }))
    .filter(o => o.room > 0)
    .sort((a, b) => b.frac - a.frac);
  for (const o of order) {
    if (remaining <= 0) break;
    floors[o.i]++;
    remaining--;
  }
  return floors;
}

// ── CORE ALLOCATION (one material, every branch, HO01 fair-share split) ────
// ho01Breakdown: Map from brdBuildHo01Breakdown() — see that function's
// header comment. sohHo below is deliberately the UNRESTRICTED-only figure
// (not buildMosSohMap()'s Total Quantity) because QC stock can't actually be
// allocated to a branch yet; qcHo is carried separately purely so the table
// can flag it ("stock exists but is stuck in QC") without ever counting it
// as available.
function brdComputeMaterialAllocation(row, sohMap, buffer, ho01Breakdown) {
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT);
  const bd     = (ho01Breakdown && ho01Breakdown.get(row.code)) || { unrestricted: 0, qc: 0 };
  const sohHo  = bd.unrestricted;
  const qcHo   = bd.qc;
  const availableHo = Math.max(0, sohHo - (Number(buffer) || 0));

  const perBranch = branchPlants.map(p => {
    const soh    = mosSohFor(sohMap, row, p);
    const amcVal = row.amcs[p];
    const hasAmc = amcVal !== null && amcVal !== undefined;
    const amc    = hasAmc ? amcVal : null;
    const need   = hasAmc ? Math.max(0, TARGET_MOS * amc - soh) : 0; // rule 7: no AMC → no auto need
    const mosNow = hasAmc ? (amc > 0 ? soh / amc : (soh > 0 ? Infinity : null)) : null;
    return { plant: p, soh, amc, hasAmc, need, mosNow };
  });

  const totalNeed = perBranch.reduce((s, b) => s + b.need, 0);

  let idealAlloc;
  if (totalNeed === 0) {
    idealAlloc = perBranch.map(() => 0);
  } else if (totalNeed <= availableHo) {
    idealAlloc = perBranch.map(b => b.need);
  } else {
    const scale = availableHo / totalNeed;
    idealAlloc = perBranch.map(b => Math.min(b.need, b.need * scale));
  }

  const caps = perBranch.map(b => b.need);
  const allocRounded = brdLargestRemainderRound(idealAlloc, caps, availableHo);
  const isPartial = totalNeed > availableHo && totalNeed > 0;
  const scalePct  = totalNeed > 0 ? Math.min(1, availableHo / totalNeed) : 1;

  return {
    sohHo, qcHo, availableHo, totalNeed, isPartial, scalePct,
    perBranch: perBranch.map((b, i) => ({ ...b, allocComputed: allocRounded[i] })),
  };
}

// ── RESOLVE A PASTED CODE (source or mapped) TO A mosMerged ROW ────────────
function brdResolveCode(raw) {
  const q = String(raw || "").trim().toUpperCase();
  if (!q) return null;
  let row = mosMerged.find(r => r.code === q);
  if (row) return row;
  if (mappingTable && mappingTable.size > 0) {
    const entry = mappingTable.get(q);
    if (entry) row = mosMerged.find(r => r.code === entry.targetCode);
  }
  return row || null;
}

function brdAddCodesFromText(text) {
  const raws = String(text || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if (!raws.length) return;
  let matched = 0;
  const unmatched = [];
  raws.forEach(r => {
    const row = brdResolveCode(r);
    if (row) {
      matched++;
      if (!brdCodes.includes(row.code)) brdCodes.push(row.code);
    } else {
      unmatched.push(r);
    }
  });
  if (typeof showPasteMatchToast === "function") {
    showPasteMatchToast(matched, raws.length, unmatched);
  }
  renderBranchDemand();
}

// ── SCOPE: which mosMerged rows are in play ─────────────────────────────────
function brdMaterialsForScope() {
  if (brdCodes.length) {
    return brdCodes.map(c => mosMerged.find(r => r.code === c)).filter(Boolean);
  }
  let rows = mosMerged;
  if (typeof personFilter !== "undefined" && personFilter.size > 0) {
    rows = rows.filter(r => r.person && personFilter.has(r.person));
  }
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT);
  const scopePlants  = brdSelectedPlant ? [brdSelectedPlant] : branchPlants;
  return rows.filter(r => scopePlants.some(p => r.amcs[p] !== null && r.amcs[p] !== undefined));
}

// ── BUILD DISPLAY LINES ─────────────────────────────────────────────────────
function brdBuildLines(sohMap) {
  const materials    = brdMaterialsForScope();
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT);
  const viewPlants   = brdSelectedPlant ? [brdSelectedPlant] : branchPlants;
  const ho01Breakdown = brdBuildHo01Breakdown();

  const lines = [];
  let hiddenNoStockCount = 0; // materials with truly nothing at HO01 (see rule below)
  materials.forEach(row => {
    // Stock Type filter (rule set in file header): classify once per
    // material and skip it entirely if it doesn't match the selected
    // filter, RDF and Health Program need different Purchasing Group /
    // Purch. Organization codes so they shouldn't be mixed on one screen
    // or one export.
    const matScope = brdMaterialScope(row.code);
    if (brdStockType && matScope.prefix !== brdStockType) return;
    const purchGroup = matScope.scope ? (PURCHASING_GROUP_MAP[matScope.scope] || "") : "";
    const purchOrg   = matScope.prefix ? (PURCH_ORG_MAP[matScope.prefix] || "") : "";
    const stockTypeLabel = matScope.prefix ? (STOCK_TYPE_LABEL[matScope.prefix] || matScope.prefix) : "";

    const calc = brdComputeMaterialAllocation(row, sohMap, brdBuffer, ho01Breakdown);

    // ── "Consider only stock available at HO01" ──────────────────────────
    // Only materials with NOTHING at HO01 (no unrestricted, no QC) are
    // dropped from the table entirely — this module is about what a branch
    // can actually be sent, so a material HO01 has zero of either way isn't
    // useful to show. A material with real unrestricted stock is shown
    // normally. A material sitting ONLY in Quality Inspection (unrestricted
    // = 0 but QC > 0) is the one exception: it's kept on screen, allocated
    // as 0 (QC stock can't be shipped yet), and flagged with a QC warning
    // below instead of being hidden — so branches aren't left unaware that
    // stock exists but isn't releasable yet.
    const qcOnly = calc.sohHo === 0 && calc.qcHo > 0;
    if (calc.sohHo === 0 && calc.qcHo === 0) { hiddenNoStockCount++; return; }

    calc.perBranch.forEach(b => {
      if (!viewPlants.includes(b.plant)) return;
      // Hide totally-inert branch/material pairs (no AMC, no stock) unless
      // the user explicitly pasted this code — otherwise the "load every
      // committed material" default would be swamped by irrelevant rows.
      if (!b.hasAmc && b.soh === 0 && !brdCodes.length) return;

      const key      = brdDraftKey(b.plant, row.code);
      const draft    = brdDraft.get(key) || {};
      const hasManual = draft.manualAlloc !== undefined && draft.manualAlloc !== null;
      const alloc     = hasManual ? draft.manualAlloc : b.allocComputed;
      const mosAfter  = (b.hasAmc && b.amc > 0) ? (b.soh + alloc) / b.amc : null;

      let status;
      if (!b.hasAmc)                       status = "no-amc";
      else if (hasManual)                  status = "manual";
      else if (b.need === 0)               status = "ok";
      else if (alloc <= 0)                 status = "none";
      else if (alloc >= b.need - 0.0001)   status = "full";
      else                                 status = "partial";

      // Lightweight redistribution hint (rule 6): other branches sitting on
      // a large surplus (MOS > 8, some stock) for the SAME material, only
      // surfaced when this branch is actually short. No "import" flag exists
      // in the data today, so this applies to every material rather than
      // being gated on one — informational only, never blocks the request.
      const surplusPlants = (status === "partial" || status === "none")
        ? calc.perBranch
            .filter(o => o.plant !== b.plant && o.hasAmc && o.mosNow !== null && o.mosNow !== Infinity && o.mosNow > 8 && o.soh > 0)
            .map(o => o.plant)
        : [];

      const storageInfo = brdStorageLocationForBranch(row.code, b.plant, matScope.scope);
      const nearestExpiry = brdNearestExpiryForBranch(row.code, b.plant);

      lines.push({
        plant: b.plant, code: row.code, desc: row.desc, origCodes: row.origCodes,
        soh: b.soh, amc: b.amc, hasAmc: b.hasAmc, mosNow: b.mosNow,
        sohHo: calc.sohHo, qcHo: calc.qcHo, qcOnly, availableHo: calc.availableHo,
        need: b.need, alloc, mosAfter, status,
        totalNeed: calc.totalNeed, isPartial: calc.isPartial, scalePct: calc.scalePct,
        approved: !!draft.approved, manual: hasManual,
        surplusPlants,
        stockPrefix: matScope.prefix, stockTypeLabel, purchGroup, purchOrg,
        storageLoc: storageInfo.loc, storageLocInferred: storageInfo.inferred,
        nearestExpiry,
      });
    });
  });
  // Most urgent first: critical/partial/none before ok/no-amc, then by need desc.
  const statusRank = { none: 0, partial: 1, manual: 1, full: 2, "no-amc": 3, ok: 4 };
  const sorted = lines.sort((a, b) => (statusRank[a.status] - statusRank[b.status]) || (b.need - a.need));
  sorted.hiddenNoStockCount = hiddenNoStockCount; // for brdKpiRow — see caller
  return sorted;
}

// ── UI HELPERS ───────────────────────────────────────────────────────────────
function brdStatusBadge(status) {
  const map = {
    ok:      { label: "No Request Needed", cls: "green" },
    full:    { label: "Full",              cls: "green" },
    partial: { label: "Partial",           cls: "amber" },
    none:    { label: "None",              cls: "red" },
    manual:  { label: "Manual",            cls: "purple" },
    "no-amc":{ label: "No AMC",            cls: "muted" },
  };
  const m = map[status] || { label: status, cls: "muted" };
  return `<span class="brd-status-pill brd-status-${m.cls}">${m.label}</span>`;
}

function brdKpiRow(lines) {
  const totalNeed  = lines.reduce((s, l) => s + (l.need || 0), 0);
  const totalAlloc = lines.reduce((s, l) => s + (l.alloc || 0), 0);
  const partialCount = lines.filter(l => l.status === "partial" || l.status === "none").length;
  const noAmcCount  = lines.filter(l => l.status === "no-amc").length;
  const approvedCount = lines.filter(l => l.approved).length;
  const qcOnlyCount = new Set(lines.filter(l => l.qcOnly).map(l => l.code)).size;
  const hiddenNoStock = lines.hiddenNoStockCount || 0;
  setKpis("brd-kpis", [
    ["Lines Shown", lines.length.toLocaleString(), "material × branch pairs", "blue"],
    ["Total Need", fmtQty(totalNeed), `to reach ${TARGET_MOS} MOS`, "amber"],
    ["Total Allocated", fmtQty(totalAlloc), "across shown lines", "green"],
    ["Short / Zero Lines", partialCount.toLocaleString(), "HO01 couldn't fully cover", "red"],
    ["HO01 Stock in QC", qcOnlyCount.toLocaleString(), "materials, not yet releasable", "amber"],
    ["No AMC", noAmcCount.toLocaleString(), "manual entry needed", "muted"],
    ["Approved", approvedCount.toLocaleString(), `of ${lines.length.toLocaleString()} shown`, "purple"],
    ["Hidden — No HO01 Stock", hiddenNoStock.toLocaleString(), "materials with nothing at HO01", "muted"],
  ]);
}

// ── MAIN RENDER ──────────────────────────────────────────────────────────────
function renderBranchDemand() {
  const noInvEl  = document.getElementById("brd-no-inventory");
  const noAmcEl  = document.getElementById("brd-no-amc");
  const contentEl = document.getElementById("brd-content");
  if (!contentEl) return;

  const hasInv = typeof rawDf !== "undefined" && rawDf.length > 0;
  const hasAmc = typeof mosMerged !== "undefined" && mosMerged.length > 0;

  if (!hasInv) {
    if (noInvEl) noInvEl.style.display = "block";
    if (noAmcEl) noAmcEl.style.display = "none";
    contentEl.style.display = "none";
    return;
  }
  if (!hasAmc) {
    if (noInvEl) noInvEl.style.display = "none";
    if (noAmcEl) noAmcEl.style.display = "block";
    contentEl.style.display = "none";
    return;
  }
  if (noInvEl) noInvEl.style.display = "none";
  if (noAmcEl) noAmcEl.style.display = "none";
  contentEl.style.display = "block";

  if (typeof renderMappingBanner === "function") renderMappingBanner("brd-mapping-banner");

  // ── Plant selector (populate once, respecting role locks) ────────────────
  const plantEl = document.getElementById("brd-plant");
  const locked  = brdLockedPlant();
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT).sort();
  if (plantEl && plantEl.dataset.built !== "1") {
    plantEl.innerHTML = "";
    if (brdCanSeeAllBranches() && !locked) {
      const optAll = document.createElement("option");
      optAll.value = ""; optAll.text = "All Branches";
      plantEl.appendChild(optAll);
    }
    branchPlants.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p; opt.text = p;
      plantEl.appendChild(opt);
    });
    if (locked && branchPlants.includes(locked)) {
      brdSelectedPlant = locked;
      plantEl.value = locked;
      plantEl.disabled = true;
    } else if (!brdCanSeeAllBranches() && !brdSelectedPlant && branchPlants.length) {
      // branch_demand_officer with no known profile plant: default to the
      // first branch rather than "All Branches" (which they shouldn't see).
      brdSelectedPlant = branchPlants[0];
      plantEl.value = brdSelectedPlant;
    } else {
      plantEl.value = brdSelectedPlant;
    }
    plantEl.dataset.built = "1";
  }

  // ── Stock Type selector (RDF / Health Program) ────────────────────────────
  // Options are scoped to what the signed-in user is actually allowed to see
  // (mirrors the Q/RDF filter used elsewhere — see stockTypeFilterOptions()
  // in permissions.js) and rebuilt whenever the available set changes (e.g.
  // after a new file is loaded), not just once.
  const stEl = document.getElementById("brd-stocktype");
  if (stEl) {
    const allowed = (typeof stockTypeFilterOptions === "function")
      ? stockTypeFilterOptions(typeof rawDf !== "undefined" ? rawDf : [])
      : ["Q", "RDF"];
    const optionDefs = [{ v: "", l: "All Stock Types" }];
    if (allowed.includes("RDF")) optionDefs.push({ v: "R", l: "RDF" });
    if (allowed.includes("Q"))   optionDefs.push({ v: "Q", l: "Health Program (Q)" });
    const optsKey = optionDefs.map(o => o.v).join(",");
    if (stEl.dataset.optsKey !== optsKey) {
      stEl.innerHTML = optionDefs.map(o => `<option value="${o.v}">${escHtml(o.l)}</option>`).join("");
      brdStockType = optionDefs.some(o => o.v === brdStockType) ? brdStockType : "";
      stEl.value = brdStockType;
      stEl.dataset.optsKey = optsKey;
    } else {
      stEl.value = brdStockType;
    }
  }

  const bufferEl = document.getElementById("brd-buffer");
  if (bufferEl) bufferEl.value = brdBuffer;

  const canEdit = brdCanEdit();
  document.getElementById("brd-approve-selected").style.display = canEdit ? "" : "none";
  document.getElementById("brd-export").style.display = canEdit ? "" : "none";

  // ── Codes chips ────────────────────────────────────────────────────────
  const chipsEl = document.getElementById("brd-codes-chips");
  if (chipsEl) {
    chipsEl.innerHTML = brdCodes.length
      ? brdCodes.map(c => `<span class="brd-chip">${escHtml(c)}<button type="button" class="brd-chip-remove" data-code="${escHtml(c)}" title="Remove">✕</button></span>`).join("")
      : `<span class="brd-chips-hint">Showing every material with an AMC commitment at ${escHtml(brdSelectedPlant || "the selected branch(es)")}. Paste codes above to narrow the list.</span>`;
  }

  // ── Compute + table ────────────────────────────────────────────────────
  const sohMap = buildMosSohMap();
  const lines  = brdBuildLines(sohMap);
  brdKpiRow(lines);

  const cols = [];
  if (canEdit) {
    cols.push({ key: "_sel", label: "", raw: true,
      fmt: (v, r) => `<input type="checkbox" class="brd-approve-cb" data-plant="${escHtml(r.plant)}" data-code="${escHtml(r.code)}" ${r.approved ? "checked" : ""} />` });
  }
  cols.push(
    { key: "code", label: "Mapped Code", fmt: (v, r) => `<span class="col-mat-code">${escHtml(v)}</span>`, raw: true, cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "plant", label: "Branch" },
    { key: "soh", label: "Branch SOH", fmt: v => fmtQty(v) },
    { key: "amc", label: "Branch AMC", fmt: (v, r) => r.hasAmc ? fmtQty(v) : mosNABadge(), raw: true },
    { key: "mosNow", label: "MOS Now", fmt: v => `<span style="${mosCellStyle(v)}">${fmtMosVal(v)}</span>`, raw: true },
    { key: "sohHo", label: "SOH HO01", fmt: (v, r) => r.qcOnly
        ? `<span class="brd-note-qc" title="No unrestricted (usable) HO01 stock — the quantity below is still sitting in Quality Inspection">0 <span class="brd-status-pill brd-status-amber">🧪 in QC</span></span>`
        : fmtQty(v) },
    { key: "need", label: `Need (to ${TARGET_MOS})`, fmt: v => fmtQty(v) },
    { key: "alloc", label: "Allocated", raw: true,
      fmt: (v, r) => canEdit
        ? `<input type="number" min="0" step="1" class="brd-alloc-input" data-plant="${escHtml(r.plant)}" data-code="${escHtml(r.code)}" value="${Number(v || 0)}" />`
        : `<b>${fmtQty(v)}</b>` },
    { key: "mosAfter", label: "MOS After", fmt: v => `<span style="${mosCellStyle(v)}">${fmtMosVal(v)}</span>`, raw: true },
    // NOTE: Status / Stock Type / Purch. Group / Purch. Org / Storage
    // Location are deliberately left off Analysis — they're SAP-header /
    // requisition detail, not stock analysis, and belong on the Request
    // Form tab instead (see reqCols below), which keeps this table on one
    // screen width. Notes is compacted to short hover-badges for the same
    // reason — the old full-sentence version made rows very tall.
    { key: "_notes", label: "Notes", raw: true, cellClass: "brd-notes-cell",
      fmt: (v, r) => {
        const bits = [];
        if (r.qcOnly) bits.push(`<span class="brd-status-pill brd-status-amber" title="HO01 stock (${fmtQty(r.qcHo)}) is still in Quality Inspection — not yet releasable">🧪 QC</span>`);
        if (r.isPartial) bits.push(`<span class="brd-status-pill brd-status-amber" title="HO01 short — scaled to ${Math.round(r.scalePct * 100)}% of need across ${escHtml(brdSelectedPlant ? "all requesting branches" : "shown branches")}">⚖️ ${Math.round(r.scalePct * 100)}%</span>`);
        if (r.surplusPlants && r.surplusPlants.length) bits.push(`<span class="brd-status-pill brd-status-blue" title="Surplus (>8mo) at: ${r.surplusPlants.map(escHtml).join(", ")}">↔️ ${r.surplusPlants.length}</span>`);
        if (!r.hasAmc) bits.push(`<span class="brd-status-pill brd-status-muted" title="No AMC on file — enter quantity manually">✏️ Manual</span>`);
        return bits.length ? `<span class="brd-notes-badges">${bits.join("")}</span>` : "—";
      } },
  );

  document.getElementById("brd-table").innerHTML = buildTable(
    lines, cols,
    (row) => row.status === "none" ? "row-critical" : (row.qcOnly ? "row-qc" : "")
  );

  // ── Request Form tab — same lines, but ONE quantity column instead of
  // SOH/AMC/Need/Allocated all sitting side by side. Analysis mixes several
  // quantity-shaped numbers together (branch SOH, branch AMC, HO01 SOH,
  // need, allocated, MOS before/after) which is exactly right for judging
  // *why* a number is what it is, but is ambiguous the moment someone just
  // wants "how much do I request for this line" — several columns look
  // similar at a glance and it's easy to check/export the wrong one. This
  // tab drops everything except identity + the one quantity that actually
  // gets requested, editable in place exactly like Analysis's Allocated
  // column (same class, same delegated listener — see wireBrdModule).
  // Request Form only offers lines that meet REQUEST ELIGIBILITY (see file
  // header): branch MOS < REQUEST_ELIGIBILITY_MOS AND HO01 actually has
  // stock to give. Lines a supervisor already approved or hand-edited stay
  // visible even if they've since fallen outside that window, so nothing
  // in progress silently vanishes off the tab.
  const requestLines = lines.filter(l => (brdIsRequestEligible(l) && l.alloc > 0) || l.approved || l.manual);
  const reqCountEl = document.getElementById("brd-tab-count-request");
  if (reqCountEl) reqCountEl.textContent = requestLines.length.toLocaleString();

  const reqCols = [];
  if (canEdit) {
    reqCols.push({ key: "_sel", label: "", raw: true,
      fmt: (v, r) => `<input type="checkbox" class="brd-approve-cb" data-plant="${escHtml(r.plant)}" data-code="${escHtml(r.code)}" ${r.approved ? "checked" : ""} />` });
  }
  reqCols.push(
    { key: "code", label: "Mapped Code", fmt: (v, r) => `<span class="col-mat-code">${escHtml(v)}</span>`, raw: true, cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "plant", label: "Branch" },
    { key: "alloc", label: "Quantity to Request", raw: true,
      fmt: (v, r) => canEdit
        ? `<input type="number" min="0" step="1" class="brd-alloc-input" data-plant="${escHtml(r.plant)}" data-code="${escHtml(r.code)}" value="${Number(v || 0)}" />`
        : `<b>${fmtQty(v)}</b>` },
    // Nearest expiry of the branch's OWN existing stock of this item —
    // Request Form only (not Analysis, see file header / cols above).
    { key: "nearestExpiry", label: "Nearest Expiry", raw: true, fmt: v => brdFmtExpiry(v) },
    { key: "storageLoc", label: "Storage Location", raw: true,
      fmt: (v, r) => v
        ? `${escHtml(v)}${r.storageLocInferred ? ' <span title="No existing stock record for this material at this branch — inferred from other materials of the same type at this plant. Double-check before approving." class="brd-note-noamc">≈ inferred</span>' : ""}`
        : `<span class="brd-note-scale">— none found</span>` },
    { key: "purchGroup", label: "Purch. Group", fmt: v => v ? escHtml(v) : "—", raw: true },
    { key: "purchOrg", label: "Purch. Org", fmt: v => v ? escHtml(v) : "—", raw: true },
    { key: "status", label: "Status", fmt: v => brdStatusBadge(v), raw: true },
  );

  const reqTableEl = document.getElementById("brd-request-table");
  if (reqTableEl) {
    reqTableEl.innerHTML = requestLines.length
      ? buildTable(requestLines, reqCols, (row) => row.status === "none" ? "row-critical" : (row.qcOnly ? "row-qc" : ""))
      : `<div class="alert-info" style="margin:0.5rem 0">Nothing to request yet on the current filters — switch to Analysis to see stock/AMC detail, or adjust the Branch / Stock Type filters above.</div>`;
  }
}

// ── EXPORT (SAP_Paste + Working, two-sheet Excel) ───────────────────────────
// SAP_Paste only includes APPROVED lines (this is the "finalized for
// requisition" set); Working includes every line currently on screen, for
// audit/reference. See file header for the primary-source-code rationale and
// for the Storage Location / Purchasing Group / Purch. Organization rule.
//
// SAP_PASTE COLUMN LAYOUT — this intentionally matches the org's own SAP
// requisition upload template (Status, Item of requisition, Acct
// Assignment Cat., Item Category, Material, Short Text, Quantity requested,
// Unit of Measure, Deliv. date category, Delivery Date, Material Group,
// Plant, Storage Location, Purchasing Group, Requisitioner, Req. Tracking
// Number, Desired Vendor, Fixed Vendor, Supplying Plant, Purch.
// Organization, Outline agreement, Princ. Agreement Item, Purchasing info
// rec., MPN: Material) column-for-column, so a row can be selected and
// pasted straight into SAP without retyping or reordering anything. Fields
// SAP derives or auto-numbers itself (Status, Item of requisition, Short
// Text, etc.) are left blank on purpose, exactly as in the reference
// template — do not "helpfully" fill them in.
function brdExportTemplate() {
  const sohMap = buildMosSohMap();
  const lines  = brdBuildLines(sohMap);
  if (!lines.length) { if (typeof showError === "function") showError("Nothing to export — no lines are currently shown. If you're mixing RDF and Health Program items, filter to one Stock Type at a time before exporting."); return; }

  const approved = lines.filter(l => l.approved);

  const workingRows = lines.map(l => {
    const src = brdPrimarySource(l.code);
    return {
      code: l.code, desc: l.desc, plant: l.plant,
      soh: l.soh, amc: l.hasAmc ? l.amc : "Not Committed",
      mosNow: l.mosNow === null ? "N/A" : (l.mosNow === Infinity ? "Infinite" : Number(l.mosNow).toFixed(2)),
      need: Number(l.need).toFixed(0), alloc: Number(l.alloc).toFixed(0),
      mosAfter: l.mosAfter === null ? "N/A" : (l.mosAfter === Infinity ? "Infinite" : Number(l.mosAfter).toFixed(2)),
      sohHo: l.sohHo, factor: src.factor, sourceCodes: src.allSourceCodes.join(", "),
      stockType: l.stockTypeLabel || "Unclassified",
      purchGroup: l.purchGroup || "", purchOrg: l.purchOrg || "",
      storageLoc: l.storageLoc || "", storageLocSource: l.storageLoc ? (l.storageLocInferred ? "Inferred — no existing stock record" : "From branch stock record") : "Not found",
      status: l.status, approved: l.approved ? "Yes" : "No",
    };
  });
  const workingCols = [
    { key: "code", label: "Mapped Code" }, { key: "desc", label: "Description" }, { key: "plant", label: "Branch" },
    { key: "soh", label: "SOH Branch" }, { key: "amc", label: "AMC" }, { key: "mosNow", label: "MOS Now" },
    { key: "need", label: `Need (to ${TARGET_MOS})` }, { key: "alloc", label: "Allocated" }, { key: "mosAfter", label: "MOS After" },
    { key: "sohHo", label: "SOH HO01" }, { key: "factor", label: "Factor (source→mapped)" }, { key: "sourceCodes", label: "Source Code(s)" },
    { key: "stockType", label: "Stock Type" }, { key: "purchGroup", label: "Purchasing Group" }, { key: "purchOrg", label: "Purch. Organization" },
    { key: "storageLoc", label: "Storage Location" }, { key: "storageLocSource", label: "Storage Location Source" },
    { key: "status", label: "Status" }, { key: "approved", label: "Approved" },
  ];

  // Column order/labels below must stay byte-identical to the reference
  // "requestion_form.xlsx" template — see comment above.
  const sapCols = [
    "Status", "Item of requisition", "Acct Assignment Cat.", "Item Category",
    "Material", "Short Text", "Quantity requested", "Unit of Measure",
    "Deliv. date category", "Delivery Date", "Material Group", "Plant",
    "Storage Location", "Purchasing Group", "Requisitioner",
    "Req. Tracking Number", "Desired Vendor", "Fixed Vendor", "Supplying Plant",
    "Purch. Organization", "Outline agreement", "Princ. Agreement Item",
    "Purchasing info rec.", "MPN: Material",
  ];

  const unclassified = approved.filter(l => !l.purchGroup || !l.purchOrg);
  const sapRows = approved.map(l => {
    const src = brdPrimarySource(l.code);
    const sourceQty = src.factor > 0 ? Math.round(l.alloc / src.factor) : l.alloc;
    return [
      "", "", "", "U",                       // Status, Item of requisition, Acct Assignment Cat., Item Category
      src.sourceCode, "", sourceQty, "",      // Material, Short Text (SAP derives this — leave blank), Quantity requested, Unit of Measure
      "", "", "", l.plant,                    // Deliv. date category, Delivery Date, Material Group, Plant
      l.storageLoc || "", l.purchGroup || "", "", "", // Storage Location, Purchasing Group, Requisitioner, Req. Tracking Number
      "", "", HUB_PLANT, l.purchOrg || "",    // Desired Vendor, Fixed Vendor, Supplying Plant, Purch. Organization
      "", "", "", "",                         // Outline agreement, Princ. Agreement Item, Purchasing info rec., MPN: Material
    ];
  });

  const wb = XLSX.utils.book_new();
  const sapWs = XLSX.utils.aoa_to_sheet([sapCols, ...sapRows]);
  const workWs = XLSX.utils.aoa_to_sheet([workingCols.map(c => c.label), ...workingRows.map(r => workingCols.map(c => r[c.key] ?? ""))]);
  XLSX.utils.book_append_sheet(wb, sapWs, "SAP_Paste");
  XLSX.utils.book_append_sheet(wb, workWs, "Working");
  XLSX.writeFile(wb, "branch_demand_requisition.xlsx");

  if (!approved.length && typeof showError === "function") {
    showError("Exported — but SAP_Paste is empty because no lines are approved yet. Check the boxes and re-export, or use the Working sheet.");
  } else if (unclassified.length && typeof showError === "function") {
    showError(`Exported — but ${unclassified.length} approved line(s) couldn't be classified as RDF or Health Program (Purchasing Group / Purch. Organization left blank for those rows). Check the Stock Type column on the Working sheet before submitting.`);
  }
}

// ── WIRE INTO PAGE_RENDERERS AND EVENT LISTENERS ────────────────────────────
(function wireBrdModule() {
  function extend() {
    if (typeof PAGE_RENDERERS !== "undefined") {
      PAGE_RENDERERS["branch-demand"] = renderBranchDemand;
    }

    const plantEl = document.getElementById("brd-plant");
    if (plantEl) plantEl.addEventListener("change", () => {
      brdSelectedPlant = plantEl.value;
      renderBranchDemand();
    });

    const bufferEl = document.getElementById("brd-buffer");
    if (bufferEl) bufferEl.addEventListener("change", () => {
      brdBuffer = Math.max(0, Number(bufferEl.value) || 0);
      renderBranchDemand();
    });

    const stockTypeEl = document.getElementById("brd-stocktype");
    if (stockTypeEl) stockTypeEl.addEventListener("change", () => {
      brdStockType = stockTypeEl.value;
      renderBranchDemand();
    });

    const recalcBtn = document.getElementById("brd-recalc");
    if (recalcBtn) recalcBtn.addEventListener("click", () => renderBranchDemand());

    const addBtn = document.getElementById("brd-codes-add");
    if (addBtn) addBtn.addEventListener("click", () => {
      const ta = document.getElementById("brd-codes-input");
      if (ta) { brdAddCodesFromText(ta.value); ta.value = ""; }
    });

    const clearBtn = document.getElementById("brd-codes-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      brdCodes = [];
      renderBranchDemand();
    });

    const approveSelBtn = document.getElementById("brd-approve-selected");
    if (approveSelBtn) approveSelBtn.addEventListener("click", () => {
      // Scoped to both tabs' tables (not just whichever is currently
      // visible) — Analysis and Request Form show the same underlying
      // lines, just with different columns, so "Approve Visible" should
      // approve every row currently on screen either way.
      document.querySelectorAll("#brd-table .brd-approve-cb, #brd-request-table .brd-approve-cb").forEach(cb => {
        const key = brdDraftKey(cb.dataset.plant, cb.dataset.code);
        const d = brdDraft.get(key) || {};
        d.approved = true;
        brdDraft.set(key, d);
      });
      renderBranchDemand();
    });

    const exportBtn = document.getElementById("brd-export");
    if (exportBtn) exportBtn.addEventListener("click", brdExportTemplate);

    // Event delegation for dynamically-rebuilt table content (chips remove,
    // per-row approve checkbox, per-row allocation edit) — and the
    // Analysis / Request Form tab switcher. Both tab tables are already
    // rebuilt on every renderBranchDemand(), so switching tabs is just a
    // visibility toggle, no recompute needed.
    document.body.addEventListener("click", (e) => {
      const chipX = e.target.closest(".brd-chip-remove");
      if (chipX) {
        brdCodes = brdCodes.filter(c => c !== chipX.dataset.code);
        renderBranchDemand();
        return;
      }
      const tabBtn = e.target.closest(".brd-tab-btn");
      if (tabBtn) {
        const tab = tabBtn.dataset.tab;
        document.querySelectorAll(".brd-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
        document.querySelectorAll(".brd-tab-panel").forEach(p => {
          p.style.display = p.id === "brd-tab-" + tab ? "block" : "none";
        });
      }
    });
    document.body.addEventListener("change", (e) => {
      const cb = e.target.closest(".brd-approve-cb");
      if (cb) {
        const key = brdDraftKey(cb.dataset.plant, cb.dataset.code);
        const d = brdDraft.get(key) || {};
        d.approved = cb.checked;
        brdDraft.set(key, d);
        return;
      }
      const inp = e.target.closest(".brd-alloc-input");
      if (inp) {
        const key = brdDraftKey(inp.dataset.plant, inp.dataset.code);
        const d = brdDraft.get(key) || {};
        const v = Math.max(0, Number(inp.value) || 0);
        d.manualAlloc = v;
        brdDraft.set(key, d);
        renderBranchDemand();
      }
    });

    // Recompute when the main inventory file or AMC file finish loading and
    // the user is already on this page (same convention as mos.js).
    const fileInput = document.getElementById("fileInput");
    if (fileInput) fileInput.addEventListener("change", () => {
      setTimeout(() => { if (currentPage === "branch-demand") renderBranchDemand(); }, 300);
    });
    const amcInput = document.getElementById("mosAmcFileInput");
    if (amcInput) amcInput.addEventListener("change", () => {
      setTimeout(() => { if (currentPage === "branch-demand") renderBranchDemand(); }, 300);
    });

    const _origApplyMapping = window.applyMaterialMapping;
    if (_origApplyMapping) {
      window.applyMaterialMapping = function () {
        _origApplyMapping.apply(this, arguments);
        if (currentPage === "branch-demand") { try { renderBranchDemand(); } catch (e) {} }
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", extend);
  } else {
    extend();
  }
})();
