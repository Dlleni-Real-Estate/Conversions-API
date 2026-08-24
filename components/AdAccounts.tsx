"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, SectionTitle } from "./ui";
import { useLang } from "./LangProvider";

type Connected = {
  ad_account_id: string;
  name: string | null;
  dataset_id: string;
  dataset_name: string | null;
  page_id: string | null;
  enabled: boolean;
  verified_at: string | null;
  last_error: string | null;
  /** True when the row carries its own token (an account from another Business). */
  has_own_token?: boolean;
  business_name?: string | null;
};
type Available = {
  id: string; name?: string; currency?: string; status?: number;
  business_id?: string; business_name?: string;
};
type Ref = { id: string; name?: string };
type Payload = {
  ok: boolean;
  connected: Connected[];
  available: Available[];
  datasets: Record<string, Ref[]>;
  pages: Record<string, Ref[]>;
  pageSource: Record<string, "account" | "user" | "none">;
  envPageId: string | null;
  listError: string | null;
};

/**
 * Connect and disconnect ad accounts.
 *
 * The picker only ever offers dataset/account pairs Meta reports as connected,
 * and an account Meta reports no dataset for is shown as blocked with the fix
 * spelled out. That is deliberate: a wrong pairing is accepted by Meta with a
 * 200 and attributed to nothing, so it cannot be caught later — it has to be
 * made unpickable here.
 */
export default function AdAccounts({ pw }: { pw: string }) {
  const { t, locale } = useLang();
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [pickedPage, setPickedPage] = useState<Record<string, string>>({});

  // "Connect from another Business": what one pasted token can see.
  type Probe = {
    available: Available[];
    datasets: Record<string, Ref[]>;
    pages: Record<string, Ref[]>;
    pageSource: Record<string, string>;
  };
  const [probeToken, setProbeToken] = useState("");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  // The manual-token path is the fallback, not the flow. Folded away so the
  // section reads as one action - the blue button - instead of two competing
  // ones; "Check token" only ever belonged to the paste-a-token path.
  const [manualOpen, setManualOpen] = useState(false);
  // How the current probe authenticated - a Facebook Login nonce or a pasted
  // token. Connect must use the SAME credential that listed the account.
  const [probeAuth, setProbeAuth] = useState<
    { kind: "nonce"; nonce: string } | { kind: "token" } | null
  >(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/ad-accounts", { headers: { "x-app-password": pw } });
      const j = await r.json();
      if (j.ok) { setData(j); setErr(null); } else setErr(j.error || "Error");
    } catch { setErr(t.connectionError); }
  }, [pw, t]);

  useEffect(() => { load(); }, [load]);

  const call = async (method: "POST" | "DELETE", body?: unknown, qs = "") => {
    setBusy(String((body as { ad_account_id?: string })?.ad_account_id ?? qs));
    setErr(null);
    try {
      const r = await fetch(`/api/ad-accounts${qs}`, {
        method,
        headers: { "x-app-password": pw, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const j = await r.json();
      if (!j.ok) setErr(j.error || "Error");
      await load();
    } catch { setErr(t.connectionError); } finally { setBusy(null); }
  };

  const runProbeWith = useCallback(
    async (
      payload: Record<string, string>,
      auth: { kind: "nonce"; nonce: string } | { kind: "token" },
      opts?: { silent?: boolean }
    ) => {
      setProbing(true);
      setProbeErr(null);
      try {
        const r = await fetch("/api/ad-accounts", {
          method: "POST",
          headers: { "x-app-password": pw, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const j = await r.json();
        if (j.ok) {
          setProbe({
            available: j.available ?? [],
            datasets: j.datasets ?? {},
            pages: j.pages ?? {},
            pageSource: j.pageSource ?? {},
          });
          setProbeAuth(auth);
        } else {
          setProbe(null);
          setProbeAuth(null);
          if (opts?.silent) {
            // A remembered sign-in the server has since forgotten. Not an
            // error - just stop remembering it.
            try { window.sessionStorage.removeItem("fb_oauth_nonce"); } catch { /* private mode */ }
          } else {
            setProbeErr(j.error || "Error");
          }
        }
      } catch {
        setProbeErr(t.connectionError);
      } finally {
        setProbing(false);
      }
    },
    [pw, t]
  );

  const runProbe = () => runProbeWith({ probe_token: probeToken.trim() }, { kind: "token" });

  const startOAuth = async () => {
    setProbeErr(null);
    try {
      const r = await fetch("/api/oauth/start", { headers: { "x-app-password": pw } });
      const j = await r.json();
      if (j.ok && j.url) window.location.href = j.url;
      else setProbeErr(j.error || "Error");
    } catch {
      setProbeErr(t.connectionError);
    }
  };

  // Returning from Facebook: the URL carries only a nonce (never a token).
  // Probe with it immediately, then scrub the query string so a reload or a
  // shared link replays nothing.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const done = sp.get("oauth_done");
    const oerr = sp.get("oauth_error");
    if (oerr) setProbeErr(oerr);
    if (done) {
      // Remember the sign-in for this browser tab, so the account list
      // survives a reload or a trip to another dashboard tab instead of
      // silently vanishing. The server still expires it after an hour.
      try { window.sessionStorage.setItem("fb_oauth_nonce", done); } catch { /* private mode */ }
      runProbeWith({ oauth_nonce: done }, { kind: "nonce", nonce: done });
    } else {
      let saved: string | null = null;
      try { saved = window.sessionStorage.getItem("fb_oauth_nonce"); } catch { /* private mode */ }
      if (saved) runProbeWith({ oauth_nonce: saved }, { kind: "nonce", nonce: saved }, { silent: true });
    }
    if (done || oerr) {
      sp.delete("oauth_done");
      sp.delete("oauth_error");
      const qs = sp.toString();
      window.history.replaceState(null, "", qs ? `/?${qs}` : "/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;

  const connectedIds = new Set(data.connected.map((c) => c.ad_account_id));
  const notConnected = data.available.filter((a) => !connectedIds.has(a.id));


  const connectProbed = async (a: Available, dataset: string, page: string) => {
    if (!dataset) return;
    setBusy(a.id);
    setErr(null);
    try {
      const r = await fetch("/api/ad-accounts", {
        method: "POST",
        headers: { "x-app-password": pw, "Content-Type": "application/json" },
        body: JSON.stringify({
          ad_account_id: a.id,
          dataset_id: dataset,
          name: a.name,
          // The credential that listed this account is the one that verifies
          // and gets stored with it - one token per pairing, end to end.
          ...(probeAuth?.kind === "nonce"
            ? { oauth_nonce: probeAuth.nonce }
            : { access_token: probeToken.trim() }),
          ...(page ? { page_id: page } : {}),
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error || "Error");
        return;
      }
      setProbe((p) => (p ? { ...p, available: p.available.filter((x) => x.id !== a.id) } : p));
      await load();
    } catch {
      setErr(t.connectionError);
    } finally {
      setBusy(null);
    }
  };

  // An already-connected account showing up in a fresh login is not a
  // duplicate to hide - it is how an expiring sign-in gets renewed. Same
  // connect call, same pairing, new token; nothing is disconnected on the way.
  const refreshRow = (a: Available) => {
    const c = data.connected.find((x) => x.ad_account_id === a.id);
    if (!c) return null;
    return (
      <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <p dir="auto" className="truncate text-sm font-medium text-slate-700">
            {a.name || a.id}
            <span className="ms-2 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
              {t.accAlreadyConnected}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500"><span className="ltr-nums">{a.id}</span></p>
        </div>
        <button
          onClick={() => connectProbed(a, c.dataset_id, c.page_id || "")}
          disabled={busy === a.id}
          className="tap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-card hover:bg-slate-50 disabled:opacity-40"
        >
          {busy === a.id ? t.accConnecting : t.accRefreshToken}
        </button>
      </Card>
    );
  };

  // Mirrors the env-token candidate card below; kept separate because its
  // pickers read from the probe result and its connect carries the token.
  const probeCard = (a: Available) => {
    if (!probe) return null;
    const sets = probe.datasets[a.id] ?? [];
    const pages = probe.pages?.[a.id] ?? [];
    const src = probe.pageSource?.[a.id] ?? "none";
    const blocked = sets.length === 0;
    const chosen = picked[a.id] ?? sets[0]?.id ?? "";
    const chosenPage = pickedPage[a.id] ?? pages[0]?.id ?? "";
    return (
      <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p dir="auto" className="truncate font-medium text-slate-800">{a.name || a.id}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            <span className="ltr-nums">{a.id}</span>
            {a.currency ? ` · ${a.currency}` : ""}
          </p>
          {blocked && (
            <p className="mt-1.5 max-w-xl rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800">
              {t.accNoDataset}
            </p>
          )}
          {!blocked && src === "user" && (
            <p className="mt-1.5 max-w-xl rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
              {t.accPageUnassigned}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {sets.length > 1 && (
            <select
              value={chosen}
              onChange={(e) => setPicked((p) => ({ ...p, [a.id]: e.target.value }))}
              aria-label={t.accDataset}
              className="tap rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
            >
              {sets.map((d) => (
                <option key={d.id} value={d.id}>{d.name || d.id}</option>
              ))}
            </select>
          )}
          {pages.length > 1 && (
            <select
              value={chosenPage}
              onChange={(e) => setPickedPage((p) => ({ ...p, [a.id]: e.target.value }))}
              aria-label={t.accPage}
              className="tap rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
            >
              {pages.map((d) => (
                <option key={d.id} value={d.id}>{d.name || d.id}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => connectProbed(a, chosen, chosenPage)}
            disabled={blocked || busy === a.id}
            className="tap rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-card hover:bg-brand-700 disabled:opacity-40"
          >
            {busy === a.id ? t.accConnecting : t.accConnect}
          </button>
        </div>
      </Card>
    );
  };

  return (
    <section>
      <SectionTitle title={t.accountsTitle} subtitle={t.accountsSub} />

      {err && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-relaxed text-red-700">{err}</p>
      )}
      {data.listError && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {t.accountsListFail}: {data.listError}
        </p>
      )}

      <div className="space-y-3">
        {data.connected.map((c) => (
          <Card key={c.ad_account_id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p dir="auto" className="truncate font-medium text-slate-800">
                {c.name || c.ad_account_id}
                {!c.verified_at && (
                  <span className="ms-2 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                    {t.accUnverified}
                  </span>
                )}
                {c.has_own_token && (
                  <span className="ms-2 rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                    {t.accOwnToken}
                  </span>
                )}
                <span
                  className={`ms-2 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                    c.enabled
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-slate-300 bg-slate-100 text-slate-500"
                  }`}
                >
                  {c.enabled ? t.accOn : t.accOff}
                </span>
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                <span className="ltr-nums">{c.ad_account_id}</span>
                {c.business_name && <> · <span dir="auto">{c.business_name}</span></>}
                {" "}· {t.accDataset}: {c.dataset_name || c.dataset_id}
                {c.page_id && <> · {t.accPage}: <span className="ltr-nums">{c.page_id}</span></>}
                {c.verified_at && (
                  <> · {t.accVerified} {new Date(c.verified_at).toLocaleDateString(locale)}</>
                )}
              </p>
              {c.last_error && <p className="mt-1 text-[11px] text-red-600">{c.last_error}</p>}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => call("POST", { ad_account_id: c.ad_account_id, enabled: !c.enabled })}
                disabled={busy === c.ad_account_id}
                className={`tap rounded-lg border px-3 py-1.5 text-xs font-medium shadow-card disabled:opacity-40 ${
                  c.enabled
                    ? "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                    : "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                }`}
              >
                {c.enabled ? t.accPause : t.accResume}
              </button>
              <button
                onClick={() => call("DELETE", undefined, `?ad_account_id=${c.ad_account_id}`)}
                disabled={busy === `?ad_account_id=${c.ad_account_id}`}
                className="tap rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 shadow-card hover:bg-red-50 disabled:opacity-40"
              >
                {t.accDisconnect}
              </button>
            </div>
          </Card>
        ))}
      </div>

      {notConnected.length > 0 && (
        <>
          <p className="mb-2 mt-5 text-xs font-medium text-slate-500">{t.accAddTitle}</p>
          <div className="space-y-3">
            {notConnected.map((a) => {
              const sets = data.datasets[a.id] ?? [];
              const pages = data.pages?.[a.id] ?? [];
              const src = data.pageSource?.[a.id] ?? "none";
              const blocked = sets.length === 0;
              const chosen = picked[a.id] ?? sets[0]?.id ?? "";
              // When Meta named no Page for this account these are just the
              // Pages the token can see, so the one already in use is the
              // sensible default rather than whatever came back first.
              const fallbackPage =
                (src === "user" && data.envPageId && pages.some((p) => p.id === data.envPageId)
                  ? data.envPageId
                  : pages[0]?.id) ?? "";
              const chosenPage = pickedPage[a.id] ?? fallbackPage;
              return (
                <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p dir="auto" className="truncate font-medium text-slate-800">{a.name || a.id}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      <span className="ltr-nums">{a.id}</span>
                      {a.currency ? ` · ${a.currency}` : ""}
                    </p>
                    {blocked && (
                      <p className="mt-1.5 max-w-xl rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800">
                        {t.accNoDataset}
                      </p>
                    )}
                    {!blocked && src === "user" && (
                      <p className="mt-1.5 max-w-xl rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
                        {t.accPageUnassigned}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {sets.length > 1 && (
                      <select
                        value={chosen}
                        onChange={(e) => setPicked((p) => ({ ...p, [a.id]: e.target.value }))}
                        aria-label={t.accDataset}
                        className="tap rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
                      >
                        {sets.map((d) => (
                          <option key={d.id} value={d.id}>{d.name || d.id}</option>
                        ))}
                      </select>
                    )}
                    {pages.length > 1 && (
                      <select
                        value={chosenPage}
                        onChange={(e) => setPickedPage((p) => ({ ...p, [a.id]: e.target.value }))}
                        aria-label={t.accPage}
                        className="tap rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
                      >
                        {pages.map((d) => (
                          <option key={d.id} value={d.id}>{d.name || d.id}</option>
                        ))}
                      </select>
                    )}
                    <button
                      onClick={() =>
                        call("POST", {
                          ad_account_id: a.id,
                          dataset_id: chosen,
                          name: a.name,
                          ...(chosenPage ? { page_id: chosenPage } : {}),
                        })
                      }
                      disabled={blocked || busy === a.id}
                      className="tap rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-card hover:bg-brand-700 disabled:opacity-40"
                    >
                      {busy === a.id ? t.accConnecting : t.accConnect}
                    </button>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <p className="mb-2 mt-6 text-xs font-medium text-slate-500">{t.accOtherBiz}</p>
      <Card className="p-4">
        <p className="max-w-2xl text-[11px] leading-relaxed text-slate-500">{t.accFbLoginSub}</p>
        <button
          onClick={startOAuth}
          disabled={probing}
          className="tap mt-3 rounded-lg bg-[#1877F2] px-4 py-2 text-xs font-semibold text-white shadow-card hover:bg-[#166FE5] disabled:opacity-40"
        >
          {t.accFbLogin}
        </button>

        <button
          onClick={() => setManualOpen((v) => !v)}
          className="tap mt-4 block text-[11px] font-medium text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600"
        >
          {manualOpen ? t.accManualHide : t.accManualShow}
        </button>
        {manualOpen && (
          <>
            <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-slate-500">{t.accOtherBizHelp}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="password"
                dir="ltr"
                value={probeToken}
                onChange={(e) => setProbeToken(e.target.value)}
                placeholder={t.accTokenPh}
                autoComplete="off"
                className="tap w-80 max-w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs shadow-card"
              />
              <button
                onClick={runProbe}
                disabled={!probeToken.trim() || probing}
                className="tap rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-card hover:bg-brand-700 disabled:opacity-40"
              >
                {probing ? t.accProbing : t.accProbe}
              </button>
            </div>
          </>
        )}
        {probeErr && <p className="mt-2 text-[11px] text-red-600">{probeErr}</p>}
        {probe && probe.available.length === 0 && (
          <p className="mt-3 text-[11px] text-slate-500">{t.accProbeNone}</p>
        )}
        {probe && (() => {
          // Grouped by owning Business: one Facebook account routinely manages
          // several, and a flat list of similar names across Businesses is how
          // the wrong account gets connected.
          const groups = new Map<string, Available[]>();
          for (const a of probe.available) {
            const k = a.business_name || "";
            const arr = groups.get(k) ?? [];
            arr.push(a);
            groups.set(k, arr);
          }
          return [...groups.entries()].map(([biz, accs]) => (
            <div key={biz || "_none"} className="mt-3">
              {groups.size > 1 && (
                <p dir="auto" className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {biz || t.accPersonalAccounts}
                </p>
              )}
              <div className="space-y-3">
                {accs.map((a) => (connectedIds.has(a.id) ? refreshRow(a) : probeCard(a)))}
              </div>
            </div>
          ));
        })()}
      </Card>
    </section>
  );
}
