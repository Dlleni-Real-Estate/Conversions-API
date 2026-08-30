import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { rankOf, type Status } from "@/lib/stages";
import { buildDictionary } from "@/lib/labels";
import type { FormSchema } from "@/lib/meta";

export const dynamic = "force-dynamic";

const LEAD_COLUMNS =
  "lead_id,full_name,phone,email,status,status_at,notes,owner,deal_value,submitted_at," +
  "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,form_name,platform,raw_fields,quality_score";

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

  const account = (p.get("account") || "").replace(/^act_/, "");
  if (account && account !== "all") q = q.eq("ad_account_id", account);

  const status = p.get("status");
  if (status && status !== "all") {
    q = status === "open" ? q.in("status", OPEN_STATUSES) : q.eq("status", status);
  }

  const campaign = p.get("campaign");
  if (campaign && campaign !== "all") q = q.eq("campaign_id", campaign);

  // Ad set, by id rather than name. Names get edited in Ads Manager and two
  // ad sets in different campaigns can share one; the id is what Meta means.
  const adset = p.get("adset");
  if (adset && adset !== "all") q = q.eq("adset_id", adset);

  const ad = p.get("ad");
  if (ad && ad !== "all") q = q.eq("ad_id", ad);

  // Search matches how people actually type. Phones are STORED normalised to
  // "20xxxxxxxxxx" (lib/meta.ts normalizeEgyptPhone) but nobody types them
  // that way — they type 010… or paste +20 10…. So the digits are stripped and
  // searched in every variant that could be the stored form. Commas and parens
  // are removed first because PostgREST's or() syntax treats them as its own
  // grammar, and a search string containing one would otherwise 400.
  const search = (p.get("q") || "").trim().replace(/[,()]/g, " ").slice(0, 60);
  if (search) {
    const ors = [
      `full_name.ilike.%${search}%`,
      `email.ilike.%${search}%`,
      `owner.ilike.%${search}%`,
      `ad_name.ilike.%${search}%`,
    ];
    const digits = search.replace(/\D/g, "");
    if (digits.length >= 3) {
      const variants = new Set([digits, digits.replace(/^0/, "20"), digits.replace(/^20/, "")]);
      for (const v of variants) if (v.length >= 3) ors.push(`phone.ilike.%${v}%`);
    }
    q = q.or(ors.join(","));
  }

  const { data, error, count } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const leads = (data ?? []) as unknown as { lead_id: string; status: Status }[];

  // The notes themselves, not just how many. The list used to read
  // leads.notes, which only this app's own note box ever writes - 3 leads out
  // of 235 - while the 134 leads carrying what the sales team actually said in
  // 8X showed a dash, because that text lives in lead_notes and was only ever
  // opened one lead at a time. Newest per lead wins; one query for the page.
  let noteCounts: Record<string, number> = {};
  let lastNotes: Record<string, { body: string; author: string | null; at: string | null }> = {};
  if (leads.length > 0) {
    const { data: notes } = await db
      .from("lead_notes")
      .select("lead_id,body,author,created_at")
      .eq("kind", "note")
      .in(
        "lead_id",
        leads.map((l) => l.lead_id)
      )
      .order("created_at", { ascending: false });

    for (const n of (notes ?? []) as { lead_id: string; body: string | null; author: string | null; created_at: string | null }[]) {
      noteCounts[n.lead_id] = (noteCounts[n.lead_id] ?? 0) + 1;
      if (!lastNotes[n.lead_id] && n.body?.trim()) {
        lastNotes[n.lead_id] = { body: n.body.trim(), author: n.author, at: n.created_at };
      }
    }
  }

  // The wording of the forms, so the client can show the question and answer
  // exactly as the customer read them instead of Meta's machine keys.
  const { data: forms } = await db.from("lead_forms").select("form_id, name, locale, questions");

  return NextResponse.json({
    ok: true,
    count,
    dictionary: buildDictionary((forms ?? []) as unknown as FormSchema[]),
    leads: leads.map((l) => ({
      ...l,
      note_count: noteCounts[l.lead_id] ?? 0,
      last_note: lastNotes[l.lead_id] ?? null,
      rank: rankOf(l.status),
    })),
  });
}
