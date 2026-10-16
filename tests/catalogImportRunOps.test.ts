/**
 * THE RUN-LEVEL CALLS AND THE OWNER-APPROVED WITHDRAWAL (Bambu import spec
 * §A.3, §A.9, §E.4, §1 row 20; worker/lib/catalogImport/runOps.ts), through
 * the real routes:
 *
 *   - protect-snapshot: `before` fingerprints every product that exists and the
 *     global counters; `after` compares the same subjects — a money change on a
 *     pre-existing product is one changed subject, the answer counts only;
 *   - finish: refused while an item is queued or in flight; `partial` when an
 *     item is BLOCKED; the token cleared, so the door is gone;
 *   - withdraw: only BLOCKED SOURCE_WITHDRAWN, the approval reference of
 *     workflow 60, a second fetch ≥ 24 h after the block that still finds the
 *     page gone, and the sitemap no longer listing it;
 *   - readback: a vanished object or a binding to another product's value is a
 *     mismatch the answer counts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTexts, manifestRowOf, newWorld, RUN_ID, stage, write } from './fixtures/catalogImportWorld';
import { sample } from './fixtures/bambu/load';
import { OPS, OPS_RUN, openRun, opsWorld, setBundle, TOKEN, type OpsWorld } from './fixtures/catalogImportOps';
import { applyEvent, itemBySource } from '../worker/lib/catalogImport/items';
import { readbackItem, withdrawItem } from '../worker/lib/catalogImport/runOps';
import { OpsRefusal } from '../worker/lib/catalogImport/auth';
import { purgePlan } from '../worker/lib/catalogImport/purge';

after(() => setBundle(null));

const post = async (w: OpsWorld, path: string, body: unknown = {}) => {
  const r = await w.call(`${OPS}${path}`, { body });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const row = (r: Record<string, unknown>) => ({ ...r, source_collections: [], breadcrumbs: '', discovery_sources: ['sitemap'], discovered_at: '2026-10-15' });
const event = (w: OpsWorld, sid: string, t: string, state: string, outcome: string, code = '') =>
  post(w, `/items/${sid}/event`, { lease_token: t, state, outcome, code, message: '', retry_at: '', release: false, detail: {} });

test('protect-snapshot: the same subjects before and after, a money change on a pre-existing product is counted, never shown', async () => {
  const w = opsWorld();
  setBundle(bundleTexts({ manifestRows: [], matches: [] }));
  openRun(w.raw);
  w.raw.prepare("INSERT INTO products (id, slug, name, price_iqd, status) VALUES ('p_owner_1', 'owner-one', 'Owner one', 25000, 'active')").run();
  w.raw.prepare("INSERT INTO products (id, slug, name, price_iqd, status) VALUES ('p_owner_2', 'owner-two', 'Owner two', 30000, 'active')").run();
  const before = await post(w, '/run/protect-snapshot', { phase: 'before' });
  assert.equal(before.status, 200);
  assert.deepEqual(Object.keys(before.json).sort(), ['changed', 'subjects']);
  assert.equal(before.json.changed, null);
  const subjects = Number(before.json.subjects);
  assert.ok(subjects >= 2 + 15, 'every product and the global counters');
  const same = await post(w, '/run/protect-snapshot', { phase: 'after' });
  assert.equal(same.json.changed, 0);
  w.raw.prepare("UPDATE products SET price_iqd = 26000 WHERE id = 'p_owner_1'").run();
  const changed = await post(w, '/run/protect-snapshot', { phase: 'after' });
  assert.equal(changed.json.changed, 1);
  assert.equal(changed.json.subjects, subjects, 'after reads the before snapshot\'s subjects');
  // The digests are stored, never answered.
  const text = JSON.stringify(changed.json);
  assert.doesNotMatch(text, /[0-9a-f]{64}|p_owner/);
  assert.ok(Number((w.raw.prepare("SELECT COUNT(*) AS n FROM catalog_import_protected WHERE phase = 'after'").get() as { n: number }).n) >= subjects);
});

test('finish: refused while an item is queued; partial with a BLOCKED item; the token cleared, the door gone', async () => {
  const w = opsWorld();
  const x = sample('ams-2-pro-feeder-unit');
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(x, 1)], matches: [] }));
  openRun(w.raw);
  await post(w, '/manifest', { rows: [row(manifestRowOf(x, 1))] });
  const refused = await post(w, '/run/finish');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'IMPORT_RUN_NOT_FINISHED');
  const t = String((await post(w, `/items/${x.sourceProductId}/lease`, { lease_token: '' })).json.lease_token);
  await event(w, x.sourceProductId, t, 'EXTRACTING', 'start');
  const blocked = await event(w, x.sourceProductId, t, 'BLOCKED', 'blocked', 'SOURCE_WITHDRAWN');
  assert.equal(blocked.json.state, 'BLOCKED');
  const fin = await post(w, '/run/finish');
  assert.deepEqual(fin.json, { state: 'partial', held: [] });
  assert.equal((w.raw.prepare('SELECT token_sha256 AS t FROM catalog_import_runs').get() as { t: string }).t, '');
  const gone = await w.call(`${OPS}/hello`, { body: { protocol: 2 }, token: TOKEN });
  assert.equal(gone.status, 404);
});

test('withdraw: BLOCKED SOURCE_WITHDRAWN, workflow 60\'s approval, a second fetch ≥ 24 h later still gone, the sitemap no longer listing it', async () => {
  const w = opsWorld();
  const x = sample('ams-2-pro-feeder-unit');
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(x, 1)], matches: [] }));
  openRun(w.raw);
  await post(w, '/manifest', { rows: [row(manifestRowOf(x, 1))] });
  const sid = x.sourceProductId;
  const t = String((await post(w, `/items/${sid}/lease`, { lease_token: '' })).json.lease_token);
  await event(w, sid, t, 'EXTRACTING', 'start');
  const evidence = (at: string, extra: Record<string, unknown> = {}) => ({ second_fetch: { at, outcome: 'withdrawn', status: 404 }, sitemap_absent: true, ...extra });
  const withdraw = (body: unknown) => post(w, `/items/${sid}/withdraw`, body);
  // Not blocked yet.
  assert.equal((await withdraw({ approval_ref: 'workflow-60-run-1', evidence: evidence(new Date().toISOString()) })).json.code, 'IMPORT_WITHDRAW_REFUSED');
  await event(w, sid, t, 'BLOCKED', 'blocked', 'SOURCE_WITHDRAWN');
  // The block happened two days ago.
  w.raw.prepare("UPDATE catalog_import_events SET at = ? WHERE outcome = 'blocked'").run(new Date(Date.now() - 48 * 3600_000).toISOString());
  const now = new Date().toISOString();
  for (const [label, body] of [
    ['no approval', { approval_ref: '', evidence: evidence(now) }],
    ['another approval', { approval_ref: 'owner said so', evidence: evidence(now) }],
    ['the page is back', { approval_ref: 'workflow-60-run-77', evidence: { second_fetch: { at: now, outcome: 'present', status: 200 }, sitemap_absent: true } }],
    ['still in the sitemap', { approval_ref: 'workflow-60-run-77', evidence: evidence(now, { sitemap_absent: false }) }],
    ['too soon', { approval_ref: 'workflow-60-run-77', evidence: evidence(new Date(Date.now() - 47 * 3600_000).toISOString()) }],
  ] as const) {
    const r = await withdraw(body);
    assert.equal(r.status, 409, label);
    assert.equal(r.json.code, 'IMPORT_WITHDRAW_REFUSED', label);
  }
  const ok = await withdraw({ approval_ref: 'workflow-60-run-77', evidence: evidence(now) });
  assert.deepEqual(ok.json, { state: 'WITHDRAWN_AT_SOURCE' });
  const item = w.raw.prepare('SELECT processing_state AS s, withdrawn_by AS by, withdrawn_evidence AS e FROM catalog_import_items').get() as { s: string; by: string; e: string };
  assert.equal(item.s, 'WITHDRAWN_AT_SOURCE');
  assert.equal(item.by, 'workflow-60-run-77');
  assert.equal(JSON.parse(item.e).sitemap_absent, true);
  // Terminal: a lease answers it as it is, with no lease.
  const l = await post(w, `/items/${sid}/lease`, { lease_token: '' });
  assert.equal(l.json.state, 'WITHDRAWN_AT_SOURCE');
  assert.equal(l.json.lease_token, '');
});

test('readback: the write\'s own verifyApplied and the live ownership checks; a vanished object or a foreign binding is a mismatch', async () => {
  const w = newWorld();
  const s = stage(w, 'h2d');
  await write(w, s);
  const env = { DB: w.db, BUCKET: w.bucket as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never };
  const item = () => itemBySource(w.db, RUN_ID, s.payload.source_product_id);
  const clean = await readbackItem(env, await item());
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.equal(clean.mismatches, 0);
  // An object gone from R2.
  const img = w.raw.prepare('SELECT r2_key FROM product_images WHERE product_id = ? AND is_primary = 0 LIMIT 1').get(s.payload.product_id) as { r2_key: string };
  w.bucket.objects.delete(img.r2_key);
  const missing = await readbackItem(env, await item());
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.keys_exist, false);
  // A binding to a value of another product.
  w.raw.exec('PRAGMA foreign_keys = OFF');
  w.raw.prepare("UPDATE product_images SET option_value_id = 'ov_of_another_product' WHERE product_id = ? AND is_primary = 1").run(s.payload.product_id);
  const foreign = await readbackItem(env, await item());
  assert.equal(foreign.checks.bindings_own, false);
  assert.ok(foreign.mismatches >= 2);
});

// ---------------------------------------------------------------- review 6b

test('finish with two end-of-queue holds: the first blocks at its turn, the second stays queued, and the run closes partial naming it', async () => {
  const w = opsWorld();
  const x = sample('ams-2-pro-feeder-unit');
  const h1 = sample('a1');
  const h2 = sample('h2d');
  const rows = [manifestRowOf(x, 1), { ...manifestRowOf(h1, 2), hold_code: 'ORDER_TYPE_WORD' }, { ...manifestRowOf(h2, 3), hold_code: 'OWNER_HIDDEN' }];
  setBundle(bundleTexts({ manifestRows: rows, matches: [] }));
  openRun(w.raw);
  await post(w, '/manifest', { rows: rows.map(row) });
  // The first item withdraws at its source (any terminal-or-blocked outcome); the holds come last.
  const t = String((await post(w, `/items/${x.sourceProductId}/lease`, { lease_token: '' })).json.lease_token);
  await event(w, x.sourceProductId, t, 'EXTRACTING', 'start');
  await event(w, x.sourceProductId, t, 'BLOCKED', 'blocked', 'SOURCE_WITHDRAWN');
  w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'WITHDRAWN_AT_SOURCE', withdrawn_evidence = ?, withdrawn_by = 'workflow-60-run-1' WHERE source_product_id = ?").run('{"sitemap_absent":true}', x.sourceProductId);
  // The first hold blocks at its turn.
  const t1 = String((await post(w, `/items/${h1.sourceProductId}/lease`, { lease_token: '' })).json.lease_token);
  await event(w, h1.sourceProductId, t1, 'EXTRACTING', 'start');
  assert.equal((await event(w, h1.sourceProductId, t1, 'BLOCKED', 'blocked', 'ORDER_TYPE_WORD')).json.state, 'BLOCKED');
  // The second can never start (one item in flight, BLOCKED included): it is neither leased nor started.
  const lease2 = await post(w, `/items/${h2.sourceProductId}/lease`, { lease_token: '' });
  assert.equal(lease2.status, 409);
  assert.equal(lease2.json.code, 'IMPORT_ILLEGAL_TRANSITION');
  const status = await w.call(`${OPS}/run/status`);
  const held = ((await status.json()) as { held: Array<{ source_product_id: string; hold_code: string }> }).held;
  assert.deepEqual(held.map((h) => [h.source_product_id, h.hold_code]), [[h2.sourceProductId, 'OWNER_HIDDEN']], '/run/status names the queued hold');
  const fin = await post(w, '/run/finish');
  assert.equal(fin.status, 200, JSON.stringify(fin.json));
  assert.equal(fin.json.state, 'partial');
  assert.deepEqual((fin.json.held as Array<{ handle: string }>).map((h) => h.handle), [h2.handle]);
  assert.equal((w.raw.prepare('SELECT state FROM catalog_import_runs').get() as { state: string }).state, 'partial');
});

test('a hold the owner has answered (gone from the bundled manifest) is no longer held: the run does not close around it', async () => {
  const w = opsWorld();
  const h1 = sample('a1');
  const h2 = sample('h2d');
  const held = [{ ...manifestRowOf(h1, 1), hold_code: 'ORDER_TYPE_WORD' }, { ...manifestRowOf(h2, 2), hold_code: 'OWNER_HIDDEN' }];
  setBundle(bundleTexts({ manifestRows: held, matches: [] }));
  openRun(w.raw);
  await post(w, '/manifest', { rows: held.map(row) });
  const t1 = String((await post(w, `/items/${h1.sourceProductId}/lease`, { lease_token: '' })).json.lease_token);
  await event(w, h1.sourceProductId, t1, 'EXTRACTING', 'start');
  await event(w, h1.sourceProductId, t1, 'BLOCKED', 'blocked', 'ORDER_TYPE_WORD');
  // The owner answered the second hold: the bundle no longer holds it, so it is an item still to import.
  setBundle(bundleTexts({ manifestRows: [held[0], { ...held[1], hold_code: '' }], matches: [] }));
  const fin = await post(w, '/run/finish');
  assert.equal(fin.status, 409);
  assert.equal(fin.json.code, 'IMPORT_RUN_NOT_FINISHED');
});

test('a second item is neither leased nor started while one is in flight: a 409 the runner re-leases on, never a 500, attempts untouched', async () => {
  const w = opsWorld();
  const a = sample('ams-2-pro-feeder-unit');
  const b = sample('a1');
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(a, 1), manifestRowOf(b, 2)], matches: [] }));
  openRun(w.raw);
  await post(w, '/manifest', { rows: [row(manifestRowOf(a, 1)), row(manifestRowOf(b, 2))] });
  const ta = String((await post(w, `/items/${a.sourceProductId}/lease`, { lease_token: '' })).json.lease_token);
  await event(w, a.sourceProductId, ta, 'EXTRACTING', 'start');
  await event(w, a.sourceProductId, ta, 'RETRYING', 'retry', 'MEDIA_TIMEOUT');
  const lease = await post(w, `/items/${b.sourceProductId}/lease`, { lease_token: '' });
  assert.equal(lease.status, 409);
  assert.equal(lease.json.code, 'IMPORT_ILLEGAL_TRANSITION');
  const attempts = () => Number((w.raw.prepare('SELECT attempts AS n FROM catalog_import_items WHERE source_product_id = ?').get(b.sourceProductId) as { n: number }).n);
  assert.equal(attempts(), 0, 'a refused lease counts no attempt');
  // A start that races the read (B leased before A started) meets the index, answered the same way.
  w.raw.prepare("UPDATE catalog_import_items SET lease_token = 'lse_b', lease_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes') WHERE source_product_id = ?").run(b.sourceProductId);
  const start = await event(w, b.sourceProductId, 'lse_b', 'EXTRACTING', 'start');
  assert.equal(start.status, 409, JSON.stringify(start.json));
  assert.equal(start.json.code, 'IMPORT_ILLEGAL_TRANSITION');
  const run = { id: OPS_RUN, state: 'running', token_expires_at: '', github_run_id: 'x', reviewed_bundle_sha256: '', code_commit: '', manifest_total: 0, started_at: '' };
  const item = await itemBySource(w.env.DB as D1Database, OPS_RUN, b.sourceProductId);
  // The index's own refusal (the read raced): still a 409, never IMPORT_INTERNAL.
  w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'DISCOVERED' WHERE source_product_id = ?").run(b.sourceProductId);
  const dbSkippingTheRead = new Proxy(w.env.DB as D1Database & Record<string, unknown>, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => (/processing_state NOT IN \('DISCOVERED'/.test(sql) && /SELECT 1 AS x/.test(sql) ? target.prepare('SELECT NULL AS x WHERE 0 AND ? IS NULL AND ? IS NULL AND ? IS NULL') : target.prepare(sql));
      }
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as D1Database;
  await assert.rejects(
    () => applyEvent(dbSkippingTheRead, run, { ...item, lease_token: 'lse_b' }, { state: 'EXTRACTING', outcome: 'start', code: '', retry_at: '', release: false, detail: {} }),
    (e: unknown) => e instanceof OpsRefusal && e.status === 409 && e.code === 'IMPORT_ILLEGAL_TRANSITION'
  );
});

test('RETRIES_EXHAUSTED: a stage runs eight times at most — its eighth failure is refused (the runner\'s own rule)', async () => {
  const w = opsWorld();
  const x = sample('ams-2-pro-feeder-unit');
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(x, 1)], matches: [] }));
  openRun(w.raw);
  await post(w, '/manifest', { rows: [row(manifestRowOf(x, 1))] });
  const sid = x.sourceProductId;
  const t = String((await post(w, `/items/${sid}/lease`, { lease_token: '' })).json.lease_token);
  await event(w, sid, t, 'EXTRACTING', 'start');
  let failures = 0;
  for (;;) {
    failures++;
    const r = await event(w, sid, t, 'RETRYING', 'retry', 'MEDIA_TIMEOUT');
    if (r.status !== 200) {
      assert.equal(r.status, 409);
      assert.equal(r.json.code, 'RETRIES_EXHAUSTED');
      break;
    }
    assert.equal((await event(w, sid, t, 'EXTRACTING', 'resume')).status, 200);
    assert.ok(failures < 12);
  }
  assert.equal(failures, 8, 'the eighth failure of the stage is refused: eight executions, seven recorded retries');
  assert.equal(Number((w.raw.prepare('SELECT stage_attempts AS n FROM catalog_import_items').get() as { n: number }).n), 7);
  // A deadline park never counts.
  assert.equal((await post(w, `/items/${sid}/event`, { lease_token: t, state: 'RETRYING', outcome: 'retry', code: 'DEADLINE_EXIT', message: '', retry_at: '', release: false, detail: {} })).status, 200);
});

test('withdraw is fenced on the state it read: an item that moved meanwhile gets no withdrawn event', async () => {
  const w = opsWorld();
  const x = sample('ams-2-pro-feeder-unit');
  setBundle(bundleTexts({ manifestRows: [manifestRowOf(x, 1)], matches: [] }));
  openRun(w.raw);
  await post(w, '/manifest', { rows: [row(manifestRowOf(x, 1))] });
  const sid = x.sourceProductId;
  const t = String((await post(w, `/items/${sid}/lease`, { lease_token: '' })).json.lease_token);
  await event(w, sid, t, 'EXTRACTING', 'start');
  await event(w, sid, t, 'BLOCKED', 'blocked', 'SOURCE_WITHDRAWN');
  w.raw.prepare("UPDATE catalog_import_events SET at = ? WHERE outcome = 'blocked'").run(new Date(Date.now() - 48 * 3600_000).toISOString());
  const stale = await itemBySource(w.env.DB as D1Database, OPS_RUN, sid);
  // The item is resumed between the call's read and its batch.
  await event(w, sid, t, 'EXTRACTING', 'resume');
  const run = { id: OPS_RUN, state: 'running', token_expires_at: '', github_run_id: 'x', reviewed_bundle_sha256: '', code_commit: '', manifest_total: 0, started_at: '' };
  await assert.rejects(
    () => withdrawItem(w.env.DB as D1Database, run, stale, { approval_ref: 'workflow-60-run-9', evidence: { second_fetch: { at: new Date().toISOString(), outcome: 'withdrawn', status: 404 }, sitemap_absent: true } }),
    (e: unknown) => e instanceof OpsRefusal && e.status === 409 && e.code === 'IMPORT_ILLEGAL_TRANSITION'
  );
  assert.equal(Number((w.raw.prepare("SELECT COUNT(*) AS n FROM catalog_import_events WHERE outcome = 'withdrawn'").get() as { n: number }).n), 0);
  assert.equal((w.raw.prepare('SELECT processing_state AS s FROM catalog_import_items').get() as { s: string }).s, 'EXTRACTING');
});

test('readback: a swatch of another product\'s value is a mismatch; an R2 that does not answer is a transient 503, never a missing object', async () => {
  const w = newWorld();
  const s = stage(w, 'pla-basic-filament');
  await write(w, s);
  const env = { DB: w.db, BUCKET: w.bucket as never, R2_PUBLIC: w.bucket as never, R2_PRIVATE: w.media.R2_PRIVATE as never };
  const item = () => itemBySource(w.db, RUN_ID, s.payload.source_product_id);
  assert.equal((await readbackItem(env, await item())).ok, true);
  // R2 throws on one HEAD: the answer is transient, not ok:false.
  const head = w.bucket.head.bind(w.bucket);
  let once = true;
  w.bucket.head = (async (key: string) => {
    if (once) {
      once = false;
      throw new Error('R2 internal error (10001)');
    }
    return head(key);
  }) as typeof w.bucket.head;
  const stale = await item();
  await assert.rejects(() => readbackItem(env, stale), (e: unknown) => e instanceof OpsRefusal && e.status === 503 && e.code === 'IMPORT_STORAGE_UNAVAILABLE');
  w.bucket.head = head as typeof w.bucket.head;
  assert.equal((await readbackItem(env, await item())).ok, true, 'and answers again once R2 does');
  // A swatch credited to this product for another product's value.
  w.raw.prepare("INSERT INTO product_option_value_swatches (option_value_id, product_id, url, r2_key) VALUES ('ov_of_another_product', ?, '/files/x.webp', 'x.webp')").run(s.payload.product_id);
  const foreign = await readbackItem(env, await item());
  assert.equal(foreign.checks.swatches_own, false);
  assert.equal(foreign.ok, false);
});

test('purge: every ancestor section of a three-level placement is purged too (its page lists the product)', async () => {
  const w = newWorld();
  const s = stage(w, 'refurbished-bambu-lab-h2d-3d-printer');
  await write(w, s);
  const plan = await purgePlan(w.db, [s.payload.product_id]);
  const chain = w.raw
    .prepare(
      `WITH RECURSIVE up(id) AS (SELECT sub_category_id FROM products WHERE id = ? UNION SELECT c.parent_id FROM catalogs c JOIN up ON c.id = up.id WHERE c.parent_id IS NOT NULL)
       SELECT c.slug FROM up JOIN catalogs c ON c.id = up.id`
    )
    .all(s.payload.product_id)
    .map((r) => (r as { slug: string }).slug);
  assert.ok(chain.length >= 3, `a three-level placement: ${chain.join(' › ')}`);
  for (const slug of chain) {
    assert.ok(plan.sections.includes(slug), `${slug} is purged`);
    assert.ok(plan.paths.includes(`/api/catalog/${slug}`));
  }
});
