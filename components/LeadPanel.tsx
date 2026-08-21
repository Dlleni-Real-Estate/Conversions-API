"use client";

import { useCallback, useEffect, useState } from "react";
import { STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { Badge, fmtAgo, fmtDate } from "./ui";
import type { Lead } from "./types";

type Note = {
  id: string;
  kind: "note" | "stage";
  body: string | null;
  from_status: Status | null;
  to_status: Status | null;
  author: string | null;
  created_at: string;
};

/**
 * Everything about one lead in one place: who they are, what they answered on
 * the form, where they are in the pipeline, and the full history of what the
 * team did — notes and stage moves in the same stream.
 */
export default function LeadPanel({
  lead,
  pw,
  onClose,
  onChanged,
}: {
  lead: Lead;
  pw: string;
  onClose: () => void;
  onChanged: (lead: Lead, patch: Partial<Lead>) => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadNotes = useCallback(async () => {
    const res = await fetch(`/api/notes?lead_id=${lead.lead_id}`, { headers: { "x-app-password": pw } });
    const json = await res.json();
    setNotes(json.notes || []);
  }, [lead.lead_id, pw]);

  useEffect(() => {
    setNotes([]);
    setDraft("");
    setMsg(null);
    loadNotes();
  }, [lead.lead_id, loadNotes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function move(status: Status) {
    if (status === lead.status) return;
    setBusy(true);
    setMsg(null);
    try {
      const stage = STAGE_BY_STATUS[status];
      const payload: Record<string, unknown> = { lead_id: lead.lead_id, status };

      if (status === "reservation") {
        const v = window.prompt("Reservation value (optional, EGP)");
        if (v && Number(v)) payload.deal_value = Number(v);
      }
      // A note typed but not yet saved rides along with the stage change, so
      // the reason and the move land on the timeline together.
      if (draft.trim()) payload.note = draft.trim();

      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": pw },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");

      setDraft("");
      onChanged(lead, { status, deal_value: (payload.deal_value as number) ?? lead.deal_value });
      await loadNotes();

      setMsg(
        !stage.event
          ? "Saved"
          : json.capi?.ok
            ? `Saved · sent "${stage.event}" to Meta`
            : `Saved locally · Meta rejected it (${json.capi?.error ?? "error"}) — it will retry automatically`
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": pw },
        body: JSON.stringify({ lead_id: lead.lead_id, body }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      setDraft("");
      onChanged(lead, { notes: body, note_count: (lead.note_count ?? 0) + 1 });
      await loadNotes();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  const stage = STAGE_BY_STATUS[lead.status];
  const answers = Object.entries(lead.raw_fields || {});

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/20" onClick={onClose} />

      <aside className="relative z-10 flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-slate-200 bg-white shadow-xl">
        <header className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-6 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{lead.full_name || "Unnamed lead"}</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {fmtDate(lead.submitted_at)} · {fmtAgo(lead.submitted_at)}
              </p>
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close">
              ✕
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge className={stage.color}>{stage.label}</Badge>
            {lead.phone && (
              <a
                href={`https://wa.me/${lead.phone}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
              >
                WhatsApp {lead.phone}
              </a>
            )}
            {lead.phone && (
              <a
                href={`tel:+${lead.phone}`}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Call
              </a>
            )}
          </div>
        </header>

        <div className="space-y-6 px-6 py-5">
          {/* Stage picker */}
          <div>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Move to</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STAGES.filter((s) => s.status !== "new").map((s) => (
                <button
                  key={s.status}
                  disabled={busy || s.status === lead.status}
                  onClick={() => move(s.status)}
                  title={s.event ? `Sends "${s.event}" to Meta` : "Stays internal"}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                    s.status === lead.status ? s.color : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {msg && <p className="mt-2 text-xs text-slate-600">{msg}</p>}
          </div>

          {/* Note composer — doubles as the reason for the next stage move */}
          <div>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Add a note</h3>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              placeholder="What happened on the call?"
              className="mt-2 w-full resize-y rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={addNote}
                disabled={busy || !draft.trim()}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
              >
                Save note
              </button>
              <span className="text-xs text-slate-400">
                Or pick a stage above and this note is attached to the move.
              </span>
            </div>
          </div>

          {/* Form answers */}
          {answers.length > 0 && (
            <div>
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Form answers</h3>
              <dl className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {answers.map(([k, v]) => (
                  <div key={k} className="flex gap-4 px-3 py-2 text-sm">
                    <dt className="w-2/5 shrink-0 text-slate-500">{k.replace(/_/g, " ")}</dt>
                    <dd className="font-medium text-slate-800">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Source */}
          <div>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Source</h3>
            <dl className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
              {[
                ["Ad", lead.ad_name],
                ["Ad set", lead.adset_name],
                ["Campaign", lead.campaign_name],
                ["Form", lead.form_name],
                ["Platform", lead.platform],
              ].map(([k, v]) => (
                <div key={k as string} className="flex gap-4 px-3 py-2">
                  <dt className="w-2/5 shrink-0 text-slate-500">{k}</dt>
                  <dd className="text-slate-800">{v || "—"}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Timeline */}
          <div>
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">History</h3>
            {notes.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">Nothing logged yet.</p>
            ) : (
              <ol className="mt-3 space-y-3 border-l border-slate-200 pl-4">
                {notes.map((n) => (
                  <li key={n.id} className="relative">
                    <span
                      className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-2 ring-white"
                      style={{
                        background:
                          n.kind === "stage" && n.to_status ? STAGE_BY_STATUS[n.to_status].accent : "#cbd5e1",
                      }}
                    />
                    <div className="text-xs text-slate-400">{fmtDate(n.created_at)}</div>
                    {n.kind === "stage" && n.to_status && (
                      <div className="mt-0.5 text-sm">
                        <span className="text-slate-500">
                          {n.from_status ? STAGE_BY_STATUS[n.from_status].label : "New"} →{" "}
                        </span>
                        <span className="font-medium">{STAGE_BY_STATUS[n.to_status].label}</span>
                      </div>
                    )}
                    {n.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{n.body}</p>}
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
