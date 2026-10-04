"use client";

import { useCallback, useEffect, useState } from "react";
import { STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { answerLabel, questionLabel, type FormDictionary } from "@/lib/labels";
import { Badge, fmtAgo, fmtDate } from "./ui";
import { useLang } from "./LangProvider";
import type { Lead } from "./types";

type Note = {
  id: string;
  kind: "note" | "stage" | "call" | "assign";
  body: string | null;
  from_status: Status | null;
  to_status: Status | null;
  author: string | null;
  created_at: string;
};

/**
 * Everything about one lead in one place: who they are, what they answered on
 * the form — in the exact words the form asked them — where they are in the
 * pipeline, and the full history of what the team did.
 *
 * Read-only. The stage and the notes are written in 8X CRM, which is where the
 * sales team already works; this panel reports them rather than competing for
 * them.
 */
export default function LeadPanel({
  lead,
  dictionary,
  pw,
  onClose,
  onChanged,
}: {
  lead: Lead;
  dictionary: FormDictionary | null;
  pw: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t, s, sHint, lang, locale } = useLang();
  const [notes, setNotes] = useState<Note[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [assignErr, setAssignErr] = useState<string | null>(null);

  // The agent list, for moving this lead by hand. Read once per opened lead;
  // no agents at all means the section has nothing to offer and stays hidden.
  useEffect(() => {
    fetch("/api/admin/agents", { headers: { "x-app-password": pw } })
      .then((r) => r.json())
      .then((j) => setAgents((j.agents || []).filter((a: { active: boolean }) => a.active)))
      .catch(() => setAgents([]));
  }, [pw]);

  const assign = async (agentId: string | null) => {
    setAssignErr(null);
    const res = await fetch("/api/admin/assign", {
      method: "POST",
      headers: { "x-app-password": pw, "content-type": "application/json" },
      body: JSON.stringify({ lead_id: lead.lead_id, agent_id: agentId }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) setAssignErr(String(j.error || res.status));
    else {
      onChanged?.();
      onClose();
    }
  };

  const minutes = (a?: string | null, b?: string | null) =>
    a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000)) : null;

  const loadNotes = useCallback(async () => {
    const res = await fetch(`/api/notes?lead_id=${lead.lead_id}`, { headers: { "x-app-password": pw } });
    const json = await res.json();
    setNotes(json.notes || []);
  }, [lead.lead_id, pw]);

  useEffect(() => {
    setNotes([]);
    loadNotes();
  }, [lead.lead_id, loadNotes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stage = STAGE_BY_STATUS[lead.status];
  const answers = Object.entries(lead.raw_fields || {});

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={onClose} />

      <aside className="relative z-10 flex h-full w-full flex-col overflow-y-auto bg-white shadow-panel md:max-w-xl md:border-s md:border-slate-200">
        <header className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-6 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 dir="auto" className="text-lg font-semibold">{lead.full_name || t.unnamed}</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {fmtDate(lead.submitted_at, locale)} · {fmtAgo(lead.submitted_at, lang)}
              </p>
            </div>
            <button onClick={onClose} className="tap -me-1.5 rounded-lg px-2.5 text-lg text-slate-400 hover:bg-slate-100" aria-label={t.close}>
              ✕
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {lead.phone && (
              <>
                <a
                  href={`https://wa.me/${lead.phone}`}
                  target="_blank"
                  rel="noreferrer"
                  className="tap flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                >
                  <span>{t.whatsapp}</span>
                  <span dir="ltr" className="tabular-nums">+{lead.phone}</span>
                </a>
                <a
                  href={`tel:+${lead.phone}`}
                  className="tap flex items-center rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  {t.call}
                </a>
              </>
            )}
          </div>
        </header>

        <div className="space-y-6 px-6 py-5">
          <div>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{t.stage}</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge className={stage.color}>{s(lead.status)}</Badge>
              <span className="text-xs text-slate-400">{t.stageFromCrm}</span>
            </div>
            {lead.owner && (
              <p dir="auto" className="mt-1.5 text-xs text-slate-600">
                <span className="text-slate-400">{t.agent}:</span> <span className="font-medium">{lead.owner}</span>
              </p>
            )}
            {sHint(lead.status) && <p className="mt-2 text-xs text-slate-400">{sHint(lead.status)}</p>}
          </div>

          {/* The agent app's side of this lead: who holds it, how fast they
              called, and a way to move it by hand. */}
          {(lead.agent_id || agents.length > 0) && (
            <div className="rounded-xl border border-brand-200 bg-brand-50/50 px-3 py-3">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-brand-700">{t.appTitle2}</h3>
              {lead.agent_id && (
                <p className="mt-1.5 text-sm text-slate-700">
                  <span className="font-semibold" dir="auto">{agents.find((a) => a.id === lead.agent_id)?.name || lead.owner || "—"}</span>
                  {lead.assigned_at && (
                    <span className="text-slate-500"> · {t.assignedAgo} {fmtAgo(lead.assigned_at, lang)}</span>
                  )}
                  <span className="text-slate-500">
                    {" · "}
                    {lead.first_call_at
                      ? `${t.calledAfter} ${minutes(lead.assigned_at, lead.first_call_at)}m`
                      : t.notCalledYet}
                  </span>
                  {lead.follow_up_at && (
                    <span className="text-slate-500"> · {t.followUpAt}: {fmtDate(lead.follow_up_at, locale)}</span>
                  )}
                </p>
              )}
              {agents.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    value=""
                    onChange={(e) => e.target.value && assign(e.target.value)}
                    className="tap rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  >
                    <option value="">{t.reassignTo}</option>
                    {agents
                      .filter((a) => a.id !== lead.agent_id)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                  {lead.agent_id && (
                    <button onClick={() => assign(null)} className="tap rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-600">
                      {t.unassign}
                    </button>
                  )}
                </div>
              )}
              {assignErr && <p className="mt-1.5 text-xs text-red-600">{assignErr}</p>}
            </div>
          )}

          {/* The form, in the words the customer actually read. Meta hands back
              machine keys; these come from the form definition, untranslated. */}
          {answers.length > 0 && (
            <div>
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{t.formAnswers}</h3>
              <dl className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-slate-50/60">
                {answers.map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:gap-4">
                    <dt className="text-xs text-slate-500 sm:w-2/5 sm:shrink-0 sm:text-sm">{questionLabel(dictionary, k)}</dt>
                    <dd dir="auto" className="font-medium text-slate-800">{answerLabel(dictionary, k, v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{t.source}</h3>
            <dl className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-slate-50/60 text-sm">
              {[
                [t.ad, lead.ad_name],
                [t.adset, lead.adset_name],
                [t.campaign, lead.campaign_name],
                [t.form, lead.form_name],
                [t.platform, lead.platform],
              ].map(([k, v]) => (
                <div key={k as string} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
                  <dt className="text-xs text-slate-500 sm:w-2/5 sm:shrink-0 sm:text-sm">{k}</dt>
                  <dd dir="auto" className="text-slate-800">{v || "—"}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{t.history}</h3>
            {notes.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">{t.nothingLogged}</p>
            ) : (
              <ol className="mt-3 space-y-3 border-s border-slate-200 ps-4">
                {notes.map((n) => (
                  <li key={n.id} className="relative">
                    <span
                      className="absolute top-1.5 h-2 w-2 rounded-full ring-2 ring-white"
                      style={{
                        insetInlineStart: "-21px",
                        background: n.kind === "stage" && n.to_status ? STAGE_BY_STATUS[n.to_status].accent : "#cbd5e1",
                      }}
                    />
                    <div className="text-xs text-slate-400">{fmtDate(n.created_at, locale)}</div>
                    {n.kind === "stage" && n.to_status && (
                      <div className="mt-0.5 text-sm">
                        <span className="text-slate-500">{n.from_status ? s(n.from_status) : s("new")} → </span>
                        <span className="font-medium">{s(n.to_status)}</span>
                      </div>
                    )}
                    {n.kind === "call" && (
                      <div className="mt-0.5 text-sm text-slate-700">
                        {n.body === "whatsapp" ? `💬 ${t.whatsapp}` : `📞 ${t.call}`}
                        {n.author && <span dir="auto" className="text-slate-500"> · {n.author}</span>}
                      </div>
                    )}
                    {n.kind === "assign" && (
                      <div className="mt-0.5 text-sm text-slate-700">
                        → <span dir="auto" className="font-medium">{n.body || "—"}</span>
                        <span className="text-slate-400"> · {n.author}</span>
                      </div>
                    )}
                    {n.body && (n.kind === "note" || n.kind === "stage") && (
                      <p dir="auto" className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{n.body}</p>
                    )}
                    {n.author && (n.kind === "note" || n.kind === "stage") && (
                      <p dir="auto" className="text-[11px] text-slate-400">{n.author}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
