"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, fmtAgo, fmtDate } from "./ui";
import { useLang } from "./LangProvider";
import type { AgentRow, CampaignOption, RoutingRuleRow } from "./types";
import AgentReport from "./AgentReport";

/**
 * Where the latest agent app lives. GitHub serves the newest release's file
 * under this fixed path, so the link never needs updating after a build.
 */
export const APK_URL =
  process.env.NEXT_PUBLIC_AGENT_APK_URL ||
  "https://github.com/Dlleni-Real-Estate/Conversions-API/releases/latest/download/dlleni-agent.apk";

const REASSIGN_OPTIONS = [0, 5, 10, 15, 30, 60];

/**
 * The manager's side of the agent app: who the agents are, how they are doing,
 * and which campaign's leads go to whom in what share.
 */
export default function AgentsView({ pw }: { pw: string }) {
  const { t, lang, locale } = useLang();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [rules, setRules] = useState<RoutingRuleRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const api = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "x-app-password": pw, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        const code = String(json.error || res.status);
        if (code === "agent_has_leads") throw new Error(`agent_has_leads:${json.leads ?? 0}`);
        throw new Error(t.agErr[code] || (code === "shares_must_total_100" ? t.rtMustBe100 : code));
      }
      return json;
    },
    [pw, t]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, r] = await Promise.all([api("/api/admin/agents"), api("/api/admin/routing")]);
      setAgents(a.agents || []);
      setRules(r.rules || []);
      setCampaigns(r.campaigns || []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  };

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr(null);
    try {
      await fn();
      if (ok) flash(ok);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

  return (
    <div className="space-y-6">
      {err && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{err}</div>}
      {msg && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">{msg}</div>}

      <Card title={t.appTitle2} subtitle={t.appSub}>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <a
            href={APK_URL}
            className="tap inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-emerald-700"
          >
            <span aria-hidden>⬇</span> {t.appDownload}
          </a>
          <a href="/agent" target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline">
            {t.appWeb}
          </a>
        </div>
      </Card>

      <AgentsCard agents={agents} loading={loading} run={run} api={api} />

      <AgentReport pw={pw} />

      <RoutingCard
        agents={agents}
        agentName={agentName}
        rules={rules}
        campaigns={campaigns}
        run={run}
        api={api}
        lang={lang}
        locale={locale}
      />
    </div>
  );
}

// ── Agents ──────────────────────────────────────────────────────────────────

function AgentsCard({
  agents,
  loading,
  run,
  api,
}: {
  agents: AgentRow[];
  loading: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  api: (path: string, body?: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", username: "", password: "", phone: "" });
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; username: string; phone: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; leads: number; moveTo: string } | null>(null);

  const saveEdit = () =>
    editing &&
    run(async () => {
      await api("/api/admin/agents", {
        action: "update",
        id: editing.id,
        name: editing.name,
        username: editing.username,
        phone: editing.phone,
      });
      setEditing(null);
    }, t.rtSaved);

  // First ask plainly; if they still hold leads, the server says how many and
  // the card asks where those go before anything is deleted.
  const remove = async (a: AgentRow) => {
    if (!window.confirm(t.agDeleteConfirm)) return;
    try {
      await api("/api/admin/agents", { action: "delete", id: a.id });
      await run(async () => {}, t.agDeleted);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      if (m.startsWith("agent_has_leads:")) setDeleting({ id: a.id, leads: Number(m.split(":")[1]) || 0, moveTo: "" });
      else await run(() => Promise.reject(e));
    }
  };

  const create = () =>
    run(async () => {
      await api("/api/admin/agents", { action: "create", ...form });
      setCreated({ username: form.username.trim().toLowerCase(), password: form.password });
      setForm({ name: "", username: "", password: "", phone: "" });
      setOpen(false);
    });

  const input = "tap w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500";

  return (
    <Card
      title={t.agTitle}
      subtitle={t.agSub}
      right={
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            onClick={() => {
              if (window.confirm(t.agClearTestsConfirm)) run(() => api("/api/admin/test-lead", { action: "clear" }), t.agClearedTests);
            }}
            className="tap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t.agClearTests}
          </button>
          <button
            onClick={() => setOpen((v) => !v)}
            className="tap rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            + {t.agAdd}
          </button>
        </div>
      }
    >
      {open && (
        <div className="grid gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:grid-cols-5">
          <input className={input} placeholder={t.agName} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input
            className={input}
            dir="ltr"
            autoCapitalize="none"
            placeholder={t.agUsername}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value.replace(/\s/g, "") })}
          />
          <input className={input} dir="ltr" placeholder={t.agPassword} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input className={input} dir="ltr" placeholder={t.agPhone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <button onClick={create} className="tap rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            {t.agCreate}
          </button>
        </div>
      )}

      {created && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm text-emerald-900">
          <span>{t.agCreated}</span>
          <span dir="ltr" className="font-mono">
            {created.username} / {created.password}
          </span>
          <button onClick={() => setCreated(null)} className="ms-auto text-emerald-700">✕</button>
        </div>
      )}

      {agents.length === 0 ? (
        <Empty>{loading ? t.loading : t.agNone}</Empty>
      ) : (
        <ul className="grid gap-3 bg-slate-50 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => (
            <li key={a.id} className={`rounded-xl border bg-white p-4 shadow-card ${a.active ? "border-slate-200" : "border-slate-200 opacity-60"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${a.online ? "bg-emerald-500" : "bg-slate-300"}`}
                      title={a.online ? t.agOnline : t.agOffline}
                    />
                    <h3 dir="auto" className="truncate font-semibold">{a.name}</h3>
                  </div>
                  <p dir="ltr" className="mt-0.5 text-start text-xs text-slate-500">@{a.username}{a.phone ? ` · ${a.phone}` : ""}</p>
                </div>
                <span
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                    !a.active
                      ? "border-slate-300 bg-slate-100 text-slate-500"
                      : a.available
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : "border-amber-300 bg-amber-50 text-amber-700"
                  }`}
                >
                  {!a.active ? t.agDisabled : a.available ? t.agOnShift : t.agOffShift}
                </span>
              </div>

              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                {[
                  [t.agToday, String(a.stats.today)],
                  [t.agUntouched, String(a.stats.untouched)],
                  [t.agMedianCall, a.stats.median_call_min === null ? "—" : `${a.stats.median_call_min}m`],
                  [t.agWithin5, a.stats.within5_pct === null ? "—" : `${a.stats.within5_pct}%`],
                  [t.agQualified, String(a.stats.qualified)],
                  [t.agLeads30, String(a.stats.leads_30d)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-slate-50 px-1.5 py-2">
                    <dd className="text-base font-semibold tabular-nums">{v}</dd>
                    <dt className="mt-0.5 text-[10px] leading-tight text-slate-500">{k}</dt>
                  </div>
                ))}
              </dl>

              <p className="mt-2 text-[11px] text-slate-400">
                {a.last_seen_at ? `${t.agLastSeen}: ${fmtAgo(a.last_seen_at, lang)}` : t.agNever}
                {a.app_version ? ` · v${a.app_version}` : ""}
                {a.phone_setup ? ` · ${a.phone_setup.maker} ${a.phone_setup.model}` : ""}
              </p>
              {a.phone_setup && (
                a.phone_setup.issues.length === 0 ? (
                  <p className="mt-1 text-[11px] font-medium text-emerald-700">✓ {t.agPhoneReady}</p>
                ) : (
                  <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-800">
                    ⚠ {t.agPhoneIssues} {a.phone_setup.issues.map((i) => t.agIssue[i]).join(lang === "ar" ? "، " : ", ")}
                  </p>
                )
              )}

              {editing?.id === a.id && (
                <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <input className={input} placeholder={t.agName} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  <input
                    className={input}
                    dir="ltr"
                    autoCapitalize="none"
                    placeholder={t.agUsername}
                    value={editing.username}
                    onChange={(e) => setEditing({ ...editing, username: e.target.value.replace(/\s/g, "") })}
                  />
                  <input className={input} dir="ltr" placeholder={t.agPhone} value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="tap rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
                      {t.agSave}
                    </button>
                    <button onClick={() => setEditing(null)} className="tap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium">
                      {t.agCancel}
                    </button>
                  </div>
                </div>
              )}

              {deleting?.id === a.id && (
                <div className="mt-3 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                  <p className="font-medium text-red-900">{t.agDeleteMove(deleting.leads)}</p>
                  <select
                    value={deleting.moveTo}
                    onChange={(e) => setDeleting({ ...deleting, moveTo: e.target.value })}
                    className="tap w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">—</option>
                    {agents
                      .filter((x) => x.id !== a.id && x.active)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    <option value="__8x">{t.agDeleteTo8x}</option>
                  </select>
                  <div className="flex gap-2">
                    <button
                      disabled={!deleting.moveTo}
                      onClick={() =>
                        run(async () => {
                          await api("/api/admin/agents", {
                            action: "delete",
                            id: a.id,
                            move_to: deleting.moveTo === "__8x" ? null : deleting.moveTo,
                          });
                          setDeleting(null);
                        }, t.agDeleted)
                      }
                      className="tap rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40"
                    >
                      {t.agDeleteNow}
                    </button>
                    <button onClick={() => setDeleting(null)} className="tap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium">
                      {t.agCancel}
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <button
                  onClick={() => {
                    setDeleting(null);
                    setEditing({ id: a.id, name: a.name, username: a.username, phone: a.phone || "" });
                  }}
                  className="tap rounded-lg border border-slate-300 px-2.5 font-medium hover:bg-slate-50"
                >
                  {t.agEdit}
                </button>
                <button
                  onClick={() => run(() => api("/api/admin/agents", { action: "update", id: a.id, active: !a.active }))}
                  className="tap rounded-lg border border-slate-300 px-2.5 font-medium hover:bg-slate-50"
                >
                  {a.active ? t.agDisable : t.agEnable}
                </button>
                <button
                  onClick={() => {
                    const p = window.prompt(t.agPwPrompt);
                    if (p) run(() => api("/api/admin/agents", { action: "password", id: a.id, password: p }), t.rtSaved);
                  }}
                  className="tap rounded-lg border border-slate-300 px-2.5 font-medium hover:bg-slate-50"
                >
                  {t.agResetPw}
                </button>
                <button
                  onClick={() => run(() => api("/api/admin/agents", { action: "signout", id: a.id }), t.rtSaved)}
                  className="tap rounded-lg border border-slate-300 px-2.5 font-medium hover:bg-slate-50"
                >
                  {t.agSignOut}
                </button>
                {a.active && (
                  <button
                    onClick={() => run(() => api("/api/admin/test-lead", { agent_id: a.id }), t.agTestSent)}
                    title={t.agTestHint}
                    className="tap rounded-lg border border-violet-300 bg-violet-50 px-2.5 font-medium text-violet-800 hover:bg-violet-100"
                  >
                    {t.agTestLead}
                  </button>
                )}
                <button
                  onClick={() => {
                    setEditing(null);
                    remove(a);
                  }}
                  className="tap rounded-lg border border-red-200 px-2.5 font-medium text-red-700 hover:bg-red-50"
                >
                  {t.agDelete}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Routing ─────────────────────────────────────────────────────────────────

type Draft = {
  campaign_id: string;
  shares: Record<string, number>;
  reassign: number;
  backfill: boolean;
};

const evenSplit = (ids: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;
  const base = Math.floor(100 / ids.length);
  ids.forEach((id, i) => (out[id] = base + (i < 100 - base * ids.length ? 1 : 0)));
  return out;
};

/**
 * Set one agent's share and spread what is left over the others in proportion
 * to their current shares (evenly if they are all at 0), in whole percents, so
 * the total is always exactly 100.
 */
function rebalance(shares: Record<string, number>, id: string, value: number): Record<string, number> {
  const others = Object.keys(shares).filter((x) => x !== id);
  if (others.length === 0) return { [id]: 100 };
  const v = Math.max(0, Math.min(100, Math.round(value) || 0));
  const rest = 100 - v;
  const base = others.reduce((sum, x) => sum + (shares[x] || 0), 0);
  const raw = others.map((x) => (base > 0 ? ((shares[x] || 0) / base) * rest : rest / others.length));
  const out = raw.map(Math.floor);
  let left = rest - out.reduce((a, b) => a + b, 0);
  const byRemainder = raw.map((r, i) => [r - out[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) out[byRemainder[k % byRemainder.length][1]]++;
  return { ...Object.fromEntries(others.map((x, i) => [x, out[i]])), [id]: v };
}

function RoutingCard({
  agents,
  agentName,
  rules,
  campaigns,
  run,
  api,
  lang,
  locale,
}: {
  agents: AgentRow[];
  agentName: Map<string, string>;
  rules: RoutingRuleRow[];
  campaigns: CampaignOption[];
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  api: (path: string, body?: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  lang: "en" | "ar";
  locale: string;
}) {
  const { t } = useLang();
  const [draft, setDraft] = useState<Draft | null>(null);
  const activeAgents = agents.filter((a) => a.active);
  const total = draft ? Object.values(draft.shares).reduce((s, v) => s + (Number(v) || 0), 0) : 0;
  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name || rules.find((r) => r.campaign_id === id)?.campaign_name || id;
  const draftCampaign = draft ? campaigns.find((c) => c.id === draft.campaign_id) : undefined;
  const routed = new Set(rules.map((r) => r.campaign_id));
  const editingExisting = !!draft && routed.has(draft.campaign_id) && rules.some((r) => r.campaign_id === draft.campaign_id);
  const picked = draft ? Object.keys(draft.shares) : [];
  // Who can be picked: active agents, plus anyone already on this rule.
  const pickable = agents.filter((a) => a.active || picked.includes(a.id));
  const toggle = (id: string) => {
    if (!draft) return;
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    setDraft({ ...draft, shares: evenSplit(next) });
  };

  const edit = (rule?: RoutingRuleRow) =>
    setDraft(
      rule
        ? {
            campaign_id: rule.campaign_id,
            shares: Object.fromEntries(rule.routes.filter((r) => r.weight > 0).map((r) => [r.agent_id, r.weight])),
            reassign: rule.reassign_after_min ?? 0,
            backfill: false,
          }
        : { campaign_id: "", shares: {}, reassign: 0, backfill: false }
    );

  const save = (d: Draft) =>
    run(async () => {
      await api("/api/admin/routing", {
        campaign_id: d.campaign_id,
        campaign_name: campaignName(d.campaign_id),
        enabled: true,
        reassign_after_min: d.reassign || null,
        routes: Object.entries(d.shares)
          .filter(([, w]) => Number(w) > 0)
          .map(([agent_id, weight]) => ({ agent_id, weight: Number(weight) })),
        backfill_hours: d.backfill ? 72 : 0,
      });
      setDraft(null);
    }, t.rtSaved);

  const setPaused = (r: RoutingRuleRow, enabled: boolean) =>
    run(() =>
      api("/api/admin/routing", {
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        enabled,
        reassign_after_min: r.reassign_after_min,
        routes: r.routes.map((x) => ({ agent_id: x.agent_id, weight: x.weight })),
      })
    );

  return (
    <Card
      title={t.rtTitle}
      subtitle={t.rtSub}
      right={
        !draft && (
          <button
            onClick={() => edit()}
            disabled={activeAgents.length === 0}
            title={activeAgents.length === 0 ? t.rtNoAgents : undefined}
            className="tap shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
          >
            + {t.rtCampaign}
          </button>
        )
      }
    >
      {draft && (
        <div className="space-y-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">{t.rtCampaign}</span>
            <select
              value={draft.campaign_id}
              onChange={(e) => setDraft({ ...draft, campaign_id: e.target.value })}
              disabled={editingExisting}
              className="tap mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
            >
              <option value="">{t.rtPick}</option>
              {[
                [t.rtActive, campaigns.filter((c) => c.active)],
                [t.rtOthers, campaigns.filter((c) => !c.active)],
              ].map(([label, list]) =>
                (list as CampaignOption[]).length === 0 ? null : (
                  <optgroup key={label as string} label={label as string}>
                    {(list as CampaignOption[]).map((c) => {
                      const taken = routed.has(c.id) && !(editingExisting && c.id === draft.campaign_id);
                      return (
                        <option key={c.id} value={c.id} disabled={taken}>
                          {c.name} · {c.leads_7d} {t.rtLeads7d}
                          {routed.has(c.id) ? ` · ${t.rtRouted}` : ""}
                        </option>
                      );
                    })}
                  </optgroup>
                )
              )}
            </select>
          </label>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">{t.rtAgents}</span>
              {picked.length > 1 && (
                <button onClick={() => setDraft({ ...draft, shares: evenSplit(picked) })} className="text-xs font-medium text-brand-700 hover:underline">
                  {t.rtSplitEven}
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">{t.rtPickAgents}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {pickable.map((a) => {
                const on = picked.includes(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => toggle(a.id)}
                    aria-pressed={on}
                    className={`tap inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium ${
                      on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${a.online ? "bg-emerald-400" : on ? "bg-white/60" : "bg-slate-300"}`} />
                    <bdi>{a.name}</bdi>
                    {on && <span aria-hidden>✓</span>}
                  </button>
                );
              })}
            </div>

            {picked.length > 0 && (
              <ul className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
                {pickable
                  .filter((a) => picked.includes(a.id))
                  .map((a) => {
                    const v = draft.shares[a.id] ?? 0;
                    const only = picked.length === 1;
                    return (
                      <li key={a.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          <bdi>{a.name}</bdi>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={v}
                          disabled={only}
                          onChange={(e) => setDraft({ ...draft, shares: rebalance(draft.shares, a.id, Number(e.target.value)) })}
                          className="hidden w-40 accent-brand-600 sm:block"
                        />
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={100}
                            value={v}
                            disabled={only}
                            onChange={(e) => setDraft({ ...draft, shares: rebalance(draft.shares, a.id, Number(e.target.value)) })}
                            className="tap w-16 rounded-lg border border-slate-300 px-2 py-1 text-end text-sm tabular-nums disabled:bg-slate-100"
                          />
                          <span className="text-sm text-slate-500">%</span>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
            <p className={`mt-1.5 text-xs font-medium ${picked.length === 0 ? "text-red-600" : "text-emerald-700"}`}>
              {picked.length === 0 ? t.rtNoAgentPicked : `${t.rtTotal}: ${total}%`}
            </p>
          </div>

          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t.rtReassign}</span>
            <select
              value={draft.reassign}
              onChange={(e) => setDraft({ ...draft, reassign: Number(e.target.value) })}
              className="tap rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
            >
              {REASSIGN_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? t.rtReassignOff : m}
                </option>
              ))}
            </select>
            <span className="text-slate-600">{t.rtReassignSuffix}</span>
          </label>

          {draftCampaign && draftCampaign.unworked_72h > 0 && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.backfill}
                onChange={(e) => setDraft({ ...draft, backfill: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-brand-600"
              />
              <span>
                {t.rtBackfill} <span className="text-slate-500">({draftCampaign.unworked_72h} {t.rtUnworked})</span>
              </span>
            </label>
          )}

          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">{t.rt8xWarn}</p>

          <div className="flex gap-2">
            <button
              onClick={() => save(draft)}
              disabled={!draft.campaign_id || picked.length === 0 || total !== 100}
              className="tap rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
            >
              {t.rtSave}
            </button>
            <button onClick={() => setDraft(null)} className="tap rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium">
              {t.rtCancel}
            </button>
          </div>
        </div>
      )}

      {rules.length === 0 ? (
        <Empty>{t.rtNoRules}</Empty>
      ) : (
        <ul className="divide-y divide-slate-200">
          {rules.map((r) => {
            const live = r.routes.filter((x) => x.weight > 0);
            // A rule whose agents were all disabled or deleted hands nothing out.
            const working = live.filter((x) => agents.some((a) => a.id === x.agent_id && a.active));
            return (
              <li key={r.campaign_id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                          r.enabled ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 bg-slate-100 text-slate-500"
                        }`}
                      >
                        {r.enabled ? t.rtLive : t.rtPaused}
                      </span>
                      <h3 dir="auto" className="truncate font-semibold">{r.campaign_name || r.campaign_id}</h3>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {t.rtSince} {fmtDate(r.since, locale)}
                      {r.reassign_after_min ? ` · ${t.rtReassign} ${r.reassign_after_min} ${lang === "ar" ? "دقيقة" : "min"}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <button onClick={() => edit(r)} className="tap rounded-lg border border-slate-300 px-2.5 font-medium hover:bg-slate-50">
                      {t.rtEdit}
                    </button>
                    <button
                      onClick={() => setPaused(r, !r.enabled)}
                      className="tap rounded-lg border border-slate-300 px-2.5 font-medium hover:bg-slate-50"
                    >
                      {r.enabled ? t.rtPause : t.rtResume}
                    </button>
                    <button
                      onClick={() => run(() => api("/api/admin/routing", { campaign_id: r.campaign_id, remove: true }))}
                      className="tap rounded-lg border border-red-200 px-2.5 font-medium text-red-700 hover:bg-red-50"
                    >
                      {t.rtRemove}
                    </button>
                  </div>
                </div>

                {r.enabled && working.length === 0 && (
                  <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">⚠ {t.rtNoActiveAgent}</p>
                )}
                {/* The split as one bar, so 70/30 reads at a glance. */}
                <div className="mt-3 flex h-7 overflow-hidden rounded-lg border border-slate-200 text-[11px] font-semibold text-white">
                  {live.map((x, i) => (
                    <div
                      key={x.agent_id}
                      style={{ width: `${x.weight}%`, background: SHARE_COLORS[i % SHARE_COLORS.length] }}
                      className="flex min-w-0 items-center justify-center truncate px-1"
                      title={`${agentName.get(x.agent_id) || "?"} ${x.weight}%`}
                    >
                      <span className="truncate">{agentName.get(x.agent_id) || "?"} {x.weight}%</span>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  {live.map((x) => `${agentName.get(x.agent_id) || "?"}: ${x.assigned}`).join(" · ")}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const SHARE_COLORS = ["#4f46e5", "#059669", "#d97706", "#db2777", "#0891b2", "#7c3aed", "#65a30d", "#dc2626"];
