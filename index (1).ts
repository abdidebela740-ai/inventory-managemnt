// ════════════════════════════════════════════════════════════════
// admin-create-user — Edge Function
//
// Why this has to be an Edge Function and not a Postgres RPC:
// creating an auth.users row with an email+password is a GoTrue
// operation (supabase.auth.admin.createUser), not a SQL statement,
// and it requires the SERVICE ROLE key — which must never reach the
// browser. This function holds that key server-side, checks the
// caller is really an Admin, creates the auth user, then calls the
// admin_create_user() RPC (002_user_management.sql) to write the
// matching profile row.
//
// Deploy: supabase functions deploy admin-create-user
// Client call: supabaseClient.functions.invoke('admin-create-user', { body: {...} })
// ════════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const VALID_ROLES = ["admin", "director", "deputy_director", "team_leader", "branch_demand_officer", "user"];
const VALID_SCOPES = ["Q_ZME", "Q_ZMS", "Q_ZLC", "Q_ZMD", "R_ZME", "R_ZMS", "R_ZLC", "R_ZMD"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // 1) Identify the caller from their JWT, using an anon-key client
  //    scoped to their token — this never touches the service role.
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !caller) return json({ error: "Not authenticated" }, 401);

  const { data: callerProfile } = await callerClient
    .from("profiles").select("role").eq("id", caller.id).single();
  if (!callerProfile || callerProfile.role !== "admin") {
    return json({ error: "Only Admin can create users" }, 403);
  }

  // 2) Validate input
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const { email, password, full_name, role, data_scopes, sidebar_permissions } = body ?? {};

  if (!email || typeof email !== "string") return json({ error: "email is required" }, 400);
  if (!password || typeof password !== "string" || password.length < 8) {
    return json({ error: "password must be at least 8 characters" }, 400);
  }
  if (!full_name || typeof full_name !== "string") return json({ error: "full_name is required" }, 400);
  if (!VALID_ROLES.includes(role)) return json({ error: `role must be one of ${VALID_ROLES.join(", ")}` }, 400);
  const scopes = Array.isArray(data_scopes) ? data_scopes : [];
  if (scopes.some((s: string) => !VALID_SCOPES.includes(s))) {
    return json({ error: `data_scopes must be a subset of ${VALID_SCOPES.join(", ")}` }, 400);
  }
  if (role !== "admin" && scopes.length === 0) {
    return json({ error: "Non-admin users need at least one data scope" }, 400);
  }

  // 3) Create the auth user with the service-role client.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // internal staff tool — skip the confirmation email flow
  });
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? "Failed to create auth user" }, 400);
  }

  // 4) Write the profile row via the RPC (re-checks Admin server-side too).
  const { error: rpcErr } = await adminClient.rpc("admin_create_user", {
    p_id: created.user.id,
    p_email: email,
    p_full_name: full_name,
    p_role: role,
    p_data_scopes: scopes,
    p_sidebar_permissions: sidebar_permissions ?? null,
  });

  if (rpcErr) {
    // Roll back the orphaned auth user so retrying doesn't collide on email.
    await adminClient.auth.admin.deleteUser(created.user.id);
    return json({ error: rpcErr.message }, 400);
  }

  return json({ id: created.user.id, email, full_name, role, data_scopes: scopes });
});
