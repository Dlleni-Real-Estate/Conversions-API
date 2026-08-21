"use client";

import { useCallback, useEffect, useState } from "react";

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

const REASON: Record<CampaignState["reason"], { label: string; className: string }> = {
  "auto-new": { label: "تلقائي", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  "auto-old": { label: "قبل التاريخ", className: "border-slate-200 bg-slate-50 text-slate-500" },
  "manual-on": { label: "مشغّلة يدوي", className: "border-emerald-300 bg-white text-emerald-700" },
  "manual-off": { label: "مطفّية يدوي", className: "border-red-200 bg-white text-red-600" },
};

/** yyyy-mm-dd for <input type="date"> */
const toDateInput = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export default function CampaignSettings({ pw }: { pw: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cutoff, setCutoff] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignState[]>([]);

  const apply = useCallback((json: { ok?: boolean; error?: string; cutoff?: string; campaigns?: CampaignState[] }) => {
    if (!json.ok) {
      setErr(json.error || "خطأ");
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
      setLoaded(true);
    } catch {
      setErr("مشكلة في الاتصال");
    } finally {
      setBusy(false);
    }
  }, [pw, apply]);

  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

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
      setErr("مشكلة في الاتصال");
    } finally {
      setBusy(false);
    }
  }

  const trackedCount = campaigns.filter((c) => c.tracked).length;

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-4 text-right"
      >
        <span>
          <span className="font-semibold">الكمبينات اللي بنسحب منها</span>
          <span className="mr-2 text-sm text-slate-500">
            {loaded ? `${trackedCount} من ${campaigns.length}` : "اضغط عشان تفتح"}
          </span>
        </span>
        <span className="text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-5 py-4">
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
            <label className="flex flex-wrap items-center gap-2">
              <span className="font-medium">اسحب من أي كمبين اتعملت من تاريخ</span>
              <input
                type="date"
                value={cutoff}
                disabled={busy}
                onChange={(e) => setCutoff(e.target.value)}
                onBlur={(e) => e.target.value && post({ cutoff: e.target.value })}
                className="rounded-lg border border-slate-300 px-3 py-1.5"
              />
              <span className="text-slate-500">وطالع</span>
            </label>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              أي كمبين جديدة تعملها بعد التاريخ ده هتتسحب لوحدها من غير ما تعمل حاجة، وفورمها معاها.
              اللي قبل التاريخ مستبعدة. وتقدر تكسر القاعدة لأي كمبين من الزرار اللي جنبها.
            </p>
          </div>

          {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-right text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">الكمبين</th>
                  <th className="px-3 py-2 font-medium">اتعملت</th>
                  <th className="px-3 py-2 font-medium">الحالة</th>
                  <th className="px-3 py-2 font-medium">بنسحب منها؟</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {campaigns.map((c) => {
                  const r = REASON[c.reason];
                  const manual = c.reason.startsWith("manual");
                  return (
                    <tr key={c.id} className={c.tracked ? "" : "text-slate-400"}>
                      <td className="px-3 py-2.5">
                        <div className={c.tracked ? "font-medium text-slate-900" : ""}>{c.name}</div>
                        <div className="ltr text-xs text-slate-400">{c.id}</div>
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {new Date(c.created_time).toLocaleDateString("ar-EG", { dateStyle: "medium" })}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {c.effective_status === "ACTIVE" ? (
                          <span className="text-emerald-700">شغّالة</span>
                        ) : (
                          <span className="text-slate-400">{c.effective_status || "—"}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            disabled={busy}
                            onClick={() =>
                              post({
                                campaign_id: c.id,
                                enabled: !c.tracked,
                                name: c.name,
                                created_time: c.created_time,
                              })
                            }
                            className={`rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                              c.tracked
                                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                                : "border-slate-300 bg-white text-slate-600"
                            }`}
                          >
                            {c.tracked ? "أيوه" : "لأ"}
                          </button>
                          <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${r.className}`}>
                            {r.label}
                          </span>
                          {manual && (
                            <button
                              disabled={busy}
                              onClick={() => post({ campaign_id: c.id, enabled: null })}
                              className="text-[11px] text-slate-400 underline hover:text-slate-600 disabled:opacity-40"
                            >
                              رجّعها للتلقائي
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {campaigns.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                      {busy ? "بيحمّل…" : "مفيش كمبينات"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
