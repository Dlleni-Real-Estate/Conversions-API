"use client";

import { useEffect, useState } from "react";
import { Card, SectionTitle } from "./ui";
import { useLang } from "./LangProvider";

type Health = {
  ok: boolean;
  sender: "app" | "crm";
  crmConfigured: boolean;
  dualSenderRisk: boolean;
  leads: number;
  lastSync: {
    started_at: string;
    finished_at: string | null;
    ok: boolean | null;
    error: string | null;
    leads_found: number | null;
    leads_new: number | null;
  } | null;
  capi7d: { sent: number; failed: number; pending: number; lastError: string | null; lastErrorAt: string | null };
  crm: {
    at?: string;
    scanned?: number;
    total?: number;
    matched?: number;
    changed?: number;
    owners?: number;
    notes?: number;
    coverage?: string;
    unmappedStatusIds?: string[];
  } | null;
};

/**
 * Four cards that answer "is the machine actually running" without opening
 * Vercel, Supabase and 8X. Numbers only — every judgement call (what is
 * failing, what to do about it) belongs to the person reading them.
 */
export default function HealthPanel({ pw }: { pw: string }) {
  const { t, locale } = useLang();
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/health", { headers: { "x-app-password": pw } })
      .then((r) => r.json())
      .then((j) => alive && (j.ok ? setH(j) : setErr(true)))
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [pw]);

  const when = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—";

  if (err) return <p className="text-xs text-red-600">{t.hLoadFail}</p>;
  if (!h) return null;

  const capiBad = h.capi7d.failed > 0;

  return (
    <section>
      <SectionTitle title={t.healthTitle} subtitle={t.healthSub} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">{t.hSender}</p>
          <p className="mt-1 text-lg font-semibold">
            {h.sender === "app" ? t.hSenderApp : t.hSenderCrm}
          </p>
          {h.dualSenderRisk && (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800">
              {t.hDualWarn}
            </p>
          )}
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">{t.hLastSync}</p>
          {h.lastSync ? (
            <>
              <p className="mt-1 text-lg font-semibold">
                {h.lastSync.ok === false ? (
                  <span className="text-red-600">✗</span>
                ) : (
                  <span className="text-emerald-600">✓</span>
                )}{" "}
                <span className="text-sm font-normal text-slate-600">{when(h.lastSync.started_at)}</span>
              </p>
              {h.lastSync.error && <p className="mt-1 break-words text-[11px] text-red-600">{h.lastSync.error}</p>}
            </>
          ) : (
            <p className="mt-1 text-sm text-slate-500">{t.hNoRuns}</p>
          )}
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">{t.hCrmMirror}</p>
          {h.crm && h.crm.at ? (
            <>
              <p className="mt-1 text-lg font-semibold">
                {h.crm.matched ?? 0} <span className="text-sm font-normal text-slate-500">{t.hMatched}</span>
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                {h.crm.coverage ?? "—"} {t.hCoverage} · {h.crm.changed ?? 0} {t.hMoved} · {h.crm.owners ?? 0}{" "}
                {t.hOwners} · {h.crm.notes ?? 0} {t.hNotes}
              </p>
              {(h.crm.unmappedStatusIds?.length ?? 0) > 0 && (
                <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                  {t.hUnmapped}: {h.crm.unmappedStatusIds?.join(", ")}
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-sm text-slate-500">{t.hNoCrm}</p>
          )}
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">{t.hCapi}</p>
          <p className="mt-1 text-lg font-semibold">
            <span className="text-emerald-600">{h.capi7d.sent}</span>{" "}
            <span className="text-sm font-normal text-slate-500">{t.hSent}</span>
            {capiBad && (
              <>
                {" · "}
                <span className="text-red-600">{h.capi7d.failed}</span>{" "}
                <span className="text-sm font-normal text-slate-500">{t.hFailed}</span>
              </>
            )}
          </p>
          {h.capi7d.pending > 0 && (
            <p className="mt-1 text-[11px] text-slate-500">{h.capi7d.pending} {t.hPending}</p>
          )}
          {capiBad && h.capi7d.lastError && (
            <p className="mt-1 break-words text-[11px] text-red-600">{h.capi7d.lastError}</p>
          )}
        </Card>
      </div>
    </section>
  );
}
