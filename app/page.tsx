"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { STAGES, STAGE_BY_STATUS, QUALIFIED_STATUSES, type Status } from "@/lib/stages";
import CampaignSettings from "@/components/CampaignSettings";

type Lead = {
  lead_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  status: Status;
  notes: string | null;
  owner: string | null;
  deal_value: number | null;
  submitted_at: string;
  campaign_name: string | null;
  adset_name: string | null;
  ad_name: string | null;
  form_name: string | null;
  platform: string | null;
  raw_fields: Record<string, string>;
};

type QualityRow = {
  ad_name: string | null;
  campaign_name: string | null;
  leads: number;
  qualified: number;
  junk: number;
  won: number;
  qualified_pct: number | null;
  junk_pct: number | null;
};

const PW_KEY = "dlleni_pw";

export default function Dashboard() {
  const [pw, setPw] = useState("");
  const [authed, setAuthed] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [quality, setQuality] = useState<QualityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [busyLead, setBusyLead] = useState<string | null>(null);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.sessionStorage.getItem(PW_KEY) : null;
    if (saved) {
      setPw(saved);
      setAuthed(true);
    }
  }, []);

  const load = useCallback(
    async (password = pw) => {
      setLoading(true);
      setMsg(null);
      try {
        const qs = new URLSearchParams({ status: statusFilter, ...(search ? { q: search } : {}) });
        const res = await fetch(`/api/leads?${qs}`, { headers: { "x-app-password": password } });
        if (res.status === 401) {
          setAuthed(false);
          window.sessionStorage.removeItem(PW_KEY);
          setMsg("الباسورد غلط");
          return;
        }
        const json = await res.json();
        setLeads(json.leads || []);
        setQuality(json.quality || []);
        setAuthed(true);
        window.sessionStorage.setItem(PW_KEY, password);
      } catch {
        setMsg("مشكلة في الاتصال");
      } finally {
        setLoading(false);
      }
    },
    [pw, statusFilter, search]
  );

  useEffect(() => {
    if (authed) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, statusFilter]);

  async function setStatus(lead: Lead, status: Status, extra?: { notes?: string; deal_value?: number }) {
    setBusyLead(lead.lead_id);
    setMsg(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": pw },
        body: JSON.stringify({ lead_id: lead.lead_id, status, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");

      setLeads((prev) =>
        prev.map((l) => (l.lead_id === lead.lead_id ? { ...l, status, ...extra } : l))
      );

      const ev = json.event;
      const capiOk = json.capi?.ok ?? json.capi?.skipped != null;
      setMsg(
        ev
          ? capiOk
            ? `✅ اتبعت لميتا: ${ev}`
            : `⚠️ اتسجّل محلياً بس ميتا رفضت: ${json.capi?.error ?? "خطأ"} — هيتعاد تلقائياً`
          : "✅ اتسجّل"
      );
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : "خطأ"}`);
    } finally {
      setBusyLead(null);
    }
  }

  async function runSync(full = false) {
    setLoading(true);
    setMsg("بيسحب الليدز من ميتا…");
    try {
      const res = await fetch(`/api/sync${full ? "?full=1" : ""}`, { headers: { "x-app-password": pw } });
      const json = await res.json();
      setMsg(
        json.ok
          ? `✅ ${json.leadsNew} ليد جديد · ${json.campaignsTracked} كمبين متابَعة من ${json.campaignsTotal}`
          : `❌ ${json.error}`
      );
      await load();
    } finally {
      setLoading(false);
    }
  }

  const stats = useMemo(() => {
    const total = leads.length;
    const qualified = leads.filter((l) => QUALIFIED_STATUSES.includes(l.status)).length;
    const junk = leads.filter((l) => l.status === "junk").length;
    const won = leads.filter((l) => l.status === "won").length;
    const pending = leads.filter((l) => l.status === "new").length;
    return { total, qualified, junk, won, pending };
  }, [leads]);

  if (!authed) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load(pw);
          }}
          className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
        >
          <h1 className="text-xl font-semibold">لوحة ليدز دلني</h1>
          <p className="mt-1 text-sm text-slate-500">ادخل الباسورد للدخول</p>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="mt-5 w-full rounded-xl border border-slate-300 px-4 py-2.5 outline-none focus:border-slate-900"
            placeholder="••••••••"
            autoFocus
          />
          <button className="mt-4 w-full rounded-xl bg-slate-900 py-2.5 font-medium text-white hover:bg-slate-800">
            دخول
          </button>
          {msg && <p className="mt-3 text-center text-sm text-red-600">{msg}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[1400px] p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">لوحة الليدز</h1>
          <p className="text-sm text-slate-500">
            كل تغيير حالة بيرجع لميتا عشان تتعلّم مين الليد الكويس
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => runSync(false)}
            disabled={loading}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? "…" : "اسحب الجديد"}
          </button>
          <button
            onClick={() => runSync(true)}
            disabled={loading}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            سحب كامل
          </button>
        </div>
      </header>

      {msg && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm">{msg}</div>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Tile label="إجمالي" value={stats.total} />
        <Tile label="لسه جديد" value={stats.pending} tone="text-slate-500" />
        <Tile label="مؤهّل" value={stats.qualified} tone="text-emerald-600" />
        <Tile label="زبالة" value={stats.junk} tone="text-red-600" />
        <Tile label="باع" value={stats.won} tone="text-green-700" />
      </section>

      <CampaignSettings pw={pw} />

      <section className="mt-6 flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="all">كل الحالات</option>
          {STAGES.map((s) => (
            <option key={s.status} value={s.status}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="بحث بالاسم أو الرقم…"
          className="w-64 rounded-xl border border-slate-300 px-3 py-2 text-sm"
        />
        <button onClick={() => load()} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
          بحث
        </button>
      </section>

      <section className="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-right text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">الليد</th>
              <th className="px-4 py-3 font-medium">الإعلان</th>
              <th className="px-4 py-3 font-medium">التاريخ</th>
              <th className="px-4 py-3 font-medium">الحالة</th>
              <th className="px-4 py-3 font-medium">تغيير</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {leads.map((lead) => (
              <tr key={lead.lead_id} className={busyLead === lead.lead_id ? "opacity-50" : ""}>
                <td className="px-4 py-3">
                  <div className="font-medium">{lead.full_name || "—"}</div>
                  {lead.phone && (
                    <a href={`https://wa.me/${lead.phone}`} target="_blank" rel="noreferrer"
                       className="ltr block text-xs text-emerald-700 hover:underline">
                      {lead.phone}
                    </a>
                  )}
                  {Object.entries(lead.raw_fields || {})
                    .filter(([k]) => !/name|phone|email|رقم|الاسم/i.test(k))
                    .slice(0, 3)
                    .map(([k, v]) => (
                      <div key={k} className="text-xs text-slate-500">
                        {k}: {v}
                      </div>
                    ))}
                </td>
                <td className="px-4 py-3 text-xs text-slate-600">
                  <div className="font-medium text-slate-800">{lead.ad_name || "—"}</div>
                  <div>{lead.campaign_name || ""}</div>
                  <div className="text-slate-400">{lead.form_name || ""}</div>
                </td>
                <td className="px-4 py-3 text-xs text-slate-600">
                  {new Date(lead.submitted_at).toLocaleString("ar-EG", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-lg border px-2 py-1 text-xs font-medium ${
                      STAGE_BY_STATUS[lead.status]?.color ?? ""
                    }`}
                  >
                    {STAGE_BY_STATUS[lead.status]?.label ?? lead.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {STAGES.filter((s) => s.status !== "new" && s.status !== lead.status).map((s) => (
                      <button
                        key={s.status}
                        disabled={busyLead === lead.lead_id}
                        onClick={() => {
                          if (s.status === "won") {
                            const v = window.prompt("قيمة الصفقة بالجنيه (اختياري)");
                            setStatus(lead, s.status, v ? { deal_value: Number(v) } : undefined);
                          } else {
                            setStatus(lead, s.status);
                          }
                        }}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
                        title={s.event ? `يبعت ${s.event} لميتا` : "مش بيبعت حدث"}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {leads.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-slate-400">
                  مفيش ليدز — اضغط «سحب كامل»
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {quality.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">جودة الليدز حسب الإعلان</h2>
          <p className="text-sm text-slate-500">ده اللي بيقولك أنهي كرييتف بيجيب ناس بتشتري فعلاً</p>
          <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-right text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">الإعلان</th>
                  <th className="px-4 py-3 font-medium">ليدز</th>
                  <th className="px-4 py-3 font-medium">مؤهّل</th>
                  <th className="px-4 py-3 font-medium">% مؤهّل</th>
                  <th className="px-4 py-3 font-medium">% زبالة</th>
                  <th className="px-4 py-3 font-medium">باع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {quality.map((r, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{r.ad_name || "—"}</div>
                      <div className="text-xs text-slate-500">{r.campaign_name || ""}</div>
                    </td>
                    <td className="px-4 py-2.5">{r.leads}</td>
                    <td className="px-4 py-2.5">{r.qualified}</td>
                    <td className="px-4 py-2.5 font-medium text-emerald-700">{r.qualified_pct ?? 0}%</td>
                    <td className="px-4 py-2.5 text-red-600">{r.junk_pct ?? 0}%</td>
                    <td className="px-4 py-2.5">{r.won}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

function Tile({ label, value, tone = "text-slate-900" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-0.5 text-2xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
