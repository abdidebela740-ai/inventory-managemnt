// ════════════════════════════════════════════════════════════════
// admin-create-user — Supabase Edge Function
//
// Called from user-management.js via:
//   supabaseClient.functions.invoke("admin-create-user", {
//     body: { email, password, full_name, role, data_scopes, sidebar_permissions }
//   })
//
// This is the ONLY place account creation happens, because it needs the
// service-role key (auth.admin.createUser) — a key that must never reach
// the browser. The caller's own JWT is re-checked here, server-side,
// against the profiles table before anything is created: the UI hides the
// "New User" button from non-Admins, but that's UX only, not security —
// this check is the real boundary.
//
// Deploy with:
//   supabase functions deploy admin-create-user
//
// Required secrets (Project Settings → Edge Functions → these are usually
// already present by default in every Supabase project, but confirm they
// exist under Settings → Edge Functions → Secrets):
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
// ════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const VALID_ROLES = ["admin", "director", "deputy_director", "team_leader", "branch_demand_officer", "user"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("wkmyruayzdiemvupllsu");
  const ANON_KEY = Deno.env.get("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrbXlydWF5emRpZW12dXBsbHN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMDY5NjEsImV4cCI6MjEwMjY4Mjk2MX0.gSGaNqxWda-7AsmtjmaU82CR_XJrB3r1KRq449x_ltM");
  const SERVICE_ROLE_KEY = Deno.env.get("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrbXlydWF5emRpZW12dXBsbHN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzEwNjk2MSwiZXhwIjoyMTAyNjgyOTYxfQ.bD7LFW05V_oWswadm5F8UdXazDFkoIR3ExCeDR77HKE");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY env vars");
    return json({ error: "Server misconfiguration — contact an admin." }, 500);
  }

  // ── 1) Identify the caller from their own JWT (anon client, RLS applies) ──
  const authHeader = req.headers.get("Authorization") || "";
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Not authenticated." }, 401);
  }

  const { data: callerProfile, error: callerProfileErr } = await callerClient
    .from("profiles")
    .select("role,status")
    .eq("id", userData.user.id)
    .single();

  if (callerProfileErr || !callerProfile) {
    return json({ error: "Could not verify caller's profile." }, 403);
  }
  if (callerProfile.status === "inactive") {
    return json({ error: "Your account is inactive." }, 403);
  }
  // Only Admin can create users — matches canManageUsersFully() in permissions.js.
  // Director/Deputy Director can edit roles but never create/delete accounts.
  if (callerProfile.role !== "admin") {
    return json({ error: "Only an Admin can create users." }, 403);
  }

  // ── 2) Validate the request body ──
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const full_name = String(body.full_name || "").trim();
  const role = String(body.role || "user");
  const data_scopes = Array.isArray(body.data_scopes) ? body.data_scopes.map(String) : [];
  const sidebar_permissions =
    body.sidebar_permissions && typeof body.sidebar_permissions === "object" ? body.sidebar_permissions : {};

  if (!email || !password || !full_name) {
    return json({ error: "Full name, email, and password are all required." }, 400);
  }
  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters." }, 400);
  }
  if (!VALID_ROLES.includes(role)) {
    return json({ error: `Invalid role: ${role}` }, 400);
  }
  if (role !== "admin" && data_scopes.length === 0) {
    return json({ error: "Assign at least one data scope for non-Admin users." }, 400);
  }

  // ── 3) Create the auth user (service-role client — bypasses RLS) ──
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // skip email verification; this is an internally-provisioned account
    user_metadata: { full_name },
  });

  if (createErr || !created?.user) {
    const msg = createErr?.message || "Could not create the account.";
    // Supabase surfaces duplicate-email as a 422/"already registered" style message.
    return json({ error: msg }, 400);
  }

  const newUserId = created.user.id;

  // ── 4) Upsert the profiles row for the new user ──
  // Using upsert (not insert) in case a DB trigger on auth.users already
  // created a skeleton profiles row for this id.
  const { error: profileErr } = await adminClient
    .from("profiles")
    .upsert({
      id: newUserId,
      email,
      full_name,
      role,
      status: "active",
      data_scopes,
      sidebar_permissions,
    });

  if (profileErr) {
    // Roll back the auth user so we don't leave an orphaned login with no profile.
    await adminClient.auth.admin.deleteUser(newUserId).catch((e) =>
      console.error("Rollback deleteUser failed after profile insert error:", e)
    );
    console.error("profiles upsert failed:", profileErr);
    return json({ error: "Account was not fully created (profile step failed). Please try again." }, 500);
  }

  return json({ success: true, id: newUserId });
});
