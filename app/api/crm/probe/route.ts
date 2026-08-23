import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import {
  CRM_CONFIGURED, crmKeyFingerprint, crmSearchRaw, extractRows,
  pickStageLabel, pickPhone, statusFromCrmStage, type CallShape,
} from "@/lib/crm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-shot reconnaissance against 8X CRM's search endpoint.
 *
 * 8X documents the request and not the reply, so before any sync is written
 * against a guessed shape this asks the real API three questions:
 *
 *   1. Which calling convention does it accept?  The docs say GET-with-body,
 *      which `fetch` cannot even express; get-query and post-body are the
 *      fallbacks worth knowing about before we depend on one.
 *   2. What does a lead record actually look like — specifically, under which
 *      key does the stage live, and is the Meta lead id carried at all?
 *   3. Does the stage string it returns match the Stage Mappings screen, so
 *      CRM_STAGE_TO_STATUS lines up?
 *
 * Deliberately read-only, and it never returns the API key — only a length and
 * last-four fingerprint, which is enough to tell "unset" from "wrong" without
 * putting a live credential in a log or a screenshot.
 *
 *   GET /api/crm/probe                  → uses a real phone from our own leads
 *   GET /api/crm/probe?needle=010…      → uses the one you name
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!CRM_CONFIGURED) {
    return NextResponse.json(
      { ok: false, error: "CRM_API_KEY is not set on this deployment", key: crmKeyFingerprint() },
      { status: 400 }
    );
  }

  // A needle we know exists, so an empty result means "shape wrong", not "no such lead".
  let needle = req.nextUrl.searchParams.get("needle") || "";
  let needleSource = "query";
  if (!needle) {
    const { data } = await supabaseAdmin()
      .from("leads").select("phone").not("phone", "is", null)
      .order("submitted_at", { ascending: false }).limit(1);
    needle = (data?.[0]?.phone as string) || "";
    needleSource = "newest lead in our db";
  }
  if (!needle) {
    return NextResponse.json({ ok: false, error: "no phone to search with — pass ?needle=" }, { status: 400 });
  }

  const shapes: CallShape[] = ["get-body", "get-query", "post-body"];
  const attempts: unknown[] = [];

  for (const shape of shapes) {
    try {
      const r = await crmSearchRaw(needle, 3, shape);

      let parsed: unknown = null;
      let parseError: string | null = null;
      try { parsed = JSON.parse(r.text); }
      catch { parseError = "response was not JSON"; }

      const rows = parsed ? extractRows(parsed) : [];
      const first = rows[0];

      attempts.push({
        shape,
        httpStatus: r.status,
        parseError,
        // The envelope's own keys tell us whether it paginates, and how.
        envelopeKeys: parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? Object.keys(parsed as object).slice(0, 25) : Array.isArray(parsed) ? ["(bare array)"] : null,
        rowCount: rows.length,
        // Every field name on one record. This is the whole point of the probe.
        rowKeys: first ? Object.keys(first).slice(0, 80) : null,
        stageLabel: first ? pickStageLabel(first) : null,
        mapsToStatus: first ? statusFromCrmStage(pickStageLabel(first)) : null,
        phoneEcho: first ? maskPhone(pickPhone(first)) : null,
        // Does the CRM carry Meta's leadgen id? If it does, we can join on it
        // exactly instead of on a phone number, which is far stronger.
        metaIdCandidates: first ? Object.keys(first).filter((k) => /lead_?id|meta|facebook|fb_|source_id|external/i.test(k)) : null,
        bodyPreview: parseError ? r.text.slice(0, 300) : null,
      });

      // First shape that returns rows wins; no need to hammer the others.
      if (rows.length > 0) break;
    } catch (err) {
      attempts.push({ shape, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    key: crmKeyFingerprint(),
    needle: maskPhone(needle),
    needleSource,
    attempts,
  });
}

/** Enough digits to recognise the lead, not enough to be a contact list. */
function maskPhone(p: string | null): string | null {
  if (!p) return null;
  return p.length <= 5 ? p : `${p.slice(0, 4)}…${p.slice(-3)}`;
}
