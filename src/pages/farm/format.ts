/**
 * Formatting for the Printer Farm. Pure functions, no React, so tests import
 * them directly.
 *
 * Digits are LATIN in every language: coins, grams, countdowns and the
 * machine names beside them are Latin already, and one card mixing two digit
 * systems reads as two documents (the same rule the order screens follow).
 * Nothing here invents a figure — every function formats a number the server
 * sent, or a difference between two server timestamps.
 */
import type { Language } from '../../translations';
import type {
  CustomerTier,
  FarmPrinter,
  JobState,
  LeaderboardBoard,
  Localized,
  PrinterState,
  PrintQuality,
  PublicFarmConfig,
} from '../../lib/farmApi';
import { colorHex, printerModel } from '../../lib/farmApi';
import type { FarmStrings } from './strings';

export function numberLocale(lang: string): string {
  return lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn';
}

/** "1,500" — an integer Farm Coin amount, grouped, Latin digits. */
export function formatCoins(n: number, lang: string): string {
  const v = Number.isFinite(n) ? Math.trunc(n) : 0;
  return new Intl.NumberFormat(numberLocale(lang), { maximumFractionDigits: 0 }).format(v);
}

/** "+120" / "−45" for ledger and away summaries. */
export function formatSignedCoins(n: number, lang: string): string {
  const abs = formatCoins(Math.abs(n), lang);
  if (n > 0) return `+${abs}`;
  if (n < 0) return `−${abs}`;
  return abs;
}

export function formatInt(n: number, lang: string): string {
  return new Intl.NumberFormat(numberLocale(lang), { maximumFractionDigits: 0 }).format(Math.round(n));
}

/** Reputation basis points → "4.20" (0–5000 → 0.00–5.00). */
export function starsFromBp(bp: number): string {
  const v = Math.max(0, Math.min(5000, bp)) / 1000;
  return v.toFixed(2);
}

/** A reputation delta in basis points → "0.15" (no sign; the caller adds it). */
export function starsDelta(bp: number): string {
  return (Math.abs(bp) / 1000).toFixed(2);
}

/** Server `stars` (0.00–5.00) → "4.20". */
export function formatStars(stars: number): string {
  return (Math.max(0, Math.min(5, stars)) || 0).toFixed(2);
}

/**
 * The leaderboard's score column. The reputation board's score is ALWAYS the
 * server's basis points (0–5000) — a score of 5 is 0.01★, not five stars —
 * so no guess is made from its magnitude. Farm value is coins; jobs a count.
 */
export function leaderboardScore(board: LeaderboardBoard, score: number, lang: string, s: FarmStrings): string {
  if (board === 'reputation') return `${starsFromBp(score)}★`;
  if (board === 'farm_value') return formatCoins(score, lang);
  return s.lbJobs(score);
}

/** Operating hours → "12.5 h". */
export function formatHours(hours: number, lang: string): string {
  return `${new Intl.NumberFormat(numberLocale(lang), { maximumFractionDigits: 1 }).format(hours)} h`;
}

/** 0–1 → "96%". */
export function formatPercent(fraction: number, lang: string): string {
  return `${formatInt(Math.max(0, Math.min(1, fraction)) * 100, lang)}%`;
}

/**
 * "180×180×180" with a zero-width space after each "×", so a narrow spec
 * column can break the figure after a dimension instead of cutting it off.
 */
export function formatVolume(volume: readonly number[]): string {
  return volume.map((v) => String(v)).join('×\u200B');
}

const UNITS: Record<Language, { h: string; m: string; s: string; d: string }> = {
  ar: { d: 'ي', h: 'س', m: 'د', s: 'ث' },
  en: { d: 'd', h: 'h', m: 'm', s: 's' },
  ckb: { d: 'ڕ', h: 'ک', m: 'خ', s: 'چ' },
};

/** U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. */
export const FSI = '\u2068';
export const PDI = '\u2069';

/**
 * One "number + unit" token, isolated from the bidi algorithm around it. An
 * Arabic unit letter next to a Latin digit is exactly the mix the algorithm
 * reorders when a cell is forced `dir="ltr"` ("1س 18د" came out "1د18 س").
 * Inside a FIRST-STRONG isolate (what `<bdi>` does) the token resolves on
 * its own from its unit letter: an Arabic or Kurdish unit makes it an RTL
 * island — digits to the right of the unit, as Arabic writes "س4" — and a
 * Latin unit an LTR one ("4h" stays "4h"); the surrounding text (an Arabic
 * sentence, an RTL card) then orders the whole tokens. A left-to-right
 * isolate would instead force Latin order on the Arabic token ("1س" with the
 * digit on the left), which is why FSI. The isolates are zero-width format
 * characters: invisible, ignored by screen readers.
 */
export function bidiToken(value: number | string, unit: string): string {
  return `${FSI}${value}${unit}${PDI}`;
}

/**
 * Game-time duration "4h 32m" from game seconds. Under a minute shows
 * seconds; days appear past 48 hours. Latin digits with a one-letter unit in
 * the UI language, every token bidi-isolated (see `bidiToken`).
 */
export function gameDuration(seconds: number, lang: string): string {
  const u = UNITS[(lang === 'en' || lang === 'ckb' ? lang : 'ar') as Language];
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return bidiToken(total, u.s);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days >= 2) return hours > 0 ? `${bidiToken(days, u.d)} ${bidiToken(hours, u.h)}` : bidiToken(days, u.d);
  const h = days * 24 + hours;
  if (h > 0) return mins > 0 ? `${bidiToken(h, u.h)} ${bidiToken(mins, u.m)}` : bidiToken(h, u.h);
  return bidiToken(mins, u.m);
}

/**
 * A real-time countdown between two server instants, in milliseconds. Shows
 * "12:34" under an hour (digits and a colon: direction-neutral, left as is),
 * "1h 05m" past it and "2d 3h" past two days (unit tokens bidi-isolated), and
 * "0:00" when the moment has passed — the client never claims a state from it.
 */
export function countdown(ms: number, lang: string): string {
  const u = UNITS[(lang === 'en' || lang === 'ckb' ? lang : 'ar') as Language];
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days >= 2) return `${bidiToken(days, u.d)} ${bidiToken(hours, u.h)}`;
  const h = days * 24 + hours;
  return `${bidiToken(h, u.h)} ${bidiToken(mins.toString().padStart(2, '0'), u.m)}`;
}

/** Real minutes for a game duration, given the config's time scale. */
export function realSecondsFor(gameSeconds: number, timeScale: number): number {
  const scale = timeScale > 0 ? timeScale : 1;
  return gameSeconds / scale;
}

/** Milliseconds of a server ISO string, or null when unparseable. */
export function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Fraction of a timed window that has elapsed at `now`, from the two SERVER
 * timestamps that bound it. Clamped to [0, 1]; a bad window is 0.
 */
export function progressFraction(startIso: string | null | undefined, endIso: string | null | undefined, now: number): number {
  const a = ms(startIso);
  const b = ms(endIso);
  if (a === null || b === null || b <= a) return 0;
  return Math.max(0, Math.min(1, (now - a) / (b - a)));
}

export function formatDateTime(iso: string | null | undefined, lang: string): string {
  const t = ms(iso);
  if (t === null) return '';
  return new Intl.DateTimeFormat(numberLocale(lang), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(t));
}

// ------------------------------------------------------------------ labels

export function printerStateLabel(state: PrinterState | string, s: FarmStrings): string {
  switch (state) {
    case 'idle':
      return s.stateIdle;
    case 'printing':
      return s.statePrinting;
    case 'done':
      return s.stateDone;
    case 'maintenance':
      return s.stateMaintenance;
    case 'broken':
      return s.stateBroken;
    default:
      return String(state);
  }
}

export function jobStateLabel(state: JobState | string, s: FarmStrings): string {
  switch (state) {
    case 'accepted':
      return s.jobAccepted;
    case 'printing':
      return s.jobPrinting;
    case 'ready':
      return s.jobReady;
    case 'delivered':
      return s.jobDelivered;
    case 'late':
      return s.jobLate;
    case 'cancelled':
      return s.jobCancelled;
    default:
      return String(state);
  }
}

export function tierLabel(tier: CustomerTier | string, s: FarmStrings): string {
  switch (tier) {
    case 'individual':
      return s.tierIndividual;
    case 'small_business':
      return s.tierSmallBusiness;
    case 'merchant':
      return s.tierMerchant;
    case 'company':
      return s.tierCompany;
    case 'industrial':
      return s.tierIndustrial;
    default:
      return String(tier);
  }
}

export function qualityLabel(q: PrintQuality | string, s: FarmStrings): string {
  switch (q) {
    case 'draft':
      return s.qualityDraft;
    case 'standard':
      return s.qualityStandard;
    case 'fine':
      return s.qualityFine;
    case 'ultra':
      return s.qualityUltra;
    default:
      return String(q);
  }
}

/** The ledger kind as a label; an unknown kind is shown as the server sent it. */
export function ledgerKindLabel(kind: string, s: FarmStrings): string {
  return s.ledgerKinds[kind] ?? kind.replace(/_/g, ' ');
}

/**
 * Colour names the config is expected to use, as CSS colours for swatches.
 * A hex value passes through; an unknown name gets a neutral swatch (the
 * NAME is still printed beside it, so nothing is hidden).
 */
const COLOR_SWATCH: Record<string, string> = {
  black: '#111114',
  white: '#ECECEC',
  grey: '#8A8A8F',
  gray: '#8A8A8F',
  silver: '#B8B8BD',
  red: '#C0392B',
  orange: '#E67E22',
  yellow: '#E8C547',
  gold: '#BAA369',
  green: '#4F8A4B',
  olive: '#7D8A4B',
  blue: '#2E6FB5',
  navy: '#1F3A6A',
  cyan: '#3AB0C9',
  teal: '#2F8F86',
  purple: '#6B4BA3',
  pink: '#D66C9E',
  brown: '#7A5233',
  beige: '#D9C7A6',
  transparent: '#9BB1C6',
  natural: '#D8D2C2',
};

export function colorSwatch(name: string): string {
  const key = (name || '').trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(key)) return key;
  return COLOR_SWATCH[key] ?? '#5B5B62';
}

/** The swatch for a colour key: the config's hex when it has one, else the name table. */
export function swatchFor(config: PublicFarmConfig | null | undefined, key: string): string {
  return colorHex(config, key) ?? colorSwatch(key);
}

/**
 * A name in the UI language. Accepts the plain string the contract describes
 * or the {ar,en,ckb} object the engine sends; ckb falls back to Arabic, the
 * source language, never to a machine translation.
 */
export function nameOf(x: Localized | null | undefined, lang: string, fallback = ''): string {
  if (x === null || x === undefined) return fallback;
  if (typeof x === 'string') return x || fallback;
  if (lang === 'en') return x.en || x.ar || x.ckb || fallback;
  if (lang === 'ckb') return x.ckb || x.ar || x.en || fallback;
  return x.ar || x.en || x.ckb || fallback;
}

/**
 * What a machine is called, everywhere one is named: the player's nickname,
 * or — for a row the server sent nameless — "<model name> <slot + 1>" (the
 * same default the server now gives new machines), so a card title, a room
 * label or a dialog's accessible name is never an empty string.
 */
export function printerName(p: Pick<FarmPrinter, 'nickname' | 'model_key' | 'slot'>, config: PublicFarmConfig | null | undefined, lang: string): string {
  const nick = (p.nickname ?? '').trim();
  if (nick) return nick;
  return `${nameOf(printerModel(config, p.model_key)?.name, lang, p.model_key)} ${p.slot + 1}`;
}

/** Localised product name from the config (either shape), falling back to the given title. */
export function localName(
  def: { name?: Localized; name_ar?: string; name_en?: string; name_ckb?: string } | null | undefined,
  lang: string,
  fallback: string
): string {
  if (!def) return fallback;
  if (def.name) return nameOf(def.name, lang, fallback);
  if (lang === 'en') return def.name_en || def.name_ar || fallback;
  if (lang === 'ckb') return def.name_ckb || def.name_ar || fallback;
  return def.name_ar || def.name_en || fallback;
}
