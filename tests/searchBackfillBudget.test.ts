/**
 * THE SEARCH-INDEX CATCH-UP WITHIN A STATEMENT BUDGET (DECISIONS row 201).
 *
 * The quarter-hour cron runs the catch-up after its jobs, with only what they
 * left of D1's 1,000 statements (worker/lib/quarterHourBudget.ts). Its fifty-
 * product chunk once cost about 1,079 statements with the tick's other jobs —
 * over the limit by itself. `backfillSearchIndex` now charges every statement
 * before it sends it and leaves what does not fit for the next pass. This
 * holds, on a real database counted at the binding:
 *   - a pass executes exactly what it charged, never more than its budget;
 *   - a product that does not fit stays stale AND untouched (its old rows
 *     still answer a search), and a later pass writes it whole;
 *   - pass after pass ends at exactly the index an unbudgeted pass writes;
 *   - a product too large for ANY budgeted pass is marked and reported once,
 *     not selected first and skipped on every tick;
 *   - a group that fails is retried one by one within the same budget;
 *   - an empty budget executes nothing — the catch-up's probe included;
 *   - the search-alias read (migration 0194, worker/lib/search/aliases.ts) is
 *     charged like every other read: its presence probe once per binding, when
 *     it is sent, and one statement per 90 products — none without 0194;
 *   - without a budget the pass is what it was (`deferred` stays 0).
 *
 * Since `#doc:6` a product's rows go in `INDEX_ROWS_PER_STATEMENT` to a
 * statement (worker/lib/search/store.ts), so a plan is its DELETE and one
 * INSERT per 500 rows: the fixtures size descriptions in quarters of that to
 * keep plans of different sizes, and the huge product is twelve INSERTs' worth.
 *
 * Run: node --import tsx --test tests/searchBackfillBudget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb } from './fixtures/app';
import { SqliteD1, type SqliteStatement } from './fixtures/d1';
import { countingD1 } from '../worker/lib/d1Count';
import { statementBudget } from '../worker/lib/fx/budget';
import { catchUpSearchIndex } from '../worker/lib/jobs';
import { toSearchDoc } from '../worker/lib/search/document';
import {
  backfillSearchIndex,
  INDEX_FAILED_MARK,
  INDEX_ROWS_PER_STATEMENT,
  INDEX_STAMP,
  planSearchIndex,
  searchDocColumns,
  searchDocReadCount,
  searchDocsForRows,
  searchProducts,
} from '../worker/lib/search/store';
import type { Env } from '../worker/lib/types';
import { aliasReadCount } from '../worker/lib/search/aliases';
import { catalogKnowledgeInstalled, catalogKnowledgeKnown } from '../worker/lib/catalogKnowledge';

/** A word per index: distinct Latin words the tokeniser keeps (letters only, four or more). */
const word = (i: number) => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `qu${s.padStart(3, 'a')}`;
};

/**
 * Thirty active products, descriptions of 0–14 words — or, `long`, of 0–14
 * quarters of an INSERT's rows, so plans differ in size: the rows go in
 * `INDEX_ROWS_PER_STATEMENT` to a statement (`#doc:6`), and a short product is
 * its DELETE and one INSERT. `huge` is a product no budgeted pass can write.
 */
function seedCatalogue(raw: DatabaseSync, opts: { huge?: string; long?: boolean } = {}) {
  const quarter = Math.ceil(INDEX_ROWS_PER_STATEMENT / 4);
  for (let i = 0; i < 30; i++) {
    const id = `p_${String(i).padStart(2, '0')}`;
    const words = id === opts.huge ? INDEX_ROWS_PER_STATEMENT * 12 : (i % 15) * (opts.long ? quarter : 1);
    const description = Array.from({ length: words }, (_, j) => word(i * 1000 + j)).join(' ');
    raw
      .prepare("INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES (?, ?, ?, ?, 1000, 'active')")
      .run(id, id, `Widget ${word(i)}`, description);
  }
}

const staleIndex = (raw: DatabaseSync) =>
  Number(
    (
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM products p WHERE p.status = 'active' AND NOT EXISTS (SELECT 1 FROM search_tokens t WHERE t.product_id = p.id AND t.token IN (?, ?))"
        )
        .get(INDEX_STAMP, INDEX_FAILED_MARK) as { n: number }
    ).n
  );
const tokens = (raw: DatabaseSync) => raw.prepare('SELECT product_id, token, weight FROM search_tokens ORDER BY product_id, token').all();

/** The plan size of every active product, from the same builder the pass uses. */
async function planSizes(raw: DatabaseSync): Promise<Map<string, number>> {
  const db = asD1(raw);
  const rows = raw.prepare(`SELECT ${searchDocColumns()} FROM products WHERE status = 'active' ORDER BY id`).all() as Record<string, unknown>[];
  const docs = await searchDocsForRows(db, rows);
  return new Map(docs.map((d) => [d.productId, planSearchIndex(db, d).length]));
}

test('a budgeted pass executes exactly what it charged, defers what does not fit, and pass after pass ends at the unbudgeted index', async () => {
  const reference = freshDb();
  seedCatalogue(reference, { long: true });
  const ref = await backfillSearchIndex(asD1(reference), { limit: 50 });
  assert.equal(ref.indexed, 30);
  assert.equal(ref.deferred, 0, 'no budget, nothing deferred');
  assert.equal(staleIndex(reference), 0);

  const raw = freshDb();
  seedCatalogue(raw, { long: true });
  const sizes = await planSizes(raw);
  const largest = Math.max(...sizes.values());
  const LIMIT = 20;
  assert.equal(Math.min(...sizes.values()), 2, 'a short product: its DELETE and one INSERT, the stamp in it');
  assert.ok(largest <= LIMIT - 2 && largest >= 5, `plans of 2..${largest} statements, every one within a pass of ${LIMIT}`);

  const counted = countingD1(asD1(raw));
  let passes = 0;
  while (staleIndex(raw) > 0 && passes < 40) {
    passes += 1;
    const budget = statementBudget(LIMIT);
    const before = counted.executed;
    const run = await backfillSearchIndex(counted.db, { limit: 50, budget, ceiling: LIMIT });
    const executed = counted.executed - before;
    assert.equal(executed, budget.used, `pass ${passes}: executed ${executed}, charged ${budget.used}`);
    assert.ok(executed <= LIMIT, `pass ${passes}: ${executed} ≤ ${LIMIT}`);
    assert.deepEqual(run.failed, []);
    assert.ok(run.indexed > 0, `pass ${passes}: progress`);
    if (staleIndex(raw) > 0) assert.ok(run.deferred > 0, `pass ${passes}: the rest deferred, not dropped`);
  }
  assert.ok(passes > 1, `the budget spread the work over ${passes} passes`);
  assert.equal(staleIndex(raw), 0, 'every product indexed');
  assert.deepEqual(tokens(raw), tokens(reference), 'the same index, row for row, as one unbudgeted pass');
});

test('a product that does not fit THIS pass waits stale and untouched — its old rows still answer — and the next pass writes it whole', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES ('p_big', 'p_big', 'Widget quaaa', ?, 1000, 'active')").run(
    Array.from({ length: 30 }, (_, j) => word(500 + j)).join(' ')
  );
  const db = asD1(raw);
  // The rows an OLDER builder wrote: findable by its name only, and without the current stamp.
  await db.batch(planSearchIndex(db, toSearchDoc({ id: 'p_big', name: 'Widget quaaa' })));
  raw.prepare('DELETE FROM search_tokens WHERE token = ?').run(INDEX_STAMP);
  const old = tokens(raw);
  assert.deepEqual((await searchProducts(db, 'quaaa')).ids, ['p_big']);
  const size = (await planSizes(raw)).get('p_big')!;

  const counted = countingD1(db);
  // Migration 0194's presence is asked once per binding (worker/lib/catalogKnowledge.ts) — asked here, so
  // each pass below pays only for its own reads: the selection and the alias read (worker/lib/search/aliases.ts).
  assert.equal(await catalogKnowledgeInstalled(counted.db), true);
  const reads = 1 + aliasReadCount(['p_big']);
  const small = statementBudget(reads + size); // the reads, then the batch fits; the mark its failure would need does not
  const before = counted.executed;
  const first = await backfillSearchIndex(counted.db, { limit: 50, budget: small, ceiling: 950 });
  assert.equal(counted.executed - before, small.used);
  assert.deepEqual({ indexed: first.indexed, deferred: first.deferred, failed: first.failed }, { indexed: 0, deferred: 1, failed: [] });
  assert.deepEqual(tokens(raw), old, 'untouched: not one row written or removed');
  assert.deepEqual((await searchProducts(db, 'quaaa')).ids, ['p_big'], 'still findable by what it was findable by');

  // The reads, the batch and the mark its failure would need.
  const second = await backfillSearchIndex(counted.db, { limit: 50, budget: statementBudget(reads + size + 1), ceiling: 950 });
  assert.deepEqual({ indexed: second.indexed, deferred: second.deferred }, { indexed: 1, deferred: 0 });
  assert.equal(staleIndex(raw), 0);
  assert.deepEqual((await searchProducts(db, word(512))).ids, ['p_big'], 'the description, indexed whole');
});

test('a product too large for ANY budgeted pass is marked and reported once — not selected first and skipped every tick — and the rest are indexed', async () => {
  const raw = freshDb();
  seedCatalogue(raw, { huge: 'p_00' });
  const sizes = await planSizes(raw);
  const CEILING = 12;
  assert.ok(sizes.get('p_00')! > CEILING, `the huge product needs ${sizes.get('p_00')} statements`);

  const counted = countingD1(asD1(raw));
  const budget = statementBudget(CEILING);
  const before = counted.executed;
  const first = await backfillSearchIndex(counted.db, { limit: 50, budget, ceiling: CEILING });
  assert.equal(counted.executed - before, budget.used);
  assert.deepEqual(first.failed.map((f) => f.id), ['p_00']);
  assert.match(first.failed[0].error, /^needs \d+ statements, more than one budgeted pass may spend \(\d+\)$/);
  assert.equal(
    Number((raw.prepare('SELECT COUNT(*) AS n FROM search_tokens WHERE product_id = ? AND token = ?').get('p_00', INDEX_FAILED_MARK) as { n: number }).n),
    1,
    'written down'
  );
  // Every pass after: the huge product is never selected again; the rest finish.
  for (let i = 0; i < 40 && staleIndex(raw) > 0; i++) {
    const run = await backfillSearchIndex(counted.db, { limit: 50, budget: statementBudget(CEILING), ceiling: CEILING });
    assert.deepEqual(run.failed, [], 'reported once');
  }
  assert.equal(staleIndex(raw), 0, 'the other 29 indexed');
});

test('a group that fails is retried one by one within the same budget; the product that cannot be written is marked; nothing past the budget', async () => {
  const raw = freshDb();
  seedCatalogue(raw);
  const inner = new SqliteD1(raw);
  const poisoned = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: async (stmts: SqliteStatement[]) => {
      if (stmts.some((s) => (s as unknown as { params: unknown[] }).params?.[0] === 'p_03' && /INSERT/.test((s as unknown as { sql: string }).sql)))
        throw new Error('simulated: statement too large');
      return inner.batch(stmts);
    },
  } as unknown as D1Database;
  const counted = countingD1(poisoned);
  const failed: string[] = [];
  for (let i = 0; i < 40 && staleIndex(raw) > 0; i++) {
    const budget = statementBudget(120);
    const before = counted.executed;
    const run = await backfillSearchIndex(counted.db, { limit: 50, budget, ceiling: 120 });
    assert.equal(counted.executed - before, budget.used, 'a failed batch is charged like a sent one');
    assert.ok(budget.used <= 120);
    failed.push(...run.failed.map((f) => f.id));
  }
  assert.deepEqual(failed, ['p_03'], 'the poison product, once');
  assert.equal(staleIndex(raw), 0, 'the other 29 indexed, p_03 marked');
});

test('an empty budget executes nothing, the catch-up’s probe included; the probe and every read are charged', async () => {
  const raw = freshDb();
  seedCatalogue(raw);
  const counted = countingD1(asD1(raw));
  const env = { DB: counted.db } as unknown as Env;

  let before = counted.executed;
  const none = await catchUpSearchIndex(env, { budget: statementBudget(0), ceiling: 950 });
  assert.deepEqual(none, { indexed: 0, deferred: 0, errors: [] });
  assert.equal(counted.executed - before, 0, 'not even the probe');

  before = counted.executed;
  const probeOnly = statementBudget(1);
  await catchUpSearchIndex(env, { budget: probeOnly, ceiling: 950 });
  assert.equal(counted.executed - before, 1, 'the probe, and nothing it could not pay for');

  // The selection and the name reads are counted before they are sent.
  const rows = raw.prepare(`SELECT ${searchDocColumns()} FROM products WHERE status = 'active'`).all() as Record<string, unknown>[];
  assert.equal(searchDocReadCount(rows), 0, 'no brand or section: no name read');
  assert.equal(searchDocReadCount([{ brand_id: 'b1', category_id: 'c1', sub_category_id: 'c2' }]), 2, 'one read for brands, one for sections');
  assert.equal(
    searchDocReadCount(Array.from({ length: 50 }, (_, i) => ({ brand_id: `b${i}`, category_id: `c${i}`, sub_category_id: `s${i}` }))),
    3,
    'fifty brands in one slice; a hundred sections in two of 90'
  );

  before = counted.executed;
  const full = statementBudget(950);
  const run = await catchUpSearchIndex(env, { budget: full, ceiling: 950 });
  assert.equal(run.indexed, 30);
  assert.equal(counted.executed - before, full.used, 'the probe, the selection and every batch statement, charged first');
});

test('the alias read is charged like every other read: its 0194 probe once per binding and only when sent, one read per 90 products — and nothing of it on a database without 0194', async () => {
  for (const through of [null, '0193'] as const) {
    const label = through === null ? 'with 0194' : 'without 0194';
    const raw = through === null ? freshDb() : dbThrough(through);
    seedCatalogue(raw);
    const total = [...(await planSizes(raw)).values()].reduce((a, b) => a + b, 0);
    const counted = countingD1(asD1(raw));
    assert.equal(catalogKnowledgeKnown(counted.db), null, `${label}: a fresh binding has not asked`);

    // The selection is paid for, the probe is not: it is not sent, and the pass defers everything it selected.
    let before = counted.executed;
    const starved = await backfillSearchIndex(counted.db, { limit: 50, budget: statementBudget(1), ceiling: 950 });
    assert.equal(counted.executed - before, 1, `${label}: the selection, and not the probe it could not pay for`);
    assert.deepEqual({ indexed: starved.indexed, deferred: starved.deferred }, { indexed: 0, deferred: 30 });
    assert.equal(catalogKnowledgeKnown(counted.db), null, `${label}: still unknown — nothing was asked`);

    // The next pass pays the probe once, then the alias read where 0194 is present (30 products: one statement).
    before = counted.executed;
    const budget = statementBudget(950);
    const run = await backfillSearchIndex(counted.db, { limit: 50, budget, ceiling: 950 });
    assert.equal(run.indexed, 30);
    assert.equal(counted.executed - before, budget.used, `${label}: executed what it charged`);
    const aliasRead = through === null ? 1 : 0;
    assert.equal(budget.used, 1 + 1 + aliasRead + total, `${label}: the selection, the probe, ${aliasRead} alias read(s), the batches`);
    assert.equal(catalogKnowledgeKnown(counted.db), through === null, `${label}: the answer is remembered`);

    // Stale again (a stamp bump): the probe is not asked again on this binding.
    raw.prepare('DELETE FROM search_tokens WHERE token = ?').run(INDEX_STAMP);
    const again = statementBudget(950);
    before = counted.executed;
    await backfillSearchIndex(counted.db, { limit: 50, budget: again, ceiling: 950 });
    assert.equal(counted.executed - before, again.used);
    assert.equal(again.used, 1 + aliasRead + total, `${label}: no second probe`);
  }
});
