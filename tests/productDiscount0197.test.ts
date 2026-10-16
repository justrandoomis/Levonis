/**
 * PRODUCT DISCOUNT — MIGRATION 0197 AND THE OLDER DATABASE (docs/ux/PRODUCT-DISCOUNT.md §3, §10, §12;
 * CLAUDE.md rule 2: every new read of a new table tolerates its absence).
 *
 *   - 0197 is additive (a table and a trigger), re-runnable, and its rules hold on their own: one
 *     scope per subject, whole cents only (a REAL is refused), $0.01 … $100,000.00;
 *   - on a database at 0195 (no 0197): the card's read says `usd_supported: false`, a dollar save is
 *     409 OFFER_USD_NOT_INSTALLED, a percent sale saves, and the card, the cart and the checkout give
 *     exactly the numbers the full database gives; the presence probe sends one statement per binding;
 *   - a V1 read (no V2 results: a database before 0189, or rolled back) carries no rate, so a dollar
 *     sale prices nothing there — an honest "no sale".
 *
 * Run: npx tsx --test tests/productDiscount0197.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { all, asD1, freshDb } from './fixtures/app';
import { discountWorld, M1, M2, PID } from './fixtures/productDiscount';
// @ts-expect-error - plain ESM helper shared with the workflow, no types
import { classify } from '../scripts/check-migrations-additive.mjs';
// @ts-expect-error - plain ESM helper shared with the migration scripts, no types
import { splitStatements } from '../scripts/lib/sql-split.mjs';
import { offerUsdInstalled, offerUsdKnown } from '../worker/lib/offerUsd';
import { loadRelationsViews } from '../worker/lib/productOverlay';
import { fixedUsdAnswerFor, type OfferWindow } from '../worker/lib/offers';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { resolveUnitPrice } from '../worker/lib/pricing';

const SQL = readFileSync('migrations/0197_offer_usd_prices.sql', 'utf8');

test('0197 is additive: a table and a trigger, nothing that touches a row', () => {
  const list = (splitStatements(SQL) as string[]).map((x) => x.replace(/^(\s*--[^\n]*\n)+/g, '').trim());
  assert.equal(list.length, 2);
  for (const s of list) assert.equal(classify(s).additive, true, s.slice(0, 60));
  assert.match(list[0]!, /^CREATE TABLE IF NOT EXISTS offer_usd_prices/);
  assert.match(list[1]!, /^CREATE TRIGGER IF NOT EXISTS offer_usd_prices_one_scope/);
});

test('0197’s own rules: one scope per subject, whole cents only, the 0189 dollar ceiling', () => {
  const raw = freshDb();
  const ins = (model: string, cents: string) =>
    raw.exec(`INSERT INTO offer_usd_prices (subject_type, subject_id, model_id, price_usd_cents) VALUES ('product', 'p', '${model}', ${cents})`);
  ins('m1', '50000');
  ins('m2', '64000');
  assert.throws(() => ins('', '50000'), /OFFER_USD_SCOPE_MIXED/, 'a whole-product row beside model rows');
  raw.exec("DELETE FROM offer_usd_prices WHERE subject_id = 'p'");
  ins('', '50000');
  assert.throws(() => ins('m1', '50000'), /OFFER_USD_SCOPE_MIXED/, 'a model row beside the whole-product row');
  const other = (cents: string) =>
    raw.exec(`INSERT INTO offer_usd_prices (subject_type, subject_id, model_id, price_usd_cents) VALUES ('product', 'q${cents.replace(/\W/g, '')}', '', ${cents})`);
  assert.throws(() => other('500.5'), /CHECK/, 'a REAL is refused');
  assert.throws(() => other('0'), /CHECK/);
  assert.throws(() => other('10000001'), /CHECK/, 'above $100,000.00');
  other('10000000');
  assert.throws(() => raw.exec("INSERT INTO offer_usd_prices (subject_type, subject_id, model_id, price_usd_cents) VALUES ('order', 'q', '', 1)"), /CHECK/);
  // Re-running the file changes nothing (the harness's --twice, here in miniature).
  raw.exec(SQL);
  assert.equal(all(raw, "SELECT * FROM offer_usd_prices WHERE subject_id = 'p'").length, 1);
});

test('a database at 0195: no dollars (409), percent works, and the customer numbers are today’s', async () => {
  const old = await discountWorld({ through: '0195', costFirst: false });
  const read = await old.readOffer(old.owner);
  assert.equal(read.status, 200);
  assert.equal(read.body.discount.usd_supported, false);
  assert.deepEqual(read.body.discount.usd, { available: false, reason: 'NOT_INSTALLED', scopes: [] });
  assert.equal(read.body.discount.published, true, 'the before prices are still read');
  const dollars = await old.saveOffer(old.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: M1, usd: '500' }] });
  assert.equal(dollars.status, 409);
  assert.equal(dollars.body.code, 'OFFER_USD_NOT_INSTALLED');
  const percent = await old.saveOffer(old.owner, { offer_price_mode: 'discount_percent', discount_percent: 10 });
  assert.equal(percent.status, 200, JSON.stringify(percent.body));
  assert.deepEqual(percent.body.offer.offer_usd_prices, []);
  const list = await old.call(old.owner, 'GET', '/api/admin/offers');
  assert.equal(list.status, 200, 'the list reads without the dollar join');

  // The same sale on a full database: the customer numbers are identical.
  const full = await discountWorld({ costFirst: false });
  assert.equal((await full.saveOffer(full.owner, { offer_price_mode: 'discount_percent', discount_percent: 10 })).status, 200);
  const numbers = async (w: typeof old) => {
    const cards = (await w.call(w.guest, 'GET', '/api/products?limit=50')).body.products as Array<Record<string, unknown>>;
    const c = cards.find((p) => p.id === PID)!;
    await w.addToCart({ productId: PID, optionId: M2, optionValueIds: [M2], qty: 1, fulfillmentType: 'direct_sale' });
    const cart = (await w.cart()).body.items[0];
    const door = (await w.quote('cash')).body.quote.lines[0];
    return [c.display_price_iqd, c.display_offer_before_iqd, c.display_offer_saving_percent, cart.unit_price_iqd, cart.breakdown.offer_before_iqd, door.unit_price_iqd, door.offer_before_iqd];
  };
  const a = await numbers(old);
  const b = await numbers(full);
  assert.deepEqual(a, b);
  // The card's figure is the cheapest way to buy (the land route of P1S, 825,000 → 742,500); the Combo line 1,125,000 → 1,012,500.
  assert.deepEqual(a, [742_500, 825_000, 10, 1_012_500, 1_125_000, 1_012_500, 1_125_000]);
  const order = await old.placeOrder();
  assert.equal(order.status, 200, 'the checkout sells on the older database');
  // A product deletion skips the absent table (worker/lib/productDeletion.ts tableExists).
  assert.equal(all(old.raw, "SELECT name FROM sqlite_master WHERE name = 'offer_usd_prices'").length, 0);
});

test('the presence probe: one statement per binding while unknown, none once known', async () => {
  let sent = 0;
  const counting = (db: D1Database): D1Database =>
    new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'prepare') return (sql: string) => ((/offer_usd_prices/.test(sql) && sent++), target.prepare(sql));
        return Reflect.get(target, prop, recv);
      },
    });
  const old = counting(asD1((await import('./fixtures/app')).dbThrough('0195')));
  assert.equal(offerUsdKnown(old), null);
  assert.equal(await offerUsdInstalled(old), false);
  assert.equal(await offerUsdInstalled(old), false);
  assert.equal(sent, 1, 'absent: asked once, then remembered for a minute');
  assert.equal(offerUsdKnown(old), false);
  sent = 0;
  const now = counting(asD1(freshDb()));
  assert.equal(await offerUsdInstalled(now), true);
  assert.equal(await offerUsdInstalled(now), true);
  assert.equal(sent, 1, 'present: asked once, never again');
});

test('a V1 read carries no rate: a dollar sale prices nothing there', async () => {
  const w = await discountWorld({ costFirst: false });
  const window: OfferWindow = {
    id: 'w', starts_at: null, ends_at: null, required_tiers: [], offer_price_mode: 'fixed_usd', offer_price_iqd: null, discount_percent: null,
    discount_iqd: null, plus_price_iqd: null, locked_preview: true, active: true, usd_prices: [{ model_id: M1, cents: 50_000 }, { model_id: M2, cents: 64_000 }],
  };
  // With the V2 results: the row carries its rate, the sale prices.
  const doc = (await loadProducts(w.db, [PID])).get(PID)!.doc;
  const r = resolveUnitPrice({ product: doc, optionId: M1, fulfillmentType: 'direct_sale', tier: 'free', tierActive: false });
  assert.deepEqual(fixedUsdAnswerFor(r, window, doc), { kind: 'price', regular_iqd: 750_000 });
  // Without them (the V1 fallback read): no rate on any row — no sale, never a guessed price.
  w.raw.exec('DROP TABLE pricing_v2_sku_results');
  const view = (await loadRelationsViews(w.db, [{ id: PID, inventory_mode: 'OPTION' }])).get(PID)!;
  assert.ok((view.sku_prices ?? []).every((row) => !('usd_iqd_rate' in row)));
  const v1doc = { ...doc, sku_prices: view.sku_prices };
  assert.deepEqual(fixedUsdAnswerFor(r, window, v1doc), { kind: 'none' });
});
