"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Empty, fmtDate, fmtPct } from "./ui";
import { useLang } from "./LangProvider";
import { STAGE_BY_STATUS, type Status } from "@/lib/stages";
import type { AgentReport as Report, ReportLead } from "@/lib/agentReport";

/**
 * The manager's report on the agents: every agent side by side, then one
 * agent in full - the numbers, the "not qualified" reasons, each campaign,
 * and every lead behind them - with a CSV of either.
 */

const RANGES = [1, 7, 30, 90];

const TX = {
  en: {
    title: "Agent quality report",
    sub: "How fast each agent calls, how many they reach and qualify, and whether they keep their callbacks. Test leads never count.",
    today: "Today",
    days: (n: number) => `${n} days`,
    csv: "Export CSV",
    agent: "Agent",
    score: "Score",
    leads: "Leads",
    untouched: "Not called",
    median: "Median to call",
    within5: "Called ≤5 min",
    answer: "Answer rate",
    qualified: "Qualified",
    disq: "Not qualified",
    callbacks: "Callbacks on time",
    moved: "Moved away",
    none: "No leads were handed to agents in this period.",
    loading: "Loading…",
    min: "min",
    pick: "Click an agent for the full report.",
    worked: "Worked",
    calls: "Calls",
    perLead: "calls per called lead",
    noAnswer: "No answer",
    phoneOff: "Phone off",
    later: "Meetings and beyond",
    reservations: "Reservations",
    notes: "Leads with a note",
    reasons: "Why not qualified",
    noReasons: "No reasons recorded.",
    stages: "Where their leads are now",
    campaigns: "By campaign",
    campaign: "Campaign",
    called: "Called",
    allLeads: "Every lead",
    lead: "Lead",
    status: "Stage",
    assigned: "Assigned",
    firstCall: "First call",
    followUp: "Callback",
    note: "Last note",
    fu: { none: "—", upcoming: "Upcoming", on_time: "On time", late: "Late", missed: "Missed" } as Record<ReportLead["follow_up_state"], string>,
    never: "Never",
    close: "Close",
    scoreHelp: "Score out of 100: speed to call 30, leads worked 25, answered→qualified 20, callbacks kept 15, notes written 10.",
    over15: (n: number) => `${n} waiting over 15 min now`,
    movedHelp: "Leads moved to another agent because they were not called in time.",
  },
  ar: {
    title: "تقرير جودة الإيجنتس",
    sub: "كل إيجنت بيتصل بسرعة قد إيه، بيوصل لكام ليد ويأهّل كام، وبيلتزم بمواعيد المكالمات ولا لأ. ليدز التجربة مش بتتحسب.",
    today: "النهارده",
    days: (n: number) => `${n} يوم`,
    csv: "تصدير CSV",
    agent: "الإيجنت",
    score: "التقييم",
    leads: "الليدز",
    untouched: "لسه متكلموش",
    median: "متوسط وقت الاتصال",
    within5: "اتصل خلال ٥ د",
    answer: "نسبة الرد",
    qualified: "مؤهلين",
    disq: "مش مؤهلين",
    callbacks: "مواعيد في وقتها",
    moved: "اتحولت منه",
    none: "مفيش ليدز اتوزعت على الإيجنتس في الفترة دي.",
    loading: "بيحمّل…",
    min: "د",
    pick: "دوس على أي إيجنت عشان تشوف التقرير الكامل.",
    worked: "اتشغل عليها",
    calls: "المكالمات",
    perLead: "مكالمة لكل ليد اتصل بيها",
    noAnswer: "مردش",
    phoneOff: "مقفول",
    later: "اجتماع وأكتر",
    reservations: "حجوزات",
    notes: "ليدز فيها ملاحظة",
    reasons: "أسباب عدم التأهيل",
    noReasons: "مفيش أسباب متسجلة.",
    stages: "الليدز بتاعته فين دلوقتي",
    campaigns: "حسب الكمبين",
    campaign: "الكمبين",
    called: "اتصل",
    allLeads: "كل الليدز",
    lead: "الليد",
    status: "المرحلة",
    assigned: "اتوزعت",
    firstCall: "أول مكالمة",
    followUp: "معاد المكالمة",
    note: "آخر ملاحظة",
    fu: { none: "—", upcoming: "جاي", on_time: "في وقته", late: "متأخر", missed: "فاته" } as Record<ReportLead["follow_up_state"], string>,
    never: "متصلش",
    close: "قفل",
    scoreHelp: "التقييم من ١٠٠: سرعة الاتصال ٣٠، الليدز اللي اتشغل عليها ٢٥، المؤهلين من اللي ردوا ٢٠، الالتزام بالمواعيد ١٥، كتابة الملاحظات ١٠.",
    over15: (n: number) => `${n} مستنيين أكتر من ١٥ دقيقة دلوقتي`,
    movedHelp: "ليدز اتحولت لإيجنت تاني عشان ماتصلش بيها في الوقت.",
  },
};

const scoreColor = (s: number | null) =>
  s === null ? "bg-slate-100 text-slate-500" : s >= 75 ? "bg-emerald-100 text-emerald-800" : s >= 50 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";

function download(name: string, rows: (string | number | null)[][]) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AgentReport({ pw }: { pw: string }) {
  const { lang, locale } = useLang();
  const tx = TX[lang];
  const ar = lang === "ar";
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<Report[] | null>(null);
  const [open, setOpen] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);

  const get = useCallback(
    async (qs: string) => {
      const res = await fetch(`/api/admin/agents/report?${qs}`, { headers: { "x-app-password": pw } });
      const j = await res.json().catch(() => ({}));
      return (j.agents || []) as Report[];
    },
    [pw]
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    get(`days=${days}`)
      .then((r) => live && setRows(r))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [days, get]);

  const openAgent = async (r: Report) => {
    setOpen(r);
    const [full] = await get(`days=${days}&agent_id=${encodeURIComponent(r.agent_id)}&leads=1`);
    if (full) setOpen(full);
  };

  const stage = (s: Status) => (ar ? STAGE_BY_STATUS[s]?.labelAr : STAGE_BY_STATUS[s]?.label) ?? s;
  const mins = (m: number | null) => (m === null ? "—" : `${m} ${tx.min}`);

  const exportAll = () =>
    rows &&
    download(`agents-report-${days}d.csv`, [
      [tx.agent, tx.score, tx.leads, tx.worked, tx.untouched, tx.median, tx.within5, tx.answer, tx.qualified, tx.disq, tx.callbacks, tx.moved, tx.calls],
      ...rows.map((r) => [
        r.name,
        r.score,
        r.leads,
        r.worked,
        r.untouched,
        r.median_call_min,
        fmtPct(r.within5_pct),
        fmtPct(r.answer_rate),
        `${r.qualified} (${fmtPct(r.qualified_rate)})`,
        r.disqualified,
        `${r.followups_on_time}/${r.followups_due}`,
        r.moved_away,
        r.calls,
      ]),
    ]);

  const exportLeads = (r: Report) =>
    download(`${r.name}-leads-${days}d.csv`, [
      [tx.lead, "Phone", tx.campaign, tx.status, tx.assigned, tx.firstCall, tx.calls, tx.followUp, tx.note],
      ...r.leads_list.map((l) => [
        l.name,
        l.phone ? `+${l.phone}` : "",
        l.campaign,
        stage(l.status),
        l.assigned_at,
        l.first_call_min === null ? tx.never : l.first_call_min,
        l.calls,
        tx.fu[l.follow_up_state],
        l.note,
      ]),
    ]);

  return (
    <Card
      title={tx.title}
      subtitle={tx.sub}
      right={
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs">
            {RANGES.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`tap rounded-md px-2.5 py-1 font-medium ${days === d ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
              >
                {d === 1 ? tx.today : tx.days(d)}
              </button>
            ))}
          </div>
          <button onClick={exportAll} disabled={!rows?.length} className="tap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40">
            {tx.csv}
          </button>
        </div>
      }
    >
      {!rows ? (
        <Empty>{tx.loading}</Empty>
      ) : rows.every((r) => r.leads === 0 && r.moved_away === 0) ? (
        <Empty>{tx.none}</Empty>
      ) : (
        <div className={`overflow-x-auto ${loading ? "opacity-60" : ""}`}>
          <table className="w-full min-w-[920px] text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                {[tx.agent, tx.score, tx.leads, tx.untouched, tx.median, tx.within5, tx.answer, tx.qualified, tx.disq, tx.callbacks, tx.moved].map((h, i) => (
                  <th key={h} className={`px-3 py-2 font-semibold ${i === 0 ? "text-start" : "text-center"}`} title={i === 1 ? tx.scoreHelp : i === 10 ? tx.movedHelp : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.agent_id} onClick={() => openAgent(r)} className="cursor-pointer hover:bg-slate-50">
                  <td className="px-3 py-2.5 font-medium"><bdi>{r.name}</bdi></td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-block min-w-[2.5rem] rounded-md px-2 py-0.5 text-xs font-bold tabular-nums ${scoreColor(r.score)}`}>{r.score ?? "—"}</span>
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{r.leads}</td>
                  <td className={`px-3 py-2.5 text-center tabular-nums ${r.untouched ? "font-semibold text-red-600" : ""}`}>{r.untouched}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{mins(r.median_call_min)}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{fmtPct(r.within5_pct)}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{fmtPct(r.answer_rate)}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums">
                    {r.qualified} <span className="text-slate-400">({fmtPct(r.qualified_rate)})</span>
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{r.disqualified}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{r.followups_due ? `${r.followups_on_time}/${r.followups_due}` : "—"}</td>
                  <td className={`px-3 py-2.5 text-center tabular-nums ${r.moved_away ? "font-semibold text-amber-700" : ""}`}>{r.moved_away}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-5 py-2 text-xs text-slate-500">{tx.pick} · {tx.scoreHelp}</p>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setOpen(null)}>
          <div className="h-full w-full max-w-3xl overflow-y-auto bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
              <div className="min-w-0">
                <h3 className="truncate text-lg font-semibold"><bdi>{open.name}</bdi></h3>
                <p className="text-xs text-slate-500">{RANGES.includes(days) && days === 1 ? tx.today : tx.days(days)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-lg px-3 py-1 text-lg font-bold tabular-nums ${scoreColor(open.score)}`} title={tx.scoreHelp}>
                  {open.score ?? "—"}
                </span>
                <button onClick={() => exportLeads(open)} disabled={!open.leads_list.length} className="tap rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40">
                  {tx.csv}
                </button>
                <button onClick={() => setOpen(null)} className="tap rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium">{tx.close}</button>
              </div>
            </div>

            <div className="space-y-6 p-5">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  [tx.leads, open.leads],
                  [tx.worked, open.worked],
                  [tx.untouched, open.untouched],
                  [tx.median, mins(open.median_call_min)],
                  [tx.within5, fmtPct(open.within5_pct)],
                  [tx.answer, fmtPct(open.answer_rate)],
                  [tx.qualified, `${open.qualified} (${fmtPct(open.qualified_rate)})`],
                  [tx.disq, open.disqualified],
                  [tx.noAnswer, open.no_answer],
                  [tx.phoneOff, open.unreachable],
                  [tx.later, open.later_stages],
                  [tx.reservations, open.reservations],
                  [tx.callbacks, open.followups_due ? `${open.followups_on_time}/${open.followups_due}` : "—"],
                  [tx.calls, `${open.calls}${open.calls_per_lead !== null ? ` · ${open.calls_per_lead} ${tx.perLead}` : ""}`],
                  [tx.notes, fmtPct(open.notes_rate)],
                  [tx.moved, open.moved_away],
                ].map(([k, v]) => (
                  <div key={String(k)} className="rounded-xl bg-slate-50 px-3 py-2.5">
                    <div className="text-base font-semibold tabular-nums">{v}</div>
                    <div className="mt-0.5 text-[11px] leading-tight text-slate-500">{k}</div>
                  </div>
                ))}
              </div>
              {open.untouched_over_15m > 0 && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">⚠ {tx.over15(open.untouched_over_15m)}</p>
              )}

              <section>
                <h4 className="text-sm font-semibold">{tx.stages}</h4>
                <div className="mt-2 flex h-7 overflow-hidden rounded-lg border border-slate-200 text-[11px] font-semibold text-white">
                  {(Object.entries(open.by_status) as [Status, number][]).map(([s, n]) => (
                    <div
                      key={s}
                      style={{ width: `${(100 * n) / Math.max(1, open.leads)}%`, background: STAGE_BY_STATUS[s]?.accent || "#64748b" }}
                      className="flex min-w-0 items-center justify-center truncate px-1"
                      title={`${stage(s)}: ${n}`}
                    >
                      <span className="truncate">{n}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                  {(Object.entries(open.by_status) as [Status, number][]).map(([s, n]) => (
                    <span key={s} className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ background: STAGE_BY_STATUS[s]?.accent }} />
                      {stage(s)}: {n}
                    </span>
                  ))}
                </div>
              </section>

              <section>
                <h4 className="text-sm font-semibold">{tx.reasons}</h4>
                {open.reasons.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">{tx.noReasons}</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {open.reasons.map((r) => (
                      <li key={r.reason} className="flex items-center gap-3 text-sm">
                        <span className="w-36 shrink-0 truncate">{r.reason}</span>
                        <span className="h-2 rounded-full bg-red-400" style={{ width: `${(100 * r.count) / Math.max(1, open.disqualified)}%`, maxWidth: "60%" }} />
                        <span className="tabular-nums text-slate-600">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h4 className="text-sm font-semibold">{tx.campaigns}</h4>
                <table className="mt-2 w-full text-sm">
                  <thead className="text-[11px] uppercase text-slate-500">
                    <tr>
                      {[tx.campaign, tx.leads, tx.called, tx.median, tx.answer, tx.qualified].map((h, i) => (
                        <th key={h} className={`py-1.5 font-semibold ${i === 0 ? "text-start" : "text-center"}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {open.by_campaign.map((c) => (
                      <tr key={c.campaign_id ?? c.campaign_name}>
                        <td className="max-w-[260px] truncate py-1.5" dir="auto">{c.campaign_name}</td>
                        <td className="py-1.5 text-center tabular-nums">{c.leads}</td>
                        <td className="py-1.5 text-center tabular-nums">{c.called}</td>
                        <td className="py-1.5 text-center tabular-nums">{mins(c.median_call_min)}</td>
                        <td className="py-1.5 text-center tabular-nums">{fmtPct(c.called ? Math.round((100 * c.answered) / c.called) : null)}</td>
                        <td className="py-1.5 text-center tabular-nums">{c.qualified}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h4 className="text-sm font-semibold">{tx.allLeads}</h4>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="text-[11px] uppercase text-slate-500">
                      <tr>
                        {[tx.lead, tx.status, tx.assigned, tx.firstCall, tx.calls, tx.followUp, tx.note].map((h, i) => (
                          <th key={h} className={`py-1.5 font-semibold ${i === 0 || i === 6 ? "text-start" : "text-center"}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {open.leads_list.map((l) => (
                        <tr key={l.lead_id}>
                          <td className="py-1.5">
                            <div className="font-medium" dir="auto">{l.name || "—"}</div>
                            <div className="max-w-[200px] truncate text-[11px] text-slate-500" dir="auto">{l.campaign}</div>
                          </td>
                          <td className="py-1.5 text-center">
                            <span className="inline-flex items-center gap-1 text-xs">
                              <span className="h-2 w-2 rounded-full" style={{ background: STAGE_BY_STATUS[l.status]?.accent }} />
                              {stage(l.status)}
                            </span>
                          </td>
                          <td className="py-1.5 text-center text-xs text-slate-600">{fmtDate(l.assigned_at, locale)}</td>
                          <td className={`py-1.5 text-center tabular-nums ${l.first_call_min === null ? "text-red-600" : l.first_call_min > 15 ? "text-amber-700" : ""}`}>
                            {l.first_call_min === null ? tx.never : mins(l.first_call_min)}
                          </td>
                          <td className="py-1.5 text-center tabular-nums">{l.calls}</td>
                          <td className={`py-1.5 text-center text-xs ${l.follow_up_state === "missed" ? "font-semibold text-red-600" : l.follow_up_state === "late" ? "text-amber-700" : ""}`}>
                            {tx.fu[l.follow_up_state]}
                          </td>
                          <td className="max-w-[220px] truncate py-1.5 text-xs text-slate-600" dir="auto" title={l.note || ""}>{l.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
