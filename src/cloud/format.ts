/**
 * PRINT CLOUD FIGURES, WRITTEN ONE WAY IN THREE LANGUAGES.
 *
 * The server's units are integers — seconds, grams (or the variant's own base
 * unit), dinars — and every helper here only WRITES them; none converts a
 * number that is then sent back (tests/displayCurrency.test.ts). Each takes
 * the reader's language and answers «—» or null for a figure it was not
 * given, never a zero it invented:
 *
 *   formatDuration(8280, 'en')   «2h 18m»    (ar «2 س 18 د», ckb «2 کاتژمێر 18 خولەک»)
 *   hoursParts(66240, 'en')      { value: '18.4', unit: 'h' }
 *   formatDays(7, 'ar')          «7 أيام» (يوم واحد، يومان، 30 يومًا)
 *   massParts(1250, 'ar')        { value: '1.25', unit: 'كيلوغرام' }
 *   formatQuantity(20, 'pc', …)  «20 pcs» / «20 قطعة» / «20 دانە»
 *   formatIqd(24250, 'en')       «24,250 IQD» (the house money rule, src/lib/money.ts)
 *   formatRelative(iso, 'ckb')   «5 خولەک لەمەوبەر»
 *   progressPercent(142, 230)    61 — only from two real numbers, never above 100
 *
 * DIGITS. Counts, hours and grams go through the house `formatFigure`, so they
 * share the digits of the dinar beside them (src/lib/localeNumber.ts); dates
 * are the order screens' own (src/components/orders/format.ts — Latin digits,
 * Sorani months written by hand, since Chromium ships no Sorani locale).
 *
 * ROUNDING NEVER FLATTERS: a balance or a progress is floored, so the screen
 * never shows an hour, a gram or a percent the customer does not have.
 */
import type { Language } from '../translations';
import { formatFigure, formatPercent as housePercent } from '../lib/localeNumber';
import { formatMoney } from '../lib/money';
import { formatDate as orderDate, formatDateTime as orderDateTime } from '../components/orders/format';
import type { Tri } from './types';

const pick = (t: Tri, lang: Language) => t[lang];

// ------------------------------------------------------------------ time

const HOUR_UNIT: Tri = { ar: 'ساعة', en: 'h', ckb: 'کاتژمێر' };
const SHORT_HOUR: Tri = { ar: 'س', en: 'h', ckb: 'کاتژمێر' };
const SHORT_MINUTE: Tri = { ar: 'د', en: 'm', ckb: 'خولەک' };
const UNDER_A_MINUTE: Tri = { ar: 'أقل من دقيقة', en: 'under 1m', ckb: 'کەمتر لە خولەکێک' };

/** Whole seconds, floored, or null for anything that is not a real figure. */
function wholeSeconds(seconds: number | null | undefined): number | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  return Math.max(0, Math.floor(seconds));
}

/**
 * A duration as a person reads it: «2h 18m», «45m», «3h». Minutes are
 * floored (an estimate of 2h 18m 50s is «2h 18m», not «2h 19m»); a positive
 * duration under a minute says so rather than «0m». `null` → «—».
 */
export function formatDuration(seconds: number | null | undefined, lang: Language): string {
  const s = wholeSeconds(seconds);
  if (s === null) return '—';
  if (s > 0 && s < 60) return pick(UNDER_A_MINUTE, lang);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const hours = `${formatFigure(h, lang)}${lang === 'en' ? '' : ' '}${pick(SHORT_HOUR, lang)}`;
  const minutes = `${formatFigure(m, lang)}${lang === 'en' ? '' : ' '}${pick(SHORT_MINUTE, lang)}`;
  if (h === 0) return minutes;
  if (m === 0) return hours;
  return `${hours} ${minutes}`;
}

/** Seconds as decimal hours, FLOORED to `decimals` places: 66,239 s is 18.3 h, never 18.4. */
export function hoursFigure(seconds: number, decimals = 1): number {
  const s = wholeSeconds(seconds) ?? 0;
  const scale = 10 ** decimals;
  // Multiply first: the integer product is exact, so the floor never loses a
  // tenth to a binary rounding error (x.99999… floored one step too low).
  return Math.floor((s * scale) / 3600) / scale;
}

/** The unit word that follows an hour figure: «h» / «ساعة» / «کاتژمێر». */
export function hoursUnit(lang: Language): string {
  return pick(HOUR_UNIT, lang);
}

/** `{ value: '18.4', unit: 'h' }` — the figure and its unit, for a figure set larger than its unit. */
export function hoursParts(seconds: number, lang: Language, decimals = 1): { value: string; unit: string } {
  return { value: formatFigure(hoursFigure(seconds, decimals), lang, decimals), unit: hoursUnit(lang) };
}

/** «18.4 h» / «18.4 ساعة» / «18.4 کاتژمێر». */
export function formatHours(seconds: number | null | undefined, lang: Language, decimals = 1): string {
  if (wholeSeconds(seconds) === null) return '—';
  const p = hoursParts(seconds as number, lang, decimals);
  return `${p.value} ${p.unit}`;
}

/**
 * A count of days as a phrase: «30 days» / «30 يومًا» / «30 ڕۆژ» — a
 * package's expiry, a hold. Arabic agrees the noun with its number (يوم واحد،
 * يومان، 3–10 أيام، 11–99 يومًا، مئة يوم), Sorani keeps it singular after
 * any number, English only after one.
 */
export function formatDays(days: number, lang: Language): string {
  const n = Math.max(0, Math.floor(Number.isFinite(days) ? days : 0));
  const figure = formatFigure(n, lang);
  if (lang === 'en') return n === 1 ? '1 day' : `${figure} days`;
  if (lang === 'ckb') return `${figure} ڕۆژ`;
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  const tail = n % 100;
  if (tail >= 3 && tail <= 10) return `${figure} أيام`;
  if (tail >= 11) return `${figure} يومًا`;
  return `${figure} يوم`;
}

// ------------------------------------------------------------------ quantities

/** The six units of `pc_units` (migrations/0215_print_cloud.sql), as a reader sees them after a figure. */
const UNIT_WORDS: Record<string, Tri> = {
  g: { ar: 'غرام', en: 'g', ckb: 'گرام' },
  kg: { ar: 'كيلوغرام', en: 'kg', ckb: 'کیلۆگرام' },
  pc: { ar: 'قطعة', en: 'pcs', ckb: 'دانە' },
  set: { ar: 'طقم', en: 'sets', ckb: 'دەست' },
  mm: { ar: 'مم', en: 'mm', ckb: 'ملم' },
  m: { ar: 'متر', en: 'm', ckb: 'مەتر' },
};

/** The word after a figure in this unit, or the code itself for a unit this table does not know. */
export function unitWord(unitCode: string, lang: Language): string {
  const w = UNIT_WORDS[unitCode];
  return w ? pick(w, lang) : unitCode;
}

/**
 * Grams as a reader sees them: grams under a kilogram, kilograms (up to two
 * decimals, floored) from 1,000 g. Display only — the server counts grams.
 */
export function massParts(grams: number, lang: Language): { value: string; unit: string } {
  const g = Math.max(0, Math.floor(Number.isFinite(grams) ? grams : 0));
  if (g < 1000) return { value: formatFigure(g, lang), unit: unitWord('g', lang) };
  return { value: formatFigure(Math.floor(g / 10) / 100, lang, 2), unit: unitWord('kg', lang) };
}

/** «650 g» / «1.25 kg»; `null` → «—». */
export function formatMass(grams: number | null | undefined, lang: Language): string {
  if (grams == null || !Number.isFinite(grams)) return '—';
  const p = massParts(grams, lang);
  return `${p.value} ${p.unit}`;
}

/**
 * A quantity in its variant's base unit: grams through `formatMass`, a
 * length in metres from 1,000 mm, anything else as counted. `null` → «—».
 */
export function formatQuantity(qty: number | null | undefined, unitCode: string, lang: Language): string {
  if (qty == null || !Number.isFinite(qty)) return '—';
  if (unitCode === 'g') return formatMass(qty, lang);
  if (unitCode === 'mm' && qty >= 1000) return `${formatFigure(Math.floor(qty / 10) / 100, lang, 2)} ${unitWord('m', lang)}`;
  return `${formatFigure(Math.floor(qty), lang)} ${unitWord(unitCode, lang)}`;
}

// ------------------------------------------------------------------ money

/**
 * Integer dinars as text, by the house rule (src/lib/money.ts): «24,250 IQD»
 * in English, «24,250 د.ع» in Arabic and Sorani. In JSX prefer
 * `<Money iqd={…} />` (src/components/ui/Money.tsx), which keeps the figure
 * an LTR island. Never converted: Print Cloud charges dinars.
 */
export function formatIqd(iqd: number | null | undefined, lang: Language): string {
  return formatMoney(iqd, lang);
}

// ------------------------------------------------------------------ dates

/** «14 Oct 2026» / «14ی تشرینی یەکەم 2026»; '' for a missing or broken date. */
export function formatDate(iso: string | null | undefined, lang: Language): string {
  return orderDate(iso, lang);
}

/** The same with the time of day. */
export function formatDateTime(iso: string | null | undefined, lang: Language): string {
  return orderDateTime(iso, lang);
}

const NOW: Tri = { ar: 'الآن', en: 'just now', ckb: 'ئێستا' };
const CKB_UNITS = { minute: 'خولەک', hour: 'کاتژمێر', day: 'ڕۆژ' } as const;

/**
 * «5 minutes ago», «in 3 hours», «yesterday» — up to a week either way, then
 * the date itself. Arabic and English through `Intl` (Latin digits, as the
 * dates are); Sorani written here, since Chromium has no Sorani locale: a
 * counted noun stays singular in Sorani («5 خولەک»), so the sentence needs
 * no plural rules. `now` is injectable for the tests.
 */
export function formatRelative(iso: string | null | undefined, lang: Language, now: number = Date.now()): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const diff = Math.round((at - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return pick(NOW, lang);
  // The unit switches where the rounded count would reach the next one: 59 m 50 s
  // is «1 hour», never «60 minutes».
  const unit: 'minute' | 'hour' | 'day' = abs < 3570 ? 'minute' : abs < 84600 ? 'hour' : 'day';
  const size = unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400;
  if (unit === 'day' && abs >= 7 * 86400) return formatDate(iso, lang);
  const n = Math.max(1, Math.round(abs / size));
  if (lang === 'ckb') return diff < 0 ? `${n} ${CKB_UNITS[unit]} لەمەوبەر` : `دوای ${n} ${CKB_UNITS[unit]}`;
  try {
    const rtf = new Intl.RelativeTimeFormat(lang === 'en' ? 'en' : 'ar-IQ-u-nu-latn', { numeric: 'auto' });
    return rtf.format(diff < 0 ? -n : n, unit);
  } catch {
    // An engine without RelativeTimeFormat: the moment itself is still true.
    return formatDateTime(iso, lang);
  }
}

// ------------------------------------------------------------------ progress

/**
 * A percentage from two REAL numbers — done and total, both finite, the total
 * positive — floored and kept within 0–100. Anything else is null, and the
 * screen then shows no bar at all rather than an invented one.
 */
export function progressPercent(done: number | null | undefined, total: number | null | undefined): number | null {
  if (done == null || total == null || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0) return null;
  // Multiply first (see hoursFigure): 29 of 50 is 58%, not the 57 of (29 / 50) * 100.
  return Math.min(100, Math.max(0, Math.floor((done * 100) / total)));
}

/** A printer's own progress (`progress_permille`, 0–1000) as a floored percentage, or null. */
export function permillePercent(permille: number | null | undefined): number | null {
  return progressPercent(permille, 1000);
}

/** «62%» / «62٪» in the reader's digits. */
export function formatPercent(percent: number, lang: Language): string {
  return housePercent(percent, lang, 0);
}

// ------------------------------------------------------------------ printers

const MM: Tri = { ar: 'مم', en: 'mm', ckb: 'ملم' };

/** A build volume: `{ figure: '256 × 256 × 256', unit: 'mm' }` — render the figure as an LTR island. */
export function buildVolumeParts(mm: { x: number; y: number; z: number }, lang: Language): { figure: string; unit: string } {
  return { figure: `${mm.x} × ${mm.y} × ${mm.z}`, unit: pick(MM, lang) };
}

/** A nozzle diameter in micrometres as millimetres: 400 → «0.4 mm». */
export function formatNozzle(um: number, lang: Language): string {
  return `${formatFigure(um / 1000, lang, 2)} ${pick(MM, lang)}`;
}
