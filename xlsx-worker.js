// ════════════════════════════════════════════════════════════════
// xlsx-worker.js — MOBILE/PERF FIX
//
// Moves the two genuinely expensive, CPU-bound steps of loading a large
// Excel export — XLSX.read() (binary parse) and sheet_to_json() (row
// materialization) — off the main thread and into a Web Worker, so the
// UI (scrolling, taps, the "⏳ LOADING…" animation itself) never freezes
// while a big file is being parsed.
//
// Scope is intentionally narrow: this worker does ONLY generic, domain-
// free spreadsheet parsing (read workbook → first sheet → JSON rows →
// trim header whitespace). All of EPSS's actual business logic
// (exclusion rules, role/scope filtering, numeric coercion, mapping,
// etc. — see loadFile() in script.js) still runs on the main thread,
// completely unchanged, on the plain array of row objects this worker
// hands back. That keeps this file safe to add without touching any
// domain logic anywhere else in the app.
//
// Protocol (structured-clone messages, no external deps other than the
// SheetJS build already used everywhere else in this app):
//   → { id, buffer: ArrayBuffer, fileName, mode?: "array" | "string" }
//   ← { id, stage: "parsing" }              (workbook decode starting)
//   ← { id, stage: "indexing" }             (sheet → row objects starting)
//   ← { id, stage: "done", rows: [...] }    (success — rows already header-trimmed)
//   ← { id, stage: "error", message }       (failure — caller should fall back)
// ════════════════════════════════════════════════════════════════

// Workers can't use the same <script src> tags the main document uses,
// so we pull in the identical SheetJS build via importScripts(). Same
// CDN + version as index.html/sw.js — keep these in sync.
try {
  importScripts("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
} catch (err) {
  // If the CDN script itself fails to load inside the worker (offline on
  // first-ever visit, blocked host, etc.) every future "parse" message
  // will fail fast and clearly below rather than throwing a confusing
  // "XLSX is not defined" — the main thread's fallback path then takes
  // over transparently (see parseWorkbookOffThread in script.js).
  self.__xlsxLoadError = err;
}

self.onmessage = function (e) {
  const { id, buffer, mode } = e.data || {};
  if (self.__xlsxLoadError || typeof XLSX === "undefined") {
    postMessage({ id, stage: "error", message: "XLSX library unavailable in worker" });
    return;
  }

  try {
    postMessage({ id, stage: "parsing" });

    const wb = mode === "string"
      ? XLSX.read(buffer, { type: "string" })
      : XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: true });

    const ws = wb.Sheets[wb.SheetNames[0]];

    postMessage({ id, stage: "indexing" });

    const data = XLSX.utils.sheet_to_json(ws, { defval: "" });

    // Trim header whitespace here (same transform loadFile() used to do
    // on the main thread right after parsing) so callers can use the
    // result directly.
    const trimmed = data.map(row => {
      const r = {};
      for (const key in row) {
        if (Object.prototype.hasOwnProperty.call(row, key)) r[key.trim()] = row[key];
      }
      return r;
    });

    postMessage({ id, stage: "done", rows: trimmed, sheetNames: wb.SheetNames });
  } catch (err) {
    postMessage({ id, stage: "error", message: (err && err.message) || String(err) });
  }
};
