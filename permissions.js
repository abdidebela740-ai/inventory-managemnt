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
window.roleBadgeText        = roleBadgeText;
window.roleBadgeTooltip     = roleBadgeTooltip;
window.ROLE_LABELS          = ROLE_LABELS;
