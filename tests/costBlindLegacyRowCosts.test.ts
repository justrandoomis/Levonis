/**
 * A COST-BLIND SAVE OF A LEGACY PRODUCT KEEPS THE COSTS ONLY ITS DOCUMENT HELD
 * (S1 review L2, and L1: the relations answer says whether it carried cost).
 *
 * A legacy product's options and colours can live only in `products.options` /
 * `products.colors`, each with its cost, and no relation row. The first save
 * through the form writes those rows. A save without cost write — an
 * assistant's, or the owner's `cost_loaded: false` after verifying in another
 * tab — has no cost to give them: the INSERT bound NULL and the JSON mirror
 * was rebuilt from the rows, so the cost was gone from both. The planner now
 * carries the stored document's cost by id into a row it CREATES (a stored
 * row keeps its own, as before), and into the mirror.
 *
 * Run: node --import tsx --test tests/costBlindLegacyRowCosts.test.ts
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

const ORIGIN = 'https://levonis-iq.com';

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
  const token = `legacy-cost-${userId}-${Math.random().toString(36).slice(2)}`;
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

/** p_a1 turned into a legacy product: structure and costs in the JSON columns only. */
function legacy(raw: DatabaseSync) {
  raw.exec(`DELETE FROM cart_items WHERE product_id='p_a1';
    DELETE FROM product_option_transports WHERE product_id='p_a1';
    DELETE FROM product_option_fulfillment WHERE product_id='p_a1';
    DELETE FROM product_color_option_links;
    DELETE FROM product_colors WHERE product_id='p_a1';
    DELETE FROM product_variants WHERE product_id='p_a1';
    DELETE FROM product_option_values WHERE product_id='p_a1';
    DELETE FROM product_option_groups WHERE product_id='p_a1';`);
  const options = JSON.stringify([
    { id: 'jo1', name_en: 'Big', name_ar: 'كبير', price_iqd: 950000, cost_iqd: 512345, cost_adjust_iqd: 1111, stock: 3, active: true },
    { id: 'jo2', name_en: 'Small', name_ar: 'صغير', price_iqd: 850000, cost_iqd: 498765, stock: 2, active: true },
  ]);
  const colors = JSON.stringify([
    // An ADJUSTMENT on the colour (no fixed cost), and a fixed cost.
    { id: 'jc1', name_en: 'Red', name_ar: 'أحمر', hex: '#ff0000', cost_iqd: null, cost_adjust_iqd: -250, active: true },
    { id: 'jc2', name_en: 'Blue', name_ar: 'أزرق', hex: '#0000ff', cost_iqd: 523456, active: true },
  ]);
  raw.prepare(`UPDATE products SET options = ?, colors = ?, sale_types='["direct_sale"]', inventory_mode='BASE' WHERE id='p_a1'`).run(options, colors);
}

type Costs = Record<string, { cost_iqd: unknown; cost_adjust_iqd: unknown }>;
function jsonCosts(raw: DatabaseSync): { options: Costs; colors: Costs } {
  const r = row<{ options: string; colors: string }>(raw, "SELECT options, colors FROM products WHERE id='p_a1'")!;
  const pick = (list: Array<Record<string, unknown>>) =>
    Object.fromEntries(list.map((x) => [String(x.id), { cost_iqd: x.cost_iqd ?? null, cost_adjust_iqd: x.cost_adjust_iqd ?? null }]));
  return { options: pick(JSON.parse(r.options)), colors: pick(JSON.parse(r.colors)) };
}
function rowCosts(raw: DatabaseSync): { options: Costs; colors: Costs } {
  const pick = (rows: Array<Record<string, unknown>>) =>
    Object.fromEntries(rows.map((x) => [String(x.id), { cost_iqd: x.cost_iqd ?? null, cost_adjust_iqd: x.cost_adjust_iqd ?? null }]));
  return {
    options: pick(raw.prepare("SELECT id, cost_iqd, cost_adjust_iqd FROM product_option_values WHERE product_id='p_a1'").all() as Array<Record<string, unknown>>),
    colors: pick(raw.prepare("SELECT id, cost_iqd, cost_adjust_iqd FROM product_colors WHERE product_id='p_a1'").all() as Array<Record<string, unknown>>),
  };
}

/** What the editor sends: the document fields and the hydrated structure (from the JSON, no rows yet). */
async function formBody(a: ReturnType<typeof app>, cookie: string) {
  const got = await call(a, cookie, 'GET', '/api/admin/products-v2/p_a1');
  assert.equal(got.status, 200, got.text.slice(0, 300));
  const rel = await call(a, cookie, 'GET', '/api/admin/products/p_a1/relations');
  assert.equal(rel.status, 200, rel.text.slice(0, 300));
  const product = got.json.product as Record<string, unknown>;
  const doc = toEditorDoc(product as never) as unknown as Record<string, unknown>;
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o; void _c; void _m;
  const relations = relationsToWire(hydrateRelations(rel.json as never, product as never)) as unknown as Record<string, unknown>;
  return { product, rel: rel.json, body: { ...docFields, relations } as Record<string, unknown> };
}

const EXPECTED = {
  options: { jo1: { cost_iqd: 512345, cost_adjust_iqd: 1111 }, jo2: { cost_iqd: 498765, cost_adjust_iqd: null } },
  colors: { jc1: { cost_iqd: null, cost_adjust_iqd: -250 }, jc2: { cost_iqd: 523456, cost_adjust_iqd: null } },
};

test('the owner\'s cost_loaded:false save of a document-only product: the rows it creates and the mirror keep every cost', async () => {
  const raw = seededCopyUnverifiedOwner();
  legacy(raw);
  assert.deepEqual(jsonCosts(raw), EXPECTED);
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  const { body, rel } = await formBody(a, cookie);
  assert.equal(rel.can_view_cost, false, 'the relations answer says it was read without cost');
  // Verified in another tab, then «حفظ» on the form read before.
  raw.exec("UPDATE users SET email_verified_at = '2026-10-08T00:00:00.000Z' WHERE id = 'usr_owner'");
  const save = await call(a, cookie, 'POST', '/api/admin/products-v2', { ...body, cost_loaded: false });
  assert.equal(save.status, 200, save.text.slice(0, 400));
  assert.deepEqual(rowCosts(raw), EXPECTED, 'the new rows carry the document\'s costs, not NULL');
  assert.deepEqual(jsonCosts(raw), EXPECTED, 'the mirror is byte-for-byte the same cost');
});

test('an assistant\'s save of a document-only product keeps every cost it was never shown', async () => {
  const raw = seededCopy();
  legacy(raw);
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_asst');
  const { body, rel } = await formBody(a, cookie);
  assert.equal(rel.can_view_cost, false);
  const save = await call(a, cookie, 'POST', '/api/admin/products-v2', body);
  assert.equal(save.status, 200, save.text.slice(0, 400));
  assert.deepEqual(rowCosts(raw), EXPECTED);
  assert.deepEqual(jsonCosts(raw), EXPECTED);
});

test('an assistant\'s relations-only write (PUT /:id/relations) keeps them too', async () => {
  const raw = seededCopy();
  legacy(raw);
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_asst');
  const { body } = await formBody(a, cookie);
  const put = await call(a, cookie, 'PUT', '/api/admin/products/p_a1/relations', body.relations);
  assert.equal(put.status, 200, put.text.slice(0, 400));
  assert.deepEqual(rowCosts(raw), EXPECTED);
  assert.deepEqual(jsonCosts(raw), EXPECTED);
});

test('nothing is invented: a NEW option in a cost-blind save has no cost; a renamed one keeps its own', async () => {
  const raw = seededCopy();
  legacy(raw);
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_asst');
  const { body } = await formBody(a, cookie);
  const relations = body.relations as { groups: Array<{ values: Array<Record<string, unknown>> }> };
  const values = relations.groups[0]!.values;
  values[0]!.name_en = 'Large';
  values.push({ ...values[1]!, id: 'jo_new', name_en: 'Medium', variant_key: 'medium', variant_label: 'Medium', cost_iqd: null, cost_adjust_iqd: null });
  const save = await call(a, cookie, 'POST', '/api/admin/products-v2', body);
  assert.equal(save.status, 200, save.text.slice(0, 400));
  const rows = rowCosts(raw);
  assert.deepEqual(rows.options.jo1, EXPECTED.options.jo1, 'renamed, same id, same cost');
  assert.deepEqual(rows.options.jo_new, { cost_iqd: null, cost_adjust_iqd: null });
  assert.deepEqual(jsonCosts(raw).options.jo_new, { cost_iqd: null, cost_adjust_iqd: null });
});

test('with cost write the payload is the answer: the verified owner\'s explicit blank clears a document-only cost', async () => {
  const raw = seededCopy();
  legacy(raw);
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  const { body, rel } = await formBody(a, cookie);
  assert.equal(rel.can_view_cost, true, 'the verified owner\'s relations answer carries cost');
  const relations = body.relations as { groups: Array<{ values: Array<Record<string, unknown>> }> };
  const jo2 = relations.groups[0]!.values.find((v) => v.id === 'jo2')!;
  assert.equal(jo2.cost_iqd, 498765, 'the owner was shown the document cost');
  jo2.cost_iqd = null;
  const save = await call(a, cookie, 'POST', '/api/admin/products-v2', body);
  assert.equal(save.status, 200, save.text.slice(0, 400));
  assert.deepEqual(rowCosts(raw).options.jo2, { cost_iqd: null, cost_adjust_iqd: null });
  assert.deepEqual(jsonCosts(raw).options.jo2, { cost_iqd: null, cost_adjust_iqd: null });
  assert.deepEqual(rowCosts(raw).colors, EXPECTED.colors, 'what the owner left alone is written as shown');
});
