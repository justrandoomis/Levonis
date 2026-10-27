/**
 * LEVONIS PRINT CLOUD — THE STORE (src/cloud/pages/store, src/cloud/strings/store.ts).
 *
 * Fast and build-free. What a purchase on cloud.<root> may and may not do,
 * held to the server it talks to:
 *
 *   quantities   the picker offers exactly what POST /pricing/quote accepts —
 *                min ≤ q ≤ max, q a multiple of the step (pricing.ts), never
 *                above the shelf — and a cart line is one per thing and
 *                destination, at most 25 lines (the quote's own limit);
 *   the cart     in memory and owned: another identity never sees a line,
 *                nothing is written to browser storage;
 *   deadlines    a quote and an order's stock hold are the server's absolute
 *                times; a passed or unreadable one is never shown as open;
 *   payment      the wallet's refusals read from their codes and details, the
 *                states and methods named in three languages for every value
 *                the database allows, the development door never called;
 *   honesty      no price is typed into the store or worked out on the client:
 *                every figure is the server's (a pack's stated price, a
 *                package's price, /pricing/quote, the stored quote).
 *
 * Run: node --import tsx --test tests/printCloudUiStore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ROOT } from './fixtures/d1';
import { ApiError } from '../src/lib/api';
import * as R from '../src/cloud/pages/store/rules';
import * as W from '../src/cloud/strings/store';
import { tx } from '../src/cloud/text';
import type { CreditPackage, PricedLine, PrinterModel, PriceTier, StoreProduct, Tri } from '../src/cloud/types';

const LANGS = ['ar', 'en', 'ckb'] as const;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, re, out);
    else if (re.test(name)) out.push(rel);
  }
  return out.sort();
}
const STORE_FILES = walk('src/cloud/pages/store', /\.tsx?$/);
const CLOUD_FILES = walk('src/cloud', /\.tsx?$/);

/** The source without its comments (strings pass whole), as tests/printCloudUiShell.test.ts strips it. */
const STRING_OR_COMMENT = /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`)|(\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$)|\/\/.*$/gm;
const code = (source: string) => source.replace(STRING_OR_COMMENT, (m: string, _s?: string, comment?: string) => (comment === undefined ? m : ''));
const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (source: ts.SourceFile, n: ts.Node) => `${source.fileName}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`;

// ------------------------------------------------------------ fixtures

const tri = (en: string): Tri => ({ ar: `ع ${en}`, en, ckb: `ک ${en}` });

function variant(over: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: 'pcv_1',
    product_id: 'pcp_1',
    sku: 'PLA-W',
    name: tri('Cold White'),
    product_name: tri('PLA Basic'),
    color_name: 'Cold White',
    color_hex: '#F4F4F2',
    diameter_um: 1750,
    unit_code: 'g',
    min_purchase_qty: 50,
    purchase_step_qty: 50,
    max_purchase_qty: 5000,
    max_per_customer_qty: null,
    fulfillment_modes: ['inventory', 'delivery', 'project'],
    category_code: 'filament',
    brand: 'Bambu Lab',
    material: 'PLA',
    grade: null,
    tags: [],
    sellable_qty: 100_000,
    price_tiers: [],
    ...over,
  };
}

const pack = (min_qty: number, price: number | null): PriceTier => ({ variant_id: 'pcv_1', mode: 'pack', min_qty, pack_price_iqd: price, unit_price_milli_iqd: null });
const bracket = (min_qty: number, milli: number): PriceTier => ({ variant_id: 'pcv_1', mode: 'bracket', min_qty, pack_price_iqd: null, unit_price_milli_iqd: milli });

function pkg(over: Partial<CreditPackage> = {}): CreditPackage {
  return {
    id: 'pcpk_1',
    tier_id: 'pct_a',
    code: 'H24',
    name: tri('24 hours'),
    kind: 'standard',
    seconds: 86_400,
    price_iqd: 36_000,
    min_quantity: 1,
    max_quantity: 3,
    max_per_customer: null,
    expires_after_days: null,
    bundle: [],
    valid_from: null,
    valid_until: null,
    sort: 0,
    ...over,
  };
}

const materialLine = (over: Partial<R.NewCartLine> = {}): R.NewCartLine => ({
  kind: 'material',
  ref: 'pcv_1',
  quantity: 500,
  fulfillment: 'inventory',
  rule: { min: 50, step: 50, max: 5000 },
  label: { name: tri('PLA Basic'), detail: tri('Cold White'), unit: 'g', color: '#F4F4F2', seconds: null },
  ...over,
});

// ============================================================ quantities

test('a variant’s own min / step / max is the picker’s rule, and its bounds are the first and last multiples of the step', () => {
  const rule = R.variantRule(variant());
  assert.deepEqual(rule, { min: 50, step: 50, max: 5000 });
  assert.equal(R.firstQuantity(rule), 50);
  assert.equal(R.lastQuantity(rule), 5000);
  // A minimum that is not a multiple of the step: the first quantity the server takes is the next multiple.
  assert.equal(R.firstQuantity({ min: 30, step: 50, max: 1000 }), 50);
  assert.equal(R.firstQuantity({ min: 120, step: 50, max: 1000 }), 150);
  // A maximum that is not a multiple: the last one under it.
  assert.equal(R.lastQuantity({ min: 50, step: 50, max: 1030 }), 1000);
  // No multiple of the step in the range: nothing can be bought.
  assert.equal(R.firstQuantity({ min: 60, step: 50, max: 90 }), null);
  assert.equal(R.lastQuantity({ min: 60, step: 50, max: 90 }), null);
  assert.equal(R.firstQuantity({ min: 1, step: 1, max: 0 }), null);
  // Defensive reads of a row: a missing or zero step is one unit, a missing minimum is one.
  assert.deepEqual(R.variantRule(variant({ purchase_step_qty: 0, min_purchase_qty: Number.NaN })), { min: 1, step: 1, max: 5000 });
  assert.deepEqual(R.packageRule(pkg({ min_quantity: 1, max_quantity: 3 })), { min: 1, step: 1, max: 3 });
});

test('the picker’s test of a quantity is the server’s own (pricing.ts), figure for figure', () => {
  // The server's refusal, as worker/lib/printCloud/pricing.ts writes it — held here so the two cannot drift.
  assert.ok(
    read('worker/lib/printCloud/pricing.ts').includes('if (qty < Number(v.min_purchase_qty) || qty > Number(v.max_purchase_qty) || qty % Number(v.purchase_step_qty) !== 0) {'),
    'pricing.ts changed its quantity rule: change rules.ts `isValidQuantity` with it'
  );
  const server = (q: number, r: R.QuantityRule) => !(q < r.min || q > r.max || q % r.step !== 0);
  for (const r of [
    { min: 50, step: 50, max: 5000 },
    { min: 30, step: 50, max: 1030 },
    { min: 1, step: 1, max: 20 },
    { min: 100, step: 25, max: 260 },
  ]) {
    for (let q = 0; q <= r.max + 120; q++) assert.equal(R.isValidQuantity(q, r), server(q, r), `${q} under ${JSON.stringify(r)}`);
  }
  for (const bad of [Number.NaN, 2.5, Number.POSITIVE_INFINITY, -50]) assert.equal(R.isValidQuantity(bad, { min: 1, step: 1, max: 100 }), false, String(bad));
});

test('a typed figure snaps to the nearest accepted quantity; the steppers move one step and stop at the ends', () => {
  const rule = { min: 50, step: 50, max: 1000 };
  assert.equal(R.snapQuantity(275, rule), 300, 'nearest multiple');
  assert.equal(R.snapQuantity(260, rule), 250);
  assert.equal(R.snapQuantity(10, rule), 50, 'below the range: the first');
  assert.equal(R.snapQuantity(99_999, rule), 1000, 'above it: the last');
  assert.equal(R.snapQuantity(Number.NaN, rule), 50, 'not a figure: the first');
  assert.equal(R.snapQuantity(100, { min: 60, step: 50, max: 90 }), null, 'nothing accepted: nothing');
  assert.equal(R.stepQuantity(500, rule, 1), 550);
  assert.equal(R.stepQuantity(500, rule, -1), 450);
  assert.equal(R.stepQuantity(1000, rule, 1), 1000, 'never past the last');
  assert.equal(R.stepQuantity(50, rule, -1), 50, 'never under the first');
  assert.equal(R.stepQuantity(275, rule, 1), 350, 'an off-step figure snaps first, then steps');
  for (let q = 0; q <= 1100; q += 7) {
    const s = R.snapQuantity(q, rule);
    assert.ok(s !== null && R.isValidQuantity(s, rule), `${q} snapped to ${s}`);
  }
});

test('a moved figure is explained by its real reason: under the least, over the most, or between two steps', () => {
  const rule = { min: 100, step: 100, max: 5000 };
  assert.equal(R.moveReason(10, rule), 'least');
  assert.equal(R.moveReason(99_999, rule), 'most');
  assert.equal(R.moveReason(650, rule), 'step');
  assert.equal(R.moveReason(40, { min: 30, step: 50, max: 1000 }), 'least', 'over the minimum but under the first accepted figure (50)');
  assert.equal(R.moveReason(990, R.withStock(rule, 730)), 'most', 'the shelf is the most');
  // The picker words each reason with its own sentence, and a link's ?qty= is explained the same way.
  const parts = read('src/cloud/pages/store/parts.tsx');
  for (const words of ['goods.raisedToLeast', 'goods.loweredToMost', 'goods.snapped']) assert.ok(parts.includes(words), words);
  assert.match(read('src/cloud/pages/store/ProductPage.tsx'), /<QuantityPicker [^>]*asked=\{asked\}/);
});

test('the shelf caps the picker: never more than the workshop can sell, and an empty shelf sells nothing', () => {
  const rule = R.variantRule(variant());
  assert.equal(R.lastQuantity(R.withStock(rule, 730)), 700);
  assert.equal(R.firstQuantity(R.withStock(rule, 40)), null, 'less than one step on the shelf');
  assert.equal(R.firstQuantity(R.withStock(rule, 0)), null);
  assert.deepEqual(R.withStock(rule, null), rule, 'no figure: the variant’s own rule');
  assert.equal(R.groupPurchasable({ variants: [variant({ sellable_qty: 0 }), variant({ id: 'pcv_2', sellable_qty: 100 })] }), true);
  assert.equal(R.groupPurchasable({ variants: [variant({ sellable_qty: 30 })] }), false);
});

test('pack sizes are the quick choices the rule accepts; a card shows the cheapest pack at its own stated price', () => {
  const tiers = [pack(1000, 24_250), pack(250, 7_000), pack(100, 3_250), pack(250, 7_000), pack(30, 1_000), bracket(500, 29_000), pack(6000, 120_000)];
  assert.deepEqual(R.packSizes(tiers, R.variantRule(variant())), [100, 250, 1000], 'invalid (30 g, 6 kg) and repeated packs left out, sorted');
  const one = R.cheapestPack([variant({ price_tiers: [pack(1000, 24_250), pack(250, 7_000)] })]);
  assert.deepEqual(one, { qty: 250, price: 7_000, unit: 'g', from: true });
  assert.deepEqual(R.cheapestPack([variant({ price_tiers: [pack(1000, 24_250)] })]), { qty: 1000, price: 24_250, unit: 'g', from: false });
  assert.equal(R.cheapestPack([variant({ price_tiers: [bracket(1, 30_000)] })]), null, 'priced only by quantity: no figure on the card');
  assert.equal(R.cheapestPack([variant({ price_tiers: [pack(30, 1_000)] })]), null, 'a pack the rule refuses is not offered');
  assert.equal(R.cheapestPack([variant({ price_tiers: [pack(1000, null)] })]), null, 'a pack with no price is no price');
});

test('a price per hour is derived only from the package’s own price and seconds, rounded up', () => {
  assert.equal(R.perHourIqd({ price_iqd: 36_000, seconds: 86_400 }), 1_500);
  assert.equal(R.perHourIqd({ price_iqd: 1_000, seconds: 7_000 }), 515, '514.28… is never shown as 514');
  assert.equal(R.perHourIqd({ price_iqd: 1_000, seconds: 0 }), null);
  assert.equal(R.perHourIqd({ price_iqd: Number.NaN, seconds: 3_600 }), null);
});

// ============================================================ the cart

test('a cart belongs to one identity: another account, or nobody, starts empty', () => {
  const mine = R.addToCart({ owner: null, lines: [] }, 'u1', materialLine()).state;
  assert.equal(mine.owner, 'u1');
  assert.equal(mine.lines.length, 1);
  assert.equal(R.cartFor(mine, 'u1'), mine, 'the owner sees the same cart');
  assert.deepEqual(R.cartFor(mine, 'u2'), { owner: 'u2', lines: [] }, 'another account never sees a line');
  assert.deepEqual(R.cartFor(mine, null), { owner: null, lines: [] }, 'signed out: no cart');
  // A write under the new identity drops the old lines for good.
  const theirs = R.addToCart(mine, 'u2', materialLine({ ref: 'pcv_9' })).state;
  assert.deepEqual(theirs.lines.map((l) => l.ref), ['pcv_9']);
  assert.deepEqual(R.cartFor(theirs, 'u1').lines, [], 'and the first account does not get its lines back');
  for (const op of [
    () => R.setCartQuantity(mine, 'u2', mine.lines[0].key, 100),
    () => R.removeFromCart(mine, 'u2', []),
    () => R.restoreCartLine(mine, 'u2', mine.lines[0], 0),
  ]) {
    assert.deepEqual(op().lines.filter((l) => l.ref === 'pcv_1'), [], 'no operation carries a line across identities');
  }
  // Nobody signed in has no cart at all.
  assert.deepEqual(R.addToCart({ owner: null, lines: [] }, null, materialLine()), { state: { owner: null, lines: [] }, outcome: 'signed_out' });
});

test('adding: one line per thing and destination, merged within the rule; refused quantities and a full cart add nothing', () => {
  let s: R.CartState = { owner: 'u1', lines: [] };
  let r = R.addToCart(s, 'u1', materialLine({ quantity: 500 }));
  assert.equal(r.outcome, 'added');
  s = r.state;
  r = R.addToCart(s, 'u1', materialLine({ quantity: 250 }));
  assert.equal(r.outcome, 'merged');
  assert.equal(r.state.lines.length, 1);
  assert.equal(r.state.lines[0].quantity, 750);
  r = R.addToCart(r.state, 'u1', materialLine({ quantity: 5000 }));
  assert.equal(r.state.lines[0].quantity, 5000, 'merged quantity is capped at the last accepted one');
  r = R.addToCart(r.state, 'u1', materialLine({ fulfillment: 'delivery', quantity: 100 }));
  assert.equal(r.outcome, 'added', 'the same filament for delivery is its own line');
  assert.deepEqual(r.state.lines.map((l) => l.key), ['material:pcv_1:inventory', 'material:pcv_1:delivery']);
  for (const quantity of [75, 0, 6000, Number.NaN]) {
    assert.equal(R.addToCart(r.state, 'u1', materialLine({ ref: 'pcv_2', quantity })).outcome, 'invalid', String(quantity));
  }
  let full: R.CartState = { owner: 'u1', lines: [] };
  for (let i = 0; i < R.CART_MAX_LINES; i++) full = R.addToCart(full, 'u1', materialLine({ ref: `pcv_${i}` })).state;
  assert.equal(full.lines.length, 25);
  assert.equal(R.addToCart(full, 'u1', materialLine({ ref: 'pcv_new' })).outcome, 'full');
  assert.equal(R.addToCart(full, 'u1', materialLine({ ref: 'pcv_3', quantity: 50 })).outcome, 'merged', 'a full cart still merges into a line it has');
  // The limit is the quote's own (pricing.ts `parseQuoteLines`).
  assert.ok(read('worker/lib/printCloud/pricing.ts').includes("if (raw.length > 25) throw invalid('lines', 'too_many');"));
  assert.equal(R.CART_MAX_LINES, 25);
});

test('changing, removing and restoring a line; the quote is asked for exactly the cart’s lines, in order', () => {
  let s = R.addToCart({ owner: 'u1', lines: [] }, 'u1', materialLine()).state;
  s = R.addToCart(s, 'u1', { kind: 'package', ref: 'pcpk_1', quantity: 1, fulfillment: 'credits', rule: { min: 1, step: 1, max: 3 }, label: { name: tri('24 h'), detail: null, unit: null, color: null, seconds: 86_400 } }).state;
  s = R.addToCart(s, 'u1', materialLine({ ref: 'pcv_2', fulfillment: 'delivery', quantity: 100 })).state;
  s = R.setCartQuantity(s, 'u1', 'material:pcv_1:inventory', 333);
  assert.equal(s.lines[0].quantity, 350, 'a changed quantity is snapped to the rule');
  assert.deepEqual(R.quoteLinesOf(s.lines), [
    { kind: 'material', variant_id: 'pcv_1', quantity: 350, fulfillment: 'inventory' },
    { kind: 'credit_package', package_id: 'pcpk_1', quantity: 1 },
    { kind: 'material', variant_id: 'pcv_2', quantity: 100, fulfillment: 'delivery' },
  ]);
  const removed = s.lines[1];
  const without = R.removeFromCart(s, 'u1', [removed.key]);
  assert.deepEqual(without.lines.map((l) => l.ref), ['pcv_1', 'pcv_2']);
  assert.deepEqual(R.restoreCartLine(without, 'u1', removed, 1).lines.map((l) => l.ref), ['pcv_1', 'pcpk_1', 'pcv_2'], 'undo puts it back where it was');
  assert.equal(R.restoreCartLine(s, 'u1', removed, 1), s, 'a line the cart still has is not added twice');
  // What a cart line keeps is never a price: prices are asked again every time.
  const cartTypes = read('src/cloud/pages/store/rules.ts').slice(read('src/cloud/pages/store/rules.ts').indexOf('export interface CartLabel'), read('src/cloud/pages/store/rules.ts').indexOf('export type NewCartLine'));
  assert.ok(cartTypes.length > 200, 'the cart line types were not found');
  assert.doesNotMatch(code(cartTypes), /price|_iqd|amount|total/i, 'a cart line carries no price');
});

// ============================================================ quotes and holds

test('a quote is open only before its server time, and only while the server calls it open', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const at = (s: number) => new Date(now + s * 1000).toISOString();
  assert.deepEqual(R.quoteState({ status: 'open', expires_at: at(300) }, now), { kind: 'open', msLeft: 300_000 });
  assert.deepEqual(R.quoteState({ expires_at: at(1) }, now), { kind: 'open', msLeft: 1000 }, 'POST /quotes carries no status: an open quote');
  assert.deepEqual(R.quoteState({ status: 'open', expires_at: at(0) }, now), { kind: 'expired' }, 'at its expiry it is expired');
  assert.deepEqual(R.quoteState({ status: 'open', expires_at: at(-60) }, now), { kind: 'expired' }, 'past it, even while the row still says open');
  assert.deepEqual(R.quoteState({ status: 'expired', expires_at: at(600) }, now), { kind: 'expired' });
  assert.deepEqual(R.quoteState({ status: 'ordered', expires_at: at(600) }, now), { kind: 'ordered' });
  assert.deepEqual(R.quoteState({ status: 'something-new', expires_at: at(600) }, now), { kind: 'expired' }, 'a status the screen does not know is not open');
  assert.deepEqual(R.quoteState({ status: 'open', expires_at: 'not a date' }, now), { kind: 'expired' }, 'an unreadable time is never open');
  assert.deepEqual(R.deadline(null, now), { passed: true, msLeft: 0 });
  assert.deepEqual(R.deadline(at(90), now), { passed: false, msLeft: 90_000 });
  // The checkout counts down to `expires_at` and re-reads the state every second.
  const page = code(read('src/cloud/pages/store/CheckoutPage.tsx'));
  assert.match(page, /const state = quoteState\(q, now\);/);
  assert.match(page, /const now = useNow\(\);/);
});

test('the clock floors, never runs negative, and switches to the date past a day', () => {
  assert.equal(R.clockText(0), '0:00');
  assert.equal(R.clockText(59_999), '0:59', 'never a second more than is left');
  assert.equal(R.clockText(61_000), '1:01');
  assert.equal(R.clockText(29 * 60_000 + 5_000), '29:05');
  assert.equal(R.clockText(3_600_000), '1:00:00');
  assert.equal(R.clockText(-5_000), '0:00');
  assert.equal(R.clockText(Number.NaN), '0:00');
  assert.equal(R.CLOCK_LIMIT_MS, 86_400_000);
});

test('a stale quote is asked again for the same lines; an order is payable only before its stock hold runs out', () => {
  const line = (over: Partial<PricedLine>): PricedLine =>
    ({ line_no: 1, kind: 'material', tier_id: null, package_id: null, variant_id: null, category_code: null, quantity: 1, seconds: 0, base_price_iqd: 1, discount_iqd: 0, final_price_iqd: 1, fulfillment: 'inventory', project_id: null, expires_after_days: null, bundle: [], breakdown: {}, stock: null, ...over }) as PricedLine;
  assert.deepEqual(
    R.quoteInputsOf([
      line({ kind: 'credit_package', package_id: 'pcpk_1', quantity: 2, seconds: 172_800, fulfillment: 'credits' }),
      line({ kind: 'credit_hours', tier_id: 'pct_a', seconds: 7_200, fulfillment: 'credits' }),
      line({ kind: 'material', variant_id: 'pcv_1', quantity: 650, fulfillment: 'inventory' }),
      line({ kind: 'material', variant_id: 'pcv_2', quantity: 100, fulfillment: 'delivery' }),
      line({ kind: 'material', variant_id: 'pcv_3', quantity: 4, fulfillment: 'project', project_id: 'pcpr_1' }),
    ]),
    [
      { kind: 'credit_package', package_id: 'pcpk_1', quantity: 2 },
      { kind: 'credit_hours', tier_id: 'pct_a', seconds: 7_200 },
      { kind: 'material', variant_id: 'pcv_1', quantity: 650, fulfillment: 'inventory' },
      { kind: 'material', variant_id: 'pcv_2', quantity: 100, fulfillment: 'delivery' },
      { kind: 'material', variant_id: 'pcv_3', quantity: 4, fulfillment: 'project', project_id: 'pcpr_1' },
    ]
  );
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const hold = (s: number) => new Date(now + s * 1000).toISOString();
  assert.equal(R.orderPayable({ status: 'awaiting_payment', stock_hold_expires_at: hold(60) }, now), true);
  assert.equal(R.orderPayable({ status: 'awaiting_payment', stock_hold_expires_at: hold(-1) }, now), false, 'past its own deadline (wallet.ts walletPayability)');
  for (const status of ['fulfilled', 'cancelled', 'expired', 'refunded', 'partially_refunded']) {
    assert.equal(R.orderPayable({ status, stock_hold_expires_at: hold(60) }, now), false, status);
    assert.equal(R.orderCancellable({ status }), false, status);
  }
  assert.equal(R.orderCancellable({ status: 'awaiting_payment' }), true);
});

// ============================================================ payment

test('a refused wallet payment is read from its code and details, never from its wording', () => {
  const refusal = (status: number, code: string, details: Record<string, unknown> = {}) =>
    new ApiError(status, 'words that change', code, { ...details, messages: { ar: 'ع', en: 'e', ckb: 'ک' } });
  assert.deepEqual(R.payRefusal(refusal(402, 'INSUFFICIENT_BALANCE', { available_iqd: 12_000, required_iqd: 60_250 })), { kind: 'insufficient', available: 12_000, required: 60_250 });
  assert.deepEqual(R.payRefusal(refusal(402, 'INSUFFICIENT_BALANCE')), { kind: 'insufficient', available: null, required: null }, 'figures it did not send are not invented');
  for (const [reason, kind] of [
    ['already_paid', 'already_paid'],
    ['cancelled', 'cancelled'],
    ['expired', 'expired'],
    ['shipment_not_awaiting_payment', 'shipment'],
    ['refunded', 'other'],
    [undefined, 'other'],
  ] as const) {
    assert.deepEqual(R.payRefusal(refusal(409, 'ORDER_NOT_PAYABLE', reason ? { reason } : {})), { kind: 'not_payable', reason: kind }, String(reason));
  }
  assert.deepEqual(R.payRefusal(refusal(503, 'PAYMENT_ADAPTER_DISABLED', { provider: 'levonis_wallet' })), { kind: 'wallet_off' });
  assert.deepEqual(R.payRefusal(refusal(409, 'STATE_CHANGED')), { kind: 'other' });
  assert.deepEqual(R.payRefusal(new Error('network')), { kind: 'other' });
  assert.equal(R.refusedLine(refusal(400, 'QUANTITY_NOT_ALLOWED', { line_no: 3 })), 3);
  assert.equal(R.refusedLine(refusal(400, 'VALIDATION', { field: 'lines' })), null);
  assert.equal(R.couponRefused(refusal(400, 'VALIDATION', { field: 'coupon', reason: 'not_valid' })), true);
  assert.equal(R.couponRefused(refusal(400, 'VALIDATION', { field: 'lines[0].quantity' })), false);
  // The reasons are the server's (worker/lib/printCloud/wallet.ts `walletPayability`).
  const wallet = read('worker/lib/printCloud/wallet.ts');
  for (const reason of ["reason: 'expired'", "reason: 'shipment_not_awaiting_payment'", "'already_paid'"]) assert.ok(wallet.includes(reason), reason);
  assert.ok(wallet.includes("pcError('INSUFFICIENT_BALANCE', { available_iqd: availableIqd, required_iqd: requiredIqd })"));
});

/** The values a CHECK constraint of migrations/0215_print_cloud.sql allows for `column` of `table`. */
function checkValues(table: string, column: string): string[] {
  const sql = read('migrations/0215_print_cloud.sql');
  const start = sql.search(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(`));
  assert.ok(start >= 0, table);
  const body = sql.slice(start, sql.indexOf(');', start));
  const m = new RegExp(`\\b${column}\\b[^,]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`, 's').exec(body);
  assert.ok(m, `${table}.${column}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

test('every order state, payment method and payment state the database allows has its words, in three languages, and its tone', () => {
  const statuses = checkValues('pc_orders', 'status');
  assert.deepEqual([...R.ORDER_STATUSES].sort(), statuses);
  assert.deepEqual(Object.keys(W.orderStatus).sort(), statuses);
  assert.deepEqual(Object.keys(R.ORDER_TONE).sort(), statuses);
  assert.equal(R.orderTone('awaiting_payment'), 'warning');
  assert.equal(R.orderTone('fulfilled'), 'success');
  assert.equal(R.orderTone('a state from a newer server'), 'neutral');
  const methods = checkValues('pc_orders', 'payment_method');
  assert.deepEqual(Object.keys(W.paymentMethod).sort(), methods);
  assert.deepEqual([...R.PAYMENT_PROVIDERS].sort(), methods);
  assert.deepEqual(checkValues('pc_payments', 'provider'), methods);
  assert.deepEqual(Object.keys(W.paymentState).sort(), checkValues('pc_payments', 'status'));
  for (const group of [W.orderStatus, W.paymentMethod, W.paymentState]) {
    for (const [key, words] of Object.entries(group)) for (const lang of LANGS) assert.ok(words[lang].trim(), `${key} ${lang}`);
  }
  // The wallet keeps the brand in Latin letters in every language.
  for (const lang of LANGS) assert.match(tx(W.paymentMethod.levonis_wallet, lang), /Levonis/);
});

// ============================================================ words

/** Every `{ ar, en, ckb }` reachable from the module's exports, with its path. */
function tris(value: unknown, path: string, out: Array<{ path: string; tri: Record<string, string> }> = []) {
  if (!value || typeof value !== 'object') return out;
  const o = value as Record<string, unknown>;
  if ('ar' in o && 'en' in o && 'ckb' in o) out.push({ path, tri: o as Record<string, string> });
  else for (const [k, v] of Object.entries(o)) tris(v, `${path}.${k}`, out);
  return out;
}
const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
/** Letters Sorani writes and Arabic does not. */
const SORANI_LETTERS = /[ەێۆڕڵڤگچپژ]/;

test('every store word is written in Arabic, English and Sorani; Sorani is never the Arabic; the slots agree', () => {
  const all = tris(W, 'store');
  assert.ok(all.length > 180, `only ${all.length} strings`);
  for (const { path, tri } of all) {
    for (const lang of LANGS) assert.ok(typeof tri[lang] === 'string' && tri[lang].trim(), `${path}: empty ${lang}`);
    assert.notEqual(tri.ckb, tri.ar, `${path}: the Sorani is a copy of the Arabic (DECISIONS row 183)`);
    assert.notEqual(tri.en, tri.ar, `${path}: the English is a copy of the Arabic`);
    assert.equal(slots(tri.ar), slots(tri.en), `${path}: the Arabic fills other {slots}`);
    assert.equal(slots(tri.ckb), slots(tri.en), `${path}: the Sorani fills other {slots}`);
    // A Sorani sentence is written in Sorani: three words or more carry its own letters.
    if (tri.ckb.trim().split(/\s+/).length >= 3) assert.match(tri.ckb, SORANI_LETTERS, `${path}: «${tri.ckb}» reads as Arabic, not Sorani`);
    for (const lang of LANGS) {
      assert.doesNotMatch(tri[lang], /علاوة/, `${path}: the forbidden word`);
      assert.doesNotMatch(tri[lang], /ليفونيس|ليفونس|لیڤۆنیس|لێڤۆنیس|ليڤۆنیس|ليڤونيس|لیفونیس/, `${path}: «Levonis» is written in Latin letters`);
      // No figure of money or time is typed into a word: those are the server's, filled in.
      assert.doesNotMatch(tri[lang], /\d[\d,.]*\s*(?:IQD|د\.ع|دينار|دینار)/, `${path}: a price in the words`);
    }
  }
});

// ============================================================ the source

test('the order screens are behind the sign-in; the catalogue and a product are public; the section ends in the 404', () => {
  const routes = code(read('src/cloud/pages/store/StoreRoutes.tsx'));
  for (const [path, page] of [
    ['/store/cart', 'CartPage'],
    ['/store/checkout/:quoteId', 'CheckoutPage'],
    ['/orders', 'OrdersPage'],
    ['/orders/:orderId', 'OrderPage'],
  ]) {
    assert.match(routes, new RegExp(`path="${path.replace(/[/:]/g, (c) => `\\${c}`)}"\\s*element=\\{\\s*<RequireSignIn>\\s*<${page} />\\s*</RequireSignIn>\\s*\\}`), `${path} needs an account`);
  }
  assert.match(routes, /<Route path="\/store" element=\{<Catalogue \/>\} \/>/);
  assert.match(routes, /<Route path="\/store\/product\/:productId" element=\{<ProductPage \/>\} \/>/);
  assert.match(routes, /<Route path="\*" element=\{<CloudNotFound \/>\} \/>\s*<\/Routes>/);
  assert.match(routes, /^export default function StoreRoutes\(\)/m);
  // A change of identity empties the cart before any screen of the section reads it.
  assert.match(routes, /useEffect\(\(\) => adoptCartOwner\(owner\), \[owner\]\);/);
});

test('the cart lives in memory and is read through its owner — nothing of a purchase is kept in the browser', () => {
  for (const rel of STORE_FILES) assert.doesNotMatch(code(read(rel)), /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/, `${rel} keeps something in the browser`);
  const cart = code(read('src/cloud/pages/store/cart.ts'));
  assert.match(cart, /let state: CartState = \{ owner: null, lines: \[\] \};/);
  assert.match(cart, /const lines = snapshot\.owner === owner \? snapshot\.lines : NONE;/, 'never another identity’s lines, even before the owner is adopted');
  assert.match(cart, /const owner = user\?\.id \?\? null;/);
  for (const op of ['addToCart(state, owner,', 'setCartQuantity(state, owner,', 'removeFromCart(state, owner,', 'restoreCartLine(state, owner,']) assert.ok(cart.includes(op), op);
  // A change made under one identity and run after another took over (a stale «undo» toast) touches nothing.
  assert.equal((cart.match(/if \(state\.owner === owner\) publish\(/g) ?? []).length, 3, 'set, remove and restore are guarded');
});

test('money doors: one Idempotency-Key per intent, a confirmation first, the wallet’s shortfall links to adding funds on Levonis', () => {
  const checkout = code(read('src/cloud/pages/store/CheckoutPage.tsx'));
  assert.match(checkout, /const intent = useIdempotencyKey\('order'\);/);
  assert.match(checkout, /useEffect\(\(\) => renew\(\), \[bodyKey, renew\]\);/, 'a new key only for a new body (the server refuses one key for two)');
  assert.match(checkout, /await createOrder\(body, intent\.key\)/);
  assert.match(checkout, /<ConfirmDialog\s+open=\{open\}\s+title=\{t\(words\.confirmTitle\)\}/);
  assert.match(checkout, /type Method = 'levonis_wallet' \| 'manual';/, 'an order is placed for the wallet or the workshop, never the development door');

  const order = code(read('src/cloud/pages/store/OrderPage.tsx'));
  assert.match(order, /const intent = useIdempotencyKey\('pay'\);/);
  assert.match(order, /await payOrderFromWallet\(order\.id, intent\.key\);\s*intent\.renew\(\);/, 'the same key on every retry, a new one after success');
  assert.match(order, /cloud\.refreshDashboard\(\);/, 'a paid order refreshes every balance on screen');
  assert.match(order, /title=\{t\(words\.payConfirmTitle, \{ total \}\)\}/);
  assert.match(order, /destructive\s+title=\{t\(words\.cancelTitle\)\}/, 'cancelling is confirmed, drawn destructive');
  assert.match(order, /if \(r\.kind === 'insufficient'\) \{[\s\S]{0,700}href=\{`\$\{mainSite\}\/wallet`\}/, 'INSUFFICIENT_BALANCE → add funds on the main site');
  assert.ok((order.match(/\$\{cloud\.mainSite\}\/wallet|\$\{mainSite\}\/wallet/g) ?? []).length >= 2, 'the shortfall is linked before paying too');
  assert.match(checkout, /href=\{`\$\{mainSite\}\/wallet`\}/);
});

test('the development payment door is never called from Print Cloud', () => {
  for (const rel of CLOUD_FILES) {
    const src = code(read(rel));
    if (rel === 'src/cloud/api.ts') {
      // Declared (the client covers every door of the API, tests/printCloudUiShell.test.ts), and never called — not even here.
      assert.equal((src.match(/\bdevPayOrder\b/g) ?? []).length, 1, 'api.ts only declares devPayOrder');
      assert.match(src, /export const devPayOrder = /);
      continue;
    }
    assert.doesNotMatch(src, /\bdevPayOrder\b|\/dev-pay\b/, `${rel} reaches for the development payment door`);
    // The answer type may name the server's development instruction; no screen acts on it.
    if (rel !== 'src/cloud/types.ts') assert.doesNotMatch(src, /dev_confirm/, `${rel} acts on the development payment instruction`);
    assert.doesNotMatch(src, /payment_method:\s*'dev'|['"]dev['"]\s+as\s+PaymentProvider/, `${rel} places an order for the development door`);
  }
});

/** Is this node a figure written in the source (a number, or a minus before one)? */
const literalFigure = (n: ts.Expression): boolean =>
  ts.isNumericLiteral(n) || (ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand)) || (ts.isParenthesizedExpression(n) && literalFigure(n.expression));

test('no price is typed into the store, and none is worked out on the client', () => {
  const MONEY_PROPERTY = /(?:_iqd|^price|^amount|^total|^subtotal|^discount)$/i;
  const arithmetic: string[] = [];
  for (const rel of [...STORE_FILES, 'src/cloud/strings/store.ts']) {
    const source = parse(rel);
    const visit = (n: ts.Node) => {
      // <Money iqd={…} /> never draws a figure the source wrote.
      if (ts.isJsxAttribute(n) && n.name.getText(source) === 'iqd' && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression) {
        assert.ok(!literalFigure(n.initializer.expression), `${lineOf(source, n)}: a price typed into <Money>`);
      }
      // formatIqd(…) / formatMoney(…) never format a figure the source wrote.
      if (ts.isCallExpression(n) && /^(?:formatIqd|formatMoney|formatSignedMoney)$/.test(n.expression.getText(source)) && n.arguments[0]) {
        assert.ok(!literalFigure(n.arguments[0]), `${lineOf(source, n)}: a price typed into ${n.expression.getText(source)}`);
      }
      // No object of the store carries a money field with a written figure.
      if (ts.isPropertyAssignment(n) && MONEY_PROPERTY.test(n.name.getText(source).replace(/['"]/g, '')) && literalFigure(n.initializer)) {
        assert.fail(`${lineOf(source, n)}: «${n.getText(source)}» writes a price into the source`);
      }
      // Arithmetic on a money figure is a price worked out on the client.
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(n.operatorToken.kind)) {
        if (/_iqd\b/.test(n.left.getText(source)) || /_iqd\b/.test(n.right.getText(source))) {
          let fn: ts.Node | undefined = n.parent;
          while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
          arithmetic.push(`${rel}#${fn && ts.isFunctionDeclaration(fn) ? fn.name?.getText(source) : '?'}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  // The one derivation the brief allows: a package's price per hour, from its own price and seconds, labelled «≈».
  assert.deepEqual([...new Set(arithmetic)], ['src/cloud/pages/store/rules.ts#perHourIqd']);
  assert.match(code(read('src/cloud/pages/store/Catalogue.tsx')), /t\(hours\.perHour, \{ price: formatIqd\(rate, lang\) \}\)/);
  for (const lang of LANGS) assert.match(W.hours.perHour[lang], /^≈ /, 'the derived figure says it is approximate');
  // A quantity is priced by the server (POST /pricing/quote) once it settles; the cart, by the same door.
  assert.match(code(read('src/cloud/pages/store/ProductPage.tsx')), /priceQuote\(\{ lines: \[\{ kind: 'material', variant_id: variant\.id, quantity: settledQty, fulfillment: mode \}\] \}, \{ signal \}\)/);
  assert.match(code(read('src/cloud/pages/store/CartPage.tsx')), /priceQuote\(c \? \{ lines, coupon: c \} : \{ lines \}, \{ signal \}\)/);
  // A price for another quantity than the one on screen is never shown.
  assert.match(code(read('src/cloud/pages/store/ProductPage.tsx')), /const pending = settledQty !== qty \|\| price\.loading;/);
});

test('the store finds what the customer types, in any of the three languages', () => {
  assert.equal(R.matchesQuery('', ['anything']), true);
  assert.equal(R.matchesQuery('pla white', ['PLA Basic', 'Cold White']), true);
  assert.equal(R.matchesQuery('petg', ['PLA Basic']), false);
  assert.equal(R.matchesQuery('أحمر', ['خيط احمر']), true, 'alef forms fold together');
  assert.equal(R.matchesQuery('سەوز', ['فیلامێنتی سەوز']), true);
  const g = R.groupProducts([variant(), variant({ id: 'pcv_2', name: tri('Jade Green'), color_name: 'Jade Green' }), variant({ id: 'pcv_3', product_id: 'pcp_2', product_name: tri('PETG HF') })]);
  assert.deepEqual(g.map((x) => [x.id, x.variants.length]), [['pcp_1', 2], ['pcp_2', 1]]);
  assert.equal(R.matchesQuery('jade', R.productFields(g[0])), true);
  assert.equal(R.matchesQuery('jade', R.productFields(g[1])), false);
  assert.equal(R.storeTab('materials'), 'materials');
  assert.equal(R.storeTab('nonsense'), 'hours');
  assert.equal(R.storeTab(null), 'hours');
  assert.equal(R.tabOfKind('filament'), 'materials');
  assert.equal(R.tabOfKind('tool'), 'accessories');
  assert.deepEqual(R.storeModes(variant(), false), ['inventory'], 'delivery only while it is on');
  assert.deepEqual(R.storeModes(variant(), true), ['inventory', 'delivery']);
  assert.deepEqual(R.storeModes(variant({ fulfillment_modes: ['project'] }), true), [], '«project» belongs to the print flow');
});

test('hour packages are grouped by printer class, named from the printers that use it', () => {
  const model = (id: string, tier: string, name: string) => ({ id, tier_id: tier, tier_name: tri(`Class ${tier}`), brand: 'Bambu Lab', model_name: name }) as unknown as PrinterModel;
  const groups = R.tierGroups([pkg(), pkg({ id: 'pcpk_2', seconds: 3_600 }), pkg({ id: 'pcpk_3', tier_id: 'pct_b' })], [model('m1', 'pct_a', 'X1C'), model('m2', 'pct_a', 'P1S')]);
  assert.deepEqual(
    groups.map((g) => [g.tierId, g.name?.en ?? null, g.models, g.packages.map((p) => p.id)]),
    [
      ['pct_a', 'Class pct_a', ['Bambu Lab X1C', 'Bambu Lab P1S'], ['pcpk_1', 'pcpk_2']],
      ['pct_b', null, [], ['pcpk_3']],
    ],
    'a class no active model names keeps its packages and says «printer class»'
  );
});

test('a delivery address is checked as the server checks it, and the phone is sent in ASCII digits', () => {
  const ok = { recipient_name: 'Ali', phone: '٠٧٧٠ ١٢٣ ٤٥٦٧', governorate: 'baghdad', city: 'Karrada', address_line: 'Street 1', notes: '' };
  assert.deepEqual(R.addressProblems(ok), []);
  assert.equal(R.phoneForServer(ok.phone), '0770 123 4567');
  assert.deepEqual(R.addressProblems({ ...R.EMPTY_ADDRESS }), ['recipient_name', 'phone', 'governorate', 'city', 'address_line']);
  assert.deepEqual(R.addressProblems({ ...ok, phone: '12' }), ['phone']);
  // The server's own phone rule (worker/lib/printCloud/shipments.ts).
  assert.ok(read('worker/lib/printCloud/shipments.ts').includes('if (!/^\\+?[0-9 ]{7,20}$/.test(phone))'));
});
