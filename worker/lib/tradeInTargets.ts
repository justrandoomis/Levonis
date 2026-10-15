/**
 * «الجهاز الجديد» — THE SERVER'S SEARCH OVER THE DEVICES A TRADE-IN CAN BUY
 * (Services S-P2 spec §6.4, G19).
 *
 * Only SELLABLE products (V2-published, active, not held: `listing(db).sellable`;
 * DECISIONS row 240: a trade-in target is a purchase-side reader)
 * that are devices (FDM / resin / laser / AMS — never an accessory, never a
 * composition), searched by name in every language, slug and brand, twenty a
 * page on a keyset `(display_order, id)`. Each carries THIS customer's lowest
 * DIRECT-sale price over the product's SKUs — the resolver the cart runs, with
 * the customer's own pricing context — never `products.price_iqd` (the V2
 * writer's rollback figure). A product with no direct-sale price today is not
 * offered: the credit is spent on a direct sale only (§16 D-16).
 */
import type { Env } from './types';
import { listing } from './listing';
import { parseProductRow } from './productModel';
import { resolveUnitPrice } from './pricing';
import { applyRelations, loadRelationsViews } from './productOverlay';
import { printerProductIds } from './printerIdentity';
import { skuLevelSelections } from './skuLevels';
import { catalogIndexFor } from './catalogPresentation';
import { familyOfProduct } from './tradeIn';
import { benefitFallbackFor, pricingCtxForUser, type PricingCtx } from '../routes/products';
import type { TradeInFamily } from '@levonis/pricing/tradeIn';
import { likePattern } from './sqlLike';

export const TARGET_PAGE = 20;
const SCAN = 80;
const DEVICE_FAMILIES: readonly TradeInFamily[] = ['fdm', 'resin', 'laser', 'ams'];

/** `<display_order>|<id>` — opaque to the client, validated here. */
function parseCursor(raw: string | null | undefined): { order: number; id: string } | null {
  if (!raw) return null;
  const m = /^(-?\d{1,9})\|([A-Za-z0-9_-]{1,80})$/.exec(raw);
  return m ? { order: Number(m[1]), id: m[2] } : null;
}


const coverOf = (doc: ReturnType<typeof parseProductRow>): string => {
  const media = [...(doc.media ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary) || a.order - b.order);
  return media[0]?.url ?? '';
};

/** This customer's lowest direct-sale price over the product's SKUs, or null. */
function lowestDirect(doc: ReturnType<typeof parseProductRow>, relations: Parameters<typeof skuLevelSelections>[1], ctx: PricingCtx, isPrinter: boolean): number | null {
  const skus = skuLevelSelections(doc, relations).filter((s) => s.transport_method === null);
  const selections = skus.length ? skus.map((s) => ({ ids: s.option_value_ids, color: s.color_id })) : [{ ids: [] as string[], color: null as string | null }];
  let best: number | null = null;
  for (const sel of selections) {
    const r = resolveUnitPrice({
      product: doc,
      optionId: sel.ids[0] ?? null,
      optionValueIds: sel.ids,
      colorId: sel.color,
      transportMethod: null,
      fulfillmentType: 'direct_sale',
      warrantyPlanId: null,
      tier: ctx.tier,
      tierActive: ctx.tierActive,
      proPolicy: ctx.proPolicy,
      transportDefaults: ctx.transportDefaults,
      memberFallback: benefitFallbackFor(ctx, doc),
      isPrinter,
    });
    const p = Math.trunc(r.unit_subtotal_iqd);
    if (r.errors.length === 0 && p > 0 && (best === null || p < best)) best = p;
  }
  return best;
}

export async function searchTargets(env: Env, userId: string, q: { q: string; family: TradeInFamily | null; cursor: string | null; productId?: string | null }) {
  const db = env.DB;
  // One product by id (the product page's entry, `/trade-in?target=<id>`): the same listing and
  // device rules, the same price — the search term and the cursor do not apply.
  const productId = q.productId ?? null;
  const term = productId ? '' : q.q.trim().slice(0, 80);
  const searching = term.length >= 2;
  const cursor = searching ? parseCursor(q.cursor) : null;
  const where = [(await listing(db)).sellable('products'), "COALESCE(composition, '') = ''"];
  const args: unknown[] = [];
  if (productId) {
    args.push(productId);
    where.push(`id = ?${args.length}`);
  }
  if (searching) {
    args.push(likePattern(term));
    const n = args.length;
    where.push(`(name LIKE ?${n} ESCAPE '\\' OR name_ar LIKE ?${n} ESCAPE '\\' OR name_ku LIKE ?${n} ESCAPE '\\' OR slug LIKE ?${n} ESCAPE '\\' OR brand LIKE ?${n} ESCAPE '\\')`);
  }
  if (cursor) {
    args.push(cursor.order, cursor.id);
    const n = args.length;
    where.push(`(display_order > ?${n - 1} OR (display_order = ?${n - 1} AND id > ?${n}))`);
  }
  // No search: the featured first page (twenty), as the old catalogue wall's top.
  const order = searching ? 'display_order, id' : 'is_featured DESC, display_order, id';
  const { results } = await db
    .prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${SCAN}`)
    .bind(...args)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const idx = await catalogIndexFor(db);
  const devices: Array<{ row: Record<string, unknown>; family: TradeInFamily }> = [];
  let consumed = 0;
  for (const row of rows) {
    consumed++;
    const family = familyOfProduct(row, idx);
    if (family && DEVICE_FAMILIES.includes(family) && (!q.family || q.family === family)) devices.push({ row, family });
    if (devices.length >= TARGET_PAGE) break;
  }
  // A search pages on (display_order, id) from the last row it looked at; the featured page does not page.
  const last = rows[consumed - 1];
  const more = consumed < rows.length || rows.length === SCAN;
  const nextCursor = searching && more && last ? `${Number(last.display_order) || 0}|${String(last.id)}` : null;
  if (!devices.length) return { targets: [], next_cursor: nextCursor };
  const ids = devices.map((d) => String(d.row.id));
  const [ctx, views, printers, groups, values, colors] = await Promise.all([
    pricingCtxForUser(db, userId),
    loadRelationsViews(db, devices.map((d) => ({ id: String(d.row.id), inventory_mode: d.row.inventory_mode }))),
    printerProductIds(db, ids),
    db
      .prepare('SELECT id, product_id, name_en, sort FROM product_option_groups WHERE product_id IN (SELECT value FROM json_each(?1)) AND active = 1 ORDER BY sort')
      .bind(JSON.stringify(ids))
      .all<{ id: string; product_id: string; name_en: string; sort: number }>(),
    db
      .prepare(
        `SELECT id, product_id, group_id, name_en, name_ar, name_ckb, sort FROM product_option_values
          WHERE product_id IN (SELECT value FROM json_each(?1)) AND active = 1 AND merged_into IS NULL ORDER BY sort`
      )
      .bind(JSON.stringify(ids))
      .all<{ id: string; product_id: string; group_id: string; name_en: string; name_ar: string | null; name_ckb: string | null; sort: number }>(),
    db
      .prepare('SELECT id, product_id, name_en, name_ar, name_ckb, hex, sort FROM product_colors WHERE product_id IN (SELECT value FROM json_each(?1)) AND active = 1 ORDER BY sort')
      .bind(JSON.stringify(ids))
      .all<{ id: string; product_id: string; name_en: string; name_ar: string | null; name_ckb: string | null; hex: string; sort: number }>(),
  ]);
  const targets = [];
  for (const { row, family } of devices) {
    const pid = String(row.id);
    const view = views.get(pid);
    const doc = view ? applyRelations(parseProductRow(row), view) : parseProductRow(row);
    const from = lowestDirect(doc, view, ctx, printers.has(pid));
    if (from === null) continue;
    const g = (groups.results ?? []).filter((x) => x.product_id === pid);
    targets.push({
      product_id: pid,
      slug: doc.slug,
      name: doc.name_en || doc.name_ar,
      name_ar: doc.name_ar || doc.name_en,
      ...(doc.name_ckb ? { name_ckb: doc.name_ckb } : {}),
      image: coverOf(doc),
      family,
      from_price_iqd: from,
      groups: g.map((grp) => ({
        id: grp.id,
        name: grp.name_en,
        values: (values.results ?? [])
          .filter((v) => v.group_id === grp.id)
          .map((v) => ({ id: v.id, label_ar: v.name_ar || v.name_en, label_en: v.name_en, ...(v.name_ckb ? { label_ckb: v.name_ckb } : {}) })),
      })),
      colors: (colors.results ?? [])
        .filter((c) => c.product_id === pid)
        .map((c) => ({ id: c.id, label_ar: c.name_ar || c.name_en, label_en: c.name_en, ...(c.name_ckb ? { label_ckb: c.name_ckb } : {}), hex: c.hex })),
    });
  }
  return { targets, next_cursor: nextCursor };
}

/** Is this product a SELLABLE device a trade-in can buy (the product-page entry)? One read. */
export async function isListedDeviceTarget(env: Env, productId: string): Promise<boolean> {
  const db = env.DB;
  const row = await db
    .prepare(`SELECT * FROM products WHERE id = ? AND ${(await listing(db)).sellable('products')} AND COALESCE(composition, '') = ''`)
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!row) return false;
  const family = familyOfProduct(row, await catalogIndexFor(db));
  return !!family && DEVICE_FAMILIES.includes(family);
}
