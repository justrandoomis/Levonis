/**
 * «عند كتابة حرف H فقط يظهر لا توجد منتجات بالرغم هنالك منتجات تبدأ بحرف H»
 *
 * tests/search.test.ts pins the owner's examples on a six-product catalogue,
 * and on six products every one of them passed while the shop still answered
 * «H» with nothing useful. What broke it only exists at a real catalogue's
 * size, so this file builds one: five products whose NAMES start with H, and a
 * hundred and twenty filaments whose ordinary English descriptions carry more
 * than forty short h-words ("how", "has", "hot", "hub", …).
 *
 * On that catalogue, before this file:
 *   - «H» returned 115 products and not the Hardened nozzle, the Heatbed, the
 *     Hotend or the Holder: the letter kept the forty SHORTEST h-words, and
 *     prose has plenty of short ones;
 *   - "Hard", "Hot", "Heat" found the descriptions that say "hard", "hot",
 *     "heat" and never the products NAMED with them, because an exact hit
 *     ended the search for the word still being typed;
 *   - «PL» put the PEI Plate above every PLA filament, because "plate" and its
 *     skeleton `plata` were both counted;
 *   - and through the route, on D1, any search that ranked fifty products or
 *     more answered HTTP 500 — the id list was bound twice against a
 *     100-parameter ceiling node:sqlite does not have.
 *
 * The route cases run on a D1 stand-in that refuses more than 100 bound
 * parameters, because that refusal is the production behaviour and the plain
 * test adapter would pass the old code.
 *
 * Run: node --import tsx --test tests/searchLive.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, ctx, freshDb, json, post, stubApp } from './fixtures/app';
import { SqliteD1, SqliteStatement } from './fixtures/d1';
import { runDurableJobs } from '../worker/lib/jobs';
import type { Env } from '../worker/lib/types';
import { toSearchDoc } from '../worker/lib/search/document';
import { buildIndexRows, expandQuery, LETTER_MIN_WEIGHT } from '../worker/lib/search/index';
import { completionSuffix, suggestCompletion, typingFragment } from '../worker/lib/search/complete';
import {
  backfillSearchIndex,
  INDEX_FAILED_MARK,
  INDEX_STAMP,
  planSearchIndex,
  searchProducts,
} from '../worker/lib/search/store';

// =========================================================================
// A D1 THAT REFUSES WHAT D1 REFUSES
// =========================================================================

class CeilingStatement {
  constructor(
    readonly inner: SqliteStatement,
    readonly sql: string,
    readonly log: number[],
    readonly bound = 0
  ) {}
  bind(...values: unknown[]) {
    return new CeilingStatement(this.inner.bind(...values), this.sql, this.log, values.length);
  }
  private check() {
    this.log.push(this.bound);
    if (this.bound > 100) throw new Error(`D1_ERROR: too many SQL variables (${this.bound})`);
  }
  run() {
    this.check();
    return this.inner.run();
  }
  first<T = Record<string, unknown>>() {
    this.check();
    return this.inner.first<T>();
  }
  all<T = Record<string, unknown>>() {
    this.check();
    return this.inner.all<T>();
  }
}

/** The real adapter, with D1's 100-bound-parameter refusal added back. */
class CeilingD1 {
  readonly log: number[] = [];
  constructor(private readonly inner: SqliteD1) {}
  prepare(sql: string) {
    return new CeilingStatement(this.inner.prepare(sql), sql, this.log);
  }
  async batch(statements: CeilingStatement[]) {
    for (const s of statements) {
      this.log.push(s.bound);
      if (s.bound > 100) throw new Error(`D1_ERROR: too many SQL variables (${s.bound})`);
    }
    return this.inner.batch(statements.map((s) => s.inner));
  }
}
const ceilingD1 = (raw: DatabaseSync) => new CeilingD1(new SqliteD1(raw)) as unknown as D1Database & { log: number[] };

// =========================================================================
// A CATALOGUE THE SIZE OF A REAL ONE
// =========================================================================

const H_WORDS = [
  'heating', 'higher', 'holds', 'humidity', 'hardware', 'housing', 'hose', 'hook', 'hood', 'hinge', 'hobby', 'hollow',
  'honeycomb', 'horizontal', 'hygroscopic', 'hundreds', 'half', 'hard', 'hatch', 'handy', 'high', 'hot', 'heat', 'hd',
  'hex', 'hub', 'head', 'heavy', 'hole', 'hours', 'hz', 'hand', 'has', 'have', 'home', 'how', 'help', 'hybrid', 'huge',
  'hi', 'ha', 'he',
];

/** The products whose NAMES start with H — what «H» is typed for. */
const H_NAMED = ['h_h2d', 'h_hardened', 'h_heatbed', 'h_hotend', 'h_holder'];

async function realisticShop(): Promise<DatabaseSync> {
  const raw = freshDb();
  const db = asD1(raw);
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو لاب','Bambu Lab')").run();
  const add = async (
    id: string,
    name: string,
    over: { description?: string; name_ar?: string; name_ckb?: string; brand?: boolean } = {}
  ) => {
    raw
      .prepare(
        `INSERT INTO products (id, slug, name, name_ar, name_ku, description, price_iqd, status, brand_id)
         VALUES (?, ?, ?, ?, ?, ?, 1000, 'active', ?)`
      )
      .run(id, id, name, over.name_ar ?? '', over.name_ckb ?? '', over.description ?? '', over.brand ? 'brd_bambu' : null);
    await db.batch(
      planSearchIndex(
        db,
        toSearchDoc({
          id,
          name,
          name_ar: over.name_ar,
          name_ckb: over.name_ckb,
          description: over.description,
          brandName: over.brand ? 'Bambu Lab' : null,
        })
      )
    );
  };
  await add('h_h2d', 'Bambu Lab H2D Combo 3D Printer', { name_ar: 'طابعة بامبو لاب H2D كومبو', brand: true });
  await add('h_hardened', 'Hardened Steel Nozzle 0.4mm', { name_ar: 'نوزل فولاذ مقوى', name_ckb: 'نۆزڵی پۆڵا' });
  await add('h_heatbed', 'Heatbed Textured PEI Plate');
  await add('h_hotend', 'Hotend Assembly for P1S');
  await add('h_holder', 'Holder Spool Stand');
  for (let i = 0; i < 120; i++) {
    const words = [H_WORDS[i % H_WORDS.length], H_WORDS[(i * 7 + 3) % H_WORDS.length], H_WORDS[(i * 11 + 5) % H_WORDS.length]];
    await add(`o_${String(i).padStart(3, '0')}`, `PLA Filament Color ${i}`, {
      description: `This product ${words.join(' ')} great for printing`,
      brand: true,
    });
  }
  return raw;
}

const ids = async (raw: DatabaseSync, q: string) => (await searchProducts(asD1(raw), q, { limit: 200 })).ids;

// =========================================================================
// THE ENGINE
// =========================================================================

test('the fixture really is the catalogue that broke it: more than forty short h-words in prose', async () => {
  const raw = await realisticShop();
  const h = raw.prepare("SELECT COUNT(DISTINCT token) AS n FROM search_tokens WHERE token >= 'h' AND token < 'i' AND weight = 1").get() as { n: number };
  assert.ok(h.n > 40, `the descriptions must carry more than forty h-words; they carry ${h.n}`);
});

test('«H» answers with the products NAMED with an H, first — not with prose', async () => {
  const raw = await realisticShop();
  const got = await ids(raw, 'H');
  for (const id of H_NAMED) assert.ok(got.includes(id), `«H» must reach ${id}`);
  const lastNamed = Math.max(...H_NAMED.map((id) => got.indexOf(id)));
  const firstProse = got.findIndex((id) => id.startsWith('o_'));
  assert.ok(
    firstProse === -1 || lastNamed < firstProse,
    `every H-named product must rank above a product that only SAYS an h-word (named up to ${lastNamed}, prose from ${firstProse})`
  );
  assert.ok(got.length < 60, `a letter names a shelf, not the shop — it returned ${got.length}`);
  // The same, on the other keyboard: «ھ»/«ه» is one letter away from the
  // Arabic name of nothing here, but «ط» is the first letter of «طابعة».
  assert.equal((await ids(raw, 'ط'))[0], 'h_h2d');
});

test('the word still being typed reaches the name it is on its way to', async () => {
  // "hard", "hot" and "heat" are exact words in the descriptions. An exact
  // hit used to end the search, so the Hardened nozzle, the Hotend and the
  // Heatbed were never looked at while the shopper typed their names.
  const raw = await realisticShop();
  assert.equal((await ids(raw, 'Hard'))[0], 'h_hardened');
  assert.equal((await ids(raw, 'Hot'))[0], 'h_hotend');
  assert.equal((await ids(raw, 'Heat'))[0], 'h_heatbed');
  assert.equal((await ids(raw, 'Ha'))[0], 'h_hardened', '"Ha" once matched the skeleton of "how"');
  assert.equal((await ids(raw, 'Hol'))[0], 'h_holder');
  assert.equal((await ids(raw, 'steel noz'))[0], 'h_hardened', 'the last word completes, the first is exact');
  assert.equal((await ids(raw, 'bambu h2'))[0], 'h_h2d');
});

test('a FINISHED word is exact: a trailing space means the shopper meant that word', async () => {
  const bare = new Map<string, string>();
  assert.deepEqual([...expandQuery('hot', bare).completing], ['hot'], 'still typing');
  assert.deepEqual([...expandQuery('hot ', bare).completing], [], 'finished');
  assert.deepEqual([...expandQuery('pla bas', bare).completing], ['bas'], 'only the LAST word is being typed');
  assert.deepEqual([...expandQuery('hot', bare, { completeLast: false }).completing], [], 'the route passes the trimmed space on');

  const raw = await realisticShop();
  const finished = await searchProducts(asD1(raw), 'hot', { limit: 200, completeLast: false });
  assert.ok(!finished.ids.includes('h_hotend'), '"hot " is the word hot, not "Hotend"');
  assert.ok(finished.ids.length > 0, 'and the products that say it are still found');
});

test('«PL» ranks PLA above the PEI plate — one word typed counts once per product', async () => {
  // "plate" and its skeleton `plata` were both prefixes of "pl" and were
  // SUMMED, which outscored "pla" and put one plate above 120 filaments.
  const raw = await realisticShop();
  const got = await ids(raw, 'PL');
  const plate = got.indexOf('h_heatbed');
  const firstPla = got.findIndex((id) => id.startsWith('o_'));
  assert.ok(firstPla >= 0 && (plate === -1 || firstPla < plate), `PLA first (pla at ${firstPla}, plate at ${plate})`);
});

test('a Latin word is not stored as its skeleton; an Arabic word still is', () => {
  // "heat" and "hot" are both `hat`, which put the Heatbed above the Hotend for
  // "hot". The skeleton only exists to carry Arabic letters across to Latin.
  const latin = buildIndexRows(toSearchDoc({ id: 'p', name: 'Heatbed Hot Plate' })).map((r) => r.token);
  assert.ok(!latin.includes('hat') && !latin.includes('plata') && !latin.includes('hatbad'), latin.join(' '));
  const arabic = buildIndexRows(toSearchDoc({ id: 'p', name_ar: 'بامبو' })).map((r) => r.token);
  assert.ok(arabic.includes('bamba'), 'the bridge from «بامبو» to "bambu" is kept');

  // And a Latin letter is not flattened into another: «E» is not the A shelf.
  const lookup = expandQuery('e', new Map()).lookup;
  assert.deepEqual(lookup, ['e']);
});

test('Arabic and Kurdish partial words still land on their products', async () => {
  const raw = await realisticShop();
  assert.equal((await ids(raw, 'طاب'))[0], 'h_h2d', '«طاب» → «طابعة»');
  assert.equal((await ids(raw, 'بام'))[0], 'h_h2d', '«بام» → «بامبو»');
  assert.ok((await ids(raw, 'نوز')).includes('h_hardened'), '«نوز» → «نوزل»');
  assert.ok((await ids(raw, 'نۆز')).includes('h_hardened'), 'Sorani «نۆز» → «نۆزڵی»');
  assert.ok((await ids(raw, 'بامبو')).includes('h_h2d'), 'and an Arabic query still crosses into a Latin brand');
});

test('a single letter keeps only naming words when there are any', async () => {
  // The rule `resolveTokens` applies with weights in hand.
  assert.equal(LETTER_MIN_WEIGHT, 5, 'name 10, brand 8, model 6, hashtag 5 — never a description (1)');
  const { resolveTokens } = await import('../worker/lib/search/index');
  const vocabulary = ['how', 'has', 'hub', 'hotend', 'hardened'];
  const weights = new Map([['how', 1], ['has', 1], ['hub', 1], ['hotend', 10], ['hardened', 10]]);
  const got = [...resolveTokens(expandQuery('h', new Map()), vocabulary, weights).keys()].sort();
  assert.deepEqual(got, ['hardened', 'hotend']);
  // …and when the letter only exists in prose, prose is still an answer.
  const prose = resolveTokens(expandQuery('h', new Map()), ['how', 'has'], new Map([['how', 1], ['has', 1]]));
  assert.equal(prose.size, 2);
});

// =========================================================================
// THE ROUTE, ON A DATABASE THAT REFUSES WHAT D1 REFUSES
// =========================================================================

async function listing(db: D1Database, query: string) {
  const { productRoutes } = await import('../worker/routes/products');
  const app = stubApp(db as never, null, (x) => x.route('/api/products', productRoutes), { host: APEX, env: { DB: db } });
  const res = await app.request(`/api/products?${query}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  return { status: res.status, body: await json(res) };
}

test('«H» and a brand name answer 200 on D1 however many products they rank', async () => {
  // 125 products carry "Bambu Lab" and 120 of them an h-word: each search ranks
  // far more than fifty, and the id list was bound twice — 2n + 2 parameters.
  const raw = await realisticShop();
  const db = ceilingD1(raw);

  const h = await listing(db, 'search=H&limit=50');
  assert.equal(h.status, 200, `«H» must not 500: ${JSON.stringify(h.body).slice(0, 200)}`);
  const hIds = (h.body.products as { id: string }[]).map((p) => p.id);
  assert.deepEqual(hIds.slice(0, H_NAMED.length).sort(), [...H_NAMED].sort(), 'the H-named products head the listing');

  // The home brand tiles link to /products?search=<brand name>.
  const brand = await listing(db, 'search=Bambu%20Lab&limit=50');
  assert.equal(brand.status, 200, `a brand search must not 500: ${JSON.stringify(brand.body).slice(0, 200)}`);
  assert.equal((brand.body.products as unknown[]).length, 50);

  // And the page after it: the ranking survives OFFSET.
  const page2 = await listing(db, 'search=Bambu%20Lab&limit=50&offset=50');
  assert.equal(page2.status, 200);
  const first = new Set((brand.body.products as { id: string }[]).map((p) => p.id));
  assert.ok((page2.body.products as { id: string }[]).every((p) => !first.has(p.id)), 'no product on both pages');

  assert.ok(Math.max(...db.log) <= 100, `no statement bound more than 100 parameters (worst ${Math.max(...db.log)})`);
});

test('the listing keeps the engine’s ranking, not the shelf order', async () => {
  const raw = await realisticShop();
  const db = ceilingD1(raw);
  const engine = (await searchProducts(asD1(raw), 'Hot', { limit: 200 })).ids;
  const route = ((await listing(db, 'search=Hot&limit=10')).body.products as { id: string }[]).map((p) => p.id);
  assert.deepEqual(route, engine.slice(0, 10));
});

test('the listing carries the grey completion for the word being typed', async () => {
  const raw = await realisticShop();
  const db = ceilingD1(raw);
  assert.equal((await listing(db, 'search=Hot&limit=6')).body.suggestion, 'Hotend');
  assert.equal((await listing(db, 'search=bambu%20la&limit=6')).body.suggestion, 'Lab');
  assert.equal((await listing(db, `search=${encodeURIComponent('طاب')}&limit=6`)).body.suggestion, 'طابعة', 'shown as the shop writes it');
  assert.equal((await listing(db, 'search=Hot%20&limit=6')).body.suggestion, null, 'a finished word gets none');
  assert.equal((await listing(db, 'limit=6')).body.suggestion, undefined, 'and a listing that is not a search carries no key');
});

// =========================================================================
// THE GREY WORD ITSELF
// =========================================================================

test('the completion is the rest of the word, compared the way the index compares', () => {
  assert.equal(typingFragment('bambu la'), 'la');
  assert.equal(typingFragment('bambu '), '');
  assert.equal(typingFragment('x2'), 'x2');
  assert.equal(completionSuffix('hot', 'Hotend'), 'end');
  assert.equal(completionSuffix('HOT', 'Hotend'), 'end', 'case is not a difference');
  assert.equal(completionSuffix('طابعه', 'طابعةات'), 'ات', 'ta marbuta and ha are one letter to search');
  assert.equal(completionSuffix('طابع', 'طابعة'), 'ة');
  assert.equal(completionSuffix('كۆ', 'کۆمبۆ'), 'مبۆ', 'Sorani ک continues an Arabic ك');
  assert.equal(completionSuffix('ط', 'طَابعة'), 'ابعة', 'a harakah on the typed letter stays with it');
  assert.equal(completionSuffix('hotend', 'Hotend'), null, 'nothing left to add');
  assert.equal(completionSuffix('hat', 'Hotend'), null);
  assert.equal(suggestCompletion('ho', ['Bambu Lab H2D', 'Hotend Assembly']), 'Hotend', 'the first name that continues it');
  assert.equal(suggestCompletion('ho ', ['Hotend']), null);
  assert.equal(suggestCompletion('ط', ['Bambu', 'طـابعة بامبو']), 'طابعة', 'tatweel is not shown back');
});

test('a word the results already say WHOLE gets no grey word — Space finishes it', () => {
  // "PLA" + Space used to become «PLAte »: the PLA product ranked first had
  // the word exactly, so the search walked on to the plate below it.
  assert.equal(suggestCompletion('PLA', ['PLA Basic Filament', 'PLA Matte Black', 'Textured PEI Plate']), null);
  assert.equal(suggestCompletion('hot', ['Hot Glue Gun', 'Hotend Assembly']), null);
  assert.equal(suggestCompletion('طابعه', ['طابعة بامبو', 'طابعات']), null, 'folded the way the index folds');
  // A longer word from a HIGHER-ranked result is still offered.
  assert.equal(suggestCompletion('hot', ['Hotend Assembly', 'Hot Glue Gun']), 'Hotend');
  assert.equal(suggestCompletion('pl', ['PLA Basic', 'Textured PEI Plate']), 'PLA');
});

async function smallShop(names: [string, string][]): Promise<DatabaseSync> {
  const raw = freshDb();
  const db = asD1(raw);
  for (const [id, name] of names) {
    raw.prepare("INSERT INTO products (id, slug, name, price_iqd, status) VALUES (?, ?, ?, 1000, 'active')").run(id, id, name);
    await db.batch(planSearchIndex(db, toSearchDoc({ id, name })));
  }
  return raw;
}

test('through the route: «PLA» and «hot» are not rewritten into a lower result’s longer word', async () => {
  const raw = await smallShop([
    ['p1', 'PLA Basic Filament'],
    ['p2', 'PLA Matte Black'],
    ['p3', 'Textured PEI Plate'],
    ['p4', 'Hot Glue Gun'],
    ['p5', 'Hotend Assembly'],
  ]);
  const db = ceilingD1(raw);
  for (const q of ['pla', 'PLA']) {
    const { body } = await listing(db, `search=${q}&limit=6`);
    const top = (body.products as { id: string }[])[0]?.id;
    assert.ok(top === 'p1' || top === 'p2', `a PLA product ranks first for ${q} (got ${top})`);
    assert.equal(body.suggestion, null, `${q}: the top result says the word whole`);
  }
  const hot = await listing(db, 'search=hot&limit=6');
  assert.equal((hot.body.products as { id: string }[])[0]?.id, 'p4', 'the product NAMED "Hot" ranks first');
  assert.equal(hot.body.suggestion, null, '"Hot Glue Gun" first: no "Hotend"');
});

test('an Arabic spelling of a Latin brand reaches it WITHOUT the dictionary', async () => {
  // «اليجو» is `alaga`; "elegoo" is `alaga` only with its own vowels
  // flattened. When Latin skeletons stopped being indexed, every brand outside
  // the synonym table went dark to an Arabic keyboard.
  const raw = await smallShop([
    ['p_el', 'Elegoo Saturn 4 Ultra'],
    ['p_so', 'Sunlu PLA Meta'],
    ['p_ma', 'Matte Black PLA'],
    ['p_he', 'Heatbed Textured PEI Plate'],
    ['p_ho', 'Hotend Assembly'],
  ]);
  const db = asD1(raw);
  const none = new Map<string, string>();
  const first = async (q: string) => (await searchProducts(db, q, { synonyms: none })).ids[0];
  assert.equal(await first('اليجو'), 'p_el');
  assert.equal(await first('ايليجو'), 'p_el');
  assert.equal(await first('ايلي'), 'p_el', 'a partial Arabic word, as typed in the live panel');
  assert.equal(await first('سونلو'), 'p_so');
  assert.equal(await first('سون'), 'p_so');
  assert.equal(await first('ماتي'), 'p_ma');
  // …and a LATIN query still never meets another Latin word through a
  // skeleton: `alaga` typed in Latin letters is not "Elegoo", "hot" is not
  // "Heatbed".
  assert.deepEqual((await searchProducts(db, 'alaga', { synonyms: none })).ids, []);
  assert.ok(!(await searchProducts(db, 'hot', { synonyms: none })).ids.includes('p_he'));
  const rows = buildIndexRows(toSearchDoc({ id: 'p', name: 'Elegoo' })).map((r) => r.token);
  assert.deepEqual(rows.sort(), ['elegoo', '~alaga'], 'the Latin skeleton is stored only under its mark');
  assert.ok(!expandQuery('elegoo', none).lookup.some((t) => t.startsWith('~')), 'a Latin query never looks one up');
});

// =========================================================================
// A RENAME REACHES THE INDEX
// =========================================================================

const ADMIN = { id: 'usr_boss', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

async function adminApp(db: D1Database) {
  const { adminTaxonomyRoutes } = await import('../worker/routes/adminTaxonomy');
  return stubApp(db as never, ADMIN, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes), { host: APEX, env: { DB: db } });
}

test('RENAMING A BRAND makes the new name findable and forgets the old one', async () => {
  const raw = await realisticShop();
  raw.prepare("INSERT INTO users (id, name, email, password_hash) VALUES ('usr_boss','Boss','boss@x.co','h')").run();
  const db = ceilingD1(raw);
  assert.ok((await searchProducts(db, 'bambu', { limit: 200 })).ids.length >= 100, 'pre-condition');

  const res = await post(await adminApp(db), '/api/admin/taxonomy/brands', {
    id: 'brd_bambu',
    name_en: 'Qidi Tech',
    name_ar: 'كيدي',
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 200));

  // The rename re-indexed what it could straight away…
  const now = (await searchProducts(db, 'qidi', { limit: 200 })).ids;
  assert.ok(now.length >= 50, `the new brand name finds products the moment the rename returns (${now.length})`);
  // …and left the rest unstamped, so the cron finishes the job.
  const stale = raw
    .prepare("SELECT COUNT(*) n FROM products p WHERE p.brand_id = 'brd_bambu' AND NOT EXISTS (SELECT 1 FROM search_tokens t WHERE t.product_id = p.id AND t.token = ?)")
    .get(INDEX_STAMP) as { n: number };
  assert.equal(stale.n, 121 - 50, 'every product the first pass did not reach is left for the backfill');
  for (let i = 0; i < 3; i++) await runDurableJobs({ DB: db } as unknown as Env);
  assert.equal((await searchProducts(db, 'qidi', { limit: 200 })).ids.length, 121, 'every product under the brand');
  // 'bambu' is still in the H2D's own name; nothing else says it any more.
  assert.deepEqual((await searchProducts(db, 'bambu', { limit: 200 })).ids, ['h_h2d'], 'the old brand name is gone');
});

test('RENAMING A SECTION reindexes the products filed under it', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO users (id, name, email, password_hash) VALUES ('usr_boss','Boss','boss@x.co','h')").run();
  raw.prepare("INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES ('cat_acc','acc','ملحقات','Accessories')").run();
  raw.prepare("INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES ('cat_noz','noz','نوزلات','Nozzles')").run();
  for (const [id, sub] of [['p_a', 'cat_noz'], ['p_b', 'cat_noz'], ['p_c', null]] as const) {
    raw
      .prepare(
        "INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id) VALUES (?, ?, ?, '', 1000, 'active', 'cat_acc', ?)"
      )
      .run(id, id, `Part ${id}`, sub);
  }
  const db = ceilingD1(raw);
  await runDurableJobs({ DB: db } as unknown as Env);
  assert.deepEqual((await searchProducts(db, 'nozzles')).ids, ['p_a', 'p_b']);

  const res = await post(await adminApp(db), '/api/admin/taxonomy/catalogs', { id: 'cat_noz', name_en: 'Hotend Tips' });
  assert.equal(res.status, 200);
  assert.deepEqual((await searchProducts(db, 'tips')).ids, ['p_a', 'p_b'], 'the new section name');
  assert.deepEqual((await searchProducts(db, 'nozzles')).ids, [], 'and not the old one');

  // A save that does not touch a name leaves the index alone.
  const stamps = () => (raw.prepare('SELECT COUNT(*) n FROM search_tokens WHERE token = ?').get(INDEX_STAMP) as { n: number }).n;
  const before = stamps();
  await post(await adminApp(db), '/api/admin/taxonomy/catalogs', { id: 'cat_noz', sort: 7 });
  assert.equal(stamps(), before, 'a re-sort is not a rename');
});

// =========================================================================
// ONE BAD PRODUCT CANNOT STALL THE BACKFILL
// =========================================================================

test('a product the backfill cannot write is marked and skipped, and the rest are indexed', async () => {
  const raw = freshDb();
  for (let i = 0; i < 30; i++) {
    const id = `p_${String(i).padStart(2, '0')}`;
    raw.prepare("INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES (?, ?, ?, '', 1000, 'active')").run(id, id, `Widget ${i}`);
  }
  const inner = new SqliteD1(raw);
  // The FIRST product by id — the one every run selects first — cannot be
  // written: any batch that touches it is refused.
  const poisoned = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: async (stmts: SqliteStatement[]) => {
      if (stmts.some((s) => (s as unknown as { params: unknown[] }).params?.[0] === 'p_00' && /INSERT/.test((s as unknown as { sql: string }).sql)))
        throw new Error('simulated: statement too large');
      return inner.batch(stmts);
    },
  } as unknown as D1Database;

  const first = await backfillSearchIndex(poisoned, { limit: 50 });
  assert.equal(first.indexed, 29, 'every other product is indexed');
  assert.deepEqual(first.failed.map((f) => f.id), ['p_00']);
  const marked = raw.prepare('SELECT COUNT(*) n FROM search_tokens WHERE product_id = ? AND token = ?').get('p_00', INDEX_FAILED_MARK) as { n: number };
  assert.equal(marked.n, 1, 'and the failure is written down');

  const second = await backfillSearchIndex(poisoned, { limit: 50 });
  assert.equal(second.indexed + second.failed.length, 0, 'the next run moves past it instead of retrying it first for ever');

  // Through the cron: the failure is on the report, and nothing else is.
  raw.exec("DELETE FROM search_tokens WHERE product_id = 'p_00'");
  const report = await runDurableJobs({ DB: poisoned } as unknown as Env);
  assert.equal(report.search_indexed, 0);
  assert.ok(report.errors.some((e) => e.startsWith('search_index_backfill: p_00')), report.errors.join('\n'));

  // A save rewrites every row the product owns, the mark included.
  await inner.batch(planSearchIndex(asD1(raw), toSearchDoc({ id: 'p_00', name: 'Widget 0' })) as unknown as SqliteStatement[]);
  const after = raw.prepare('SELECT COUNT(*) n FROM search_tokens WHERE product_id = ? AND token = ?').get('p_00', INDEX_FAILED_MARK) as { n: number };
  assert.equal(after.n, 0);
});
