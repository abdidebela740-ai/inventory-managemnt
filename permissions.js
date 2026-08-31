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

// ── PLANT SCOPING ────────────────────────────────────────────────
// Single source of truth for the "restrict a user to one branch/plant"
// feature configured in Advanced User Management (see user-management.js
// PLANT_OPTIONS / field-hint, and window.APP_USER.plant set in auth.js).
//
// Rules (per the user-management field hint + auth.js comments this was
// always meant to back):
//   - Admin always sees every plant (hasFullPlantAccess()).
//   - A user whose plant is unset or "HO01" (Head Office) sees every plant.
//   - Any other plant code restricts that user to that plant ONLY, plus the
//     HO01 hub itself (Branch Demand and similar hub-vs-branch views need to
//     show what stock Head Office has available even to a branch-locked
//     user).
//
// NOTE: these were previously referenced by comments/defensive
// `typeof fn === "function"` checks throughout mos.js / pending-dispatch.js /
// auth.js / user-management.js but never actually implemented here — which
// meant plant restriction silently did nothing anywhere in the app
// (dashboard, expiry watch list, quality inspection / New Received Stock,
// branch comparison, etc. all showed every plant to every user regardless
// of their assigned branch). This block is that missing implementation.
// NOTE: named PERM_HUB_PLANT, not HUB_PLANT — mos.js also declares a
// top-level `const HUB_PLANT`. Both files load as plain (non-module)
// <script> tags sharing one global lexical scope, so two top-level `const
// HUB_PLANT` declarations collide: the second one to load (mos.js, since it
// loads after permissions.js) throws `SyntaxError: Identifier 'HUB_PLANT'
// has already been declared` at parse time, which aborts ALL of mos.js
// before any of its code runs — silently killing the AMC upload handler,
// mosMerged, etc. Keep this name distinct from mos.js's HUB_PLANT.
const PERM_HUB_PLANT = "HO01";

function hasFullPlantAccess() {
  return computeIsAdmin();
}

function getUserPlant() {
  return (window.APP_USER && window.APP_USER.plant)
    ? String(window.APP_USER.plant).trim().toUpperCase()
    : null;
}

// True when this user has no plant restriction at all — i.e. Admin, or a
// user whose plant is unset / explicitly HO01.
function isHeadOfficeUser() {
  if (hasFullPlantAccess()) return true;
  const p = getUserPlant();
  return !p || p === PERM_HUB_PLANT;
}

/**
 * Row/dropdown-level plant access check. `plantCode` should already be the
 * bare code (e.g. "AA01"), matching how callers read row["Plant"] or a
 * plant-select's value.
 *
 * Deliberately permissive on missing/blank plantCode (e.g. rows from a file
 * that doesn't carry a "Plant" column at all, or a not-yet-selected filter
 * value) — plant scoping only restricts rows that identify a plant this
 * user isn't allowed to see; it never blanket-denies data that simply has
 * no plant to check, which would be a different (and much more aggressive)
 * failure mode than intended.
 */
function canAccessPlant(plantCode) {
  if (isHeadOfficeUser()) return true;
  const p = String(plantCode || "").trim().toUpperCase();
  if (!p) return true;
  if (p === PERM_HUB_PLANT) return true; // branch users can always see the HO01 hub
  return p === getUserPlant();
}

// ── CHART AXIS: STOCK TYPE (Q vs RDF) FOR BRANCH-LOCKED ROLES ───────
// Branch-locked users only ever have one Plant, so any "by Plant" bar
// chart (Dashboard, QC, Near-Expiry Risk) collapses to a single
// full-width bar for them. For these roles the chart's x-axis dimension
// should swap from Plant to Stock Type (Q / RDF) instead — a split that's
// actually meaningful within one branch, and one this app's own
// permission model already keys on (data_scopes are stored as "Q_ZME" /
// "R_ZLC", i.e. stock type + valuation type per material).
//
// Deliberately keyed on role (isHeadOfficeUser()), not on how many plants
// happen to survive the current filter — an HO01/Admin user who filters
// the Plant dropdown down to one branch is still comparing across the
// org and should keep the Plant axis; only branch-locked roles get the
// swap.
function shouldUseStockTypeAxis() {
  return !isHeadOfficeUser();
}

// Returns "RDF" or "Health Program (Q)" for a row. Mirrors
// STOCK_TYPE_LABEL in branch-demand.js, kept independent here so
// permissions.js doesn't depend on branch-demand.js's load order.
function getRowStockTypeLabel(row) {
  const sst = String((row && row["Special Stock Type"]) || "").trim().toUpperCase();
  return sst === "Q" ? "Health Program (Q)" : "RDF";
}

/**
 * Filters a list of plant codes (e.g. a page's plant dropdown options, or
 * mosPlants derived from an AMC file's own columns) down to the ones this
 * user may see. Admin / HO01 users get the list back unchanged.
 */
function getVisiblePlants(plants) {
  if (!Array.isArray(plants)) return [];
  if (isHeadOfficeUser()) return plants;
  return plants.filter(p => canAccessPlant(p));
}

/**
 * Strips HO01 (Head Office hub) rows for a branch-locked user, mirroring
 * the exclusion applyPageFilter() applies at render time. Head Office /
 * Admin users get rows back unchanged.
 *
 * WHY THIS EXISTS: rawDf (and therefore anything built from it, like
 * filter-dropdown option lists) deliberately KEEPS HO01 rows for a
 * branch-locked user — canAccessPlant() above lets them through so
 * Branch Demand / the MOS hub-vs-branch comparison can read rawDf
 * directly and still see what stock HO01 has. But applyPageFilter()
 * (Dashboard/Transit/Expiry/QC/Branch Comparison) strips those same HO01
 * rows back out for non-Head-Office users. Any dropdown built straight
 * from rawDf can therefore offer a Material Group / Plant / Material
 * whose ONLY accessible rows are at HO01 — a selectable option that is
 * guaranteed to render zero results for that user. Callers that build
 * filter-chip option lists should route rawDf through this first so the
 * options offered always match what applyPageFilter() can actually show.
 */
function stripHubForBranchUser(rows) {
  if (!Array.isArray(rows)) return [];
  if (isHeadOfficeUser()) return rows;
  return rows.filter(r => String(r["Plant"] || "").trim().toUpperCase() !== PERM_HUB_PLANT);
}

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
// Head-Office-only modules: these are national/cross-branch views that only
// make sense — and are only meant to be granted — to a Head Office user
// (HO01 plant, or unset) or Admin. A user locked to a specific branch plant
// can NEVER be granted these, no matter what an Admin/Director checks in
// Advanced User Management: the checkboxes for these keys are disabled
// there whenever a non-HO01 plant is selected (see user-management.js),
// and this is the matching enforcement point so a stale/tampered
// sidebar_permissions value can't grant them either. Other modules remain
// available to branch users as normal, just scoped to their own branch by
// the plant-scoping functions above — notably "branch-demand" (Branch
// Demand) is deliberately NOT in this list, since branch users placing
// their own demand requests is the whole point of that page.
const HEAD_OFFICE_ONLY_MODULE_KEYS = [
  "pending-dispatch", "branch", "expiry-risk", "stockout-risk",
  "quick-lookup", "who-responsible", "shelf-life-lookup", "new-received-stock",
  "natl-table", "concentration", "request-analysis", "allocation-tool",
  "person-assigned",
];

// Admin always has every module. Everyone else needs an explicit `true`
// in their sidebar_permissions map — the default for a newly created user
// is an empty map (nothing on), per the "minimal default, customize per
// user" decision. Head-Office-only modules are additionally hard-denied to
// any user locked to a specific branch plant, regardless of what their
// sidebar_permissions map says.
function canAccessModule(moduleKey) {
  if (computeIsAdmin()) return true;
  if (!window.APP_USER) return false;
  // User Management is gated on canManageRoles() (Admin + Director + Deputy
  // Director), not on sidebar_permissions — it's part of the Access Level
  // matrix itself, not a togglable module (see auth.js applyRoleToUI(), which
  // shows the nav button on that same basis). Without this, the nav button
  // was visible to Director/Deputy Director but clicking it fell through to
  // the sidebar_permissions check below — which is never set for a
  // non-togglable key — so renderPage()'s SEC-ACCESS-GATE silently denied
  // them and redirected elsewhere.
  if (moduleKey === "user-management") return canManageRoles();
  if (HEAD_OFFICE_ONLY_MODULE_KEYS.includes(moduleKey) && !isHeadOfficeUser()) return false;
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
  if (!canAccessPlant(row && row["Plant"])) return false;
  const scope = getRowScopeCode(row);
  if (!scope) return false;
  return getUserScopes().includes(scope);
}

// ── UNIVERSAL EXCLUSIONS (apply to EVERY role, including Admin) ──
// CLASSIFICATION REBUILD: this function now implements ONLY the two
// universal data-membership rules from the classification spec, plus the
// unrelated non-medical/location housekeeping rules that were already here
// and are not part of the classification rebuild. All previous Special-
// Stock-Type guesswork (the old `s !== "Q" && s !== "W"` check, and later
// the isProjectStockDescription-based heuristic for rows whose code isn't
// literally "Q") has been deleted — it encoded assumptions that are no
// longer part of the spec.
//
// RULE 1 — SPECIAL STOCK TYPE: keep only two values — "Q" (Program) and
// blank (RDF). Every other Special Stock Type value is excluded, for every
// role, everywhere. This is a hard data-membership rule, not a permission —
// even Admin never sees a non-Q/non-blank row.
//
// RULE 2 — INVENTORY VALUATION: any row whose Inventory Valuation
// (Inventory Valuation Type column) is blank is excluded, everywhere on the
// site. Enforced here — the single universal choke point used by
// filterRowsByAccess and every canAccessRow-adjacent flow — instead of
// being duplicated at individual call sites, so it can never be forgotten
// on a new page.
function passesUniversalExclusions(row) {
  if (!row) return false;
  const sst = String(row["Special Stock Type"] || "").trim().toUpperCase();
  if (sst !== "" && sst !== "Q") return false;
  if (String(row["Inventory Valuation Type"] || "").trim() === "") return false;
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

// ── FIX-BRD-CROSS-BRANCH-BLIND-SPOT: PLANT-UNRESTRICTED ROW ACCESS ─────────
// Same as canAccessRow()/filterRowsByAccess() above MINUS the
// canAccessPlant() check — i.e. still enforces data_scope (Q_ZME/R_ZLC/etc)
// and the universal invariants, but never denies a row just because it
// belongs to a plant the signed-in user is locked away from.
//
// WHY THIS EXISTS: some calculations are inherently cross-branch and must
// come out identical no matter which user runs them — e.g. Branch Demand's
// priority-tier allocation, which needs EVERY branch's real stock-on-hand to
// correctly decide how much of HO01's stock each tier consumes before a
// given branch's own turn comes up (see brdBuildNationalSohMap() in
// branch-demand.js, and the near-identical rationale already applied to
// Open Outbound via getOpenOutboundRowsNational() in pending-dispatch.js).
// A branch-locked user's ordinary rawDf only contains their own plant + the
// HO01 hub, so any cross-branch math built on it would (wrongly) treat
// every OTHER branch's SOH as zero — producing a different, incorrect
// result for the exact same material/branch than an HO01/Admin user
// computing the same thing. This helper is for that narrow class of
// national/cross-branch calculations ONLY — anything that DISPLAYS rows to
// the current user should keep using filterRowsByAccess()/rawDf as normal.
function canAccessRowIgnoringPlant(row) {
  if (computeIsAdmin()) return true;
  const scope = getRowScopeCode(row);
  if (!scope) return false;
  return getUserScopes().includes(scope);
}

function filterRowsByAccessIgnoringPlant(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(r => passesUniversalExclusions(r) && canAccessRowIgnoringPlant(r));
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

/**
 * Material Group options for a filter checklist. Unlike Material Type /
 * Stock Type, there's no fixed enum of Material Groups to intersect
 * against a scope code — group membership isn't itself part of the
 * Q_ZME-style scope grammar (a scope grants a Stock Type + Material Type
 * combination, not a group). So the only invariant this helper enforces
 * is: only groups actually present in access-filtered `rows` can appear,
 * with non-medical groups excluded — same universal exclusion every other
 * caller already applies via passesUniversalExclusions().
 *
 * `rows` MUST already be access-filtered (e.g. rawDf/baseDf/mappedDf, or
 * the output of filterRowsByAccess()/applyPageFilter()) — this helper does
 * not re-run canAccessRow() itself, since "Material Group Name" carries no
 * scope info of its own to check. This is the single choke point every
 * Material Group dropdown in the app should go through, so a duplicate,
 * looser copy of this list-building logic can't reappear in a 7th spot.
 */
function materialGroupFilterOptions(rows) {
  return [...new Set((Array.isArray(rows) ? rows : []).map(r => r["Material Group Name"]))]
    .filter(Boolean)
    .filter(name => typeof isNonMedicalGroup !== "function" || !isNonMedicalGroup(name))
    .sort();
}

/**
 * Program Classification (RDF-CDSS / RDF-NON-CDSS / Program-Reportable /
 * Program-Non-Reportable) values the current user's role is allowed to
 * filter by. Mirrors stockTypeFilterOptions()'s Q/R scope gate: RDF-CDSS
 * and RDF-NON-CDSS are RDF-side classifications (need an "R_..." scope),
 * Program-Reportable and Program-Non-Reportable are Q-side (need a
 * "Q_..." scope). Admin/full-access always sees all four, same as every
 * other *FilterOptions() helper in this file.
 */
function programClassFilterOptions() {
  const ALL = ["RDF-CDSS", "RDF-NON-CDSS", "Program-Reportable", "Program-Non-Reportable"];
  if (computeIsAdmin()) return ALL;
  const scopedPrefixes = new Set(getUserScopes().map(s => String(s).split("_")[0]));
  const out = [];
  if (scopedPrefixes.has("R")) out.push("RDF-CDSS", "RDF-NON-CDSS");
  if (scopedPrefixes.has("Q")) out.push("Program-Reportable", "Program-Non-Reportable");
  return out;
}

/**
 * Hides/disables the Program Classification <option>s a user's role isn't
 * scoped to see in a given <select> (the six "*-program-class" filter
 * dropdowns share one static HTML option list, so a Q-scoped user was
 * previously shown — and could apply — "RDF · CDSS" etc, and an RDF-only
 * user could pick "Program (Q) · Reportable" and always get zero results).
 * The "All Classifications" (value="") option is always kept. If the
 * select's currently-chosen value is one that's now hidden (stale value
 * from before login, or a role change mid-session), resets it back to
 * "All" so the page doesn't keep silently filtering on an option the user
 * can no longer see or choose.
 */
function applyProgramClassAccessToSelect(selectEl) {
  if (!selectEl) return;
  const allowed = new Set(programClassFilterOptions());
  let selectedHidden = false;
  Array.from(selectEl.options).forEach(opt => {
    if (!opt.value) return; // "All Classifications" — always shown
    const visible = allowed.has(opt.value);
    opt.hidden   = !visible;
    opt.disabled = !visible;
    if (!visible && selectEl.value === opt.value) selectedHidden = true;
  });
  if (selectedHidden) selectEl.value = "";
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
  "blocked", "restricted",
  "expiry-risk", "stockout-risk", "natl-table", "concentration",
  "request-analysis", "mos-plant", "branch-demand",
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
window.hasFullPlantAccess   = hasFullPlantAccess;
window.getUserPlant         = getUserPlant;
window.isHeadOfficeUser     = isHeadOfficeUser;
window.canAccessPlant       = canAccessPlant;
window.getVisiblePlants     = getVisiblePlants;
window.stripHubForBranchUser = stripHubForBranchUser;
window.shouldUseStockTypeAxis = shouldUseStockTypeAxis;
window.getRowStockTypeLabel   = getRowStockTypeLabel;
window.HUB_PLANT            = PERM_HUB_PLANT;
window.isDirectorLike       = isDirectorLike;
window.canManageRoles       = canManageRoles;
window.canManageUsersFully  = canManageUsersFully;
window.canAccessModule      = canAccessModule;
window.HEAD_OFFICE_ONLY_MODULE_KEYS = HEAD_OFFICE_ONLY_MODULE_KEYS;
window.getUserScopes        = getUserScopes;
window.getRowScopeCode      = getRowScopeCode;
window.canAccessRow         = canAccessRow;
window.canAccessRowIgnoringPlant = canAccessRowIgnoringPlant;
window.passesUniversalExclusions = passesUniversalExclusions;
window.filterRowsByAccess   = filterRowsByAccess;
window.filterRowsByAccessIgnoringPlant = filterRowsByAccessIgnoringPlant;
window.materialTypeFilterOptions = materialTypeFilterOptions;
window.stockTypeFilterOptions    = stockTypeFilterOptions;
window.materialGroupFilterOptions = materialGroupFilterOptions;
window.programClassFilterOptions  = programClassFilterOptions;
window.applyProgramClassAccessToSelect = applyProgramClassAccessToSelect;
window.roleBadgeText        = roleBadgeText;
window.roleBadgeTooltip     = roleBadgeTooltip;
window.firstAccessibleModule = firstAccessibleModule;
window.ROLE_LABELS          = ROLE_LABELS;
