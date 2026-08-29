import React from 'react';

/**
 * PhoneField — phone input with a country selector, Iraq (+964) default
 * (integrated mandate §2.1/§2.3).
 *
 * - Digits render LTR even inside RTL pages (the whole control is dir="ltr";
 *   the label stays in the page direction).
 * - Pasting local (07…), international (+9647…/009647…/9647…) and
 *   Arabic/Eastern-Arabic-digit forms is normalized client-side, mirroring
 *   worker/lib/phone.ts — the country code is never doubled and the local
 *   leading 0 never survives into the international form.
 * - inputmode="tel" brings up the phone keypad on iPad/phones.
 *
 * HONESTY: a syntactically complete number proves the SHAPE only, never
 * ownership (ownership is proven via the Telegram flow or another authorized
 * provider, server-side). For Iraq the strict mobile rule applies
 * (+964 7XX XXX XXXX): ten digits starting with 7 — an arbitrary 10-digit
 * string does NOT validate. For other countries only an E.164 plausibility
 * check is possible client-side (no libphonenumber in the build; the server
 * remains the authority) — see honest note in the slice report.
 */

// ------------------------------------------------------------ pure helpers

/** Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits → ASCII.
 *  Client-side mirror of worker/lib/phone.ts#toAsciiDigits. */
export function toAsciiDigitsClient(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return String((c >= 0x06f0 ? c - 0x06f0 : c - 0x0660) % 10);
  });
}

export interface Country {
  iso: string;
  /** Dial code digits, no '+'. */
  dial: string;
  flag: string;
  name: string;
  nameAr: string;
}

/** Iraq first (default); a pragmatic regional list, longest-dial matching. */
export const COUNTRIES: Country[] = [
  { iso: 'IQ', dial: '964', flag: '🇮🇶', name: 'Iraq', nameAr: 'العراق' },
  { iso: 'SY', dial: '963', flag: '🇸🇾', name: 'Syria', nameAr: 'سوريا' },
  { iso: 'JO', dial: '962', flag: '🇯🇴', name: 'Jordan', nameAr: 'الأردن' },
  { iso: 'LB', dial: '961', flag: '🇱🇧', name: 'Lebanon', nameAr: 'لبنان' },
  { iso: 'KW', dial: '965', flag: '🇰🇼', name: 'Kuwait', nameAr: 'الكويت' },
  { iso: 'SA', dial: '966', flag: '🇸🇦', name: 'Saudi Arabia', nameAr: 'السعودية' },
  { iso: 'AE', dial: '971', flag: '🇦🇪', name: 'UAE', nameAr: 'الإمارات' },
  { iso: 'QA', dial: '974', flag: '🇶🇦', name: 'Qatar', nameAr: 'قطر' },
  { iso: 'BH', dial: '973', flag: '🇧🇭', name: 'Bahrain', nameAr: 'البحرين' },
  { iso: 'OM', dial: '968', flag: '🇴🇲', name: 'Oman', nameAr: 'عُمان' },
  { iso: 'TR', dial: '90', flag: '🇹🇷', name: 'Türkiye', nameAr: 'تركيا' },
  { iso: 'IR', dial: '98', flag: '🇮🇷', name: 'Iran', nameAr: 'إيران' },
  { iso: 'EG', dial: '20', flag: '🇪🇬', name: 'Egypt', nameAr: 'مصر' },
  { iso: 'DE', dial: '49', flag: '🇩🇪', name: 'Germany', nameAr: 'ألمانيا' },
  { iso: 'SE', dial: '46', flag: '🇸🇪', name: 'Sweden', nameAr: 'السويد' },
  { iso: 'GB', dial: '44', flag: '🇬🇧', name: 'United Kingdom', nameAr: 'بريطانيا' },
  { iso: 'US', dial: '1', flag: '🇺🇸', name: 'United States', nameAr: 'الولايات المتحدة' },
];

export function countryByIso(iso: string): Country {
  return COUNTRIES.find((c) => c.iso === iso) || COUNTRIES[0];
}

const MAX_NATIONAL_DIGITS = 14;

/**
 * Normalize any typed/pasted phone text into { iso, national }:
 * - Arabic/Eastern-Arabic digits → ASCII; spaces/dashes/dots/parens dropped.
 * - "+<dial>…" / "00<dial>…" switches the country (longest dial match).
 * - A local trunk "0" is stripped (07701234567 → 7701234567).
 * - Typing the current country's dial code without "+" (9647701234567)
 *   does not double it.
 */
export function normalizePhoneInput(
  raw: string,
  currentIso: string
): { iso: string; national: string } {
  let s = toAsciiDigitsClient(String(raw ?? '')).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;

  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    const match = [...COUNTRIES]
      .sort((a, b) => b.dial.length - a.dial.length)
      .find((c) => digits.startsWith(c.dial));
    if (match) {
      let rest = digits.slice(match.dial.length);
      rest = rest.replace(/^0+/, ''); // +964 07… → the 0 never survives
      return { iso: match.iso, national: rest.slice(0, MAX_NATIONAL_DIGITS) };
    }
    return { iso: currentIso, national: digits.slice(0, MAX_NATIONAL_DIGITS) };
  }

  let digits = s.replace(/\D/g, '');
  digits = digits.replace(/^0+/, ''); // local trunk zero
  const cur = countryByIso(currentIso);
  // Full international form typed without '+': don't double the dial code.
  if (
    digits.startsWith(cur.dial) &&
    digits.length > cur.dial.length + 6
  ) {
    digits = digits.slice(cur.dial.length).replace(/^0+/, '');
  }
  return { iso: currentIso, national: digits.slice(0, MAX_NATIONAL_DIGITS) };
}

export interface PhoneValue {
  iso: string;
  /** Dial code digits of the selected country (no '+'). */
  dial: string;
  /** National digits as shown in the input (ASCII, no trunk 0). */
  national: string;
  /** E.164 (+<dial><national>) when valid, otherwise null. */
  e164: string | null;
  valid: boolean;
  /** 0..1 completion for the FillButton; capped below 1 while invalid. */
  progress: number;
}

/** Build the full PhoneValue from a country + national digits. */
export function buildPhoneValue(iso: string, national: string): PhoneValue {
  const c = countryByIso(iso);
  const digits = national.replace(/\D/g, '');
  let valid: boolean;
  let progress: number;
  if (c.iso === 'IQ') {
    // Strict Iraqi mobile: exactly 7XXXXXXXXX (worker/lib/phone.ts rule).
    valid = /^7\d{9}$/.test(digits);
    progress = clamp01Local(digits.length / 10);
    if (digits.length > 0 && !digits.startsWith('7')) {
      valid = false;
      progress = Math.min(progress, 0.2); // clearly "wrong track", not "almost"
    }
  } else {
    // E.164 plausibility only (≤15 digits total, ≥8 national digits).
    const total = c.dial.length + digits.length;
    valid = digits.length >= 8 && digits.length <= MAX_NATIONAL_DIGITS && total <= 15;
    progress = clamp01Local(digits.length / 8);
  }
  if (!valid) progress = Math.min(progress, 0.95);
  return {
    iso: c.iso,
    dial: c.dial,
    national: digits,
    e164: valid ? `+${c.dial}${digits}` : null,
    valid,
    progress,
  };
}

export function emptyPhoneValue(iso = 'IQ'): PhoneValue {
  return buildPhoneValue(iso, '');
}

function clamp01Local(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// --------------------------------------------------------------- component

export interface PhoneFieldProps {
  id: string;
  label: string;
  /** Accessible label for the country selector. */
  countryLabel: string;
  value: PhoneValue;
  onChange: (value: PhoneValue) => void;
  lang?: 'ar' | 'en' | 'ckb';
  error?: string;
  hint?: string;
  disabled?: boolean;
  placeholder?: string;
}

export default function PhoneField({
  id,
  label,
  countryLabel,
  value,
  onChange,
  lang = 'ar',
  error,
  hint,
  disabled,
  placeholder,
}: PhoneFieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const country = countryByIso(value.iso);
  const countryName = (c: Country) => (lang === 'en' ? c.name : c.nameAr);

  const handleText = (raw: string) => {
    const { iso, national } = normalizePhoneInput(raw, value.iso);
    onChange(buildPhoneValue(iso, national));
  };

  const handleCountry = (iso: string) => {
    onChange(buildPhoneValue(iso, value.national));
  };

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold text-zinc-300">
        {label}
      </label>
      {/* dir=ltr: dial code and digits always read left-to-right, even on
          the Arabic page (mandate §2.1). */}
      <div className="flex gap-2" dir="ltr">
        <div className="relative shrink-0">
          {/* Compact closed display (flag + dial); the real, accessible
              <select> sits on top with full localized country names. */}
          <span
            aria-hidden
            className={`flex min-h-[48px] items-center gap-1.5 rounded-xl border bg-zinc-950/70 px-3 text-[15px] text-white transition-colors ${
              error ? 'border-red-500/70' : 'border-zinc-800'
            } ${disabled ? 'opacity-60' : ''}`}
          >
            <span className="text-base leading-none">{country.flag}</span>
            <span className="font-semibold tabular-nums">+{country.dial}</span>
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 text-zinc-500" fill="currentColor" aria-hidden>
              <path d="M5.3 7.7a1 1 0 0 1 1.4 0L10 11l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z" />
            </svg>
          </span>
          <select
            id={`${id}-country`}
            aria-label={countryLabel}
            value={country.iso}
            onChange={(e) => handleCountry(e.target.value)}
            disabled={disabled}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          >
            {COUNTRIES.map((c) => (
              <option key={c.iso} value={c.iso}>
                {c.flag} +{c.dial} — {countryName(c)}
              </option>
            ))}
          </select>
        </div>
        <input
          id={id}
          name={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          dir="ltr"
          value={value.national}
          onChange={(e) => handleText(e.target.value)}
          placeholder={placeholder ?? (country.iso === 'IQ' ? '7XX XXX XXXX' : '')}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={`w-full min-h-[48px] rounded-xl border bg-zinc-950/70 px-4 py-3 text-[15px] tabular-nums text-white placeholder-zinc-600 outline-none transition-colors focus:border-gold/70 focus:ring-1 focus:ring-gold/40 disabled:opacity-60 ${
            error ? 'border-red-500/70' : 'border-zinc-800'
          }`}
        />
      </div>
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-xs leading-relaxed text-zinc-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
