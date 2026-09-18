/**
 * A FAILED READ IS NOT AN EMPTY TABLE — and for ninety days it was.
 *
 * `loadAlertContexts` fetches a product's option values, colours, variants,
 * colour links and fulfilment cells through `soft()`, which existed so that a
 * Worker running ahead of its migration degrades instead of taking the cron
 * down. It degraded by returning `[]`.
 *
 * But an EMPTY `product_option_values` read is indistinguishable, downstream,
 * from a product whose models were deleted. `valueById` comes out empty,
 * `resolveWish` finds no row for the wished model and answers TARGET_REMOVED —
 * which the module documents as PERMANENT, because ids are never reused. The
 * sweep writes `state='dead'` on it, and the driving query reads only
 * `state IN ('armed','firing')`. There is no path back.
 *
 * So ONE transient `D1_ERROR: Network connection lost` on ONE of six reads
 * would have told every waiting customer «الخيار الذي اخترته ما عاد موجود»
 * about a model sitting live and sellable on the product page one tap away —
 * and the shop would have had no way to learn it had happened, because
 * `report.dead` counts it as successful reconciliation.
 *
 * Worse than transient: `soft` also swallowed `no such column`, so during the
 * deploy-ahead-of-migration window it was written for, EVERY pass would have
 * killed EVERY option and colour alert in the shop, deterministically.
 *
 * These tests inject exactly that failure and hold the rule that fixes it:
 * only a read that SUCCEEDED may justify a permanent verdict.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1 } from './fixtures/app';
import { loadAlertContexts, resolveWish, armRefusal, contextDegraded } from '../worker/lib/stockAlertResolve';

/** A product with two models, one of them in stock — an alert on it should FIRE. */
function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,selling_type,sale_types,inventory_mode,stock)
      VALUES ('p1','a1','A1 printer','طابعة A1',900000,'active','direct_sale','["direct_sale"]','OPTION',NULL);
    INSERT INTO product_option_groups (id,product_id,name_en,active,sort)
      VALUES ('g1','p1','Model',1,0);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,active,stock,sort)
      VALUES ('v_big','p1','g1','Large','كبير',1,5,0),
             ('v_small','p1','g1','Small','صغير',1,0,1);
  `);
}

/**
 * The real adapter, with one SELECT made to throw — the shape of a transient
 * D1 failure, which is the case `soft` was silently converting into a
 * permanent verdict.
 */
function failingOn(db: D1Database, needle: string): D1Database {
  return {
    prepare(sql: string) {
      const stmt = (db as unknown as { prepare(s: string): Record<string, unknown> }).prepare(sql);
      if (!sql.includes(needle)) return stmt;
      return {
        bind: () => ({
          all: () => Promise.reject(new Error('D1_ERROR: Network connection lost.')),
          first: () => Promise.reject(new Error('D1_ERROR: Network connection lost.')),
          run: () => Promise.reject(new Error('D1_ERROR: Network connection lost.')),
        }),
      };
    },
    batch: (db as unknown as { batch: unknown }).batch,
  } as unknown as D1Database;
}

const WISH = { kind: 'option_value' as const, option_value_id: 'v_big', color_id: '' };

test('with every read working, the wish resolves and is buyable', async () => {
  const raw = freshDb();
  seed(raw);
  const ctx = (await loadAlertContexts(asD1(raw), ['p1'])).get('p1')!;
  assert.ok(ctx, 'the product loaded');
  assert.equal(contextDegraded(ctx), false);

  const v = resolveWish(ctx, WISH);
  assert.equal(v.buyable, true, 'the large model has five on the shelf');
  assert.equal(v.dead, null);
  assert.equal(v.label.ar, 'كبير', 'and the message would name the model, not the product');
});

test('THE BUG: one failed read used to answer TARGET_REMOVED — permanently', async () => {
  const raw = freshDb();
  seed(raw);
  // Exactly the reviewer's injection: the option-values read fails, the other
  // five succeed, and the `products` read (which is deliberately NOT soft)
  // succeeds — so the sweep's `contexts.size === 0` guard does not fire.
  const db = failingOn(asD1(raw), 'FROM product_option_values');
  const ctx = (await loadAlertContexts(db, ['p1'])).get('p1')!;
  assert.ok(ctx, 'the product still loads — which is why the empty-map guard misses this');

  const v = resolveWish(ctx, WISH);
  assert.notEqual(v.dead, 'TARGET_REMOVED', 'a read we could not perform may never be called permanent');
  assert.equal(v.dead, null, 'and it is not any other permanent reason either');
  assert.equal(v.degraded, true, 'it says plainly that it decided nothing');
  assert.equal(v.buyable, false, 'and it never guesses a fire out of missing data');
  assert.equal(v.available, null, 'no count, because no count was read');
});

test('every soft read is covered, not just the one that was reported', async () => {
  // The failure is not special to option values: colours decide TARGET_REMOVED
  // the same way, and a missing colour-links read makes every colour look
  // selectable with every model — a FALSE FIRE rather than a false death.
  for (const needle of [
    'FROM product_option_groups',
    'FROM product_option_values',
    'FROM product_colors',
    'FROM product_variants',
    'FROM product_color_option_links',
    'FROM product_option_fulfillment',
  ]) {
    const raw = freshDb();
    seed(raw);
    const ctx = (await loadAlertContexts(failingOn(asD1(raw), needle), ['p1'])).get('p1')!;
    assert.equal(contextDegraded(ctx), true, `${needle}: the context knows it is degraded`);
    const v = resolveWish(ctx, WISH);
    assert.equal(v.dead, null, `${needle}: no permanent verdict`);
    assert.equal(v.degraded, true, `${needle}: reported as undecided`);
  }
});

test('the door refuses transiently rather than arming a promise it cannot check', async () => {
  // The mirror-image mistake, and the one the short-circuit would have caused
  // on its own: armRefusal answers by looking for a permanent reason, a
  // degraded context produces none, and silence would read as consent.
  const raw = freshDb();
  seed(raw);
  const ctx = (await loadAlertContexts(failingOn(asD1(raw), 'FROM product_option_values'), ['p1'])).get('p1')!;

  assert.equal(armRefusal(ctx, WISH), null, 'no PERMANENT refusal exists — that is the trap');
  assert.equal(contextDegraded(ctx), true, 'so the route must ask this instead, and it does');
});

test('a genuinely deleted model is still TARGET_REMOVED — the fix does not blunt the real answer', async () => {
  const raw = freshDb();
  seed(raw);
  const ctx = (await loadAlertContexts(asD1(raw), ['p1'])).get('p1')!;
  const gone = resolveWish(ctx, { kind: 'option_value', option_value_id: 'v_never', color_id: '' });
  assert.equal(gone.dead, 'TARGET_REMOVED', 'a read that SUCCEEDED and found nothing is a real answer');
  assert.ok(!gone.degraded);
});
