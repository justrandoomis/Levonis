/**
 * «تخفيض السعر»: THE SALE PRICE ROW ON THE WIRE, AND ITS DRAFT (moved out of ProductDiscountCard.tsx so
 * the purchase card can write the same row through the same door without the whole card; DECISIONS row 273).
 * Pure: no React, no request.
 */
import { baghdadInputToNaive, isoToBaghdadInput } from '../../../lib/offerTime';


export type DiscountChannel = 'direct_sale' | 'pre_order_land' | 'pre_order_sea' | 'pre_order_air';
export type Names = { ar: string; en: string; ckb: string };

export interface DiscountRowWire {
  combo_key: string;
  model_id: string | null;
  names: Names;
  channel: DiscountChannel;
  before_iqd: number;
  before_usd: string | null;
  before_usd_exact: boolean;
}

export interface PreviewRowWire extends DiscountRowWire {
  after_iqd: number | null;
  after_usd: string | null;
  offer_saving_percent: number | null;
  state: 'lowered' | 'not_lower' | 'not_covered' | 'below_floor';
  owner?: { below_cost: boolean; below_min_profit: boolean };
}

export interface DiscountReadWire {
  usd_supported: boolean;
  published: boolean;
  composition: boolean;
  viewer: 'owner' | 'editor';
  method: 'cost' | 'usd' | null;
  usd: { available: boolean; reason: null | 'NOT_INSTALLED' | 'NOT_PUBLISHED' | 'OWNER_ONLY' | 'NOT_DIRECT' | 'MIXED_PRICES'; scopes: Array<'product' | 'model'> };
  models: Array<{ model_id: string; names: Names; uniform: boolean; direct: boolean }>;
  rows: DiscountRowWire[];
  write_seq: number;
}

/** The stored window, as the door's `windowView` answers it. */
export interface OfferWire {
  subject_id: string;
  offer_id: string;
  starts_at: string | null;
  ends_at: string | null;
  required_tiers: string[];
  offer_price_mode: string;
  offer_price_iqd: number | null;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  locked_preview: boolean;
  active: boolean;
  max_per_user: number | null;
  max_global: number | null;
  updated_at: string | null;
  suspended?: boolean;
  offer_usd_prices?: Array<{ model_id: string; usd: string }>;
}

export interface Issue {
  code: string;
  message?: string;
  ar?: string;
  en?: string;
  ckb?: string;
}

/* ------------------------------------------------------------- the draft -- */

export interface DiscountDraft {
  mode: 'usd' | 'percent';
  scope: 'product' | 'model';
  usdWhole: string;
  usdByModel: Record<string, string>;
  percent: number | null;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

/** The draft a stored row opens as: its own mode when the card can show it, else the percent (§6.2). */
export function draftFrom(offer: OfferWire | null, read: DiscountReadWire): DiscountDraft {
  const usdOk = read.usd.available;
  const set = offer?.offer_usd_prices ?? [];
  const byModel: Record<string, string> = {};
  for (const p of set) if (p.model_id) byModel[p.model_id] = p.usd;
  const wholeRow = set.find((p) => p.model_id === '');
  const scope: DiscountDraft['scope'] = set.some((p) => p.model_id !== '')
    ? 'model'
    : wholeRow
      ? 'product'
      : read.usd.scopes.includes('product')
        ? 'product'
        : 'model';
  // The dollar mode only where this viewer may use it (an editor on a cost-first product never sees
  // dollars, D7); otherwise the card opens on the percent.
  const mode: DiscountDraft['mode'] = usdOk && (offer?.offer_price_mode === 'fixed_usd' || !offer) ? 'usd' : 'percent';
  return {
    mode,
    scope,
    usdWhole: wholeRow?.usd ?? '',
    usdByModel: byModel,
    percent: offer?.offer_price_mode === 'discount_percent' ? offer.discount_percent : null,
    startsAt: isoToBaghdadInput(offer?.starts_at ?? null),
    endsAt: isoToBaghdadInput(offer?.ends_at ?? null),
    active: offer ? offer.active : true,
  };
}

/** The dollar set the draft names (empty inputs drop out: that model keeps its price). */
export function usdSetOf(d: DiscountDraft): Array<{ model_id: string; usd: string }> {
  if (d.scope === 'product') return d.usdWhole.trim() ? [{ model_id: '', usd: d.usdWhole.trim() }] : [];
  return Object.entries(d.usdByModel)
    .filter(([, usd]) => usd.trim() !== '')
    .map(([model_id, usd]) => ({ model_id, usd: usd.trim() }));
}

/**
 * THE PUT (and the preview) BODY: the WHOLE row as loaded — tiers, limits, `locked_preview`, the PLUS
 * price carried untouched — the card's own fields, the dollar set in the dollar mode, and the stamp the
 * card read (null when it saw no row).
 */
export function saveBodyOf(loaded: OfferWire | null, d: DiscountDraft): Record<string, unknown> {
  const usd = d.mode === 'usd';
  return {
    required_tiers: loaded?.required_tiers ?? [],
    max_per_user: loaded?.max_per_user ?? null,
    max_global: loaded?.max_global ?? null,
    locked_preview: loaded?.locked_preview ?? true,
    plus_price_iqd: loaded?.plus_price_iqd ?? null,
    starts_at: baghdadInputToNaive(d.startsAt),
    ends_at: baghdadInputToNaive(d.endsAt),
    active: d.active,
    offer_price_mode: usd ? 'fixed_usd' : 'discount_percent',
    offer_price_iqd: null,
    discount_percent: usd ? null : d.percent,
    discount_iqd: null,
    ...(usd ? { offer_usd_prices: usdSetOf(d) } : {}),
    expected_updated_at: loaded ? loaded.updated_at : null,
  };
}


/**
 * THE PREVIEW ANSWER AS THE CARD SHOWS IT (review). A draft the door refuses at checks 1–6 (`refused`) prices
 * nothing: its rows are shown with their before price and «—», never as «بلا تخفيض» (which reads as "this model
 * will not be discounted"); its sentence and the preview's warnings are kept to be said before «حفظ».
 */
export function previewAnswerOf(res: { rows?: PreviewRowWire[]; issues?: Issue[]; warnings?: Issue[]; refused?: boolean }): {
  preview: PreviewRowWire[] | null;
  issues: Issue[];
  warnings: Issue[];
} {
  return { preview: res.refused ? null : (res.rows ?? []), issues: res.issues ?? [], warnings: res.warnings ?? [] };
}

