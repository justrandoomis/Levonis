/**
 * THE CATALOGUE, AS THE STOREFRONT READS IT.
 *
 * `catalogSearch` is the search box: the same token index, the same exact
 * identifier lane, the same visibility rule and the same card builders
 * (`listCatalogProducts`), for this viewer. The assistant adds no ranking, no
 * price and no stock rule of its own, so an answer here can never disagree
 * with the grid (assistant plan, acceptance rows 14–15).
 *
 * `printerModels` is which printers the shop actually lists, by model token:
 * the chips the triage offers and the `fits` filter of a part question.
 * `printerCards` is those printers themselves, as cards («شكد سعر الطابعة»
 * while the conversation is about the A1).
 */
import { listCatalogProducts, resolveListingCards } from '../../catalog/cardsRead';
import { optimisticSellable, optimisticSellableFlag, optimisticVisible, runListed } from '../../listing';
import { printerOptions } from '../../printerFits';
import { searchProducts } from '../../search/store';
import type { ModelToken, Viewer } from '../types';
import { MODEL_TOKENS } from '../types';
import { latinModels } from '../understand/models';

export interface CatalogSearchArgs {
  /** The query, already stripped to what names the product. May be empty with a category or `fits`. */
  text: string;
  /** Printer slugs the parts must be linked to (`product_printer_fits`). */
  fits?: string[];
  category?: 'cat_maint';
  limit: number;
  /** The listing offset: «اكو غيرها؟» asks for the page after the cards already shown. */
  offset?: number;
  /**
   * ONLY WHAT THE TEXT REALLY NAMES: keep a product only when the identifier
   * lane answered it exactly, or every typed word reaches it without a
   * forgiven typo (worker/lib/search/index.ts `strongProducts`). For a text
   * that may not name a product at all — the route's last resort for a
   * sentence nothing else read — where a forgiving ranking would answer
   * «اوكي» with a filament.
   */
  strong?: boolean;
}

export interface CatalogItem {
  id: string;
  card: Record<string, unknown>;
  row: Record<string, unknown>;
}

export interface CatalogSearchResult {
  items: CatalogItem[];
  exactIds: string[];
  exactMiss: string[];
}

export const SEARCH_LIMIT_MAX = 8;
export const SEARCH_TEXT_MAX = 100;
export const FITS_MAX = 8;
export const SEARCH_OFFSET_MAX = 48;

export async function catalogSearch(db: D1Database, viewer: Viewer, args: CatalogSearchArgs): Promise<CatalogSearchResult> {
  const q: Record<string, string> = { limit: String(Math.min(SEARCH_LIMIT_MAX, Math.max(1, args.limit))) };
  const text = args.text.trim().slice(0, SEARCH_TEXT_MAX - 1);
  // The trailing space says the last word is finished: «hotend» is the word,
  // not the start of a longer one (`typingLastWord` in routes/products.ts).
  if (text) q.search = `${text} `;
  if (args.fits?.length) q.fits = args.fits.slice(0, FITS_MAX).join(',');
  if (args.category) q.category = args.category;
  if (args.offset) q.offset = String(Math.min(SEARCH_OFFSET_MAX, Math.max(0, Math.floor(args.offset))));
  if (!q.search && !q.fits && !q.category) return { items: [], exactIds: [], exactMiss: [] };
  const listing = await listCatalogProducts(db, q, viewer.pricing);
  const products = Array.isArray(listing.body.products) ? (listing.body.products as Record<string, unknown>[]) : [];
  const items: CatalogItem[] = [];
  for (const card of products) {
    const id = String(card.id ?? '');
    if (!id) continue;
    items.push({ id, card, row: listing.rows.get(id) ?? card });
  }
  const exact = Array.isArray(listing.body.exact) ? (listing.body.exact as Array<{ product_id?: unknown }>) : [];
  const miss = Array.isArray(listing.body.exact_miss) ? (listing.body.exact_miss as unknown[]) : [];
  const exactIds = [...new Set(exact.map((h) => String(h.product_id ?? '')).filter(Boolean))];
  let kept = items;
  if (args.strong && text && items.length) {
    // The same engine, asked which of its matches carry every word. A database
    // whose index is not built yet answered through the LIKE fallback, which
    // is already literal: its answer stands.
    const ranked = await searchProducts(db, `${text} `, { limit: SEARCH_LIMIT_MAX, completeLast: false, strong: true }).catch(() => null);
    if (ranked?.indexReady) {
      const keep = new Set([...exactIds, ...(ranked.strong ?? [])]);
      kept = items.filter((i) => keep.has(i.id));
    } else if (!ranked) {
      kept = items.filter((i) => exactIds.includes(i.id));
    }
  }
  return {
    items: kept,
    exactIds,
    exactMiss: miss.filter((m): m is string => typeof m === 'string'),
  };
}

/**
 * THE PRODUCTS JUST SHOWN, READ AGAIN («شكد سعره؟», «الاول بكم»).
 *
 * The ids come from the conversation context, which a browser can forge, so
 * they are only ids: each row is read again under the storefront listing's
 * own visibility rule and turned into a card by the storefront's card
 * builder, for this viewer. The price and availability are therefore today's,
 * the grid's, and a product no longer listed is simply absent. Same order as
 * `ids`.
 */
export async function catalogByIds(db: D1Database, viewer: Viewer, ids: string[]): Promise<CatalogItem[]> {
  if (ids.length === 0) return [];
  const scope = `${optimisticVisible(db)} AND (products.composition = '' OR ${optimisticSellable(db)})`;
  const { results } = await runListed(
    db,
    `SELECT *, ${optimisticSellableFlag(db)} AS sellable_now FROM products WHERE ${scope} AND products.id IN (SELECT value FROM json_each(?))`,
    (q) => db.prepare(q).bind(JSON.stringify(ids)).all<Record<string, unknown>>()
  );
  const rows = results ?? [];
  const cards = await resolveListingCards(db, rows, await viewer.pricing, null, 'flag');
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const out: CatalogItem[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const card = cards.get(id);
    if (row && card) out.push({ id, card, row });
  }
  return out;
}

/** Memoised per isolate: the printer list changes when the owner edits the catalogue, not per request. */
const MODELS_TTL_MS = 60_000;

interface ListedPrinters {
  slugs: Map<ModelToken, string[]>;
  ids: Map<ModelToken, string[]>;
}
const modelsMemo = new WeakMap<D1Database, { at: number; value: Promise<ListedPrinters> }>();

function listedPrinters(db: D1Database, nowMs: number): Promise<ListedPrinters> {
  const hit = modelsMemo.get(db);
  if (hit && nowMs - hit.at < MODELS_TTL_MS) return hit.value;
  const value = loadPrinterModels(db);
  modelsMemo.set(db, { at: nowMs, value });
  value.catch(() => modelsMemo.delete(db));
  return value;
}

/**
 * Model token → the slugs of the ACTIVE, new (not used-unit) printers the
 * catalogue lists under it, in the registry's order. «Bambu Lab A1 Combo» and
 * «Bambu Lab A1» are both A1. A model the shop does not list is absent, so it
 * never becomes a chip.
 */
export async function printerModels(db: D1Database, nowMs = Date.now()): Promise<Map<ModelToken, string[]>> {
  return (await listedPrinters(db, nowMs)).slugs;
}

/**
 * The printers the shop lists under one model, as the storefront cards them
 * for this viewer (`catalogByIds`: today's visibility, price and stock). At
 * most `limit`; none when the shop lists no printer of that model. A new
 * printer comes before a refurbished or open-box one (`loadPrinterModels`).
 */
export async function printerCards(db: D1Database, viewer: Viewer, model: ModelToken, limit: number): Promise<CatalogItem[]> {
  const ids = (await listedPrinters(db, Date.now())).ids.get(model) ?? [];
  return ids.length ? catalogByIds(db, viewer, ids.slice(0, limit)) : [];
}

/**
 * The models of the listed printers among `ids`, in the registry's order.
 * An answer that showed the A1 and the A1 Combo was about the A1; one that
 * showed a part, or three different printers, is about no one printer.
 */
export async function printerModelsOf(db: D1Database, ids: readonly string[]): Promise<ModelToken[]> {
  if (!ids.length) return [];
  const listed = await listedPrinters(db, Date.now());
  const wanted = new Set(ids);
  return [...listed.ids.entries()].filter(([, list]) => list.some((id) => wanted.has(id))).map(([model]) => model);
}

/**
 * A refurbished, open-box or second-hand listing: it is offered after the new
 * printer of the same model, whatever its name sorts as («[Refurbished] …»
 * sorts before «Bambu …»).
 */
const SECOND_HAND = /refurb|renewed|open[\s-]?box|pre[\s-]?owned|second[\s-]?hand|\bused\b|مجدد|مستعمل|اوبن\s?بوكس|مستخدم/i;
function secondHand(p: { name_en: string; name_ar: string; slug: string }): boolean {
  return SECOND_HAND.test(`${p.name_en} ${p.name_ar} ${p.slug}`);
}

async function loadPrinterModels(db: D1Database): Promise<ListedPrinters> {
  // New first, then refurbished and open-box; otherwise the listing's own order (a stable sort).
  const printers = [...(await printerOptions(db))].sort((a, b) => Number(secondHand(a)) - Number(secondHand(b)));
  const slugs = new Map<ModelToken, string[]>();
  const ids = new Map<ModelToken, string[]>();
  for (const p of printers) {
    if (p.status !== 'active' || p.used) continue;
    const model = latinModels(p.name_en || p.name_ar)[0];
    if (!model) continue;
    const list = slugs.get(model) ?? [];
    if (!list.includes(p.slug)) list.push(p.slug);
    slugs.set(model, list);
    const idList = ids.get(model) ?? [];
    if (!idList.includes(p.id)) idList.push(p.id);
    ids.set(model, idList);
  }
  const ordered: ListedPrinters = { slugs: new Map(), ids: new Map() };
  for (const token of MODEL_TOKENS) {
    if (!slugs.has(token)) continue;
    ordered.slugs.set(token, slugs.get(token)!);
    ordered.ids.set(token, ids.get(token)!);
  }
  return ordered;
}
