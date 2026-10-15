/**
 * «سعر اليوم» — TODAY'S PRICE OF THE SAME DEVICE, NEW (Services S-P2 spec §4.2;
 * plan §0 correction 4; DECISIONS row 238).
 *
 * The lowest PUBLIC new price of the same SKU (model + colour) on any channel
 * the shop sells it today: direct sale, or a pre-order route when that is
 * cheaper (V2 keeps P ≤ D). It is read ONLY from a product the customer
 * surfaces list — V2-published, active, not held (`listing(db).listed`) —
 * through the same strict resolver the cart uses, for a guest (the regular
 * public class; the paid-net figure already carries the buyer's membership).
 * An unlisted, held, hidden or «يحتاج تسعيرًا» product answers null, and so does
 * a SKU × channel the V2 writer never priced (`VARIANT_UNAVAILABLE`).
 *
 * NEVER READ: `products.price_iqd`, an option's `regular_price_iqd` /
 * `regular_adjust_iqd`, `pricing_legacy_snapshots` — the archive of old dinar
 * prices and the writer's rollback copies are not today's price.
 *
 * Stock is not required: a model out of stock still has a public price.
 */
import type { Env } from './types';
import { listing } from './listing';
import { parseProductRow } from './productModel';
import { resolveUnitPrice } from './pricing';
import { applyRelations, loadRelationsView } from './productOverlay';
import { isPrinterProduct } from './printerIdentity';
import { skuLevelSelections } from './skuLevels';
import { benefitFallbackFor, pricingCtxForUser, quoteOptionValueIds, type PricingCtx } from '../routes/products';

export type NowChannel = 'direct_sale' | 'pre_order_air' | 'pre_order_sea' | 'pre_order_land';
export interface TodayPrice {
  iqd: number;
  channel: NowChannel;
}

const CHANNELS: ReadonlyArray<{ channel: NowChannel; fulfillmentType: 'direct_sale' | 'pre_order'; transport: string | null }> = [
  { channel: 'direct_sale', fulfillmentType: 'direct_sale', transport: null },
  { channel: 'pre_order_air', fulfillmentType: 'pre_order', transport: 'air' },
  { channel: 'pre_order_sea', fulfillmentType: 'pre_order', transport: 'sea' },
  { channel: 'pre_order_land', fulfillmentType: 'pre_order', transport: 'land' },
];

export interface ListedProduct {
  id: string;
  doc: ReturnType<typeof parseProductRow>;
  relations: Awaited<ReturnType<typeof loadRelationsView>>;
  isPrinter: boolean;
}

/**
 * One request's reads, shared: the guest pricing context and each listed product
 * once (a Combo and its plain sibling are the same product).
 */
export class TodayReader {
  private ctx: Promise<PricingCtx> | null = null;
  private listedSql: Promise<string> | null = null;
  private products = new Map<string, Promise<ListedProduct | null>>();
  constructor(private readonly env: Env) {}

  private guest(): Promise<PricingCtx> {
    this.ctx ??= pricingCtxForUser(this.env.DB, null);
    return this.ctx;
  }

  /** The product as a customer may see it, or null (unlisted, held, hidden, needs pricing, absent). */
  product(productId: string): Promise<ListedProduct | null> {
    let p = this.products.get(productId);
    if (!p) {
      p = (async () => {
        const db = this.env.DB;
        this.listedSql ??= listing(db).then((l) => l.listed('products'));
        const row = await db.prepare(`SELECT * FROM products WHERE id = ? AND ${await this.listedSql}`).bind(productId).first<Record<string, unknown>>();
        if (!row) return null;
        const parsed = parseProductRow(row);
        const [relations, isPrinter] = await Promise.all([loadRelationsView(db, productId, row.inventory_mode), isPrinterProduct(db, productId)]);
        return { id: productId, doc: applyRelations(parsed, relations), relations, isPrinter };
      })();
      this.products.set(productId, p);
    }
    return p;
  }

  /** The lowest public price of one SKU across the channels, or null. Ties go to direct sale. */
  async price(sel: { productId: string; optionValueIds: readonly string[]; colorId: string | null }): Promise<TodayPrice | null> {
    const loaded = await this.product(sel.productId);
    if (!loaded) return null;
    const ctx = await this.guest();
    return priceOnChannels(loaded, ctx, sel.optionValueIds, sel.colorId);
  }

  /** The lowest public price of ANY SKU of a product (a standalone reference product or a successor). */
  async lowest(productId: string): Promise<TodayPrice | null> {
    const loaded = await this.product(productId);
    if (!loaded) return null;
    const ctx = await this.guest();
    const skus = skuLevelSelections(loaded.doc, loaded.relations);
    const candidates = skus.length ? skus.map((s) => ({ ids: s.option_value_ids, color: s.color_id })) : [{ ids: [] as string[], color: null }];
    let best: TodayPrice | null = null;
    for (const c of candidates) {
      const p = priceOnChannels(loaded, ctx, c.ids, c.color);
      if (p && (!best || p.iqd < best.iqd)) best = p;
    }
    return best;
  }
}

function priceOnChannels(loaded: ListedProduct, ctx: PricingCtx, optionValueIdsIn: readonly string[], colorIdIn: string | null): TodayPrice | null {
  const { doc, relations } = loaded;
  const known = new Set(doc.options.filter((o) => o.active !== false && !o.merged_into).map((o) => o.id));
  if (!optionValueIdsIn.every((id) => known.has(id))) return null;
  const optionValueIds = quoteOptionValueIds([...optionValueIdsIn], null, relations);
  const color = colorIdIn ? doc.colors.find((c) => c.id === colorIdIn && c.active !== false) ?? null : null;
  let best: TodayPrice | null = null;
  for (const ch of CHANNELS) {
    const r = resolveUnitPrice({
      product: doc,
      optionId: optionValueIds[0] ?? null,
      optionValueIds,
      colorId: color?.id ?? null,
      transportMethod: ch.transport,
      fulfillmentType: ch.fulfillmentType,
      preorderPricing: 'prepaid',
      warrantyPlanId: null,
      tier: 'free',
      tierActive: false,
      proPolicy: ctx.proPolicy,
      transportDefaults: ctx.transportDefaults,
      memberFallback: benefitFallbackFor(ctx, doc),
      isPrinter: loaded.isPrinter,
    });
    const iqd = Math.trunc(r.unit_subtotal_iqd);
    if (r.errors.length > 0 || !(iqd > 0)) continue;
    if (!best || iqd < best.iqd) best = { iqd, channel: ch.channel };
  }
  return best;
}

/** One SKU's price today, through a one-off reader. */
export function todayPrice(env: Env, sel: { productId: string; optionValueIds: string[]; colorId: string | null }): Promise<TodayPrice | null> {
  return new TodayReader(env).price(sel);
}
