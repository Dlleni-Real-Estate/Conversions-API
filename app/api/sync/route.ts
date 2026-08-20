import { NextRequest, NextResponse } from "next/server";
import { listLeadForms, fetchFormLeads, flattenFields, normalizeEgyptPhone } from "@/lib/meta";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Pulls new leads from every instant form on the Page into Supabase.
 * Runs on a Vercel cron every 10 minutes; also callable by hand.
 *
 * `?full=1` ignores the incremental watermark and re-reads every lead — use it
 * once on first run to backfill history.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const full = req.nextUrl.searchParams.get("full") === "1";
  const db = supabaseAdmin();
  const startedAt = new Date().toISOString();

  const { data: run } = await db.from("sync_runs").insert({ started_at: startedAt }).select("id").single();

  let formsSeen = 0;
  let leadsFound = 0;
  let leadsNew = 0;
  const perForm: { form: string; found: number; inserted: number; error?: string }[] = [];

  try {
    const forms = await listLeadForms();
    formsSeen = forms.length;

    for (const form of forms) {
      try {
        // Incremental watermark: only ask Meta for leads newer than our newest.
        let since: number | undefined;
        if (!full) {
          const { data: newest } = await db
            .from("leads")
            .select("submitted_at")
            .eq("form_id", form.id)
            .order("submitted_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (newest?.submitted_at) {
            since = Math.floor(new Date(newest.submitted_at).getTime() / 1000);
          }
        }

        const raw = await fetchFormLeads(form.id, since);
        leadsFound += raw.length;

        if (raw.length === 0) {
          perForm.push({ form: form.name, found: 0, inserted: 0 });
          continue;
        }

        const rows = raw.map((lead) => {
          const { fields, full_name, phone, email } = flattenFields(lead);
          return {
            lead_id: lead.id,
            form_id: lead.form_id || form.id,
            form_name: form.name,
            page_id: process.env.META_PAGE_ID,
            ad_id: lead.ad_id ?? null,
            ad_name: lead.ad_name ?? null,
            adset_id: lead.adset_id ?? null,
            adset_name: lead.adset_name ?? null,
            campaign_id: lead.campaign_id ?? null,
            campaign_name: lead.campaign_name ?? null,
            platform: lead.platform ?? null,
            is_organic: lead.is_organic ?? false,
            submitted_at: lead.created_time,
            full_name: full_name ?? null,
            phone: normalizeEgyptPhone(phone) ?? null,
            email: email ?? null,
            raw_fields: fields,
            synced_at: new Date().toISOString(),
          };
        });

        // ignoreDuplicates keeps a re-sync from wiping the sales team's status.
        const { data: inserted, error } = await db
          .from("leads")
          .upsert(rows, { onConflict: "lead_id", ignoreDuplicates: true })
          .select("lead_id");

        if (error) throw new Error(error.message);
        const n = inserted?.length ?? 0;
        leadsNew += n;
        perForm.push({ form: form.name, found: raw.length, inserted: n });
      } catch (err) {
        perForm.push({
          form: form.name,
          found: 0,
          inserted: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (run?.id) {
      await db
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          forms_seen: formsSeen,
          leads_found: leadsFound,
          leads_new: leadsNew,
          ok: true,
        })
        .eq("id", run.id);
    }

    return NextResponse.json({ ok: true, formsSeen, leadsFound, leadsNew, perForm });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run?.id) {
      await db
        .from("sync_runs")
        .update({ finished_at: new Date().toISOString(), ok: false, error: message })
        .eq("id", run.id);
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
