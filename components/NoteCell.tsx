"use client";

import { useEffect, useRef, useState } from "react";
import { useLang } from "./LangProvider";

/**
 * Notes, written from the row.
 *
 * Empty looks like an invitation — a dashed box saying "write here" — not like
 * a disabled field. Type in it and it saves itself when you click away or press
 * ⌘/Ctrl+Enter; there is no Save button to forget. Once a note exists the box
 * goes solid and a + appears next to it for the next one, so the first note is
 * one click and every note after it is one click too.
 */
export default function NoteCell({
  leadId,
  lastNote,
  count,
  pw,
  onSaved,
}: {
  leadId: string;
  lastNote: string | null;
  count: number;
  pw: string;
  onSaved: (body: string) => void;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const ref = useRef<HTMLTextAreaElement>(null);
  const savedRef = useRef(false);

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  useEffect(() => {
    if (state !== "saved") return;
    const id = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(id);
  }, [state]);

  async function save() {
    const body = draft.trim();
    // Guard against blur and ⌘+Enter both firing for the same text.
    if (!body || savedRef.current) return;
    savedRef.current = true;
    setState("saving");
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": pw },
        body: JSON.stringify({ lead_id: leadId, body }),
      });
      if (!res.ok) throw new Error("failed");
      onSaved(body);
      setDraft("");
      setOpen(false);
      setState("saved");
    } catch {
      setState("error");
    } finally {
      savedRef.current = false;
    }
  }

  if (open) {
    return (
      <div onClick={(e) => e.stopPropagation()} className="min-w-[15rem]">
        <textarea
          ref={ref}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") {
              setDraft("");
              setOpen(false);
            }
          }}
          placeholder={t.notePlaceholder}
          className="w-full resize-y rounded-lg border border-slate-400 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-slate-900"
        />
        <div className="mt-0.5 text-[10px] text-slate-400">
          {state === "saving" ? t.saving : t.autosaveHint}
        </div>
      </div>
    );
  }

  // Nothing written yet: a dashed box that says "write here".
  if (!lastNote) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="note-empty min-h-[2.25rem] w-full min-w-[13rem] rounded-lg border px-2.5 py-1.5 text-start text-xs text-slate-400 transition"
      >
        {state === "saved" ? `✓ ${t.saved}` : t.notePlaceholder}
      </button>
    );
  }

  // Has notes: solid box, plus a + for the next one.
  return (
    <div className="flex min-w-[13rem] items-stretch gap-1.5">
      <div className="note-filled min-w-0 flex-1 rounded-lg border px-2.5 py-1.5">
        <div className="line-clamp-2 text-xs text-slate-700">{lastNote}</div>
        {count > 1 && <div className="mt-0.5 text-[10px] text-slate-400">{t.notesCount(count)}</div>}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={t.addNote}
        aria-label={t.addNote}
        className="shrink-0 rounded-lg border border-slate-300 bg-white px-2 text-base leading-none text-slate-500 transition hover:border-slate-500 hover:text-slate-900"
      >
        +
      </button>
    </div>
  );
}
