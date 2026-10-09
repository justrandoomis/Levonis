/**
 * WARRANTY TIME, AS A PERSON SAYS IT — pure, no I/O, shared by the warranty
 * screens, the trade-in screens and the tests.
 */
const DAY_MS = 86_400_000;

/** Calendar-month addition, UTC, clamped to the target month's last day (worker/lib/membershipOps.ts `addMonths`). */
function plusMonths(fromMs: number, months: number): number {
  const d = new Date(fromMs);
  const day = d.getUTCDate();
  const t = new Date(fromMs);
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + months);
  const daysInTarget = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, daysInTarget));
  return t.getTime();
}

/**
 * WHAT IS LEFT OF A WARRANTY, AS A PERSON SAYS IT (owner decision 3,
 * 2026-10-09): whole calendar months from now, then the remaining whole days,
 * until the end date. The owner's example — twelve months from delivery,
 * traded in thirty days later — reads «11 months 0 days» (where the rounded-up
 * `warrantyMonthsLeft` says 12). DISPLAY ONLY: the valuation keeps its own
 * rounding, which is a money rule. Zero and zero once the end has passed.
 */
export function warrantyTimeLeft(endIso: string | null | undefined, nowIso: string): { months: number; days: number } {
  const end = endIso ? Date.parse(endIso) : NaN;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(end) || !Number.isFinite(now) || end <= now) return { months: 0, days: 0 };
  let months = 0;
  while (months < 600 && plusMonths(now, months + 1) <= end) months++;
  const days = Math.floor((end - plusMonths(now, months)) / DAY_MS);
  return { months, days };
}

// ------------------------------------------------------------------ words

/** The three languages every warranty sentence is written in. */
export type WarrantyLang = 'ar' | 'en' | 'ckb';

/**
 * «N months» as a person writes it. Arabic takes its singular, its dual and
 * its two plurals (شهر واحد / شهران / N أشهر / N شهرًا); English its singular;
 * Sorani keeps the noun singular after a number (N مانگ). `fmt` renders the
 * digits (a screen may localise them); the plural is chosen on the number.
 */
export function monthsWords(n: number, lang: WarrantyLang, fmt: (n: number) => string = String): string {
  const f = fmt(n);
  if (lang === 'en') return n === 1 ? `${f} month` : `${f} months`;
  if (lang === 'ckb') return `${f} مانگ`;
  if (n === 1) return 'شهر واحد';
  if (n === 2) return 'شهران';
  if (n >= 3 && n <= 10) return `${f} أشهر`;
  return `${f} شهرًا`;
}

/** «N days», the same way (يوم واحد / يومان / N أيام / N يومًا; N ڕۆژ). */
export function daysWords(n: number, lang: WarrantyLang, fmt: (n: number) => string = String): string {
  const f = fmt(n);
  if (lang === 'en') return n === 1 ? `${f} day` : `${f} days`;
  if (lang === 'ckb') return `${f} ڕۆژ`;
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  if (n >= 3 && n <= 10) return `${f} أيام`;
  return `${f} يومًا`;
}

/**
 * What is left (`warrantyTimeLeft`) in words: months, then days — a part
 * that is zero is left out («11 شهرًا», not «11 شهر و0 يوم»), and nothing
 * left at all reads as zero days.
 */
export function timeLeftWords(left: { months: number; days: number }, lang: WarrantyLang, fmt: (n: number) => string = String): string {
  const m = Math.max(0, Math.trunc(left.months));
  const d = Math.max(0, Math.trunc(left.days));
  if (m === 0) return daysWords(d, lang, fmt);
  if (d === 0) return monthsWords(m, lang, fmt);
  if (lang === 'en') return `${monthsWords(m, lang, fmt)} ${daysWords(d, lang, fmt)}`;
  return `${monthsWords(m, lang, fmt)} و${lang === 'ckb' ? ' ' : ''}${daysWords(d, lang, fmt)}`;
}
