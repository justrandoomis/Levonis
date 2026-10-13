/**
 * LEAK AUDIT — channel search-seo-html, candidate `search-branches-unswept`.
 *
 * The cost sweeps (tests/costRoleMatrix.test.ts through
 * tests/fixtures/roleMatrix.ts) call every GET with its path parameters filled
 * and NO query string, on a database whose `search_tokens` is empty and whose
 * costly product carries `options='[]'` / `colors='[]'`. So none of the
 * search-only code runs under them:
 *
 *   - GET /api/products?search=…        the index branch, the LIKE fallback,
 *                                        the grey `suggestion`, the listing
 *                                        step (sort + facets) over hits
 *   - GET /api/public/v1/search?q=…      (no q → 400 before the handler)
 *   - GET /api/community/search?q=…      the catalogue `materials` section
 *                                        (index branch and LIKE fallback)
 *   - GET /api/community/search/suggest  the catalogue suggestion lane
 *   - the search_tokens WRITER           backfillSearchIndex → searchDocsForRows
 *                                        → variantNamesFrom over the
 *                                        products.options / products.colors
 *                                        JSON mirror, which in real data holds
 *                                        cost_iqd and cost_adjust_iqd for every
 *                                        option and colour
 *
 * This file runs all of them, as every non-owner role of the matrix, against
 * the seeded costly product with a REAL mirror (built the way the save path
 * builds it: parseProductRow → applyRelations → serializeDoc) and a REAL index
 * (the cron backfill), and asserts:
 *
 *   1. the mirror really carries the sentinel costs (or this proves nothing);
 *   2. the index holds the colour name read from the mirror (the writer was
 *      fed) and NO token carries a cost — as a value, as digits, as a decimal;
 *   3. every answer of every search path, to every role, is clean (`leaks`);
 *   4. searching a cost AS A NUMBER never surfaces the costly product (the
 *      "which product costs 611111?" oracle) — through the index AND through
 *      the LIKE fallback;
 *   5. positive controls: «black» (a colour name, in no product column) finds
 *      the product through the index on every path — the index branch ran.
 *
 * Run: node --import tsx --test tests/leakAudit_search-seo-html_search_branches_unswept.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1 } from './fixtures/app';
import { COST, DECIMAL_SENTINELS, SENTINELS, leaks } from './fixtures/costlyProduct';
import { ROLES, appFor, call, getPaths, seedRoleMatrix, seededCopy, type MountSpec, type Router } from './fixtures/roleMatrix';
import { productRoutes } from '../worker/routes/products';
import { publicApiRoutes } from '../worker/routes/publicApi';
import { communitySearchRoutes, MATERIALS_CATALOG } from '../worker/routes/communitySearch';
import { backfillSearchIndex, INDEX_STAMP } from '../worker/lib/search/store';
import { parseProductRow, serializeDoc } from '../worker/lib/productModel';
import { applyRelations, loadRelationsView } from '../worker/lib/productOverlay';
import { Hono } from 'hono';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError, requireMainHost } from '../worker/lib/http';
import { classifyHost, rootDomainFrom } from '../worker/lib/hosts';
import { loadSessionUser } from '../worker/lib/session';
import { sha256Hex } from '../worker/lib/crypto';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire } from '../src/components/adminProducts/form/model';

const MOUNTS: readonly MountSpec[] = [
  ['/api/products', productRoutes as Router],
  ['/api/public/v1', publicApiRoutes as Router],
  ['/api/community', communitySearchRoutes as Router],
];

/** Every number a cost could be searched for by, as the text a visitor would type. */
const COST_TERMS: string[] = [
  ...[...SENTINELS].map(String),
  ...[...SENTINELS].map((n) => n.toLocaleString('en-US')),
  ...Object.values(DECIMAL_SENTINELS).map(String),
];

/** Words that do reach the product: its name, its option, its colour (from the mirror only). */
const WORDS = ['bambu', 'bamb', 'a1', 'black', 'blac', 'بامبو', 'أسود', 'Bambu Lab A1'];

/**
 * The seeded costly product, as real data holds it: the JSON mirror on
 * `products` written from the relation rows exactly as `applyPlannedMirror`
 * writes it on a save, so every option and colour carries its cost; the
 * product filed under the materials section too (a legacy `subcategory_id`
 * token, which the search document does not read), so the community
 * `materials` section can reach it; the community open, so every role gets
 * past the gate.
 */
async function realistic(raw: DatabaseSync, { index }: { index: boolean }): Promise<DatabaseSync> {
  const db = asD1(raw);
  const row = (await db.prepare('SELECT * FROM products WHERE id = ?').bind('p_a1').first<Record<string, unknown>>())!;
  const view = await loadRelationsView(db, 'p_a1', row.inventory_mode);
  const overlaid = applyRelations(parseProductRow(row), view, { includeInactive: true, authoredNames: true });
  const record = serializeDoc(overlaid);
  raw
    .prepare('UPDATE products SET options = ?, colors = ?, subcategory_id = ? WHERE id = ?')
    .run(String(record.options), String(record.colors), MATERIALS_CATALOG, 'p_a1');
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}')`);
  if (index) {
    const run = await backfillSearchIndex(db, { limit: 50 });
    assert.deepEqual(run.failed, [], 'the backfill wrote every product');
  }
  return raw;
}

/** A role's own throwaway database, built through the real writer. */
const worlds = new Map<string, Promise<DatabaseSync>>();
const world = (key: string, index: boolean) => {
  let w = worlds.get(key);
  if (!w) {
    w = realistic(seededCopy(), { index });
    worlds.set(key, w);
  }
  return w;
};

const enc = encodeURIComponent;

type App = ReturnType<typeof appFor>;

/**
 * One GET with the rate-limit windows cleared first: the community search
 * allows 120 a minute, and a refusal is not an answer — a 429 would turn
 * every check below into a vacuous pass.
 */
async function get(raw: DatabaseSync, app: App, url: string) {
  raw.exec('DELETE FROM rate_limits');
  return call(app, 'GET', url);
}

/** Every search-only URL, for one term. */
function searchUrls(term: string): string[] {
  return [
    `/api/products?search=${enc(term)}`,
    `/api/products?search=${enc(term)}&limit=24&offset=0`,
    `/api/products?search=${enc(term)}&sort=price_asc&facets=1`,
    `/api/products?search=${enc(term)}&sort=price_desc&avail=1`,
    `/api/public/v1/search?q=${enc(term)}`,
    `/api/public/v1/search?q=${enc(term)}&limit=24`,
    `/api/public/v1/products?q=${enc(term)}`,
    `/api/community/search?q=${enc(term)}`,
    `/api/community/search?q=${enc(term)}&types=materials`,
    `/api/community/search/suggest?q=${enc(term)}`,
  ];
}

/**
 * The answer with the caller's OWN TERM taken out of every string before it is
 * scanned: the echoed `q` / `query`, the «more» links and `links.self` repeat
 * what the visitor typed, and typing «611111» is not being told it. Numbers
 * are never stripped, and every other sentinel is still looked for in every
 * string — a cost the server ADDS to the answer is caught as before.
 */
function withoutEcho(v: unknown, term: string): unknown {
  const forms = [...new Set([enc(term), enc(term).replace(/%20/g, '+'), term])].sort((a, b) => b.length - a.length);
  const strip = (s: string) => forms.reduce((acc, f) => acc.split(f).join(''), s);
  if (Array.isArray(v)) return v.map((x) => withoutEcho(x, term));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, withoutEcho(x, term)]));
  }
  return typeof v === 'string' ? strip(v) : v;
}
const scan = (body: unknown, term: string) => leaks(withoutEcho(body, term));

/** Does an answer name the costly product (by id, slug, url or name)? */
const namesCostly = (body: unknown): boolean => {
  const s = JSON.stringify(body ?? null);
  return s.includes('"p_a1"') || s.includes('/product/a1') || s.includes('"a1"') || s.includes('Bambu Lab A1') || s.includes('بامبو A1');
};

// ------------------------------------------------------------------ the guard gap itself

test('the guard gap is real: the role-matrix sweep sends no search term, and its database has no index and an empty mirror', () => {
  const paths = getPaths();
  // The export query the matrix sends since DECISIONS row 220 (`?ids=p_a1`) is no search term.
  assert.equal(paths.filter((p) => /[?&](q|query|search|term|s)=/.test(p)).length, 0, 'the role matrix now sends search terms — revisit this audit');
  const raw = seedRoleMatrix();
  const tokens = raw.prepare('SELECT COUNT(*) AS n FROM search_tokens').get() as { n: number };
  const mirror = raw.prepare("SELECT options, colors FROM products WHERE id='p_a1'").get() as { options: string; colors: string };
  raw.close();
  assert.equal(tokens.n, 0, 'the role matrix seeds no search index');
  assert.deepEqual([mirror.options, mirror.colors], ['[]', '[]'], 'the role matrix seeds an empty JSON mirror');
});

// ------------------------------------------------------------------ the writer

test('the realistic mirror carries every option and colour cost (precondition: the index builder is fed real cost)', async () => {
  const raw = await world('writer', true);
  const r = raw.prepare("SELECT options, colors FROM products WHERE id='p_a1'").get() as { options: string; colors: string };
  const options = JSON.parse(r.options) as Array<Record<string, unknown>>;
  const colors = JSON.parse(r.colors) as Array<Record<string, unknown>>;
  assert.ok(options.some((o) => o.cost_iqd === COST.option && o.cost_adjust_iqd === COST.optionAdjust), `option cost in the mirror: ${r.options.slice(0, 300)}`);
  assert.ok(colors.some((c) => c.cost_iqd === COST.color && c.cost_adjust_iqd === COST.colorAdjust), `colour cost in the mirror: ${r.colors.slice(0, 300)}`);
  // …and the mirror itself is exactly what the scanner calls a leak, so a
  // token or an answer carrying any of it would be caught below.
  assert.ok(leaks({ options, colors }).length >= 4);
});

test('search_tokens for the costly product: the mirror was read (its colour is indexed) and no token carries a cost', async () => {
  const raw = await world('writer', true);
  const rows = raw.prepare("SELECT token, weight FROM search_tokens WHERE product_id = 'p_a1'").all() as Array<{ token: string; weight: number }>;
  const tokens = rows.map((r) => r.token);
  assert.ok(tokens.includes(INDEX_STAMP), 'the product was indexed by the current builder');
  assert.ok(tokens.some((t) => t.includes('black')), `the colour name from the mirror reached the index: ${tokens.join(' ')}`);
  assert.deepEqual(leaks(tokens), [], `cost reached search_tokens: ${tokens.join(' ')}`);
  const digits = (n: number | string) => String(n).replace(/\D/g, '');
  const costDigits = [...SENTINELS, ...Object.values(DECIMAL_SENTINELS)].map(digits);
  const carrying = tokens.filter((t) => costDigits.some((d) => d.length >= 4 && t.replace(/\D/g, '').includes(d)));
  assert.deepEqual(carrying, [], 'a token spells a cost');
  // The whole table, every product: nothing numeric beyond the stamp's own digit.
  const all = (raw.prepare('SELECT token FROM search_tokens').all() as Array<{ token: string }>).map((r) => r.token);
  assert.deepEqual(leaks(all), []);
});

// ------------------------------------------------------------------ every role, every search path

for (const [role, user] of Object.entries(ROLES)) {
  test(`${role}: every search path (index branch) answers without a cost, and «black» reaches the costly product`, async () => {
    const raw = await world(`index:${role}`, true);
    const app = appFor(raw, user ?? null, MOUNTS);
    const found: string[] = [];
    const reached = new Set<string>();
    const statuses: Record<string, number> = {};
    for (const term of WORDS) {
      for (const url of searchUrls(term)) {
        const { status, body } = await get(raw, app, url);
        statuses[url] = status;
        for (const l of scan(body, term)) found.push(`${url}  ${l}`);
        if (status >= 200 && status < 300 && namesCostly(body)) reached.add(url.replace(/\?.*$/, ''));
      }
    }
    assert.deepEqual(found, [], `cost reached ${role} through search:\n${found.join('\n')}`);
    // Every search path ANSWERED (a refusal would make the check above vacuous).
    const refused = Object.entries(statuses).filter(([, s]) => s !== 200);
    assert.deepEqual(refused, [], `${role}: search paths that did not answer`);
    // Positive controls: «black» is a COLOUR name, in no column the LIKE
    // fallback reads, so finding the product by it proves the index branch
    // ran and the mirror fed it.
    for (const url of [
      '/api/products?search=black',
      '/api/products?search=black&sort=price_asc&facets=1',
      '/api/public/v1/search?q=black',
      '/api/community/search?q=black&types=materials',
      '/api/community/search/suggest?q=black',
    ]) {
      const { status, body } = await get(raw, app, url);
      assert.equal(status, 200, `${role} ${url} answered ${status}`);
      assert.ok(namesCostly(body), `${role} ${url} did not reach the costly product: ${JSON.stringify(body).slice(0, 400)}`);
    }
    // The grey completion runs (only a search that is still typing gets one).
    const typing = await get(raw, app, '/api/products?search=bamb');
    assert.equal(typeof (typing.body as { suggestion?: unknown }).suggestion, 'string', `${role}: no suggestion for «bamb»`);
    assert.ok(reached.size >= 4, `${role} reached the product on only ${[...reached].join(', ')}`);
  });

  test(`${role}: searching a cost as a number never surfaces the costly product, through the index`, async () => {
    const raw = await world(`index:${role}`, true);
    const app = appFor(raw, user ?? null, MOUNTS);
    const oracle: string[] = [];
    const found: string[] = [];
    const refused: string[] = [];
    for (const term of COST_TERMS) {
      for (const url of searchUrls(term)) {
        const { status, body } = await get(raw, app, url);
        if (status !== 200) refused.push(`${url} ${status}`);
        for (const l of scan(body, term)) found.push(`${url}  ${l}`);
        if (status >= 200 && status < 300 && namesCostly(body)) oracle.push(url);
      }
    }
    assert.deepEqual(found, [], `cost reached ${role}:\n${found.join('\n')}`);
    assert.deepEqual(oracle, [], `a cost typed into search finds the costly product for ${role}:\n${oracle.join('\n')}`);
    assert.deepEqual(refused, [], `${role}: cost searches that were refused instead of answered`);
  });
}

// ------------------------------------------------------------------ the LIKE fallback

test('LIKE fallback (no index yet): every search path is clean for every role, the product is still found by name, and no cost finds it', async () => {
  const problems: string[] = [];
  for (const [role, user] of Object.entries(ROLES)) {
    const raw = await world(`like:${role}`, false);
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM search_tokens').get() as { n: number }).n, 0, 'no index: the fallback runs');
    const app = appFor(raw, user ?? null, MOUNTS);
    for (const term of [...WORDS, ...COST_TERMS]) {
      for (const url of searchUrls(term)) {
        const { status, body } = await get(raw, app, url);
        for (const l of scan(body, term)) problems.push(`${role} ${url}  ${l}`);
        if (COST_TERMS.includes(term) && status >= 200 && status < 300 && namesCostly(body)) problems.push(`${role} ${url}  ORACLE`);
      }
    }
    // Control: the fallback reaches the product by its name.
    for (const url of ['/api/products?search=bambu', '/api/public/v1/search?q=bambu', '/api/community/search?q=bambu&types=materials']) {
      const { status, body } = await get(raw, app, url);
      assert.equal(status, 200, `${role} ${url}`);
      assert.ok(namesCostly(body), `${role} ${url} (LIKE) did not reach the costly product`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

// ------------------------------------------------------------------ the SAVE-PATH writer

const ORIGIN = 'https://levonis-iq.com';

/** The admin form's two routers behind the real session loader (tests/costBlindLegacyRowCosts.test.ts). */
function adminApp(raw: DatabaseSync) {
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
  a.route('/api/admin/products', adminProductRelationsRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    return c.json({ success: false, error: String(err) }, 500);
  });
  return a;
}
async function sessionFor(raw: DatabaseSync, userId: string): Promise<string> {
  const token = `search-audit-${userId}-${Math.random().toString(36).slice(2)}`;
  raw
    .prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .run(await sha256Hex(token), userId, new Date(Date.now() + 86_400_000).toISOString(), 'test');
  return `levonis_session=${token}`;
}
const EXECUTION = { waitUntil() {}, passThroughOnException() {} } as never;
async function adminCall(a: ReturnType<typeof adminApp>, cookie: string, method: string, path: string, body?: unknown) {
  const res = await a.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: { Cookie: cookie, 'CF-Connecting-IP': '1.2.3.4', ...(body !== undefined ? { 'content-type': 'application/json', origin: ORIGIN } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    undefined,
    EXECUTION
  );
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json: parsed };
}

test('the SAVE-PATH writer (the owner saves the costly product through the form): the mirror it writes carries cost, the tokens it writes carry none, and a guest search over them is clean', async () => {
  const raw = seededCopy();
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}')`);
  raw.exec('DELETE FROM search_tokens');
  // The form refuses a direct-sale option with no stock; the fixture leaves it NULL.
  raw.exec("UPDATE product_option_values SET stock = 2 WHERE id = 'v_a1'");
  const a = adminApp(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  const got = await adminCall(a, cookie, 'GET', '/api/admin/products-v2/p_a1');
  assert.equal(got.status, 200, got.text.slice(0, 300));
  const rel = await adminCall(a, cookie, 'GET', '/api/admin/products/p_a1/relations');
  assert.equal(rel.status, 200, rel.text.slice(0, 300));
  const product = got.json.product as Record<string, unknown>;
  const doc = toEditorDoc(product as never) as unknown as Record<string, unknown>;
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o;
  void _c;
  void _m;
  const relations = relationsToWire(hydrateRelations(rel.json as never, product as never)) as unknown as Record<string, unknown>;
  const save = await adminCall(a, cookie, 'POST', '/api/admin/products-v2', { ...docFields, relations });
  assert.equal(save.status, 200, save.text.slice(0, 500));

  // The save wrote the mirror WITH cost (the owner's save), and the index in the same batch.
  const mirror = raw.prepare("SELECT options, colors FROM products WHERE id='p_a1'").get() as { options: string; colors: string };
  assert.ok(leaks({ options: JSON.parse(mirror.options), colors: JSON.parse(mirror.colors) }).length >= 2, 'the saved mirror carries the option and colour cost');
  const tokens = (raw.prepare("SELECT token FROM search_tokens WHERE product_id = 'p_a1'").all() as Array<{ token: string }>).map((r) => r.token);
  assert.ok(tokens.includes(INDEX_STAMP), `the save wrote the index: ${tokens.join(' ')}`);
  assert.ok(tokens.some((t) => t.includes('black')), `the save indexed the colour name: ${tokens.join(' ')}`);
  assert.deepEqual(leaks(tokens), [], `the save wrote a cost into search_tokens: ${tokens.join(' ')}`);
  const costDigits = [...SENTINELS, ...Object.values(DECIMAL_SENTINELS)].map((n) => String(n).replace(/\D/g, ''));
  assert.deepEqual(tokens.filter((t) => costDigits.some((d) => t.replace(/\D/g, '').includes(d))), []);

  // A guest searching over THAT index: found by its colour, and clean; no cost finds it.
  const app = appFor(raw, null, MOUNTS);
  const found: string[] = [];
  for (const term of ['black', 'bambu', ...COST_TERMS]) {
    for (const url of searchUrls(term)) {
      const { status, body } = await get(raw, app, url);
      assert.equal(status, 200, `${url} ${status}`);
      for (const l of scan(body, term)) found.push(`${url}  ${l}`);
      if (COST_TERMS.includes(term) && namesCostly(body)) found.push(`${url}  ORACLE`);
    }
  }
  assert.deepEqual(found, [], found.join('\n'));
  const black = await get(raw, app, '/api/products?search=black');
  assert.ok(namesCostly(black.body), 'the guest found the product by its colour through the index the save wrote');
});
