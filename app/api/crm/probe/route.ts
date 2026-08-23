import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import {
  CRM_CONFIGURED, crmKeyFingerprint, crmSearchRaw, crmTry, extractRows,
  pickIds, pickStageLabel, statusFromCrmStage, LOOKUP_CANDIDATES,
} from "@/lib/crm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Reconnaissance against 8X CRM, round two.
 *
 * Round one settled the basics: the documented GET-with-body works, the reply
 * is {message,status,data}, and a phone search returns the lead. It also turned
 * up the two things that change the design:
 *
 *   - The CRM stores `leadgen_id`, `form_id`, `page_id`, `ad_id`, `adgroup_id`.
 *     Meta's own leadgen id is in there, so leads can be joined exactly instead
 *     of by phone — no normalising +20/0020/01, no collisions between two people
 *     sharing a number, no silent mismatch.
 *   - The stage is `status_id`, a number. A name never appears on the record, so
 *     something has to translate 7 into "interested" before any of this means
 *     anything.
 *
 * So this round asks: what are the id values on a real lead, is there an
 * endpoint that names the statuses, does the key reach the richer v4 endpoint
 * the CRM's own screen uses, and does search accept a leadgen id as the needle.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!CRM_CONFIGURED) {
    return NextResponse.json({ ok: false, error: "CRM_API_KEY not set", key: crmKeyFingerprint() }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: sample } = await db
    .from("leads").select("lead_id,phone,status")
    .not("phone", "is", null).order("submitted_at", { ascending: false }).limit(6);
  const leads = (sample ?? []) as { lead_id: string; phone: string; status: string }[];

  const needle = req.nextUrl.searchParams.get("needle") || leads[0]?.phone || "";
  if (!needle) return NextResponse.json({ ok: false, error: "no phone to search with" }, { status: 400 });

  const out: Record<string, unknown> = { ok: true, key: crmKeyFingerprint() };

  // ── 1. The id fields on real leads, and which stage each is in ────────────
  // Several leads, not one: one row cannot show which number means which stage.
  const byLead: unknown[] = [];
  for (const l of leads.slice(0, 5)) {
    try {
      const r = await crmSearchRaw(l.phone, 1, "get-body");
      const row = extractRows(JSON.parse(r.text))[0];
      byLead.push({
        ourStatus: l.status,
        ourLeadId: l.lead_id,
        found: Boolean(row),
        ids: row ? pickIds(row) : null,
        // Does the CRM's leadgen_id equal the id Meta gave us? If yes, that is
        // the join key and the phone never has to be trusted again.
        leadgenMatchesOurs: row ? String(row.leadgen_id ?? "") === l.lead_id : null,
        stageLabel: row ? pickStageLabel(row) : null,
        mapsToStatus: row ? statusFromCrmStage(pickStageLabel(row)) : null,
      });
    } catch (err) {
      byLead.push({ ourLeadId: l.lead_id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  out.leads = byLead;

  // ── 2. Can we search by Meta's leadgen id directly? ───────────────────────
  if (leads[0]) {
    try {
      const r = await crmSearchRaw(leads[0].lead_id, 1, "get-body");
      const rows = extractRows(JSON.parse(r.text));
      out.searchByLeadgenId = { httpStatus: r.status, rowCount: rows.length };
    } catch (err) {
      out.searchByLeadgenId = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── 3. Is there an endpoint that names the statuses? ──────────────────────
  const lookups: unknown[] = [];
  for (const path of LOOKUP_CANDIDATES) {
    for (const method of ["GET", "POST"] as const) {
      try {
        const r = await crmTry(method, path, method === "POST" ? {} : undefined);
        if (r.status === 404 || r.status === 405) continue;
        lookups.push({ path, method, httpStatus: r.status, preview: r.text.slice(0, 220) });
      } catch { /* unreachable path — not worth reporting */ }
    }
  }
  out.lookups = lookups;

  // ── 4. Does the key reach the endpoint the CRM's own workspace uses? ──────
  // That one paginates and filters, which the documented search does not.
  try {
    const r = await crmTry("POST", "/api/v4/leads/leads", { page: 1, per_page: 2 });
    const rows = r.status === 200 ? extractRows(JSON.parse(r.text)) : [];
    out.v4 = {
      httpStatus: r.status,
      rowCount: rows.length,
      rowKeys: rows[0] ? Object.keys(rows[0]).slice(0, 90) : null,
      // If v4 expands the status into a name, nothing else in this file matters.
      stageLabel: rows[0] ? pickStageLabel(rows[0]) : null,
      preview: r.status === 200 ? null : r.text.slice(0, 220),
    };
  } catch (err) {
    out.v4 = { error: err instanceof Error ? err.message : String(err) };
  }

  return NextResponse.json(out);
}
