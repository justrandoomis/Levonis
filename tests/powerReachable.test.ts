/**
 * THE MAINS ANSWER IS REACHABLE — not merely computed.
 *
 * worker/lib/powerAdvice.ts is proved arithmetic-first in
 * tests/powerAdvice.test.ts. What that file cannot see is the failure that
 * actually happened: the whole feature reached the wire and STOPPED THERE.
 * GET /api/compare shipped a `power` key that src/lib/compare.ts did not
 * declare and src/pages/Compare.tsx did not draw, and worker/routes/support.ts
 * never called `powerOf` at all — so a customer asking «كم تستهلك الطابعة وشقد
 * UPS أحتاج», which is the question the module exists for, got nothing from
 * either surface.
 *
 * A feature the customer cannot reach is a feature the customer does not have,
 * so this file walks the two paths that carry it to a human.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, freshDb, get, json, post, stubApp, type StubUser } from './fixtures/app';
import { compareRoutes } from '../worker/routes/compare';
import { supportRoutes, matchIntents } from '../worker/routes/support';
import { ROOT } from './fixtures/d1';
import type { DatabaseSync } from 'node:sqlite';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const user: StubUser = { id: 'u_pw', role: 'customer', email: 'c@x.co' };

/** Two FDM printers with real wattages on the shelf the taxonomy carries. */
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

  add('p_a', 'alpha', 'Alpha X1', 1_000_000, {
    print_speed: '500',
    rated_power: '350',
    typical_print_power: '120',
    heated_bed_power: '250',
  });
  // Specs but NO wattage: the honest state of a product nobody finished
  // entering, and the one this feature must stay silent about.
  add('p_b', 'beta', 'Beta P1', 1_200_000, { print_speed: '300' });
  return raw;
}

const compareApp = (db: unknown) => stubApp(db, user, (a) => a.route('/api/compare', compareRoutes));
const supportApp = (db: unknown) => stubApp(db, user, (a) => a.route('/api/support', supportRoutes));

// ------------------------------------------------------------- the wire

test('GET /api/compare carries the power answer, aligned with products, for ONE column too', async () => {
  const db = asD1(seed());
  const one = await json(await get(compareApp(db), '/api/compare?ids=p_a'));
  assert.equal(one.success, true, JSON.stringify(one).slice(0, 300));
  assert.equal(one.comparison, null, 'a comparison of one is not a comparison');
  assert.equal(one.power.length, 1, 'but the mains question is still worth answering');
  assert.equal(one.power[0].known, true);
  assert.ok(one.power[0].points.length > 0);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(String(one.power[0].points[0].text[lang]).length > 10, `no ${lang} sentence`);
  }

  // INDEX-FOR-INDEX with `products`. A shorter array would pair one machine's
  // wattage with another machine's name, which is the one way this can lie.
  const two = await json(await get(compareApp(db), '/api/compare?ids=p_a,p_b'));
  assert.equal(two.power.length, two.products.length);
  assert.equal(two.products[0].id, 'p_a');
  assert.equal(two.power[0].known, true);
  assert.equal(two.products[1].id, 'p_b');
  assert.equal(two.power[1].known, false, 'a machine nobody entered watts for is UNKNOWN, never 0 W');
  assert.deepEqual(two.power[1].points, [], 'and a paragraph of «غير مذكور» is never assembled');
});

// ------------------------------------------------------- the storefront

test('the storefront declares the key and draws it as ordered points, not a table', () => {
  const lib = read('src/lib/compare.ts');
  assert.match(lib, /power\?: PowerAdvice\[\];/, 'CompareResponse does not declare the key the server sends');
  assert.match(lib, /export interface PowerAdvice/);

  const page = read('src/pages/Compare.tsx');
  assert.match(page, /<PowerBlock products=\{products\} power=\{power\}/, 'the page draws no power block');
  assert.match(page, /setPower\(res\.power\)/, 'the response key is never read');

  const block = read('src/components/compare/PowerBlock.tsx');
  // POINTS, NOT A TABLE — «لا يتم وضعها بشكل جداول وهوسه وخربطه».
  assert.match(block, /advice\.points\.map/);
  assert.doesNotMatch(block, /<table/, 'the answer is sentences, not a grid');

  // AND NO BARE FIGURE IS PICKED OFF THE OBJECT. Every number in the payload —
  // the UPS size, the runtime, the suggested breaker — has its caveat in the
  // sentence beside it, so rendering one on its own strips the caveat. An MCB
  // rating shown without «راجع كهربائي» is a fire-safety claim.
  for (const bare of ['suggested_breaker_a', 'recommended_kva', 'minutes_min', 'minutes_max', 'draw.rated']) {
    assert.ok(!block.includes(bare), `PowerBlock renders the bare figure ${bare} without its sentence`);
  }

  // Nothing at all for a machine nobody entered watts for.
  assert.match(block, /advice\.known/);
});

// --------------------------------------------------------- the assistant

test('«كم تستهلك» reaches its own intent, without a comparison having been started', () => {
  assert.deepEqual(matchIntents('كم تستهلك'), ['power_usage']);
  assert.deepEqual(matchIntents('ups'), ['power_usage']);
  assert.deepEqual(matchIntents('how much power'), ['power_usage']);
  assert.deepEqual(matchIntents('چەند وزە'), ['power_usage']);
});

test('the assistant answers the mains question from the same arithmetic, and refuses to guess', async () => {
  const db = asD1(seed());
  const ask = async (body: Record<string, unknown>) =>
    (await json(await post(supportApp(db), '/api/support/assistant', { locale: 'ar', ...body }))).reply;

  const reply = await ask({ intent: 'power_usage', params: { ids: 'p_a' } });
  assert.equal(reply.intent, 'power_usage');
  // The real figures, from the real module — 350 W at PF 0.9 on 220 V is 1.77 A.
  assert.match(reply.text, /350/);
  assert.match(reply.text, /1\.77/);
  assert.match(reply.text, /kVA/);
  assert.equal(reply.links[0].to, '/compare?ids=p_a');

  // A PRODUCT WHOSE WATTAGE NOBODY TYPED IS SAID OUT LOUD, not sized.
  const unknown = await ask({ intent: 'power_usage', params: { ids: 'p_b' } });
  assert.doesNotMatch(unknown.text, /kVA|أمبير/, 'a sizing was built out of an empty form');
  assert.ok(unknown.text.length > 10);

  // And the comparison reply carries it too, for the customer who is choosing
  // between two machines and wants to know which survives the evening cut.
  const compared = await ask({ intent: 'compare_products', params: { ids: 'p_a,p_b' } });
  assert.match(compared.text, /Alpha X1/);
  assert.match(compared.text, /350/, 'the comparison says nothing about power');
});

// ------------------------------------------------- and never an external call

test('no surface on this path reaches an external API for any of it', () => {
  // «ممنوع استخدام AI أو Gemini أو OpenAI أو أي API توليدي للترجمة». The
  // module is pure and every sentence it returns is a literal; this is the
  // assertion that stops a later "just ask the model to phrase it" edit.
  const module_ = read('worker/lib/powerAdvice.ts');
  assert.doesNotMatch(module_, /\bfetch\s*\(/);
  assert.doesNotMatch(module_, /gemini|openai|anthropic|api\.|https?:\/\//i);
  assert.doesNotMatch(read('src/components/compare/PowerBlock.tsx'), /\bfetch\s*\(/);
});
