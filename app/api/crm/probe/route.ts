import { NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { CRM_CONFIGURED, crmKeyFingerprint, crmPage, crmSearchRaw, extractRows } from "@/lib/crm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Round five, and the numbers finally get names.
 *
 * v4 turned out to be a DataTables endpoint — {draw, recordsTotal,
 * recordsFiltered, data}, paging on start/length — so the whole book is
 * readable now, 13,687 leads of it, and the stage histogram can be counted
 * exactly instead of sampled.
 *
 * Exact counts are what make this conclusive rather than suggestive. The CRM's
 * stages are wildly uneven and no two are close: cold calls ~7,982, the
 * disqualified group ~3,020, No Answer ~2,387, interested ~151, set a meeting
 * ~6, follow up after meeting ~2. A tally that lands on those figures is not a
 * pattern that could have come out any other way.
 *
 * The example names are the second, independent check, and the stronger one.
 * The CRM screen was showing samer and Donia Magdi as "fresh leads" and Manaly
 * farag, عادل حسن and Heba Z as "No Answer". If those names come back attached
 * to a status_id here, that id is settled by observation and owes nothing to
 * any inference about counts.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!CRM_CONFIGURED) return NextResponse.json({ ok: false, key: crmKeyFingerprint() }, { status: 400 });

  // Fallback that cannot fail: a name off the screen straight to its status_id.
  const q = req.nextUrl.searchParams.get("q");
  if (q) {
    const r = await crmSearchRaw(q, 10, "get-body");
    return NextResponse.json({
      ok: true, query: q,
      matches: extractRows(JSON.parse(r.text)).map((row) => ({
        full_name: row.full_name ?? null, status_id: row.status_id ?? null, leadgen_id: row.leadgen_id ?? null,
      })),
    });
  }

  // length=100 paged correctly; length=2000 returned 35 rows and then nothing,
  // so the server caps the page and does not say by how much. Find the ceiling
  // by asking, rather than picking a number and hoping.
  const startedAt = Date.now();
  const budgetMs = 42_000;
  const probes: { length: number; got: number }[] = [];
  let pageSize = 100;
  for (const len of [100, 250, 500, 1000]) {
    try {
      const { rows } = await crmPage(0, len);
      probes.push({ length: len, got: rows.length });
      // Only trust a length the server actually honoured in full.
      if (rows.length >= len) pageSize = len; else break;
    } catch { break; }
  }

  const counts = new Map<string, number>();
  const examples = new Map<string, string[]>();
  const metaLeads = new Map<string, number>();   // how many carry a leadgen_id
  let scanned = 0;
  let total = 0;
  let complete = false;
  let error: string | null = null;

  try {
    for (let start = 0; ; start += pageSize) {
      const { total: t, rows } = await crmPage(start, pageSize);
      total = t;
      if (!rows.length) break;

      for (const row of rows) {
        scanned++;
        const k = String(row.status_id ?? "null");
        counts.set(k, (counts.get(k) ?? 0) + 1);
        if (row.leadgen_id) metaLeads.set(k, (metaLeads.get(k) ?? 0) + 1);
        const ex = examples.get(k) ?? [];
        if (ex.length < 3 && typeof row.full_name === "string" && row.full_name.trim()) {
          ex.push(row.full_name.trim());
          examples.set(k, ex);
        }
      }

      if (scanned >= total) break;
      // Stop before the function is killed, and say so, rather than returning a
      // partial tally that reads exactly like a finished one.
      if (Date.now() - startedAt > budgetMs) break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // The previous round set this the moment a page came back empty, so a run
  // that saw 35 of 13,687 leads reported complete:true — the exact thing the
  // flag existed to prevent. Completeness is one question and one only: did we
  // account for every record the server says exists.
  complete = total > 0 && scanned >= total;

  return NextResponse.json({
    ok: true,
    total,
    scanned,
    complete,
    coverage: total > 0 ? Math.round((1000 * scanned) / total) / 10 + "%" : null,
    pageSize,
    pageSizeProbes: probes,
    elapsedMs: Date.now() - startedAt,
    error,
    stages: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([status_id, n]) => ({
        status_id,
        n,
        pct: Math.round((1000 * n) / Math.max(scanned, 1)) / 10,
        fromMetaAds: metaLeads.get(status_id) ?? 0,
        examples: examples.get(status_id) ?? [],
      })),
  });
}
