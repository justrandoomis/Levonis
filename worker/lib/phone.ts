/**
 * Phone identity: one normalization, every country.
 *
 * WHAT CHANGED AND WHY. This file used to hard-code Iraq: `+964` was
 * accepted only in the mobile shape `7XXXXXXXXX`, and every other country
 * fell through to "a leading + and 8–15 digits" — a length check, not a
 * validation. That was honest about being a length check, but it meant
 * `+971000000000` was accepted as a UAE number and a real number from a
 * country with a shorter national format could be rejected. LEVONIS now has
 * users outside Iraq, so the rule is no longer "Iraq, plus a shrug".
 *
 * Validation is delegated to `libphonenumber-js` (Google's libphonenumber
 * metadata), so every country's real numbering plan decides — not a regex
 * somebody wrote from one example number.
 *
 * WHAT IS DELIBERATELY *NOT* CHECKED: whether the number is a MOBILE line.
 * The `min` metadata bundled here cannot tell mobile from fixed-line in
 * every country (in the US the whole range is `FIXED_LINE_OR_MOBILE`), so
 * requiring "mobile" would reject perfectly valid numbers in some countries
 * and wave through anything in others. Ownership is proven by Telegram
 * answering on that number — not by its number range.
 *
 * INPUT SHAPES THAT MUST KEEP WORKING:
 *   `07701234567`      a local Iraqi number typed by a customer
 *   `٠٧٧٠١٢٣٤٥٦٧`      the same, in Arabic-Indic digits
 *   `009647701234567`  the international 00 prefix
 *   `9647701234567`    a Telegram `contact.phone_number` — NO leading '+',
 *                      already international. This one is why the bare-digit
 *                      branch exists at all, and why it is tried as
 *                      international *after* the default country fails.
 *
 * Comparison is always full E.164. There is no suffix matching anywhere: two
 * numbers are the same number or they are not.
 */
import { parsePhoneNumberFromString, getCountries, getCountryCallingCode } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

/** The country assumed when a number arrives with no country information. */
export const DEFAULT_COUNTRY: CountryCode = 'IQ';

/** Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits → ASCII. */
export function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return String((c >= 0x06f0 ? c - 0x06f0 : c - 0x0660) % 10);
  });
}

function isCountry(v: unknown): v is CountryCode {
  return typeof v === 'string' && /^[A-Z]{2}$/.test(v) && (getCountries() as string[]).includes(v);
}

/**
 * Any accepted input shape → E.164, or null when it is not a real number in
 * any reading. `defaultCountry` only decides how a number with no country
 * information is read; an explicitly international number ignores it.
 */
export function normalizePhone(raw: string, defaultCountry: string = DEFAULT_COUNTRY): string | null {
  if (typeof raw !== 'string') return null;
  let s = toAsciiDigits(raw).trim().replace(/[\s\-().‎‏]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;

  const country = isCountry(defaultCountry) ? defaultCountry : DEFAULT_COUNTRY;

  // Explicitly international: the country is in the number, so nothing may
  // override it.
  if (s.startsWith('+')) {
    if (!/^\+\d{4,17}$/.test(s)) return null;
    const parsed = parsePhoneNumberFromString(s);
    return parsed && parsed.isValid() ? parsed.number : null;
  }

  if (!/^\d{4,17}$/.test(s)) return null;

  // Bare digits, read the way the person most likely meant them: first as a
  // national number in their country, then as an international number that
  // simply lost its '+' — which is exactly how Telegram delivers a shared
  // contact.
  const asNational = parsePhoneNumberFromString(s, country);
  if (asNational && asNational.isValid()) return asNational.number;

  const asInternational = parsePhoneNumberFromString(`+${s}`);
  if (asInternational && asInternational.isValid()) return asInternational.number;

  return null;
}

/**
 * The ISO country of an E.164 number — BEST-EFFORT, and only ever for
 * display. Calling codes are shared (+44 covers the UK, Guernsey, Jersey and
 * the Isle of Man; +1 covers twenty-odd countries), and some ranges genuinely
 * cannot be told apart. Nothing security-relevant may key off this: the
 * identity is the E.164 number itself.
 */
export function countryOfPhone(e164: string): string | null {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed?.country ?? null;
}

export function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na !== null && nb !== null && na === nb;
}

/**
 * Masked display: `+9647******567`. Keeps the dial code (so the owner
 * recognises their own country) and the last three digits (so they
 * recognise their own number), and nothing in between.
 */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '***';
  return `${e164.slice(0, 5)}${'*'.repeat(Math.max(0, e164.length - 8))}${e164.slice(-3)}`;
}

/** Every callable country, with its dial code. Ordered by ISO code. */
export function allCountries(): { iso: string; dial: string }[] {
  return getCountries()
    .map((iso) => ({ iso: iso as string, dial: getCountryCallingCode(iso) as string }))
    .sort((a, b) => a.iso.localeCompare(b.iso));
}

// ===========================================================================
//  SEARCH KEYS — AND THE INVARIANT THEY DO NOT REPEAL
// ===========================================================================
/**
 * THIS IS SEARCH. IT IS NOT IDENTITY.
 *
 * The header of this module states the rule the rest of the platform runs on:
 * «Comparison is always full E.164. There is no suffix matching anywhere.»
 * That rule is about deciding WHO SOMEBODY IS — logging in, claiming an
 * account, binding a Telegram contact to a user — and it still governs every
 * one of those paths without exception.
 *
 * What follows is for ONE caller: the admin order board's search box, where a
 * person is holding a paper receipt or a courier is on the phone and the
 * question is "which order is this", not "who is this". Nothing here decides a
 * permission, an ownership or a login. A suffix match that shows an admin one
 * extra order costs a second glance; a suffix match that decides identity is
 * account takeover, and that is why the two live behind different functions
 * with this paragraph between them.
 *
 * WHY A SUFFIX IS NEEDED AT ALL. `orders.address_snapshot` is frozen history —
 * a JSON copy of the address row as it stood at checkout. Orders placed before
 * the address validator normalised phones carry `+964-0770 123 4567`; orders
 * placed after carry `+9647701234567`. Exact equality finds the second and
 * misses the first, and the admin searching for a customer they served last
 * year gets nothing with no error to explain it. The NATIONAL NUMBER is what
 * both shapes end with, so that is the key.
 */
export interface PhoneSearchKeys {
  /**
   * Full E.164 when the input is a real number in some country, else null.
   * This is the IDENTITY key and is compared with `=` against
   * `users.phone_e164` — the account's own phone, which is always normalised.
   */
  e164: string | null;
  /** Every ASCII digit typed, Arabic-Indic folded. '' when none were. */
  digits: string;
  /**
   * The national significant number — no country code, no trunk zero. The
   * suffix BOTH stored snapshot shapes end with, and therefore the only part
   * of a phone worth matching loosely.
   */
  national: string;
}

/**
 * The longest national number in the world is 15 digits (E.164's ceiling
 * minus nothing); capping here keeps a pasted paragraph of digits from
 * becoming a LIKE pattern, which `likePattern` would truncate anyway.
 */
const MAX_NATIONAL_DIGITS = 15;

/**
 * What an admin typed, turned into the two keys the board's phone clause
 * binds. Pure: no database, no clock, no I/O.
 *
 * The fallback path matters as much as the parsed one. `libphonenumber`
 * refuses a PARTIAL number — an admin who has typed `07701` while reading it
 * off a receipt has no valid number yet — and a search that only worked on
 * complete numbers would be dead for every keystroke but the last. So when
 * parsing fails, the international and trunk prefixes are stripped by hand and
 * whatever remains is used as the suffix.
 */
export function phoneSearchKeys(raw: unknown): PhoneSearchKeys {
  const text = typeof raw === 'string' ? raw : '';
  const digits = toAsciiDigits(text).replace(/\D/g, '').slice(0, 20);
  if (!digits) return { e164: null, digits: '', national: '' };

  const parsed = normalizePhone(text);
  if (parsed) {
    const p = parsePhoneNumberFromString(parsed);
    const national = p?.nationalNumber ? String(p.nationalNumber) : strippedNational(digits);
    return { e164: parsed, digits, national: national.slice(-MAX_NATIONAL_DIGITS) };
  }
  return { e164: null, digits, national: strippedNational(digits).slice(-MAX_NATIONAL_DIGITS) };
}

/**
 * The by-hand fallback: drop the `00` international prefix, then Iraq's `964`,
 * then the trunk `0`. In that order, because `009647...`, `9647...`, `07...`
 * and `7...` are the four shapes a number reaches this codebase in, and each
 * is the previous one with a prefix in front.
 *
 * Only Iraq's code is stripped by hand. A foreign number that fails to parse
 * is left with its country code on, which narrows the suffix rather than
 * widening it — the safe direction for a match that must not surprise.
 */
function strippedNational(digits: string): string {
  let n = digits;
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('964')) n = n.slice(3);
  return n.replace(/^0+/, '') || n;
}
