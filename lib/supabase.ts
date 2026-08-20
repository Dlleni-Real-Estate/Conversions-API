import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only client. Uses the service-role key, which bypasses RLS —
 * never import this from a "use client" component.
 */
let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
