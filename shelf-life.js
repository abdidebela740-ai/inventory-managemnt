// =============================================================================
// PharmaTrack v2 — shelf-life.js
// "🕐 Shelf Life Look-up" — sidebar search that shows, for any material, every
// batch currently on hand with its Production Date, Expiration Date, the date
// it was actually received into stock (Goods Receipt Posting Date, from the
// separately-uploaded Incoming GR log), and the Remaining Shelf Life % at the
// point of Goods Receipt:
//
//   Remaining Shelf Life % at Receipt =
//       (Expiration Date − GR Posting Date) ÷ (Expiration Date − Production Date) × 100
//
// MULTI-MATERIAL SELECTION
// -------------------------
// Picking a suggestion adds it as a removable chip instead of opening the
// modal immediately. Pick as many materials as you like, then hit "Show
// Shelf Life" (or press Enter with the input empty) to open one combined
// modal with every batch from every selected material, sorted worst-first
// across the whole set. A single material still works exactly the same way,
// just with one extra click on "Show Shelf Life".
//
// DATA SOURCES
// ------------
//   1. Main inventory file (rawDf) — already parsed by script.js. Each row
//      carries a Batch, an optional Production Date (row._prodDate) and an
//      Expiration Date (row._expiry). Production Date is frequently blank —
//      SAP rarely captures it per batch — so this module degrades gracefully
//      wherever it's missing.
//   2. Incoming GR.xlsx (goods-receipt movement log) — uploaded separately via
//      the "🚚 Upload Incoming GR.xlsx" sidebar button. Supplies the Posting
//      Date (the date that batch actually entered stock), keyed by
//      Material + Batch. When a batch has multiple GR line items, the
//      EARLIEST posting date is used — that's the original receipt.
//
// Requires: script.js (rawDf, personFilter, getPersonFilteredCodes, fmtQty,
//           escHtml, buildTable, wireTableExport, downloadCSV, downloadExcel,
//           parseExpiryDate, fmtLocalDate, kpiCard)
// Independent of mos.js / expiry-risk.js / who-responsible.js — this module
// only needs script.js. Must be loaded AFTER script.js.
// =============================================================================

(function shelfLifeModule() {
  const MS_PER_DAY  = 24 * 60 * 60 * 1000;
  const DAYS_PER_MO = 30.44; // consistent with expiry-risk.js's month math
  const MAX_SUGGESTIONS = 8;
  const NO_EXPIRY_YEAR_CUTOFF = 9000; // SAP uses 9999-12-31 as a "never expires" sentinel

  let activeIndex = -1;
  let currentMatches = [];

  // ── MULTI-MATERIAL SELECTION STATE ──────────────────────────────────────────
  // Map code → desc, in insertion order. Populated by picking suggestions;
  // consumed by the "Show Shelf Life" button to open one combined modal.
  let selectedCodes = new Map();

  // ── INCOMING GR STATE ───────────────────────────────────────────────────────
  // Map key `${material}|${batch}` → { postingDate: Date (earliest seen), plant, hits }
  let grMap = new Map();
  let grLoaded = false;

  // FEAT-QC-DAYS-QTY-MATCH: a second, stricter index used ONLY by the "Days in
  // Quality" panel (script.js's _renderQCDaysPanel). That panel needs a GR
  // receipt to match on Material + Batch + Quantity all at once (a batch can
  // be split across multiple GR line items / multiple QC holds with different
  // quantities, and only the line with the matching quantity is the right
  // receipt for that specific QC stock). Unlike grMap above (which keeps the
  // EARLIEST posting date per material+batch, for shelf-life-at-receipt math),
  // this index keeps the MOST RECENT posting date among rows that share the
  // same material + batch + quantity, per the "if all match, take the recent
  // posting date" requirement.
  // Key: `${material}|${batch}|${quantity rounded to 3dp}` → { postingDate: Date (most recent), hits }
  let grQtyMap = new Map();

  // Candidate header names for the GR quantity column. The uploaded Incoming
  // GR.xlsx isn't guaranteed to use one exact label across exports, so we
  // check a short list of common SAP goods-receipt-report headers and use
  // whichever is present. If none of these match your file's actual column
  // name, tell me the exact header and I'll add it here.
  const GR_QTY_COLUMNS = ["Quantity", "Qty", "GR Quantity", "Posting Quantity", "Quantity in Unit of Entry", "Qty in Unit of Entry"];
  function extractGrQty(r) {
    for (const col of GR_QTY_COLUMNS) {
      if (col in r) {
        const n = Number(r[col]);
        if (!isNaN(n)) return n;
      }
    }
    return null;
  }
  // Rounded to 3dp so float noise in the source file (e.g. 500.000000001)
  // doesn't silently break an otherwise-exact quantity match.
  const qtyKeyPart = (qty) => Number(qty).toFixed(3);

  const GR_REQUIRED_COLUMNS = ["Material", "Batch", "Posting Date"];

  // ── Public accessor for other modules ────────────────────────────────────
  // grMap itself stays private (module-scoped) so nothing outside this file
  // can mutate it — other modules that need a posting date (e.g. script.js's
  // "Days in Quality" panel) go through this instead. Keyed the same way
  // buildBatchRows() above looks it up: trimmed, original-case Material +
  // Batch — NOT uppercased, since that's how the GR file's own values and
  // rawDf's Material/Batch values are compared everywhere else in this file.
  function getGrPostingDate(material, batch) {
    if (!grLoaded || !material || !batch) return null;
    const entry = grMap.get(`${String(material).trim()}|${String(batch).trim()}`);
    return entry ? entry.postingDate : null;
  }

  // FEAT-QC-DAYS-QTY-MATCH: strict Material + Batch + Quantity match, most
  // recent posting date wins on ties. Returns null if quantity is missing/
  // not a number, or if no GR row shares all three values.
  function getGrPostingDateByQty(material, batch, quantity) {
    if (!grLoaded || !material || !batch) return null;
    const qty = Number(quantity);
    if (!Number.isFinite(qty)) return null;
    const key = `${String(material).trim()}|${String(batch).trim()}|${qtyKeyPart(qty)}`;
    const entry = grQtyMap.get(key);
    return entry ? entry.postingDate : null;
  }

  window.isIncomingGrLoaded = () => grLoaded;
  window.getIncomingGrPostingDate = getGrPostingDate;
  window.getIncomingGrPostingDateByQty = getGrPostingDateByQty;

  // ── INCOMING GR FILE LOADER ──────────────────────────────────────────────────
  function loadIncomingGrFile(file) {
    const statusEl = document.getElementById("incomingFileStatus");
    const btnEl    = document.getElementById("incomingUploadBtnText");
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.innerHTML = `<div class="status-ok">⏳ LOADING…</div><div class="status-name">Parsing ${escHtml(file.name)}</div>`;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!rows.length) throw new Error("The uploaded file contains no data.");

        const trimmed = rows.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) r[String(k).trim()] = v;
          return r;
        });

        const colsLower = Object.keys(trimmed[0]).map(c => c.toLowerCase());
        const missing = GR_REQUIRED_COLUMNS.filter(c => !colsLower.includes(c.toLowerCase()));
        if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}`);

        // Keep only Goods Receipt rows when a Movement Type column is present.
        // (This file is typically GR-only already — movement type "101".)
        // Also exclude "GR stock in transit" rows via Movement Type Text when
        // present — that's stock still in transit, not yet actually received,
        // so it must never be used as a batch's receipt date for shelf-life math.
        const EXCLUDED_MOVEMENT_TEXTS = ["gr stock in transit"];
        const filtered = trimmed.filter(r => {
          if ("Movement Type" in r) {
            const mt = String(r["Movement Type"] || "").trim();
            if (mt && mt !== "101") return false;
          }
          if ("Movement Type Text" in r) {
            const mtText = String(r["Movement Type Text"] || "").trim().toLowerCase();
            if (EXCLUDED_MOVEMENT_TEXTS.includes(mtText)) return false;
          }
          return true;
        });

        const map = new Map();
        let parsedRows = 0;
        let excludedRows = 0;
        for (const r of filtered) {
          const mat   = String(r["Material"] || "").trim();
          const batch = String(r["Batch"] || "").trim();
          if (!mat || !batch) continue;

          // Apply the same exclusion rules used everywhere else (filters.js),
          // so Project Stock / non-medical / excluded-location materials never
          // surface in "New Received Stock" even though this file is loaded
          // separately from the main inventory upload. "Material" is always
          // present; the other columns are only checked when the GR export
          // happens to include them.
          // Universal invariants (W / non-medical / project-stock / excluded
          // location) apply to everyone, including Admin.
          if (!passesUniversalExclusions(r)) { excludedRows++; continue; }
          // Role/scope gating: this GR file may or may not carry "Inventory
          // Valuation Type" per row. When it does, gate Q rows by scope like
          // everywhere else. When it doesn't, canAccessRow() can't compute a
          // scope code and denies non-Q rows too aggressively — so for the
          // (common) case where the row has no valuation type of its own,
          // fall back to just checking "Q" against Admin vs non-Admin: a
          // non-Q row is fine to keep and will still be reconciled against
          // rawDf/valType matching further down; a Q row with no valuation
          // type on this line can't be scope-checked here, so it's excluded
          // unless the user is Admin (matches "deny when unknown").
          if ("Special Stock Type" in r) {
            const sst = String(r["Special Stock Type"]).trim().toUpperCase();
            if (sst === "Q") {
              const hasOwnValType = "Inventory Valuation Type" in r && String(r["Inventory Valuation Type"] || "").trim() !== "";
              if (hasOwnValType) {
                if (!canAccessRow(r)) { excludedRows++; continue; }
              } else if (!isAdminUser()) {
                excludedRows++; continue;
              }
            }
          }

          const posting = parseExpiryDate(r["Posting Date"]);
          if (!posting) continue;
          const plant = String(r["Plant"] || "").trim().toUpperCase();
          const storageLoc = String(r["Storage Location"] || "").trim().toUpperCase();

          const key = `${mat}|${batch}`;
          const existing = map.get(key);
          // Earliest posting date per material+batch = the original GR date
          if (!existing || posting < existing.postingDate) {
            map.set(key, { postingDate: posting, plant, storageLoc, hits: existing ? existing.hits + 1 : 1 });
          } else {
            existing.hits += 1;
          }
          parsedRows++;
        }

        if (!map.size) throw new Error("No usable rows found — check the Material, Batch, and Posting Date columns.");

        grMap = map;
        grLoaded = true;

        if (statusEl) statusEl.innerHTML =
          `<div class="status-ok">✓ LOADED</div><div class="status-name">${escHtml(file.name)}</div>` +
          `<div class="status-name" style="color:var(--green)">${map.size} batch receipt${map.size === 1 ? "" : "s"} indexed (${parsedRows} rows${excludedRows ? `, ${excludedRows} excluded` : ""})</div>`;
        if (btnEl) btnEl.textContent = "🚚 Change Incoming GR File";

      } catch (err) {
        console.error("Incoming GR load error:", err);
        if (statusEl) {
          statusEl.style.display = "block";
          statusEl.innerHTML = `<div class="status-error">⚠️ ${escHtml(err.message)}</div>`;
        }
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Highlight first match of `q` inside `text` (same pattern as who-responsible.js) ──
  function highlight(text, q) {
    const safe = escHtml(String(text ?? ""));
    if (!q) return safe;
    const idx = String(text ?? "").toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return safe;
    const raw = String(text ?? "");
    const before = escHtml(raw.slice(0, idx));
    const match  = escHtml(raw.slice(idx, idx + q.length));
    const after  = escHtml(raw.slice(idx + q.length));
    return `${before}<mark>${match}</mark>${after}`;
  }

  // ── Find matching materials directly from the inventory file (rawDf) ─────────
  // Independent of the AMC file — works as soon as the main inventory Excel is loaded.
  function findMatches(query) {
    if (typeof rawDf === "undefined" || !rawDf.length) return { rows: [], noData: true };
    const q = query.trim().toLowerCase();
    if (!q) return { rows: [], noData: false };

    let pool = rawDf;
    if (typeof personFilter !== "undefined" && personFilter.size > 0 && typeof getPersonFilteredCodes === "function") {
      const codes = getPersonFilteredCodes();
      if (codes) pool = pool.filter(r => codes.has(String(r["Material"] || "").trim().toUpperCase()));
    }

    const seen = new Map(); // code → desc
    for (const r of pool) {
      const code = String(r["Material"] || "").trim();
      if (!code || seen.has(code)) continue;
      seen.set(code, String(r["Material Description"] || "").trim());
    }

    const starts = [];
    const contains = [];
    for (const [code, desc] of seen) {
      const c = code.toLowerCase();
      const d = desc.toLowerCase();
      if (c.startsWith(q) || d.startsWith(q)) starts.push({ code, desc });
      else if (c.includes(q) || d.includes(q)) contains.push({ code, desc });
      if (starts.length + contains.length >= MAX_SUGGESTIONS * 4) break; // cheap early-out
    }
    return { rows: [...starts, ...contains].slice(0, MAX_SUGGESTIONS), noData: false };
  }

  // ── Suggestions dropdown (mirrors who-responsible.js, new element ids) ───────
  function positionSuggestions() {
    const input = document.getElementById("shelf-input");
    const box   = document.getElementById("shelf-suggestions");
    if (!input || !box) return;
    const r = input.getBoundingClientRect();
    box.style.left  = `${r.left}px`;
    box.style.top   = `${r.bottom + 4}px`;
    box.style.width = `${r.width}px`;
  }

  function closeSuggestions() {
    const box = document.getElementById("shelf-suggestions");
    if (!box) return;
    box.classList.remove("open");
    box.innerHTML = "";
    currentMatches = [];
    activeIndex = -1;
  }

  function renderSuggestions(query) {
    const box = document.getElementById("shelf-suggestions");
    if (!box) return;

    const { rows, noData } = findMatches(query);
    currentMatches = rows;
    activeIndex = -1;

    if (noData) {
      box.innerHTML = `<div class="who-resp-empty">Upload the <b>main inventory Excel</b> in the sidebar to enable this search.</div>`;
      positionSuggestions();
      box.classList.add("open");
      return;
    }
    if (!rows.length) {
      box.innerHTML = query.trim()
        ? `<div class="who-resp-empty">No matching materials.</div>`
        : "";
      positionSuggestions();
      box.classList.toggle("open", !!query.trim());
      return;
    }

    const q = query.trim();
    box.innerHTML = rows.map((r, i) => `
      <div class="who-resp-item${selectedCodes.has(r.code) ? " shelf-item-selected" : ""}" data-idx="${i}" data-code="${escHtml(r.code)}">
        <span class="who-resp-item-code">${highlight(r.code, q)}</span>
        <span class="who-resp-item-desc">${highlight(r.desc || "—", q)}</span>
      </div>
    `).join("");
    positionSuggestions();
    box.classList.add("open");
  }

  function setActive(idx) {
    const items = document.querySelectorAll("#shelf-suggestions .who-resp-item");
    items.forEach(el => el.classList.remove("who-resp-active"));
    if (idx >= 0 && idx < items.length) {
      items[idx].classList.add("who-resp-active");
      items[idx].scrollIntoView({ block: "nearest" });
    }
    activeIndex = idx;
  }

  // ── Date / shelf-life math ────────────────────────────────────────────────
  function daysBetween(a, b) {
    if (!(a instanceof Date) || isNaN(a) || !(b instanceof Date) || isNaN(b)) return null;
    return (b.getTime() - a.getTime()) / MS_PER_DAY;
  }
  function fmtDaysMo(days) {
    if (days === null || days === undefined || isNaN(days)) return "—";
    const mo = days / DAYS_PER_MO;
    return `${Math.round(days).toLocaleString()} d (~${mo.toFixed(1)} mo)`;
  }
  function isNonExpiring(expiry) {
    return expiry instanceof Date && !isNaN(expiry) && expiry.getFullYear() >= NO_EXPIRY_YEAR_CUTOFF;
  }
  function statusBadge(row) {
    if (row.nonExpiring) return `<span class="shelf-badge shelf-badge-grey">Non-expiring</span>`;
    if (row.remainPct === null) return `<span class="shelf-badge shelf-badge-grey">Incomplete data</span>`;
    if (row.remainPct < 0)   return `<span class="shelf-badge shelf-badge-red">Expired at receipt</span>`;
    if (row.remainPct < 50)  return `<span class="shelf-badge shelf-badge-red">Low</span>`;
    if (row.remainPct < 80)  return `<span class="shelf-badge shelf-badge-amber">Acceptable</span>`;
    return `<span class="shelf-badge shelf-badge-green">Good</span>`;
  }

  // ── Build the batch-level dataset shown in the modal ──────────────────────
  function buildBatchRows(code) {
    // Exclude phantom/unverified-transit rows (same convention used app-wide:
    // r._phantomTransitQty > 0, stamped by stampUnverifiedTransit() in script.js
    // from the hardcoded UNVERIFIED_TRANSIT_LIST). These are unverified stock-in-
    // transit amounts, not confirmed on-hand batches, so they have no place in
    // a shelf-life lookup.
    const rows = rawDf.filter(r =>
      String(r["Material"] || "").trim() === code &&
      !(r._phantomTransitQty > 0) &&
      Number(r["Total Qty"] || 0) > 0   // only batches with actual quantity on hand at that plant
    );
    const out = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const r of rows) {
      const batch   = String(r["Batch"] || "").trim();
      const plant   = String(r["Plant"] || "").trim().toUpperCase();
      const storageLoc = String(r["Storage Location"] || "").trim();
      const valType = String(r["Inventory Valuation Type"] || "").trim();
      const qty     = Number(r["Total Qty"] || 0);
      const prod    = r._prodDate instanceof Date && !isNaN(r._prodDate) ? r._prodDate : null;
      const expiry  = r._expiry   instanceof Date && !isNaN(r._expiry)   ? r._expiry   : null;
      const nonExpiring = isNonExpiring(expiry);

      const grEntry = batch ? grMap.get(`${code}|${batch}`) : null;
      const posting = grEntry ? grEntry.postingDate : null;
      // Storage Location as of the original Goods Receipt (from the Incoming
      // GR file), distinct from `storageLoc` above which is the CURRENT
      // location from the inventory file — a batch is often moved after receipt.
      const receivedStorageLoc = grEntry ? (grEntry.storageLoc || "") : "";

      const totalShelfDays = (!nonExpiring && prod && expiry) ? daysBetween(prod, expiry) : null;
      const remainAtReceiptDays = (!nonExpiring && posting && expiry) ? daysBetween(posting, expiry) : null;
      const remainPct = (totalShelfDays !== null && totalShelfDays > 0 && remainAtReceiptDays !== null)
        ? (remainAtReceiptDays / totalShelfDays) * 100
        : null;
      // Days left to expiry AS OF TODAY (not at receipt) — negative means already expired.
      const daysLeftToday = (!nonExpiring && expiry) ? daysBetween(today, expiry) : null;

      out.push({
        batch, plant, storageLoc, receivedStorageLoc, valType, qty,
        prod, expiry, posting, nonExpiring,
        totalShelfDays, remainAtReceiptDays, remainPct, daysLeftToday,
        grMatched: !!grEntry,
      });
    }

    // Worst shelf-life % first (nulls/non-expiring last) — surfaces the batches
    // that need attention right at the top of the table.
    out.sort((a, b) => {
      if (a.remainPct === null && b.remainPct === null) return 0;
      if (a.remainPct === null) return 1;
      if (b.remainPct === null) return -1;
      return a.remainPct - b.remainPct;
    });
    return out;
  }

  // ── Result modal ───────────────────────────────────────────────────────────
  function escHandler(e) { if (e.key === "Escape") closeModal(); }

  function closeModal() {
    const overlay = document.getElementById("shelf-modal-overlay");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", escHandler);
  }

  // ── Chip helpers ─────────────────────────────────────────────────────────
  function addCode(code, desc) {
    if (!code || selectedCodes.has(code)) return;
    selectedCodes.set(code, desc || "");
    renderChips();
  }

  function removeCode(code) {
    selectedCodes.delete(code);
    renderChips();
  }

  function renderChips() {
    const row = document.getElementById("shelf-chip-row");
    const btn = document.getElementById("shelf-show-btn");
    if (!row || !btn) return;

    if (!selectedCodes.size) {
      row.innerHTML = "";
      row.classList.remove("open");
      btn.classList.remove("open");
      btn.disabled = true;
      btn.textContent = "🔍 Show Shelf Life";
      return;
    }

    row.classList.add("open");
    btn.classList.add("open");
    row.innerHTML = [...selectedCodes.entries()].map(([code, desc]) => `
      <span class="shelf-chip" data-code="${escHtml(code)}" title="${escHtml(code)}${desc ? " — " + desc : ""}">
        <span class="shelf-chip-text">
          <span class="shelf-chip-code">${escHtml(code)}</span>
          ${desc ? `<span class="shelf-chip-desc">${escHtml(desc)}</span>` : ""}
        </span>
        <button type="button" class="shelf-chip-x" data-code="${escHtml(code)}" aria-label="Remove ${escHtml(code)}">✕</button>
      </span>
    `).join("") + (selectedCodes.size > 1 ? `<button type="button" class="shelf-chip-clear" id="shelf-chip-clear">Clear all</button>` : "");

    btn.disabled = false;
    btn.textContent = selectedCodes.size === 1
      ? "🔍 Show Shelf Life"
      : `🔍 Show Shelf Life (${selectedCodes.size} materials)`;
  }

  function selectMatch(idx) {
    const m = currentMatches[idx];
    if (!m) return;
    // Toggle: picking an already-added suggestion removes it again.
    if (selectedCodes.has(m.code)) removeCode(m.code);
    else addCode(m.code, m.desc);

    // Keep the search text and dropdown open (re-rendered so the ✓ marker
    // updates) so multiple matching suggestions can be picked in a row
    // without retyping. Only Escape, clicking away, or manually clearing
    // the box closes it.
    const input = document.getElementById("shelf-input");
    if (input) {
      input.focus();
      renderSuggestions(input.value);
    }
  }

  // ── Bulk paste: paste a list of material codes (space/newline/comma-
  // separated) straight into the input and every recognized one is added
  // as a chip in one go. Unrecognized tokens are reported, not silently
  // dropped. A single-token paste is left alone so normal typing/paste
  // into the input still works as expected. ──────────────────────────────
  function showPasteNote(msg, warn) {
    const note = document.getElementById("shelf-paste-note");
    if (!note) return;
    if (!msg) {
      note.classList.remove("open", "warn");
      note.innerHTML = "";
      return;
    }
    note.innerHTML = msg;
    note.classList.add("open");
    note.classList.toggle("warn", !!warn);
  }

  function handlePaste(e) {
    const clip = e.clipboardData || window.clipboardData;
    const text = clip ? clip.getData("text") : "";
    if (!text) return;

    const tokens = [...new Set(
      text.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean)
    )];
    if (tokens.length <= 1) return; // let default single-value paste behave normally

    e.preventDefault();
    showPasteNote(null);

    if (typeof rawDf === "undefined" || !rawDf.length) {
      showPasteNote("Upload the main inventory Excel first to enable bulk paste.", true);
      return;
    }

    // code (uppercased) → { code, desc } — built fresh each paste since
    // rawDf can change between uploads.
    const codeIndex = new Map();
    for (const r of rawDf) {
      const code = String(r["Material"] || "").trim();
      if (code && !codeIndex.has(code.toUpperCase())) {
        codeIndex.set(code.toUpperCase(), { code, desc: String(r["Material Description"] || "").trim() });
      }
    }

    let added = 0;
    const unmatched = [];
    for (const tok of tokens) {
      const hit = codeIndex.get(tok.toUpperCase());
      if (hit) {
        if (!selectedCodes.has(hit.code)) added++;
        addCode(hit.code, hit.desc);
      } else {
        unmatched.push(tok);
      }
    }

    const input = document.getElementById("shelf-input");
    if (input) input.value = "";

    if (unmatched.length) {
      showPasteNote(
        `✓ Added ${added} material${added === 1 ? "" : "s"}. ${unmatched.length} not found: <b>${unmatched.map(t => escHtml(t)).join(", ")}</b>`,
        true
      );
    } else if (added) {
      showPasteNote(`✓ Added ${added} material${added === 1 ? "" : "s"} from paste.`, false);
    }
  }

  // ── Result modal — accepts one or many material codes at once ─────────────
  function showCards(codes) {
    closeSuggestions();
    if (!codes || !codes.length) return;

    const validCodes = [];
    const descByCode = new Map();
    const emptyCodes = [];
    let allBatches = [];

    for (const code of codes) {
      const rowsAll = rawDf.filter(r => String(r["Material"] || "").trim() === code);
      if (!rowsAll.length) continue;
      const desc = String(rowsAll[0]["Material Description"] || "").trim();
      validCodes.push(code);
      descByCode.set(code, desc);

      const batches = buildBatchRows(code).map(b => ({ ...b, material: code, materialDesc: desc }));
      if (!batches.length) emptyCodes.push(code);
      allBatches = allBatches.concat(batches);
    }
    if (!validCodes.length) return;

    // Re-sort the combined set worst shelf-life % first (nulls/non-expiring
    // last) — same convention as buildBatchRows, now applied across materials.
    allBatches.sort((a, b) => {
      if (a.remainPct === null && b.remainPct === null) return 0;
      if (a.remainPct === null) return 1;
      if (b.remainPct === null) return -1;
      return a.remainPct - b.remainPct;
    });

    const multi = validCodes.length > 1;

    const withPct  = allBatches.filter(b => b.remainPct !== null);
    const avgPct   = withPct.length ? withPct.reduce((s, b) => s + b.remainPct, 0) / withPct.length : null;
    const matchedGr = allBatches.filter(b => b.grMatched).length;
    const missingProd = allBatches.filter(b => !b.nonExpiring && !b.prod).length;

    const kpis = [
      multi ? kpiCard("Materials Selected", String(validCodes.length), emptyCodes.length ? `${emptyCodes.length} with no stock on hand` : "all with stock on hand", emptyCodes.length ? "amber" : "blue") : null,
      kpiCard("Batches on Hand", String(allBatches.length), multi ? "across selected materials" : "currently in stock", "blue"),
      kpiCard("Matched to GR Log", `${matchedGr} / ${allBatches.length}`, grLoaded ? "batches with a receipt date" : "upload Incoming GR.xlsx", grLoaded ? "green" : "amber"),
      kpiCard("Avg. Remaining Shelf Life", avgPct === null ? "—" : `${avgPct.toFixed(1)}%`, "at point of receipt", avgPct === null ? "muted" : (avgPct < 50 ? "red" : avgPct < 80 ? "amber" : "green")),
      kpiCard("Missing Production Date", String(missingProd), "can't compute % for these", missingProd ? "amber" : "green"),
    ].filter(Boolean);

    const cols = [
      ...(multi ? [{ key: "material", label: "Material", cellClass: "col-mat-code-wrap" }] : []),
      { key: "batch",   label: "Batch", cellClass: "col-mat-code-wrap" },
      { key: "plant",   label: "Plant" },
      { key: "storageLoc", label: "Storage Location (Current)" },
      { key: "receivedStorageLoc", label: "Storage Location (Received)", fmt: (v, r) => v ? v : (grLoaded ? "—" : "Upload GR file") },
      { key: "valType", label: "Valuation Type" },
      { key: "qty",     label: "Qty on Hand", fmt: fmtQty },
      { key: "prod",    label: "Production Date", fmt: v => v ? fmtLocalDate(v) : "—" },
      { key: "expiry",  label: "Expiration Date", fmt: (v, r) => r.nonExpiring ? "No expiry" : (v ? fmtLocalDate(v) : "—") },
      { key: "posting", label: "GR Posting Date", fmt: v => v ? fmtLocalDate(v) : "—" },
      { key: "totalShelfDays", label: "Total Shelf Life", fmt: v => fmtDaysMo(v) },
      { key: "remainAtReceiptDays", label: "Remaining at Receipt", fmt: v => fmtDaysMo(v) },
      { key: "remainPct", label: "Remaining % at Receipt", fmt: v => v === null ? "—" : `${v.toFixed(1)}%` },
      { key: "daysLeftToday", label: "Days Left to Expiry (Today)", fmt: (v, r) => r.nonExpiring ? "No expiry" : (v === null ? "—" : `${Math.round(v).toLocaleString()} d`) },
      { key: "_status", label: "Status", fmt: (v, r) => statusBadge(r), raw: true },
    ];

    const noteParts = [];
    if (!grLoaded) noteParts.push(`📌 <b>Incoming GR.xlsx</b> hasn't been uploaded yet, so <b>GR Posting Date</b> and <b>Remaining % at Receipt</b> can't be computed. Upload it via <b>🚚 Upload Incoming GR.xlsx</b> in the sidebar to complete this view.`);
    if (missingProd) noteParts.push(`📌 ${missingProd} batch${missingProd === 1 ? "" : "es"} above ${missingProd === 1 ? "has" : "have"} no <b>Production Date</b> on file (common — SAP doesn't always capture it per batch), so their % can't be calculated. Their Expiration Date and GR Posting Date are still shown where available.`);
    if (emptyCodes.length) noteParts.push(`📌 No batches currently on hand for: <b>${emptyCodes.map(c => escHtml(c)).join(", ")}</b>.`);
    const note = noteParts.length ? `<div class="shelf-note">${noteParts.join("<br>")}</div>` : "";

    const headerCode = multi ? `${validCodes.length} Materials Selected` : validCodes[0];
    const headerDesc = multi
      ? validCodes.map(c => descByCode.get(c) ? `${c} — ${descByCode.get(c)}` : c).join(" · ")
      : (descByCode.get(validCodes[0]) || "—");

    const overlay = document.createElement("div");
    overlay.id = "shelf-modal-overlay";
    overlay.className = "who-resp-modal-overlay";
    overlay.innerHTML = `
      <div class="shelf-modal" role="dialog" aria-modal="true" aria-label="Shelf life for ${escHtml(headerCode)}">
        <button class="who-resp-modal-close" id="shelf-modal-close" type="button" aria-label="Close">✕</button>
        <div class="who-resp-modal-header">
          <div class="who-resp-modal-code">${escHtml(headerCode)}</div>
          <div class="who-resp-modal-desc${multi ? " who-resp-modal-desc-multi" : ""}">${escHtml(headerDesc || "—")}</div>
        </div>
        <div class="shelf-kpi-row">${kpis.join("")}</div>
        ${note}
        <div class="shelf-batch-wrap" id="shelf-batch-table"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("shelf-batch-table").innerHTML = allBatches.length
      ? buildTable(allBatches, cols, r => r.nonExpiring ? "" : ((r.remainPct !== null && r.remainPct < 50) || (r.daysLeftToday !== null && r.daysLeftToday < 0) ? "row-red" : ""), "", { id: "shelf-batch-export", title: "" })
      : '<div class="alert-info" style="margin:0.5rem 0">No batches currently on hand for the selected material(s).</div>';

    if (allBatches.length) {
      const exportCols = [
        ...(multi ? [{ key: "material", label: "Material" }] : []),
        { key: "batch", label: "Batch" }, { key: "plant", label: "Plant" }, { key: "storageLoc", label: "Storage Location (Current)" },
        { key: "receivedStorageLoc", label: "Storage Location (Received)" },
        { key: "valType", label: "Valuation Type" },
        { key: "qty", label: "Qty on Hand", fmt: v => Number(v).toFixed(2) },
        { key: "prod", label: "Production Date", fmt: v => v ? fmtLocalDate(v) : "" },
        { key: "expiry", label: "Expiration Date", fmt: (v, r) => r.nonExpiring ? "No expiry" : (v ? fmtLocalDate(v) : "") },
        { key: "posting", label: "GR Posting Date", fmt: v => v ? fmtLocalDate(v) : "" },
        { key: "totalShelfDays", label: "Total Shelf Life (days)", fmt: v => v === null ? "" : Number(v).toFixed(1) },
        { key: "remainAtReceiptDays", label: "Remaining at Receipt (days)", fmt: v => v === null ? "" : Number(v).toFixed(1) },
        { key: "remainPct", label: "Remaining % at Receipt", fmt: v => v === null ? "" : Number(v).toFixed(1) },
        { key: "daysLeftToday", label: "Days Left to Expiry (Today)", fmt: (v, r) => r.nonExpiring ? "No expiry" : (v === null ? "" : Number(v).toFixed(1)) },
      ];
      const fname = multi ? `shelf_life_multi_${validCodes.length}materials` : `shelf_life_${validCodes[0]}`;
      wireTableExport("shelf-batch-export", allBatches, exportCols, fname);
    }

    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    document.getElementById("shelf-modal-close").addEventListener("click", closeModal);
    document.addEventListener("keydown", escHandler);
  }

  // ── 🆕 New Received Stock ───────────────────────────────────────────────────
  // Lists every batch whose GR Posting Date (from the uploaded Incoming GR.xlsx)
  // falls inside a chosen window — "last N days" by default, or an explicit
  // From/To date range. Cross-references rawDf (by Material+Batch) to show
  // current Qty on Hand and Expiration Date where the batch is still in stock;
  // batches already fully consumed/moved on are still listed (GR did happen)
  // but flagged as no longer on hand.
  function escHandlerIncoming(e) { if (e.key === "Escape") closeIncomingModal(); }

  function closeIncomingModal() {
    const overlay = document.getElementById("incoming-modal-overlay");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", escHandlerIncoming);
  }

  function buildNewIncomingRows(fromDate, toDate, valTypeFilter) {
    const out = [];
    if (!grLoaded || !grMap.size) return out;

    // Material Type filter (ZME/ZMS/ZLC/ZMD, checklist). Batches with no
    // known/matched Valuation Type (already consumed / moved on, so there's
    // no current stock row to read a type from) are excluded whenever this
    // filter is active — we can't confirm they match, so they don't show.
    const hasValTypeFilter = !!(valTypeFilter && valTypeFilter.length);
    let excludedUnknownType = 0;

    let allowedCodes = null;
    if (typeof personFilter !== "undefined" && personFilter.size > 0 && typeof getPersonFilteredCodes === "function") {
      allowedCodes = getPersonFilteredCodes();
    }

    const descByMaterial = new Map();
    const stockByKey = new Map(); // "material|batch" → { qty, expiry, nonExpiring, prod, plants:Set }
    if (typeof rawDf !== "undefined") {
      for (const r of rawDf) {
        const mat = String(r["Material"] || "").trim();
        if (!mat) continue;
        if (!descByMaterial.has(mat)) descByMaterial.set(mat, String(r["Material Description"] || "").trim());

        const batch = String(r["Batch"] || "").trim();
        if (!batch || (r._phantomTransitQty > 0)) continue;
        const qty = Number(r["Total Qty"] || 0);
        if (!(qty > 0)) continue;

        const key = `${mat}|${batch}`;
        const expiry = r._expiry instanceof Date && !isNaN(r._expiry) ? r._expiry : null;
        const prod   = r._prodDate instanceof Date && !isNaN(r._prodDate) ? r._prodDate : null;
        const plant = String(r["Plant"] || "").trim().toUpperCase();
        const storageLoc = String(r["Storage Location"] || "").trim();
        const valType = (typeof getValuationType === "function"
          ? getValuationType(r)
          : String(r["Inventory Valuation Type"] || "").trim()) || null;
        const existing = stockByKey.get(key);
        if (existing) {
          existing.qty += qty;
          existing.plants.add(plant);
          if (storageLoc) existing.storageLocs.add(storageLoc);
          if (!existing.prod && prod) existing.prod = prod;
          if (!existing.valType && valType) existing.valType = valType;
        } else {
          stockByKey.set(key, { qty, expiry, nonExpiring: isNonExpiring(expiry), prod, valType, plants: new Set([plant]), storageLocs: new Set(storageLoc ? [storageLoc] : []) });
        }
      }
    }

    for (const [key, gr] of grMap) {
      if (gr.postingDate < fromDate || gr.postingDate > toDate) continue;
      const sep = key.indexOf("|");
      const material = key.slice(0, sep);
      const batch = key.slice(sep + 1);
      if (isNonMedicalCode(material)) continue; // belt-and-suspenders vs. filters.js exclusions
      if (allowedCodes && !allowedCodes.has(material.toUpperCase())) continue;

      const stock = stockByKey.get(key);

      // BUG FIX: a batch with a current stockByKey entry is proven clean —
      // rawDf itself is already filtered at parse time, so its presence there
      // means it's definitely not Project Stock / non-medical / an excluded
      // storage location. But when a batch has no current on-hand match
      // (already consumed, moved on — OR silently excluded because it's
      // Project Stock and the uploaded Incoming GR.xlsx lacks the columns
      // needed to catch that at load time), we can't tell those two cases
      // apart from the GR log alone. In that ambiguous case, fall back to
      // excludedMaterialCodes (captured from the main inventory file across
      // ALL its rows, before filtering) so a material known to carry an
      // excluded classification doesn't still surface here.
      if (!stock && typeof excludedMaterialCodes !== "undefined" && excludedMaterialCodes.has(material)) continue;

      // Material Type filter: a batch with no matched stock row has no known
      // Valuation Type to check against, so it's excluded while the filter
      // is active rather than guessed at.
      const valType = stock ? (stock.valType || null) : null;
      if (hasValTypeFilter && !valType) { excludedUnknownType++; continue; }
      if (hasValTypeFilter && !valTypeFilter.includes(valType)) continue;

      const nonExpiring = stock ? stock.nonExpiring : false;
      const expiry = stock ? stock.expiry : null;
      const prod   = stock ? stock.prod   : null;

      // Same shelf-life math as the Shelf Life Look-up, anchored to this
      // batch's actual GR Posting Date rather than "today".
      const totalShelfDays      = (!nonExpiring && prod && expiry) ? daysBetween(prod, expiry) : null;
      const remainAtReceiptDays = (!nonExpiring && expiry) ? daysBetween(gr.postingDate, expiry) : null;
      const remainPct = (totalShelfDays !== null && totalShelfDays > 0 && remainAtReceiptDays !== null)
        ? (remainAtReceiptDays / totalShelfDays) * 100
        : null;

      out.push({
        material,
        materialDesc: descByMaterial.get(material) || "",
        batch,
        plant: gr.plant || (stock ? [...stock.plants].join(", ") : "") || "—",
        storageLoc: gr.storageLoc || (stock ? [...stock.storageLocs].join(", ") : "") || "—",
        posting: gr.postingDate,
        qty: stock ? stock.qty : null,
        prod, expiry, nonExpiring,
        totalShelfDays, remainAtReceiptDays, remainPct,
        inStock: !!stock,
        valType,
      });
    }

    out.sort((a, b) => b.posting - a.posting); // most recently received first
    out.excludedUnknownType = excludedUnknownType;
    return out;
  }

  function showNewIncoming(fromDate, toDate, valTypeFilter) {
    const rows = buildNewIncomingRows(fromDate, toDate, valTypeFilter);
    const hasValTypeFilter = !!(valTypeFilter && valTypeFilter.length);
    const materials = new Set(rows.map(r => r.material));
    const notInStock = rows.filter(r => !r.inStock).length;
    const totalQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
    const withPct = rows.filter(r => r.remainPct !== null);
    const avgPct  = withPct.length ? withPct.reduce((s, r) => s + r.remainPct, 0) / withPct.length : null;
    const missingProd = rows.filter(r => r.inStock && !r.nonExpiring && !r.prod).length;

    const kpis = [
      kpiCard("Batches Received", String(rows.length), fmtLocalDate(fromDate) + " – " + fmtLocalDate(toDate), "blue"),
      kpiCard("Materials", String(materials.size), "distinct materials", "blue"),
      kpiCard("Total Qty (still on hand)", fmtQty(totalQty), "summed across listed batches", "green"),
      kpiCard("Avg. Remaining Shelf Life", avgPct === null ? "—" : `${avgPct.toFixed(1)}%`, "at point of receipt", avgPct === null ? "muted" : (avgPct < 50 ? "red" : avgPct < 80 ? "amber" : "green")),
      kpiCard("Not Currently on Hand", String(notInStock), notInStock ? "received, but no matching stock row" : "all still in stock", notInStock ? "amber" : "green"),
    ];

    const cols = [
      { key: "material", label: "Material", cellClass: "col-mat-code-wrap" },
      { key: "materialDesc", label: "Description" },
      { key: "batch",   label: "Batch", cellClass: "col-mat-code-wrap" },
      { key: "plant",   label: "Plant" },
      { key: "storageLoc", label: "Storage Location" },
      { key: "valType", label: "Material Type", fmt: v => v || "—" },
      { key: "posting", label: "GR Posting Date", fmt: v => v ? fmtLocalDate(v) : "—" },
      { key: "qty",     label: "Qty", fmt: (v, r) => r.inStock ? fmtQty(v) : "—" },
      { key: "expiry",  label: "Expiration Date", fmt: (v, r) => !r.inStock ? "—" : (r.nonExpiring ? "No expiry" : (v ? fmtLocalDate(v) : "—")) },
      { key: "totalShelfDays", label: "Total Shelf Life", fmt: (v, r) => !r.inStock ? "—" : (r.nonExpiring ? "No expiry" : fmtDaysMo(v)) },
      { key: "remainAtReceiptDays", label: "Shelf Life Remaining (by Month)", fmt: (v, r) => !r.inStock ? "—" : (r.nonExpiring ? "No expiry" : fmtDaysMo(v)) },
      { key: "remainPct", label: "Remaining %", fmt: (v, r) => !r.inStock ? "—" : (r.nonExpiring ? "—" : (v === null ? "—" : `${v.toFixed(1)}%`)) },
      { key: "_status", label: "Status", raw: true, fmt: (v, r) => r.inStock
          ? `<span class="shelf-badge shelf-badge-green">In stock<span class="incoming-new-badge-new">NEW</span></span>`
          : `<span class="shelf-badge shelf-badge-grey">Not on hand</span>` },
    ];

    const noteParts = [];
    if (!rows.length) noteParts.push(`📌 No Goods Receipt rows posted between <b>${escHtml(fmtLocalDate(fromDate))}</b> and <b>${escHtml(fmtLocalDate(toDate))}</b>${hasValTypeFilter ? ` matching the selected Material Type${valTypeFilter.length === 1 ? "" : "s"}` : ""}.`);
    if (notInStock) noteParts.push(`📌 ${notInStock} batch${notInStock === 1 ? "" : "es"} above ${notInStock === 1 ? "was" : "were"} received in this window but ${notInStock === 1 ? "doesn't" : "don't"} currently match an on-hand row in the main inventory (likely already issued out or fully consumed).`);
    if (missingProd) noteParts.push(`📌 ${missingProd} in-stock batch${missingProd === 1 ? "" : "es"} above ${missingProd === 1 ? "has" : "have"} no <b>Production Date</b> on file, so Total Shelf Life and Remaining % can't be calculated for ${missingProd === 1 ? "it" : "them"} — GR Posting Date and Expiration Date are still shown.`);
    if (hasValTypeFilter && rows.excludedUnknownType) noteParts.push(`📌 ${rows.excludedUnknownType} batch${rows.excludedUnknownType === 1 ? "" : "es"} received in this window ${rows.excludedUnknownType === 1 ? "was" : "were"} hidden by the Material Type filter — ${rows.excludedUnknownType === 1 ? "it has" : "they have"} no matching on-hand row, so ${rows.excludedUnknownType === 1 ? "its" : "their"} Material Type can't be confirmed.`);
    const note = noteParts.length ? `<div class="shelf-note">${noteParts.join("<br>")}</div>` : "";

    const overlay = document.createElement("div");
    overlay.id = "incoming-modal-overlay";
    overlay.className = "who-resp-modal-overlay";
    overlay.innerHTML = `
      <div class="shelf-modal" role="dialog" aria-modal="true" aria-label="New Received Stock">
        <button class="who-resp-modal-close" id="incoming-modal-close" type="button" aria-label="Close">✕</button>
        <div class="who-resp-modal-header">
          <div class="who-resp-modal-code">🆕 New Received Stock</div>
          <div class="who-resp-modal-desc">${escHtml(fmtLocalDate(fromDate))} – ${escHtml(fmtLocalDate(toDate))}${hasValTypeFilter ? ` · Material Type: ${escHtml(valTypeFilter.join(", "))}` : ""}</div>
        </div>
        <div class="shelf-kpi-row">${kpis.join("")}</div>
        ${note}
        <div class="shelf-batch-wrap" id="incoming-new-table"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("incoming-new-table").innerHTML = rows.length
      ? buildTable(rows, cols, r => r.inStock ? "" : "row-red", "", { id: "incoming-new-export", title: "" })
      : '<div class="alert-info" style="margin:0.5rem 0">No New Received Stock in this window.</div>';

    if (rows.length) {
      const exportCols = [
        { key: "material", label: "Material" }, { key: "materialDesc", label: "Description" },
        { key: "batch", label: "Batch" }, { key: "plant", label: "Plant" }, { key: "storageLoc", label: "Storage Location" },
        { key: "valType", label: "Material Type", fmt: v => v || "" },
        { key: "posting", label: "GR Posting Date", fmt: v => v ? fmtLocalDate(v) : "" },
        { key: "qty", label: "Qty", fmt: (v, r) => r.inStock ? Number(v).toFixed(2) : "" },
        { key: "expiry", label: "Expiration Date", fmt: (v, r) => !r.inStock ? "" : (r.nonExpiring ? "No expiry" : (v ? fmtLocalDate(v) : "")) },
        { key: "totalShelfDays", label: "Total Shelf Life (days)", fmt: (v, r) => (!r.inStock || v === null) ? "" : Number(v).toFixed(1) },
        { key: "remainAtReceiptDays", label: "Shelf Life Remaining at Receipt (days)", fmt: (v, r) => (!r.inStock || v === null) ? "" : Number(v).toFixed(1) },
        { key: "remainPct", label: "Remaining %", fmt: (v, r) => (!r.inStock || v === null) ? "" : Number(v).toFixed(1) },
        { key: "inStock", label: "Currently On Hand", fmt: v => v ? "Yes" : "No" },
      ];
      const vtSuffix = hasValTypeFilter ? `_${valTypeFilter.join("-")}` : "";
      wireTableExport("incoming-new-export", rows, exportCols, `new_incoming_${fmtLocalDate(fromDate)}_to_${fmtLocalDate(toDate)}${vtSuffix}`.replace(/\s+/g, "_"));
    }

    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeIncomingModal(); });
    document.getElementById("incoming-modal-close").addEventListener("click", closeIncomingModal);
    document.addEventListener("keydown", escHandlerIncoming);
  }

  function runNewIncoming() {
    const noteEl  = document.getElementById("incoming-new-note");
    const daysEl  = document.getElementById("incoming-new-days");
    const fromEl  = document.getElementById("incoming-new-from");
    const toEl    = document.getElementById("incoming-new-to");
    if (noteEl) { noteEl.style.display = "none"; noteEl.innerHTML = ""; }

    if (!grLoaded) {
      if (noteEl) { noteEl.style.display = "block"; noteEl.innerHTML = `📌 Upload <b>Incoming GR.xlsx</b> in the sidebar first — that's what supplies Goods Receipt dates.`; }
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let fromDate, toDate;
    const fromVal = fromEl && fromEl.value ? new Date(fromEl.value + "T00:00:00") : null;
    const toVal   = toEl   && toEl.value   ? new Date(toEl.value   + "T00:00:00") : null;

    if (fromVal && toVal) {
      fromDate = fromVal;
      toDate   = toVal;
      if (fromDate > toDate) {
        if (noteEl) { noteEl.style.display = "block"; noteEl.innerHTML = `📌 The "from" date is after the "to" date.`; }
        return;
      }
    } else {
      const days = Math.max(1, Math.min(365, parseInt(daysEl && daysEl.value, 10) || 5));
      toDate = today;
      fromDate = new Date(today.getTime() - (days - 1) * MS_PER_DAY);
    }

    const vtWrap = document.getElementById("ms-incoming-new-vt");
    const valTypeFilter = (vtWrap && vtWrap._getSelected) ? vtWrap._getSelected() : [];

    showNewIncoming(fromDate, toDate, valTypeFilter);
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function wire() {
    const input = document.getElementById("shelf-input");
    const box   = document.getElementById("shelf-suggestions");
    if (input && box) {
      input.addEventListener("input", () => renderSuggestions(input.value));
      input.addEventListener("focus", () => { if (input.value.trim()) renderSuggestions(input.value); });
      input.addEventListener("paste", handlePaste);

      input.addEventListener("keydown", (e) => {
        const items = document.querySelectorAll("#shelf-suggestions .who-resp-item");
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (!items.length) return;
          setActive(activeIndex < items.length - 1 ? activeIndex + 1 : 0);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (!items.length) return;
          setActive(activeIndex > 0 ? activeIndex - 1 : items.length - 1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (activeIndex >= 0) selectMatch(activeIndex);
          else if (currentMatches.length) selectMatch(0);
          // Empty input + at least one chip already picked: Enter is a
          // shortcut for hitting "Show Shelf Life".
          else if (!input.value.trim() && selectedCodes.size) {
            showCards([...selectedCodes.keys()]);
          }
        } else if (e.key === "Escape") {
          closeSuggestions();
          input.blur();
        }
      });

      box.addEventListener("click", (e) => {
        const item = e.target.closest(".who-resp-item[data-idx]");
        if (!item) return;
        e.stopPropagation(); // selecting re-renders the box; don't let this
                              // click also hit the document "click outside"
                              // listener below, which would close it again.
        selectMatch(Number(item.dataset.idx));
      });

      document.addEventListener("click", (e) => {
        if (e.target === input || box.contains(e.target)) return;
        closeSuggestions();
      });

      window.addEventListener("resize", () => { if (box.classList.contains("open")) positionSuggestions(); });
      window.addEventListener("scroll", () => { if (box.classList.contains("open")) positionSuggestions(); }, true);
    }

    const chipRow = document.getElementById("shelf-chip-row");
    if (chipRow) {
      chipRow.addEventListener("click", (e) => {
        if (e.target.closest("#shelf-chip-clear")) {
          selectedCodes.clear();
          renderChips();
          showPasteNote(null);
          return;
        }
        const x = e.target.closest(".shelf-chip-x[data-code]");
        if (x) { removeCode(x.dataset.code); showPasteNote(null); }
      });
    }

    const showBtn = document.getElementById("shelf-show-btn");
    if (showBtn) {
      showBtn.addEventListener("click", () => {
        if (!selectedCodes.size) return;
        showCards([...selectedCodes.keys()]);
      });
    }

    const grInput = document.getElementById("incomingFileInput");
    if (grInput) {
      grInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) loadIncomingGrFile(e.target.files[0]);
      });
    }

    const incomingShowBtn = document.getElementById("incoming-new-show-btn");
    if (incomingShowBtn) incomingShowBtn.addEventListener("click", runNewIncoming);

    // Material Type checklist (ZME/ZMS/ZLC/ZMD) for New Received Stock —
    // same fixed set and multi-select control used for Material Type
    // elsewhere in the app.
    if (typeof buildMultiSelect === "function" && document.getElementById("ms-incoming-new-vt")) {
      buildMultiSelect("ms-incoming-new-vt", "ms-incoming-new-vt-dd", ["ZME", "ZMS", "ZLC", "ZMD"], "All Material Types");
    }

    // Picking an explicit date clears the "last N days" quick input so it's
    // obvious which mode will be used, and vice versa.
    const incomingDays = document.getElementById("incoming-new-days");
    const incomingFrom = document.getElementById("incoming-new-from");
    const incomingTo   = document.getElementById("incoming-new-to");
    if (incomingFrom || incomingTo) {
      [incomingFrom, incomingTo].forEach(el => {
        if (!el) return;
        el.addEventListener("input", () => { if (el.value && incomingDays) incomingDays.value = ""; });
      });
    }
    if (incomingDays) {
      incomingDays.addEventListener("input", () => {
        if (incomingDays.value) {
          if (incomingFrom) incomingFrom.value = "";
          if (incomingTo) incomingTo.value = "";
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
