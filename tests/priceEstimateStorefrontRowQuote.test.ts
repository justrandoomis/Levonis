/**
 * «عدة ألوان»: EACH COLOUR'S QUOTE BECOMES ITS ROW (review r2-rowquote;
 * docs/SMART_PRICING.md §5.3).
 *
 * The panel turns each colour's own quote (`POST /api/products/:slug/quote`,
 * qty 1, the panel's exact body) into a row through one pure function,
 * `rowQuoteOf`; the row's and the total's «سعر تقديري» read its `estimate`. A
 * server render never runs the quote effect, so this runs the function on the
 * route's REAL answers:
 *
 *   - a mixed product's estimated colour → `estimate: true`, its own figures;
 *   - its firm colour (`price_estimate_firm_skus`) and the unlabelled twin's
 *     colours → `estimate: false`;
 *   - a colour with no price (added after publication) → unpriced, no ceiling,
 *     no label;
 *   - a refused selection → the quote's and the availability's errors, so the
 *     panel's add stays closed;
 *   - the total and the rows follow those rows (`totalEstimated`, `rowEstimated`).
 *
 * Run: node --import tsx --test tests/priceEstimateStorefrontRowQuote.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { json, post, stubApp } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { seedOptionless, writeV2 } from './fixtures/pricingV2';
import { productRoutes } from '../worker/routes/products';
import { selectionKey } from '../worker/lib/commercialState';
import { rowEstimated, rowQuoteOf, totalEstimated, type QuoteAnswer } from '../src/components/product/ColourQuantityPanel';

const EST = 'p_est';
const PLAIN = 'p_plain';
const colour = (pid: string, k: number) => `${pid}_c${k}`;

/** The estimate label on a product row, as the apply writes it (the engine guard opened around it). */
function label(raw: DatabaseSync, pid: string): void {
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';`);
}

async function world() {
  const w = pricingWorld();
  for (const pid of [EST, PLAIN]) {
    seedOptionless(w.raw, pid, { routes: ['sea'], saleTypes: ['pre_order'], colours: 2 });
    await writeV2(w.db, pid, {
      method: 'usd',
      points: [
        { scope: 'product', scope_id: '', kind: 'fixed', usd: '20' },
        { scope: 'color', scope_id: colour(pid, 0), kind: 'delta', usd: '2' },
      ],
    });
  }
  // Colour 0 is an estimate, colour 1 confirmed by the owner; the twin is never labelled.
  label(w.raw, EST);
  w.raw
    .prepare('INSERT INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)')
    .run(EST, selectionKey([], colour(EST, 1)), 'usr_owner', '2026-11-01T00:00:00.000Z');
  // A third colour added after publication: its SKU has no price.
  w.raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
              VALUES ('${colour(EST, 2)}', '${EST}', 'Colour 3', 'لون ٣', 'ڕەنگی ٣', '#336699', 2, 1, 5)`);
  const app = stubApp(w.db, null, (a) => a.route('/api/products', productRoutes), { publishV2: false });
  return { ...w, app };
}

/** Exactly the body the panel sends for a colour row of a product sold by colour (ColourQuantityPanel.tsx). */
async function panelQuote(app: Awaited<ReturnType<typeof world>>['app'], pid: string, colorId: string): Promise<QuoteAnswer> {
  const ids: string[] = [];
  const body = JSON.parse(
    JSON.stringify({
      qty: 1,
      optionId: ids[0] || undefined,
      optionValueIds: ids.length ? ids : undefined,
      colorId: colorId || undefined,
      transportMethod: 'sea',
      fulfillmentType: 'pre_order',
      warrantyPlanId: undefined,
    })
  );
  const res = await post(app, `/api/products/slug-${pid}/quote`, body);
  const answer = (await json(res)) as QuoteAnswer;
  assert.equal(res.status, 200, JSON.stringify(answer).slice(0, 300));
  return answer;
}

test('an estimated colour and a firm one: each row carries its own quote’s label and its own figures', async () => {
  const { app } = await world();
  const estimated = await panelQuote(app, EST, colour(EST, 0));
  const firm = await panelQuote(app, EST, colour(EST, 1));
  // The real answers: the label rides on a priced answer only when its SKU is an estimate.
  assert.deepEqual([estimated.price_status, estimated.price_estimate, estimated.quote?.price_estimate], ['priced', true, true]);
  assert.deepEqual([firm.price_status, firm.price_estimate, firm.quote?.price_estimate], ['priced', undefined, undefined]);

  for (const [answer, estimate] of [[estimated, true], [firm, false]] as const) {
    const q = answer.quote!;
    const stock = answer.availability!.stock!;
    assert.deepEqual(rowQuoteOf(answer), {
      unit: q.unit_subtotal_iqd,
      regular: q.regular_iqd,
      applied: q.applied_iqd,
      unitBase: { iqd: q.unit_subtotal_iqd, usdCents: q.unit_subtotal_usd_cents },
      appliedUsd: q.applied_usd_cents,
      regularUsd: q.regular_usd_cents,
      maxQty: stock.max_qty,
      tracked: stock.tracked,
      scope: stock.scope,
      preorder: true,
      quotaTracked: false,
      errors: [],
      unpriced: false,
      estimate,
    });
  }
  // $22 against $20: two different prices, each the colour's own.
  assert.notEqual(rowQuoteOf(estimated).unit, rowQuoteOf(firm).unit);

  // The rows and the total read those answers; until an answer, the page's label stands in.
  const est = rowQuoteOf(estimated);
  const fir = rowQuoteOf(firm);
  assert.equal(rowEstimated(est, false), true);
  assert.equal(rowEstimated(fir, true), false, 'a firm colour of a mixed product carries none');
  assert.equal(totalEstimated([fir], true), false, 'only the firm colour chosen');
  assert.equal(totalEstimated([fir, est], false), true, 'one estimated colour makes the total an estimate');
  assert.equal(totalEstimated([fir, null], true), true, 'a colour still waiting for its quote');
});

test('the unlabelled twin: no row is an estimate', async () => {
  const { app } = await world();
  for (const k of [0, 1]) {
    const answer = await panelQuote(app, PLAIN, colour(PLAIN, k));
    assert.equal('price_estimate' in answer, false);
    assert.equal(rowQuoteOf(answer).estimate, false);
    assert.equal(rowQuoteOf(answer).unpriced, false);
  }
});

test('a colour with no price: unpriced, no ceiling, no label — even on a labelled product', async () => {
  const { app } = await world();
  const answer = await panelQuote(app, EST, colour(EST, 2));
  assert.deepEqual([answer.price_status, answer.quote, answer.availability], ['unpriced', null, null]);
  assert.deepEqual(rowQuoteOf(answer), {
    unit: 0,
    regular: 0,
    applied: 0,
    unitBase: null,
    appliedUsd: null,
    regularUsd: null,
    maxQty: 0,
    tracked: false,
    scope: '',
    preorder: false,
    quotaTracked: false,
    errors: [],
    unpriced: true,
    estimate: false,
  });
});

test('a refused selection keeps both lists of errors, so the add stays closed', async () => {
  const { app } = await world();
  // A route the product does not offer: the resolver refuses it, the availability says so.
  const res = await post(app, `/api/products/slug-${EST}/quote`, { qty: 1, colorId: colour(EST, 0), transportMethod: 'air', fulfillmentType: 'pre_order' });
  const answer = (await json(res)) as QuoteAnswer;
  assert.equal(res.status, 200);
  const row = rowQuoteOf(answer);
  assert.ok(row.errors.length > 0, JSON.stringify(answer).slice(0, 400));
  assert.deepEqual(row.errors, [...(answer.quote?.errors ?? []), ...(answer.availability?.selection?.errors ?? [])]);
});
