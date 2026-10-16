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
import { OPS, openRun, opsWorld, setBundle, TOKEN, type OpsWorld } from './fixtures/catalogImportOps';
import { itemBySource } from '../worker/lib/catalogImport/items';
import { readbackItem } from '../worker/lib/catalogImport/runOps';

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
  assert.deepEqual(fin.json, { state: 'partial' });
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
