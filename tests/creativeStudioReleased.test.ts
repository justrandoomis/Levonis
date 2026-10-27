/**
 * WHAT LEAVES THE STUDIO STAYS TRUE (spec §6, §9, §13, §25; acceptance 12;
 * worker/lib/creative/documents.ts, opportunities.ts).
 *
 *   - after approval or a final export, a price or availability change marks
 *     the design `needs_review` — from the catalogue watch, a snapshot
 *     re-verification, a refused approval, and on opening it — without
 *     touching its content; a draft is not marked;
 *   - a discount or limited-time claim with no live offer NOW blocks the
 *     approval and the final export, whatever the bound snapshot said;
 *   - a full admin's upload waits for review, is never offered to Claude and
 *     blocks an approval or a final export until it is approved;
 *   - the design carries the kit of its pinned brand version.
 *
 * Run: node --import tsx --test tests/creativeStudioReleased.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, get, json as body, patch, post, put, row } from './fixtures/app';
import { BASE, FULL, MODEL_A, SECRET_KEY, design, message, modelsPage, stubProvider, studioApp, studioDb } from './fixtures/creativeStudio';
import { PNG_1x1, approve, create, endOffer, exportPng, goodDesign, multipart, snapshotOf, startOffer } from './fixtures/creativeStudioDesigns';
import { offerClaimIssues } from '../worker/lib/creative/documents';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const needsReview = (raw: Parameters<typeof row>[0], id: string) => JSON.parse(row<{ needs_review_json: string }>(raw, 'SELECT needs_review_json FROM creative_documents WHERE id = ?', id)!.needs_review_json) as string[];
const sync = async (app: ReturnType<typeof studioApp>) => {
  const res = await post(app, `${BASE}/watch/sync`, {});
  assert.equal(res.status, 200);
  return body(res);
};

test('acceptance 12: a price change after release marks the design — by the watch, a re-verification and on opening — and never a draft (worker-7, spec-14)', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const snapA = await snapshotOf(app);
  const approved = await create(app, goodDesign(snapA.id));
  assert.equal((await approve(app, approved.id, 1)).status, 200);
  const exported = await create(app, goodDesign(snapA.id));
  assert.equal((await exportPng(app, exported.id, 1)).status, 201);
  const draft = await create(app, goodDesign(snapA.id));
  const snapD = await snapshotOf(app);
  const verified = await create(app, goodDesign(snapD.id));
  assert.equal((await approve(app, verified.id, 1)).status, 200);
  await sync(app); // the baseline

  startOffer(raw); // the shown price drops from 900,000 to 800,000

  // Opening a final-exported design re-verifies it.
  const opened = await body(await get(app, `${BASE}/documents/${exported.id}`));
  assert.ok(opened.document.needs_review.includes('price_changed'), JSON.stringify(opened.document.needs_review));
  assert.equal(opened.document.version, 1, 'the content is never touched');
  // Re-verifying a snapshot marks the released designs bound to it.
  await post(app, `${BASE}/snapshots/${snapD.id}/verify`, {});
  assert.ok(needsReview(raw, verified.id).includes('price_changed'));
  // The watch marks every released design binding the product, once; a draft is not released.
  await sync(app);
  assert.deepEqual(needsReview(raw, approved.id), ['price_changed']);
  await sync(app);
  assert.deepEqual(needsReview(raw, approved.id), ['price_changed'], 'idempotent');
  assert.deepEqual(needsReview(raw, draft.id), []);
  const listed = await body(await get(app, `${BASE}/documents?status=approved`));
  assert.ok(listed.documents.find((d: { id: string }) => d.id === approved.id).needs_review.includes('price_changed'));
  assert.equal(row<{ version: number }>(raw, 'SELECT version FROM creative_documents WHERE id = ?', approved.id)!.version, 1);
  // A new approval is still refused, and the design stays marked.
  assert.equal((await body(await approve(app, approved.id, 1))).code, 'SOURCE_CHANGED');
  assert.ok(needsReview(raw, approved.id).includes('price_changed'));
});

test('a discount claim outliving its offer blocks approval and the final export, even with no price shown (worker-1)', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  startOffer(raw);
  const snap = await snapshotOf(app);
  assert.ok(snap.data.price.offer, 'the bound snapshot holds the offer');
  const doc = await create(app, goodDesign(snap.id, { caption: 'عرض خاص على الطابعة' }, { price: false, headline: 'خصم لفترة محدودة على طابعة A1' }));
  assert.equal((await exportPng(app, doc.id, 1)).status, 201, 'while the offer is live the words are true');

  endOffer(raw);
  for (const res of [await approve(app, doc.id, 1), await exportPng(app, doc.id, 1)]) {
    assert.equal(res.status, 409);
    const b = await body(res);
    assert.equal(b.code, 'QA_BLOCKERS');
    const claims = b.details.issues.filter((i: { code: string }) => i.code === 'unsupported_claim');
    assert.deepEqual(claims.map((i: { layer_ids: string[]; detail: string }) => [i.layer_ids, i.detail]), [[['headline'], 'discount,limited_time'], [[], 'caption:discount']]);
  }
  assert.ok(needsReview(raw, doc.id).includes('offer_changed'), 'the exported design is marked');
  // The same words with no product at all have no offer behind them either.
  assert.equal(offerClaimIssues({ ...design(), layers: [], caption: 'خصم', alt_text: '' } as never, false).length, 1);
});

test('a full admin\'s upload waits for review: not offered to Claude, and it blocks approval and the final export until approved (spec-6)', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  const full = studioApp(raw, FULL, { ANTHROPIC_API_KEY: SECRET_KEY });
  const pending = (await body(await multipart(full, `${BASE}/assets`, PNG_1x1, { kind: 'icon', label: 'Admin icon' }))).asset;
  const mine = (await body(await multipart(app, `${BASE}/assets`, PNG_1x1, { kind: 'icon', label: 'Owner icon' }))).asset;
  assert.equal(pending.review, 'needs_review');
  assert.equal(mine.review, 'approved');

  const snap = await snapshotOf(app);
  const withAsset = goodDesign(snap.id);
  (withAsset.layers as unknown[]).splice(1, 0, { id: 'deco', type: 'image', name: 'deco', role: 'icon', x: 20, y: 20, asset: { kind: 'asset', ref: pending.id }, natural: { width: 1, height: 1 }, scale: 10 });
  const doc = await create(app, withAsset);
  for (const res of [await approve(app, doc.id, 1), await exportPng(app, doc.id, 1)]) {
    const b = await body(res);
    assert.equal(b.code, 'QA_BLOCKERS', JSON.stringify(b));
    assert.deepEqual(b.details.issues.filter((i: { code: string }) => i.code === 'asset_not_approved'), [{ code: 'asset_not_approved', severity: 'blocker', layer_ids: ['deco'], detail: 'needs_review' }]);
  }

  // Claude is offered only approved assets.
  const stub = stubProvider((call) => (call.url.includes('/v1/models') ? modelsPage() : message({})));
  restore = stub.restore;
  assert.equal((await put(app, `${BASE}/provider/settings`, { model: MODEL_A })).status, 200);
  await post(app, `${BASE}/ai/edit`, { document_id: doc.id, base_version: 1, instruction: 'كبّر المنتج', scope_ids: null, annotations: [], idempotency_key: 'edit-assets-0001' });
  const texts: string[] = [];
  const walk = (v: unknown): void => { if (typeof v === 'string') texts.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(stub.messages()[0]!.body!.messages);
  const allowed = JSON.parse(/<allowed>\n([\s\S]*?)\n<\/allowed>/.exec(texts.join('\n'))![1]!) as { asset_ids: string[] };
  assert.ok(allowed.asset_ids.includes(mine.id), 'an approved asset is offered');
  assert.ok(!allowed.asset_ids.includes(pending.id), 'an asset waiting for review is not');

  assert.equal((await patch(app, `${BASE}/assets/${pending.id}`, { review: 'approved' })).status, 200);
  const ok = await approve(app, doc.id, 1);
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
});

test('a design carries the kit of its pinned brand version, not the newer one in force (spec-2)', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const def = (await body(await get(app, `${BASE}/brand`))).kit;
  const v1 = await body(await post(app, `${BASE}/brand/versions`, { kit: { ...def, digits: 'latn' }, note: 'v1', approve: true }));
  const doc = await create(app, design({ brand_version: v1.saved.version }));
  await post(app, `${BASE}/brand/versions`, { kit: { ...def, digits: 'arab', currency_label: 'IQD' }, note: 'v2', approve: true });
  const got = (await body(await get(app, `${BASE}/documents/${doc.id}`))).document;
  assert.equal(got.brand_version, v1.saved.version);
  assert.equal(got.brand_kit.digits, 'latn');
  assert.equal((await body(await get(app, `${BASE}/brand`))).kit.digits, 'arab', 'the kit in force moved on');
});
