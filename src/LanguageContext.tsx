import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { Language, translations } from './translations';

interface LanguageContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: keyof typeof translations['en']) => string;
  /**
   * Inline trilingual text picked by the CURRENT language. When no Sorani
   * (ckb) text is supplied, ckb falls back to Arabic — the source language —
   * never to a machine translation.
   */
  loc: (ar: string, en: string, ckb?: string) => string;
  dir: 'ltr' | 'rtl';
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const LANG_KEY = 'levo_lang';

/**
 * Module-level mirror of the current language, kept in sync by the provider,
 * so the standalone `loc` export also works outside component render.
 */
let currentLang: Language = 'ar';

function initialLang(): Language {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'ku') {
      // Legacy Sorani code — migrate the stored value to ISO 639-3 'ckb'.
      try {
        localStorage.setItem(LANG_KEY, 'ckb');
      } catch {
        /* storage unavailable */
      }
      return 'ckb';
    }
    if (stored === 'en' || stored === 'ar' || stored === 'ckb') return stored;
  } catch {
    /* storage unavailable */
  }
  // First visit defaults to Arabic (the store's source language) — never
  // derived from the browser locale.
  return 'ar';
}

/**
 * Standalone `loc` for use outside components (module helpers, callbacks).
 * Inside components prefer the context's `loc` from useLanguage(), which is
 * bound to the rendering language.
 */
export function loc(ar: string, en: string, ckb?: string): string {
  if (currentLang === 'en') return en;
  if (currentLang === 'ckb') return ckb || ar;
  return ar;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    const initial = initialLang();
    currentLang = initial;
    return initial;
  });

  const setLang = (next: Language) => {
    currentLang = next;
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* storage unavailable */
    }
  };

  const t = (key: keyof typeof translations['en']) => {
    return translations[lang][key] || translations['en'][key];
  };

  const locBound = (ar: string, en: string, ckb?: string) =>
    lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar;

  // Arabic and Sorani Kurdish (Arabic script) are both right-to-left.
  const dir = lang === 'ar' || lang === 'ckb' ? 'rtl' : 'ltr';

  useEffect(() => {
    currentLang = lang;
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
  }, [dir, lang]);

  /**
   * THE NEW LANGUAGE ARRIVES INSTEAD OF APPEARING.
   *
   * «عند تغيّر اللغة من العربي للانقليزي … تخلي حركة خفيفة سلسلة انميشن ناعم
   *  عند تنقل الكلام من اليمنة لليسرة (حسب اللغة المراد اختيارها) بدل الوضع
   *  الحالي (انتقال لحظي وبدون تأثيرات).»
   *
   * This is deliberately ONE line of state and no render of its own. The
   * language still commits exactly as it did — the tree re-renders, the new
   * strings paint — and this marks the document so CSS can play that paint in.
   * There is no fade-out to wait behind, no second commit, and no component
   * anywhere needs to know it happened, which matters because there are six
   * language switchers in the shop and the animation must not belong to any
   * one of them.
   *
   * It runs AFTER the effect above by declaration order, so
   * `document.documentElement.dir` already holds the NEW direction and the
   * content settles toward the side the new language reads from.
   *
   * THE FIRST RUN IS SKIPPED. A page load is not a language change, and
   * animating it would put a flicker on every cold start.
   *
   * THE ATTRIBUTE ALWAYS COMES OFF. `animationend` is the normal path; the
   * timer is the one that matters — a hidden tab does not run animations, so
   * without it a language changed in the background would leave the marker on
   * and the next paint would replay it.
   */
  const firstLangRun = useRef(true);
  useEffect(() => {
    if (firstLangRun.current) {
      firstLangRun.current = false;
      return;
    }
    const root = document.documentElement;
    root.setAttribute('data-lang-swap', dir);
    const clear = () => root.removeAttribute('data-lang-swap');
    const timer = window.setTimeout(clear, 400);
    const main = document.querySelector('main');
    main?.addEventListener('animationend', clear, { once: true });
    return () => {
      window.clearTimeout(timer);
      main?.removeEventListener('animationend', clear);
      clear();
    };
  }, [lang, dir]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, loc: locBound, dir }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
