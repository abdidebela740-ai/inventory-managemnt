// ════════════════════════════════════════════════════════════════
// user-management.js — the Advanced User Management page
//
// Depends on (in load order): auth.js → filters.js → permissions.js → this.
// Talks to Supabase through the RPCs defined in
// supabase/migrations/002_user_management.sql, and to the
// admin-create-user Edge Function for actual account creation
// (that step needs the service-role key, which never reaches the browser).
//
// Every mutation re-checks the caller's role server-side inside the
// RPC/Edge Function — the UI gating below is for a good experience,
// not the security boundary.
// ════════════════════════════════════════════════════════════════

const ALL_ROLES = ["admin", "director", "deputy_director", "team_leader", "branch_demand_officer", "user"];
const ALL_SCOPES = ["Q_ZME", "Q_ZMS", "Q_ZLC", "Q_ZMD", "R_ZME", "R_ZMS", "R_ZLC", "R_ZMD"];
const SCOPE_LABELS = {
  Q_ZME: "Health Program · Medicine", Q_ZMS: "Health Program · Medical Supply",
  Q_ZLC: "Health Program · Laboratory", Q_ZMD: "Health Program · Medical Device",
  R_ZME: "RDF · Medicine", R_ZMS: "RDF · Medical Supply",
  R_ZLC: "RDF · Laboratory", R_ZMD: "RDF · Medical Device",
};

let allUsers = [];
let modalMode = null;       // "create" | "edit"
let editingUser = null;     // profile row being edited, when mode === "edit"

// ── Bootstrap once auth.js has resolved the signed-in user ──────
document.addEventListener("epss-auth-ready", async () => {
  if (!window.APP_USER) return; // auth.js will show the login overlay itself
  if (!canManageRoles()) {
    document.getElementById("um-denied").style.display = "";
    return;
  }
  document.getElementById("um-main").style.display = "";
  document.getElementById("um-subtitle").textContent =
    canManageUsersFully()
      ? "Create, edit, and manage every account."
      : "You can view users and change their role. Other fields are managed by an Admin.";

  if (!canManageUsersFully()) {
    const note = document.getElementById("um-role-note");
    note.textContent = "🔒 Director access — role changes only";
    note.style.display = "";
  }

  const createBtn = document.getElementById("um-create-btn");
  if (canManageUsersFully()) {
    createBtn.style.display = "";
    createBtn.addEventListener("click", () => openModal("create"));
  }

  wireToolbar();
  wireModalChrome();
  await loadUsers();
});

// ── Data loading ──────────────────────────────────────────────
async function loadUsers() {
  try {
    const { data, error } = await window.supabaseClient.rpc("admin_list_users");
    if (error) {
      console.error("[user-management] admin_list_users RPC failed:", error);
      showAlert("error", "Could not load users: " + error.message + " (open the console for full details)");
      return;
    }
    allUsers = data || [];
    console.log("[user-management] loaded", allUsers.length, "users");
    renderTable();
  } catch (err) {
    // Catches network failures / thrown exceptions that the {data, error}
    // pattern above wouldn't catch (e.g. CORS, RPC name typo throwing before
    // Supabase can build a normal error response).
    console.error("[user-management] loadUsers() threw:", err);
    showAlert("error", "Could not load users — unexpected error, check the console.");
  }
}

// ── Toolbar (search / filter) ────────────────────────────────
function wireToolbar() {
  document.getElementById("um-search-input").addEventListener("input", renderTable);
  document.getElementById("um-role-filter").addEventListener("change", renderTable);
  document.getElementById("um-status-filter").addEventListener("change", renderTable);
}

function filteredUsers() {
  const q = document.getElementById("um-search-input").value.trim().toLowerCase();
  const roleFilter = document.getElementById("um-role-filter").value;
  const statusFilter = document.getElementById("um-status-filter").value;
  return allUsers.filter(u => {
    if (roleFilter && u.role !== roleFilter) return false;
    if (statusFilter && u.status !== statusFilter) return false;
    if (q && !(`${u.full_name} ${u.email}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

// ── Table rendering ───────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById("um-table-body");
  const empty = document.getElementById("um-empty");
  const rows = filteredUsers();

  if (rows.length === 0) {
    tbody.innerHTML = "";
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  tbody.innerHTML = rows.map(rowHtml).join("");

  tbody.querySelectorAll("[data-edit]").forEach(btn =>
    btn.addEventListener("click", () => openModal("edit", rows.find(u => u.id === btn.dataset.edit))));
  tbody.querySelectorAll("[data-toggle-status]").forEach(btn =>
    btn.addEventListener("click", () => toggleStatus(rows.find(u => u.id === btn.dataset.toggleStatus))));
}

function rowHtml(u) {
  const isSelf = window.APP_USER && u.id === window.APP_USER.id;
  const roleLabel = window.ROLE_LABELS[u.role] || u.role;
  const scopesHtml = u.role === "admin"
    ? '<span class="scope-chip" style="background:transparent;color:var(--purple);border:1px solid var(--purple);">Full Access</span>'
    : scopeChips(u.data_scopes || []);

  const canEdit = canManageUsersFully() || (isDirectorLike() && u.role !== "admin");
  const canToggle = canManageUsersFully() && !isSelf;

  return `
    <tr>
      <td>
        <div class="um-name">${escapeHtml(u.full_name || "(no name)")}</div>
        <div class="um-email">${escapeHtml(u.email)}${isSelf ? " · you" : ""}</div>
      </td>
      <td><span class="role-pill role-${u.role}">${escapeHtml(roleLabel)}</span></td>
      <td>${scopesHtml}</td>
      <td>
        <span class="status-${u.status}"><span class="status-dot"></span>${u.status === "active" ? "Active" : "Inactive"}</span>
      </td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-edit="${u.id}" ${canEdit ? "" : "disabled"}>Edit</button>
          <button class="btn btn-sm btn-danger" data-toggle-status="${u.id}" ${canToggle ? "" : "disabled"}
            title="${isSelf ? 'You cannot deactivate your own account' : ''}">
            ${u.status === "active" ? "Deactivate" : "Activate"}
          </button>
        </div>
      </td>
    </tr>`;
}

function scopeChips(scopes) {
  if (!scopes.length) return '<span style="color:var(--dim); font-size:0.78rem;">No scopes</span>';
  if (scopes.length <= 3) return scopes.map(s => `<span class="scope-chip">${s}</span>`).join("");
  return `<span class="scope-chip">${scopes[0]}</span><span class="scope-chip">${scopes[1]}</span>
    <span class="scope-more" title="${scopes.join(", ")}">+${scopes.length - 2} more</span>`;
}

// ── Activate / Deactivate ────────────────────────────────────
async function toggleStatus(u) {
  if (!u) return;
  const next = u.status === "active" ? "inactive" : "active";
  if (next === "inactive" && !confirm(`Deactivate ${u.full_name || u.email}? They will be signed out and unable to log in.`)) return;

  const { error } = await window.supabaseClient.rpc("admin_set_user_status", { p_user_id: u.id, p_status: next });
  if (error) { showAlert("error", error.message); return; }
  showAlert("success", `${u.full_name || u.email} is now ${next}.`);
  await loadUsers();
}

// ── Modal: create / edit ─────────────────────────────────────
function wireModalChrome() {
  document.getElementById("um-modal-close").addEventListener("click", closeModal);
  document.getElementById("um-modal-cancel").addEventListener("click", closeModal);
  document.getElementById("um-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "um-modal-backdrop") closeModal();
  });
  document.getElementById("um-modal-save").addEventListener("click", saveModal);
}

function openModal(mode, user) {
  modalMode = mode;
  editingUser = user || null;
  document.getElementById("um-modal-title").textContent = mode === "create" ? "New User" : `Edit ${user.full_name || user.email}`;
  document.getElementById("um-modal-body").innerHTML = modalBodyHtml(mode, user);
  document.getElementById("um-modal-backdrop").classList.add("open");

  // Full editing (Admin) vs role-only editing (Director/Deputy)
  const fullEdit = canManageUsersFully();
  if (mode === "edit" && !fullEdit) {
    document.getElementById("um-modal-body").querySelectorAll("input, select").forEach(el => {
      if (el.dataset.roleField !== "true") el.disabled = true;
    });
  }
}

function closeModal() {
  document.getElementById("um-modal-backdrop").classList.remove("open");
  modalMode = null;
  editingUser = null;
}

function modalBodyHtml(mode, user) {
  const role = user ? user.role : "user";
  const scopes = user ? (user.data_scopes || []) : [];
  const perms = user ? (user.sidebar_permissions || {}) : {};
  const fullEdit = canManageUsersFully();

  const roleOptions = ALL_ROLES.map(r =>
    `<option value="${r}" ${r === role ? "selected" : ""}>${window.ROLE_LABELS[r]}</option>`).join("");

  const scopeGrid = ALL_SCOPES.map(s => `
    <label class="scope-check">
      <input type="checkbox" name="scope" value="${s}" ${scopes.includes(s) ? "checked" : ""} />
      <span><strong>${s}</strong><br/><span style="color:var(--muted); font-size:0.72rem;">${SCOPE_LABELS[s]}</span></span>
    </label>`).join("");

  // Sidebar/module permission keys mirror app_modules — kept inline here so
  // the page works even before app_modules is queried; a live deployment
  // can swap this static list for a `SELECT key,label FROM app_modules`.
  const MODULE_GROUPS = {
    "Dashboard": ["dashboard:Dashboard"],
    "Inventory Ops": ["pending-dispatch:Open Outbound", "transit:Stock in Transit", "branch:Branch Comparison"],
    "Quality & Risk": ["expiry:Expiry Watchlist", "qc:Quality Inspection", "expiry-risk:Overstock & Expiry Risk", "stockout-risk:Stockout Risk"],
    "Analytics": ["natl-table:National Stock & MOS", "concentration:Stock Concentration"],
    "Self-Service": ["request-analysis:Request Analysis", "allocation-tool:Allocation Tool", "branch-demand:Branch Demand"],
  };
  const permGrid = Object.entries(MODULE_GROUPS).map(([group, items]) => `
    <div class="perm-group-label">${group}</div>
    ${items.map(item => {
      const [key, label] = item.split(":");
      return `<label class="perm-check">
        <input type="checkbox" name="perm" value="${key}" ${perms[key] ? "checked" : ""} />
        <span>${label}</span>
      </label>`;
    }).join("")}
  `).join("");

  return `
    ${mode === "create" ? `
      <div class="field">
        <label for="um-f-fullname">Full Name</label>
        <input type="text" id="um-f-fullname" placeholder="e.g. Selamawit Tesfaye" />
      </div>
      <div class="field">
        <label for="um-f-email">Email</label>
        <input type="email" id="um-f-email" placeholder="name@epss.gov.et" />
      </div>
      <div class="field">
        <label for="um-f-password">Temporary Password</label>
        <input type="password" id="um-f-password" placeholder="At least 8 characters" />
        <div class="field-hint">Share this with the user directly; they can change it after logging in.</div>
      </div>
    ` : `
      <div class="field">
        <div style="font-weight:700;">${escapeHtml(user.full_name || "(no name)")}</div>
        <div class="um-email">${escapeHtml(user.email)}</div>
      </div>
    `}

    <div class="field">
      <label for="um-f-role">Access Level</label>
      <select id="um-f-role" data-role-field="true">${roleOptions}</select>
      ${!fullEdit ? '<div class="field-hint">As Director/Deputy Director you can only change the role.</div>' : ""}
    </div>

    <div class="field ${!fullEdit ? "field-locked" : ""}">
      <label>Data Scopes</label>
      <div class="scope-grid">${scopeGrid}</div>
      <div class="field-hint">Admin does not need scopes — it always has full access.</div>
    </div>

    <div class="field ${!fullEdit ? "field-locked" : ""}">
      <label>Sidebar / Module Access</label>
      <div class="perm-grid">${permGrid}</div>
      <div class="field-hint">Admin always sees every module. Data Upload is Admin-only and isn't listed here.</div>
    </div>
  `;
}

async function saveModal() {
  const saveBtn = document.getElementById("um-modal-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  try {
    if (modalMode === "create") {
      await createUser();
    } else {
      await updateUser();
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
}

function collectScopes() {
  return Array.from(document.querySelectorAll('input[name="scope"]:checked')).map(el => el.value);
}
function collectPerms() {
  const perms = {};
  document.querySelectorAll('input[name="perm"]').forEach(el => { perms[el.value] = el.checked; });
  return perms;
}

async function createUser() {
  const full_name = document.getElementById("um-f-fullname").value.trim();
  const email = document.getElementById("um-f-email").value.trim();
  const password = document.getElementById("um-f-password").value;
  const role = document.getElementById("um-f-role").value;
  const data_scopes = collectScopes();
  const sidebar_permissions = collectPerms();

  if (!full_name || !email || !password) {
    showAlert("error", "Full name, email, and password are all required.");
    return;
  }
  if (role !== "admin" && data_scopes.length === 0) {
    showAlert("error", "Assign at least one data scope for non-Admin users.");
    return;
  }

  const { data, error } = await window.supabaseClient.functions.invoke("create-user", {
    body: { email, password, full_name, role, data_scopes, sidebar_permissions },
  });

  if (error || (data && data.error)) {
    showAlert("error", "Could not create user: " + (data?.error || error.message));
    return;
  }

  showAlert("success", `${full_name} was created.`);
  closeModal();
  await loadUsers();
}

async function updateUser() {
  const user = editingUser;
  const role = document.getElementById("um-f-role").value;

  // Role change — everyone with canManageRoles() may do this.
  if (role !== user.role) {
    const { error } = await window.supabaseClient.rpc("admin_update_user_role", { p_user_id: user.id, p_role: role });
    if (error) { showAlert("error", error.message); return; }
  }

  // Scopes / sidebar permissions — Admin only.
  if (canManageUsersFully()) {
    const data_scopes = collectScopes();
    const sidebar_permissions = collectPerms();

    if (role !== "admin" && data_scopes.length === 0) {
      showAlert("error", "Assign at least one data scope for non-Admin users.");
      return;
    }

    const [{ error: scopeErr }, { error: permErr }] = await Promise.all([
      window.supabaseClient.rpc("admin_set_data_scopes", { p_user_id: user.id, p_scopes: data_scopes }),
      window.supabaseClient.rpc("admin_set_sidebar_permissions", { p_user_id: user.id, p_perms: sidebar_permissions }),
    ]);
    if (scopeErr) { showAlert("error", scopeErr.message); return; }
    if (permErr) { showAlert("error", permErr.message); return; }
  }

  showAlert("success", `${user.full_name || user.email} was updated.`);
  closeModal();
  await loadUsers();
}

// ── Alerts ────────────────────────────────────────────────────
function showAlert(kind, message) {
  const slot = document.getElementById("um-alert-slot");
  const el = document.createElement("div");
  el.className = `um-alert um-alert-${kind}`;
  el.textContent = message;
  slot.innerHTML = "";
  slot.appendChild(el);
  if (kind === "success") setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
