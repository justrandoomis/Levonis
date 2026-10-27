/**
 * THE STUDIO SCREENS' CALLS AGREE WITH THE WORKER — the real client
 * (src/components/creativeStudio/client.ts) driven against the real router
 * (worker/routes/adminCreativeStudio.ts), like tests/creativeStudioContract.test.ts,
 * for the calls the screens added:
 *
 *  - «الخدمات المعتمدة»: create a claim, revise it, approve it, list the
 *    designs that use it — and a full admin's write is refused (spec §7-ج, §19);
 *  - «تحديث الكتالوج»: POST /watch/sync repeated to the end of a pass, the
 *    first pass reported as the baseline (spec §10);
 *  - «انسخ كمسودة»: POST /documents/:id/duplicate (spec §18);
 *  - the owner's priorities round-trip through PUT /provider/settings and the
 *    status, and the caps save while the provider's model list is down
 *    (the model is not re-sent when unchanged);
 *  - a saved brand version can be read back with its kit (GET
 *    /brand/versions/:version) where the Worker has the route.
 *
 * Run: node --import tsx --test tests/creativeStudioScreensContract.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER } from './fixtures/app';
import { FULL, MODEL_A, TYPED_KEY, json, seedStore, standardProvider, studioApp, studioDb, stubProvider } from './fixtures/creativeStudio';
import { ApiError } from '../src/lib/api';
import { brand, claims, documents, provider, watch } from '../src/components/creativeStudio/client';
import { claimText } from '../src/components/creativeStudio/editorData';
import { claimBody, claimForm, runCatalogSync, settingsPayload } from '../src/components/creativeStudio/screensModel';
import { buildFromTemplate } from '../packages/creativeDoc/src/layout';
import { defaultBrandKit } from '../packages/creativeDoc/src/brand';
import { FORMATS } from '../packages/creativeDoc/src/schema';
import { NO_EVIDENCE } from '../packages/creativeDoc/src/templates';
import { approximateMeasurer } from '../packages/creativeDoc/src/text';

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

const WARRANTY = {
  ...claimForm(),
  key: 'printer_warranty',
  title: { ar: 'ضمان سنة على الطابعات', en: 'One-year printer warranty', ckb: 'گەرەنتیی ساڵێک بۆ چاپکەرەکان' },
  summary: { ar: 'ضمان الوكيل لمدة سنة', en: 'A one-year dealer warranty', ckb: 'گەرەنتیی بریکار بۆ ماوەی ساڵێک' },
  conditions: { ar: 'مع فاتورة الشراء', en: 'With the purchase invoice', ckb: 'لەگەڵ پسوولەی کڕین' },
  details_path: '/policies/warranty',
  product_ids: ['p_print'],
};

test('service claims: create → revise → approve → the designs that use it; a full admin reads only', async () => {
  const raw = await seedStore(await studioDb());
  const restore = routeFetchTo(studioApp(raw, OWNER));
  try {
    assert.deepEqual(await claims.list(), []);
    const created = await claims.create(WARRANTY.key, claimBody(WARRANTY));
    assert.equal(created.status, 'pending');
    assert.equal(created.version, 1);
    assert.deepEqual(created.product_ids, ['p_print']);
    const first = await claims.approve(created.id, null);
    assert.equal(first.claim.status, 'approved');
    assert.equal(first.marked, 0);

    // A service design bound to version 1.
    const built = buildFromTemplate({
      template: 'service_card', variant: 'feature_first', format: FORMATS.square, locale: 'ar', objective: 'service_trust', density: 'brief', brand: defaultBrandKit(),
      brandVersion: null, products: [], service: claimText(first.claim), copy: { headline: 'ضمان تثق به' }, evidence: NO_EVIDENCE, family: 'service',
      logo: null, backgroundNatural: null, slide: null, caption: '', alt_text: '', measure: approximateMeasurer,
    });
    const doc = await documents.create({ title: 'ضمان', content: built.doc });
    const using = await claims.documents(created.id);
    assert.deepEqual(using.map((d) => d.id), [doc.id]);

    // A new version waits for approval; approving it marks the design bound to the older one.
    const revised = await claims.revise(created.id, claimBody({ ...WARRANTY, conditions: { ...WARRANTY.conditions, ar: 'مع فاتورة الشراء خلال سنة' } }));
    assert.equal(revised.version, 2);
    assert.equal(revised.status, 'pending');
    const listed = await claims.list();
    assert.deepEqual(listed.map((c) => `${c.version}:${c.status}`).sort(), ['1:approved', '2:pending']);
    const second = await claims.approve(created.id, 2);
    assert.equal(second.claim.version, 2);
    assert.equal(second.marked, 1);
  } finally {
    restore();
  }

  const asAdmin = routeFetchTo(studioApp(raw, FULL));
  try {
    assert.equal((await claims.list()).length, 1, 'a full admin reads the claims');
    await assert.rejects(claims.create('other_claim', claimBody(WARRANTY)), (e: unknown) => e instanceof ApiError && e.status === 403);
  } finally {
    asAdmin();
  }
});

test('the catalogue update runs POST /watch/sync to the end of a pass; the first pass is the baseline', async () => {
  const raw = await seedStore(await studioDb());
  const restore = routeFetchTo(studioApp(raw, OWNER));
  try {
    const first = await runCatalogSync(() => watch.sync());
    assert.equal(first.complete, true);
    assert.equal(first.baseline, true);
    assert.ok(first.processed >= 3, `the three visible products were seen (${first.processed})`);
    assert.equal(first.arrivals, 0, 'a baseline reports no arrival');
    const second = await runCatalogSync(() => watch.sync());
    assert.equal(second.complete, true);
    assert.equal(second.baseline, false);
  } finally {
    restore();
  }
});

test('a design is duplicated as a new draft; the owner’s priorities round-trip; the caps save while the model list is down', async () => {
  const raw = await seedStore(await studioDb());
  let revoked = false;
  const prov = stubProvider((call) => (revoked ? json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401) : standardProvider()(call)));
  const restore = routeFetchTo(studioApp(raw, OWNER));
  try {
    // --- duplicate -------------------------------------------------------------------
    const built = buildFromTemplate({
      template: 'service_card', variant: 'feature_first', format: FORMATS.square, locale: 'ar', objective: 'service_trust', density: 'brief', brand: defaultBrandKit(),
      brandVersion: null, products: [], service: null, copy: { headline: 'تصميم للنسخ' }, evidence: NO_EVIDENCE, family: null,
      logo: null, backgroundNatural: null, slide: null, caption: '', alt_text: '', measure: approximateMeasurer,
    });
    const doc = await documents.create({ title: 'الأصل', content: built.doc });
    const copy = await documents.duplicate(doc.id);
    assert.notEqual(copy.id, doc.id);
    assert.equal(copy.version, 1);
    assert.equal(copy.status, 'draft');
    assert.equal((await documents.list({})).documents.length, 2);

    // --- the owner's priorities ------------------------------------------------------
    await provider.saveKey(TYPED_KEY);
    await provider.saveSettings({ model: MODEL_A });
    let status = await provider.status();
    assert.equal(status.model, MODEL_A);
    const form = { model: MODEL_A, effort: '' as const, budget: status.budget, rates: status.rates, vision: status.vision_review, priorities: 'الطابعات أولاً\nالفلمنت الجديد' };
    await provider.saveSettings(settingsPayload(status, form));
    status = await provider.status();
    assert.deepEqual(status.priorities, ['الطابعات أولاً', 'الفلمنت الجديد']);

    // --- the key is revoked: the model list fails, the caps still save ---------------
    revoked = true;
    await assert.rejects(provider.models(), (e: unknown) => e instanceof ApiError);
    await provider.saveSettings(settingsPayload(status, { ...form, budget: { ...status.budget, daily_requests: 7 } }));
    status = await provider.status();
    assert.equal(status.budget.daily_requests, 7);
    assert.equal(status.model, MODEL_A, 'the model choice is untouched');
    assert.deepEqual(status.priorities, ['الطابعات أولاً', 'الفلمنت الجديد']);

    // --- a saved brand version, read back with its kit (where the Worker has the route) ---
    const saved = await brand.saveVersion({ ...defaultBrandKit(), notes: ['نسخة للعرض'] }, 'للعرض');
    assert.ok(saved, 'POST /brand/versions answers the saved version');
    try {
      const v = await brand.version(saved!.version);
      assert.equal(v.version.version, saved!.version);
      assert.deepEqual(v.kit.notes, ['نسخة للعرض']);
    } catch (e) {
      assert.ok(e instanceof ApiError && e.status === 404, `only a missing route is tolerated: ${String(e)}`);
    }
  } finally {
    restore();
    prov.restore();
  }
});
