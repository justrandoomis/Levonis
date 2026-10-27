/**
 * DESIGNS, VERSIONS, APPROVAL, EXPORTS, ASSETS, CLAIMS AND THE BRAND KIT
 * (spec §15, §19, §22–§25, §30; acceptance 8, 12; docs/CREATIVE_STUDIO.md §3).
 *
 *   - a stale save is 409 VERSION_CONFLICT and never overwrites newer work;
 *   - the normaliser refuses a fatal document on write and cleans on read;
 *   - an approval belongs to one version: a later save invalidates it;
 *   - approval and a final export re-verify the bound store data NOW, and a
 *     restore never carries a design past a change (acceptance 12);
 *   - files are sniffed (no SVG), private, and an asset an approved design
 *     uses cannot be deleted;
 *   - a new approved claim version marks bound designs, never edits them;
 *   - on a database without migration 0215 every read answers the same status
 *     and every write is 503 CREATIVE_SCHEMA_MISSING.
 *
 * Run: node --import tsx --test tests/creativeStudioDocuments.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, dbThrough, get, json as body, post, put, row, send } from './fixtures/app';
import { BASE, FULL, design, seedStudioUsers, studioApp, studioDb, textLayer } from './fixtures/creativeStudio';

type App = ReturnType<typeof studioApp>;

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function create(app: App, content: Record<string, unknown> = design(), extra: Record<string, unknown> = {}) {
  const res = await post(app, `${BASE}/documents`, { title: 'Design', content, kind: 'post', ...extra });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await body(res)).document as { id: string; version: number; status: string };
}

function multipart(app: App, path: string, file: Buffer, fields: Record<string, string>, type = 'image/png') {
  const form = new FormData();
  form.set('file', new Blob([file], { type }), 'upload.bin');
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return app.request(path, { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
}

/** A design that passes every server check: a bound product picture, a bound price, a headline — inside the safe area, nothing overlapping. */
function goodDesign(snapshotId: string, extra: Record<string, unknown> = {}) {
  return design({
    objective: 'sell',
    products: [{ slot: 'main', product_id: 'p_print', variant_key: null, snapshot_id: snapshotId }],
    layers: [
      { id: 'background', type: 'shape', name: 'bg', role: 'background', x: 0, y: 0, width: 1080, height: 1080, shape: 'rect', fill: '#111214', locked: true },
      textLayer('headline', 'headline', 'طابعة دقيقة لكل مشروع', { x: 120, y: 110, width: 840, height: 110 }),
      { id: 'product', type: 'image', name: 'product', role: 'product', x: 240, y: 260, asset: { kind: 'product', ref: '/files/products/p_print/main.webp', slot: 'main' }, natural: { width: 1200, height: 1000 }, scale: 0.5 },
      textLayer('price', 'price', '900,000 د.ع', { x: 120, y: 800, width: 840, height: 90, source: { kind: 'product', slot: 'main', field: 'price' } }),
    ],
    alt_text: 'طابعة',
    caption: 'طابعة Bambu Lab A1',
    ...extra,
  });
}

async function boundDesign(raw: DatabaseSync, app: App) {
  const snap = await body(await post(app, `${BASE}/snapshots`, { product_id: 'p_print', variant_key: null }));
  assert.ok(snap.id, JSON.stringify(snap));
  const doc = await create(app, goodDesign(snap.id));
  return { snap, doc };
}

test('a stale save is 409 VERSION_CONFLICT with the current version, and never overwrites newer work', async () => {
  const raw = await studioDb();
  const owner = studioApp(raw, OWNER);
  const full = studioApp(raw, FULL);
  const doc = await create(owner);
  const first = await put(full, `${BASE}/documents/${doc.id}`, { base_version: 1, content: design({ layers: [textLayer('headline', 'headline', 'نسخة المسؤول')] }) });
  assert.equal(first.status, 200);
  assert.equal((await body(first)).document.version, 2);
  const stale = await put(owner, `${BASE}/documents/${doc.id}`, { base_version: 1, content: design({ layers: [textLayer('headline', 'headline', 'نسخة قديمة')] }) });
  assert.equal(stale.status, 409);
  const b = await body(stale);
  assert.equal(b.code, 'VERSION_CONFLICT');
  assert.equal(b.details.current_version, 2);
  const stored = await body(await get(owner, `${BASE}/documents/${doc.id}`));
  assert.equal(stored.document.content.layers[0].text, 'نسخة المسؤول', 'the newer work survives');
  // A title-only change does not move the version.
  const titled = await body(await put(owner, `${BASE}/documents/${doc.id}`, { base_version: 2, content: stored.document.content, title: 'عنوان جديد' }));
  assert.equal(titled.document.version, 2);
  assert.equal(titled.document.title, 'عنوان جديد');
});

test('the normaliser refuses a fatal design on write (foreign picture, invented font) and cleans a hand-edited row on read', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  for (const bad of [
    design({ layers: [{ id: 'img', type: 'image', role: 'product', asset: { kind: 'product', ref: 'https://evil.example/x.png' }, natural: { width: 10, height: 10 }, scale: 1 }] }),
    design({ layers: [textLayer('t', 'headline', 'x', { font: { family: 'Comic Sans', weight: 400, size: 40, lineHeight: 1.2 } })] }),
    design({ schema_version: 9 }),
    'not a document',
  ]) {
    const res = await post(app, `${BASE}/documents`, { title: 'x', content: bad });
    assert.equal(res.status, 400);
    const b = await body(res);
    assert.equal(b.code, 'INVALID_DOCUMENT');
    assert.ok(b.details.issues.length > 0);
  }
  assert.equal(all(raw, 'SELECT * FROM creative_documents').length, 0);
  const doc = await create(app);
  raw.prepare('UPDATE creative_documents SET content_json = ? WHERE id = ?').run(JSON.stringify({ ...design(), injected: '<script>', caption: 'ok' }), doc.id);
  const read = await body(await get(app, `${BASE}/documents/${doc.id}`));
  assert.equal(read.document.content.injected, undefined);
  assert.ok(read.document.issues.some((i: { code: string }) => i.code === 'unknown_key'));
});

test('versions are kept at meaningful points; a restore is a new version; idempotent create returns the same design', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const doc = await create(app, design(), { idempotency_key: 'create-once-key-01' });
  const again = await create(app, design(), { idempotency_key: 'create-once-key-01' });
  assert.equal(again.id, doc.id);
  const v2 = await body(await put(app, `${BASE}/documents/${doc.id}`, { base_version: 1, content: design({ caption: 'two' }) }));
  assert.equal(v2.document.version, 2);
  // Seconds after the creation's version row and not a checkpoint: no row for v2.
  let versions = (await body(await get(app, `${BASE}/documents/${doc.id}/versions`))).versions;
  assert.deepEqual(versions.map((v: { version: number }) => v.version), [1]);
  await put(app, `${BASE}/documents/${doc.id}`, { base_version: 2, content: design({ caption: 'three' }), checkpoint: true, change_summary: 'checkpoint' });
  versions = (await body(await get(app, `${BASE}/documents/${doc.id}/versions`))).versions;
  assert.deepEqual(versions.map((v: { version: number }) => v.version), [3, 1]);
  const restored = await body(await post(app, `${BASE}/documents/${doc.id}/restore`, { version: 1, base_version: 3 }));
  assert.equal(restored.document.version, 4);
  assert.equal(restored.document.content.caption, '');
  const v4 = await body(await get(app, `${BASE}/documents/${doc.id}/versions/4`));
  assert.equal(v4.version.origin, 'restore');
  const dup = await body(await post(app, `${BASE}/documents/${doc.id}/duplicate`, {}));
  assert.notEqual(dup.document.id, doc.id);
  assert.equal(dup.document.parent_id, doc.id);
});

test('approval belongs to one version: the server re-runs its checks, and a later save invalidates the approval', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const { doc } = await boundDesign(raw, app);
  const stale = await post(app, `${BASE}/documents/${doc.id}/approve`, { version: 9, qa: { issues: [], blockers: 0, ran: [], skipped: [] }, export_ids: [] });
  assert.equal((await body(stale)).code, 'APPROVAL_STALE');
  // The editor's measured checks can only add blockers.
  const overflow = await post(app, `${BASE}/documents/${doc.id}/approve`, { version: 1, qa: { issues: [{ code: 'text_overflow', severity: 'blocker', layer_ids: ['headline'] }], blockers: 1, ran: ['text_fit'], skipped: [] }, export_ids: [] });
  assert.equal(overflow.status, 409);
  assert.equal((await body(overflow)).code, 'QA_BLOCKERS');
  const ok = await post(app, `${BASE}/documents/${doc.id}/approve`, { version: 1, qa: { issues: [], blockers: 0, ran: ['text_fit', 'fonts', 'assets'], skipped: [] }, export_ids: [] });
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  const approved = await body(ok);
  assert.equal(approved.document.status, 'approved');
  assert.equal(approved.document.approved_version, 1);
  assert.ok(approved.qa.ran.includes('data') && approved.qa.ran.includes('claims'));
  assert.equal(approved.review.decision, 'approved');

  const content = approved.document.content;
  content.caption = 'تغيير بعد الاعتماد';
  const saved = await body(await put(app, `${BASE}/documents/${doc.id}`, { base_version: 1, content }));
  assert.equal(saved.document.status, 'draft');
  assert.equal(saved.document.approved_version, null);
  const reviews = (await body(await get(app, `${BASE}/documents/${doc.id}/reviews`))).reviews;
  assert.equal(reviews[0].invalidated_reason, 'content_changed');
  assert.ok(reviews[0].invalidated_at);
});

test('a design with a missing snapshot or a test snapshot is blocked at approval', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const doc = await create(app, goodDesign('csnap_missing_000000000'));
  const res = await post(app, `${BASE}/documents/${doc.id}/approve`, { version: 1, qa: {}, export_ids: [] });
  assert.equal(res.status, 409);
  const b = await body(res);
  assert.equal(b.code, 'QA_BLOCKERS');
  assert.ok(b.details.issues.some((i: { code: string }) => i.code === 'snapshot_missing'));
});

test('acceptance 12: when what the design shows changes in the store, the final export and the approval are blocked — and a restore does not bypass it', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const { snap, doc } = await boundDesign(raw, app);
  const exportFinal = (version: number) => multipart(app, `${BASE}/documents/${doc.id}/exports`, PNG_1x1, { meta: JSON.stringify({ version, kind: 'png', final: true, width: 1080, height: 1080 }) });

  const fine = await exportFinal(1);
  assert.equal(fine.status, 201, JSON.stringify(await fine.clone().json()));
  assert.equal((await body(fine)).export.source_check, 'fresh');

  // The store renames the product: what the design shows changed.
  raw.exec(`UPDATE products SET name_ar = 'بامبو لاب A1 الجديدة' WHERE id = 'p_print'`);
  const blocked = await exportFinal(1);
  assert.equal(blocked.status, 409);
  const b = await body(blocked);
  assert.equal(b.code, 'SOURCE_CHANGED');
  assert.ok(b.details.changes.includes('name_changed'));
  const approve = await post(app, `${BASE}/documents/${doc.id}/approve`, { version: 1, qa: {}, export_ids: [] });
  assert.equal((await body(approve)).code, 'SOURCE_CHANGED');

  // A newer version, then restoring the old one: still bound to the stale snapshot, still blocked.
  const v2 = await body(await put(app, `${BASE}/documents/${doc.id}`, { base_version: 1, content: goodDesign(snap.id, { caption: 'two' }) }));
  const restored = await body(await post(app, `${BASE}/documents/${doc.id}/restore`, { version: 1, base_version: v2.document.version }));
  const afterRestore = await exportFinal(restored.document.version);
  assert.equal(afterRestore.status, 409);
  assert.equal((await body(afterRestore)).code, 'SOURCE_CHANGED');

  // A draft export is still allowed, honestly marked unverified.
  const draft = await multipart(app, `${BASE}/documents/${doc.id}/exports`, PNG_1x1, { meta: JSON.stringify({ version: restored.document.version, kind: 'png', final: false }) });
  assert.equal(draft.status, 201);
  assert.equal((await body(draft)).export.source_check, 'unverified');

  // Re-verify, rebind to the fresh snapshot: the final export goes through.
  const verify = await body(await post(app, `${BASE}/snapshots/${snap.id}/verify`, {}));
  assert.ok(verify.changes.includes('name_changed'));
  const rebound = await body(await put(app, `${BASE}/documents/${doc.id}`, { base_version: restored.document.version, content: goodDesign(verify.fresh.id) }));
  const after = await exportFinal(rebound.document.version);
  assert.equal(after.status, 201);
});

test('exports: sniffed bytes only — SVG refused, a kind mismatch refused, Project JSON through the document gate; files are private', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const doc = await create(app);
  const meta = (kind: string, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, kind, final: false, ...extra });
  const svg = await multipart(app, `${BASE}/documents/${doc.id}/exports`, SVG, { meta: meta('png') }, 'image/png');
  assert.equal(svg.status, 415);
  assert.equal((await body(svg)).code, 'UNSUPPORTED_MEDIA');
  const mismatch = await multipart(app, `${BASE}/documents/${doc.id}/exports`, PNG_1x1, { meta: meta('jpeg') });
  assert.equal((await body(mismatch)).code, 'UNSUPPORTED_MEDIA');
  const stale = await multipart(app, `${BASE}/documents/${doc.id}/exports`, PNG_1x1, { meta: JSON.stringify({ version: 3, kind: 'png' }) });
  assert.equal((await body(stale)).code, 'STALE_VERSION');
  const badJson = await multipart(app, `${BASE}/documents/${doc.id}/exports`, Buffer.from(JSON.stringify(design({ schema_version: 7 }))), { meta: meta('project_json') }, 'application/json');
  assert.equal((await body(badJson)).code, 'INVALID_DOCUMENT');
  const project = await multipart(app, `${BASE}/documents/${doc.id}/exports`, Buffer.from(JSON.stringify(design())), { meta: meta('project_json') }, 'application/json');
  assert.equal(project.status, 201);
  const png = await body(await multipart(app, `${BASE}/documents/${doc.id}/exports`, PNG_1x1, { meta: meta('png') }));
  assert.equal(png.export.width, 1);
  assert.equal(png.export.source_check, 'none');
  const file = await get(app, png.export.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG_1x1, 'the exact bytes, never re-encoded');
  const key = row<{ r2_key: string; sha256: string }>(raw, 'SELECT r2_key, sha256 FROM creative_exports WHERE id = ?', png.export.id)!;
  assert.match(key.r2_key, new RegExp(`^creative-studio/exports/${doc.id}/cexp_[0-9a-f]+\\.png$`));
  const list = await body(await get(app, `${BASE}/documents/${doc.id}/exports`));
  assert.equal(list.exports.length, 2);
  const dto = await body(await get(app, `${BASE}/documents`));
  assert.equal(dto.documents[0].thumb_export_id, png.export.id);
});

test('assets: PNG accepted with its header size, SVG refused, private file route, and an asset an approved design uses cannot be deleted', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const svg = await multipart(app, `${BASE}/assets`, SVG, { kind: 'logo' }, 'image/svg+xml');
  assert.equal(svg.status, 415);
  const created = await multipart(app, `${BASE}/assets`, PNG_1x1, { kind: 'background', label: 'Matte' });
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const asset = (await body(created)).asset;
  assert.equal(asset.mime, 'image/png');
  assert.equal(asset.width, 1);
  assert.equal(asset.provenance, 'uploaded');
  assert.match(row<{ r2_key: string }>(raw, 'SELECT r2_key FROM creative_assets')!.r2_key, /^creative-studio\/assets\/background\/cast_[0-9a-f]+\.png$/);
  const file = await get(app, asset.url);
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
  assert.equal((await body(await get(app, `${BASE}/assets?kind=background`))).assets.length, 1);

  const { snap } = await boundDesign(raw, app);
  const withAsset = goodDesign(snap.id);
  (withAsset.layers as unknown[]).splice(1, 0, { id: 'deco', type: 'image', name: 'deco', role: 'decor', x: 0, y: 0, asset: { kind: 'asset', ref: asset.id }, natural: { width: 1, height: 1 }, scale: 10 });
  const doc = await create(app, withAsset);
  const approved = await post(app, `${BASE}/documents/${doc.id}/approve`, { version: 1, qa: {}, export_ids: [] });
  assert.equal(approved.status, 200, JSON.stringify(await approved.clone().json()));
  const del = await send(app, 'DELETE', `${BASE}/assets/${asset.id}`, {});
  assert.equal(del.status, 409);
  assert.equal((await body(del)).code, 'ASSET_IN_USE');
  const unused = (await body(await multipart(app, `${BASE}/assets`, PNG_1x1, { kind: 'icon' }))).asset;
  assert.equal((await send(app, 'DELETE', `${BASE}/assets/${unused.id}`, {})).status, 200);
  assert.ok(row(raw, 'SELECT deleted_at FROM creative_assets WHERE id = ?', unused.id)!.deleted_at, 'a soft delete: the row and bytes stay');
});

test('claims: a pending version reaches nothing; approval needs ar/en/ckb; a newer approved version marks bound designs without editing them', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const full = studioApp(raw, FULL);
  const texts = {
    title: { ar: 'ضمان سنة', en: 'One-year warranty', ckb: 'گەرەنتیی یەک ساڵ' },
    summary: { ar: 'ضمان على عيوب التصنيع', en: 'Covers manufacturing defects', ckb: 'کەموکوڕیی دروستکردن دەگرێتەوە' },
    conditions: { ar: 'حسب سياسة الضمان', en: 'Per the warranty policy', ckb: 'بەپێی سیاسەتی گەرەنتی' },
    details_path: '/policies/warranty',
  };
  assert.equal((await post(app, `${BASE}/claims`, { key: 'warranty', ...texts, summary: { ar: 'نص', en: 'x', ckb: 'نص' } })).status, 400, 'a Sorani slot copying the Arabic is refused');
  assert.equal((await post(app, `${BASE}/claims`, { key: 'warranty', ...texts, details_path: 'https://elsewhere.example' })).status, 400);
  const created = await body(await post(app, `${BASE}/claims`, { key: 'warranty', ...texts }));
  const claim = created.claim;
  assert.equal(claim.status, 'pending');
  const first = await body(await post(app, `${BASE}/claims/${claim.id}/approve`, {}));
  assert.equal(first.claim.status, 'approved');
  assert.equal(first.claim.version, 1);

  const doc = await create(full, design({ services: [{ claim_id: claim.id, claim_version: 1 }] }));
  const revised = await body(await put(app, `${BASE}/claims/${claim.id}`, { ...texts, conditions: { ...texts.conditions, ar: 'حسب سياسة الضمان المحدثة' } }));
  assert.equal(revised.claim.version, 2);
  assert.equal(revised.claim.status, 'pending');
  const listed = await body(await get(full, `${BASE}/claims`));
  assert.deepEqual(listed.claims.map((c: { version: number; status: string }) => `${c.version}:${c.status}`), ['2:pending', '1:approved']);
  const second = await body(await post(app, `${BASE}/claims/${claim.id}/approve`, {}));
  assert.equal(second.marked, 1);
  const after = await body(await get(full, `${BASE}/documents/${doc.id}`));
  assert.deepEqual(after.document.needs_review, ['claim_changed']);
  assert.equal(after.document.version, 1, 'the design itself is never edited');
  assert.equal(after.document.content.services[0].claim_version, 1);
  assert.deepEqual(all(raw, 'SELECT version, status FROM creative_service_claim_versions ORDER BY version').map((r) => `${r.version}:${r.status}`), ['1:retired', '2:approved']);
  const docs = await body(await get(full, `${BASE}/claims/${claim.id}/documents`));
  assert.deepEqual(docs.documents.map((d: { id: string }) => d.id), [doc.id]);
});

test('the brand kit: the default before anything is saved, a pending version, then the approved one in force', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const def = await body(await get(app, `${BASE}/brand`));
  assert.equal(def.status, 'default');
  assert.equal(def.version, null);
  assert.deepEqual(def.site_logo, { width: 1254, height: 1254 });
  const saved = await body(await post(app, `${BASE}/brand/versions`, { kit: { ...def.kit, name: 'Levonis', colors: { ...def.kit.colors, accent: 'not-a-colour' } }, note: 'first', approve: false }));
  assert.equal(saved.saved.status, 'pending');
  assert.equal(saved.brand.status, 'pending');
  assert.equal(saved.brand.kit.colors.accent, def.kit.colors.accent, 'an invalid colour falls back, never stored');
  const approved = await body(await post(app, `${BASE}/brand/versions/${saved.saved.version}/approve`, {}));
  assert.equal(approved.brand.status, 'approved');
  assert.equal(approved.brand.version, saved.saved.version);
  assert.equal((await post(app, `${BASE}/brand/versions`, { kit: 'nope' })).status, 400);
});

test('rejecting records the reasons as feedback; status transitions are guarded by the version', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const doc = await create(app);
  assert.equal((await post(app, `${BASE}/documents/${doc.id}/reject`, { reasons: ['nonsense'] })).status, 400);
  const rej = await body(await post(app, `${BASE}/documents/${doc.id}/reject`, { reasons: ['product_small', 'crowded'], note: 'كبّر المنتج' }));
  assert.equal(rej.review.decision, 'rejected');
  const fb = await body(await get(app, `${BASE}/feedback`));
  assert.deepEqual(fb.feedback[0].reasons, ['product_small', 'crowded']);
  const toReview = await body(await post(app, `${BASE}/documents/${doc.id}/status`, { status: 'in_review', base_version: 1 }));
  assert.equal(toReview.document.status, 'in_review');
  assert.equal((await body(await post(app, `${BASE}/documents/${doc.id}/status`, { status: 'archived', base_version: 5 }))).code, 'VERSION_CONFLICT');
  const archived = await body(await post(app, `${BASE}/documents/${doc.id}/status`, { status: 'archived', base_version: 1 }));
  assert.equal(archived.document.status, 'archived');
  assert.equal((await body(await get(app, `${BASE}/documents`))).documents.length, 0, 'archived designs leave the default list');
  assert.equal((await body(await get(app, `${BASE}/documents?status=archived`))).documents.length, 1);
});

test('deploy-ahead: on a database without 0215 every read answers the same status, every write 503 CREATIVE_SCHEMA_MISSING, never a 500', async () => {
  const behind = seedStudioUsers(dbThrough('0214'));
  const ahead = await studioDb();
  const appBehind = studioApp(behind, OWNER);
  const appAhead = studioApp(ahead, OWNER);
  const reads = ['/provider', '/usage', '/brand', '/brand/versions', '/claims', '/assets', '/documents', '/jobs', '/ideas', '/feedback', '/opportunities', '/products',
    '/documents/cdoc_x', '/documents/cdoc_x/versions', '/documents/cdoc_x/versions/1', '/documents/cdoc_x/reviews', '/documents/cdoc_x/exports',
    '/snapshots/csnap_x', '/assets/cast_x/file', '/exports/cexp_x/file', '/claims/cclm_x/documents', '/products/p_none'];
  for (const path of reads) {
    const a = await get(appAhead, `${BASE}${path}`);
    const b = await get(appBehind, `${BASE}${path}`);
    assert.equal(b.status, a.status, path);
    assert.ok(b.status < 500, `${path}: ${b.status}`);
    if (b.status === 200 && 'migrated' in ((await b.clone().json()) as object)) assert.equal((await body(b)).migrated, false, path);
  }
  const writes: Array<[string, string, unknown]> = [
    ['POST', '/documents', { title: 'x', content: design() }],
    ['PUT', '/provider/settings', { effort: 'low' }],
    ['POST', '/feedback', { kind: 'note', note: 'x' }],
    ['POST', '/watch/sync', {}],
    ['POST', '/claims', { key: 'warranty', title: { ar: 'ضمان', en: 'Warranty', ckb: 'گەرەنتی' } }],
    ['POST', '/brand/versions', { kit: {} }],
  ];
  for (const [method, path, payload] of writes) {
    const res = await send(appBehind, method, `${BASE}${path}`, payload);
    assert.equal(res.status, 503, `${method} ${path}`);
    assert.equal((await body(res)).code, 'CREATIVE_SCHEMA_MISSING', `${method} ${path}`);
  }
});
