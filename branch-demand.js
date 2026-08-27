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
//     stocked it before, we fall back to the branch's cold or non-cold
//     storage-location code (per storage-locations.js, sourced from
//     demand_storage.xlsx) that matches where the material sits at HO01,
//     preferring whichever candidate's Special Stock Type matches this
//     material's own Q/R classification, and flag the line as "inferred" so
//     a human can double-check before approving. See brdStorageLocationForBranch().
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
//   else                      → allocated tier-by-tier, most urgent first —
//                                see PRIORITY ALLOCATION below   [rule 4]
//   Rounded to whole units via the "largest remainder" method so
//   Σ alloc_b ≤ available_HO exactly, preferring to give partial > 0 over 0
//   to branches with a real (if small) need whenever HO still has stock.
//
//   PRIORITY TIERS (labels the existing MOS thresholds — no new band):
//     Critical         current MOS <  1                    (CRITICAL_MOS)
//     High             1  ≤ current MOS <  3                (REQUEST_ELIGIBILITY_MOS)
//     Medium           3  ≤ current MOS <  5                (TARGET_MOS)
//     Low/Overstocked  current MOS >= 5 — need hard-clamped to 0, never orders
//   See brdPriorityTier(). The fill target for every requesting branch is
//   still TARGET_MOS (5); tiers only change the ORDER stock is handed out
//   in, not how much a branch is entitled to.
//
//   PRIORITY ALLOCATION (replaces the old flat equal-scale split): when
//   available_HO can't cover total_need for a material, HO01 stock is
//   handed out tier by tier — Critical branches fully covered first, then
//   High, then Medium — each tier filled completely before the next tier
//   gets anything. Only the ONE tier that actually runs out of stock is
//   split proportionally within itself (need-weighted, same formula as
//   rule 4 above but scoped to that tier's branches only); every tier after
//   it gets 0 for this material, and every tier before it was already
//   filled in full. See brdComputeMaterialAllocation().
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
//   storage-locations.js (PLANT_STORAGE_LOCATIONS, PLANT_COLD_STORAGE_LOCATIONS,
//               PLANT_NONCOLD_STORAGE_LOCATIONS, HO01_COLD_LOCATIONS,
//               storageLocationSpecialStockType)
//   script.js  (rawDf, mappedDf, mappingTable, escHtml, fmtQty, buildTable,
//               kpiCard, setKpis, canAccessRow via permissions.js, getReconciledBase)
//   mos.js     (HUB_PLANT, mosPlants, mosMerged, mosSohFor, buildMosSohMap,
//               fmtMosVal, mosCellStyle, mosNABadge)
//   permissions.js (canAccessModule, currentRole, computeIsAdmin, isDirectorLike)
// =============================================================================

const TARGET_MOS = 5; // constant for v1 — do not expose as user-editable yet
const REQUEST_ELIGIBILITY_MOS = 3; // a branch may REQUEST a line only below this MOS — see file header
const CRITICAL_MOS = 1; // below this MOS a branch is "Critical" priority — see file header / brdPriorityTier()

// ── PRIORITY TIERS (see file header "PRIORITY TIERS" / "PRIORITY ALLOCATION") ─
// This is deliberately just a labeled view onto the SAME MOS thresholds the
// rest of the module already used (REQUEST_ELIGIBILITY_MOS=3 floor,
// TARGET_MOS=5 fill ceiling) plus one new boundary (CRITICAL_MOS=1) — not a
// second, independent band. `max` is exclusive-upper (current MOS < max).
const PRIORITY_TIERS = [
  { key: "critical", label: "Critical",          cls: "red",   max: CRITICAL_MOS },
  { key: "high",      label: "High",              cls: "amber", max: REQUEST_ELIGIBILITY_MOS },
  { key: "medium",    label: "Medium",            cls: "blue",  max: TARGET_MOS },
  { key: "low",       label: "Low / Overstocked", cls: "green", max: Infinity },
];
// Returns the PRIORITY_TIERS entry for a branch's current MOS. A branch with
// no AMC (mosNow === null) or stock but zero AMC (mosNow === Infinity) both
// fall through to Low/Overstocked — there's no real, computable need either
// way, so there's nothing to prioritize.
function brdPriorityTier(mosNow) {
  if (mosNow === null || mosNow === undefined || mosNow === Infinity) return PRIORITY_TIERS[3];
  for (const t of PRIORITY_TIERS) {
    if (mosNow < t.max) return t;
  }
  return PRIORITY_TIERS[3];
}
function brdPriorityBadge(tierKey) {
  const t = PRIORITY_TIERS.find(x => x.key === tierKey) || PRIORITY_TIERS[3];
  return `<span class="brd-status-pill brd-status-${t.cls}" title="Priority tier, based on this branch's current MOS">${escHtml(t.label)}</span>`;
}

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
// BUGFIX-QC-FALSE-POSITIVE: the map key here MUST be normalized the exact
// same way every other cross-file code lookup in the app normalizes it
// (.trim().toUpperCase() — see getPersonFilteredCodes() / getReconciledBase()
// in script.js). Previously this only .trim()'d the code. Real SAP exports
// routinely have the same material appear with different casing across rows
// (or across the AMC file vs the inventory file), and mosMerged.code /
// row._mappedMaterial are themselves NOT case-normalized upstream (see
// buildMosMerged() in mos.js and applyMaterialMapping() in script.js — both
// only trim). Without normalizing here too, HO01 unrestricted stock recorded
// under e.g. "MED123" and QC stock recorded under "med123" landed in TWO
// SEPARATE map entries instead of being summed into one. brdComputeMaterialAllocation()
// then looked the material up under whichever single casing mosMerged.code
// happened to use, found the QC-only bucket, and showed "0 unrestricted /
// QC positive" for a material that actually had usable unrestricted stock
// sitting under the other-cased bucket. Normalizing the key here (and the
// lookup key in brdComputeMaterialAllocation()) collapses both casings back
// into one entry so the two quantities are summed correctly again.
function brdBuildHo01Breakdown() {
  const map = new Map();
  const base = (typeof getReconciledBase === "function")
    ? getReconciledBase()
    : (typeof rawDf !== "undefined" ? rawDf : []);
  if (!base.length) return map;
  for (const row of base) {
    const plt = String(row["Plant"] || "").trim().toUpperCase();
    if (plt !== HUB_PLANT) continue;
    const mat = String(row._mappedMaterial || row["Material"] || "").trim().toUpperCase();
    if (!mat) continue;
    const unrestricted = (typeof getMappedQty === "function") ? getMappedQty(row, "Unrestricted Stock") : Number(row["Unrestricted Stock"] || 0);
    const qc            = (typeof getMappedQty === "function") ? getMappedQty(row, "Stock in Quality Inspection") : Number(row["Stock in Quality Inspection"] || 0);
    if (!map.has(mat)) map.set(mat, { unrestricted: 0, qc: 0 });
    const entry = map.get(mat);
    entry.unrestricted += Number(unrestricted) || 0;
    entry.qc            += Number(qc) || 0;
  }
  // DEFENSIVE LOG (dev aid, not shown to users): if this ever fires a lot,
  // the QC badge is unreliable again — most likely a new place upstream
  // stopped normalizing casing/trim on a material code. Grep for "QC-FALSE-
  // POSITIVE" if this shows up.
  if (window.DEBUG_BRD) {
    const qcOnlyCodes = [...map.entries()].filter(([, v]) => v.unrestricted === 0 && v.qc > 0).map(([k]) => k);
    if (qcOnlyCodes.length) console.debug("[branch-demand] HO01 QC-only codes this build:", qcOnlyCodes);
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
let brdProgramClass   = "";       // "" = All, else one of PROGRAM_CLASS.* (mos.js) — RDF·CDSS/Non-CDSS, Program(Q)·Reportable/Non-Reportable
let brdCodes          = [];       // explicit user-pasted canonical/mapped codes (empty = auto-load)
// brdDraft: Map<"PLANT::CODE", { approved:boolean, manualAlloc:number|null }>
// Keyed by plant+code so edits/approvals survive a Recalculate (which only
// rebuilds the underlying computed numbers, never this map).
let brdDraft = new Map();

function brdDraftKey(plant, code) { return `${plant}::${code}`; }

// ── ROLE / CAPABILITY HELPERS ───────────────────────────────────────────────
// UPDATED POLICY: branch_demand_officer now also gets editing + approval +
// export (previously read-only). All of branch_demand_officer/team_leader/
// director/deputy_director/admin get the full plant selector + multi-branch
// view + editing + approval + export. Admin/Director-like already bypass
// most gating elsewhere in the app, so we mirror that here rather than
// inventing a new rule. branch_demand_officer stays locked to their own
// plant when known (see brdLockedPlant()) — this only changes their edit
// capability within that plant, not their plant scope.
//
// FIX-BRD-EDIT-FOR-GRANTED-USERS: the fixed role list above used to be the
// ONLY way in, which meant a plain "user"-role account that an Admin/
// Director had explicitly granted the Branch Demand module (sidebar
// permission checkbox — see canAccessModule("branch-demand")) could open
// the page and see every line, but Approve Visible / Deselect All / Export
// Template stayed hidden regardless — there was no way to grant edit rights
// to anyone outside that fixed role set. Per the module's own intent
// ("branch users placing their own demand requests is the whole point of
// this page" — see permissions.js HEAD_OFFICE_ONLY_MODULE_KEYS comment),
// anyone the app has actually let onto this page should be able to act on
// it: canAccessModule() already returned true for them or they wouldn't be
// here at all, so it's added as an additional OR below rather than
// replacing the role list (keeps the explicit roles working even if a
// future admin somehow revokes the sidebar checkbox for one of them).
function brdCanEdit() {
  return (typeof computeIsAdmin === "function" && computeIsAdmin())
      || (typeof isDirectorLike === "function" && isDirectorLike())
      || (typeof currentRole === "function" && currentRole() === "team_leader")
      // POLICY UPDATE: branch_demand_officer now also gets edit/approve/export
      // access (previously read-only-only per the original spec comment above).
      || (typeof currentRole === "function" && currentRole() === "branch_demand_officer")
      // Any role explicitly granted the Branch Demand module itself.
      || (typeof canAccessModule === "function" && canAccessModule("branch-demand"));
}
function brdCanSeeAllBranches() { return brdCanEdit(); }
// window.APP_USER.plant (see permissions.js "PLANT SCOPING" for the
// app-wide source of truth) drives this. Returns the plant code this user
// is locked to for Branch Demand, or null when they may see every branch —
// which is BOTH the "no plant set yet" case AND the "plant === HO01" case:
// HO01 is the hub (not a branch in this dropdown at all — see
// branchPlants = mosPlants.filter(p => p !== HUB_PLANT) below), so a
// director/team_leader/admin whose plant is HO01 must fall through to full
// multi-branch behaviour, not get treated as "locked to HO01". Without this
// HUB_PLANT check, such a user's "All Branches" option would incorrectly
// disappear (see the `!locked` guard in renderBranchDemand()'s plant-select
// build below) even though the spec says HO01 users keep full access.
function brdLockedPlant() {
  const p = (window.APP_USER && window.APP_USER.plant) ? String(window.APP_USER.plant).trim().toUpperCase() : null;
  return (p && p !== HUB_PLANT) ? p : null;
}

// ── SOURCE-CODE / FACTOR RESOLUTION FOR SAP EXPORT ──────────────────────────
// See file header comment for the "primary source" choice rationale.
//
// BUGFIX-MAPPING-SHAPE: mappingTable is Map<sourceCode → Map<stockType
// ("RDF"|"Q") → { targetCode, targetDesc, factor }>> (see script.js —
// applyMaterialMapping / the mapping-file parser). The old version of this
// function did `mappingTable.forEach((entry, srcCode)) { if
// (entry.targetCode === mappedCode) ... }`, treating the per-source VALUE as
// if it were the {targetCode,factor} row directly. It's actually the nested
// stockType map, so `entry.targetCode` was always undefined, no candidate
// was ever found, and this silently fell back to "sourceCode = mappedCode,
// factor = 1" for every material — i.e. the request was NEVER actually
// converted to the real, orderable source code/pack size, which is the bug
// being fixed here. brdAllCandidateSources() below does the nested-map walk
// correctly.
function brdAllCandidateSources(mappedCode) {
  if (!mappingTable || mappingTable.size === 0) return [];
  const candidates = [];
  mappingTable.forEach((stypeMap, srcCode) => {
    stypeMap.forEach((entry, stype) => {
      if (entry.targetCode === mappedCode) candidates.push({ srcCode, factor: entry.factor, stockType: stype });
    });
  });
  return candidates;
}

// preferredStockType: this line's own Q/RDF classification ("Q" or "R", the
// same convention as matScope.prefix from brdMaterialScope) — when given,
// candidates whose mapping-row stock type matches it are preferred over
// candidates for the OTHER stock type, so a mapped code that's fed by both a
// Q-flagged pack size and an RDF-flagged pack size doesn't get resolved to
// whichever one happens to hold more stock at HO01. Falls back to the full
// candidate list (old "most stock at HO01 wins" tie-break) whenever no
// preferred type is given, or none of the candidates match it.
function brdPrimarySource(mappedCode, preferredStockType) {
  const candidates = brdAllCandidateSources(mappedCode);
  if (!candidates.length) return { sourceCode: mappedCode, factor: 1, allSourceCodes: [mappedCode], stockTypeMatched: false };

  const wantStype = preferredStockType === "Q" ? "Q" : (preferredStockType === "R" ? "RDF" : null);
  let pool = candidates;
  let stockTypeMatched = false;
  if (wantStype) {
    const filtered = candidates.filter(c => c.stockType === wantStype);
    if (filtered.length) { pool = filtered; stockTypeMatched = true; }
  }

  if (pool.length === 1) {
    return { sourceCode: pool[0].srcCode, factor: pool[0].factor, allSourceCodes: pool.map(c => c.srcCode), stockTypeMatched };
  }
  const base = (mappingTable.size > 0 ? mappedDf : rawDf) || [];
  const qtyBySource = {};
  base.forEach(r => {
    const plt = String(r["Plant"] || "").trim().toUpperCase();
    if (plt !== HUB_PLANT) return;
    const src = String(r["Material"] || "").trim().toUpperCase();
    if (!pool.some(c => c.srcCode === src)) return;
    const qty = (Number(r["Unrestricted Stock"]) || 0) + (Number(r["Stock in Transit"]) || 0) + (Number(r["Stock in Quality Inspection"]) || 0);
    qtyBySource[src] = (qtyBySource[src] || 0) + qty;
  });
  let best = pool[0], bestQty = -1;
  pool.forEach(c => {
    const q = qtyBySource[c.srcCode] || 0;
    if (q > bestQty) { bestQty = q; best = c; }
  });
  return { sourceCode: best.srcCode, factor: best.factor, allSourceCodes: pool.map(c => c.srcCode), stockTypeMatched };
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
  // Can't pass a preferred stock type here — determining it IS the point of
  // this function — so gather every candidate source code regardless of
  // type (see BUGFIX-MAPPING-SHAPE note on brdAllCandidateSources above;
  // this used to go through brdPrimarySource(), which always came back
  // empty and silently left most mapped materials "Unclassified").
  const allSrc = brdAllCandidateSources(mappedCode);
  const allSourceCodes = allSrc.length ? allSrc.map(c => c.srcCode) : [mappedCode];
  const base = (mappingTable && mappingTable.size > 0 ? mappedDf : rawDf) || [];
  const candidateRows = base.filter(r => allSourceCodes.includes(String(r["Material"] || "").trim().toUpperCase()));
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
// Fallback rule (used only when the branch has no existing stock record for
// this exact material — see brdStorageLocationForBranch below): match the
// temperature zone (cold vs non-cold) of wherever this material actually
// sits at HO01 right now, same signal request-analysis.js's
// classifyStorageMismatch() uses, then return THIS plant's own code for that
// zone. When a plant has more than one candidate code for that zone (e.g.
// HA01 has two cold codes), prefer whichever one's Special Stock Type
// serves this material's own Q/R classification — see storageLocationServesScope()
// in storage-locations.js and brdNonColdCodeForPlant() / brdInferStorageLocation()
// below. A location flagged "Q AND RDF" in the reference table serves
// either classification, so it never rules out a candidate by itself.
//
// HO01_COLD_LOCATIONS, PLANT_COLD_STORAGE_LOCATIONS, and
// PLANT_NONCOLD_STORAGE_LOCATIONS all come from storage-locations.js (loaded
// before this file), which is generated from the real plant/storage-location
// reference list (demand_storage.xlsx) — NOT hand-maintained copies in this
// file anymore. That file is also what request-analysis.js's
// classifyStorageMismatch() reads, so both modules now agree by construction
// instead of by two people remembering to update two files in lockstep. See
// storage-locations.js for the full table.

// Whether this material sits cold, non-cold, both, or neither at HO01 right
// now, read live from Storage Location on the main inventory data (any row,
// regardless of current stock qty). Returns true (cold), false (non-cold),
// or null when there's no HO01 location data for it, or it's split across
// both zones — either way there isn't a clean signal to act on, so callers
// should not guess.
function brdHo01IsCold(mappedCode) {
  const base = (typeof getReconciledBase === "function") ? getReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
  let hasCold = false, hasNonCold = false;
  base.forEach(row => {
    if (String(row["Plant"] || "").trim().toUpperCase() !== HUB_PLANT) return;
    const canonical = String(row._mappedMaterial || row["Material"] || "").trim();
    if (canonical !== mappedCode) return;
    const loc = String(row["Storage Location"] || "").trim().toUpperCase();
    if (!loc) return;
    if (HO01_COLD_LOCATIONS.includes(loc)) hasCold = true; else hasNonCold = true;
  });
  if (hasCold && !hasNonCold) return true;
  if (hasNonCold && !hasCold) return false;
  return null; // no data, or split across both zones
}

// This plant's own non-cold code, from the PLANT_NONCOLD_STORAGE_LOCATIONS
// reference list (storage-locations.js). When the plant has more than one
// non-cold code, narrow to whichever one's Special Stock Type matches this
// material's own Q/R classification (scopeCode, e.g. "Q_ZME" or "R_ZLC")
// where the reference table can tell them apart; if that still leaves more
// than one candidate (or scopeCode is unknown), fall back to whichever
// candidate is used most often in this plant's own live data, and finally
// to the first reference-list candidate if there's no live data yet.
function brdNonColdCodeForPlant(plant, scopeCode) {
  let candidates = PLANT_NONCOLD_STORAGE_LOCATIONS[plant] || [];
  if (!candidates.length) return "";
  if (scopeCode) {
    const wantPrefix = scopeCode.startsWith("Q_") ? "Q" : "R";
    const matched = candidates.filter(loc => storageLocationServesScope(plant, loc, wantPrefix) === true);
    if (matched.length) candidates = matched;
  }
  if (candidates.length === 1) return candidates[0];
  const base = (mappingTable && mappingTable.size > 0 ? mappedDf : rawDf) || [];
  const counts = {};
  base.forEach(r => {
    if (String(r["Plant"] || "").trim().toUpperCase() !== plant) return;
    const sloc = String(r["Storage Location"] || "").trim().toUpperCase();
    if (candidates.includes(sloc)) counts[sloc] = (counts[sloc] || 0) + 1;
  });
  let best = candidates[0], bestCount = -1;
  candidates.forEach(sloc => { const c = counts[sloc] || 0; if (c > bestCount) { bestCount = c; best = sloc; } });
  return best;
}

// scopeCode carries this material's own Q/R + valuation-type classification
// (e.g. "Q_ZME", "R_ZLC" — see brdMaterialScope()), used to break ties when
// a plant has more than one candidate code for a temperature zone.
function brdInferStorageLocation(plant, mappedCode, scopeCode) {
  const isCold = brdHo01IsCold(mappedCode);
  if (isCold === null) return ""; // no clear HO01 signal — don't guess
  if (isCold) {
    const coldCodes = PLANT_COLD_STORAGE_LOCATIONS[plant];
    if (!coldCodes || !coldCodes.length) return "";
    if (coldCodes.length === 1 || !scopeCode) return coldCodes[0];
    const wantPrefix = scopeCode.startsWith("Q_") ? "Q" : "R";
    const matched = coldCodes.filter(loc => storageLocationServesScope(plant, loc, wantPrefix) === true);
    return matched.length ? matched[0] : coldCodes[0];
  }
  return brdNonColdCodeForPlant(plant, scopeCode);
}

// Resolves the Storage Location a line should use. The temperature zone
// (cold vs non-cold) is ALWAYS anchored to where this material currently
// sits at HO01 — HOM3/HOM8/HOM9 = cold, anything else = non-cold (see file
// header) — and the destination branch's own location must be in that same
// zone, no exceptions. Within the correct zone: prefer the branch's own
// existing stock record (picking whichever zone-matching location holds the
// most stock, if it sits in more than one); cold/non-cold-matched inference
// second, when the branch has no zone-matching record of its own yet.
// `inferred:true` means the caller should surface this for human review
// before the line is approved. Q vs RDF (scopeCode) is read straight off
// the material's own "Special Stock Type" in the inventory data elsewhere
// (blank = RDF, "Q" = Health Program — see brdScopeCodeForRow()); it only
// affects which SPECIFIC code is picked within a zone here, never whether
// the item is cold or non-cold.
function brdStorageLocationForBranch(mappedCode, plant, scopeCode) {
  const wantPrefix = scopeCode ? (scopeCode.startsWith("Q_") ? "Q" : "R") : null;
  const src  = brdPrimarySource(mappedCode, wantPrefix);
  const base = (mappingTable && mappingTable.size > 0 ? mappedDf : rawDf) || [];
  const ho01Cold = brdHo01IsCold(mappedCode); // true | false | null (unknown/mixed)

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
    // Zone-filter the branch's own recorded locations against HO01's zone
    // for this material — a branch's own stock history is still preferred
    // over inferring, but it must never send a non-cold HO01 item to a
    // cold branch location (or vice-versa). A location this app has no
    // reference-table zone data for is NOT excluded on that basis alone
    // (isStorageLocationCold returns null = unknown, not "wrong zone");
    // only a location the reference table CONFIRMS is the opposite zone
    // gets dropped as a candidate.
    let candidateSlocs = Object.keys(qtyBySloc);
    if (ho01Cold !== null) {
      const zoneMatched = candidateSlocs.filter(sloc => {
        const cold = isStorageLocationCold(plant, sloc);
        return cold === null ? true : cold === ho01Cold;
      });
      candidateSlocs = zoneMatched; // may end up empty — that's handled below
    }
    if (candidateSlocs.length) {
      let bestLoc = "", bestQty = -1;
      candidateSlocs.forEach(sloc => { const q = qtyBySloc[sloc]; if (q > bestQty) { bestQty = q; bestLoc = sloc; } });
      return { loc: bestLoc, inferred: false };
    }
    // Branch has stock of this material, but every location it's recorded
    // under is the WRONG temperature zone for where HO01 actually holds it
    // — don't route a fresh request to a mismatched location just because
    // that's where old stock happens to sit. Fall through to inference so
    // the recommendation still lands in the correct zone, and mark it
    // "inferred" so a human reviews it (the branch's real record disagreeing
    // with HO01's zone is itself worth a second look).
  }

  const inferredLoc = brdInferStorageLocation(plant, mappedCode, scopeCode);
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
function brdNearestExpiryForBranch(mappedCode, plant, scopeCode) {
  const wantPrefix = scopeCode ? (scopeCode.startsWith("Q_") ? "Q" : "R") : null;
  const src  = brdPrimarySource(mappedCode, wantPrefix);
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
// ── OPEN OUTBOUND (Pending Dispatch) — already-in-transit quantities ───────
// Reads pending-dispatch.js's own parsed + access-filtered rows (see
// window.getOpenOutboundRows() there) and nets them against a branch's Need
// below, so Branch Demand stops recommending a request for stock the branch
// is already about to receive from an open (not-yet-issued) delivery.
// Keyed by "PLANT::CANONICALCODE" — the Open Outbound file's own "Material"
// column carries the raw/source SAP code, so it's run through the same
// mappingTable used everywhere else to land on the canonical code
// row.code/brdComputeMaterialAllocation deals with.
function brdBuildOpenOutboundMap() {
  const byPlant = new Map();
  const byCode  = new Map(); // canonical code -> total qty on open outbound to ANY branch (used to net HO01's own SOH)
  if (typeof window.getOpenOutboundRows !== "function") return { byPlant, byCode };
  let rows;
  try { rows = window.getOpenOutboundRows(); } catch (e) { return { byPlant, byCode }; }
  if (!Array.isArray(rows) || !rows.length) return { byPlant, byCode };
  rows.forEach(r => {
    const plant = String(r.shipToParty || "").trim().slice(0, 4).toUpperCase();
    let code = String(r.material || "").trim().toUpperCase();
    if (!code) return;
    if (mappingTable && mappingTable.size > 0) {
      const entry = mappingTable.get(code);
      if (entry) code = entry.targetCode;
    }
    const qty = Number(r.qty) || 0;
    byCode.set(code, (byCode.get(code) || 0) + qty);
    if (!plant) return;
    const key = `${plant}::${code}`;
    byPlant.set(key, (byPlant.get(key) || 0) + qty);
  });
  return { byPlant, byCode };
}

function brdComputeMaterialAllocation(row, sohMap, buffer, ho01Breakdown, openOutboundMap) {
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT);
  // BUGFIX-QC-FALSE-POSITIVE: must match the normalization brdBuildHo01Breakdown()
  // now uses for its keys (.trim().toUpperCase()) — see that function's comment.
  const ho01Key = String(row.code || "").trim().toUpperCase();
  const bd     = (ho01Breakdown && ho01Breakdown.get(ho01Key)) || { unrestricted: 0, qc: 0 };
  const sohHo  = bd.unrestricted;
  const qcHo   = bd.qc;
  // NET OUT OPEN OUTBOUND (see brdBuildOpenOutboundMap): sohHo is HO01's raw
  // unrestricted stock, but some of it may already be committed to an open
  // (not-yet-issued) outbound delivery to a branch — still sitting in SAP as
  // unrestricted, but not really available to allocate again. Total across
  // ALL branches (not just the ones currently in view/filter), since it's
  // already spoken for regardless of which branch this screen happens to be
  // showing right now. netSohHo is what allocation actually uses below.
  const outboundTotal = (openOutboundMap && openOutboundMap.byCode && openOutboundMap.byCode.get(ho01Key)) || 0;
  const netSohHo = Math.max(0, sohHo - outboundTotal);
  const availableHo = Math.max(0, netSohHo - (Number(buffer) || 0));

  const perBranch = branchPlants.map(p => {
    const soh    = mosSohFor(sohMap, row, p);
    const amcVal = row.amcs[p];
    const hasAmc = amcVal !== null && amcVal !== undefined;
    const amc    = hasAmc ? amcVal : null;
    const mosNow = hasAmc ? (amc > 0 ? soh / amc : (soh > 0 ? Infinity : null)) : null;
    // Net out stock already in an open (not-yet-issued) outbound delivery to
    // this branch — it's not on the shelf yet (still in soh), but it's no
    // longer a real gap either, so it shouldn't inflate Need. See
    // brdBuildOpenOutboundMap() above.
    const outboundQty = (openOutboundMap && openOutboundMap.byPlant && openOutboundMap.byPlant.get(`${p}::${row.code}`)) || 0;
    let need     = hasAmc ? Math.max(0, TARGET_MOS * amc - soh - outboundQty) : 0; // rule 7: no AMC → no auto need
    // Overstocked branches don't order (see file header): hard-clamped to 0
    // rather than just relying on the formula above landing on 0 — this also
    // guards edge cases like mosNow === Infinity (stock on hand, AMC reads
    // as 0) where the formula alone wouldn't have produced a need anyway,
    // but the clamp makes the "never orders" guarantee explicit and immune
    // to future formula tweaks.
    if (mosNow !== null && mosNow >= TARGET_MOS) need = 0;
    const tier = brdPriorityTier(mosNow);
    return { plant: p, soh, amc, hasAmc, need, mosNow, tier: tier.key, tierLabel: tier.label, outboundQty };
  });

  const totalNeed = perBranch.reduce((s, b) => s + b.need, 0);

  // ── PRIORITY-BASED ALLOCATION (see file header) ─────────────────────────
  // Walk the tiers most-urgent-first (Critical → High → Medium; Low/
  // Overstocked never has need>0 thanks to the clamp above, so it's skipped
  // entirely). Each tier is fully covered from whatever HO01 stock remains
  // before the next tier is touched at all; only the tier that actually
  // exhausts the remaining stock gets a proportional (need-weighted) split
  // WITHIN that tier — every tier after it is left at 0 for this material.
  // Each tier is rounded to whole units on its own (largest-remainder,
  // scoped to that tier's branches and stock) so rounding leftovers never
  // leak from a higher-priority tier into a lower one.
  const allocRounded = perBranch.map(() => 0);
  let remainingHo = availableHo;
  for (const tierDef of PRIORITY_TIERS) {
    if (tierDef.key === "low") break; // overstocked branches never have need>0 here
    if (remainingHo <= 0) break;
    const idxs = [];
    const needs = [];
    perBranch.forEach((b, i) => {
      if (b.tier === tierDef.key && b.need > 0) { idxs.push(i); needs.push(b.need); }
    });
    if (!idxs.length) continue;
    const tierNeedTotal = needs.reduce((a, b) => a + b, 0);
    if (tierNeedTotal <= 0) continue;
    const tierCapTotal = Math.min(tierNeedTotal, remainingHo);
    const idealForTier = tierNeedTotal <= remainingHo
      ? needs.slice()
      : needs.map(n => n * (remainingHo / tierNeedTotal));
    const roundedForTier = brdLargestRemainderRound(idealForTier, needs, tierCapTotal);
    idxs.forEach((i, k) => { allocRounded[i] = roundedForTier[k]; });
    remainingHo -= tierCapTotal;
  }

  const isPartial = totalNeed > availableHo && totalNeed > 0;
  // Material-level "HO short by X%" figure — kept for the material-wide
  // framing (e.g. "HO01 only covers 40% of everyone's need combined"), but
  // no longer used as each branch's own fill ratio, since priority
  // allocation can fill one branch 100% and another 0% for the same
  // material. See fillPct below for the per-branch figure.
  const scalePct = totalNeed > 0 ? Math.min(1, availableHo / totalNeed) : 1;

  return {
    sohHo, qcHo, netSohHo, outboundTotal, availableHo, totalNeed, isPartial, scalePct,
    perBranch: perBranch.map((b, i) => ({
      ...b,
      allocComputed: allocRounded[i],
      // Actual share of THIS branch's own need that got filled (0–1) —
      // what "how urgent, and did the priority order actually help this
      // branch" should be judged against, unlike the material-wide scalePct.
      fillPct: b.need > 0 ? Math.min(1, allocRounded[i] / b.need) : 1,
    })),
  };
}

// A code's own Q/RDF classification (per brdMaterialScope, i.e. its actual
// Special Stock Type in the inventory data) translated to the "Q"/"RDF"
// strings mosMerged rows use for .type — the single source of truth this
// module uses to pick between two AMC rows that share a code.
function brdMosTypeForCode(code) {
  const scope = brdMaterialScope(code);
  if (scope.prefix === "Q") return "Q";
  if (scope.prefix === "R") return "RDF";
  return null;
}

// ── RESOLVE A PASTED CODE (source or mapped) TO A mosMerged ROW ────────────
// A code can now have two mosMerged rows (Q and RDF) — pick the one whose
// type matches the code's own classification from brdMosTypeForCode(), not
// just whichever happened to come first in mosMerged.
function brdResolveCode(raw) {
  const q = String(raw || "").trim().toUpperCase();
  if (!q) return null;
  let target = q;
  if (!mosMerged.some(r => r.code === q) && mappingTable && mappingTable.size > 0) {
    const entry = mappingTable.get(q);
    if (entry) target = entry.targetCode;
  }
  return mosFindRow(target, brdMosTypeForCode(target));
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
// A code can have two mosMerged rows (Q and RDF). Only one of them is the
// "real" classification for that code per the inventory data's own Special
// Stock Type (brdMosTypeForCode) — the other would double the material onto
// the screen with mismatched AMC, so it's dropped here before anything else
// scopes or filters the list.
function brdDedupeByOwnType(rows) {
  const byCode = new Map();
  rows.forEach(r => {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  });
  const out = [];
  byCode.forEach((candidates, code) => {
    if (candidates.length === 1) { out.push(candidates[0]); return; }
    const wantType = brdMosTypeForCode(code);
    const match = wantType ? candidates.find(r => r.type === wantType) : null;
    out.push(match || candidates[0]);
  });
  return out;
}

function brdMaterialsForScope() {
  if (brdCodes.length) {
    return brdCodes.map(c => brdResolveCode(c)).filter(Boolean);
  }
  let rows = mosMerged;
  if (typeof personFilter !== "undefined" && personFilter.size > 0) {
    rows = rows.filter(r => r.person && personFilter.has(r.person));
  }
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT);
  const scopePlants  = brdSelectedPlant ? [brdSelectedPlant] : branchPlants;
  rows = rows.filter(r => scopePlants.some(p => r.amcs[p] !== null && r.amcs[p] !== undefined));
  rows = brdDedupeByOwnType(rows);
  if (brdProgramClass) rows = rows.filter(r => r.programClass === brdProgramClass);
  return rows;
}

// ── BUILD DISPLAY LINES ─────────────────────────────────────────────────────
function brdBuildLines(sohMap) {
  const materials    = brdMaterialsForScope();
  const branchPlants = mosPlants.filter(p => p !== HUB_PLANT);
  const viewPlants   = brdSelectedPlant ? [brdSelectedPlant] : branchPlants;
  const ho01Breakdown = brdBuildHo01Breakdown();
  const openOutboundMap = brdBuildOpenOutboundMap();

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

    const calc = brdComputeMaterialAllocation(row, sohMap, brdBuffer, ho01Breakdown, openOutboundMap);

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
      const nearestExpiry = brdNearestExpiryForBranch(row.code, b.plant, matScope.scope);

      // ── REQUESTABLE (SOURCE) CODE + QUANTITY ────────────────────────────
      // What the branch should actually put on the request, not the mapped
      // code — resolved to the source code matching THIS line's own Q/RDF
      // classification (matScope.prefix) where the mapping data supports
      // it, converted to that code's own pack size via the mapping factor.
      // E.g. mapped code tracks AMC in a 10x10 pack, but the branch's real
      // stock/request is in a 10x5 pack with factor 0.5 → sourceQty is
      // alloc converted into 10x5 units, not the raw mapped-unit number.
      const reqSrc = brdPrimarySource(row.code, matScope.prefix);
      const reqSourceCode = reqSrc.sourceCode;
      const reqSourceFactor = reqSrc.factor;
      const reqSourceDiffers = reqSourceCode.toUpperCase() !== String(row.code).toUpperCase() || reqSourceFactor !== 1;
      const reqSourceQty = reqSourceFactor > 0 ? Math.round(alloc / reqSourceFactor) : alloc;

      lines.push({
        plant: b.plant, code: row.code, desc: row.desc, origCodes: row.origCodes,
        soh: b.soh, amc: b.amc, hasAmc: b.hasAmc, mosNow: b.mosNow,
        sohHo: calc.sohHo, qcHo: calc.qcHo, qcOnly, availableHo: calc.availableHo,
        netSohHo: calc.netSohHo, outboundTotal: calc.outboundTotal,
        need: b.need, alloc, mosAfter, status,
        totalNeed: calc.totalNeed, isPartial: calc.isPartial, scalePct: calc.scalePct,
        priorityTier: b.tier, priorityLabel: b.tierLabel, fillPct: b.fillPct,
        approved: !!draft.approved, manual: hasManual,
        surplusPlants, outboundQty: b.outboundQty,
        stockPrefix: matScope.prefix, stockTypeLabel, purchGroup, purchOrg,
        storageLoc: storageInfo.loc, storageLocInferred: storageInfo.inferred,
        nearestExpiry,
        reqSourceCode, reqSourceFactor, reqSourceQty, reqSourceDiffers,
        reqSourceTypeMatched: reqSrc.stockTypeMatched,
      });
    });
  });
  // Alphabetical by Description, for both Analysis and Request Form tabs
  // (both render from this same `lines` array — see brdRenderTables below).
  const sorted = lines.sort((a, b) =>
    String(a.desc || "").localeCompare(String(b.desc || "")));
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
  const partialCount = lines.filter(l => l.status === "partial" || l.status === "none").length;
  const noAmcCount  = lines.filter(l => l.status === "no-amc").length;
  const approvedCount = lines.filter(l => l.approved).length;
  const qcOnlyCount = new Set(lines.filter(l => l.qcOnly).map(l => l.code)).size;
  const hiddenNoStock = lines.hiddenNoStockCount || 0;

  setKpis("brd-kpis", [
    ["Lines Shown", lines.length.toLocaleString(), "material × branch pairs", "blue"],
    // Explicit Target MOS band, per file header: floor at REQUEST_ELIGIBILITY_MOS
    // (a branch may request below this), ceiling at TARGET_MOS (fill target).
    ["Target MOS Band", `${REQUEST_ELIGIBILITY_MOS}–${TARGET_MOS}`, `request below ${REQUEST_ELIGIBILITY_MOS}, fill to ${TARGET_MOS}`, "purple"],
    ["Short / Zero Lines", partialCount.toLocaleString(), "HO01 couldn't fully cover", "red"],
    ["HO01 Stock in Quality Inspection", qcOnlyCount.toLocaleString(), "materials, not yet releasable", "amber"],
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

  // ── Plant selector (populate once, respecting role locks AND the user's
  //    profile plant — see brdLockedPlant()/PLANT SCOPING) ────────────────
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
      // branch_demand_officer with no plant assigned yet on their profile:
      // default to the first branch rather than "All Branches" (which they
      // shouldn't see) until an Admin assigns them a real plant.
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

  const clsEl = document.getElementById("brd-program-class");
  if (clsEl) {
    clsEl.value = brdProgramClass; // restore persisted filter state into the DOM first...
    // ...then hide any option this role can't see (e.g. Program (Q) for an
    // RDF-only user). If that just cleared the selection, fall the
    // persisted state back to "All" too, so a later re-render or the
    // Recalculate handler doesn't keep filtering on a hidden value.
    if (typeof applyProgramClassAccessToSelect === "function") applyProgramClassAccessToSelect(clsEl);
    brdProgramClass = clsEl.value;
  }

  const canEdit = brdCanEdit();
  document.getElementById("brd-approve-selected").style.display = canEdit ? "" : "none";
  document.getElementById("brd-deselect-all").style.display = canEdit ? "" : "none";
  document.getElementById("brd-export").style.display = canEdit ? "" : "none";

  // ── Codes chips ────────────────────────────────────────────────────────
  const chipsEl = document.getElementById("brd-codes-chips");
  if (chipsEl) {
    chipsEl.innerHTML = brdCodes.length
      ? brdCodes.map(c => `<span class="brd-chip">${escHtml(c)}<button type="button" class="brd-chip-remove" data-code="${escHtml(c)}" title="Remove">✕</button></span>`).join("")
      : `<span class="brd-chips-hint">Showing every material with an AMC commitment at ${escHtml(brdSelectedPlant || "the selected branch(es)")}. Paste codes above to narrow the list.</span>`;
  }

  // ── LAZY/DEFERRED HEAVY COMPUTE (Issue: Branch Demand loads too slowly) ──
  // brdBuildLines() runs the full priority allocation across every branch ×
  // material (heaviest for users who can see all plants — see
  // brdComputeMaterialAllocation()) and is synchronous, so running it inline
  // here would block the main thread and the UI would just freeze with no
  // feedback until it finishes. Instead: paint a "Calculating…" state into
  // the KPI/table areas immediately (cheap, instant), then hand the actual
  // computation to a fresh macrotask (setTimeout 0) so the browser gets a
  // chance to paint the spinner first. brdRenderSeq guards against a stale
  // in-flight calculation (e.g. user tweaks the buffer twice quickly, or
  // navigates away) finishing late and overwriting a newer render.
  const mySeq = ++brdRenderSeq;
  const loadingHtml = `<div class="brd-loading"><span class="brd-spinner"></span>Calculating branch demand…</div>`;
  const kpisEl = document.getElementById("brd-kpis");
  if (kpisEl) kpisEl.innerHTML = loadingHtml;
  const tableEl = document.getElementById("brd-table");
  if (tableEl) tableEl.innerHTML = loadingHtml;
  const reqTableElLoading = document.getElementById("brd-request-table");
  if (reqTableElLoading) reqTableElLoading.innerHTML = loadingHtml;

  setTimeout(() => brdRenderHeavy(mySeq), 0);
}

// ── HEAVY COMPUTE + TABLE RENDER (deferred out of renderBranchDemand, see
//    comment above) — only ever runs while the user is actually on Branch
//    Demand; renderBranchDemand() is itself only invoked via
//    PAGE_RENDERERS["branch-demand"] (navigation) or explicit user actions
//    (filters, recalc, edits) already guarded to that page — see
//    wireBrdModule() at the bottom of this file for the file-upload / AMC /
//    mapping-apply guards.
let brdRenderSeq = 0;
function brdRenderHeavy(mySeq) {
  // Stale calculation (superseded by a newer render, or user navigated away
  // from Branch Demand while this was pending) — drop it silently.
  if (mySeq !== brdRenderSeq) return;
  if (typeof currentPage !== "undefined" && currentPage !== "branch-demand") return;
  const contentEl = document.getElementById("brd-content");
  if (!contentEl || contentEl.style.display === "none") return;

  const canEdit = brdCanEdit();

  // Everything below runs in a deferred macrotask (see renderBranchDemand()
  // above), so it's outside renderPage()'s own try/catch in script.js —
  // without this try/catch, an error here would only surface as an
  // uncaught console error with the "Calculating…" spinner left on screen
  // forever, instead of the app's usual friendly in-page error message.
  try {
    const sohMap = buildMosSohMap();
    const lines  = brdBuildLines(sohMap);
    brdRenderTables(lines, canEdit);
  } catch (e) {
    console.error("Error computing Branch Demand:", e);
    const msg = `<div class="alert-danger" style="margin-top:1rem">
      ⚠️ An error occurred while calculating branch demand: <b>${escHtml(e.message)}</b>
      <br><small style="opacity:0.7">Check the browser console for details.</small>
    </div>`;
    const kEl = document.getElementById("brd-kpis");
    const tEl = document.getElementById("brd-table");
    const rEl = document.getElementById("brd-request-table");
    if (kEl) kEl.innerHTML = "";
    if (tEl) tEl.innerHTML = msg;
    if (rEl) rEl.innerHTML = "";
  }
}

// ── TABLE RENDER (Analysis + Request Form tabs) — split out of
//    brdRenderHeavy() purely so that function's try/catch (above) covers
//    both the allocation math AND the table-building/DOM-write in one go.
function brdRenderTables(lines, canEdit) {
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
    { key: "priorityTier", label: "Priority", raw: true, fmt: (v, r) => brdPriorityBadge(v) },
    { key: "sohHo", label: "SOH HO01", raw: true, fmt: (v, r) => r.qcOnly
        ? `<span class="brd-note-qc" title="No unrestricted (usable) HO01 stock — ${fmtQty(r.qcHo)} in Quality Inspection (see Notes column)">0</span>`
        : fmtQty(v) },
    { key: "netSohHo", label: "Net SOH HO01 (after Pending Dispatch)", raw: true,
      fmt: (v, r) => r.outboundTotal > 0
        ? `<span class="brd-note-scale" title="${fmtQty(r.sohHo)} raw SOH − ${fmtQty(r.outboundTotal)} already committed to open (not-yet-issued) pending dispatch at HO01, across all branches — this is the number allocation actually uses">${fmtQty(v)}</span>`
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
        if (r.qcOnly) bits.push(`<span class="brd-status-pill brd-status-amber" title="HO01 stock (${fmtQty(r.qcHo)}) is still in Quality Inspection — not yet releasable">🧪 ${fmtQty(r.qcHo)} Quality Inspection</span>`);
        if (r.outboundQty > 0) bits.push(`<span class="brd-status-pill brd-status-blue" title="${fmtQty(r.outboundQty)} of this material is already on an open (not-yet-issued) pending dispatch from HO01 to this branch — netted out of Need below">📦 ${fmtQty(r.outboundQty)} pending dispatch (HO01)</span>`);
        if (r.isPartial) bits.push(`<span class="brd-status-pill brd-status-amber" title="HO01 short overall for this material (covers ${Math.round(r.scalePct * 100)}% of combined need) — priority allocation filled THIS branch's own need ${Math.round(r.fillPct * 100)}% (${escHtml(r.priorityLabel)} priority)">⚖️ ${Math.round(r.fillPct * 100)}%</span>`);
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
    // The code/pack size to actually PUT ON THE REQUEST — resolved from the
    // mapped (AMC-tracking) code down to whatever real, orderable source
    // code exists for this material and stock type (see reqSourceCode on
    // brdBuildLines). Mapped Code column intentionally omitted here (it's
    // shown on the Analysis tab) — Request Form only needs the actual
    // material code to put on the requisition.
    { key: "reqSourceCode", label: "Material Code", raw: true,
      fmt: (v, r) => r.reqSourceDiffers
        ? `<span class="col-mat-code" title="${r.reqSourceTypeMatched ? '' : 'No source code found for this line\'s own Q/RDF stock type — falling back to the mapping table\'s other candidate(s). Double-check before approving.'}">${escHtml(v)}${!r.reqSourceTypeMatched ? ' <span class="brd-note-noamc">⚠ check type</span>' : ""}</span>`
        : `<span class="col-mat-code">${escHtml(v)}</span>` },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "plant", label: "Branch" },
    { key: "priorityTier", label: "Priority", raw: true, fmt: (v, r) => brdPriorityBadge(v) },
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

  const workingRows = approved.map(l => {
    return {
      code: l.code, desc: l.desc, plant: l.plant,
      soh: l.soh, amc: l.hasAmc ? l.amc : "Not Committed",
      mosNow: l.mosNow === null ? "N/A" : (l.mosNow === Infinity ? "Infinite" : Number(l.mosNow).toFixed(2)),
      priority: l.priorityLabel || "",
      need: Number(l.need).toFixed(0), alloc: Number(l.alloc).toFixed(0),
      mosAfter: l.mosAfter === null ? "N/A" : (l.mosAfter === Infinity ? "Infinite" : Number(l.mosAfter).toFixed(2)),
      sohHo: l.sohHo,
      // reqSourceCode/reqSourceFactor/reqSourceQty come straight off the
      // line (see brdBuildLines) so the Working sheet and the SAP_Paste
      // sheet below always agree with each other AND with what's shown
      // on-screen in the Request Form tab — all three now resolve the
      // available code via the SAME stock-type-aware brdPrimarySource()
      // call, instead of the export recomputing it separately (which used
      // to skip the stock-type preference the on-screen table now uses).
      requestCode: l.reqSourceCode, requestQty: Number(l.reqSourceQty).toFixed(0),
      factor: l.reqSourceFactor, codeChanged: l.reqSourceDiffers ? "Yes" : "No",
      stockType: l.stockTypeLabel || "Unclassified",
      purchGroup: l.purchGroup || "", purchOrg: l.purchOrg || "",
      storageLoc: l.storageLoc || "", storageLocSource: l.storageLoc ? (l.storageLocInferred ? "Inferred — no existing stock record" : "From branch stock record") : "Not found",
      status: l.status, approved: l.approved ? "Yes" : "No",
    };
  });
  const workingCols = [
    { key: "code", label: "Mapped Code" }, { key: "desc", label: "Description" }, { key: "plant", label: "Branch" },
    { key: "soh", label: "SOH Branch" }, { key: "amc", label: "AMC" }, { key: "mosNow", label: "MOS Now" },
    { key: "priority", label: "Priority" },
    { key: "need", label: `Need (to ${TARGET_MOS})` }, { key: "alloc", label: "Allocated (mapped units)" }, { key: "mosAfter", label: "MOS After" },
    { key: "sohHo", label: "SOH HO01" },
    { key: "requestCode", label: "Request As (Available Code)" }, { key: "requestQty", label: "Qty (Available Pack)" },
    { key: "factor", label: "Factor (available→mapped)" }, { key: "codeChanged", label: "Code Changed From Mapped?" },
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
    return [
      "", "", "", "U",                        // Status, Item of requisition, Acct Assignment Cat., Item Category
      l.reqSourceCode, "", Number(l.reqSourceQty).toFixed(0), "", // Material, Short Text (SAP derives this — leave blank), Quantity requested, Unit of Measure
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
    showError("Exported — but both sheets are empty because no lines are checked/approved yet. Check the boxes for the lines you want, then re-export.");
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

    const programClassEl = document.getElementById("brd-program-class");
    if (programClassEl) programClassEl.addEventListener("change", () => {
      brdProgramClass = programClassEl.value;
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

    // Counterpart to "Approve Visible" — clears the checkbox/approved state
    // on every row currently on screen (both tabs, same rationale as
    // above), so a user can back out of a bulk-select without unchecking
    // rows one at a time. Same brdCanEdit() gate as Approve Visible /
    // Export Template — only shown to roles that can edit this page.
    const deselectAllBtn = document.getElementById("brd-deselect-all");
    if (deselectAllBtn) deselectAllBtn.addEventListener("click", () => {
      document.querySelectorAll("#brd-table .brd-approve-cb, #brd-request-table .brd-approve-cb").forEach(cb => {
        const key = brdDraftKey(cb.dataset.plant, cb.dataset.code);
        const d = brdDraft.get(key) || {};
        d.approved = false;
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
