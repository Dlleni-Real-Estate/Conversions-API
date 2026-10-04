import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAdmin, isAuthed } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  AGENT_COLUMNS,
  MIN_PASSWORD,
  cairoMidnight,
  hashPassword,
  isOnline,
  medianOf as median,
  normaliseUsername,
  type Agent,
} from "@/lib/agents";
import { rankOf, type Status } from "@/lib/stages";
import { agentsSchemaReady } from "@/lib/schema";

export const dynamic = "force-dynamic";

/**
 * GET -> every agent, with the numbers a manager looks at first: how many
 * leads they hold, how many are still untouched, and how fast they call.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  // Deployed before migration 0015 ran: say so plainly, not as a SQL error.
  if (!(await agentsSchemaReady(db))) return NextResponse.json({ ok: false, error: "schema_pending", agents: [] });

  const { data: agents, error } = await db.from("agents").select(AGENT_COLUMNS).order("created_at", { ascending: true });
  if (error) return NextResponse.json({ ok: false, error: error.message, agents: [] }, { status: 200 });

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const { data: leads } = await db
    .from("leads")
    .select("agent_id,status,assigned_at,first_call_at")
    .not("agent_id", "is", null)
    .eq("is_test", false)
    .gte("assigned_at", since)
    .limit(10000);

  const today = cairoMidnight();
  type L = { agent_id: string; status: Status; assigned_at: string | null; first_call_at: string | null };
  const by = new Map<string, L[]>();
  for (const l of (leads ?? []) as L[]) by.set(l.agent_id, [...(by.get(l.agent_id) ?? []), l]);

  return NextResponse.json({
    ok: true,
    agents: ((agents ?? []) as Agent[]).map((a) => {
      const mine = by.get(a.id) ?? [];
      const waits = mine
        .filter((l) => l.assigned_at && l.first_call_at)
        .map((l) => Math.max(0, Math.round((Date.parse(l.first_call_at!) - Date.parse(l.assigned_at!)) / 60_000)));
      return {
        ...a,
        online: isOnline(a.last_seen_at),
        stats: {
          leads_30d: mine.length,
          today: mine.filter((l) => l.assigned_at && Date.parse(l.assigned_at) >= today).length,
          untouched: mine.filter((l) => l.status === "new").length,
          called: waits.length,
          median_call_min: median(waits),
          within5_pct: waits.length ? Math.round((100 * waits.filter((w) => w <= 5).length) / waits.length) : null,
          qualified: mine.filter((l) => rankOf(l.status) >= 2).length,
          disqualified: mine.filter((l) => l.status === "disqualified").length,
        },
      };
    }),
  });
}

/**
 * POST, one of:
 *   { action: "create", name, username, password, phone? }
 *   { action: "update", id, name?, phone?, active? }
 *   { action: "password", id, password }    also signs every device out
 *   { action: "signout", id }               signs every device out
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });
  const db = supabaseAdmin();
  const body = await req.json().catch(() => null);
  const action = String(body?.action || "");

  if (action === "create") {
    const name = String(body?.name || "").trim().slice(0, 80);
    const username = normaliseUsername(body?.username);
    const password = String(body?.password || "");
    if (!name) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });
    if (!username) return NextResponse.json({ ok: false, error: "bad_username" }, { status: 400 });
    if (password.length < MIN_PASSWORD) return NextResponse.json({ ok: false, error: "short_password" }, { status: 400 });

    const { data, error } = await db
      .from("agents")
      .insert({
        name,
        username,
        password_hash: await hashPassword(password),
        phone: body?.phone ? String(body.phone).slice(0, 30) : null,
      })
      .select(AGENT_COLUMNS)
      .single();
    if (error) {
      const taken = /duplicate key|unique/i.test(error.message);
      return NextResponse.json({ ok: false, error: taken ? "username_taken" : error.message }, { status: taken ? 409 : 500 });
    }
    await logAudit(req, "agent_create", username, { name });
    return NextResponse.json({ ok: true, agent: data });
  }

  const id = String(body?.id || "");
  if (!id) return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });

  if (action === "update") {
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
    if (typeof body.phone === "string") patch.phone = body.phone.trim().slice(0, 30) || null;
    if (typeof body.active === "boolean") patch.active = body.active;
    if (Object.keys(patch).length === 0) return NextResponse.json({ ok: false, error: "nothing_to_change" }, { status: 400 });
    const { data, error } = await db.from("agents").update(patch).eq("id", id).select(AGENT_COLUMNS).single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    // Switched off: their phone stops on its very next request.
    if (patch.active === false) await db.from("agent_sessions").delete().eq("agent_id", id);
    await logAudit(req, "agent_update", id, patch);
    return NextResponse.json({ ok: true, agent: data });
  }

  if (action === "password") {
    const password = String(body?.password || "");
    if (password.length < MIN_PASSWORD) return NextResponse.json({ ok: false, error: "short_password" }, { status: 400 });
    const { error } = await db.from("agents").update({ password_hash: await hashPassword(password) }).eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    await db.from("agent_sessions").delete().eq("agent_id", id);
    await logAudit(req, "agent_password", id);
    return NextResponse.json({ ok: true });
  }

  if (action === "signout") {
    await db.from("agent_sessions").delete().eq("agent_id", id);
    await logAudit(req, "agent_signout", id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
}
