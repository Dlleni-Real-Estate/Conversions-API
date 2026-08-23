import { NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { CRM_CONFIGURED, crmKeyFingerprint, crmSearchRaw, crmTry, extractRows, findIdNamePairs } from "@/lib/crm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Round four. One question left: which number is which stage.
 *
 * Round three asked the integration-settings endpoint and got the integration's
 * own form fields back, not the stage list, and the histogram came out useless
 * because v4 ignored `page`/`per_page` and returned the same five rows six
 * times (18 and 12 across "six pages" — both exact multiples of six).
 *
 * So this stops guessing at the envelope and reads it. Laravel names its
 * paginator fields in the reply itself, so one look at the top-level keys
 * settles what the request should have said. Three angles, and any one of them
 * is enough:
 *
 *   ENVELOPE   - what v4 calls its own paging fields.
 *   PAGING     - twelve request shapes; the one that moves the first row id off
 *                the default page is the real one. Row ids, not counts: a wrong
 *                shape returns page one again, which counts the same as right.
 *   SAVEDFILTER- the screen has a saved filter applied, and a saved stage
 *                filter has to store stage ids. If it also carries labels, that
 *                is the mapping outright.
 *
 * `?q=` stays as the fallback that cannot fail: search a name read off the CRM
 * screen, read back its status_id, and the pair is settled by observation.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!CRM_CONFIGURED) return NextResponse.json({ ok: false, key: crmKeyFingerprint() }, { status: 400 });

  const out: Record<string, unknown> = { ok: true };

  // ── q= : resolve a name straight to its status_id ────────────────────────
  const q = req.nextUrl.searchParams.get("q");
  if (q) {
    const r = await crmSearchRaw(q, 10, "get-body");
    const rows = extractRows(JSON.parse(r.text));
    out.query = q;
    out.matches = rows.map((row) => ({
      full_name: row.full_name ?? null,
      status_id: row.status_id ?? null,
      leadgen_id: row.leadgen_id ?? null,
      updated_at: row.updated_at ?? null,
    }));
    return NextResponse.json(out);
  }

  // ── ENVELOPE ─────────────────────────────────────────────────────────────
  try {
    const r = await crmTry("POST", "/api/v4/leads/leads", {});
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    const data = parsed.data as Record<string, unknown> | undefined;
    out.envelope = {
      topKeys: Object.keys(parsed),
      // Laravel hides {current_page,last_page,per_page,total} one level down.
      dataKeys: data && !Array.isArray(data) ? Object.keys(data) : "(data is an array)",
      meta: data && !Array.isArray(data)
        ? Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === "number" || typeof v === "string"))
        : null,
    };
  } catch (err) {
    out.envelope = { error: err instanceof Error ? err.message : String(err) };
  }

  // ── PAGING ───────────────────────────────────────────────────────────────
  const shapes: { label: string; body: unknown }[] = [
    { label: "page+per_page", body: { page: 2, per_page: 100 } },
    { label: "page+limit", body: { page: 2, limit: 100 } },
    { label: "page+size", body: { page: 2, size: 100 } },
    { label: "page+perPage", body: { page: 2, perPage: 100 } },
    { label: "limit+offset", body: { limit: 100, offset: 100 } },
    { label: "start+length", body: { start: 100, length: 100 } },
    { label: "nested pagination", body: { pagination: { page: 2, per_page: 100 } } },
    { label: "take+skip", body: { take: 100, skip: 100 } },
    { label: "page+rows", body: { page: 2, rows: 100 } },
    { label: "paginate", body: { paginate: 100, page: 2 } },
    { label: "page only", body: { page: 2 } },
    { label: "per_page only", body: { per_page: 100 } },
  ];
  const paging: unknown[] = [];
  let baselineFirstId: unknown = null;
  try {
    const base = extractRows(JSON.parse((await crmTry("POST", "/api/v4/leads/leads", {})).text));
    baselineFirstId = base[0]?.id ?? null;
    paging.push({ label: "(baseline, no params)", rowCount: base.length, firstId: baselineFirstId });
  } catch { /* baseline unavailable; the shapes below still report counts */ }

  for (const s of shapes) {
    try {
      const r = await crmTry("POST", "/api/v4/leads/leads", s.body);
      const rows = extractRows(JSON.parse(r.text));
      paging.push({
        label: s.label,
        rowCount: rows.length,
        firstId: rows[0]?.id ?? null,
        // The only signal that matters: did we actually leave page one?
        moved: rows[0]?.id !== undefined && rows[0]?.id !== baselineFirstId,
      });
    } catch { paging.push({ label: s.label, error: "failed" }); }
  }
  // Query-string paging, in case the body is ignored entirely.
  try {
    const r = await crmTry("POST", "/api/v4/leads/leads?page=2&per_page=100", {});
    const rows = extractRows(JSON.parse(r.text));
    paging.push({ label: "querystring", rowCount: rows.length, firstId: rows[0]?.id ?? null, moved: rows[0]?.id !== baselineFirstId });
  } catch { /* ignored */ }
  out.paging = paging;

  // ── SAVEDFILTER ──────────────────────────────────────────────────────────
  const saved: unknown[] = [];
  for (const body of [{ screen_slug: "leads" }, { slug: "leads" }, { screen: "leads" }, {}]) {
    try {
      const r = await crmTry("POST", "/api/v2/saved-filters/saved-filters/get-saved-filters-by-screen-slug", body);
      if (r.status !== 200) continue;
      const parsed = JSON.parse(r.text);
      const pairs = findIdNamePairs(parsed);
      saved.push({ body, pairs: pairs.slice(0, 40), preview: pairs.length ? null : r.text.slice(0, 400) });
      if (pairs.length) break;
    } catch { /* try the next body shape */ }
  }
  out.savedFilters = saved;

  return NextResponse.json(out);
}
