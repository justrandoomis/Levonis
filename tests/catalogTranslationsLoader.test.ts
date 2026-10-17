/**
 * THE TRANSLATION MEMORY'S LOADER THROUGH THE IMPORT DOOR
 * (docs/bambu-import/I18N-DESIGN.md §A.4; worker/lib/catalogImport/translations.ts,
 * `POST /api/ops/catalog-import/run/translations`).
 *
 * The real Worker on a fully migrated database behind `LimitD1` (D1's
 * 100-parameter limit), a run holding a token's hash, an edge-cache double that
 * records every purge:
 *
 *   1. an unknown part → 409 TRANSLATIONS_PART_UNKNOWN; bytes that do not hash
 *      to the bundled index → 409 TRANSLATIONS_PART_MISMATCH; one bad row →
 *      400 TRANSLATIONS_ROW_INVALID naming the row and its code, nothing
 *      written; a database without 0196 → 409 TRANSLATIONS_SCHEMA_MISSING;
 *   2. a first load inserts the rows, the refs and the ledger row in one batch
 *      and purges its products' page, knowledge and v1 record; the answer is
 *      counts, never text;
 *   3. the same part again → `skipped`: no write, no purge;
 *   4. a changed row → `updated`, and only its products are purged — every
 *      product the database links to it, one dropped from the row's list
 *      included; the cap of 60 counts products that exist (an id not written
 *      yet never takes a live page's place); a `keep` row is stored, never shown;
 *   5. every statement binds ≤ 100 parameters; a 250-row part costs well under
 *      the invocation budget; no token → the uniform 404;
 *   6. the bundled index is the committed one, and a malformed index knows no
 *      part; EVERY committed part loads through the real Worker on a fully
 *      migrated database — re-validated row by row, ≤ 100 parameters a
 *      statement, under the invocation budget — and loading them all again is
 *      `skipped` for each.
 *
 * Run: node --import tsx --test tests/catalogTranslationsLoader.test.ts
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dbThrough } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { violations } from './fixtures/d1Limits';
import { seedLiveCatalog, LIVE_PRODUCTS, P } from './fixtures/liveCatalog';
import { OPS, openRun, opsWorld, setBundle, type OpsWorld } from './fixtures/catalogImportOps';
import { bundleTexts } from './fixtures/catalogImportWorld';
import { countingD1 } from '../worker/lib/catalogImport/budget';
import { bundledTranslationsIndex, parseTranslationsIndex, useTranslationsIndexForTests } from '../worker/lib/catalogImport/translations';
import { serializeTranslationPart, sourceHash, type TranslationRow } from '../packages/catalog/src/bambuImport/i18n';

after(() => {
  setBundle(null);
  useTranslationsIndexForTests(null);
});

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const H2D = LIVE_PRODUCTS.find((p) => p.id === P.H2D)!;
const A1 = LIVE_PRODUCTS.find((p) => p.id === P.A1)!;
const X2D = LIVE_PRODUCTS.find((p) => p.id === P.X2D)!;

const row = (en: string, ar: string, ckb: string, products: string[], over: Partial<TranslationRow> = {}): TranslationRow => ({
  h: sourceHash(en),
  en,
  ar,
  ckb,
  kind: 'spec_value_text',
  status: 'reviewed',
  products: [...products].sort(),
  ...over,
});

const ROWS: TranslationRow[] = [
  row('Below 10mA', 'أقل من 10mA', 'کەمتر لە 10mA', [P.H2D, 'p_not_imported_yet']),
  row('Gray', 'رمادي', 'خۆڵەمێشی', [P.H2D, P.A1]),
  row('Plastics, PCBA', 'بلاستيك، PCBA', 'پلاستیک، PCBA', [P.X2D]),
];

/** Index exactly these parts (name → text), as the assembler would. */
function indexParts(parts: Record<string, string>): void {
  useTranslationsIndexForTests({
    version: 1,
    parts: Object.fromEntries(
      Object.entries(parts).map(([name, text]) => [name, { sha256: sha(text), rows: (JSON.parse(text) as unknown[]).length, bytes: Buffer.byteLength(text, 'utf8') }])
    ),
  });
}

interface Purges {
  deleted: string[];
}

function cacheDouble(): Purges {
  const p: Purges = { deleted: [] };
  (globalThis as { caches?: unknown }).caches = {
    default: {
      match: async () => undefined,
      put: async () => undefined,
      delete: async (req: Request | string) => {
        p.deleted.push(typeof req === 'string' ? req : req.url);
        return true;
      },
    },
  };
  return p;
}

/** The purged paths (a cache key carries the catalogue epoch as its query). */
const paths = (p: Purges) => p.deleted.map((u) => new URL(u).pathname);

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

function world(raw = undefined as ReturnType<typeof dbThrough> | undefined): OpsWorld {
  const w = opsWorld(raw ? { raw } : {});
  seedLiveCatalog(w.raw);
  setBundle(bundleTexts({ manifestRows: [], matches: [] }));
  openRun(w.raw);
  return w;
}

const load = (w: OpsWorld, part: string, text: string, token?: string | null) => w.call(`${OPS}/run/translations`, { body: { part, text }, ...(token !== undefined ? { token } : {}) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const answer = async (r: Response): Promise<Record<string, any>> => (await r.json()) as Record<string, any>;
const count = (w: OpsWorld, sql: string) => Number((w.raw.prepare(sql).get() as { n: number }).n);

test('refusals: an unknown part, bytes that differ from the index, one bad row, a database without 0196 — nothing written', async () => {
  const w = world();
  const good = serializeTranslationPart(ROWS);
  indexParts({ p001: good });
  // Unknown part.
  const unknown = await load(w, 'p002', good);
  assert.equal(unknown.status, 409);
  assert.equal((await answer(unknown)).code, 'TRANSLATIONS_PART_UNKNOWN');
  // The bytes are not the indexed ones (a row altered in transit).
  const altered = good.replace('رمادي', 'رمادي فاتح');
  const mismatch = await load(w, 'p001', altered);
  assert.equal(mismatch.status, 409);
  assert.equal((await answer(mismatch)).code, 'TRANSLATIONS_PART_MISMATCH');
  // One bad row, even in an indexed part: the whole part is refused, named by index and code, never by text.
  const bad = serializeTranslationPart([ROWS[0], { ...ROWS[1], ckb: ROWS[1].ar }, ROWS[2]]);
  indexParts({ p001: bad });
  const refused = await load(w, 'p001', bad);
  assert.equal(refused.status, 400);
  const body = await refused.text();
  const j = JSON.parse(body);
  assert.equal(j.code, 'TRANSLATIONS_ROW_INVALID');
  assert.match(j.message, /\(row:1, CKB_COPIES_AR\)$/);
  assert.ok(!body.includes('رمادي') && !body.includes('Gray'), 'no text of the part is echoed');
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translations'), 0);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translation_refs'), 0);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translation_parts'), 0);
  // A forged hash in an indexed part: the per-row proof refuses it.
  const forged = serializeTranslationPart([{ ...ROWS[1], en: 'Grey' }]);
  indexParts({ p001: forged });
  const f = await load(w, 'p001', forged);
  assert.equal(f.status, 400);
  assert.match((await answer(f)).message, /\(row:0, HASH\)$/);
  // A database at 0195: the door answers, the tables do not exist.
  const old = world(dbThrough('0195'));
  indexParts({ p001: good });
  const missing = await load(old, 'p001', good);
  assert.equal(missing.status, 409);
  assert.equal((await answer(missing)).code, 'TRANSLATIONS_SCHEMA_MISSING');
  // A part name outside the ledger's rule never reaches the loader.
  const badName = await load(w, '../p001', good);
  assert.equal(badName.status, 400);
  assert.equal((await answer(badName)).code, 'IMPORT_BAD_REQUEST');
});

test('a first load writes rows, refs and the ledger in one batch and purges its products; again → skipped; a changed row purges only its own', async () => {
  const w = world();
  const purges = cacheDouble();
  const text = serializeTranslationPart(ROWS);
  indexParts({ p001: text });
  const first = await load(w, 'p001', text);
  const firstText = await first.text();
  assert.equal(first.status, 200, firstText);
  const a = JSON.parse(firstText);
  assert.deepEqual(
    { skipped: a.skipped, rows: a.rows, inserted: a.inserted, updated: a.updated, unchanged: a.unchanged, refs_added: a.refs_added, purge_truncated: a.purge_truncated },
    { skipped: false, rows: 3, inserted: 3, updated: 0, unchanged: 0, refs_added: 5, purge_truncated: false }
  );
  assert.deepEqual(a.purge_ids, [P.H2D, P.A1, P.X2D].sort(), 'the products purged: a product not imported yet has no page to purge');
  assert.equal(a.purged_products, 3);
  assert.ok(!firstText.includes('رمادي') && !firstText.includes('Gray'), 'counts, never text');
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translations'), 3);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translation_refs'), 5);
  const ledger = (w.raw.prepare('SELECT part, sha256, rows, run_id FROM catalog_translation_parts').all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
  assert.deepEqual(ledger, [{ part: 'p001', sha256: sha(text), rows: 3, run_id: 'cir_00aa11bb22cc33dd44ee55ff' }]);
  const stored = w.raw.prepare('SELECT en, ar, ckb, kind, status, part FROM catalog_translations WHERE h = ?').get(sourceHash('Gray')) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, { en: 'Gray', ar: 'رمادي', ckb: 'خۆڵەمێشی', kind: 'spec_value_text', status: 'reviewed', part: 'p001' });
  for (const p of [H2D, A1, X2D]) {
    assert.ok(paths(purges).includes(`/api/products/${p.slug}`), `${p.slug}: the page body`);
    assert.ok(paths(purges).includes(`/api/products/${p.slug}/knowledge`), `${p.slug}: the knowledge answer`);
    assert.ok(paths(purges).includes(`/api/public/v1/products/${p.slug}`), `${p.slug}: the v1 record`);
  }
  assert.ok(!paths(purges).some((p) => /^\/api\/(home|products)$|^\/api\/home\/|^\/api\/catalog\//.test(p)), 'no listing, home or section path (cards carry no memory text)');
  // The page now reads the memory (the overlay is tested in catalogTranslationsDisplay).

  // The same part again: skipped, nothing written, nothing purged.
  purges.deleted.length = 0;
  const again = await load(w, 'p001', text);
  const b = await answer(again);
  assert.equal(b.skipped, true);
  assert.equal(b.inserted + b.updated + b.refs_added, 0);
  assert.deepEqual(purges.deleted, []);

  // One row changed (a reviewer's correction) under a new index: only its products are purged.
  const changed = serializeTranslationPart([ROWS[0], { ...ROWS[1], ar: 'رمادي فاتح', ckb: 'خۆڵەمێشی کاڵ' }, ROWS[2]]);
  indexParts({ p001: changed });
  const c = await answer(await load(w, 'p001', changed));
  assert.deepEqual({ skipped: c.skipped, inserted: c.inserted, updated: c.updated, unchanged: c.unchanged, refs_added: c.refs_added }, { skipped: false, inserted: 0, updated: 1, unchanged: 2, refs_added: 0 });
  assert.deepEqual(c.purge_ids, [P.H2D, P.A1].sort());
  assert.ok(paths(purges).includes(`/api/products/${A1.slug}`));
  assert.ok(!paths(purges).includes(`/api/products/${X2D.slug}`), 'an unchanged row purges nothing');
  assert.equal((w.raw.prepare('SELECT ar FROM catalog_translations WHERE h = ?').get(sourceHash('Gray')) as { ar: string }).ar, 'رمادي فاتح');
  // A row withdrawn: committed again as needs_review — stored, never shown, and still never deleted.
  const withdrawn = serializeTranslationPart([{ ...ROWS[0], status: 'needs_review' }]);
  indexParts({ p002: withdrawn });
  const d = await answer(await load(w, 'p002', withdrawn));
  assert.equal(d.updated, 1);
  assert.equal((w.raw.prepare('SELECT status FROM catalog_translations WHERE h = ?').get(sourceHash('Below 10mA')) as { status: string }).status, 'needs_review');
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translations'), 3);
});

test('a changed row purges every product the database links to it — one dropped from the row\'s list too (review: stale colo copies)', async () => {
  const w = world();
  const purges = cacheDouble();
  const v1 = serializeTranslationPart(ROWS);
  indexParts({ p001: v1 });
  assert.equal((await load(w, 'p001', v1)).status, 200);
  // Version 2 corrects «Gray» and lists only the H2D: the A1 still holds its ref, so its cached copy goes too.
  purges.deleted.length = 0;
  const v2 = serializeTranslationPart([ROWS[0], { ...ROWS[1], ar: 'رمادي فاتح', ckb: 'خۆڵەمێشی کاڵ', products: [P.H2D] }, ROWS[2]]);
  indexParts({ p001: v2 });
  const c = await answer(await load(w, 'p001', v2));
  assert.equal(c.updated, 1);
  assert.deepEqual(c.purge_ids, [P.H2D, P.A1].sort());
  assert.ok(paths(purges).includes(`/api/products/${A1.slug}`), 'the A1 shows the corrected words at once');
  assert.ok(paths(purges).includes(`/api/products/${A1.slug}/knowledge`));
  assert.equal(count(w, `SELECT COUNT(*) AS n FROM catalog_translation_refs WHERE h = '${sourceHash('Gray')}'`), 2, 'refs are never deleted');
  // A withdrawal whose list shrank: the withdrawn words leave every linked product's cached copy.
  purges.deleted.length = 0;
  const v3 = serializeTranslationPart([ROWS[0], { ...ROWS[1], ar: 'رمادي فاتح', ckb: 'خۆڵەمێشی کاڵ', products: [P.H2D], status: 'needs_review' }, ROWS[2]]);
  indexParts({ p001: v3 });
  const d = await answer(await load(w, 'p001', v3));
  assert.deepEqual(d.purge_ids, [P.H2D, P.A1].sort());
});

test('the purge cap counts products that exist: ids not written yet never crowd out a live page (review: p_ sorts before prd_)', async () => {
  const w = world();
  const purges = cacheDouble();
  const notYet = Array.from({ length: 70 }, (_, i) => `p_new_${String(i).padStart(3, '0')}`);
  const text = serializeTranslationPart([row('Gray', 'رمادي', 'خۆڵەمێشی', [...notYet, P.H2D, P.A1])]);
  indexParts({ p001: text });
  const a = await answer(await load(w, 'p001', text));
  assert.deepEqual(a.purge_ids, [P.H2D, P.A1].sort(), 'the live products are purged');
  assert.equal(a.purge_truncated, false, 'every existing product fit under the cap');
  assert.ok(paths(purges).includes(`/api/products/${H2D.slug}`));
  assert.ok(paths(purges).includes(`/api/products/${A1.slug}`));
});

test('a `keep` row (the English stays) loads and is stored, never shown; a reviewed row turned `keep` is withdrawn', async () => {
  const w = world();
  cacheDouble();
  const keep = row('MacOS, Windows', 'MacOS, Windows', 'MacOS, Windows', [P.H2D], { status: 'keep' });
  const v1 = serializeTranslationPart([ROWS[1], keep]);
  indexParts({ p001: v1 });
  const a = await answer(await load(w, 'p001', v1));
  assert.equal(a.inserted, 2, JSON.stringify(a));
  assert.equal((w.raw.prepare('SELECT status FROM catalog_translations WHERE h = ?').get(keep.h) as { status: string }).status, 'keep');
  const v2 = serializeTranslationPart([{ ...ROWS[1], ar: 'Gray', ckb: 'Gray', status: 'keep' }, keep]);
  indexParts({ p001: v2 });
  const b = await answer(await load(w, 'p001', v2));
  assert.equal(b.updated, 1);
  const shown = w.raw.prepare("SELECT COUNT(*) AS n FROM catalog_translations WHERE status IN ('reviewed','machine')").get() as { n: number };
  assert.equal(shown.n, 0, 'nothing of a keep row is shown as a translation');
});

test('a 250-row part: every statement ≤ 100 parameters, well under the invocation budget; no token is the uniform 404', async () => {
  const w = world();
  cacheDouble();
  const counted = countingD1(w.env.DB as D1Database);
  w.env.DB = counted.db;
  const products = Array.from({ length: 12 }, (_, i) => `p_bulk_${String(i).padStart(2, '0')}`);
  const rows = Array.from({ length: 250 }, (_, i) => row(`Line number ${i} of the part`, `السطر رقم ${i} من الجزء`, `دێڕی ژمارە ${i} لە بەشەکە`, products.slice(i % 6, (i % 6) + 4), { kind: 'block_line' }));
  const text = serializeTranslationPart(rows);
  assert.ok(Buffer.byteLength(text) < 1024 * 1024);
  indexParts({ p003: text });
  const before = counted.counter.count;
  const startViolations = violations.length;
  const res = await load(w, 'p003', text);
  const a = await answer(res);
  assert.equal(res.status, 200, JSON.stringify(a));
  assert.equal(a.inserted, 250);
  assert.equal(a.refs_added, 1000);
  const spent = counted.counter.count - before;
  // door + rate limit + ledger + 2 reads + 18 upserts + 20 refs + ledger write + purge read ≈ 45
  assert.ok(spent <= 60, `${spent} statements`);
  assert.deepEqual(violations.slice(startViolations), [], 'no statement over D1\'s limits');
  // Without a token: the door does not exist.
  const anon = await load(w, 'p003', text, null);
  assert.equal(anon.status, 404);
  assert.deepEqual(await answer(anon), { error: 'Not found' });
});

test('the bundled index is the committed one; a malformed index knows no part', () => {
  useTranslationsIndexForTests(null);
  const committed = readFileSync(join(ROOT, 'data', 'bambu-import', 'translations', 'index.json'), 'utf8');
  assert.deepEqual(parseTranslationsIndex(committed), parseTranslationsIndex(JSON.parse(committed)));
  assert.deepEqual(bundledTranslationsIndex(), parseTranslationsIndex(committed));
  for (const bad of ['', '{', '[]', '{"version":2,"parts":{}}', '{"version":1,"parts":{"x1":{"sha256":"' + 'a'.repeat(64) + '","rows":1,"bytes":1}}}', '{"version":1,"parts":{"p001":{"sha256":"A","rows":1,"bytes":1}}}']) {
    assert.deepEqual(parseTranslationsIndex(bad), { version: 1, parts: {} }, bad);
  }
});

test('every committed part loads through the real Worker: each row re-proved, within D1\'s limits and the budget; again → skipped', async () => {
  useTranslationsIndexForTests(null);
  const w = world();
  cacheDouble();
  const counted = countingD1(w.env.DB as D1Database);
  w.env.DB = counted.db;
  const dir = join(ROOT, 'data', 'bambu-import', 'translations');
  const parts = Object.keys(bundledTranslationsIndex().parts).sort();
  assert.ok(parts.length > 0, 'the reviewed translations are committed');
  const startViolations = violations.length;
  let rows = 0;
  let most = 0;
  for (const part of parts) {
    const text = readFileSync(join(dir, `${part}.json`), 'utf8');
    const before = counted.counter.count;
    const res = await load(w, part, text);
    const a = await answer(res);
    assert.equal(res.status, 200, `${part}: ${JSON.stringify(a)}`);
    assert.equal(a.inserted + a.updated + a.unchanged, a.rows, part);
    rows += a.rows;
    most = Math.max(most, counted.counter.count - before);
  }
  assert.deepEqual(violations.slice(startViolations), [], 'no statement over D1\'s limits');
  assert.ok(most <= 120, `the largest part spent ${most} statements (the invocation budget is 900)`);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translations'), rows);
  assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translation_parts'), parts.length);
  // `keep` and `needs_review` rows are stored, never shown; the Sorani is never the Arabic in what is shown.
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM catalog_translations WHERE status IN ('reviewed','machine') AND ckb = ar"), 0);
  assert.equal(count(w, "SELECT COUNT(*) AS n FROM catalog_translations WHERE status = 'keep' AND (ar <> en OR ckb <> en)"), 0);
  // The same parts again: each one skipped, nothing written.
  for (const part of parts) {
    const a = await answer(await load(w, part, readFileSync(join(dir, `${part}.json`), 'utf8')));
    assert.equal(a.skipped, true, part);
  }
});

// ---------------------------------------------------------------- the runner (scripts/bambu-import/translations.ts)

test('the runner: /hello for this run with 0196, every committed part in order through the real Worker, counts only in its log', async () => {
  const { OpsClient } = await import('../scripts/bambu-import/opsClient');
  const { Deadline } = await import('../scripts/bambu-import/deadline');
  const { configFromArgs, loadAll, readParts } = await import('../scripts/bambu-import/translations');
  const { indexOf, serializeIndex } = await import('../scripts/bambu-import/i18nData');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const w = world();
  cacheDouble();
  const dir = mkdtempSync(join(tmpdir(), 'tm-runner-'));
  try {
    const parts = new Map([
      ['p001', serializeTranslationPart(ROWS.slice(0, 2))],
      ['p002', serializeTranslationPart(ROWS.slice(2))],
    ]);
    for (const [n, t] of parts) writeFileSync(join(dir, `${n}.json`), t);
    writeFileSync(join(dir, 'index.json'), serializeIndex(indexOf(parts)));
    indexParts(Object.fromEntries(parts));
    const clock = { now: () => Date.now(), sleep: async () => undefined };
    const client = new OpsClient({ siteOrigin: 'https://levonis-iq.com', token: 'c0ffee'.repeat(10) + '1234', fetch: (u, i) => w.fetch(u, i), clock, deadline: new Deadline(Date.now() + 3600_000, clock) });
    const lines: string[] = [];
    const cfg = configFromArgs(['--data', dir, '--run', 'cir_00aa11bb22cc33dd44ee55ff', '--token-file', '/nonexistent'], {}, ROOT);
    assert.equal(cfg.siteOrigin, 'https://levonis-iq.com');
    const read = readParts(cfg.dataDir);
    assert.deepEqual(read.map((p) => p.part), ['p001', 'p002']);
    assert.equal(await loadAll(cfg, read, { client, log: (l) => lines.push(l) }), 0, lines.join('\n'));
    assert.equal(count(w, 'SELECT COUNT(*) AS n FROM catalog_translations'), 3);
    assert.match(lines.join('\n'), /p001: rows 2, inserted 2, updated 0, unchanged 0, refs 4/);
    assert.match(lines.at(-1)!, /done: 2 parts \(0 skipped\), inserted 3/);
    assert.ok(!lines.join('\n').includes('رمادي') && !lines.join('\n').includes('Gray'), 'never text');
    // Again: both skipped.
    const again: string[] = [];
    assert.equal(await loadAll(cfg, read, { client, log: (l) => again.push(l) }), 0);
    assert.match(again.at(-1)!, /done: 2 parts \(2 skipped\)/);
    // Another run's id, a part edited after its index, a site that is not ours: refused before anything is sent.
    const other: string[] = [];
    assert.equal(await loadAll({ runId: 'cir_ffffffffffffffffffffffff' }, read, { client, log: (l) => other.push(l) }), 1);
    assert.match(other.join('\n'), /another run/);
    writeFileSync(join(dir, 'p002.json'), parts.get('p002')!.replace('PCBA', 'PCB'));
    assert.throws(() => readParts(dir), /p002: the file differs from index\.json/);
    assert.throws(() => configFromArgs(['--site', 'https://evil.example', '--run', 'cir_00aa11bb22cc33dd44ee55ff', '--token-file', 'x'], {}, ROOT), /live site or a local dry run/);
    // A refusal of the Worker stops the job with its code.
    writeFileSync(join(dir, 'p002.json'), parts.get('p002')!);
    indexParts({ p001: parts.get('p001')! });
    const refused: string[] = [];
    assert.equal(await loadAll(cfg, readParts(dir), { client, log: (l) => refused.push(l) }), 1);
    assert.match(refused.at(-1)!, /::error::\[translations\] TRANSLATIONS_PART_UNKNOWN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
