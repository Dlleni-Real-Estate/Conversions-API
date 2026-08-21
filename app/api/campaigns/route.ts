import { NextRequest, NextResponse } from "next/server";
import { listCampaigns } from "@/lib/meta";
import { resolveCampaigns, setCutoff, setOverride, clearOverride } from "@/lib/tracking";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Every campaign on the ad account, with whether the platform is watching it. */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  try {
    const { cutoff, states } = await resolveCampaigns(db, await listCampaigns());
    return NextResponse.json({ ok: true, cutoff, campaigns: states });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * Body is one of:
 *   { cutoff: "2026-08-01" }                         move the date line
 *   { campaign_id, enabled: true|false, name?, created_time? }   pin a campaign
 *   { campaign_id, enabled: null }                   unpin — back to the date rule
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  try {
    const body = (await req.json()) as {
      cutoff?: string;
      campaign_id?: string;
      enabled?: boolean | null;
      name?: string;
      created_time?: string;
    };

    if (typeof body.cutoff === "string") {
      await setCutoff(db, body.cutoff);
    } else if (typeof body.campaign_id === "string") {
      if (body.enabled === null) {
        await clearOverride(db, body.campaign_id);
      } else if (typeof body.enabled === "boolean") {
        await setOverride(
          db,
          { id: body.campaign_id, name: body.name, created_time: body.created_time },
          body.enabled
        );
      } else {
        return NextResponse.json({ ok: false, error: "enabled must be true, false or null" }, { status: 400 });
      }
    } else {
      return NextResponse.json({ ok: false, error: "nothing to change" }, { status: 400 });
    }

    const { cutoff, states } = await resolveCampaigns(db, await listCampaigns());
    return NextResponse.json({ ok: true, cutoff, campaigns: states });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
