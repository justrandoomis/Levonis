/**
 * «كم سيصبح السعر؟» — WHAT THE OWNER TYPED, AS THE REQUEST THE SERVER TAKES.
 *
 * Pure (no React, no request), so it is tested directly
 * (tests/adminPricingClient.test.ts). It checks the SHAPE only — the server's
 * exact parser decides — and it never turns a decimal into a number:
 *   - Arabic-Indic and Extended digits, the Arabic decimal point and thousands
 *     separators are read as people in Iraq type them — a separator only
 *     where it really groups thousands: «1,250» is 1250, but «12,5» (a decimal
 *     comma) is refused with a hint, never read as 125;
 *   - a supplier cost, a manual CBM and every rate travel as decimal TEXT,
 *     because the server refuses a JSON number for a decimal (no binary float
 *     ever reaches a price);
 *   - whole numbers (grams, millimetres, dinars) travel as safe integers;
 *   - the box is one unit: all three sides or none.
 */
import { toAsciiDigits } from '../../lib/localeNumber';
import { PRICING_CURRENCIES, PRICING_PROFILES, type PricingCurrency, type PricingProfile, type PricingWhatIfRequest } from './api';
import type { PricingUiStrings } from './strings';

export type FormKey =
  | 'cost'
  | 'currency'
  | 'model'
  | 'additional'
  | 'weight'
  | 'box'
  | 'cbm'
  | 'profile'
  | 'fx'
  | 'shipping';

/** The server's field names (PRICING_INPUT_INVALID `details.field`) → the control that shows it. */
export const SERVER_FIELD: Readonly<Record<string, FormKey>> = {
  supplier_cost: 'cost',
  supplier_currency: 'currency',
  option_id: 'model',
  additional_cost_iqd: 'additional',
  shipping_weight_g: 'weight',
  shipping_box: 'box',
  manual_cbm: 'cbm',
  shipping_profile: 'profile',
  fx_rate: 'fx',
  shipping_rate: 'shipping',
};

/** What may sit between thousands: `,` `٬` `،` a space, a no-break or thin space, `'` or `_`. */
const GROUP = "[\\s\\u00A0\\u202F\\u066C,\\u060C'_]";
const HAS_GROUP = new RegExp(GROUP);
const ALL_GROUPS = new RegExp(GROUP, 'g');
/** 1–3 digits (no leading zero: «0,024» is a decimal comma), then groups of exactly three: «1,250», «12 500 000». */
const GROUPED_INT = new RegExp(`^[1-9]\\d{0,2}(?:${GROUP}\\d{3})+$`);

/**
 * Read Arabic-Indic digits and the Arabic decimal point, and drop thousands
 * grouping — only where it IS grouping: before the decimal point, with every
 * group after the first exactly three digits. Anything else («12,5», «420,50»,
 * «1,2,3», a separator after the point) is not a number here: null, so the
 * field says so instead of a price ten or a hundred times too high.
 */
function clean(raw: string): string | null {
  const s = toAsciiDigits(raw).trim().replace(/\u066B/g, '.');
  const [int = '', frac, ...extra] = s.split('.');
  if (extra.length) return null;
  if (frac !== undefined && HAS_GROUP.test(frac)) return null;
  let digits = int;
  if (HAS_GROUP.test(int)) {
    if (!GROUPED_INT.test(int)) return null;
    digits = int.replace(ALL_GROUPS, '');
  }
  return frac === undefined ? digits : `${digits}.${frac}`;
}

/** Decimal TEXT strictly above zero, as the server's grammar takes it; null when it is not one. */
export function decimalOf(raw: string, maxInt: number, maxFrac: number): string | null {
  const s = clean(raw);
  if (s === null) return null;
  const shape = new RegExp(`^\\d{1,${maxInt}}(?:\\.\\d{1,${maxFrac}})?$`);
  if (!shape.test(s)) return null;
  return /[1-9]/.test(s) ? s : null;
}

/**
 * Was the comma meant as a decimal point? True when the text is refused as it
 * stands but would be a valid decimal with its comma read as a point — so the
 * field can say «use a point for decimals» rather than a bare «invalid».
 */
export function isDecimalComma(raw: string, maxInt: number, maxFrac: number): boolean {
  return /[,\u060C]/.test(raw) && decimalOf(raw, maxInt, maxFrac) === null && decimalOf(raw.replace(/[,\u060C]/g, '.'), maxInt, maxFrac) !== null;
}

/** A whole number (min ≤ n), or null. Safe integers only. */
export function wholeOf(raw: string, min: number): number | null {
  const s = clean(raw);
  if (s === null || !/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

export interface Draft {
  cost: string;
  currency: PricingCurrency;
  model: string;
  additional: string;
  weight: string;
  length: string;
  width: string;
  height: string;
  cbm: string;
  profile: '' | PricingProfile;
  fx: Record<PricingCurrency, string>;
  shipping: Record<PricingProfile, string>;
}

export const emptyDraft = (currency: PricingCurrency): Draft => ({
  cost: '',
  currency,
  model: '',
  additional: '',
  weight: '',
  length: '',
  width: '',
  height: '',
  cbm: '',
  profile: '',
  fx: { USD: '', EUR: '', CNY: '' },
  shipping: { GERMANY_LAND: '', CHINA_AIR: '', CHINA_SEA: '' },
});

/** Build the request from the draft, or the errors that stop it. */
export function buildRequest(d: Draft, s: PricingUiStrings): { body: PricingWhatIfRequest | null; errors: Partial<Record<FormKey, string>> } {
  const errors: Partial<Record<FormKey, string>> = {};
  const supplier_cost = decimalOf(d.cost, 12, 4);
  if (!supplier_cost) errors.cost = isDecimalComma(d.cost, 12, 4) ? s.decimalComma : s.invalidCost;
  const body: PricingWhatIfRequest = { supplier_cost: supplier_cost ?? '', currency: d.currency };
  if (d.model) body.option_id = d.model;
  if (d.additional.trim()) {
    const n = wholeOf(d.additional, 0);
    if (n === null) errors.additional = s.invalidWholeZero;
    else body.additional_cost_iqd = n;
  }
  const measures: NonNullable<PricingWhatIfRequest['measures']> = {};
  if (d.weight.trim()) {
    const n = wholeOf(d.weight, 1);
    if (n === null) errors.weight = s.invalidWhole;
    else measures.weight_g = n;
  }
  const sides = [d.length, d.width, d.height];
  if (sides.some((x) => x.trim())) {
    const [l, w, h] = sides.map((x) => wholeOf(x, 1));
    if (l == null || w == null || h == null) errors.box = s.boxAllThree;
    else Object.assign(measures, { length_mm: l, width_mm: w, height_mm: h });
  }
  if (d.cbm.trim()) {
    const v = decimalOf(d.cbm, 6, 6);
    if (!v) errors.cbm = isDecimalComma(d.cbm, 6, 6) ? s.decimalComma : s.invalidDecimal;
    else measures.manual_cbm = v;
  }
  if (d.profile) measures.shipping_profile = d.profile;
  if (Object.keys(measures).length) body.measures = measures;

  const fx: Partial<Record<PricingCurrency, string>> = {};
  for (const c of PRICING_CURRENCIES) {
    if (!d.fx[c].trim()) continue;
    const v = decimalOf(d.fx[c], 10, 6);
    if (!v) errors.fx = isDecimalComma(d.fx[c], 10, 6) ? s.decimalComma : s.invalidDecimal;
    else fx[c] = v;
  }
  const shipping: Partial<Record<PricingProfile, string>> = {};
  for (const p of PRICING_PROFILES) {
    if (!d.shipping[p].trim()) continue;
    const v = decimalOf(d.shipping[p], 10, 6);
    if (!v) errors.shipping = isDecimalComma(d.shipping[p], 10, 6) ? s.decimalComma : s.invalidDecimal;
    else shipping[p] = v;
  }
  if (Object.keys(fx).length || Object.keys(shipping).length) {
    body.rates = {};
    if (Object.keys(fx).length) body.rates.fx = fx;
    if (Object.keys(shipping).length) body.rates.shipping = shipping;
  }
  return { body: Object.keys(errors).length ? null : body, errors };
}

/** Which currency the calculator opens on: the supplier side the product's routes point at. */
export function defaultCurrency(routes: readonly string[]): PricingCurrency {
  if (routes.includes('land')) return 'EUR';
  if (routes.includes('air') || routes.includes('sea')) return 'CNY';
  return 'EUR';
}
