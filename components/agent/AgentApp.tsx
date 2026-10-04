"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { answerLabel, questionLabel, type FormDictionary } from "@/lib/labels";
import { AGENT_TEXT, type AgentLang, type AgentText } from "@/lib/agentText";
import {
  IconArrows,
  IconBattery,
  IconBell,
  IconCalendarCheck,
  IconCheck,
  IconChevron,
  IconChevronEnd,
  IconClock,
  IconFlask,
  IconGear,
  IconInbox,
  IconLanguages,
  IconList,
  IconLogOut,
  IconMaximize,
  IconNote,
  IconPhone,
  IconPhoneFilled,
  IconPhoneMissed,
  IconPhoneOff,
  IconRefresh,
  IconRepeat,
  IconSearch,
  IconSend,
  IconStar,
  IconUserX,
  IconWhatsApp,
  IconZap,
} from "./icons";

/**
 * The agent app: the screens an agent lives in all day.
 *
 * It runs in two places. Inside the Android app it is the WebView's page, and
 * the native shell does what a web page cannot - ring like a phone call while
 * the screen is locked, keep checking for leads in the background, and dial
 * directly. In a plain phone browser it works the same minus the ringing.
 * Everything native goes through `window.DlleniApp`; when that is missing the
 * page falls back to plain links.
 *
 * Design: Apple's app language. Content sits on opaque grouped cards; only the
 * floating chrome (top bar, tab bar, call bar) is glass. One indigo tint does
 * the interactive work and green means "call". Three loud moments, everything
 * else quiet: the "today" card, the waiting ring on a new lead, and the
 * result sheet's confirmation.
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
  /** Since app 1.0.2: the ring and notifications follow the app's language. */
  setLang?(lang: string): void;
  /** Since app 1.0.4: a follow-up changed; the phone re-reads them and sets its alarm. */
  refreshReminders?(): void;
};

type NativeStatus = {
  version?: string;
  notifications?: boolean;
  fullScreen?: boolean;
  battery?: boolean;
  callPhone?: boolean;
  // Since app 1.0.4
  background?: boolean;
  exactAlarms?: boolean;
  /** The phone maker's own autostart / pop-up screens: none on this phone, opened, or still to do. */
  autostart?: "na" | "opened" | "todo";
  popup?: "na" | "opened" | "todo";
  watching?: boolean;
  lastCheck?: number;
  lastError?: string;
  maker?: string;
  model?: string;
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
  is_test?: boolean;
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
type Today = { assigned: number; called: number; median_call_min: number | null };

const TOKEN_KEY = "dlleni_agent_token";
const LANG_KEY = "dlleni_agent_lang";
const CONTACT_KEY = /name|phone|email|whatsapp|رقم|الاسم|بريد|واتس/i;
/** Arabic (or any right-to-left) script, to set a mixed row's direction. */
const RTL_TEXT = /[֐-ࣿ]/;
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
    .replace(/^TEST\s*·\s*/, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

const prettyPhone = (p: string | null) => (p ? `+${p}` : "");

/** The name as shown: a test lead's "TEST ·" lives in its chip, not its name. */
const shownName = (l: { full_name: string | null }, tx: AgentText) =>
  (l.full_name || "").replace(/^TEST\s*·\s*/, "") || tx.unnamed;

function stageName(status: Status, lang: AgentLang) {
  const s = STAGE_BY_STATUS[status];
  return s ? (lang === "ar" ? s.labelAr : s.label) : status;
}

/** A stable gradient per person, so the same customer always looks the same. */
const AVATAR_GRADIENTS = [
  "from-indigo-500 to-violet-500",
  "from-sky-500 to-indigo-500",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-rose-500 to-pink-500",
  "from-fuchsia-500 to-purple-500",
  "from-cyan-500 to-sky-500",
];
function gradientFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

/** How urgent a waiting lead is: green under 5 minutes, amber under 15, then red. */
function urgency(minutes: number): { color: string; tone: string } {
  if (minutes < 5) return { color: "#34C759", tone: "text-emerald-600" };
  if (minutes < 15) return { color: "#FF9500", tone: "text-amber-600" };
  return { color: "#FF3B30", tone: "text-red-600" };
}

function Avatar({
  name,
  seed,
  size = 48,
  waitingMin,
}: {
  name: string | null;
  seed: string;
  size?: number;
  waitingMin?: number | null;
}) {
  const ring = waitingMin !== null && waitingMin !== undefined ? urgency(waitingMin) : null;
  const r = size / 2 + 4;
  const c = 2 * Math.PI * r;
  const progress = ring ? Math.min(1, (waitingMin as number) / 15) : 0;
  return (
    <div className="relative shrink-0" style={{ width: size + 12, height: size + 12 }}>
      {ring && (
        <>
          <span
            className="agent-ping absolute rounded-full"
            style={{ inset: 6, background: ring.color, opacity: 0.35 }}
            aria-hidden
          />
          <svg className="absolute inset-0 -rotate-90" viewBox={`0 0 ${size + 12} ${size + 12}`} aria-hidden>
            <circle cx={(size + 12) / 2} cy={(size + 12) / 2} r={r} fill="none" stroke="rgba(120,120,128,0.16)" strokeWidth="3" />
            <circle
              cx={(size + 12) / 2}
              cy={(size + 12) / 2}
              r={r}
              fill="none"
              stroke={ring.color}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - Math.max(0.06, progress))}
              style={{ transition: "stroke-dashoffset 600ms var(--ease), stroke 600ms var(--ease)" }}
            />
          </svg>
        </>
      )}
      <div
        className={`absolute flex items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white ${gradientFor(seed)}`}
        style={{ inset: 6, fontSize: size * 0.36 }}
      >
        {initials(name)}
      </div>
    </div>
  );
}

function StageChip({ status, lang }: { status: Status; lang: AgentLang }) {
  const s = STAGE_BY_STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--fill-3)] px-2.5 py-1 text-[12px] font-semibold text-[var(--label)]">
      <span className="h-2 w-2 rounded-full" style={{ background: s?.accent }} aria-hidden />
      {stageName(status, lang)}
    </span>
  );
}

function TestChip({ tx }: { tx: AgentText }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-800">
      <IconFlask className="h-3 w-3" strokeWidth={2.5} />
      {tx.testChip}
    </span>
  );
}

// ── The app ─────────────────────────────────────────────────────────────────

export default function AgentApp() {
  const [lang, setLangState] = useState<AgentLang>("en");
  const tx = AGENT_TEXT[lang];
  const [booted, setBooted] = useState(false);
  const [token, setToken] = useState<string>("");
  const [agent, setAgent] = useState<Agent | null>(null);

  const [screen, setScreen] = useState<"list" | "lead" | "settings" | "setup">("list");
  const [view, setView] = useState<View>("new");
  const [search, setSearch] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState({ new: 0, follow_due: 0, all: 0 });
  const [today, setToday] = useState<Today | null>(null);
  const [dict, setDict] = useState<FormDictionary | null>(null);
  const [loading, setLoading] = useState(false);

  const [leadId, setLeadId] = useState<string | null>(null);
  const [lead, setLead] = useState<Lead | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [leadDict, setLeadDict] = useState<FormDictionary | null>(null);
  const [sheetFor, setSheetFor] = useState<Lead | null>(null);

  const [toast, setToast] = useState<string | null>(null);
  const [native, setNative] = useState<NativeStatus | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const pendingCall = useRef<string | null>(null);
  const deepLinked = useRef(false);
  const autoSetup = useRef(false);

  // Language: English unless the agent chose Arabic. The whole document
  // flips, so native widgets sit on the right side too, and the native shell
  // is told so the ring and its notifications match.
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
    // Older app builds have no setLang; they simply stay in English.
    const b = bridge();
    if (b && typeof b.setLang === "function") b.setLang(lang);
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
    setTimeout(() => setToast(null), 2600);
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
      setToday(j.today || null);
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
      deepLinked.current = true;
      openLead(id, p.get("after_call") === "1");
      window.history.replaceState(null, "", "/agent");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // A phone that is not set up to ring opens on the setup steps, once per
  // launch - unless the app was opened from a ring, which wins.
  useEffect(() => {
    if (!agent || !native || autoSetup.current) return;
    autoSetup.current = true;
    if (!deepLinked.current && setupMissing(native) > 0) setScreen("setup");
  }, [agent, native]);

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
        setScreen(screen === "setup" ? "settings" : "list");
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

  const sendTestLead = async () => {
    try {
      await api("/api/agent/test-lead", {});
      flash(tx.testLeadSent);
      // In a browser nothing rings: show it in the list instead.
      if (!bridge()) {
        setView("new");
        setScreen("list");
        setTimeout(loadList, 400);
      }
    } catch (e) {
      flash((e as Error).message === "too_many_tests" ? tx.tooManyTests : tx.network);
    }
  };

  // The real path: the app is closed and the phone locked, an alarm wakes it
  // and it rings. The note stays up long enough to read while closing the app.
  const testRing = () => {
    const b = bridge();
    if (!b) return;
    b.testRing();
    setTestNote(tx.testScheduled);
    setTimeout(() => setTestNote(null), 20_000);
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

  const setupIncomplete = !!native && setupMissing(native) > 0;

  return (
    <div className="agent-app min-h-screen">
      {screen === "list" && (
        <ListScreen
          tx={tx}
          lang={lang}
          agent={agent}
          view={view}
          counts={counts}
          today={today}
          leads={leads}
          dict={dict}
          loading={loading}
          search={search}
          onSearch={setSearch}
          onOpen={(id) => openLead(id)}
          onCall={(l) => startCall(l, "phone")}
          onAvailable={setAvailable}
          onLang={setLang}
          onSetup={() => setScreen("setup")}
          onRefresh={loadList}
          setupIncomplete={setupIncomplete}
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
          onAvailable={setAvailable}
          onRefreshNative={() => setNative(nativeStatus())}
          onTestLead={sendTestLead}
          onSetup={() => setScreen("setup")}
          onTestRing={testRing}
          testNote={testNote}
          onLogout={async () => {
            await api("/api/agent/logout", {}).catch(() => {});
            signOutLocal();
          }}
        />
      )}

      {screen === "setup" && (
        <SetupScreen
          tx={tx}
          native={native}
          onBack={() => setScreen("settings")}
          onRefreshNative={() => setNative(nativeStatus())}
          onTestRing={testRing}
          testNote={testNote}
        />
      )}

      {screen !== "lead" && screen !== "setup" && (
        <TabBar
          tx={tx}
          active={screen === "settings" ? "settings" : view}
          counts={counts}
          onPick={(t) => {
            if (t === "settings") setScreen("settings");
            else {
              setView(t);
              setScreen("list");
            }
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
            // A new callback time: the phone sets its alarm for it now.
            bridge()?.refreshReminders?.();
          }}
          onDone={() => {
            setSheetFor(null);
            // Next lead: back to the list, where the next one is waiting.
            setScreen("list");
            loadList();
          }}
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 top-4 z-[70] flex justify-center px-4">
          <div className="agent-glass agent-rise flex max-w-sm items-center gap-2 rounded-full px-4 py-2.5 text-[14px] font-medium">
            <IconBell className="h-4 w-4 shrink-0 text-[var(--tint)]" />
            <span>{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chrome ──────────────────────────────────────────────────────────────────

function Splash() {
  return (
    <div className="agent-app flex min-h-screen items-center justify-center">
      <Logo />
    </div>
  );
}

function Logo({ size = 64 }: { size?: number }) {
  return (
    <div
      className="agent-mesh flex items-center justify-center text-white shadow-[0_10px_30px_rgba(79,70,229,0.35)]"
      style={{ width: size, height: size, borderRadius: size * 0.28 }}
    >
      <IconPhoneFilled className="h-1/2 w-1/2" />
    </div>
  );
}

function LangToggle({ lang, onLang }: { lang: AgentLang; onLang: (l: AgentLang) => void }) {
  return (
    <div className="inline-flex rounded-full bg-[var(--fill-3)] p-0.5 text-[13px] font-semibold">
      {(["en", "ar"] as const).map((l) => (
        <button
          key={l}
          onClick={() => onLang(l)}
          className={`agent-press rounded-full px-3.5 py-1.5 ${lang === l ? "bg-white text-[var(--label)] shadow-[var(--shadow-1)]" : "text-[var(--label-2)]"}`}
        >
          {l === "ar" ? "العربية" : "English"}
        </button>
      ))}
    </div>
  );
}

/** iOS switch, on = green. */
function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-300 ${on ? "bg-[var(--call)]" : "bg-[var(--fill)]"}`}
    >
      <span
        className="absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15)] transition-all duration-300"
        style={{ insetInlineStart: on ? 22 : 2, transitionTimingFunction: "var(--ease)" }}
      />
    </button>
  );
}

function TabBar({
  tx,
  active,
  counts,
  onPick,
}: {
  tx: AgentText;
  active: View | "settings";
  counts: { new: number; follow_due: number };
  onPick: (t: View | "settings") => void;
}) {
  const items: { id: View | "settings"; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "new", label: tx.tabNew, icon: <IconInbox className="h-[22px] w-[22px]" />, badge: counts.new },
    { id: "follow", label: tx.tabFollow, icon: <IconRepeat className="h-[22px] w-[22px]" />, badge: counts.follow_due },
    { id: "all", label: tx.tabAll, icon: <IconList className="h-[22px] w-[22px]" /> },
    { id: "settings", label: tx.settings, icon: <IconGear className="h-[22px] w-[22px]" /> },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(14px,env(safe-area-inset-bottom))]">
      <div className="agent-glass mx-auto flex max-w-md items-stretch justify-between rounded-full p-1.5">
        {items.map((it) => {
          const on = active === it.id;
          return (
            <button
              key={it.id}
              onClick={() => onPick(it.id)}
              className={`agent-press relative flex flex-1 flex-col items-center gap-0.5 rounded-full px-1 py-1.5 text-[10.5px] font-semibold ${
                on ? "bg-[var(--fill-3)] text-[var(--tint)]" : "text-[var(--label-2)]"
              }`}
            >
              {it.icon}
              <span className="truncate">{it.label}</span>
              {!!it.badge && it.badge > 0 && (
                <span className="absolute top-0.5 min-w-[18px] translate-x-[14px] rounded-full bg-[#FF3B30] px-1 text-[10px] font-bold leading-[18px] text-white rtl:-translate-x-[14px]">
                  {it.badge > 99 ? "99+" : it.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// ── Login ───────────────────────────────────────────────────────────────────

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
    <main className="agent-app relative min-h-screen overflow-hidden">
      <div className="agent-mesh absolute inset-x-0 top-0 h-[46vh] rounded-b-[40px]" aria-hidden />
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col px-5 pb-10 pt-6">
        <div className="flex justify-end">
          <div className="rounded-full bg-white/20 p-0.5 backdrop-blur">
            <LangToggle lang={lang} onLang={onLang} />
          </div>
        </div>
        <div className="agent-rise mt-10 text-center text-white">
          <div className="mx-auto w-fit rounded-[22px] bg-white/15 p-1.5 backdrop-blur">
            <Logo size={72} />
          </div>
          <h1 className="mt-5 text-[32px] font-bold leading-tight tracking-[-0.02em]">{tx.appName}</h1>
          <p className="mt-1 text-[15px] text-white/80">{tx.signInSub}</p>
        </div>

        <form onSubmit={submit} className="agent-rise mt-8 rounded-[28px] bg-white p-4 shadow-[var(--shadow-3)]" style={{ animationDelay: "80ms" }}>
          <div className="overflow-hidden rounded-[18px] bg-[var(--fill-3)]">
            <input
              value={u}
              onChange={(e) => setU(e.target.value.replace(/\s/g, ""))}
              placeholder={tx.username}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              dir="ltr"
              className="agent-hairline w-full bg-transparent px-4 py-4 text-[17px] outline-none placeholder:text-[var(--label-3)]"
            />
            <input
              value={p}
              onChange={(e) => setP(e.target.value)}
              placeholder={tx.password}
              type="password"
              autoComplete="current-password"
              dir="ltr"
              className="w-full bg-transparent px-4 py-4 text-[17px] outline-none placeholder:text-[var(--label-3)]"
            />
          </div>
          {err && <p className="mt-3 text-center text-[14px] font-medium text-[#FF3B30]">{err}</p>}
          <button
            disabled={busy || !u || !p}
            className="agent-press mt-4 w-full rounded-full bg-[var(--tint)] py-4 text-[17px] font-semibold text-white shadow-[0_8px_20px_rgba(79,70,229,0.35)] disabled:opacity-40"
          >
            {busy ? tx.signingIn : tx.signIn}
          </button>
        </form>
      </div>
    </main>
  );
}

// ── Lead list ───────────────────────────────────────────────────────────────

function ListScreen({
  tx,
  lang,
  agent,
  view,
  counts,
  today,
  leads,
  dict,
  loading,
  search,
  onSearch,
  onOpen,
  onCall,
  onAvailable,
  onLang,
  onSetup,
  onRefresh,
  setupIncomplete,
}: {
  tx: AgentText;
  lang: AgentLang;
  agent: Agent;
  view: View;
  counts: { new: number; follow_due: number; all: number };
  today: Today | null;
  leads: Lead[];
  dict: FormDictionary | null;
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
  onOpen: (id: string) => void;
  onCall: (l: Lead) => void;
  onAvailable: (v: boolean) => void;
  onLang: (l: AgentLang) => void;
  onSetup: () => void;
  onRefresh: () => void;
  setupIncomplete: boolean;
}) {
  // Re-render every 30s so waiting times and rings move on their own.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const hour = new Date().getHours();
  const title = view === "new" ? tx.titleNew : view === "follow" ? tx.titleFollow : tx.titleAll;

  return (
    <>
      <header className="sticky top-0 z-30 px-4 pt-3">
        <div className="agent-glass mx-auto flex max-w-md items-center justify-between gap-2 rounded-full py-1.5 pe-1.5 ps-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo size={32} />
            <div className="min-w-0 leading-tight">
              <p className="text-[11px] text-[var(--label-2)]">{hour < 12 ? tx.goodMorning : tx.goodEvening}</p>
              <p dir="auto" className="truncate text-[15px] font-semibold">{agent.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onAvailable(!agent.available)}
              className={`agent-press flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-2 text-[13px] font-semibold ${
                agent.available ? "bg-[#34C759]/15 text-[#248A3D]" : "bg-[var(--fill-3)] text-[var(--label-2)]"
              }`}
              aria-pressed={agent.available}
            >
              <span className="relative flex h-2 w-2">
                {agent.available && <span className="agent-ping absolute inset-0 rounded-full bg-[#34C759]" />}
                <span className={`relative h-2 w-2 rounded-full ${agent.available ? "bg-[#34C759]" : "bg-[var(--label-3)]"}`} />
              </span>
              {agent.available ? tx.onShift : tx.offShift}
            </button>
            <button
              onClick={() => onLang(lang === "ar" ? "en" : "ar")}
              aria-label={tx.language}
              className="agent-press flex h-9 w-9 items-center justify-center rounded-full bg-[var(--fill-3)] text-[13px] font-bold"
            >
              {lang === "ar" ? "EN" : "ع"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md px-4 pb-32 pt-4">
        <div className="flex items-end justify-between gap-3 px-1">
          <h1 className="text-[34px] font-bold leading-[1.1] tracking-[-0.025em]">{title}</h1>
          <button
            onClick={onRefresh}
            aria-label={tx.refresh}
            className="agent-press mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-white text-[var(--tint)] shadow-[var(--shadow-1)]"
          >
            <IconRefresh className={`h-[18px] w-[18px] ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {view === "new" && today && (
          <section className="agent-mesh agent-rise relative mt-4 overflow-hidden rounded-[28px] p-5 text-white shadow-[0_16px_40px_rgba(67,56,202,0.35)]">
            <div className="absolute -end-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl" aria-hidden />
            <div className="relative flex items-center justify-between">
              <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-white/75">{tx.today}</p>
              {today.median_call_min !== null && today.median_call_min <= 5 && (
                <span className="flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[12px] font-semibold backdrop-blur">
                  <IconZap className="h-3.5 w-3.5" /> {tx.fast}
                </span>
              )}
            </div>
            <div className="relative mt-3 grid grid-cols-3 gap-3">
              {[
                [String(counts.new), tx.waitingNow],
                [`${today.called}/${today.assigned}`, tx.calledToday],
                [today.median_call_min === null ? "—" : `${today.median_call_min}${tx.min}`, tx.medianToCall],
              ].map(([v, k]) => (
                <div key={k}>
                  <p className="text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums">{v}</p>
                  <p className="mt-1.5 text-[12px] leading-tight text-white/75">{k}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {!agent.available && (
          <div className="agent-card mt-4 flex items-start gap-3 rounded-[20px] p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-amber-100 text-amber-700">
              <IconBell className="h-5 w-5" />
            </span>
            <p className="text-[15px] leading-snug text-[var(--label-2)]">{tx.offShiftBanner}</p>
          </div>
        )}
        {setupIncomplete && (
          <button onClick={onSetup} className="agent-card agent-press mt-4 flex w-full items-center gap-3 rounded-[20px] p-4 text-start">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--tint)] text-white">
              <IconBell className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1 text-[15px] font-medium leading-snug">{tx.setupBanner}</span>
            <IconChevronEnd className="h-5 w-5 shrink-0 text-[var(--label-3)] rtl:rotate-180" />
          </button>
        )}

        <label className="mt-4 flex items-center gap-2 rounded-[12px] bg-[var(--fill-3)] px-3 py-2.5">
          <IconSearch className="h-[18px] w-[18px] shrink-0 text-[var(--label-2)]" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={tx.search}
            className="min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-[var(--label-2)]"
          />
        </label>

        {leads.length === 0 ? (
          <EmptyState tx={tx} view={view} />
        ) : (
          <ul className="mt-4 space-y-3">
            {leads.map((l, i) => (
              <LeadCard
                key={l.lead_id}
                index={i}
                tx={tx}
                lang={lang}
                lead={l}
                dict={dict}
                onOpen={() => onOpen(l.lead_id)}
                onCall={() => onCall(l)}
              />
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function EmptyState({ tx, view }: { tx: AgentText; view: View }) {
  return (
    <div className="agent-rise mt-10 flex flex-col items-center px-6 text-center">
      <div className="relative flex h-28 w-28 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-[#34C759]/10" />
        <span className="absolute inset-4 rounded-full bg-[#34C759]/15" />
        <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-[var(--call)] text-white shadow-[0_10px_24px_rgba(52,199,89,0.35)]">
          {view === "new" ? <IconCheck className="h-7 w-7" strokeWidth={2.5} /> : <IconPhoneFilled className="h-6 w-6" />}
        </span>
      </div>
      <p className="mt-5 text-[20px] font-semibold tracking-[-0.01em]">
        {view === "new" ? tx.emptyNew : view === "follow" ? tx.emptyFollow : tx.emptyAll}
      </p>
      {view === "new" && <p className="mt-1.5 max-w-xs text-[15px] text-[var(--label-2)]">{tx.emptyNewSub}</p>}
    </div>
  );
}

function LeadCard({
  index,
  tx,
  lang,
  lead,
  dict,
  onOpen,
  onCall,
}: {
  index: number;
  tx: AgentText;
  lang: AgentLang;
  lead: Lead;
  dict: FormDictionary | null;
  onOpen: () => void;
  onCall: () => void;
}) {
  const isNew = lead.status === "new";
  const waitMin = isNew && lead.assigned_at ? Math.max(0, Math.round((Date.now() - Date.parse(lead.assigned_at)) / 60_000)) : null;
  const due = lead.follow_up_at && Date.parse(lead.follow_up_at) <= Date.now();
  const preview = Object.entries(lead.raw_fields || {})
    .filter(([k, v]) => !CONTACT_KEY.test(k) && String(v ?? "").trim())
    .slice(0, 2)
    .map(([k, v]) => ({ q: questionLabel(dict, k), a: answerLabel(dict, k, v) }));

  return (
    <li className="agent-card agent-rise overflow-hidden rounded-[24px]" style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}>
      <div className="flex items-center gap-3 p-3.5">
        <button onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-start">
          <Avatar name={lead.full_name} seed={lead.lead_id} size={46} waitingMin={waitMin} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-center gap-2">
              <h3 dir="auto" className="truncate text-[17px] font-semibold tracking-[-0.02em]">{shownName(lead, tx)}</h3>
              {lead.is_test && <TestChip tx={tx} />}
            </div>
            <p className="mt-0.5 truncate text-[13px] text-[var(--label-2)]">
              {waitMin !== null ? (
                <span className={`font-semibold ${urgency(waitMin).tone}`}>
                  {tx.waiting} {ago(lead.assigned_at, tx)}
                </span>
              ) : (
                <>
                  {tx.assigned} {ago(lead.assigned_at, tx)}
                </>
              )}
              {lead.campaign_name ? ` · ${lead.campaign_name}` : ""}
            </p>
            {preview.length > 0 && (
              <dl className="mt-2 space-y-0.5">
                {/* The row takes the question's direction, so an Arabic
                    question and its answer read in order in an English card. */}
                {preview.map((p) => (
                  <div key={p.q} dir={RTL_TEXT.test(p.q) ? "rtl" : "ltr"} className="text-start text-[13px] leading-snug">
                    <dt className="inline text-[var(--label-2)]">
                      <bdi>{p.q}</bdi>:{" "}
                    </dt>
                    <dd className="inline font-semibold">
                      <bdi>{p.a}</bdi>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <StageChip status={lead.status} lang={lang} />
              {lead.follow_up_at && !isNew && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${
                    due ? "bg-amber-100 text-amber-800" : "bg-[var(--fill-3)] text-[var(--label-2)]"
                  }`}
                >
                  <IconClock className="h-3.5 w-3.5" />
                  {when(lead.follow_up_at, lang)}
                </span>
              )}
              {!!lead.call_count && <span className="text-[12px] text-[var(--label-2)]">{tx.calls(lead.call_count)}</span>}
            </div>
          </div>
        </button>
        {lead.phone && (
          <button
            onClick={onCall}
            aria-label={tx.call}
            className="agent-press flex h-[52px] w-[52px] shrink-0 items-center justify-center self-center rounded-full bg-[var(--call)] text-white shadow-[0_8px_18px_rgba(52,199,89,0.35)]"
          >
            <IconPhoneFilled className="h-6 w-6" />
          </button>
        )}
      </div>
    </li>
  );
}

// ── One lead ────────────────────────────────────────────────────────────────

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="px-4 text-[13px] font-semibold uppercase tracking-[0.04em] text-[var(--label-2)]">{title}</h2>
      <div className="agent-card mt-2 overflow-hidden rounded-[20px]">{children}</div>
    </section>
  );
}

function NoteIcon({ n }: { n: Note }) {
  const base = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full";
  if (n.kind === "call") return <span className={`${base} bg-[#34C759]/15 text-[#248A3D]`}>{n.body === "whatsapp" ? <IconWhatsApp className="h-4 w-4" /> : <IconPhone className="h-4 w-4" />}</span>;
  if (n.kind === "assign") return <span className={`${base} bg-[var(--tint)]/10 text-[var(--tint)]`}><IconArrows className="h-4 w-4" /></span>;
  if (n.kind === "stage" && n.to_status) {
    const c = STAGE_BY_STATUS[n.to_status]?.accent ?? "#8E8E93";
    return (
      <span className={base} style={{ background: `${c}22`, color: c }}>
        <IconCalendarCheck className="h-4 w-4" />
      </span>
    );
  }
  return <span className={`${base} bg-[var(--fill-3)] text-[var(--label-2)]`}><IconNote className="h-4 w-4" /></span>;
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
  const waitMin =
    lead && lead.status === "new" && lead.assigned_at ? Math.max(0, Math.round((Date.now() - Date.parse(lead.assigned_at)) / 60_000)) : null;

  return (
    <>
      <header className="sticky top-0 z-30 px-4 pt-3">
        <div className="agent-glass mx-auto flex max-w-md items-center gap-1 rounded-full p-1.5">
          <button onClick={onBack} aria-label={tx.back} className="agent-press flex h-10 w-10 items-center justify-center rounded-full text-[var(--tint)]">
            <IconChevron className="h-6 w-6 rtl:rotate-180" strokeWidth={2.4} />
          </button>
          <h1 dir="auto" className="min-w-0 flex-1 truncate pe-3 text-[16px] font-semibold">{lead ? shownName(lead, tx) : ""}</h1>
        </div>
      </header>

      {!lead ? (
        <div className="flex justify-center py-24">
          <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[var(--fill)] border-t-[var(--tint)]" />
        </div>
      ) : (
        <main className="mx-auto max-w-md px-4 pb-36 pt-6">
          <section className="agent-rise flex flex-col items-center text-center">
            <Avatar name={lead.full_name} seed={lead.lead_id} size={84} waitingMin={waitMin} />
            <h2 dir="auto" className="mt-3 text-[26px] font-bold leading-tight tracking-[-0.02em]">{shownName(lead, tx)}</h2>
            <p dir="ltr" className="mt-1 text-[17px] tabular-nums text-[var(--label-2)]">{prettyPhone(lead.phone)}</p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
              <StageChip status={lead.status} lang={lang} />
              {lead.is_test && <TestChip tx={tx} />}
              <span className={`text-[13px] ${waitMin !== null ? `font-semibold ${urgency(waitMin).tone}` : "text-[var(--label-2)]"}`}>
                {lead.status === "new" ? tx.waiting : tx.assigned} {ago(lead.assigned_at, tx)}
              </span>
              <span className="text-[13px] text-[var(--label-2)]">· {lead.call_count ? tx.calls(lead.call_count) : tx.neverCalled}</span>
            </div>
          </section>

          {/* Quick actions, Contacts-style: three equal tiles. */}
          <div className="agent-rise mt-5 grid grid-cols-3 gap-2.5" style={{ animationDelay: "60ms" }}>
            {[
              { k: "call", label: tx.call, icon: <IconPhoneFilled className="h-6 w-6" />, on: () => onCall(lead), tone: "bg-[var(--call)] text-white shadow-[0_8px_18px_rgba(52,199,89,0.3)]" },
              { k: "wa", label: tx.whatsapp, icon: <IconWhatsApp className="h-6 w-6" />, on: () => onWhatsapp(lead), tone: "agent-card text-[#25D366]" },
              { k: "res", label: tx.logOutcome, icon: <IconCheck className="h-6 w-6" strokeWidth={2.5} />, on: () => onOutcome(lead), tone: "agent-card text-[var(--tint)]" },
            ].map((a) => (
              <button
                key={a.k}
                onClick={a.on}
                disabled={a.k !== "res" && !lead.phone}
                className={`agent-press flex flex-col items-center gap-1.5 rounded-[20px] px-2 py-3.5 disabled:opacity-40 ${a.tone}`}
              >
                {a.icon}
                <span className={`text-[12px] font-semibold leading-tight ${a.k === "call" ? "text-white" : "text-[var(--label)]"}`}>{a.label}</span>
              </button>
            ))}
          </div>

          {lead.follow_up_at && (
            <div
              className={`agent-rise mt-4 flex items-center gap-3 rounded-[20px] p-4 ${
                Date.parse(lead.follow_up_at) <= Date.now() ? "bg-amber-100 text-amber-900" : "agent-card"
              }`}
            >
              <IconClock className="h-5 w-5 shrink-0" />
              <div className="min-w-0 text-[15px]">
                <p className="font-semibold">{Date.parse(lead.follow_up_at) <= Date.now() ? tx.followDue : tx.followUp}</p>
                <p className="opacity-75">{when(lead.follow_up_at, lang)}</p>
              </div>
            </div>
          )}

          {Object.keys(lead.raw_fields || {}).length > 0 && (
            <Group title={tx.formAnswers}>
              <dl>
                {Object.entries(lead.raw_fields || {}).map(([k, v], i, all) => (
                  <div key={k} className={`px-4 py-3 ${i < all.length - 1 ? "agent-hairline" : ""}`}>
                    <dt dir="auto" className="text-[13px] text-[var(--label-2)]">{questionLabel(dict, k)}</dt>
                    <dd dir="auto" className="mt-0.5 text-[17px] font-semibold tracking-[-0.01em]">{answerLabel(dict, k, v)}</dd>
                  </div>
                ))}
              </dl>
            </Group>
          )}

          <Group title={tx.history}>
            <div className="agent-hairline flex items-center gap-2 p-3">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={tx.addNote}
                dir="auto"
                className="min-w-0 flex-1 rounded-full bg-[var(--fill-3)] px-4 py-2.5 text-[16px] outline-none placeholder:text-[var(--label-3)]"
              />
              <button
                disabled={!note.trim() || saving}
                aria-label={tx.save}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await onNote(note.trim());
                    setNote("");
                  } finally {
                    setSaving(false);
                  }
                }}
                className="agent-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--tint)] text-white disabled:opacity-30"
              >
                <IconSend className="h-[18px] w-[18px] rtl:-scale-x-100" />
              </button>
            </div>
            <ol className="px-4 py-2">
              {notes.map((n, i) => (
                <li key={n.id} className="relative flex gap-3 py-2.5">
                  {i < notes.length - 1 && <span className="absolute bottom-0 start-4 top-11 w-px bg-[var(--separator)]" aria-hidden />}
                  <NoteIcon n={n} />
                  <div className="min-w-0 flex-1 pt-1">
                    {n.kind === "stage" && n.to_status && (
                      <p className="text-[15px]">
                        {n.from_status && (
                          <span className="text-[var(--label-2)]">
                            {stageName(n.from_status, lang)} {lang === "ar" ? "←" : "→"}{" "}
                          </span>
                        )}
                        <span className="font-semibold">{stageName(n.to_status, lang)}</span>
                      </p>
                    )}
                    {n.kind === "call" && <p className="text-[15px] font-medium">{n.body === "whatsapp" ? tx.timelineWhatsapp : tx.timelineCall}</p>}
                    {n.kind === "assign" && n.body && (
                      <p className="text-[15px]">
                        {tx.timelineAssign} <bdi className="font-semibold">{n.body}</bdi>
                      </p>
                    )}
                    {n.body && (n.kind === "note" || n.kind === "stage") && (
                      <p dir="auto" className="mt-0.5 whitespace-pre-wrap text-[15px] leading-snug">{n.body}</p>
                    )}
                    <p className="mt-0.5 text-[12px] text-[var(--label-2)]">
                      {when(n.created_at, lang)}
                      {n.author && n.kind !== "assign" ? <bdi> · {n.author}</bdi> : null}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Group>

          <Group title={tx.source}>
            <dl>
              {[
                [tx.campaign, lead.campaign_name],
                [tx.ad, lead.ad_name],
                [tx.form, lead.form_name],
                [tx.platform, lead.platform],
              ].map(([k, v], i) => (
                <div key={k as string} className={`flex justify-between gap-4 px-4 py-3 text-[15px] ${i < 3 ? "agent-hairline" : ""}`}>
                  <dt className="shrink-0 text-[var(--label-2)]">{k}</dt>
                  <dd dir="auto" className="min-w-0 truncate text-end font-medium">{v || "—"}</dd>
                </div>
              ))}
            </dl>
          </Group>
        </main>
      )}

      {/* The call bar: always under the thumb on a lead. */}
      {lead && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(14px,env(safe-area-inset-bottom))]">
          <div className="agent-glass mx-auto flex max-w-md gap-2 rounded-full p-1.5">
            {lead.phone && (
              <button
                onClick={() => onCall(lead)}
                className="agent-press flex flex-1 items-center justify-center gap-2 rounded-full bg-[var(--call)] py-3.5 text-[17px] font-semibold text-white"
              >
                <IconPhoneFilled className="h-5 w-5" /> {tx.callNow}
              </button>
            )}
            <button
              onClick={() => onOutcome(lead)}
              className="agent-press flex flex-1 items-center justify-center gap-2 rounded-full bg-[var(--tint)] py-3.5 text-[17px] font-semibold text-white"
            >
              <IconCheck className="h-5 w-5" strokeWidth={2.5} /> {tx.logOutcome}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── After the call ──────────────────────────────────────────────────────────

type CallResult = "answered" | "no_answer" | "unreachable";
type FollowPick = "none" | "15m" | "30m" | "1h" | "2h" | "tonight" | "tomorrow" | "custom";

const FOLLOW_MINUTES: Partial<Record<FollowPick, number>> = { "15m": 15, "30m": 30, "1h": 60, "2h": 120 };

function followTime(pick: FollowPick, custom: string): string | null {
  const d = new Date();
  const mins = FOLLOW_MINUTES[pick];
  if (mins) return new Date(Date.now() + mins * 60_000).toISOString();
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

/** A big choice tile: tinted and checked when picked, quiet otherwise. */
function Tile({
  on,
  color,
  icon,
  label,
  onClick,
}: {
  on: boolean;
  color: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="agent-press relative flex flex-col items-center justify-center gap-2 rounded-[20px] px-2 py-4 text-[14px] font-semibold"
      style={{
        background: on ? `${color}1F` : "var(--fill-3)",
        color: on ? color : "var(--label)",
        boxShadow: on ? `inset 0 0 0 2px ${color}` : "none",
      }}
    >
      <span
        className="flex h-11 w-11 items-center justify-center rounded-full text-white"
        style={{ background: on ? color : "rgba(120,120,128,0.32)" }}
      >
        {icon}
      </span>
      <span className="leading-tight">{label}</span>
      {on && (
        <span className="agent-pop absolute end-2 top-2 flex h-5 w-5 items-center justify-center rounded-full text-white" style={{ background: color }}>
          <IconCheck className="h-3 w-3" strokeWidth={3.5} />
        </span>
      )}
    </button>
  );
}

function Chip({ on, onClick, children, tone = "var(--tint)" }: { on: boolean; onClick: () => void; children: React.ReactNode; tone?: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="agent-press rounded-full px-3.5 py-2 text-[14px] font-medium"
      style={{
        background: on ? `${tone}1F` : "var(--fill-3)",
        color: on ? tone : "var(--label)",
        boxShadow: on ? `inset 0 0 0 1.5px ${tone}` : "none",
      }}
    >
      {children}
    </button>
  );
}

function OutcomeSheet({
  tx,
  lang,
  lead,
  onClose,
  onSave,
  onDone,
}: {
  tx: AgentText;
  lang: AgentLang;
  lead: Lead;
  onClose: () => void;
  onSave: (p: { status: Status; note: string; follow_up_at: string | null; deal_value?: number }) => Promise<void>;
  onDone: () => void;
}) {
  const [call, setCall] = useState<CallResult | null>(null);
  const [result, setResult] = useState<Status | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [follow, setFollow] = useState<FollowPick>("none");
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [deal, setDeal] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Sensible reminders, so the common case is one tap: an unanswered call is
  // tried again in half an hour, a switched-off phone in two, an interested
  // lead that needs time tomorrow. At that time the phone rings like a call.
  const pickCall = (c: CallResult) => {
    setCall(c);
    setResult(null);
    setFollow(c === "no_answer" ? "30m" : c === "unreachable" ? "2h" : "none");
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
      const fullNote = [reasons.join(lang === "ar" ? "، " : ", "), note.trim()].filter(Boolean).join(" — ");
      await onSave({
        status,
        note: fullNote,
        follow_up_at: closed ? null : followTime(follow, custom),
        ...(status === "reservation" && Number(deal) > 0 ? { deal_value: Number(deal) } : {}),
      });
      setDone(true);
      setTimeout(onDone, 900);
    } catch (e) {
      setErr((e as Error).message || tx.network);
      setBusy(false);
    }
  };

  const follows: { id: FollowPick; label: string }[] = [
    { id: "15m", label: tx.in15 },
    { id: "30m", label: tx.in30 },
    { id: "1h", label: tx.inHour },
    { id: "2h", label: tx.in2Hours },
    { id: "tonight", label: tx.tonight },
    { id: "tomorrow", label: tx.tomorrow },
    { id: "custom", label: tx.custom },
    { id: "none", label: tx.noReminder },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="agent-fade absolute inset-0 bg-black/40" onClick={() => !busy && onClose()} />
      <div className="agent-sheet relative flex max-h-[92vh] w-full max-w-md flex-col rounded-t-[32px] bg-white shadow-[var(--shadow-3)]">
        {done ? (
          <div className="flex flex-col items-center justify-center px-6 py-16">
            <span className="agent-pop flex h-20 w-20 items-center justify-center rounded-full bg-[var(--call)] text-white shadow-[0_12px_28px_rgba(52,199,89,0.4)]">
              <svg viewBox="0 0 24 24" className="agent-check h-10 w-10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <p className="agent-rise mt-5 text-[22px] font-bold" style={{ animationDelay: "200ms" }}>{tx.saved.replace(/\s*✓$/, "")}</p>
            {status && (
              <p className="agent-rise mt-1 text-[15px] text-[var(--label-2)]" style={{ animationDelay: "260ms" }}>
                {stageName(status, lang)}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="px-5 pt-2.5">
              <div className="mx-auto h-1.5 w-10 rounded-full bg-[var(--fill)]" />
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p dir="auto" className="truncate text-[13px] text-[var(--label-2)]">{shownName(lead, tx)}</p>
                  <h2 className="text-[22px] font-bold tracking-[-0.02em]">{tx.whatHappened}</h2>
                </div>
                <button onClick={onClose} aria-label={tx.back} className="agent-press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--fill-3)] text-[var(--label-2)]">
                  <IconChevron className="h-5 w-5 -rotate-90" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-4">
              <p className="mt-4 text-[13px] font-semibold text-[var(--label-2)]">{tx.step1}</p>
              <div className="mt-2 grid grid-cols-3 gap-2.5">
                <Tile on={call === "answered"} color="#34C759" icon={<IconPhone className="h-5 w-5" />} label={tx.answered} onClick={() => pickCall("answered")} />
                <Tile on={call === "no_answer"} color="#FF9500" icon={<IconPhoneMissed className="h-5 w-5" />} label={tx.noAnswer} onClick={() => pickCall("no_answer")} />
                <Tile on={call === "unreachable"} color="#8E8E93" icon={<IconPhoneOff className="h-5 w-5" />} label={tx.phoneOff} onClick={() => pickCall("unreachable")} />
              </div>

              {call === "answered" && (
                <div className="agent-rise">
                  <p className="mt-5 text-[13px] font-semibold text-[var(--label-2)]">{tx.step2}</p>
                  <div className="mt-2 grid grid-cols-3 gap-2.5">
                    <Tile on={result === "qualified"} color="#7C3AED" icon={<IconStar className="h-5 w-5" />} label={tx.qualified} onClick={() => pickResult("qualified")} />
                    <Tile on={result === "disqualified"} color="#FF3B30" icon={<IconUserX className="h-5 w-5" />} label={tx.notQualified} onClick={() => pickResult("disqualified")} />
                    <Tile on={result === "contacted"} color="#0EA5E9" icon={<IconRepeat className="h-5 w-5" />} label={tx.followUpNeeded} onClick={() => pickResult("contacted")} />
                  </div>
                  <p className="mt-4 text-[12px] font-semibold uppercase tracking-[0.04em] text-[var(--label-3)]">{tx.moreStages}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {LATER_STAGES.map((s) => (
                      <Chip key={s} on={result === s} onClick={() => pickResult(s)} tone={STAGE_BY_STATUS[s].accent}>
                        {stageName(s, lang)}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              {result === "disqualified" && (
                <div className="agent-rise">
                  <p className="mt-5 text-[13px] font-semibold text-[var(--label-2)]">{tx.why}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {tx.reasons.map((r) => (
                      <Chip key={r} on={reasons.includes(r)} tone="#FF3B30" onClick={() => setReasons(reasons.includes(r) ? reasons.filter((x) => x !== r) : [...reasons, r])}>
                        {r}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              {result === "reservation" && (
                <label className="agent-rise mt-5 block">
                  <span className="text-[13px] font-semibold text-[var(--label-2)]">{tx.dealValue}</span>
                  <input
                    value={deal}
                    onChange={(e) => setDeal(e.target.value.replace(/[^\d]/g, ""))}
                    inputMode="numeric"
                    dir="ltr"
                    className="mt-2 w-full rounded-[14px] bg-[var(--fill-3)] px-4 py-3.5 text-[17px] outline-none"
                  />
                </label>
              )}

              {status && (
                <div className="agent-rise">
                  {!closed && (
                    <>
                      <p className="mt-5 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--label-2)]">
                        <IconClock className="h-4 w-4" /> {tx.step3}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {follows.map((f) => (
                          <Chip key={f.id} on={follow === f.id} tone="#D97706" onClick={() => setFollow(f.id)}>
                            {f.label}
                          </Chip>
                        ))}
                      </div>
                      {follow === "custom" && (
                        <input
                          type="datetime-local"
                          value={custom}
                          onChange={(e) => setCustom(e.target.value)}
                          className="mt-2 w-full rounded-[14px] bg-[var(--fill-3)] px-4 py-3 text-[16px]"
                        />
                      )}
                      {follow !== "none" && (
                        <p className="agent-rise mt-2 flex items-start gap-1.5 text-[13px] leading-snug text-[var(--label-2)]">
                          <IconBell className="mt-px h-3.5 w-3.5 shrink-0 text-[#D97706]" />
                          {tx.callbackHint}
                        </p>
                      )}
                    </>
                  )}
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    dir="auto"
                    placeholder={tx.notePlaceholder}
                    className="mt-4 w-full resize-none rounded-[18px] bg-[var(--fill-3)] px-4 py-3 text-[16px] outline-none placeholder:text-[var(--label-3)] focus:bg-white focus:shadow-[inset_0_0_0_1.5px_var(--tint)]"
                  />
                </div>
              )}
              {err && <p className="mt-3 text-center text-[14px] font-medium text-[#FF3B30]">{err}</p>}
            </div>

            <div className="agent-hairline border-t-0 px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 shadow-[0_-0.5px_0_var(--separator)]">
              <button
                onClick={save}
                disabled={busy || !status}
                className="agent-press w-full rounded-full bg-[var(--tint)] py-4 text-[17px] font-semibold text-white shadow-[0_8px_20px_rgba(79,70,229,0.3)] disabled:opacity-35 disabled:shadow-none"
              >
                {busy ? tx.saving : tx.saveOutcome}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

/** An iOS settings row: a coloured icon square, a label, and what's on the end. */
function Row({
  icon,
  color,
  label,
  sub,
  end,
  onClick,
  last,
}: {
  icon: React.ReactNode;
  color: string;
  label: string;
  sub?: string;
  end?: React.ReactNode;
  onClick?: () => void;
  last?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={`flex w-full items-center gap-3 px-4 py-3 text-start ${onClick ? "agent-row" : ""}`}>
      <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] text-white" style={{ background: color }}>
        {icon}
      </span>
      <span className={`flex min-w-0 flex-1 items-center gap-3 self-stretch ${last ? "" : "agent-hairline -mb-3 pb-3"}`}>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] tracking-[-0.02em]">{label}</span>
          {sub && <span className="mt-0.5 block text-[13px] leading-snug text-[var(--label-2)]">{sub}</span>}
        </span>
        {end}
      </span>
    </Tag>
  );
}

function SettingsScreen({
  tx,
  lang,
  agent,
  native,
  onLang,
  onAvailable,
  onRefreshNative,
  onTestLead,
  onSetup,
  onTestRing,
  testNote,
  onLogout,
}: {
  tx: AgentText;
  lang: AgentLang;
  agent: Agent;
  native: NativeStatus | null;
  onLang: (l: AgentLang) => void;
  onAvailable: (v: boolean) => void;
  onRefreshNative: () => void;
  onTestLead: () => void;
  onSetup: () => void;
  onTestRing: () => void;
  testNote: string | null;
  onLogout: () => void;
}) {
  // The permission screens are the system's; coming back from one is the
  // moment to look again.
  useEffect(() => {
    const id = setInterval(onRefreshNative, 1500);
    return () => clearInterval(id);
  }, [onRefreshNative]);

  const steps = setupSteps(native, tx).filter((st) => !st.optional);
  const stepsDone = steps.filter((st) => st.done).length;

  return (
    <main className="mx-auto max-w-md px-4 pb-32 pt-6">
      <h1 className="px-1 text-[34px] font-bold leading-[1.1] tracking-[-0.025em]">{tx.settings}</h1>

      <section className="agent-card agent-rise mt-4 flex items-center gap-4 rounded-[24px] p-4">
        <Avatar name={agent.name} seed={agent.id} size={52} />
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate text-[20px] font-semibold tracking-[-0.02em]">{agent.name}</p>
          <p dir="ltr" className="text-start text-[15px] text-[var(--label-2)]">@{agent.username}</p>
        </div>
      </section>

      <Group title={tx.profile}>
        <Row
          icon={<IconZap className="h-[18px] w-[18px]" />}
          color="#34C759"
          label={agent.available ? tx.onShift : tx.offShift}
          end={<Switch on={agent.available} onChange={onAvailable} label={tx.onShift} />}
        />
        <Row
          icon={<IconLanguages className="h-[18px] w-[18px]" />}
          color="#5856D6"
          label={tx.language}
          end={<LangToggle lang={lang} onLang={onLang} />}
          last
        />
      </Group>

      {native ? (
        <Group title={tx.ringSettings}>
          <Row
            icon={<IconBell className="h-[18px] w-[18px]" />}
            color={stepsDone === steps.length ? "#34C759" : "#FF3B30"}
            label={tx.phoneSetup}
            sub={stepsDone === steps.length ? tx.setupReady : tx.setupProgress(stepsDone, steps.length)}
            onClick={onSetup}
            end={<IconChevronEnd className="h-5 w-5 text-[var(--label-3)] rtl:rotate-180" />}
          />
          <Row
            icon={<IconPhoneFilled className="h-[18px] w-[18px]" />}
            color="#FF9500"
            label={tx.testRing}
            sub={testNote || tx.testRingSub}
            onClick={onTestRing}
            end={<IconChevronEnd className="h-5 w-5 text-[var(--label-3)] rtl:rotate-180" />}
            last
          />
        </Group>
      ) : (
        <Group title={tx.ringSettings}>
          <div className="p-4">
            <p className="text-[15px] leading-snug text-[var(--label-2)]">{tx.webOnly}</p>
            <a
              href="https://github.com/Dlleni-Real-Estate/Conversions-API/releases/latest/download/dlleni-agent.apk"
              className="agent-press mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-[var(--call)] py-3.5 text-[17px] font-semibold text-white"
            >
              {tx.download}
            </a>
          </div>
        </Group>
      )}

      <Group title={tx.testing}>
        <Row
          icon={<IconFlask className="h-[18px] w-[18px]" />}
          color="#AF52DE"
          label={tx.testLead}
          sub={tx.testLeadSub}
          onClick={onTestLead}
          end={<IconChevronEnd className="h-5 w-5 text-[var(--label-3)] rtl:rotate-180" />}
          last
        />
      </Group>

      <div className="agent-card mt-6 overflow-hidden rounded-[20px]">
        <Row icon={<IconLogOut className="h-[18px] w-[18px]" />} color="#FF3B30" label={tx.logout} onClick={onLogout} last />
      </div>

      {native?.version && (
        <p className="mt-4 text-center text-[13px] text-[var(--label-3)]">
          {tx.version} {native.version}
        </p>
      )}
    </main>
  );
}

// ── Phone setup ─────────────────────────────────────────────────────────────

type SetupStep = {
  key: string;
  title: string;
  sub: string;
  done: boolean;
  /** A phone maker's screen we cannot read back: done means "opened once". */
  opened?: boolean;
  optional?: boolean;
  color: string;
  icon: React.ReactNode;
};

const titleCase = (v?: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : "");

/**
 * What stands between this phone and a ring, in the order to fix it. Only the
 * steps this phone has: no autostart row on a Pixel or a Samsung, no pop-up
 * row anywhere but Xiaomi, and nothing an older app build cannot report.
 */
function setupSteps(native: NativeStatus | null, tx: AgentText): SetupStep[] {
  if (!native) return [];
  const icon = "h-[18px] w-[18px]";
  const steps: SetupStep[] = [
    { key: "notifications", title: tx.stepNotifications, sub: tx.stepNotificationsSub, done: !!native.notifications, color: "#FF3B30", icon: <IconBell className={icon} /> },
  ];
  if (native.fullScreen !== undefined) {
    steps.push({ key: "fullscreen", title: tx.stepFullScreen, sub: tx.stepFullScreenSub, done: native.fullScreen !== false, color: "#5856D6", icon: <IconMaximize className={icon} /> });
  }
  steps.push({ key: "battery", title: tx.stepBattery, sub: tx.stepBatterySub, done: !!native.battery, color: "#34C759", icon: <IconBattery className={icon} /> });
  if (native.background === false) {
    steps.push({ key: "background", title: tx.stepBackground, sub: tx.stepBackgroundSub, done: false, color: "#FF9500", icon: <IconBattery className={icon} /> });
  }
  if (native.autostart && native.autostart !== "na") {
    const opened = native.autostart === "opened";
    steps.push({ key: "autostart", title: tx.stepAutostart, sub: tx.stepAutostartSub(titleCase(native.maker)), done: opened, opened, color: "#007AFF", icon: <IconZap className={icon} /> });
  }
  if (native.popup && native.popup !== "na") {
    const opened = native.popup === "opened";
    steps.push({ key: "popup", title: tx.stepPopup, sub: tx.stepPopupSub, done: opened, opened, color: "#AF52DE", icon: <IconMaximize className={icon} /> });
  }
  if (native.exactAlarms !== undefined) {
    steps.push({ key: "exact", title: tx.stepExact, sub: tx.stepExactSub, done: !!native.exactAlarms, color: "#FF9500", icon: <IconClock className={icon} /> });
  }
  if (native.callPhone !== undefined) {
    steps.push({ key: "call", title: tx.stepCall, sub: tx.stepCallSub, done: !!native.callPhone, optional: true, color: "#007AFF", icon: <IconPhone className={icon} /> });
  }
  return steps;
}

/** How many required steps are still open (labels do not matter for counting). */
function setupMissing(native: NativeStatus | null): number {
  return setupSteps(native, AGENT_TEXT.en).filter((st) => !st.optional && !st.done).length;
}

function SetupScreen({
  tx,
  native,
  onBack,
  onRefreshNative,
  onTestRing,
  testNote,
}: {
  tx: AgentText;
  native: NativeStatus | null;
  onBack: () => void;
  onRefreshNative: () => void;
  onTestRing: () => void;
  testNote: string | null;
}) {
  // Each step opens one of the phone's own settings screens; coming back from
  // it is the moment to look again.
  useEffect(() => {
    const id = setInterval(onRefreshNative, 1500);
    return () => clearInterval(id);
  }, [onRefreshNative]);

  const steps = setupSteps(native, tx);
  const required = steps.filter((st) => !st.optional);
  const done = required.filter((st) => st.done).length;
  const ready = required.length > 0 && done === required.length;
  const oem = !!native?.autostart && native.autostart !== "na";

  const last = native?.lastCheck ? Math.round((Date.now() - native.lastCheck) / 1000) : null;
  const trouble = !!native?.watching && !!native.lastError && (last === null || last > 120);

  return (
    <main className="mx-auto max-w-md px-4 pb-16 pt-4">
      <button onClick={onBack} aria-label={tx.back} className="agent-press -ms-1 flex h-10 w-10 items-center justify-center rounded-full text-[var(--tint)]">
        <IconChevron className="h-6 w-6 rtl:rotate-180" strokeWidth={2.4} />
      </button>
      <h1 className="mt-1 px-1 text-[34px] font-bold leading-[1.1] tracking-[-0.025em]">{tx.phoneSetup}</h1>
      <p className="mt-1.5 px-1 text-[15px] leading-snug text-[var(--label-2)]">{tx.phoneSetupSub}</p>

      <div className="mt-4 px-1">
        <div className="h-2 overflow-hidden rounded-full bg-[var(--fill-3)]">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${required.length ? (100 * done) / required.length : 0}%`, background: ready ? "var(--call)" : "var(--tint)", transitionTimingFunction: "var(--ease)" }}
          />
        </div>
        <p className="mt-1.5 text-[13px] font-semibold text-[var(--label-2)]">{tx.setupProgress(done, required.length)}</p>
      </div>

      <div className="agent-card mt-4 overflow-hidden rounded-[20px]">
        {steps.map((st, i) => (
          <Row
            key={st.key}
            icon={st.icon}
            color={st.color}
            label={st.title}
            sub={st.sub}
            onClick={st.done && !st.opened ? undefined : () => bridge()?.fix(st.key)}
            last={i === steps.length - 1}
            end={
              st.done && !st.opened ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#34C759] text-white">
                  <IconCheck className="h-3.5 w-3.5" strokeWidth={3.5} />
                </span>
              ) : st.opened ? (
                <span className="shrink-0 rounded-full bg-[var(--fill-3)] px-3 py-1.5 text-[13px] font-semibold text-[var(--label-2)]">{tx.opened}</span>
              ) : (
                <span className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-semibold ${st.optional ? "bg-[var(--fill-3)] text-[var(--tint)]" : "bg-[var(--tint)] text-white"}`}>
                  {st.key === "autostart" || st.key === "popup" ? tx.open : tx.fix}
                </span>
              )
            }
          />
        ))}
      </div>
      {oem && <p className="mt-3 px-4 text-[13px] leading-snug text-[var(--label-2)]">{tx.lockRecents}</p>}

      <section className={`agent-card mt-6 rounded-[24px] p-5 ${ready ? "agent-rise" : ""}`}>
        {ready && (
          <div className="mb-4 flex items-center gap-3">
            <span className="agent-pop flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--call)] text-white">
              <IconCheck className="h-5 w-5" strokeWidth={3} />
            </span>
            <div>
              <p className="text-[17px] font-semibold">{tx.setupReady}</p>
              <p className="text-[13px] text-[var(--label-2)]">{tx.setupReadySub}</p>
            </div>
          </div>
        )}
        <button
          onClick={onTestRing}
          className="agent-press flex w-full items-center justify-center gap-2 rounded-full bg-[var(--call)] py-3.5 text-[17px] font-semibold text-white shadow-[0_8px_20px_rgba(52,199,89,0.3)]"
        >
          <IconPhoneFilled className="h-5 w-5" />
          {tx.testRing}
        </button>
        <p className={`mt-3 text-center text-[13px] leading-snug ${testNote ? "font-semibold text-[var(--label)]" : "text-[var(--label-2)]"}`}>
          {testNote || tx.testRingSub}
        </p>
      </section>

      {native?.lastCheck !== undefined && (
        <p className={`mt-4 px-4 text-[13px] leading-snug ${trouble ? "font-medium text-[#FF3B30]" : "text-[var(--label-3)]"}`}>
          {tx.lastCheck}: {last === null ? tx.notYet : last < 60 ? tx.secondsAgo(last) : tx.minAgo(Math.round(last / 60))}
          {trouble && <span className="mt-1 block">{tx.checkTrouble}</span>}
          {native.maker && <span className="mt-1 block" dir="ltr">{titleCase(native.maker)} {native.model} · {native.version}</span>}
        </p>
      )}
    </main>
  );
}
