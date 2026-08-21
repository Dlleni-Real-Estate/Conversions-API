"use client";

import { useMemo, useState } from "react";
import { STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { answerLabel, questionLabel, type FormDictionary } from "@/lib/labels";
import { Card, Empty, Td, Th, fmtAgo, fmtDate } from "./ui";
import { useLang } from "./LangProvider";
import type { Lead } from "./types";

/**
 * The working list. Everything a broker does a hundred times a day happens on
 * the row itself — change the stage, drop a note — and the detail panel is only
 * for when they want the whole story.
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
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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

  async function saveNote(lead: Lead) {
    const body = draft.trim();
    if (!body) return;
    setBusyId(lead.lead_id);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": pw },
        body: JSON.stringify({ lead_id: lead.lead_id, body }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      onChanged(lead, { notes: body, note_count: (lead.note_count ?? 0) + 1 });
      setDraft("");
      setNoteFor(null);
    } catch (e) {
      setFlash({ id: lead.lead_id, text: e instanceof Error ? e.message : "Error" });
    } finally {
      setBusyId(null);
    }
  }

  /** The two or three answers worth seeing without opening anything. */
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
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
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
            className="w-48 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-slate-900"
          />
        </div>
      }
    >
      {leads.length === 0 ? (
        <Empty>{loading ? t.loading : t.noLeads}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/60">
              <tr>
                <Th>{t.colLead}</Th>
                <Th>{t.colSource}</Th>
                <Th>{t.colSubmitted}</Th>
                <Th>{t.colStatus}</Th>
                <Th>{t.colNotes}</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {leads.map((lead) => {
                const stage = STAGE_BY_STATUS[lead.status];
                const busy = busyId === lead.lead_id;
                const composing = noteFor === lead.lead_id;
                return [
                  <tr
                    key={lead.lead_id}
                    className={`transition ${selectedId === lead.lead_id ? "bg-slate-100" : "hover:bg-slate-50/70"} ${
                      busy ? "opacity-60" : ""
                    }`}
                  >
                    <Td>
                      <div className="flex items-center gap-2">
                        {lead.status === "new" && (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
                            title={t.untouchedDot}
                          />
                        )}
                        <span className="font-medium text-slate-900">{lead.full_name || t.unnamed}</span>
                      </div>
                      {lead.phone && (
                        <a
                          href={`https://wa.me/${lead.phone}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs text-emerald-700 hover:underline"
                          dir="ltr"
                        >
                          {lead.phone}
                        </a>
                      )}
                      {preview(lead).map((line) => (
                        <div key={line} className="max-w-xs truncate text-[11px] text-slate-400">
                          {line}
                        </div>
                      ))}
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

                    {/* Stage changes straight from the row — this is the thing
                        that happens all day, so it should never cost a click
                        into a panel. */}
                    <Td>
                      <select
                        value={lead.status}
                        disabled={busy}
                        onChange={(e) => move(lead, e.target.value as Status)}
                        className={`w-full max-w-[11rem] cursor-pointer rounded-lg border px-2 py-1.5 text-xs font-medium outline-none ${stage.color}`}
                        style={{ borderColor: stage.accent }}
                      >
                        {STAGES.map((st) => (
                          <option key={st.status} value={st.status} className="bg-white text-slate-800">
                            {s(st.status)}
                          </option>
                        ))}
                      </select>
                      {flash?.id === lead.lead_id && (
                        <div className="mt-1 max-w-[12rem] text-[11px] leading-tight text-slate-500">{flash.text}</div>
                      )}
                    </Td>

                    <Td>
                      <div className="max-w-[16rem] truncate text-xs text-slate-500">{lead.notes || "—"}</div>
                      <button
                        onClick={() => {
                          setNoteFor(composing ? null : lead.lead_id);
                          setDraft("");
                        }}
                        className="mt-0.5 text-[11px] text-slate-400 underline hover:text-slate-700"
                      >
                        {composing ? t.cancel : t.addNote}
                        {(lead.note_count ?? 0) > 0 ? ` · ${t.notesCount(lead.note_count ?? 0)}` : ""}
                      </button>
                    </Td>

                    <Td align="right">
                      <button
                        onClick={() => onOpen(lead)}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                      >
                        {t.openDetails}
                      </button>
                    </Td>
                  </tr>,

                  composing ? (
                    <tr key={`${lead.lead_id}-note`} className="bg-slate-50/80">
                      <td colSpan={6} className="px-3 py-3">
                        <div className="flex flex-wrap items-start gap-2">
                          <textarea
                            autoFocus
                            rows={2}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote(lead);
                              if (e.key === "Escape") setNoteFor(null);
                            }}
                            placeholder={t.notePlaceholder}
                            className="min-w-[16rem] flex-1 resize-y rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
                          />
                          <button
                            onClick={() => saveNote(lead)}
                            disabled={busy || !draft.trim()}
                            className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
                          >
                            {busy ? t.saving : t.save}
                          </button>
                          <button
                            onClick={() => setNoteFor(null)}
                            className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-white"
                          >
                            {t.cancel}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
