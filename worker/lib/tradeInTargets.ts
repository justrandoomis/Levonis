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
 *
 * «سعر تقديري» (migration 0218; docs/SMART_PRICING.md §8; owner question
 * 282(h), default: excluded): a product whose price is an estimate the owner
 * has not confirmed is never a target. It is sold by pre-order only, so it has
 * no direct-sale price here anyway — this is defence in depth, read off the
 * product row both readers already select (`SELECT *`), at no statement's cost.
 */
import type { Env } from './types';
import { listing } from './listing';
import { isEstimateRow } from './priceEstimateLabel';
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
    // A labelled product (an estimated price) is looked at and passed over, so the keyset cursor still moves past it.
    if (isEstimateRow(row)) continue;
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
    targets.push({
      product_id: pid,
      slug: doc.slug,
      name: doc.name_en || doc.name_ar,
      name_ar: doc.name_ar || doc.name_en,
      ...(doc.name_ckb ? { name_ckb: doc.name_ckb } : {}),
      image: coverOf(doc),
      family,
      from_price_iqd: from,
      ...choicesOf(doc, (groups.results ?? []).filter((x) => x.product_id === pid), values.results ?? [], colors.results ?? []),
    });
  }
  return { targets, next_cursor: nextCursor };
}

type GroupRow = { id: string; product_id: string; name_en: string; sort: number };
type ValueRow = { id: string; product_id: string; group_id: string; name_en: string; name_ar: string | null; name_ckb: string | null; sort: number };
type ColorRow = { id: string; product_id: string; name_en: string; name_ar: string | null; name_ckb: string | null; hex: string; sort: number };

/**
 * THE CHOICES OF A TARGET, from the product AS IT IS SOLD (`doc.options` / `doc.colors` — the ids
 * the target's price is checked against, `priceTarget`), never from the relational tables alone:
 * a product whose models live in its own option list (the A1's «A1 / A1 Combo», no group row) has
 * no `product_option_values` rows, and a group sent with no value could never be chosen — the
 * sheet showed «اختر الخيارات» with nothing to pick (owner, 2026-11-18). Options are grouped by
 * their group name; a group row of the same name lends its id, else a stable one is made.
 * Every group sent has at least one value.
 */
export function choicesOf(doc: ReturnType<typeof parseProductRow>, groupRows: GroupRow[], valueRows: ValueRow[], colorRows: ColorRow[]) {
  const live = doc.options.filter((o) => o.active !== false && !o.merged_into);
  const rowOf = new Map(valueRows.map((v) => [v.id, v]));
  const groupIdOfValue = new Map(valueRows.map((v) => [v.id, v.group_id]));
  const groupById = new Map(groupRows.map((g) => [g.id, g]));
  const byKey = new Map<string, { id: string; name: string; sort: number; values: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string }> }>();
  live.forEach((o, i) => {
    const rowGroup = groupIdOfValue.get(o.id);
    const named = (o as { group_en?: string }).group_en?.trim() ?? '';
    const match = rowGroup ? groupById.get(rowGroup) : groupRows.find((g) => named !== '' && g.name_en === named);
    const key = match ? match.id : `grp:${named || 'main'}`;
    let g = byKey.get(key);
    if (!g) {
      g = { id: key, name: match?.name_en ?? named, sort: match?.sort ?? 1_000 + i, values: [] };
      byKey.set(key, g);
    }
    const r = rowOf.get(o.id);
    const ar = o.name_ar || r?.name_ar || o.name_en;
    const en = o.name_en || r?.name_en || o.name_ar;
    const ckb = o.name_ckb || r?.name_ckb || '';
    g.values.push({ id: o.id, label_ar: ar, label_en: en, ...(ckb ? { label_ckb: ckb } : {}) });
  });
  const groups = [...byKey.values()].filter((g) => g.values.length > 0).sort((a, b) => a.sort - b.sort).map(({ id, name, values }) => ({ id, name, values }));
  const colorRow = new Map(colorRows.map((c) => [c.id, c]));
  const colors = doc.colors
    .filter((c) => c.active !== false)
    .map((c) => {
      const r = colorRow.get(c.id);
      const ckb = c.name_ckb || r?.name_ckb || '';
      return { id: c.id, label_ar: c.name_ar || r?.name_ar || c.name_en, label_en: c.name_en || r?.name_en || c.name_ar, ...(ckb ? { label_ckb: ckb } : {}), hex: c.hex || r?.hex || '' };
    });
  return { groups, colors };
}

/** Is this product a SELLABLE device a trade-in can buy (the product-page entry)? One read. */
export async function isListedDeviceTarget(env: Env, productId: string): Promise<boolean> {
  const db = env.DB;
  const row = await db
    .prepare(`SELECT * FROM products WHERE id = ? AND ${(await listing(db)).sellable('products')} AND COALESCE(composition, '') = ''`)
    .bind(productId)
    .first<Record<string, unknown>>();
  // An estimated price is never a target (see the header): the product page draws no trade-in entry for it.
  if (!row || isEstimateRow(row)) return false;
  const family = familyOfProduct(row, await catalogIndexFor(db));
  return !!family && DEVICE_FAMILIES.includes(family);
}
