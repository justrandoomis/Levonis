/**
 * THE ROLE MATRIX: every GET route a cost could travel through, swept as every
 * caller who must see none — owner decision 2 (2026-10-07), step S1.
 *
 * tests/costLeaksPhase0.test.ts pins the leaks the audit found, one by one.
 * This file is the net for the ones nobody has found yet: it mounts every
 * product-, cart-, order-, wallet-, inventory-, procurement-, pricing- and
 * finance-facing router the way worker/index.ts does (every `/api/admin/*`
 * mount included — tests/fixtures/roleMatrix.ts `BASE_MOUNTS`), enumerates
 * each one's GET routes from Hono itself (so a route added tomorrow is swept
 * tomorrow), fills the path parameters with the seeded product, lot, purchase
 * and order, and calls each as every role of the fixture:
 *
 *   guest, customer, merchant, assistant, full, legacy_null, grantee_off,
 *   employee, investor, support_assistant
 *
 * Any 2xx answer is walked to its last leaf. It fails on a key naming cost
 * that carries a number, on ANY key of FINANCIAL_FIELDS that carries a value,
 * and on any value — number, decimal, or digits inside a string such as an
 * exported .txt or .csv — equal to one of the seeded costs. A refusal is a
 * pass: what is not served cannot leak.
 *
 * `full` and `legacy_null` are the two that saw every cost before S1. They
 * keep their money screens (asserted below) and see no cost. The owner is
 * swept in the opposite direction: the seeded costs must reach the owner on
 * the screens that exist to show them, or the fixture is not reaching the
 * places this file claims to search.
 *
 * «التسعير التقديري» (docs/SMART_PRICING.md §3.4, §4.8; DECISIONS rows 278–282)
 * mounts the supplier price catalogue and the estimator inside the pricing
 * router, so the sweeps reach them with it. Their owner-only refusals are
 * pinned twice: on the sweep's own database, and on one that holds what the
 * owner's catalogue and estimator hold once he uses them — supplier prices, a
 * match, his typed price, a type's figures and a stored preview — where the
 * owner reads every one of them and every other caller is refused at the door,
 * hears nothing of them, and writes nothing.
 *
 * Run: node --import tsx --test tests/costRoleMatrix.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  BASE_MOUNTS,
  OWNER,
  OWNER_UNVERIFIED,
  ROLES,
  appFor,
  call,
  getPaths,
  leaks,
  seededCopy,
  seededCopyUnverifiedOwner,
  sweepGets,
  type RoleName,
  type SweepResult,
} from './fixtures/roleMatrix';
import { get as getPath, json as jsonOf, post as postPath } from './fixtures/app';
import { LEGACY_NUMBERS } from './fixtures/catalogOnly';

const PATHS = getPaths();

/** One sweep per role, computed once and shared by the tests that read it. */
const cache = new Map<string, Promise<SweepResult>>();
function sweep(role: RoleName | 'owner' | 'owner_unverified'): Promise<SweepResult> {
  let p = cache.get(role);
  if (!p) {
    // The owner before the address is verified reads a database whose owner
    // row carries no stamp either (DECISIONS row 185 amendment).
    p =
      role === 'owner_unverified'
        ? sweepGets({ roles: { [role]: OWNER_UNVERIFIED }, seed: seededCopyUnverifiedOwner }).then((r) => r[role]!)
        : sweepGets({ roles: { [role]: role === 'owner' ? OWNER : ROLES[role] } }).then((r) => r[role]!);
    cache.set(role, p);
  }
  return p;
}

/** How many 2xx answers each role must at least reach — a sweep that reaches nothing proves nothing. */
const FLOOR: Record<RoleName, number> = {
  guest: 25,
  customer: 50,
  merchant: 50,
  assistant: 150,
  full: 150,
  legacy_null: 150,
  grantee_off: 150,
  employee: 50,
  investor: 50,
  support_assistant: 150,
};

test('the sweep reaches a real number of routes, every /api/admin mount included (or it proves nothing)', () => {
  assert.ok(PATHS.length > 300, `only ${PATHS.length} GET paths were enumerated`);
  const prefixes = new Set(BASE_MOUNTS.map(([p]) => p));
  for (const p of ['/api/admin/finance', '/api/admin/community', '/api/admin/wallet-adjust', '/api/admin/chats', '/api/admin/media', '/api/invest', '/api/wallet']) {
    assert.ok(prefixes.has(p), `${p} is mounted in the sweep`);
  }
});

for (const role of Object.keys(ROLES) as RoleName[]) {
  test(`no GET answer to ${role} carries a cost (${PATHS.length} paths)`, async () => {
    const r = await sweep(role);
    assert.ok(r.answered >= FLOOR[role], `only ${r.answered} routes answered ${role} — the sweep is not reaching anything`);
    assert.deepEqual(r.leaks, [], `cost reached ${role}:\n${r.leaks.join('\n')}`);
  });
}

test('DECISIONS row 185 amendment — the owner BEFORE the address is verified: no GET answer or refusal carries a cost, and every cost door says OWNER_EMAIL_UNVERIFIED', async () => {
  const r = await sweep('owner_unverified');
  assert.ok(r.answered >= 150, `only ${r.answered} routes answered the unverified owner — the sweep is not reaching anything`);
  assert.deepEqual(r.leaks, [], `cost reached the unverified owner:\n${r.leaks.join('\n')}`);
  // Never the generic refusal: every door that refuses this session names the way out.
  const generic = Object.entries(r.codes).filter(([, c]) => c === 'COST_ACCESS_DENIED').map(([p]) => p);
  assert.deepEqual(generic, [], 'a cost door answered the unverified owner with COST_ACCESS_DENIED instead of OWNER_EMAIL_UNVERIFIED');
  const owner = await sweep('owner');
  const problems: string[] = [];
  let wayOut = 0;
  for (const path of owner.costSeen) {
    const status = r.statuses[path];
    if (status === undefined || status >= 500) problems.push(`${path}: ${status}`);
    else if (status === 403) {
      if (r.codes[path] !== 'OWNER_EMAIL_UNVERIFIED') problems.push(`${path}: 403 ${r.codes[path]}`);
      else wayOut += 1;
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(wayOut >= 5, `the unverified owner was shown the way out on only ${wayOut} of the owner's cost screens`);
  // The finance screens are shut to this session, every one of them, with the way out.
  const finance = PATHS.filter((p) => /^\/api\/admin\/(finance|finance-workspace|finance-people|finance-operations)(\/|$)/.test(p));
  const open = finance.filter((p) => r.statuses[p] !== 403 || r.codes[p] !== 'OWNER_EMAIL_UNVERIFIED');
  assert.deepEqual(open, []);
});

test('the owner sees the seeded costs where they live: the product, the lot, the order, the finance screens', async () => {
  const r = await sweep('owner');
  for (const path of [
    '/api/admin/products-v2/p_a1',
    // The clean start (spec addendum A.6): the price grid is a closed V1 door (409 PRICING_V2_MANAGED).
    '/api/admin/inventory/overview',
    '/api/admin/inventory/incoming',
    '/api/admin/finance-workspace/orders/ord1',
    '/api/admin/finance-workspace/summary',
    '/api/admin/finance-operations/orders/ord1/profit',
    '/api/admin/template/export/p_a1',
  ]) {
    assert.ok(r.costSeen.includes(path), `the owner saw no cost on ${path} — the fixture no longer reaches it`);
  }
  assert.ok(r.costSeen.length >= 15, `the owner saw cost on only ${r.costSeen.length} routes: ${r.costSeen.join(', ')}`);
});

test('wherever the owner saw a cost, every non-owner admin got a refusal or a clean answer — and never a crash', async () => {
  const owner = await sweep('owner');
  const problems: string[] = [];
  for (const role of ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'] as const) {
    const r = await sweep(role);
    for (const path of owner.costSeen) {
      const status = r.statuses[path];
      if (status === undefined || status >= 500) problems.push(`${role} ${path}: ${status}`);
    }
    // The clean-answer half is the leak sweep above; this prints where they stood.
    const refused = owner.costSeen.filter((p) => r.statuses[p] === 403);
    assert.ok(refused.length > 0, `${role} was refused nowhere the owner saw cost`);
  }
  assert.deepEqual(problems, []);
});

test('decision 2 keeps MONEY with full and legacy admins: their money screens answer, an assistant’s do not', async () => {
  const money = [
    '/api/admin/wallet-adjust/rounding-drift',
    '/api/admin/community/payouts',
    '/api/admin/community/reconciliation/store-orders',
    '/api/admin/community/ledger/parity',
  ];
  for (const role of ['full', 'legacy_null', 'grantee_off'] as const) {
    const r = await sweep(role);
    for (const p of money) assert.equal(r.statuses[p], 200, `${role} keeps ${p}`);
  }
  const a = await sweep('assistant');
  for (const p of money) assert.equal(a.statuses[p], 403, `an assistant is refused ${p}`);
});

test('the finance screens are the owner’s alone: full and legacy admins are refused at the door', async () => {
  const owner = await sweep('owner');
  const finance = PATHS.filter((p) =>
    /^\/api\/admin\/(finance|finance-workspace|finance-people|finance-operations)(\/|$)/.test(p)
  );
  assert.ok(finance.length > 20);
  for (const role of ['full', 'legacy_null', 'grantee_off'] as const) {
    const r = await sweep(role);
    const open = finance.filter((p) => r.statuses[p] !== 403);
    assert.deepEqual(open, [], `${role} reached a finance route`);
  }
  assert.ok(finance.filter((p) => owner.statuses[p] === 200).length > 15, 'the owner reaches them');
});

test('«التسعير والشحن» (pricing engine MVP P1): the owner reads the counts there, its V1 product door is closed; every other admin is refused at its door with COST_ACCESS_DENIED; customers and guests never reach it', async () => {
  const detail = '/api/admin/pricing/products/p_a1';
  const routes = ['/api/admin/pricing/overview', detail];
  assert.ok(routes.every((p) => PATHS.includes(p)), 'the sweep enumerates the pricing router');
  const owner = await sweep('owner');
  assert.equal(owner.statuses['/api/admin/pricing/overview'], 200, 'the owner reads the counts');
  // The clean start (spec addendum A.6): the V1 product sheet is closed, to the owner too.
  assert.deepEqual([owner.statuses[detail], owner.codes[detail]], [409, 'PRICING_V2_MANAGED']);
  assert.equal(owner.costSeen.includes(detail), false);
  for (const role of ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'] as const) {
    const r = await sweep(role);
    for (const p of routes) {
      assert.equal(r.statuses[p], 403, `${role} ${p}`);
      assert.equal(r.codes[p], 'COST_ACCESS_DENIED', `${role} ${p}`);
    }
  }
  for (const role of ['customer', 'merchant', 'employee', 'investor'] as const) {
    const r = await sweep(role);
    for (const p of routes) assert.equal(r.statuses[p], 403, `${role} ${p}`);
  }
  const guest = await sweep('guest');
  for (const p of routes) assert.equal(guest.statuses[p], 401, `guest ${p}`);
  const unverified = await sweep('owner_unverified');
  for (const p of routes) assert.equal(unverified.codes[p], 'OWNER_EMAIL_UNVERIFIED', `unverified owner ${p}`);
});

// ------------------------------------------------------------- «التسعير التقديري»

/** The two owner routers mounted inside the pricing router: the supplier price catalogue and the estimator. */
const ESTIMATE_ROUTERS = /^\/api\/admin\/pricing\/(supplier-prices|estimates)(\/|$)/;
const NON_OWNER_ADMINS = ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'] as const;
const NON_ADMINS = ['customer', 'merchant', 'employee', 'investor'] as const;

test('«التسعير التقديري» (docs/SMART_PRICING.md §3.4, §4.8): the supplier catalogue and the estimator are swept with the pricing router — the owner reads them; every other admin hears COST_ACCESS_DENIED at the door; customers and guests never reach them; the unverified owner hears the way out', async () => {
  const routes = PATHS.filter((p) => ESTIMATE_ROUTERS.test(p));
  for (const p of [
    '/api/admin/pricing/supplier-prices/snapshots',
    '/api/admin/pricing/supplier-prices/matches',
    '/api/admin/pricing/supplier-prices/lookup',
    '/api/admin/pricing/supplier-prices/links',
    '/api/admin/pricing/supplier-prices/links/p_a1',
    '/api/admin/pricing/supplier-prices/owner-links/p_a1',
    '/api/admin/pricing/estimates/control',
    '/api/admin/pricing/estimates/types',
    '/api/admin/pricing/estimates/types/p_a1/suggest',
    '/api/admin/pricing/estimates/products',
    '/api/admin/pricing/estimates/products/p_a1',
  ]) {
    assert.ok(routes.includes(p), `the sweep enumerates ${p}`);
  }
  const owner = await sweep('owner');
  // The sweep's database holds no supplier price and no preview: the reads answer the owner with empty lists,
  // and a type key that is no type (`p_a1`) or a product with no stored preview is 404 — never a refusal, never a crash.
  for (const p of routes) {
    const want = /\/(estimates\/types\/p_a1\/suggest|estimates\/products\/p_a1)$/.test(p) ? 404 : 200;
    assert.equal(owner.statuses[p], want, `owner ${p}`);
  }
  for (const role of NON_OWNER_ADMINS) {
    const r = await sweep(role);
    for (const p of routes) {
      assert.equal(r.statuses[p], 403, `${role} ${p}`);
      assert.equal(r.codes[p], 'COST_ACCESS_DENIED', `${role} ${p}`);
    }
  }
  for (const role of NON_ADMINS) {
    const r = await sweep(role);
    for (const p of routes) assert.equal(r.statuses[p], 403, `${role} ${p}`);
  }
  const guest = await sweep('guest');
  for (const p of routes) assert.equal(guest.statuses[p], 401, `guest ${p}`);
  const unverified = await sweep('owner_unverified');
  for (const p of routes) assert.equal(unverified.codes[p], 'OWNER_EMAIL_UNVERIFIED', `unverified owner ${p}`);
});

/**
 * What the owner's catalogue and estimator hold once he uses them, each a value found nowhere else in the
 * seed: a complete EU snapshot with the costly product's item and variant at a captured price, the matcher's
 * automatic confirmation of it, his own typed price, the printer type's figures, and a stored preview whose
 * line carries the supplier amount, R and D.
 */
const EST = {
  snapshot: 'sps_rm_estimates',
  handle: 'rm-sentinel-a1',
  variant: '731147002',
  price: '7311.47',
  typed: '7322.58',
  profit: '73.11',
  extra: 731_147,
  weight: 7_311,
  cost: 7_311_470,
  estimate: 7_399_000,
  hash: '3c'.repeat(32),
  // The owner's own supplier link of the costly product (§3.10, migration 0223): its host.
  ownerHost: 'owner-link-7311.example',
} as const;
/** The costly product's one sellable SKU (tests/fixtures/costlyProduct.ts: model v_a1 in black). */
const RM_SKU = 'o:v_a1|c:c_blk';
const EST_TEXTS: readonly string[] = [EST.snapshot, EST.handle, EST.variant, EST.price, EST.typed, EST.profit, String(EST.extra), String(EST.weight), String(EST.cost), String(EST.estimate), EST.ownerHost];
/** The tables those values live in, and the label: what a refused write must leave as it found it. */
const ESTIMATE_TABLES = [
  'supplier_price_snapshots',
  'supplier_price_items',
  'supplier_price_skus',
  'supplier_price_keys',
  'supplier_price_matches',
  'supplier_price_manual',
  'price_estimate_types',
  'price_estimate_control',
  'product_price_estimates',
  'price_estimate_lines',
  'price_estimate_firm_skus',
  'pricing_audit',
  'product_supplier_links',
] as const;

function seedEstimates(raw: DatabaseSync): DatabaseSync {
  const at = '2026-10-31T09:00:00.000Z';
  raw.exec(`
    INSERT INTO supplier_price_snapshots (id, source, currency, price_basis, capture, captured_on, captured_by, file_sha256, item_count, sku_count, state, created_by, created_at, completed_at)
      VALUES ('${EST.snapshot}', 'bambu_eu', 'EUR', 'list', 'browser_sweep', '2026-10-31', 'browser sweep', '${'7a'.repeat(32)}', 1, 1, 'complete', 'usr_owner', '${at}', '${at}');
    INSERT INTO supplier_price_items (snapshot_id, item_key, url, page_host, title, name_en, category, sourcing_hint, route_hint)
      VALUES ('${EST.snapshot}', '${EST.handle}', 'https://eu.store.bambulab.com/products/${EST.handle}', 'eu.store.bambulab.com', 'Bambu Lab A1', 'Bambu Lab A1', '', 'EU_STORE_EUR', 'GERMANY_LAND');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, options_json, options_en_json, price)
      VALUES ('${EST.snapshot}', '${EST.handle}', '${EST.variant}', '{"option1":"Black"}', '{"option1":"Black"}', '${EST.price}');
    INSERT INTO supplier_price_keys (snapshot_id, key_type, key_value, item_key, sku_key) VALUES
      ('${EST.snapshot}', 'handle', '${EST.handle}', '${EST.handle}', ''),
      ('${EST.snapshot}', 'variant_id', '${EST.variant}', '${EST.handle}', '${EST.variant}');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('p_a1', '${RM_SKU}', 'bambu_eu', '${EST.handle}', '${EST.variant}', 'high', 'handle', 'confirmed', 'auto', '${at}', '${EST.snapshot}', '${at}');
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, entered_by, entered_at)
      VALUES ('p_a1', '${RM_SKU}', '${EST.typed}', 'EUR', 'typed', 'usr_owner', '${at}');
    UPDATE price_estimate_types SET min_profit_usd = '${EST.profit}', additional_cost_iqd = ${EST.extra}, default_weight_g = ${EST.weight} WHERE key = 'printer';
    INSERT INTO product_price_estimates (product_id, type_key, type_source, state, measure_basis, preview_hash, computed_at, updated_by, updated_at)
      VALUES ('p_a1', 'printer', 'owner', 'candidate', 'type_default', '${EST.hash}', '${at}', 'usr_owner', '${at}');
    INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, supplier_amount, supplier_currency, measure_source, est_cost_iqd, est_price_iqd, computed_at)
      VALUES ('p_a1', '${RM_SKU}', 'pre_order_land', 'typed', '${EST.typed}', 'EUR', 'type_default', ${EST.cost}, ${EST.estimate}, '${at}');
    INSERT INTO product_supplier_links (id, product_id, combo_key, url, host, label, supplier_name, note, created_by, created_at, updated_by, updated_at)
      VALUES ('psl_rm_sentinel', 'p_a1', '${RM_SKU}', 'https://${EST.ownerHost}/a1', '${EST.ownerHost}', 'A1 black', 'RM supplier', '', 'usr_owner', '${at}', 'usr_owner', '${at}');
  `);
  return raw;
}

/** Every row of the estimate tables and every product's label, hashed. */
function estimateState(raw: DatabaseSync): string {
  const h = createHash('sha256');
  for (const t of ESTIMATE_TABLES) {
    for (const r of raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()) h.update(`${t} ${JSON.stringify(r)}\n`);
  }
  for (const r of raw.prepare('SELECT id, price_estimate FROM products ORDER BY id').all()) h.update(`products ${JSON.stringify(r)}\n`);
  return h.digest('hex');
}

/** Each read of the two routers on that database, and the values the owner must find in its answer. */
const ESTIMATE_READS: ReadonlyArray<readonly [path: string, owner: readonly string[]]> = [
  ['/api/admin/pricing/supplier-prices/snapshots', [EST.snapshot]],
  ['/api/admin/pricing/supplier-prices/matches?state=auto', [EST.handle, EST.variant, EST.price, EST.typed]],
  ['/api/admin/pricing/supplier-prices/lookup?q=rm-sentinel-a1', [EST.handle, EST.variant, EST.price]],
  ['/api/admin/pricing/supplier-prices/links', [EST.handle, EST.variant, EST.price, EST.typed]],
  ['/api/admin/pricing/supplier-prices/links/p_a1', [EST.handle, EST.variant, EST.price, EST.typed]],
  ['/api/admin/pricing/supplier-prices/owner-links/p_a1', [EST.handle, EST.variant, EST.price, EST.typed, EST.ownerHost]],
  ['/api/admin/pricing/estimates/control', []],
  ['/api/admin/pricing/estimates/types', [EST.profit, String(EST.extra), String(EST.weight)]],
  ['/api/admin/pricing/estimates/types/printer/suggest', []],
  ['/api/admin/pricing/estimates/products?state=all', [EST.typed, String(EST.cost), String(EST.estimate)]],
  ['/api/admin/pricing/estimates/products/p_a1', [EST.typed, String(EST.cost), String(EST.estimate)]],
];

/** Each write of the two routers, with a body shaped like the owner's screen sends on that database (the door refuses before any is read). */
const ESTIMATE_WRITES: ReadonlyArray<readonly [method: string, path: string, body: unknown]> = [
  ['POST', '/api/admin/pricing/supplier-prices/snapshots', { source: 'bambu_eu', currency: 'EUR', price_basis: 'list', capture: 'browser_sweep', captured_on: '2026-10-31', captured_by: 'browser sweep', file_sha256: '5f'.repeat(32), item_count: 1 }],
  ['POST', `/api/admin/pricing/supplier-prices/snapshots/${EST.snapshot}/items`, { items: [] }],
  ['POST', `/api/admin/pricing/supplier-prices/snapshots/${EST.snapshot}/complete`, { item_count: 1, sku_count: 1, file_sha256: '7a'.repeat(32) }],
  ['POST', `/api/admin/pricing/supplier-prices/snapshots/${EST.snapshot}/discard`, {}],
  ['POST', '/api/admin/pricing/supplier-prices/match', { product_ids: ['p_a1'] }],
  ['PUT', '/api/admin/pricing/supplier-prices/matches/p_a1', { version: '1.1.2026-10-31T09:00:00.000Z', skus: [{ combo_key: RM_SKU, source: 'bambu_eu', item_key: EST.handle, sku_key: null }] }],
  ['PUT', '/api/admin/pricing/supplier-prices/manual/p_a1', { version: '1.1.2026-10-31T09:00:00.000Z', skus: [{ combo_key: RM_SKU, amount: null }] }],
  ['PUT', '/api/admin/pricing/supplier-prices/owner-links/p_a1', { version: '1.1.2026-10-31T09:00:00.000Z', upsert: [{ combo_key: RM_SKU, url: 'https://detail.tmall.com/item.htm?id=1' }], remove: ['psl_rm_sentinel'] }],
  ['POST', '/api/admin/pricing/supplier-prices/read-store-page', { url: `https://eu.store.bambulab.com/products/${EST.handle}?id=${EST.variant}`, save: { product_id: 'p_a1', combo_keys: [RM_SKU] } }],
  ['PUT', '/api/admin/pricing/estimates/control', { version: 1, ordering_enabled: false }],
  ['POST', '/api/admin/pricing/estimates/types', { key: 'measuring_tool', name_ar: 'أدوات القياس', name_en: 'Measuring tools', name_ckb: 'ئامرازەکانی پێوان', sourcing: 'CHINA_CNY', route: 'sea' }],
  ['PUT', '/api/admin/pricing/estimates/types/printer', { version: 1, min_profit_usd: null }],
  ['POST', '/api/admin/pricing/estimates/compute', { product_ids: ['p_a1'] }],
  ['POST', '/api/admin/pricing/estimates/apply', { items: [{ product_id: 'p_a1', preview_hash: EST.hash }] }],
  ['PUT', '/api/admin/pricing/estimates/products/p_a1', { version: 1, state: 'paused' }],
  ['POST', '/api/admin/pricing/estimates/products/p_a1/confirm', { version: 1, accept_flags: [] }],
];

test('«التسعير التقديري», owner-only refusals with the data in place: the owner reads every supplier price, match, typed price, type figure and preview; every other caller is refused at the door in one answer, hears none of them, and its writes change nothing', async () => {
  // Every write route of the two routers is called below (a new one must be added to the list).
  const writes = new Set(ESTIMATE_WRITES.map(([m, p]) => `${m} ${p.replace(`/${EST.snapshot}/`, '/:id/').replace(/\/p_a1(\/|$)/, '/:id$1').replace('/types/printer', '/types/:key')}`));
  for (const [prefix, router] of BASE_MOUNTS.filter(([p]) => p === '/api/admin/pricing')) {
    for (const r of router.routes) {
      const full = `${prefix}${r.path}`;
      if (r.method === 'GET' || r.method === 'ALL' || !ESTIMATE_ROUTERS.test(full)) continue;
      assert.ok(writes.has(`${r.method} ${full.replace(/:product_id\b/, ':id')}`), `${r.method} ${full} is called by this test`);
    }
  }

  // The owner: every read answers, and the values reach him where they live (or the fixture proves nothing).
  const owned = seedEstimates(seededCopy());
  const ownerApp = appFor(owned, OWNER);
  for (const [path, values] of ESTIMATE_READS) {
    const res = await call(ownerApp, 'GET', path);
    assert.equal(res.status, 200, `owner ${path}: ${JSON.stringify(res.body).slice(0, 200)}`);
    const text = JSON.stringify(res.body);
    for (const v of values) assert.ok(text.includes(v), `the owner does not see ${v} on ${path}`);
  }
  assert.ok(leaks((await call(ownerApp, 'GET', '/api/admin/pricing/supplier-prices/links/p_a1')).body).length > 0, 'leaks() finds the supplier prices in the owner’s answer');
  assert.ok(leaks((await call(ownerApp, 'GET', '/api/admin/pricing/estimates/products/p_a1')).body).length > 0, 'leaks() finds R in the owner’s answer');

  // Everyone else, the owner before the address is verified included: the refusal each one hears.
  const refusalFor = (role: RoleName | 'owner_unverified'): { status: number; code: string | null } =>
    role === 'guest'
      ? { status: 401, code: null }
      : role === 'owner_unverified'
        ? { status: 403, code: 'OWNER_EMAIL_UNVERIFIED' }
        : (NON_ADMINS as readonly string[]).includes(role)
          ? { status: 403, code: null }
          : { status: 403, code: 'COST_ACCESS_DENIED' };
  const problems: string[] = [];
  for (const role of [...(Object.keys(ROLES) as RoleName[]), 'owner_unverified' as const]) {
    const raw = seedEstimates(role === 'owner_unverified' ? seededCopyUnverifiedOwner() : seededCopy());
    const app = appFor(raw, role === 'owner_unverified' ? OWNER_UNVERIFIED : ROLES[role]);
    const before = estimateState(raw);
    const want = refusalFor(role);
    const bodies = new Set<string>();
    const requests: Array<readonly [string, string, unknown]> = [...ESTIMATE_READS.map(([p]) => ['GET', p, undefined] as const), ...ESTIMATE_WRITES];
    for (const [method, path, body] of requests) {
      const res = await call(app, method, path, body);
      const text = JSON.stringify(res.body);
      bodies.add(text);
      const code = res.body && typeof res.body === 'object' ? ((res.body as { code?: string }).code ?? null) : null;
      if (res.status !== want.status) problems.push(`${role} ${method} ${path}: ${res.status} (want ${want.status})`);
      if (want.code && code !== want.code) problems.push(`${role} ${method} ${path}: ${code} (want ${want.code})`);
      for (const v of EST_TEXTS) if (text.includes(v)) problems.push(`${role} ${method} ${path}: the refusal carries ${v}`);
      for (const l of leaks(res.body)) problems.push(`${role} ${method} ${path}: ${l}`);
    }
    // The same bytes at every door of the two routers, a read or a write, a real id or a body.
    if (bodies.size !== 1) problems.push(`${role}: ${bodies.size} different refusals across the two routers`);
    if (estimateState(raw) !== before) problems.push(`${role}: a refused write changed the estimate tables or a label`);
  }
  assert.deepEqual(problems, []);
});

test('«طلب السعر» (DECISIONS row 240): mine, the queue’s counts, the list column and the notice carry no cost, no legacy figure and no one else', async () => {
  const raw = seededCopy();
  // The costly product shown but not sold (no V2 publication), its legacy ladder still in the row; one open
  // request by the customer and one by the employee, and a delivered notice.
  raw.exec(`
    DELETE FROM pricing_v2_sku_results WHERE product_id = 'p_a1';
    UPDATE products SET price_iqd = ${LEGACY_NUMBERS[0]}, prime_price_iqd = ${LEGACY_NUMBERS[1]} WHERE id = 'p_a1';
    INSERT INTO product_price_requests (id, user_id, product_id, selection, notify) VALUES
      ('prq_rm_1', 'u1', 'p_a1', '', 1), ('prq_rm_2', 'usr_emp', 'p_a1', '', 0);
    INSERT INTO product_price_request_stats (product_id, requesters, selections, clicks, last_request_at) VALUES ('p_a1', 2, 1, 2, '2026-10-15T09:00:00.000Z');
    INSERT INTO user_notifications (id, user_id, kind, title_ar, title_en, body_ar, body_en, link, entity_type, entity_id, meta, event_key)
      VALUES ('n_rm', 'u1', 'price_available', 'صار السعر متوفراً', 'The price is now available', 'x', 'x', '/product/a1', 'product', 'p_a1',
              '{"title_ckb":"نرخ ئێستا بەردەستە","body_ckb":"x"}', 'price_available:prq_rm_1:1');
  `);
  const extra = { numbers: LEGACY_NUMBERS };
  for (const [role, user] of Object.entries(ROLES)) {
    const app = appFor(raw, user, BASE_MOUNTS, { publishV2: false });
    for (const path of ['/api/price-requests/mine', '/api/notifications', '/api/products/a1', '/api/products?limit=50', '/api/admin/products-v2/needs-pricing?filter=most_requested', '/api/admin/products-v2?sort=requests']) {
      const res = await getPath(app, path);
      const text = await res.text();
      const body = text.startsWith('{') ? JSON.parse(text) : text;
      assert.deepEqual(leaks(body, extra), [], `${role} ${path}`);
      if (path === '/api/price-requests/mine' && res.status === 200) {
        assert.ok(!text.includes('usr_emp') || user?.id === 'usr_emp', `${role}: never another person’s request`);
        assert.ok(!text.includes('u1"') || user?.id === 'u1', `${role}: never another person’s request`);
        assert.doesNotMatch(text, /click_count|requesters/, `${role}: no counter`);
      }
    }
    // A request answer, refused or not, carries none either.
    const asked = await postPath(app, '/api/price-requests', { product_id: 'p_a1' });
    assert.deepEqual(leaks(await jsonOf(asked), extra), [], `${role} POST /api/price-requests`);
  }
});
