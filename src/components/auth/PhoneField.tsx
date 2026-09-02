import React, { useMemo } from 'react';
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber,
  validatePhoneNumberLength,
  type CountryCode,
} from 'libphonenumber-js';

/**
 * PhoneField — a phone input for everyone, not for Iraq.
 *
 * WHAT THIS REPLACED. The old field offered seventeen hand-picked countries
 * and validated Iraq strictly (`7XXXXXXXXX`) while every other country got a
 * length check: eight to fourteen digits, anything goes. So `+971 00000 0000`
 * was accepted as a UAE number, a real number with a shorter national format
 * was rejected, and the label said "Iraqi mobile" — which is exactly what a
 * customer outside Iraq read before giving up.
 *
 * Now: every country libphonenumber knows (245 of them), each country's real
 * numbering plan deciding validity, and the country NAMES coming from the
 * platform's own locale data rather than a translation table — so the picker
 * is in Arabic, English or Kurdish without anyone maintaining 245 × 3 strings
 * that would drift the moment a country is renamed.
 *
 * WHAT IS STILL TRUE, AND HAS TO BE SAID: a syntactically perfect number
 * proves the SHAPE and nothing else. Ownership is proven server-side, by
 * Telegram answering on that number. Nothing here is a credential.
 *
 * Direction: the whole control is `dir="ltr"` because a dial code and a
 * national number are read left-to-right in every language; only the label
 * follows the page direction.
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
}

/** ISO 3166-1 alpha-2 → regional-indicator flag. Falls back to the code
 *  itself on platforms that do not render flag emoji (Windows), which is
 *  still a correct, readable label. */
export function flagOf(iso: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso)) return '';
  return String.fromCodePoint(
    ...iso
      .toUpperCase()
      .split('')
      .map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)
  );
}

/** Every callable country. Built once — the metadata never changes at runtime. */
export const COUNTRIES: Country[] = getCountries()
  .map((iso) => ({ iso: iso as string, dial: getCountryCallingCode(iso) as string, flag: flagOf(iso) }))
  .sort((a, b) => a.iso.localeCompare(b.iso));

const BY_ISO = new Map(COUNTRIES.map((c) => [c.iso, c]));

/** The markets this platform actually serves, floated to the top of the list
 *  so the common case is one tap rather than a scroll through 245 entries. */
export const COMMON_ISO = ['IQ', 'AE', 'SA', 'KW', 'QA', 'BH', 'OM', 'JO', 'LB', 'SY', 'TR', 'IR', 'EG', 'GB', 'DE', 'SE', 'US'];

export function countryByIso(iso: string): Country {
  return BY_ISO.get(String(iso ?? '').toUpperCase()) ?? BY_ISO.get('IQ') ?? COUNTRIES[0];
}

const MAX_NATIONAL_DIGITS = 15;

/**
 * Normalize typed or pasted text into { iso, national }.
 *
 * `+…` / `00…` switches the country by longest matching dial code; a local
 * trunk zero is dropped; typing the current country's own dial code without a
 * plus does not double it. This mirrors what the server does with the same
 * input, so the field never shows valid for something the server refuses.
 */
export function normalizePhoneInput(raw: string, currentIso: string): { iso: string; national: string } {
  let s = toAsciiDigitsClient(String(raw ?? '')).replace(/[\s\-().‎‏]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;

  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    const match = [...COUNTRIES]
      .sort((a, b) => b.dial.length - a.dial.length)
      .find((c) => digits.startsWith(c.dial));
    if (match) {
      const rest = digits.slice(match.dial.length).replace(/^0+/, '');
      return { iso: match.iso, national: rest.slice(0, MAX_NATIONAL_DIGITS) };
    }
    return { iso: currentIso, national: digits.slice(0, MAX_NATIONAL_DIGITS) };
  }

  let digits = s.replace(/\D/g, '').replace(/^0+/, '');
  const cur = countryByIso(currentIso);
  if (digits.startsWith(cur.dial) && digits.length > cur.dial.length + 6) {
    digits = digits.slice(cur.dial.length).replace(/^0+/, '');
  }
  return { iso: cur.iso, national: digits.slice(0, MAX_NATIONAL_DIGITS) };
}

export interface PhoneValue {
  iso: string;
  /** Dial code digits of the selected country (no '+'). */
  dial: string;
  /** National digits (ASCII, no trunk 0) — what is stored in state. */
  national: string;
  /** Grouped for reading, e.g. `(202) 555-0123`. Display only. */
  formatted: string;
  /** E.164 when the number is real, otherwise null. */
  e164: string | null;
  valid: boolean;
  /** 0..1 completion for the progress-filling button. */
  progress: number;
}

/**
 * Build the full value from a country and national digits.
 *
 * Validity is libphonenumber's answer for that country, never a digit count.
 * `progress` uses the same metadata: TOO_SHORT means keep going, TOO_LONG
 * means it will not become valid by typing more.
 */
export function buildPhoneValue(iso: string, national: string): PhoneValue {
  const c = countryByIso(iso);
  const digits = String(national ?? '').replace(/\D/g, '').slice(0, MAX_NATIONAL_DIGITS);
  const e164Candidate = `+${c.dial}${digits}`;
  const valid = digits.length > 0 && isValidPhoneNumber(e164Candidate);

  let progress = 0;
  if (digits.length > 0) {
    if (valid) {
      progress = 1;
    } else {
      const verdict = validatePhoneNumberLength(e164Candidate);
      // TOO_SHORT: on the right track. Anything else (TOO_LONG, INVALID
      // COUNTRY, a valid length that is not a real number) is not "almost".
      progress = verdict === 'TOO_SHORT' ? Math.min(0.9, 0.25 + digits.length * 0.08) : 0.2;
    }
  }

  let formatted = digits;
  try {
    formatted = new AsYouType(c.iso as CountryCode).input(digits) || digits;
  } catch {
    formatted = digits;
  }

  return {
    iso: c.iso,
    dial: c.dial,
    national: digits,
    formatted,
    e164: valid ? e164Candidate : null,
    valid,
    progress,
  };
}

export function emptyPhoneValue(iso = 'IQ'): PhoneValue {
  return buildPhoneValue(iso, '');
}

/** Localized country names, from the platform's own locale data. */
export function countryNames(lang: string): (iso: string) => string {
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames([lang], { type: 'region' });
  } catch {
    dn = null;
  }
  return (iso: string) => {
    try {
      return dn?.of(iso) ?? iso;
    } catch {
      return iso;
    }
  };
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
  /** Groups the frequently used countries at the top of the picker. */
  commonLabel?: string;
  allLabel?: string;
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
  commonLabel,
  allLabel,
}: PhoneFieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const country = countryByIso(value.iso);

  const { common, rest, nameOf } = useMemo(() => {
    const nameOf = countryNames(lang);
    const commonSet = new Set(COMMON_ISO);
    const common = COMMON_ISO.map((iso) => BY_ISO.get(iso)).filter(Boolean) as Country[];
    const rest = COUNTRIES.filter((c) => !commonSet.has(c.iso)).sort((a, b) =>
      nameOf(a.iso).localeCompare(nameOf(b.iso), lang)
    );
    return { common, rest, nameOf };
  }, [lang]);

  const handleText = (raw: string) => {
    const { iso, national } = normalizePhoneInput(raw, value.iso);
    onChange(buildPhoneValue(iso, national));
  };

  const option = (c: Country) => (
    <option key={c.iso} value={c.iso}>
      {c.flag} {nameOf(c.iso)} +{c.dial}
    </option>
  );

  return (
    <div>
      <label htmlFor={id} className="lv-field__label">
        {label}
      </label>
      {/* dir=ltr: a dial code and a national number read left-to-right in
          every language, including on the Arabic and Kurdish pages. */}
      <div className="lv-phone" dir="ltr">
        <div className="lv-phone__country">
          {/* Compact closed display; the real, accessible <select> sits on
              top at full size with localized names. */}
          <span
            aria-hidden
            className={`lv-phone__display${error ? ' is-error' : ''}${disabled ? ' is-disabled' : ''}`}
          >
            <span className="text-base leading-none">{country.flag}</span>
            <span className="font-semibold tabular-nums">+{country.dial}</span>
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M5.3 7.7a1 1 0 0 1 1.4 0L10 11l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z" />
            </svg>
          </span>
          <select
            id={`${id}-country`}
            aria-label={countryLabel}
            value={country.iso}
            onChange={(e) => onChange(buildPhoneValue(e.target.value, value.national))}
            disabled={disabled}
            className="lv-phone__select"
          >
            <optgroup label={commonLabel ?? '—'}>{common.map(option)}</optgroup>
            <optgroup label={allLabel ?? '—'}>{rest.map(option)}</optgroup>
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
          placeholder={placeholder ?? ''}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={`lv-field__input lv-phone__input${error ? ' is-error' : ''}`}
        />
      </div>
      {/* One reserved line for the message: an error appearing must not push
          the submit button down the page under the thumb that was aiming
          for it. */}
      <p
        id={error ? errorId : hintId}
        className={`lv-field__help${error ? ' is-bad' : ''}`}
      >
        {error || hint || ''}
      </p>
    </div>
  );
}
