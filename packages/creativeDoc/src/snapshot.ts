/**
 * THE MARKETING SNAPSHOT — the only product data an ad is built from, and the
 * only product data Claude ever sees (spec §9).
 *
 * The Worker builds it READ-ONLY from the public card path (the price a guest
 * sees now, the card availability rule, the product's own pictures) and
 * stores it with a hash; a document binds to the snapshot id, never to live
 * numbers. Re-verification before a final export compares a fresh snapshot
 * with the bound one (`compareSnapshots`).
 *
 * By construction it carries no cost, margin, supplier, stock count, sales
 * figure, investor or customer field: the type has nowhere to put one. The
 * Worker's builder is an allow-list of the fields below.
 */
import type { AdLocale } from './schema';
import { formatIqd, type CurrencyLabel, type DigitStyle } from './text';

export interface Localized {
  ar: string;
  en: string;
  ckb: string;
}

/**
 * The price a guest sees, with its kind kept separate:
 *   priced        a public price exists
 *   unpriced      no public price («اطلب السعر») — NEVER zero
 *   members_only  only a membership price is shown publicly
 */
export type PriceStatus = 'priced' | 'unpriced' | 'members_only';

export interface SnapshotPrice {
  status: PriceStatus;
  /** The public price now (the offer price while an offer is live). null unless `priced`. */
  amount_iqd: number | null;
  /** The regular price before a live public offer, when there is one. */
  regular_iqd: number | null;
  /** "from" pricing: the cheapest of several options. */
  from: boolean;
  /** A live PUBLIC offer window (required tiers empty). A members-only offer is not an offer here. */
  offer: { starts_at: string | null; ends_at: string | null } | null;
  /** A membership price teaser, kept apart so it is never drawn as the public price. */
  member_price_iqd: number | null;
}

/**
 *   available    buy now, direct sale, in stock
 *   preorder     orderable, delivered later
 *   unavailable  not orderable now
 *   unknown      the card rule could not tell (an unpriced product is always unknown)
 */
export type SnapshotAvailability = 'available' | 'preorder' | 'unavailable' | 'unknown';

export interface SnapshotImage {
  /** Same-origin `/files/...` url, or an absolute url (which cannot be drawn into an export canvas). */
  url: string;
  width: number | null;
  height: number | null;
  alt: string;
  primary: boolean;
  /** Which variant/option/colour the picture belongs to; null = the product as a whole. */
  variant_key: string | null;
  /** True only for `/files/...` — the exporter can draw it without tainting the canvas. */
  same_origin: boolean;
}

export interface ProductSnapshotData {
  product_id: string;
  slug: string;
  /** The public product path (`/product/<slug>`), never an absolute URL a model could alter. */
  path: string;
  variant_key: string | null;
  variant_label: Localized | null;
  name: Localized;
  brand: Localized | null;
  category: Localized | null;
  sku: string | null;
  short_description: Localized;
  /** Documented spec rows only (label/value), no internal fields. */
  specs: Array<{ label: Localized; value: string }>;
  /** What is in the box, from the product's own "contents" spec rows. */
  contents: Array<{ text: string; qty: number | null }>;
  price: SnapshotPrice;
  availability: SnapshotAvailability;
  /** `direct_sale` / `pre_order` / `bundle`, as the card states them. */
  sale_types: string[];
  images: SnapshotImage[];
  /** The product row's own updated_at, for "when did the source change". */
  source_updated_at: string | null;
}

export interface ProductSnapshot {
  id: string;
  data: ProductSnapshotData;
  /** sha256 of `canonicalJson(data)`, hex. */
  hash: string;
  /** `live` from the catalogue; `manual` imported by the owner; `test` marked fixture data (never shown as a Levonis price). */
  source: 'live' | 'manual' | 'test';
  fetched_at: string;
}

/** Key-sorted JSON — the hash input, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Change detection — what makes an approved design need review (spec §25)
// ---------------------------------------------------------------------------

export type SnapshotChange =
  | 'price_changed' | 'price_status_changed' | 'offer_changed' | 'availability_changed'
  | 'name_changed' | 'image_removed' | 'product_missing';

export function compareSnapshots(bound: ProductSnapshotData, fresh: ProductSnapshotData | null): SnapshotChange[] {
  if (!fresh) return ['product_missing'];
  const out: SnapshotChange[] = [];
  if (bound.price.status !== fresh.price.status) out.push('price_status_changed');
  else if (bound.price.amount_iqd !== fresh.price.amount_iqd || bound.price.regular_iqd !== fresh.price.regular_iqd || bound.price.from !== fresh.price.from) out.push('price_changed');
  if (JSON.stringify(bound.price.offer) !== JSON.stringify(fresh.price.offer)) out.push('offer_changed');
  if (bound.availability !== fresh.availability) out.push('availability_changed');
  if (bound.name.ar !== fresh.name.ar || bound.name.en !== fresh.name.en || bound.name.ckb !== fresh.name.ckb) out.push('name_changed');
  const freshUrls = new Set(fresh.images.map((i) => i.url));
  if (bound.images.some((i) => !freshUrls.has(i.url))) out.push('image_removed');
  return out;
}

/** Changes that block a final export of a design that SHOWS the affected field. */
export function blockingChanges(changes: readonly SnapshotChange[], shows: { price: boolean; availability: boolean }): SnapshotChange[] {
  return changes.filter((c) => {
    if (c === 'product_missing') return true;
    if (c === 'price_changed' || c === 'price_status_changed' || c === 'offer_changed') return shows.price;
    if (c === 'availability_changed') return shows.availability;
    return c === 'name_changed' || c === 'image_removed';
  });
}

// ---------------------------------------------------------------------------
// Rendering bound text — the ONLY way a price or availability becomes words
// ---------------------------------------------------------------------------

const PHRASES = {
  price_on_request: { ar: 'السعر عند الطلب', en: 'Price on request', ckb: 'نرخ بە داواکاری' },
  members_price: { ar: 'سعر الأعضاء', en: 'Members price', ckb: 'نرخی ئەندامان' },
  from: { ar: 'يبدأ من', en: 'From', ckb: 'دەست پێدەکات لە' },
  available: { ar: 'متوفر الآن', en: 'Available now', ckb: 'ئێستا بەردەستە' },
  preorder: { ar: 'متاح بالطلب المسبق', en: 'Available to pre-order', ckb: 'بە داواکاریی پێشوەختە بەردەستە' },
  unavailable: { ar: 'غير متوفر حالياً', en: 'Currently unavailable', ckb: 'لە ئێستادا بەردەست نییە' },
  was: { ar: 'بدلاً من', en: 'was', ckb: 'لە جیاتی' },
  test_label: { ar: 'تجريبي', en: 'TEST', ckb: 'تاقیکاری' },
} as const satisfies Record<string, Localized>;

export type BoundPhraseKey = keyof typeof PHRASES;

export function phrase(key: BoundPhraseKey, locale: AdLocale): string {
  return PHRASES[key][locale];
}

export interface PriceRendering {
  /** What the price layer draws. */
  text: string;
  /** `price` when a real public number is drawn; otherwise what was drawn instead. */
  kind: 'price' | 'on_request' | 'members_only';
  /** The regular price, when a live public offer lowers it (for an optional "was" line). */
  was: string | null;
}

/**
 * The words a bound price layer draws. Unpriced → "price on request", never a
 * zero. Members-only → the members phrase without a number (a membership
 * price is never presented as the public price). A test snapshot is labelled
 * as such so a fixture price can never pass for a Levonis price.
 */
export function renderPrice(snap: Pick<ProductSnapshot, 'data' | 'source'>, opts: { locale: AdLocale; digits: DigitStyle; label: CurrencyLabel }): PriceRendering {
  const p = snap.data.price;
  const test = snap.source === 'test' ? `${phrase('test_label', opts.locale)} — ` : '';
  if (p.status === 'unpriced' || p.amount_iqd === null) {
    return { text: test + phrase(p.status === 'members_only' ? 'members_price' : 'price_on_request', opts.locale), kind: p.status === 'members_only' ? 'members_only' : 'on_request', was: null };
  }
  if (p.status === 'members_only') return { text: test + phrase('members_price', opts.locale), kind: 'members_only', was: null };
  const amount = formatIqd(p.amount_iqd, opts);
  const text = test + (p.from ? `${phrase('from', opts.locale)} ${amount}` : amount);
  const was = p.offer && p.regular_iqd !== null && p.regular_iqd > p.amount_iqd ? `${phrase('was', opts.locale)} ${formatIqd(p.regular_iqd, opts)}` : null;
  return { text, kind: 'price', was };
}

export function renderAvailability(snap: Pick<ProductSnapshot, 'data'>, locale: AdLocale): string | null {
  const a = snap.data.availability;
  return a === 'unknown' ? null : phrase(a, locale);
}

export function localized(l: Localized | null, locale: AdLocale): string {
  if (!l) return '';
  return l[locale] || (locale === 'ckb' ? '' : l.ar || l.en);
}

// ---------------------------------------------------------------------------
// Approved service claims (spec §19) — the words a service ad may use
// ---------------------------------------------------------------------------

/**
 * One approved claim (warranty, delivery, returns, a course): its texts in
 * three languages as the OWNER wrote and approved them, with a version — a
 * design records the version it used, and a newer version makes it need
 * review. `conditions` is never dropped from a design that uses the claim.
 */
export interface ServiceClaimText {
  id: string;
  version: number;
  title: Localized;
  summary: Localized;
  conditions: Localized;
  /** The public page with the full terms (a site path, never an external URL). */
  details_path: string | null;
}
