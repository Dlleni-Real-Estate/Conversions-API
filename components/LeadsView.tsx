"use client";

import { useMemo, useState } from "react";
import { STAGES, STAGE_BY_STATUS } from "@/lib/stages";
import { answerLabel, questionLabel, type FormDictionary } from "@/lib/labels";
import { Card, Empty, Td, Th, fmtAgo, fmtDate } from "./ui";
import { useLang } from "./LangProvider";
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
 *
 * Read-only by design. Stages and notes are the sales team's work, and the
 * sales team works in 8X CRM — asking them to type the same thing twice is
 * asking for it to be typed once, in the other place. What is shown here comes
 * from the CRM and from Meta; nothing on this screen writes.
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
  selectedId: string | null;
}) {
  const { t, s, lang, locale } = useLang();
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

  /** The two answers worth seeing without opening anything. */
  const preview = (lead: Lead) =>
    Object.entries(lead.raw_fields || {})
      .filter(([k]) => !/name|phone|email|whatsapp|رقم|الاسم|بريد|واتس/i.test(k))
      .slice(0, 2)
      .map(([k, v]) => ({ q: questionLabel(dictionary, k), a: answerLabel(dictionary, k, v) }));

  const isStale = (lead: Lead) => lead.status === "new" && hoursSince(lead.submitted_at) >= STALE_HOURS;

  const StageBadge = ({ lead, className = "" }: { lead: Lead; className?: string }) => {
    const stage = STAGE_BY_STATUS[lead.status];
    return (
      <span
        title={t.stageFromCrm}
        className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-semibold ${stage.color} ${className}`}
      >
        {s(lead.status)}
      </span>
    );
  };

  // What the agent actually wrote. `notes` is this app's own box and almost
  // nobody types in it; the sales team writes in 8X, and that text arrives in
  // lead_notes. Showing only the former left a dash on every lead that had
  // real feedback sitting one click away.
  const Note = ({ lead }: { lead: Lead }) => {
    const body = lead.notes || lead.last_note?.body || "";
    if (!body) return <span className="text-xs text-slate-300">—</span>;
    const author = lead.notes ? null : lead.last_note?.author ?? null;
    const more = (lead.note_count ?? 0) - (lead.notes ? 0 : 1);
    return (
      <div className="min-w-0">
        <div dir="auto" className="line-clamp-3 text-xs leading-relaxed text-slate-700">{body}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-slate-400">
          {author && <span dir="auto">{author}</span>}
          {more > 0 && <span>{t.notesCount(lead.note_count ?? 0)}</span>}
        </div>
      </div>
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
          {/* ── Phone: one real card per lead ────────────────────────────────
              Separated cards, not a divided list: on a phone a run of rows
              with hairlines between them reads as one long smear. Each card
              gets its own edge, its own shadow, and air around it. */}
          <ul className="space-y-3 bg-slate-100 p-3 md:hidden">
            {ordered.map((lead) => {
              const stage = STAGE_BY_STATUS[lead.status];
              const stale = isStale(lead);
              return (
                <li
                  key={lead.lead_id}
                  onClick={() => onOpen(lead)}
                  className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card"
                >
                  {/* The stage colour lives on the edge, so the card surface
                      stays white and the cards stay distinct from each other. */}
                  <span
                    className="absolute inset-y-0 start-0 w-1.5"
                    style={{ background: stage.accent }}
                    aria-hidden
                  />

                  <div className="ps-4 pe-3.5 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {stale && <span className="stale-dot h-2 w-2 shrink-0 rounded-full bg-orange-500" />}
                          <span dir="auto" className="truncate text-[15px] font-semibold text-slate-900">
                            {lead.full_name || t.unnamed}
                            {lead.quality_score != null && (
                              <span
                                title={t.qualityScore}
                                className={`ms-2 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                                  lead.quality_score >= 55
                                    ? "bg-emerald-50 text-emerald-700"
                                    : lead.quality_score >= 30
                                      ? "bg-amber-50 text-amber-700"
                                      : "bg-slate-100 text-slate-500"
                                }`}
                              >
                                {lead.quality_score}
                              </span>
                            )}
                          </span>
                        </div>
                        {lead.phone && (
                          <div dir="ltr" className="mt-0.5 text-start text-sm font-medium tabular-nums text-slate-600">
                            +{lead.phone}
                          </div>
                        )}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          stale ? "bg-orange-100 text-orange-700" : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {fmtAgo(lead.submitted_at, lang)}
                      </span>
                    </div>

                    <div dir="auto" className="mt-1 truncate text-[11px] text-slate-400">
                      {lead.ad_name || "—"}
                      {lead.form_name ? ` · ${lead.form_name}` : ""}
                    </div>

                    {preview(lead).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {preview(lead).map((f) => (
                          <span
                            key={f.q}
                            dir="auto"
                            className="rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200"
                          >
                            {f.a}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="mt-3 border-t border-slate-100 pt-3">
                      <StageBadge lead={lead} />

                      {lead.phone && (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <a
                            href={`https://wa.me/${lead.phone}`}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="tap flex items-center justify-center rounded-lg bg-emerald-600 text-sm font-semibold text-white shadow-card active:bg-emerald-700"
                          >
                            {t.whatsapp}
                          </a>
                          <a
                            href={`tel:+${lead.phone}`}
                            onClick={(e) => e.stopPropagation()}
                            className="tap flex items-center justify-center rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 shadow-card active:bg-slate-50"
                          >
                            {t.call}
                          </a>
                        </div>
                      )}

                      {lead.notes && (
                        <div className="mt-2 rounded-lg bg-slate-50 px-2.5 py-2 ring-1 ring-slate-200">
                          <Note lead={lead} />
                        </div>
                      )}
                    </div>
                  </div>
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
                  const stale = isStale(lead);
                  return (
                    <tr
                      key={lead.lead_id}
                      onClick={() => onOpen(lead)}
                      title={t.openDetails}
                      className={`cursor-pointer transition even:bg-slate-50/70 hover:bg-brand-50 ${
                        selectedId === lead.lead_id ? "bg-brand-50" : ""
                      }`}
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
                        {lead.owner && (
                          <div dir="auto" className="mt-0.5 max-w-[14rem] truncate text-[11px] font-medium text-brand-700">
                            {t.agent}: {lead.owner}
                          </div>
                        )}
                      </Td>

                      <Td>
                        <div className="text-xs text-slate-600">{fmtDate(lead.submitted_at, locale)}</div>
                        <div className={`text-xs ${stale ? "font-medium text-orange-600" : "text-slate-400"}`}>
                          {fmtAgo(lead.submitted_at, lang)}
                        </div>
                      </Td>

                      <Td>
                        <StageBadge lead={lead} />
                      </Td>

                      <Td>
                        <div className="max-w-[16rem]"><Note lead={lead} /></div>
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
