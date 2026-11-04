/**
 * THE PRICE FEED FOR META BUSINESS AGENT — the public catalogue as one CSV
 * (`GET /api/products/price-feed.csv`, worker/routes/products.ts).
 *
 * The owner links a Google Sheet to the agent's price list. The sheet holds one
 * formula, `=IMPORTDATA("https://levonis-iq.com/api/products/price-feed.csv")`,
 * and Meta re-reads it twice a day. The owner's rules for what the agent may
 * say decide every row:
 *
 *   in stock    a direct sale from the shelf now, at its final price: «متوفر الآن
 *               (بيع مباشر)» and the LOWEST firm direct-sale price of the
 *               selections on the shelf now, «يبدأ من» when they differ. Never
 *               the card's own figure: that is the cheapest way to buy, and on a
 *               product sold both ways it is a pre-order route's price.
 *   pre-order   nothing on the shelf and pre-order open (a sold-out direct sale
 *               included): the agent says only that the shop can get it and
 *               hands the chat to the admin. No price.
 *   not priced  everything else: a catalog-only product («السعر غير متوفر
 *               حالياً»), a direct sale with an empty shelf and no pre-order, a
 *               shelf count the site withholds, or a shelf whose every price is
 *               still an estimate. No price.
 *
 * An estimated price («سعر تقديري», migration 0218) and a pre-order price are
 * never written: the one figure this file prints is a firm direct-sale price of
 * a selection on the shelf now.
 *
 * DURING A SALE (owner, 2026-11-04, for Black Friday): «السعر قبل الخصم» carries
 * the struck price of that same selection when a live offer lowered it — the
 * product page's own struck figure, on the same footing as the price beside it —
 * so the agent can say «بـ 699,000 بدل 760,500». Empty otherwise.
 *
 * AVAILABILITY IS THE STOREFRONT CARD'S OWN RULE (`cardAvailability`,
 * packages/catalog), read off the card `GET /api/products` serialized — the same
 * `direct_stock_available` the card's «متوفر» line reads.
 *
 * WORDS. The columns are the owner's data contract with Meta's agent, in Arabic
 * and English. The feed is read by a machine, not shown on a page, and it has
 * no Sorani column, so no ckb slot exists that could carry a copy of the
 * Arabic (DECISIONS row 183).
 *
 * Pure: no I/O.
 */
import { cardAvailability } from '@levonis/catalog/availability';
import { toCsv } from './importCsv';

export type PriceFeedStatus = 'in_stock' | 'pre_order' | 'not_priced';

/** One selection the shelf sells now as a direct sale: its direct-sale price, and whether that price is an estimate. */
export interface ShelfPrice {
  price_iqd: number;
  estimate: boolean;
  /**
   * A live offer lowered it: the struck price on the same footing as `price_iqd` (the offer's struck
   * ladder price plus the selection's unchanged direct-sale fees), present only when above `price_iqd`.
   */
  before_iqd?: number;
}

export interface PriceFeedProduct {
  /** The listing card (`GET /api/products`): slug, name, `price_status`, `direct_stock_available`, `sale_types`, sections. */
  card: Record<string, unknown>;
  /** The product row's Arabic name (the card carries the English one). */
  name_ar: string;
  /** Every selection on the shelf now as a direct sale, priced (worker/routes/products.ts `shelfDirectPrices`). */
  shelf: readonly ShelfPrice[];
}

export const PRICE_FEED_HEADER: readonly string[] = ['الاسم', 'Name', 'الحالة', 'Status', 'السعر (د.ع)', 'السعر قبل الخصم (د.ع)', 'الرابط'];

export const PRICE_FEED_STATUS: Readonly<Record<PriceFeedStatus, { ar: string; en: string }>> = {
  in_stock: { ar: 'متوفر الآن (بيع مباشر)', en: 'In stock' },
  pre_order: { ar: 'طلب مسبق — نكدر نوفره لك، والإدارة تبلغك بالسعر والموعد', en: 'Pre-order' },
  not_priced: { ar: 'السعر غير متوفر حالياً', en: 'Not priced' },
};

/** «يبدأ من» exactly where the in-stock selections differ in price. */
const FROM_PREFIX = 'يبدأ من ';

const GROUP_ORDER: Readonly<Record<PriceFeedStatus, number>> = { in_stock: 0, pre_order: 1, not_priced: 2 };

const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Is this card on the shelf now as a priced direct sale — the products whose shelf prices the route reads? */
export function onShelfNow(card: Record<string, unknown>): boolean {
  return card.price_status === 'priced' && cardAvailability(card).state === 'available';
}

/** One product's status, and the figure it may carry (in stock only). */
export function priceFeedVerdict(p: Pick<PriceFeedProduct, 'card' | 'shelf'>): {
  status: PriceFeedStatus;
  /** `before_iqd`: the struck price of the selection the figure is (a live offer lowered it), else null. */
  price: { iqd: number; from: boolean; before_iqd: number | null } | null;
} {
  // Catalog-only (DECISIONS row 240): the site shows «السعر غير متوفر حالياً» and claims no stock.
  if (p.card.price_status !== 'priced') return { status: 'not_priced', price: null };
  const state = cardAvailability(p.card).state;
  if (state === 'available') {
    const firm = p.shelf.filter((s) => !s.estimate && positive(s.price_iqd));
    if (firm.length === 0) return { status: 'not_priced', price: null };
    const low = Math.min(...firm.map((s) => s.price_iqd));
    // The struck price belongs to the selection the printed figure is: among the firm selections at
    // that figure, the smallest struck price above it (never a saving larger than one shown on the site).
    const struck = firm
      .filter((s) => s.price_iqd === low && typeof s.before_iqd === 'number' && positive(s.before_iqd) && s.before_iqd > low)
      .map((s) => s.before_iqd as number);
    return {
      status: 'in_stock',
      price: {
        iqd: low,
        from: p.shelf.some((s) => positive(s.price_iqd) && s.price_iqd !== low),
        before_iqd: struck.length ? Math.min(...struck) : null,
      },
    };
  }
  return state === 'preorder' ? { status: 'pre_order', price: null } : { status: 'not_priced', price: null };
}

/** 760500 → «760,500», as the site prints a dinar figure — without Intl, so every runtime agrees. */
export function groupedIqd(n: number): string {
  return String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A section in the shop's category tree (worker/lib/catalogPresentation.ts `CatalogRecord`). */
export interface CategoryNode {
  id: string;
  parent_id: string | null;
  sort: number;
  name_en: string;
  name_ar: string;
}

const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const siblingOrder = (a: CategoryNode, b: CategoryNode) =>
  a.sort - b.sort || (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar) || textOrder(a.id, b.id);

/**
 * Every section's place in the category tree: depth first, siblings in the
 * admin's order (sort, then name — the category map's own), so a section's
 * sub-sections follow it. A node with no known parent is a root; a cycle,
 * which has none, is ranked after every tree.
 */
export function categoryRanks(nodes: Iterable<CategoryNode>): Map<string, number> {
  const all = [...nodes];
  const ids = new Set(all.map((n) => n.id));
  const children = new Map<string, CategoryNode[]>();
  const roots: CategoryNode[] = [];
  for (const n of all) {
    if (n.parent_id && n.parent_id !== n.id && ids.has(n.parent_id)) {
      const list = children.get(n.parent_id) ?? [];
      list.push(n);
      children.set(n.parent_id, list);
    } else {
      roots.push(n);
    }
  }
  const out = new Map<string, number>();
  const walk = (n: CategoryNode) => {
    if (out.has(n.id)) return;
    out.set(n.id, out.size);
    for (const k of [...(children.get(n.id) ?? [])].sort(siblingOrder)) walk(k);
  };
  for (const r of [...roots].sort(siblingOrder)) walk(r);
  for (const n of [...all].sort(siblingOrder)) walk(n);
  return out;
}

const oneLine = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** The card's section — its sub-section, else its section — and that section's rank (Infinity: not in the tree). */
function sectionOf(card: Record<string, unknown>, ranks: ReadonlyMap<string, number>): { rank: number; id: string } {
  const ids = [card.sub_category_id, card.category_id].map(oneLine).filter(Boolean);
  for (const id of ids) {
    const rank = ranks.get(id);
    if (rank !== undefined) return { rank, id };
  }
  return { rank: Number.POSITIVE_INFINITY, id: ids[0] ?? '' };
}

const byNumber = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

export interface PriceFeedOptions {
  /** The site the links open, e.g. https://levonis-iq.com (worker/lib/appOrigin.ts `trustedOrigin`). */
  origin: string;
  /** `categoryRanks` of the shop's taxonomy; empty orders the sections by id. */
  categoryRanks: ReadonlyMap<string, number>;
}

/**
 * The feed's rows, the header first: in stock, then pre-order, then not priced;
 * within each, by section (the tree's order), then by name.
 */
export function priceFeedRows(products: readonly PriceFeedProduct[], opts: PriceFeedOptions): string[][] {
  const origin = opts.origin.replace(/\/+$/, '');
  const rows = products
    .map((p) => {
      const en = oneLine(p.card.name);
      const ar = oneLine(p.name_ar);
      return { slug: oneLine(p.card.slug), ar: ar || en, en: en || ar, section: sectionOf(p.card, opts.categoryRanks), verdict: priceFeedVerdict(p) };
    })
    .filter((r) => r.slug !== '');
  rows.sort(
    (a, b) =>
      GROUP_ORDER[a.verdict.status] - GROUP_ORDER[b.verdict.status] ||
      byNumber(a.section.rank, b.section.rank) ||
      textOrder(a.section.id, b.section.id) ||
      byName(a.en, b.en) ||
      textOrder(a.slug, b.slug)
  );
  return [
    [...PRICE_FEED_HEADER],
    ...rows.map((r) => {
      const words = PRICE_FEED_STATUS[r.verdict.status];
      const price = r.verdict.price ? `${r.verdict.price.from ? FROM_PREFIX : ''}${groupedIqd(r.verdict.price.iqd)}` : '';
      const before = r.verdict.price && r.verdict.price.before_iqd !== null ? groupedIqd(r.verdict.price.before_iqd) : '';
      return [r.ar, r.en, words.ar, words.en, price, before, `${origin}/product/${encodeURIComponent(r.slug)}`];
    }),
  ];
}

/**
 * The CSV: RFC 4180 quoting and the formula defusing every CSV this Worker
 * serves (worker/lib/importCsv.ts `toCsv`), CRLF line ends, UTF-8 without a
 * BOM — Google Sheets' IMPORTDATA reads the charset from the Content-Type.
 */
export function priceFeedCsv(products: readonly PriceFeedProduct[], opts: PriceFeedOptions): string {
  return `${toCsv(priceFeedRows(products, opts))}\r\n`;
}
