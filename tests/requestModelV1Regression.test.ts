/**
 * ACCEPTANCE 27 — A V1 REQUEST WITH A PENDING OFFER LIVES THROUGH MIGRATION
 * 0208 AND ITS JOB UNTOUCHED (P1-04, docs/DECISIONS.md row 266).
 *
 * The live database, as workflow 7 meets it: built through 0207, holding a
 * published v1 request with a pending offer, and another whose offer was
 * accepted into a funded order. Then the deploy applies 0208 and the quarter-
 * hour job materialises every model. Pinned:
 *
 *   - the revisions, offers, orders and requests tables are byte-identical,
 *     and so is every v1 column of the print rows (the job writes none);
 *   - `composeSnapshot` gives the very spec, files and hash revision 1 holds;
 *   - republishing as stored, or with the identical v1 body, is `replayed`:
 *     same revision, the offer still pending (a replay rewrites only the
 *     row's `created_at`, `reason` and estimate, exactly as it did before);
 *   - accepting the offer succeeds and the order's snapshot carries the hash
 *     captured before the migration;
 *   - the other order's `community_orders` row never moved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, row } from './fixtures/app';
import { composeSnapshot } from '../worker/lib/requestRevisions';
import { readRequestModel } from '../worker/lib/requestModel';
import { catchUpRequestModels } from '../worker/lib/requestModelBackfill';
import { statementBudget } from '../worker/lib/fx/budget';
import { apply0208, as, dump, fund, newDraft, offerOn, publish, world } from './fixtures/requestModelWorld';

const V1_BODY = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 2, color_hex: '#d32f2f', color_name: 'Red', customer_notes: 'please sand the top', governorate: 'baghdad' };
const V1_COLUMNS = `request_id, process, material_id, color_hex, color_name, quality, infill_percent, supports, colors_count, post_processing_minutes,
  primary_file_id, source_kind, source_provider, source_url, source_meta, analysis, estimate, estimate_low_iqd, estimate_high_iqd, estimate_confidence,
  completeness, created_at, updated_at, source_type, process_unsure, material_unsure, stated_dims`;

async function liveBefore0208() {
  const raw = world('0207');
  fund(raw, 'buyer', 1_000_000);
  // A: published, one pending offer on revision 1.
  const a = await newDraft(raw);
  assert.equal((await publish(raw, a, V1_BODY)).status, 200);
  const pending = await offerOn(raw, a, 30_000);
  // B: published, its offer accepted into a funded order.
  const b = await newDraft(raw, { title: 'A lamp shade', description: 'A lamp shade for a desk lamp' });
  assert.equal((await publish(raw, b, { ...V1_BODY, material_id: 'petg', quantity: 1 })).status, 200);
  const won = await offerOn(raw, b, 25_000);
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${won.id}/accept`, { expected_total_iqd: 25_000, offer_revision: won.revision });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  return { raw, a, b, pending };
}

/** 0208's added columns, which an older row holds at their defaults. */
const ADDED = ['budget_visible', 'coverage_json', 'substitutions_json', 'covers_all'];
const without = (raw: DatabaseSync, table: string) =>
  JSON.stringify(raw.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((r) => Object.fromEntries(Object.entries({ ...(r as object) }).filter(([k]) => !ADDED.includes(k)))));

const snapshotOf = (raw: DatabaseSync) => ({
  revisions: dump(raw, 'community_request_revisions', 'id'),
  offers: without(raw, 'community_offers'),
  orders: dump(raw, 'community_orders', 'id'),
  requests: without(raw, 'community_requests'),
  printV1: JSON.stringify(raw.prepare(`SELECT ${V1_COLUMNS} FROM community_print_requests ORDER BY request_id`).all().map((r) => ({ ...(r as object) }))),
  files: dump(raw, 'community_request_files', 'id'),
});

test('acceptance 27: 0208 and its job leave every v1 byte where it was; the snapshot recomputes to the same hash', async () => {
  const { raw, a } = await liveBefore0208();
  const before = snapshotOf(raw);
  const rev1 = row<{ spec: string; files: string; hash: string }>(raw, 'SELECT spec, files, hash FROM community_request_revisions WHERE request_id = ? AND revision = 1', a)!;

  apply0208(raw);
  const report = await catchUpRequestModels({ DB: asD1(raw) }, { budget: statementBudget(500) });
  assert.equal(report.built, 2, JSON.stringify(report));
  assert.equal(report.mirror_mismatch, 0);
  assert.deepEqual(snapshotOf(raw), before, 'migration + job wrote nothing but the model, its summary and its stamp');
  // The added columns hold their defaults: a private budget (Q2), offers covering the whole request.
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_requests WHERE budget_visible <> 0')!.n, 0);
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE coverage_json IS NOT NULL OR substitutions_json <> '[]' OR covers_all <> 1")!.n, 0);
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM community_print_requests WHERE model_mirror <> '' AND schema_version = 1")!.n, 2);

  const snap = (await composeSnapshot(asD1(raw), a))!;
  assert.equal(snap.hash, rev1.hash);
  assert.equal(JSON.stringify(snap.spec), rev1.spec);
  assert.equal(JSON.stringify(snap.files), rev1.files);
  const read = (await readRequestModel(asD1(raw), a))!;
  assert.equal(read.schema_version, 1);
  assert.equal(read.origin, 'synthesized', 'a version-1 request is read from its v1 row, never from the cache');
});

test('acceptance 27: after the deploy, republishing as stored or with the identical v1 body is a replay; the offer is accepted at the old hash', async () => {
  const { raw, a, b, pending } = await liveBefore0208();
  const rev1 = row<{ spec: string; files: string; hash: string }>(raw, 'SELECT spec, files, hash FROM community_request_revisions WHERE request_id = ? AND revision = 1', a)!;
  const orderB = dump(raw, `community_orders WHERE request_id = '${b}'`, 'id');
  apply0208(raw);
  await catchUpRequestModels({ DB: asD1(raw) }, { budget: statementBudget(500) });

  for (const body of [{}, V1_BODY]) {
    const res = await publish(raw, a, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.replayed, true, JSON.stringify(body));
    assert.equal(res.body.revision, 1);
    const now = row<{ spec: string; files: string; hash: string }>(raw, 'SELECT spec, files, hash FROM community_request_revisions WHERE request_id = ? AND revision = 1', a)!;
    assert.deepEqual([now.spec, now.files, now.hash], [rev1.spec, rev1.files, rev1.hash]);
    assert.equal(row<{ state: string; request_revision: number }>(raw, 'SELECT state FROM community_offers WHERE id = ?', pending.id)!.state, 'pending');
  }
  assert.equal(row<{ v: number }>(raw, 'SELECT schema_version AS v FROM community_print_requests WHERE request_id = ?', a)!.v, 1, 'a v1 body never makes a request version 3');

  const offers = (await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${a}/offers`))).offers as Array<{ id: string; revision: number; total_iqd?: number; price_iqd: number }>;
  const o = offers.find((x) => x.id === pending.id)!;
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${pending.id}/accept`, { expected_total_iqd: o.total_iqd ?? o.price_iqd, offer_revision: o.revision });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const order = row<{ request_snapshot: string; request_revision: number }>(raw, 'SELECT request_snapshot, request_revision FROM community_orders WHERE request_id = ?', a)!;
  assert.equal(order.request_revision, 1);
  assert.equal(JSON.parse(order.request_snapshot).hash, rev1.hash, 'the order froze the hash captured before 0208');
  assert.equal(dump(raw, `community_orders WHERE request_id = '${b}'`, 'id'), orderB, 'an accepted order snapshot is never touched');
});
