import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { answerLabel, buildDictionary, questionLabel } from "@/lib/labels";
import type { FormSchema } from "@/lib/meta";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The whole working set of leads as one spreadsheet.
 *
 * The point of this file is that everything a person needs to judge a lead
 * lives in ONE row: what the customer was asked and what they answered, in the
 * form's own Arabic; which campaign, ad set and ad brought them; where the
 * sales team left them; and every word the team wrote about them in 8X. Until
 * now that was spread across a table, a side panel, and the CRM.
 *
 * It takes exactly the filters the leads screen takes, so "export what I am
 * looking at" is literally the same query with no limit.
 */

/** Identity fields already have their own columns; don't repeat them. */
const IDENTITY_KEYS = /^(full_name|name|phone|phone_number|email|email_address)$/i;

/** Excel decides a CSV's encoding from the BOM, and Arabic without one is mojibake. */
const BOM = "﻿";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '""';
  // One row per lead: newlines inside a cell are legal CSV but they break
  // every naive downstream reader, and a note is a sentence, not a document.
  const s = String(v).replace(/\r?\n+/g, " / ").replace(/"/g, '""');
  return `"${s}"`;
}

type LeadRow = {
  lead_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  status: Status;
  status_at: string | null;
  owner: string | null;
  deal_value: number | null;
  quality_score: number | null;
  submitted_at: string;
  campaign_name: string | null;
  adset_name: string | null;
  ad_name: string | null;
  form_name: string | null;
  platform: string | null;
  raw_fields: Record<string, string> | null;
};

type NoteRow = {
  lead_id: string;
  kind: string;
  body: string | null;
  from_status: string | null;
  to_status: string | null;
  author: string | null;
  created_at: string;
};

const OPEN_STATUSES = [
  "new",
  "contacted",
  "no_answer",
  "unreachable",
  "qualified",
  "meeting_booked",
  "meeting_done",
  "site_visit_booked",
];

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const db = supabaseAdmin();
  const ar = (p.get("lang") || "en").startsWith("ar");

  // ── Exactly the leads screen's filters ───────────────────────────────────
  let q = db
    .from("leads")
    .select(
      "lead_id,full_name,phone,email,status,status_at,owner,deal_value,quality_score,submitted_at," +
        "campaign_name,adset_name,ad_name,form_name,platform,raw_fields"
    )
    .order("submitted_at", { ascending: false })
    .limit(5000);

  const account = (p.get("account") || "").replace(/^act_/, "");
  if (account && account !== "all") q = q.eq("ad_account_id", account);

  const campaign = p.get("campaign");
  if (campaign && campaign !== "all") q = q.eq("campaign_id", campaign);

  const adset = p.get("adset");
  if (adset && adset !== "all") q = q.eq("adset_id", adset);

  const ad = p.get("ad");
  if (ad && ad !== "all") q = q.eq("ad_id", ad);

  const status = p.get("status");
  if (status && status !== "all") {
    q = status === "open" ? q.in("status", OPEN_STATUSES) : q.eq("status", status);
  }

  const search = (p.get("q") || "").trim().replace(/[,()]/g, " ").slice(0, 60);
  if (search) {
    const ors = [
      `full_name.ilike.%${search}%`,
      `email.ilike.%${search}%`,
      `owner.ilike.%${search}%`,
      `ad_name.ilike.%${search}%`,
    ];
    const digits = search.replace(/\D/g, "");
    if (digits.length >= 3) {
      const variants = new Set([digits, digits.replace(/^0/, "20"), digits.replace(/^20/, "")]);
      for (const v of variants) if (v.length >= 3) ors.push(`phone.ilike.%${v}%`);
    }
    q = q.or(ors.join(","));
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const leads = (data ?? []) as unknown as LeadRow[];

  // ── The form's own wording, and every word the team wrote ────────────────
  const { data: forms } = await db.from("lead_forms").select("form_id, name, locale, questions");
  const dict = buildDictionary((forms ?? []) as unknown as FormSchema[]);

  // Chunked: a single .in() with thousands of ids becomes a URL no gateway
  // will carry, and it fails as a silent empty result rather than an error.
  const notesByLead = new Map<string, NoteRow[]>();
  const ids = leads.map((l) => l.lead_id);
  for (let i = 0; i < ids.length; i += 300) {
    const { data: chunk } = await db
      .from("lead_notes")
      .select("lead_id,kind,body,from_status,to_status,author,created_at")
      .in("lead_id", ids.slice(i, i + 300))
      .order("created_at", { ascending: true });
    for (const n of (chunk ?? []) as NoteRow[]) {
      const list = notesByLead.get(n.lead_id) ?? [];
      list.push(n);
      notesByLead.set(n.lead_id, list);
    }
  }

  // ── One column per question actually present, most-answered first ────────
  const keyCounts = new Map<string, number>();
  for (const l of leads) {
    for (const [k, v] of Object.entries(l.raw_fields ?? {})) {
      if (IDENTITY_KEYS.test(k) || !v?.trim()) continue;
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    }
  }
  const questionKeys = [...keyCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const stageName = (s: string | null) =>
    !s ? "" : ar ? STAGE_BY_STATUS[s as Status]?.labelAr ?? s : STAGE_BY_STATUS[s as Status]?.label ?? s;

  const header = ar
    ? [
        "الاسم", "الموبايل", "الإيميل", "تاريخ التسجيل",
        "المرحلة", "المسؤول", "تاريخ آخر تحديث", "سكور الجودة", "قيمة الصفقة",
        "الكمبين", "Ad Set", "الإعلان", "المنصة", "الفورم",
        ...questionKeys.map((k) => questionLabel(dict, k)),
        "ملاحظات الفريق", "عدد الملاحظات", "تاريخ المراحل", "Lead ID",
      ]
    : [
        "Name", "Phone", "Email", "Submitted",
        "Stage", "Owner", "Stage changed", "Quality score", "Deal value",
        "Campaign", "Ad set", "Ad", "Platform", "Form",
        ...questionKeys.map((k) => questionLabel(dict, k)),
        "Team notes", "Notes count", "Stage history", "Lead ID",
      ];

  const rows = leads.map((l) => {
    const notes = notesByLead.get(l.lead_id) ?? [];
    const written = notes.filter((n) => n.kind === "note" && n.body?.trim());
    const moves = notes.filter((n) => n.kind === "stage");

    return [
      l.full_name ?? "",
      // The invisible left-to-right mark is doing two jobs and neither is
      // decorative: it makes Excel read the cell as text (as a number,
      // 201022322504 becomes 2.01E+11 and the lead is unreachable), and it
      // keeps the digits running left-to-right inside a right-to-left sheet,
      // where they otherwise render in an order nobody can dial.
      l.phone ? `‎${l.phone}` : "",
      l.email ?? "",
      l.submitted_at ?? "",
      stageName(l.status),
      l.owner ?? "",
      l.status_at ?? "",
      l.quality_score ?? "",
      l.deal_value ?? "",
      l.campaign_name ?? "",
      l.adset_name ?? "",
      l.ad_name ?? "",
      l.platform ?? "",
      l.form_name ?? "",
      ...questionKeys.map((k) => {
        const v = l.raw_fields?.[k];
        return v?.trim() ? answerLabel(dict, k, v) : "";
      }),
      written.map((n) => `${n.author ? `${n.author}: ` : ""}${n.body}`).join(" | "),
      written.length,
      moves
        .map((n) => `${stageName(n.from_status)} → ${stageName(n.to_status)} (${(n.created_at || "").slice(0, 10)})`)
        .join(" | "),
      l.lead_id,
    ];
  });

  const csv = BOM + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
