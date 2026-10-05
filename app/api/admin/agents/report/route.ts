import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { agentsSchemaReady } from "@/lib/schema";
import { agentReports } from "@/lib/agentReport";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET ?days=30 | ?from=YYYY-MM-DD&to=YYYY-MM-DD, &agent_id=, &leads=1
 *   -> { agents: AgentReport[] }   (see lib/agentReport.ts)
 *
 * Every agent side by side; with agent_id and leads=1, one agent with every
 * lead behind the numbers.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  if (!(await agentsSchemaReady(db))) return NextResponse.json({ ok: false, error: "schema_pending", agents: [] });

  const p = req.nextUrl.searchParams;
  const days = Math.max(1, Math.min(365, Number(p.get("days")) || 30));
  const from = p.get("from");
  const to = p.get("to");
  const since = from && Number.isFinite(Date.parse(from)) ? new Date(from).toISOString() : new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const until = to && Number.isFinite(Date.parse(to)) ? new Date(Date.parse(to) + 24 * 3600_000 - 1).toISOString() : new Date().toISOString();

  const agents = await agentReports(db, {
    since,
    until,
    agentId: p.get("agent_id") || undefined,
    withLeads: p.get("leads") === "1",
  });
  return NextResponse.json({ ok: true, since, until, agents });
}
