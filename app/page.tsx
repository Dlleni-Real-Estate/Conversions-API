"use client";

import { useCallback, useEffect, useState } from "react";
import LeadsView from "@/components/LeadsView";
import LeadPanel from "@/components/LeadPanel";
import AnalyticsView from "@/components/AnalyticsView";
import CampaignSettings from "@/components/CampaignSettings";
import HealthPanel from "@/components/HealthPanel";
import AdAccounts from "@/components/AdAccounts";
import AuditPanel from "@/components/AuditPanel";
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

  // Search reloads on its own, debounced. It used to sit outside the effect's
  // dependency list entirely, which is why typing in the box did nothing until
  // some other control happened to change — the classic silent way for a
  // search to be "broken" while every piece of it works.
  useEffect(() => {
    if (!authed) return;
    const id = setTimeout(() => load(), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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
  // Leads nobody has called yet. Surfaced on the tab so it is visible from any
  // screen — a queue you cannot see is a queue nobody works.
  const untouched = leads.filter((l) => l.status === "new").length;

  return (
    <div className="min-h-screen">
      {/* A real chrome bar. Without it the page is one uninterrupted sheet of
          white and nothing tells you where the app ends and the data begins. */}
      <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 shadow-card backdrop-blur">
        <span className="block h-1 bg-gradient-to-r from-brand-600 via-brand-500 to-emerald-500" aria-hidden />
        <div className="mx-auto max-w-[1600px] px-4 pt-3 sm:px-6 sm:pt-4">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-base font-semibold tracking-tight sm:text-lg">{t.appTitle}</h1>
              <p className="mt-0.5 hidden max-w-2xl text-xs text-slate-500 sm:block">{t.appTagline}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <LangSwitch />
              {campaignOptions.length > 1 && (
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  className="tap max-w-[10rem] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs shadow-card sm:max-w-none"
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
                className="tap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium shadow-card hover:bg-slate-50 disabled:opacity-40"
                title={t.refreshHint}
              >
                {loading ? t.refreshing : t.refresh}
              </button>
            </div>
          </header>

          <nav className="mt-2 flex items-center gap-1 overflow-x-auto sm:mt-3">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`tap -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition ${
                  tab === tb.id
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {t[tb.tk]}
                {tb.id === "pipeline" && untouched > 0 && (
                  <span className="rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                    {untouched}
                  </span>
                )}
              </button>
            ))}
            <span className="ms-auto hidden shrink-0 pb-2 text-[11px] text-slate-400 sm:block">
              {lastLoaded
                ? `${t.updated} ${lastLoaded.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", numberingSystem: "latn" })}`
                : ""}
            </span>
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 sm:py-6">
        {err && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{err}</div>
        )}

        <div>
        {tab === "pipeline" && (
          <LeadsView
            leads={leads}
            dictionary={dictionary}
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
            <AnalyticsView data={analytics} onSelectCampaign={(id) => setScope(id)} />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white px-5 py-14 text-center text-sm text-slate-400">
              {loading ? t.loading : t.noData}
            </div>
          ))}

        {/* Kept mounted, only hidden. Unmounting on every tab switch threw
            away all three components' state, so coming back meant a full
            reload each time - health, accounts, datasets, pages, campaigns,
            five Meta round-trips to redraw a screen that had just been open.
            Hidden, it keeps its state and reappears instantly; each component
            still refreshes itself on its own terms. */}
        <div hidden={tab !== "settings"} className="space-y-6">
          <HealthPanel pw={pw} />
          <AdAccounts pw={pw} />
          <CampaignSettings pw={pw} />
          <AuditPanel pw={pw} />
        </div>
        </div>

        {selected && (
          <LeadPanel
            lead={selected}
            dictionary={dictionary}
            pw={pw}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
    </div>
  );
}
