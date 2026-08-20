import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Lead list for the dashboard, with filters. */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const db = supabaseAdmin();

  let q = db
    .from("leads")
    .select(
      "lead_id,full_name,phone,email,status,notes,owner,deal_value,submitted_at,campaign_name,adset_name,ad_name,form_name,platform,raw_fields",
      { count: "exact" }
    )
    .order("submitted_at", { ascending: false })
    .limit(Number(p.get("limit") || 200));

  const status = p.get("status");
  if (status && status !== "all") q = q.eq("status", status);

  const campaign = p.get("campaign");
  if (campaign && campaign !== "all") q = q.eq("campaign_name", campaign);

  const search = p.get("q");
  if (search) q = q.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`);

  const { data, error, count } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: quality } = await db.from("lead_quality_by_ad").select("*").limit(50);

  return NextResponse.json({ leads: data, count, quality });
}
