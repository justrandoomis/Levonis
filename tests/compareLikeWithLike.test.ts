/**
 * «في المقارنة … يجب أن يكون الفيلمنت مقابل الفيلمنت الطابعة مقابل الطابعة».
 *
 * A RULE, NOT A LABEL. The engine already NOTICED a mixed set — `basisOf`
 * answered `basis: 'mixed'` and the page printed «مقارنة مختلطة: المنتجات مو
 * من نوع واحد» over it — and then drew the comparison anyway. Two things with
 * almost no field in common produce a table of «غير مذكور» and a score built
 * out of whatever three attributes happen to overlap, which is worse than no
 * answer, because it looks like a verdict.
 *
 * Two halves, and only both of them together are the fix:
 *
 *   * GET /api/compare REFUSES the pair, so a hand-edited or shared URL cannot
 *     produce one either;
 *   * the picker stops OFFERING it, because a list of taps that each end in a
 *     refusal is a worse answer than a shorter list — the same rule that keeps
 *     a product with no spec sheet out of it.
 *
 * And one thing the fix must NOT do: refuse a product whose branch states no
 * type. `null` is "not stated", never "different", and treating it as a
 * contradiction would turn a taxonomy gap into an uncomparable product.
 *
 * Every case runs against the REAL route and the REAL migrations: the product
 * type is derived from the catalogue branch exactly as the storefront derives
 * it, never stubbed.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, stubApp, type StubUser } from './fixtures/app';
import { compareRoutes } from '../worker/routes/compare';

const visitor: StubUser = { id: 'u_cmp', role: 'customer', email: 'c@x.co' };
const app = (db: unknown) => stubApp(db, visitor, (a) => a.route('/api/compare', compareRoutes));

function shelfId(raw: DatabaseSync, slug: string): string {
  const row = raw.prepare('SELECT id FROM catalogs WHERE slug = ?').get(slug) as { id: string } | undefined;
  assert.ok(row, `the migrations carry a «${slug}» shelf`);
  return row.id;
}

/**
 * Two printers and a spool, each filed on the shelf the taxonomy already
 * carries and each with a real spec sheet — so nothing below is refused for
 * the OTHER reasons the route can refuse, and a passing test means the type
 * gate is what acted.
 */
function seed(): DatabaseSync {
  const raw = freshDb();
  const add = (id: string, slug: string, name: string, shelf: string, specs: Record<string, string>) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
           selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy,spec_fields,
           template_family,category_id)
         VALUES (?,?,?,?,'',1000000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?,'devices',?)`
      )
      .run(id, slug, name, name, JSON.stringify(specs), shelfId(raw, shelf));

  add('p_a', 'alpha', 'Alpha X1', 'fdm-printers', {
    print_speed: '500',
    build_volume: '256 x 256 x 256',
  });
  add('p_b', 'beta', 'Beta P1', 'fdm-printers', {
    print_speed: '300',
    build_volume: '220 x 220 x 250',
  });
  add('f_a', 'pla-matte', 'PLA Matte', 'fdm-materials', {
    diameter_mm: '1.75',
    spool_weight_g: '1000',
  });
  return raw;
}

const compare = (raw: DatabaseSync, ids: string) => get(app(asD1(raw)), `/api/compare?ids=${ids}`);

test('a printer against a printer is drawn', async () => {
  const res = await compare(seed(), 'p_a,p_b');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.products.length, 2);
  assert.ok(body.comparison, 'and there is a comparison, not just two cards');
});

test('a printer against a spool of filament is REFUSED, by name', async () => {
  const res = await compare(seed(), 'p_a,f_a');
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'COMPARE_TYPE_MISMATCH');
  // Blamed the way COMPARE_NO_SPECS is, so the page can offer to drop that
  // column and carry on instead of showing a dead end.
  assert.equal(body.details.product_id, 'f_a');
  assert.ok(String(body.error).includes('PLA Matte'), 'and it names the odd one out');
});

test('the column it blames is the MINORITY one, whatever order the URL lists', async () => {
  /**
   * The refusal exists to be acted on: the page reads `product_id` and offers
   * to drop that column. On «spool, printer, printer» a first-wins rule blames
   * a printer, and dropping it leaves «spool, printer» — still refused. The
   * affordance would be wrong on its first tap and would take two.
   */
  for (const ids of ['p_a,p_b,f_a', 'f_a,p_a,p_b', 'p_a,f_a,p_b']) {
    const res = await compare(seed(), ids);
    assert.equal(res.status, 400, ids);
    assert.equal((await json(res)).details.product_id, 'f_a', `«${ids}» blames the spool`);
  }
});

test('on a straight tie it is the LATER column that goes — the one just added', async () => {
  const res = await compare(seed(), 'p_a,f_a');
  assert.equal(res.status, 400);
  assert.equal((await json(res)).details.product_id, 'f_a');
});

test('a product whose branch states no type is not refused — «not stated» is not «different»', async () => {
  const raw = seed();
  // «others» carries no product type, which is exactly the corner of the
  // taxonomy that would become uncomparable if `null` were read as a conflict.
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
         selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy,spec_fields,
         template_family,category_id)
       VALUES ('x_a','thing','Thing','Thing','',50000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?,'devices',?)`
    )
    .run(JSON.stringify({ weight_g: '20' }), shelfId(raw, 'others'));
  const res = await compare(raw, 'p_a,x_a');
  assert.equal(res.status, 200, 'an unclassified product is still comparable');
});

test('the picker offers only what the comparison will actually draw', async () => {
  const raw = seed();
  const res = await get(app(asD1(raw)), '/api/compare/candidates?for=p_a');
  assert.equal(res.status, 200);
  const ids = ((await json(res)).products as Array<{ id: string }>).map((p) => p.id);
  assert.ok(ids.includes('p_b'), 'the other printer is offered');
  assert.ok(
    !ids.includes('f_a'),
    'the spool is not: every one of those rows was a tap that ends in COMPARE_TYPE_MISMATCH'
  );
});

test('a filament’s picker offers filament', async () => {
  const raw = seed();
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
         selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy,spec_fields,
         template_family,category_id)
       VALUES ('f_b','petg','PETG','PETG','',30000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?,'devices',?)`
    )
    .run(JSON.stringify({ diameter_mm: '1.75' }), shelfId(raw, 'fdm-materials'));
  const res = await get(app(asD1(raw)), '/api/compare/candidates?for=f_a');
  const ids = ((await json(res)).products as Array<{ id: string }>).map((p) => p.id);
  assert.deepEqual(ids, ['f_b'], 'the other spool, and neither printer');
});

test('one product on its own is never refused — there is nothing to mismatch', async () => {
  const res = await compare(seed(), 'p_a');
  assert.equal(res.status, 200);
  assert.equal((await json(res)).comparison, null, 'a comparison of one is not a comparison');
});
