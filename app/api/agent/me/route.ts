import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { agentFromRequest, touchPresence } from "@/lib/agents";

export const dynamic = "force-dynamic";

/** GET -> the signed-in agent. */
export async function GET(req: NextRequest) {
  const db = supabaseAdmin();
  const agent = await agentFromRequest(req, db);
  if (!agent) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  await touchPresence(db, agent, req.headers.get("x-app-version"));
  return NextResponse.json({ ok: true, agent, server_time: new Date().toISOString() });
}

/**
 * POST { available } - the agent's own on-shift switch.
 *
 * Off: routing passes them over while anyone else on the rule is on shift,
 * and the app stops ringing. On again: rebaselined, so they rejoin at their
 * share rather than being owed every lead that arrived while they were off.
 */
export async function POST(req: NextRequest) {
  const db = supabaseAdmin();
  const agent = await agentFromRequest(req, db);
  if (!agent) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (typeof body?.available !== "boolean") {
    return NextResponse.json({ ok: false, error: "available must be true or false" }, { status: 400 });
  }
  if (body.available && !agent.available) await db.rpc("rebaseline_agent", { p_agent_id: agent.id });
  const { data, error } = await db
    .from("agents")
    .update({ available: body.available, last_seen_at: new Date().toISOString() })
    .eq("id", agent.id)
    .select("id,name,username,phone,active,available,last_seen_at,app_version")
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, agent: data });
}
