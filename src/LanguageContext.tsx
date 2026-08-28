import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
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
