import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { AGENT_COLUMNS, newToken, normaliseUsername, verifyPassword, type Agent } from "@/lib/agents";

export const dynamic = "force-dynamic";

/** Every refusal costs the same, so a guess learns nothing from the timing. */
const slow = () => new Promise((r) => setTimeout(r, 600));

/**
 * POST { username, password, device? } -> { token, agent }
 *
 * One session per device; signing in again on the same phone simply adds a
 * session, and a password reset in the dashboard ends all of them.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const username = normaliseUsername(body?.username);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password) {
    await slow();
    return NextResponse.json({ ok: false, error: "bad_credentials" }, { status: 401 });
  }

  const db = supabaseAdmin();
  const { data } = await db
    .from("agents")
    .select(`${AGENT_COLUMNS},password_hash`)
    .eq("username", username)
    .maybeSingle();
  const row = data as (Agent & { password_hash: string }) | null;

  if (!row || !(await verifyPassword(password, row.password_hash))) {
    await slow();
    return NextResponse.json({ ok: false, error: "bad_credentials" }, { status: 401 });
  }
  if (!row.active) {
    return NextResponse.json({ ok: false, error: "disabled" }, { status: 403 });
  }

  const { token, hash } = newToken();
  const device = typeof body?.device === "string" ? body.device.slice(0, 120) : null;
  const { error } = await db.from("agent_sessions").insert({ token_hash: hash, agent_id: row.id, device });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const { password_hash: _ignored, ...agent } = row;
  return NextResponse.json({ ok: true, token, agent });
}
