"use client";

import { useMemo, useState } from "react";
import { QUICK_MOVES, STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { answerLabel, questionLabel, type FormDictionary } from "@/lib/labels";
import { Card, Empty, Td, Th, fmtAgo, fmtDate } from "./ui";
import { useLang } from "./LangProvider";
import NoteCell from "./NoteCell";
import type { Lead } from "./types";

/** Untouched for longer than this and the row starts asking to be noticed. */
const STALE_HOURS = 2;

type Sort = "triage" | "newest" | "oldest";

const hoursSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3_600_000;

/**
 * The working list.
 *
 * Two layouts, one behaviour: a table on a laptop, a stack of cards on a phone.
 * The phone is where a broker actually stands — in a showroom, between calls —
 * so the mobile card is the primary design, not a squeezed table.
 *
 * The default order is triage, not newest: a lead nobody has called yet and
 * that has been sitting for three hours matters more than one that arrived a
 * minute ago. Sorting by arrival time is what lets old leads quietly rot.
 */
export default function LeadsView({
  leads,
  dictionary,
  loading,
  statusFilter,
  onStatusFilter,
  search,
  onSearch,
  onOpen,
  onChanged,
  pw,
  selectedId,
}: {
  leads: Lead[];
  dictionary: FormDictionary | null;
  loading: boolean;
  statusFilter: string;
  onStatusFilter: (v: string) => void;
  search: string;
  onSearch: (v: string) => void;
  onOpen: (lead: Lead) => void;
  onChanged: (lead: Lead, patch: Partial<Lead>) => void;
  pw: string;
  selectedId: string | null;
}) {
  const { t, s, lang, locale } = useLang();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; text: string } | null>(null);
  const [sort, setSort] = useState<Sort>("triage");

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of leads) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [leads]);

  const ordered = useMemo(() => {
    const rows = [...leads];
    if (sort === "newest") return rows.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
    if (sort === "oldest") return rows.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
    // Triage: untouched first, oldest untouched at the very top, then everyone
    // else newest-first.
    return rows.sort((a, b) => {
      const au = a.status === "new" ? 0 : 1;
      const bu = b.status === "new" ? 0 : 1;
      if (au !== bu) return au - bu;
      return au === 0
        ? a.submitted_at.localeCompare(b.submitted_at)
        : b.submitted_at.localeCompare(a.submitted_at);
    });
  }, [leads, sort]);

  async function move(lead: Lead, status: Status) {
    if (status === lead.status) return;
    setBusyId(lead.lead_id);
    try {
      const payload: Record<string, unknown> = { lead_id: lead.lead_id, status };
      if (status === "reservation") {
        const v = window.prompt(t.reservationPrompt);
        if (v && Number(v)) payload.deal_value = Number(v);
      }
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": pw },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");

      onChanged(lead, { status, deal_value: (payload.deal_value as number) ?? lead.deal_value });

      const ev = STAGE_BY_STATUS[status].event;
      setFlash({
        id: lead.lead_id,
        text: !ev ? t.saved : json.capi?.ok ? t.sentToMeta(ev) : t.metaRejected(json.capi?.error ?? "error"),
      });
      window.setTimeout(() => setFlash((f) => (f?.id === lead.lead_id ? null : f)), 4000);
    } catch (e) {
      setFlash({ id: lead.lead_id, text: e instanceof Error ? e.message : "Error" });
    } finally {
      setBusyId(null);
    }
  }

  /** The two answers worth seeing without opening anything. */
  const preview = (lead: Lead) =>
    Object.entries(lead.raw_fields || {})
      .filter(([k]) => !/name|phone|email|whatsapp|رقم|الاسم|بريد|واتس/i.test(k))
      .slice(0, 2)
      .map(([k, v]) => ({ q: questionLabel(dictionary, k), a: answerLabel(dictionary, k, v) }));

  const isStale = (lead: Lead) => lead.status === "new" && hoursSince(lead.submitted_at) >= STALE_HOURS;

  const StageSelect = ({ lead, className = "" }: { lead: Lead; className?: string }) => {
    const stage = STAGE_BY_STATUS[lead.status];
    return (
      <select
        value={lead.status}
        disabled={busyId === lead.lead_id}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => move(lead, e.target.value as Status)}
        className={`tap cursor-pointer rounded-lg border-2 px-2 py-1.5 text-xs font-semibold shadow-card outline-none ${stage.color} ${className}`}
        style={{ borderColor: stage.accent }}
      >
        {STAGES.map((st) => (
          <option key={st.status} value={st.status} className="bg-white font-normal text-slate-800">
            {s(st.status)}
          </option>
        ))}
      </select>
    );
  };

  const Controls = (
    // Two side by side then a full-width search on a phone; one row on a laptop.
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
      <select
        value={sort}
        onChange={(e) => setSort(e.target.value as Sort)}
        className="tap min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
      >
        <option value="triage">{t.sortTriage}</option>
        <option value="newest">{t.sortNewest}</option>
        <option value="oldest">{t.sortOldest}</option>
      </select>
      <select
        value={statusFilter}
        onChange={(e) => onStatusFilter(e.target.value)}
        className="tap min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
      >
        <option value="all">{t.allStatuses}</option>
        <option value="open">{t.openStatuses}</option>
        {STAGES.map((st) => (
          <option key={st.status} value={st.status}>
            {s(st.status)}
            {counts[st.status] ? ` (${counts[st.status]})` : ""}
          </option>
        ))}
      </select>
      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={t.searchPlaceholder}
        className="tap col-span-2 min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card outline-none focus:border-brand-500 sm:col-span-1 sm:w-44"
      />
    </div>
  );

  return (
    <Card
      title={t.leads}
      subtitle={`${leads.length} ${t.shown}${statusFilter !== "all" ? ` · ${t.filtered}` : ""}`}
      right={<div className="hidden sm:block">{Controls}</div>}
    >
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 sm:hidden">{Controls}</div>

      {ordered.length === 0 ? (
        <Empty>{loading ? t.loading : t.noLeads}</Empty>
      ) : (
        <>
          {/* ── Phone: one card per lead ─────────────────────────────────── */}
          <ul className="divide-y divide-slate-200 md:hidden">
            {ordered.map((lead) => {
              const stage = STAGE_BY_STATUS[lead.status];
              const stale = isStale(lead);
              return (
                <li
                  key={lead.lead_id}
                  onClick={() => onOpen(lead)}
                  className={`relative px-4 py-3.5 ${lead.status === "new" ? "bg-white" : stage.soft}`}
                >
                  <span
                    className="absolute inset-y-0 start-0 w-1"
                    style={{ background: stage.accent }}
                    aria-hidden
                  />

                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {stale && <span className="stale-dot h-2 w-2 shrink-0 rounded-full bg-orange-500" />}
                        <span dir="auto" className="truncate font-semibold text-slate-900">
                          {lead.full_name || t.unnamed}
                        </span>
                      </div>
                      <div dir="auto" className="mt-0.5 text-[11px] text-slate-500">
                        {fmtAgo(lead.submitted_at, lang)} · {lead.ad_name || "—"}
                      </div>
                    </div>
                    {lead.phone && (
                      <a
                        href={`https://wa.me/${lead.phone}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="tap flex shrink-0 items-center rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white shadow-card active:bg-emerald-700"
                      >
                        {t.whatsapp}
                      </a>
                    )}
                  </div>

                  {preview(lead).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {preview(lead).map((f) => (
                        <span
                          key={f.q}
                          dir="auto"
                          className="rounded-md bg-white/80 px-1.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200"
                        >
                          {f.a}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* One tap for the four moves that account for most of the
                      day; the full list stays in the select next to them. */}
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {QUICK_MOVES.filter((q) => q !== lead.status).map((q) => (
                      <button
                        key={q}
                        disabled={busyId === lead.lead_id}
                        onClick={(e) => {
                          e.stopPropagation();
                          move(lead, q);
                        }}
                        className={`tap rounded-lg border px-2.5 text-xs font-medium disabled:opacity-40 ${STAGE_BY_STATUS[q].color}`}
                      >
                        {s(q)}
                      </button>
                    ))}
                    <StageSelect lead={lead} className="min-w-[9rem] flex-1" />
                  </div>

                  <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                    <NoteCell
                      leadId={lead.lead_id}
                      lastNote={lead.notes}
                      count={lead.note_count ?? 0}
                      pw={pw}
                      onSaved={(body) =>
                        onChanged(lead, { notes: body, note_count: (lead.note_count ?? 0) + 1 })
                      }
                    />
                  </div>

                  {flash?.id === lead.lead_id && (
                    <div className="mt-2 text-[11px] text-slate-500">{flash.text}</div>
                  )}
                </li>
              );
            })}
          </ul>

          {/* ── Laptop: the table ────────────────────────────────────────── */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-100">
                <tr>
                  <Th>{t.colLead}</Th>
                  <Th>{t.colSource}</Th>
                  <Th>{t.colSubmitted}</Th>
                  <Th>{t.colStatus}</Th>
                  <Th>{t.colNotes}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {ordered.map((lead) => {
                  const stage = STAGE_BY_STATUS[lead.status];
                  const busy = busyId === lead.lead_id;
                  const stale = isStale(lead);
                  return (
                    <tr
                      key={lead.lead_id}
                      onClick={() => onOpen(lead)}
                      title={t.openDetails}
                      className={`cursor-pointer transition even:bg-slate-50/70 hover:bg-brand-50 ${
                        selectedId === lead.lead_id ? "bg-brand-50" : ""
                      } ${busy ? "opacity-60" : ""}`}
                    >
                      <Td>
                        <div className="flex items-start gap-2.5">
                          <span
                            className="mt-1 h-8 w-1 shrink-0 rounded-full"
                            style={{ background: stage.accent }}
                            aria-hidden
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              {stale && (
                                <span
                                  className="stale-dot h-2 w-2 shrink-0 rounded-full bg-orange-500"
                                  title={t.staleHint}
                                />
                              )}
                              <span dir="auto" className="font-medium text-slate-900">{lead.full_name || t.unnamed}</span>
                            </div>
                            {lead.phone && (
                              <a
                                href={`https://wa.me/${lead.phone}`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs font-medium text-emerald-700 hover:underline"
                                dir="ltr"
                              >
                                {lead.phone}
                              </a>
                            )}
                            {preview(lead).map((f) => (
                              <div key={f.q} dir="auto" className="max-w-xs truncate text-[11px] text-slate-500">
                                {f.q}: {f.a}
                              </div>
                            ))}
                          </div>
                        </div>
                      </Td>

                      <Td>
                        <div dir="auto" className="text-xs font-medium text-slate-700">{lead.ad_name || "—"}</div>
                        <div dir="auto" className="max-w-[14rem] truncate text-xs text-slate-400">
                          {lead.form_name || lead.campaign_name || ""}
                        </div>
                      </Td>

                      <Td>
                        <div className="text-xs text-slate-600">{fmtDate(lead.submitted_at, locale)}</div>
                        <div className={`text-xs ${stale ? "font-medium text-orange-600" : "text-slate-400"}`}>
                          {fmtAgo(lead.submitted_at, lang)}
                        </div>
                      </Td>

                      <Td>
                        <StageSelect lead={lead} className="w-full max-w-[11rem]" />
                        {flash?.id === lead.lead_id && (
                          <div className="mt-1 max-w-[12rem] text-[11px] leading-tight text-slate-500">
                            {flash.text}
                          </div>
                        )}
                      </Td>

                      <Td>
                        <NoteCell
                          leadId={lead.lead_id}
                          lastNote={lead.notes}
                          count={lead.note_count ?? 0}
                          pw={pw}
                          onSaved={(body) =>
                            onChanged(lead, { notes: body, note_count: (lead.note_count ?? 0) + 1 })
                          }
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
