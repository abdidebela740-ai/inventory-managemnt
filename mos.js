// =============================================================================
// PharmaTrack v2 — mos.js
// MOS by Plant: Months of Stock = Stock-on-Hand ÷ Average Monthly Consumption.
//
// HO01 SPECIAL CASE
// -----------------
// HO01 is the central distribution hub. It does not consume stock itself —
// it only holds and ships it out to the 18 branch plants. So HO01 has no
// "AMC" of its own in any meaningful sense (its AMC column, if present in
// AMC.xlsx, is null/blank for every item).
//
// Using HO01's own (non-existent) consumption would make its MOS undefined
// or infinite, which tells a planner nothing useful. What actually matters
// operationally is: "how long can HO01 keep the whole network supplied at
// current demand?" So for HO01 specifically:
//
//     HO01 MOS = HO01 stock-on-hand ÷ SUM of every branch plant's AMC
//
// For every other (branch) plant, MOS uses the normal formula:
//
//     Plant MOS = Plant stock-on-hand ÷ that plant's own AMC
//
// Requires: script.js (fmtQty, escHtml, buildTable, downloadCSV, downloadExcel,
//           mappingTable, PLOTLY_LAYOUT, PLOTLY_CONFIG, waitForPlotly, rawDf,
//           PAGE_RENDERERS, renderPage, currentPage)
// Must be loaded AFTER script.js.
// =============================================================================

const HUB_PLANT = "HO01"; // the distribution hub — never has its own consumption

// The only two program types this app understands.
const VALID_MOS_TYPES = ["Q", "RDF"];

// ── PROGRAM CLASSIFICATION (CDSS / Reportable) ─────────────────────────────────
// A second, independent dimension on top of Q/RDF.
//
// TYPE SOURCE OF TRUTH: the Q/RDF `type` is ALWAYS read from the main
// inventory file's own "Special Stock Type" column (Q = Health Program;
// blank, anything else, or the material not being in the inventory file at
// all, is treated as RDF). It is NEVER read from the AMC file — the AMC
// file's "PROGRAM TYPE" column only decides the CDSS/Reportable
// sub-classification layered on top:
//
//   RDF + AMC "PROGRAM TYPE" says "RDF-CDSS"           → RDF · CDSS
//   RDF + anything else (blank / not in AMC at all)    → RDF · Non-CDSS
//   Q   + AMC "PROGRAM TYPE" says "Program-Reportable"  → Program (Q) · Reportable
//   Q   + anything else (blank / not in AMC at all)    → Program (Q) · Non-Reportable
//
// Every material lands in exactly one of these four buckets — there is no
// "unclassified" case and no manual assignment step is needed, since type
// always has a deterministic answer from the inventory file.
const PROGRAM_CLASS = {
  RDF_CDSS:     "RDF-CDSS",
  RDF_NON_CDSS: "RDF-Non-CDSS",
  PROG_REPORT:  "PROGRAM-Reportable",
  PROG_NONREPT: "PROGRAM-Non-Reportable",
};
const PROGRAM_CLASS_LABELS = {
  [PROGRAM_CLASS.RDF_CDSS]:     "RDF · CDSS",
  [PROGRAM_CLASS.RDF_NON_CDSS]: "RDF · Non-CDSS",
  [PROGRAM_CLASS.PROG_REPORT]:  "Program (Q) · Reportable",
  [PROGRAM_CLASS.PROG_NONREPT]: "Program (Q) · Non-Reportable",
};

// Resolves the final { type, cls } pair for one canonical material code.
// `code` must already be the canonical (mapping-resolved) code, matching how
// `sstMap` (buildSpecialStockTypeMap) and the inventory description map are
// keyed. `rawProgramType` is whatever the AMC file's "PROGRAM TYPE" /
// "Material Type Code" cell contained for this material, verbatim (may be
// blank if the material wasn't found in the AMC file at all).
//
// LAW (per business rule): the SAME material code can legitimately be
// carried under BOTH streams at once — some units as regular RDF stock,
// others as Health-Program-funded (Q) stock — so an AMC row's OWN
// classification text is the primary signal for which stream that row
// belongs to: "RDF-..." always means RDF, "PROGRAM-..." always means Q.
// Each row is treated as-is; one stream's row is never used to overrule or
// dedupe the other. The inventory file's Special Stock Type (sstMap) is
// only a fallback for rows whose AMC text is blank/unrecognized (e.g. the
// material wasn't found in the AMC file at all), since only then is there
// no row-level signal to go on.
function resolveProgramTypeAndClass(code, rawProgramType, sstMap) {
  const norm = String(rawProgramType || "").trim().toUpperCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  const type = norm.startsWith("RDF")     ? "RDF"
             : norm.startsWith("PROGRAM") ? "Q"
             : (sstMap.get(code) === "Q" ? "Q" : "RDF");
  const cls = type === "RDF"
    ? (norm === "RDF-CDSS" ? PROGRAM_CLASS.RDF_CDSS : PROGRAM_CLASS.RDF_NON_CDSS)
    : (norm === "PROGRAM-REPORTABLE" ? PROGRAM_CLASS.PROG_REPORT : PROGRAM_CLASS.PROG_NONREPT);
  return { type, cls };
}

// code (upper) → "Q" | "RDF", derived from the main inventory file's own
// Special Stock Type column (Q = Health Program; blank/anything else = RDF).
// Used two ways for the new AMC format:
//   1. as a fallback source for the Q/RDF `type` itself when the AMC file
//      doesn't say (this new export has no "Material Type Code" column), so
//      the manual assignment prompt only fires for materials this can't
//      resolve either — not for every row in the file.
//   2. to decide which "Non-" bucket a resolved-but-unclassified RDF/Q item
//      falls into (see the defaulting pass in finishMosAmcLoad below).
function buildSpecialStockTypeMap() {
  const map = new Map();
  // FIX-CLS-PERSON-LEAK: was getReconciledBase(), which narrows to whichever
  // person is currently selected in the global filter. Special Stock Type
  // is a stable per-material fact that feeds classification (see
  // getMappingReconciledBase() in script.js for the full story) — it must
  // never depend on the person filter's state at whatever moment this
  // happened to run.
  const base = (typeof getMappingReconciledBase === "function")
    ? getMappingReconciledBase()
    : (typeof rawDf !== "undefined" ? rawDf : []);
  base.forEach(row => {
    const code = String(row._mappedMaterial || row["Material"] || "").trim().toUpperCase();
    if (!code || map.has(code)) return;
    const sst = String(row["Special Stock Type"] || "").trim().toUpperCase();
    map.set(code, sst === "Q" ? "Q" : "RDF");
  });
  return map;
}

// ── MOS STATE ────────────────────────────────────────────────────────────────
let mosAmcRaw    = [];          // parsed rows from AMC.xlsx: { code, desc, rawProgramType, person, amcs:{plant:val} }
let mosPlants    = [];          // ordered plant code list detected from AMC.xlsx
let mosMerged    = [];          // deduplicated AMC rows (mapping-aware), one per canonical material
let mosPersons   = [];          // sorted unique PERSON values from AMC.xlsx

// ── AMC FILE LOADER ───────────────────────────────────────────────────────────
function loadMosAmcFile(file) {
  const statusEl = document.getElementById("mosAmcFileStatus");
  const btnEl    = document.getElementById("mosAmcUploadBtnText");
  if (statusEl) statusEl.innerHTML = '<div class="status-loading">⏳ Parsing…</div>';

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb   = XLSX.read(e.target.result, { type: "array" });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

      if (!rows.length) throw new Error("AMC file is empty.");

      // FIX-AMC-HEADER-ALIASES: match META columns by normalized header text
      // (trim + collapse internal whitespace + uppercase) rather than exact
      // string equality. Real-world AMC exports vary the classification
      // column's name and whitespace — seen so far: "PROGRAM TYPE",
      // "Material Type Code", and " CLASSIFICATION TYPE" (leading space).
      // Before this fix, any header not hitting an exact string match (1)
      // was NOT excluded from detectedPlants, so it got misparsed as a bogus
      // plant column, and (2) was never read into rawProgramType, so every
      // material silently fell back to the "Non-CDSS"/"Non-Reportable"
      // bucket — e.g. a whole file classified as RDF-CDSS / Program-
      // Reportable would show zero materials in those filters everywhere
      // downstream (Dashboard, MOS, Branch Demand, etc.) even though the
      // data was present in the file, just under an unrecognized header.
      const normHeader = k => String(k || "").trim().toUpperCase().replace(/\s+/g, " ");
      const META_ALIASES = {
        code:  ["MATERIAL CODE"],
        desc:  ["DESCRIPTION"],
        type:  ["MATERIAL TYPE CODE"],
        // "PROGRAM TYPE" and "CLASSIFICATION TYPE" are the same concept
        // under different export names — both resolve to rawProgramType.
        cls:   ["PROGRAM TYPE", "CLASSIFICATION TYPE"],
        person:["PERSON"],
      };
      const firstRow = rows[0];
      const actualKeys = Object.keys(firstRow);
      // Map each recognized alias category to whichever actual column name
      // (verbatim, original casing/whitespace) is present in this file, if any.
      const resolvedMeta = {};
      Object.entries(META_ALIASES).forEach(([slot, aliases]) => {
        const hit = actualKeys.find(k => aliases.includes(normHeader(k)));
        if (hit) resolvedMeta[slot] = hit;
      });
      const metaKeysPresent = Object.values(resolvedMeta);
      const detectedPlants = actualKeys.filter(k => !metaKeysPresent.includes(k));
      if (!detectedPlants.length) throw new Error("No plant columns found in AMC file.");

      // Normalize plant codes the SAME way buildMosSohMap() normalizes the
      // inventory file's "Plant" column (trim + uppercase). Without this,
      // any AMC column header that isn't already exact-case (e.g. "Ho01"
      // instead of "HO01", or with stray whitespace) silently fails to
      // match the SOH map's keys, and that plant's stock is dropped to 0
      // everywhere it's looked up — including in National SOH/MOS.
      mosPlants  = detectedPlants.map(p => String(p).trim().toUpperCase());

      mosAmcRaw  = rows.map(r => {
        // FIX-AMC-CODE-CASE: uppercase here too (not just trim) — every other
        // material-code comparison in the app normalizes with
        // .trim().toUpperCase() (see FIX-MOS-MAP-CASE below and
        // BUGFIX-QC-FALSE-POSITIVE in branch-demand.js). mosFindRow()/
        // brdResolveCode() uppercase the code they search FOR, so if this
        // file's own "Material Code" column has lowercase/mixed-case values
        // (common in real SAP exports), those rows silently failed to match
        // and the material looked "Not found" on Branch Demand even though
        // it was genuinely present in the AMC upload.
        const code = String(r[resolvedMeta.code || "Material Code"] || "").trim().toUpperCase();

        // Raw classification text only — NOT used to determine Q/RDF `type`
        // anymore (see resolveProgramTypeAndClass above). Kept verbatim here
        // and matched against "RDF-CDSS" / "Program-Reportable" later, once
        // per merged material, in buildMosMerged(). Sourced from whichever
        // actual column resolvedMeta.cls found (PROGRAM TYPE / CLASSIFICATION
        // TYPE / etc. — see FIX-AMC-HEADER-ALIASES above), falling back to
        // the type-code column for older exports that use that name instead.
        const rawProgramType = String(
          (resolvedMeta.cls  && r[resolvedMeta.cls])  ||
          (resolvedMeta.type && r[resolvedMeta.type]) ||
          ""
        ).trim();

        return {
          code,
          desc:   String(r[resolvedMeta.desc || "Description"] || "").trim(),
          rawProgramType,
          person: String(r[resolvedMeta.person || "PERSON"] || "").trim(),
          amcs: Object.fromEntries(
            detectedPlants.map(p => [String(p).trim().toUpperCase(), (r[p] == null || r[p] === "" || typeof r[p] === "string") ? null : Number(r[p])])
          ),
        };
      });

      // Expose sorted unique person list for the global person filter dropdown
      mosPersons = [...new Set(mosAmcRaw.map(r => r.person).filter(Boolean))].sort();
      if (typeof populatePersonFilter === "function") populatePersonFilter(mosPersons);

      // No manual assignment step needed — type (Q/RDF) always comes from
      // the inventory file's own Special Stock Type, and classification
      // (CDSS/Reportable) is derived deterministically inside buildMosMerged
      // via resolveProgramTypeAndClass(). See finishMosAmcLoad below.
      finishMosAmcLoad(file, detectedPlants, statusEl, btnEl);

    } catch (err) {
      console.error("MOS AMC load error:", err);
      if (statusEl) statusEl.innerHTML = `<div class="status-error">⚠️ ${escHtml(err.message)}</div>`;
    }
  };
  reader.readAsArrayBuffer(file);
}

function finishMosAmcLoad(file, detectedPlants, statusEl, btnEl) {
  mosMerged = buildMosMerged();

  const count = mosMerged.length;
  const hasHub = mosPlants.includes(HUB_PLANT);
  if (statusEl) statusEl.innerHTML =
    `<div class="status-ok">✓ LOADED</div><div class="status-name">${escHtml(file.name)}</div>` +
    `<div class="status-name" style="color:var(--green)">${count} items · ${detectedPlants.length} plants</div>` +
    (hasHub ? "" : `<div class="status-name" style="color:var(--amber)">⚠️ "${HUB_PLANT}" column not found — hub MOS rule won't apply</div>`);
  if (btnEl) btnEl.textContent = "📐 Change AMC File";

  const noAmcEl  = document.getElementById("mos-no-amc");
  const contentEl = document.getElementById("mos-content");
  if (noAmcEl)  noAmcEl.style.display  = "none";
  if (contentEl) contentEl.style.display = "block";

  if (currentPage === "mos-plant") renderMosPlant();
}

// ── DESCRIPTION FALLBACK (from the main inventory file) ───────────────────────
// AMC files aren't guaranteed to carry a "Description" column at all (e.g. a
// Q/RDF-style export that only has Material Code, PROGRAM TYPE, PERSON, and
// plant columns). When the AMC row itself has no description, fall back to
// the main inventory upload's "Material Description" — keyed by the same
// canonical code (_mappedMaterial when a mapping file is loaded) buildMosSohMap()
// already uses, so this agrees with every other page's description lookup.
// Built once per buildMosMerged() call, not per row, to avoid rescanning the
// whole inventory file per material.
function buildInventoryDescMap() {
  const map = new Map();
  // FIX-CLS-PERSON-LEAK: see buildSpecialStockTypeMap() above — this feeds
  // mosMerged too and must stay person-filter-independent.
  const base = (typeof getMappingReconciledBase === "function")
    ? getMappingReconciledBase()
    : (typeof rawDf !== "undefined" ? rawDf : []);
  base.forEach(row => {
    const code = String(row._mappedMaterial || row["Material"] || "").trim();
    const desc = String(row._mappedDesc || row["Material Description"] || "").trim();
    if (code && desc && !map.has(code)) map.set(code, desc);
  });
  return map;
}

// ── DEDUPLICATION (mapping-aware) ─────────────────────────────────────────────
// Collapses multiple AMC source codes onto the same canonical target code when
// a mapping file is loaded, summing AMC per plant across duplicates — same
// approach used elsewhere in the app for inventory rows.
//
// KEYED BY CANONICAL CODE + STREAM (RDF vs Program/Q): per the LAW in
// resolveProgramTypeAndClass, a material can legitimately be carried under
// BOTH streams at once, so merging only collapses duplicate AMC rows within
// the SAME stream (e.g. two source codes mapping to one RDF target) — it
// never merges an RDF row and a Program(Q) row for the same code into one,
// since that would silently sum their AMCs together and pick only one
// rawProgramType to represent both. Downstream code that expects "a code
// can have two mosMerged rows" (see brdResolveCode/brdDedupeByOwnType in
// branch-demand.js and the type-aware lookup in mosFindRow) relies on this.
//
// Rebuilt on every AMC/inventory/mapping change (see wireMosModule below),
// so sstMap here always reflects the CURRENT inventory upload — no stale
// type/classification left over from before the inventory file loaded.
function buildMosMerged() {
  if (!mosAmcRaw.length) return [];

  const merged = new Map(); // canonicalCode → mergedRow
  const invDescMap = buildInventoryDescMap();
  const sstMap = buildSpecialStockTypeMap();

  for (const row of mosAmcRaw) {
    let canonical = row.code;
    let canonDesc = row.desc;

    if (mappingTable && mappingTable.size > 0) {
      // FIX-MOS-MAP-CASE: mappingTable's source keys are always uppercased
      // (loadMappingFile does src.toUpperCase()), but row.code is the AMC
      // file's code exactly as typed. A casing mismatch here (e.g. lowercase
      // in AMC.xlsx) makes this lookup miss even when a mapping genuinely
      // exists, silently leaving the material unmapped in mosMerged.
      //
      // FIX-MOS-MAP-NESTED: mappingTable.get(code) returns a Map keyed by
      // stock type ("Q"/"RDF" → {targetCode, targetDesc, factor}) — see
      // "Build the mapping table" in script.js's loadMappingFile — NOT a
      // flat {targetCode,...} object. Reading entry.targetCode/.targetDesc
      // directly off that Map (as this used to) always returned undefined,
      // silently collapsing EVERY AMC material with a mapping-file entry
      // into a single `canonical: undefined` bucket that
      // buildCodeProgramClassMap() then drops entirely (its `m.code &&`
      // guard is false for undefined) — so any mapped material's
      // classification (RDF-CDSS / Program-Reportable / etc.) vanished from
      // every AMC-derived view (Dashboard classification filter, MOS,
      // National table, Expiry Risk...).
      //
      // FIX-MOS-MAP-STOCKTYPE-MATCH: when a source code has mapping rules for
      // BOTH stock types (~15 codes in this dataset — e.g. "105-AMIT-0101-03"
      // maps to a DIFFERENT target under "RDF" than under "Q"), the correct
      // variant to pick is whichever one matches THIS AMC ROW's own
      // classification text: an "RDF-CDSS"/"RDF-Non-CDSS" row is inherently
      // the RDF stream and must resolve through the mapping's RDF-tagged
      // target; a "Program-Reportable"/"Program-Non-Reportable" row is
      // inherently the Q stream and must resolve through the Q-tagged
      // target. Picking the wrong one (as an inventory-lookup-based guess
      // could) silently misattributes this row's AMC numbers and
      // classification onto the WRONG canonical material — e.g. an
      // RDF-CDSS row's data landing on the Q-stream's target code instead.
      // Falls back to the single available entry when the code only has one
      // stock-type rule, or to an RDF-then-Q preference when this row has no
      // AMC classification text to go on at all (nothing else to tell the
      // two streams apart by).
      const stypeMap = mappingTable.get(String(row.code || "").trim().toUpperCase());
      let entry;
      if (stypeMap && stypeMap.size) {
        const clsNorm = String(row.rawProgramType || "").trim().toUpperCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
        const wantStype = clsNorm.startsWith("RDF") ? "RDF" : (clsNorm.startsWith("PROGRAM") ? "Q" : null);
        entry = (wantStype && stypeMap.get(wantStype))
          || (stypeMap.size === 1 ? [...stypeMap.values()][0] : (stypeMap.get("RDF") || stypeMap.get("Q")));
      }
      if (entry) {
        canonical = entry.targetCode;
        canonDesc = entry.targetDesc || row.desc;
      }
    }

    // AMC file had nothing for this material — try the inventory file.
    if (!canonDesc) canonDesc = invDescMap.get(canonical) || "";

    // This row's own stream — see the LAW in resolveProgramTypeAndClass.
    // Computed up front so it can be folded into the merge key below.
    const { type: rowType } = resolveProgramTypeAndClass(canonical, row.rawProgramType, sstMap);
    const mergeKey = canonical + "\u241F" + rowType;

    if (!merged.has(mergeKey)) {
      merged.set(mergeKey, {
        code: canonical,
        origCodes: new Set([row.code]),
        desc: canonDesc,
        rawProgramType: row.rawProgramType || "",
        person: row.person || "",
        amcs: Object.fromEntries(mosPlants.map(p => [p, null])),
        isMerged: false,
      });
    }
    const m = merged.get(mergeKey);
    m.origCodes.add(row.code);
    if (m.origCodes.size > 1) m.isMerged = true;
    if (!m.desc && canonDesc) m.desc = canonDesc; // fill in if an earlier dup left it blank
    if (!m.rawProgramType && row.rawProgramType) m.rawProgramType = row.rawProgramType; // fill in if an earlier dup left it blank
    if (!m.person && row.person) m.person = row.person;

    for (const p of mosPlants) {
      const v = row.amcs[p];
      if (v !== null && v !== undefined) {
        m.amcs[p] = (m.amcs[p] || 0) + v;
      }
    }
  }

  return Array.from(merged.values()).map(m => {
    const { type, cls } = resolveProgramTypeAndClass(m.code, m.rawProgramType, sstMap);
    return {
      ...m,
      origCodes: [...m.origCodes].join(", "),
      type,
      programClass: cls,
    };
  });
}

// ── CANONICAL CODE → MATERIAL VALUATION TYPE (ZME/ZMS/ZLC/ZMD) ──────────────
// mosMerged's own `type` field is Q/RDF (Special Stock Type) — a completely
// different axis from the material's SAP valuation type (ZME=Medicines,
// ZMS=Medical Supplies, ZLC, ZMD). Pages like Overstock & Expiry Risk and
// Stockout Risk offer a "Type" dropdown of ZME/ZMS(/ZLC) — this map is what
// they should actually filter against, not r.type. Sourced the exact same
// way request-analysis.js's buildMaterialTypeMap() does (getValuationType()
// from filters.js, over the mapping-reconciled base), just exposed globally
// so any page can use it.
function buildCodeMaterialTypeMap() {
  const out = new Map();
  // FIX-CLS-PERSON-LEAK: was getReconciledBase() — see
  // buildSpecialStockTypeMap() above. Valuation type (ZME/ZMS/etc.) is a
  // material-level fact too, so it must not vanish for materials outside
  // whichever person is currently selected.
  const base = (typeof getMappingReconciledBase === "function") ? getMappingReconciledBase() : (typeof rawDf !== "undefined" ? rawDf : []);
  base.forEach(row => {
    const code = String(row._mappedMaterial || row["Material"] || "").trim();
    if (!code || out.has(code)) return;
    const type = (typeof getValuationType === "function" ? String(getValuationType(row) || "") : "").trim().toUpperCase();
    if (type && type !== "(NONE)") out.set(code, type);
  });
  return out;
}

// ── CANONICAL CODE → PROGRAM CLASSIFICATION (RDF·CDSS / RDF·Non-CDSS / ──────
//    Program(Q)·Reportable / Program(Q)·Non-Reportable) ─────────────────────
// Exposes mosMerged's per-item `programClass` keyed by canonical material
// code, so any page's generic filter bar (Dashboard, Transit, Expiry
// Watchlist, QC, Blocked, Restricted, Stock Concentration, etc. — see
// applyPageFilter() in script.js) can offer a "Classification Type" filter
// without needing its own copy of the AMC merge/resolution logic. Returns an
// empty map (never throws) when the AMC file hasn't been uploaded yet, so
// callers on pages that don't require AMC data degrade gracefully — the
// Classification Type control simply has no options / matches nothing.
// Returns a Map with TWO kinds of keys so callers can go either way:
//   - "CODE"            → first-seen programClass (back-compat for callers
//                          that don't know/care which stream a row is in)
//   - "CODE\u241FTYPE"  → the programClass for that code's RDF row or its
//                          Program(Q) row specifically. Since a code can
//                          legitimately have both (see buildMosMerged's LAW
//                          comment), callers that DO know a row's own
//                          Special Stock Type should look up the type-aware
//                          key first and only fall back to the plain code.
function buildCodeProgramClassMap() {
  const out = new Map();
  if (typeof mosMerged === "undefined" || !mosMerged.length) return out;
  mosMerged.forEach(m => {
    if (!m.code || !m.programClass) return;
    const code = String(m.code).trim().toUpperCase();
    if (!out.has(code)) out.set(code, m.programClass);
    out.set(code + "\u241F" + (m.type || "RDF"), m.programClass);
  });
  return out;
}

// ── FIND A mosMerged ROW BY CODE, TYPE-AWARE ──────────────────────────────────
// Since the same code can now have separate Q and RDF rows, any caller that
// needs "the one row for this material" must say which type it means when it
// knows (e.g. branch-demand.js resolving a request line's own Q/R
// classification). If `type` is omitted or matches nothing, falls back to the
// first row for that code (old single-row behavior) so callers that don't yet
// have a type to check against still get a usable result instead of null.
function mosFindRow(code, type) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  if (type) {
    const t = String(type).trim().toUpperCase();
    const exact = mosMerged.find(r => r.code === c && r.type === t);
    if (exact) return exact;
  }
  return mosMerged.find(r => r.code === c) || null;
}

// ── SOH LOOKUP (from main inventory file) ─────────────────────────────────────
// materialCode → plantCode → Total Quantity on hand.
// Total Quantity = Unrestricted Stock + verified Stock in Transit (phantom/
// unverified transit excluded) + Stock in Quality Inspection — same definition
// and same getMappedQty/getVerifiedTransitQty helpers Branch Comparison's
// "Total Quantity" metric uses (see script.js matPlantMap[mat][pln].TotalQty),
// so the two pages agree on the same number for the same material.
//
// FIX-SOH-STREAM-SPLIT: a material code can carry BOTH an RDF-stream
// mosMerged row and a Program(Q)-stream row (see buildMosMerged's LAW
// comment). Before this fix, SOH here was keyed by code+plant ONLY, so
// both streams' rows read the exact same code-level total — e.g. filtering
// to "RDF-CDSS" would show the correct row, but its SOH figure silently
// included Q-stock too (and the Program-Reportable row for the same code
// showed that identical inflated number back). The inventory file's own
// Special Stock Type column (the SAME field that decides a row's Q/RDF
// `type` everywhere else in this app — see the TYPE SOURCE OF TRUTH comment
// above) already tells us which stream each physical stock line belongs to,
// so it's used here too: every code gets its normal map.get(code)[plant]
// TOTAL entry (unchanged, still used by callers like request-analysis.js/
// who-responsible.js that intentionally want the whole-material figure),
// PLUS a stream-scoped map.get(code+"\u241F"+"RDF"/"Q")[plant] entry —
// same "code\u241Ftype" key convention buildMosMerged() already uses.
// mosSohFor()/computeNationalMOS() prefer the stream-scoped entry when the
// caller's row knows its own type, falling back to the total for backward
// compatibility (e.g. a stream that has AMC data but literally zero
// inventory rows of its own — see resolveProgramTypeAndClass's fallback —
// would otherwise show 0 instead of the only stock that actually exists).
function buildMosSohMap() {
  const map = new Map();
  // Use the mapping-reconciled base (mappedDf when a mapping file is loaded)
  // so materials that consolidate multiple source SAP codes into one target
  // code — via applyMaterialMapping() — are looked up under their canonical/
  // target code, same as Branch Comparison, National Table, and Expiry Risk.
  // rawDf rows never carry _mappedMaterial (that field only exists on
  // mappedDf's copies), so reading rawDf directly silently drops all stock
  // recorded under pre-mapping source codes.
  const base = (typeof getReconciledBase === "function")
    ? getReconciledBase()
    : (typeof rawDf !== "undefined" ? rawDf : []);
  if (!base.length) return map;
  for (const row of base) {
    const mat = String(row._mappedMaterial || row["Material"] || "").trim();
    const plt = String(row["Plant"] || "").trim().toUpperCase();
    if (!mat || !plt) continue;

    const unrestricted = (typeof getMappedQty === "function") ? getMappedQty(row, "Unrestricted Stock") : Number(row["Unrestricted Stock"] || 0);
    const transit       = (typeof getVerifiedTransitQty === "function") ? getVerifiedTransitQty(row) : Number(row["Stock in Transit"] || 0);
    const qc            = (typeof getMappedQty === "function") ? getMappedQty(row, "Stock in Quality Inspection") : Number(row["Stock in Quality Inspection"] || 0);
    const qty = (Number(unrestricted) || 0) + (Number(transit) || 0) + (Number(qc) || 0);

    // Stream source of truth: this row's own Special Stock Type — same rule
    // used everywhere else (Q = Health Program, anything else/blank = RDF).
    const sst = String(row["Special Stock Type"] || "").trim().toUpperCase() === "Q" ? "Q" : "RDF";

    if (!map.has(mat)) map.set(mat, {});
    map.get(mat)[plt] = (map.get(mat)[plt] || 0) + qty;

    const streamKey = mat + "\u241F" + sst;
    if (!map.has(streamKey)) map.set(streamKey, {});
    map.get(streamKey)[plt] = (map.get(streamKey)[plt] || 0) + qty;
  }
  return map;
}

function mosSohFor(sohMap, row, plant) {
  const streamEntry = sohMap.get(row.code + "\u241F" + row.type);
  if (streamEntry && plant in streamEntry) return streamEntry[plant] ?? 0;
  // Fallback: no inventory rows recorded under this row's own stream for
  // this code (e.g. AMC-only Q classification with no physical Q stock on
  // file yet) — use the code-level total rather than showing a false zero.
  return sohMap.get(row.code)?.[plant] ?? 0;
}

/**
 * Computes MOS for every plant, for one AMC row.
 * Returns an array of { plant, soh, amc, mos, isHub }.
 *
 * - For the hub plant (HO01): amc = sum of every branch plant's AMC for this
 *   item (nulls treated as 0 — a branch with no commitment contributes no
 *   demand). mos = HO01's SOH ÷ that total branch demand.
 * - For every other plant: amc = that plant's own AMC column value.
 *   mos = that plant's SOH ÷ its own AMC.
 *
 * mos is null when there's no basis to compute it (no AMC commitment at all,
 * i.e. the plant isn't expected to carry this item). mos is Infinity when
 * there IS stock but zero demand (can't run out, but also isn't moving).
 */
function computeRowMOS(row, sohMap) {
  // PLANT SCOPING: restrict which branches feed the hub's "Σ branch AMC"
  // figure to plants this user can see (getVisiblePlants() — full list for
  // Admin/HO01, so no behaviour change for them). Without this, a branch-
  // scoped user's HO01 column would still reflect demand aggregated across
  // every OTHER branch too, which is exactly the kind of cross-branch
  // number the plant-scoping feature is meant to keep private.
  const scopedPlants = (typeof getVisiblePlants === "function") ? getVisiblePlants(mosPlants) : mosPlants;
  const branchPlants = scopedPlants.filter(p => p !== HUB_PLANT);
  const totalBranchAmc = branchPlants.reduce((s, p) => s + (row.amcs[p] || 0), 0);
  const anyBranchCommitted = branchPlants.some(p => row.amcs[p] !== null);

  return mosPlants.map(p => {
    const soh = mosSohFor(sohMap, row, p);
    const isHub = p === HUB_PLANT;

    if (isHub) {
      // Hub's own AMC column (if present) is ignored on purpose — HO01 doesn't
      // consume. Its "demand" is the total of what it has to ship out.
      if (!anyBranchCommitted) return { plant: p, soh, amc: null, mos: null, isHub };
      const mos = totalBranchAmc > 0 ? soh / totalBranchAmc : (soh > 0 ? Infinity : null);
      return { plant: p, soh, amc: totalBranchAmc, mos, isHub };
    }

    const amc = row.amcs[p];
    if (amc === null || amc === undefined) return { plant: p, soh, amc: null, mos: null, isHub };
    const mos = amc > 0 ? soh / amc : (soh > 0 ? Infinity : null);
    return { plant: p, soh, amc, mos, isHub };
  });
}

/**
 * National MOS — one network-wide number per item:
 *
 *     National MOS = (SOH at every plant, INCLUDING HO01)
 *                   ÷ (AMC at every BRANCH plant, EXCLUDING HO01)
 *
 * HO01 holds stock but doesn't consume it, so its warehouse stock is counted
 * as part of the network's total supply cushion (numerator), while its own
 * AMC column (which doesn't represent real demand) is excluded from the
 * denominator — only the branches' actual consumption represents real demand.
 *
 * Returns { totalSoh, totalAmc, mos, hasHo01 } where mos is:
 *   - null if no branch is committed to this item at all (no real demand to measure against)
 *   - Infinity if there's stock but zero branch demand
 *   - a number otherwise
 */
function computeNationalMOS(row, sohMap) {
  // PLANT SCOPING: see the matching comment in computeRowMOS() just above —
  // same reasoning, applied to the "National MOS" aggregate so it becomes a
  // "my visible plants" MOS for a branch-scoped user rather than a true
  // national figure that leaks other branches' demand into one number.
  const scopedPlants = (typeof getVisiblePlants === "function") ? getVisiblePlants(mosPlants) : mosPlants;
  const branchPlants = scopedPlants.filter(p => p !== HUB_PLANT);
  const totalBranchAmc = branchPlants.reduce((s, p) => s + (row.amcs[p] || 0), 0);
  const anyBranchCommitted = branchPlants.some(p => row.amcs[p] !== null);

  // FIX-NATL-SOH: SOH must cover ALL plants holding this material in the
  // inventory file — not just plants that happen to have a column in the
  // uploaded AMC file. Previously this summed mosPlants only, which silently
  // dropped stock sitting at any plant absent from the AMC upload (or whose
  // plant code didn't match an AMC column), undercounting national SOH.
  //
  // FIX-SOH-STREAM-SPLIT: prefer this row's own stream-scoped entry (see
  // buildMosSohMap above) so a Program(Q) row's National SOH doesn't include
  // an RDF row's stock for the same code, and vice versa. Falls back to the
  // code-level total only when this stream has no inventory rows of its own.
  const streamEntry = sohMap.get(row.code + "\u241F" + row.type);
  const allPlantsForRow = streamEntry || sohMap.get(row.code) || {};
  const totalSoh = Object.values(allPlantsForRow).reduce((s, v) => s + (Number(v) || 0), 0);
  const hasHo01  = mosPlants.includes(HUB_PLANT);

  if (!anyBranchCommitted) return { totalSoh, totalAmc: null, mos: null, hasHo01 };
  const mos = totalBranchAmc > 0 ? totalSoh / totalBranchAmc : (totalSoh > 0 ? Infinity : null);
  return { totalSoh, totalAmc: totalBranchAmc, mos, hasHo01 };
}

// ── FORMATTING HELPERS ────────────────────────────────────────────────────────
function mosNABadge() {
  return '<span class="amc-na-badge" title="Not committed — item not required at this plant">Not Committed</span>';
}

function fmtMosVal(mos) {
  if (mos === null || mos === undefined) return mosNABadge();
  if (mos === Infinity) return '<span style="color:var(--amber)">∞</span>';
  return `<b>${Number(mos).toFixed(1)}</b> mo`;
}

// Only rule requested: flag critical (< 1 month). Everything else is neutral.
function isMosCritical(mos) {
  return mos !== null && mos !== undefined && mos !== Infinity && mos < 1;
}

function mosCellStyle(mos) {
  return isMosCritical(mos) ? "color:var(--red);font-weight:700" : "color:var(--text)";
}

function getMosFilteredRows(typeFilter, searchQ, clsFilter) {
  if (!mosMerged.length) return [];
  let rows = mosMerged;
  // Global person filter — applied before any per-page filters
  if (typeof personFilter !== "undefined" && personFilter.size > 0) {
    rows = rows.filter(r => r.person && personFilter.has(r.person));
  }
  if (typeFilter) rows = rows.filter(r => r.type === typeFilter);
  if (clsFilter)  rows = rows.filter(r => r.programClass === clsFilter);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    rows = rows.filter(r => r.code.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q));
  }
  return rows;
}

function mosKpiCard(label, value, sub, color) {
  return `<div class="kpi-card"><div class="kpi-label">${escHtml(label)}</div><div class="kpi-value" style="color:var(--${color||'blue'})">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
}

// ── PROGRAM CLASS BADGE / COUNTS (used on MOS/National table + Dashboard) ─────
function programClassBadge(cls) {
  if (!cls) return '<span class="amc-na-badge" title="No AMC classification data">Unclassified</span>';
  const colorMap = {
    [PROGRAM_CLASS.RDF_CDSS]:     "#3fb950",
    [PROGRAM_CLASS.RDF_NON_CDSS]: "#8763cc",
    [PROGRAM_CLASS.PROG_REPORT]:  "#3a8fd4",
    [PROGRAM_CLASS.PROG_NONREPT]: "#d29922",
  };
  const label = PROGRAM_CLASS_LABELS[cls] || cls;
  return `<span style="color:${colorMap[cls] || 'var(--text)'};font-weight:600">${escHtml(label)}</span>`;
}

// Counts every mosMerged row (one per canonical code+type) into the four
// program-class buckets, plus however many are still unclassified (type
// itself never got resolved, e.g. user hit "Skip" in the assignment prompt).
// Used by the Dashboard's classification panel.
function getProgramClassCounts() {
  const counts = {
    [PROGRAM_CLASS.RDF_CDSS]: 0, [PROGRAM_CLASS.RDF_NON_CDSS]: 0,
    [PROGRAM_CLASS.PROG_REPORT]: 0, [PROGRAM_CLASS.PROG_NONREPT]: 0,
    unclassified: 0,
  };
  if (typeof mosMerged === "undefined") return counts;
  mosMerged.forEach(r => {
    if (r.programClass && counts.hasOwnProperty(r.programClass)) counts[r.programClass]++;
    else counts.unclassified++;
  });
  return counts;
}

// ── MAIN RENDER ────────────────────────────────────────────────────────────────
async function renderMosPlant() {
  await waitForPlotly();
  if (!mosMerged.length) return;

  const searchEl    = document.getElementById("mos-search");
  const plantEl     = document.getElementById("mos-plant-filter");
  const typeEl      = document.getElementById("mos-type");
  const clsEl       = document.getElementById("mos-program-class");
  const criticalEl  = document.getElementById("mos-critical-only");

  const searchQ     = searchEl   ? searchEl.value.trim()  : "";
  const typeVal     = typeEl     ? typeEl.value.trim()    : "";
  const clsVal      = clsEl      ? clsEl.value.trim()     : "";
  const criticalOnly= criticalEl ? criticalEl.checked     : false;
  // PLANT SCOPING: ignore a plant value the DOM happens to hold (e.g. a
  // stale selection from before the user's session/plant was known) if
  // it's not one this user can actually see — defense in depth on top of
  // the dropdown itself only ever offering visiblePlants options above.
  const rawPlantVal = plantEl ? plantEl.value.trim() : "";
  const plantVal    = (typeof canAccessPlant === "function" && rawPlantVal && !canAccessPlant(rawPlantVal))
    ? "" : rawPlantVal;

  // PLANT SCOPING: mosPlants comes from the AMC file's own column headers,
  // not from rawDf rows — so unlike the row-based pages (whose plant
  // dropdowns are built from already-scoped rows and get this filtering
  // for free via permissions.js's canAccessRow()), this one needs an
  // explicit getVisiblePlants() pass. HO01 stays visible to a branch user
  // (canAccessPlant() always allows the hub) since MOS's hub-vs-branch
  // comparison is the whole point of this page.
  const visiblePlants = (typeof getVisiblePlants === "function") ? getVisiblePlants(mosPlants) : mosPlants;

  // Populate plant dropdown once
  if (plantEl && plantEl.options.length <= 1) {
    visiblePlants.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p; opt.text = p === HUB_PLANT ? `${p} (Hub)` : p;
      plantEl.appendChild(opt);
    });
  }

  const sohMap = buildMosSohMap();
  const hasSoh = sohMap.size > 0;

  let rows = getMosFilteredRows(typeVal, searchQ, clsVal);

  // Compute per-plant MOS for every row, plus one network-wide National MOS
  let scored = rows.map(r => ({
    ...r,
    _plantMos: computeRowMOS(r, sohMap),
    _national: computeNationalMOS(r, sohMap),
  }));

  // Plant-specific filter: only keep rows where that plant has a commitment
  if (plantVal) {
    scored = scored.filter(r => r._plantMos.find(m => m.plant === plantVal)?.amc !== null);
  }

  // Critical-only filter: at least one plant (or the selected plant) under 1mo
  if (criticalOnly) {
    scored = scored.filter(r => {
      const relevant = plantVal ? r._plantMos.filter(m => m.plant === plantVal) : r._plantMos;
      return relevant.some(m => isMosCritical(m.mos));
    });
  }

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const allEntries = scored.flatMap(r => plantVal ? r._plantMos.filter(m => m.plant === plantVal) : r._plantMos);
  const committedEntries = allEntries.filter(e => e.amc !== null);
  const criticalCount = committedEntries.filter(e => isMosCritical(e.mos)).length;
  const hubEntries = scored.map(r => r._plantMos.find(m => m.isHub)).filter(e => e && e.amc !== null);
  const hubCriticalCount = hubEntries.filter(e => isMosCritical(e.mos)).length;
  const nationalEntries = scored.map(r => r._national).filter(n => n.mos !== null);
  const nationalCriticalCount = nationalEntries.filter(n => isMosCritical(n.mos)).length;

  mosKpiRow([
    mosKpiCard("Items Screened", scored.length.toLocaleString(), typeVal || "All types", "blue"),
    mosKpiCard("National MOS Critical (<1mo)", nationalCriticalCount.toLocaleString(), `of ${nationalEntries.length.toLocaleString()} items with national MOS`, "red"),
    mosKpiCard("Plant-Item Pairs Critical (<1mo)", criticalCount.toLocaleString(), `of ${committedEntries.length.toLocaleString()} committed pairs`, "amber"),
    mosKpiCard(`${HUB_PLANT} Critical (<1mo)`, hubCriticalCount.toLocaleString(), "vs. total branch demand", "purple"),
    mosKpiCard("SOH Data Loaded", hasSoh ? "Yes" : "No", hasSoh ? "From inventory file" : "Upload inventory Excel for SOH", hasSoh ? "green" : "amber"),
  ]);

  if (!hasSoh) {
    document.getElementById("chart-mos-plant").innerHTML =
      '<div class="alert-info" style="margin:1rem 0">⚠️ Upload the main inventory Excel (sidebar) to provide stock-on-hand — MOS can\'t be computed from AMC alone.</div>';
    document.getElementById("mos-table").innerHTML = "";
    return;
  }

  // ── CHART: avg MOS per plant across screened items (capped for display) ──
  // PLANT SCOPING: falls back to visiblePlants (not the raw mosPlants list)
  // so a branch-scoped user's "no plant selected" view only ever shows
  // their own plant + the HO01 hub column, never every other branch.
  const displayPlants = plantVal ? [plantVal] : visiblePlants;
  const plantAverages = displayPlants.map(p => {
    const vals = scored
      .map(r => r._plantMos.find(m => m.plant === p))
      .filter(e => e && e.amc !== null && e.mos !== null && e.mos !== Infinity);
    const avg = vals.length ? vals.reduce((s, e) => s + e.mos, 0) / vals.length : null;
    return { plant: p, avg, n: vals.length, isHub: p === HUB_PLANT };
  });

  Plotly.newPlot("chart-mos-plant", [{
    type: "bar",
    x: plantAverages.map(p => p.isHub ? `${p.plant} ★` : p.plant),
    y: plantAverages.map(p => p.avg ?? 0),
    marker: {
      color: plantAverages.map(p => p.avg !== null && p.avg < 1 ? "#f85149" : p.isHub ? "#8763cc" : "#3a8fd4"),
    },
    text: plantAverages.map(p => p.avg !== null ? `${p.avg.toFixed(1)}mo` : "—"),
    textposition: "outside",
    textfont: { size: 10 },
    hovertemplate: "<b>%{x}</b><br>Avg MOS: %{y:.1f} months<extra></extra>",
  }], {
    ...PLOTLY_LAYOUT,
    height: 360,
    margin: { l: 60, r: 30, t: 30, b: 80 },
    xaxis: { title: "Plant (★ = hub, MOS vs. total branch demand)", tickfont: { size: 10 } },
    yaxis: { title: "Average MOS (months)" },
    shapes: [{
      type: "line", x0: -0.5, x1: displayPlants.length - 0.5, y0: 1, y1: 1,
      line: { color: "#f85149", width: 1.5, dash: "dot" },
    }],
    annotations: [{
      x: displayPlants.length - 0.5, y: 1, xanchor: "right", yanchor: "bottom",
      text: "1mo critical line", showarrow: false, font: { color: "#f85149", size: 9 },
    }],
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  }, PLOTLY_CONFIG);

  // ── TABLE ────────────────────────────────────────────────────────────────────
  const cols = [
    { key: "code", label: "Material Code",
      fmt: (v, r) => r.isMerged
        ? `<span class="col-mat-code">${escHtml(v)}</span><span class="mat-mapped-badge" title="Merged from: ${escHtml(r.origCodes)}">MERGED</span>`
        : `<span class="col-mat-code">${escHtml(v)}</span>`,
      raw: true, cellClass: "col-mat-code-wrap" },
    { key: "desc", label: "Description", cellClass: "col-mat-desc-wrap" },
    { key: "type", label: "Type" },
    { key: "programClass", label: "Classification", fmt: v => programClassBadge(v), raw: true },
    { key: "_national", label: "National MOS",
      fmt: (v) => {
        if (!v || v.mos === null) return mosNABadge();
        const sohStr = `<span style="font-size:0.72em;color:var(--muted)"> · SOH ${fmtQty(v.totalSoh)}${v.hasHo01 ? ' (incl. ' + HUB_PLANT + ')' : ''}</span>`;
        const amcStr = `<span style="font-size:0.72em;color:var(--muted)"> · AMC ${fmtQty(v.totalAmc)} (branches)</span>`;
        return `<span style="${mosCellStyle(v.mos)}">${fmtMosVal(v.mos)}</span>${sohStr}${amcStr}`;
      },
      raw: true, cellClass: "col-mat-desc-wrap" },
    ...displayPlants.map(p => ({
      key: `_m_${p}`, label: p === HUB_PLANT ? `${p} (Hub)` : p,
      fmt: (v) => {
        if (!v || v.amc === null) return mosNABadge();
        const sohStr = `<span style="font-size:0.72em;color:var(--muted)"> · SOH ${fmtQty(v.soh)}</span>`;
        const amcLabel = v.isHub ? "Σ branch AMC" : "AMC";
        const amcStr = `<span style="font-size:0.72em;color:var(--muted)"> · ${amcLabel} ${fmtQty(v.amc)}</span>`;
        return `<span style="${mosCellStyle(v.mos)}">${fmtMosVal(v.mos)}</span>${sohStr}${amcStr}`;
      },
      raw: true,
    })),
  ];

  const tableRows = scored.map(r => ({
    ...r,
    ...Object.fromEntries(displayPlants.map(p => [`_m_${p}`, r._plantMos.find(m => m.plant === p)])),
  }));

  document.getElementById("mos-table").innerHTML = buildTable(
    tableRows, cols,
    (row) => {
      const relevant = plantVal ? [row[`_m_${plantVal}`]] : displayPlants.map(p => row[`_m_${p}`]);
      const nationalCritical = row._national && isMosCritical(row._national.mos);
      return (relevant.some(v => v && isMosCritical(v.mos)) || nationalCritical) ? "row-critical" : "";
    }
  );

  // ── EXPORT ────────────────────────────────────────────────────────────────────
  // PLANT SCOPING: r._plantMos always carries an entry for EVERY mosPlants
  // code (computeRowMOS() has to compute all of them for the hub-vs-branch
  // math), so filtering only by plantVal — as this used to — would leak
  // every other branch's plant/soh/amc/mos into a branch-scoped user's CSV
  // whenever no single plant was selected. Restrict to displayPlants (which
  // is already visiblePlants-derived) so the export never exceeds what the
  // table/chart above it are showing.
  const exportRows = scored.flatMap(r =>
    r._plantMos.filter(m => displayPlants.includes(m.plant) && (!plantVal || m.plant === plantVal)).map(m => ({
      code: r.code, desc: r.desc, type: r.type, programClass: PROGRAM_CLASS_LABELS[r.programClass] || "Unclassified",
      nationalMos: r._national.mos, nationalSoh: r._national.totalSoh, nationalAmc: r._national.totalAmc,
      plant: m.plant, isHub: m.isHub ? "Yes (vs. total branch demand)" : "No",
      soh: m.soh, amc: m.amc, mos: m.mos,
    }))
  );
  const exportCols = [
    { key: "code", label: "Material Code" }, { key: "desc", label: "Description" }, { key: "type", label: "Type" },
    { key: "programClass", label: "Classification (CDSS/Reportable)" },
    { key: "nationalMos", label: "National MOS (months)", fmt: v => v === null ? "N/A" : v === Infinity ? "Infinite" : Number(v).toFixed(2) },
    { key: "nationalSoh", label: "National SOH (all plants incl. " + HUB_PLANT + ")", fmt: v => Number(v || 0).toFixed(2) },
    { key: "nationalAmc", label: "National AMC (branches only)", fmt: v => v === null ? "N/A" : Number(v).toFixed(2) },
    { key: "plant", label: "Plant" }, { key: "isHub", label: "Hub Plant?" },
    { key: "soh", label: "Stock on Hand", fmt: v => Number(v || 0).toFixed(2) },
    { key: "amc", label: "AMC Used", fmt: v => v === null ? "Not Committed" : Number(v).toFixed(2) },
    { key: "mos", label: "MOS (months)", fmt: v => v === null ? "N/A" : v === Infinity ? "Infinite" : Number(v).toFixed(2) },
  ];
  const dlRow = document.getElementById("mos-dl-row");
  if (dlRow) {
    dlRow.innerHTML = '<button class="dl-btn">⬇ CSV</button><button class="dl-btn">⬇ Excel</button>';
    dlRow.querySelectorAll(".dl-btn")[0].onclick = () => downloadCSV(exportRows,   exportCols, "mos_by_plant.csv");
    dlRow.querySelectorAll(".dl-btn")[1].onclick = () => downloadExcel(exportRows, exportCols, "mos_by_plant.xlsx");
  }
}

function mosKpiRow(cards) {
  const el = document.getElementById("mos-kpis");
  if (el) el.innerHTML = cards.join("");
}

// ── WIRE INTO PAGE_RENDERERS AND EVENT LISTENERS ──────────────────────────────
(function wireMosModule() {
  function extend() {
    // SEC-ACCESS-GATE: this module used to monkey-patch window.renderPage
    // with its own unguarded branch for "mos-plant" (to let the page render
    // before rawDf was loaded), which bypassed the canAccessModule()
    // permission check in the real renderPage() (script.js) entirely.
    // renderPage() now has its own rawDf exemption for this page id, so
    // registering into PAGE_RENDERERS is all that's needed here.
    if (typeof PAGE_RENDERERS !== "undefined") {
      PAGE_RENDERERS["mos-plant"] = renderMosPlant;
    }

    const amcInput = document.getElementById("mosAmcFileInput");
    if (amcInput) {
      amcInput.addEventListener("change", e => {
        const f = e.target.files[0]; if (f) loadMosAmcFile(f);
        e.target.value = "";
      });
    }

    const filterMap = {
      "mos-apply": renderMosPlant,
      "mos-clear": () => {
        const s = document.getElementById("mos-search");         if (s) s.value = "";
        const p = document.getElementById("mos-plant-filter");   if (p) p.value = "";
        const t = document.getElementById("mos-type");           if (t) t.value = "";
        const g = document.getElementById("mos-program-class");  if (g) g.value = "";
        const c = document.getElementById("mos-critical-only");  if (c) c.checked = false;
        renderMosPlant();
      },
    };

    document.body.addEventListener("click", (e) => {
      const btn = e.target.closest("button[id]");
      if (!btn || !mosMerged.length) return;
      const fn = filterMap[btn.id];
      if (fn) { e.stopPropagation(); fn(); }
    }, true);

    // Recompute SOH-driven values whenever the main inventory file finishes
    // loading (rawDf changes).
    //
    // PARALLEL-LOAD FIX: this used to only call renderMosPlant(), which
    // re-reads rawDf for SOH quantities but does NOT rebuild mosMerged
    // itself. buildInventoryDescMap() (used for the AMC row's Description
    // fallback) is baked into mosMerged once, inside buildMosMerged(), at
    // whatever moment the AMC file finished loading — reading rawDf as it
    // stood AT THAT INSTANT. If AMC finishes loading before the inventory
    // file (now possible now that storage-sync.js loads slots in parallel
    // instead of strictly inventory-then-amc), that snapshot is an empty
    // rawDf, and every AMC row's Description permanently falls back to
    // blank for the rest of the session — renderMosPlant() alone can never
    // fix this, since it doesn't touch mosMerged.
    //
    // Rebuilding mosMerged here (whenever it's already populated, i.e. AMC
    // has already loaded at least once) makes AMC's description fallback
    // correct regardless of whether inventory or AMC finishes loading
    // first — mirroring the same self-healing pattern already used by the
    // applyMaterialMapping() wrapper below for the mapping file.
    const fileInput = document.getElementById("fileInput");
    if (fileInput) {
      fileInput.addEventListener("change", () => {
        setTimeout(() => {
          if (mosAmcRaw.length) mosMerged = buildMosMerged();
          if (currentPage === "mos-plant" && mosMerged.length) renderMosPlant();
        }, 300);
      });
    }

    // Rebuild mosMerged when the mapping file changes, like the old AMC module did.
    const _origApplyMapping = window.applyMaterialMapping;
    if (_origApplyMapping) {
      window.applyMaterialMapping = function () {
        _origApplyMapping.apply(this, arguments);
        if (mosAmcRaw.length) {
          mosMerged = buildMosMerged();
          if (currentPage === "mos-plant") {
            try { renderMosPlant(); } catch (e) {}
          }
        }
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", extend);
  } else {
    extend();
  }
})();
