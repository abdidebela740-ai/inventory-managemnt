// =============================================================================
// PharmaTrack v2 — filters.js
// Exclusion rules for non-medical / non-pharmaceutical materials.
// This file MUST be loaded before script.js.
//
// isNonMedicalCode(materialCode)           → true = exclude this row
// isNonMedicalGroup(groupName)             → true = exclude this row
// isProjectStockDescription(description)   → true = exclude this row
// isExcludedStorageLocation(storageLoc)    → true = exclude this row
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
 * Returns true if the Special Stock Type Description indicates Project Stock.
 *
 * This catches rows where the Special Stock Type code is not "Q" but the
 * description still resolves to "Project Stock" — both must be excluded.
 */
function isProjectStockDescription(description) {
  if (!description) return false;
  const d = String(description).trim().toUpperCase();
  if (!d) return false;
  return d === "PROJECT STOCK";
}

/**
 * Extracts the valuation type suffix from an "Inventory Valuation Type" value.
 *
 * SAP stores these as "<code>_<SUFFIX>" e.g. "50833_ZME", "023_ZLC", "EPSS1_ZMS".
 * We extract everything after the last underscore and return it uppercased.
 *
 * Known suffixes in use: ZME, ZLC, ZMS, ZMD.
 * Returns "(None)" for blank / unrecognised values so the filter dropdown always
 * has a clean, displayable label for every row.
 */
function getValuationType(row) {
  if (!row) return "(None)";
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
