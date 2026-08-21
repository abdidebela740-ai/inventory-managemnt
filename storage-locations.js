// =============================================================================
// PharmaTrack v2 — storage-locations.js
// Shared plant/storage-location reference table
// -----------------------------------------------------------------------------
// Source: demand_storage.xlsx (a hand-supplied plant/storage-location
// reference list) — every Storage Location code that exists for every plant,
// which Special Stock Type(s) it's used for, and whether it is a cold or
// non-cold location.
//
// v2 UPDATE (this revision)
// --------------------------
// The reference file was corrected/re-supplied and changed shape:
//   1. Every plant's generic/blank-type location (the old *G1 / *G2 codes —
//      e.g. AA1G, ARG1, HOG1/HOG2, JIG1, KDG1, MKG1, etc.) was REMOVED from
//      the list entirely. Those codes no longer appear as valid reference
//      locations for any plant.
//   2. Special Stock Type is no longer just "Q" or blank — it's now one of
//      three values: "Q", "RDF", or "Q AND RDF" (a location can legitimately
//      hold both stock types). See storageLocationServesScope() below for
//      how this is matched against a material's own Q/R classification.
//   3. DE01 no longer has ANY cold location in the reference list — DEC1 is
//      listed as Non cold and DEG1 (previously DE01's only cold code) has
//      been removed outright. If DE01 is actually expected to have a cold
//      location, that's missing from this source file — flagging it here
//      rather than guessing one back in.
//   4. MK01 specifically: MKBI is now "Q AND RDF" / Non cold (previously
//      "Q" only). MKG1 (RDF, Non cold) was removed, leaving MKBI and MKM1 as
//      MK01's only two non-cold codes, both serving Q AND RDF — so nothing
//      in the Special Stock Type column can tell them apart anymore for a
//      brand-new MK01 line; brdNonColdCodeForPlant() falls back to whichever
//      of the two is actually used most often in MK01's own live inventory
//      data when that happens (see branch-demand.js).
//
// WHY THIS FILE EXISTS
// ---------------------
// Both branch-demand.js and request-analysis.js need to know, for a given
// plant, which Storage Location code(s) are "cold" vs "non-cold" (temperature
// zone reconciliation against HO01). Both used to hand-maintain their OWN
// copy of that table, with a comment in each telling a human to keep the
// other one in sync by hand. This file replaces both copies with the actual
// source list, loaded once, so there is exactly one place to update if a
// plant's storage-location codes ever change — see PLANT_STORAGE_LOCATIONS
// below. Branch Demand still checks the branch's OWN live inventory data for
// an existing stock record first (see brdStorageLocationForBranch() in
// branch-demand.js) — this reference table is only the fallback used when a
// branch has never stocked a given material before.
//
// Requires: nothing. Must be loaded BEFORE branch-demand.js and
// request-analysis.js (both reference the globals defined here).
// =============================================================================

// Plant -> array of { loc, specialStockType, cold }, one entry per Storage
// Location code that plant actually uses, straight from demand_storage.xlsx.
//   specialStockType: "Q" | "RDF" | "Q AND RDF" — which stock type(s) this
//                      location is used for.
//   cold:             true = cold storage, false = non-cold
// HO01 (the hub) is included here too, same shape as every branch.
const PLANT_STORAGE_LOCATIONS = {
  AA01: [
    { loc: "AA11", specialStockType: "RDF", cold: false },
    { loc: "AA1C", specialStockType: "Q AND RDF", cold: true },
    { loc: "AA1P", specialStockType: "Q", cold: false },
  ],
  AA02: [
    { loc: "AA21", specialStockType: "RDF", cold: false },
    { loc: "AA22", specialStockType: "RDF", cold: false },
    { loc: "AA2C", specialStockType: "Q AND RDF", cold: true },
    { loc: "AA2P", specialStockType: "Q", cold: false },
  ],
  AD01: [
    { loc: "ADC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "ADM1", specialStockType: "Q AND RDF", cold: false },
    { loc: "APWM", specialStockType: "Q", cold: false },
  ],
  AR01: [
    { loc: "AMC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "AMM1", specialStockType: "Q AND RDF", cold: false },
  ],
  AS01: [
    { loc: "ASC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "ASM1", specialStockType: "Q AND RDF", cold: false },
  ],
  BD01: [
    { loc: "BDC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "BDM1", specialStockType: "Q AND RDF", cold: false },
  ],
  // NOTE: per the current reference file, DE01 has NO cold location at all
  // — DEC1 is listed Non cold, and DEG1 (DE01's only cold code in the prior
  // version of this file) has been removed. Double-check this against SAP /
  // the branch before relying on it — a plant with genuinely no cold
  // storage is unusual, so this may be a gap in the source list rather than
  // a real fact about DE01.
  DE01: [
    { loc: "DEC1", specialStockType: "Q AND RDF", cold: false },
    { loc: "DEM1", specialStockType: "Q AND RDF", cold: false },
  ],
  DI01: [
    { loc: "DDC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "DDM1", specialStockType: "Q AND RDF", cold: false },
  ],
  GA01: [
    { loc: "GAC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "GAM1", specialStockType: "Q AND RDF", cold: false },
  ],
  GO01: [
    { loc: "GOC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "GOM1", specialStockType: "Q AND RDF", cold: false },
  ],
  HA01: [
    { loc: "HAC1", specialStockType: "Q", cold: true },
    { loc: "HAC2", specialStockType: "RDF", cold: true },
    { loc: "HAM1", specialStockType: "Q AND RDF", cold: false },
  ],
  HO01: [
    { loc: "HMO1", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOA2", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOA3", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOA5", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOA7", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOM1", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOM3", specialStockType: "Q AND RDF", cold: true },
    { loc: "HOM4", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOM6", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOM7", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOM8", specialStockType: "Q AND RDF", cold: true },
    { loc: "HOM9", specialStockType: "Q AND RDF", cold: true },
    { loc: "HOS2", specialStockType: "Q AND RDF", cold: false },
    { loc: "HOS3", specialStockType: "Q AND RDF", cold: false },
  ],
  JI01: [
    { loc: "JMC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "JMM1", specialStockType: "Q AND RDF", cold: false },
  ],
  JJ01: [
    { loc: "JJC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "JJHP", specialStockType: "Q", cold: false },
    { loc: "JJM1", specialStockType: "Q AND RDF", cold: false },
  ],
  KD01: [
    { loc: "KDC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "KDM1", specialStockType: "Q AND RDF", cold: false },
  ],
  // MK01 — see "v2 UPDATE" note above: MKBI is now Q AND RDF (was Q-only),
  // and MKG1 (the old RDF-only non-cold code) is gone, so MKBI and MKM1 are
  // MK01's only two non-cold codes and both now serve either stock type.
  MK01: [
    { loc: "MKBI", specialStockType: "Q AND RDF", cold: false },
    { loc: "MKC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "MKM1", specialStockType: "Q AND RDF", cold: false },
  ],
  NB01: [
    { loc: "NBC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "NBM1", specialStockType: "Q AND RDF", cold: false },
  ],
  NK01: [
    { loc: "NKC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "NKM1", specialStockType: "Q AND RDF", cold: false },
  ],
  SE01: [
    { loc: "SEC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "SEM1", specialStockType: "Q AND RDF", cold: false },
  ],
  SH01: [
    { loc: "SHC1", specialStockType: "Q AND RDF", cold: true },
    { loc: "SHM1", specialStockType: "Q AND RDF", cold: false },
  ],
};

// ── DERIVED LOOKUPS (built once, below, from PLANT_STORAGE_LOCATIONS) ──────

// Plant -> array of cold Storage Location codes. Kept under the same name
// both files previously hard-coded, so nothing else has to change shape.
const PLANT_COLD_STORAGE_LOCATIONS = {};
// Plant -> array of non-cold Storage Location codes (the full reference
// list, not just "whatever's most common in live data" — request-analysis.js
// already treated "any code not in PLANT_COLD_STORAGE_LOCATIONS" as
// non-cold, so this is mainly useful to branch-demand.js's inference step,
// which needs to pick a real, known non-cold code rather than guess.
const PLANT_NONCOLD_STORAGE_LOCATIONS = {};
Object.keys(PLANT_STORAGE_LOCATIONS).forEach(plant => {
  const locs = PLANT_STORAGE_LOCATIONS[plant];
  PLANT_COLD_STORAGE_LOCATIONS[plant] = locs.filter(l => l.cold).map(l => l.loc);
  PLANT_NONCOLD_STORAGE_LOCATIONS[plant] = locs.filter(l => !l.cold).map(l => l.loc);
});

// HO01's own cold storage locations — was a separately hand-maintained
// constant in both files (HOM3/HOM8/HOM9); now just HO01's row above.
const HO01_COLD_LOCATIONS = PLANT_COLD_STORAGE_LOCATIONS["HO01"] || ["HOM3", "HOM8", "HOM9"];

// Whether a given plant+location is a confirmed cold location per the
// reference table. Returns true/false when known, or null when the plant or
// that exact location code isn't in PLANT_STORAGE_LOCATIONS at all (so
// callers can tell "confirmed non-cold" apart from "no reference data" —
// same "don't guess without a signal" convention the rest of this app uses).
function isStorageLocationCold(plant, loc) {
  const list = PLANT_STORAGE_LOCATIONS[String(plant || "").trim().toUpperCase()];
  if (!list) return null;
  const hit = list.find(l => l.loc === String(loc || "").trim().toUpperCase());
  return hit ? hit.cold : null;
}

// The reference table's raw Special Stock Type string ("Q", "RDF", or
// "Q AND RDF") for a given plant+location, or null when the plant/location
// isn't in the table.
function storageLocationSpecialStockType(plant, loc) {
  const list = PLANT_STORAGE_LOCATIONS[String(plant || "").trim().toUpperCase()];
  if (!list) return null;
  const hit = list.find(l => l.loc === String(loc || "").trim().toUpperCase());
  return hit ? (hit.specialStockType || "") : null;
}

// Whether a plant+location's Special Stock Type serves the given material
// scope prefix ("Q" for Health Program, "R" for RDF — see brdMaterialScope()
// in branch-demand.js). "Q AND RDF" locations serve both. Returns null when
// the plant/location isn't in the reference table at all (unknown, not a
// non-match), so callers can tell the two apart.
function storageLocationServesScope(plant, loc, scopePrefix) {
  const sst = storageLocationSpecialStockType(plant, loc);
  if (sst === null) return null;
  if (sst === "Q AND RDF") return true;
  if (scopePrefix === "Q") return sst === "Q";
  return sst === "RDF";
}
