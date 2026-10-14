/**
 * THE CLEAN START'S TEST FIXTURE (owner answer Q6, DECISIONS row 222; spec
 * addendum A.12.1).
 *
 * From the release on, a platform product is listed to customers only while it
 * is V2-PUBLISHED: a V2 method AND the results of a complete V2 price write
 * (worker/lib/listing.ts `V2_LISTED_CLAUSE`). A product a test seeds with raw
 * SQL is therefore hidden — exactly like every product that exists at deploy.
 * A test that needs a sellable product publishes it here, through the REAL V2
 * writer (evaluateV2Write → v2WriteStatements → one batch), as the owner's
 * first V2 write would: price-first («سعر بالدولار»), at the fixture rate
 * U = 1,500 (or the rate the test already applied).
 *
 * The dollars are chosen so the fixture's prices stay what the test seeded
 * (`usdReproducing`: ceil_1000(usd × U) = ceil_1000(I)), per SKU: one product
 * price for the commonest SKU price, a SKU price for every other; and one
 * pre-order discount that reproduces each SKU's cheapest route under its
 * direct price. An off-step price (12,345) moves to the next 1,000; route fees
 * are 0 on a V2 product; a pre-order dearer than direct sells at direct.
 *
 * `usdReproducing` and `discountReproducing` are the V2-5 migration's helpers.
 * The clean start retired that migration (no path may publish an old dinar
 * price), so they live here, test-only (tests/pricingCostToPrice.test.ts
 * fails if a worker/ or src/ file names them), proven by
 * tests/v2Publish.test.ts.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  addProcurementExact,
  compareProcurementExact,
  floorToPlaces,
  parseProcurementDecimal,
  procurementExact,
  procurementExactText,
  quotientProcurementExact,
  type ProcurementExact,
} from '@levonis/contracts/procurementCost';
import { ROUNDING_STEP_IQD, ceilStep } from '@levonis/pricing/costToPrice';
import { SKU_CHANNELS } from '@levonis/pricing/skuChannel';
import type { V2Discount, V2PricePoint } from '@levonis/pricing/priceV2';
import { evaluateLegacy, unitComboKey } from '../../worker/lib/pricingEngine/legacy';
import { evaluateV2Write, type V2Evaluation } from '../../worker/lib/pricingEngine/v2/evaluate';
import { v2WriteStatements } from '../../worker/lib/pricingEngine/v2/write';
import { firstWriteInputs, firstWriteStatements } from '../../worker/lib/pricingEngine/v2/firstWrite';
import { asD1 } from './app';
import { applyRate } from './fx';
import { v2Context } from './pricingV2';

/** The fixture's USD/IQD when the test applied none (spec addendum A.12.1). */
export const FIXTURE_U = '1500';

/* ------------------------------------------------- the reproduce rule -- */

const cmp = compareProcurementExact;
const sub = (a: ProcurementExact, b: ProcurementExact): ProcurementExact => addProcurementExact(a, { num: -b.num, den: b.den });

function wholeIqd(iqd: unknown, what: string): number {
  if (typeof iqd !== 'number' || !Number.isSafeInteger(iqd) || iqd < 1) throw new RangeError(`${what} must be a whole number of IQD ≥ 1, never a binary float`);
  return iqd;
}

/** U as an exact positive rational with a cent × U below one step (U < 100,000 at the 1,000 step). */
function usdRateOf(u: unknown, step: number): ProcurementExact {
  if (typeof u === 'number' && !Number.isSafeInteger(u)) throw new RangeError('The USD/IQD rate must be decimal text, never a binary float');
  let exact: ProcurementExact;
  try {
    exact = procurementExact(parseProcurementDecimal(u, { maxIntDigits: 12, maxFractionDigits: 12, min: 'positive' }));
  } catch {
    throw new RangeError('The USD/IQD rate must be a positive decimal');
  }
  if (cmp(exact, procurementExact(100 * step)) >= 0) throw new RangeError('A cent × U must stay below one rounding step (U < 100,000 at the 1,000 step)');
  return exact;
}

const reproducingExact = (iqd: number, u: ProcurementExact, step: number) => floorToPlaces(quotientProcurementExact(procurementExact(ceilStep(iqd, step)), u), 2);

/**
 * The cents that reproduce a dinar price: floor_cents(ceil_step(I) ÷ U). For every
 * whole I ≥ 1 and 0 < U < 100 × step, ceil_step(result × U) === ceil_step(I): an
 * off-step I (1,004,500) reproduces the NEXT step (1,005,000), never the lower one.
 */
export function usdReproducing(iqd: number, u: string, step: number = ROUNDING_STEP_IQD): string {
  return procurementExactText(reproducingExact(wholeIqd(iqd, 'The price'), usdRateOf(u, step), step));
}

/** The discount that reproduces a pre-order price under the direct dollars: max(0, D − usdReproducing(P)). */
export function discountReproducing(directUsd: string, preorderIqd: number, u: string, step: number = ROUNDING_STEP_IQD): string {
  if (typeof directUsd !== 'string') throw new RangeError('A dollar price must be decimal text, never a binary float');
  const d = procurementExact(parseProcurementDecimal(directUsd, { maxIntDigits: 12, maxFractionDigits: 2, min: 'positive' }));
  const diff = sub(d, reproducingExact(wholeIqd(preorderIqd, 'The pre-order price'), usdRateOf(u, step), step));
  return diff.num > 0n ? procurementExactText(diff) : '0';
}

/* ----------------------------------------------------------- the rate -- */

/** The applied USD/IQD, applying `u` first when the test applied none. */
export function ensureUsdRate(raw: DatabaseSync, u: string = FIXTURE_U): string {
  const row = raw.prepare("SELECT effective_rate AS r FROM fx_rate_pairs WHERE pair = 'USD_IQD'").get() as { r: string | null } | undefined;
  if (row?.r) return row.r;
  applyRate(raw, 'USD_IQD', u);
  return u;
}

/* ---------------------------------------------------------- publishing -- */

export interface PublishOptions {
  /** One dollar price for the whole product instead of the reproduced grid. */
  usd?: string;
  /** With `usd`: one pre-order discount for every SKU. */
  discountUsd?: string;
  /** Only price-first exists here: a cost-first product needs the owner's inputs (tests/fixtures/pricingV2.ts `writeV2`). */
  method?: 'usd';
  /** The USD/IQD to apply when none is (default 1,500). */
  u?: string;
  actor?: string;
}

const mostCommon = <T>(xs: readonly T[]): T | undefined => {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | undefined;
  let n = 0;
  for (const [x, c] of counts) if (c > n) [best, n] = [x, c];
  return best;
};

/** The dollar set that keeps today's (seeded) prices: a product price, SKU exceptions, one discount per SKU. */
async function reproducedSet(raw: DatabaseSync, pid: string, u: string): Promise<{ points: V2PricePoint[]; discounts: V2Discount[] }> {
  const db = asD1(raw);
  const c = await v2Context(db, pid);
  const legacy = evaluateLegacy(pid, c.loaded.doc, c.loaded.view, c.ctx, { perSku: true });
  const units = legacy.units.map((unit) => {
    const ok = (ch: string) => unit.channels.find((x) => x.channel === ch && x.ok && (x.prepaid_iqd ?? 0) > 0)?.prepaid_iqd ?? null;
    const direct = ok('direct_sale');
    const routes = SKU_CHANNELS.filter((ch) => ch !== 'direct_sale').map(ok).filter((p): p is number => p !== null);
    const cheapestRoute = routes.length ? Math.min(...routes) : null;
    return { combo: unitComboKey(unit), direct, cheapestRoute, target: direct ?? cheapestRoute };
  });
  const priced = units.filter((x) => x.target !== null);
  const fallback = Number(c.loaded.row.price_iqd) > 0 ? Number(c.loaded.row.price_iqd) : 1000;
  const base = mostCommon(priced.map((x) => x.target!)) ?? fallback;
  const productUsd = usdReproducing(base, u);
  const points: V2PricePoint[] = [{ scope: 'product', scope_id: '', kind: 'fixed', usd: productUsd }];
  const usdOf = new Map<string, string>();
  for (const x of priced) {
    if (x.target === base || x.combo === '') {
      usdOf.set(x.combo, productUsd);
      continue;
    }
    const usd = usdReproducing(x.target!, u);
    points.push({ scope: 'sku', scope_id: x.combo, kind: 'fixed', usd });
    usdOf.set(x.combo, usd);
  }
  // One discount per SKU that sells direct and by a cheaper route; the commonest becomes the product's.
  const wanted = units
    .filter((x) => x.direct !== null && x.cheapestRoute !== null)
    .map((x) => ({ combo: x.combo, usd: discountReproducing(usdOf.get(x.combo) ?? productUsd, x.cheapestRoute!, u) }));
  const common = mostCommon(wanted.map((w) => w.usd)) ?? '0';
  const discounts: V2Discount[] = common !== '0' ? [{ scope: 'product', scope_id: '', usd: common }] : [];
  for (const w of wanted) if (w.usd !== common && w.combo !== '') discounts.push({ scope: 'sku', scope_id: w.combo, usd: w.usd });
  return { points, discounts };
}

/**
 * Publish one product in V2 (price-first) through the real writer: its first V2
 * write when it has no method (the clean start's «يحتاج تسعيرًا»), a reprice
 * otherwise. Throws with the codes when the evaluation is incomplete.
 */
export async function publishV2(raw: DatabaseSync, productId: string, o: PublishOptions = {}): Promise<V2Evaluation> {
  const db = asD1(raw);
  const u = ensureUsdRate(raw, o.u);
  const set = o.usd
    ? { points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: o.usd }] as V2PricePoint[], discounts: o.discountUsd ? ([{ scope: 'product', scope_id: '', usd: o.discountUsd }] as V2Discount[]) : [] }
    : await reproducedSet(raw, productId, u);
  const first0 = !raw.prepare("SELECT 1 AS x FROM product_pricing_state WHERE product_id = ? AND mode = 'engine' AND pricing_method IS NOT NULL").get(productId);
  // The owner's first V2 write is a product save, and that save retires the fees in the same batch
  // (`pinV2PriceFields`: no direct surcharge, every route's commission 0 — 0189's fee trigger).
  if (first0) zeroLegacyFees(raw, productId);
  const c = await v2Context(db, productId);
  const first = !(c.stored.state?.mode === 'engine' && c.stored.state.pricing_method);
  const ev = await evaluateV2Write({
    loaded: c.loaded,
    stored: c.stored,
    v2: c.v2,
    ctx: c.ctx,
    rates: c.rates,
    control: c.control,
    method: 'usd',
    points: set.points,
    discounts: set.discounts,
    inputWrites: first ? firstWriteInputs(c.stored) : [],
    ruleWrites: [],
    image: c.image,
    acceptBlocked: true,
  });
  if (!ev.complete) throw new Error(`publishV2(${productId}) incomplete: ${ev.codes.join(', ')}`);
  const statements = await v2WriteStatements(db, ev, {
    actor: o.actor ?? 'usr_owner',
    now: new Date().toISOString(),
    source: 'test',
    idempotencyKey: `test:publish:${productId}:${ev.hash}`,
    ...(first ? { firstWrite: firstWriteStatements(db, c.stored) } : {}),
  });
  await db.batch(statements);
  return ev;
}

/** What the first V2 save does to the legacy fee columns (worker/lib/pricingEngine/v2/draft.ts `pinV2PriceFields`). */
function zeroLegacyFees(raw: DatabaseSync, productId: string): void {
  const row = raw.prepare('SELECT direct_surcharge_iqd AS s, preorder_transports AS t FROM products WHERE id = ?').get(productId) as { s: number | null; t: string | null } | undefined;
  if (!row) return;
  let routes: unknown = null;
  try {
    routes = row.t ? JSON.parse(row.t) : null;
  } catch {
    routes = null;
  }
  const zeroed = Array.isArray(routes) ? routes.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? { ...(r as Record<string, unknown>), commission_iqd: 0 } : r)) : routes;
  const t = Array.isArray(routes) ? JSON.stringify(zeroed) : row.t;
  if (t !== row.t) raw.prepare('UPDATE products SET preorder_transports = ? WHERE id = ?').run(t, productId);
  // A V1 engine product's surcharge sits under 0181's price lock: it stays (the V2 resolver reads no fee).
  const v1 = raw.prepare("SELECT 1 AS x FROM product_pricing_state WHERE product_id = ? AND mode = 'engine'").get(productId);
  if (row.s !== null && !v1) raw.prepare('UPDATE products SET direct_surcharge_iqd = NULL WHERE id = ?').run(productId);
}

/** Is this product V2-published (the listing predicate's clause)? */
export function isV2Published(raw: DatabaseSync, productId: string): boolean {
  return !!raw
    .prepare(
      `SELECT 1 AS x FROM product_pricing_state s WHERE s.product_id = ? AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
          AND EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = s.product_id)`
    )
    .get(productId);
}

/**
 * Publish every ordinary product of the database not yet V2-published (or the
 * ids given). Compositions (bundles, mystery offers) have no V2 method yet
 * (owner question Q7): they stay hidden and are skipped. Returns the ids published.
 */
export async function publishAllV2(raw: DatabaseSync, o: PublishOptions & { ids?: readonly string[] } = {}): Promise<string[]> {
  const rows = raw.prepare("SELECT id FROM products WHERE COALESCE(composition, '') = '' ORDER BY id").all() as Array<{ id: string }>;
  const wanted = o.ids ? new Set(o.ids) : null;
  const done: string[] = [];
  for (const { id } of rows) {
    if (wanted && !wanted.has(id)) continue;
    if (isV2Published(raw, id)) continue;
    await publishV2(raw, id, o);
    done.push(id);
  }
  return done;
}

/**
 * A price change after the clean start: a V2-published product is repriced
 * through the real writer (one dollar price reproducing `iqd` at the fixture
 * U), never by an UPDATE of the legacy columns — the engine locks refuse that.
 */
export function repriceV2(raw: DatabaseSync, productId: string, iqd: number, o: Omit<PublishOptions, 'usd'> = {}): Promise<V2Evaluation> {
  return publishV2(raw, productId, { ...o, usd: usdReproducing(iqd, o.u ?? FIXTURE_U) });
}
