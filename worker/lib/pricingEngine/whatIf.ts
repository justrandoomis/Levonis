/**
 * «كم سيصبح السعر؟» — THE WHAT-IF CALCULATOR OF P1 (MVP plan §6 P1). Writes nothing.
 *
 * The owner types a supplier cost and its currency (optionally one model,
 * measures, an additional cost per unit, and rates); E1's `priceSku` prices
 * every model × channel the store offers today with:
 *   - the minimum profit and Direct Sale Extra the old prices carry (the legacy
 *     placement, as rules — a value held for review stays held: no price);
 *   - the public package measures as suggestions, under the owner's measures;
 *   - the rate reference from the purchase screens (unconfirmed), under the
 *     owner's rates — `allowUnconfirmedRates`, so a preview is never blocked by
 *     a rate the owner has not confirmed yet, and says so as a warning.
 * Each new price is shown next to what a guest pays for that channel today.
 *
 * Validation is strict and names fields, never values: an unknown key is
 * UNKNOWN_FIELD; a bad value is PRICING_INPUT_INVALID with `details.field`.
 * Decimals are canonical TEXT (the 0179 grammar), parsed exactly — a JSON
 * number is refused for a decimal so no binary float ever reaches the price.
 */
import {
  MAX_ADDITIONAL_COST_IQD,
  MAX_BOX_MM,
  MAX_WEIGHT_G,
  SUPPLIER_CURRENCIES,
  priceSku,
  type ChannelPrice,
  type PricingInputRow,
  type SupplierCurrency,
} from '@levonis/pricing/costToPrice';
import { resolveRuleAt } from '@levonis/pricing/ruleResolution';
import { SHIPPING_PROFILES, type ShippingProfile, type SkuChannel } from '@levonis/pricing/skuChannel';
import { parseProcurementDecimal } from '@levonis/contracts/procurementCost';
import { COST_REFUSALS, serverMessage } from '@levonis/contracts/costRefusals';
import { PRICING_FIELD_LABELS, isPricingFieldName } from '@levonis/contracts/pricingFieldLabels';
import { HttpError } from '../http';
import type { OptionV2 } from '../pricing';
import { ruleTargetOf, sourceChainOf, type ProductEvaluation } from './compute';
import { centralRatesOf, type RateOrigin, type RateReference } from './load';

export interface WhatIfMeasures {
  weight_g?: number;
  box?: { length_mm: number; width_mm: number; height_mm: number };
  manual_cbm?: string;
  shipping_profile?: ShippingProfile;
}

export interface WhatIfRequest {
  supplier_cost: string;
  currency: SupplierCurrency;
  option_id: string | null;
  additional_cost_iqd: number | null;
  measures: WhatIfMeasures;
  rates: { fx: Partial<Record<SupplierCurrency, string>>; shipping: Partial<Record<ShippingProfile, string>> };
}

export interface WhatIfChannel {
  channel: SkuChannel;
  today_prepaid_iqd: number | null;
  today_cod_iqd: number | null;
  price: ChannelPrice | null;
  /** new − today (prepaid), whole IQD; null without either. */
  change_iqd: number | null;
  issue_codes: string[];
}

export interface WhatIfModel {
  option: OptionV2 | null;
  option_id: string;
  channels: WhatIfChannel[];
}

export interface WhatIfResult {
  request: WhatIfRequest;
  scope: 'base' | 'option';
  rates: RateReference;
  models: WhatIfModel[];
}

const BODY_KEYS = ['supplier_cost', 'currency', 'option_id', 'additional_cost_iqd', 'measures', 'rates'] as const;
const MEASURE_KEYS = ['weight_g', 'length_mm', 'width_mm', 'height_mm', 'manual_cbm', 'shipping_profile'] as const;
const RATE_KEYS = ['fx', 'shipping'] as const;

function unknownField(fields: string[]): HttpError {
  return new HttpError(400, serverMessage('UNKNOWN_FIELD'), 'UNKNOWN_FIELD', { fields });
}

/**
 * 400 PRICING_INPUT_INVALID naming the FIELD (never its value). The sentence
 * carries the field's own label where the pricing vocabulary has one.
 */
export function inputInvalid(field: string): HttpError {
  const label = isPricingFieldName(field) ? PRICING_FIELD_LABELS[field] : null;
  const { ar, en } = COST_REFUSALS.PRICING_INPUT_INVALID;
  const message = `${ar.replace('{field}', label?.ar ?? field)} / ${en.replace('{field}', label?.en ?? field)}`;
  return new HttpError(400, message, 'PRICING_INPUT_INVALID', { field });
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function strictKeys(obj: Record<string, unknown>, allowed: readonly string[], prefix = ''): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw unknownField(extra.map((k) => `${prefix}${k}`).sort());
}

/** Decimal TEXT in the 0179 grammar, strictly above zero. */
function decimalText(raw: unknown, field: string, maxIntDigits: number, maxFractionDigits: number): string {
  if (typeof raw !== 'string') throw inputInvalid(field);
  try {
    return parseProcurementDecimal(raw, { maxIntDigits, maxFractionDigits, min: 'positive' });
  } catch {
    throw inputInvalid(field);
  }
}

function whole(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) throw inputInvalid(field);
  return raw;
}

/** Parse and validate the what-if body (see the file header). Throws an HttpError. */
export function parseWhatIf(body: unknown): WhatIfRequest {
  const b = isRecord(body) ? body : {};
  strictKeys(b, BODY_KEYS);
  const supplier_cost = decimalText(b.supplier_cost, 'supplier_cost', 12, 4);
  if (typeof b.currency !== 'string' || !(SUPPLIER_CURRENCIES as readonly string[]).includes(b.currency)) throw inputInvalid('supplier_currency');
  const currency = b.currency as SupplierCurrency;
  let option_id: string | null = null;
  if (b.option_id !== undefined && b.option_id !== null && b.option_id !== '') {
    if (typeof b.option_id !== 'string' || b.option_id.length > 100) throw inputInvalid('option_id');
    option_id = b.option_id;
  }
  const additional_cost_iqd =
    b.additional_cost_iqd === undefined || b.additional_cost_iqd === null
      ? null
      : whole(b.additional_cost_iqd, 'additional_cost_iqd', 0, MAX_ADDITIONAL_COST_IQD);

  const measures: WhatIfMeasures = {};
  if (b.measures !== undefined && b.measures !== null) {
    if (!isRecord(b.measures)) throw inputInvalid('measures');
    const m = b.measures;
    strictKeys(m, MEASURE_KEYS, 'measures.');
    if (m.weight_g !== undefined && m.weight_g !== null) measures.weight_g = whole(m.weight_g, 'shipping_weight_g', 1, MAX_WEIGHT_G);
    const axes = [m.length_mm, m.width_mm, m.height_mm];
    if (axes.some((a) => a !== undefined && a !== null)) {
      // The box is one unit [L2-1a]: all three axes, or none.
      measures.box = {
        length_mm: whole(m.length_mm, 'shipping_box', 1, MAX_BOX_MM),
        width_mm: whole(m.width_mm, 'shipping_box', 1, MAX_BOX_MM),
        height_mm: whole(m.height_mm, 'shipping_box', 1, MAX_BOX_MM),
      };
    }
    if (m.manual_cbm !== undefined && m.manual_cbm !== null) measures.manual_cbm = decimalText(m.manual_cbm, 'manual_cbm', 6, 6);
    if (m.shipping_profile !== undefined && m.shipping_profile !== null) {
      if (typeof m.shipping_profile !== 'string' || !(SHIPPING_PROFILES as readonly string[]).includes(m.shipping_profile)) throw inputInvalid('shipping_profile');
      measures.shipping_profile = m.shipping_profile as ShippingProfile;
    }
  }

  const rates: WhatIfRequest['rates'] = { fx: {}, shipping: {} };
  if (b.rates !== undefined && b.rates !== null) {
    if (!isRecord(b.rates)) throw inputInvalid('rates');
    strictKeys(b.rates, RATE_KEYS, 'rates.');
    const { fx, shipping } = b.rates;
    if (fx !== undefined && fx !== null) {
      if (!isRecord(fx)) throw inputInvalid('fx_rate');
      strictKeys(fx, SUPPLIER_CURRENCIES, 'rates.fx.');
      for (const c of SUPPLIER_CURRENCIES) if (fx[c] !== undefined && fx[c] !== null) rates.fx[c] = decimalText(fx[c], 'fx_rate', 10, 6);
    }
    if (shipping !== undefined && shipping !== null) {
      if (!isRecord(shipping)) throw inputInvalid('shipping_rate');
      strictKeys(shipping, SHIPPING_PROFILES, 'rates.shipping.');
      for (const p of SHIPPING_PROFILES) if (shipping[p] !== undefined && shipping[p] !== null) rates.shipping[p] = decimalText(shipping[p], 'shipping_rate', 10, 6);
    }
  }
  return { supplier_cost, currency, option_id, additional_cost_iqd, measures, rates };
}

/** The reference with the owner's what-if rates laid over it. */
export function ratesFor(reference: RateReference, req: WhatIfRequest): RateReference {
  const origin: RateOrigin = 'what_if';
  const out: RateReference = {
    fx: { USD: { ...reference.fx.USD }, EUR: { ...reference.fx.EUR }, CNY: { ...reference.fx.CNY } },
    shipping: {
      GERMANY_LAND: { ...reference.shipping.GERMANY_LAND },
      CHINA_AIR: { ...reference.shipping.CHINA_AIR },
      CHINA_SEA: { ...reference.shipping.CHINA_SEA },
    },
  };
  for (const c of SUPPLIER_CURRENCIES) if (req.rates.fx[c] !== undefined) out.fx[c] = { rate: req.rates.fx[c]!, origin };
  for (const p of SHIPPING_PROFILES) if (req.rates.shipping[p] !== undefined) out.shipping[p] = { rate: req.rates.shipping[p]!, origin };
  return out;
}

/** The owner's inputs, as one MANUAL_OVERRIDE row of the chosen scope (in memory only). */
function overrideRow(req: WhatIfRequest): PricingInputRow {
  const row: PricingInputRow = {
    supplier_cost: req.supplier_cost,
    supplier_currency: req.currency,
  };
  if (req.additional_cost_iqd !== null) row.additional_cost_iqd = req.additional_cost_iqd;
  if (req.measures.weight_g !== undefined) row.shipping_weight_g = req.measures.weight_g;
  if (req.measures.box) {
    row.shipping_length_mm = req.measures.box.length_mm;
    row.shipping_width_mm = req.measures.box.width_mm;
    row.shipping_height_mm = req.measures.box.height_mm;
  }
  if (req.measures.manual_cbm !== undefined) row.manual_cbm = req.measures.manual_cbm;
  if (req.measures.shipping_profile !== undefined) row.shipping_profile = req.measures.shipping_profile;
  return row;
}

/**
 * Price the product as the engine would with the owner's figures. An
 * `option_id` that names no model of the product is PRICING_INPUT_INVALID.
 */
export function runWhatIf(evaluation: ProductEvaluation, req: WhatIfRequest, reference: RateReference): WhatIfResult {
  const models = req.option_id ? evaluation.models.filter((m) => m.option_id === req.option_id) : evaluation.models;
  if (req.option_id && !models.length) throw inputInvalid('option_id');
  const scope: 'base' | 'option' = req.option_id ? 'option' : 'base';
  const rates = ratesFor(reference, req);
  const central = centralRatesOf(rates);
  const row = overrideRow(req);

  const out: WhatIfModel[] = models.map((m) => {
    // The owner's figures sit at the model's own level, so a public package
    // measure (a SOURCE suggestion at the model) never outranks them; with no
    // model named they apply to every model alike.
    const chain = sourceChainOf(evaluation.doc, m, { scope: m.option ? 'option' : 'base', row });
    const offered = m.channels.filter((c) => c.ok);
    const channels = offered.map((c) => c.channel);
    const at = ruleTargetOf(evaluation.id, m.option_id);
    const result = channels.length
      ? priceSku({
          chain,
          rates: central,
          channels,
          target: resolveRuleAt(evaluation.rules, 'target_profit', at),
          extra: channels.includes('direct_sale') ? resolveRuleAt(evaluation.rules, 'direct_sale_extra', at) : null,
          allowUnconfirmedRates: true,
        })
      : null;
    return {
      option: m.option,
      option_id: m.option_id,
      channels: offered.map((c): WhatIfChannel => {
        const price = result?.channels.find((p) => p.channel === c.channel) ?? null;
        const codes = new Set<string>();
        for (const issue of result?.issues ?? []) if (!issue.channel || issue.channel === c.channel) codes.add(issue.code);
        return {
          channel: c.channel,
          today_prepaid_iqd: c.prepaid_iqd,
          today_cod_iqd: c.cod_iqd,
          price,
          change_iqd: price && c.prepaid_iqd !== null ? price.computed_price_iqd - c.prepaid_iqd : null,
          issue_codes: [...codes].sort(),
        };
      }),
    };
  });
  return { request: req, scope, rates, models: out };
}
