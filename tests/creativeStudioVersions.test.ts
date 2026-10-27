/**
 * VERSIONS AND RACES (spec §22, §25, §29, §30, §32; worker/lib/creative/documents.ts).
 *
 *   - the approved and the final-exported version are always in the history,
 *     so they can be viewed and restored after later edits;
 *   - a cancel landing between a save's job check and its batch never lets
 *     the cancelled AI answer into the design;
 *   - the loser of a concurrent save or approval writes nothing: no version
 *     row, no job mark, no review — and an approval committed under a save is
 *     withdrawn by it;
 *   - who withdrew an approval, and every status change, is in audit_log.
 *
 * Run: node --import tsx --test tests/creativeStudioVersions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, all, asD1, get, json as body, post, put, row } from './fixtures/app';
import { BASE, FULL, design, studioApp, studioDb, textLayer } from './fixtures/creativeStudio';
import { approve, create, exportPng, goodDesign, hookedD1, seedJob, snapshotOf } from './fixtures/creativeStudioDesigns';
import { approveDocument, saveDocument } from '../worker/lib/creative/documents';

const headline = (text: string) => design({ layers: [textLayer('headline', 'headline', text, { x: 120, y: 110, width: 840, height: 110 })] });
const save = (content: Record<string, unknown>, base: number, extra: Record<string, unknown> = {}) => ({
  base_version: base, content, title: null, change_summary: '', origin: 'manual' as const, job_id: null, checkpoint: false, ...extra,
});
const versionsOf = (raw: Parameters<typeof all>[0], id: string) => all<{ version: number; origin: string; job_id: string | null; content_json: string }>(raw, 'SELECT version, origin, job_id, content_json FROM creative_document_versions WHERE document_id = ? ORDER BY version', id);

test('the final-exported and approved version is kept in the history: after a later edit it can be viewed and restored (spec-1)', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const snap = await snapshotOf(app);
  const doc = await create(app, goodDesign(snap.id));
  // A manual edit seconds later keeps no row of its own…
  const v2 = await body(await put(app, `${BASE}/documents/${doc.id}`, { base_version: 1, content: goodDesign(snap.id, { caption: 'the approved words' }) }));
  assert.equal(v2.document.version, 2);
  assert.deepEqual(versionsOf(raw, doc.id).map((v) => v.version), [1]);
  // …but its final export and its approval put it in the history.
  assert.equal((await exportPng(app, doc.id, 2)).status, 201);
  const ok = await approve(app, doc.id, 2);
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  await put(app, `${BASE}/documents/${doc.id}`, { base_version: 2, content: goodDesign(snap.id, { caption: 'later words' }) });
  const versions = (await body(await get(app, `${BASE}/documents/${doc.id}/versions`))).versions as Array<{ version: number; change_summary: string }>;
  assert.deepEqual(versions.map((v) => v.version), [2, 1]);
  assert.equal(versions[0]!.change_summary, 'final export');
  assert.equal((await body(await get(app, `${BASE}/documents/${doc.id}/versions/2`))).content.caption, 'the approved words');
  const restored = await post(app, `${BASE}/documents/${doc.id}/restore`, { version: 2, base_version: 3 });
  assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json()));
  assert.equal((await body(restored)).document.content.caption, 'the approved words');
});

test('a cancel that lands between the job check and the batch: the cancelled AI answer never reaches the design (worker-4)', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const doc = await create(app, headline('قبل'));
  seedJob(raw, 'cjob_y', { task: 'edit', document_id: doc.id, base_version: 1 });
  const db = hookedD1(raw, [{ match: /SELECT status, document_id, applied_at FROM creative_jobs/, fire: () => void raw.exec(`UPDATE creative_jobs SET status = 'cancelled' WHERE id = 'cjob_y'`) }]);
  await assert.rejects(saveDocument(db, 'usr_owner', doc.id, save(headline('AI answer the owner discarded'), 1, { origin: 'ai', job_id: 'cjob_y' })), (e: { code?: string }) => e.code === 'JOB_CANCELLED');
  const stored = row<{ version: number; content_json: string }>(raw, 'SELECT version, content_json FROM creative_documents WHERE id = ?', doc.id)!;
  assert.equal(stored.version, 1);
  assert.ok(!stored.content_json.includes('discarded'));
  assert.deepEqual(versionsOf(raw, doc.id).map((v) => v.version), [1]);
  assert.deepEqual(row(raw, 'SELECT status, applied_at FROM creative_jobs WHERE id = ?', 'cjob_y'), { status: 'cancelled', applied_at: null });
});

test('the losing save writes nothing: no version row for content that never was, and its job is not marked applied (worker-5)', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const doc = await create(app, headline('v1'));
  seedJob(raw, 'cjob_x', { task: 'edit', document_id: doc.id, base_version: 1 });
  // Tab B applies an AI answer; tab A's ordinary autosave lands between B's reads and B's batch.
  const db = hookedD1(raw, [{ match: /SELECT MAX\(created_at\)/, fire: async () => void (await saveDocument(asD1(raw), 'usr_full', doc.id, save(headline('A manual autosave'), 1))) }]);
  await assert.rejects(saveDocument(db, 'usr_owner', doc.id, save(headline('B AI answer'), 1, { origin: 'ai', job_id: 'cjob_x' })), (e: { code?: string }) => e.code === 'VERSION_CONFLICT');
  const v = versionsOf(raw, doc.id);
  assert.ok(!v.some((x) => x.job_id === 'cjob_x' || x.content_json.includes('B AI answer')), JSON.stringify(v));
  assert.deepEqual(row(raw, 'SELECT applied_at, applied_version FROM creative_jobs WHERE id = ?', 'cjob_x'), { applied_at: null, applied_version: null }, 'the paid answer can still be applied');
  assert.ok(row<{ content_json: string }>(raw, 'SELECT content_json FROM creative_documents WHERE id = ?', doc.id)!.content_json.includes('A manual autosave'));
});

test('approval races: the losing approval records no review; an approval committed under a save is withdrawn by it (worker-5)', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  // (a) A save lands while the approval is checking: APPROVAL_STALE, and no review row says «approved».
  const a = await create(app, headline('سيُعتمد'));
  const racingSave = hookedD1(raw, [{ match: /creative_service_claim_versions/, fire: async () => void (await saveDocument(asD1(raw), 'usr_full', a.id, save(headline('غيّره زميل'), 1))) }]);
  await assert.rejects(approveDocument(racingSave, 'usr_owner', a.id, { version: 1, qa: {} as never, export_ids: [] }), (e: { code?: string }) => e.code === 'APPROVAL_STALE');
  assert.equal(all(raw, 'SELECT * FROM creative_reviews WHERE document_id = ?', a.id).length, 0);
  // (b) An approval lands while a save is between its reads and its batch: the save withdraws it.
  const b = await create(app, headline('مسودة'));
  const racingApproval = hookedD1(raw, [{ match: /SELECT MAX\(created_at\)/, fire: async () => void (await approveDocument(asD1(raw), 'usr_full', b.id, { version: 1, qa: {} as never, export_ids: [] })) }]);
  const out = await saveDocument(racingApproval, 'usr_owner', b.id, save(headline('تعديل بعد الاعتماد'), 1));
  assert.equal(out.invalidated, true);
  assert.equal(out.row.status, 'draft');
  assert.equal(out.row.approved_version, null);
  const review = row<{ invalidated_at: string | null; invalidated_reason: string | null }>(raw, 'SELECT invalidated_at, invalidated_reason FROM creative_reviews WHERE document_id = ?', b.id)!;
  assert.ok(review.invalidated_at);
  assert.equal(review.invalidated_reason, 'content_changed');
});

test('who withdrew an approval — by a status change, an edit or a restore — and every status change are audited (security-3)', async () => {
  const raw = await studioDb();
  const owner = studioApp(raw, OWNER);
  const full = studioApp(raw, FULL);
  const doc = await create(owner, headline('معتمد'));
  const audits = () => all<{ actor_id: string; action: string; detail: string }>(raw, `SELECT actor_id, action, detail FROM audit_log WHERE target = ? AND action LIKE 'creative.document.%' ORDER BY id`, doc.id)
    .map((r) => ({ actor: r.actor_id, action: r.action, ...JSON.parse(r.detail) }));

  assert.equal((await approve(owner, doc.id, 1)).status, 200);
  assert.equal((await post(full, `${BASE}/documents/${doc.id}/status`, { status: 'draft', base_version: 1 })).status, 200);
  assert.equal((await approve(owner, doc.id, 1)).status, 200);
  assert.equal((await put(full, `${BASE}/documents/${doc.id}`, { base_version: 1, content: headline('عدّله زميل') })).status, 200);
  assert.equal((await approve(owner, doc.id, 2)).status, 200);
  assert.equal((await post(full, `${BASE}/documents/${doc.id}/restore`, { version: 1, base_version: 2 })).status, 200);
  assert.equal((await post(owner, `${BASE}/documents/${doc.id}/status`, { status: 'in_review', base_version: 3 })).status, 200);

  assert.deepEqual(audits(), [
    { actor: 'usr_owner', action: 'creative.document.approved', version: 1 },
    { actor: 'usr_full', action: 'creative.document.status', from: 'approved', to: 'draft', version: 1 },
    { actor: 'usr_full', action: 'creative.document.approval_invalidated', version: 1, reason: 'withdrawn' },
    { actor: 'usr_owner', action: 'creative.document.approved', version: 1 },
    { actor: 'usr_full', action: 'creative.document.approval_invalidated', version: 2, reason: 'content_changed' },
    { actor: 'usr_owner', action: 'creative.document.approved', version: 2 },
    { actor: 'usr_full', action: 'creative.document.approval_invalidated', version: 3, reason: 'content_changed', restored_from: 1 },
    { actor: 'usr_owner', action: 'creative.document.status', from: 'draft', to: 'in_review', version: 3 },
  ]);
});
