"use client";

import { useCallback, useEffect, useState } from "react";
import LeadsView from "@/components/LeadsView";
import LeadPanel from "@/components/LeadPanel";
import AnalyticsView from "@/components/AnalyticsView";
import CampaignSettings from "@/components/CampaignSettings";
import { LangProvider, LangSwitch, useLang } from "@/components/LangProvider";
import type { FormDictionary } from "@/lib/labels";
import type { Analytics, Lead } from "@/components/types";

const PW_KEY = "dlleni_pw";
const TABS = [
  { id: "pipeline", tk: "tabPipeline" },
  { id: "analytics", tk: "tabAnalytics" },
  { id: "settings", tk: "tabSettings" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default function Page() {
  // The provider owns dir/lang on <html>, so it has to sit above everything.
  return (
    <LangProvider>
      <Dashboard />
    </LangProvider>
  );
}

function Dashboard() {
  const { t, locale } = useLang();
  const [pw, setPw] = useState("");
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("pipeline");

  const [leads, setLeads] = useState<Lead[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [dictionary, setDictionary] = useState<FormDictionary | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("all");
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

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
      setErr(null);
      try {
        const leadQs = new URLSearchParams({ status: statusFilter, campaign: scope, ...(search ? { q: search } : {}) });
        const analyticsQs = new URLSearchParams({ campaign: scope });

        const [leadRes, statsRes] = await Promise.all([
          fetch(`/api/leads?${leadQs}`, { headers: { "x-app-password": password } }),
          fetch(`/api/analytics?${analyticsQs}`, { headers: { "x-app-password": password } }),
        ]);

        if (leadRes.status === 401) {
          setAuthed(false);
          window.sessionStorage.removeItem(PW_KEY);
          setErr(t.wrongPassword);
          return;
        }

        const leadJson = await leadRes.json();
        const statsJson = await statsRes.json();

        setLeads(leadJson.leads || []);
        if (leadJson.dictionary) setDictionary(leadJson.dictionary);
        if (statsJson.ok) setAnalytics(statsJson);
        setAuthed(true);
        setLastLoaded(new Date());
        window.sessionStorage.setItem(PW_KEY, password);
      } catch {
        setErr(t.connectionError);
      } finally {
        setLoading(false);
      }
    },
    [pw, statusFilter, search, scope]
  );

  useEffect(() => {
    if (authed) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, statusFilter, scope]);

  /** Patch a lead in place so the table updates without a full reload. */
  const onChanged = useCallback((lead: Lead, patch: Partial<Lead>) => {
    setLeads((prev) => prev.map((l) => (l.lead_id === lead.lead_id ? { ...l, ...patch } : l)));
    setSelected((s) => (s && s.lead_id === lead.lead_id ? { ...s, ...patch } : s));
  }, []);

  if (!authed) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load(pw);
          }}
          className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-panel"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{t.appTitle}</h1>
              <p className="mt-1 text-sm text-slate-500">{t.signInSub}</p>
            </div>
            <LangSwitch />
          </div>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="mt-5 w-full rounded-xl border border-slate-300 px-4 py-2.5 outline-none focus:border-slate-900"
            placeholder={t.password}
            autoFocus
          />
          <button className="mt-4 w-full rounded-xl bg-slate-900 py-2.5 text-sm font-medium text-white hover:bg-slate-800">
            {t.signIn}
          </button>
          {err && <p className="mt-3 text-center text-sm text-red-600">{err}</p>}
        </form>
      </main>
    );
  }

  const campaignOptions = analytics?.campaigns ?? [];

  return (
    <div className="min-h-screen">
      {/* A real chrome bar. Without it the page is one uninterrupted sheet of
          white and nothing tells you where the app ends and the data begins. */}
      <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 shadow-card backdrop-blur">
        <div className="mx-auto max-w-[1600px] px-6 pt-4">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{t.appTitle}</h1>
              <p className="mt-0.5 max-w-2xl text-xs text-slate-500">{t.appTagline}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <LangSwitch />
              {campaignOptions.length > 1 && (
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs shadow-card"
                >
                  <option value="all">{t.allCampaigns}</option>
                  {campaignOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => load()}
                disabled={loading}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium shadow-card hover:bg-slate-50 disabled:opacity-40"
                title={t.refreshHint}
              >
                {loading ? t.refreshing : t.refresh}
              </button>
            </div>
          </header>

          <nav className="mt-3 flex items-center gap-1">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                  tab === tb.id
                    ? "border-slate-900 text-slate-900"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {t[tb.tk]}
              </button>
            ))}
            <span className="ms-auto pb-2 text-[11px] text-slate-400">
              {lastLoaded
                ? `${t.updated} ${lastLoaded.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", numberingSystem: "latn" })}`
                : ""}
            </span>
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        {err && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{err}</div>
        )}

        <div>
        {tab === "pipeline" && (
          <LeadsView
            leads={leads}
            dictionary={dictionary}
            pw={pw}
            onChanged={onChanged}
            loading={loading}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            search={search}
            onSearch={setSearch}
            onOpen={setSelected}
            selectedId={selected?.lead_id ?? null}
          />
        )}

        {tab === "analytics" &&
          (analytics ? (
            <AnalyticsView data={analytics} />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white px-5 py-14 text-center text-sm text-slate-400">
              {loading ? t.loading : t.noData}
            </div>
          ))}

        {tab === "settings" && <CampaignSettings pw={pw} />}
        </div>

        {selected && (
          <LeadPanel
            lead={selected}
            dictionary={dictionary}
            pw={pw}
            onClose={() => setSelected(null)}
            onChanged={onChanged}
          />
        )}
      </main>
    </div>
  );
}
