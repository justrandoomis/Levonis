/**
 * /complete: BOTH SIDES PASS AND AGREE, OR NOTHING MOVES (Bambu import spec
 * §I.1, §I.1.10; worker/lib/catalogImport/complete.ts).
 *
 *   - the runner's evidence and the Worker's own D1 recompute agree → COMPLETE
 *     with live_url, verified_at, d1_checks, edge_evidence (no free detail) and
 *     the lease-fenced COMPLETED event;
 *   - a hard check the runner failed, a check it did not run, counts that are
 *     not the written payload's, a D1 fact that disagrees → VERIFYING_LIVE, the
 *     failed check NAMES only, the records kept for the owner;
 *   - price-request eligibility through validatePriceRequestSelection: a
 *     complete selection eligible, an incomplete one SELECTION_REQUIRED, a bogus
 *     one fails the check — and no request row is ever created;
 *   - the live URL must be this item's page on the origin called; a stale lease
 *     aborts the COMPLETE whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, newWorld, RUN_ID, stage, write, type World } from './fixtures/catalogImportWorld';
import type { ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { OpsRefusal, type ImportRun } from '../worker/lib/catalogImport/auth';
import { applyEvent, finishPublishing, itemBySource } from '../worker/lib/catalogImport/items';
import { sample } from './fixtures/bambu/load';
import { publishV2 } from './fixtures/v2Publish';
import { agreementOf, completeItem, EXPECTED_EDGE_CHECKS } from '../worker/lib/catalogImport/complete';
import { payloadCounts } from '../worker/lib/catalogImport/writer';

const RUN: ImportRun = { id: RUN_ID, state: 'running', token_expires_at: '', github_run_id: '42', reviewed_bundle_sha256: '', code_commit: '', manifest_total: 0, started_at: '' };
const ORIGIN = 'https://levonis-iq.com';
const URL_OF = (slug: string) => `${ORIGIN}/product/${slug}`;

async function verifying(handle: 'ams-2-pro-feeder-unit' | 'h2d' = 'ams-2-pro-feeder-unit') {
  const w = newWorld();
  const s = stage(w, handle);
  const { result } = await write(w, s);
  const item = await itemBySource(w.db, RUN_ID, s.payload.source_product_id);
  await finishPublishing(w.db, RUN, item);
  return { w, s, result };
}

function evidence(p: ImportPayload, slug: string, over: { checks?: Record<string, unknown>; counts?: Record<string, number>; selections?: string[][] } = {}) {
  const checks: Record<string, unknown> = {};
  for (const k of EXPECTED_EDGE_CHECKS) checks[k] = { ok: true, hard: true, status: 200, counts: { n: 1 }, detail: { expected: 'a'.repeat(64), note: 'never stored' } };
  // The browser's own check (scripts/bambu-import/browser.ts): always part of the evidence (§I.1.7).
  checks.browser = { ok: true, checks: { hero: true, gallery: true } };
  return {
    version: 1,
    live_url: URL_OF(slug),
    round: 1,
    checks: { ...checks, ...(over.checks ?? {}) },
    sections: { leaf: 'printer-parts', root: 'parts', secondary: [] },
    selections_checked: over.selections ?? [p.groups.map((g) => g.default_value_id).filter(Boolean)],
    counts: over.counts ?? payloadCounts(p),
  };
}

const complete = async (w: World, sid: string, body: Record<string, unknown>) =>
  completeItem({ DB: w.db, BUCKET: w.bucket as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never }, `${ORIGIN}/api/ops/catalog-import/items/${sid}/complete`, RUN, await itemBySource(w.db, RUN_ID, sid), w.bundle, body);

const itemRow = (w: World, id: string) => w.raw.prepare('SELECT processing_state AS state, live_url, verified_at, d1_checks, edge_evidence FROM catalog_import_items WHERE id = ?').get(id) as Record<string, string>;

test('runner evidence and the Worker recompute agree: COMPLETE, the records stored without free detail, the fenced event', async () => {
  const { w, s, result } = await verifying();
  const a = await complete(w, s.payload.source_product_id, { lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: evidence(s.payload, result.slug) });
  assert.equal(a.state, 'COMPLETE');
  assert.equal(a.d1_checks.ok, true);
  assert.deepEqual(a.d1_checks.agreement.failed, []);
  assert.ok(typeof a.seq === 'number' && a.seq > 0);
  const row = itemRow(w, s.itemId);
  assert.equal(row.state, 'COMPLETE');
  assert.equal(row.live_url, URL_OF(result.slug));
  assert.ok(row.verified_at);
  assert.doesNotMatch(row.edge_evidence, /never stored|detail/, 'a check\'s free detail is never stored');
  assert.match(row.d1_checks, /"agreement"/);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_events WHERE item_id = ? AND stage = 'COMPLETED'", s.itemId), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_price_requests'), 0, 'eligibility created no request');
});

test('any disagreement moves nothing: counts not the written payload\'s, a hard check failed, a check missing, a D1 fact', async () => {
  const { w, s, result } = await verifying();
  const sid = s.payload.source_product_id;
  const body = (ev: unknown) => ({ lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: ev });
  const cases: Array<[string, unknown, string]> = [
    ['counts', evidence(s.payload, result.slug, { counts: { ...payloadCounts(s.payload), images: 99 } }), 'counts.edge_vs_written_payload'],
    ['a hard check', evidence(s.payload, result.slug, { checks: { search: { ok: false, hard: true } } }), 'edge.search'],
    ['a missing check', (() => { const e = evidence(s.payload, result.slug); delete (e.checks as Record<string, unknown>).compare; return e; })(), 'edge.compare.missing'],
    ['the browser', evidence(s.payload, result.slug, { checks: { browser: { ok: false, checks: { hero: false } } } }), 'edge.browser'],
  ];
  for (const [label, ev, failed] of cases) {
    const a = await complete(w, sid, body(ev));
    assert.equal(a.state, 'VERIFYING_LIVE', label);
    assert.ok(a.d1_checks.agreement.failed.includes(failed), `${label}: ${JSON.stringify(a.d1_checks.agreement.failed)}`);
    assert.equal(itemRow(w, s.itemId).state, 'VERIFYING_LIVE', `${label}: nothing moved`);
  }
  // A soft check that failed is not a disagreement.
  assert.equal((await complete(w, sid, body(evidence(s.payload, result.slug, { checks: { search: { ok: false, hard: false } } })))).state, 'COMPLETE');
  // The disagreements were recorded as info events, by code.
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_events WHERE item_id = ? AND code = 'IMPORT_VERIFY_DISAGREES'", s.itemId), cases.length);
});

test('a D1 fact the runner cannot see: a lost image row refuses COMPLETE (d1.counts)', async () => {
  const { w, s, result } = await verifying();
  const img = w.raw.prepare('SELECT id FROM product_images WHERE product_id = ? AND is_primary = 0 LIMIT 1').get(s.payload.product_id) as { id: string };
  w.raw.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
  const a = await complete(w, s.payload.source_product_id, { lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: evidence(s.payload, result.slug) });
  assert.equal(a.state, 'VERIFYING_LIVE');
  assert.ok(a.d1_checks.agreement.failed.includes('d1.counts'));
});

test('price-request eligibility through the POST\'s validator: complete and incomplete selections pass, a bogus one fails; no request row', async () => {
  const { w, s, result } = await verifying('h2d');
  const sid = s.payload.source_product_id;
  const values = s.payload.groups.flatMap((g) => g.values.map((v) => v.id));
  const complete1 = s.payload.variants[0].value_ids;
  const ok = await complete(w, sid, { lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: evidence(s.payload, result.slug, { selections: [complete1, [values[0]], ['ov_not_a_value']] }) });
  assert.equal(ok.state, 'VERIFYING_LIVE');
  assert.deepEqual(ok.d1_checks.agreement.failed, ['d1.price_request'], 'the bogus selection is neither eligible nor SELECTION_REQUIRED');
  const good = await complete(w, sid, { lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: evidence(s.payload, result.slug, { selections: [complete1, [values[0]]] }) });
  assert.equal(good.state, 'COMPLETE');
  assert.equal(Number(good.d1_checks.counts.selections_checked), 3, 'the default selection and the two the runner checked');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_price_requests'), 0);
});

test('the live URL must be this item\'s page on the origin called; a stale lease aborts the COMPLETE whole', async () => {
  const { w, s, result } = await verifying();
  const sid = s.payload.source_product_id;
  for (const url of [`https://evil.example/product/${result.slug}`, `${ORIGIN}/product/another-slug`, `${ORIGIN}/product/${result.slug}?x=1`]) {
    await assert.rejects(
      () => complete(w, sid, { lease_token: 'lease_test_0001', live_url: url, edge_evidence: evidence(s.payload, result.slug) }),
      (e: unknown) => e instanceof OpsRefusal && e.status === 400,
      url
    );
  }
  // The lease lapses between the read and the batch: the COMPLETED event's fence aborts it.
  const item = await itemBySource(w.db, RUN_ID, sid);
  w.raw.prepare("UPDATE catalog_import_items SET lease_until = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(s.itemId);
  await assert.rejects(
    () => completeItem({ DB: w.db, BUCKET: w.bucket as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never }, `${ORIGIN}/x`, RUN, item, w.bundle, { lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: evidence(s.payload, result.slug) }),
    (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_LEASE_LOST'
  );
  assert.equal(itemRow(w, s.itemId).state, 'VERIFYING_LIVE');
});

test('a merge needs the runner\'s merge check AND the before_fp_equal the write recorded; every COMPLETE needs the browser check', () => {
  const ev = { version: 1 as const, live_url: '', round: 1, checks: Object.fromEntries(EXPECTED_EDGE_CHECKS.map((k) => [k, { ok: true, hard: true }])), browser: { ok: true, checks: 2, failed: 0 }, sections: { leaf: '', root: '', secondary: [] }, selections_checked: 1, counts: { groups: 1 } };
  const d1 = { ok: true, checks: {}, counts: {}, failed: [] };
  const recorded = { before_fp_equal: true };
  assert.deepEqual(agreementOf(ev, d1, { groups: 1 }, false).failed, []);
  assert.deepEqual(agreementOf(ev, d1, { groups: 1 }, true, recorded).failed, ['edge.merge.missing']);
  assert.deepEqual(agreementOf({ ...ev, checks: { ...ev.checks, merge: { ok: false, hard: true } } }, d1, { groups: 1 }, true, recorded).failed, ['edge.merge']);
  // W1: evidence without the browser check is never a COMPLETE.
  assert.deepEqual(agreementOf({ ...ev, browser: null }, d1, { groups: 1 }, false).failed, ['edge.browser.missing']);
  // W2: the runner's merge check alone is not the proof — the write's own record is (a lost /write answer is not `true`).
  const merged = { ...ev, checks: { ...ev.checks, merge: { ok: true, hard: true } } };
  assert.deepEqual(agreementOf(merged, d1, { groups: 1 }, true, recorded).failed, []);
  assert.deepEqual(agreementOf(merged, d1, { groups: 1 }, true, {}).failed, ['write.before_fp_equal'], 'absent counts as not equal');
  assert.deepEqual(agreementOf(merged, d1, { groups: 1 }, true, { before_fp_equal: false }).failed, ['write.before_fp_equal']);
});

test('review 6b: /complete is fenced on the state it read — an item that moved during the recompute gets no COMPLETED event', async () => {
  const { w, s, result } = await verifying();
  const sid = s.payload.source_product_id;
  const stale = await itemBySource(w.db, RUN_ID, sid);
  // Under the same lease, the item is parked (the runner's in-job retry after an ambiguous /complete).
  await applyEvent(w.db, RUN, stale, { state: 'RETRYING', outcome: 'retry', code: 'OPS_UNREACHABLE', retry_at: '', release: false, detail: {} });
  const env = { DB: w.db, BUCKET: w.bucket as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never };
  const body = { lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: evidence(s.payload, result.slug) };
  await assert.rejects(
    () => completeItem(env, `${ORIGIN}/x`, RUN, stale, w.bundle, body),
    (e: unknown) => e instanceof OpsRefusal && e.status === 409 && e.code === 'IMPORT_ILLEGAL_TRANSITION'
  );
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_events WHERE item_id = ? AND stage = 'COMPLETED'", s.itemId), 0, 'no phantom COMPLETED event');
  assert.equal(itemRow(w, s.itemId).state, 'RETRYING');
  // The not-COMPLETE branch too: no record, no info event, for an item that moved.
  const failing = { ...body, edge_evidence: evidence(s.payload, result.slug, { checks: { v1: { ok: false, hard: true } } }) };
  const before = count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_events WHERE item_id = ? AND code = 'IMPORT_VERIFY_DISAGREES'", s.itemId);
  await assert.rejects(() => completeItem(env, `${ORIGIN}/x`, RUN, stale, w.bundle, failing), (e: unknown) => e instanceof OpsRefusal && e.code === 'IMPORT_ILLEGAL_TRANSITION');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_events WHERE item_id = ? AND code = 'IMPORT_VERIFY_DISAGREES'", s.itemId), before);
});

test('review 6b: a merge completes on the before_fp_equal its write recorded, and never without it', async () => {
  const w = newWorld();
  const x = sample('a1');
  w.raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, category_id, options, colors, images)
    VALUES ('p_a1m', 'bambu-a1-m', 'Bambu Lab A1', 'بامبو A1', 'بامبو A1', 'active', 0, 'cat_printers', '[]', '[]', '[]')`);
  w.raw.exec("INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_a1m', 'cat_printers', 1)");
  w.matches.push({ source_product_id: x.sourceProductId, source_handle: x.handle, levonis_product_id: 'p_a1m', decision: 'merge', value_map: {}, unmapped_variants: [], reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  const s = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1m' });
  const { result } = await write(w, s);
  await publishV2(w.raw, 'p_a1m'); // the owner's own price on the merged product (a merge keeps its own V2 state)
  await finishPublishing(w.db, RUN, await itemBySource(w.db, RUN_ID, s.payload.source_product_id));
  // A merged product keeps its own options: the runner checks the selections of ITS page (none beyond the default here).
  const base = evidence(s.payload, result.slug, { selections: [] });
  const merged = { ...base, checks: { ...base.checks, merge: { ok: true, hard: true } } };
  // The record lost (as if the post-commit record had never landed): refused, whatever the runner says.
  w.raw.prepare("UPDATE catalog_import_items SET stage_data = json_remove(stage_data, '$.before_fp_equal') WHERE id = ?").run(s.itemId);
  const without = await complete(w, s.payload.source_product_id, { lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: merged });
  assert.equal(without.state, 'VERIFYING_LIVE');
  assert.ok(without.d1_checks.agreement.failed.includes('write.before_fp_equal'));
  // As the write recorded it: COMPLETE.
  w.raw.prepare("UPDATE catalog_import_items SET stage_data = json_set(stage_data, '$.before_fp_equal', json('true')) WHERE id = ?").run(s.itemId);
  const ok = await complete(w, s.payload.source_product_id, { lease_token: 'lease_test_0001', live_url: URL_OF(result.slug), edge_evidence: merged });
  assert.equal(ok.state, 'COMPLETE', JSON.stringify(ok.d1_checks.failed.concat(ok.d1_checks.agreement.failed)));
});

test('review 6b, 2: a thrown R2 HEAD during the recompute is a transient 503 before any record, in both binding shapes; only an object R2 lacks fails d1.media', async () => {
  const { R2Double } = await import('./fixtures/imageDoubles');
  for (const shape of ['one bucket (the fixtures)', 'R2_PUBLIC apart from the legacy BUCKET (wrangler.jsonc)'] as const) {
    const { w, s, result } = await verifying();
    const sid = s.payload.source_product_id;
    const env = { DB: w.db, BUCKET: (shape.startsWith('one') ? w.bucket : new R2Double()) as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never };
    const call = async () =>
      completeItem(env, `${ORIGIN}/api/ops/catalog-import/items/${sid}/complete`, RUN, await itemBySource(w.db, RUN_ID, sid), w.bundle, {
        lease_token: 'lease_test_0001',
        live_url: URL_OF(result.slug),
        edge_evidence: evidence(s.payload, result.slug),
      });
    const head = w.bucket.head.bind(w.bucket);
    let thrown = 0;
    w.bucket.head = (async (k: string) => {
      if (thrown === 0) {
        thrown++;
        throw new Error('R2 internal error (10001)');
      }
      return head(k);
    }) as typeof w.bucket.head;
    await assert.rejects(call, (e: unknown) => e instanceof OpsRefusal && e.status === 503 && e.code === 'IMPORT_STORAGE_UNAVAILABLE', shape);
    assert.equal(thrown, 1, shape);
    assert.equal(itemRow(w, s.itemId).state, 'VERIFYING_LIVE', `${shape}: nothing moved`);
    assert.equal(itemRow(w, s.itemId).d1_checks, '{}', `${shape}: no d1_checks recorded`);
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_events WHERE item_id = ? AND code = 'IMPORT_VERIFY_DISAGREES'", s.itemId), 0, `${shape}: no disagreement event`);
    // An object R2 positively does not have is a failed check, not a transient answer.
    w.bucket.head = head as typeof w.bucket.head;
    const gone = (w.raw.prepare('SELECT r2_key FROM product_images WHERE product_id = ? AND is_primary = 0 LIMIT 1').get(s.payload.product_id) as { r2_key: string }).r2_key;
    const bytes = w.bucket.objects.get(gone);
    w.bucket.objects.delete(gone);
    const missing = await call();
    assert.equal(missing.state, 'VERIFYING_LIVE', shape);
    assert.ok(missing.d1_checks.agreement.failed.includes('d1.media'), `${shape}: ${JSON.stringify(missing.d1_checks.agreement.failed)}`);
    // R2 answers and has every object: COMPLETE.
    w.bucket.objects.set(gone, bytes!);
    const ok = await call();
    assert.equal(ok.state, 'COMPLETE', `${shape}: ${JSON.stringify(ok.d1_checks.agreement.failed)}`);
  }
});
