import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/notes?lead_id=… — the full timeline for one lead. */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const leadId = req.nextUrl.searchParams.get("lead_id");
  if (!leadId) return NextResponse.json({ error: "lead_id is required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("lead_notes")
    .select("id, kind, body, from_status, to_status, author, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, notes: data ?? [] });
}

/** POST { lead_id, body, author? } — add a note to the timeline. */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json().catch(() => null);
  const leadId = payload?.lead_id;
  const text = typeof payload?.body === "string" ? payload.body.trim() : "";

  if (!leadId || !text) {
    return NextResponse.json({ error: "lead_id and a non-empty body are required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("lead_notes")
    .insert({ lead_id: leadId, kind: "note", body: text, author: payload.author ?? null })
    .select("id, kind, body, from_status, to_status, author, created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mirror the latest note onto the lead so the list can show it without a
  // second query per row.
  await db.from("leads").update({ notes: text }).eq("lead_id", leadId);

  return NextResponse.json({ ok: true, note: data });
}
