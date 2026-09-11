/**
 * `CatalogEntrypoint` — the catalogue facts other services must not read out
 * of the products tables themselves (`01-TARGET.md` §2.4). It is what
 * `levonis-catalog` will answer from Phase 5; the two methods here are the two
 * Phase-1 consumers actually need: the printer flag (Fulfilment, Devices and
 * the storefront note all key off `catalogs.is_printer_catalog`, never off
 * `ops_policy`) and the cursor-paged index feed Search backfills from (4i).
 *
 * Read-only by construction: this entrypoint writes nothing.
 */
import type { CatalogApi, IndexRow } from '@levonis/contracts/rpc/catalog';
import type { RpcCtx } from '@levonis/contracts/rpc/common';
import { CoreEntrypoint } from './base';
import { safeParse } from '../lib/types';

/** One page of the index feed. Small on purpose: a backfill is many cheap calls. */
export const INDEX_PAGE_SIZE = 100;

export class CatalogEntrypoint extends CoreEntrypoint {
  /** `catalogs.is_printer_catalog` — the owner's flag, resolved for one catalogue. */
  async isPrinterCatalog(catalogId: string, ctx?: RpcCtx): Promise<boolean> {
    await this.assertHop('isPrinterCatalog', [catalogId], ctx);
    const env = this.ready();
    const row = await env.DB.prepare('SELECT is_printer_catalog AS flag FROM catalogs WHERE id = ?')
      .bind(catalogId)
      .first<{ flag: number }>();
    return !!Number(row?.flag ?? 0);
  }

  /**
   * The backfill feed, ordered by id so the cursor is the last id returned —
   * a page can never be skipped by a concurrent insert, and never repeated.
   * Display and index fields only: no cost, no margin, no supplier.
   */
  async listForIndex(cursor: string | null, ctx?: RpcCtx): Promise<{ rows: IndexRow[]; next: string | null }> {
    await this.assertHop('listForIndex', [cursor], ctx);
    const env = this.ready();
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.slug, p.status, p.name_ar, p.name AS name_en, p.name_ku, p.hashtags, p.brand_id, p.price_iqd, p.doc_version,
              (SELECT group_concat(pc.catalog_id) FROM product_catalogs pc WHERE pc.product_id = p.id) AS catalog_ids
         FROM products p
        WHERE p.id > ?
        ORDER BY p.id
        LIMIT ?`
    )
      .bind(cursor ?? '', INDEX_PAGE_SIZE)
      .all<{
        id: string;
        slug: string;
        status: string;
        name_ar: string;
        name_en: string;
        name_ku: string;
        hashtags: string | null;
        brand_id: string | null;
        price_iqd: number | null;
        doc_version: number | null;
        catalog_ids: string | null;
      }>();
    const rows: IndexRow[] = (results ?? []).map((r) => ({
      product_id: String(r.id),
      slug: String(r.slug),
      status: String(r.status),
      names: { ar: r.name_ar ?? '', en: r.name_en ?? '', ckb: r.name_ku ?? '' },
      hashtags: safeParse<string[]>(r.hashtags, []),
      catalog_ids: r.catalog_ids ? String(r.catalog_ids).split(',').filter(Boolean) : [],
      brand_id: r.brand_id ? String(r.brand_id) : null,
      price_iqd: r.price_iqd === null || r.price_iqd === undefined ? null : Number(r.price_iqd),
      doc_version: Number(r.doc_version ?? 0),
    }));
    return { rows, next: rows.length === INDEX_PAGE_SIZE ? rows[rows.length - 1].product_id : null };
  }
}

/**
 * Compile-time proof against `packages/contracts/src/rpc/catalog.ts`.
 * `getProductsForCart` is NOT here: pricing a cart line is the whole resolver
 * (tier, PRO policy, transport defaults, availability), and it moves with the
 * read routes in slice 5.1 rather than being reimplemented behind a binding.
 */
type ImplementedCatalog = Pick<CatalogApi, 'isPrinterCatalog' | 'listForIndex' | 'health'>;
export const _catalogContract: (e: CatalogEntrypoint) => ImplementedCatalog = (e) => e;
