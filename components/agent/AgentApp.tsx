"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { answerLabel, questionLabel, type FormDictionary } from "@/lib/labels";
import { AGENT_TEXT, type AgentLang, type AgentText } from "@/lib/agentText";

/**
 * The agent app: the screens an agent lives in all day.
 *
 * It runs in two places. Inside the Android app it is the WebView's page, and
 * the native shell does what a web page cannot - ring like a phone call while
 * the screen is locked, keep checking for leads in the background, and dial
 * directly. In a plain phone browser it works the same minus the ringing.
 * Everything native goes through `window.DlleniApp`; when that is missing the
 * page falls back to plain links.
 */

// ── Native bridge ───────────────────────────────────────────────────────────

type NativeBridge = {
  session(): string;
  login(token: string, agentJson: string): void;
  logout(): void;
  setAvailable(on: boolean): void;
  call(leadId: string, phone: string): void;
  whatsapp(phone: string): void;
  ack(leadId: string): void;
  status(): string;
  fix(what: string): void;
  testRing(): void;
};

type NativeStatus = {
  version?: string;
  notifications?: boolean;
  fullScreen?: boolean;
  battery?: boolean;
  callPhone?: boolean;
};

declare global {
  interface Window {
    DlleniApp?: NativeBridge;
    dlleniAfterCall?: (leadId: string) => void;
    dlleniResume?: () => void;
    dlleniBack?: () => boolean;
  }
}

const bridge = () => (typeof window !== "undefined" ? window.DlleniApp : undefined);

function nativeStatus(): NativeStatus | null {
  try {
    const b = bridge();
    return b ? (JSON.parse(b.status() || "{}") as NativeStatus) : null;
  } catch {
    return null;
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

type Agent = { id: string; name: string; username: string; available: boolean; phone?: string | null };

type Lead = {
  lead_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  status: Status;
  submitted_at: string;
  campaign_name: string | null;
  adset_name: string | null;
  ad_name: string | null;
  form_name: string | null;
  platform: string | null;
  raw_fields: Record<string, string> | null;
  assigned_at: string | null;
  acked_at: string | null;
  first_call_at: string | null;
  last_call_at: string | null;
  call_count: number | null;
  follow_up_at: string | null;
  notes: string | null;
};

type Note = {
  id: string;
  kind: "note" | "stage" | "call" | "assign";
  body: string | null;
  from_status: Status | null;
  to_status: Status | null;
  author: string | null;
  created_at: string;
};

type View = "new" | "follow" | "all";

const TOKEN_KEY = "dlleni_agent_token";
const LANG_KEY = "dlleni_agent_lang";
const CONTACT_KEY = /name|phone|email|whatsapp|رقم|الاسم|بريد|واتس/i;
const LATER_STAGES: Status[] = ["meeting_booked", "meeting_done", "site_visit_booked", "site_visit_done", "eoi", "reservation"];

// ── Small helpers ───────────────────────────────────────────────────────────

function ago(iso: string | null | undefined, tx: AgentText): string {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 0) {
    const ahead = -mins;
    return ahead < 60 ? tx.inMin(ahead) : tx.inHourN(Math.round(ahead / 60));
  }
  if (mins < 1) return tx.justNow;
  if (mins < 60) return tx.minAgo(mins);
  const h = Math.round(mins / 60);
  if (h < 48) return tx.hourAgo(h);
  return tx.dayAgo(Math.round(h / 24));
}

function when(iso: string | null | undefined, lang: AgentLang): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(lang === "ar" ? "ar-EG" : "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    numberingSystem: "latn",
  });
}

const initials = (name: string | null) =>
  (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

const prettyPhone = (p: string | null) => (p ? `+${p}` : "");

function stageName(status: Status, lang: AgentLang) {
  const s = STAGE_BY_STATUS[status];
  return s ? (lang === "ar" ? s.labelAr : s.label) : status;
}

function StageChip({ status, lang, className = "" }: { status: Status; lang: AgentLang; className?: string }) {
  const s = STAGE_BY_STATUS[status];
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${s?.color ?? ""} ${className}`}>
      {stageName(status, lang)}
    </span>
  );
}

function PhoneIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24 11.36 11.36 0 003.57.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1.02l-2.2 2.2z" />
    </svg>
  );
}

function WhatsIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12.04 2a9.9 9.9 0 00-8.5 15l-1.4 5 5.1-1.34A9.9 9.9 0 1012.04 2zm5.8 14.06c-.24.68-1.42 1.3-1.96 1.35-.5.05-1.13.07-1.83-.11a16.6 16.6 0 01-1.66-.61 13 13 0 01-5-4.42 5.7 5.7 0 01-1.2-3.03 3.3 3.3 0 011.03-2.45 1.08 1.08 0 01.78-.37h.56c.18 0 .42-.07.66.5.24.6.83 2.05.9 2.2.07.14.12.31.02.5-.1.2-.14.31-.29.48l-.43.5c-.14.15-.29.3-.12.6a8.9 8.9 0 001.65 2.05 8.1 8.1 0 002.38 1.47c.3.15.47.12.65-.07.17-.2.75-.87.95-1.17.2-.3.4-.25.66-.15.27.1 1.72.81 2.02.96.3.15.49.22.56.34.07.12.07.7-.17 1.38z" />
    </svg>
  );
}

// ── The app ─────────────────────────────────────────────────────────────────

export default function AgentApp() {
  const [lang, setLangState] = useState<AgentLang>("ar");
  const tx = AGENT_TEXT[lang];
  const [booted, setBooted] = useState(false);
  const [token, setToken] = useState<string>("");
  const [agent, setAgent] = useState<Agent | null>(null);

  const [screen, setScreen] = useState<"list" | "lead" | "settings">("list");
  const [view, setView] = useState<View>("new");
  const [search, setSearch] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState({ new: 0, follow_due: 0, all: 0 });
  const [dict, setDict] = useState<FormDictionary | null>(null);
  const [loading, setLoading] = useState(false);

  const [leadId, setLeadId] = useState<string | null>(null);
  const [lead, setLead] = useState<Lead | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [leadDict, setLeadDict] = useState<FormDictionary | null>(null);
  const [sheetFor, setSheetFor] = useState<Lead | null>(null);

  const [toast, setToast] = useState<string | null>(null);
  const [native, setNative] = useState<NativeStatus | null>(null);
  const pendingCall = useRef<string | null>(null);

  // Language: Arabic unless the agent chose otherwise. The whole document
  // flips, so native widgets sit on the right side too.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANG_KEY);
      if (saved === "en" || saved === "ar") setLangState(saved);
    } catch {
      /* private mode */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);
  const setLang = (l: AgentLang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
  };

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  };

  const signOutLocal = useCallback(() => {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    bridge()?.logout();
    setToken("");
    setAgent(null);
    setScreen("list");
  }, []);

  const api = useCallback(
    async (path: string, body?: unknown, tok = token) => {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: {
          "x-agent-token": tok,
          "content-type": "application/json",
          ...(native?.version ? { "x-app-version": native.version } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      if (res.status === 401) {
        signOutLocal();
        throw new Error("unauthorized");
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || res.status));
      return j;
    },
    [token, native?.version, signOutLocal]
  );

  // Boot: the native shell's session first, then the browser's.
  useEffect(() => {
    setNative(nativeStatus());
    let tok = "";
    try {
      const s = bridge()?.session();
      if (s) tok = (JSON.parse(s) as { token?: string }).token || "";
    } catch {
      /* no session */
    }
    if (!tok) {
      try {
        tok = window.localStorage.getItem(TOKEN_KEY) || "";
      } catch {
        /* ignore */
      }
    }
    if (!tok) {
      setBooted(true);
      return;
    }
    fetch("/api/agent/me", { headers: { "x-agent-token": tok }, cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) return signOutLocal();
        const j = await r.json();
        if (j.ok) {
          setToken(tok);
          setAgent(j.agent);
        }
      })
      .catch(() => {
        // Offline at boot: keep the session, the list shows the error.
        setToken(tok);
      })
      .finally(() => setBooted(true));
  }, [signOutLocal]);

  const loadList = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ view, ...(search.trim() ? { q: search.trim() } : {}) });
      const j = await api(`/api/agent/leads?${qs}`);
      setLeads(j.leads || []);
      setCounts(j.counts || { new: 0, follow_due: 0, all: 0 });
      setDict(j.dictionary || null);
      if (j.agent) setAgent(j.agent);
    } catch (e) {
      if ((e as Error).message !== "unauthorized") flash(tx.network);
    } finally {
      setLoading(false);
    }
  }, [token, view, search, api, tx.network]);

  const loadLead = useCallback(
    async (id: string) => {
      const j = await api(`/api/agent/leads/${encodeURIComponent(id)}`);
      setLead(j.lead);
      setNotes(j.notes || []);
      setLeadDict(j.dictionary || null);
      return j.lead as Lead;
    },
    [api]
  );

  const openLead = useCallback(
    async (id: string, withSheet = false) => {
      setLeadId(id);
      setScreen("lead");
      setLead(null);
      setNotes([]);
      bridge()?.ack(id);
      try {
        const l = await loadLead(id);
        if (!l.acked_at) api(`/api/agent/leads/${encodeURIComponent(id)}`, { action: "open" }).catch(() => {});
        if (withSheet) setSheetFor(l);
      } catch {
        flash(tx.network);
      }
    },
    [loadLead, api, tx.network]
  );

  // List: on open, on every tab/search change, and every 20s while visible.
  useEffect(() => {
    if (!token) return;
    const id = setTimeout(loadList, search ? 350 : 0);
    return () => clearTimeout(id);
  }, [token, view, search, loadList]);

  useEffect(() => {
    if (!token) return;
    const tick = setInterval(() => {
      if (document.visibilityState === "visible" && screen === "list") loadList();
    }, 20_000);
    return () => clearInterval(tick);
  }, [token, screen, loadList]);

  // Deep links from the native shell: ?lead=ID opens a lead, &after_call=1
  // opens the result sheet straight away.
  useEffect(() => {
    if (!token) return;
    const p = new URLSearchParams(window.location.search);
    const id = p.get("lead");
    if (id) {
      openLead(id, p.get("after_call") === "1");
      window.history.replaceState(null, "", "/agent");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Native callbacks, and the browser's way of noticing a call ended.
  useEffect(() => {
    window.dlleniAfterCall = (id: string) => {
      pendingCall.current = null;
      openLead(id, true);
    };
    window.dlleniResume = () => {
      setNative(nativeStatus());
      if (screen === "list") loadList();
      else if (leadId) loadLead(leadId).catch(() => {});
    };
    window.dlleniBack = () => {
      if (sheetFor) {
        setSheetFor(null);
        return true;
      }
      if (screen !== "list") {
        setScreen("list");
        loadList();
        return true;
      }
      return false;
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (pendingCall.current && !bridge()) {
        const id = pendingCall.current;
        pendingCall.current = null;
        openLead(id, true);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [openLead, loadList, loadLead, screen, leadId, sheetFor]);

  const startCall = async (l: Lead, channel: "phone" | "whatsapp") => {
    if (!l.phone) return;
    api(`/api/agent/leads/${encodeURIComponent(l.lead_id)}`, { action: "call", channel }).catch(() => {});
    const b = bridge();
    if (channel === "whatsapp") {
      if (b) b.whatsapp(l.phone);
      else window.open(`https://wa.me/${l.phone}`, "_blank");
      return;
    }
    pendingCall.current = l.lead_id;
    if (b) b.call(l.lead_id, l.phone);
    else window.location.href = `tel:+${l.phone}`;
  };

  const setAvailable = async (on: boolean) => {
    try {
      const j = await api("/api/agent/me", { available: on });
      setAgent(j.agent);
      bridge()?.setAvailable(on);
    } catch {
      flash(tx.network);
    }
  };

  if (!booted) return <Splash />;
  if (!token || !agent) {
    return (
      <Login
        tx={tx}
        lang={lang}
        onLang={setLang}
        onDone={(tok, a) => {
          try {
            window.localStorage.setItem(TOKEN_KEY, tok);
          } catch {
            /* ignore */
          }
          bridge()?.login(tok, JSON.stringify(a));
          setNative(nativeStatus());
          setToken(tok);
          setAgent(a);
        }}
      />
    );
  }

  const setupIncomplete = native && (!native.notifications || native.fullScreen === false || !native.battery);

  return (
    <div className="min-h-screen bg-slate-100 pb-10 text-slate-900">
      {screen === "list" && (
        <ListScreen
          tx={tx}
          lang={lang}
          agent={agent}
          view={view}
          onView={setView}
          counts={counts}
          leads={leads}
          dict={dict}
          loading={loading}
          search={search}
          onSearch={setSearch}
          onOpen={(id) => openLead(id)}
          onCall={(l) => startCall(l, "phone")}
          onAvailable={setAvailable}
          onSettings={() => setScreen("settings")}
          onRefresh={loadList}
          setupIncomplete={!!setupIncomplete}
        />
      )}

      {screen === "lead" && (
        <LeadScreen
          tx={tx}
          lang={lang}
          lead={lead}
          notes={notes}
          dict={leadDict}
          onBack={() => {
            setScreen("list");
            loadList();
          }}
          onCall={(l) => startCall(l, "phone")}
          onWhatsapp={(l) => startCall(l, "whatsapp")}
          onOutcome={(l) => setSheetFor(l)}
          onNote={async (body) => {
            if (!leadId) return;
            const j = await api(`/api/agent/leads/${encodeURIComponent(leadId)}`, { action: "note", body });
            setNotes(j.notes || []);
            flash(tx.saved);
          }}
        />
      )}

      {screen === "settings" && (
        <SettingsScreen
          tx={tx}
          lang={lang}
          agent={agent}
          native={native}
          onLang={setLang}
          onBack={() => setScreen("list")}
          onAvailable={setAvailable}
          onRefreshNative={() => setNative(nativeStatus())}
          onLogout={async () => {
            await api("/api/agent/logout", {}).catch(() => {});
            signOutLocal();
          }}
        />
      )}

      {sheetFor && (
        <OutcomeSheet
          tx={tx}
          lang={lang}
          lead={sheetFor}
          onClose={() => setSheetFor(null)}
          onSave={async (payload) => {
            await api(`/api/agent/leads/${encodeURIComponent(sheetFor.lead_id)}`, { action: "outcome", ...payload });
            setSheetFor(null);
            flash(tx.saved);
            // Next lead: back to the list, where the next one is waiting.
            setScreen("list");
            loadList();
          }}
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
          <div className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg">{toast}</div>
        </div>
      )}
    </div>
  );
}

// ── Screens ─────────────────────────────────────────────────────────────────

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
    </div>
  );
}

function Logo({ size = "h-14 w-14 text-2xl" }: { size?: string }) {
  return (
    <div className={`flex ${size} items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600 to-emerald-500 font-bold text-white shadow-raised`}>
      د
    </div>
  );
}

function Login({
  tx,
  lang,
  onLang,
  onDone,
}: {
  tx: AgentText;
  lang: AgentLang;
  onLang: (l: AgentLang) => void;
  onDone: (token: string, agent: Agent) => void;
}) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/agent/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: u, password: p, device: navigator.userAgent.slice(0, 120) }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) onDone(j.token, j.agent);
      else setErr(j.error === "disabled" ? tx.disabled : tx.badCredentials);
    } catch {
      setErr(tx.network);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col bg-gradient-to-b from-brand-50 via-white to-white px-6 pb-10 pt-16">
      <div className="flex justify-end">
        <LangToggle lang={lang} onLang={onLang} />
      </div>
      <div className="mx-auto mt-6 w-full max-w-sm">
        <Logo />
        <h1 className="mt-6 text-2xl font-bold tracking-tight">{tx.appName}</h1>
        <p className="mt-1 text-sm text-slate-500">{tx.signInSub}</p>
        <form onSubmit={submit} className="mt-8 space-y-3">
          <input
            value={u}
            onChange={(e) => setU(e.target.value.replace(/\s/g, ""))}
            placeholder={tx.username}
            autoCapitalize="none"
            autoCorrect="off"
            dir="ltr"
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-base shadow-card outline-none focus:border-brand-500"
          />
          <input
            value={p}
            onChange={(e) => setP(e.target.value)}
            placeholder={tx.password}
            type="password"
            dir="ltr"
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-base shadow-card outline-none focus:border-brand-500"
          />
          {err && <p className="text-sm font-medium text-red-600">{err}</p>}
          <button
            disabled={busy || !u || !p}
            className="w-full rounded-2xl bg-brand-600 py-3.5 text-base font-semibold text-white shadow-raised active:scale-[0.99] disabled:opacity-50"
          >
            {busy ? tx.signingIn : tx.signIn}
          </button>
        </form>
      </div>
    </main>
  );
}

function LangToggle({ lang, onLang }: { lang: AgentLang; onLang: (l: AgentLang) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-full border border-slate-200 bg-white text-xs font-semibold shadow-card">
      {(["ar", "en"] as const).map((l) => (
        <button
          key={l}
          onClick={() => onLang(l)}
          className={`px-3 py-1.5 ${lang === l ? "bg-slate-900 text-white" : "text-slate-600"}`}
        >
          {l === "ar" ? "ع" : "EN"}
        </button>
      ))}
    </div>
  );
}

function ShiftSwitch({ on, tx, onChange }: { on: boolean; tx: AgentText; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-card transition ${
        on ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-500"
      }`}
      aria-pressed={on}
    >
      <span className={`relative h-4 w-7 rounded-full transition ${on ? "bg-emerald-500" : "bg-slate-300"}`}>
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
            on ? "start-[0.875rem]" : "start-0.5"
          }`}
        />
      </span>
      {on ? tx.onShift : tx.offShift}
    </button>
  );
}

function ListScreen({
  tx,
  lang,
  agent,
  view,
  onView,
  counts,
  leads,
  dict,
  loading,
  search,
  onSearch,
  onOpen,
  onCall,
  onAvailable,
  onSettings,
  onRefresh,
  setupIncomplete,
}: {
  tx: AgentText;
  lang: AgentLang;
  agent: Agent;
  view: View;
  onView: (v: View) => void;
  counts: { new: number; follow_due: number; all: number };
  leads: Lead[];
  dict: FormDictionary | null;
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
  onOpen: (id: string) => void;
  onCall: (l: Lead) => void;
  onAvailable: (v: boolean) => void;
  onSettings: () => void;
  onRefresh: () => void;
  setupIncomplete: boolean;
}) {
  const tabs: { id: View; label: string; badge: number; tone: string }[] = [
    { id: "new", label: tx.tabNew, badge: counts.new, tone: "bg-red-500" },
    { id: "follow", label: tx.tabFollow, badge: counts.follow_due, tone: "bg-amber-500" },
    { id: "all", label: tx.tabAll, badge: 0, tone: "" },
  ];

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 pb-3 pt-4 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Logo size="h-10 w-10 text-lg" />
            <div className="min-w-0">
              <p className="text-xs text-slate-500">{tx.hello}</p>
              <h1 dir="auto" className="truncate text-base font-bold">{agent.name}</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ShiftSwitch on={agent.available} tx={tx} onChange={onAvailable} />
            <button
              onClick={onSettings}
              aria-label={tx.settings}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-card"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mx-auto mt-3 grid max-w-xl grid-cols-3 gap-1 rounded-2xl bg-slate-100 p-1">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => onView(tb.id)}
              className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-semibold transition ${
                view === tb.id ? "bg-white text-slate-900 shadow-card" : "text-slate-500"
              }`}
            >
              {tb.label}
              {tb.badge > 0 && (
                <span className={`min-w-[1.25rem] rounded-full px-1.5 py-0.5 text-[10px] leading-none text-white ${tb.tone}`}>{tb.badge}</span>
              )}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-3 px-4 pt-3">
        {!agent.available && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{tx.offShiftBanner}</div>
        )}
        {setupIncomplete && (
          <button
            onClick={onSettings}
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-start text-sm text-brand-900"
          >
            <span>{tx.setupBanner}</span>
            <span className="shrink-0 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">{tx.setupFix}</span>
          </button>
        )}

        <div className="flex gap-2">
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={tx.search}
            className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-base shadow-card outline-none focus:border-brand-500"
          />
          <button
            onClick={onRefresh}
            aria-label={tx.refresh}
            className="flex w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-card"
          >
            <svg viewBox="0 0 24 24" className={`h-5 w-5 ${loading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M21 12a9 9 0 11-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
        </div>

        {leads.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <PhoneIcon className="h-7 w-7" />
            </div>
            <p className="mt-4 font-semibold">
              {view === "new" ? tx.emptyNew : view === "follow" ? tx.emptyFollow : tx.emptyAll}
            </p>
            {view === "new" && <p className="mt-1 text-sm text-slate-500">{tx.emptyNewSub}</p>}
          </div>
        ) : (
          <ul className="space-y-3">
            {leads.map((l) => (
              <LeadCard key={l.lead_id} tx={tx} lang={lang} lead={l} dict={dict} onOpen={() => onOpen(l.lead_id)} onCall={() => onCall(l)} />
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function LeadCard({
  tx,
  lang,
  lead,
  dict,
  onOpen,
  onCall,
}: {
  tx: AgentText;
  lang: AgentLang;
  lead: Lead;
  dict: FormDictionary | null;
  onOpen: () => void;
  onCall: () => void;
}) {
  const stage = STAGE_BY_STATUS[lead.status];
  const isNew = lead.status === "new";
  const due = lead.follow_up_at && Date.parse(lead.follow_up_at) <= Date.now();
  const preview = Object.entries(lead.raw_fields || {})
    .filter(([k, v]) => !CONTACT_KEY.test(k) && String(v ?? "").trim())
    .slice(0, 2)
    .map(([k, v]) => ({ q: questionLabel(dict, k), a: answerLabel(dict, k, v) }));

  return (
    <li className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card">
      <span className="absolute inset-y-0 start-0 w-1.5" style={{ background: stage?.accent }} aria-hidden />
      <div className="flex items-stretch">
        <button onClick={onOpen} className="min-w-0 flex-1 px-4 py-3.5 ps-5 text-start">
          <div className="flex items-center gap-2">
            {isNew && <span className="stale-dot h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" aria-hidden />}
            <h3 dir="auto" className="truncate text-base font-bold">{lead.full_name || tx.unnamed}</h3>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {isNew ? `${tx.waiting} ${ago(lead.assigned_at, tx)}` : `${tx.assigned} ${ago(lead.assigned_at, tx)}`}
            {lead.campaign_name ? ` · ${lead.campaign_name}` : ""}
          </p>
          {preview.length > 0 && (
            <dl className="mt-2 space-y-1">
              {preview.map((p) => (
                <div key={p.q} className="text-[13px] leading-snug">
                  <dt className="inline text-slate-500" dir="auto">{p.q}: </dt>
                  <dd className="inline font-semibold text-slate-800" dir="auto">{p.a}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <StageChip status={lead.status} lang={lang} />
            {lead.follow_up_at && lead.status !== "new" && (
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${due ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"}`}>
                ⏰ {when(lead.follow_up_at, lang)}
              </span>
            )}
            {!!lead.call_count && <span className="text-[11px] text-slate-400">{tx.calls(lead.call_count)}</span>}
          </div>
        </button>
        {lead.phone && (
          <div className="flex items-center pe-3">
            <button
              onClick={onCall}
              aria-label={tx.call}
              className={`flex h-14 w-14 items-center justify-center rounded-full text-white shadow-raised active:scale-95 ${
                isNew ? "bg-emerald-500" : "bg-emerald-600/90"
              }`}
            >
              <PhoneIcon className="h-6 w-6" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-card">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function LeadScreen({
  tx,
  lang,
  lead,
  notes,
  dict,
  onBack,
  onCall,
  onWhatsapp,
  onOutcome,
  onNote,
}: {
  tx: AgentText;
  lang: AgentLang;
  lead: Lead | null;
  notes: Note[];
  dict: FormDictionary | null;
  onBack: () => void;
  onCall: (l: Lead) => void;
  onWhatsapp: (l: Lead) => void;
  onOutcome: (l: Lead) => void;
  onNote: (body: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/95 px-2 py-2 backdrop-blur">
        <button onClick={onBack} aria-label={tx.back} className="flex h-11 w-11 items-center justify-center rounded-full text-slate-700 active:bg-slate-100">
          <svg viewBox="0 0 24 24" className="h-6 w-6 rtl:rotate-180" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 dir="auto" className="min-w-0 flex-1 truncate text-base font-bold">{lead?.full_name || ""}</h1>
      </header>

      {!lead ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
        </div>
      ) : (
        <main className="mx-auto max-w-xl space-y-3 px-4 pt-4">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-lg font-bold text-brand-700">
                {initials(lead.full_name)}
              </div>
              <div className="min-w-0">
                <h2 dir="auto" className="truncate text-xl font-bold">{lead.full_name || tx.unnamed}</h2>
                <p dir="ltr" className="text-start text-sm font-medium tabular-nums text-slate-600">{prettyPhone(lead.phone)}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <StageChip status={lead.status} lang={lang} />
              <span>
                {lead.status === "new" ? tx.waiting : tx.assigned} {ago(lead.assigned_at, tx)}
              </span>
              <span>· {lead.call_count ? tx.calls(lead.call_count) : tx.neverCalled}</span>
            </div>

            {lead.follow_up_at && (
              <div
                className={`mt-3 rounded-2xl px-3 py-2 text-sm font-medium ${
                  Date.parse(lead.follow_up_at) <= Date.now() ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-700"
                }`}
              >
                ⏰ {Date.parse(lead.follow_up_at) <= Date.now() ? tx.followDue : tx.followUp}: {when(lead.follow_up_at, lang)}
              </div>
            )}

            {lead.phone && (
              <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                <button
                  onClick={() => onCall(lead)}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-4 text-lg font-bold text-white shadow-raised active:scale-[0.99]"
                >
                  <PhoneIcon className="h-6 w-6" /> {tx.callNow}
                </button>
                <button
                  onClick={() => onWhatsapp(lead)}
                  aria-label={tx.whatsapp}
                  className="flex w-16 items-center justify-center rounded-2xl border-2 border-emerald-500 text-emerald-600 active:scale-[0.99]"
                >
                  <WhatsIcon className="h-7 w-7" />
                </button>
              </div>
            )}
            <button
              onClick={() => onOutcome(lead)}
              className="mt-2 w-full rounded-2xl border-2 border-brand-200 bg-brand-50 py-3 text-base font-semibold text-brand-700 active:scale-[0.99]"
            >
              {tx.logOutcome}
            </button>
          </section>

          {Object.keys(lead.raw_fields || {}).length > 0 && (
            <Section title={tx.formAnswers}>
              <dl className="divide-y divide-slate-100">
                {Object.entries(lead.raw_fields || {}).map(([k, v]) => (
                  <div key={k} className="py-2.5">
                    <dt dir="auto" className="text-xs text-slate-500">{questionLabel(dict, k)}</dt>
                    <dd dir="auto" className="mt-0.5 text-[15px] font-semibold text-slate-900">{answerLabel(dict, k, v)}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          <Section title={tx.history}>
            <div className="flex gap-2">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={tx.addNote}
                dir="auto"
                className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-base outline-none focus:border-brand-500 focus:bg-white"
              />
              <button
                disabled={!note.trim() || saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await onNote(note.trim());
                    setNote("");
                  } finally {
                    setSaving(false);
                  }
                }}
                className="rounded-2xl bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
              >
                {saving ? "…" : tx.save}
              </button>
            </div>
            <ol className="mt-4 space-y-3 border-s-2 border-slate-100 ps-4">
              {notes.map((n) => (
                <li key={n.id} className="relative">
                  <span
                    className="absolute top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white"
                    style={{
                      insetInlineStart: "-23px",
                      background:
                        n.kind === "stage" && n.to_status
                          ? STAGE_BY_STATUS[n.to_status]?.accent
                          : n.kind === "call"
                            ? "#10b981"
                            : n.kind === "assign"
                              ? "#6366f1"
                              : "#cbd5e1",
                    }}
                  />
                  <div className="text-[11px] text-slate-400">
                    {when(n.created_at, lang)}
                    {n.author && n.kind !== "assign" ? <span dir="auto"> · {n.author}</span> : null}
                  </div>
                  {n.kind === "stage" && n.to_status && (
                    <div className="mt-0.5 text-sm">
                      {n.from_status && (
                        <span className="text-slate-500">
                          {stageName(n.from_status, lang)} {lang === "ar" ? "←" : "→"}{" "}
                        </span>
                      )}
                      <span className="font-semibold">{stageName(n.to_status, lang)}</span>
                    </div>
                  )}
                  {n.kind === "call" && (
                    <div className="mt-0.5 text-sm text-slate-700">{n.body === "whatsapp" ? `💬 ${tx.timelineWhatsapp}` : `📞 ${tx.timelineCall}`}</div>
                  )}
                  {n.kind === "assign" && n.body && (
                    <div className="mt-0.5 text-sm text-slate-700">
                      {tx.timelineAssign} <span dir="auto" className="font-semibold">{n.body}</span>
                    </div>
                  )}
                  {n.body && (n.kind === "note" || n.kind === "stage") && (
                    <p dir="auto" className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{n.body}</p>
                  )}
                </li>
              ))}
            </ol>
          </Section>

          <Section title={tx.source}>
            <dl className="divide-y divide-slate-100 text-sm">
              {[
                [tx.campaign, lead.campaign_name],
                [tx.ad, lead.ad_name],
                [tx.form, lead.form_name],
                [tx.platform, lead.platform],
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between gap-4 py-2">
                  <dt className="shrink-0 text-slate-500">{k}</dt>
                  <dd dir="auto" className="min-w-0 truncate text-end font-medium">{v || "—"}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </main>
      )}
    </>
  );
}

// ── After the call ──────────────────────────────────────────────────────────

type CallResult = "answered" | "no_answer" | "unreachable";
type FollowPick = "none" | "1h" | "3h" | "tonight" | "tomorrow" | "custom";

function followTime(pick: FollowPick, custom: string): string | null {
  const d = new Date();
  if (pick === "1h") return new Date(Date.now() + 3600_000).toISOString();
  if (pick === "3h") return new Date(Date.now() + 3 * 3600_000).toISOString();
  if (pick === "tonight") {
    d.setHours(20, 0, 0, 0);
    if (d.getTime() < Date.now() + 15 * 60_000) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if (pick === "tomorrow") {
    d.setDate(d.getDate() + 1);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  }
  if (pick === "custom" && custom) return new Date(custom).toISOString();
  return null;
}

function OutcomeSheet({
  tx,
  lang,
  lead,
  onClose,
  onSave,
}: {
  tx: AgentText;
  lang: AgentLang;
  lead: Lead;
  onClose: () => void;
  onSave: (p: { status: Status; note: string; follow_up_at: string | null; deal_value?: number }) => Promise<void>;
}) {
  const [call, setCall] = useState<CallResult | null>(null);
  const [result, setResult] = useState<Status | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [follow, setFollow] = useState<FollowPick>("none");
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [deal, setDeal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Sensible reminders, so the common case is one tap: an unanswered call is
  // tried again in an hour, a switched-off phone in three, an interested lead
  // that needs time tomorrow.
  const pickCall = (c: CallResult) => {
    setCall(c);
    setResult(null);
    setFollow(c === "no_answer" ? "1h" : c === "unreachable" ? "3h" : "none");
  };
  const pickResult = (s: Status) => {
    setResult(s);
    setFollow(s === "contacted" ? "tomorrow" : s === "disqualified" ? "none" : follow);
  };

  const status: Status | null = call === "answered" ? result : call;
  const closed = status === "disqualified" || status === "reservation";

  const save = async () => {
    if (!status) {
      setErr(tx.pickFirst);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const fullNote = [reasons.join("، "), note.trim()].filter(Boolean).join(" — ");
      await onSave({
        status,
        note: fullNote,
        follow_up_at: closed ? null : followTime(follow, custom),
        ...(status === "reservation" && Number(deal) > 0 ? { deal_value: Number(deal) } : {}),
      });
    } catch (e) {
      setErr((e as Error).message || tx.network);
      setBusy(false);
    }
  };

  const big = (active: boolean, tone: string) =>
    `flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 px-2 py-4 text-sm font-bold transition active:scale-[0.98] ${
      active ? tone : "border-slate-200 bg-white text-slate-700"
    }`;

  const follows: { id: FollowPick; label: string }[] = [
    { id: "1h", label: tx.inHour },
    { id: "3h", label: tx.in3Hours },
    { id: "tonight", label: tx.tonight },
    { id: "tomorrow", label: tx.tomorrow },
    { id: "custom", label: tx.custom },
    { id: "none", label: tx.noReminder },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-[2rem] bg-white px-5 pb-8 pt-3 shadow-panel">
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-slate-200" />
        <p dir="auto" className="text-center text-sm text-slate-500">{lead.full_name || tx.unnamed}</p>
        <h2 className="mt-1 text-center text-lg font-bold">{tx.whatHappened}</h2>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <button onClick={() => pickCall("answered")} className={big(call === "answered", "border-emerald-500 bg-emerald-50 text-emerald-800")}>
            <span className="text-2xl">✅</span>
            {tx.answered}
          </button>
          <button onClick={() => pickCall("no_answer")} className={big(call === "no_answer", "border-orange-500 bg-orange-50 text-orange-800")}>
            <span className="text-2xl">📵</span>
            {tx.noAnswer}
          </button>
          <button onClick={() => pickCall("unreachable")} className={big(call === "unreachable", "border-stone-500 bg-stone-100 text-stone-800")}>
            <span className="text-2xl">⛔</span>
            {tx.phoneOff}
          </button>
        </div>

        {call === "answered" && (
          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tx.result}</h3>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <button onClick={() => pickResult("qualified")} className={big(result === "qualified", "border-violet-500 bg-violet-50 text-violet-800")}>
                <span className="text-xl">⭐</span>
                {tx.qualified}
              </button>
              <button onClick={() => pickResult("disqualified")} className={big(result === "disqualified", "border-red-500 bg-red-50 text-red-800")}>
                <span className="text-xl">✖️</span>
                {tx.notQualified}
              </button>
              <button onClick={() => pickResult("contacted")} className={big(result === "contacted", "border-sky-500 bg-sky-50 text-sky-800")}>
                <span className="text-xl">🔁</span>
                {tx.followUpNeeded}
              </button>
            </div>
            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">{tx.moreStages}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {LATER_STAGES.map((s) => {
                const st = STAGE_BY_STATUS[s];
                return (
                  <button
                    key={s}
                    onClick={() => pickResult(s)}
                    className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${result === s ? st.color : "border-slate-200 bg-white text-slate-600"}`}
                  >
                    {stageName(s, lang)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {result === "disqualified" && (
          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tx.why}</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {tx.reasons.map((r) => {
                const on = reasons.includes(r);
                return (
                  <button
                    key={r}
                    onClick={() => setReasons(on ? reasons.filter((x) => x !== r) : [...reasons, r])}
                    className={`rounded-full border px-3 py-1.5 text-sm font-medium ${on ? "border-red-400 bg-red-50 text-red-800" : "border-slate-200 bg-white text-slate-600"}`}
                  >
                    {r}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {result === "reservation" && (
          <label className="mt-5 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tx.dealValue}</span>
            <input
              value={deal}
              onChange={(e) => setDeal(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              dir="ltr"
              className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-base outline-none focus:border-brand-500"
            />
          </label>
        )}

        {status && !closed && (
          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">⏰ {tx.callAgain}</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {follows.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFollow(f.id)}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                    follow === f.id ? "border-amber-400 bg-amber-50 text-amber-900" : "border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {follow === "custom" && (
              <input
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-base"
              />
            )}
          </div>
        )}

        {status && (
          <label className="mt-5 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tx.note}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              dir="auto"
              placeholder={tx.notePlaceholder}
              className="mt-2 w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base outline-none focus:border-brand-500 focus:bg-white"
            />
          </label>
        )}

        {err && <p className="mt-3 text-center text-sm font-medium text-red-600">{err}</p>}

        <button
          onClick={save}
          disabled={busy || !status}
          className="mt-5 w-full rounded-2xl bg-brand-600 py-4 text-base font-bold text-white shadow-raised active:scale-[0.99] disabled:opacity-40"
        >
          {busy ? tx.saving : tx.saveOutcome}
        </button>
      </div>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsScreen({
  tx,
  lang,
  agent,
  native,
  onLang,
  onBack,
  onAvailable,
  onRefreshNative,
  onLogout,
}: {
  tx: AgentText;
  lang: AgentLang;
  agent: Agent;
  native: NativeStatus | null;
  onLang: (l: AgentLang) => void;
  onBack: () => void;
  onAvailable: (v: boolean) => void;
  onRefreshNative: () => void;
  onLogout: () => void;
}) {
  // The permission screens are the system's; coming back from one is the
  // moment to look again.
  useEffect(() => {
    const id = setInterval(onRefreshNative, 1500);
    return () => clearInterval(id);
  }, [onRefreshNative]);

  const checks = useMemo(
    () =>
      native
        ? ([
            ["notifications", tx.permNotifications, native.notifications],
            ["fullscreen", tx.permFullScreen, native.fullScreen],
            ["battery", tx.permBattery, native.battery],
            ["call", tx.permCall, native.callPhone],
          ] as const)
        : [],
    [native, tx]
  );

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/95 px-2 py-2 backdrop-blur">
        <button onClick={onBack} aria-label={tx.back} className="flex h-11 w-11 items-center justify-center rounded-full text-slate-700 active:bg-slate-100">
          <svg viewBox="0 0 24 24" className="h-6 w-6 rtl:rotate-180" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-base font-bold">{tx.settings}</h1>
      </header>

      <main className="mx-auto max-w-xl space-y-3 px-4 pt-4">
        <Section title={tx.account}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p dir="auto" className="truncate font-bold">{agent.name}</p>
              <p dir="ltr" className="text-start text-sm text-slate-500">@{agent.username}</p>
            </div>
            <ShiftSwitch on={agent.available} tx={tx} onChange={onAvailable} />
          </div>
        </Section>

        {native ? (
          <Section title={tx.setup}>
            <p className="-mt-1 mb-3 text-sm text-slate-500">{tx.setupSub}</p>
            <ul className="divide-y divide-slate-100">
              {checks.map(([key, label, ok]) =>
                ok === undefined ? null : (
                  <li key={key} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="flex items-center gap-2 text-sm">
                      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] text-white ${ok ? "bg-emerald-500" : "bg-red-500"}`}>
                        {ok ? "✓" : "!"}
                      </span>
                      {label}
                    </span>
                    {ok ? (
                      <span className="text-xs font-semibold text-emerald-700">{tx.ok}</span>
                    ) : (
                      <button
                        onClick={() => bridge()?.fix(key)}
                        className="rounded-full bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        {tx.fix}
                      </button>
                    )}
                  </li>
                )
              )}
            </ul>
            <button
              onClick={() => bridge()?.testRing()}
              className="mt-3 w-full rounded-2xl border-2 border-emerald-500 py-3 text-base font-bold text-emerald-700 active:scale-[0.99]"
            >
              🔔 {tx.testRing}
            </button>
            <p className="mt-1.5 text-center text-xs text-slate-500">{tx.testRingSub}</p>
            <p className="mt-3 rounded-2xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">{tx.oemTip}</p>
          </Section>
        ) : (
          <Section title={tx.setup}>
            <p className="text-sm text-slate-600">{tx.webOnly}</p>
            <a
              href="https://github.com/Dlleni-Real-Estate/Conversions-API/releases/latest/download/dlleni-agent.apk"
              className="mt-3 flex w-full items-center justify-center rounded-2xl bg-emerald-600 py-3 text-base font-bold text-white"
            >
              ⬇ {tx.download}
            </a>
          </Section>
        )}

        <Section title={tx.language}>
          <LangToggle lang={lang} onLang={onLang} />
        </Section>

        <button onClick={onLogout} className="w-full rounded-2xl border border-red-200 bg-white py-3 text-base font-semibold text-red-600">
          {tx.logout}
        </button>
        {native?.version && (
          <p className="text-center text-xs text-slate-400">
            {tx.version} {native.version}
          </p>
        )}
      </main>
    </>
  );
}
