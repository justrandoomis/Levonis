/**
 * COST IS "LOADED" ONLY WHEN BOTH PARALLEL ANSWERS CARRIED IT (S1 review L1),
 * AND THE AUTOMATIC RE-READ AFTER VERIFYING NEVER UNMOUNTS THE FORM (L3).
 *
 * The product form reads the product and its relations in parallel; the quick
 * price panel reads the price grid and the relations in parallel. Each set
 * "read with cost" from the FIRST answer only, so an address verified between
 * the two answers left blank row costs (option, colour, order type, route) on
 * screen that the next save wrote as NULL. GET /:id/relations now says whether
 * it carried cost (`can_view_cost`, as the price grid always did), and the
 * clients take the AND of both answers.
 *
 * Run: node --import tsx --test tests/costLoadedBothAnswers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError, requireMainHost } from '../worker/lib/http';
import { classifyHost, rootDomainFrom } from '../worker/lib/hosts';
import { loadSessionUser } from '../worker/lib/session';
import { sha256Hex } from '../worker/lib/crypto';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire } from '../src/components/adminProducts/form/model';
import { asD1, row } from './fixtures/app';
import { seededCopy, seededCopyUnverifiedOwner } from './fixtures/roleMatrix';
import { codeOf } from './fixtures/source';

const ORIGIN = 'https://levonis-iq.com';
const VERIFY = "UPDATE users SET email_verified_at = '2026-10-08T00:00:00.000Z' WHERE id = 'usr_owner'";

function app(raw: DatabaseSync) {
  const d1 = asD1(raw);
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: d1, INITIAL_ADMIN_EMAIL: 'boss@x.co', APP_ORIGIN: ORIGIN, EXTRA_ALLOWED_ORIGINS: '' } as unknown as Env;
    c.set('host', classifyHost(c.req.header('Host'), rootDomainFrom(c.env)));
    await loadSessionUser(c);
    await next();
  });
  a.use('/api/admin/*', requireMainHost);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminPriceGridRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    return c.json({ success: false, error: String(err) }, 500);
  });
  return a;
}
async function sessionFor(raw: DatabaseSync, userId: string): Promise<string> {
  const token = `both-answers-${userId}-${Math.random().toString(36).slice(2)}`;
  raw.prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), userId, new Date(Date.now() + 86_400_000).toISOString(), 'test');
  return `levonis_session=${token}`;
}
const EXECUTION = { waitUntil() {}, passThroughOnException() {} } as never;
async function call(a: ReturnType<typeof app>, cookie: string, method: string, path: string, body?: unknown) {
  const res = await a.request(`${ORIGIN}${path}`, {
    method,
    headers: { Cookie: cookie, 'CF-Connecting-IP': '1.2.3.4', ...(body !== undefined ? { 'content-type': 'application/json', origin: ORIGIN } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, undefined, EXECUTION);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: res.status, text, json };
}
const stored = (raw: DatabaseSync) => ({
  option: row(raw, "SELECT cost_iqd, cost_adjust_iqd FROM product_option_values WHERE id = 'v_a1'"),
  color: row(raw, "SELECT cost_iqd, cost_adjust_iqd FROM product_colors WHERE id = 'c_blk'"),
  cells: raw.prepare("SELECT option_id, fulfillment_type, cost_iqd, cost_adjust_iqd FROM product_option_fulfillment WHERE product_id = 'p_a1' ORDER BY option_id, fulfillment_type").all(),
  routes: raw.prepare("SELECT t.method, f.option_id, t.cost_iqd, t.cost_adjust_iqd FROM product_option_transports t JOIN product_option_fulfillment f ON f.id = t.fulfillment_id WHERE t.product_id='p_a1' ORDER BY f.option_id, t.method").all(),
});

/**
 * Every row that existed before still has its cost. The editor also writes
 * the (empty) routes it shows by default, so new rows may appear — with no
 * cost, which is nothing lost.
 */
function assertKept(before: ReturnType<typeof stored>, after: ReturnType<typeof stored>) {
  assert.deepEqual(after.option, before.option);
  assert.deepEqual(after.color, before.color);
  const key = (r: Record<string, unknown>) => `${r.option_id}|${r.fulfillment_type ?? r.method}`;
  for (const [what, was, now] of [['cells', before.cells, after.cells], ['routes', before.routes, after.routes]] as const) {
    const byKey = new Map((now as Array<Record<string, unknown>>).map((r) => [key(r), r]));
    for (const r of was as Array<Record<string, unknown>>) assert.deepEqual({ ...byKey.get(key(r)) }, { ...r }, `${what} ${key(r)}`);
  }
}

/** The clients' rule, as ProductForm.tsx states it (pinned below). */
const carriesCost = (product: object) => Object.prototype.hasOwnProperty.call(product, 'product_cost_iqd');
const relationsCarryCost = (relations: Record<string, unknown>) => relations.can_view_cost === true;

// ------------------------------------------------------------- the server says so

test('GET /:id/relations says whether it carried cost: the verified owner only', async () => {
  const cases: Array<[string, () => DatabaseSync, string, boolean]> = [
    ['verified owner', seededCopy, 'usr_owner', true],
    ['unverified owner', seededCopyUnverifiedOwner, 'usr_owner', false],
    ['full-scope admin', seededCopy, 'usr_full', false],
    ['assistant', seededCopy, 'usr_asst', false],
  ];
  for (const [who, seed, id, expected] of cases) {
    const raw = seed();
    const a = app(raw);
    const rel = await call(a, await sessionFor(raw, id), 'GET', '/api/admin/products/p_a1/relations');
    assert.equal(rel.status, 200, `${who}: ${rel.text.slice(0, 200)}`);
    assert.equal(rel.json.can_view_cost, expected, who);
    const cells = (rel.json.fulfillments as Array<Record<string, unknown>>) ?? [];
    assert.equal(cells.some((f) => 'cost_iqd' in f), expected, `${who}: the flag matches what the answer carries`);
  }
});

// ------------------------------------------------------------- the race, end to end

async function mixedRead(raw: DatabaseSync) {
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  // The relations answer lands before the stamp, the product answer after.
  const rel = await call(a, cookie, 'GET', '/api/admin/products/p_a1/relations');
  raw.exec(VERIFY);
  const got = await call(a, cookie, 'GET', '/api/admin/products-v2/p_a1');
  const product = got.json.product as Record<string, unknown>;
  const doc = toEditorDoc(product as never) as unknown as Record<string, unknown>;
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o; void _c; void _m;
  const relations = relationsToWire(hydrateRelations(rel.json as never, product as never));
  return { a, cookie, product, rel: rel.json, body: { ...docFields, relations } as Record<string, unknown> };
}

test('product form: a verification between the two answers leaves the form "read without cost", and its save keeps every row cost', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE product_option_values SET stock = 2 WHERE id = 'v_a1'");
  const before = stored(raw);
  const { a, cookie, product, rel, body } = await mixedRead(raw);
  assert.equal(carriesCost(product), true, 'the product answer alone says "with cost" — the old rule');
  assert.equal(relationsCarryCost(rel), false, 'the relations answer says it was not');
  const costLoaded = carriesCost(product) && relationsCarryCost(rel);
  assert.equal(costLoaded, false);
  const save = await call(a, cookie, 'POST', '/api/admin/products-v2', { ...body, ...(costLoaded ? {} : { cost_loaded: false }) });
  assert.equal(save.status, 200, save.text.slice(0, 400));
  assertKept(before, stored(raw));
});

test('…and the old first-answer rule would have written the blanks as NULL (the defect this closes)', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE product_option_values SET stock = 2 WHERE id = 'v_a1'");
  const before = stored(raw);
  assert.notEqual(before.option?.cost_iqd ?? null, null, 'the fixture has an option cost to lose');
  const { a, cookie, body } = await mixedRead(raw);
  const save = await call(a, cookie, 'POST', '/api/admin/products-v2', body);
  assert.equal(save.status, 200, save.text.slice(0, 400));
  assert.throws(() => assertKept(before, stored(raw)), 'a stored row cost was blanked');
});

test('quick price panel: grid after the stamp, relations before — the AND sends cost_loaded:false and every cell and route cost stays', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  const before = stored(raw);
  const rel = await call(a, cookie, 'GET', '/api/admin/products/p_a1/relations');
  raw.exec(VERIFY);
  const grid = await call(a, cookie, 'GET', '/api/admin/products/p_a1/price-grid');
  // The panel's rule (QuickPricePanel `load`): the AND of the two answers.
  const canViewCost = grid.json.can_view_cost === true && rel.json.can_view_cost === true;
  assert.equal(grid.json.can_view_cost, true);
  assert.equal(rel.json.can_view_cost, false);
  assert.equal(canViewCost, false);
  const fulfillments = ((rel.json.fulfillments as Array<Record<string, unknown>>) ?? []).map((f) => ({
    option_id: f.option_id, fulfillment_type: f.fulfillment_type, enabled: true, sort: f.sort ?? 0,
    cost_iqd: f.cost_iqd ?? null, cost_adjust_iqd: f.cost_adjust_iqd ?? null,
    transports: ((f.transports as Array<Record<string, unknown>>) ?? []).map((t) => ({ method: t.method, enabled: true, sort: 0, surcharge_iqd: t.surcharge_iqd, cost_iqd: t.cost_iqd ?? null, cost_adjust_iqd: t.cost_adjust_iqd ?? null })),
  }));
  const put = await call(a, cookie, 'PUT', '/api/admin/products/p_a1/fulfillment', {
    fulfillments,
    direct_stock: [{ scope: 'option', id: 'v_a1', stock: 2, low_stock_threshold: null }],
    inventory_mode: 'OPTION',
    ...(canViewCost ? {} : { cost_loaded: false }),
  });
  assert.equal(put.status, 200, put.text.slice(0, 300));
  assertKept(before, stored(raw));
});

// ------------------------------------------------------------- the clients, pinned

test('ProductForm: costLoaded is the AND of both answers, on load and after a save', () => {
  const code = codeOf('src/components/adminProducts/ProductForm.tsx');
  assert.match(code, /function relationsCarryCost\(relations: RelationsRead\): boolean \{\s*return relations\.can_view_cost === true;/);
  assert.match(code, /setCostLoaded\(carriesCost\(p\.product\) && relationsCarryCost\(r\)\);/);
  assert.match(code, /if \(res\.product\) setCostLoaded\(carriesCost\(res\.product\) && relationsCarryCost\(fresh\)\);/);
  assert.doesNotMatch(code, /setCostLoaded\(carriesCost\([^)]*\)\);/, 'no first-answer-only assignment is left');
});

test('ProductForm: the re-read after verifying is a background read that never shows the spinner (L3)', () => {
  const code = codeOf('src/components/adminProducts/ProductForm.tsx');
  const effect = code.slice(code.indexOf('const costReloadTried = useRef'), code.indexOf('}, [canSeeCost, costLoaded, reloadId, loading, dirty, readProduct, applyProduct]);'));
  assert.ok(effect.length > 0, 'the effect is found');
  assert.match(effect, /if \(!canSeeCost \|\| costLoaded \|\| !reloadId \|\| loading \|\| dirty\) return;/);
  assert.match(effect, /readProduct\(reloadId\)/);
  assert.doesNotMatch(effect, /loadProduct\(/, 'loadProduct toggles `loading`, which unmounts the form');
  assert.doesNotMatch(effect, /setLoading\(/);
  // Swapped in only for the same product, untouched, with no newer baseline.
  assert.match(effect, /reloadIdRef\.current !== reloadId \|\| baselineGeneration\.current !== generation/);
  assert.match(effect, /JSON\.stringify\(\{ d: docRef\.current, rs: relRef\.current \}\) === baselineRef\.current/);
  assert.match(effect, /if \(clean\) applyProduct\(read\);/);
  const apply = code.slice(code.indexOf('const applyProduct = useCallback'), code.indexOf('const loadProduct = useCallback'));
  assert.doesNotMatch(apply, /setLoading\(/, 'applying a read never toggles the spinner');
  // Every new baseline bumps the generation: a load or swap, and a save.
  assert.match(apply, /baselineGeneration\.current \+= 1;/);
  assert.match(code, /baselineGeneration\.current \+= 1;\s*setBaseline\(JSON\.stringify\(\{ d: freshDoc, rs: savedRel \}\)\);/);
});

test('QuickPricePanel: can_view_cost is the AND of the grid and the relations answers, and the read-back keeps it', () => {
  const code = codeOf('src/components/adminProducts/QuickPricePanel.tsx');
  assert.match(code, /setData\(\{ \.\.\.res, can_view_cost: res\.can_view_cost === true && relResponse\.can_view_cost === true \}\);/);
  assert.match(code, /can_view_cost: d\.can_view_cost && freshRead\.can_view_cost === true/);
  assert.match(code, /\.\.\.\(data\.can_view_cost \? \{\} : \{ cost_loaded: false \}\)/);
  assert.doesNotMatch(code, /setData\(res\);/);
});
