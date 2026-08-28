/**
 * LEVO Studio i18n (slice S6).
 *
 * - Locales: Arabic (default, RTL), English (LTR), Sorani Kurdish ckb (RTL).
 * - The app CHROME follows the locale direction; the 3D viewport and other
 *   technical readouts stay LTR by design (`.viewport-mount` and
 *   `.studio-status` are pinned LTR in globals.css — mandate §5).
 * - The chosen locale is persisted in localStorage (a locale is not a secret)
 *   and re-applied before hydration by the inline snippet in layout.tsx so an
 *   English/Sorani user does not get an ar/rtl flash.
 *
 * Sorani strings still need a native-speaker review before being described as
 * a reviewed human translation — see the note in ckb.ts and the delivery
 * report. No machine-translation service is called at runtime.
 */

import { ar } from "./ar";
import { ckb } from "./ckb";
import { en, type StudioDictionary } from "./en";

export type { StudioDictionary };

export type Locale = "ar" | "en" | "ckb";

export const DEFAULT_LOCALE: Locale = "ar";

export const LOCALES: readonly Locale[] = ["ar", "en", "ckb"];

/** Autonyms for the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  ar: "العربية",
  en: "English",
  ckb: "کوردیی سۆرانی",
};

export const DICTIONARIES: Record<Locale, StudioDictionary> = { ar, en, ckb };

/** localStorage key — shared with the pre-hydration snippet in layout.tsx. */
export const LOCALE_STORAGE_KEY = "levo-studio-locale";

export function isLocale(value: unknown): value is Locale {
  return value === "ar" || value === "en" || value === "ckb";
}

/** Chrome direction for a locale (the 3D viewport itself stays LTR). */
export function dirFor(locale: Locale): "rtl" | "ltr" {
  return locale === "en" ? "ltr" : "rtl";
}

/** BCP-47 tag for date/number formatting. */
export function dateLocaleFor(locale: Locale): string {
  if (locale === "ar") return "ar-IQ";
  if (locale === "ckb") return "ckb-IQ";
  return "en";
}

/** Stored locale, when present and valid; DEFAULT_LOCALE otherwise. */
export function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Persists the chosen locale; storage failures are non-fatal by design. */
export function storeLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private browsing / storage-denied environments keep the in-memory choice.
  }
}

/** Applies lang/dir to the document chrome (viewport stays LTR via CSS). */
export function applyLocaleToDocument(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = dirFor(locale);
}

/** Replaces `{key}` placeholders. Missing values are left visible on purpose. */
export function templateText(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}
