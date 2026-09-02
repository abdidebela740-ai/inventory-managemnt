// ════════════════════════════════════════════════════════════════
// check-email — Supabase Edge Function
//
// Called from auth.js's "Forgot Your Password?" handler via:
//   supabaseClient.functions.invoke("check-email", { body: { email } })
//
// Public / unauthenticated on purpose — this runs on the sign-in screen,
// before anyone is logged in. It only ever returns { registered: true|false },
// never any profile details, and uses the service-role key server-side so
// the lookup works regardless of the profiles table's RLS policies.
//
// Deploy with:
//   supabase functions deploy check-email --no-verify-jwt
//
// Required secrets (Project Settings → Edge Functions):
//   SUPABASE_URL
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
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars");
    return json({ error: "Server misconfiguration — contact an admin." }, 500);
  }

  // ── Validate the request body ──
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!email) return json({ error: "Email is required." }, 400);

  // ── Look the email up with the service-role client (bypasses RLS) ──
  // profiles.email is written lower-cased by create-user, so an exact match
  // is enough and keeps this from being usable as a wildcard search.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data, error } = await adminClient
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("check-email profiles lookup failed:", error);
    return json({ error: "Could not check that email right now." }, 500);
  }

  return json({ registered: !!data });
});
