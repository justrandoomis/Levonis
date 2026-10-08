/**
 * «كم سيصبح السعر؟» — WHAT THE OWNER TYPED, AS THE REQUEST THE SERVER TAKES.
 *
 * Pure (no React, no request), so it is tested directly
 * (tests/adminPricingClient.test.ts). It checks the SHAPE only — the server's
 * exact parser decides — and it never turns a decimal into a number:
 *   - Arabic-Indic and Extended digits, the Arabic decimal point and thousands
 *     separators are read as people in Iraq type them;
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

/** Strip grouping, read Arabic-Indic digits and the Arabic decimal point; nothing else changes. */
const clean = (raw: string) =>
  toAsciiDigits(raw)
    .trim()
    .replace(/[\s\u00A0\u202F\u066C,\u060C'_]/g, '')
    .replace(/\u066B/g, '.');

/** Decimal TEXT strictly above zero, as the server's grammar takes it; null when it is not one. */
export function decimalOf(raw: string, maxInt: number, maxFrac: number): string | null {
  const s = clean(raw);
  const shape = new RegExp(`^\\d{1,${maxInt}}(?:\\.\\d{1,${maxFrac}})?$`);
  if (!shape.test(s)) return null;
  return /[1-9]/.test(s) ? s : null;
}

/** A whole number (min ≤ n), or null. Safe integers only. */
export function wholeOf(raw: string, min: number): number | null {
  const s = clean(raw);
  if (!/^\d{1,12}$/.test(s)) return null;
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
  if (!supplier_cost) errors.cost = s.invalidCost;
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
    if (!v) errors.cbm = s.invalidDecimal;
    else measures.manual_cbm = v;
  }
  if (d.profile) measures.shipping_profile = d.profile;
  if (Object.keys(measures).length) body.measures = measures;

  const fx: Partial<Record<PricingCurrency, string>> = {};
  for (const c of PRICING_CURRENCIES) {
    if (!d.fx[c].trim()) continue;
    const v = decimalOf(d.fx[c], 10, 6);
    if (!v) errors.fx = s.invalidDecimal;
    else fx[c] = v;
  }
  const shipping: Partial<Record<PricingProfile, string>> = {};
  for (const p of PRICING_PROFILES) {
    if (!d.shipping[p].trim()) continue;
    const v = decimalOf(d.shipping[p], 10, 6);
    if (!v) errors.shipping = s.invalidDecimal;
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
