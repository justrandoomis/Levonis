/**
 * /api/admin/pricing — «التسعير والشحن» P1, the router (MVP plan §6 P1).
 *
 *   - the owner reads the overview (20 a page, the §2.3 counts), one product
 *     (today's prices per model × channel, prepaid and cash on delivery, the
 *     old landed cost, the derived minimum profit and Direct Sale Extra, the rules named
 *     by kind, the measures, the rate reference) and runs the what-if, whose
 *     price is E1's exact maths on the owner's figures;
 *   - validation names fields, never values (UNKNOWN_FIELD, PRICING_INPUT_INVALID);
 *   - typed PRIME/PRO prices are reported yes/no;
 *   - every other admin hears COST_ACCESS_DENIED, the same bytes for a real and
 *     an invented id; a customer is refused at the admin door, a guest is 401;
 *     the owner's unverified session hears OWNER_EMAIL_UNVERIFIED;
 *   - through the whole Worker: anonymous → 401 (the live probe's verdict), a
 *     cross-origin write is refused, a merchant host never reaches it, and the
 *     owner's answers are `private, no-store`.
 *
 * Run: node --import tsx --test tests/adminPricingRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, MERCHANT_HOST, OWNER, asD1, ctx, freshDb, stubApp, type StubUser } from './fixtures/app';
import { ROLES, call, type MatrixApp } from './fixtures/roleMatrix';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { serverMessage } from '../packages/contracts/src/costRefusals';
import { ceilStep } from '../packages/pricing/src/costToPrice';
import { sha256Hex } from '../worker/lib/crypto';
import worker from '../worker/index';

function db(): DatabaseSync {
  const raw = freshDb();
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  return raw;
}

const appAs = (raw: DatabaseSync, user: StubUser | null, host?: string): MatrixApp =>
  stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
    },
    host ? { host } : {}
  );

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Every key at any depth. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}

const AMS_HT = 'lp_08'; // census row 8: one model, land, a direct cell at +50,000, no fee

// ------------------------------------------------------------------ overview

test('overview: 41 products, 20 a page, the §2.3 counts over all of them, private and never stored', async () => {
  const app = appAs(db(), OWNER);
  const pages: Json[] = [];
  for (const page of [1, 2, 3]) {
    const res = await call(app, 'GET', `/api/admin/pricing/overview?page=${page}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    pages.push(res.body as Json);
  }
  const [p1, p2, p3] = pages as [Json, Json, Json];
  assert.deepEqual([p1.success, p1.preview_only, p1.total, p1.pages, p1.page_size], [true, true, 41, 3, 20]);
  assert.deepEqual(pages.map((p) => p.products.length), [20, 20, 1]);
  const all = [...p1.products, ...p2.products, ...p3.products] as Json[];
  assert.equal(new Set(all.map((p) => p.id)).size, 41);
  // The counts cover every product, not only the page; nothing is ready to switch in P1.
  const counts = Object.fromEntries((p1.status_counts as Json[]).map((s) => [s.migration_status, s.count]));
  assert.deepEqual(Object.keys(counts), ['CONFLICT', 'TARGET_PROFIT_REVIEW_REQUIRED', 'NEEDS_MANUAL_REVIEW', 'WAITING_FOR_SUPPLIER_COST', 'READY_TO_SWITCH', 'READY']);
  assert.equal(Object.values(counts).reduce((a: number, b) => a + (b as number), 0), 41);
  for (const [status, n] of Object.entries(counts)) assert.equal(all.filter((p) => p.migration_status === status).length, n, status);
  assert.equal(counts.READY_TO_SWITCH + counts.READY, 0);
  // A page out of range answers the last page; garbage answers the first.
  assert.equal(((await call(app, 'GET', '/api/admin/pricing/overview?page=99')).body as Json).page, 3);
  assert.equal(((await call(app, 'GET', '/api/admin/pricing/overview?page=zz')).body as Json).page, 1);
  // Rules are named by kind everywhere: no answer carries `amount_iqd`.
  assert.equal(keysOf(p1).has('amount_iqd'), false);
});

// ------------------------------------------------------------------ one product

test('one product: today’s price per channel (prepaid and COD), the landed cost, the derived values, rules by kind, the rate reference', async () => {
  const res = await call(appAs(db(), OWNER), 'GET', `/api/admin/pricing/products/${AMS_HT}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const body = res.body as Json;
  assert.equal(body.preview_only, true);
  assert.deepEqual([body.product.slug, body.product.migration_status, body.product.channel_mix, body.product.routes], ['bambu-lab-ams-ht', 'WAITING_FOR_SUPPLIER_COST', 'BOTH', ['land']]);
  const [model] = body.models as Json[];
  const byChannel = Object.fromEntries((model!.channels as Json[]).map((c) => [c.channel, c]));
  // B = 450,000 (row 8), cost 423,000, direct cell 500,000, land route without a fee.
  assert.deepEqual(
    [byChannel.direct_sale.today_item_iqd, byChannel.direct_sale.today_prepaid_iqd, byChannel.direct_sale.landed_cost_iqd],
    [500_000, 500_000, 423_000]
  );
  assert.deepEqual(
    [byChannel.pre_order_land.today_item_iqd, byChannel.pre_order_land.today_fee_iqd, byChannel.pre_order_land.today_prepaid_iqd],
    [450_000, 0, 450_000]
  );
  // Cash on delivery of the pre-order is priced as the direct sale (an enabled direct cell, V4).
  assert.deepEqual([byChannel.pre_order_land.today_cod_iqd, byChannel.pre_order_land.cod_priced_as_direct], [500_000, true]);
  assert.deepEqual([model!.target.migration_state, model!.target.target_profit_iqd], ['MIGRATED', 27_000]);
  assert.deepEqual([model!.direct_sale_extra.migration_state, model!.direct_sale_extra.direct_sale_extra_iqd], ['MIGRATED', 50_000]);
  assert.equal(model!.base_route, 'land');
  assert.equal(model!.roundtrip_ok, true);
  assert.deepEqual(model!.suggested_measures, {
    // The model's own package weight wins over the product's (the most specific level).
    shipping_weight_g: 1_200,
    weight_scope: 'option',
    shipping_length_mm: 400,
    shipping_width_mm: 300,
    shipping_height_mm: 207,
    box_scope: 'base',
    calculated_cbm: '0.02484',
  });
  assert.deepEqual(
    (model!.missing as Json[]).map((m) => `${m.channel}:${m.code}`).sort(),
    ['direct_sale:SUPPLIER_COST_MISSING', 'direct_sale:SUPPLIER_CURRENCY_MISSING', 'pre_order_land:SUPPLIER_COST_MISSING', 'pre_order_land:SUPPLIER_CURRENCY_MISSING']
  );
  // The placement, named by kind.
  assert.deepEqual(body.legacy_rules, [
    { kind: 'target_profit', scope: 'product', scope_id: '', state: 'ACTIVE', source: 'LEGACY_MIGRATION', target_profit_iqd: 27_000 },
    { kind: 'direct_sale_extra', scope: 'product', scope_id: '', state: 'ACTIVE', source: 'LEGACY_MIGRATION', direct_sale_extra_iqd: 50_000 },
  ]);
  assert.equal(keysOf(body).has('amount_iqd'), false);
  // The rate reference: from the purchase profiles, never confirmed, no USD; CNY from the newer China profile.
  assert.deepEqual(
    (body.fx_rates as Json[]).map((r) => [r.currency, r.rate_iqd, r.confirmed, r.rate_origin]),
    [
      ['USD', null, false, 'procurement_profiles'],
      ['EUR', '1610.25', false, 'procurement_profiles'],
      ['CNY', '206.25', false, 'procurement_profiles'],
    ]
  );
  assert.deepEqual(
    (body.shipping_rates as Json[]).map((r) => [r.profile, r.basis, r.rate_iqd, r.confirmed]),
    [
      ['GERMANY_LAND', 'weight', '9000', false],
      ['CHINA_AIR', 'weight', '14000', false],
      ['CHINA_SEA', 'volume', '350000', false],
    ]
  );
});

test('the rate reference follows 0179’s seed rule: the newer China profile gives CNY, an out-of-range rate is missing', async () => {
  const raw = db();
  raw.exec("UPDATE procurement_cost_profiles SET updated_at = '2026-09-09T00:00:00.000Z' WHERE id = 'china_air'");
  raw.exec("UPDATE procurement_cost_profiles SET shipping_rate_iqd = 0 WHERE id = 'germany_land'");
  const body = (await call(appAs(raw, OWNER), 'GET', `/api/admin/pricing/products/${AMS_HT}`)).body as Json;
  assert.equal((body.fx_rates as Json[]).find((r) => r.currency === 'CNY')!.rate_iqd, '205.5');
  assert.equal((body.shipping_rates as Json[]).find((r) => r.profile === 'GERMANY_LAND')!.rate_iqd, null);
});

test('typed PRIME/PRO prices are reported yes/no, product by product and in the overview count', async () => {
  const raw = db();
  const app = appAs(raw, OWNER);
  const before = (await call(app, 'GET', '/api/admin/pricing/overview')).body as Json;
  assert.equal(before.typed_member_price_products, 0);
  raw.exec("UPDATE products SET prime_price_iqd = 440000 WHERE id = 'lp_08'");
  raw.exec("UPDATE product_option_fulfillment SET pro_adjust_iqd = -5000 WHERE id = 'lp_09_o0_d'");
  const after = (await call(app, 'GET', '/api/admin/pricing/overview')).body as Json;
  assert.equal(after.typed_member_price_products, 2);
  const one = ((await call(app, 'GET', '/api/admin/pricing/products/lp_08')).body as Json).product;
  assert.equal(one.typed_member_prices, true);
  assert.ok(one.info_codes.includes('LEGACY_MEMBER_PRICE_DROPPED'));
  const clean = ((await call(app, 'GET', '/api/admin/pricing/products/lp_10')).body as Json).product;
  assert.equal(clean.typed_member_prices, false);
});

test('an unknown product is 404; a bundle is never engine-priced (409 COMPOSITION_NOT_PRICEABLE)', async () => {
  const raw = db();
  raw.exec("INSERT INTO products (id, slug, name, status, price_iqd, composition) VALUES ('bdl_1', 'starter', 'Starter', 'active', 900000, 'bundle')");
  const app = appAs(raw, OWNER);
  assert.equal((await call(app, 'GET', '/api/admin/pricing/products/zz-no-such')).status, 404);
  const bundle = await call(app, 'GET', '/api/admin/pricing/products/bdl_1');
  assert.deepEqual([bundle.status, (bundle.body as Json).code], [409, 'COMPOSITION_NOT_PRICEABLE']);
  assert.equal(bundle.headers.get('cache-control'), 'private, no-store');
  // …and the overview leaves it out.
  assert.equal(((await call(app, 'GET', '/api/admin/pricing/overview')).body as Json).total, 41);
});

// ------------------------------------------------------------------ the what-if

const whatIf = (app: MatrixApp, id: string, body: unknown) => call(app, 'POST', `/api/admin/pricing/products/${id}/what-if`, body);

test('what-if: E1’s exact price on the owner’s figures, next to today’s, with the change — and the unconfirmed rates as warnings', async () => {
  const res = await whatIf(appAs(db(), OWNER), AMS_HT, { supplier_cost: '500', currency: 'EUR' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const body = res.body as Json;
  assert.deepEqual(body.inputs, { scope: 'base', scope_id: '', supplier_cost: '500', supplier_currency: 'EUR', additional_cost_iqd: null });
  const ch = Object.fromEntries((body.models[0].channels as Json[]).map((c) => [c.channel, c]));
  // R_exact = 500 × 1,610.25 + 1.2 kg (the model's package) × 9,000 = 815,925;
  // land = ceil_1000(815,925 + 27,000) = 843,000.
  const land = ceilStep(805_125 + 10_800 + 27_000);
  assert.equal(land, 843_000);
  assert.deepEqual(
    [ch.pre_order_land.computed_price_iqd, ch.pre_order_land.replacement_cost_iqd, ch.pre_order_land.replacement_exact, ch.pre_order_land.target_profit_iqd],
    [843_000, 815_925, '815925', 27_000]
  );
  assert.deepEqual([ch.pre_order_land.today_prepaid_iqd, ch.pre_order_land.change_iqd], [450_000, 393_000]);
  // Direct = the base profile's pre-order price + the 50,000 Direct Sale Extra.
  assert.deepEqual([ch.direct_sale.computed_price_iqd, ch.direct_sale.direct_sale_extra_iqd, ch.direct_sale.change_iqd], [893_000, 50_000, 393_000]);
  assert.deepEqual(ch.pre_order_land.issue_codes, ['FX_RATE_UNCONFIRMED', 'SHIPPING_RATE_UNCONFIRMED']);
  assert.equal(keysOf(body).has('amount_iqd'), false);
});

test('what-if: the owner’s rates and measures lay over the reference; USD needs a rate', async () => {
  const app = appAs(db(), OWNER);
  const rated = (await whatIf(app, AMS_HT, { supplier_cost: '500', currency: 'EUR', rates: { fx: { EUR: '1500' } } })).body as Json;
  const land = (rated.models[0].channels as Json[]).find((c) => c.channel === 'pre_order_land')!;
  assert.equal(land.computed_price_iqd, ceilStep(750_000 + 10_800 + 27_000));
  assert.deepEqual((rated.fx_rates as Json[]).find((r) => r.currency === 'EUR'), { currency: 'EUR', rate_iqd: '1500', confirmed: false, rate_origin: 'what_if' });

  const usd = (await whatIf(app, AMS_HT, { supplier_cost: '400', currency: 'USD' })).body as Json;
  const usdLand = (usd.models[0].channels as Json[]).find((c) => c.channel === 'pre_order_land')!;
  assert.equal(usdLand.computed_price_iqd, null);
  assert.ok(usdLand.issue_codes.includes('FX_RATE_MISSING'));
  const withUsd = (await whatIf(app, AMS_HT, { supplier_cost: '400', currency: 'USD', rates: { fx: { USD: '1310' } } })).body as Json;
  assert.equal((withUsd.models[0].channels as Json[]).find((c) => c.channel === 'pre_order_land')!.computed_price_iqd, ceilStep(524_000 + 10_800 + 27_000));

  // A heavier box by weight: the owner's measure wins over the public one.
  const heavy = (await whatIf(app, AMS_HT, { supplier_cost: '500', currency: 'EUR', measures: { weight_g: 3_000 } })).body as Json;
  assert.equal((heavy.models[0].channels as Json[]).find((c) => c.channel === 'pre_order_land')!.effective_weight_g, 3_000);
});

test('what-if on one model of a product: option scope, that model only; a model held for review gets no price', async () => {
  const app = appAs(db(), OWNER);
  const all = (await whatIf(app, 'lp_04', { supplier_cost: '600', currency: 'EUR' })).body as Json;
  assert.equal(all.models.length, 2);
  // a1 model 2 is held (COST_LESS_SPECIFIC_THAN_PRICE): its minimum profit is BLOCKED, so no price.
  const held = (all.models[1].channels as Json[])[0];
  assert.equal(held.computed_price_iqd, null);
  assert.ok(held.issue_codes.includes('TARGET_PROFIT_BLOCKED'));
  const one = (await whatIf(app, 'lp_04', { supplier_cost: '600', currency: 'EUR', option_id: 'lp_04_o0' })).body as Json;
  assert.deepEqual([one.inputs.scope, one.inputs.scope_id, one.models.length], ['option', 'lp_04_o0', 1]);
  assert.ok((one.models[0].channels as Json[]).every((c) => typeof c.computed_price_iqd === 'number'));
});

test('what-if validation names the field, never the value: UNKNOWN_FIELD and PRICING_INPUT_INVALID', async () => {
  const app = appAs(db(), OWNER);
  const unknown = await whatIf(app, AMS_HT, { supplier_cost: '10', currency: 'EUR', price_iqd: 1, measures: { colour: 'x' } });
  assert.deepEqual([unknown.status, (unknown.body as Json).code, (unknown.body as Json).details], [400, 'UNKNOWN_FIELD', { fields: ['price_iqd'] }]);
  const nested = await whatIf(app, AMS_HT, { supplier_cost: '10', currency: 'EUR', measures: { colour: 'x' } });
  assert.deepEqual((nested.body as Json).details, { fields: ['measures.colour'] });
  const cases: Array<[unknown, string]> = [
    [{ supplier_cost: 412.5, currency: 'EUR' }, 'supplier_cost'],
    [{ supplier_cost: '-412.5', currency: 'EUR' }, 'supplier_cost'],
    [{ supplier_cost: '0', currency: 'EUR' }, 'supplier_cost'],
    [{ supplier_cost: '412.12345', currency: 'EUR' }, 'supplier_cost'],
    [{ supplier_cost: '4e2', currency: 'EUR' }, 'supplier_cost'],
    [{ currency: 'EUR' }, 'supplier_cost'],
    [{ supplier_cost: '412.5', currency: 'GBP' }, 'supplier_currency'],
    [{ supplier_cost: '412.5', currency: 'EUR', measures: { length_mm: 300 } }, 'shipping_box'],
    [{ supplier_cost: '412.5', currency: 'EUR', measures: { weight_g: 1.5 } }, 'shipping_weight_g'],
    [{ supplier_cost: '412.5', currency: 'EUR', measures: { shipping_profile: 'MOON' } }, 'shipping_profile'],
    [{ supplier_cost: '412.5', currency: 'EUR', additional_cost_iqd: -1 }, 'additional_cost_iqd'],
    [{ supplier_cost: '412.5', currency: 'EUR', rates: { fx: { EUR: 1500 } } }, 'fx_rate'],
    [{ supplier_cost: '412.5', currency: 'EUR', option_id: 'lp_05_o0' }, 'option_id'],
  ];
  for (const [body, field] of cases) {
    const res = await whatIf(app, AMS_HT, body);
    const b = res.body as Json;
    assert.deepEqual([res.status, b.code, b.details], [400, 'PRICING_INPUT_INVALID', { field }], JSON.stringify(body));
    assert.doesNotMatch(String(b.error), /412|4e2|GBP|MOON/, 'the refusal never echoes the value');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
});

// ------------------------------------------------------------------ who may ask

test('every other admin hears COST_ACCESS_DENIED — the same bytes for a real id, an invented one and a tampered query; customers and guests never reach it', async () => {
  const raw = db();
  for (const role of ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'] as const) {
    const app = appAs(raw, ROLES[role]);
    const bodies: string[] = [];
    for (const [method, path] of [
      ['GET', '/api/admin/pricing/overview'],
      ['GET', `/api/admin/pricing/products/${AMS_HT}`],
      ['GET', '/api/admin/pricing/products/zz-no-such-id'],
      ['GET', `/api/admin/pricing/products/${AMS_HT}?include=cost&role=owner`],
      ['POST', `/api/admin/pricing/products/${AMS_HT}/what-if`],
      ['POST', '/api/admin/pricing/products/zz-no-such-id/what-if'],
    ] as const) {
      const res = await call(app, method, path, method === 'POST' ? { supplier_cost: '10', currency: 'EUR' } : undefined);
      assert.equal(res.status, 403, `${role} ${method} ${path}`);
      assert.equal((res.body as Json).code, 'COST_ACCESS_DENIED');
      assert.equal((res.body as Json).error, serverMessage('COST_ACCESS_DENIED'));
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      bodies.push(JSON.stringify(res.body));
    }
    assert.equal(new Set(bodies).size, 1, `${role}: the refusal differs between routes or ids`);
  }
  for (const role of ['customer', 'merchant', 'employee', 'investor'] as const) {
    const res = await call(appAs(raw, ROLES[role]), 'GET', `/api/admin/pricing/products/${AMS_HT}`);
    assert.equal(res.status, 403, role);
    assert.notEqual((res.body as Json).code, 'OWNER_EMAIL_UNVERIFIED');
  }
  assert.equal((await call(appAs(raw, null), 'GET', '/api/admin/pricing/overview')).status, 401);
  // The owner before the address is verified: the way out, no cost.
  const unverified = await call(appAs(raw, { ...OWNER, email_verified_at: null }), 'GET', `/api/admin/pricing/products/${AMS_HT}`);
  assert.deepEqual([unverified.status, (unverified.body as Json).code], [403, 'OWNER_EMAIL_UNVERIFIED']);
  // A merchant host never reaches administration (404, as every /api/admin route).
  assert.equal((await call(appAs(raw, OWNER, MERCHANT_HOST), 'GET', '/api/admin/pricing/overview')).status, 404);
});

test('the router itself marks every answer private, no-store — its own refusals included, without the /api/admin layer', async () => {
  const raw = db();
  const bare = (user: StubUser | null) => stubApp(asD1(raw), user, (a) => a.route('/api/admin/pricing', adminPricingRoutes));
  for (const [user, status] of [[null, 401], [ROLES.customer, 403], [ROLES.full, 403], [OWNER, 200]] as const) {
    const res = await call(bare(user), 'GET', '/api/admin/pricing/overview');
    assert.equal(res.status, status);
    assert.equal(res.headers.get('cache-control'), 'private, no-store', `${user?.id ?? 'guest'}`);
  }
});

// ------------------------------------------------------------------ the whole Worker

async function viaWorker(raw: DatabaseSync, path: string, init: { method?: string; cookie?: string; origin?: string; body?: unknown; host?: string } = {}) {
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  const headers: Record<string, string> = { Host: init.host ?? APEX, accept: 'application/json', 'CF-Connecting-IP': '9.9.9.9' };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.origin) headers.Origin = init.origin;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(
    new Request(`https://${init.host ?? APEX}${path}`, { method: init.method ?? 'GET', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined }),
    env as never,
    ctx
  );
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

async function ownerSession(raw: DatabaseSync): Promise<string> {
  raw.exec("INSERT INTO users (id, name, email, password_hash, role, admin_scope, email_verified_at) VALUES ('usr_owner', 'Owner', 'boss@x.co', 'h', 'admin', NULL, '2026-01-01T00:00:00.000Z')");
  const token = `pricing-test-${Math.random().toString(36).slice(2)}`;
  raw.prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), 'usr_owner', new Date(Date.now() + 86_400_000).toISOString(), 'test');
  return `levonis_session=${token}`;
}

test('the whole Worker: anonymous → 401 (the live probe), the owner is served private, no-store, a cross-origin what-if is refused', async () => {
  const raw = db();
  const anon = await viaWorker(raw, '/api/admin/pricing/overview');
  assert.equal(anon.status, 401);
  const cookie = await ownerSession(raw);
  const overview = await viaWorker(raw, '/api/admin/pricing/overview', { cookie });
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get('cache-control'), 'private, no-store');
  assert.equal(overview.json.total, 41);
  const same = await viaWorker(raw, `/api/admin/pricing/products/${AMS_HT}/what-if`, { method: 'POST', cookie, origin: `https://${APEX}`, body: { supplier_cost: '500', currency: 'EUR' } });
  assert.equal(same.status, 200);
  assert.equal(same.headers.get('cache-control'), 'private, no-store');
  const cross = await viaWorker(raw, `/api/admin/pricing/products/${AMS_HT}/what-if`, { method: 'POST', cookie, origin: 'https://evil.example', body: { supplier_cost: '500', currency: 'EUR' } });
  assert.equal(cross.status, 403);
  assert.equal(JSON.stringify(cross.json).includes('843000'), false, 'a refused cross-origin call carries no price');
  // A storefront host shares the cookie and never reaches the owner's screen.
  const merchant = await viaWorker(raw, '/api/admin/pricing/overview', { cookie, host: MERCHANT_HOST });
  assert.equal(merchant.status, 404);
});
