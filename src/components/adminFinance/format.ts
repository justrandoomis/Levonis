/**
 * HOW THIS SCREEN WRITES A NUMBER — and why it does not invent a second rule.
 *
 * ---------------------------------------------------------------------------
 * DIGITS: THE ORDER BOARD ALREADY DECIDED, SO THIS FOLLOWS IT.
 *
 * `arabicDigits` and `countText` are IMPORTED from
 * src/components/adminOrders/OrderBoardBadges.tsx rather than re-written here.
 * A second copy of the ٠-٩ fold is a second thing to change, and the day the
 * two disagree is the day the orders tab and the profit tab write the same
 * count in different digits on the same screen. The rule that file established,
 * and this one keeps:
 *
 *   COUNTS (orders, lines, units, entries, page numbers) are written in the
 *   digits of the language being read — Arabic-Indic for ar and ckb, Latin for
 *   en. Kurdish is NOT an exception: ckb is written in the Arabic script and
 *   takes Arabic-Indic digits, which is also why nothing here branches on
 *   direction (`dir === 'rtl'` is true for both ar and ckb and would answer
 *   Arabic for a Kurdish reader).
 *
 *   MONEY goes through `formatIqd` from src/lib/api.ts — the same function the
 *   order board's row, the invoice and the wallet already use, «د.ع» and all.
 *   It is deliberately NOT re-folded to Arabic-Indic here: a total on the
 *   orders tab and the same total on this tab must be one string.
 *
 * ---------------------------------------------------------------------------
 * COMPACT FIGURES ARE FOR AXES AND TIPS ONLY, NEVER FOR A FACT.
 *
 * «٢٫٤ م» on a y-axis tick is a scale marker and is read as one. The same
 * rounding on the hero figure would quietly hide 40,000 dinars, so every
 * headline number, every table cell and every tooltip prints the exact integer
 * through `formatIqd`. Compaction stops where the number stops being a label.
 *
 * ---------------------------------------------------------------------------
 * A PERCENTAGE THAT DOES NOT EXIST IS «—», NEVER «٠٪».
 *
 * The server answers `null` for a margin with no costed base — a period with
 * no sales whose cost is known has no margin, and printing a zero invites the
 * owner to compare a quiet month against a loss-making one as though they were
 * the same thing. This module renders that null as an em dash and the screen
 * says beside it why there is no base.
 */
import { formatIqd } from '../../lib/api';
import { arabicDigits, countText } from '../adminOrders/OrderBoardBadges';

export { arabicDigits, countText };

/** True only for English. ar and ckb both take Arabic-Indic digits. */
export const isLatin = (lang: string): boolean => lang === 'en';

/** The exact amount, in the platform's one money format. */
export const money = (iqd: number): string => formatIqd(iqd);

/**
 * A signed exact amount — «+١٢٠٬٠٠٠ د.ع». The sign is part of the fact: a
 * comparison that drops it reads as growth in both directions.
 */
export const signedMoney = (iqd: number): string => `${iqd >= 0 ? '+' : '−'}${formatIqd(Math.abs(iqd))}`;

/**
 * An axis tick or a bar's end label. Rounded to one decimal, with the unit
 * word rather than a bare «م» so nothing reads as a product code.
 *
 * The numeric part goes through `toLocaleString` exactly the way `formatIqd`
 * does, so ticks and totals group their thousands identically.
 */
export function compactIqd(iqd: number, latin: boolean): string {
  const n = Math.round(iqd);
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const unit = (value: number, suffixAr: string, suffixEn: string): string => {
    const text = value.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `${sign}${text}${latin ? suffixEn : suffixAr}`;
  };
  if (abs >= 1_000_000) return unit(abs / 1_000_000, ' م', 'M');
  if (abs >= 1_000) return unit(abs / 1_000, ' ألف', 'K');
  return `${sign}${abs.toLocaleString()}`;
}

/** «١٨٫٤٪» / «18.4%», or «—» when the server said there is no base for it. */
export function percent(value: number | null | undefined, latin: boolean): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = value.toFixed(1);
  return latin ? `${text}%` : `${arabicDigits(text)}٪`;
}

/** A signed percentage change. Null — the server's "there was nothing before" — is «—». */
export function signedPercent(value: number | null | undefined, latin: boolean): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = `${Math.abs(value).toFixed(1)}`;
  const sign = value >= 0 ? '+' : '−';
  return latin ? `${sign}${text}%` : `${sign}${arabicDigits(text)}٪`;
}

/**
 * WHICH DIRECTION IS GOOD, STATED PER FIGURE.
 *
 * Revenue up is good; operating expenses up is not. A single "green when
 * positive" rule would paint a month that spent twice as much on advertising
 * in the success colour. Callers name the direction, and a zero change is
 * neutral — it is not a small win.
 */
export type DeltaTone = 'good' | 'bad' | 'flat';

export function deltaTone(amount: number, goodDirection: 'up' | 'down'): DeltaTone {
  if (amount === 0) return 'flat';
  const up = amount > 0;
  return up === (goodDirection === 'up') ? 'good' : 'bad';
}

/**
 * The text classes for a delta. The colour NEVER carries the meaning alone —
 * every delta ships beside an arrow glyph and the words «مقارنة بالفترة
 * السابقة», per the status rule that a status colour is always paired with an
 * icon and a label.
 */
export const DELTA_CLASS: Record<DeltaTone, string> = {
  good: 'text-success',
  bad: 'text-danger',
  flat: 'text-text-muted',
};

/**
 * A bucket key as an axis tick.
 *
 * ###########################################################################
 * #  THIS SPLITS A STRING. IT DOES NOT CONSTRUCT A Date, AND MUST NOT.      #
 * ###########################################################################
 * The same rule as `dayDigits` in the order board: `new Date('2026-09-23')`
 * parses as UTC midnight, so a browser on a negative offset renders the 22nd —
 * the server says Wednesday and the axis says Tuesday. Every key the server
 * sends is already a Baghdad civil day; three integers out of a fixed-width
 * string is the whole of what an axis label needs.
 *
 * Day-first, as Iraq writes it. A month key ('YYYY-MM') keeps its year,
 * because a twelve-month chart whose ticks are bare month numbers cannot be
 * read across a December.
 */
export function bucketLabel(key: string, latin: boolean): string {
  if (key === 'range') return '';
  const parts = key.split('-');
  if (parts.length === 3) {
    const text = `${Number(parts[2])}/${Number(parts[1])}`;
    return latin ? text : arabicDigits(text);
  }
  if (parts.length === 2) {
    const text = `${Number(parts[1])}/${parts[0]}`;
    return latin ? text : arabicDigits(text);
  }
  return latin ? key : arabicDigits(key);
}

/** A full day, day-first — «١٩/٩/٢٠٢٦». Used in tooltips and range captions. */
export function dayLabel(day: string, latin: boolean): string {
  const [y, m, d] = String(day).split('-');
  if (!y || !m || !d) return String(day);
  const text = `${Number(d)}/${Number(m)}/${y}`;
  return latin ? text : arabicDigits(text);
}

/** «١٩/٩/٢٠٢٦ — ٢٥/٩/٢٠٢٦», or the single day when both ends are equal. */
export function rangeLabel(from: string, to: string, latin: boolean): string {
  return from === to ? dayLabel(from, latin) : `${dayLabel(from, latin)} — ${dayLabel(to, latin)}`;
}
