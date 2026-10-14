/**
 * PRICING V2 — TEST WORLD HELPERS (spec §3.11): the census world of
 * `procurementPricing.ts` (41 products, U = 1,600, EUR/USD 1.1, CNY/USD 0.14,
 * Germany land 3,200 IQD/kg, China air 20,000 IQD/kg, China sea 400,000 IQD/m³)
 * plus the two shapes the census lacks — an option-less product and a
 * colour-only product — and `writeV2`, which makes a product V2 through the REAL
 * V2 writer (evaluateV2Write → v2WriteStatements → one batch), exactly as the
 * owner's save (V2-3b) and the migration (V2-5) will.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { V2Discount, V2Method, V2PricePoint } from '@levonis/pricing/priceV2';
import { loadPreviewContext, loadProducts, type LoadedProduct } from '../../worker/lib/pricingEngine/load';
import { loadProductsPricing, ownerRow, ruleAt, type InputFields, type InputWrite, type RuleWrite } from '../../worker/lib/pricingEngine/store';
import { loadPricingRates } from '../../worker/lib/pricingEngine/rates';
import { loadEngineControl, priceImageOf, withRuleIds } from '../../worker/lib/pricingEngine/engineWrite';
import { loadV2Store } from '../../worker/lib/pricingEngine/v2/store';
import { evaluateV2Write, type V2Evaluation } from '../../worker/lib/pricingEngine/v2/evaluate';
import { v2WriteStatements } from '../../worker/lib/pricingEngine/v2/write';
import { evaluateLegacy } from '../../worker/lib/pricingEngine/legacy';
import { asD1, stubApp, type StubUser } from './app';
import { OWNER_USER } from './procurementPricing';
import { noStoreUnlessSet } from '../../worker/lib/edgePolicy';
import { adminProductsRoutes } from '../../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../../worker/routes/adminProductRelations';
import { adminPricingRoutes } from '../../worker/routes/adminPricing';
import { cartRoutes } from '../../worker/routes/cart';

const sql = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** An option-less product: no option, sold direct and/or pre-order by the product's own routes. */
export function seedOptionless(raw: DatabaseSync, id: string, o: { price?: number; saleTypes?: string[]; routes?: Array<'air' | 'sea' | 'land'>; colours?: number } = {}): void {
  const saleTypes = o.saleTypes ?? ['direct_sale', 'pre_order'];
  const routes = (o.routes ?? ['land']).map((m) => ({ method: m, commission_iqd: 10_000, active: true }));
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                          package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
    VALUES (${sql(id)}, ${sql(`slug-${id}`)}, ${sql(`Product ${id}`)}, 'منتج', 'بەرهەم', 'active', ${o.price ?? 500_000}, 5, ${sql(saleTypes[0])},
            ${sql(JSON.stringify(saleTypes))}, ${sql(JSON.stringify(routes))}, 'BASE', 1000, 400, 300, 200);
  `);
  for (let k = 0; k < (o.colours ?? 0); k += 1) {
    raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
              VALUES (${sql(`${id}_c${k}`)}, ${sql(id)}, ${sql(`Colour ${k + 1}`)}, ${sql(`لون ${k + 1}`)}, ${sql(`ڕەنگی ${k + 1}`)}, '#336699', ${k}, 1, 5);`);
  }
}

export interface WriteV2Options {
  method: V2Method;
  points?: V2PricePoint[];
  discounts?: V2Discount[];
  /** Cost-first: the product-level cost inputs (merged over the stored row). */
  inputs?: Partial<InputFields>;
  /** Cost-first: the product's minimum profit in USD. */
  minimumProfitUsd?: string;
  acceptBlocked?: boolean;
  /** Return the evaluation without writing. */
  dryRun?: boolean;
  actor?: string;
}

/** Everything one evaluation reads, loaded as a route would. */
export async function v2Context(db: D1Database, pid: string) {
  // One batch at a time (a D1 batch is a transaction; the test binding runs them on one connection).
  const loaded = (await loadProducts(db, [pid])).get(pid)!;
  const stores = await loadProductsPricing(db, [pid]);
  const v2 = await loadV2Store(db, [pid]);
  const ctx = await loadPreviewContext(db);
  const rates = await loadPricingRates(db);
  const control = await loadEngineControl(db);
  const image = await priceImageOf(db, pid);
  return { loaded, stored: stores.get(pid)!, v2: v2.get(pid) ?? null, ctx, rates, control, image };
}

/** Make (or reprice) a V2 product through the real V2 writer; throws with the codes when incomplete. */
export async function writeV2(db: D1Database, pid: string, o: WriteV2Options): Promise<V2Evaluation> {
  const c = await v2Context(db, pid);
  const inputWrites: InputWrite[] = o.inputs ? [{ scope: 'base', scope_id: '', existing: ownerRow(c.stored.inputs, 'base', ''), set: o.inputs, source_ref: 'test' }] : [];
  const ruleWrites: RuleWrite[] = o.minimumProfitUsd
    ? withRuleIds([
        {
          kind: 'target_profit',
          scope: 'product',
          scope_id: '',
          existing: ruleAt(c.stored.rules, pid, 'target_profit', 'product', ''),
          next: { state: 'ACTIVE', amount_usd: o.minimumProfitUsd, amount_iqd: null, source: 'OWNER', legacy_result_id: null },
        },
      ])
    : [];
  const ev = await evaluateV2Write({
    loaded: c.loaded,
    stored: c.stored,
    v2: c.v2,
    ctx: c.ctx,
    rates: c.rates,
    control: c.control,
    method: o.method,
    points: o.points ?? [],
    discounts: o.discounts ?? [],
    inputWrites,
    ruleWrites,
    image: c.image,
    acceptBlocked: o.acceptBlocked,
  });
  if (o.dryRun) return ev;
  if (!ev.complete) throw new Error(`V2 evaluation of ${pid} incomplete: ${ev.codes.join(', ')}`);
  const statements = await v2WriteStatements(db, ev, { actor: o.actor ?? 'usr_owner', now: new Date().toISOString(), source: 'test', idempotencyKey: `test:${pid}:${ev.hash}` });
  await db.batch(statements);
  return ev;
}

/** What the cart charges a guest today, per SKU × channel (the live resolver over the customer's document). */
export async function cartGrid(db: D1Database, pid: string): Promise<Record<string, { prepaid: number | null; cod: number | null; fee: number | null; ok: boolean; errors: string[] }>> {
  const loaded: LoadedProduct = (await loadProducts(db, [pid])).get(pid)!;
  const ctx = await loadPreviewContext(db);
  const ev = evaluateLegacy(pid, loaded.doc, loaded.view, ctx, { perSku: true });
  const out: Record<string, { prepaid: number | null; cod: number | null; fee: number | null; ok: boolean; errors: string[] }> = {};
  for (const u of ev.units) for (const c of u.channels) out[`${u.combo_key ?? u.option_id}@${c.channel}`] = { prepaid: c.prepaid_iqd, cod: c.cod_iqd, fee: c.fee_iqd, ok: c.ok, errors: c.errors };
  return out;
}

/**
 * V2-3b: the product routers on a pricing world's database — the product save
 * and its V2 pricing routes, the relations, the pricing door and the cart —
 * as `user` (default: the owner), with a sign-in `sessionAgeSeconds` old.
 */
export function v2App(raw: DatabaseSync, user: StubUser | null = OWNER_USER, sessionAgeSeconds?: number) {
  return stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/products-v2', adminProductsRoutes);
      a.route('/api/admin/products', adminProductRelationsRoutes);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route('/api/cart', cartRoutes);
    },
    sessionAgeSeconds === undefined ? {} : { sessionAgeSeconds }
  );
}
