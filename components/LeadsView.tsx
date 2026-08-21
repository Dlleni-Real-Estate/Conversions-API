"use client";

import { useMemo, useState } from "react";
import { STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { answerLabel, questionLabel, type FormDictionary } from "@/lib/labels";
import { Card, Empty, Td, Th, fmtAgo, fmtDate } from "./ui";
import { useLang } from "./LangProvider";
import NoteCell from "./NoteCell";
import type { Lead } from "./types";

/**
 * The working list.
 *
 * The two things a broker does a hundred times a day — move a stage, write a
 * note — happen on the row itself. Clicking anywhere else on the row opens the
 * full lead, so there is no button to hunt for.
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

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of leads) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [leads]);

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
  function preview(lead: Lead) {
    return Object.entries(lead.raw_fields || {})
      .filter(([k]) => !/name|phone|email|whatsapp|رقم|الاسم|بريد|واتس/i.test(k))
      .slice(0, 2)
      .map(([k, v]) => `${questionLabel(dictionary, k)}: ${answerLabel(dictionary, k, v)}`);
  }

  return (
    <Card
      title={t.leads}
      subtitle={`${leads.length} ${t.shown}${statusFilter !== "all" ? ` · ${t.filtered}` : ""}`}
      right={
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
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
            className="w-48 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card outline-none focus:border-slate-900"
          />
        </div>
      }
    >
      {leads.length === 0 ? (
        <Empty>{loading ? t.loading : t.noLeads}</Empty>
      ) : (
        <div className="overflow-x-auto">
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
              {leads.map((lead) => {
                const stage = STAGE_BY_STATUS[lead.status];
                const busy = busyId === lead.lead_id;
                return (
                  <tr
                    key={lead.lead_id}
                    onClick={() => onOpen(lead)}
                    title={t.openDetails}
                    className={`cursor-pointer transition even:bg-slate-50/70 hover:bg-sky-50 ${
                      selectedId === lead.lead_id ? "bg-sky-50" : ""
                    } ${busy ? "opacity-60" : ""}`}
                  >
                    <Td>
                      {/* A colour chip on the row edge, so a screenful of leads
                          reads as a pipeline rather than a wall of text. */}
                      <div className="flex items-start gap-2.5">
                        <span
                          className="mt-1 h-8 w-1 shrink-0 rounded-full"
                          style={{ background: stage.accent }}
                          aria-hidden
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900">{lead.full_name || t.unnamed}</div>
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
                          {preview(lead).map((line) => (
                            <div key={line} className="max-w-xs truncate text-[11px] text-slate-500">
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>
                    </Td>

                    <Td>
                      <div className="text-xs font-medium text-slate-700">{lead.ad_name || "—"}</div>
                      <div className="max-w-[14rem] truncate text-xs text-slate-400">
                        {lead.form_name || lead.campaign_name || ""}
                      </div>
                    </Td>

                    <Td>
                      <div className="text-xs text-slate-600">{fmtDate(lead.submitted_at, locale)}</div>
                      <div className="text-xs text-slate-400">{fmtAgo(lead.submitted_at, lang)}</div>
                    </Td>

                    <Td>
                      <div onClick={(e) => e.stopPropagation()}>
                        <select
                          value={lead.status}
                          disabled={busy}
                          onChange={(e) => move(lead, e.target.value as Status)}
                          className={`w-full max-w-[11rem] cursor-pointer rounded-lg border-2 px-2 py-1.5 text-xs font-semibold shadow-card outline-none ${stage.color}`}
                          style={{ borderColor: stage.accent }}
                        >
                          {STAGES.map((st) => (
                            <option key={st.status} value={st.status} className="bg-white font-normal text-slate-800">
                              {s(st.status)}
                            </option>
                          ))}
                        </select>
                        {flash?.id === lead.lead_id && (
                          <div className="mt-1 max-w-[12rem] text-[11px] leading-tight text-slate-500">
                            {flash.text}
                          </div>
                        )}
                      </div>
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
      )}
    </Card>
  );
}
