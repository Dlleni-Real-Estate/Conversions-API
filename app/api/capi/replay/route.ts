import { NextRequest, NextResponse } from "next/server";
import { replayFailed } from "@/lib/capi";
import { isAuthed } from "@/lib/auth";
import { renewExpiringTokens } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hourly cron: retry any CAPI event that never made it to Meta, then renew tokens. */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await replayFailed();
  const tokens = await renewExpiringTokens();
  return NextResponse.json({ ok: true, ...result, tokens });
}
