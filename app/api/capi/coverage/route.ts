import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { chainFor, type Status } from "@/lib/stages";
import { capiEventId } from "@/lib/capi";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Did Meta actually get told the truth about every lead?
 *
 * Two different failures hide behind a healthy-looking "events sent" count,
 * and neither shows up anywhere else:
 *
 *   MISSING     — a stage the lead reached that Meta was never told about.
 *                 Meta credits a lead with a stage only when that stage's own
 *                 event arrives, so a gap here silently shortens the funnel.
 *
 *   UNEXPECTED  — an event Meta was told that the lead's stage does not imply.
 *                 This is the dangerous one. It sends cleanly, Meta accepts it,
 *                 the dashboard stays green, and the optimiser learns something
 *                 false. It is exactly how the catch-up sweep came to report
 *                 every qualified lead as NoAnswer and Disqualified as well.
 *
 * Counting sent events can never surface either: both leave the total looking
 * plausible. Only comparing what was sent against what the stage implies does.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const campaign = req.nextUrl.searchParams.get("campaign");
  const scoped = campaign && campaign !== "all" ? campaign : null;

  let q = db.from("leads").select("lead_id,status,campaign_name,submitted_at").limit(2000);
  if (scoped) q = q.eq("campaign_id", scoped);
  const { data: leadRows, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const leads = (leadRows ?? []) as { lead_id: string; status: Status; campaign_name: string | null; submitted_at: string }[];
  if (leads.length === 0) return NextResponse.json({ ok: true, leads: 0 });

  // Only 'sent' counts. Pending or failed rows are not knowledge Meta has.
  const sentIds = new Set<string>();
  for (let i = 0; i < leads.length; i += 200) {
    const slice = leads.slice(i, i + 200).map((l) => l.lead_id);
    const { data } = await db
      .from("capi_events").select("event_id").eq("status", "sent").in("lead_id", slice);
    for (const r of data ?? []) sentIds.add(r.event_id as string);
  }

  const missingByEvent = new Map<string, number>();
  const unexpectedByEvent = new Map<string, number>();
  const gaps: { lead_id: string; status: Status; missing: string[]; unexpected: string[] }[] = [];
  let expectedTotal = 0;
  let presentTotal = 0;

  for (const lead of leads) {
    const expected = chainFor(lead.status).map((s) => s.event as string);
    const expectedSet = new Set(expected);
    expectedTotal += expected.length;

    const missing = expected.filter((e) => !sentIds.has(capiEventId(lead.lead_id, e)));
    presentTotal += expected.length - missing.length;

    // Anything sent for this lead whose name the stage does not imply.
    const prefix = `${lead.lead_id}:`;
    const unexpected: string[] = [];
    for (const id of sentIds) {
      if (!id.startsWith(prefix)) continue;
      const name = id.slice(prefix.length).split(":")[0];
      if (!expectedSet.has(name)) unexpected.push(name);
    }

    for (const e of missing) missingByEvent.set(e, (missingByEvent.get(e) ?? 0) + 1);
    for (const e of unexpected) unexpectedByEvent.set(e, (unexpectedByEvent.get(e) ?? 0) + 1);
    if (missing.length || unexpected.length) {
      gaps.push({ lead_id: lead.lead_id, status: lead.status, missing, unexpected });
    }
  }

  const tally = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([event, leads]) => ({ event, leads }));

  return NextResponse.json({
    ok: true,
    campaign: scoped ?? "all",
    leads: leads.length,
    expectedEvents: expectedTotal,
    presentInMeta: presentTotal,
    completeness: expectedTotal ? Math.round((1000 * presentTotal) / expectedTotal) / 10 + "%" : null,
    missingByEvent: tally(missingByEvent),
    unexpectedByEvent: tally(unexpectedByEvent),
    leadsWithGaps: gaps.length,
    gaps: gaps.slice(0, 40),
  });
}
