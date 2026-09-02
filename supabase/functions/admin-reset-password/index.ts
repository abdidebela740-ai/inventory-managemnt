// ════════════════════════════════════════════════════════════════
// admin-reset-password — Supabase Edge Function
//
// Called from user-management.js (Edit User modal, Admin only) via:
//   supabaseClient.functions.invoke("admin-reset-password", {
//     body: { user_id, new_password }
//   })
//
// This is the ONLY place a user's password can be set by someone else,
// because it needs the service-role key (auth.admin.updateUserById) — a
// key that must never reach the browser. The caller's own JWT is
// re-checked here, server-side, against the profiles table before
// anything is changed: the UI hides this control from non-Admins, but
// that's UX only, not security — this check is the real boundary.
//
// Deploy with:
//   supabase functions deploy admin-reset-password
//
// Required secrets (Project Settings → Edge Functions — usually already
// present by default in every Supabase project):
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
  // Only Admin can reset another user's password — matches
  // canManageUsersFully() in permissions.js / the same rule create-user uses.
  if (callerProfile.role !== "admin") {
    return json({ error: "Only an Admin can reset another user's password." }, 403);
  }

  // ── 2) Validate the request body ──
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const target_user_id = String(body.user_id || "").trim();
  const new_password = String(body.new_password || "");

  if (!target_user_id) return json({ error: "user_id is required." }, 400);
  if (new_password.length < 8) {
    return json({ error: "Password must be at least 8 characters." }, 400);
  }

  // ── 3) Update the auth user's password (service-role client — bypasses RLS) ──
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { error: updateErr } = await adminClient.auth.admin.updateUserById(target_user_id, {
    password: new_password,
  });

  if (updateErr) {
    const msg = updateErr.message || "Could not update the password.";
    return json({ error: msg }, 400);
  }

  return json({ success: true });
});
