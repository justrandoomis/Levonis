/**
 * THE PRODUCT SAVE WAITS ON THE DATABASE A BOUNDED NUMBER OF TIMES (the
 * owner's report of 2026-10-17: «Network error — check your connection and
 * try again» on «حفظ», «نشر» and «اعتمد ونشر», «sometimes»).
 *
 * On the live Worker every D1 call is a round trip from the Iraqi PoP to the
 * D1 primary, and every R2 read and Images decode is one more wait; a handler
 * that awaits them one after another pays each in full. The save of a
 * realistic product — the owner's filament: three colours, cost-first V2, a
 * live dollar offer, six pictures, open price requests — waited 80 times in
 * sequence for the review sheet's 409 and 99 times for «اعتمد ونشر» (measured
 * here, on the code before this change), and a slow day put that past the
 * client's 20-second deadline.
 *
 * Measured through the real routes on a D1 that enforces production's limits
 * (100 bound parameters, 5 compound terms, 100 KB of SQL, 32 arguments to one
 * SQL function) and counts every call (tests/fixtures/d1RoundTrips.ts); a call
 * that starts while another is in flight shares its wave. Ceilings, not exact numbers: a change that adds a
 * sequential wait to the save fails here and says which.
 *
 * Run: node --import tsx --test tests/adminSaveRoundTrips.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, post, put, stubApp } from './fixtures/app';
import { countingD1 } from './fixtures/d1RoundTrips';
import { discountWorld } from './fixtures/productDiscount';
import { productMediaFixtureEnv } from './fixtures/productMedia';
import { seedOptionless, writeV2 } from './fixtures/pricingV2';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire } from '../src/components/adminProducts/form/model';
import { docWithoutLegacyMoney, withoutLegacyMoney } from '../src/components/adminProducts/form/v2/v2Model';
import { statsRecompute } from '../worker/lib/priceRequests';

/** The ceilings (sequential waits, every kind of I/O), measured 2026-10-17 with a little room. */
const CEILING = { reviewSheet: 36, publish: 46, apply: 23 } as const;
const PICTURES = 6;
const ID = 'p_esun';

async function filamentWorld() {
  const w = await discountWorld({ costFirst: false });
  seedOptionless(w.raw, ID, { colours: 3, routes: ['land'] });
  await writeV2(w.db, ID, {
    method: 'cost',
    inputs: { supplier_cost_amount: '12', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1300 },
    minimumProfitUsd: '4',
  });
  const offer = await w.saveOffer(w.owner, { offer_price_mode: 'fixed_usd', offer_usd_prices: [{ model_id: '', usd: '15' }], ends_at: '2099-01-01T00:00', expected_updated_at: null }, ID);
  assert.equal(offer.status, 200, JSON.stringify(offer.body).slice(0, 200));
  for (let k = 0; k < PICTURES; k++) {
    w.raw.exec(`INSERT INTO product_images (id, product_id, url, r2_key, content_type, sort_order, is_primary, width, height, bytes)
                VALUES ('img${k}', '${ID}', '/files/esun-${k}.webp', 'esun-${k}.webp', 'image/webp', ${k}, ${k === 0 ? 1 : 0}, 640, 480, 30)`);
  }
  w.raw.exec(`INSERT INTO product_price_requests (id, user_id, product_id, selection, notify) VALUES
    ('prq_1', 'u_buyer', '${ID}', 'c:${ID}_c0', 1), ('prq_2', 'usr_editor', '${ID}', 'c:${ID}_c1', 0)`);
  await w.db.batch([statsRecompute(w.db, ID, new Date().toISOString())]);

  // The routes on the counting, limit-enforcing D1; R2 and the Images binding counted in the same waves.
  const media = productMediaFixtureEnv();
  const { db, counter } = countingD1(w.raw);
  const getObject = media.publicBucket.get.bind(media.publicBucket);
  media.publicBucket.get = (key: string) => counter.io(`r2 get ${key}`, () => getObject(key));
  const images = media.env.IMAGES as unknown as Record<string, (...a: unknown[]) => unknown>;
  const info = images.info.bind(images);
  const input = images.input.bind(images);
  images.info = (s: unknown) => counter.io('images info', () => info(s) as Promise<unknown>);
  images.input = (s: unknown) => {
    const decoder = input(s) as { output: (...a: unknown[]) => Promise<unknown> };
    return { output: (...a: unknown[]) => counter.io('images output', () => decoder.output(...a)) };
  };
  const app = stubApp(
    db,
    { id: 'usr_owner', role: 'admin', email: 'boss@x.co' },
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/products-v2', adminProductsRoutes);
      a.route('/api/admin/products', adminProductRelationsRoutes);
    },
    { publishV2: false, env: media.env }
  );
  return { w, app, counter };
}

/** What the form posts (ProductForm `save`): the document without its derived copies and dinar keys, its relations. */
async function formBody(app: Awaited<ReturnType<typeof filamentWorld>>['app'], pricingV2: Record<string, unknown>) {
  const product = (await json(await get(app, `/api/admin/products-v2/${ID}`))).product;
  const rel = await json(await get(app, `/api/admin/products/${ID}/relations`));
  const doc = toEditorDoc(product as never) as unknown as Record<string, unknown>;
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o; void _c; void _m;
  const relations = withoutLegacyMoney(relationsToWire(hydrateRelations(rel as never, product as never)) as never);
  return { ...docWithoutLegacyMoney(docFields), relations, expected_updated_at: product.updated_at, pricing_v2: pricingV2 };
}

const named = (log: string[]) => log.join('\n');

test('«حفظ» then «اعتمد ونشر» on the owner’s filament: the review sheet and the publish wait a bounded number of times', async () => {
  const { w, app, counter } = await filamentWorld();
  const pricing = { cost: { inputs: [{ scope: 'base', supplier_cost_amount: '13' }] } };
  const body = await formBody(app, { pricing });

  counter.reset();
  const sheet = await post(app, '/api/admin/products-v2', body);
  const sheetBody = await json(sheet);
  assert.equal(sheetBody.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(sheetBody).slice(0, 300));
  const sheetWaves = counter.waves;
  assert.ok(sheetWaves <= CEILING.reviewSheet, `the review sheet's 409 waited ${sheetWaves} times (ceiling ${CEILING.reviewSheet}):\n${named(counter.log)}`);

  counter.reset();
  const res = await post(app, '/api/admin/products-v2', { ...body, pricing_v2: { pricing, preview_hash: sheetBody.details.preview.review_hash, confirm_large_change: true } });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())).slice(0, 300));
  const publishWaves = counter.waves;
  assert.ok(publishWaves <= CEILING.publish, `«اعتمد ونشر» waited ${publishWaves} times (ceiling ${CEILING.publish}):\n${named(counter.log)}`);
  // Every picture is checked, and they are checked together: one wave of R2 reads for all six, each time.
  const reads = counter.log.filter((l) => /\tr2 get /.test(l));
  assert.equal(reads.length, PICTURES * 2, 'each picture read and re-read after its guard');
  assert.ok(new Set(reads.map((l) => l.split('\t')[0])).size <= 2, `the reads share their waves:\n${reads.join('\n')}`);
  // The product schema is asked once per binding, never per column: the second save asks it nothing (the media
  // guard keeps its own probe per picture — the catalogue import budgets it — sent with the picture's guard).
  const pragmas = counter.log.filter((l) => /PRAGMA table_info/.test(l));
  assert.deepEqual([...new Set(pragmas.map((l) => l.replace(/^\d+\t/, '')))], ['all PRAGMA table_info("media_object_guards")'], pragmas.join('\n'));

  // THE RETRY THE FORM MAY INVITE IS SAFE (src/components/adminProducts/saveOutcome.ts): the same edit sent
  // again after it landed is refused as stale, and nothing is written twice.
  const stored = () => JSON.stringify([
    w.raw.prepare('SELECT updated_at FROM products WHERE id = ?').get(ID),
    w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ?').get(ID),
    w.raw.prepare('SELECT COUNT(*) AS n FROM price_history WHERE product_id = ?').get(ID),
  ]);
  const before = stored();
  const again = await post(app, '/api/admin/products-v2', { ...body, pricing_v2: { pricing, preview_hash: sheetBody.details.preview.review_hash, confirm_large_change: true } });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'STALE_EDIT');
  assert.equal(stored(), before, 'nothing written twice');
});

test('the prices-only apply waits a bounded number of times', async () => {
  const { app, counter } = await filamentWorld();
  const stored = await json(await get(app, `/api/admin/products-v2/${ID}/pricing`));
  const seq = stored.seq as { inputs_seq: number; write_seq: number };
  const pricing = { cost: { inputs: [{ scope: 'base', supplier_cost_amount: '13' }] } };
  const bare = await json(await put(app, `/api/admin/products-v2/${ID}/pricing`, { seq, pricing }));
  assert.equal(bare.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(bare).slice(0, 300));
  counter.reset();
  const res = await put(app, `/api/admin/products-v2/${ID}/pricing`, { seq, pricing, preview_hash: bare.details.preview.review_hash, confirm_large_change: true });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())).slice(0, 300));
  assert.ok(counter.waves <= CEILING.apply, `the apply waited ${counter.waves} times (ceiling ${CEILING.apply}):\n${named(counter.log)}`);
});
