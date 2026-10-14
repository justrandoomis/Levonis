/**
 * PRICING V2 — WHO SEES AND EDITS WHAT (spec §4.4 as amended by the owner's
 * answer Q2, DECISIONS row 222, addendum A.1 and A.12.3; C-14; docs/PRICING-V2.md
 * §2.10; owner decision 2, DECISIONS rows 184 (2), 220).
 *
 * For guest, customer, merchant, assistant, full, legacy NULL and owner:
 *   - the GET projections hold: the owner reads every private figure (`v2_*`);
 *     a price editor reads final dinars, codes and names and — on a
 *     PRICE-FIRST product only — the dollar set it may edit (`editor_usd`, a
 *     key outside FINANCIAL_FIELDS); everyone else is refused at the admin door;
 *   - a price editor's dollars round-trip: what they type is what the writer
 *     stores, the cart charges it at U, the next read gives it back;
 *   - an editor writing the method or a cost field is 403 COST_ACCESS_DENIED
 *     naming the fields; dollars on a cost-first product are 403
 *     PRICING_V2_OWNER_ONLY {section: 3}; `intents` (retired) is 400 for all;
 *   - no non-owner answer carries a `v2_*` key, the applied rate or a COST
 *     sentinel; the dollar PRICE sentinels reach admins on a price-first
 *     product's pricing answers only, and the owner's read shows both (not vacuous);
 *   - the preview hash is the same for two different U values that give the
 *     same final prices at the same rate versions: it is not a U oracle.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2Roles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, put, type StubUser } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { legacyProductId } from './fixtures/legacyCatalogue';
import { cartGrid, v2App, writeV2 } from './fixtures/pricingV2';
import { ADMIN_ROLES, ROLES, OWNER, appFor, call, leaks, seededCopy, type MountSpec, type Router } from './fixtures/roleMatrix';
import { V2_COST_SENTINELS, V2_PRICE_SENTINELS, V2_SENTINELS } from './fixtures/fxSentinels';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { V2_STAFF_SEES_USD } from '../worker/lib/adminScope';
import { evaluateDesired, loadV2Read } from '../worker/lib/pricingEngine/v2/api';

const MODEL = `${AMS}_o0`;
const AMS2 = legacyProductId('bambu-lab-ams-2-pro');
const fixed = (usd: string) => ({ scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd });
const off = (usd: string) => ({ scope: 'product' as const, scope_id: '', usd });
const answer = async (res: Response) => ({ status: res.status, body: await json(res) });

const EDITORS: Record<string, StubUser> = {
  assistant: { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' },
  full: { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' },
  legacy_null: { id: 'usr_legacy', role: 'admin', email: 'legacy@x.co', admin_scope: null },
};
const OUTSIDERS: Record<string, StubUser | null> = {
  guest: null,
  customer: { id: 'u1', role: 'customer', email: 's@x.co' },
  merchant: { id: 'u_m', role: 'merchant', email: 'm@x.co' },
};

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}
const PRIVATE = new Set<string>(FINANCIAL_FIELDS);
const privateKeys = (body: unknown) => [...keysOf(body)].filter((k) => k.startsWith('v2_') || PRIVATE.has(k) || k === 'owner');

async function v2World() {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
  await writeV2(w.db, AMS2, {
    method: 'cost',
    inputs: { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 },
    minimumProfitUsd: '120',
    discounts: [off('50')],
  });
  return w;
}

test('Q2: the GET projections per role — owner everything, editors dinars plus the dollars of a price-first product, everyone else refused', async () => {
  const w = await v2World();
  const owner = await answer(await get(v2App(w.raw), `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(owner.status, 200);
  assert.ok(owner.body.v2_points && owner.body.v2_rate && owner.body.table[0].owner, 'the owner reads the private figures');
  assert.deepEqual(owner.body.editor_usd.points, [{ scope: 'product', id: '', kind: 'fixed', usd: '1000' }], 'and the same dollar block as every editor');
  assert.deepEqual(owner.body.can_edit, { money: true, cost: true, method: true, structure: true });
  for (const [role, user] of Object.entries(EDITORS)) {
    for (const pid of [AMS, AMS2]) {
      const r = await answer(await get(v2App(w.raw, user), `/api/admin/products-v2/${pid}/pricing`));
      assert.equal(r.status, 200, `${role} ${pid}`);
      assert.deepEqual(privateKeys(r.body), [], `${role} ${pid}: no private key`);
      assert.deepEqual(leaks(r.body), [], `${role} ${pid}`);
      // Never the applied rate (U = 1,600), on either product.
      assert.doesNotMatch(JSON.stringify(r.body), /"1600(\.0+)?"/, `${role} ${pid}: no rate`);
      assert.ok(r.body.table.length > 0 && r.body.table.every((row: { price_iqd: unknown }) => typeof row.price_iqd === 'number'), `${role} ${pid}: final dinars`);
    }
    const priceFirst = await answer(await get(v2App(w.raw, user), `/api/admin/products-v2/${AMS}/pricing`));
    assert.deepEqual(priceFirst.body.can_edit, { money: true, cost: false, method: false, structure: true });
    assert.deepEqual(priceFirst.body.editor_usd, { points: [{ scope: 'product', id: '', kind: 'fixed', usd: '1000' }], discounts: [{ scope: 'product', id: '', usd: '50' }] });
    const direct = priceFirst.body.table.find((row: { channel: string }) => row.channel === 'direct_sale');
    const land = priceFirst.body.table.find((row: { channel: string }) => row.channel === 'pre_order_land');
    assert.deepEqual([direct.editor_usd_price, land.editor_usd_price], ['1000', '950'], 'each channel’s exact dollars: the figures the editor typed, never a cost');
    const costFirst = await answer(await get(v2App(w.raw, user), `/api/admin/products-v2/${AMS2}/pricing`));
    assert.deepEqual(costFirst.body.can_edit, { money: false, cost: false, method: false, structure: true });
    assert.equal(costFirst.body.editor_usd, undefined, 'no dollar block on a cost-first product (D = R + T: a cost oracle)');
    assert.doesNotMatch(JSON.stringify(costFirst.body).replace('"method":"cost"', ''), /usd/i, `${role}: no dollar figure on a cost-first product`);
    assert.ok(costFirst.body.table.every((row: Record<string, unknown>) => row.discount_from === undefined), 'a cost-first route never says where its discount came from (the floor is an oracle)');
  }
  for (const [role, user] of Object.entries(OUTSIDERS)) {
    const r = await get(v2App(w.raw, user), `/api/admin/products-v2/${AMS}/pricing`);
    assert.ok(r.status === 401 || r.status === 403, `${role}: ${r.status}`);
    const p = await post(v2App(w.raw, user), '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: {} });
    assert.ok(p.status === 401 || p.status === 403, `${role} preview: ${p.status}`);
  }
  assert.equal(V2_STAFF_SEES_USD, true, 'owner answer Q2 (DECISIONS row 222): staff who may edit prices see and edit USD');
});

test('Q2: a price editor’s dollars round-trip — typed, stored, charged at U, read back', async () => {
  const w = await v2World();
  const editor = v2App(w.raw, EDITORS.full);
  const pricing = {
    points: [{ scope: 'product', id: '', kind: 'fixed', usd: '1093.75' }, { scope: 'option', id: MODEL, kind: 'fixed', usd: '1133.13' }],
    discounts: [{ scope: 'product', id: '', usd: '62.5' }, { scope: 'option', id: MODEL, usd: '70.63' }],
  };
  const pre = await answer(await post(editor, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing }));
  assert.equal(pre.status, 200, JSON.stringify(pre.body).slice(0, 300));
  assert.deepEqual(privateKeys(pre.body), []);
  const at = (ch: string) => pre.body.table.find((r: { channel: string }) => r.channel === ch);
  assert.equal(at('direct_sale').price_iqd, 1_814_000, 'the model’s dollars × U, rounded up once (1133.13 × 1,600)');
  assert.equal(at('direct_sale').editor_usd_price, '1133.13');
  assert.equal(at('pre_order_land').editor_usd_price, '1062.5');
  assert.equal(at('pre_order_land').price_iqd, 1_700_000);
  const put1 = await answer(await put(editor, `/api/admin/products-v2/${AMS}/pricing`, { seq: pre.body.seq, pricing, preview_hash: pre.body.review_hash }));
  assert.equal(put1.status, 200, JSON.stringify(put1.body).slice(0, 300));
  const grid = await cartGrid(w.db, AMS);
  assert.equal(grid[`o:${MODEL}@direct_sale`]!.prepaid, 1_814_000);
  assert.equal(grid[`o:${MODEL}@pre_order_land`]!.prepaid, 1_700_000);
  const back = await answer(await get(editor, `/api/admin/products-v2/${AMS}/pricing`));
  const sorted = (rows: Array<Record<string, string>>) => [...rows].sort((a, b) => `${a.scope}${a.id}`.localeCompare(`${b.scope}${b.id}`));
  assert.deepEqual(sorted(back.body.editor_usd.points), sorted(pricing.points));
  assert.deepEqual(sorted(back.body.editor_usd.discounts), sorted(pricing.discounts));
  // Following the product again: the model's own price and discount are gone, the product's apply.
  const follow = { points: [pricing.points[0]!], discounts: [pricing.discounts[0]!] };
  const pre2 = await answer(await post(editor, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: follow }));
  assert.equal(pre2.body.table.find((r: { channel: string }) => r.channel === 'direct_sale').price_iqd, 1_750_000);
  assert.equal(pre2.body.table.find((r: { channel: string }) => r.channel === 'pre_order_land').price_iqd, 1_650_000);
});

test('Q2: an editor writing the method or a cost field is refused by field name; dollars on a cost-first product are the owner’s; intents are gone', async () => {
  const w = await v2World();
  for (const [role, user] of Object.entries(EDITORS)) {
    const app = v2App(w.raw, user);
    const cases: Array<[unknown, string[]]> = [
      [{ method: 'cost' }, ['method']],
      [{ cost: { inputs: [], minimum_profit: '10' } }, ['cost.inputs', 'cost.minimum_profit']],
      [{ points: [{ scope: 'product', id: '', kind: 'fixed', usd: '1' }], cost: { minimum_profit: '10' } }, ['cost.minimum_profit']],
    ];
    for (const [pricing, fields] of cases) {
      for (const send of [
        () => post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing }),
        () => put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq: { inputs_seq: 0, write_seq: 0 }, pricing }),
      ]) {
        const r = await answer(await send());
        if (r.body.code === 'PRICING_CHANGED') continue; // the PUT's sequence is checked first; the preview proves the field rule
        assert.equal(r.status, 403, `${role} ${JSON.stringify(pricing)}: ${JSON.stringify(r.body).slice(0, 200)}`);
        assert.equal(r.body.code, 'COST_ACCESS_DENIED');
        assert.deepEqual(r.body.details.fields, fields);
        assert.deepEqual(leaks(r.body), []);
      }
    }
    for (const pricing of [{ points: [{ scope: 'product', id: '', kind: 'fixed', usd: '2000' }] }, { discounts: [] }]) {
      const cost = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS2, pricing }));
      assert.equal(cost.status, 403, JSON.stringify(cost.body).slice(0, 200));
      assert.equal(cost.body.code, 'PRICING_V2_OWNER_ONLY');
      assert.equal(cost.body.details.section, 3);
    }
    // The method equal to the product's own is no write: it passes.
    assert.equal((await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: { method: 'usd' } }))).status, 200);
  }
  // The dinar intents of the first V2-3b draft are retired for everyone.
  for (const user of [undefined, EDITORS.full]) {
    const r = await answer(await post(v2App(w.raw, user), '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: { intents: { direct_iqd: 1 } } }));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'PRICING_INPUT_INVALID');
    assert.equal(r.body.details.field, 'intents');
  }
});

test('the clean start: an editor opens a needs-pricing product as price-first and may publish it in dollars; the owner’s cost stays the owner’s', async () => {
  const w = pricingWorld();
  const editor = v2App(w.raw, EDITORS.assistant);
  const read = await answer(await get(editor, `/api/admin/products-v2/${AMS2}/pricing`));
  assert.equal(read.status, 200, JSON.stringify(read.body).slice(0, 300));
  assert.deepEqual([read.body.needs_pricing, read.body.method, read.body.default_method], [true, 'usd', 'usd']);
  assert.deepEqual(read.body.editor_usd, { points: [], discounts: [] }, 'nothing stored seeds a never-priced product');
  assert.deepEqual(privateKeys(read.body), []);
  const pricing = { method: 'usd', points: [{ scope: 'product', id: '', kind: 'fixed', usd: '1250' }] };
  const pre = await answer(await post(editor, '/api/admin/products-v2/pricing/preview', { product_id: AMS2, pricing }));
  assert.equal(pre.status, 200, JSON.stringify(pre.body).slice(0, 300));
  assert.equal(pre.body.publishable, true);
  const put1 = await answer(await put(editor, `/api/admin/products-v2/${AMS2}/pricing`, { seq: pre.body.seq, pricing, preview_hash: pre.body.review_hash }));
  assert.equal(put1.status, 200, JSON.stringify(put1.body).slice(0, 300));
  assert.deepEqual([put1.body.method, put1.body.needs_pricing], ['usd', false]);
  assert.deepEqual(privateKeys(put1.body), []);
});

test('C-14: the preview hash is the same for two U values that give the same final prices — never a rate oracle', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('999.37')], discounts: [off('50')] });
  const read = (await loadV2Read(w.db, AMS))!;
  const desired = { method: 'usd' as const, points: [fixed('999.37')], discounts: [off('50')], inputWrites: [], ruleWrites: [] };
  const a = await evaluateDesired(read, desired);
  const usd = read.rates!.central.fx.USD!;
  const nudged: typeof read = { ...read, rates: { ...read.rates!, usd_iqd: '1600.0001', central: { ...read.rates!.central, fx: { ...read.rates!.central.fx, USD: { ...usd, rate: '1600.0001' } } } } };
  const b = await evaluateDesired(nudged, desired);
  assert.deepEqual(a.plan.prices.map((p) => p.price.computed_price_iqd), b.plan.prices.map((p) => p.price.computed_price_iqd), 'the same final prices');
  assert.notEqual(a.rows[0]!.owner!.exact_iqd, b.rows[0]!.owner!.exact_iqd, 'different exact figures behind them');
  assert.equal(a.hash, b.hash, 'one hash: U is not in it');
});

/** The role matrix's costly product made V2 (price-first) over its V2_SENTINELS, inside the tokens. */
function seedV2Product(): DatabaseSync {
  const raw = seededCopy();
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:p_a1', 1), ('engine-price:p_a1', 1);
            INSERT INTO product_pricing_state (product_id, mode, pricing_method, v2_since, updated_at) VALUES ('p_a1', 'engine', 'usd', '2026-10-13T12:00:00.000Z', '2026-10-13T12:00:00.000Z')
              ON CONFLICT(product_id) DO UPDATE SET mode = 'engine', pricing_method = 'usd', v2_since = excluded.v2_since;
            DELETE FROM ops_guards WHERE id IN ('pricing-mode:p_a1', 'engine-price:p_a1');`);
  return raw;
}

test('§8 / A.12.3: no non-owner V2 answer carries a cost sentinel, a private key or the rate; dollar price sentinels reach admins on the price-first product only — and the owner’s read shows both (not vacuous)', async () => {
  const cost = { decimals: [...V2_COST_SENTINELS], numbers: V2_COST_SENTINELS.map(Number) };
  const price = { decimals: [...V2_PRICE_SENTINELS], numbers: V2_PRICE_SENTINELS.map(Number) };
  const all = { decimals: [...V2_SENTINELS], numbers: V2_SENTINELS.map(Number) };
  const mounts: readonly MountSpec[] = [['/api/admin/products-v2', adminProductsRoutes as Router]];
  const paths: Array<[string, string, unknown?]> = [
    ['GET', '/api/admin/products-v2/p_a1/pricing'],
    ['POST', '/api/admin/products-v2/pricing/preview', { product_id: 'p_a1', pricing: {} }],
    ['POST', '/api/admin/products-v2/pricing/preview', { product_id: 'p_a1', pricing: { intents: { direct_iqd: 1_000_000 } } }],
    ['PUT', '/api/admin/products-v2/p_a1/pricing', { seq: { inputs_seq: 0, write_seq: 0 }, pricing: {} }],
  ];
  for (const [role, user] of Object.entries({ ...ROLES, owner: OWNER })) {
    const app = appFor(seedV2Product(), user ?? null, mounts);
    const admin = (ADMIN_ROLES as readonly string[]).includes(role);
    let seen = 0;
    for (const [method, path, body] of paths) {
      const r = await call(app, method, path, body);
      if (role === 'owner') {
        if (method === 'GET') {
          assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
          assert.ok(leaks(r.body, all).some((l) => /987\.65|61\.73|43\.21/.test(l)), 'the owner\u2019s read shows the stored dollars');
          seen += 1;
        }
        continue;
      }
      assert.deepEqual(leaks(r.body, cost), [], `${role} ${method} ${path}: a cost sentinel`);
      assert.deepEqual(privateKeys(r.body), [], `${role} ${method} ${path}: private keys`);
      if (!admin) assert.deepEqual(leaks(r.body, price), [], `${role} ${method} ${path}: a dollar price outside the admin door`);
      if (admin && method === 'GET') {
        assert.equal(r.status, 200, `${role}: ${JSON.stringify(r.body).slice(0, 200)}`);
        assert.ok(leaks(r.body, price).length > 0, `${role}: a price editor reads the price-first product's dollars (not vacuous)`);
        seen += 1;
      }
      if (r.status === 200) assert.doesNotMatch(JSON.stringify(r.body), /usd_iqd|"rate"|"1562\.5"/i, `${role} ${method} ${path}`);
    }
    if (role === 'owner' || admin) assert.equal(seen, 1, role);
  }
  void asD1;
});
