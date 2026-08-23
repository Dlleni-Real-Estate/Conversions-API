import { NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import {
  CRM_CONFIGURED, crmKeyFingerprint, crmTry, extractRows, findIdNamePairs, LOOKUP_CANDIDATES,
} from "@/lib/crm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Round three, and the only question left: which number is which stage.
 *
 * Rounds one and two settled everything else. The CRM carries Meta's own
 * leadgen_id and it matched ours on every lead that exists in both, so the join
 * is exact. Stage is `status_id` and no name appears anywhere on a lead record.
 *
 * Guessing the ids from their order would be easy and wrong-shaped: the numbers
 * seen so far start at 69, and if 71 is "No Answer" rather than "cold calls"
 * then live leads get filed one stage off, and that error leaves here as
 * optimisation signal to Meta before any screen would show it. So this asks
 * twice, two independent ways, and only a matching answer is worth trusting:
 *
 *   NAMES  - the endpoint the CRM's own Stage Mappings screen loads from.
 *   SHAPE  - the real distribution of status_id across a sample of leads.
 *            The CRM's stage counts are wildly uneven (cold calls ~7,982,
 *            No Answer ~2,387, interested ~151, set a meeting ~6), so the
 *            shape of the histogram identifies the big stages on its own.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!CRM_CONFIGURED) return NextResponse.json({ ok: false, key: crmKeyFingerprint() }, { status: 400 });

  const out: Record<string, unknown> = { ok: true };

  // ── NAMES ────────────────────────────────────────────────────────────────
  const bodies: unknown[] = [{}, { slug: "meta_conversions" }, { integration: "meta_conversions" }, { key: "meta_conversions" }];
  const named: unknown[] = [];
  for (const path of LOOKUP_CANDIDATES) {
    for (const body of bodies) {
      try {
        const r = await crmTry("POST", path, body);
        if (r.status !== 200) continue;
        const parsed = JSON.parse(r.text);
        const pairs = findIdNamePairs(parsed);
        // Only report a hit that actually looks like the stage list — the CRM's
        // own screen shows these exact names.
        const looksLikeStages = pairs.filter((p) =>
          /fresh|cold call|no answer|interested|meeting|budget|available|network|expo|call back/i.test(p.name)
        );
        if (looksLikeStages.length) { named.push({ path, body, pairs: looksLikeStages }); break; }
        if (pairs.length) named.push({ path, body, sample: pairs.slice(0, 20) });
      } catch { /* wrong shape for this endpoint — try the next */ }
    }
    if (named.some((n) => (n as { pairs?: unknown[] }).pairs?.length)) break;
  }
  out.names = named;

  // ── SHAPE ────────────────────────────────────────────────────────────────
  const tally = new Map<string, number>();
  let scanned = 0;
  for (let page = 1; page <= 6; page++) {
    try {
      const r = await crmTry("POST", "/api/v4/leads/leads", { page, per_page: 100 });
      if (r.status !== 200) { out.v4Error = { page, httpStatus: r.status, preview: r.text.slice(0, 200) }; break; }
      const rows = extractRows(JSON.parse(r.text));
      if (!rows.length) break;
      for (const row of rows) {
        scanned++;
        const k = String(row.status_id ?? "null");
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }
    } catch (err) { out.v4Error = { page, error: err instanceof Error ? err.message : String(err) }; break; }
  }
  out.statusHistogram = {
    scanned,
    counts: [...tally.entries()].sort((a, b) => b[1] - a[1])
      .map(([status_id, n]) => ({ status_id, n, pct: Math.round((1000 * n) / Math.max(scanned, 1)) / 10 })),
  };

  return NextResponse.json(out);
}
