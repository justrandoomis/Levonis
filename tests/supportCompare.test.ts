/**
 * «قارن» IN THE ASSISTANT — DETERMINISTIC, COMPACT, AND NEVER A GUESS.
 *
 * The comparison engine is proved in tests/compareSpecs.test.ts; what is
 * proved HERE is the three things the route adds on top of it, each of which
 * is a way the feature can be wrong while every pure function still passes:
 *
 *   1. IT NEVER PICKS THE SECOND MACHINE. One printer named and the other not
 *      is the single most tempting place in this route to guess, and a guess
 *      produces a confident verdict about a comparison nobody asked for. The
 *      answer is choices, which is this file's rule for every ambiguous match.
 *
 *   2. THE REPLY STAYS SMALL. «بشكل أصغر لا يحدث هوسة في المحادثة» — a chat
 *      bubble that renders the whole spec sheet is the defect. The bound is
 *      asserted as a NUMBER, because a regression here is invisible in review:
 *      the reply still looks correct, it is just six times too long.
 *
 *   3. IT DOES NOT SCORE ANYTHING ITSELF. The winning column and the verdict
 *      have to agree with `compareProducts`, so a second opinion cannot grow
 *      inside the support route and start contradicting the page it links to.
 *
 * The link is asserted too: it is the whole point of the reply — both machines
 * already placed, so the full comparison is one tap and nothing is chosen
 * twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, post, stubApp, type StubUser } from './fixtures/app';
import { supportRoutes } from '../worker/routes/support';
import { matchIntents } from '../worker/routes/support';
import type { DatabaseSync } from 'node:sqlite';

const user: StubUser = { id: 'u_cmp', role: 'customer', email: 'c@x.co' };

/** Two FDM printers on the shelf the taxonomy already carries, so the product
 *  TYPE is derived the same way the storefront derives it rather than stubbed. */
function seed(): DatabaseSync {
  const raw = freshDb();
  const shelf = raw.prepare("SELECT id FROM catalogs WHERE slug = 'fdm-printers'").get() as { id: string };
  const add = (id: string, slug: string, name: string, price: number, specs: Record<string, string>) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
           selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy,spec_fields,
           template_family,category_id)
         VALUES (?,?,?,?,'',?,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?,'devices',?)`
      )
      .run(id, slug, name, name, price, JSON.stringify(specs), shelf.id);

  // Alpha wins every scorable row AND is cheaper, so a verdict that comes out
  // any other way is the route scoring for itself.
  add('p_a', 'alpha', 'Alpha X1', 1_000_000, {
    print_speed: '500',
    build_volume: '256 x 256 x 256',
    noise_level: '50',
  });
  add('p_b', 'beta', 'Beta P1', 1_200_000, {
    print_speed: '300',
    build_volume: '220 x 220 x 250',
    noise_level: '55',
  });
  return raw;
}

const app = (db: unknown) => stubApp(db, user, (a) => a.route('/api/support', supportRoutes));

const ask = async (db: unknown, body: Record<string, unknown>) =>
  (await json(await post(app(db), '/api/support/assistant', { locale: 'ar', ...body }))).reply;

test('«قارن» / «مقارنة» / «compare» reach the intent, and nothing else does', () => {
  assert.deepEqual(matchIntents('قارن'), ['compare_products']);
  assert.deepEqual(matchIntents('مقارنة'), ['compare_products']);
  assert.deepEqual(matchIntents('compare'), ['compare_products']);
  assert.deepEqual(matchIntents('بەراورد'), ['compare_products']);
  // A bare 'vs' is a substring of ordinary words; only the spaced form counts.
  assert.deepEqual(matchIntents('the vsync setting'), []);
});

test('two machines: a compact table, a verdict, and ONE link with both already placed', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { intent: 'compare_products', params: { ids: 'p_a,p_b' } });

  assert.equal(reply.intent, 'compare_products');
  assert.deepEqual(reply.table.columns, ['Alpha X1', 'Beta P1']);

  // THE BOUND, as a number: price plus at most five scored rows.
  assert.ok(reply.table.rows.length <= 6, `the reply must stay compact, got ${reply.table.rows.length} rows`);

  // Price is shown and is FIRST, and it is never the reason anybody wins.
  assert.equal(reply.table.rows[0].label, 'السعر');
  assert.deepEqual(reply.table.rows[0].values, ['1,000,000 IQD', '1,200,000 IQD']);

  // The winner agrees with the engine: Alpha takes every scorable row.
  for (const row of reply.table.rows) assert.deepEqual(row.winners, [0], `row ${row.label}`);
  assert.match(reply.text, /Alpha X1/);

  assert.equal(reply.links.length, 1);
  assert.equal(reply.links[0].to, '/compare?ids=p_a,p_b');
});

test('ONE named and the other not: choices for the second slot, never a pick', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { intent: 'compare_products', params: { ids: 'p_a' } });

  assert.equal(reply.table, undefined, 'a comparison of one is not a comparison');
  assert.equal(reply.links, undefined, 'nothing to open until both slots are filled');
  assert.ok(reply.choices.length > 0, 'the second machine is offered');
  // Every choice carries BOTH ids, so accepting one is a complete request.
  for (const choice of reply.choices) {
    assert.equal(choice.intent, 'compare_products');
    assert.equal(choice.params.ids, 'p_a,p_b');
  }
});

test('free text names one machine — the routing words are not part of the name', async () => {
  const db = asD1(seed());
  // «قارن» is what sent the sentence here; searching for it finds nothing.
  const reply = await ask(db, { text: 'قارن Alpha' });
  assert.match(reply.text, /Alpha X1/);
  assert.ok(reply.choices.some((ch: { params?: { ids?: string } }) => ch.params?.ids === 'p_a,p_b'));
});

test('a bare «مقارنة» asks which product, rather than comparing two arbitrary ones', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { text: 'مقارنة' });
  assert.equal(reply.table, undefined);
  assert.match(reply.text, /أي منتج/);
});

test('a name matching several products returns the choices, never the first row', async () => {
  const raw = seed();
  const shelf = raw.prepare("SELECT id FROM catalogs WHERE slug = 'fdm-printers'").get() as { id: string };
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
         selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy,spec_fields,
         template_family,category_id)
       VALUES ('p_c','alpha-pro','Alpha Pro','Alpha Pro','',900000,'active',5,'[]','[]','direct_sale',
               '["direct_sale"]','[]','[]','BASE','{}',?,'devices',?)`
    )
    .run(JSON.stringify({ print_speed: '400' }), shelf.id);

  const reply = await ask(asD1(raw), { text: 'قارن Alpha' });
  assert.equal(reply.table, undefined, 'two machines answer to that name — picking one is a guess');
  const offered = reply.choices.map((ch: { params?: { ids?: string } }) => ch.params?.ids).sort();
  assert.deepEqual(offered, ['p_a', 'p_c'], 'each choice names ONE machine, for the first slot');
});
