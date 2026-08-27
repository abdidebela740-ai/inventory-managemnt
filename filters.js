// =============================================================================
// PharmaTrack v2 — filters.js
// Exclusion rules for non-medical / non-pharmaceutical materials.
// This file MUST be loaded before script.js.
//
// isNonMedicalCode(materialCode)           → true = exclude this row
// isNonMedicalGroup(groupName)             → true = exclude this row
// isExcludedStorageLocation(storageLoc)    → true = exclude this row
//
// Special Stock Type (Q/blank-only) and Inventory Valuation Type (blank)
// exclusions now live in permissions.js's passesUniversalExclusions() —
// see the classification rebuild note there.
// =============================================================================

/**
 * Returns true if the material code is a valid pharmaceutical code.
 * Pharmaceutical SAP material codes start with 1, 2, 3, or 4.
 * Used internally by isNonMedicalCode and available for external callers.
 */
function isMedicalCode(code) {
  if (!code) return false;
  const c = String(code).trim();
  if (!c) return false;
  return /^[1234]/.test(c);
}

/**
 * Returns true if the material code looks like a non-medical / non-trade item
 * that should be excluded from pharmaceutical inventory analysis.
 *
 * Exclusion rules:
 *   - Codes starting with "NT" (Non-Trade)
 *   - Codes that do NOT start with 1, 2, 3, or 4 (pharmaceutical SAP codes)
 *   - Empty / blank codes
 *
 * FIX-R9: now implemented as the negation of isMedicalCode (DRY) with the
 * additional NT prefix guard, so both functions stay consistent.
 */
function isNonMedicalCode(code) {
  if (!code) return true;
  const c = String(code).trim().toUpperCase();
  if (!c) return true;

  // Non-Trade prefix — excluded even though it starts with a letter, not 1-4
  if (c.startsWith("NT")) return true;

  // Delegate to isMedicalCode for the numeric prefix check
  return !isMedicalCode(c);
}

/**
 * Returns true if the material group name is a non-medical category
 * that should be excluded from pharmaceutical inventory analysis.
 *
 * Common EPSS group names to exclude.
 * Extend this list to match your actual material group naming.
 */
function isNonMedicalGroup(groupName) {
  if (!groupName) return false;
  const g = String(groupName).trim().toUpperCase();
  if (!g) return false;

  const EXCLUDED_GROUPS = [
    "NON TRADE",
    "NON-TRADE",
    "NONTRADE",
    "PROJECT STOCK",
    "SERVICES",
    "ASSETS",
    "OFFICE SUPPLIES",
    "STATIONERY",
    "SPARE PARTS",
    "EQUIPMENT",
    "FURNITURE",
  ];

  return EXCLUDED_GROUPS.some(ex => g.includes(ex));
}

/**
 * EXCEPTION LIST — materials whose "Inventory Valuation Type" column carries
 * the wrong suffix in the source SAP export. Confirmed via
 * INVENTORY_VALUATION_CHECK_UP.xlsx ("ZLC Correction List"): these 6
 * material codes are tagged "..._ZLC" in the data, but are actually Medical
 * Supply (ZMS) materials — a data-entry/mapping issue upstream in SAP, not
 * something this app can fix at the source. Keyed by bare Material Code
 * (uppercased, trimmed) → the CORRECT suffix. getValuationType() below
 * checks this map before falling back to parsing the raw suffix, so every
 * consumer of Material Type (filter-bar checklists, role/scope checks,
 * MOS, Branch Demand, Request Analysis, Shelf-Life, dashboard charts, etc.)
 * automatically treats these codes as ZMS everywhere, from this one place.
 *
 * To add another correction later: add another "CODE": "SUFFIX" entry here.
 */
const VALUATION_TYPE_EXCEPTIONS = {
  "301-BAEL-0105":      "ZMS", // Bandage Elastic - 8cm x 5m
  "301-GABA-0105-02":   "ZMS", // Gauze Bandage - 12.5cmx5m of 12 Pieces
  "302-CAIV-0501-02":   "ZMS", // Cannula Intravenous Set - 24G of 100
  "306-ADPL-0706":      "ZMS", // Adhesive Plaster Zinc Oxide -7.5cm x10m
  "306-TOUL-0701-02":   "ZMS", // Tourniquet latexfr.Fl.750*18mm(50cm)of25
  "303-SHNO-0601-02":   "ZMS", // Shoecover Non-Skid - of 100
};

/**
 * Extracts the valuation type suffix from an "Inventory Valuation Type" value.
 *
 * SAP stores these as "<code>_<SUFFIX>" e.g. "50833_ZME", "023_ZLC", "EPSS1_ZMS".
 * We extract everything after the last underscore and return it uppercased.
 *
 * Known suffixes in use: ZME, ZLC, ZMS, ZMD.
 * Returns "(None)" for blank / unrecognised values so the filter dropdown always
 * has a clean, displayable label for every row.
 *
 * Checks VALUATION_TYPE_EXCEPTIONS first (by Material Code) — a handful of
 * codes are mistagged ZLC in the source data and should read as ZMS instead;
 * see that map's comment for details.
 */
function getValuationType(row) {
  if (!row) return "(None)";
  const code = String(row["Material"] || "").trim().toUpperCase();
  if (code && VALUATION_TYPE_EXCEPTIONS[code]) return VALUATION_TYPE_EXCEPTIONS[code];
  const raw = String(row["Inventory Valuation Type"] || "").trim();
  if (!raw) return "(None)";
  const lastUnderscore = raw.lastIndexOf("_");
  if (lastUnderscore === -1 || lastUnderscore === raw.length - 1) return raw.toUpperCase() || "(None)";
  return raw.substring(lastUnderscore + 1).toUpperCase();
}

/**
 * Returns true if the Storage Location code is in the excluded list.
 *
 * These locations hold non-pharmaceutical / project / administrative stock
 * and must be excluded from all inventory analysis.
 */
function isExcludedStorageLocation(storageLoc) {
  if (!storageLoc) return false;
  const s = String(storageLoc).trim().toUpperCase();
  if (!s) return false;

  const EXCLUDED_LOCATIONS = [
    "AA1G", "AA2G", "ADG1", "ARG1", "ASG1",
    "BDG1", "DDG1", "DEG1", "GAG1", "GOG1",
    "HAG1", "HOG1", "HOG2", "JIG1", "JJG1",
    "KDG1", "MKG1", "NBG1", "NKG1", "SEG1",
    "SHG1",
  ];

  return EXCLUDED_LOCATIONS.includes(s);
}
