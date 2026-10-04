import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { tokenHash } from "@/lib/agents";

export const dynamic = "force-dynamic";

/** Ends this device's session only. */
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-agent-token") || "";
  if (token) await supabaseAdmin().from("agent_sessions").delete().eq("token_hash", tokenHash(token));
  return NextResponse.json({ ok: true });
}
