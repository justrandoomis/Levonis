/**
 * SMART TRADE-IN VALUE (owner, 2026-11-18; DECISIONS row 353; migration 0238).
 *
 *   - a model's resale share: the owner's, else the family's blended GENTLY with real resales,
 *     less a newer generation on sale;
 *   - age is not counted twice: the fall of today's price below what was paid is credited back
 *     to the age line (never above 0);
 *   - hours are judged against the months owned;
 *   - a model with no price on sale today is valued from what was paid (new offers only);
 *   - the owner's value table (every printer, its offer at 3–24 months) — cost-read only;
 *     a model's profile and a family's knobs — the owner's alone.
 * The 15% margin (at least 50,000 for a printer) and every cap are unchanged.
 *
 * Run: node --import tsx --test tests/tradeInSmartValue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { get, json, post, send } from './fixtures/app';
import { publishSeededV2 } from './fixtures/autoPublish';
import { OWNER, STAFF, adminApp, customerApp, restoreFetch, seed } from './sv2_tradein_fixture';
import { blankInputs } from '../packages/pricing/src/tradeIn';
import { DEFAULT_RULE_SETS } from '../packages/pricing/src/tradeInDefaults';
import {
  DEFAULT_SMART_PARAMS,
  componentOffer,
  lastPaidNowIqd,
  learnedResaleBp,
  modelResaleBp,
  paramsOf,
  resaleSampleBp,
  smartParamsOf,
  validateSmartParams,
} from '../packages/pricing/src/tradeInOffer';

test.after(restoreFetch);

const fdm = DEFAULT_RULE_SETS.fdm;
const p = paramsOf(fdm);
const facts = (over: Record<string, unknown> = {}) => ({
  role: 'device' as const,
  family: 'fdm' as const,
  now_iqd: 850_000,
  paid_iqd: 850_000,
  usage_months: 12,
  warranty_left_months: 0,
  product_id: 'p_a1',
  inputs: { ...blankInputs('fdm'), hours: 300 },
  ...over,
});

// ============================================================ the pure formula

test('learning is gentle: no sale = the family share; one sale moves it a quarter of the way (3 phantom sales)', () => {
  assert.equal(learnedResaleBp(8_000, [], 3), 8_000);
  assert.equal(learnedResaleBp(8_000, [6_000], 3), 7_500);
  assert.equal(learnedResaleBp(8_000, [6_000, 6_000, 6_000], 3), 7_000);
  // A real resale is read as sold ÷ (today's price × condition), held inside 30–95%.
  assert.equal(resaleSampleBp(500_000, 850_000, 8_000), 7_352);
  assert.equal(resaleSampleBp(10, 850_000, 8_000), 3_000);
  assert.equal(resaleSampleBp(5_000_000, 850_000, 8_000), 9_500);
  assert.equal(resaleSampleBp(0, 850_000, 8_000), null);
});

test('the owner’s share wins; a newer generation on sale lowers it by its superseded share', () => {
  assert.deepEqual(modelResaleBp(8_000, { ownerBp: 7_000, samples: [6_000], weight: 3, superseded: false, supersededBp: 1_000 }), {
    resale_bp: 7_000,
    source: 'owner',
    learned_bp: 7_500,
    samples: 1,
  });
  assert.equal(modelResaleBp(8_000, { ownerBp: 7_000, samples: [], weight: 3, superseded: true, supersededBp: 1_000 }).resale_bp, 6_300);
  assert.equal(modelResaleBp(8_000, { ownerBp: null, samples: [], weight: 3, superseded: false, supersededBp: 1_000 }).source, 'family');
  assert.equal(modelResaleBp(8_000, { ownerBp: null, samples: [7_000], weight: 3, superseded: false, supersededBp: 1_000 }).source, 'learned');
  // An owner figure outside 10–95% is not one.
  assert.equal(modelResaleBp(8_000, { ownerBp: 500, samples: [], weight: 3, superseded: false, supersededBp: 0 }).source, 'family');
});

test('a model off sale: what was paid, less 2% a month, at most 60%', () => {
  assert.equal(lastPaidNowIqd(1_000_000, 10, DEFAULT_SMART_PARAMS.fdm), 800_000);
  assert.equal(lastPaidNowIqd(1_000_000, 40, DEFAULT_SMART_PARAMS.fdm), 400_000);
  assert.equal(lastPaidNowIqd(1_000_000, 0, DEFAULT_SMART_PARAMS.fdm), 1_000_000);
});

test('without the smart facts the 0192 formula is exactly as before (the model share defaults to the family’s)', () => {
  const before = componentOffer(fdm, p, facts());
  const same = componentOffer(fdm, p, { ...facts(), resale_bp: p.resale_bp });
  assert.equal(same.offer_iqd, before.offer_iqd);
  assert.deepEqual([before.age_credit_bp, before.hours_allowance, before.resale_bp], [0, 0, p.resale_bp]);
});

test('age is not counted twice: a price that fell since purchase is credited back to the age line — never above zero, every cap still holds', () => {
  const smart = DEFAULT_SMART_PARAMS.fdm;
  const fell = { now_iqd: 500_000, paid_iqd: 850_000 };
  const old = componentOffer(fdm, p, facts(fell));
  const now = componentOffer(fdm, p, { ...facts(fell), smart });
  assert.equal(now.age_credit_bp, 4_117); // (850,000 − 500,000) / 850,000
  assert.ok(now.q_bp > old.q_bp, 'the age line no longer takes the fall a second time');
  assert.ok(now.offer_iqd >= old.offer_iqd);
  assert.ok(now.offer_iqd <= now.store_cap_iqd && now.offer_iqd <= now.max_offer_iqd && now.offer_iqd <= now.cond_iqd);
  // No fall, no credit: the same offer as before.
  const flat = componentOffer(fdm, p, { ...facts(), smart });
  assert.equal(flat.age_credit_bp, 0);
  // The credit only cancels the age line: it never adds value above a device that did not age.
  const young = componentOffer(fdm, p, { ...facts({ ...fell, usage_months: 0 }), smart });
  const youngOld = componentOffer(fdm, p, facts({ ...fell, usage_months: 0 }));
  assert.equal(young.q_bp, youngOld.q_bp);
});

test('hours are judged against the months owned: 900 h over 12 months is 420 beyond the 480 expected', () => {
  const smart = DEFAULT_SMART_PARAMS.fdm;
  const heavy = { inputs: { ...blankInputs('fdm'), hours: 900 } };
  const old = componentOffer(fdm, p, facts(heavy));
  const now = componentOffer(fdm, p, { ...facts(heavy), smart });
  assert.equal(now.hours_allowance, 480);
  assert.ok(now.q_bp > old.q_bp);
  // A print farm (5,000 h in a year) is still a print farm.
  const farm = componentOffer(fdm, p, { ...facts({ inputs: { ...blankInputs('fdm'), hours: 5_000 } }), smart });
  assert.ok(farm.q_bp < now.q_bp);
});

test('a model’s own resale share moves the store’s cap, never the margin rule', () => {
  const smart = DEFAULT_SMART_PARAMS.fdm;
  const low = componentOffer(fdm, p, { ...facts(), smart, resale_bp: 6_000 });
  const fam = componentOffer(fdm, p, { ...facts(), smart });
  assert.ok(low.resale_iqd < fam.resale_iqd);
  assert.ok(low.offer_iqd <= fam.offer_iqd);
  assert.equal(low.margin_iqd, Math.max(Math.floor((low.resale_iqd * p.margin_bp) / 10_000), p.margin_min_iqd));
});

test('the family knobs: stored values inside their ranges, else the default', () => {
  assert.deepEqual(smartParamsOf('fdm', { hours_allowance_per_month: 60, learn_weight: 0 }), { ...DEFAULT_SMART_PARAMS.fdm, hours_allowance_per_month: 60 });
  assert.equal(validateSmartParams({ superseded_bp: 6_000 }).ok, false);
  assert.deepEqual(validateSmartParams({ superseded_bp: null, last_price_decay_bp: 150 }), { ok: true, value: { superseded_bp: null, last_price_decay_bp: 150 } });
});

// ============================================================ the Worker

async function printers(raw: DatabaseSync) {
  await publishSeededV2(raw);
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, name_en, is_printer_catalog) VALUES ('cat_pr', 'printers-x', 'طابعات', 'Printers', 1);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1', 'cat_pr', 0), ('p_p1s', 'cat_pr', 1);
  `);
  return raw;
}

test('the value table: every printer model with today’s price, its share and where it came from, the offer at 3–24 months — the owner’s alone', async () => {
  const raw = await printers(seed());
  for (const who of [STAFF]) {
    const res = await get(adminApp(raw, who), '/api/admin/trade-in/value-table');
    assert.equal(res.status, 403);
  }
  const res = await get(adminApp(raw, OWNER), '/api/admin/trade-in/value-table');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const ids = body.rows.map((r: { product_id: string }) => r.product_id).sort();
  assert.deepEqual(ids, ['p_a1', 'p_p1s']);
  const p1s = body.rows.find((r: { product_id: string }) => r.product_id === 'p_p1s');
  assert.equal(p1s.now_iqd, 1_500_000);
  assert.deepEqual([p1s.resale.source, p1s.resale.resale_bp], ['family', 8_000]);
  const offers = p1s.offers.map((o: { offer_iqd: number }) => o.offer_iqd);
  assert.equal(offers.length, 4);
  for (let i = 1; i < offers.length; i++) assert.ok(offers[i] <= offers[i - 1], `older is never worth more: ${offers}`);
  assert.ok(offers[0] > 0 && offers[0] <= 1_500_000 * 0.7);
});

test('a model profile: the owner sets a share and a successor; staff cannot; a bad figure is refused; clearing it returns to the family', async () => {
  const raw = await printers(seed());
  const put = (who: typeof OWNER, body: Record<string, unknown>) => send(adminApp(raw, who), 'PUT', '/api/admin/trade-in/model-profiles/p_a1', body);
  assert.equal((await put(STAFF, { resale_bp: 6_000 })).status, 403);
  assert.equal((await put(OWNER, { resale_bp: 500 })).status, 400);
  assert.equal((await put(OWNER, { successor_product_id: 'p_nope' })).status, 404);
  const ok = await put(OWNER, { resale_bp: 7_000, successor_product_id: 'p_p1s' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const a1 = (await json(await get(adminApp(raw, OWNER), '/api/admin/trade-in/value-table'))).rows.find((r: { product_id: string }) => r.product_id === 'p_a1');
  // The P1S is on sale: the A1 is a superseded model — 7,000 less 10% = 6,300.
  assert.deepEqual([a1.resale.source, a1.resale.superseded, a1.resale.resale_bp], ['owner', true, 6_300]);
  assert.equal((await put(OWNER, { resale_bp: null, successor_product_id: null })).status, 200);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM trade_in_model_profiles').get()!.n, 0);
  // A family's knobs: the owner's, checked.
  assert.equal((await send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/smart-params/fdm', { hours_allowance_per_month: 9_999 })).status, 400);
  const smart = await json(await send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/smart-params/fdm', { hours_allowance_per_month: 60 }));
  assert.equal(smart.smart.fdm.hours_allowance_per_month, 60);
  assert.equal((await send(adminApp(raw, STAFF), 'PUT', '/api/admin/trade-in/smart-params/fdm', { hours_allowance_per_month: 60 })).status, 403);
});

test('a model no longer on sale: no offer unless the OWNER switched it on — then from what was paid, less the decay, never shown as today’s price', async () => {
  const raw = seed({ deliveredDaysAgo: 200 });
  raw.exec(`UPDATE products SET status = 'hidden' WHERE id = 'p_a1'`);
  const a = customerApp(raw);
  const r = await json(await post(a, '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' }));
  assert.ok(r.success, JSON.stringify(r));
  const id = r.request.id as string;
  const preview = async () => {
    const res = await post(a, `/api/trade-in/requests/${id}/preview`, { components: { device: blankInputs('fdm') } });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    return (body.offer ?? body.estimate) as Record<string, any>;
  };
  // Hidden for a day to be re-priced is not «off sale»: no offer, as before.
  const off = await preview();
  assert.equal(off.offer_iqd ?? null, null, JSON.stringify(off));
  // The owner switches the model on.
  const sw = await send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/model-profiles/p_a1', { value_off_sale: true });
  assert.equal(sw.status, 200, await sw.clone().text());
  const on = await preview();
  assert.ok(Number(on.offer_iqd) > 0, JSON.stringify(on));
  assert.ok(Number(on.offer_iqd) < 850_000);
  assert.equal(on.now_price_iqd ?? null, null, 'a private figure is not «today’s price»');
});

test('offered at a real price, the model hidden before intake: the offer stands as the ceiling (F-14), never re-valued from what was paid', async () => {
  const { received, submitted } = await import('./sv2_tradein_fixture');
  const raw = seed();
  const id = await submitted(raw);
  const offer = (raw.prepare('SELECT offer_iqd FROM trade_in_requests WHERE id = ?').get(id) as { offer_iqd: number }).offer_iqd;
  assert.ok(offer > 0);
  raw.exec(`UPDATE products SET status = 'hidden' WHERE id = 'p_a1'`);
  await send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/model-profiles/p_a1', { value_off_sale: true });
  await received(raw, id);
  const r = raw.prepare('SELECT ceiling_iqd, intake_json FROM trade_in_requests WHERE id = ?').get(id) as { ceiling_iqd: number; intake_json: string };
  assert.equal(r.ceiling_iqd, offer);
  assert.equal(JSON.parse(r.intake_json).no_offer_reason, 'no_price_today');
});

test('a learned share is not cut again for a newer model; only the newest 20 sales teach, the extremes trimmed from 5', async () => {
  const { teachingSamples } = await import('../packages/pricing/src/tradeInOffer');
  const learned = modelResaleBp(8_000, { ownerBp: null, samples: [6_000], weight: 3, superseded: true, supersededBp: 1_000 });
  assert.deepEqual([learned.source, learned.resale_bp], ['learned', 7_500]);
  const fam = modelResaleBp(8_000, { ownerBp: null, samples: [], weight: 3, superseded: true, supersededBp: 1_000 });
  assert.deepEqual([fam.source, fam.resale_bp], ['family', 7_200]);
  // Samples that cannot be read do not make a share «learned».
  assert.equal(modelResaleBp(8_000, { ownerBp: null, samples: [0, -5], weight: 3, superseded: false, supersededBp: 0 }).source, 'family');
  assert.deepEqual(teachingSamples([7_000, 6_000, 8_000]), [7_000, 6_000, 8_000]);
  assert.deepEqual(teachingSamples([7_000, 3_000, 9_500, 6_000, 8_000]), [6_000, 7_000, 8_000]);
  assert.equal(teachingSamples(Array.from({ length: 30 }, (_, i) => 5_000 + i)).length, 18);
  assert.deepEqual(teachingSamples(Array.from({ length: 30 }, (_, i) => 5_000 + i)).slice(0, 1), [5_001], 'the newest 20, less their lowest');
});

test('a profile save keeps what it does not send (the note, the off-sale switch)', async () => {
  const raw = await printers(seed());
  const put = (body: Record<string, unknown>) => send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/model-profiles/p_a1', body);
  assert.equal((await put({ resale_bp: 7_000, value_off_sale: true, note: 'X1C only refurbished' })).status, 200);
  assert.equal((await put({ resale_bp: 6_500 })).status, 200);
  const row = raw.prepare('SELECT resale_bp, value_off_sale, note FROM trade_in_model_profiles WHERE product_id = ?').get('p_a1') as Record<string, unknown>;
  assert.deepEqual({ ...row }, { resale_bp: 6_500, value_off_sale: 1, note: 'X1C only refurbished' });
  assert.equal((await put({ value_off_sale: 'yes' })).status, 400);
});

test('learning reads real resales: a traded-in A1 booked to stock and sold teaches the A1’s share — gently, and only the A1’s', async () => {
  const { approvedAndOrdered, delivered, submitted } = await import('./sv2_tradein_fixture');
  const { resaleSamples, modelResaleFor, loadSmartBook } = await import('../worker/lib/tradeInSmart');
  const { TodayReader } = await import('../worker/lib/tradeInToday');
  const { asD1 } = await import('./fixtures/app');
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  await delivered(raw, orderId);
  const lot = `ilot_ti_${id}`;
  assert.ok(raw.prepare('SELECT 1 FROM trade_in_stock WHERE lot_id = ?').get(lot), 'the old A1 became a stock lot');
  const db = asD1(raw);
  assert.deepEqual([...(await resaleSamples(db, ['p_a1'])).entries()], [], 'not sold yet: nothing learned');
  // The used A1 is sold to another customer for 520,000.
  raw.exec(`
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-USED','cust','delivered','delivered','{}','standard','{}','cash',520000,0,1400,520000,0,'2026-11-01T00:00:00.000Z','2026-11-02T00:00:00.000Z','2026-11-02T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_used','ORD-USED','prd_ti_${id}','Used A1','','',1,520000,520000,'','[]');
    INSERT INTO order_item_inventory_allocations (id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES
      ('al_used','ORD-USED','oi_used','${lot}','base','',1,NULL,NULL,'used-1');
  `);
  const samples = (await resaleSamples(db, ['p_a1', 'p_p1s'])).get('p_a1') ?? [];
  assert.equal(samples.length, 1);
  assert.ok(samples[0] >= 3_000 && samples[0] <= 9_500, String(samples[0]));
  assert.equal((await resaleSamples(db, ['p_p1s'])).size, 0, 'a P1S learns nothing from an A1');
  const smart = await loadSmartBook(db);
  const r = await modelResaleFor(db, new TodayReader({ DB: db } as never), 'p_a1', 8_000, smart.fdm);
  assert.equal(r.source, 'learned');
  assert.equal(r.resale_bp, Math.floor((8_000 * 3 + samples[0]) / 4));
});

test('only a finished sale teaches: undelivered, returned or refunded sales move nothing; the listed unit price counts, not what a coupon left', async () => {
  const { approvedAndOrdered, delivered, submitted } = await import('./sv2_tradein_fixture');
  const { resaleSamples } = await import('../worker/lib/tradeInSmart');
  const { asD1 } = await import('./fixtures/app');
  const raw = seed();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  await delivered(raw, orderId);
  const lot = `ilot_ti_${id}`;
  const db = asD1(raw);
  const sell = (order: string, status: string, unit: number, line: number) =>
    raw.exec(`
      INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                          subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
        ('${order}','cust','${status}','${status}','{}','standard','{}','cash',${line},0,1400,${line},0,'2026-11-01T00:00:00.000Z','2026-11-02T00:00:00.000Z',NULL);
      INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
        ('oi_${order}','${order}','prd_ti_${id}','Used A1','','',1,${unit},${line},'','[]');
      INSERT INTO order_item_inventory_allocations (id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES
        ('al_${order}','${order}','oi_${order}','${lot}','base','',1,NULL,NULL,'k-${order}');`);
  // A sale on its way (not delivered): nothing.
  sell('ORD-U1', 'shipped', 520_000, 520_000);
  assert.equal((await resaleSamples(db, ['p_a1'])).size, 0);
  // Delivered, listed at 520,000 but a coupon left 100,000 on the line: the listed price counts.
  raw.exec(`UPDATE orders SET status = 'delivered', stage = 'delivered' WHERE id = 'ORD-U1'; UPDATE order_items SET line_total_iqd = 100000 WHERE id = 'oi_ORD-U1';`);
  const one = (await resaleSamples(db, ['p_a1'])).get('p_a1') ?? [];
  assert.equal(one.length, 1);
  const listed = one[0];
  // A return opened on it (not yet decided), or refunded: it teaches nothing.
  raw.exec(`INSERT INTO return_cases (id, order_id, order_item_id, user_id, qty, reason, state) VALUES ('rc1','ORD-U1','oi_ORD-U1','cust',1,'defective','requested')`);
  assert.equal((await resaleSamples(db, ['p_a1'])).size, 0);
  raw.exec(`UPDATE return_cases SET state = 'resolved', resolution = 'refund' WHERE id = 'rc1'`);
  assert.equal((await resaleSamples(db, ['p_a1'])).size, 0, 'refunded');
  // A return the shop rejected, or declined: the sale stands.
  raw.exec(`UPDATE return_cases SET state = 'rejected', resolution = NULL WHERE id = 'rc1'`);
  assert.deepEqual((await resaleSamples(db, ['p_a1'])).get('p_a1'), [listed]);
  raw.exec(`UPDATE return_cases SET state = 'resolved', resolution = 'declined' WHERE id = 'rc1'`);
  assert.deepEqual((await resaleSamples(db, ['p_a1'])).get('p_a1'), [listed]);
});
