import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { agentFromRequest } from "@/lib/agents";
import { createTestLead, TEST_LEADS_PER_HOUR } from "@/lib/testLeads";

export const dynamic = "force-dynamic";

/**
 * POST -> a test lead handed to the signed-in agent. Their phone rings on
 * its next check-in. Never reaches Meta, 8X or any report (lib/testLeads.ts).
 */
export async function POST(req: NextRequest) {
  const db = supabaseAdmin();
  const agent = await agentFromRequest(req, db);
  if (!agent) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { count } = await db
    .from("leads")
    .select("lead_id", { count: "exact", head: true })
    .eq("is_test", true)
    .eq("agent_id", agent.id)
    .gte("submitted_at", new Date(Date.now() - 3600_000).toISOString());
  if ((count ?? 0) >= TEST_LEADS_PER_HOUR) {
    return NextResponse.json({ ok: false, error: "too_many_tests" }, { status: 429 });
  }

  try {
    const lead = await createTestLead(db, agent, { by: "agent" });
    return NextResponse.json({ ok: true, ...lead });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
