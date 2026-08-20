// ════════════════════════════════════════════════════════════════
// storage-sync.js — syncs uploaded Excel files through Supabase
// Slots map to your existing file inputs:
//   inventory -> #fileInput         -> bucket path inventory/latest.xlsx
//   mapping   -> #mappingFileInput  -> bucket path mapping/latest.xlsx
//   amc       -> #mosAmcFileInput   -> bucket path amc/latest.xlsx
//   incoming  -> #incomingFileInput -> bucket path incoming/latest.xlsx
//
// Runs AFTER auth.js, BEFORE/alongside script.js. Does not touch your
// existing parsing code — it reuses it by reading the file into the
// real <input type=file> and dispatching a "change" event, exactly
// as if the user picked the file themselves.
// ════════════════════════════════════════════════════════════════

const FILE_SLOTS = {
  inventory:       { inputId: "fileInput",                path: "inventory/latest.xlsx",        statusId: "fileStatus" },
  mapping:         { inputId: "mappingFileInput",         path: "mapping/latest.xlsx",           statusId: "mappingFileStatus" },
  amc:             { inputId: "mosAmcFileInput",          path: "amc/latest.xlsx",               statusId: "mosAmcFileStatus" },
  incoming:        { inputId: "incomingFileInput",        path: "incoming/latest.xlsx",          statusId: "incomingFileStatus" },
  pendingDispatch: { inputId: "pendingDispatchFileInput", path: "pending-dispatch/latest.xlsx",  statusId: "pendingDispatchFileStatus" },
};

// ── Wait for the slot's own status element to leave its "⏳ loading" state ──
// Every loader (loadFile, loadMappingFile, loadMosAmcFile, loadIncomingGrFile)
// writes an hourglass into its status element the instant it starts parsing
// — synchronously, before the FileReader callback ever fires — and replaces
// it with a ✓/✗ result the instant parsing (success or failure) finishes.
// That makes the status element a reliable, zero-plumbing signal for "is
// this slot's async parse actually done yet", without touching script.js,
// mos.js, or shelf-life.js at all.
//
// FIX-RACE: previously pullFileFromSupabase only awaited the network download
// and the synchronous dispatchEvent() call, then immediately moved on to the
// next slot — while the just-dispatched file was still being parsed in the
// background (FileReader + XLSX.read are async). That let inventory and
// mapping (or amc/incoming) finish parsing out of order relative to how an
// admin uploads them by hand (one at a time, with a natural pause between
// clicks), so a viewer's page could render — and, if refreshed at the wrong
// moment, keep showing — dashboard totals computed from unmapped/partial
// data instead of the fully material-standardized totals an admin sees.
function waitForParseSettle(statusId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const el = document.getElementById(statusId);
    if (!el) { resolve(); return; }

    const isLoading = () => (el.textContent || "").includes("⏳");

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      observer.disconnect();
      resolve();
    };

    const observer = new MutationObserver(() => { if (!isLoading()) finish(); });
    observer.observe(el, { childList: true, subtree: true, characterData: true });

    // Absolute ceiling so a stuck or silently-failing loader can never hang
    // the rest of the pull sequence forever.
    const hardTimeout = setTimeout(finish, timeoutMs);

    // By the time dispatchEvent() returns, the loader's synchronous
    // "start parsing" DOM write has already happened — so isLoading() should
    // already be true here. This just covers the edge case of a slot with no
    // registered loader at all (nothing will ever set "⏳"), so we don't wait
    // out the full timeout for no reason.
    if (!isLoading()) finish();
  });
}

const BUCKET = "inventory-files";

// ── Clock correction ────────────────────────────────────────
// uploaded_at must never be trusted straight from this machine's clock —
// if the uploader's laptop time is wrong, that wrong value gets written to
// Supabase and every viewer sees it, permanently, regardless of their own
// clock. To avoid depending on this machine's clock at all, we estimate how
// far off it is from real time by reading the "Date" response header that
// every HTTP response is required to send (RFC 7231), via a lightweight
// same-origin request, and apply that offset whenever we timestamp
// something. Best-effort: if the sync request fails (offline/blocked), the
// offset stays 0 and we fall back to the raw (possibly wrong) local clock,
// same as before this fix.
let CLOCK_OFFSET_MS = 0;
let clockSyncPromise = null;

function syncClockOffset(forceRefresh) {
  if (clockSyncPromise && !forceRefresh) return clockSyncPromise;
  clockSyncPromise = fetch(location.href, { method: "HEAD", cache: "no-store" })
    .then((res) => {
      const hdr = res.headers.get("Date");
      if (!hdr) return;
      const serverMs = new Date(hdr).getTime();
      if (!isNaN(serverMs)) CLOCK_OFFSET_MS = serverMs - Date.now();
    })
    .catch(() => {}); // offline/blocked — silently keep offset at 0
  return clockSyncPromise;
}
// Kick off a sync as soon as this script runs, so the offset is usually
// already known well before any upload happens.
syncClockOffset();

function correctedNow() {
  return new Date(Date.now() + CLOCK_OFFSET_MS);
}

// ── Friendlier toast/status labels for multi-word slot names ──
const SLOT_LABELS = { pendingDispatch: "Pending Dispatch" };
function slotLabel(slot) {
  return SLOT_LABELS[slot] || (slot.charAt(0).toUpperCase() + slot.slice(1));
}

// ── Relative time formatting (e.g. "3h ago", "just now") ──
function formatRelativeTime(isoOrDate) {
  if (!isoOrDate) return null;
  const then = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (isNaN(then.getTime())) return null;
  const diffMs = correctedNow().getTime() - then.getTime();
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30)  return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ── Sync-info row: "Last synced Xh ago" + a per-slot "Refresh now" button ──
// Rendered as a sibling of the slot's existing #<statusId> element (never
// inside it — script.js/mos.js/shelf-life.js's loaders overwrite that
// element's innerHTML wholesale on every load, which would silently wipe
// out anything we nested in there).
const slotMeta = {}; // slot -> { uploadedAt: Date|null, filename: string|null }

function ensureSyncInfoStyles() {
  if (document.getElementById("sync-info-styles")) return;
  const style = document.createElement("style");
  style.id = "sync-info-styles";
  style.textContent = `
    .sync-info-row {
      display: flex; align-items: center; gap: 8px;
      margin-top: 4px; font-size: 0.72rem; opacity: 0.75;
    }
    .sync-info-row .sync-info-text { flex: 1; min-width: 0; }
    .sync-info-refresh-btn {
      background: none; border: 1px solid currentColor; border-radius: 6px;
      padding: 2px 8px; font-size: 0.7rem; cursor: pointer; opacity: 0.85;
      color: inherit; flex-shrink: 0; line-height: 1.4;
    }
    .sync-info-refresh-btn:hover { opacity: 1; }
    .sync-info-refresh-btn:disabled { opacity: 0.4; cursor: default; }
  `;
  document.head.appendChild(style);
}

function ensureSyncInfoEl(slot) {
  const { statusId } = FILE_SLOTS[slot];
  const wrapId = `${statusId}-sync-info`;
  let el = document.getElementById(wrapId);
  if (el) return el;

  const statusEl = document.getElementById(statusId);
  if (!statusEl || !statusEl.parentNode) return null;

  ensureSyncInfoStyles();
  el = document.createElement("div");
  el.id = wrapId;
  el.className = "sync-info-row";
  el.innerHTML = `<span class="sync-info-text"></span><button type="button" class="sync-info-refresh-btn">🔄 Refresh</button>`;
  statusEl.insertAdjacentElement("afterend", el);

  el.querySelector(".sync-info-refresh-btn").addEventListener("click", () => manualRefresh(slot));
  return el;
}

function renderSyncInfo(slot) {
  const el = ensureSyncInfoEl(slot);
  if (!el) return;
  const meta = slotMeta[slot];
  const textEl = el.querySelector(".sync-info-text");
  const btnEl  = el.querySelector(".sync-info-refresh-btn");
  if (!meta || !meta.uploadedAt) {
    textEl.textContent = "Not yet synced";
  } else {
    const rel = formatRelativeTime(meta.uploadedAt);
    textEl.textContent = `Last synced ${rel || "—"}${meta.filename ? ` · ${meta.filename}` : ""}`;
    textEl.title = meta.uploadedAt.toLocaleString();
  }
  if (btnEl) btnEl.disabled = false;

  // Let pending-dispatch.js (or anything else) know this slot's upload
  // metadata just changed, so it can show its own "data as of" indicator
  // without storage-sync.js needing to know that page's internals.
  if (slot === "pendingDispatch") {
    document.dispatchEvent(new CustomEvent("pd-source-meta", { detail: meta || null }));
  }
}

// Keep the "Xh ago" text fresh without re-fetching, since the underlying
// timestamp doesn't change between real syncs.
setInterval(() => {
  Object.keys(slotMeta).forEach(slot => { if (slotMeta[slot] && slotMeta[slot].uploadedAt) renderSyncInfo(slot); });
}, 60 * 1000);

async function fetchSlotMetadata(slot) {
  const sc = window.supabaseClient;
  const { path } = FILE_SLOTS[slot];
  try {
    const { data, error } = await sc.from("app_files").select("uploaded_at, filename").eq("slot", slot).eq("storage_path", path).maybeSingle();
    if (error || !data) return null;
    return { uploadedAt: data.uploaded_at ? new Date(data.uploaded_at) : null, filename: data.filename || null };
  } catch (e) {
    console.error(`[storage-sync] Metadata fetch failed (${slot}):`, e);
    return null;
  }
}

async function manualRefresh(slot) {
  const el = ensureSyncInfoEl(slot);
  const btnEl = el && el.querySelector(".sync-info-refresh-btn");
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = "⏳ …"; }
  await pullFileFromSupabase(slot);
  if (btnEl) { btnEl.disabled = false; btnEl.textContent = "🔄 Refresh"; }
  const label = slotLabel(slot);
  showToast(`✓ ${label} refreshed`, "ok");
}

// ── Toast notifications ──
function ensureToastStyles() {
  if (document.getElementById("sync-toast-styles")) return;
  const style = document.createElement("style");
  style.id = "sync-toast-styles";
  style.textContent = `
    #sync-toast-stack {
      position: fixed; top: 16px; right: 16px; z-index: 10000;
      display: flex; flex-direction: column; gap: 8px; max-width: 320px;
    }
    .sync-toast {
      padding: 10px 14px; border-radius: 8px; font-size: 0.82rem;
      color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      display: flex; align-items: center; gap: 8px;
      animation: sync-toast-in 0.2s ease-out;
    }
    .sync-toast.ok   { background: #1f8a4c; }
    .sync-toast.err  { background: #b3322a; }
    .sync-toast.info { background: #2563a8; }
    .sync-toast button {
      margin-left: auto; background: none; border: none; color: #fff;
      opacity: 0.8; cursor: pointer; font-size: 0.9rem; line-height: 1;
    }
    .sync-toast button:hover { opacity: 1; }
    @keyframes sync-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  `;
  document.head.appendChild(style);
}

function showToast(message, type = "info", timeoutMs = 4500) {
  ensureToastStyles();
  let stack = document.getElementById("sync-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "sync-toast-stack";
    document.body.appendChild(stack);
  }
  const el = document.createElement("div");
  el.className = `sync-toast ${type}`;
  el.innerHTML = `<span>${message}</span><button aria-label="Dismiss">✕</button>`;
  el.querySelector("button").addEventListener("click", () => el.remove());
  stack.appendChild(el);
  if (timeoutMs) setTimeout(() => el.remove(), timeoutMs);
  return el;
}

// ── Push: called when an admin selects a file ──
async function pushFileToSupabase(slot, file) {
  const { path } = FILE_SLOTS[slot];
  const sc = window.supabaseClient;
  const label = slotLabel(slot);

  const pending = showToast(`⏳ Syncing ${label} to Supabase…`, "info", 0);

  const { error: upErr } = await sc.storage.from(BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type || "application/octet-stream",
    cacheControl: "0", // FIX-CACHE: never let this fixed-path object be cached — see pullFileFromSupabase
  });
  pending.remove();
  if (upErr) {
    console.error(`Upload failed (${slot}):`, upErr);
    showToast(`✗ ${label} sync failed: ${upErr.message || "unknown error"}`, "err");
    return;
  }

  // FIX-CLOCK: don't trust this machine's system clock for uploaded_at —
  // wait for (or trigger) a clock-offset sync against the server's HTTP
  // Date header first, so the timestamp we write is correct even if the
  // uploader's laptop clock is wrong. This delays the metadata write by at
  // most one lightweight HEAD request (already usually in flight/cached
  // from page load), never a full round trip per upload.
  await syncClockOffset();
  const uploadedAtCorrected = correctedNow();

  const { error: metaErr } = await sc.from("app_files").upsert({
    slot,
    storage_path: path,
    filename: file.name,
    uploaded_by: window.APP_USER ? window.APP_USER.id : null,
    uploaded_at: uploadedAtCorrected.toISOString(),
  });
  if (metaErr) {
    console.error(`Metadata save failed (${slot}):`, metaErr);
    showToast(`⚠️ ${label} file synced, but metadata save failed`, "err");
    return;
  }

  showToast(`✓ ${label} synced — all users will see this on refresh`, "ok");

  slotMeta[slot] = { uploadedAt: uploadedAtCorrected, filename: file.name };
  renderSyncInfo(slot);
}

// ── Pull: called on app load for every signed-in user ──
async function pullFileFromSupabase(slot) {
  const { path, inputId, statusId } = FILE_SLOTS[slot];
  const sc = window.supabaseClient;

  renderSyncInfo(slot); // show whatever we know so far (placeholder on first load)

  // FIX-CACHE: storage.download() can be served from browser/CDN HTTP cache
  // for up to Supabase's default cacheControl (3600s), since every upload
  // reuses the SAME fixed path (upsert to "latest.xlsx"). A page refresh does
  // NOT guarantee a fresh network fetch — so a viewer can keep seeing an old
  // snapshot for up to an hour after an admin uploads a new one, even after
  // reloading, while the admin (who reads the local File object directly,
  // never over the network) always sees the current file. Route around this
  // by fetching a signed URL manually with an explicit cache-busting query
  // param and cache: 'no-store', instead of trusting the SDK's default
  // caching behavior.
  const { data: signed, error: signErr } = await sc.storage.from(BUCKET).createSignedUrl(path, 60);
  if (signErr) {
    if (signErr.statusCode !== "404" && !/not.?found/i.test(signErr.message || "")) {
      console.error(`[storage-sync] Pull failed (${slot}):`, signErr);
    }
    slotMeta[slot] = null;
    renderSyncInfo(slot);
    return;
  }
  const bustedUrl = signed.signedUrl + (signed.signedUrl.includes("?") ? "&" : "?") + "_cb=" + Date.now();
  let blob;
  try {
    const res = await fetch(bustedUrl, { cache: "no-store" });
    if (!res.ok) {
      if (res.status !== 404) console.error(`[storage-sync] Pull fetch failed (${slot}): HTTP ${res.status}`);
      slotMeta[slot] = null;
      renderSyncInfo(slot);
      return;
    }
    blob = await res.blob();
  } catch (err) {
    console.error(`[storage-sync] Pull fetch failed (${slot}):`, err);
    slotMeta[slot] = null;
    renderSyncInfo(slot);
    return;
  }

  const filename = path.split("/").pop();
  const file = new File([blob], filename, { type: blob.type });

  const input = document.getElementById(inputId);
  if (!input) { console.warn(`[storage-sync] No input #${inputId} found for ${slot}`); return; }

  // Populate the real <input type=file> so existing handlers work unmodified.
  // Mark + unmark fromSupabase tightly around the synchronous dispatch so the
  // flag can never get stuck (previously it was set earlier in the caller and
  // only cleared by the listener — if the pull failed/returned early above,
  // it stayed stuck "on" forever and silently blocked all future real uploads).
  input.dataset.fromSupabase = "1";
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true })); // capture-phase listener consumes the flag synchronously here
  input.dataset.fromSupabase = "";

  // FIX-RACE: don't let the caller move on to the next slot until this
  // slot's async Excel parse has actually finished — see waitForParseSettle
  // above for why this matters.
  if (statusId) await waitForParseSettle(statusId);

  slotMeta[slot] = await fetchSlotMetadata(slot);
  renderSyncInfo(slot);
}

// ── Hide upload controls for viewers ──────────────────────────────────────
// Only the clickable label+input is hidden (class "upload-admin-only") —
// the upload-label heading and the #<slot>Status / sync-info row stay
// visible for everyone, so viewers can still see what's loaded and refresh
// it, they just can't pick a local file that would only display for them
// (pushFileToSupabase never runs for non-admins anyway; hiding the control
// avoids a viewer ever landing in that confusing local-only state).
function applyUploadVisibility() {
  const isAdmin = !!window.isAdmin;
  document.querySelectorAll(".upload-admin-only").forEach(el => {
    el.classList.toggle("viewer-hidden", !isAdmin);
  });
}

// ── Wire up: intercept admin's own file picks to also push to Supabase ──
// NOTE: script.js resets input.value = "" right after reading the file in
// its own (bubble-phase) change listener. We use { capture: true } here so
// OUR listener runs FIRST, before that reset wipes e.target.files.
function attachAdminUploadSync() {
  Object.entries(FILE_SLOTS).forEach(([slot, { inputId }]) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener(
      "change",
      (e) => {
        if (!window.isAdmin) return;            // safety net; UI is already hidden for non-admins
        const file = e.target.files && e.target.files[0];
        if (!file) { console.warn(`[storage-sync] No file found on change for ${slot}`); return; }
        // Don't re-upload the file we just pulled from Supabase ourselves
        if (input.dataset.fromSupabase === "1") { input.dataset.fromSupabase = ""; return; }
        pushFileToSupabase(slot, file);
      },
      { capture: true }
    );
  });
}

// ── Live update banner — shown to viewers (and admins) when someone
//    else uploads new data, via Supabase Realtime on app_files ──
function showNewDataBanner(slot) {
  if (document.getElementById("new-data-banner")) return; // already showing
  const label = slotLabel(slot);
  const el = document.createElement("div");
  el.id = "new-data-banner";
  el.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 10001;
    background: var(--blue, #3a8fd4); color: #fff; text-align: center;
    padding: 10px 14px; font-size: 0.85rem;
    display: flex; align-items: center; justify-content: center; gap: 12px;
  `;
  el.innerHTML = `
    <span>🔔 New ${label} data is available.</span>
    <button id="refresh-data-btn" style="background:#fff;color:var(--blue,#3a8fd4);border:none;border-radius:6px;padding:4px 12px;font-weight:600;cursor:pointer;font-size:0.8rem">Refresh now</button>
    <button id="dismiss-banner-btn" style="background:none;border:1px solid rgba(255,255,255,0.6);color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8rem">Later</button>
  `;
  document.body.prepend(el);
  document.getElementById("refresh-data-btn").addEventListener("click", () => location.reload());
  document.getElementById("dismiss-banner-btn").addEventListener("click", () => el.remove());
}

function attachRealtimeSync() {
  const sc = window.supabaseClient;
  sc.channel("app_files_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "app_files" },
      (payload) => {
        const slot = payload.new && payload.new.slot;
        const uploadedBy = payload.new && payload.new.uploaded_by;
        // Don't show the banner to the admin who just uploaded it themselves
        if (window.APP_USER && uploadedBy === window.APP_USER.id) return;
        showNewDataBanner(slot || "inventory");
      }
    )
    .subscribe();
}

// ── On auth ready: load whatever's already in Supabase for everyone ──
document.addEventListener("epss-auth-ready", async () => {
  applyUploadVisibility();
  attachAdminUploadSync();
  attachRealtimeSync();

  // Pending Dispatch is a fully independent dataset/page — it doesn't feed
  // the material-standardization pipeline that inventory/mapping/amc/incoming
  // share, so it has no ordering dependency on them (that's what the
  // sequential loop below protects against for those four). Kick it off
  // immediately, in parallel with that chain, instead of always loading
  // dead last behind four other awaits — that's why its data used to visibly
  // "appear after" every other page's.
  const INDEPENDENT_SLOTS = ["pendingDispatch"];
  const sequentialSlots = Object.keys(FILE_SLOTS).filter(s => !INDEPENDENT_SLOTS.includes(s));

  const independentLoads = Promise.all(INDEPENDENT_SLOTS.map(slot => pullFileFromSupabase(slot)));

  for (const slot of sequentialSlots) {
    await pullFileFromSupabase(slot);
  }
  await independentLoads; // make sure startup doesn't resolve before this settles too
});
