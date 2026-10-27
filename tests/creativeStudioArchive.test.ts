/**
 * FINDING, CREATING AND THE BRAND KIT'S VERSIONS (spec §6, §22, §27, §28;
 * worker/lib/creative/documents.ts, brandStore.ts).
 *
 *   - archive search finds a design by its headline and by its product's
 *     name, and a bare `to` date includes its own day;
 *   - a design built from Claude's answer records origin 'ai' and the job in
 *     version 1, and a composition is applied once;
 *   - one brand version and its kit can be read before it is approved;
 *   - the site logo's size is read from the file the site serves.
 *
 * Run: node --import tsx --test tests/creativeStudioArchive.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, get, json as body, memoryBucket, post, row } from './fixtures/app';
import { BASE, FULL, design, studioApp, studioDb, textLayer } from './fixtures/creativeStudio';
import { create, goodDesign, seedJob, snapshotOf } from './fixtures/creativeStudioDesigns';
import { SITE_LOGO_OBJECT_KEY } from '../worker/lib/creative/brandStore';
import { SITE_LOGO_KEY } from '../src/lib/siteLogo';

const ids = async (app: ReturnType<typeof studioApp>, query: string) =>
  ((await body(await get(app, `${BASE}/documents?${query}`))).documents as Array<{ id: string }>).map((d) => d.id).sort();

test('archive search: the headline and the bound product\'s name are searched, and a bare `to` date includes that day (spec-17)', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const snap = await snapshotOf(app);
  const byHeadline = await create(app, design({ layers: [textLayer('headline', 'headline', 'آخر إعلان A1 للمبتدئين', { x: 120, y: 110, width: 840, height: 110 })] }), { title: 'منشور' });
  const byProduct = await create(app, goodDesign(snap.id), { title: 'تصميم' });
  const unrelated = await create(app, design({ layers: [textLayer('headline', 'headline', 'فلامنت جديد', { x: 120, y: 110, width: 840, height: 110, visible: true })] }), { title: 'آخر' });
  const hidden = await create(app, design({ layers: [textLayer('headline', 'headline', 'A1 مخفي', { visible: false })] }), { title: 'مخفي' });
  assert.deepEqual(await ids(app, 'q=A1'), [byHeadline.id, byProduct.id].sort(), 'a hidden layer is not what the design says');
  assert.deepEqual(await ids(app, `q=${encodeURIComponent('بامبو')}`), [byProduct.id]);
  assert.deepEqual(await ids(app, `q=${encodeURIComponent('100%_')}`), [], 'wildcards are literal');
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(await ids(app, `from=${today}&to=${today}`), [byHeadline.id, byProduct.id, unrelated.id, hidden.id].sort());
});

test('a design built from Claude\'s answer records origin "ai" and its job; a composition is applied once (spec-18, editor-11)', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  seedJob(raw, 'cjob_compose');
  const made = await create(app, design(), { origin: 'ai', job_id: 'cjob_compose' });
  const v1 = await body(await get(app, `${BASE}/documents/${made.id}/versions/1`));
  assert.equal(v1.version.origin, 'ai');
  assert.equal(v1.version.job_id, 'cjob_compose');
  assert.deepEqual(row(raw, 'SELECT applied_version, document_id FROM creative_jobs WHERE id = ?', 'cjob_compose'), { applied_version: 1, document_id: made.id });
  const again = await post(app, `${BASE}/documents`, { title: 'x', content: design(), origin: 'ai', job_id: 'cjob_compose' });
  assert.equal((await body(again)).code, 'JOB_ALREADY_APPLIED');

  seedJob(raw, 'cjob_theirs', { actor: 'usr_full' });
  seedJob(raw, 'cjob_gone', { status: 'cancelled' });
  seedJob(raw, 'cjob_edit', { task: 'edit' });
  for (const [extra, status, code] of [
    [{ origin: 'ai', job_id: 'cjob_theirs' }, 400, 'INVALID_INPUT'],
    [{ origin: 'ai', job_id: 'cjob_edit' }, 400, 'INVALID_INPUT'],
    [{ origin: 'ai', job_id: 'cjob_gone' }, 409, 'JOB_CANCELLED'],
    [{ origin: 'ai' }, 400, 'INVALID_INPUT'],
    [{ origin: 'template', job_id: 'cjob_theirs' }, 400, 'INVALID_INPUT'],
    [{ origin: 'restore' }, 400, undefined],
  ] as const) {
    const res = await post(app, `${BASE}/documents`, { title: 'x', content: design(), ...extra });
    assert.equal(res.status, status, JSON.stringify(extra));
    assert.equal((await body(res)).code, code, JSON.stringify(extra));
  }
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM creative_documents')!.n, 1, 'no refused create wrote a design');
  // An ideas answer is shared and offers several ideas: each design built from it cites it.
  seedJob(raw, 'cjob_ideas', { task: 'ideas', actor: 'usr_full' });
  for (let i = 0; i < 2; i++) {
    const d = await create(app, design(), { origin: 'ai', job_id: 'cjob_ideas' });
    assert.equal((await body(await get(app, `${BASE}/documents/${d.id}/versions/1`))).version.job_id, 'cjob_ideas');
  }
  // Other origins are recorded as sent — but never a template the design does not have.
  const imported = await create(app, design(), { origin: 'import' });
  assert.equal((await body(await get(app, `${BASE}/documents/${imported.id}/versions/1`))).version.origin, 'import');
  const blank = await create(app, design(), { origin: 'template' });
  assert.equal((await body(await get(app, `${BASE}/documents/${blank.id}/versions/1`))).version.origin, 'manual');
});

test('one brand version and its kit, a pending one too; 404 for a version that does not exist (spec-24)', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const full = studioApp(raw, FULL);
  assert.equal((await get(app, `${BASE}/brand/versions/1`)).status, 404);
  const def = (await body(await get(app, `${BASE}/brand`))).kit;
  await post(app, `${BASE}/brand/versions`, { kit: { ...def, digits: 'latn' }, note: 'approved', approve: true });
  await post(app, `${BASE}/brand/versions`, { kit: { ...def, digits: 'arab' }, note: 'waiting', approve: false });
  const pending = await body(await get(full, `${BASE}/brand/versions/2`));
  assert.equal(pending.version.version, 2);
  assert.equal(pending.version.status, 'pending');
  assert.equal(pending.kit.digits, 'arab', 'the pending kit, not the one in force');
  assert.equal((await body(await get(app, `${BASE}/brand`))).kit.digits, 'latn');
  assert.equal((await get(app, `${BASE}/brand/versions/9`)).status, 404);
  assert.equal((await get(app, `${BASE}/brand/versions/x`)).status, 404);
});

test('the site logo\'s size comes from the file the site serves; unreadable, the recorded size stands (editor-8)', async () => {
  assert.equal(SITE_LOGO_OBJECT_KEY, SITE_LOGO_KEY, 'the Worker reads the object src/lib/siteLogo.ts names');
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  assert.deepEqual((await body(await get(app, `${BASE}/brand`))).site_logo, { width: 1254, height: 1254 });
  // A replaced, non-square mark: a WebP VP8X header for 1200×400.
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'latin1');
  header.write('WEBPVP8X', 8, 'latin1');
  header.writeUIntLE(1199, 24, 3);
  header.writeUIntLE(399, 27, 3);
  const bucket = memoryBucket();
  await bucket.put(SITE_LOGO_OBJECT_KEY, header);
  const withLogo = studioApp(raw, OWNER, { BUCKET: bucket });
  assert.deepEqual((await body(await get(withLogo, `${BASE}/brand`))).site_logo, { width: 1200, height: 400 });
});
