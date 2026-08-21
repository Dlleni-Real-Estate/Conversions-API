"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DICT, stageHint, stageLabel, type Dict, type Lang } from "@/lib/i18n";
import type { Status } from "@/lib/stages";

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Dict;
  /** Stage name in the current language. */
  s: (status: Status) => string;
  sHint: (status: Status) => string | undefined;
  /** Locale for dates and numbers. */
  locale: string;
};

const LangContext = createContext<Ctx | null>(null);
const KEY = "dlleni_lang";

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      if (saved === "ar" || saved === "en") setLangState(saved);
    } catch {
      // Private browsing or blocked storage — English is a fine default.
    }
  }, []);

  // The whole document flips, not just this subtree, so native widgets
  // (selects, date pickers, scrollbars) sit on the right side too.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      lang,
      setLang,
      t: DICT[lang] as unknown as Dict,
      s: (status: Status) => stageLabel(status, lang),
      sHint: (status: Status) => stageHint(status, lang),
      locale: lang === "ar" ? "ar-EG" : "en-GB",
    }),
    [lang, setLang]
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): Ctx {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used inside <LangProvider>");
  return ctx;
}

export function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 bg-white text-xs font-medium">
      {(["en", "ar"] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={`px-2.5 py-1.5 transition ${
            lang === l ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          {l === "en" ? "EN" : "ع"}
        </button>
      ))}
    </div>
  );
}
