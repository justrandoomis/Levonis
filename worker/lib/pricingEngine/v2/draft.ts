/**
 * PRICING V2-3b — PRICING A DRAFT BEFORE IT IS SAVED (spec §4.1, §4.3, §3.3
 * step 4; docs/PRICING-V2.md §2.6, §2.7).
 *
 * The preview of add-product (`product_id: null`) and of an edit that adds a
 * model or switches a route on, and the product save that commits structure
 * and prices together, all price the product AS THE SAVE WOULD LEAVE IT. That
 * document is built by the one planner every product writer goes through
 * (`planProductSave`), read-only: its planned row, its planned relational
 * mirror and its planned order-type cells under the ids its own batch writes
 * (`plan.view`). The client's ids are the ids the save persists
 * (productPersistence.ts keeps a sent id), so the preview's SKU keys are the
 * save's.
 *
 * Nothing here writes. Prices on the draft are not trusted: the V2 writer
 * replaces every price field the plan touches.
 */
import type { Context } from 'hono';
import type { TransportOffer } from '@levonis/pricing/pricing';
import type { AppContext } from '../../types';
import { HttpError } from '../../http';
import { canWriteCost } from '../../adminScope';
import { applyRelations, EMPTY_RELATIONS, type ProductRelationsView } from '../../productOverlay';
import { parseProductRow, serializeDoc, validateProductDoc, type ProductDoc } from '../../productModel';
import { carryStoredCostForward } from '../../adminScope';
import { planProductSave, type ProductSavePlan } from '../../productPersistence';
import { skuPricesInstalled } from '../../engineInstalled';
import { inputInvalid } from '../whatIf';
import { strictBody } from '../../fx/ownerActs';
import type { LoadedProduct } from '../load';

/**
 * The price fields of a V2 product's document are not the client's (spec
 * §5.5: the form shows computed prices, never an input): the stored ladder
 * stays until the V2 writer replaces it in the same batch, and no route may
 * carry a commission or the product a direct surcharge (0189's fee trigger,
 * PRICING_V2_FEES_RETIRED). A new product keeps its (draft) price field and
 * loses its fees the same way.
 */
export function pinV2PriceFields(doc: ProductDoc, prev: ProductDoc | null): void {
  if (prev) {
    doc.price_iqd = prev.price_iqd;
    doc.prime_price_iqd = prev.prime_price_iqd;
    doc.pro_price_iqd = prev.pro_price_iqd;
    doc.original_price_iqd = prev.original_price_iqd;
  } else {
    doc.prime_price_iqd = null;
    doc.pro_price_iqd = null;
  }
  doc.direct_surcharge_iqd = null;
  doc.preorder_transports = (doc.preorder_transports ?? []).map((t: TransportOffer) => ({ ...t, commission_iqd: 0 }));
}

/**
 * The product as `plan` leaves it, as the cart reads it: the planned row over
 * the stored one, the planned relations (or the stored ones when the save
 * carries none), and the stored SKU rung and strict flag — the rows the V2
 * writer replaces.
 */
export async function draftLoadedOf(db: D1Database, plan: ProductSavePlan, stored: LoadedProduct | null): Promise<LoadedProduct> {
  const id = plan.productId;
  const planned = plan.doc ?? stored?.doc;
  if (!planned) throw new HttpError(400, 'a product document is required', 'VALIDATION');
  const row: Record<string, unknown> = { ...(stored?.row ?? {}), ...serializeDoc(planned), id };
  if (plan.relations) row.inventory_mode = plan.relations.mode;
  const skuRows = stored?.view ? stored.view.sku_prices : (await skuPricesInstalled(db)) ? [] : null;
  const base: ProductRelationsView = plan.view ?? stored?.view ?? { ...EMPTY_RELATIONS };
  const view: ProductRelationsView = {
    ...base,
    sku_prices: skuRows ?? null,
    ...(stored?.view?.sku_strict ? { sku_strict: true as const } : {}),
    // A failed read of the stored rung stays a failed read on the draft: the writer refuses it (retryable).
    ...(stored?.view?.sku_prices_unread ? { sku_prices_unread: true as const } : {}),
  };
  if (!view.sku_strict) delete view.sku_strict;
  if (!view.sku_prices_unread) delete view.sku_prices_unread;
  return { id, row, doc: applyRelations(parseProductRow(row), view), view };
}

/**
 * The PREVIEW's draft: `structure = { doc, relations }` validated and planned
 * as the save would (cost carried forward for a caller who may not write it),
 * then read as `draftLoadedOf` reads a plan. `prev` is the stored product row
 * (null: add-product).
 */
export async function previewDraft(
  c: Context<AppContext>,
  raw: unknown,
  prev: { row: Record<string, unknown>; loaded: LoadedProduct } | null
): Promise<LoadedProduct> {
  const structure = strictBody(raw, ['doc', 'relations']);
  if (!structure.doc || typeof structure.doc !== 'object' || Array.isArray(structure.doc)) throw inputInvalid('structure.doc');
  const relations = structure.relations === undefined || structure.relations === null ? null : structure.relations;
  if (relations !== null && (typeof relations !== 'object' || Array.isArray(relations))) throw inputInvalid('structure.relations');
  const db = c.env.DB;
  const admin = c.get('user')!;
  const body = structure.doc as Record<string, unknown>;
  const prevDoc = prev ? parseProductRow(prev.row) : null;
  const doc = validateProductDoc({ ...body, ...(prevDoc ? { id: prevDoc.id } : {}) }, { costBlind: !canWriteCost(c.env, admin) });
  if (!prevDoc) {
    const taken = await db.prepare('SELECT 1 AS x FROM products WHERE id = ?').bind(doc.id).first<{ x: number }>();
    if (taken) throw inputInvalid('structure.doc.id');
  }
  const money = canWriteCost(c.env, admin);
  if (!money) carryStoredCostForward(doc, prevDoc);
  doc.slug = prevDoc?.slug ?? `draft-${doc.id}`;
  pinV2PriceFields(doc, prevDoc);
  let plan: ProductSavePlan;
  try {
    plan = await planProductSave(
      db,
      {
        mode: prevDoc ? 'update' : 'create',
        doc,
        prev: prevDoc,
        relations: relations as Record<string, unknown> | null,
        actor: { adminId: admin.id, money },
        priceHistory: false,
        hashtags: false,
      },
      { relationMediaMetadata: 'deferred' }
    );
  } catch (e) {
    if (e instanceof HttpError && e.code === 'RELATIONS_VALIDATION') {
      const errors = Array.isArray(e.details?.errors) ? (e.details!.errors as string[]) : [e.message];
      throw new HttpError(400, e.message, 'VALIDATION', { errors, section: 5 });
    }
    throw e;
  }
  return draftLoadedOf(db, plan, prev?.loaded ?? null);
}
