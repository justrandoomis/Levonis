/**
 * THE LIVE SEARCH READS ITS DICTIONARY ONCE PER ISOLATE, NOT PER KEYSTROKE
 * (speed audit 2026-10-16, «live search: every keystroke runs 5 dependent D1
 * round trips»; worker/lib/search/store.ts `synonymsFor`).
 *
 * Every search answer read the whole `search_synonyms` table before anything
 * else could start — the query's expansion and the vocabulary scan depend on
 * it — so each keystroke paid one more dependent round trip to the primary.
 * Proved here with the wave-counting adapter on the real listing route:
 *
 *   - a warm isolate answers a search in one wave fewer, without the read;
 *   - the owner's vocabulary door forgets the memo in its isolate at once, so a
 *     word they add finds its product on the next keystroke; the import's
 *     taxonomy step (`prepareTaxonomy`) does the same for the words it adds;
 *   - elsewhere it is re-read after 30 s; a second database never shares it;
 *     a failed read is not kept.
 *
 * Run: node --import tsx --test tests/searchSynonymsMemo.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, get, json, post, stubApp, type StubUser } from './fixtures/app';
import { wavesD1 } from './fixtures/wavesD1';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { SYNONYMS_TTL_MS, forgetSearchSynonyms, planSearchIndex, searchProducts, synonymsFor } from '../worker/lib/search/store';
import { prepareTaxonomy } from '../worker/lib/catalogImport/runOps';
import type { ReviewedBundle } from '../worker/lib/catalogImport/reviewed';
import { toSearchDoc } from '../worker/lib/search/document';

const ADMIN: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: 'full' };

async function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,username) VALUES ('boss','Boss','boss@x.co','h','admin','boss')`);
  const { waves, db } = wavesD1(raw);
  // The index, as the backfill would write it, for the seeded catalogue.
  const rows = raw.prepare("SELECT id, name FROM products WHERE status = 'active'").all() as Array<{ id: string; name: string }>;
  for (const r of rows) await db.batch(planSearchIndex(db, toSearchDoc({ id: r.id, name: r.name })));
  const guest = stubApp(db, null, (a) => a.route('/api/products', productRoutes));
  const admin = stubApp(db, ADMIN, (a) => a.route('/api/admin/taxonomy', adminTaxonomyRoutes));
  const search = async (q: string) => {
    waves.reset();
    const res = await get(guest, `/api/products?search=${encodeURIComponent(q)}&limit=6`);
    assert.equal(res.status, 200);
    const body = await json(res);
    return { ids: (body.products as Array<{ id: string }>).map((p) => p.id), counts: { ...waves.counts } };
  };
  return { raw, db, waves, search, admin };
}

const readsDictionary = (sqls: string[]) => sqls.some((s) => /FROM search_synonyms/.test(s));

test('a warm isolate answers a keystroke one dependent round trip sooner: the dictionary is not read again', async () => {
  const w = await world();
  const cold = await w.search('bambu');
  assert.ok(cold.ids.length > 0, 'the search finds the seeded products');
  assert.ok(readsDictionary(cold.counts.sqls), 'a cold isolate reads the dictionary');
  const warm = await w.search('bamb');
  assert.equal(readsDictionary(warm.counts.sqls), false, warm.counts.sqls.join('\n'));
  assert.equal(warm.counts.waves, cold.counts.waves - 1, `cold ${cold.counts.waves} waves, warm ${warm.counts.waves}`);
  assert.deepEqual((await w.search('bambu')).ids, cold.ids, 'the same answer');
});

test('the owner\'s vocabulary door forgets it in its isolate: a word they add works on the next keystroke', async () => {
  const w = await world();
  assert.deepEqual((await w.search('ماكنه')).ids, [], 'an unknown word finds nothing (and fills the memo)');
  const added = await post(w.admin, '/api/admin/taxonomy/search-vocabulary', { term: 'ماكنه', canonical: 'h2d' });
  assert.equal(added.status, 200, await added.clone().text());
  const after = await w.search('ماكنه');
  assert.ok(readsDictionary(after.counts.sqls), 're-read at once');
  assert.ok(after.ids.length > 0, 'and the new word finds what it means');
  const removed = await w.admin.request('/api/admin/taxonomy/search-vocabulary/ماكنه', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal(removed.status, 200);
  assert.deepEqual((await w.search('ماكنه')).ids, [], 'and a word they delete stops at once');
});

test('the import\'s taxonomy step forgets it in its isolate too: a synonym the import adds is found on the next search (speed lane review)', async () => {
  const w = await world();
  assert.deepEqual((await w.search('ماكينة')).ids, [], 'an unknown word finds nothing (and fills the memo)');
  // Only what the step reads: no node to create, one reviewed synonym.
  const bundle = { taxonomy: { create: [] }, synonyms: [{ term: 'ماكينة', canonical: 'h2d', lang: 'ar' }] } as unknown as ReviewedBundle;
  const done = await prepareTaxonomy(w.db, bundle);
  assert.equal(done.synonyms_inserted, 1);
  const after = await w.search('ماكينة');
  assert.ok(readsDictionary(after.counts.sqls), 're-read at once, not after the memo\'s 30 s');
  assert.ok(after.ids.length > 0, 'and the import\'s word finds what it means');
});

test('re-read after the TTL; never shared across databases; a failed read is not kept', async () => {
  const w = await world();
  const t0 = 1_700_000_000_000;
  forgetSearchSynonyms(w.db);
  await synonymsFor(w.db, t0);
  w.waves.reset();
  await synonymsFor(w.db, t0 + SYNONYMS_TTL_MS - 1);
  assert.equal(w.waves.counts.executions, 0);
  await synonymsFor(w.db, t0 + SYNONYMS_TTL_MS + 1);
  assert.equal(w.waves.counts.executions, 1);
  const other = await world();
  other.waves.reset();
  await searchProducts(other.db, 'bambu');
  assert.ok(readsDictionary(other.waves.counts.sqls), 'a second database reads its own');
  // A read that fails is not remembered.
  const broken = freshDb();
  const { db: brokenDb } = wavesD1(broken);
  broken.exec('DROP TABLE search_synonyms');
  await assert.rejects(synonymsFor(brokenDb, t0));
  broken.exec('CREATE TABLE search_synonyms (term TEXT PRIMARY KEY, canonical TEXT NOT NULL, owner_added INTEGER NOT NULL DEFAULT 0, created_at TEXT)');
  broken.exec("INSERT INTO search_synonyms (term, canonical) VALUES ('x', 'y')");
  assert.equal((await synonymsFor(brokenDb, t0 + 1)).get('x'), 'y');
});
