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
 */
import { listCatalogProducts } from '../../catalog/cardsRead';
import { printerOptions } from '../../printerFits';
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

export async function catalogSearch(db: D1Database, viewer: Viewer, args: CatalogSearchArgs): Promise<CatalogSearchResult> {
  const q: Record<string, string> = { limit: String(Math.min(SEARCH_LIMIT_MAX, Math.max(1, args.limit))) };
  const text = args.text.trim().slice(0, SEARCH_TEXT_MAX - 1);
  // The trailing space says the last word is finished: «hotend» is the word,
  // not the start of a longer one (`typingLastWord` in routes/products.ts).
  if (text) q.search = `${text} `;
  if (args.fits?.length) q.fits = args.fits.slice(0, FITS_MAX).join(',');
  if (args.category) q.category = args.category;
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
  return {
    items,
    exactIds: [...new Set(exact.map((h) => String(h.product_id ?? '')).filter(Boolean))],
    exactMiss: miss.filter((m): m is string => typeof m === 'string'),
  };
}

/** Memoised per isolate: the printer list changes when the owner edits the catalogue, not per request. */
const MODELS_TTL_MS = 60_000;
const modelsMemo = new WeakMap<D1Database, { at: number; value: Promise<Map<ModelToken, string[]>> }>();

/**
 * Model token → the slugs of the ACTIVE, new (not used-unit) printers the
 * catalogue lists under it, in the registry's order. «Bambu Lab A1 Combo» and
 * «Bambu Lab A1» are both A1. A model the shop does not list is absent, so it
 * never becomes a chip.
 */
export function printerModels(db: D1Database, nowMs = Date.now()): Promise<Map<ModelToken, string[]>> {
  const hit = modelsMemo.get(db);
  if (hit && nowMs - hit.at < MODELS_TTL_MS) return hit.value;
  const value = loadPrinterModels(db);
  modelsMemo.set(db, { at: nowMs, value });
  value.catch(() => modelsMemo.delete(db));
  return value;
}

async function loadPrinterModels(db: D1Database): Promise<Map<ModelToken, string[]>> {
  const printers = await printerOptions(db);
  const byModel = new Map<ModelToken, string[]>();
  for (const p of printers) {
    if (p.status !== 'active' || p.used) continue;
    const model = latinModels(p.name_en || p.name_ar)[0];
    if (!model) continue;
    const list = byModel.get(model) ?? [];
    if (!list.includes(p.slug)) list.push(p.slug);
    byModel.set(model, list);
  }
  const ordered = new Map<ModelToken, string[]>();
  for (const token of MODEL_TOKENS) if (byModel.has(token)) ordered.set(token, byModel.get(token)!);
  return ordered;
}
