/**
 * Who did what, written where it cannot be quietly forgotten.
 *
 * Every mutating endpoint calls this once, after the mutation succeeds. The
 * write is fire-and-forget by design: an audit failure must never turn into a
 * user-facing failure of the thing being audited - but it does get logged, so
 * a broken audit trail is at least a visible one.
 */

import type { NextRequest } from "next/server";
import { supabaseAdmin } from "./supabase";
import { roleOf } from "./auth";

export async function logAudit(
  req: NextRequest,
  action: string,
  subject?: string | null,
  detail?: Record<string, unknown> | null
): Promise<void> {
  try {
    const db = supabaseAdmin();
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
    await db.from("audit_log").insert({
      actor: roleOf(req) ?? "unknown",
      action,
      subject: subject ?? null,
      detail: detail ?? null,
      ip,
    });
  } catch (err) {
    console.error("[audit] write failed:", err instanceof Error ? err.message : err);
  }
}
