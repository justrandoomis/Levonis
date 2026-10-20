/**
 * THE REQUEST-MODEL CACHE JOB (P1-04, worker/lib/requestModelBackfill.ts;
 * docs/DECISIONS.md row 266).
 *
 * Pinned: it builds every unbuilt version-1 row, and a second run finds
 * nothing and writes nothing (idempotent); it never writes a request, a
 * revision, an offer, an order or a v1 column; it never touches a version-3
 * row; a writer that lands between its read and its write is left for the
 * next pass (the guard); it spends at most its budget, counted at the binding;
 * one request that cannot be written is marked `error` and never stalls the
 * rest — AT THE TICK'S OWN 40, with the bad row sorting first, whether the
 * check in code finds it or only a failed batch does; this build's own v1
 * edits and a file arriving put a built cache back on the list; and `drift`
 * (the admin route, by hand) rebuilds a cache an older build left stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, json, post, row, stubApp } from './fixtures/app';
import { catchUpRequestModels, descentAttempts, pageWorstCase, REQUEST_MODEL_PAGE } from '../worker/lib/requestModelBackfill';
import { REQUEST_MODEL_TICK_BUDGET } from '../worker/lib/quarterHourBudget';
import { insertRequestFile } from '../worker/lib/requestFileHooks';
import { statementBudget } from '../worker/lib/fx/budget';
import { countingD1 } from '../worker/lib/d1Count';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { addFile, dump, newDraft, offerOn, PLA, publish, saveDraft, world } from './fixtures/requestModelWorld';

const FRESH = `(model_mirror = json_array(process, process_unsure, material_id, material_unsure, color_hex, color_name, colors_count, primary_file_id, source_type, source_kind, source_url, source_provider, stated_dims))`;

/**
 * `n` published v1 requests: the first through the routes (it takes an offer), the rest as the old
 * build's rows (a burst of drafts through the route would meet its rate limit).
 */
async function manyRequests(n: number) {
  const raw = world();
  const first = await newDraft(raw);
  addFile(raw, first, 'crf_b0', 'reference', 'p0.png');
  assert.equal((await publish(raw, first, { ...PLA, color_name: 'Navy' })).status, 200);
  const ids = [first];
  const req = raw.prepare(
    `INSERT INTO community_requests (id, customer_id, title, description, status, state, quantity, governorate, revision, created_at, updated_at)
     VALUES (?, 'buyer', 'A bracket', 'A bracket for a shelf', 'open', 'open', 1, 'baghdad', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
  );
  const print = raw.prepare(
    `INSERT INTO community_print_requests (request_id, process, material_id, color_name, colors_count, source_type, updated_at)
     VALUES (?, 'fdm', 'pla', ?, ?, 'description', '2026-10-01T00:00:00.000Z')`
  );
  for (let i = 1; i < n; i++) {
    const id = `req_bulk_${String(i).padStart(3, '0')}`;
    req.run(id);
    print.run(id, i % 4 === 0 ? 'Navy' : '', (i % 3) + 1);
    if (i % 2 === 0) addFile(raw, id, `crf_b${i}`, 'reference', `p${i}.png`);
    ids.push(id);
  }
  // As the deploy finds them: written by the old build, never built.
  raw.exec("UPDATE community_print_requests SET model_mirror = ''");
  return { raw, ids };
}

const job = (raw: DatabaseSync, opts: Partial<Parameters<typeof catchUpRequestModels>[1]> = {}) =>
  catchUpRequestModels({ DB: asD1(raw) }, { budget: statementBudget(1000), ...opts });

const modelTables = (raw: DatabaseSync) =>
  ['community_request_sources', 'community_request_parts', 'community_request_part_sources', 'community_request_part_materials'].map((t) =>
    dump(raw, t, t === 'community_request_part_sources' ? 'part_id, source_id' : 'id')
  );
const untouchable = (raw: DatabaseSync) => [
  dump(raw, 'community_requests', 'id'),
  dump(raw, 'community_request_revisions', 'id'),
  dump(raw, 'community_offers', 'id'),
  dump(raw, 'community_orders', 'id'),
  JSON.stringify(raw.prepare(`SELECT request_id, process, material_id, color_hex, color_name, colors_count, primary_file_id, source_type, source_url, updated_at, estimate FROM community_print_requests ORDER BY request_id`).all()),
];

test('builds every unbuilt row; a second run finds nothing and writes nothing; no request, revision, offer, order or v1 column moves', async () => {
  const { raw, ids } = await manyRequests(30);
  await offerOn(raw, ids[0]);
  const before = untouchable(raw);
  const first = await job(raw);
  assert.deepEqual([first.scanned, first.built, first.skipped, first.errors, first.mirror_mismatch], [30, 30, 0, 0, 0]);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_print_requests WHERE ${FRESH} AND schema_version = 1`), 30);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_parts'), 30);
  assert.deepEqual(untouchable(raw), before);

  const tables = modelTables(raw);
  const summaries = dump(raw, 'community_print_requests', 'request_id');
  const second = await job(raw);
  assert.deepEqual([second.scanned, second.built], [0, 0], 'idempotent: nothing pending');
  assert.deepEqual(modelTables(raw), tables);
  assert.equal(dump(raw, 'community_print_requests', 'request_id'), summaries);
});

test('never touches a version-3 row, even one whose stamp is empty', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await saveDraft(raw, id, { schema_version: 3, parts: [{ name: 'A', materials: [{ material_id: 'pla' }] }, { name: 'B', materials: [{ material_id: 'petg' }] }] })).status, 200);
  raw.exec(`UPDATE community_print_requests SET model_mirror = '' WHERE request_id = '${id}'`);
  const tables = modelTables(raw);
  const report = await job(raw);
  assert.equal(report.scanned, 0);
  assert.deepEqual(modelTables(raw), tables);
  assert.equal(row<{ v: number }>(raw, 'SELECT schema_version AS v FROM community_print_requests WHERE request_id = ?', id)!.v, 3);
});

test('THE GUARD: a writer that lands between the read and the write is left alone, and built on the next pass', async () => {
  const { raw, ids } = await manyRequests(3);
  const base = asD1(raw);
  let raced = false;
  const racing = new Proxy(base, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          // The write batch opens with the parts DELETE: a customer's save lands just before it.
          if (!raced && statements.length === 7) {
            raced = true;
            raw.exec(`UPDATE community_print_requests SET updated_at = '2099-01-01T00:00:00.000Z', material_id = 'abs' WHERE request_id = '${ids[1]}'`);
          }
          return target.batch(statements);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const report = await catchUpRequestModels({ DB: racing }, { budget: statementBudget(1000) });
  assert.ok(raced);
  assert.deepEqual([report.built, report.skipped], [2, 1]);
  assert.equal(row<{ m: string }>(raw, 'SELECT model_mirror AS m FROM community_print_requests WHERE request_id = ?', ids[1])!.m, '', 'left unbuilt');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_parts WHERE request_id = ?', ids[1]), 0, 'not one statement of the page touched it');
  const next = await job(raw);
  assert.equal(next.built, 1);
  assert.equal(row<{ m: string }>(raw, 'SELECT material_id AS m FROM community_request_part_materials WHERE part_id = ?', `rpt_${ids[1]}_1`)!.m, 'abs', 'built from the row as the writer left it');
});

test('spends at most its budget, counted at the binding, and only on pages it can write', async () => {
  const { raw } = await manyRequests(90);
  const counted = countingD1(asD1(raw));
  let before = counted.executed;
  const report = await catchUpRequestModels({ DB: counted.db }, { budget: statementBudget(40) });
  let spent = counted.executed - before;
  assert.equal(spent, 33, 'three full pages, and no read of a fourth it could not write');
  assert.deepEqual([report.built, report.stopped], [75, true]);
  before = counted.executed;
  const rest = await catchUpRequestModels({ DB: counted.db }, { budget: statementBudget(40) });
  spent = counted.executed - before;
  assert.deepEqual([rest.built, rest.stopped, spent], [15, false, 11], 'the last short page, then nothing');
});

test('one request that cannot be written is marked error and never stalls the others; drift retries it', async () => {
  const { raw, ids } = await manyRequests(5);
  // A row from before the link was validated: an address longer than a source may hold.
  raw.exec(`UPDATE community_print_requests SET source_url = 'https://example.com/${'x'.repeat(9000)}' WHERE request_id = '${ids[2]}'`);
  const report = await job(raw);
  assert.deepEqual([report.built, report.errors], [4, 1]);
  assert.equal(row<{ m: string }>(raw, 'SELECT model_mirror AS m FROM community_print_requests WHERE request_id = ?', ids[2])!.m, 'error');
  assert.equal((await job(raw)).scanned, 0, 'the error row left the work list: the job does not stall on it');
  const drift = await job(raw, { mode: 'drift' });
  assert.deepEqual([drift.scanned, drift.errors], [1, 1], 'drift retries it (and it still cannot be written)');
});

test('drift mode rebuilds a cache an older build left stale after a rollback', async () => {
  const { raw, ids } = await manyRequests(2);
  await job(raw);
  // The older build edits the v1 row: it knows nothing of the stamp.
  raw.exec(`UPDATE community_print_requests SET material_id = 'abs', colors_count = 4 WHERE request_id = '${ids[0]}'`);
  assert.equal((await job(raw)).scanned, 0, 'unbuilt mode does not see a stale stamp');
  const drift = await job(raw, { mode: 'drift' });
  assert.deepEqual([drift.scanned, drift.built], [1, 1]);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_print_requests WHERE ${FRESH}`), 2);
  const colours = JSON.parse(row<{ c: string }>(raw, 'SELECT colors AS c FROM community_request_part_materials WHERE part_id = ?', `rpt_${ids[0]}_1`)!.c);
  assert.equal(colours.length, 4);
});

test('the admin route runs it by hand: a dry run counts and writes nothing; a run builds; both answer counts only', async () => {
  const { raw } = await manyRequests(3);
  const admin = stubApp(asD1(raw), { id: 'admin1', role: 'admin', email: 'admin@x.co' }, (a) => a.route('/api/admin/community', adminCommunityRoutes));
  const tables = modelTables(raw);
  const dry = await json(await post(admin, '/api/admin/community/request-models/backfill', { dry_run: true, limit: 100 }));
  assert.equal(dry.report.dry_run, true);
  assert.equal(dry.report.scanned, 3);
  assert.deepEqual(modelTables(raw), tables, 'a dry run writes nothing');
  const run = await json(await post(admin, '/api/admin/community/request-models/backfill', { limit: 2 }));
  assert.deepEqual([run.report.built, run.report.next_after !== null], [2, true]);
  const rest = await json(await post(admin, '/api/admin/community/request-models/backfill', { after: run.report.next_after }));
  assert.equal(rest.report.built, 1);
  assert.ok(!JSON.stringify(run).includes('phone stand'), 'counts only, no request content');
});

/** The request that sorts first among the unbuilt: the one every quarter-hour tick reads first. */
const firstUnbuilt = (raw: DatabaseSync) =>
  row<{ id: string }>(raw, "SELECT MIN(request_id) AS id FROM community_print_requests WHERE model_mirror = '' AND schema_version = 1")!.id;
const pending = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM community_print_requests WHERE model_mirror = '' AND schema_version = 1");
const tick = (raw: DatabaseSync) => catchUpRequestModels({ DB: asD1(raw) }, { budget: statementBudget(REQUEST_MODEL_TICK_BUDGET) });

test("the first page's whole descent and its error mark fit the tick's share: 25 requests cost at most 40", () => {
  assert.equal(REQUEST_MODEL_PAGE, 25);
  assert.equal(descentAttempts(25), 5, '25, 12, 6, 3, 1');
  assert.equal(pageWorstCase(REQUEST_MODEL_PAGE), REQUEST_MODEL_TICK_BUDGET);
  assert.ok(pageWorstCase(32) > REQUEST_MODEL_TICK_BUDGET, 'a page of 32 would not fit: 32, 16, 8, 4, 2, 1');
});

test("AT THE TICK'S 40: a row the tables would refuse sorts first — it is marked error up front and the page builds around it", async () => {
  const { raw } = await manyRequests(30);
  const bad = firstUnbuilt(raw);
  // A link longer than any source holds (a value no writer of this build can store).
  raw.exec(`UPDATE community_print_requests SET source_url = 'https://example.com/${'x'.repeat(9000)}' WHERE request_id = '${bad}'`);
  const first = await tick(raw);
  assert.deepEqual([first.errors, first.built], [1, 29], JSON.stringify(first));
  assert.equal(row<{ m: string }>(raw, 'SELECT model_mirror AS m FROM community_print_requests WHERE request_id = ?', bad)!.m, 'error');
  assert.equal(pending(raw), 0);
});

test("AT THE TICK'S 40: a batch that fails for a reason no check can see, its row first, still moves every tick — never the same page forever", async () => {
  const { raw } = await manyRequests(30);
  const bad = firstUnbuilt(raw);
  // Unwritable in SQL only: the check in code passes it, the batch it joins fails.
  raw.exec(`CREATE TRIGGER t_unwritable BEFORE INSERT ON community_request_parts WHEN NEW.request_id = '${bad}'
            BEGIN SELECT RAISE(ABORT, 'unwritable'); END`);
  const first = await tick(raw);
  assert.equal(first.errors, 1, `the descent reached the bad row and marked it inside the 40: ${JSON.stringify(first)}`);
  assert.equal(row<{ m: string }>(raw, 'SELECT model_mirror AS m FROM community_print_requests WHERE request_id = ?', bad)!.m, 'error');
  const second = await tick(raw);
  assert.equal(second.errors, 0);
  assert.equal(pending(raw), 0, `every other request built on the next tick: ${JSON.stringify(second)}`);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM community_print_requests WHERE ${FRESH} AND schema_version = 1`), 29);
});

test('a smaller share reads a smaller first page, so the descent still fits; below one request it reads nothing', async () => {
  const { raw } = await manyRequests(30);
  const bad = firstUnbuilt(raw);
  raw.exec(`CREATE TRIGGER t_unwritable BEFORE INSERT ON community_request_parts WHEN NEW.request_id = '${bad}'
            BEGIN SELECT RAISE(ABORT, 'unwritable'); END`);
  const small = await catchUpRequestModels({ DB: asD1(raw) }, { budget: statementBudget(25) });
  assert.equal(small.scanned, 3, 'a page of 3: 1 + 3 + 7 × 2 + 1 = 19 ≤ 25; a page of 6 would need 26');
  assert.equal(small.errors, 1);
  const none = await catchUpRequestModels({ DB: asD1(raw) }, { budget: statementBudget(11) });
  assert.deepEqual([none.scanned, none.stopped], [0, true]);
});

test("THIS BUILD'S OWN V1 EDIT puts a built cache back on the list, and the scheduled pass rebuilds it", async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, { ...PLA, colors_count: 2 })).status, 200);
  assert.equal((await job(raw)).built, 1);
  assert.equal(row<{ s: string }>(raw, 'SELECT review_state AS s FROM community_print_requests WHERE request_id = ?', id)!.s, 'needs_technical_review');
  // The wizard (a v1 body) changes the material and the colours.
  assert.equal((await publish(raw, id, { ...PLA, material_id: 'petg', colors_count: 1 })).status, 200);
  assert.equal(row<{ m: string }>(raw, 'SELECT model_mirror AS m FROM community_print_requests WHERE request_id = ?', id)!.m, '', 'back on the list');
  const again = await job(raw);
  assert.equal(again.built, 1, 'the scheduled (unbuilt) pass rebuilt it');
  const p = row<{ s: string; m: string; c: number }>(raw, 'SELECT review_state AS s, materials_json AS m, colors_total AS c FROM community_print_requests WHERE request_id = ?', id)!;
  assert.deepEqual([p.s, JSON.parse(p.m), p.c], ['', ['petg'], 1]);
  assert.equal(row<{ m: string }>(raw, 'SELECT material_id AS m FROM community_request_part_materials WHERE part_id = ?', `rpt_${id}_1`)!.m, 'petg');
  // The draft door does the same.
  const draft = await newDraft(raw);
  assert.equal((await saveDraft(raw, draft, { ...PLA })).status, 200);
  await job(raw);
  assert.equal((await saveDraft(raw, draft, { ...PLA, material_id: 'abs' })).status, 200);
  assert.equal(row<{ m: string }>(raw, 'SELECT model_mirror AS m FROM community_print_requests WHERE request_id = ?', draft)!.m, '');
});

test('A FILE ARRIVING on a request whose v1 cache is built puts it back on the list, and the rebuild carries the file', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, PLA)).status, 200);
  assert.equal((await job(raw)).built, 1);
  await insertRequestFile(asD1(raw), {
    id: 'crf_late', requestId: id, ownerId: 'buyer', key: 'requests/buyer/files/crf_late.png', name: 'late.png', mime: 'image/png', bytes: 64, kind: 'reference',
  });
  assert.equal(row<{ m: string }>(raw, 'SELECT model_mirror AS m FROM community_print_requests WHERE request_id = ?', id)!.m, '');
  assert.equal((await job(raw)).built, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_request_sources WHERE request_id = ? AND file_id = 'crf_late'", id), 1);
});
