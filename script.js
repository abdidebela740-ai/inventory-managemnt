// Wait for deferred Plotly to be available before charting
const waitForPlotly = () => new Promise(r => {
  if (window.Plotly) return r();
  window.addEventListener('load', r, { once: true });
});
// ── CONSTANTS ──────────────────────────────────────────────────────────────
const REQUIRED_COLUMNS = [
  "Material","Material Description","Plant","Plant Name",
  "Storage Location","Description of Storage Location",
  "Special Stock Type","Special Stock Type Description",
  "Unrestricted Stock","Stock in Quality Inspection","Blocked Stock",
  "Batch","Inventory Valuation Type","Material Group Name",
  "Shelf Life Expiration Date","Stock in Transit",
  "Value of Stock in Quality Inspection","Value of Stock in Transit",
  "Value of Unrestricted Stock",
];

const COLORWAY = ["#3a8fd4","#2e9e5a","#c47f17","#d94040","#8763cc","#5cbfdb","#4db87a","#e09b2d","#e86060","#a78bde","#59b8f5","#70ce94"];

/**
 * Injects ⬇ CSV and ⬇ Excel buttons into a container div (by id).
 * Used to place download buttons directly above each page's table.
 */
function injectDlButtons(rowId, onCsv, onXlsx) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.innerHTML = '<button class="dl-btn">⬇ CSV</button><button class="dl-btn">⬇ Excel</button>';
  row.querySelectorAll(".dl-btn")[0].onclick = onCsv;
  row.querySelectorAll(".dl-btn")[1].onclick = onXlsx;
}

// NOTE: Exclusion rules (isNonMedicalCode, isNonMedicalGroup) are loaded from
// filters.js which MUST be included before this script in the HTML.
/**
 * Shows a brief toast notification confirming the Branch Comparison drilldown.
 * Auto-dismisses after 4 seconds.
 */
function showSpreadDrilldownToast(count, groupLabel) {
  // Remove any existing toast first
  const existing = document.getElementById("spread-drilldown-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "spread-drilldown-toast";
  toast.innerHTML = `
    <span style="font-size:1.1em">🎯</span>
    <span>Showing <strong>${count}</strong> material${count !== 1 ? "s" : ""} stocked in <strong>${escHtml(groupLabel)}</strong> — filtered from Stock Concentration</span>
    <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;opacity:0.7;padding:0 0.25rem" title="Dismiss">✕</button>
  `;
  Object.assign(toast.style, {
    position:       "fixed",
    bottom:         "1.5rem",
    left:           "50%",
    transform:      "translateX(-50%)",
    background:     "var(--blue, #3a8fd4)",
    color:          "#fff",
    padding:        "0.65rem 1.1rem",
    borderRadius:   "8px",
    boxShadow:      "0 4px 18px rgba(0,0,0,0.35)",
    display:        "flex",
    alignItems:     "center",
    gap:            "0.6rem",
    fontSize:       "0.82rem",
    fontFamily:     "Inter, sans-serif",
    zIndex:         "9999",
    maxWidth:       "520px",
    animation:      "fadeInUp 0.25s ease",
    pointerEvents:  "auto",
  });
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 4500);
}

// FEAT-MS-PASTE-SEARCH: Shows a brief toast confirming how many pasted codes
// were auto-checked in a multi-select dropdown (see buildMultiSelect's paste
// handler below). Lists a few unmatched codes (if any) so the user immediately
// knows which pasted entries didn't exist in the list, instead of silently
// dropping them. Auto-dismisses after 5 seconds (slightly longer than the
// drilldown toast since there may be more to read).
function showPasteMatchToast(matchedCount, totalCount, unmatchedCodes) {
  const existing = document.getElementById("ms-paste-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ms-paste-toast";
  const allMatched = matchedCount === totalCount;
  const unmatchedPreview = (unmatchedCodes || []).slice(0, 6).map(escHtml).join(", ")
    + ((unmatchedCodes || []).length > 6 ? `, +${unmatchedCodes.length - 6} more` : "");
  toast.innerHTML = `
    <span style="font-size:1.1em">${allMatched ? "✅" : "⚠️"}</span>
    <span>
      Pasted <strong>${totalCount}</strong> code${totalCount !== 1 ? "s" : ""} — checked <strong>${matchedCount}</strong> match${matchedCount !== 1 ? "es" : ""}
      ${allMatched ? "" : `<br><span style="opacity:0.85">Not found: ${unmatchedPreview}</span>`}
    </span>
    <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;opacity:0.7;padding:0 0.25rem" title="Dismiss">✕</button>
  `;
  Object.assign(toast.style, {
    position:       "fixed",
    bottom:         "1.5rem",
    left:           "50%",
    transform:      "translateX(-50%)",
    background:     allMatched ? "var(--green, #2e9e5a)" : "var(--orange, #c47f17)",
    color:          "#fff",
    padding:        "0.65rem 1.1rem",
    borderRadius:   "8px",
    boxShadow:      "0 4px 18px rgba(0,0,0,0.35)",
    display:        "flex",
    alignItems:     "flex-start",
    gap:            "0.6rem",
    fontSize:       "0.82rem",
    fontFamily:     "Inter, sans-serif",
    lineHeight:     "1.45",
    zIndex:         "9999",
    maxWidth:       "560px",
    animation:      "fadeInUp 0.25s ease",
    pointerEvents:  "auto",
  });
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 5000);
}

// SEC-ACCESS-GATE: Shown only when a signed-in user has literally zero
// accessible modules (firstAccessibleModule() found nothing to redirect
// them to) — everyone else with at least one permitted module gets
// silently redirected there instead of ever seeing a denial message.
function showNoModulesAssignedToast() {
  const existing = document.getElementById("access-denied-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "access-denied-toast";
  toast.innerHTML = `
    <span style="font-size:1.1em">🔒</span>
    <span>Your account doesn't have any modules assigned yet — contact your administrator</span>
    <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;opacity:0.7;padding:0 0.25rem" title="Dismiss">✕</button>
  `;
  Object.assign(toast.style, {
    position:       "fixed",
    bottom:         "1.5rem",
    left:           "50%",
    transform:      "translateX(-50%)",
    background:     "var(--red, #d94040)",
    color:          "#fff",
    padding:        "0.65rem 1.1rem",
    borderRadius:   "8px",
    boxShadow:      "0 4px 18px rgba(0,0,0,0.35)",
    display:        "flex",
    alignItems:     "flex-start",
    gap:            "0.6rem",
    fontSize:       "0.82rem",
    fontFamily:     "Inter, sans-serif",
    lineHeight:     "1.45",
    zIndex:         "9999",
    maxWidth:       "560px",
    animation:      "fadeInUp 0.25s ease",
    pointerEvents:  "auto",
  });
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 5000);
}

// SEC-ACCESS-GATE: Shows a brief toast when navigation to a module is
// blocked because the signed-in user lacks permission for it. Used by the
// central renderPage() gate and by every other jump point (overview cards,
// material drilldowns, Who's Responsible "View at-risk", etc.) so a denied
// navigation always gives the user visible feedback instead of just
// silently doing nothing.
function showAccessDeniedToast() {
  const existing = document.getElementById("access-denied-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "access-denied-toast";
  toast.innerHTML = `
    <span style="font-size:1.1em">🔒</span>
    <span>You don't have access to this module</span>
    <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;opacity:0.7;padding:0 0.25rem" title="Dismiss">✕</button>
  `;
  Object.assign(toast.style, {
    position:       "fixed",
    bottom:         "1.5rem",
    left:           "50%",
    transform:      "translateX(-50%)",
    background:     "var(--red, #d94040)",
    color:          "#fff",
    padding:        "0.65rem 1.1rem",
    borderRadius:   "8px",
    boxShadow:      "0 4px 18px rgba(0,0,0,0.35)",
    display:        "flex",
    alignItems:     "center",
    gap:            "0.6rem",
    fontSize:       "0.82rem",
    fontFamily:     "Inter, sans-serif",
    zIndex:         "9999",
    maxWidth:       "520px",
    animation:      "fadeInUp 0.25s ease",
    pointerEvents:  "auto",
  });
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 4000);
}

// ── THEME-AWARE PLOTLY LAYOUT ─────────────────────────────────────────────
// Reads CSS vars at call time so chart colours match the active theme.
function getPlotlyThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const get = v => s.getPropertyValue(v).trim();
  return {
    grid:   get('--border')  || '#1e2e3d',
    muted:  get('--muted')   || '#7a97b0',
    bg:     'rgba(0,0,0,0)',
  };
}

const PLOTLY_LAYOUT = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { family: "Inter, IBM Plex Sans, sans-serif", color: "#7a97b0", size: 12 },
  xaxis: { gridcolor: "#1e2e3d", zerolinecolor: "#1e2e3d", tickfont: { color: "#7a97b0" } },
  yaxis: { gridcolor: "#1e2e3d", zerolinecolor: "#1e2e3d", tickfont: { color: "#7a97b0" } },
  legend: { bgcolor: "rgba(0,0,0,0)", font: { color: "#7a97b0" } },
  margin: { l: 20, r: 20, t: 40, b: 40 },
  colorway: COLORWAY,
};
const PLOTLY_CONFIG = { displayModeBar: false, responsive: true };

// ── STATE ──────────────────────────────────────────────────────────────────
let rawDf  = [];
let filtDf = [];
let currentPage = "dashboard";

// Every material code seen with an excluded classification (Project Stock,
// non-medical code/group, excluded storage location, or Q/W special stock
// type) ANYWHERE in the raw uploaded file, captured BEFORE the parse-time
// filter strips those rows out of rawDf. rawDf itself never contains these
// rows, but other separately-uploaded files (e.g. Incoming GR.xlsx) don't
// carry the same columns, so anything cross-referencing by Material code
// against those files needs this set as a defence-in-depth guard — see
// shelf-life.js's Look-up suggestions and "New Incoming Stock" table.
let excludedMaterialCodes = new Set();
let scopeExcludedMaterialCodes = new Set();

// Stock-in-Transit VERIFICATION file state ─────────────────────────────────
// Replaces the old hardcoded ghost-transit list. The user uploads a
// Stock-in-Transit file (Material + Plant + Quantity) each session — it is
// held in memory only and is NOT persisted (re-upload required every
// session/page load, matching the app's session-only data model).
//
// Matching rule: for a given material+plant that has "Stock in Transit" > 0
// in the main inventory file, that row is TRUE only if the uploaded file
// contains the SAME material+plant with the EXACT SAME quantity. Anything
// that doesn't match (or isn't present at all in the uploaded file) is
// GHOST and excluded from every total across the app, exactly like the
// old phantom-transit logic — just driven by the upload instead of a
// hardcoded list.
let TRANSIT_UPLOAD_LIST = [];   // [{materialCode, plantCode, qty, supplyingPlant, ...}] — parsed rows from the uploaded file
let transitFileLoaded   = false; // gates the Transit page until a file is uploaded
let transitFileName     = "";
let transitFileStats    = null;  // {trueCount, ghostCount} — set after (re)stamping

// Build a fast lookup Map keyed by "materialCode|plantCode" -> qty
let _transitUploadLookup = new Map();
// Second lookup keyed the same way -> full uploaded row (for Supplying Plant, etc.)
let _transitUploadDetailsLookup = new Map();
function _rebuildTransitUploadLookup() {
  _transitUploadLookup = new Map();
  _transitUploadDetailsLookup = new Map();
  TRANSIT_UPLOAD_LIST.forEach(e => {
    const key = String(e.materialCode).trim().toUpperCase() + "|" + String(e.plantCode).trim().toUpperCase();
    _transitUploadLookup.set(key, e.qty);
    _transitUploadDetailsLookup.set(key, e);
  });
}

// Returns the "Supplying Plant" value from the uploaded Stock-in-Transit file
// for this row's material+plant, or "" if not available.
function getSupplyingPlant(row) {
  const mat = String(row["Material"] || "").trim().toUpperCase();
  const plt = String(row["Plant"]    || "").trim().toUpperCase();
  const hit = _transitUploadDetailsLookup.get(mat + "|" + plt);
  return hit && hit.supplyingPlant ? hit.supplyingPlant : "";
}

// Returns {qty, val} of the GHOST portion of a row's Stock in Transit.
//   - No transit file uploaded yet → the entire amount is ghost.
//   - Transit file uploaded, but this material+plant is absent, or its
//     quantity doesn't exactly match → the entire amount is ghost.
//   - Transit file uploaded AND quantity matches exactly → nothing is
//     ghost (fully true).
function getGhostTransit(row) {
  const total = row["Stock in Transit"] || 0;
  if (total <= 0) return { qty: 0, val: 0 };
  if (!transitFileLoaded) return { qty: total, val: row["Value of Stock in Transit"] || 0 };

  const mat = String(row["Material"] || "").trim().toUpperCase();
  const plt = String(row["Plant"]    || "").trim().toUpperCase();
  const uploadedQty = _transitUploadLookup.get(mat + "|" + plt);
  const isTrue  = (uploadedQty !== undefined) && (Number(uploadedQty) === Number(total));
  return isTrue ? { qty: 0, val: 0 } : { qty: total, val: row["Value of Stock in Transit"] || 0 };
}

// Incoming Shelf Life state (feature removed)

// Page-level filter state — now arrays for multi-select support
const pageFilters = {
  dashboard: { plants: [], mgs: [], valTypes: [] },
  transit:   { plants: [], mgs: [], valTypes: [], materials: [] },
  expiry:    { plants: [], mgs: [], valTypes: [], materials: [] },
  qc:        { plants: [], mgs: [], valTypes: [], materials: [] },
  branch:    { mgs: [],             valTypes: [], materials: [] },
  concentration: { mgs: [], valTypes: [] },
};

// ── SPREAD CHART DRILLDOWN STATE ──────────────────────────────────────────
// Stores the last matConcentration array from renderConcentration() so that a
// bar-click can hand off the selected plant-count group to Branch Comparison.
let _lastSpreadDrilldown = null;   // { plantCount, matCodes[] } | null

// ── DRILLDOWN BACK NAVIGATION ────────────────────────────────────────────────
// Tracks the chain created specifically by drilldown clicks (material code →
// Concentration, Concentration → Branch Comparison via the drill banner or
// the Branch Spread chart bar). A normal nav-bar / overview-card click clears
// this trail — "⬅ Back" is only ever offered on a page reached BY drilling
// down from another, and it restores that other page exactly as it was left:
// no re-render, since a hidden page's DOM already holds its prior state
// (drill banners included) and re-rendering would wipe one-shot state like
// _materialDrilldownCode that's already been consumed.
let _drillNavStack = []; // stack of page ids to return to, most recent last

function _showPageDivOnly(id) {
  document.getElementById("landingView").style.display = "none";
  document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
  const pg = document.getElementById(`page-${id}`);
  if (pg) pg.style.display = "block";
  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
  currentPage = id;
}

// Paints (or clears) the "⬅ Back" button into whichever page-back-<id>
// placeholder matches the page currently on screen.
function _renderDrillBackButtons() {
  document.querySelectorAll('[id^="page-back-"]').forEach(el => { el.innerHTML = ""; });
  if (!_drillNavStack.length) return;
  const container = document.getElementById(`page-back-${currentPage}`);
  if (container) {
    container.innerHTML = `<button type="button" class="drill-back-btn" id="drill-back-btn" title="Back to where you came from">↩ Back</button>`;
  }
}

// Call instead of a bare renderPage() at a drilldown jump-off point: records
// the page being left so Back can return to it later, then navigates.
function drillNavigate(targetPage) {
  _drillNavStack.push(currentPage);
  renderPage(targetPage);
  _renderDrillBackButtons();
}

// Pops one hop off the chain and restores that page's exact prior state.
function goDrillBack() {
  if (!_drillNavStack.length) return;
  const target = _drillNavStack.pop();
  _showPageDivOnly(target);
  _renderDrillBackButtons();
}

// Any "normal" navigation (nav bar, overview cards, the phantom-transit
// link) abandons the drilldown trail — Back should never point somewhere
// stale once the user has deliberately jumped elsewhere.
function navReset(id) {
  _drillNavStack = [];
  renderPage(id);
  _renderDrillBackButtons();
}

document.body.addEventListener("click", (e) => {
  if (e.target.closest("#drill-back-btn")) goDrillBack();
});

// ── GLOBAL MATERIAL-CODE DRILLDOWN ──────────────────────────────────────────
// Clicking ANY material code anywhere in the app (rendered via renderMatCode /
// renderMappedMatCode, or a page's own custom cell markup that opts in with
// the same data-drill-mat attribute) jumps to Stock Concentration filtered to
// that one material. This exists because a material can look perfectly fine
// at the national level (e.g. on Stockout Risk) while actually being held
// almost entirely at a single plant — a redistribution candidate, not a real
// network-wide shortage. Concentration then offers a one-click hop on to
// Branch Comparison for the same material so the user can see exactly where
// the stock sits and where it could move.
let _materialDrilldownCode = null; // material code to auto-filter to | null, consumed once by renderConcentration()

function goToMaterialConcentration(code) {
  const c = String(code || "").trim();
  if (!c) return;
  // SEC-ACCESS-GATE: no early guard here anymore — drillNavigate() ->
  // renderPage() is the single enforcement point, and renderPage() now
  // redirects a denied jump to the user's own accessible module rather
  // than blocking it, so there's nothing left to duplicate here.
  _materialDrilldownCode = c;
  drillNavigate("concentration");
}

// ── BRANCH-COMPARISON-ONLY OVERRIDE ─────────────────────────────────────────
// On every other page, clicking a material code jumps to Stock Concentration
// (see goToMaterialConcentration above). On Branch Comparison specifically,
// the more useful jump is to the Expiry Watch List filtered to that one
// material — you're already looking at where a material sits across plants,
// so the natural next question is "is any of that stock about to expire?"
// rather than "how concentrated is it?". This REPLACES the Concentration
// jump for Branch Comparison only; every other page is untouched.
let _expiryDrilldownMatCode = null; // material code to auto-filter Expiry Watch List to | null, consumed once by renderExpiry()

function goToMaterialExpiry(code) {
  const c = String(code || "").trim();
  if (!c) return;
  // SEC-ACCESS-GATE: see goToMaterialConcentration() above — enforcement
  // (including the redirect-to-accessible-module behavior) lives centrally
  // in renderPage() now, so there's no separate guard to keep here.
  _expiryDrilldownMatCode = c;
  drillNavigate("expiry");
}

// Capture-phase listener so it runs BEFORE the bubble-phase global handler
// below, regardless of registration order. Only intercepts clicks whose
// material-code element lives inside the Branch Comparison page; everywhere
// else the click falls through untouched to the normal Concentration jump.
document.body.addEventListener("click", (e) => {
  const el = e.target.closest("[data-drill-mat]");
  if (!el) return;
  if (!el.closest("#page-branch")) return;
  e.stopPropagation();
  goToMaterialExpiry(el.dataset.drillMat);
}, true);

document.body.addEventListener("click", (e) => {
  const el = e.target.closest("[data-drill-mat]");
  if (!el) return;
  e.stopPropagation();
  goToMaterialConcentration(el.dataset.drillMat);
});

document.body.addEventListener("click", (e) => {
  if (e.target.closest("#conc-drill-clear")) {
    _materialDrilldownCode = null;
    if (typeof renderConcentration === "function") renderConcentration();
    return;
  }
  const branchBtn = e.target.closest("#conc-drill-to-branch");
  if (branchBtn) {
    const mat = branchBtn.dataset.mat;
    if (mat) {
      _lastSpreadDrilldown = { plantCount: null, matCodes: [mat], label: `material ${mat}` };
      drillNavigate("branch");
    }
  }
});

// ── GLOBAL PERSON FILTER ────────────────────────────────────────────────────
// A Set of selected PERSON values from the AMC file.
// When non-empty, only materials whose AMC row has a matching PERSON are shown
// on every page — dashboard, transit, expiry, QC, branch, concentration,
// MOS by Plant, and Overstock & Expiry Risk.
let personFilter = new Set();   // empty = show all persons

// Returns the Set of CANONICAL/mapped material codes that belong to the
// currently-selected persons. Built on demand from mosMerged (not the raw
// mosAmcRaw) so it always reflects the latest AMC data AND the same
// mapping-consolidated code identity used everywhere else in the app
// (MOS by Plant, Who's Responsible, etc).
// Returns null when no person filter is active (show everything).
//
// BUGFIX-PERSON-MAPPING: previously this pulled RAW, pre-mapping codes
// straight from mosAmcRaw and compared them against the inventory's raw
// "Material" field. That breaks whenever a mapping file consolidates
// several distinct original SAP codes onto one target/canonical code
// (e.g. two vial formulations both mapped to "105-PHEY-0301"): AMC only
// tags a PERSON on the specific raw code it references, so filtering by
// person silently dropped every OTHER raw code that maps to the same
// canonical material — even though that canonical material, as a whole,
// belongs to that person. This showed up as wildly different stock
// numbers (and even different descriptions, since the surviving row
// determined which one displayed) depending on whether a person filter
// was active. Resolving against mosMerged's canonical `code` (which is
// already mapping-aware, see buildMosMerged()) fixes this at the source.
function getPersonFilteredCodes() {
  if (personFilter.size === 0) return null;
  if (typeof mosMerged === "undefined" || !mosMerged.length) return null;
  const codes = new Set();
  mosMerged.forEach(r => {
    if (r.person && personFilter.has(r.person)) codes.add(String(r.code || "").trim().toUpperCase());
  });
  return codes;
}

// ── PERSON FILTER DROPDOWN POPULATION ──────────────────────────────────────
// Single global dropdown lives in the sidebar (#global-person-filter) and
// applies to every page. Called by mos.js after the AMC file is parsed.
function populatePersonFilter(persons) {
  const sel = document.getElementById("global-person-filter");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">\u{1F464} All Persons</option>';
  persons.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    if (personFilter.has(p)) opt.selected = true;
    sel.appendChild(opt);
  });
  // Restore previous selection if still valid
  if (prev && persons.includes(prev)) sel.value = prev;
  _syncChipState();
  // BUG-MOS-STALE-FIX: this fires right after mos.js finishes parsing the AMC
  // file. If the user is already sitting on Branch Comparison's Material tab,
  // its MOS/AMC checkboxes were greyed out based on AMC data that didn't
  // exist yet — refresh it now so they light up immediately instead of
  // staying stuck disabled until the user happens to click Apply.
  if (typeof window._activeBranchMatRefresh === "function") {
    try { window._activeBranchMatRefresh(); }
    catch (e) { console.error("Branch material tab refresh failed:", e); }
  }
}

function _syncChipState() {
  const sel = document.getElementById("global-person-filter");
  if (!sel) return;
  const chip  = document.getElementById("pf-chip-global");
  const clear = document.getElementById("pf-clear-global");
  const active = personFilter.size > 0;
  sel.classList.toggle("pf-active", active);
  if (chip)  chip.classList.toggle("pf-chip-active", active);
  if (clear) clear.style.display = active ? "inline-flex" : "none";
}

// ── MATERIAL STANDARDIZATION MAPPING STATE ─────────────────────────────────
// mappingTable: Map<sourceCode → { targetCode, targetDesc, factor }>
let mappingTable   = new Map();   // populated when mapping file is uploaded
let mappedDf       = [];          // rawDf rows after applyMaterialMapping()
let mappingStats   = null;        // { mapped, total, valuePct } — shown in sidebar

// Returns the base dataset with material standardization applied (if mapping loaded),
// then narrowed to materials belonging to the currently-selected persons (if any).
//
// BUGFIX-PERSON-MAPPING: now matches on the CANONICAL/mapped material code
// (r._mappedMaterial, falling back to the raw code when no mapping is
// loaded) instead of the raw pre-mapping "Material" field. This must stay
// in lockstep with getPersonFilteredCodes(), which now returns canonical
// codes too — otherwise every row whose raw code differs from its target
// code would silently fail to match again.
function getReconciledBase() {
  const base = mappingTable.size > 0 ? mappedDf : rawDf;
  const codes = getPersonFilteredCodes();
  if (!codes) return base;
  return base.filter(r => {
    const mat = String(r._mappedMaterial || r["Material"] || "").trim().toUpperCase();
    return codes.has(mat);
  });
}

// FIX BUG-3: reset all page filters when a new file is loaded so stale plant/MG
// values from the previous file can never produce a blank result set.
function resetPageFilters() {
  // BUG-RESET FIX: guard against pages (e.g. "branch") that have no "plants" key
  // BUG-FIX-2: also guard mgs/valTypes keys so "incoming: {}" never gets phantom slots
  Object.keys(pageFilters).forEach(page => {
    if ("plants"    in pageFilters[page]) pageFilters[page].plants    = [];
    if ("mgs"       in pageFilters[page]) pageFilters[page].mgs       = [];
    if ("valTypes"  in pageFilters[page]) pageFilters[page].valTypes  = [];
    if ("materials" in pageFilters[page]) pageFilters[page].materials = [];
  });
}

// ── FORMAT HELPERS ─────────────────────────────────────────────────────────
const fmtETB = v => `ETB ${Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmtQty = v => Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

// ── HTML ESCAPE (used by buildTable and reconciliation UI) ──────────────────
function escHtml(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── MATERIAL COLUMN HELPERS ────────────────────────────────────────────────
// SAP sometimes stores the description text in the Material field when no
// numeric/structured code exists. We detect and flag this clearly.

// Returns true if the value looks like free-text description rather than a code.
function looksLikeDescription(val) {
  if (!val) return false;
  const s = String(val).trim();
  if (!s) return false;
  return s.includes(" ") || (s.length > 22 && !/^[\w\-\.\/]+$/.test(s));
}

// Gets the code sibling field — used by desc renderer to detect duplicates.
function getSiblingCode(row) {
  if (!row) return "";
  return String(
    row["Material"] ?? row["_st_material"] ?? row["mat"] ?? ""
  ).trim();
}

// ── renderMatCodeRaw / renderMatDescRaw ─────────────────────────────────────
// Used exclusively by the Expiry Watch List page. Per user request, that page
// always shows the plain SAP Material Code and Material Description exactly
// as they came from SAP — no STD/mapped substitution and no "via mapping"
// badge, even when a material-standardization mapping file is loaded and the
// row IS mapped. The click-to-drilldown target still uses the mapped/STD
// code under the hood (row._mappedMaterial) so navigating elsewhere in the
// app — Concentration, or being reached FROM Branch Comparison — continues
// to line up with every other page's mapped-code filtering; only what's
// DISPLAYED on Expiry Watch List changes.
function renderMatCodeRaw(val, row) {
  const s = escHtml(String(val ?? "").trim());
  if (!s) return '<span style="color:var(--dim)">—</span>';

  if (looksLikeDescription(val)) {
    return `<span class="mat-name-as-code" title="No structured code — SAP stores the name here">${s}</span>`
         + `<span class="mat-desc-badge" title="Material field contains a name, not a code">NAME</span>`;
  }
  const drillCode = escHtml(String((row && row._mappedMaterial) || val || "").trim());
  return `<span class="col-mat-code mat-code-clickable" data-drill-mat="${drillCode}" title="${_matCodeClickTitle()}">${s}</span>`;
}

function renderMatDescRaw(val, row) {
  const desc = String(val ?? "").trim();
  const code = getSiblingCode(row);

  if (!desc) return '<span style="color:var(--dim)">—</span>';
  if (desc === code) {
    return `<span class="mat-desc-same" title="Description is identical to the material code field">— same as code —</span>`;
  }
  return `<span class="col-mat-desc">${escHtml(desc)}</span>`;
}


// Defined here (before renderMatCode) so the mutual reference resolves cleanly.

// Branch Comparison is the one page where clicking a material code jumps to
// the Expiry Watch List instead of Stock Concentration (see the Branch-
// Comparison-only override near goToMaterialExpiry). The tooltip is kept in
// sync with that behavior rather than always saying "Stock Concentration".
function _matCodeClickTitle() {
  return currentPage === "branch"
    ? "Click to see the Expiry Watch List for this material"
    : "Click to see Stock Concentration for this material";
}

function renderMappedMatCode_early(val, row) {
  const target = escHtml(String(row._mappedMaterial || "").trim());
  const orig   = escHtml(String(row._origMaterial   || "").trim());
  const clickTitle = _matCodeClickTitle();
  if (!target) {
    const s = escHtml(String(val ?? "").trim());
    return s ? `<span class="col-mat-code mat-code-clickable" data-drill-mat="${s}" title="${clickTitle}">${s}</span>` : '<span style="color:var(--dim)">—</span>';
  }
  const codeHtml = `<span class="col-mat-code mat-code-clickable" data-drill-mat="${target}" title="${clickTitle}">${target}</span><span class="mat-mapped-badge" title="Standardized from ${orig}">STD</span>`;
  if (orig && orig !== target) {
    return codeHtml + `<span class="mat-orig-pill" title="Original SAP code">${orig}</span>`;
  }
  return codeHtml;
}

function renderMappedMatDesc_early(val, row) {
  const tDesc = String(row._mappedDesc || row["Material Description"] || "").trim();
  const oDesc = String(row._origDesc   || "").trim();
  if (!tDesc) return '<span style="color:var(--dim)">—</span>';
  let html = `<span class="col-mat-desc">${escHtml(tDesc)}</span>`;
  if (oDesc && oDesc !== tDesc) {
    html += `<div style="font-size:var(--fs-2xs);color:var(--dim);margin-top:1px;font-style:italic">${escHtml(oDesc)}</div>`;
  }
  return html;
}

// ── renderMatCode(val, row) ────────────────────────────────────────────────
// Renders the "Material Code" cell.
//  • Normal code  → purple monospace
//  • Val looks like a description (has spaces / long) → amber "NAME" badge,
//    styled differently so it's obvious this isn't a structured code
//  • If row._isMapped → delegates to renderMappedMatCode for standardized display
function renderMatCode(val, row) {
  // Delegate to mapped renderer when standardization is active for this row
  if (row && row._isMapped) return renderMappedMatCode_early(val, row);

  const s = escHtml(String(val ?? "").trim());
  if (!s) return '<span style="color:var(--dim)">—</span>';

  if (looksLikeDescription(val)) {
    // The "code" field actually contains a descriptive name
    return `<span class="mat-name-as-code" title="No structured code — SAP stores the name here">${s}</span>`
         + `<span class="mat-desc-badge" title="Material field contains a name, not a code">NAME</span>`;
  }
  return `<span class="col-mat-code mat-code-clickable" data-drill-mat="${s}" title="${_matCodeClickTitle()}">${s}</span>`;
}

// ── renderMatDesc(val, row) ────────────────────────────────────────────────
// Renders the "Material Description" cell.
//  • If description === code (SAP duplicate) → show italic muted "(same as code)"
//  • Otherwise → normal readable text
//  • If row._isMapped → delegates to renderMappedMatDesc
function renderMatDesc(val, row) {
  if (row && row._isMapped) return renderMappedMatDesc_early(val, row);

  const desc = String(val ?? "").trim();
  const code = getSiblingCode(row);

  if (!desc) return '<span style="color:var(--dim)">—</span>';

  // Description is identical to the code field → don't repeat it
  if (desc === code) {
    return `<span class="mat-desc-same" title="Description is identical to the material code field">— same as code —</span>`;
  }

  return `<span class="col-mat-desc">${escHtml(desc)}</span>`;
}

// ── FIX BUG-8: Timezone-safe expiry date parser ────────────────────────────
// new Date("2024-03-15") is parsed as UTC midnight → in UTC+3 it appears as
// 2024-03-14 after 21:00 local time, causing day-off expiry errors.
// This parser treats yyyy-mm-dd strings as LOCAL midnight to avoid that shift.
function parseExpiryDate(d) {
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  if (!d) return null;
  const s = String(d).trim();
  // yyyy-mm-dd → local date (not UTC)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const dt = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    return isNaN(dt.getTime()) ? null : dt;
  }
  // Fallback for other string formats
  const p = new Date(d);
  return isNaN(p.getTime()) ? null : p;
}

// FIX-EXPIRY-DISPLAY: toISOString() converts local-midnight dates to UTC, producing
// a one-day-earlier date string in UTC+3 (Ethiopia). Use local date parts instead.
function fmtLocalDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

// ── LOAD & PROCESS EXCEL ───────────────────────────────────────────────────
function loadFile(file) {
  // FIX PERF-2: warn before parsing very large files
  if (file.size > 25 * 1024 * 1024) {
    if (!confirm(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Large files may take a few seconds to parse. Continue?`)) return;
  }

  const statusEl = document.getElementById("fileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) { showError("The uploaded file contains no data."); return; }

        const trimmed = data.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) r[k.trim()] = v;
          return r;
        });

        // FIX ROBUST: case-insensitive column header matching
        const colsLower = Object.keys(trimmed[0]).map(c => c.toLowerCase());
        const missing = REQUIRED_COLUMNS.filter(c => !colsLower.includes(c.toLowerCase()));
        if (missing.length) { showError(`Missing columns: ${missing.join(", ")}`); return; }

        // Record every material code that carries an excluded classification
        // BEFORE filtering rows out, so pages/features that cross-reference by
        // Material code against OTHER files (which may lack these columns)
        // can still recognize and hide them. See excludedMaterialCodes above.
        // Reset first so re-uploading a fresh/corrected file doesn't keep
        // codes around from a previous upload.
        // excludedMaterialCodes tracks materials excluded by the UNIVERSAL
        // invariants only (W / non-medical / project-stock / excluded
        // location) — never by role/scope. A material a user merely lacks
        // scope for is still a valid material for other users, so it must
        // not be added to this cross-file exclusion set.
        excludedMaterialCodes = new Set();
        // scopeExcludedMaterialCodes tracks materials that pass the universal
        // invariants but that the SIGNED-IN user's role/data_scopes deny.
        // This is per-user (unlike excludedMaterialCodes) and exists so that
        // cross-file features like "New Received Stock" (shelf-life.js),
        // whose source file usually has no Valuation Type column to scope-
        // check directly, can still hide a batch when it belongs to a
        // material outside this user's role instead of showing it as
        // "Not on hand" just because it's absent from this user's rawDf.
        scopeExcludedMaterialCodes = new Set();
        trimmed.forEach(r => {
          const mat = String(r["Material"] || "").trim();
          if (!mat) return;
          if (!passesUniversalExclusions(r)) { excludedMaterialCodes.add(mat); return; }
          if (!canAccessRow(r)) scopeExcludedMaterialCodes.add(mat);
        });

        // filterRowsByAccess (permissions.js) applies the universal
        // invariants (W always excluded; non-medical/project-stock/excluded
        // location always excluded) AND the signed-in user's role/scope
        // access (Q rows now included when the user's scope allows it;
        // Admin sees every scope).
        let df = filterRowsByAccess(trimmed)
          .filter(r => String(r["Inventory Valuation Type"] || "").trim() !== "");

        // DEBUG: stock-type visibility trace. Logs, per Special Stock Type
        // ("Q" / "W" / blank-other), how many rows existed in the raw upload
        // vs how many survived filterRowsByAccess + the valuation-type check.
        // Safe to remove once the "Admin only sees RDF" issue is confirmed
        // fixed — this does not change any filtering behavior, it only reports it.
        (function debugStockTypeTrace() {
          const bucket = v => (v === "Q" ? "Q" : v === "W" ? "W" : "(blank/other)");
          const rawCounts = {};
          trimmed.forEach(r => {
            const sst = String(r["Special Stock Type"] || "").trim().toUpperCase();
            const b = bucket(sst);
            rawCounts[b] = (rawCounts[b] || 0) + 1;
          });
          const keptCounts = {};
          df.forEach(r => {
            const sst = String(r["Special Stock Type"] || "").trim().toUpperCase();
            const b = bucket(sst);
            keptCounts[b] = (keptCounts[b] || 0) + 1;
          });
          console.log("── Stock-type visibility trace ──");
          console.log("window.isAdmin:", window.isAdmin, "| role:", window.APP_USER && window.APP_USER.role, "| data_scopes:", window.APP_USER && window.APP_USER.data_scopes);
          console.log("Raw Q:", rawCounts["Q"] || 0, "| Raw W:", rawCounts["W"] || 0, "| Raw blank/other:", rawCounts["(blank/other)"] || 0);
          console.log("Kept Q:", keptCounts["Q"] || 0, "| Kept W:", keptCounts["W"] || 0, "| Kept blank/other:", keptCounts["(blank/other)"] || 0);
          if ((rawCounts["Q"] || 0) > 0 && (keptCounts["Q"] || 0) === 0) {
            const sampleQ = trimmed.find(r => String(r["Special Stock Type"] || "").trim().toUpperCase() === "Q");
            if (sampleQ) {
              const desc     = sampleQ["Special Stock Type Description"];
              const material = sampleQ["Material"];
              const matGroup = sampleQ["Material Group Name"];
              const storeLoc = sampleQ["Storage Location"];
              const valType  = sampleQ["Inventory Valuation Type"];
              console.log("── Checking sample Q row against each exclusion rule ──");
              console.log("Special Stock Type Description:", JSON.stringify(desc),
                "→ isProjectStockDescription:", typeof isProjectStockDescription === "function" ? isProjectStockDescription(desc) : "(fn missing)");
              console.log("Material:", JSON.stringify(material),
                "→ isNonMedicalCode:", typeof isNonMedicalCode === "function" ? isNonMedicalCode(material) : "(fn missing)");
              console.log("Material Group Name:", JSON.stringify(matGroup),
                "→ isNonMedicalGroup:", typeof isNonMedicalGroup === "function" ? isNonMedicalGroup(matGroup) : "(fn missing)");
              console.log("Storage Location:", JSON.stringify(storeLoc),
                "→ isExcludedStorageLocation:", typeof isExcludedStorageLocation === "function" ? isExcludedStorageLocation(storeLoc) : "(fn missing)");
              console.log("Inventory Valuation Type:", JSON.stringify(valType),
                "→ blank?", String(valType || "").trim() === "",
                "| resolved suffix:", typeof getValuationType === "function" ? getValuationType(sampleQ) : "(fn missing)");
              console.log("→ Whichever line above says 'true' (or 'blank? true') is the rule dropping this row. That rule needs its exclusion list/logic adjusted for Q-type stock, or the source data needs correcting.");
            }
          }
        })();

        const numCols = [
          "Unrestricted Stock","Stock in Quality Inspection","Blocked Stock","Stock in Transit",
          "Value of Stock in Quality Inspection","Value of Stock in Transit","Value of Unrestricted Stock",
        ];
        df.forEach(row => {
          numCols.forEach(c => { row[c] = parseFloat(row[c]) || 0; });
          // FIX BUG-8: use timezone-safe parser
          row._expiry = parseExpiryDate(row["Shelf Life Expiration Date"]);
          // SHELF-LIFE LOOKUP: Production Date is an OPTIONAL column — most inventory
          // exports won't have it, and most rows within it are blank (SAP rarely
          // captures production date per batch). parseExpiryDate() returns null for
          // blank/invalid values, so this is always safe even when the column is
          // entirely absent from the uploaded file.
          row._prodDate = parseExpiryDate(row["Production Date"]);
          row["Total Value"] = row["Value of Unrestricted Stock"] + row["Value of Stock in Transit"] + row["Value of Stock in Quality Inspection"];
          row["Total Qty"]   = row["Unrestricted Stock"] + row["Stock in Transit"] + row["Stock in Quality Inspection"];
        });

        df = df.filter(r =>
          r["Unrestricted Stock"] > 0 ||
          r["Stock in Transit"] > 0 ||
          r["Stock in Quality Inspection"] > 0 ||
          r["Blocked Stock"] > 0
        );

        rawDf  = df;
        filtDf = df;

        // EPSS_PLANT_MASTER: expose a clean plantCode -> plantName lookup built
        // from THIS file's own "Plant" / "Plant Name" columns (the authoritative
        // SAP master data), so other pages — e.g. pending-dispatch.js, which
        // only has the messier "Ship-to Party" / "Name of the ship-to party"
        // text to work with — can show the same clean names instead of
        // re-deriving their own from noisier data. Picks the most frequent
        // Plant Name seen per code, in case of stray casing/whitespace variants.
        (function buildPlantMaster() {
          const counts = {}; // code -> { name -> count }
          df.forEach((row) => {
            const code = String(row["Plant"] || "").trim().toUpperCase();
            const name = String(row["Plant Name"] || "").trim();
            if (!code || !name) return;
            counts[code] = counts[code] || {};
            counts[code][name] = (counts[code][name] || 0) + 1;
          });
          const master = {};
          Object.keys(counts).forEach((code) => {
            let best = null, bestN = -1;
            Object.entries(counts[code]).forEach(([name, n]) => {
              if (n > bestN) { best = name; bestN = n; }
            });
            master[code] = best;
          });
          window.EPSS_PLANT_MASTER = master;
        })();

        // FIX BUG-3: clear stale page filters from the previous file
        resetPageFilters();
        // FIX-STFILTER: also reset transit-section filter state on new main file load
        // so stale PO/supplying-plant selections from the previous dataset don't persist

        // FIX-PHANTOM-MAP-ORDER: stamp phantom/ghost transit flags on rawDf
        // BEFORE applying material mapping. applyMaterialMapping() builds mappedDf
        // via a shallow copy of each rawDf row ({...row, ...}); if it ran first,
        // rawDf wouldn't have _phantomTransitQty/_phantomTransitVal yet, so those
        // fields would never make it onto mappedDf. Since getReconciledBase() reads
        // from mappedDf whenever a mapping is loaded, the Ghost Transit tab
        // would silently show nothing for any dataset loaded alongside a mapping file.
        stampGhostTransit(); // stamp ghost amounts using the uploaded Stock-in-Transit verification file

        // Apply material standardization mapping if already loaded
        if (mappingTable.size > 0) applyMaterialMapping();

        showSuccess(file.name, df.length);
        clearError();
        hideLanding();
        populateAllFilters();
        // Switch to dashboard after file load
        renderPage(currentPage === "home" ? "dashboard" : currentPage);
      } catch (err) {
        showError(`Could not read Excel file: ${err.message}`);
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

// ── MULTI-SELECT DROPDOWN BUILDER ─────────────────────────────────────────
// Creates a searchable checkbox dropdown inside .ms-wrap elements.
// wrapId = id of the .ms-wrap container
// items  = array of string values
// onLabel = optional function(selectedArr) → button label string
function buildMultiSelect(wrapId, ddId, items, placeholder) {
  const wrap = document.getElementById(wrapId);
  const dd   = document.getElementById(ddId);
  if (!wrap || !dd) return;

  const btn  = wrap.querySelector(".ms-btn");

  // FIX-LABEL: use a mutable reference so updateLabel always targets the live
  // DOM button even after btn is replaced by freshBtn below.
  let activeBtn = btn;

  // Render options
  // FIX-SEARCH-CHECK-LOSS: renderItems() rebuilds the whole checkbox list from
  // scratch every time the search box fires (typing OR pasting). It used to
  // restore "checked" purely from pageFilters — the last APPLIED selection —
  // so any box the user had just ticked but not yet hit "Apply" on would
  // silently lose its checkmark the moment they searched/pasted for another
  // item, making an already-selected material look unselected. We now snapshot
  // whatever is actually checked in the DOM right before wiping it, and use
  // that snapshot (not pageFilters) to restore state on every re-render after
  // the first one, so in-progress selections survive searching/pasting.
  let hasRenderedOnce = false;
  function renderItems(filter) {
    const priorChecked = new Set(
      [...dd.querySelectorAll(".ms-item input:checked")].map(cb => cb.value)
    );
    const q = (filter || "").trim();
    const filtered = q ? items.filter(v => v.toLowerCase().includes(q.toLowerCase())) : items;

    // FEAT-MAPPING-SEARCH: if the typed text is a raw/source material code
    // that isn't itself an item (e.g. it has no current stock under that
    // exact code, or was consolidated), but the loaded mapping file maps it
    // to a target/STD code that IS an item, surface that item too — marked
    // "via <source code>" so it's clear it matched through the mapping
    // table, not a literal text match. Only ever finds anything for the
    // Material list (mapping entries are material codes); for Material
    // Group / Material Type this is a harmless no-op.
    const mappedExtras = [];
    if (q && typeof mappingTable !== "undefined" && mappingTable.size > 0) {
      const directCodes = new Set(filtered.map(v => v.split(" — ")[0].trim().toUpperCase()));
      const qUpper = q.toUpperCase();
      mappingTable.forEach((entry, srcCode) => {
        if (!srcCode.includes(qUpper)) return;
        const targetCode = String(entry.targetCode || "").trim().toUpperCase();
        if (!targetCode || directCodes.has(targetCode)) return; // already shown directly
        const targetItem = items.find(v => v.split(" — ")[0].trim().toUpperCase() === targetCode);
        if (targetItem && !mappedExtras.some(e => e.item === targetItem)) {
          mappedExtras.push({ item: targetItem, viaCode: srcCode });
          directCodes.add(targetCode);
        }
      });
    }

    dd.querySelectorAll(".ms-item").forEach(el => el.remove());

    const renderRow = (val, viaCode) => {
      const label = document.createElement("label");
      label.className = "ms-item";
      const cb = document.createElement("input");
      cb.type  = "checkbox";
      cb.value = val;
      // Restore checked state: after the first render, trust the live DOM
      // snapshot (priorChecked) so unsaved clicks survive searching/pasting.
      // On the very first render there's nothing to snapshot yet, so seed
      // from the last-Applied pageFilters selection as before.
      if (hasRenderedOnce) {
        if (priorChecked.has(val)) cb.checked = true;
      } else {
        const page = wrap.dataset.page, key = wrap.dataset.key;
        if (page && key && pageFilters[page] && (pageFilters[page][key] || []).includes(val)) {
          cb.checked = true;
        }
      }
      cb.addEventListener("change", updateLabel);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(val));
      if (viaCode) {
        const badge = document.createElement("span");
        badge.className = "ms-mapped-badge";
        badge.textContent = ` (STD, via ${viaCode})`;
        badge.title = `Matched because ${viaCode} is mapped to this material in your mapping file`;
        badge.style.cssText = "font-size:0.75em;opacity:0.65;font-style:italic;margin-left:4px";
        label.appendChild(badge);
      }
      dd.appendChild(label);
    };

    filtered.forEach(val => renderRow(val, null));
    mappedExtras.forEach(({ item, viaCode }) => renderRow(item, viaCode));

    hasRenderedOnce = true;
  }

  function updateLabel() {
    const checked = [...dd.querySelectorAll("input:checked")].map(c => c.value);
    if (checked.length === 0) {
      activeBtn.innerHTML = `${escHtml(placeholder)} <span class="ms-arrow">▾</span>`;
      activeBtn.classList.remove("ms-active");
    } else {
      const fullLabel = checked.join(", ");
      const display   = fullLabel.length > 32 ? fullLabel.slice(0, 30) + "…" : fullLabel;
      activeBtn.innerHTML = `<span class="ms-selected-names" title="${escHtml(fullLabel)}">${escHtml(display)}</span> <span class="ms-count-badge">${checked.length}</span> <span class="ms-arrow">▾</span>`;
      activeBtn.classList.add("ms-active");
    }
  }

  // Build search box + items
  dd.innerHTML = "";
  const searchInput = document.createElement("input");
  searchInput.className   = "ms-search";
  searchInput.placeholder = "Search… (or paste a list of codes)";
  searchInput.type        = "text";
  searchInput.addEventListener("input", e => renderItems(e.target.value));
  dd.appendChild(searchInput);
  renderItems("");

  // FEAT-MS-PASTE-SEARCH: Support pasting a whole list of codes at once
  // (e.g. copied from Excel/SAP as a column, or comma-separated from an
  // email) into any buildMultiSelect search box — most usefully the
  // Material field on Branch Comparison's "Material Across Branches" tab,
  // so a user can paste 50 material codes and have every match auto-checked
  // instead of typing/ticking them one at a time.
  //
  // Only kicks in when the pasted text actually contains more than one
  // token (split on newlines/commas/semicolons/tabs) — a normal single-word
  // paste (e.g. pasting one code to search for it) falls through to the
  // default paste behaviour and the existing live "input" filter above.
  searchInput.addEventListener("paste", e => {
    const clip = e.clipboardData || window.clipboardData;
    const text = clip ? clip.getData("text") : "";
    const tokens = [...new Set(
      text.split(/[\n\r,;\t]+/).map(s => s.trim()).filter(Boolean)
    )];
    if (tokens.length <= 1) return; // let the default single-value paste + search happen

    e.preventDefault();

    // Show the full (unfiltered) list so every checkbox we're about to tick
    // actually exists in the DOM, then match each pasted token against
    // either the item's leading code (before " — description") or its
    // full text, case-insensitively.
    renderItems("");
    const tokenSet = new Set(tokens.map(t => t.toUpperCase()));
    const matchedTokens = new Set();
    dd.querySelectorAll(".ms-item input[type=checkbox]").forEach(cb => {
      const fullUpper = cb.value.toUpperCase();
      const codeUpper = cb.value.split(" — ")[0].trim().toUpperCase();
      const hit = tokenSet.has(codeUpper) ? codeUpper : (tokenSet.has(fullUpper) ? fullUpper : null);
      if (hit) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change"));
        matchedTokens.add(hit);
      }
    });

    const unmatched = tokens.filter(t => !matchedTokens.has(t.toUpperCase()));
    searchInput.value = "";
    if (typeof showPasteMatchToast === "function") {
      showPasteMatchToast(tokens.length - unmatched.length, tokens.length, unmatched);
    }
  });

  // Toggle open/close
  // FIX-LISTENER: clone btn to strip any previously registered click listeners from
  // prior buildMultiSelect calls (e.g. when renderBranch rebuilds ms-branch-select).
  const freshBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(freshBtn, btn);
  // FIX-LABEL: update activeBtn to point at the now-live freshBtn so updateLabel
  // writes to the correct element (the old btn is detached from the DOM after replaceChild).
  activeBtn = freshBtn;
  freshBtn.addEventListener("click", e => {
    e.stopPropagation();
    // Close all others first
    document.querySelectorAll(".ms-wrap.open").forEach(w => { if (w !== wrap) w.classList.remove("open"); });
    wrap.classList.toggle("open");
    if (wrap.classList.contains("open")) searchInput.focus();
  });

  // Expose refresh function on the wrap element
  wrap._refreshOptions = function(newItems) {
    // BUG-MULTISELECT FIX: update the items array when newItems is provided
    if (Array.isArray(newItems)) items = newItems;
    renderItems(searchInput.value || "");
    updateLabel();
  };
  wrap._getSelected = function() {
    return [...dd.querySelectorAll("input:checked")].map(c => c.value);
  };
  wrap._clearSelected = function() {
    dd.querySelectorAll("input:checked").forEach(cb => { cb.checked = false; });
    updateLabel();
  };

  updateLabel();
}

// Close dropdowns when clicking outside
document.addEventListener("click", () => {
  document.querySelectorAll(".ms-wrap.open").forEach(w => w.classList.remove("open"));
});

// ── COLLAPSIBLE FILTER CHIPS ────────────────────────────────────────────────
// Wraps a filter control (select, multi-select, checkbox group, etc.) so it's
// hidden behind a small "chip" button and only appears once clicked. Used on
// pages with many filters (e.g. Branch Comparison) to keep the toolbar compact.
// Each chip shows a numeric badge when the filter has an active selection.
function filterChipHTML(id, label, innerHtml) {
  return `
    <div class="filter-item" id="flt-item-${id}" style="position:relative">
      <button type="button" class="filter-chip-toggle" id="flt-toggle-${id}"
        style="display:flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer;white-space:nowrap">
        <span>${escHtml(label)}</span>
        <span class="filter-badge" id="flt-badge-${id}" style="display:none;background:var(--blue,#3a8fd4);color:#fff;border-radius:10px;font-size:11px;font-weight:700;padding:1px 6px;min-width:16px;text-align:center;line-height:1.4">0</span>
        <span style="font-size:10px;opacity:0.7">▾</span>
      </button>
      <div class="filter-body" id="flt-body-${id}" style="display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.7rem;min-width:230px;box-shadow:0 4px 18px rgba(0,0,0,0.3)">
        ${innerHtml}
      </div>
    </div>`;
}

// Wires the toggle behaviour for one or more filter chips built with
// filterChipHTML(). Call once after the chips' HTML is in the DOM.
function wireFilterChips(ids) {
  ids.forEach(id => {
    const toggle = document.getElementById(`flt-toggle-${id}`);
    const body   = document.getElementById(`flt-body-${id}`);
    if (!toggle || !body) return;
    toggle.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
      toggle.classList.toggle("filter-chip-open", !isOpen);
    });
    // Clicks inside the body (e.g. opening a nested ms-wrap dropdown) shouldn't
    // bubble up and trigger the "close on outside click" handler below.
    body.addEventListener("click", e => e.stopPropagation());
  });
}

// Opens a specific filter chip's body (used e.g. by drilldowns that
// auto-select a filter, so the user immediately sees what changed).
function openFilterChip(id) {
  const toggle = document.getElementById(`flt-toggle-${id}`);
  const body   = document.getElementById(`flt-body-${id}`);
  if (!body || !toggle) return;
  body.style.display = "block";
  toggle.classList.add("filter-chip-open");
}

// Close any open filter-chip bodies when clicking outside them.
document.addEventListener("click", e => {
  document.querySelectorAll(".filter-body").forEach(body => {
    if (body.style.display === "none") return;
    const item = body.closest(".filter-item");
    if (item && !item.contains(e.target)) body.style.display = "none";
  });
});

// ── GLOBAL PERSON FILTER WIRING ─────────────────────────────────────────────
// Single dropdown in the sidebar drives the filter for every page.
(function wirePersonFilter() {
  function applyAndRender(newPerson) {
    personFilter.clear();
    if (newPerson) personFilter.add(newPerson);
    _syncChipState();
    if (typeof renderPage === "function") renderPage(currentPage);
  }

  document.body.addEventListener("change", e => {
    if (e.target.id !== "global-person-filter") return;
    applyAndRender(e.target.value);
  });

  document.body.addEventListener("click", e => {
    if (!e.target.closest("#pf-clear-global")) return;
    const sel = document.getElementById("global-person-filter");
    if (sel) sel.value = "";
    applyAndRender("");
  });
})();

// ── POPULATE FILTER DROPDOWNS ──────────────────────────────────────────────
function populateAllFilters() {
  // BUGFIX-PHANTOM-FILTER-OPTION: build every dropdown off the same base
  // applyPageFilter() actually renders against, not raw rawDf. rawDf
  // deliberately keeps HO01 (Head Office hub) rows for a branch-locked user
  // (canAccessPlant()'s hub carve-out, needed by Branch Demand / MOS), but
  // applyPageFilter() strips those same HO01 rows back out for that user at
  // render time (dashboard/transit/expiry/qc/branch all go through it). A
  // dropdown built straight from rawDf could therefore offer a Plant /
  // Material Group / Material Type whose only accessible rows live at
  // HO01 — a selectable option guaranteed to render zero results the
  // moment the user picks it. Routing through stripHubForBranchUser()
  // (permissions.js) first keeps the offered options in lockstep with what
  // applyPageFilter() can actually show. No-op for Admin/Head-Office users.
  const dropdownBase = (typeof stripHubForBranchUser === "function")
    ? stripHubForBranchUser(rawDf)
    : rawDf;

  const plants = [...new Set(dropdownBase.map(r => r["Plant Name"]))].filter(Boolean).sort();
  // Routed through the single central helper (permissions.js) instead of
  // building the list here — dropdownBase is already access-filtered (and
  // now HO01-stripped for branch users), so this just needs the shared
  // non-medical-group exclusion applied consistently with every other
  // Material Group control in the app.
  const mgs    = (typeof materialGroupFilterOptions === "function")
    ? materialGroupFilterOptions(dropdownBase)
    : [...new Set(dropdownBase.map(r => r["Material Group Name"]))].filter(Boolean).filter(name => !isNonMedicalGroup(name)).sort();

  // Plant multi-selects
  const plantConfigs = [
    { wrapId:"ms-dash-plant",    ddId:"ms-dash-plant-dd",    page:"dashboard", key:"plants" },
    { wrapId:"ms-transit-plant", ddId:"ms-transit-plant-dd", page:"transit",   key:"plants" },
    { wrapId:"ms-expiry-plant",  ddId:"ms-expiry-plant-dd",  page:"expiry",    key:"plants" },
    { wrapId:"ms-qc-plant",      ddId:"ms-qc-plant-dd",      page:"qc",        key:"plants" },
  ];
  plantConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "plants"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, plants, "All Plants");
  });

  // MG multi-selects
  const mgConfigs = [
    { wrapId:"ms-dash-mg",    ddId:"ms-dash-mg-dd",    page:"dashboard", key:"mgs" },
    { wrapId:"ms-transit-mg", ddId:"ms-transit-mg-dd", page:"transit",   key:"mgs" },
    { wrapId:"ms-expiry-mg",  ddId:"ms-expiry-mg-dd",  page:"expiry",    key:"mgs" },
    { wrapId:"ms-qc-mg",      ddId:"ms-qc-mg-dd",      page:"qc",        key:"mgs" },

  ];
  mgConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "mgs"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, mgs, "All Material Groups");
  });

  // Concentration page MG
  (() => {
    const wrap = document.getElementById("ms-conc-mg");
    if (wrap) { wrap.dataset.page = "concentration"; wrap.dataset.key = "mgs"; }
    buildMultiSelect("ms-conc-mg", "ms-conc-mg-dd", mgs, "All Material Groups");
  })();

  // Valuation Type multi-selects
  // Use materialTypeFilterOptions(rawDf) rather than deriving the list
  // inline: rawDf is already access-filtered, so for non-admins this is
  // equivalent to the old inline logic, but for Admin it now always shows
  // the full static ZME/ZMS/ZLC/ZMD list instead of only the types present
  // in the current upload (matches Dispatch/Comparison/Received Stock).
  const valTypes = (typeof materialTypeFilterOptions === "function")
    ? materialTypeFilterOptions(rawDf)
    : [...new Set(rawDf.map(r => getValuationType(r)))]
        .filter(v => v && v !== "(None)")
        .sort();

  const vtConfigs = [
    { wrapId:"ms-dash-vt",    ddId:"ms-dash-vt-dd",    page:"dashboard" },
    { wrapId:"ms-transit-vt", ddId:"ms-transit-vt-dd", page:"transit"   },
    { wrapId:"ms-expiry-vt",  ddId:"ms-expiry-vt-dd",  page:"expiry"    },
    { wrapId:"ms-qc-vt",      ddId:"ms-qc-vt-dd",      page:"qc"        },

  ];
  vtConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "valTypes"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, valTypes, "All Material Types");
  });

  // Concentration page VT
  (() => {
    const wrap = document.getElementById("ms-conc-vt");
    if (wrap) { wrap.dataset.page = "concentration"; wrap.dataset.key = "valTypes"; }
    buildMultiSelect("ms-conc-vt", "ms-conc-vt-dd", valTypes, "All Material Types");
  })();

  // Material multi-selects — replaces the old free-text Material Lookup search
  // boxes on Transit / Expiry / QC / Flow with a proper filter-bar control.
  const materials = [...new Set(rawDf.map(r => {
    const code = String(r["Material"] || "").trim();
    if (!code) return "";
    const desc = String(r["Material Description"] || "").trim();
    return code + (desc && desc !== code ? " — " + desc : "");
  }))].filter(Boolean).sort();

  const matConfigs = [
    { wrapId:"ms-transit-mat", ddId:"ms-transit-mat-dd", page:"transit",   key:"materials" },
    { wrapId:"ms-expiry-mat",  ddId:"ms-expiry-mat-dd",  page:"expiry",    key:"materials" },
    { wrapId:"ms-qc-mat",      ddId:"ms-qc-mat-dd",      page:"qc",        key:"materials" },

  ];
  matConfigs.forEach(cfg => {
    const wrap = document.getElementById(cfg.wrapId);
    if (wrap) { wrap.dataset.page = cfg.page; wrap.dataset.key = "materials"; }
    buildMultiSelect(cfg.wrapId, cfg.ddId, materials, "All Materials");
  });

  // New Received Stock (shelf-life.js) Material Type checklist. It's built
  // once at initial page wiring — before any file is uploaded, so rawDf is
  // empty and the checklist ends up with no options — and was never
  // refreshed afterward. Rebuild it here too, same as every other filter,
  // now that a file (and possibly a mapping) has just been loaded.
  if (typeof window.refreshIncomingValTypeOptions === "function") {
    window.refreshIncomingValTypeOptions();
  }

}

// ── APPLY PAGE FILTER ──────────────────────────────────────────────────────
// Uses the memoised reconciled base for performance.
// Also re-enforces base exclusion rules so excluded rows never appear on any page
// even if rawDf somehow contains them (e.g. after reconciliation merges).
function applyPageFilter(page) {
  const f    = pageFilters[page] || {};
  const base = getReconciledBase();
  const plants    = f.plants    || [];
  const mgs       = f.mgs       || [];
  const valTypes  = f.valTypes  || [];
  // Material filter values are stored as "CODE — Description" (or bare CODE);
  // only the code portion is matched against each row's Material field.
  const materials = (f.materials || []).map(v => String(v).split(" — ")[0].trim().toLowerCase());
  return base.filter(r =>
    // Re-apply base exclusion + role/scope rules (defence-in-depth) via the
    // single central helpers in permissions.js, rather than a second copy
    // of the rules living here.
    passesUniversalExclusions(r) &&
    canAccessRow(r) &&
    // PLANT SCOPING — HUB EXCLUSION: canAccessRow()/canAccessPlant() let a
    // branch-locked user's HO01 rows through (that carve-out exists for
    // Branch Demand and the MOS hub-vs-branch comparison, which read rawDf
    // directly and need it). Dashboard/Transit/Expiry Watchlist/Quality
    // Inspection/Branch Comparison all route through this shared
    // applyPageFilter() though, and a branch user should see ONLY their own
    // plant here — HO01 included — so strip HO01 rows back out at this
    // single choke point rather than duplicating the exclusion in every
    // page renderer.
    (typeof isHeadOfficeUser !== "function" || isHeadOfficeUser() ||
      String(r["Plant"] || "").trim().toUpperCase() !== (window.HUB_PLANT || "HO01")) &&
    String(r["Inventory Valuation Type"] || "").trim() !== "" &&
    // Page-level plant / material group / valuation type / material filters
    (!plants.length    || plants.includes(r["Plant Name"])) &&
    (!mgs.length       || mgs.includes(r["Material Group Name"])) &&
    (!valTypes.length  || valTypes.includes(getValuationType(r))) &&
    // FEAT-MAPPING-SEARCH: match on the raw code OR the mapped/STD code, so
    // selecting a target (STD) material also pulls in every source code that
    // maps to it (e.g. picking 105-PHEY-0301 includes 105-PHEY-0301-01 rows
    // too), not just rows whose raw code is a literal, exact match.
    (!materials.length
      || materials.includes(String(r["Material"] || "").trim().toLowerCase())
      || materials.includes(String(r._mappedMaterial || "").trim().toLowerCase()))
  );
}

// ── UI HELPERS ─────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById("errorBanner");
  el.textContent = `⚠️ ${msg}`;
  el.style.display = "block";
}
function clearError() { document.getElementById("errorBanner").style.display = "none"; }
function showSuccess(name, n) {
  const el = document.getElementById("fileStatus");
  el.style.display = "block";
  el.innerHTML = `<div class="status-ok">✓ FILE LOADED</div><div class="status-name">${escHtml(name)} (${n.toLocaleString()} records)</div>`;
  document.getElementById("uploadBtnText").textContent = "📂 Change File";
}
function hideLanding() { document.getElementById("landingView").style.display = "none"; }

function kpiCard(label, value, sub, color) {
  return `<div class="kpi-card ${color}"><div class="kpi-label">${escHtml(label)}</div><div class="kpi-value">${escHtml(value)}</div><div class="kpi-sub">${escHtml(sub)}</div></div>`;
}
function setKpis(id, cards) {
  document.getElementById(id).innerHTML = cards.map(([l,v,s,c]) => kpiCard(l,v,s,c)).join("");
}

// ── GROUPBY HELPERS ────────────────────────────────────────────────────────
function groupBy(data, key, aggCols) {
  const map = {};
  data.forEach(row => {
    // FIX BUG-10: label blank keys clearly so charts don't show an invisible bar
    const k = row[key] || "(Blank)";
    if (!map[k]) { map[k] = { [key]: k }; aggCols.forEach(([c]) => { map[k][c] = 0; }); }
    aggCols.forEach(([c,src]) => { map[k][c] += row[src] || 0; });
  });
  return Object.values(map);
}
function sortBy(arr, key, asc=false) { return [...arr].sort((a,b) => asc ? a[key]-b[key] : b[key]-a[key]); }

// ── Count DISTINCT materials (not summed quantity) within each group ───────
// Used by charts where the "Quantity" line should represent how many unique
// SKUs are present per group (e.g. per plant, per month) rather than the sum
// of stock quantities — those are two very different numbers, and mixing them
// up under one "Qty" label is what was causing confusion.
// Respects the same source-material mapping used elsewhere (_mappedMaterial).
// groupKey: column name to group by (e.g. "Plant Name"). Pass groupFn
// instead (e.g. getRowStockTypeLabel) to derive the group label from the
// row rather than reading a fixed column — used by charts that swap their
// axis to Stock Type (Q/RDF) for branch-locked roles.
function countUniqueMaterialsByGroup(rows, groupKey, groupFn) {
  const sets = {};
  rows.forEach(row => {
    const g = (typeof groupFn === "function") ? groupFn(row) : (row[groupKey] || "(Blank)");
    if (!sets[g]) sets[g] = new Set();
    sets[g].add(row._mappedMaterial || row["Material"]);
  });
  const out = {};
  Object.keys(sets).forEach(g => { out[g] = sets[g].size; });
  return out;
}

// ── TABLE BUILDER ──────────────────────────────────────────────────────────
// Columns with raw:true may contain trusted HTML (badges etc.) — all others
// are escaped to prevent XSS from Excel data landing in the DOM.
function buildTable(rows, cols, rowClass, extraClass="", exportOpts=null) {
  // exportOpts: { id, title } — when provided, renders a header bar with the
  // table's title (optional) and CSV/Excel export buttons inline, top-right
  // of the table itself. Caller must wire clicks via wireTableExport(id, ...)
  // after the HTML is inserted into the DOM.
  const exportHeader = exportOpts
    ? `<div class="tbl-export-header"><span class="tbl-export-title">${escHtml(exportOpts.title || "")}</span><div class="tbl-export-btns"><button class="dl-btn" id="${exportOpts.id}-csv">⬇ CSV</button><button class="dl-btn" id="${exportOpts.id}-xlsx">⬇ Excel</button></div></div>`
    : "";
  if (!rows.length) return `${exportHeader}<div class="alert-info">No data to display.</div>`;
  const thead = `<thead><tr>${cols.map(c => `<th>${escHtml(c.label)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(row => {
    const cls = rowClass ? rowClass(row) : "";
    return `<tr class="${cls}">${cols.map(c => {
      // Pass both the cell value AND the full row so fmt functions can cross-check sibling fields
      const raw     = c.fmt ? c.fmt(row[c.key], row) : (row[c.key] ?? "");
      const val     = c.raw ? raw : escHtml(String(raw));
      const cellCls = c.cellClass || "";
      return `<td class="${cellCls}">${val}</td>`;
    }).join("")}</tr>`;
  }).join("")}</tbody>`;
  return `<div class="tbl-wrap">${exportHeader}<table class="${extraClass}">${thead}${tbody}</table></div>`;
}

// ── Wire CSV/Excel buttons rendered by buildTable's exportOpts header ──────
// Call right after the table HTML (from buildTable with exportOpts) has been
// inserted into the DOM.
function wireTableExport(id, data, exportCols, filenameBase) {
  const csvBtn  = document.getElementById(`${id}-csv`);
  const xlsxBtn = document.getElementById(`${id}-xlsx`);
  if (csvBtn)  csvBtn.onclick  = () => downloadCSV(data,   exportCols, `${filenameBase}.csv`);
  if (xlsxBtn) xlsxBtn.onclick = () => downloadExcel(data, exportCols, `${filenameBase}.xlsx`);
}

// ── EXCEL DOWNLOAD ─────────────────────────────────────────────────────────
function downloadExcel(data, cols, filename) {
  const header = cols.map(c => c.label);
  const rows   = data.map(row => cols.map(c => {
    const v   = row[c.key];
    const raw = c.rawKey ? (row[c.rawKey] ?? v) : v;
    if (c.fmt) return (typeof raw === "number") ? raw : (raw ?? "");
    return raw ?? "";
  }));
  const wsData = [header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, filename);
}

// ── CSV DOWNLOAD ───────────────────────────────────────────────────────────
function downloadCSV(data, cols, filename) {
  const header = cols.map(c => c.label).join(",");
  const rows   = data.map(row => cols.map(c => {
    let v = c.rawKey ? (row[c.rawKey] ?? row[c.key] ?? "") : (row[c.key] ?? "");
    v = String(v ?? "");
    // FIX-CSV-ORDER: quote first (handles commas/tabs/newlines/quotes), THEN
    // apply injection guard — but only on non-quoted values so the ' prefix stays
    // as the literal first character seen by spreadsheet apps.
    const needsQuote = v.includes(",") || v.includes('"') || v.includes("\n") || v.includes("\t");
    if (needsQuote) {
      v = `"${v.replace(/"/g, '""')}"`;
    } else if (/^[=+\-@]/.test(v)) {
      // BUG-FIX-7: removed \r from injection guard regex. A value beginning with
      // \r\n (Windows line ending) would get a spurious ' prefix producing garbage
      // like '\r\nsome text. Carriage returns are already handled by the needsQuote
      // path above via the \n check (they always appear together in Windows line
      // endings). Formula-injection characters =, +, -, @ still guarded.
      v = `'${v}`;
    }
    return v;
  }).join(","));
  const blob = new Blob(["\uFEFF" + header + "\n" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Shared chart drilldown modal ────────────────────────────────────────────
// Popup shown when a bar on a dashboard/page chart is clicked, listing the
// underlying line items behind that bar. Reuses the same visual shell as the
// "Who's Responsible" search result card (who-resp-modal-overlay) and the
// Shelf Life lookup's wide table modal (shelf-modal), so it looks and behaves
// consistently with the rest of the app rather than introducing a new style.
//
// opts: { title, meta, rows, cols, rowClass, filenameBase }
function chartDrillEscHandler(e) { if (e.key === "Escape") closeChartDrillModal(); }

function closeChartDrillModal() {
  const overlay = document.getElementById("chart-drill-modal-overlay");
  if (overlay) overlay.remove();
  document.removeEventListener("keydown", chartDrillEscHandler);
}

function showChartDrillModal(opts) {
  closeChartDrillModal();
  const { title, meta, rows, cols, rowClass, filenameBase } = opts;

  const overlay = document.createElement("div");
  overlay.id = "chart-drill-modal-overlay";
  overlay.className = "who-resp-modal-overlay";
  overlay.innerHTML = `
    <div class="shelf-modal" role="dialog" aria-modal="true" aria-label="${escHtml(title)}">
      <button class="who-resp-modal-close" id="chart-drill-modal-close" type="button" aria-label="Close">✕</button>
      <div class="who-resp-modal-header">
        <div class="who-resp-modal-code">${escHtml(title)}</div>
        <div class="who-resp-modal-desc">${escHtml(meta || "")}</div>
      </div>
      <div class="shelf-batch-wrap" id="chart-drill-modal-table"></div>
      <div style="display:flex;gap:0.5rem;margin-top:0.9rem">
        <button class="apply-btn" id="chart-drill-dl-csv" type="button" style="flex:1">⬇ CSV</button>
        <button class="apply-btn" id="chart-drill-dl-xlsx" type="button" style="flex:1">⬇ Excel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("chart-drill-modal-table").innerHTML = rows.length
    ? buildTable(rows, cols, rowClass)
    : `<div class="alert-info">No items found.</div>`;

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeChartDrillModal(); });
  document.getElementById("chart-drill-modal-close").addEventListener("click", closeChartDrillModal);
  document.getElementById("chart-drill-dl-csv").addEventListener("click", () =>
    downloadCSV(rows, cols, `${filenameBase || "drilldown"}.csv`));
  document.getElementById("chart-drill-dl-xlsx").addEventListener("click", () =>
    downloadExcel(rows, cols, `${filenameBase || "drilldown"}.xlsx`));
  document.addEventListener("keydown", chartDrillEscHandler);
}

// Standard drilldown table columns — reused across all chart-click modals so
// the item list always looks the same regardless of which chart it came from.
const CHART_DRILL_COLS = [
  {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
  {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
  {key:"Material Group Name", label:"Material Group"},
  {key:"Plant Name",          label:"Plant"},
  {key:"_expiryStr",          label:"Expiry Date"},
  {key:"_daysLeftStr",        label:"Days to Expiry"},
  {key:"_drillQty",           label:"Qty",         fmt:fmtQty, rawKey:"_drillQty", cellClass:"col-qty"},
  {key:"_drillVal",           label:"Value (ETB)", fmt:fmtETB, rawKey:"_drillVal", cellClass:"col-val"},
];

// Builds a row set for the drilldown modal, stamping in the qty/value fields
// relevant to whichever stock status the click came from (Unrestricted,
// Transit, or QC), plus a readable expiry date string and days-remaining
// count (negative = already expired) for the "Days to Expiry" column.
function buildDrillRows(items, qtyKey, valKey) {
  const qtyFn = typeof qtyKey === "function" ? qtyKey : (r => qtyKey ? getMappedQty(r, qtyKey) : 0);
  const valFn = typeof valKey === "function" ? valKey : (r => valKey ? getMappedVal(r, valKey) : 0);
  const today = new Date(); today.setHours(0,0,0,0);
  return sortBy(items.map(r => {
    let daysLeftStr = "—";
    if (r._expiry instanceof Date && !isNaN(r._expiry)) {
      const exp = new Date(r._expiry); exp.setHours(0,0,0,0);
      const days = Math.round((exp - today) / 86400000);
      daysLeftStr = days < 0 ? `Expired ${Math.abs(days)}d ago` : `${days}d`;
    }
    return {
      ...r,
      _expiryStr: r._expiry instanceof Date && !isNaN(r._expiry) ? fmtLocalDate(r._expiry) : "—",
      _daysLeftStr: daysLeftStr,
      _drillQty:  qtyFn(r),
      _drillVal:  valFn(r),
    };
  }), "_drillVal");
}

// ── PLOTLY LAYOUT MERGE ────────────────────────────────────────────────────
function pl(extra={}) {
  const tc = getPlotlyThemeColors();
  const base = {
    ...PLOTLY_LAYOUT,
    font:   { ...PLOTLY_LAYOUT.font,   color: tc.muted },
    xaxis:  { ...PLOTLY_LAYOUT.xaxis,  gridcolor: tc.grid, zerolinecolor: tc.grid, tickfont: { color: tc.muted } },
    yaxis:  { ...PLOTLY_LAYOUT.yaxis,  gridcolor: tc.grid, zerolinecolor: tc.grid, tickfont: { color: tc.muted } },
    legend: { ...PLOTLY_LAYOUT.legend, font: { color: tc.muted } },
  };
  return Object.assign({}, base, extra, {
    xaxis:  Object.assign({}, base.xaxis,  extra.xaxis  || {}),
    yaxis:  Object.assign({}, base.yaxis,  extra.yaxis  || {}),
    legend: Object.assign({}, base.legend, extra.legend || {}),
    margin: Object.assign({}, base.margin, extra.margin || {}),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════
function renderDashboard() {
  const df = applyPageFilter("dashboard");

  // FIX-NO-DASH-PHANTOM-ALERT: the "Ghost Transit Stock Excluded" banner
  // is no longer shown on the Dashboard — it now only appears on the Transit
  // page itself. Dashboard totals still exclude ghost amounts (see
  // getTrueTransitVal/Qty below), just without the inline banner.
  const dashPhantomEl = document.getElementById("dash-phantom-alert");
  if (dashPhantomEl) dashPhantomEl.innerHTML = "";

  // Exclude ghost transit amounts (from the uploaded verification file) from Dashboard totals.
  const transitVal = df.reduce((s,r) => s + getTrueTransitVal(r), 0);
  const transitQty = df.reduce((s,r) => s + getTrueTransitQty(r), 0);
  const qcVal      = df.reduce((s,r) => s + getMappedVal(r,"Value of Stock in Quality Inspection"), 0);
  const availVal   = df.reduce((s,r) => s + getMappedVal(r,"Value of Unrestricted Stock"), 0);
  const totalVal   = availVal + transitVal + qcVal;
  const totalQty   = df.reduce((s,r) => s + getMappedQty(r,"Unrestricted Stock"), 0) + transitQty + df.reduce((s,r) => s + getMappedQty(r,"Stock in Quality Inspection"), 0);

  setKpis("dash-kpis", [
    ["Total Inventory Value",    fmtETB(totalVal),   "",      "blue"],
    ["Stock in Transit Value",   fmtETB(transitVal), "", "amber"],
    ["Value in QC",              fmtETB(qcVal),      "", "red"],
    ["Available (Unrestricted)", fmtETB(availVal),   "", "green"],
    ["Unique Materials",         new Set(df.map(r=>r._mappedMaterial||r["Material"])).size.toLocaleString(), `${new Set(df.map(r=>r["Plant"])).size} plants`, "purple"],
  ]);

  // Plant bar — stacked by stock status (Unrestricted / In Transit / In QC), matching
  // the Branch Comparison chart style. Uses getMappedVal/getTrueTransitVal so
  // unit-conversion mapping and the phantom-transit exclusion are respected, same
  // as everywhere else on the Dashboard.
  //
  // FEAT-BRANCH-AXIS: branch-locked roles only ever have one Plant, so this
  // chart used to render as one full-width bar for them. For those roles,
  // group by Stock Type (Q / RDF) instead — still meaningful within a
  // single branch. HO01/Admin keep the Plant axis regardless of how many
  // plants survive the current filter. See shouldUseStockTypeAxis() in
  // permissions.js.
  const useStockTypeAxis = typeof shouldUseStockTypeAxis === "function" && shouldUseStockTypeAxis();
  const plantAggMap = {};
  df.forEach(r => {
    const k = useStockTypeAxis ? getRowStockTypeLabel(r) : (r["Plant Name"] || "(Blank)");
    if (!plantAggMap[k]) {
      plantAggMap[k] = {
        PlantName:k, Unrestricted:0, Transit:0, QC:0, TotalValue:0,
        UnrestrictedMats:new Set(), TransitMats:new Set(), QCMats:new Set(), AllMats:new Set(),
      };
    }
    const matKey           = r._mappedMaterial || r["Material"];
    const unrestrictedVal  = getMappedVal(r,"Value of Unrestricted Stock");
    const transitVal2      = getTrueTransitVal(r);
    const qcVal2           = getMappedVal(r,"Value of Stock in Quality Inspection");
    const unrestrictedQty2 = getMappedQty(r,"Unrestricted Stock");
    const transitQty2      = getTrueTransitQty(r);
    const qcQty2           = getMappedQty(r,"Stock in Quality Inspection");
    plantAggMap[k].Unrestricted += unrestrictedVal;
    plantAggMap[k].Transit      += transitVal2;
    plantAggMap[k].QC           += qcVal2;
    plantAggMap[k].TotalValue   += unrestrictedVal + transitVal2 + qcVal2;
    // Only count a material toward a status's SKU set if it actually carries
    // quantity in that status — matches how the bar segments themselves work.
    if (unrestrictedQty2 > 0) plantAggMap[k].UnrestrictedMats.add(matKey);
    if (transitQty2      > 0) plantAggMap[k].TransitMats.add(matKey);
    if (qcQty2            > 0) plantAggMap[k].QCMats.add(matKey);
    if (unrestrictedQty2 > 0 || transitQty2 > 0 || qcQty2 > 0) plantAggMap[k].AllMats.add(matKey);
  });
  const plantAgg = sortBy(Object.values(plantAggMap), "TotalValue");
  Plotly.newPlot("chart-plant-val", [
    { type:"bar", name:"Unrestricted (ETB)", x:plantAgg.map(r=>r.PlantName), y:plantAgg.map(r=>r.Unrestricted),
      customdata:plantAgg.map(r=>r.UnrestrictedMats.size), marker:{color:"#3fb950"}, yaxis:"y",
      hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<br>Materials: %{customdata:,d}<extra></extra>" },
    { type:"bar", name:"In Transit (ETB)", x:plantAgg.map(r=>r.PlantName), y:plantAgg.map(r=>r.Transit),
      customdata:plantAgg.map(r=>r.TransitMats.size), marker:{color:"#d29922"}, yaxis:"y",
      hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<br>Materials: %{customdata:,d}<extra></extra>" },
    { type:"bar", name:"In QC (ETB)", x:plantAgg.map(r=>r.PlantName), y:plantAgg.map(r=>r.QC),
      customdata:plantAgg.map(r=>r.QCMats.size), marker:{color:"#f85149"}, yaxis:"y",
      hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<br>Materials: %{customdata:,d}<extra></extra>" },
    { type:"scatter", mode:"lines+markers", name:"Unique Materials", x:plantAgg.map(r=>r.PlantName), y:plantAgg.map(r=>r.AllMats.size),
      yaxis:"y2", marker:{color:"#7ee0ff",size:7}, line:{color:"#7ee0ff"},
      hovertemplate:"<b>%{x}</b><br>Materials: %{y:,d}<extra></extra>" },
  ], pl({
    height:300,
    barmode:"stack",
    margin:{l:60,r:70,t:20,b:100},
    xaxis:{title:{text: useStockTypeAxis ? "Stock Type" : "Plant", font:{size:10}}, tickangle:-35, tickfont:{size:10}, automargin:true},
    yaxis:{title:{text:"Value (ETB)",font:{size:10}}, automargin:true},
    yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#7ee0ff"},tickformat:",d",title:{text:"Unique Materials",font:{size:10,color:"#7ee0ff"}}},
  }), PLOTLY_CONFIG);

  const dashPlantValEl = document.getElementById("chart-plant-val");
  if (dashPlantValEl) {
    dashPlantValEl.on("plotly_click", function(data) {
      const groupLabel = data.points[0].x;
      const items = useStockTypeAxis
        ? df.filter(r => getRowStockTypeLabel(r) === groupLabel)
        : df.filter(r => (r["Plant Name"] || "(Blank)") === groupLabel);
      const rows = buildDrillRows(items, "Unrestricted Stock", "Value of Unrestricted Stock");
      showChartDrillModal({
        title: `📦 Inventory — ${groupLabel}`,
        meta: `${rows.length} items`,
        rows, cols: CHART_DRILL_COLS,
        filenameBase: `inventory_${groupLabel}`,
      });
    });
  }

  // ── Material Groups with Expiry Risk ──────────────────────────────────
  // For each material group, count how many distinct materials have
  // near-expiry unrestricted stock within the next 6 months.
  // Split into Critical (<3 months) and High (3–6 months) bands.
  const now        = new Date();
  const cut3mo     = new Date(now); cut3mo.setMonth(cut3mo.getMonth() + 3);
  const cut6mo     = new Date(now); cut6mo.setMonth(cut6mo.getMonth() + 6);

  // Build per-group risk counts using unique material codes (not row counts)
  // so a material stocked at multiple plants counts once per group.
  const mgRiskMap = {};
  df.forEach(r => {
    if (!(r._expiry instanceof Date) || isNaN(r._expiry)) return;
    if ((r["Unrestricted Stock"] || 0) <= 0) return;
    const grp = r["Material Group Name"] || "(Blank)";
    const mat = r._mappedMaterial || r["Material"];
    if (!mgRiskMap[grp]) mgRiskMap[grp] = { critical: new Set(), high: new Set() };
    if (r._expiry >= now && r._expiry <= cut3mo) {
      mgRiskMap[grp].critical.add(mat);
    } else if (r._expiry > cut3mo && r._expiry <= cut6mo) {
      mgRiskMap[grp].high.add(mat);
    }
  });

  // Only show groups that have at least one at-risk material; sort by total risk desc
  const mgRiskRows = Object.entries(mgRiskMap)
    .map(([grp, sets]) => ({
      grp,
      critical: sets.critical.size,
      high:     sets.high.size,
      total:    sets.critical.size + sets.high.size,
    }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  const mgRiskEl = document.getElementById("chart-mg-expiry-risk");
  if (mgRiskRows.length) {
    // Count total unique groups with any risk exposure for the subtitle
    const totalRiskGroups = Object.values(mgRiskMap).filter(s => s.critical.size + s.high.size > 0).length;
    const totalGroups     = new Set(df.map(r => r["Material Group Name"]).filter(Boolean)).size;
    // Update subtitle in legend area
    const legendEl = document.getElementById("mg-expiry-risk-legend");
    if (legendEl) {
      legendEl.innerHTML = `
        <span class="mg-risk-summary"><b style="color:var(--red)">${totalRiskGroups}</b> of ${totalGroups} groups have near-expiry exposure</span>
        <span style="display:flex;gap:0.7rem;flex-wrap:wrap;margin-top:0.35rem">
          <span><span class="mg-risk-dot" style="background:#f85149"></span>Critical (&lt;3 mo)</span>
          <span><span class="mg-risk-dot" style="background:#ffa657"></span>High (3–6 mo)</span>
        </span>`;
    }

    const labels = mgRiskRows.map(r => r.grp.length > 26 ? r.grp.slice(0, 24) + "…" : r.grp);
    // FIX-XAXIS-READABILITY: dtick:1 forced a tick at every integer, which became
    // an unreadable wall of overlapping labels once any group's risk count grew
    // past ~15-20. Scale the tick step to the largest bar so there are at most
    // ~8 ticks, while tickformat keeps labels as whole numbers (counts of materials).
    const maxRisk = Math.max(1, ...mgRiskRows.map(r => r.total));
    const xDtick  = maxRisk <= 10 ? 1 : Math.ceil(maxRisk / 8);
    Plotly.newPlot("chart-mg-expiry-risk", [
      {
        type: "bar", orientation: "h", name: "Critical (<3 mo)",
        x: mgRiskRows.map(r => r.critical),
        y: labels,
        marker: { color: "#f85149" },
        hovertemplate: "<b>%{y}</b><br>Critical: %{x} material(s)<extra></extra>",
      },
      {
        type: "bar", orientation: "h", name: "High (3–6 mo)",
        x: mgRiskRows.map(r => r.high),
        y: labels,
        marker: { color: "#ffa657" },
        hovertemplate: "<b>%{y}</b><br>High: %{x} material(s)<extra></extra>",
      },
    ], pl({
      barmode: "stack",
      height: Math.max(220, mgRiskRows.length * 26 + 40),
      margin: { l: 10, r: 30, t: 10, b: 30 },
      xaxis: { title: { text: "Materials at risk", font: { size: 10, color: "#7a97b0" } }, dtick: xDtick, tickformat: ",d" },
      yaxis: { automargin: true, tickfont: { size: 10 } },
      legend: { orientation: "h", y: -0.18, x: 0, font: { size: 10 } },
      showlegend: true,
    }), PLOTLY_CONFIG);

    document.getElementById("chart-mg-expiry-risk").on("plotly_click", function(data) {
      const pt = data.points[0];
      // Use the point's index into mgRiskRows rather than the y-axis label
      // text, since long group names are truncated with "…" for display and
      // would be ambiguous/unreliable to match back to the original name.
      const rowInfo = mgRiskRows[pt.pointIndex];
      if (!rowInfo) return;
      const band = pt.data.name.startsWith("Critical") ? "critical" : "high";
      const items = df.filter(r => {
        if (!(r._expiry instanceof Date) || isNaN(r._expiry)) return false;
        if ((r["Unrestricted Stock"] || 0) <= 0) return false;
        if ((r["Material Group Name"] || "(Blank)") !== rowInfo.grp) return false;
        return band === "critical"
          ? (r._expiry >= now && r._expiry <= cut3mo)
          : (r._expiry > cut3mo && r._expiry <= cut6mo);
      });
      const rows = buildDrillRows(items, "Unrestricted Stock", "Value of Unrestricted Stock");
      const bandLabel = band === "critical" ? "Critical (<3 mo)" : "High (3–6 mo)";
      showChartDrillModal({
        title: `⚠️ ${rowInfo.grp} — ${bandLabel}`,
        meta: `${rows.length} materials at risk`,
        rows, cols: CHART_DRILL_COLS,
        filenameBase: `expiry_risk_${rowInfo.grp}_${band}`,
      });
    });
  } else {
    mgRiskEl.innerHTML = `<div class="alert-info" style="margin:0.5rem 0;font-size:0.75rem">✓ No material groups have near-expiry stock within 6 months.</div>`;
  }

  // Near-expiry by plant (within 6 months)
  const nearCutoff = new Date(); nearCutoff.setMonth(nearCutoff.getMonth() + 6);
  const nearToday  = new Date();
  const nearExpiry = df.filter(r =>
    r._expiry instanceof Date && !isNaN(r._expiry) &&
    r._expiry >= nearToday && r._expiry <= nearCutoff &&
    (r["Unrestricted Stock"] || 0) > 0
  );
  // FIX-DASH-EXPORT-MISMATCH: was groupBy(nearExpiry, "Plant Name", [["val","Value of
  // Unrestricted Stock"]]) — that sums the RAW SAP column directly, bypassing
  // getMappedVal(). Every other Dashboard aggregate (KPIs, chart-plant-val) goes
  // through getMappedVal so material-mapping conversion factors are respected, and
  // the drilldown modal's export (buildDrillRows -> getMappedVal) does too. Left as
  // a raw sum, this bar's height silently disagreed with the CSV/Excel exported from
  // clicking it whenever a mapping file was active. Aggregating with getMappedVal
  // here makes the bar and its export agree again.
  // FEAT-BRANCH-AXIS: branch-locked roles only have one Plant, so this chart
  // used to render as one full-width bar for them. Group by Stock Type
  // (Q / RDF) instead for those roles; HO01/Admin keep the Plant axis. See
  // shouldUseStockTypeAxis() in permissions.js.
  const nearUseStockTypeAxis = typeof shouldUseStockTypeAxis === "function" && shouldUseStockTypeAxis();
  const nearByPlantMap = {};
  nearExpiry.forEach(r => {
    const k = nearUseStockTypeAxis ? getRowStockTypeLabel(r) : (r["Plant Name"] || "(Blank)");
    if (!nearByPlantMap[k]) nearByPlantMap[k] = { "Plant Name": k, val: 0 };
    nearByPlantMap[k].val += getMappedVal(r, "Value of Unrestricted Stock");
  });
  const nearByPlant = sortBy(Object.values(nearByPlantMap), "val");
  const uniqByPlantNear = countUniqueMaterialsByGroup(nearExpiry, nearUseStockTypeAxis ? null : "Plant Name", nearUseStockTypeAxis ? getRowStockTypeLabel : null);
  nearByPlant.forEach(r => { r.uniqMat = uniqByPlantNear[r["Plant Name"]] || 0; });
  if (nearByPlant.length) {
    Plotly.newPlot("chart-mg-bar", [
      { type:"bar", name:"Value at Risk (ETB)", x:nearByPlant.map(r=>r["Plant Name"]), y:nearByPlant.map(r=>r.val), yaxis:"y",  marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"scatter", mode:"lines+markers", name:"Unique Materials at Risk", x:nearByPlant.map(r=>r["Plant Name"]), y:nearByPlant.map(r=>r.uniqMat), yaxis:"y2", marker:{color:"#f85149",size:8}, line:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>Materials: %{y}<extra></extra>" },
    ], pl({
      height:420, margin:{l:60,r:80,t:20,b:110}, barmode:"group",
      xaxis:{title:{text: nearUseStockTypeAxis ? "Stock Type" : "Plant", font:{size:10}}, tickangle:-35, tickfont:{size:10}, automargin:true},
      yaxis:{title:{text:"Value at Risk (ETB)",font:{size:10,color:"#d29922"}}, tickfont:{color:"#d29922"}, automargin:true},
      yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#f85149"},tickformat:",d",title:{text:"Unique Materials",font:{size:10,color:"#f85149"}}},
    }), PLOTLY_CONFIG);

    document.getElementById("chart-mg-bar").on("plotly_click", function(data) {
      const groupLabel = data.points[0].x;
      const items = nearUseStockTypeAxis
        ? nearExpiry.filter(r => getRowStockTypeLabel(r) === groupLabel)
        : nearExpiry.filter(r => (r["Plant Name"] || "(Blank)") === groupLabel);
      const rows  = buildDrillRows(items, "Unrestricted Stock", "Value of Unrestricted Stock");
      showChartDrillModal({
        title: `⏳ Near-Expiry Risk — ${groupLabel}`,
        meta: `${rows.length} items · within 6 months`,
        rows, cols: CHART_DRILL_COLS,
        filenameBase: `near_expiry_${groupLabel}`,
      });
    });
  } else {
    document.getElementById("chart-mg-bar").innerHTML = `<div class="alert-info" style="margin:1rem 0">✓ No near-expiry stock (within 6 months) with quantity on hand.</div>`;
  }

  // Download
  const dlCols = [
    {key:"Plant Name",         label:"Plant"},
    {key:"Material Group Name",label:"Material Group"},
    {key:"Total Value",        label:"Total Value (ETB)", fmt:fmtETB, rawKey:"Total Value"},
    {key:"Total Qty",          label:"Total Qty",         fmt:fmtQty, rawKey:"Total Qty"},
  ];
  const aggForDl = groupBy(df, "Plant Name", [["Total Value","Total Value"],["Total Qty","Total Qty"]]);

}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK IN TRANSIT FILE LOADER
// ═══════════════════════════════════════════════════════════════════════════
// MATERIAL STANDARDIZATION MAPPING — File Loader & Core Logic
// ═══════════════════════════════════════════════════════════════════════════

/**
 * loadMappingFile(file)
 *   Parses the uploaded mapping Excel and populates mappingTable.
 *   Expected columns (case-insensitive):
 *     Material Code SORCE / Material Code Source → source code
 *     Material Description (source)              → source desc (informational)
 *     Conversion Factor                          → multiplier
 *     Material Code Target                       → target code
 *     Material Description (target)              → target desc
 *
 * After parsing, calls applyMaterialMapping() and re-renders the current page.
 */
function loadMappingFile(file) {
  const statusEl = document.getElementById("mappingFileStatus");
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!data.length) { statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ Mapping file is empty.</div>`; return; }

        // Case-insensitive column lookup
        const colMap = {};
        Object.keys(data[0]).forEach(k => { colMap[k.toLowerCase().trim()] = k; });
        const gc = (...names) => {
          for (const n of names) {
            const k = colMap[n.toLowerCase()];
            if (k) return k;
          }
          return null;
        };

        const colSource  = gc(
          "material code sorce","material code source","material code (source)",
          "source material code","source code","mat code source","mat. code source",
          "source mat code","source material","material source","source"
        );
        const colTarget  = gc(
          "material code target","target material code","target code",
          "mat code target","mat. code target","target mat code",
          "target material","material target","target"
        );
        const colFactor  = gc(
          "conversion factor","factor","conv factor","conversion",
          "conv. factor","uom factor","unit factor","qty factor","quantity factor"
        );
        let colTgtDesc = gc(
          "material description (target)","target description","target desc",
          "material description target","target material description","desc target",
          "description (target)","description target"
        );

        // POSITIONAL-TARGET-DESC-FIX: some mapping files reuse the exact same
        // header text for both the source and target description columns
        // (e.g. "Material Description " for source and "Material
        // Description" for target — after trimming, both collide on the
        // same normalized key, so name-based lookup above can only ever
        // resolve to one of them and has no way to tell which). Whenever a
        // description-like column follows "Material Code Target" in the
        // sheet's actual column order, that positional column IS the target
        // description — this takes priority over the name-based match
        // above, since a name match found under ambiguous/colliding headers
        // isn't trustworthy.
        if (colTarget) {
          const headerKeys = Object.keys(data[0]);
          const targetIdx  = headerKeys.indexOf(colTarget);
          const isDescLike = k => {
            const n = k.toLowerCase().trim();
            return n === "material description" || n === "description" || n === "desc"
                || n === "material desc" || n.includes("description");
          };
          if (targetIdx !== -1) {
            const positionalTgtDesc = headerKeys.slice(targetIdx + 1).find(isDescLike);
            if (positionalTgtDesc) colTgtDesc = positionalTgtDesc;
          }
        }

        if (!colSource || !colTarget || !colFactor) {
          const missing = [
            !colSource && "Material Code Source",
            !colTarget && "Material Code Target",
            !colFactor && "Conversion Factor",
          ].filter(Boolean);
          const actualCols = Object.keys(data[0]).map(k => k.trim()).join(", ");
          statusEl.innerHTML = `
            <div class="status-ok" style="color:var(--red)">✗ Missing required columns: ${missing.join(", ")}</div>
            <div style="font-size:var(--fs-2xs);margin-top:4px;color:var(--muted)">
              <b>Accepted names:</b><br>
              • Source: "Material Code Source" (or "Material Code Sorce", "Source Code")<br>
              • Target: "Material Code Target" (or "Target Material Code", "Target Code")<br>
              • Factor: "Conversion Factor" (or "Factor", "Conv Factor")<br>
              <b style="color:var(--amber)">Columns found in your file:</b> ${escHtml(actualCols)}
            </div>`;
          return;
        }

        // Build the mapping table — source → { targetCode, targetDesc, factor }
        const newMap = new Map();
        let skipped  = 0;
        data.forEach(row => {
          const src    = String(row[colSource]  ?? "").trim();
          const tgt    = String(row[colTarget]  ?? "").trim();
          const rawFac = String(row[colFactor]  ?? "").trim();
          const tDesc  = colTgtDesc ? String(row[colTgtDesc] ?? "").trim() : "";
          const factor = parseFloat(rawFac);

          if (!src || !tgt || isNaN(factor) || factor <= 0) { skipped++; return; }
          // Store with 9dp rounding to suppress float drift (consistent with existing reconciliation logic)
          newMap.set(src.toUpperCase(), { targetCode: tgt, targetDesc: tDesc, factor: parseFloat(factor.toFixed(9)) });
        });

        if (!newMap.size) {
          statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ No valid mapping rows found (${skipped} skipped).</div>`;
          return;
        }

        mappingTable = newMap;

        // FIX-MAPPING-PERSIST: save mapping to sessionStorage so it survives
        // soft page navigations within the same browser session.
        try {
          const serialized = JSON.stringify([...newMap.entries()]);
          sessionStorage.setItem("pharmatrack_mapping", serialized);
        } catch (_) { /* quota exceeded or private mode — silent */ }

        // Apply to current inventory (if loaded)
        if (rawDf.length) applyMaterialMapping();

        statusEl.innerHTML = `
          <div class="status-ok">✓ MAPPING LOADED</div>
          <div class="status-name">${escHtml(file.name)}</div>
          <div class="status-stats">${newMap.size.toLocaleString()} mapping rules${skipped ? ` · ${skipped} rows skipped` : ""}</div>
          ${mappingStats ? `<div class="status-stats">${mappingStats.mapped.toLocaleString()} materials mapped · ${mappingStats.valuePct}% of stock value</div>` : ""}`;
        document.getElementById("mappingUploadBtnText").textContent = "🗺️ Change Mapping File";

        // Re-render current page with mapped data
        if (rawDf.length) {
          const reRender = {
            dashboard: renderDashboard, transit: renderTransit,
            expiry: renderExpiry, qc: renderQC, branch: renderBranch,
          };
          if (reRender[currentPage]) reRender[currentPage]();
        }
      } catch (err) {
        statusEl.innerHTML = `<div class="status-ok" style="color:var(--red)">✗ ${escHtml(err.message)}</div>`;
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK-IN-TRANSIT VERIFICATION FILE LOADER
// ═══════════════════════════════════════════════════════════════════════════
/**
 * loadTransitFile(file)
 *   Parses the uploaded Stock-in-Transit verification file and populates
 *   TRANSIT_UPLOAD_LIST. Expected columns (case-insensitive, flexible names):
 *     Material Code  → material code
 *     Plant Code     → plant code
 *     Quantity       → quantity currently in transit for that material+plant
 *
 *   This file is held in memory only for the current session — it is never
 *   written to sessionStorage/localStorage, so it must be re-uploaded after
 *   a page reload or in a new session, matching the app's existing
 *   session-only data model for hardcoded/derived state.
 *
 *   After parsing, re-stamps rawDf (stampGhostTransit) and re-renders
 *   the current page so true/ghost totals update everywhere.
 */
function loadTransitFile(file) {
  const statusEls = [document.getElementById("transitFileStatus"), document.getElementById("transitGateFileStatus")].filter(Boolean);
  const setStatus = html => statusEls.forEach(el => { el.style.display = "block"; el.innerHTML = html; });
  setStatus(`<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`);

  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        let data;
        if (/\.csv$/i.test(file.name)) {
          const text = new TextDecoder("utf-8").decode(new Uint8Array(e.target.result));
          const wb   = XLSX.read(text, { type: "string" });
          data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
        } else {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
          data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
        }
        if (!data.length) { setStatus(`<div class="status-ok" style="color:var(--red)">✗ Stock-in-Transit file is empty.</div>`); return; }

        // Case-insensitive, flexible column lookup (same pattern as loadMappingFile)
        const colMap = {};
        Object.keys(data[0]).forEach(k => { colMap[k.toLowerCase().trim()] = k; });
        const gc = (...names) => {
          for (const n of names) {
            const k = colMap[n.toLowerCase()];
            if (k) return k;
          }
          return null;
        };
        const colMat = gc("material code","material","material code (source)","mat code","mat. code","code");
        const colPlt = gc("plant code","plant","plant  code");
        const colQty = gc("quantity","qty","stock in transit","quantity in transit","transit qty","transit quantity");
        const colDesc = gc("material description","description","material desc","desc");
        const colUom  = gc("base unit of measure","uom","unit of measure","unit","base unit");
        const colSupPlant = gc("supplying plant","supplying plant code","supply plant","supplying plant name","source plant");

        if (!colMat || !colPlt || !colQty) {
          const missing = [!colMat && "Material Code", !colPlt && "Plant Code", !colQty && "Quantity"].filter(Boolean);
          const actualCols = Object.keys(data[0]).map(k => k.trim()).join(", ");
          setStatus(`
            <div class="status-ok" style="color:var(--red)">✗ Missing required columns: ${missing.join(", ")}</div>
            <div style="font-size:var(--fs-2xs);margin-top:4px;color:var(--muted)">
              <b>Expected:</b> "Material Code", "Plant Code", "Quantity"<br>
              <b style="color:var(--amber)">Columns found in your file:</b> ${escHtml(actualCols)}
            </div>`);
          return;
        }

        const newList = [];
        let skipped = 0;
        data.forEach(row => {
          const mat = String(row[colMat] ?? "").trim();
          const plt = String(row[colPlt] ?? "").trim();
          const qty = parseFloat(row[colQty]);
          if (!mat || !plt || isNaN(qty)) { skipped++; return; }
          newList.push({
            materialCode: mat, plantCode: plt, qty: qty,
            desc: colDesc ? String(row[colDesc] ?? "").trim() : "",
            uom:  colUom  ? String(row[colUom]  ?? "").trim() : "",
            supplyingPlant: colSupPlant ? String(row[colSupPlant] ?? "").trim() : "",
          });
        });

        if (!newList.length) {
          setStatus(`<div class="status-ok" style="color:var(--red)">✗ No valid rows found (${skipped} skipped).</div>`);
          return;
        }

        TRANSIT_UPLOAD_LIST = newList;
        transitFileLoaded   = true;
        transitFileName     = file.name;
        _rebuildTransitUploadLookup();

        // Re-stamp rawDf with fresh true/ghost amounts and re-render
        if (rawDf.length) {
          stampGhostTransit();
          const phantomAllTransit = rawDf.filter(r => r["Stock in Transit"] > 0);
          const ghostCount   = phantomAllTransit.filter(r => r._phantomTransitQty > 0).length;
          const trueCount     = phantomAllTransit.length - ghostCount;
          transitFileStats = { trueCount, ghostCount };
        }

        const statsLine = transitFileStats
          ? `<div class="status-stats">${transitFileStats.trueCount.toLocaleString()} true · ${transitFileStats.ghostCount.toLocaleString()} ghost (material+plant rows)</div>`
          : "";
        setStatus(`
          <div class="status-ok">✓ FILE LOADED</div>
          <div class="status-name">${escHtml(file.name)}</div>
          <div class="status-stats">${newList.length.toLocaleString()} row${newList.length!==1?"s":""}${skipped ? ` · ${skipped} skipped` : ""}</div>
          ${statsLine}`);
        const btnTextEl = document.getElementById("transitUploadBtnText");
        if (btnTextEl) btnTextEl.textContent = "🚚 Change Stock-in-Transit File";

        if (rawDf.length && currentPage === "transit") renderTransit();
        // Other pages (dashboard, branch, flow) fold true/ghost totals
        // in automatically the next time they're rendered/navigated to.
      } catch (err) {
        setStatus(`<div class="status-ok" style="color:var(--red)">✗ ${escHtml(err.message)}</div>`);
      }
    }, 30);
  };
  reader.readAsArrayBuffer(file);
}

/**
 * applyMaterialMapping()
 *   Walks rawDf and stamps every row with:
 *     _mappedMaterial  — target material code (or original if no mapping)
 *     _mappedDesc      — target description   (or original)
 *     _mappingFactor   — conversion factor     (1.0 if no mapping)
 *     _isMapped        — boolean: true = this row has a mapping entry
 *     _origMaterial    — always the original Material code (for traceability)
 *     _origDesc        — always the original Material Description
 *
 *   Converted quantity / value fields on the row object are also stamped:
 *     _cvUnrestricted, _cvTransit, _cvQC, _cvBlocked
 *     _cvValUnrestricted, _cvValTransit, _cvValQC
 *     _cvTotalQty, _cvTotalValue
 *
 *   The "Material" and "Material Description" fields are NOT mutated here —
 *   rendering helpers use _mappedMaterial / _mappedDesc so the original SAP
 *   code is always recoverable.
 *
 *   mappedDf is a shallow copy of rawDf with the above extra fields; all
 *   downstream render functions call getReconciledBase() which returns mappedDf
 *   when a mapping is active.
 *
 *   Also computes mappingStats { mapped, total, valuePct }.
 *
 *   PHARMA BEST PRACTICE: batches with different expiry dates are NEVER merged.
 *   The row-level conversion only rescales quantities; aggregation at a higher
 *   level groups by _mappedMaterial (and expiry for watchlist purposes).
 */
function applyMaterialMapping() {
  if (!rawDf.length) return;

  let mappedCount = 0;
  let totalValue  = 0;
  let mappedValue = 0;

  mappedDf = rawDf.map(row => {
    const srcCode = String(row["Material"] || "").trim().toUpperCase();
    const entry   = mappingTable.get(srcCode);
    totalValue += row["Total Value"] || 0;

    if (!entry) {
      // No mapping → keep original, factor = 1
      return {
        ...row,
        _mappedMaterial: row["Material"],
        _mappedDesc:     row["Material Description"],
        _mappingFactor:  1.0,
        _isMapped:       false,
        _origMaterial:   row["Material"],
        _origDesc:       row["Material Description"],
        // Converted = original (factor 1)
        _cvUnrestricted:    row["Unrestricted Stock"],
        _cvTransit:         row["Stock in Transit"],
        _cvQC:              row["Stock in Quality Inspection"],
        _cvBlocked:         row["Blocked Stock"],
        _cvValUnrestricted: row["Value of Unrestricted Stock"],
        _cvValTransit:      row["Value of Stock in Transit"],
        _cvValQC:           row["Value of Stock in Quality Inspection"],
        _cvTotalQty:        row["Total Qty"],
        _cvTotalValue:      row["Total Value"],
      };
    }

    // Mapping found — apply conversion factor
    const f = entry.factor;
    const cvUnrestricted    = parseFloat(((row["Unrestricted Stock"]              || 0) * f).toFixed(9));
    const cvTransit         = parseFloat(((row["Stock in Transit"]                || 0) * f).toFixed(9));
    const cvQC              = parseFloat(((row["Stock in Quality Inspection"]     || 0) * f).toFixed(9));
    const cvBlocked         = parseFloat(((row["Blocked Stock"]                   || 0) * f).toFixed(9));
    const cvValUnrestricted = parseFloat(((row["Value of Unrestricted Stock"]     || 0) * f).toFixed(9));
    const cvValTransit      = parseFloat(((row["Value of Stock in Transit"]       || 0) * f).toFixed(9));
    const cvValQC           = parseFloat(((row["Value of Stock in Quality Inspection"] || 0) * f).toFixed(9));
    const cvTotalQty        = cvUnrestricted + cvTransit + cvQC;
    const cvTotalValue      = cvValUnrestricted + cvValTransit + cvValQC;

    mappedCount++;
    mappedValue += cvTotalValue;

    return {
      ...row,
      // Keep original SAP fields intact — render functions read _mapped* for display
      _mappedMaterial: entry.targetCode,
      _mappedDesc:     entry.targetDesc || row["Material Description"],
      _mappingFactor:  f,
      _isMapped:       true,
      _origMaterial:   row["Material"],
      _origDesc:       row["Material Description"],
      _cvUnrestricted:    cvUnrestricted,
      _cvTransit:         cvTransit,
      _cvQC:              cvQC,
      _cvBlocked:         cvBlocked,
      _cvValUnrestricted: cvValUnrestricted,
      _cvValTransit:      cvValTransit,
      _cvValQC:           cvValQC,
      _cvTotalQty:        cvTotalQty,
      _cvTotalValue:      cvTotalValue,
    };
  });

  // BUGFIX-DESC-CONSISTENCY: when multiple distinct raw SAP codes map to the
  // same canonical target code, each row's _mappedDesc was previously set
  // independently from ITS OWN mapping entry's targetDesc (falling back to
  // that row's own raw "Material Description" if targetDesc was blank). If
  // only some of a target's mapping entries had targetDesc filled in, rows
  // for the same canonical material ended up showing different descriptions
  // depending on which row happened to be first in whatever filtered/sorted
  // view was rendering (Branch Comparison, matPlantMap, etc) — e.g. one
  // formulation's raw description "winning" over another's for a merged
  // item. Resolve ONE canonical description per target code up front (first
  // non-empty targetDesc found across all mapping entries sharing that
  // target; falls back to the first raw description seen for that target if
  // no entry defines one) and stamp it uniformly on every row.
  const canonicalDescByTarget = new Map();
  mappingTable.forEach(entry => {
    if (entry.targetDesc && !canonicalDescByTarget.has(entry.targetCode)) {
      canonicalDescByTarget.set(entry.targetCode, entry.targetDesc);
    }
  });
  mappedDf.forEach(row => {
    if (!row._isMapped) return;
    if (!canonicalDescByTarget.has(row._mappedMaterial)) {
      canonicalDescByTarget.set(row._mappedMaterial, row._mappedDesc);
    }
    row._mappedDesc = canonicalDescByTarget.get(row._mappedMaterial);
  });

  // Compute stats
  const valuePct = totalValue > 0 ? Math.round((mappedValue / totalValue) * 100) : 0;
  mappingStats = { mapped: mappedCount, total: rawDf.length, valuePct };

  // Refresh sidebar status to show stats
  const statusEl = document.getElementById("mappingFileStatus");
  if (statusEl && statusEl.style.display !== "none") {
    const existing = statusEl.innerHTML;
    // Only update the stats line; don't re-write if mid-load
    const statsDiv = statusEl.querySelector(".status-stats:last-child");
    if (statsDiv) statsDiv.textContent = `${mappedCount.toLocaleString()} materials mapped · ${valuePct}% of stock value`;
  }
}

/**
 * renderMappingBanner(containerId)
 *   Injects a purple info banner into the given element showing mapping status.
 *   No-ops if no mapping is active.
 */
function renderMappingBanner(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!mappingTable.size || !mappingStats) { el.innerHTML = ""; return; }
  const { mapped, total, valuePct } = mappingStats;
  el.innerHTML = `
    <div class="mapping-active-banner">
      ⚗️ Material Standardization Active —
      <b>${mapped.toLocaleString()} materials mapped</b> ·
      <b>${valuePct}%</b> of total stock value standardized ·
      <span style="font-size:0.7rem;color:var(--muted)">${mappingTable.size.toLocaleString()} mapping rules loaded</span>
    </div>`;
}

// Aliases — full implementations are renderMappedMatCode_early / renderMappedMatDesc_early above.
const renderMappedMatCode = renderMappedMatCode_early;
const renderMappedMatDesc = renderMappedMatDesc_early;

/**
 * getMappedQty(row, field)
 * getMappedVal(row, field)
 *   Return the standardized (converted) value for a quantity/value column.
 *   When mapping is not active or row is not mapped, return the raw SAP value.
 *   This is the single point of truth used by all aggregate functions.
 */
function getMappedQty(row, field) {
  if (!row._isMapped) return row[field] || 0;
  const cv = { "Unrestricted Stock": "_cvUnrestricted", "Stock in Transit": "_cvTransit", "Stock in Quality Inspection": "_cvQC", "Blocked Stock": "_cvBlocked" };
  return (cv[field] !== undefined ? row[cv[field]] : row[field]) || 0;
}
function getMappedVal(row, field) {
  if (!row._isMapped) return row[field] || 0;
  const cv = { "Value of Unrestricted Stock": "_cvValUnrestricted", "Value of Stock in Transit": "_cvValTransit", "Value of Stock in Quality Inspection": "_cvValQC" };
  return (cv[field] !== undefined ? row[cv[field]] : row[field]) || 0;
}

/**
 * getTrueTransitQty(row, field)
 * getTrueTransitVal(row, field)
 *   Return transit qty/value MINUS any phantom (ghost) portion.
 *   A transit row is "phantom" when it has Stock in Transit > 0 but no
 *   Ghost amounts (rows not matched by the uploaded verification file)
 *   are subtracted from every
 *   aggregate shown to the user across all pages.
 */
function getTrueTransitQty(row) {
  const raw     = getMappedQty(row, "Stock in Transit");
  const phantom = row._phantomTransitQty || 0;
  return Math.max(0, raw - phantom);
}
function getTrueTransitVal(row) {
  const raw     = getMappedVal(row, "Value of Stock in Transit");
  const phantom = row._phantomTransitVal || 0;
  return Math.max(0, raw - phantom);
}
/**
 * Returns true if the row has transit stock beyond the ghost portion.
 */
function _hasTrueTransit(row) {
  // Row is true if its ghost qty is LESS than total transit qty
  const total = getMappedQty(row, "Stock in Transit");
  const ghost = row._phantomTransitQty || 0;
  return total > ghost;
}

/**
 * aggregateByMappedMaterial(df)
 *   Like aggregateByMaterial but groups by _mappedMaterial (or Material when
 *   no mapping active), uses converted quantities, and preserves original code
 *   traceability via _origMaterial.
 */
function aggregateByMappedMaterial(df) {
  const useMapped = mappingTable.size > 0;
  const QTY_FIELDS = ["Unrestricted Stock","Stock in Quality Inspection","Blocked Stock","Stock in Transit"];
  const VAL_FIELDS = ["Value of Unrestricted Stock","Value of Stock in Quality Inspection","Value of Stock in Transit"];

  const matMap = {};
  df.forEach(row => {
    const mat = useMapped ? (row._mappedMaterial || row["Material"]) : row["Material"];
    if (!mat) return;
    if (!matMap[mat]) {
      matMap[mat] = {
        ...row,
        "Material":             mat,
        "Material Description": useMapped ? (row._mappedDesc || row["Material Description"]) : row["Material Description"],
        _mappedMaterial:        mat,
        _allPlants:             [],
        _allStorageLocs:        [],
        _origCodes:             new Set(),
      };
      // FIX-AGG-FIRST-ROW: zero all fields first then add the first row's
      // converted values via the same getMappedQty/getMappedVal path used for
      // subsequent rows.  Previously the first row's raw values (spread above)
      // were kept but subsequent rows were accumulated with the converted values,
      // causing a mismatch when a mapping factor != 1 was active.
      QTY_FIELDS.forEach(c => { matMap[mat][c] = getMappedQty(row, c); });
      VAL_FIELDS.forEach(c => { matMap[mat][c] = getMappedVal(row, c); });
      if (row["Plant Name"]) matMap[mat]._allPlants.push(row["Plant Name"]);
      if (row["Description of Storage Location"] || row["Storage Location"]) {
        matMap[mat]._allStorageLocs.push(row["Description of Storage Location"] || row["Storage Location"]);
      }
      if (row._origMaterial)  matMap[mat]._origCodes.add(row._origMaterial);
    } else {
      const target = matMap[mat];
      QTY_FIELDS.forEach(c => { target[c] += getMappedQty(row, c); });
      VAL_FIELDS.forEach(c => { target[c] += getMappedVal(row, c); });
      // Keep earliest expiry across all batches (pharma best practice)
      const te = target["_expiry"], se = row["_expiry"];
      if (se instanceof Date && !isNaN(se)) {
        if (!(te instanceof Date) || isNaN(te) || se < te) target["_expiry"] = se;
      }
      if (row["Plant Name"] && !target._allPlants.includes(row["Plant Name"])) {
        target._allPlants.push(row["Plant Name"]);
      }
      const sloc = row["Description of Storage Location"] || row["Storage Location"];
      if (sloc && !target._allStorageLocs.includes(sloc)) {
        target._allStorageLocs.push(sloc);
      }
      if (row._origMaterial)  target._origCodes.add(row._origMaterial);
      if (!target["Material Group Name"] && row["Material Group Name"]) target["Material Group Name"] = row["Material Group Name"];
    }
  });

  Object.values(matMap).forEach(row => {
    row["Total Qty"]   = (row["Unrestricted Stock"] || 0) + (row["Stock in Transit"] || 0) + (row["Stock in Quality Inspection"] || 0);
    row["Total Value"] = (row["Value of Unrestricted Stock"] || 0) + (row["Value of Stock in Transit"] || 0) + (row["Value of Stock in Quality Inspection"] || 0);
    const plants = (row._allPlants || []).filter(Boolean).sort();
    row["_plantList"]  = plants.length ? plants.join(", ") : (row["Plant Name"] || "—");
    const storageLocs = (row._allStorageLocs || []).filter(Boolean).sort();
    row["_storageLocList"] = storageLocs.length ? storageLocs.join(", ") : (row["Description of Storage Location"] || row["Storage Location"] || "—");
    // Build traceability string for detail tables
    const origCodes    = [...(row._origCodes || [])].filter(c => c !== row["Material"]);
    row._traceCodes    = origCodes.length ? origCodes.join(", ") : "";
  });

  return Object.values(matMap);
}

// ─────────────────────────────────────────────────────────────────────────────
// END MATERIAL STANDARDIZATION MAPPING
// ─────────────────────────────────────────────────────────────────────────────

// ─── Lookup helper: Transit info ─────────────────────────────────────────────
// PO details not tracked — returns placeholders.
function getTransitInfo(material, plantCode) {
  return { purDoc: "—", supPlant: "—" };
}

// ─── Phantom Transit Detection ────────────────────────────────────────────
// A transit row is "phantom" (ghost / not confirmed available) when:
//   • The main data has Stock in Transit > 0, AND
//   • The uploaded Stock-in-Transit verification file has NO exact quantity
//     match for this material+plant (including when no file has been
//     uploaded at all yet — everything is ghost until proven otherwise).
//
// Phantom rows are EXCLUDED from all aggregate values (Total Value, Total Qty,
// Value of Stock in Transit, Stock in Transit) on Dashboard, Branch Comparison,
// and Inventory Flow. They are flagged with a warning badge on the Transit page.

function isPhantomTransit(row) {
  // A row is phantom when it isn't backed by an exact match in the uploaded
  // Stock-in-Transit verification file for this material+plant combination.
  const { qty } = getGhostTransit(row);
  return qty > 0 && (row["Stock in Transit"] > 0);
}

// Stamps each rawDf row with _phantomTransitQty / _phantomTransitVal using
// the uploaded Stock-in-Transit verification file, then recomputes Total
// Value / Total Qty.
function stampGhostTransit() {
  rawDf.forEach(row => {
    const { qty: uqty, val: uval } = getGhostTransit(row);
    // Clamp to actual transit so we never go negative
    row._phantomTransitQty = Math.min(uqty, row["Stock in Transit"] || 0);
    row._phantomTransitVal = Math.min(uval, row["Value of Stock in Transit"] || 0);
    // Recompute derived totals excluding ghost transit
    row["Total Value"] = row["Value of Unrestricted Stock"]
                       + (row["Value of Stock in Transit"] - row._phantomTransitVal)
                       + row["Value of Stock in Quality Inspection"];
    row["Total Qty"]   = row["Unrestricted Stock"]
                       + (row["Stock in Transit"] - row._phantomTransitQty)
                       + row["Stock in Quality Inspection"];
  });
}
// Alias kept for any remaining internal call sites
function recomputePhantomTransit() { stampGhostTransit(); }

// Returns an object { count, qty, val } for phantom transit rows in a given df slice
function getPhantomSummary(df) {
  const rows = df.filter(r => r._phantomTransitQty > 0);
  return {
    count: rows.length,
    qty:   rows.reduce((s,r) => s + r._phantomTransitQty, 0),
    val:   rows.reduce((s,r) => s + r._phantomTransitVal, 0),
  };
}

// Renders a dismissible alert banner into the element with given id.
// Does nothing (clears el) if there are no phantom rows.
// FIX-PHANTOM-VISIBLE: the alert now includes an expand/collapse button so users
// can view the ghost items directly inline without navigating away.
// A unique alertId is derived from containerId so multiple alerts (dash, branch,
// flow) each have independent expand state.
function renderPhantomAlert(containerId, df) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const { count, qty, val } = getPhantomSummary(df);
  if (!count) {
    el.innerHTML = "";
    return;
  }

  // Collect the actual phantom rows from this df slice for the inline table
  const phantomRows = df.filter(r => r._phantomTransitQty > 0);
  const tableId = containerId + "-inline-tbl";

  const phantomCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name", label:"Material Group"},
    {key:"Plant Name",          label:"Plant"},
    {key:"_phantomTransitQty",  label:"Ghost Qty",        fmt:fmtQty, rawKey:"_phantomTransitQty", cellClass:"col-qty"},
    {key:"_phantomTransitVal",  label:"Ghost Value (ETB)", fmt:fmtETB, rawKey:"_phantomTransitVal", cellClass:"col-val"},
  ];

  const isTransitPage = (containerId === "transit-phantom-alert");
  // On transit page, the full phantom section is rendered separately via
  // renderPhantomTable — so the alert only needs a short "jump to section" link.
  const actionHtml = isTransitPage
    ? `<a class="phantom-alert-link" style="white-space:nowrap" onclick="document.querySelector('.transit-tab-btn[data-tab=ghost]').click()">View ghost items →</a>`
    : `<button class="phantom-alert-toggle" id="${tableId}-btn" onclick="(function(){
        var tbl=document.getElementById('${tableId}');
        var btn=document.getElementById('${tableId}-btn');
        var open=tbl.style.display!=='none';
        tbl.style.display=open?'none':'block';
        btn.textContent=open?'Show ghost items ▾':'Hide ghost items ▴';
      })()" style="background:none;border:1px solid var(--amber);color:var(--amber);border-radius:4px;padding:3px 10px;font-size:0.72rem;cursor:pointer;white-space:nowrap">Show ghost items ▾</button>
      <a class="phantom-alert-link" style="white-space:nowrap" onclick="navReset('transit')">Transit page →</a>
      <div id="${tableId}" style="display:none;margin-top:0.75rem;max-height:320px;overflow-y:auto">${buildTable(phantomRows, phantomCols, () => "row-amber")}</div>`;

  el.innerHTML = `
    <div class="phantom-transit-alert">
      <span class="phantom-alert-icon">⚠️</span>
      <div class="phantom-alert-body">
        <strong>Ghost Transit Stock Excluded</strong>
        <span>${count.toLocaleString()} item${count!==1?"s":""} (${fmtQty(qty)} units · ${fmtETB(val)}) have <em>Stock in Transit</em> but
        ${transitFileLoaded ? "don't have a matching quantity in the uploaded Stock-in-Transit file" : "no Stock-in-Transit file has been uploaded yet to verify them"}.
        These items are <strong>excluded from all totals</strong> — verify first.</span>
        <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-top:0.35rem">
          ${actionHtml}
        </div>
      </div>
    </div>`;
}

// ─── Phantom Transit Dedicated Section (Transit page only) ────────────────
// Renders the full ghost-items table with KPI summary and download into
// the #transit-phantom-section container on the Transit page.
// Called from renderTransit() whenever phantom rows exist.
function renderPhantomTable(df) {
  const sectionEl = document.getElementById("transit-phantom-section");
  if (!sectionEl) return;

  const phantomRows = df.filter(r => r._phantomTransitQty > 0);
  if (!phantomRows.length) {
    sectionEl.style.display = "none";
    sectionEl.innerHTML = "";
    return;
  }

  const totalPhantomQty = phantomRows.reduce((s,r) => s + r._phantomTransitQty, 0);
  const totalPhantomVal = phantomRows.reduce((s,r) => s + r._phantomTransitVal, 0);
  const uniqMats        = new Set(phantomRows.map(r => r._mappedMaterial || r["Material"])).size;
  const uniqPlants      = new Set(phantomRows.map(r => r["Plant Name"])).size;

  const phantomCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",  label:"Material Group"},
    {key:"Plant",                label:"Plant Code"},
    {key:"Plant Name",           label:"Plant Name"},
    {key:"Storage Location",     label:"Storage Location"},
    {key:"_phantomTransitQty",   label:"Ghost Qty",         fmt:fmtQty, rawKey:"_phantomTransitQty", cellClass:"col-qty"},
    {key:"_phantomTransitVal",   label:"Ghost Value (ETB)",  fmt:fmtETB, rawKey:"_phantomTransitVal", cellClass:"col-val"},
  ];

  // Sort by value descending so highest-risk items are at the top
  const sorted = sortBy(phantomRows, "_phantomTransitVal");

  const dlId = "btn-dl-phantom-transit";
  sectionEl.style.display = "block";
  sectionEl.innerHTML = `
    <div class="phantom-transit-section-wrap" style="
      border:1px solid #d29922;border-radius:8px;padding:1rem 1.2rem;
      background:rgba(210,153,34,0.06);margin-bottom:1.5rem">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.8rem">
        <div>
          <div class="section-header" style="margin:0;color:#d29922">⚠️ Ghost Transit Items</div>
          <div style="font-size:0.76rem;color:var(--muted);margin-top:3px">
            ${transitFileLoaded
              ? `These items appear in the SAP <em>Stock in Transit</em> column but their quantity <strong>does not exactly match</strong> the uploaded Stock-in-Transit file (or the material+plant wasn't found in it). They are <strong>excluded from all inventory totals</strong> until true.`
              : `No Stock-in-Transit verification file has been uploaded yet, so <strong>every</strong> item with <em>Stock in Transit</em> is treated as ghost and excluded from all inventory totals. Upload the file above to verify matching items.`}
          </div>
        </div>
        <button class="dl-btn" id="${dlId}">⬇ Download CSV</button>
      </div>
      <div class="kpi-row" style="margin-bottom:0.9rem">
        ${[
          ["Ghost Items",    sorted.length.toLocaleString(),    "Rows without a true match",  "amber"],
          ["Unique Materials",    uniqMats.toLocaleString(),          "Distinct SKUs",                  "amber"],
          ["Affected Plants",     uniqPlants.toLocaleString(),        "Locations with ghost stock","amber"],
          ["Ghost Qty",      fmtQty(totalPhantomQty),           "Units not confirmed",            "amber"],
          ["Ghost Value",    fmtETB(totalPhantomVal),           "Excluded from totals",           "amber"],
        ].map(([l,v,s]) => `
          <div class="kpi-card amber">
            <div class="kpi-label">${escHtml(l)}</div>
            <div class="kpi-value">${escHtml(v)}</div>
            <div class="kpi-sub">${escHtml(s)}</div>
          </div>`).join("")}
      </div>
      <div id="phantom-transit-table-wrap">${buildTable(sorted, phantomCols, () => "row-amber")}</div>
    </div>`;

  document.getElementById(dlId).onclick = () => downloadCSV(sorted, phantomCols, "ghost_transit_items.csv");
}


// ═══════════════════════════════════════════════════════════════════════════
// TRANSIT
// ═══════════════════════════════════════════════════════════════════════════

// Holds the full transit rows (pre-built) so the search filter can re-slice them.
let _transitRowsCache = [];
let _transitColsCache = [];
// _ho01RowsCache removed — was declared but never populated or read (dead code)

function renderTransit() {
  // UPLOAD GATE: block the page behind an upload prompt until a
  // Stock-in-Transit verification file has been uploaded this session.
  const gateEl = document.getElementById("transit-upload-gate");
  const bodyEl = document.getElementById("transit-page-body");
  if (!transitFileLoaded) {
    if (gateEl) gateEl.style.display = "block";
    if (bodyEl) bodyEl.style.display = "none";
    return;
  }
  if (gateEl) gateEl.style.display = "none";
  if (bodyEl) bodyEl.style.display = "block";

  // rawDf is pre-filtered at parse time — no need to re-apply isNonMedical* guards here.
  // Simply restrict to rows with positive transit qty and value.
  // FIX-PHANTOM-HIDE: phantom transit rows (ghost against the uploaded file)
  // are excluded from the main table entirely; they only appear in the
  // ghost-items section.
  const df = applyPageFilter("transit").filter(r =>
    r["Stock in Transit"] > 0 &&
    r["Value of Stock in Transit"] > 0 &&
    !(r._phantomTransitQty > 0)   // exclude phantom rows from this table
  );

  const totalTV = df.reduce((s,r) => s + getMappedVal(r,"Value of Stock in Transit"), 0);
  const uniqMat = new Set(df.map(r => r._mappedMaterial||r["Material"])).size;

  // FIX-PHANTOM-VISIBLE: render the alert banner AND the dedicated ghost-items
  // table section on the Transit page so users can see and download phantom items.
  const allTransitDf = applyPageFilter("transit").filter(r => r["Stock in Transit"] > 0 && r["Value of Stock in Transit"] > 0);
  renderPhantomAlert("transit-phantom-alert", allTransitDf);
  renderPhantomTable(allTransitDf);

  // FIX-MAPPED-COUNT: count unique target materials for phantom KPI
  const phantomRows  = allTransitDf.filter(r => r._phantomTransitQty > 0);
  const phantomCount = new Set(phantomRows.map(r => r._mappedMaterial || r["Material"])).size;
  const phantomKpiExtra = phantomCount > 0
    ? [[`Ghost Transit Items`, String(phantomCount), "Excluded from all totals — see bottom of page ↓", "amber"]]
    : [];

  setKpis("transit-kpis", [
    ["Total Transit Value",        fmtETB(totalTV), "True items only",  "amber"],
    ["Unique Materials in Transit",String(uniqMat), "Distinct SKUs",        "green"],
    ...phantomKpiExtra,
  ]);

  const transitCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",       label:"Material Group"},
    {key:"Plant Name",                label:"Plant"},
    {key:"_supplyingPlant",           label:"Supplying Plant", raw:true, fmt:v=>v || "—"},
    {key:"Stock in Transit",          label:"Transit Qty",       fmt:fmtQty, rawKey:"Stock in Transit",          cellClass:"col-qty"},
    {key:"Value of Stock in Transit", label:"Transit Value (ETB)",fmt:fmtETB, rawKey:"Value of Stock in Transit", cellClass:"col-val"},
    {key:"_status",                   label:"Status", raw:true},
  ];
  const transitRows = sortBy([...df], "Value of Stock in Transit").map(r => ({
    ...r,
    _supplyingPlant: getSupplyingPlant(r),
    _status: r["Value of Stock in Transit"] > 100000 ? "<span class='badge badge-red'>Critical</span>"
      : r["Value of Stock in Transit"] > 50000  ? "<span class='badge badge-amber'>High</span>"
      : r["Value of Stock in Transit"] > 10000  ? "<span class='badge badge-amber'>Medium</span>"
      : "<span class='badge badge-green'>Low</span>",
  }));

  // Cache rows for search filtering
  _transitRowsCache = transitRows;
  _transitColsCache = transitCols;

  // Wire chart
  if (df.length) {
    // FIX-TRANSIT-EXPORT-MISMATCH: was groupBy(df, "Plant Name", [["val","Value of
    // Stock in Transit"]]) — raw unmapped sum, while the drilldown export (below,
    // via buildDrillRows -> getMappedVal) is mapped. Same class of bug as the
    // Dashboard near-expiry chart. Aggregating with getMappedVal here keeps the
    // bar and its exported CSV/Excel in agreement.
    const plantAggMap = {};
    df.forEach(r => {
      const k = r["Plant Name"] || "(Blank)";
      if (!plantAggMap[k]) plantAggMap[k] = { "Plant Name": k, val: 0 };
      plantAggMap[k].val += getMappedVal(r, "Value of Stock in Transit");
    });
    const plantAgg = sortBy(Object.values(plantAggMap), "val");
    const uniqByPlant = countUniqueMaterialsByGroup(df, "Plant Name");
    plantAgg.forEach(r => { r.uniqMat = uniqByPlant[r["Plant Name"]] || 0; });
    Plotly.newPlot("chart-transit-plant", [
      {type:"bar",  name:"Value (ETB)", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.val), yaxis:"y",  marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
      {type:"scatter", mode:"lines+markers", name:"Unique Materials", x:plantAgg.map(r=>r["Plant Name"]), y:plantAgg.map(r=>r.uniqMat), yaxis:"y2", marker:{color:"#3fb950",size:8}, line:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>Materials: %{y}<extra></extra>"},
    ], pl({
      height:300,
      margin:{l:60,r:70,t:20,b:100},
      xaxis:{title:{text:"Plant",font:{size:10}}, tickangle:-35, tickfont:{size:10}, automargin:true},
      yaxis:{title:{text:"Value (ETB)",font:{size:10,color:"#d29922"}}, tickfont:{color:"#d29922"}, automargin:true},
      yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#3fb950"},tickformat:",d",title:{text:"Unique Materials",font:{size:10,color:"#3fb950"}}},
    }), PLOTLY_CONFIG);

    document.getElementById("chart-transit-plant").on("plotly_click", function(data) {
      const plantName = data.points[0].x;
      const items = df.filter(r => (r["Plant Name"] || "(Blank)") === plantName);
      const rows  = buildDrillRows(items, "Stock in Transit", "Value of Stock in Transit");
      showChartDrillModal({
        title: `🚚 In Transit — ${plantName}`,
        meta: `${rows.length} items`,
        rows, cols: CHART_DRILL_COLS,
        filenameBase: `transit_${plantName}`,
      });
    });
  } else {
    document.getElementById("chart-transit-plant").innerHTML = "";
  }

  // Show all filtered transit items directly (no search gate)
  document.getElementById("transit-table-wrap").innerHTML = transitRows.length
    ? buildTable(transitRows, transitCols, r => r._phantomTransitQty > 0 ? "row-red" : "", "", {id:"transit-export", title:"Transit Analysis"})
    : `<div class="alert-info">No pharmaceutical transit items found.</div>`;
  if (transitRows.length) wireTableExport("transit-export", _transitRowsCache, transitCols.slice(0,-1), "transit_analysis");
}

// NOTE: Transit material lookup is now handled via the Material filter-bar
// control (see ms-transit-mat) feeding applyPageFilter("transit") — the table
// above already reflects the current filter selection directly.

// ═══════════════════════════════════════════════════════════════════════════
// EXPIRY
// ═══════════════════════════════════════════════════════════════════════════
// ── EXPIRY TIMELINE — SECTION BUILDER ──────────────────────────────────────
// Injects either one combined chart-box (single stock type / Admin-collapsed
// view is intentionally still split — see splitByStockType above) or two
// side-by-side chart-boxes (RDF + Health Program Q) into #expiry-timeline-
// boxes, then delegates the actual Plotly render + drilldown wiring for each
// box to renderExpiryTimelineChart(). Re-run on every renderExpiry() call so
// filter changes (window/plant/material group/etc.) always rebuild fresh —
// this also means any bar clicked before a re-render is safely discarded
// along with its now-stale drilldown DOM.
function renderExpiryTimelineSection(splitByStockType, expiring) {
  const boxesEl = document.getElementById("expiry-timeline-boxes");
  if (!boxesEl) return;

  const chartBoxHtml = (suffix, title) => `
    <div class="chart-box full"${suffix ? ' style="margin-bottom:1rem"' : ""}>
      <div class="section-header" style="display:flex;align-items:center;gap:0.5rem">
        <span>${title}</span>
        <span style="font-size:0.7rem;font-weight:400;color:var(--muted);margin-left:0.25rem">— Click a bar to drill into that month's items</span>
      </div>
      <div id="chart-expiry-timeline${suffix}"></div>
      <div id="expiry-drilldown${suffix}" style="display:none;margin-top:1rem;border-top:1px solid var(--border2);padding-top:1rem">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem">
          <div>
            <span id="expiry-drill-title${suffix}" style="font-weight:700;color:var(--text);font-size:0.95rem"></span>
            <span id="expiry-drill-meta${suffix}" style="font-size:0.78rem;color:var(--muted);margin-left:0.75rem"></span>
          </div>
          <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
            <button id="expiry-drill-dl-csv${suffix}" class="dl-btn" style="font-size:0.72rem;padding:4px 10px">⬇ CSV</button>
            <button id="expiry-drill-dl-xlsx${suffix}" class="dl-btn" style="font-size:0.72rem;padding:4px 10px">⬇ Excel</button>
            <button id="expiry-drill-close${suffix}" class="apply-btn secondary" style="font-size:0.72rem;padding:4px 12px">✕ Close</button>
          </div>
        </div>
        <div id="expiry-drill-table${suffix}"></div>
      </div>
    </div>`;

  if (splitByStockType) {
    boxesEl.innerHTML =
      chartBoxHtml("-rdf", "RDF Expiry Timeline — Items &amp; Value at Risk by Month") +
      chartBoxHtml("-q",   "Health Program (Q) Expiry Timeline — Items &amp; Value at Risk by Month");
    const rdfRows = expiring.filter(r => (typeof getRowStockTypeLabel === "function" ? getRowStockTypeLabel(r) : "RDF") !== "Health Program (Q)");
    const qRows   = expiring.filter(r => (typeof getRowStockTypeLabel === "function" ? getRowStockTypeLabel(r) : "RDF") === "Health Program (Q)");
    renderExpiryTimelineChart("-rdf", rdfRows);
    renderExpiryTimelineChart("-q",   qRows);
  } else {
    boxesEl.innerHTML = chartBoxHtml("", "Expiry Timeline — Items &amp; Value at Risk by Month");
    renderExpiryTimelineChart("", expiring);
  }
}

// ── EXPIRY TIMELINE — SINGLE CHART + DRILLDOWN ─────────────────────────────
// suffix is "" for the combined chart, or "-rdf" / "-q" for the split view
// (see renderExpiryTimelineSection above); it's appended to every element id
// so the two split charts never collide. rowsForChart is the (already
// stock-type-filtered, where applicable) set of expiring rows to plot.
function renderExpiryTimelineChart(suffix, rowsForChart) {
  const chartElId = `chart-expiry-timeline${suffix}`;
  const drillId   = `expiry-drilldown${suffix}`;
  const chartEl   = document.getElementById(chartElId);
  if (!chartEl) return;

  if (!rowsForChart.length) {
    chartEl.innerHTML = "";
    const dEl = document.getElementById(drillId);
    if (dEl) dEl.style.display = "none";
    return;
  }

  // valMap: value at risk summed per month (bar). uniqMatSets: distinct
  // materials expiring per month, counted via the same source→target
  // mapping used elsewhere (_mappedMaterial), so it lines up with the KPI
  // cards above rather than counting duplicate source rows.
  const valMap = {}, uniqMatSets = {};
  rowsForChart.forEach(r => {
    const key = `${r._expiry.getFullYear()}-${String(r._expiry.getMonth()+1).padStart(2,"0")}`;
    valMap[key] = (valMap[key] || 0) + (r["Value of Unrestricted Stock"]||0) + (r["Value of Stock in Quality Inspection"]||0);
    if (!uniqMatSets[key]) uniqMatSets[key] = new Set();
    uniqMatSets[key].add(r._mappedMaterial || r["Material"]);
  });
  const ms = Object.keys(valMap).sort();
  const uniqMap = {};
  ms.forEach(m => { uniqMap[m] = uniqMatSets[m].size; });

  Plotly.newPlot(chartElId, [
    {type:"bar",    name:"Value at Risk (ETB)", x:ms, y:ms.map(m=>valMap[m]), yaxis:"y",  marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
    {type:"scatter",mode:"lines+markers",name:"Unique Materials", x:ms, y:ms.map(m=>uniqMap[m]), yaxis:"y2", marker:{color:"#f85149",size:8}, line:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>Materials: %{y}<extra></extra>"},
  ], pl({
    height:280,
    margin:{l:60,r:70,t:20,b:60},
    xaxis:{title:{text:"Expiry Month",font:{size:10}}, tickfont:{size:10}, automargin:true},
    yaxis:{title:{text:"Value at Risk (ETB)",font:{size:10,color:"#d29922"}}, tickfont:{color:"#d29922"}, automargin:true},
    yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#f85149"},tickformat:",d",title:{text:"Unique Materials",font:{size:10,color:"#f85149"}}},
  }), PLOTLY_CONFIG);

  document.getElementById(chartElId).on("plotly_click", function(data) {
    const pt = data.points[0];
    const monthKey = pt.x;
    const [yr, mo] = monthKey.split("-").map(Number);
    const monthItems = rowsForChart.filter(r => r._expiry.getFullYear() === yr && r._expiry.getMonth() + 1 === mo);
    // FIX-QC-EXPIRY: _qty/_val roll Unrestricted + QC together so QC-only
    // rows (Unrestricted Stock = 0) still show their real quantity/value
    // instead of a misleading zero; _availBadge marks which is which.
    const drillCols = [
      {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCodeRaw(val,r), raw:true, cellClass:"col-mat-code-wrap"},
      {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDescRaw(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
      {key:"Material Group Name",         label:"Material Group"},
      {key:"Plant Name",                  label:"Plant"},
      {key:"Description of Storage Location", label:"Storage Location"},
      {key:"_expiryStr",                  label:"Expiry Date"},
      {key:"_availBadge",                 label:"Availability",fmt:v=>v, raw:true},
      {key:"_qty",                        label:"Qty",        fmt:fmtQty, cellClass:"col-qty"},
      {key:"_val",                        label:"Value (ETB)",fmt:fmtETB, cellClass:"col-val"},
      {key:"_daysLeft",                   label:"Days Left"},
    ];
    const drillRows = sortBy(
      monthItems.map(r => ({
        ...r,
        _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : "",
        _daysLeft:  r._expiry ? Math.floor((r._expiry - new Date()) / 86400000) : 9999,
        _qty:       (r["Unrestricted Stock"]||0) + (r["Stock in Quality Inspection"]||0),
        _val:       (r["Value of Unrestricted Stock"]||0) + (r["Value of Stock in Quality Inspection"]||0),
        _availBadge: r._qcOnly
          ? "<span class='badge badge-amber'>In QC</span>"
          : "<span class='badge badge-green'>Available</span>",
      })),
      "_daysLeft", true
    );
    const totalVal   = monthItems.reduce((s,r) => s+(r["Value of Unrestricted Stock"]||0)+(r["Value of Stock in Quality Inspection"]||0), 0);
    const totalQty   = monthItems.reduce((s,r) => s+(r["Unrestricted Stock"]||0)+(r["Stock in Quality Inspection"]||0), 0);
    const monthLabel = new Date(yr, mo-1, 1).toLocaleString("default", {month:"long", year:"numeric"});
    document.getElementById(`expiry-drill-title${suffix}`).textContent = "📅 " + monthLabel;
    document.getElementById(`expiry-drill-meta${suffix}`).textContent  = `${drillRows.length} items · ${fmtQty(totalQty)} units · ${fmtETB(totalVal)}`;
    document.getElementById(`expiry-drill-table${suffix}`).innerHTML   = drillRows.length
      ? buildTable(drillRows, drillCols, r => r._daysLeft <= 30 ? "row-red" : r._daysLeft <= 90 ? "row-amber" : "")
      : '<div class="alert-info">No items for this month.</div>';
    const drillEl = document.getElementById(drillId);
    drillEl.style.display = "block";
    drillEl.scrollIntoView({ behavior:"smooth", block:"nearest" });
    document.getElementById(`expiry-drill-dl-csv${suffix}`).onclick  = () => downloadCSV(drillRows,  drillCols, `expiry${suffix}_${monthKey}.csv`);
    document.getElementById(`expiry-drill-dl-xlsx${suffix}`).onclick = () => downloadExcel(drillRows, drillCols, `expiry${suffix}_${monthKey}.xlsx`);
  });
  document.getElementById(`expiry-drill-close${suffix}`).onclick = () => {
    document.getElementById(drillId).style.display = "none";
  };
}

function renderExpiry() {
  // ── Branch-Comparison material drilldown: auto-select the clicked material ──
  // _expiryDrilldownMatCode is set by goToMaterialExpiry() (see the Branch-
  // Comparison-only click override near the top of this file). We consume it
  // once here and clear it so a later manual visit to Expiry doesn't re-apply
  // a stale filter. pageFilters.expiry.materials is set directly (that's what
  // applyPageFilter/renderExpiryDetailTable actually read); the checkbox UI
  // is then ticked to match, purely so the filter bar reflects reality.
  if (_expiryDrilldownMatCode) {
    const code = _expiryDrilldownMatCode;
    _expiryDrilldownMatCode = null; // consume — one-shot
    pageFilters.expiry.materials = [code];
    const matWrapEl = document.getElementById("ms-expiry-mat");
    const matDdEl   = document.getElementById("ms-expiry-mat-dd");
    if (matWrapEl && matDdEl) {
      if (matWrapEl._clearSelected) matWrapEl._clearSelected();
      const target = code.trim().toUpperCase();
      matDdEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
        const cbCode = cb.value.split(" — ")[0].trim().toUpperCase();
        if (cbCode === target) {
          cb.checked = true;
          cb.dispatchEvent(new Event("change"));
        }
      });
    }
  }

  const baseDf  = applyPageFilter("expiry");
  const months  = parseInt(document.querySelector('input[name="expWin"]:checked')?.value || 6);
  const today   = new Date();
  const cutoff  = new Date(today); cutoff.setMonth(cutoff.getMonth() + months);
  const valid   = baseDf.filter(r => r._expiry instanceof Date && !isNaN(r._expiry));

  // FIX-QC-EXPIRY: broadened from Unrestricted-only so QC-held batches with an
  // expiry date also surface here (previously invisible if all their stock was
  // sitting in QC). Rows carry _qcOnly so the UI can badge them as "In QC" —
  // they aren't available/sellable stock, just visible for planning.
  const expiring     = valid.filter(r => r._expiry >= today && r._expiry <= cutoff &&
    ((r["Unrestricted Stock"]||0) + (r["Stock in Quality Inspection"]||0)) > 0 &&
    ((r["Value of Unrestricted Stock"]||0) + (r["Value of Stock in Quality Inspection"]||0)) > 0
  ).map(r => ({ ...r, _qcOnly: (r["Unrestricted Stock"]||0) <= 0 && (r["Stock in Quality Inspection"]||0) > 0 }));
  const expired      = valid.filter(r => r._expiry < today);
  // FIX BUG-4: filter zero-qty BEFORE the KPI count so KPI matches the table
  const expiredWithStock = expired.filter(r => (r["Unrestricted Stock"] || 0) > 0);
  const expiredZeroQty   = expired.length - expiredWithStock.length;

  // FIX-MAPPED-COUNT: count unique target materials so that multiple source codes
  // mapping to the same target material are counted as one item, not many.
  const getMatKey = r => r._mappedMaterial || r["Material"];
  const expiringUniq      = new Set(expiring.map(getMatKey)).size;
  const expiredStockUniq  = new Set(expiredWithStock.map(getMatKey)).size;

  setKpis("expiry-kpis", [
    ["Expiring in Window", String(expiringUniq),      `Items within next ${months} months`,             "amber"],
    // FIX BUG-4: use expiredWithStock count; FIX-MAPPED-COUNT: unique target materials
    ["Already Expired",   String(expiredStockUniq),  "Items with stock on hand requiring action",      "red"],
    ["At-Risk Value",     fmtETB(expiring.reduce((s,r) => s+getMappedVal(r,"Value of Unrestricted Stock")+getMappedVal(r,"Value of Stock in Quality Inspection"),0)), "Unrestricted + QC stock value","purple"],
    ["At-Risk Quantity",  fmtQty(expiring.reduce((s,r) => s+getMappedQty(r,"Unrestricted Stock")+getMappedQty(r,"Stock in Quality Inspection"),0)),          "Units expiring soon (incl. QC)",     "amber"],
  ]);

  // ── STOCK-TYPE SPLIT (RDF vs Health Program Q) ────────────────────────────
  // A role that has access to BOTH stock types (per stockTypeFilterOptions()
  // in permissions.js — Admin, or a user whose data_scopes include both a
  // "Q_..." and an "R_..." scope) gets two separate timeline charts, one per
  // stock type, instead of one chart that blends both funding streams
  // together. A role scoped to only one stock type keeps the original single
  // combined chart, unchanged.
  const expiryStockTypes  = (typeof stockTypeFilterOptions === "function")
    ? stockTypeFilterOptions(valid)
    : ["Q", "RDF"];
  const splitByStockType  = expiryStockTypes.includes("Q") && expiryStockTypes.includes("RDF");
  renderExpiryTimelineSection(splitByStockType, expiring);

  // Detailed batch/location table — driven by the Material filter in the
  // filter bar (replaces the old free-text Material Lookup search box).
  renderExpiryDetailTable(baseDf, today);

  if (expiredWithStock.length) {
    document.getElementById("expired-section").style.display = "block";
    const zeroNote = expiredZeroQty
      ? ` <span style="font-size:0.72rem;color:var(--muted);font-weight:400">(${expiredZeroQty} zero-qty records hidden)</span>`
      : "";
    document.getElementById("expired-header").innerHTML = `🔴 Already Expired Items (${expiredWithStock.length})${zeroNote}`;
    const expiredRows = expiredWithStock.map(r => ({...r, _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : ""}));
    const expiredCols = [
      {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCodeRaw(val,r), raw:true, cellClass:"col-mat-code-wrap"},
      {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDescRaw(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
      {key:"Material Group Name",            label:"Material Group"},
      {key:"Plant Name",                     label:"Plant"},
      {key:"Description of Storage Location",label:"Storage Location"},
      {key:"_expiryStr",                     label:"Expiry Date"},
      {key:"Unrestricted Stock",             label:"Qty", fmt:fmtQty, rawKey:"Unrestricted Stock", cellClass:"col-qty"},
    ];
    document.getElementById("expired-table-wrap").innerHTML = buildTable(expiredRows, expiredCols);
    document.getElementById("btn-dl-expired-csv").onclick  = () => downloadCSV(expiredRows,   expiredCols, "expired_items.csv");
    document.getElementById("btn-dl-expired-xlsx").onclick = () => downloadExcel(expiredRows, expiredCols, "expired_items.xlsx");
  } else {
    document.getElementById("expired-section").style.display = "none";
  }
}

// ── MATERIAL-FILTERED EXPIRY DETAIL TABLE ─────────────────────────────────
// Replaces the old free-text "Material Lookup" search box. The Material
// filter in the filter bar narrows baseDf via applyPageFilter("expiry");
// this renders the resulting batch/location-level detail. Left blank with a
// prompt when no material is selected, so the page doesn't dump every batch
// row by default.
function renderExpiryDetailTable(baseDf, today) {
  const wrap = document.getElementById("expiry-table-wrap");
  const selectedMaterials = pageFilters.expiry.materials || [];

  if (!selectedMaterials.length) {
    wrap.innerHTML = `<div class="alert-info">🔍 Select one or more materials in the filter bar above to view detailed batch/location-level expiry data.</div>`;
    return;
  }

  // FIX-QC-EXPIRY: broadened from Unrestricted-only so QC-held batches with an
  // expiry date also surface here (mirrors the same fix on the "expiring"
  // watch-list filter above). _qcOnly flags rows with zero Unrestricted stock
  // so the UI can badge them as "In QC" rather than showing them as available.
  const matches = baseDf.filter(r =>
    ((r["Unrestricted Stock"]||0) + (r["Stock in Quality Inspection"]||0)) > 0 &&
    ((r["Value of Unrestricted Stock"]||0) + (r["Value of Stock in Quality Inspection"]||0)) > 0
  );
  if (!matches.length) {
    wrap.innerHTML = `<div class="alert-info">No batch/location records found for the selected material(s).</div>`;
    return;
  }

  const annotated = matches.map(r => {
    const expiryStr = r._expiry ? fmtLocalDate(r._expiry) : "—";
    let daysLeft = null, statusLabel = "No Expiry Date", statusClass = "";
    if (r._expiry instanceof Date && !isNaN(r._expiry)) {
      daysLeft = Math.floor((r._expiry - today) / 86400000);
      if      (daysLeft < 0)   { statusLabel = `Expired ${Math.abs(daysLeft)}d ago`; statusClass = "row-red";   }
      else if (daysLeft <= 30)  { statusLabel = `${daysLeft}d left`;                  statusClass = "row-red";   }
      else if (daysLeft <= 180) { statusLabel = `${daysLeft}d left`;                  statusClass = "row-amber"; }
      else                      { statusLabel = `${daysLeft}d left`;                  statusClass = "";          }
    }
    const qcOnly = (r["Unrestricted Stock"]||0) <= 0 && (r["Stock in Quality Inspection"]||0) > 0;
    return {
      ...r,
      _expiryStr: expiryStr, _daysLeft: daysLeft ?? 99999, _statusLabel: statusLabel, _statusClass: statusClass,
      _qcOnly: qcOnly,
      _qty: (r["Unrestricted Stock"]||0) + (r["Stock in Quality Inspection"]||0),
      _val: (r["Value of Unrestricted Stock"]||0) + (r["Value of Stock in Quality Inspection"]||0),
      _availBadge: qcOnly
        ? "<span class='badge badge-amber'>In QC</span>"
        : "<span class='badge badge-green'>Available</span>",
    };
  });

  const sorted     = annotated.sort((a,b) => a._daysLeft - b._daysLeft);
  const uniqueMats = [...new Set(sorted.map(r => r["Material"]))];
  const summary    = `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.5rem">
    Showing <b style="color:var(--text)">${sorted.length}</b> batch/location record(s) across
    <b style="color:var(--text)">${uniqueMats.length}</b> material code(s)
  </div>`;

  const cols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMatCodeRaw(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMatDescRaw(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Plant Name",                     label:"Plant"},
    {key:"Description of Storage Location",label:"Storage Location"},
    {key:"Batch",                          label:"Batch"},
    {key:"_expiryStr",                     label:"Expiry Date"},
    {key:"_statusLabel",                   label:"Status"},
    {key:"_availBadge",                    label:"Availability", fmt:v=>v, raw:true},
    {key:"_qty",                           label:"Qty",   fmt:fmtQty, cellClass:"col-qty"},
    {key:"_val",                           label:"Value (ETB)", fmt:fmtETB, cellClass:"col-val"},
  ];

  wrap.innerHTML = summary + buildTable(sorted, cols, r => r._statusClass, "", {id:"expiry-export", title:"Expiry Detail"});
  wireTableExport("expiry-export", sorted, cols, "expiry_detail");
}

// NOTE: QC and Flow material lookup are now handled via the Material
// filter-bar control (ms-qc-mat / ms-flow-mat) feeding applyPageFilter() —
// renderQC() below already reflects the current selection.


function renderQC() {
  // FIX BUG-6: removed "&& r["Value of Stock in Quality Inspection"] > 0"
  // SAP sometimes records QC qty > 0 with zero ETB value (non-valuated batches,
  // consignment stock) — these must still appear for physical count audits.
  // RECONCILIATION: aggregate all source codes into their target canonical code
  // so each material appears exactly once (e.g. three ASA variants → one total).
  const rawFiltered = applyPageFilter("qc").filter(r => r["Stock in Quality Inspection"] > 0);
  const df          = aggregateByMappedMaterial(rawFiltered).filter(r => r["Stock in Quality Inspection"] > 0);

  const totalQCVal = df.reduce((s,r) => s + r["Value of Stock in Quality Inspection"], 0);
  setKpis("qc-kpis", [
    ["Total Value in QC", fmtETB(totalQCVal), "Across all plants",      "red"],
    ["Unique Materials",  String(new Set(df.map(r=>r["Material"])).size),"Distinct SKUs","blue"],
  ]);

  if (!df.length) { document.getElementById("qc-table-wrap").innerHTML = `<div class="alert-info">✓ No items in quality inspection.</div>`; return; }

  // FIX-QC-EXPORT-MISMATCH: was groupBy(rawFiltered, "Plant Name", [["val","Value of
  // Stock in Quality Inspection"]]) — raw unmapped sum. This disagreed with BOTH the
  // KPI cards above (which sum df, already mapped via aggregateByMappedMaterial) and
  // the drilldown export (buildDrillRows -> getMappedVal). Aggregating with
  // getMappedVal here brings all three into agreement.
  // FEAT-BRANCH-AXIS: branch-locked roles only have one Plant, so this chart
  // used to render as one full-width bar for them. Group by Stock Type
  // (Q / RDF) instead for those roles; HO01/Admin keep the Plant axis. See
  // shouldUseStockTypeAxis() in permissions.js.
  const qcUseStockTypeAxis = typeof shouldUseStockTypeAxis === "function" && shouldUseStockTypeAxis();
  const plantQCMap = {};
  rawFiltered.forEach(r => {
    const k = qcUseStockTypeAxis ? getRowStockTypeLabel(r) : (r["Plant Name"] || "(Blank)");
    if (!plantQCMap[k]) plantQCMap[k] = { "Plant Name": k, val: 0 };
    plantQCMap[k].val += getMappedVal(r, "Value of Stock in Quality Inspection");
  });
  const plantQC = sortBy(Object.values(plantQCMap), "val");
  const uniqByPlantQC = countUniqueMaterialsByGroup(rawFiltered, qcUseStockTypeAxis ? null : "Plant Name", qcUseStockTypeAxis ? getRowStockTypeLabel : null);
  plantQC.forEach(r => { r.uniqMat = uniqByPlantQC[r["Plant Name"]] || 0; });
  Plotly.newPlot("chart-qc-plant", [
    {type:"bar",     name:"Value (ETB)", x:plantQC.map(r=>r["Plant Name"]), y:plantQC.map(r=>r.val), yaxis:"y",  marker:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>"},
    {type:"scatter", mode:"lines+markers", name:"Unique Materials", x:plantQC.map(r=>r["Plant Name"]), y:plantQC.map(r=>r.uniqMat), yaxis:"y2", marker:{color:"#3fb950",size:8}, line:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>Materials: %{y}<extra></extra>"},
  ], pl({
    height:300,
    margin:{l:60,r:70,t:20,b:100},
    xaxis:{title:{text: qcUseStockTypeAxis ? "Stock Type" : "Plant", font:{size:10}}, tickangle:-35, tickfont:{size:10}, automargin:true},
    yaxis:{title:{text:"Value (ETB)",font:{size:10,color:"#f85149"}}, tickfont:{color:"#f85149"}, automargin:true},
    yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{color:"#3fb950"},tickformat:",d",title:{text:"Unique Materials",font:{size:10,color:"#3fb950"}}},
  }), PLOTLY_CONFIG);

  document.getElementById("chart-qc-plant").on("plotly_click", function(data) {
    const groupLabel = data.points[0].x;
    const items = qcUseStockTypeAxis
      ? rawFiltered.filter(r => getRowStockTypeLabel(r) === groupLabel)
      : rawFiltered.filter(r => (r["Plant Name"] || "(Blank)") === groupLabel);
    const rows  = buildDrillRows(items, "Stock in Quality Inspection", "Value of Stock in Quality Inspection");
    showChartDrillModal({
      title: `🧪 In QC — ${groupLabel}`,
      meta: `${rows.length} items`,
      rows, cols: CHART_DRILL_COLS,
      filenameBase: `qc_${groupLabel}`,
    });
  });

  const qcCols = [
    {key:"Material", label:"Material Code", fmt:(val,r)=>renderMappedMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
    {key:"Material Description", label:"Material Description", fmt:(val,r)=>renderMappedMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
    {key:"Material Group Name",                  label:"Material Group"},
    {key:"_plantList",                           label:"Plant(s)"},
    {key:"_storageLocList",                      label:"Storage Location"},
    {key:"_expiryStr",                           label:"Shelf Life Expiry"},
    {key:"Stock in Quality Inspection",          label:"QC Qty",        fmt:fmtQty, rawKey:"Stock in Quality Inspection", cellClass:"col-qty"},
    {key:"Value of Stock in Quality Inspection", label:"QC Value (ETB)",fmt:fmtETB, rawKey:"Value of Stock in Quality Inspection", cellClass:"col-val"},
  ];

  const qcRows = sortBy(
    [...df].map(r => ({
      ...r,
      _expiryStr: r._expiry ? fmtLocalDate(r._expiry) : "",
    })),
    "Value of Stock in Quality Inspection"
  );
  document.getElementById("qc-table-wrap").innerHTML = buildTable(qcRows, qcCols, r => r["Value of Stock in Quality Inspection"] > 10000 ? "row-red" : "", "", {id:"qc-export", title:"Quality Inspection"});
  wireTableExport("qc-export", qcRows, qcCols, "qc_inspection");

}

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH COMPARISON
// ═══════════════════════════════════════════════════════════════════════════
function renderBranch() {
  // BUG-BRANCH-1 FIX: Use baseDf (pre-aggregation, one row per plant per material)
  // for branch totals and matPlantMap. aggregateByMaterial collapses all plants into
  // a single row per material so it CANNOT be used for per-branch breakdowns.
  // aggregateByMaterial is still used for the material tab (Tab 2) display only.
  const baseDf = applyPageFilter("branch");


  const plants = [...new Set(baseDf.map(r => String(r["Plant"]).toUpperCase()))];
  // BUG-FIX-6: centralCode was computed but never read anywhere — removed dead variable.
  // All downstream logic uses centralName (the display name).
  let centralName;
  if (plants.includes("HO01")) {
    centralName = baseDf.find(r => String(r["Plant"]).toUpperCase() === "HO01")?.["Plant Name"] || "HO01";
    document.getElementById("branch-central-info").style.display = "none";
  } else {
    const totals = {};
    baseDf.forEach(r => { const p = r["Plant Name"]; totals[p] = (totals[p] || 0) + r["Total Value"]; });
    centralName = Object.entries(totals).sort((a,b) => b[1]-a[1])[0]?.[0] || "";
    document.getElementById("branch-central-info").style.display = "block";
    document.getElementById("branch-central-info").innerHTML = `ℹ️ HO01 not found — using <b>${escHtml(centralName)}</b> as central branch (highest inventory value).`;
  }

  const aggMap = {};
  const aggMatSets = {}; // separate Sets to count unique materials without mutating aggMap
  baseDf.forEach(r => {
    const k = r["Plant Name"];
    if (!aggMap[k]) { aggMap[k] = {PlantName:k,Plant:r["Plant"],TotalValue:0,Unrestricted:0,Transit:0,QC:0,UnrestrictedQty:0,TransitQty:0,QCQty:0,Items:0}; aggMatSets[k] = new Set(); }
    aggMap[k].TotalValue      += getMappedVal(r,"Value of Unrestricted Stock") + getMappedVal(r,"Value of Stock in Transit") + getMappedVal(r,"Value of Stock in Quality Inspection");
    aggMap[k].Unrestricted    += getMappedVal(r,"Value of Unrestricted Stock");
    // FIX-PHANTOM-BRANCH: exclude phantom (no PO/supplying plant) transit from branch totals
    const phantomVal = r._phantomTransitVal || 0;
    const phantomQty = r._phantomTransitQty || 0;
    aggMap[k].Transit         += getMappedVal(r,"Value of Stock in Transit") - phantomVal;
    aggMap[k].QC              += getMappedVal(r,"Value of Stock in Quality Inspection");
    aggMap[k].UnrestrictedQty += getMappedQty(r,"Unrestricted Stock");
    aggMap[k].TransitQty      += getMappedQty(r,"Stock in Transit") - phantomQty;
    aggMap[k].QCQty           += getMappedQty(r,"Stock in Quality Inspection");
    const matKey = (mappingTable.size > 0 ? r._mappedMaterial : null) || r["Material"];
    aggMatSets[k].add(String(matKey));
  });
  // Assign correct unique-material counts after accumulation
  Object.keys(aggMap).forEach(k => { aggMap[k].Items = aggMatSets[k].size; });
  const branchAgg = Object.values(aggMap);
  const others    = branchAgg.map(r => r.PlantName).filter(b => b !== centralName);

  // BUG-BRANCH-1 FIX: Build matPlantMap from baseDf so every (material, plant) pair
  // is a separate bucket. Using aggregated df would give only one plant per material.
  const matPlantMap = {};
  baseDf.forEach(r => {
    const mat = (mappingTable.size > 0 ? r._mappedMaterial : null) || r["Material"];
    const pln = r["Plant Name"];
    if (!matPlantMap[mat]) {
      // FEAT-BRANCH-MAPPED-DESC: also capture whether this material is a
      // mapping target and its pre-mapping (original) code/description, so
      // the Tab 2 table can show the same "STD" badge + italic original-desc
      // subtitle used on every other page (dashboard, transit, QC, etc.)
      // instead of just the bare mapped text.
      const isMapped = mappingTable.size > 0 && !!r._isMapped;
      matPlantMap[mat] = {
        desc:        (mappingTable.size > 0 ? r._mappedDesc : null) || r["Material Description"],
        group:       r["Material Group Name"],
        valType:     getValuationType(r),
        isMapped:    isMapped,
        origMaterial: isMapped ? (r._origMaterial || r["Material"]) : mat,
        origDesc:    isMapped ? (r._origDesc || r["Material Description"]) : ((mappingTable.size > 0 ? r._mappedDesc : null) || r["Material Description"]),
      };
    }
    if (!matPlantMap[mat][pln]) matPlantMap[mat][pln] = {Unrestricted:0,Transit:0,QC:0,TotalValue:0,TotalQty:0,UnrestrictedQty:0,TransitQty:0,QCQty:0};
    matPlantMap[mat][pln].Unrestricted    += getMappedVal(r,"Value of Unrestricted Stock");
    // FIX-PHANTOM-BRANCH: exclude phantom transit from per-material-per-branch data
    const phantomVal = r._phantomTransitVal || 0;
    const phantomQty = r._phantomTransitQty || 0;
    matPlantMap[mat][pln].Transit         += getMappedVal(r,"Value of Stock in Transit") - phantomVal;
    matPlantMap[mat][pln].QC             += getMappedVal(r,"Value of Stock in Quality Inspection");
    matPlantMap[mat][pln].TotalValue      += getMappedVal(r,"Value of Unrestricted Stock") + getMappedVal(r,"Value of Stock in Transit") - phantomVal + getMappedVal(r,"Value of Stock in Quality Inspection");
    // BUG-BRANCH-2 FIX: TotalQty is derived — recompute rather than accumulate
    matPlantMap[mat][pln].UnrestrictedQty += getMappedQty(r,"Unrestricted Stock");
    matPlantMap[mat][pln].TransitQty      += getMappedQty(r,"Stock in Transit") - phantomQty;
    matPlantMap[mat][pln].QCQty           += getMappedQty(r,"Stock in Quality Inspection");
    matPlantMap[mat][pln].TotalQty        = matPlantMap[mat][pln].UnrestrictedQty
                                          + matPlantMap[mat][pln].TransitQty
                                          + matPlantMap[mat][pln].QCQty;
  });
  // aggregated df is still needed for the material-level Tab 2 table display
  const df = aggregateByMappedMaterial(baseDf);

  const tabsHtml = `
    <div id="branch-tab-material"></div>`;
  document.getElementById("branch-tabs-wrap").innerHTML = tabsHtml;

  // FIX-R7: replaced native <select multiple> with buildMultiSelect for UX consistency.
  const branchWrapId = "ms-branch-select";
  const branchDdId   = "ms-branch-select-dd";
  buildMultiSelect(branchWrapId, branchDdId, others, "All Branches");
  // Pre-select all branches so the chart renders immediately without requiring user interaction.
  // FIX-BRANCH-PRESELECT: buildMultiSelect leaves checkboxes unchecked by default.
  // We must explicitly check them so _getSelected() returns all branches on first render.
  const branchWrap = document.getElementById(branchWrapId);
  setTimeout(() => {
    const branchDd = document.getElementById(branchDdId);
    if (branchDd) {
      branchDd.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.checked = true; });
      // Trigger label update if the buildMultiSelect exposed it (call the internal updateLabel via change event)
      branchDd.querySelectorAll("input[type=checkbox]").forEach(cb => cb.dispatchEvent(new Event("change")));
    }
  }, 0);

  function getSelectedBranches() {
    if (!branchWrap || !branchWrap._getSelected) return others;
    const sel = branchWrap._getSelected();
    // FIX-BRANCH-DEFAULT: if nothing is checked (e.g. before user interaction), show all branches
    return sel.length > 0 ? sel : others;
  }

  // Wire Clear button — deselects all branches and re-renders showing all branches
  const branchClearBtn = document.getElementById("branch-select-clear");
  if (branchClearBtn) {
    branchClearBtn.addEventListener("click", () => {
      if (branchWrap && branchWrap._clearSelected) branchWrap._clearSelected();
      updateBranchCharts();
    });
  }

  // ── TAB 1: Total Value ──
  function updateBranchCharts() {
    const selected = getSelectedBranches();
    const wrap     = document.getElementById("branch-tab-value");
    if (!selected.length) { wrap.innerHTML = `<div class="alert-warning">⚠️ Select at least one branch.</div>`; return; }
    const compareNames = [centralName, ...selected];
    const compareDf    = branchAgg.filter(r => compareNames.includes(r.PlantName));

    const bCols = [
      {key:"PlantName",       label:"Plant Name"},
      {key:"TotalValue",      label:"Total Value (ETB)",    fmt:fmtETB, rawKey:"TotalValue"},
      {key:"Unrestricted",    label:"Unrestricted (ETB)",   fmt:fmtETB, rawKey:"Unrestricted"},
      {key:"UnrestrictedQty", label:"Avail Qty",            fmt:fmtQty, rawKey:"UnrestrictedQty", cellClass:"col-qty"},
      {key:"Transit",         label:"Transit (ETB)",        fmt:fmtETB, rawKey:"Transit"},
      {key:"TransitQty",      label:"Transit Qty",          fmt:fmtQty, rawKey:"TransitQty",      cellClass:"col-qty"},
      {key:"QC",              label:"QC (ETB)",             fmt:fmtETB, rawKey:"QC"},
      {key:"QCQty",           label:"QC Qty",               fmt:fmtQty, rawKey:"QCQty",           cellClass:"col-qty"},
      {key:"Items",           label:"# Unique Materials"},
    ];
    wrap.innerHTML = `
      <div id="branch-chart-wrap" style="margin-bottom:1.2rem"></div>
      <div id="branch-table-wrap-inner" style="margin-bottom:1rem">${buildTable(compareDf, bCols, r => r.PlantName === centralName ? "row-blue" : "")}</div>`;
    // Export always includes every branch (branchAgg), independent of whatever
    // subset is currently checked in the "Compare branches" filter — the
    // on-screen table (compareDf) still respects that filter, only the
    // download does not.
    document.getElementById("btn-dl-branch-csv").onclick  = () => downloadCSV(branchAgg,   bCols, "branch_comparison.csv");
    document.getElementById("btn-dl-branch-xlsx").onclick = () => downloadExcel(branchAgg, bCols, "branch_comparison.xlsx");

    // BUG-BRANCH-CHART FIX: render a grouped bar chart comparing branches by value category
    const sorted = [...compareDf].sort((a,b) => {
      if (a.PlantName === centralName) return -1;
      if (b.PlantName === centralName) return 1;
      return b.TotalValue - a.TotalValue;
    });
    Plotly.newPlot("branch-chart-wrap", [
      { type:"bar", name:"Unrestricted (ETB)", x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.Unrestricted), marker:{color:"#3fb950"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"bar", name:"In Transit (ETB)",   x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.Transit),      marker:{color:"#d29922"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
      { type:"bar", name:"In QC (ETB)",        x:sorted.map(r=>r.PlantName), y:sorted.map(r=>r.QC),           marker:{color:"#f85149"}, hovertemplate:"<b>%{x}</b><br>ETB %{y:,.0f}<extra></extra>" },
    ], pl({ height:300, barmode:"stack", margin:{l:20,r:20,t:30,b:100},
      title:{text:"Inventory Value by Branch", font:{color:"#8b949e",size:13}} }), PLOTLY_CONFIG);
  }

  // ── TAB 2: Material Across Branches ──
  // FIX-BRANCH-TAB2-FILTER: matTabInitialized only guards the one-time UI scaffold build.
  // It must NOT block re-render when the MG filter in Tab 1 changes; we reset it on
  // every renderBranch() call (renderMaterialTab is called fresh each time the tab is opened).
  let matTabInitialized = false;
  function renderMaterialTab() {
    // FEAT-BRANCH-FREEZE: freeze-panes state for the Material Across Branches
    // table. Two INDEPENDENT toggles:
    //   matColFreezeOn — pins the first 3 columns (Material Code, Material
    //                    Description, Material Group) while scrolling
    //                    horizontally.
    //   matRowFreezeOn — pins the header row while scrolling vertically.
    // Head Office is intentionally excluded from the frozen columns — it's a
    // regular scrolling plant column like the others.
    // Off by default; toggled via the ⇔ / ⇕ icons in the top-left header
    // cell. Declared here (not inside refreshMaterialView) so they survive
    // filter/metric changes that re-render the table without a full
    // renderMaterialTab() re-run, and reset to off whenever the Branch
    // Comparison page itself is re-rendered.
    let matColFreezeOn = false;
    let matRowFreezeOn = false;

    const wrap         = document.getElementById("branch-tab-material");
    // BUG-BRANCH-3 FIX: use baseDf to enumerate plant names — df (aggregated) may
    // collapse multi-plant materials to a single plant, hiding some branch columns.
    const allPlantNames = [...new Set(baseDf.map(r => r["Plant Name"]))].sort((a,b) => {
      if (a === centralName) return -1; if (b === centralName) return 1; return a.localeCompare(b);
    });

    // ── MOS WIRING (FEAT-BRANCH-MOS) ──────────────────────────────────────────
    // Lets the Material Across Branches table show Months-of-Stock alongside
    // quantity figures, reusing the AMC engine from mos.js. Only meaningful for
    // Qty metrics (MOS = qty ÷ AMC), so it's only rendered when one of those is
    // selected. Uses the exact same hub/branch AMC rules as mos.js:
    //   - HO01's AMC = sum of every branch plant's own AMC (HO01 has no real
    //     consumption of its own — see mos.js header comment).
    //   - Every other (branch) plant uses its own AMC column.
    //   - "National" uses the same branch-only AMC denominator as HO01 (per
    //     mos.js's National MOS definition), but its SOH numerator is the
    //     network-wide total (every plant incl. HO01) rather than HO01 alone.
    const plantNameToCode = {};
    baseDf.forEach(r => {
      const pn = r["Plant Name"];
      if (pn && !plantNameToCode[pn]) plantNameToCode[pn] = String(r["Plant"] || "").trim().toUpperCase();
    });
    const mosAvailable0 = typeof mosMerged !== "undefined" && mosMerged.length > 0
                       && typeof mosPlants !== "undefined" && mosPlants.length > 0;
    // BUG-MOS-STALE-FIX: previously `const mosAvailable` / `const mosByCode` were
    // computed once here and never rechecked. If the AMC file finished loading
    // AFTER the user had already opened Branch Comparison, mosAvailable stayed
    // false forever (checkboxes permanently greyed out) even though the data
    // was now present — refreshMaterialView() re-ran on every Apply/filter
    // change but always read this same stale const. Both are now `let` and get
    // recomputed at the top of refreshMaterialView() below, so the checkboxes
    // re-enable themselves the moment fresh AMC data shows up.
    let mosAvailable = mosAvailable0;
    let mosByCode  = mosAvailable ? new Map(mosMerged.map(r => [r.code, r])) : new Map();
    const mosHubCode = (typeof HUB_PLANT !== "undefined") ? HUB_PLANT : "HO01";

    // AMC a given plant code should be measured against for this AMC row.
    // Hub plant (and National) both use the sum of every branch plant's AMC —
    // that's the "AMC is the same for National and HO01" rule.
    function branchAmcFor(mosRow, plantCode) {
      if (!mosRow) return null;
      const branchCodes = mosPlants.filter(p => p !== mosHubCode);
      if (plantCode === mosHubCode) {
        const anyCommitted = branchCodes.some(p => mosRow.amcs[p] !== null && mosRow.amcs[p] !== undefined);
        if (!anyCommitted) return null;
        return branchCodes.reduce((s, p) => s + (mosRow.amcs[p] || 0), 0);
      }
      const v = mosRow.amcs[plantCode];
      return (v === null || v === undefined) ? null : v;
    }

    function mosFor(qty, amc) {
      if (amc === null || amc === undefined) return null; // not committed at this plant
      if (amc > 0) return qty / amc;
      return qty > 0 ? Infinity : null;
    }

    // FEAT-BRANCH-SOH-MOS-AMC: renders a table cell showing any combination of
    // SOH (the selected quantity metric) / MOS (qty ÷ AMC) / AMC (raw monthly
    // consumption), each as its own stacked sub-row, per the "Show" checkboxes.
    // Falls back to plain qty if somehow called with everything off, so a cell
    // is never left blank.
    function plantCellMulti(qty, mos, amc, flags) {
      const rows = [];
      if (flags.soh) rows.push(`<div>${fmtQty(qty)}</div>`);
      if (flags.mos) {
        const style = (typeof mosCellStyle === "function") ? mosCellStyle(mos) : "";
        const mosHtml = (typeof fmtMosVal === "function") ? fmtMosVal(mos)
          : (mos === null || mos === undefined ? "N/A" : mos === Infinity ? "∞" : `${mos.toFixed(1)} mo`);
        rows.push(`<div style="font-size:0.92em;font-weight:600;margin-top:3px;opacity:0.95;${style}"><span style="opacity:0.55;font-weight:400;font-size:0.85em;margin-right:3px">MOS</span>${mosHtml}</div>`);
      }
      if (flags.amc) {
        const amcHtml = (amc === null || amc === undefined) ? "N/A" : fmtQty(amc);
        rows.push(`<div style="font-size:0.85em;opacity:0.75;margin-top:2px"><span style="opacity:0.7;margin-right:3px">AMC</span>${amcHtml}</div>`);
      }
      return rows.length ? rows.join("") : `<div>${fmtQty(qty)}</div>`;
    }

    function mosExportVal(mos) {
      if (mos === null || mos === undefined) return "Not Committed";
      if (mos === Infinity) return "∞";
      return Number(mos).toFixed(1);
    }

    function amcExportVal(amc) {
      return (amc === null || amc === undefined) ? "Not Committed" : Number(amc).toFixed(1);
    }

    if (!matTabInitialized) {
      matTabInitialized = true;
      // FIX-BRANCH-MG: use baseDf (not aggregated df) so all material groups are available.
      // Routed through the central materialGroupFilterOptions() helper (permissions.js)
      // rather than a local copy of the list-building logic — baseDf here comes from
      // applyPageFilter("branch"), which already runs canAccessRow().
      const mgNamesForFilter = (typeof materialGroupFilterOptions === "function")
        ? materialGroupFilterOptions(baseDf)
        : [...new Set(baseDf.map(r => r["Material Group Name"]))].filter(Boolean).filter(name => !isNonMedicalGroup(name)).sort();
      // Build list of all materials for the multi-select.
      // BUGFIX-MAT-FILTER-DEDUP: previously built from the RAW "Material" /
      // "Material Description" fields on every baseDf row, so a material
      // mapped from several source SKUs (e.g. 105-PHEN-0104,
      // 105-PHEN-0104-01, -03, -04 all mapping to 105-PHEN-0104-02) showed
      // up as separate, confusing entries in the dropdown instead of one.
      // Now: when mapping is active, use the mapped/canonical code + mapped
      // description (r._mappedMaterial / r._mappedDesc) so all rows sharing
      // a target collapse into a single entry. A code with no mapping entry
      // still falls back to its own raw code/description, unchanged.
      const allMatOptions = [...new Set(baseDf.map(r => {
        const code = String((mappingTable.size > 0 ? r._mappedMaterial : null) || r["Material"] || "").trim();
        const desc = String((mappingTable.size > 0 ? r._mappedDesc     : null) || r["Material Description"] || "").trim();
        return code + (desc && desc !== code ? " — " + desc : "");
      }))].filter(Boolean).sort();

      // ── SAP-STYLE FILTER BAR ────────────────────────────────────────────
      // Fields laid out horizontally (label above box, always visible while
      // expanded) with a top-right Go / Hide Filter Bar / Filters(N) control
      // row — mirrors the SAP list-report filter bar pattern rather than the
      // old per-field chip popups. Material / Material Group / Material Type
      // keep the exact same box styling and click-to-open checklist behavior
      // as before (.ms-btn / .ms-dropdown) — just no extra decorative icon —
      // so they read consistently with the plain Metric / Sort By selects.
      // Same underlying controls/IDs (mat-ms-wrap, mat-mg-ms-wrap,
      // mat-type-ms-wrap, mat-metric, mat-sort, mat-apply, mat-clear) so none of
      // the existing wiring below needs to change.
      wrap.innerHTML = `
        <div id="mat-filterbar-wrap" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:1rem;overflow:visible">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:1.1rem;padding:0.55rem 0.9rem;border-bottom:1px solid var(--border)">
            <button id="mat-apply" class="apply-btn" style="padding:5px 22px">Go</button>
            <button id="mat-hide-filterbar-btn" type="button" style="background:none;border:none;color:var(--blue);font-size:0.78rem;cursor:pointer;padding:0">Hide Filter Bar</button>
          </div>
          <div id="mat-filterbar-fields" style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:flex-end;padding:0.9rem 1rem 1rem">
            <div style="min-width:240px;flex:1 1 240px">
              <div class="nav-label" style="font-size:var(--fs-2xs);margin-bottom:5px">Material</div>
              <div class="ms-wrap" id="mat-ms-wrap" style="min-width:0;width:100%"><button class="ms-btn" type="button" style="width:100%">All Materials <span class="ms-arrow">▾</span></button><div class="ms-dropdown" id="mat-ms-dd"></div></div>
            </div>
            <div style="min-width:210px;flex:1 1 210px">
              <div class="nav-label" style="font-size:var(--fs-2xs);margin-bottom:5px">Material Group</div>
              <div class="ms-wrap" id="mat-mg-ms-wrap" style="min-width:0;width:100%"><button class="ms-btn" type="button" style="width:100%">All Material Groups <span class="ms-arrow">▾</span></button><div class="ms-dropdown" id="mat-mg-ms-dd"></div></div>
            </div>
            <div style="min-width:180px;flex:1 1 180px">
              <div class="nav-label" style="font-size:var(--fs-2xs);margin-bottom:5px">Material Type</div>
              <div class="ms-wrap" id="mat-type-ms-wrap" style="min-width:0;width:100%"><button class="ms-btn" type="button" style="width:100%">All Material Types <span class="ms-arrow">▾</span></button><div class="ms-dropdown" id="mat-type-ms-dd"></div></div>
            </div>
            <div style="min-width:190px;flex:1 1 190px">
              <div class="nav-label" style="font-size:var(--fs-2xs);margin-bottom:5px">Metric</div>
              <select id="mat-metric" style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;width:100%">
                <option value="TotalQty" selected>Total Quantity</option>
                <option value="UnrestrictedQty">Unrestricted Stock Quantity</option>
                <option value="TransitQty">Transit Quantity</option>
                <option value="QCQty">Stock in Quality Inspection Quantity</option>
                <option value="TotalValue">Total Value (ETB)</option>
                <option value="Unrestricted">Unrestricted Value (ETB)</option>
                <option value="Transit">Transit Value (ETB)</option>
                <option value="QC">Stock in Quality Inspection Value (ETB)</option>
              </select>
            </div>
            <div style="min-width:190px;flex:1 1 190px">
              <div class="nav-label" style="font-size:var(--fs-2xs);margin-bottom:5px">Sort By</div>
              <select id="mat-sort" style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;width:100%">
                <option value="total_desc">Highest Total ↓</option>
                <option value="total_asc">Lowest Total ↑</option>
                <option value="desc_asc">Description A–Z</option>
                <option value="spread_desc">Most Branches ↓</option>
              </select>
            </div>
            <div style="display:flex;align-items:flex-end">
              <button id="mat-clear" class="apply-btn secondary">Clear</button>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:1rem;padding:0 0.2rem">
          <span class="nav-label" style="font-size:var(--fs-2xs)">Show</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:0.78rem;cursor:pointer" title="Stock on Hand — the value picked by the Metric dropdown">
            <input type="checkbox" id="mat-show-soh" checked /> SOH
          </label>
          <label id="mat-show-mos-label" style="display:flex;align-items:center;gap:4px;font-size:0.78rem;${mosAvailable ? "cursor:pointer" : "opacity:0.4"}" title="Months of Stock (Qty ÷ AMC) — only available when a Quantity metric is selected and AMC data is loaded">
            <input type="checkbox" id="mat-show-mos" ${mosAvailable ? "" : "disabled"} /> MOS
          </label>
          <label id="mat-show-amc-label" style="display:flex;align-items:center;gap:4px;font-size:0.78rem;${mosAvailable ? "cursor:pointer" : "opacity:0.4"}" title="Average Monthly Consumption — only available when a Quantity metric is selected and AMC data is loaded">
            <input type="checkbox" id="mat-show-amc" ${mosAvailable ? "" : "disabled"} /> AMC
          </label>
        </div>
        <div id="mat-chart-wrap" style="margin-bottom:1rem"></div>
        <div style="font-size:0.72rem;color:var(--muted);margin-bottom:0.5rem">Downloads include whichever of SOH / MOS / AMC are ticked above.</div>
        <div id="mat-dl-row" style="display:flex;gap:0.6rem;justify-content:flex-end;margin-bottom:0.5rem"></div>
        <div id="mat-table-wrap"></div>`;

      // ── Hide Filter Bar / Filters(N) behaviour ────────────────────────────
      // "Hide Filter Bar" collapses the whole fields row down to just the top
      // control strip (Go / Filters(N) badge), and flips to "Show Filter Bar"
      // to bring it back.
      const filterFieldsEl  = document.getElementById("mat-filterbar-fields");
      const hideBtn         = document.getElementById("mat-hide-filterbar-btn");
      function setFilterBarExpanded(expanded) {
        if (filterFieldsEl) filterFieldsEl.style.display = expanded ? "flex" : "none";
        if (hideBtn) hideBtn.textContent = expanded ? "Hide Filter Bar" : "Show Filter Bar";
      }
      if (hideBtn) {
        hideBtn.addEventListener("click", () => {
          const isExpanded = filterFieldsEl && filterFieldsEl.style.display !== "none";
          setFilterBarExpanded(!isExpanded);
        });
      }
      setFilterBarExpanded(true); // starts expanded

      document.getElementById("mat-apply").addEventListener("click", refreshMaterialView);
      document.getElementById("mat-clear").addEventListener("click", () => {
        const matWrap2  = document.getElementById("mat-ms-wrap");
        const mgWrap2   = document.getElementById("mat-mg-ms-wrap");
        const typeWrap2 = document.getElementById("mat-type-ms-wrap");
        if (matWrap2  && matWrap2._clearSelected)  matWrap2._clearSelected();
        if (mgWrap2   && mgWrap2._clearSelected)   mgWrap2._clearSelected();
        if (typeWrap2 && typeWrap2._clearSelected) typeWrap2._clearSelected();
        document.getElementById("mat-metric").value    = "TotalQty";
        document.getElementById("mat-sort").value      = "total_desc";
        refreshMaterialView();
      });
      // Build the material multi-select after HTML is in DOM
      buildMultiSelect("mat-ms-wrap", "mat-ms-dd", allMatOptions, "All Materials");
      // Material Group multi-select — lets users narrow the comparison to one or
      // more material groups (e.g. only "Antibiotics" or "Vaccines") in addition
      // to / instead of picking individual materials.
      buildMultiSelect("mat-mg-ms-wrap", "mat-mg-ms-dd", mgNamesForFilter, "All Material Groups");
      // Material Type multi-select — was a single-select <select>; now supports
      // choosing more than one type (e.g. ZME + ZMS) at once, same UX as the
      // other filters on this tab.
      // FIX-SCOPED-FILTER-LIST: was hardcoded to the full ZME/ZMS/ZLC/ZMD list
      // for every role, so a scope-restricted user (e.g. Q_ZME only) could
      // still pick ZMS/ZLC/ZMD here even though every row of those types is
      // invisible to them. Now derived from baseDf (already access-filtered
      // via applyPageFilter -> canAccessRow), narrowed further by the user's
      // data_scopes — Admin still always sees the full static list.
      const matTypeOptions = (typeof materialTypeFilterOptions === "function")
        ? materialTypeFilterOptions(baseDf)
        : ["ZME", "ZMS", "ZLC", "ZMD"]; // permissions.js not loaded — fail open to old behavior
      buildMultiSelect("mat-type-ms-wrap", "mat-type-ms-dd", matTypeOptions, "All Material Types");
      ["mat-show-soh", "mat-show-mos", "mat-show-amc"].forEach(id => {
        const cb = document.getElementById(id);
        if (cb) cb.addEventListener("change", refreshMaterialView);
      });
      // Expose so the drilldown block below (and any future callers within
      // this render) can re-expand the bar after programmatically ticking boxes.
      wrap._expandMatFilterBar = () => setFilterBarExpanded(true);
    }

    // ── Spread-chart drilldown: auto-select materials from the clicked group ──
    // _lastSpreadDrilldown is set by the Branch Spread bar-click handler in
    // renderConcentration(). We consume it once here and clear it so a manual
    // page-revisit doesn't re-apply a stale selection.
    if (_lastSpreadDrilldown) {
      const { plantCount, matCodes, label: customLabel } = _lastSpreadDrilldown;
      _lastSpreadDrilldown = null;   // consume — one-shot

      const matWrapEl = document.getElementById("mat-ms-wrap");
      const matDdEl   = document.getElementById("mat-ms-dd");
      if (matWrapEl && matDdEl) {
        // Clear any existing selection first
        if (matWrapEl._clearSelected) matWrapEl._clearSelected();

        // The multi-select options are formatted as "CODE — DESC" or just "CODE".
        // We need to tick every checkbox whose value starts with one of our codes.
        const codeSet = new Set(matCodes.map(c => String(c).trim().toUpperCase()));
        let matched = 0;
        matDdEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
          const cbCode = cb.value.split(" — ")[0].trim().toUpperCase();
          if (codeSet.has(cbCode)) {
            cb.checked = true;
            cb.dispatchEvent(new Event("change"));
            matched++;
          }
        });

        // Show a transient toast so the user knows why the filter changed.
        // customLabel is used for single-material jumps (e.g. from the
        // Concentration drill banner) where "plants" phrasing doesn't apply.
        const label = customLabel != null ? customLabel
          : plantCount === 1
          ? "1 plant (sole branch)"
          : `${plantCount} plant${plantCount > 1 ? "s" : ""}`;
        showSpreadDrilldownToast(matched, label);
        // Make sure the filter bar is expanded so the user can see what got
        // auto-selected in the Material field.
        if (wrap._expandMatFilterBar) wrap._expandMatFilterBar();
      }
    }

    refreshMaterialView();
    // BUG-MOS-STALE-FIX: expose this tab's refresh fn globally so that when the
    // AMC file finishes loading *after* the user is already on this page, we
    // can re-enable the MOS/AMC checkboxes immediately instead of leaving them
    // greyed out until the user manually re-applies a filter. See the
    // populatePersonFilter() hook near the top of the file, which mos.js calls
    // right after it finishes parsing the AMC file.
    window._activeBranchMatRefresh = refreshMaterialView;

    // FEAT-BRANCH-FREEZE: measure the rendered widths of the frozen columns
    // (Material Code, Material Description, Material Group) and stamp
    // cumulative pixel offsets onto their `left` style so position:sticky
    // lines them up correctly — widths vary with content/theme/font, so a
    // fixed CSS value can't be used. Only relevant to column freeze; row
    // freeze needs no offset math since the header just sticks to top:0.
    function computeFreezeOffsets(table) {
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
    function setMatColFreeze(on) {
      matColFreezeOn = on;
      const table = document.querySelector("#mat-table-wrap table");
      const btn   = document.getElementById("mat-freeze-col-toggle");
      if (!table) return;
      if (on) {
        table.classList.add("freeze-cols");
        if (btn) { btn.classList.add("active"); btn.setAttribute("aria-pressed", "true"); }
        computeFreezeOffsets(table);
      } else {
        table.classList.remove("freeze-cols");
        if (btn) { btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); }
        table.querySelectorAll("[data-freeze-col]").forEach(el => { el.style.left = ""; });
      }
    }

    // Row freeze (⇕) — independent of column freeze.
    function setMatRowFreeze(on) {
      matRowFreezeOn = on;
      const table = document.querySelector("#mat-table-wrap table");
      const btn   = document.getElementById("mat-freeze-row-toggle");
      if (!table) return;
      if (on) {
        table.classList.add("freeze-header");
        if (btn) { btn.classList.add("active"); btn.setAttribute("aria-pressed", "true"); }
      } else {
        table.classList.remove("freeze-header");
        if (btn) { btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); }
      }
    }

    function wireMatFreezeToggle() {
      const colBtn = document.getElementById("mat-freeze-col-toggle");
      const rowBtn = document.getElementById("mat-freeze-row-toggle");

      if (colBtn) {
        colBtn.addEventListener("click", (e) => { e.stopPropagation(); setMatColFreeze(!matColFreezeOn); });
        colBtn.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setMatColFreeze(!matColFreezeOn); }
        });
      }
      if (rowBtn) {
        rowBtn.addEventListener("click", (e) => { e.stopPropagation(); setMatRowFreeze(!matRowFreezeOn); });
        rowBtn.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setMatRowFreeze(!matRowFreezeOn); }
        });
      }
      // Re-render (metric/filter change) happened — carry both freeze states forward.
      if (matColFreezeOn) setMatColFreeze(true);
      if (matRowFreezeOn) setMatRowFreeze(true);
    }

    function refreshMaterialView() {
      // BUG-MOS-STALE-FIX: recheck AMC availability fresh on every call instead
      // of trusting the value captured when the tab first opened — see note
      // above where mosAvailable/mosByCode are declared.
      mosAvailable = typeof mosMerged !== "undefined" && mosMerged.length > 0
                  && typeof mosPlants !== "undefined" && mosPlants.length > 0;
      mosByCode = mosAvailable ? new Map(mosMerged.map(r => [r.code, r])) : new Map();

      const matWrap   = document.getElementById("mat-ms-wrap");
      const selected  = (matWrap && matWrap._getSelected) ? matWrap._getSelected() : [];
      // selected values are "CODE — DESC" or just "CODE"; extract the code part before " — "
      const selCodes  = selected.map(v => v.split(" — ")[0].trim().toLowerCase());
      const mgWrap      = document.getElementById("mat-mg-ms-wrap");
      const selectedMgs = (mgWrap && mgWrap._getSelected) ? mgWrap._getSelected() : [];
      const typeWrap      = document.getElementById("mat-type-ms-wrap");
      const selectedTypes = (typeWrap && typeWrap._getSelected) ? typeWrap._getSelected() : [];
      const metric    = document.getElementById("mat-metric").value;
      const sortMode  = document.getElementById("mat-sort").value;
      const isQty     = metric.includes("Qty");
      const fmtFn     = isQty ? fmtQty : fmtETB;

      // FEAT-BRANCH-SOH-MOS-AMC: read the three "Show" checkboxes. MOS/AMC only
      // make sense against a quantity metric with AMC data loaded, so they're
      // force-disabled otherwise. If every box ends up unchecked (e.g. user
      // unticks SOH right after switching away from a Qty metric, which just
      // force-disabled MOS/AMC too), silently re-check SOH so a cell is never
      // left blank.
      const showSohCb = document.getElementById("mat-show-soh");
      const showMosCb = document.getElementById("mat-show-mos");
      const showAmcCb = document.getElementById("mat-show-amc");
      const mosAmcUsable = isQty && mosAvailable;
      if (showMosCb) showMosCb.disabled = !mosAmcUsable;
      if (showAmcCb) showAmcCb.disabled = !mosAmcUsable;
      const mosLabelEl = document.getElementById("mat-show-mos-label");
      const amcLabelEl = document.getElementById("mat-show-amc-label");
      if (mosLabelEl) mosLabelEl.style.opacity = mosAmcUsable ? "1" : "0.4";
      if (amcLabelEl) amcLabelEl.style.opacity = mosAmcUsable ? "1" : "0.4";
      let showSoh = showSohCb ? showSohCb.checked : true;
      let showMos = mosAmcUsable && showMosCb ? showMosCb.checked : false;
      let showAmc = mosAmcUsable && showAmcCb ? showAmcCb.checked : false;
      if (!showSoh && !showMos && !showAmc) {
        showSoh = true;
        if (showSohCb) showSohCb.checked = true;
      }

      let materials = Object.entries(matPlantMap)
        .filter(([mat, info]) => {
          if (selectedTypes.length > 0 && !selectedTypes.includes(info.valType)) return false;
          if (selectedMgs.length > 0 && !selectedMgs.includes(info.group)) return false;
          if (selCodes.length > 0) {
            // Multi-select: match if material code is one of the selected codes
            return selCodes.includes(mat.toLowerCase());
          }
          return true;
        })
        .map(([mat, info]) => {
          const plantData = {};
          let grandTotal = 0, branchCount = 0;
          allPlantNames.forEach(pn => {
            const v = info[pn] ? info[pn][metric] : 0;
            plantData[pn] = v || 0;
            grandTotal   += plantData[pn];
            if (plantData[pn] > 0) branchCount++;
          });
          // FEAT-BRANCH-SOH-MOS-AMC: MOS/AMC only make sense against a quantity,
          // and only when AMC data has been loaded.
          // computeMosAmcData() takes a plant->qty map (+ grand total qty) and
          // returns matching plant->MOS and plant->AMC maps in one pass (AMC
          // doesn't depend on qty, but is looked up alongside MOS since both
          // need the same hub/branch AMC resolution below). Shared by the
          // on-screen display (tied to whichever qty metric is selected) and
          // the export-only version (always based on Total Quantity, so
          // exporting MOS/AMC works even for materials with 0 in the currently
          // selected metric).
          function computeMosAmcData(qtyByPlant, grandQty) {
            const mos = {}, amc = {};
            const mosRow = mosByCode.get(mat);
            allPlantNames.forEach(pn => {
              // FIX-BRANCH-MOS-HUB: detect the hub by pn === centralName (already
              // correctly resolved above — handles HO01-not-found fallback, and
              // doesn't depend on the AMC file having an HO01/hub column at all),
              // rather than matching plantNameToCode[pn] against mosHubCode, which
              // silently fails to flag the hub when there's no such AMC column.
              const isHubPlant = pn === centralName;
              const code = plantNameToCode[pn];
              const plantAmc = mosRow ? branchAmcFor(mosRow, isHubPlant ? mosHubCode : code) : null;
              amc[pn] = plantAmc;
              mos[pn] = mosFor(qtyByPlant[pn] || 0, plantAmc);
            });
            // National = network-wide qty (grandQty, already incl. HO01) ÷ branch-only AMC
            const nationalAmc = mosRow ? branchAmcFor(mosRow, mosHubCode) : null;
            amc.__national__ = nationalAmc;
            mos.__national__ = mosFor(grandQty, nationalAmc);
            return { mos, amc };
          }

          const mosAmcOnScreen = (isQty && mosAvailable) ? computeMosAmcData(plantData, grandTotal) : null;
          const mosData = mosAmcOnScreen ? mosAmcOnScreen.mos : null;
          const amcData = mosAmcOnScreen ? mosAmcOnScreen.amc : null;

          // Export-only MOS/AMC, always computed from Total Quantity regardless
          // of the currently selected metric, so exports stay meaningful no
          // matter what the table is currently displaying.
          let exportMosData = null, exportAmcData = null;
          if (mosAvailable) {
            if (isQty && metric === "TotalQty") {
              exportMosData = mosData; // already exactly this calc — reuse
              exportAmcData = amcData;
            } else {
              const totalQtyByPlant = {};
              let totalQtyGrand = 0;
              allPlantNames.forEach(pn => {
                const tq = info[pn] ? (info[pn].TotalQty || 0) : 0;
                totalQtyByPlant[pn] = tq;
                totalQtyGrand += tq;
              });
              const exp = computeMosAmcData(totalQtyByPlant, totalQtyGrand);
              exportMosData = exp.mos;
              exportAmcData = exp.amc;
            }
          }

          return {mat, desc:info.desc, group:info.group, valType:info.valType, isMapped:info.isMapped, origMaterial:info.origMaterial, origDesc:info.origDesc, plantData, mosData, amcData, exportMosData, exportAmcData, grandTotal, branchCount};
        });

      if (sortMode === "total_desc") materials.sort((a,b) => b.grandTotal - a.grandTotal);
      if (sortMode === "total_asc")  materials.sort((a,b) => a.grandTotal - b.grandTotal);
      if (sortMode === "desc_asc")   materials.sort((a,b) => a.desc.localeCompare(b.desc));
      if (sortMode === "spread_desc")materials.sort((a,b) => b.branchCount - a.branchCount);

      const top      = materials.slice(0, 30);
      const chartWrap = document.getElementById("mat-chart-wrap");
      if (!top.length) {
        chartWrap.innerHTML = "";
        document.getElementById("mat-table-wrap").innerHTML = `<div class="alert-info">No materials found.</div>`;
        const matDlRow = document.getElementById("mat-dl-row");
        if (matDlRow) matDlRow.innerHTML = "";
        return;
      }
      chartWrap.innerHTML = "";

      // FEAT-BRANCH-SOH-MOS-AMC-FIX: previously this redeclared `showMos`
      // (already `let`-declared above from the checkbox) as a *second*,
      // unrelated `const showMos` — a duplicate lexical declaration in the
      // same function scope, which is a SyntaxError and crashed the entire
      // script.js on load (nothing on the page worked). It also called
      // plantCellWithMos(), a function that doesn't exist anywhere in this
      // codebase — a ReferenceError the instant it ran. Both are removed;
      // we reuse mosAmcUsable (computed above from the checkboxes) and the
      // already-implemented plantCellMulti() helper, which renders any
      // combination of SOH / MOS / AMC as its own sub-row per the cellFlags
      // below, driven directly by the three "Show" checkboxes.
      const cellFlags = { soh: showSoh, mos: showMos, amc: showAmc };
      const colDefs = [
        {key:"mat",  label:"Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap"},
        {key:"desc", label:"Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap"},
        {key:"group",label:"Material Group"},
        ...allPlantNames.map(pn => ({
          key:`__p__${pn}`, label:pn,
          fmt:(val,r) => mosAmcUsable
            ? plantCellMulti(val, r.__mosData ? r.__mosData[pn] : null, r.__amcData ? r.__amcData[pn] : null, cellFlags)
            : fmtFn(val),
          raw:true, // fmt returns HTML (<div> wrappers) — must not be escaped
          rawKey:`__r__${pn}`, cellClass:isQty?"col-qty":"col-val",
        })),
        {key:"grandTotal",  label:"National", // FEAT-BRANCH-MOS: "Grand Total" renamed to "National"
          fmt:(val,r) => mosAmcUsable
            ? plantCellMulti(val, r.__mosData ? r.__mosData.__national__ : null, r.__amcData ? r.__amcData.__national__ : null, cellFlags)
            : fmtFn(val),
          raw:true, // fmt returns HTML (<div> wrappers) — must not be escaped
          rawKey:"grandTotal", cellClass:isQty?"col-qty":"col-val"},
        {key:"branchCount", label:"# Branches"},
      ];
      // buildMatRow: shared shape-builder used both for the on-screen (capped)
      // table and for the full-data export below, so the two never drift apart.
      function buildMatRow(m) {
        const row = {
          mat:m.mat, desc:m.desc, group:m.group, grandTotal:m.grandTotal, branchCount:m.branchCount,
          // FEAT-BRANCH-MAPPED-DESC: lets renderMatCode/renderMatDesc detect a
          // mapped row and render the "STD" badge + original code/description
          // subtitle, same as dashboard/transit/QC/etc.
          _isMapped:      m.isMapped,
          _mappedMaterial: m.mat,
          _origMaterial:  m.origMaterial,
          _mappedDesc:    m.desc,
          _origDesc:      m.origDesc,
        };
        allPlantNames.forEach(pn => { row[`__p__${pn}`] = m.plantData[pn] || 0; row[`__r__${pn}`] = m.plantData[pn] || 0; });
        row["__r__grandTotal"] = m.grandTotal;
        row.__mosData = m.mosData; // FEAT-BRANCH-MOS: consumed by plant/national column fmt()
        row.__amcData = m.amcData; // FEAT-BRANCH-SOH-MOS-AMC-FIX: consumed by plant/national column fmt()
        row.__exportMosData = m.exportMosData; // EXPORT-MOS-CB: consumed by export-only MOS columns
        row.__exportAmcData = m.exportAmcData; // consumed by export-only AMC columns
        return row;
      }
      // On-screen table stays capped at 200 rows for render performance.
      const tableRows = materials.slice(0, 200).map(buildMatRow);
      // EXPORT-FULL-DATA: exports must include every material, not just the
      // first 200 rendered on screen — build the full row set separately.
      const allTableRows = materials.map(buildMatRow);

      const centralKey = `__p__${centralName}`;
      // FEAT-BRANCH-FREEZE: the first 4 colDefs are frozen for horizontal
      // scroll. Head Office/central plant is NOT frozen; it's a normal
      // scrolling column (it's still visually tinted via
      // col-central/col-central-th, just not sticky).
      const FREEZE_COL_MAX_IDX = 3;
      const thead = `<thead><tr>${colDefs.map((c, i) => {
        const isCentral = c.key === centralKey;
        const freezeAttr = i <= FREEZE_COL_MAX_IDX ? ` data-freeze-col="${i}"` : "";
        const pins = i === 0
          ? `<span class="freeze-toggle-btn freeze-cols-btn" id="mat-freeze-col-toggle" role="button" tabindex="0" title="Freeze first 4 columns (horizontal scroll)">⇔</span>` +
            `<span class="freeze-toggle-btn freeze-header-btn" id="mat-freeze-row-toggle" role="button" tabindex="0" title="Freeze header row (vertical scroll)">⇕</span>`
          : "";
        return `<th${isCentral ? ' class="col-central-th"' : ""}${freezeAttr}>${escHtml(c.label)}${pins}</th>`;
      }).join("")}</tr></thead>`;
      const tbody = tableRows.map(r => {
        const cells = colDefs.map((c, i) => {
          const v         = r[c.key];
          // BUGFIX-MAT-TAB-FMT: previously this skipped calling c.fmt entirely
          // whenever c.raw was true, and just used the unformatted value `v`
          // as the cell's HTML. That meant renderMatCode()/renderMatDesc() —
          // which apply the mapped material code/description, the "STD"
          // badge, and the original (pre-mapping) value as an italic
          // subtitle — never ran for this table, so mapped rows silently
          // fell back to showing the plain (sometimes unmapped-looking) text.
          // Mirrors buildTable()'s pattern: always compute via c.fmt first,
          // then only escape the result if c.raw is NOT set.
          const formatted = c.fmt ? c.fmt(v, r) : v;
          const display   = c.raw ? (formatted ?? "")
                        : (formatted == null ? "" : escHtml(String(formatted)));
          const isZero  = typeof v === "number" && v === 0;
          // FIX-CENTRAL-COL-CONTRAST: previously hardcoded color:#58a6ff;background:#0d2035
          // here — a fixed dark background that never adapted to light theme, while the
          // MOS sub-text inside it does (var(--text)), killing contrast in light mode.
          // Use a theme-aware tint class instead and let normal text colors (qty/MOS)
          // render on top of it unmodified.
          const style   = isZero && c.key !== centralKey ? 'style="color:var(--dim)"' : "";
          const cls     = [c.cellClass, c.key === centralKey ? "col-central" : ""].filter(Boolean).join(" ");
          const freezeAttr = i <= FREEZE_COL_MAX_IDX ? ` data-freeze-col="${i}"` : "";
          return `<td class="${cls}" ${style}${freezeAttr}>${display}</td>`;
        }).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      document.getElementById("mat-table-wrap").innerHTML = `
        <div style="color:var(--muted);font-size:12px;margin-bottom:6px">Showing ${tableRows.length} of ${materials.length} materials · Blue = Central (${escHtml(centralName)}) · <span style="cursor:default">⇔ freeze first 4 columns · ⇕ freeze header row — click either icon in the top-left header cell</span></div>
        <div class="tbl-wrap tbl-wrap-freeze"><table>${thead}<tbody>${tbody}</tbody></table></div>
        ${materials.length > 200 ? `<div class="alert-info">Showing first 200 of ${materials.length}. Refine search.</div>` : ""}`;

      // FEAT-BRANCH-FREEZE: wire both toggles and (re-)apply whatever freeze
      // state was active before this re-render (metric/filter changes
      // rebuild this innerHTML, which would otherwise silently drop it).
      wireMatFreezeToggle();

      // EXPORT-MOS-CB: "Include MOS columns in export" is independent of the
      // on-screen MOS display (showMos) — it reads its own checkbox, defaults
      // to checked, and only requires MOS data to exist at all (mosAvailable),
      // not that the table is currently in a qty-metric view.
      // EXPORT-MOS-CB-FIX: this used to read a checkbox with id "mat-export-mos"
      // that is never rendered anywhere in the wrap.innerHTML above, so
      // exportMos was always false — MOS never made it into a download even
      // with the on-screen MOS checkbox ticked, and AMC had no export path
      // at all. Downloads now mirror exactly what's ticked on screen.
      const exportMos = mosAmcUsable && showMos;
      const exportAmc = mosAmcUsable && showAmc;

      const exportCols = [
        {key:"mat",  label:"Material Code"},
        {key:"desc", label:"Material Description"},
        {key:"group",label:"Material Group"},
        ...allPlantNames.flatMap(pn => [
          {key:`__p__${pn}`, label:pn, rawKey:`__r__${pn}`},
          ...(exportMos ? [{key:`__mos__${pn}`, label:`${pn} MOS`, rawKey:`__mos__${pn}`}] : []),
          ...(exportAmc ? [{key:`__amc__${pn}`, label:`${pn} AMC`, rawKey:`__amc__${pn}`}] : []),
        ]),
        {key:"grandTotal", label:"National", rawKey:"grandTotal"},
        ...(exportMos ? [{key:"__mos__national", label:"National MOS", rawKey:"__mos__national"}] : []),
        ...(exportAmc ? [{key:"__amc__national", label:"National AMC", rawKey:"__amc__national"}] : []),
        {key:"branchCount", label:"# Branches"},
      ];
      // EXPORT-FULL-DATA: exports are built from allTableRows (every material
      // that matches the current filters), not the 200-row on-screen tableRows,
      // so CSV/Excel downloads always contain the complete result set.
      // allTableRows entries only carry mat/desc/group plus __p__/__r__ plant keys and
      // grandTotal/branchCount — already exactly what exportCols needs, so export
      // directly from them (no HTML-formatting fns involved). MOS/AMC fields
      // (mosExportVal/amcExportVal) are sourced from __exportMosData/__exportAmcData
      // (always Total-Quantity-based, so exports stay meaningful even when the
      // on-screen table is currently showing a Value metric).
      const exportRows = (exportMos || exportAmc)
        ? allTableRows.map(r => {
            const er = {...r};
            if (exportMos) {
              allPlantNames.forEach(pn => { er[`__mos__${pn}`] = mosExportVal(r.__exportMosData ? r.__exportMosData[pn] : null); });
              er["__mos__national"] = mosExportVal(r.__exportMosData ? r.__exportMosData.__national__ : null);
            }
            if (exportAmc) {
              allPlantNames.forEach(pn => { er[`__amc__${pn}`] = amcExportVal(r.__exportAmcData ? r.__exportAmcData[pn] : null); });
              er["__amc__national"] = amcExportVal(r.__exportAmcData ? r.__exportAmcData.__national__ : null);
            }
            return er;
          })
        : allTableRows;
      injectDlButtons("mat-dl-row",
        () => downloadCSV(exportRows,   exportCols, "branch_material_comparison.csv"),
        () => downloadExcel(exportRows, exportCols, "branch_material_comparison.xlsx"),
      );
    }
  }

  renderMaterialTab();
}

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY FLOW
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// AGGREGATE BY MATERIAL (used by QC and Branch Comparison)
// ═══════════════════════════════════════════════════════════════════════════
// Collapses multiple rows with the same material code into ONE row per
// material, summing all qty and value columns and keeping the earliest expiry.
// Also builds a "_plantList" string of all plants stocking the material.

function aggregateByMaterial(df) {
  // NOTE: Total Qty is intentionally excluded from QTY_COLS — it is a derived
  // sum (Unrestricted + Transit + QC) and must be recomputed after aggregation,
  // not accumulated directly (which would double-count it).
  const QTY_COLS = [
    "Unrestricted Stock", "Stock in Quality Inspection",
    "Blocked Stock",      "Stock in Transit",
  ];
  const VAL_COLS = [
    "Value of Unrestricted Stock",
    "Value of Stock in Quality Inspection",
    "Value of Stock in Transit",
    // BUG-FIX-4: "Total Value" removed — it is recomputed from components below
    // (line ~2081). Accumulating it here then overwriting it was wasted work and
    // would double-count if the recompute step were ever skipped.
  ];

  // Group all rows by Material code
  const matMap = {}; // materialCode → aggregated row

  df.forEach(row => {
    const mat = row["Material"];
    if (!mat) return;

    if (!matMap[mat]) {
      matMap[mat] = {
        ...row,
        _allPlants: [],
      };
      if (row["Plant Name"]) matMap[mat]._allPlants.push(row["Plant Name"]);
    } else {
      const target = matMap[mat];
      QTY_COLS.forEach(c => { target[c] = (target[c] || 0) + (row[c] || 0); });
      VAL_COLS.forEach(c => { target[c] = (target[c] || 0) + (row[c] || 0); });
      // Keep earliest expiry
      const te = target["_expiry"], se = row["_expiry"];
      if (se instanceof Date && !isNaN(se)) {
        if (!(te instanceof Date) || isNaN(te) || se < te) target["_expiry"] = se;
      }
      if (row["Plant Name"] && !target._allPlants.includes(row["Plant Name"])) {
        target._allPlants.push(row["Plant Name"]);
      }
      if (!target["Material Group Name"] && row["Material Group Name"]) target["Material Group Name"] = row["Material Group Name"];
    }
  });

  // Recompute derived totals AFTER aggregation to prevent double-counting.
  // Total Qty / Total Value are sums of components — never accumulate directly.
  Object.values(matMap).forEach(row => {
    row["Total Qty"]   = (row["Unrestricted Stock"] || 0) + (row["Stock in Transit"] || 0) + (row["Stock in Quality Inspection"] || 0);
    row["Total Value"] = (row["Value of Unrestricted Stock"] || 0) + (row["Value of Stock in Transit"] || 0) + (row["Value of Stock in Quality Inspection"] || 0);
    const plants = (row._allPlants || []).filter(Boolean).sort();
    row["_plantList"] = plants.length ? plants.join(", ") : (row["Plant Name"] || "—");
  });

  return Object.values(matMap);
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE SWITCHING
// ═══════════════════════════════════════════════════════════════════════════
const PAGE_RENDERERS = {
  dashboard:     renderDashboard,
  transit:       renderTransit,
  expiry:        renderExpiry,
  qc:            renderQC,
  branch:        renderBranch,
  concentration: renderConcentration,
};

function renderPage(id) {
  // Home page removed — redirect to dashboard
  if (id === "home") id = "dashboard";
  // SEC-ACCESS-GATE (MOST IMPORTANT): single choke point for module access.
  // Every navigation path in the app — sidebar buttons, navReset(),
  // drillNavigate(), overview cards, material-code drilldowns, phantom
  // links, "View at-risk" jumps, etc. — ends up calling renderPage(), so
  // gating it here is what actually enforces permissions rather than just
  // hiding buttons. Admin always passes (canAccessModule() returns true
  // for Admin). If the check fails: don't touch currentPage, don't show
  // or render the page, just toast and bail out.
  if (typeof canAccessModule === "function" && !canAccessModule(id)) {
    // REDIRECT-NOT-DENY: instead of blocking with an "access denied"
    // message, send the user straight to the first module their role /
    // sidebar_permissions actually grant. This is what makes login (which
    // defaults to "dashboard") work for a role that doesn't include
    // Dashboard — they land on their own module instead of a denial.
    // Guard against redirecting to the same id (shouldn't happen, since
    // firstAccessibleModule() only returns ids canAccessModule() allows,
    // but this keeps renderPage() from ever recursing on itself).
    const fallback = (typeof firstAccessibleModule === "function") ? firstAccessibleModule() : null;
    if (fallback && fallback !== id) {
      console.warn(`Redirecting "${id}" → "${fallback}" — user lacks permission for "${id}".`);
      renderPage(fallback);
      return;
    }
    // BUGFIX-QUICK-LOOKUP-ONLY: firstAccessibleModule() only knows about
    // renderPage() targets (NAVIGABLE_MODULE_KEYS) — Quick Lookup and its
    // three sub-tools (Who's Responsible / Shelf Life Look-up / New
    // Received Stock) are deliberately excluded from that list because
    // they navigate through showGroupOverview() (index.html) instead of
    // renderPage(). That meant a user whose ONLY granted module was Quick
    // Lookup (or just one of its sub-tools) fell straight through to the
    // "no modules assigned" toast below, even though they do have an
    // accessible module — renderPage() just didn't know how to reach it.
    // Before giving up, try sending them to Quick Lookup by clicking its
    // sidebar title, which already re-checks canAccessModule("quick-lookup")
    // itself and applies the correct highlighting/expansion.
    if (typeof canAccessModule === "function" && canAccessModule("quick-lookup")) {
      const qlTitle = document.querySelector('#quick-lookup-group .nav-group-title');
      if (qlTitle) {
        console.warn(`Redirecting "${id}" → "quick-lookup" — user has no renderPage() module but does have Quick Lookup.`);
        qlTitle.click();
        return;
      }
    }
    // No accessible module at all — nothing to redirect to, so this is the
    // one case that still needs a message rather than a silent no-op.
    if (typeof showNoModulesAssignedToast === "function") {
      showNoModulesAssignedToast();
    } else if (typeof showAccessDeniedToast === "function") {
      showAccessDeniedToast();
    }
    console.warn(`Blocked navigation to "${id}" — user has no accessible modules.`);
    return;
  }
  // Pending Dispatch, MOS by Plant, National Stock & MOS, and Request
  // Analysis each have their own independent dataset (STATE.rows /
  // mosMerged / reqRows) and their own empty-state placeholder, so —
  // unlike every other page here — they don't need the main inventory
  // file (rawDf) loaded first. Without this exemption, clicking their nav
  // button did nothing at all until inventory was uploaded. (This used to
  // be implemented by each module monkey-patching window.renderPage with
  // its own unguarded copy of this function — which also bypassed the
  // canAccessModule() check above. Listing them here instead means they
  // stay covered by the single gated renderPage.)
  const RAWDF_EXEMPT_PAGES = ["pending-dispatch", "mos-plant", "natl-table", "request-analysis", "branch-demand"];
  if (!rawDf.length && !RAWDF_EXEMPT_PAGES.includes(id)) return;
  currentPage = id;
  // BUG-MOS-STALE-FIX: drop the Branch-Comparison-material-tab refresh hook
  // whenever we navigate to a different page, so populatePersonFilter() never
  // calls back into a refreshMaterialView() closure whose DOM elements (e.g.
  // #mat-metric) no longer exist. renderMaterialTab() re-sets this itself if
  // Branch Comparison is (re)opened.
  if (id !== "branch") window._activeBranchMatRefresh = null;
  // Hide the pre-data landing splash whenever any page is shown
  document.getElementById("landingView").style.display = "none";
  document.querySelectorAll(".page").forEach(el => { el.style.display = "none"; });
  const pg = document.getElementById(`page-${id}`);
  if (pg) pg.style.display = "block";
  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.page === id));
  try {
    PAGE_RENDERERS[id]?.();
  } catch(e) {
    console.error(`Error rendering ${id}:`, e);
    // Show a friendly in-page error rather than a blank page
    if (pg) pg.innerHTML = `<div class="alert-danger" style="margin-top:2rem">
      ⚠️ An error occurred while rendering this page: <b>${escHtml(e.message)}</b>
      <br><small style="opacity:0.7">Check the browser console for details.</small>
    </div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  // Dashboard is the default page (Home removed)

  // Nav
  document.querySelectorAll(".nav-btn[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.page;
      navReset(target);
    });
  });

  // File upload
  document.getElementById("fileInput").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) loadFile(f);
    // FIX-FILE-RESET: reset value so the same file can be re-uploaded (e.g. after editing)
    e.target.value = "";
  });





  // Material Standardization Mapping file upload
  document.getElementById("mappingFileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (f) loadMappingFile(f);
    e.target.value = "";
  });

  // Stock-in-Transit verification file upload (session-only; gates the Transit page)
  document.getElementById("transitFileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (f) loadTransitFile(f);
    e.target.value = "";
  });



  // Expiry window radio
  document.getElementById("expiry-window-group").addEventListener("change", () => {
    if (rawDf.length && currentPage === "expiry") renderExpiry();
  });

  // ── Page filter wiring (event delegation) ──────────────────────────────
  // Uses document-level delegation so listeners survive any DOM rebuild
  // (e.g. the renderPage error path replaces pg.innerHTML entirely).
  // Each Apply/Clear button is identified by its stable ID.

  const PAGE_FILTER_MAP = {
    "dash-filter-apply":    { page:"dashboard", plantWrap:"ms-dash-plant",    mgWrap:"ms-dash-mg",    vtWrap:"ms-dash-vt",    matWrap:null,             action:"apply" },
    "dash-filter-clear":    { page:"dashboard", plantWrap:"ms-dash-plant",    mgWrap:"ms-dash-mg",    vtWrap:"ms-dash-vt",    matWrap:null,             action:"clear" },
    "transit-filter-apply": { page:"transit",   plantWrap:"ms-transit-plant", mgWrap:"ms-transit-mg", vtWrap:"ms-transit-vt", matWrap:"ms-transit-mat", action:"apply" },
    "transit-filter-clear": { page:"transit",   plantWrap:"ms-transit-plant", mgWrap:"ms-transit-mg", vtWrap:"ms-transit-vt", matWrap:"ms-transit-mat", action:"clear" },
    "expiry-filter-apply":  { page:"expiry",    plantWrap:"ms-expiry-plant",  mgWrap:"ms-expiry-mg",  vtWrap:"ms-expiry-vt",  matWrap:"ms-expiry-mat",  action:"apply" },
    "expiry-filter-clear":  { page:"expiry",    plantWrap:"ms-expiry-plant",  mgWrap:"ms-expiry-mg",  vtWrap:"ms-expiry-vt",  matWrap:"ms-expiry-mat",  action:"clear" },
    "qc-filter-apply":      { page:"qc",        plantWrap:"ms-qc-plant",      mgWrap:"ms-qc-mg",      vtWrap:"ms-qc-vt",      matWrap:"ms-qc-mat",      action:"apply" },
    "qc-filter-clear":      { page:"qc",        plantWrap:"ms-qc-plant",      mgWrap:"ms-qc-mg",      vtWrap:"ms-qc-vt",      matWrap:"ms-qc-mat",      action:"clear" },

    "conc-filter-apply":    { page:"concentration", plantWrap:null,               mgWrap:"ms-conc-mg",    vtWrap:"ms-conc-vt",    matWrap:null,             action:"apply" },
    "conc-filter-clear":    { page:"concentration", plantWrap:null,               mgWrap:"ms-conc-mg",    vtWrap:"ms-conc-vt",    matWrap:null,             action:"clear" },
  };

  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("button[id]");
    if (!btn) return;
    const cfg = PAGE_FILTER_MAP[btn.id];
    if (!cfg) return;
    if (!rawDf.length) return;

    e.stopPropagation();
    // Close any open dropdowns first
    document.querySelectorAll(".ms-wrap.open").forEach(w => w.classList.remove("open"));

    if (cfg.action === "apply") {
      if (cfg.plantWrap) {
        const wrap = document.getElementById(cfg.plantWrap);
        pageFilters[cfg.page].plants = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
      if (cfg.mgWrap) {
        const wrap = document.getElementById(cfg.mgWrap);
        pageFilters[cfg.page].mgs = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
      if (cfg.vtWrap) {
        const wrap = document.getElementById(cfg.vtWrap);
        pageFilters[cfg.page].valTypes = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
      if (cfg.matWrap) {
        const wrap = document.getElementById(cfg.matWrap);
        pageFilters[cfg.page].materials = (wrap && wrap._getSelected) ? wrap._getSelected() : [];
      }
    } else {
      if (cfg.plantWrap) {
        pageFilters[cfg.page].plants = [];
        const wrap = document.getElementById(cfg.plantWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
      if (cfg.mgWrap) {
        pageFilters[cfg.page].mgs = [];
        const wrap = document.getElementById(cfg.mgWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
      if (cfg.vtWrap) {
        pageFilters[cfg.page].valTypes = [];
        const wrap = document.getElementById(cfg.vtWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
      if (cfg.matWrap) {
        pageFilters[cfg.page].materials = [];
        const wrap = document.getElementById(cfg.matWrap);
        if (wrap && wrap._clearSelected) wrap._clearSelected();
      }
    }
    renderPage(cfg.page);
  });

});

// ── GLOBAL MATERIAL SEARCH ─────────────────────────────────────────────────
(function () {
  function fmt(n) {
    if (n == null || isNaN(+n)) return "—";
    return (+n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // FIX-R6: added export buttons so users always have a download path, not just
  // when results are truncated past 200 rows.
  // BUG-FIX-1: renamed from buildTable → gsrBuildTable to avoid collision with the
  // global buildTable at line 582 (different signatures: rowClass fn vs exportFilename str).
  // exportCols (optional) lets callers supply plain-text column defs for CSV/Excel
  // export — display cols often use raw:true/fmt to render HTML badges/links,
  // which would leak markup into a spreadsheet if exported as-is. When omitted,
  // falls back to display cols (fine for plain text-only column sets).
  function gsrBuildTable(rows, cols, exportFilename, exportCols) {
    if (!rows.length) return '<p class="gsr-no-data">No matching records found.</p>';
    let html = '<div class="tbl-wrap"><table><thead><tr>';
    cols.forEach(c => { html += `<th>${escHtml(c.label)}</th>`; });
    html += "</tr></thead><tbody>";
    rows.slice(0, 200).forEach(r => {
      html += "<tr>";
      cols.forEach(c => {
        const rawVal = r[c.key] ?? "";
        const display = c.fmt ? c.fmt(rawVal, r) : rawVal;
        const val = c.raw ? display : escHtml(String(display ?? ""));
        const cls = (c.cellClass || c.cls) ? ` class="${c.cellClass || c.cls}"` : "";
        html += `<td${cls}>${val}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table></div>";

    const safeFile  = exportFilename || "search_results.csv";
    const baseName   = safeFile.replace(/\.csv$/i, "");
    const safeId     = baseName.replace(/\W/g, "_");
    const csvFile    = baseName + ".csv";
    const xlsxFile   = baseName + ".xlsx";
    const colsForExport = exportCols || cols;
    const noteText   = rows.length > 200 ? `Showing first 200 of ${rows.length} rows. ` : "";

    html += `<p class="gsr-no-data" style="margin-top:0.4rem">
      ${noteText}
      <button id="gsr-export-csv-${safeId}" class="dl-btn" style="font-size:0.72rem;padding:3px 10px;margin-left:6px">⬇ CSV (${rows.length} rows)</button>
      <button id="gsr-export-xlsx-${safeId}" class="dl-btn" style="font-size:0.72rem;padding:3px 10px;margin-left:6px">⬇ Excel (${rows.length} rows)</button>
    </p>`;
    // Wire export after insertion via a deferred data attribute approach
    setTimeout(() => {
      const csvBtn  = document.getElementById(`gsr-export-csv-${safeId}`);
      const xlsxBtn = document.getElementById(`gsr-export-xlsx-${safeId}`);
      if (csvBtn)  csvBtn.addEventListener("click",  () => downloadCSV(rows,   colsForExport, csvFile),  { once: true });
      if (xlsxBtn) xlsxBtn.addEventListener("click", () => downloadExcel(rows, colsForExport, xlsxFile), { once: true });
    }, 0);
    return html;
  }

  function showResultsPanel() {
    document.getElementById("global-search-results-panel").style.display = "block";
  }
  function hideResultsPanel() {
    document.getElementById("global-search-results-panel").style.display = "none";
  }

  function runSearch() {
    const q = (document.getElementById("global-search-input").value || "").trim().toLowerCase();
    const out = document.getElementById("global-search-results");
    if (!q) { out.innerHTML = ""; hideResultsPanel(); return; }

    // ── In-Stock results ──
    // FIX-SEARCH-MAPPED: use the reconciled base (mappedDf when mapping is active)
    // so search matches on standardized material codes/descriptions, and aggregate
    // per-material so the quantities shown match the QC/Dashboard KPIs exactly.
    const base = getReconciledBase();
    const stockRowsRaw = base.filter(r => {
      const code     = String(r._mappedMaterial || r["Material"] || "").toLowerCase();
      const origCode = String(r["Material"] || "").toLowerCase();
      const desc     = String(r._mappedDesc || r["Material Description"] || "").toLowerCase();
      return code.includes(q) || origCode.includes(q) || desc.includes(q);
    });
    // Aggregate to match what QC/Dashboard pages show (one row per canonical material)
    const stockRows = aggregateByMappedMaterial(stockRowsRaw);

    const stockCols = [
      { key: "Material", label: "Material Code", fmt:(val,r)=>renderMappedMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
      { key: "Material Description", label: "Material Description", fmt:(val,r)=>renderMappedMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
      { key: "_plantList",           label: "Plant(s)" },
      { key: "Material Group Name",  label: "Material Group" },
      { key: "Unrestricted Stock",   label: "Unrestricted Qty",  fmt: fmtQty, rawKey: "Unrestricted Stock",              cls: "col-qty" },
      { key: "Stock in Quality Inspection", label: "QC Qty",     fmt: fmtQty, rawKey: "Stock in Quality Inspection",     cls: "col-qty" },
      { key: "Value of Unrestricted Stock", label: "Value (ETB)",fmt: fmtETB, rawKey: "Value of Unrestricted Stock",     cls: "col-val" },
    ];
    const stockExportCols = [
      { key: "Material",             label: "Material Code" },
      { key: "Material Description", label: "Material Description" },
      { key: "_plantList",           label: "Plant(s)" },
      { key: "Material Group Name",  label: "Material Group" },
      { key: "Unrestricted Stock",          label: "Unrestricted Qty" },
      { key: "Stock in Quality Inspection", label: "QC Qty" },
      { key: "Value of Unrestricted Stock", label: "Value (ETB)" },
    ];

    // ── Transit results (from uploaded Stock-in-Transit verification file) ──
    const transitCols = [
      { key: "_st_material", label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
      { key: "_st_desc",     label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
      { key: "_st_plant",    label: "Plant" },
      { key: "_st_qty",      label: "Qty", cls: "col-qty" },
      { key: "_st_uom",      label: "UoM" },
    ];
    const transitExportCols = [
      { key: "_st_material", label: "Material Code" },
      { key: "_st_desc",     label: "Material Description" },
      { key: "_st_plant",    label: "Plant" },
      { key: "_st_qty",      label: "Qty" },
      { key: "_st_uom",      label: "UoM" },
    ];
    const transitRows = TRANSIT_UPLOAD_LIST.filter(r => {
      const q = String(query).toUpperCase();
      return r.materialCode.toUpperCase().includes(q);
    }).map(r => ({
      _st_material: r.materialCode,
      _st_desc:     r.desc || "",
      _st_plant:    r.plantCode,
      _st_qty:      r.qty,
      _st_uom:      r.uom || "",
    }));

    // ── Also search "Stock in Transit" column in main data ──
    // FIX-PHANTOM-SEARCH: exclude phantom rows (no PO/supplying plant) from search results
    const inTransitMain = base.filter(r => {
      const code = String(r["Material"] || "").toLowerCase();
      const desc = String(r["Material Description"] || "").toLowerCase();
      const hasTransit = parseFloat(r["Stock in Transit"] || 0) > 0;
      const isPhantom  = r._phantomTransitQty > 0;
      return hasTransit && !isPhantom && (code.includes(q) || desc.includes(q));
    });

    let html = "";

    // In-Stock section
    html += `<div class="gsr-section-title">
      <span class="gsr-badge gsr-badge-stock">In Stock</span>
      ${stockRows.length} record${stockRows.length !== 1 ? "s" : ""} found
    </div>`;
    html += gsrBuildTable(stockRows, stockCols, "search_results_stock.csv", stockExportCols);

    // Transit from uploaded Stock-in-Transit verification file (if uploaded)
    if (transitFileLoaded && TRANSIT_UPLOAD_LIST.length > 0) {
      html += `<div class="gsr-section-title" style="margin-top:1.2rem">
        <span class="gsr-badge gsr-badge-transit">In Transit (Uploaded File)</span>
        ${transitRows.length} record${transitRows.length !== 1 ? "s" : ""} found
      </div>`;
      html += gsrBuildTable(transitRows, transitCols, "search_results_transit.csv", transitExportCols);
    } else if (inTransitMain.length > 0) {
      // Fallback: show in-transit column from main data
      html += `<div class="gsr-section-title" style="margin-top:1.2rem">
        <span class="gsr-badge gsr-badge-transit">In Transit (from inventory data)</span>
        ${inTransitMain.length} record${inTransitMain.length !== 1 ? "s" : ""} found
      </div>`;
      const tCols = [
        { key: "Material", label: "Material Code", fmt:(val,r)=>renderMatCode(val,r), raw:true, cellClass:"col-mat-code-wrap" },
        { key: "Material Description", label: "Material Description", fmt:(val,r)=>renderMatDesc(val,r), raw:true, cellClass:"col-mat-desc-wrap" },
        { key: "Plant",                label: "Plant" },
        { key: "Stock in Transit",     label: "Transit Qty", cls: "col-qty" },
        { key: "Value of Stock in Transit", label: "Transit Value (ETB)", cls: "col-val" },
      ];
      const tExportCols = [
        { key: "Material",             label: "Material Code" },
        { key: "Material Description", label: "Material Description" },
        { key: "Plant",                label: "Plant" },
        { key: "Stock in Transit",            label: "Transit Qty" },
        { key: "Value of Stock in Transit",   label: "Transit Value (ETB)" },
      ];
      html += gsrBuildTable(inTransitMain, tCols, "search_results_transit_main.csv", tExportCols);
    }

    out.innerHTML = html;
    showResultsPanel();
  }

  function clearSearch() {
    document.getElementById("global-search-input").value = "";
    document.getElementById("global-search-results").innerHTML = "";
    hideResultsPanel();
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("global-search-btn").addEventListener("click", runSearch);
    document.getElementById("global-search-clear").addEventListener("click", clearSearch);
    document.getElementById("global-search-input").addEventListener("keydown", e => {
      if (e.key === "Enter") runSearch();
    });
    document.getElementById("global-search-results-close").addEventListener("click", hideResultsPanel);
  });
})();
// ═══════════════════════════════════════════════════════════════════════════
// STOCK CONCENTRATION
// ═══════════════════════════════════════════════════════════════════════════
function renderConcentration() {
  // ── Build filtered dataset (no plant filter — concentration is cross-plant) ──
  const f           = pageFilters["concentration"] || {};
  const base        = getReconciledBase();
  const mgs         = f.mgs      || [];
  const valTypes    = f.valTypes || [];
  // FIX-CONC-MAP: honour mapping table state — only use _mappedMaterial as key
  // when a mapping file is actually loaded, otherwise fall back to raw Material.
  // Without this guard, unmapped rows (where _mappedMaterial === original code)
  // would be counted correctly, but the intent is unclear and inconsistent with
  // aggregateByMappedMaterial which is the canonical pattern across all pages.
  const useMapped   = mappingTable.size > 0;

  const df = base.filter(r =>
    passesUniversalExclusions(r) &&
    canAccessRow(r) &&
    String(r["Inventory Valuation Type"] || "").trim() !== "" &&
    (!mgs.length      || mgs.includes(r["Material Group Name"])) &&
    (!valTypes.length || valTypes.includes(getValuationType(r)))
  );



  if (!df.length) {
    document.getElementById("conc-kpis").innerHTML = "";
    document.getElementById("conc-analysis-cards").innerHTML = `<div class="alert-info">No data after filters.</div>`;
    document.getElementById("chart-conc-pie").innerHTML = "";
    document.getElementById("chart-conc-spread").innerHTML = "";
    _materialDrilldownCode = null; // consume — nothing to show it against
    const bannerEl = document.getElementById("conc-drill-banner");
    if (bannerEl) bannerEl.innerHTML = "";
    return;
  }

  // ── 1. Plant-level aggregation (value basis) ──
  const plantValMap = {};
  df.forEach(r => {
    const k = r["Plant Name"] || "(Blank)";
    if (!plantValMap[k]) plantValMap[k] = 0;
    plantValMap[k] += getMappedVal(r, "Value of Unrestricted Stock")
                    + getTrueTransitVal(r)
                    + getMappedVal(r, "Value of Stock in Quality Inspection");
  });
  const totalVal = Object.values(plantValMap).reduce((s, v) => s + v, 0);
  const plantValArr = Object.entries(plantValMap)
    .map(([name, val]) => ({ name, val, pct: totalVal > 0 ? (val / totalVal) * 100 : 0 }))
    .sort((a, b) => b.val - a.val);

  // ── 2. Per-material, per-plant aggregation (unrestricted qty + value) ──
  // FIX-CONC-MAP: key by _mappedMaterial only when mapping is active — this is
  // the single change that makes two SAP codes mapping to the same target drug
  // collapse into one row. Without useMapped guard they stayed separate because
  // unmapped rows' _mappedMaterial equals their original code (no merger).
  const matPlantMap = {};
  df.forEach(r => {
    const mat   = useMapped ? (r._mappedMaterial || r["Material"]) : r["Material"];
    const desc  = useMapped ? (r._mappedDesc    || r["Material Description"] || "") : (r["Material Description"] || "");
    const plant = r["Plant Name"] || "(Blank)";
    const orig  = r._origMaterial || r["Material"];
    if (!mat) return;
    if (!matPlantMap[mat]) {
      matPlantMap[mat] = {
        desc,
        plants:    {},
        totalQty:  0,
        totalVal:  0,
        origCodes: new Set(),   // FIX-CONC-MAP: track all original SAP codes merged here
      };
    }
    const qty = getMappedQty(r, "Unrestricted Stock");
    const val = getMappedVal(r, "Value of Unrestricted Stock");
    if (!matPlantMap[mat].plants[plant]) matPlantMap[mat].plants[plant] = { qty: 0, val: 0 };
    matPlantMap[mat].plants[plant].qty += qty;
    matPlantMap[mat].plants[plant].val += val;
    matPlantMap[mat].totalQty += qty;
    matPlantMap[mat].totalVal += val;
    if (orig && orig !== mat) matPlantMap[mat].origCodes.add(orig);
  });

  // ── 3. Concentration classification ──
  // For each material find the dominant plant
  const matConcentration = Object.entries(matPlantMap).map(([mat, info]) => {
    // Only count plants that actually hold positive Unrestricted Stock qty.
    // A plant can have an inventory row for this material (e.g. a batch fully
    // in QC/Blocked/Transit) with zero Unrestricted Stock — that shouldn't
    // count as "stocked at this plant" for concentration purposes, or it
    // inflates plantCount for materials that are really only at one plant.
    const activePlants = Object.entries(info.plants).filter(([, v]) => v.qty > 0);
    const plantCount = activePlants.length;
    const topPlant   = [...activePlants]
      .sort((a, b) => b[1].qty - a[1].qty)[0];
    const topPlantName = topPlant ? topPlant[0] : "—";
    const topQty       = topPlant ? topPlant[1].qty : 0;
    const topVal       = topPlant ? topPlant[1].val : 0;
    const pctQty       = info.totalQty > 0 ? (topQty / info.totalQty) * 100 : 0;
    const pctVal       = info.totalVal > 0 ? (topVal / info.totalVal) * 100 : 0;
    const origCodes    = [...info.origCodes].sort().join(", ");
    return { mat, desc: info.desc, plantCount, topPlantName, topQty, topVal, pctQty, pctVal, totalQty: info.totalQty, totalVal: info.totalVal, origCodes, _plants: Object.fromEntries(activePlants) };
  }).filter(r => r.totalQty > 0); // only materials with unrestricted stock

  // ── 3b. MOS-based exclusion for "Sole Branch" ────────────────────────────
  // A material sitting >80% in one plant only counts as a genuine sole-branch
  // supply-chain RISK if that stock is actually going to sit there a while.
  // If ANY plant holding the material has MOS < 1 month (it's moving fast —
  // about to be consumed within weeks), it isn't a meaningful concentration
  // risk in the same sense, so we exclude it from the Sole Branch bucket.
  // Requires AMC.xlsx (mos.js) to be loaded; if it isn't, no exclusion is
  // applied and behaviour is unchanged from before.
  const hasMosData = typeof mosMerged !== "undefined" && mosMerged.length > 0
                   && typeof computeRowMOS === "function" && typeof buildMosSohMap === "function";

  let anyPlantMosBelow1mo = () => false; // no-op when AMC data isn't loaded

  if (hasMosData) {
    // Plant Name → Plant code lookup (matPlantMap is keyed by friendly name;
    // AMC/MOS data is keyed by plant code, e.g. "AA01").
    const nameToCode = {};
    if (typeof rawDf !== "undefined") {
      for (const r of rawDf) {
        const name = r["Plant Name"];
        const code = String(r["Plant"] || "").trim().toUpperCase();
        if (name && code && !nameToCode[name]) nameToCode[name] = code;
      }
    }

    const sohMap   = buildMosSohMap();
    const mosByMat = new Map(mosMerged.map(r => [r.code, r])); // canonical code → AMC row

    anyPlantMosBelow1mo = (mat, plantNames) => {
      const amcRow = mosByMat.get(mat);
      if (!amcRow) return false; // material not present in AMC file — nothing to check
      const plantMos = computeRowMOS(amcRow, sohMap); // [{plant, soh, amc, mos, isHub}]
      return plantNames.some(pname => {
        const code = nameToCode[pname];
        if (!code) return false;
        const entry = plantMos.find(p => p.plant === code);
        return !!entry && entry.mos !== null && entry.mos !== Infinity && entry.mos < 1;
      });
    };
  }

  matConcentration.forEach(r => {
    r._mosExcluded = hasMosData ? anyPlantMosBelow1mo(r.mat, Object.keys(r._plants)) : false;
  });

  // Band classification
  const sole   = matConcentration.filter(r => r.pctQty >= 80 && !r._mosExcluded);  // >80% in one plant, excluding fast-moving (MOS<1mo) items
  const few    = matConcentration.filter(r => r.pctQty < 80 && r.plantCount >= 2 && r.plantCount <= 4);
  const spread = matConcentration.filter(r => r.pctQty < 80 && r.plantCount >= 5 && r.plantCount <= 8);
  const wide   = matConcentration.filter(r => r.pctQty < 80 && r.plantCount > 8);
  const soleExcludedCount = matConcentration.filter(r => r.pctQty >= 80 && r._mosExcluded).length;

  // ── MATERIAL DRILLDOWN BANNER ──────────────────────────────────────────────
  // Consumed once: set by clicking any material code elsewhere in the app
  // (renderMatCode / renderMappedMatCode, or a page's own cell that opts in
  // with data-drill-mat — see goToMaterialConcentration in the global click
  // handler near the top of this file). Shows this material's concentration
  // profile regardless of which band it falls in — a material can look fine
  // nationally (e.g. on Stockout Risk) while actually sitting almost entirely
  // at one plant — plus a one-click hop on to Branch Comparison for it.
  const drillCode    = _materialDrilldownCode;
  _materialDrilldownCode = null; // one-shot
  const drillBannerEl = document.getElementById("conc-drill-banner");
  if (drillBannerEl) {
    if (!drillCode) {
      drillBannerEl.innerHTML = "";
    } else {
      const codeUp = drillCode.trim().toUpperCase();
      const info = matConcentration.find(r =>
        r.mat.trim().toUpperCase() === codeUp ||
        (r.origCodes && r.origCodes.split(", ").some(c => c.trim().toUpperCase() === codeUp))
      );
      if (!info) {
        drillBannerEl.innerHTML = `<div class="alert-info" style="margin-bottom:0.9rem;display:flex;align-items:center;justify-content:space-between;gap:0.6rem;flex-wrap:wrap">
          <span>No unrestricted stock found for <b>${escHtml(drillCode)}</b> under the current filters — nothing to show in Stock Concentration.</span>
          <button type="button" id="conc-drill-clear" class="apply-btn secondary small" style="padding:0.2rem 0.6rem">✕ Clear</button>
        </div>`;
      } else {
        const band = info.pctQty >= 80        ? { label: "Sole Branch",     color: "red"   }
                   : info.plantCount <= 4      ? { label: "Few Branches",    color: "amber" }
                   : info.plantCount <= 8      ? { label: "Moderate Spread", color: "amber" }
                   :                             { label: "Wide Spread",     color: "green" };
        drillBannerEl.innerHTML = `<div class="alert-info" style="margin-bottom:0.9rem">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.6rem;flex-wrap:wrap">
            <span>Showing Stock Concentration for <b class="col-mat-code">${escHtml(info.mat)}</b> — ${escHtml(info.desc || "")}</span>
            <button type="button" id="conc-drill-clear" class="apply-btn secondary small" style="padding:0.2rem 0.6rem">✕ Clear</button>
          </div>
          <div style="margin-top:0.6rem;display:flex;gap:1.4rem;flex-wrap:wrap;font-size:0.78rem">
            <span>Band: <b style="color:var(--${band.color})">${band.label}</b></span>
            <span>Dominant plant: <b>${escHtml(info.topPlantName)}</b></span>
            <span>% of qty in top plant: <b>${info.pctQty.toFixed(1)}%</b></span>
            <span>Plants stocking it: <b>${info.plantCount}</b></span>
            <span>Total qty: <b>${fmtQty(info.totalQty)}</b></span>
          </div>
          <div style="margin-top:0.7rem">
            <button type="button" id="conc-drill-to-branch" class="apply-btn small" data-mat="${escHtml(info.mat)}">↪ View in Branch Comparison</button>
          </div>
        </div>`;
      }
    }
  }

  // ── KPIs ──
  const topPlantPct = plantValArr.length > 0 ? plantValArr[0].pct : 0;
  const totalMats   = matConcentration.length;
  // FIX-CONC-MAP: count unique materials by mapped code when mapping is active
  const uniqueMatCount = useMapped
    ? new Set(df.map(r => r._mappedMaterial || r["Material"])).size
    : new Set(df.map(r => r["Material"])).size;
  setKpis("conc-kpis", [
    ["Total Unique Plants",      new Set(df.map(r => r["Plant Name"])).size.toLocaleString(),        "With unrestricted stock",       "blue"],
    ["Sole-Branch Materials",    sole.length.toLocaleString(),   `${totalMats > 0 ? ((sole.length/totalMats)*100).toFixed(0) : 0}% of materials${soleExcludedCount ? ` · ${soleExcludedCount} excluded (MOS&lt;1mo)` : ""}`,  "red"],
    ["Few-Branch Materials",     few.length.toLocaleString(),    "Held in 2–4 plants",               "amber"],
    ["Top Plant Share",          topPlantPct.toFixed(1) + "%",   plantValArr[0]?.name || "—",        "purple"],
    ["Unique Materials Tracked", uniqueMatCount.toLocaleString(), useMapped ? "Standardized (merged)" : "Unrestricted stock only", "green"],
  ]);

  // ── Pie chart: value by plant ──
  const pieLabels = plantValArr.map(r => r.name);
  const pieVals   = plantValArr.map(r => r.val);
  const pieText   = plantValArr.map(r => `${r.pct.toFixed(1)}%`);
  Plotly.newPlot("chart-conc-pie", [{
    type: "pie",
    labels: pieLabels,
    values: pieVals,
    text:   pieText,
    textinfo: "label+percent",
    hovertemplate: "<b>%{label}</b><br>ETB %{value:,.0f}<br>%{percent}<extra></extra>",
    hole: 0.38,
    marker: { colors: COLORWAY },
    textfont: { size: 11 },
  }], pl({
    height: 300,
    margin: { l: 10, r: 10, t: 10, b: 10 },
    showlegend: false,
  }), PLOTLY_CONFIG);

  // ── Table/popup data for ALL FOUR bands (sole/few/spread/wide) — built
  //    BEFORE the cards so each card's click handler and the "Highly
  //    Concentrated Items" table below can share the exact same rows/cols
  //    instead of recomputing (and risking the views drifting apart). ──
  const concCols = [
    { key: "mat",         label: "Material Code",    fmt: (v, r) => renderMatCode(r.Material, r), raw: true, cellClass: "col-mat-code-wrap" },
    { key: "desc",        label: "Description",      fmt: (v)    => `<span class="col-mat-desc">${escHtml(String(v||""))}</span>`, raw: true, cellClass: "col-mat-desc-wrap" },
    { key: "topPlantName",label: "Dominant Plant",   fmt: (v)    => `<span class="conc-plant-pill" title="${escHtml(String(v||""))}">${escHtml(String(v||""))}</span>`, raw: true },
    { key: "topQty",      label: "Qty in Plant",     fmt: fmtQty, rawKey: "topQty",   cellClass: "col-qty" },
    { key: "totalQty",    label: "Total Qty",        fmt: fmtQty, rawKey: "totalQty", cellClass: "col-qty" },
    { key: "totalVal",    label: "Total Value (ETB)",fmt: fmtETB, rawKey: "totalVal", cellClass: "col-val" },
    { key: "plantCount",  label: "Plants Holding It",fmt: (v)    => `<span class="conc-plant-pill">${Number(v).toLocaleString()}</span>`, raw: true },
    {
      key: "pctQty",
      label: "% of Qty in Top Plant",
      fmt: (v) => {
        const cls = v >= 95 ? "critical" : v >= 80 ? "high" : "";
        return cls ? `<span class="conc-pct-badge ${cls}">${Number(v).toFixed(1)}%</span>` : `${Number(v).toFixed(1)}%`;
      },
      raw: true,
    },
  ];

  // Build plain objects for buildTable/downloadCSV/downloadExcel out of a
  // matConcentration-shaped array.
  // FIX-CONC-STD: attach mapping fields so renderMatCode delegates to
  // renderMappedMatCode_early and shows the STD badge just like every other page.
  // A row is "mapped" when mapping is active AND it has at least one original
  // SAP code that differs from the target (i.e. it merged ≥1 source code).
  function toConcRows(arr) {
    return [...arr].sort((a, b) => b.totalVal - a.totalVal).map(r => {
      const hasMergedCodes = useMapped && r.origCodes && r.origCodes.length > 0;
      return {
        mat:             r.mat,
        // The "Material" key is what renderMatCode reads as `val` (first arg)
        Material:        r.mat,
        desc:            r.desc,
        origCodes:       r.origCodes || "",
        topPlantName:    r.topPlantName,
        topQty:          r.topQty,
        totalQty:        r.totalQty,
        totalVal:        r.totalVal,
        pctQty:          r.pctQty,
        plantCount:      r.plantCount,
        // Mapping display fields — mirror what applyMaterialMapping stamps on rows
        _isMapped:       hasMergedCodes,
        _mappedMaterial: r.mat,
        _origMaterial:   hasMergedCodes ? r.origCodes.split(", ")[0] : r.mat,
        _mappedDesc:     r.desc,
        _origDesc:       "",
      };
    });
  }

  const soleRows   = toConcRows(sole);
  const fewRows    = toConcRows(few);
  const spreadRows = toConcRows(spread);
  const wideRows   = toConcRows(wide);

  // ── Concentration Analysis Cards ──
  function bandCard(cls, icon, count, label, desc, clickId) {
    // clickId, when given, makes the card a keyboard-and-mouse-clickable
    // affordance that opens a popup listing the underlying materials.
    const clickAttrs = clickId
      ? ` id="${clickId}" role="button" tabindex="0" style="cursor:pointer" title="Click to see these ${count} material(s), and which plant each is concentrated in"`
      : "";
    return `<div class="conc-band-card ${cls}"${clickAttrs}>
      <div class="conc-band-icon">${icon}</div>
      <div class="conc-band-count">${count}</div>
      <div class="conc-band-label">${label}</div>
      <div class="conc-band-desc">${desc}</div>
    </div>`;
  }
  document.getElementById("conc-analysis-cards").innerHTML = `
    <div class="conc-analysis-grid">
      ${bandCard("sole",   "🔴", sole.length,   "Sole Branch",   ">80% of stock in a single plant — high supply-chain risk", "conc-band-sole")}
      ${bandCard("few",    "🟠", few.length,    "Few Branches",  "Spread across 2–4 plants — limited redundancy", "conc-band-few")}
      ${bandCard("spread", "🟡", spread.length, "Moderate Spread","Across 5–8 plants — reasonable distribution", "conc-band-spread")}
      ${bandCard("wide",   "🟢", wide.length,   "Wide Spread",   "Across 9+ plants — well distributed", "conc-band-wide")}
    </div>
    <div style="margin-top:0.85rem;font-size:0.7rem;color:var(--dim);line-height:1.5">
      Classification based on <b>% of total unrestricted quantity</b> held by the top plant per material.
      <br>Sole Branch threshold: ≥80% in one plant. Items with MOS &lt; 1 month at any holding plant are excluded (fast-moving, not a real concentration risk).
    </div>`;

  // ── Each band card → popup listing its items + their dominant plant % ──
  // Reuses the shared showChartDrillModal() shell (same look as every other
  // chart-click popup in the app). This is the only place Sole Branch items
  // are listed now that the standalone "Highly Concentrated Items" table has
  // been removed (redundant with this card's own drilldown).
  const BAND_MODAL_CONFIG = [
    { id: "conc-band-sole",   icon: "🔴", label: "Sole-Branch Materials",    rows: soleRows,   desc: "≥80% of stock concentrated in a single plant",         critical: true  },
    { id: "conc-band-few",    icon: "🟠", label: "Few-Branch Materials",     rows: fewRows,    desc: "Spread across 2–4 plants — limited redundancy",         critical: false },
    { id: "conc-band-spread", icon: "🟡", label: "Moderate-Spread Materials",rows: spreadRows, desc: "Spread across 5–8 plants — reasonable distribution",    critical: false },
    { id: "conc-band-wide",   icon: "🟢", label: "Wide-Spread Materials",    rows: wideRows,   desc: "Spread across 9+ plants — well distributed",            critical: false },
  ];
  BAND_MODAL_CONFIG.forEach(band => {
    const el = document.getElementById(band.id);
    if (!el) return;
    const openModal = () => {
      showChartDrillModal({
        title: `${band.icon} ${band.label}`,
        meta: `${band.rows.length.toLocaleString()} material${band.rows.length !== 1 ? "s" : ""} · ${band.desc}`,
        rows: band.rows,
        cols: concCols,
        rowClass: band.critical ? (row => row.pctQty >= 95 ? "row-critical" : "row-warning") : undefined,
        filenameBase: band.id.replace("conc-band-", "") + "_branch_materials",
      });
    };
    el.addEventListener("click", openModal);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openModal(); }
    });
  });

  // ── Branch Spread Bar Chart ──
  // Count materials by number of plants they occupy
  const spreadCountMap = {};
  matConcentration.forEach(r => {
    const k = r.plantCount;
    spreadCountMap[k] = (spreadCountMap[k] || 0) + 1;
  });
  const spreadKeys  = Object.keys(spreadCountMap).map(Number).sort((a, b) => a - b);
  const spreadCounts = spreadKeys.map(k => spreadCountMap[k]);
  const spreadColors = spreadKeys.map(k =>
    k === 1 ? "#f85149" : k <= 4 ? "#ffa657" : k <= 8 ? "#d29922" : "#3fb950"
  );

  const spreadLabels = spreadKeys.map(k =>
    k === 1 ? "1 plant\n(sole)" : `${k} plant${k > 1 ? "s" : ""}`
  );

  // Build a lookup: plantCount → array of material codes (used by click handler)
  const _spreadByPlantCount = {};
  matConcentration.forEach(r => {
    if (!_spreadByPlantCount[r.plantCount]) _spreadByPlantCount[r.plantCount] = [];
    _spreadByPlantCount[r.plantCount].push(r.mat);
  });
  Plotly.newPlot("chart-conc-spread", [{
    type: "bar",
    x: spreadLabels,
    y: spreadCounts,
    marker: {
      color: spreadColors,
      line: { color: "rgba(255,255,255,0.15)", width: 1 },
    },
    hovertemplate: "<b>%{x}</b><br>%{y} material(s)<br><i>Click to explore in Branch Comparison →</i><extra></extra>",
    text: spreadCounts,
    textposition: "outside",
    textfont: { size: 10 },
    customdata: spreadKeys,   // parallel array: raw plant-count number for each bar
  }], pl({
    height: 300,
    margin: { l: 20, r: 20, t: 30, b: 70 },
    xaxis: { title: { text: "Number of plants stocking the material  ·  Click a bar to explore in Branch Comparison →", font: { size: 10 } }, tickfont: { size: 10 } },
    yaxis: { title: { text: "Materials", font: { size: 10 } }, tickformat: ",d" },
    showlegend: false,
  }), PLOTLY_CONFIG);

  // ── Drilldown: clicking a bar navigates to Branch Comparison ──────────────
  // We attach the listener to the Plotly div directly; the handler is replaced on
  // every renderConcentration() call so stale closures over old data never fire.
  const spreadDiv = document.getElementById("chart-conc-spread");
  // Plotly sets cursor to 'pointer' on bar hover automatically but we make it
  // explicit so users see the affordance even before hovering over a bar.
  spreadDiv.style.cursor = "pointer";

  spreadDiv.on("plotly_click", function(eventData) {
    const pt = eventData && eventData.points && eventData.points[0];
    if (!pt) return;

    // pt.customdata is the raw plantCount number we stored above
    const clickedCount = pt.customdata;
    const mats = _spreadByPlantCount[clickedCount];
    if (!mats || !mats.length) return;

    // Stash drilldown payload so renderBranch can read it after navigation
    _lastSpreadDrilldown = { plantCount: clickedCount, matCodes: mats };

    // Navigate to Branch Comparison — renderPage calls renderBranch() which
    // rebuilds the DOM; we hook in once the tab/filter UI is ready.
    drillNavigate("branch");
  });
}
