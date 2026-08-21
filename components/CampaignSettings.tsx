"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Empty, Td, Th } from "./ui";
import { useLang } from "./LangProvider";

export type CampaignState = {
  id: string;
  name: string;
  created_time: string;
  status?: string;
  effective_status?: string;
  objective?: string;
  tracked: boolean;
  reason: "manual-on" | "manual-off" | "auto-new" | "auto-old";
};

const REASON: Record<CampaignState["reason"], { tk: "rAuto" | "rBefore" | "rPinnedOn" | "rPinnedOff"; className: string }> = {
  "auto-new": { tk: "rAuto", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  "auto-old": { tk: "rBefore", className: "border-slate-200 bg-slate-50 text-slate-500" },
  "manual-on": { tk: "rPinnedOn", className: "border-emerald-300 bg-white text-emerald-700" },
  "manual-off": { tk: "rPinnedOff", className: "border-red-200 bg-white text-red-600" },
};

const toDateInput = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export default function CampaignSettings({ pw }: { pw: string }) {
  const { t, locale } = useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cutoff, setCutoff] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignState[]>([]);

  const apply = useCallback((json: { ok?: boolean; error?: string; cutoff?: string; campaigns?: CampaignState[] }) => {
    if (!json.ok) {
      setErr(json.error || "Error");
      return;
    }
    setErr(null);
    if (json.cutoff) setCutoff(toDateInput(json.cutoff));
    setCampaigns(json.campaigns || []);
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns", { headers: { "x-app-password": pw } });
      apply(await res.json());
    } catch {
      setErr(t.connectionError);
    } finally {
      setBusy(false);
    }
  }, [pw, apply]);

  useEffect(() => {
    load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": pw },
        body: JSON.stringify(body),
      });
      apply(await res.json());
    } catch {
      setErr(t.connectionError);
    } finally {
      setBusy(false);
    }
  }

  const trackedCount = campaigns.filter((c) => c.tracked).length;

  return (
    <Card
      title={t.trackedCampaigns}
      subtitle={t.trackedSub(trackedCount, campaigns.length)}
      right={
        <button
          onClick={load}
          disabled={busy}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
        >
          {busy ? "…" : t.refresh}
        </button>
      }
    >
      <div className="border-b border-slate-100 px-5 py-4">
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-800">{t.cutoffLabel}</span>
          <input
            type="date"
            value={cutoff}
            disabled={busy}
            onChange={(e) => setCutoff(e.target.value)}
            onBlur={(e) => e.target.value && post({ cutoff: e.target.value })}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-500">
{t.cutoffHelp}
        </p>
      </div>

      {err && <p className="px-5 pt-3 text-sm text-red-600">{err}</p>}

      {campaigns.length === 0 ? (
        <Empty>{busy ? t.loading : t.noCampaigns}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-100">
              <tr>
                <Th>{t.colCampaign}</Th>
                <Th>{t.colCreated}</Th>
                <Th>{t.colDelivery}</Th>
                <Th>{t.colTracked}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {campaigns.map((c) => {
                const r = REASON[c.reason];
                const pinned = c.reason.startsWith("manual");
                return (
                  <tr key={c.id} className={c.tracked ? "" : "text-slate-400"}>
                    <Td>
                      <div className={c.tracked ? "font-medium text-slate-900" : ""}>{c.name}</div>
                      <div className="text-[11px] text-slate-400">{c.id}</div>
                    </Td>
                    <Td>
                      <span className="text-xs">
                        {new Date(c.created_time).toLocaleDateString(locale, { dateStyle: "medium", numberingSystem: "latn" })}
                      </span>
                    </Td>
                    <Td>
                      <span className={`text-xs ${c.effective_status === "ACTIVE" ? "text-emerald-700" : "text-slate-400"}`}>
                        {c.effective_status === "ACTIVE" ? t.active : (c.effective_status || "—").toLowerCase()}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          disabled={busy}
                          onClick={() =>
                            post({ campaign_id: c.id, enabled: !c.tracked, name: c.name, created_time: c.created_time })
                          }
                          className={`rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                            c.tracked
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                              : "border-slate-300 bg-white text-slate-600"
                          }`}
                        >
                          {c.tracked ? t.on : t.off}
                        </button>
                        <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${r.className}`}>{t[r.tk]}</span>
                        {pinned && (
                          <button
                            disabled={busy}
                            onClick={() => post({ campaign_id: c.id, enabled: null })}
                            className="text-[11px] text-slate-400 underline hover:text-slate-600 disabled:opacity-40"
                          >
                            {t.unpin}
                          </button>
                        )}
                      </div>
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
