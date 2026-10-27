/**
 * PRINT CLOUD ADMIN — how a figure of the workshop is written.
 *
 * Time is integer SECONDS on the wire, money integer DINARS, quantities
 * integers in the variant's base unit, temperatures DECI-degrees, progress
 * PER-MILLE and rates BASIS POINTS. Each is written here once, in Latin digits
 * (every id and amount beside them is Latin already — the house rule of
 * src/components/orders/format.ts, whose Sorani-aware dates this reuses).
 *
 * Nothing here invents a figure: null or undefined is «—».
 */
import { formatDate, formatDateTime } from '../orders/format';
import { pick, tri, type Lang, type Tri } from './i18n';

export { formatDate, formatDateTime };

const H = tri('ساعة', 'h', 'کاتژمێر');
const MIN = tri('دقيقة', 'min', 'خولەک');
const SEC = tri('ثانية', 's', 'چرکە');
const DAY = tri('يوم', 'd', 'ڕۆژ');
const MB = tri('ميغابايت', 'MB', 'مێگابایت');
const BYTES = tri('بايت', 'B', 'بایت');
const MICRONS = tri('ميكرون', 'µm', 'مایکرۆن');

/**
 * «from → to» in the reader's direction. U+2192 is not mirrored, so in an RTL
 * line (ar, ckb) it would point back at the from-value: there the arrow is «←».
 */
export function arrow(lang: Lang): string {
  return lang === 'en' ? '→' : '←';
}

/** A count of seconds with its unit word: «9,000 ثانية» / «9,000 s». */
export function secondsCount(n: number | null | undefined, lang: Lang): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${num(n)} ${pick(SEC, lang)}`;
}

/** A count of bytes with its unit word. */
export function bytesCount(n: number | null | undefined, lang: Lang): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${num(n)} ${pick(BYTES, lang)}`;
}

/** Micrometres (a nozzle): «400 ميكرون» / «400 µm». */
export function microns(n: number | null | undefined, lang: Lang): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${num(n)} ${pick(MICRONS, lang)}`;
}

/** A count, grouped, Latin digits. */
export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

/** «12 h 30 min» from seconds (seconds shown only under an hour). */
export function duration(seconds: number | null | undefined, lang: Lang): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${num(h)} ${pick(H, lang)}`);
  if (m || (h && rest)) parts.push(`${m} ${pick(MIN, lang)}`);
  if (!h && (rest || !m)) parts.push(`${rest} ${pick(SEC, lang)}`);
  return parts.join(' ');
}

/** Signed seconds, for a balance adjustment: «+2 h» / «−30 min». */
export function signedDuration(seconds: number, lang: Lang): string {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '−' : '';
  return `${sign}${duration(Math.abs(seconds), lang)}`;
}

/** Per-mille as a percentage: 455 → «45.5%». */
export function permille(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  return `${(p / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

/** Basis points as a percentage: 1250 → «12.5%». */
export function bps(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—';
  return `${(b / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** Deci-degrees as degrees: 2150 → «215 °C». */
export function temp(dc: number | null | undefined): string {
  if (dc === null || dc === undefined || !Number.isFinite(dc)) return '—';
  return `${(dc / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} °C`;
}

/** Bytes as megabytes: 41943040 → «40 MB» (the unit in the reader's language). */
export function megabytes(bytes: number | null | undefined, lang: Lang): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  return `${(bytes / 1048576).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${pick(MB, lang)}`;
}

const UNIT_WORDS: Readonly<Record<string, Tri>> = {
  g: tri('غ', 'g', 'گرام'),
  kg: tri('كغ', 'kg', 'کیلۆ'),
  pc: tri('قطعة', 'pcs', 'دانە'),
  set: tri('طقم', 'sets', 'دەست'),
  mm: tri('مم', 'mm', 'ملم'),
  m: tri('م', 'm', 'مەتر'),
};

/** A quantity in its variant's base unit: «1,200 g», «20 pcs». */
export function qty(n: number | null | undefined, unit: string | null | undefined, lang: Lang): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const word = unit && Object.prototype.hasOwnProperty.call(UNIT_WORDS, unit) ? pick(UNIT_WORDS[unit], lang) : unit ?? '';
  return `${num(n)}${word ? ` ${word}` : ''}`;
}

/** How long ago, in whole seconds/minutes/hours/days, from an age in seconds. */
export function ago(ageSeconds: number | null | undefined, lang: Lang): string {
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(ageSeconds)) return '—';
  const s = Math.max(0, Math.floor(ageSeconds));
  const value = s < 60 ? `${s} ${pick(SEC, lang)}` : s < 3600 ? `${Math.floor(s / 60)} ${pick(MIN, lang)}` : s < 86400 ? `${Math.floor(s / 3600)} ${pick(H, lang)}` : `${Math.floor(s / 86400)} ${pick(DAY, lang)}`;
  return pick(tri(`منذ ${value}`, `${value} ago`, `${value} لەمەوبەر`), lang);
}

/** Seconds since an ISO time, or null. */
export function ageOf(at: string | null | undefined, now = Date.now()): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : null;
}

/** A value for a `datetime-local` box, in the device's time zone. */
export function toLocalInput(at: string | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value back to an ISO instant, or null when empty or invalid. */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A short id for a table cell (the whole id stays in the title and the copy). */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-5)}` : id;
}
