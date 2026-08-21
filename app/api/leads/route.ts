import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { rankOf, type Status } from "@/lib/stages";

export const dynamic = "force-dynamic";

const LEAD_COLUMNS =
  "lead_id,full_name,phone,email,status,status_at,notes,owner,deal_value,submitted_at," +
  "campaign_id,campaign_name,adset_name,ad_id,ad_name,form_name,platform,raw_fields";

/** Still worth a phone call — the default working view. */
const OPEN_STATUSES = [
  "new",
  "contacted",
  "no_answer",
  "qualified",
  "meeting_booked",
  "meeting_done",
  "site_visit_booked",
];

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const db = supabaseAdmin();

  let q = db
    .from("leads")
    .select(LEAD_COLUMNS, { count: "exact" })
    .order("submitted_at", { ascending: false })
    .limit(Number(p.get("limit") || 500));

  const status = p.get("status");
  if (status && status !== "all") {
    q = status === "open" ? q.in("status", OPEN_STATUSES) : q.eq("status", status);
  }

  const campaign = p.get("campaign");
  if (campaign && campaign !== "all") q = q.eq("campaign_id", campaign);

  const ad = p.get("ad");
  if (ad && ad !== "all") q = q.eq("ad_id", ad);

  const search = p.get("q");
  if (search) q = q.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`);

  const { data, error, count } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const leads = (data ?? []) as unknown as { lead_id: string; status: Status }[];

  // How many notes each lead carries, so a row can show it without the client
  // making one request per lead.
  let noteCounts: Record<string, number> = {};
  if (leads.length > 0) {
    const { data: notes } = await db
      .from("lead_notes")
      .select("lead_id")
      .eq("kind", "note")
      .in(
        "lead_id",
        leads.map((l) => l.lead_id)
      );
    noteCounts = (notes ?? []).reduce<Record<string, number>>((acc, n: { lead_id: string }) => {
      acc[n.lead_id] = (acc[n.lead_id] ?? 0) + 1;
      return acc;
    }, {});
  }

  return NextResponse.json({
    ok: true,
    count,
    leads: leads.map((l) => ({ ...l, note_count: noteCounts[l.lead_id] ?? 0, rank: rankOf(l.status) })),
  });
}
