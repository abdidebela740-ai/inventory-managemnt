// ════════════════════════════════════════════════════════════════
// permissions.js — role & data-scope permission API
//
// Load order matters:
//   auth.js  → populates window.APP_USER / window.isAdmin
//   filters.js → provides getValuationType() / isNonMedicalCode() / etc
//   permissions.js  ← this file (needs both of the above)
//   script.js, mos.js, shelf-life.js, etc → call into this file
//
// window.APP_USER shape (set by auth.js after login):
//   {
//     id, email, full_name, role, status,
//     data_scopes: ["Q_ZME", "R_ZLC", ...],
//     sidebar_permissions: { "transit": true, "expiry": false, ... }
//   }
// ════════════════════════════════════════════════════════════════

const ROLE_LABELS = {
  admin: "Admin",
  director: "Director",
  deputy_director: "Deputy Director",
  team_leader: "Team Leader",
  branch_demand_officer: "Branch Demand Officer",
  user: "User",
};

const VALID_VALUATION_SUFFIXES = ["ZME", "ZMS", "ZLC", "ZMD"];

// ── BASIC ROLE CHECKS ───────────────────────────────────────────
function computeIsAdmin() {
  return !!window.isAdmin;
}

function currentRole() {
  return window.APP_USER ? window.APP_USER.role : null;
}

// Director & Deputy Director share every permission except that they can
// only ever change a user's role (enforced server-side by
// admin_update_user_role() — this is just for UI gating).
function isDirectorLike() {
  const r = currentRole();
  return r === "director" || r === "deputy_director";
}

function canManageRoles() {
  return computeIsAdmin() || isDirectorLike();
}

// True only for Admin — Directors can EDIT roles but not create/delete/
// deactivate users or touch sidebar permissions/data scopes.
function canManageUsersFully() {
  return computeIsAdmin();
}

// ── SIDEBAR / MODULE PERMISSIONS ────────────────────────────────
// Admin always has every module. Everyone else needs an explicit `true`
// in their sidebar_permissions map — the default for a newly created user
// is an empty map (nothing on), per the "minimal default, customize per
// user" decision.
function canAccessModule(moduleKey) {
  if (computeIsAdmin()) return true;
  if (!window.APP_USER) return false;
  const perms = window.APP_USER.sidebar_permissions || {};
  return perms[moduleKey] === true;
}

// ── DATA SCOPES ──────────────────────────────────────────────────
function getUserScopes() {
  return (window.APP_USER && Array.isArray(window.APP_USER.data_scopes))
    ? window.APP_USER.data_scopes
    : [];
}

/**
 * Computes a row's scope code, e.g. "Q_ZME" or "R_ZLC".
 *   Special Stock Type "Q"      → prefix "Q" (Health Program Drugs)
 *   Special Stock Type blank/*  → prefix "R" (RDF Drugs) — "W" is handled
 *                                  separately as a universal exclusion, so
 *                                  it never reaches this function in practice.
 *   Inventory Valuation Type    → suffix via getValuationType() (filters.js)
 *
 * Returns null when the valuation suffix isn't one of the four known types
 * — callers must treat null as "deny", never as "allow everything".
 */
function getRowScopeCode(row) {
  if (!row) return null;
  const sst = String(row["Special Stock Type"] || "").trim().toUpperCase();
  const prefix = sst === "Q" ? "Q" : "R";
  const valType = (typeof getValuationType === "function")
    ? getValuationType(row)
    : String(row["Inventory Valuation Type"] || "").trim().toUpperCase();
  if (!VALID_VALUATION_SUFFIXES.includes(valType)) return null;
  return `${prefix}_${valType}`;
}

/**
 * Row-level access check. Admin bypasses scope restriction entirely.
 * Everyone else needs the row's computed scope code to be in their
 * assigned data_scopes.
 *
 * NOTE: this does NOT apply the universal invariants (W / non-medical /
 * project-stock / excluded storage location) — those apply to Admin too
 * and are handled separately by passesUniversalExclusions(). Always use
 * filterRowsByAccess() at call sites rather than canAccessRow() alone.
 */
function canAccessRow(row) {
  if (computeIsAdmin()) return true;
  const scope = getRowScopeCode(row);
  if (!scope) return false;
  return getUserScopes().includes(scope);
}

// ── UNIVERSAL EXCLUSIONS (apply to EVERY role, including Admin) ──
// This replaces the old hardcoded `s !== "Q" && s !== "W"` check that used
// to live in script.js: "W" (project stock) stays hard-excluded for
// everyone, "Q" is no longer blanket-excluded — it's scope-gated instead
// via canAccessRow() above.
function passesUniversalExclusions(row) {
  if (!row) return false;
  const sst = String(row["Special Stock Type"] || "").trim().toUpperCase();
  if (sst === "W") return false;
  // BUGFIX: SAP always labels the "Special Stock Type Description" field as
  // "Project Stock" for rows whose Special Stock Type code is "Q" — that's
  // just SAP's generic text for any special-stock indicator, not a sign the
  // row is genuinely project stock. This check is only meant to catch rows
  // where the CODE isn't "Q" but the description still reads "Project Stock"
  // (see filters.js comment on isProjectStockDescription). Without the
  // `sst !== "Q"` guard below, every real Q row was being excluded here
  // before the Q-scope logic in canAccessRow() ever got a chance to run —
  // so Q rows never appeared even for Admin.
  if (sst !== "Q" &&
      typeof isProjectStockDescription === "function" &&
      isProjectStockDescription(row["Special Stock Type Description"])) return false;
  if (typeof isNonMedicalCode === "function" &&
      isNonMedicalCode(row["Material"])) return false;
  if (typeof isNonMedicalGroup === "function" &&
      isNonMedicalGroup(row["Material Group Name"])) return false;
  if (typeof isExcludedStorageLocation === "function" &&
      isExcludedStorageLocation(row["Storage Location"])) return false;
  return true;
}

/**
 * THE central filtering helper. Every module that turns a raw uploaded
 * sheet into usable rows should filter through this — it's the single
 * choke point that enforces both the universal data-quality invariants
 * and the signed-in user's role/scope access in one pass.
 */
function filterRowsByAccess(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(r => passesUniversalExclusions(r) && canAccessRow(r));
}

// ── FILTER-OPTION LISTS (data-scope + upload-aware) ─────────────
// Several pages show a "Material Type" (ZME/ZMS/ZLC/ZMD) or "Stock Type"
// (Q/RDF) checklist. These used to be hardcoded to the full static list
// everywhere, so e.g. a "Q_ZME"-scoped user would see ZMS/ZLC/ZMD and RDF
// as choosable options in the filter bar even though every row of those
// types is invisible to them (and, separately, even an Admin would see a
// type in the list that has zero rows in whatever file is currently
// loaded). The two helpers below fix both problems at once:
//   - Admin/full-access: always the complete static list, regardless of
//     what's in the current upload (spec: "Admin always sees full list").
//   - Everyone else: the intersection of (a) types the user's data_scopes
//     actually grant them, and (b) types with at least one row in the
//     rows currently passed in. Passing an already access-filtered array
//     (e.g. rawDf, baseDf, or a page's own scope-filtered STATE.rows)
//     naturally satisfies both at once; the explicit scope check here is
//     just defence-in-depth in case a caller passes unfiltered rows.

/**
 * Material Type (ZME/ZMS/ZLC/ZMD) options for a filter checklist.
 * `rows` should be the rows currently available to build the list from
 * (ideally already access-filtered, e.g. rawDf/baseDf).
 */
function materialTypeFilterOptions(rows) {
  if (computeIsAdmin()) return [...VALID_VALUATION_SUFFIXES];
  const scopedSuffixes = new Set(
    getUserScopes().map(s => String(s).split("_")[1]).filter(Boolean)
  );
  const present = new Set(
    (Array.isArray(rows) ? rows : []).map(r =>
      (typeof getValuationType === "function")
        ? getValuationType(r)
        : String(r["Inventory Valuation Type"] || "").trim().toUpperCase()
    )
  );
  return VALID_VALUATION_SUFFIXES.filter(t => scopedSuffixes.has(t) && present.has(t));
}

/**
 * Stock Type (Q / RDF) options for a filter checklist, e.g. Pending
 * Dispatch. `rows` should be the rows currently available (ideally already
 * access-filtered). `prefixOfRow` optionally overrides how a row's Q/R
 * prefix is derived — needed on pages whose row shape doesn't have a
 * "Special Stock Type" field (e.g. pending-dispatch.js's parsed rows use
 * `row.specialStock`); defaults to the standard SAP export field.
 */
function stockTypeFilterOptions(rows, prefixOfRow) {
  if (computeIsAdmin()) return ["Q", "RDF"];
  const getPrefix = typeof prefixOfRow === "function" ? prefixOfRow : (r) => {
    const sst = String(r["Special Stock Type"] || "").trim().toUpperCase();
    return sst === "Q" ? "Q" : "R";
  };
  const scopedPrefixes  = new Set(getUserScopes().map(s => String(s).split("_")[0]));
  const presentPrefixes = new Set((Array.isArray(rows) ? rows : []).map(getPrefix));
  const out = [];
  if (scopedPrefixes.has("Q") && presentPrefixes.has("Q")) out.push("Q");
  if (scopedPrefixes.has("R") && presentPrefixes.has("R")) out.push("RDF");
  return out;
}

// ── ROLE BADGE TEXT (spec #4) ──────────────────────────────────
// "Team Leader · Q_ZME"  |  "Team Leader · Q_ZME + Q_ZMS"  |
// "Team Leader · 3 scopes" (tooltip should show scopes.join(", ") for this case)
// "Admin · Full Access"
function roleBadgeText() {
  if (!window.APP_USER) return "";
  if (computeIsAdmin()) return "Admin · Full Access";
  const roleLabel = ROLE_LABELS[currentRole()] || currentRole() || "User";
  const scopes = getUserScopes();
  if (scopes.length === 0) return `${roleLabel} · No Scopes Assigned`;
  if (scopes.length <= 2) return `${roleLabel} · ${scopes.join(" + ")}`;
  return `${roleLabel} · ${scopes.length} scopes`;
}

// Full scope list for the badge's tooltip (used when scopes.length > 2).
function roleBadgeTooltip() {
  return getUserScopes().join(", ");
}

// ── FIRST ACCESSIBLE MODULE (auto-redirect target) ─────────────────
// Module keys that map to a real renderPage() page, in a sensible
// fallback order. Keep this in sync with PAGE_RENDERERS / RAWDF_EXEMPT_PAGES
// in script.js — those are the only ids renderPage() actually knows how to
// display. ("user-management", "quick-lookup", "allocation-tool", etc. are
// deliberately excluded: they aren't renderPage() targets, they navigate
// through their own separate flow.)
const NAVIGABLE_MODULE_KEYS = [
  "dashboard", "pending-dispatch", "transit", "branch", "expiry", "qc",
  "expiry-risk", "stockout-risk", "natl-table", "concentration",
  "request-analysis", "mos-plant",
];

/**
 * Returns the first module key the signed-in user actually has permission
 * to open, or null if they have none at all.
 *
 * Used to send a user straight to a module they're allowed to see instead
 * of showing an "access denied" message — e.g. right after login, when the
 * app defaults to "dashboard" but that user's role doesn't include it, or
 * whenever navigation would otherwise land on a page their
 * sidebar_permissions don't grant.
 *
 * Order preference: the DB-driven app_modules.sort_order (so it reflects
 * however the org has configured module ordering) when window.APP_MODULES
 * has loaded, falling back to the static NAVIGABLE_MODULE_KEYS order
 * otherwise. Either way, only keys renderPage() can actually display are
 * considered.
 */
function firstAccessibleModule() {
  const dbOrder = Array.isArray(window.APP_MODULES)
    ? window.APP_MODULES.filter(m => m.active !== false).map(m => m.key)
    : [];
  const candidates = [...new Set([...dbOrder, ...NAVIGABLE_MODULE_KEYS])]
    .filter(k => NAVIGABLE_MODULE_KEYS.includes(k));
  return candidates.find(k => canAccessModule(k)) || null;
}

// ── EXPORTS ──────────────────────────────────────────────────────
window.isAdminUser          = computeIsAdmin;
window.currentRole          = currentRole;
window.isDirectorLike       = isDirectorLike;
window.canManageRoles       = canManageRoles;
window.canManageUsersFully  = canManageUsersFully;
window.canAccessModule      = canAccessModule;
window.getUserScopes        = getUserScopes;
window.getRowScopeCode      = getRowScopeCode;
window.canAccessRow         = canAccessRow;
window.passesUniversalExclusions = passesUniversalExclusions;
window.filterRowsByAccess   = filterRowsByAccess;
window.materialTypeFilterOptions = materialTypeFilterOptions;
window.stockTypeFilterOptions    = stockTypeFilterOptions;
window.roleBadgeText        = roleBadgeText;
window.roleBadgeTooltip     = roleBadgeTooltip;
window.firstAccessibleModule = firstAccessibleModule;
window.ROLE_LABELS          = ROLE_LABELS;
