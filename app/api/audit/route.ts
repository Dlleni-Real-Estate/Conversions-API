import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAdmin, isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The audit trail, admin-eyes only. A viewer password opens the dashboards,
 * not the record of who changed what - that stays with the owner.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 100), 300);
  const { data, error } = await supabaseAdmin()
    .from("audit_log")
    .select("id, at, actor, action, subject, detail, ip")
    .order("at", { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, entries: data ?? [] });
}
