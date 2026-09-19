/**
 * THE CRON THAT HAS TO EMPTY THE R2 CLEANUP QUEUE.
 *
 * Removing one picture from a saved product stopped abandoning its object in
 * R2 and started writing a `media_cleanup_jobs` row instead. That half works.
 * The half this file guards is the other one: a row is not a deletion, and for
 * a while the ONLY thing that turned a row into freed bytes was an admin
 * POSTing the maintenance endpoint by hand — a button that does not exist
 * anywhere in the product. A queue nobody drains is strictly worse than the
 * leak it replaced: the owner pays for exactly the same bytes AND carries a
 * table that only grows.
 *
 * So the properties asserted here are wiring and restraint, not arithmetic:
 *
 *  - the fifteen-minute cron entrypoint really does reach the drain — across
 *    BOTH files it takes to get there (`worker/index.ts`'s `scheduled` hands
 *    the run to `runDurableJobs`, whose last step calls
 *    `runGuardedMediaCleanup`). "The drain exists" and "something runs it" are
 *    two different facts and only the second one reclaims disk;
 *  - a queued, provably unreferenced key is actually deleted from the bucket,
 *    and the upload ledger keeps its row and gains a date rather than losing
 *    the record of who uploaded what;
 *  - a key that came back is NEVER deleted, and a schema the reference scan
 *    cannot account for deletes NOTHING AT ALL — not "most of it";
 *  - the run is bounded, and a partially drained queue resumes on the next
 *    tick instead of restarting or stalling;
 *  - a drain that throws outright is contained exactly like every other step:
 *    the run still returns a full report and the steps around it still ran.
 *
 * TECHNIQUE, AND WHY IT IS THIS ONE. tests/durableJobs.test.ts already proves
 * pipeline wiring against a REAL SQLite database built from the REAL migration
 * files, using the `tests/fixtures/d1.ts` adapter; this file uses the same one.
 * Where it goes further is the entrypoint: the Worker's `scheduled` export is
 * IMPORTED AND CALLED here, with a fake `ExecutionContext` that collects what
 * it hands to `waitUntil`, so the chain from the cron entrypoint to an actual
 * R2 delete is executed rather than pattern-matched. Only one link stays a
 * source assertion, and it is named as such where it is made.
 *
 * WHAT IT CANNOT PROVE, said plainly: Cloudflare firing the cron in
 * production, R2 itself, and D1's real concurrency — the overlapping-run
 * behaviour discussed in worker/index.ts is reasoned about there, not executed
 * here, because two runs in one process do not race the way two invocations
 * across two colos do.
 *
 * Run: node --import tsx --test tests/mediaCleanupSchedule.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, SqliteD1, createTableIfNotExistsSql } from './fixtures/d1';
import worker from '../worker/index';
import { runDurableJobs } from '../worker/lib/jobs';
import { MEDIA_CLEANUP_RUN_LIMIT } from '../worker/lib/mediaRefs';
import type { Env } from '../worker/lib/types';

// --------------------------------------------------------------- the fixture

/** Every `delete` the drain asked the bucket for, in order. */
interface FakeBucket {
  deleted: string[];
  delete(key: string): Promise<void>;
}

function fakeBucket(): FakeBucket {
  const deleted: string[] = [];
  return {
    deleted,
    async delete(key: string) {
      deleted.push(key);
    },
  };
}

/**
 * A database carrying ONLY what the drain itself reads.
 *
 * Deliberately NOT `newSqlite()`, and foreign keys are turned off below:
 * `product_images` declares four of them, so with enforcement on an honest
 * still-referenced fixture would drag half the catalogue in behind one image
 * row. The drain never reads `products` — it reads the key-bearing COLUMNS —
 * so those tables would be schema for their own sake.
 *
 * The tables are lifted verbatim from the real migrations, and 0048's ALTERs
 * are replayed, because `r2_key` is the column the reference scan actually
 * uses and a hand-written `product_images` would be a different table from the
 * one production has.
 *
 * Everything else the pipeline touches is absent on purpose: those steps then
 * fail against missing tables, which is the isolation half of this file.
 */
function freshDb(): { env: Env; raw: DatabaseSync; bucket: FakeBucket } {
  const raw = new DatabaseSync(':memory:');
  // node:sqlite enforces foreign keys by DEFAULT — unlike D1, and unlike bare
  // SQLite. Inserting one `product_images` row therefore demands `products`,
  // `product_option_values`, `product_colors` and `product_variants` as well.
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(createTableIfNotExistsSql('0072_product_deletion_integrity.sql', 'media_cleanup_jobs'));
  raw.exec(createTableIfNotExistsSql('0068_media_objects.sql', 'file_objects'));
  raw.exec(createTableIfNotExistsSql('0018_prime_taxonomy_inventory.sql', 'product_images'));
  raw.exec(`
    ALTER TABLE product_images ADD COLUMN alt_ar TEXT NOT NULL DEFAULT '';
    ALTER TABLE product_images ADD COLUMN alt_ckb TEXT NOT NULL DEFAULT '';
    ALTER TABLE product_images ADD COLUMN r2_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE product_images ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
  `);
  const bucket = fakeBucket();
  const env = {
    DB: new SqliteD1(raw) as unknown as D1Database,
    BUCKET: bucket as unknown as R2Bucket,
  } as unknown as Env;
  return { env, raw, bucket };
}

/**
 * Queue one detached object, the way `enqueueMediaDetach` does.
 *
 * `created_at` is passed explicitly rather than left to the column default:
 * the queue is read oldest-first, and fifty rows inserted inside one
 * millisecond all carry the same `strftime('…%f…')` value, which would make
 * "the bound leaves the NEWEST ten behind" an assertion about SQLite's tie
 * ordering instead of about the bound. One real second apart, so the ordering
 * the drain relies on is the ordering this fixture actually has.
 */
function enqueue(raw: DatabaseSync, key: string, nth: number): void {
  const createdAt = new Date(Date.UTC(2026, 0, 1) + nth * 1000).toISOString();
  raw
    .prepare(
      `INSERT INTO media_cleanup_jobs (id, object_key, visibility, reason, source_product_id, created_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(`mcj_${nth}`, key, 'public', 'image_detach', 'prod_1', createdAt);
}

/** The nth key of a synthetic backlog; padded so the keys sort like the queue. */
const queuedKey = (nth: number) => `products/queued${String(nth).padStart(4, '0')}.jpg`;

/** The upload ledger row the detach left behind; the drain must date it, not drop it. */
function ledger(raw: DatabaseSync, key: string): void {
  raw
    .prepare(
      `INSERT INTO file_objects (object_key, visibility, domain, owner_id, mime_type, byte_size)
       VALUES (?,?,?,?,?,?)`
    )
    .run(key, 'public', 'product', 'u1', 'image/jpeg', 12345);
}

const jobState = (raw: DatabaseSync, key: string) =>
  raw.prepare('SELECT state, attempts FROM media_cleanup_jobs WHERE object_key = ?').get(key) as
    | { state: string; attempts: number }
    | undefined;

const pendingCount = (raw: DatabaseSync) =>
  (raw.prepare("SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE state = 'pending'").get() as { n: number }).n;

/** Comments removed — prose describing a rule is never the rule (the repo idiom). */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ------------------------------------------------------------ the wiring

/** Cloudflare hands the handler one of these; nothing here reads its fields. */
const cronEvent = () => ({ cron: '', scheduledTime: Date.now(), noRetry() {} }) as unknown as ScheduledEvent;

/**
 * An ExecutionContext that KEEPS what it is given.
 *
 * `waitUntil` is the whole contract of a scheduled handler: work not handed to
 * it may be killed the moment the handler returns, and a handler that starts
 * the run without registering it would drain the queue only as far as the
 * runtime felt like letting it. So the fake collects the promises instead of
 * discarding them, and the test awaits them — which is also the only way the
 * drain's own async work is observable from here.
 */
function fakeCtx() {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    ctx: { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext,
  };
}

/**
 * THE CHAIN, EXECUTED — not pattern-matched.
 *
 * This calls the exact export Cloudflare's cron scheduler calls, with a queued
 * job in a real database and a bucket that records what it is asked to remove.
 * A refactor that leaves `runGuardedMediaCleanup` exported but stops calling it
 * from the cron is precisely the regression this catches, and that regression
 * is silent in every other way: nothing 500s, nothing looks broken, the bucket
 * just quietly stops shrinking and the queue just quietly grows.
 */
test('the cron entrypoint really drains the queue — scheduled → runDurableJobs → the bucket', async () => {
  const { env, raw, bucket } = freshDb();
  enqueue(raw, 'products/eeee5555.jpg', 1);
  const { waited, ctx } = fakeCtx();

  worker.scheduled(cronEvent(), env, ctx);

  assert.equal(waited.length, 1, 'the run must be registered with waitUntil, not merely started');
  await Promise.all(waited);

  assert.deepEqual(bucket.deleted, ['products/eeee5555.jpg'], 'the cron must reach R2, not just the report');
  assert.equal(jobState(raw, 'products/eeee5555.jpg')?.state, 'done');
});

/**
 * THE ONE LINK THAT STAYS A SOURCE ASSERTION, AND WHY.
 *
 * `runDurableJobs` cannot reject today — every await inside it is already
 * inside its `step()` try/catch — so there is no env this test could build
 * that would make the promise handed to `waitUntil` reject. The `.catch` at
 * the entrypoint is therefore guarding a FUTURE line added outside `step`,
 * and the only way to assert it is on the source. Without it, that future
 * line's rejection is an unhandled rejection in `waitUntil`: the whole
 * scheduled invocation fails, and nothing this codebase logs says which job
 * did it.
 */
test('the entrypoint contains its own rejection, the way every step inside the run does', () => {
  const index = code(readFileSync(join(ROOT, 'worker/index.ts'), 'utf8'));
  assert.match(index, /scheduled\(\s*_event: ScheduledEvent/, 'the Worker must still export a scheduled handler');
  assert.match(index, /runDurableJobs\(env\)\.catch\(/, 'the entrypoint must contain what it schedules');
});

/**
 * The fifteen-minute claim in worker/index.ts is a claim about a config file,
 * so it is checked against that file rather than trusted. If the cron is ever
 * slowed to hourly, the comment that tells an operator how long a deleted
 * image survives in R2 becomes wrong, and this fails instead of the operator
 * finding out from a storage bill.
 */
test("the cron really is every fifteen minutes, which is what bounds a deleted image's life in R2", () => {
  const wrangler = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const crons = [...wrangler.matchAll(/"crons"\s*:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(crons.length > 0, 'wrangler.jsonc must still declare a cron trigger');
  for (const entry of crons) {
    assert.match(entry, /"\*\/15 \* \* \* \*"/, `expected a fifteen-minute cron, got ${entry}`);
  }
});

// ------------------------------------------------------- the drain, running

test('a queued, unreferenced object is deleted, and the upload ledger keeps its row', async () => {
  const { env, raw, bucket } = freshDb();
  enqueue(raw, 'products/aaaa1111.jpg', 1);
  enqueue(raw, 'products/bbbb2222.jpg', 2);
  ledger(raw, 'products/aaaa1111.jpg');

  const report = await runDurableJobs(env);

  assert.deepEqual(report.media_cleanup.refusals, [], 'this schema is fully classified, so nothing may refuse');
  assert.equal(report.media_cleanup.attempted, 2);
  assert.equal(report.media_cleanup.deleted, 2);
  assert.deepEqual(bucket.deleted.sort(), ['products/aaaa1111.jpg', 'products/bbbb2222.jpg']);
  assert.equal(jobState(raw, 'products/aaaa1111.jpg')?.state, 'done');
  assert.equal(pendingCount(raw), 0);

  // The ledger row survives with a date on it. Deleting it would destroy the
  // record of who uploaded what and when, along with the bytes.
  const row = raw
    .prepare('SELECT object_key, owner_id, deleted_at FROM file_objects WHERE object_key = ?')
    .get('products/aaaa1111.jpg') as { object_key: string; owner_id: string; deleted_at: string | null };
  assert.equal(row.owner_id, 'u1', 'the upload ledger row must not be deleted');
  assert.ok(row.deleted_at, 'it must be dated instead');
});

/**
 * THE UNDO. Between the detach and the tick, the admin put the picture back —
 * or moved it to another product. The job says "this was unreferenced when we
 * queued it", which is not the question the bucket delete answers.
 */
test('a key that came back is closed skipped_shared, and its bytes survive', async () => {
  const { env, raw, bucket } = freshDb();
  enqueue(raw, 'products/cccc3333.jpg', 1);
  raw
    .prepare("INSERT INTO product_images (id, product_id, url, r2_key) VALUES ('img1','prod_9','/files/products/cccc3333.jpg','products/cccc3333.jpg')")
    .run();

  const report = await runDurableJobs(env);

  assert.deepEqual(bucket.deleted, [], 'a referenced object must never be handed to the bucket');
  assert.equal(report.media_cleanup.deleted, 0);
  assert.equal(report.media_cleanup.still_referenced, 1);
  assert.equal(jobState(raw, 'products/cccc3333.jpg')?.state, 'skipped_shared');
});

/**
 * THE REFUSAL, WHICH IS THE WHOLE SAFETY PROPERTY.
 *
 * A migration adds a column that can hold an object key and that nothing in
 * mediaRefs.ts has an opinion about. From that moment the reference set is a
 * guess, and the destructive path must refuse rather than delete "the ones it
 * is fairly sure about". The queue stays intact so the same tick's work is
 * still there once the column is classified.
 */
test('an unclassified key-bearing column stops the run dead — nothing is deleted', async () => {
  const { env, raw, bucket } = freshDb();
  enqueue(raw, 'products/dddd4444.jpg', 1);
  raw.exec("CREATE TABLE promo_banners (id TEXT PRIMARY KEY, image_key TEXT NOT NULL DEFAULT '')");

  const report = await runDurableJobs(env);

  assert.ok(report.media_cleanup.refusals.length > 0, 'the run must say what it could not account for');
  assert.match(report.media_cleanup.refusals.join(' '), /promo_banners\.image_key/);
  assert.deepEqual(bucket.deleted, [], 'a guess must never reach the bucket');
  assert.equal(report.media_cleanup.deleted, 0);
  assert.equal(jobState(raw, 'products/dddd4444.jpg')?.state, 'pending', 'the work is kept, not lost');
});

// ------------------------------------------------------------- the bound

/**
 * A QUEUE OF TEN THOUSAND MUST NOT TRY TO BE A TICK OF TEN THOUSAND.
 *
 * Every job is a bucket delete plus two D1 writes, and a chunk of twenty-five
 * costs a full reference scan on top. Unbounded, one mass deletion would run
 * the invocation into the Worker's CPU limit and the sub-request cap, and the
 * tick would die somewhere in the middle of the queue — which is survivable
 * only because of the second half of this test: what was not reached is still
 * `pending` and is read again, oldest first, on the next tick.
 *
 * Sized against the real constant rather than a copy of it, so raising
 * `MEDIA_CLEANUP_RUN_LIMIT` does not quietly leave this asserting the old
 * number.
 */
test('the run is bounded, and the remainder resumes on the next tick', async () => {
  const { env, raw, bucket } = freshDb();
  const total = MEDIA_CLEANUP_RUN_LIMIT + 10;
  for (let i = 1; i <= total; i++) enqueue(raw, queuedKey(i), i);

  const first = await runDurableJobs(env);
  assert.equal(first.media_cleanup.attempted, MEDIA_CLEANUP_RUN_LIMIT, 'one tick takes the bound, never the queue');
  assert.equal(first.media_cleanup.deleted, MEDIA_CLEANUP_RUN_LIMIT);
  assert.equal(bucket.deleted.length, MEDIA_CLEANUP_RUN_LIMIT, 'and the bucket saw exactly that many calls');
  assert.equal(pendingCount(raw), 10, 'the rest is kept, still pending');

  // Oldest first: the ten left behind are the ten most recently queued.
  assert.equal(jobState(raw, queuedKey(1))?.state, 'done');
  assert.equal(jobState(raw, queuedKey(total))?.state, 'pending');

  // The next tick finishes the queue rather than starting it over — a job
  // leaves `pending` exactly once, so nothing is deleted twice.
  const second = await runDurableJobs(env);
  assert.equal(second.media_cleanup.attempted, 10);
  assert.equal(second.media_cleanup.deleted, 10);
  assert.equal(pendingCount(raw), 0);
  assert.equal(bucket.deleted.length, total, 'and no key was handed to the bucket twice');
});

// --------------------------------------------------------- the containment

/**
 * A D1 whose READ OF THE QUEUE rejects.
 *
 * This is the shape of a real failure, not an invented one: a transient
 * "Network connection lost" or a write-lock timeout on the one SELECT the
 * drain opens with. Unwrapped, that rejection leaves `pendingMediaCleanup`,
 * then leaves `runGuardedMediaCleanup` entirely, and the question this test
 * exists for is what it takes with it.
 *
 * IT HAS TO BE THIS STATEMENT, AND THE NARROWNESS IS THE POINT. Almost
 * nothing else in the drain can throw outward: the `PRAGMA table_info` behind
 * `tableExists` swallows its own errors and reports "no such table", every
 * bucket delete is caught per job, and every ledger write goes through the
 * drain's own `write()` helper into `bookkeeping_failures`. A fixture that
 * broke every statement mentioning `media_cleanup_jobs` would therefore be
 * caught by that PRAGMA and prove nothing — which is worth saying out loud,
 * because "the step is well contained internally" and "the step cannot take
 * the run down" are different claims and only the second one is asserted here.
 */
function brokenQueueDb(raw: DatabaseSync): D1Database {
  const real = new SqliteD1(raw);
  return {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      const guard = () => {
        if (/FROM\s+media_cleanup_jobs/i.test(sql)) throw new Error('D1_ERROR: Network connection lost');
      };
      const wrap = (bound: ReturnType<SqliteD1['prepare']>) => ({
        bind: (...values: unknown[]) => wrap(bound.bind(...values)),
        run: async () => { guard(); return bound.run(); },
        first: async () => { guard(); return bound.first(); },
        all: async () => { guard(); return bound.all(); },
      });
      return wrap(stmt) as unknown as D1PreparedStatement;
    },
    batch: (statements: unknown[]) => real.batch(statements as never[]),
  } as unknown as D1Database;
}

test('a drain that throws is contained — the report still comes back, and the other steps still ran', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(createTableIfNotExistsSql('0072_product_deletion_integrity.sql', 'media_cleanup_jobs'));
  const bucket = fakeBucket();
  const env = { DB: brokenQueueDb(raw), BUCKET: bucket as unknown as R2Bucket } as unknown as Env;

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let report;
  try {
    report = await runDurableJobs(env);
  } finally {
    console.error = realError;
  }

  // Contained, named and reported — never a rejected run.
  assert.ok(
    report.errors.some((e) => e.startsWith('media_cleanup:')),
    `the failure must be attributed to its step, got ${JSON.stringify(report.errors)}`
  );
  assert.ok(logged.some((l) => l.includes('media_cleanup')), 'and logged where an operator looks');

  // The report still carries the step's shape rather than a hole, so a
  // maintenance view reading it does not have to guess.
  assert.deepEqual(report.media_cleanup, {
    attempted: 0, deleted: 0, still_referenced: 0, dead_lettered: 0, retrying: 0, refusals: [],
  });

  // ORDERING, STATED HONESTLY: `media_cleanup` is the LAST step in the run, so
  // there is no step after it for a throw to starve. The containment that
  // matters is therefore in the other direction — every step BEFORE it must
  // still have produced its own result, and the run must still resolve with a
  // full report rather than rejecting into `ctx.waitUntil`.
  assert.deepEqual(report.outbox_final, { sent: 0, failed: 0 });
  assert.deepEqual(report.bnpl_overdue, { scanned: 0, overdue: 0, suspended: 0 });
  assert.deepEqual(report.automatic_reviews, { scanned: 0, created: 0, skipped: 0 });
  assert.ok(report.ran_at, 'the run completed and dated itself');
  assert.equal(bucket.deleted.length, 0, 'and a queue it could not read is a queue it must not delete from');
});
