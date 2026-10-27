/**
 * THE TWO HALVES AGREE: the studio's real client (src/components/creativeStudio/
 * client.ts, through src/lib/api.ts) driven against the real router
 * (worker/routes/adminCreativeStudio.ts) over a migrated, seeded database.
 *
 * Each half was built against packages/creativeDoc/src/api.ts, which fixes
 * the DTOs but not every route path or request field — so the editor's own
 * browser test (a stubbed server written from the same assumptions) could not
 * catch a path or a field the Worker spells differently. This test can: every
 * request goes through `fetch` into the Hono app, and every answer is read by
 * the client's own parsers (`one`/`list`), which refuse a shape they do not
 * expect. One full product path: key → model → product → snapshot → three
 * compositions → design → AI edit → save → versions → restore → rename →
 * final export → approval. Spec §34 acceptance 1, 8, 9, 10.
 *
 * Run: node --import tsx --test tests/creativeStudioContract.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER } from './fixtures/app';
import { MODEL_A, TYPED_KEY, message, seedStore, standardProvider, studioApp, studioDb, stubProvider } from './fixtures/creativeStudio';
import { ApiError } from '../src/lib/api';
import { ai, assets, brand, documents, provider, store } from '../src/components/creativeStudio/client';
import { buildFromTemplate } from '../packages/creativeDoc/src/layout';
import { defaultBrandKit } from '../packages/creativeDoc/src/brand';
import { qualityReport } from '../packages/creativeDoc/src/quality';
import { FORMATS } from '../packages/creativeDoc/src/schema';
import { NO_EVIDENCE } from '../packages/creativeDoc/src/templates';
import { approximateMeasurer } from '../packages/creativeDoc/src/text';
import type { CreativeDocument } from '../packages/creativeDoc/src/schema';

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);

/** Route every same-origin call of the client into the app; anything else is a test bug. */
function routeFetchTo(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    if (!url.startsWith('/api/admin/creative-studio')) throw new Error(`unexpected fetch ${url}`);
    const headers = new Headers(init?.headers);
    headers.set('CF-Connecting-IP', '1.2.3.4');
    return app.request(url, { ...init, headers });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** What each AI task answers, chosen by the schema the request carries. */
let editAnswer: (() => unknown) | null = null;
let ideasAnswer: (() => unknown) | null = null;
function answerFor(body: Record<string, unknown>) {
  const props = Object.keys(((body.output_config as { format?: { schema?: { properties?: object } } })?.format?.schema?.properties ?? {}) as object);
  if (props.includes('ideas')) return message(ideasAnswer ? ideasAnswer() : { ideas: [], notes: [] });
  if (props.includes('proposals')) {
    return message({
      proposals: [
        { variant: 'product_first', reason: 'المنتج هو البطل', headline: 'طباعة دقيقة لكل مشروع', subhead: '', features: [], cta: 'اطلبها الآن', caption: 'طابعة Bambu Lab A1', alt_text: 'طابعة على خلفية فحمية' },
        { variant: 'feature_first', reason: 'ميزة واضحة', headline: 'دقة في كل طبقة', subhead: '', features: ['معايرة تلقائية'], cta: 'اطلبها الآن', caption: '', alt_text: '' },
      ],
      warnings: [],
      missing: [],
    });
  }
  if (props.includes('operations')) return message(editAnswer ? editAnswer() : {});
  if (props.includes('notes')) return message({ notes: [], summary: 'متوازن' });
  return message({ ok: true });
}

test('the studio client and the Worker agree on every route the editor uses (one full product path)', async () => {
  const raw = await seedStore(await studioDb());
  const app = studioApp(raw, OWNER);
  const prov = stubProvider(standardProvider(answerFor));
  const restore = routeFetchTo(app);
  try {
    // --- provider: key, models, settings, test, usage --------------------------------
    const before = await provider.status();
    assert.equal(before.can_manage, true);
    assert.equal(before.key.source, 'none');
    const saved = await provider.saveKey(TYPED_KEY);
    assert.ok(!JSON.stringify(saved).includes(TYPED_KEY), 'the key is never echoed');
    const status = await provider.status();
    assert.equal(status.key.source, 'stored');
    assert.equal(status.key.hint?.length, 4);
    const models = await provider.models();
    assert.ok(models.some((m) => m.id === MODEL_A));
    await provider.saveSettings({ model: MODEL_A, effort: 'low', vision_review: true });
    await provider.test();
    assert.equal((await provider.status()).ready, true);
    const usage = await provider.usage();
    assert.ok(Array.isArray(usage));

    // --- store: list, detail, snapshot, verify ----------------------------------------
    const products = await store.search('');
    assert.ok(products.some((p) => p.id === 'p_print'));
    const detail = await store.product('p_print');
    assert.ok(Array.isArray(detail.variants));
    const snap = await store.snapshot('p_print', null);
    assert.equal(snap.data.product_id, 'p_print');
    assert.equal(snap.source, 'live');
    const verify = await store.verify(snap.id);
    assert.deepEqual(verify.changes, []);
    const again = await store.getSnapshot(snap.id);
    assert.equal(again.hash, snap.hash);

    // --- brand, claims, assets ---------------------------------------------------------
    const kitDto = await brand.get();
    assert.ok(kitDto.kit.colors.background);
    await brand.saveVersion({ ...kitDto.kit, notes: ['قاعدة تجريبية'] }, 'first');
    const versions = await brand.versions();
    assert.equal(versions.length, 1);
    await brand.approve(versions[0].version);
    assert.equal((await brand.get()).status, 'approved');
    assert.deepEqual(await brand.claims(), []);
    const asset = await assets.upload(new Blob([PNG_1x1], { type: 'image/png' }), 'element', 'نقطة');
    assert.equal(asset.review, 'approved');
    assert.equal((await assets.review(asset.id, 'rejected')).review, 'rejected');
    assert.equal((await assets.list('element')).length, 1);
    await assets.remove(asset.id);

    // --- three compositions → a design -----------------------------------------------
    const compose = await ai.compose({
      snapshot_id: snap.id, claim_id: null, objective: 'sell', priority: 'product', density: 'brief', template: 'product_hero', family: null,
      variants: ['product_first', 'feature_first'], locale: 'ar', brief: '', idempotency_key: 'contract-compose-0001',
    });
    assert.equal(compose.proposals.length, 2);
    const img = snap.data.images.find((i) => i.same_origin && i.width && i.height)!;
    const built = buildFromTemplate({
      template: 'product_hero', variant: 'product_first', format: FORMATS.square, locale: 'ar', objective: 'sell', density: 'brief',
      brand: defaultBrandKit(), brandVersion: versions[0].version, products: [{ slot: 'main', snapshot: snap, image: { url: img.url, width: img.width!, height: img.height! } }],
      service: null, copy: { headline: compose.proposals[0].headline, cta: compose.proposals[0].cta }, evidence: NO_EVIDENCE, family: null,
      logo: { width: 1254, height: 1254 }, backgroundNatural: null, slide: null, caption: compose.proposals[0].caption, alt_text: compose.proposals[0].alt_text,
      measure: approximateMeasurer,
    });
    const doc = await documents.create({ title: 'إعلان A1', content: built.doc });
    assert.equal(doc.version, 1);
    const listed = await documents.list({});
    assert.ok(listed.documents.some((d) => d.id === doc.id));

    // --- an AI edit, applied and saved with its job -------------------------------------
    editAnswer = () => ({
      schema_version: 1, document_id: doc.id, base_document_version: 1, intent: 'edit_selected_text', target_layer_ids: ['headline'],
      operations: [{ op: 'set_text', layer_id: 'headline', value: 'دقة تراها في كل طبقة' }], reason: 'عنوان أقصر', warnings: [], clarification: '',
    });
    const edit = await ai.edit({ document_id: doc.id, base_version: 1, instruction: 'غيّر العنوان فقط', scope_ids: ['headline'], annotations: [], idempotency_key: 'contract-edit-00001' });
    assert.equal(edit.patch.target_layer_ids[0], 'headline');
    const edited: CreativeDocument = { ...built.doc, layers: built.doc.layers.map((l) => (l.id === 'headline' && l.type === 'text' ? { ...l, text: 'دقة تراها في كل طبقة' } : l)) };
    const save = await documents.save(doc.id, { content: edited, base_version: 1, origin: 'ai', job_id: edit.job_id });
    assert.equal(save.version, 2);
    await ai.applied(edit.job_id, doc.id, 2);

    // a stale save is a 409 the client surfaces with its code — nothing overwritten
    await assert.rejects(documents.save(doc.id, { content: built.doc, base_version: 1, origin: 'manual' }), (e: unknown) => e instanceof ApiError && e.code === 'VERSION_CONFLICT');

    // --- versions, restore, rename -----------------------------------------------------
    const vers = await documents.versions(doc.id);
    assert.ok(vers.length >= 2);
    const v1 = await documents.version(doc.id, 1);
    assert.equal(v1.content.schema_version, 1);
    const restored = await documents.restore(doc.id, 1, 2);
    assert.equal(restored.version, 3);
    await documents.rename(doc.id, 'إعلان A1 — نهائي');
    const reopened = await documents.get(doc.id);
    assert.equal(reopened.title, 'إعلان A1 — نهائي');
    assert.equal(reopened.version, 3, 'a rename is not a new version');

    // --- a final export, then approval of that version --------------------------------
    const exp = await documents.uploadExport(doc.id, { file: new Blob([PNG_1x1], { type: 'image/png' }), kind: 'png', version: 3, final: true, width: 1080, height: 1080 });
    assert.equal(exp.final, true);
    assert.equal(exp.source_check, 'fresh');
    assert.equal((await documents.exports(doc.id)).length, 1);
    const qa = qualityReport(reopened.content, {
      brand: defaultBrandKit(), snapshots: { main: snap }, claims: {}, verification: { main: [] }, measure: approximateMeasurer, final: true, now: new Date().toISOString(),
    });
    assert.equal(qa.blockers, 0, JSON.stringify(qa.issues));
    const review = await documents.approve(doc.id, { version: 3, qa, export_ids: [exp.id] });
    assert.equal(review.decision, 'approved');

    // --- ideas, saved ideas, visual review, cancel ---------------------------------------
    const opps = await ai.opportunities();
    const topic = opps.find((o) => o.kind === 'education_topic');
    assert.ok(topic, `an education topic is always offered: ${JSON.stringify(opps.map((o) => o.kind))}`);
    // A correct model answer cites the evidence the request carried; the Worker refuses one that cites nothing.
    ideasAnswer = () => ({
      ideas: [{
        objective: 'education', target_kind: 'topic', target_ref: '', audience: 'هواة الطباعة', reason: 'موضوع تعليمي معتمد', evidence_ids: [topic!.id],
        message: 'كيف تختار الفلمنت المناسب', headline: 'اختر الفلمنت المناسب لمشروعك', subhead: '', cta: 'اعرف التفاصيل', post_type: 'carousel',
        layout: 'feature_first', caption: '', alt_text: '',
      }],
      notes: [],
    });
    const ideas = await ai.ideas({ count: 3, priorities: [], idempotency_key: 'contract-ideas-0001' });
    assert.equal(ideas.ideas.length, 1);
    assert.ok(ideas.ideas[0].id);
    assert.equal((await ai.savedIdeas()).length, 1);
    const rev = await ai.review({ document_id: doc.id, version: 3, image_base64: PNG_1x1.toString('base64'), idempotency_key: 'contract-review-001' });
    assert.equal(rev.summary, 'متوازن');
    await assert.rejects(ai.cancel(edit.job_id), (e: unknown) => e instanceof ApiError && typeof e.code === 'string', 'an applied job cannot be cancelled');
    assert.ok(prov.messages().length >= 4);
  } finally {
    restore();
    prov.restore();
  }
});
