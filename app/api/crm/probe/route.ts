import { NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { CRM_CONFIGURED, crmKeyFingerprint, crmPage, crmSearchRaw, crmTry, extractRows, findIdNamePairs } from "@/lib/crm";

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

  // Who is agent #8? The assignee arrives as a bare user id with no name, yet
  // the CRM's own Assignees filter lists every agent by name without firing a
  // single extra request — so the names sit either behind an expansion the v4
  // endpoint accepts, or behind a users endpoint the SPA caches at boot. Both
  // are asked here, and the answer decides how the mirror resolves names.
  if (req.nextUrl.searchParams.get("users")) {
    const out: Record<string, unknown> = { ok: true };

    // 1. Does v4 expand relations when asked in the request body?
    const expansions: Record<string, unknown>[] = [
      { start: 0, length: 2, with: ["assignees", "last_activity"] },
      { start: 0, length: 2, includes: ["assignees", "last_activity"] },
      { start: 0, length: 2, expand: ["assignees", "last_activity"] },
      { start: 0, length: 2, relations: ["assignees", "last_activity"] },
      { start: 0, length: 2, with_relations: true },
    ];
    const expTries: unknown[] = [];
    for (const body of expansions) {
      try {
        const r = await crmTry("POST", "/api/v4/leads/leads", body);
        const rows = r.status === 200 ? extractRows(JSON.parse(r.text)) : [];
        expTries.push({
          body: Object.keys(body).filter((k) => k !== "start" && k !== "length"),
          assignees_raw: rows[0] ? JSON.stringify(rows[0].assignees)?.slice(0, 300) : null,
        });
      } catch { /* next */ }
    }
    out.expansions = expTries;

    // 2. Is there a users/employees endpoint the key can reach?
    const KNOWN = /sabry|moustafa|shawki|zakaria|roshdy|rosh/i;
    const candidates = [
      "/api/v2/users/users", "/api/v1/users/users", "/api/v4/users/users",
      "/api/v2/users/get-users", "/api/v2/employees/employees",
      "/api/v2/hr/employees/employees", "/api/v1/employees/employees",
      "/api/v2/settings/users", "/api/v2/lookups/users", "/api/v2/agents/agents",
    ];
    const hits: unknown[] = [];
    for (const path of candidates) {
      for (const body of [{}, { start: 0, length: 100 }]) {
        try {
          const r = await crmTry("POST", path, body);
          if (r.status === 404 || r.status === 405) break;
          if (r.status !== 200) { hits.push({ path, httpStatus: r.status }); break; }
          const pairs = findIdNamePairs(JSON.parse(r.text));
          const known = pairs.filter((pr: { name: string }) => KNOWN.test(pr.name));
          hits.push({ path, pairs: known.length ? known : pairs.slice(0, 10), confirmed: known.length > 0 });
          break;
        } catch { /* next body */ }
      }
      if (hits.some((h) => (h as { confirmed?: boolean }).confirmed)) break;
    }
    out.userEndpoints = hits;

    // 3. Hunt for rows that actually HAVE last_activity, however deep they sit.
    const found: unknown[] = [];
    const t0 = Date.now();
    for (let start = 0; start < 3000 && found.length < 3 && Date.now() - t0 < 30_000; start += 250) {
      const { rows } = await crmPage(start, 250);
      if (!rows.length) break;
      for (const row of rows) {
        if (row.last_activity && found.length < 3) {
          found.push({
            full_name: row.full_name ?? null,
            status_id: row.status_id ?? null,
            last_activity_raw: JSON.stringify(row.last_activity)?.slice(0, 600),
          });
        }
      }
    }
    out.lastActivitySamples = found;

    return NextResponse.json(out);
  }

  // Raw shapes of the two fields the mirror could not read. The sync's
  // extractors returned null across the board, and null cannot say which of
  // two very different things happened: the shape is not what the extractors
  // expect, or the newest leads genuinely have no assignee and no activity
  // yet (a fresh, untouched lead has neither). Only the raw JSON of rows that
  // HAVE the fields can tell those apart.
  if (req.nextUrl.searchParams.get("inspect")) {
    const { rows } = await crmPage(0, 250);
    const interesting = rows.filter((r) => {
      const a = r.assignees, n = r.last_activity;
      const hasA = Array.isArray(a) ? a.length > 0 : Boolean(a);
      return hasA || Boolean(n);
    });
    const shape = (v: unknown) => JSON.stringify(v)?.slice(0, 600) ?? "undefined";
    return NextResponse.json({
      ok: true,
      rowsRead: rows.length,
      withEither: interesting.length,
      samples: interesting.slice(0, 4).map((r) => ({
        full_name: r.full_name ?? null,
        status_id: r.status_id ?? null,
        assignees_raw: shape(r.assignees),
        assignees_ids_raw: shape(r.assignees_ids),
        last_activity_raw: shape(r.last_activity),
      })),
      // One untouched row too, as the control case.
      control: rows[0]
        ? { full_name: rows[0].full_name ?? null, assignees_raw: shape(rows[0].assignees), last_activity_raw: shape(rows[0].last_activity) }
        : null,
    });
  }

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
