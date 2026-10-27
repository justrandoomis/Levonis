/**
 * THE STUDIO RENDERS — static markup of the shell and its key states, in
 * Arabic, English and Sorani (the technique of tests/linkCardsUi.test.ts).
 *
 *  - the admin launcher in three languages, pointing at the full-screen route;
 *  - an assistant admin meets the refusal, never the screens;
 *  - the owner's shell: the tabs, Home loading honestly;
 *  - «AI is not ready»: the reason by code and the way to Settings, and the
 *    note that manual editing keeps working — no demo text pretending to be
 *    Claude;
 *  - the editor open on a design built from MARKED test data: the test-data
 *    banner, the save state, the phone toolbar (a first render has no
 *    matchMedia, which is the phone layout), never a crash;
 *  - the checks panel lists the checks that ran and the ones that did not.
 *
 * Run: node --import tsx --test tests/creativeStudioUiRender.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { AuthContext } = await import('../src/AuthContext');
const { default: StudioLauncher } = await import('../src/components/creativeStudio/StudioLauncher');
const { default: StudioShell } = await import('../src/components/creativeStudio/StudioShell');
const { AiNotReady, StudioContext } = await import('../src/components/creativeStudio/shared');
const { EditorReady } = await import('../src/components/creativeStudio/Editor');
const { default: QaPanel } = await import('../src/components/creativeStudio/panels/QaPanel');
const { ERROR_TEXT, S } = await import('../src/components/creativeStudio/strings');
const { defaultBrandKit } = await import('../packages/creativeDoc/src/brand');
const { buildFromTemplate } = await import('../packages/creativeDoc/src/layout');
const { FORMATS } = await import('../packages/creativeDoc/src/schema');
const { NO_EVIDENCE } = await import('../packages/creativeDoc/src/templates');
const { approximateMeasurer } = await import('../packages/creativeDoc/src/text');
const { ImageStore } = await import('../src/components/creativeStudio/media');
import type { ProductSnapshot } from '../packages/creativeDoc/src/snapshot';
import type { DocumentDto, ProviderStatusDto } from '../packages/creativeDoc/src/api';
import type { StudioContextValue } from '../src/components/creativeStudio/shared';
import type { EditorApi } from '../src/components/creativeStudio/editorApi';

type Lang = 'ar' | 'en' | 'ckb';
const auth = (user: Record<string, unknown>) => ({
  isAuthenticated: true, user, isLoaded: true,
  login: async () => {}, loginWithGoogle: async () => 'ok' as const, register: async () => {}, refreshUser: async () => {}, adoptSession: async () => 'ok' as const, logout: async () => {},
});
const OWNER = { id: 'usr_owner', isAdmin: true, admin_scope: 'full', is_owner: true, owner_email_unverified: false };
const ASSISTANT = { id: 'usr_asst', isAdmin: true, admin_scope: 'assistant', is_owner: false };
const html = (node: ReactNode, lang: Lang = 'ar', user: Record<string, unknown> = OWNER) => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(AuthContext.Provider, { value: auth(user) as never }, createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) })));
};

const kit = defaultBrandKit();
const snapshot: ProductSnapshot = {
  id: 'snap_test_0001', hash: 'x'.repeat(64), source: 'test', fetched_at: '2026-10-27T09:00:00Z',
  data: {
    product_id: 'p_test_a1', slug: 'test-a1', path: '/product/test-a1', variant_key: null, variant_label: null,
    name: { ar: 'طابعة Bambu Lab A1 Combo مع 4 بكرات (AMS lite)', en: 'TEST Bambu Lab A1 Combo', ckb: 'چاپکەری Bambu Lab A1 Combo تاقیکاری' },
    brand: null, category: null, sku: null, short_description: { ar: '', en: '', ckb: '' }, specs: [], contents: [],
    price: { status: 'priced', amount_iqd: 1250000, regular_iqd: null, from: false, offer: null, member_price_iqd: null },
    availability: 'available', sale_types: [], source_updated_at: null,
    images: [{ url: '/files/products/test/a1.webp', width: 1200, height: 800, alt: '', primary: true, variant_key: null, same_origin: true }],
  },
};
const doc = buildFromTemplate({
  template: 'product_hero', variant: 'product_first', format: FORMATS.square, locale: 'ar', objective: 'sell', density: 'brief', brand: kit, brandVersion: null,
  products: [{ slot: 'main', snapshot, image: { url: '/files/products/test/a1.webp', width: 1200, height: 800 } }], service: null,
  copy: { headline: 'طباعة ثلاثية الأبعاد بدقة مذهلة', cta: 'اطلبها الآن' }, evidence: NO_EVIDENCE, family: null, logo: { width: 1254, height: 1254 },
  backgroundNatural: null, slide: null, caption: '', alt_text: '', measure: approximateMeasurer,
}).doc;
const notReady = (code: ProviderStatusDto['not_ready_code']): ProviderStatusDto => ({
  migrated: true, provider: 'anthropic', key: { source: 'none', hint: null, set_at: null }, encryption_ready: false, model: null, effort: null, last_test: null,
  capabilities: { structured_outputs: null, vision: null, effort: null },
  budget: { daily_requests: 50, daily_tokens: 200000, daily_usd: null, monthly_usd: null, max_parallel: 2, auto_fix_rounds: 2 },
  rates: null, vision_review: false, today: { requests: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: null }, month: { requests: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: null },
  can_manage: true, ready: false, not_ready_code: code,
});
const ctx = (provider: ProviderStatusDto | null): StudioContextValue => ({
  user: { isOwner: true, canDesign: true }, provider, brand: { migrated: true, version: null, status: 'default', kit, site_logo: { width: 1254, height: 1254 } },
  reloadProvider: () => {}, reloadBrand: () => {}, goTab: () => {}, openDocument: () => {}, startNew: () => {},
});

test('the admin launcher speaks all three languages and points at the full-screen route', () => {
  const ar = html(createElement(StudioLauncher), 'ar');
  const en = html(createElement(StudioLauncher), 'en');
  const ckb = html(createElement(StudioLauncher), 'ckb');
  assert.match(ar, /href="\/admin\/creative-studio"/);
  assert.match(ar, /افتح الاستوديو/);
  assert.match(en, /Open the studio/);
  assert.match(ckb, /ستۆدیۆکە بکەرەوە/);
});

test('an assistant admin meets the refusal; the owner gets the tabs and an honest loading Home', () => {
  const refused = html(createElement(StudioShell), 'ar', ASSISTANT);
  assert.match(refused, /data-studio-refused/);
  assert.match(refused, new RegExp(S.assistantRefused.ar));
  const owner = html(createElement(StudioShell), 'ckb', OWNER);
  assert.match(owner, /data-studio-tab="home"/);
  for (const k of ['tabHome', 'tabNew', 'tabBrand', 'tabAssets', 'tabArchive', 'tabSettings'] as const) assert.match(owner, new RegExp(S[k].ckb), k);
  assert.match(owner, new RegExp(S.loading.ckb), 'Home shows it is loading, not an empty success');
  assert.doesNotMatch(owner, new RegExp(S.tabEditor.ckb), 'no editor tab until a design is open');
});

test('AI not ready says why by code and links to Settings; manual editing keeps working', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const out = html(createElement(AiNotReady, { provider: notReady('MODEL_NOT_SELECTED'), onSettings: () => {} }), lang);
    assert.match(out, /data-ai-not-ready="MODEL_NOT_SELECTED"/);
    assert.ok(out.includes(ERROR_TEXT.MODEL_NOT_SELECTED[lang]), lang);
    assert.ok(out.includes(S.aiManualStillWorks[lang]), lang);
    assert.ok(out.includes(S.aiGoSettings[lang]), lang);
  }
  const unknown = html(createElement(AiNotReady, { provider: null, onSettings: () => {} }), 'en');
  assert.match(unknown, /data-ai-not-ready="KEY_NOT_CONFIGURED"/, 'no status at all reads as «no key», never as ready');
});

test('the editor opens on a design built from marked test data: banner, save state, phone toolbar', () => {
  const meta: DocumentDto = {
    id: 'doc_test_1', title: 'TEST A1', status: 'draft', kind: 'post', format: doc.format, product_id: 'p_test_a1', product_name: snapshot.data.name, template_id: 'product_hero',
    version: 3, approved_version: null, needs_review: [], campaign_id: null, parent_id: null, updated_at: '2026-10-27T09:00:00Z', created_at: '2026-10-27T09:00:00Z',
    thumb_export_id: null, content: doc, brand_version: null, updated_by_name: null, issues: [],
  };
  const data = { brand: ctx(null).brand!, snapshots: { main: snapshot }, claims: [], assets: [], opportunities: [] };
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const out = html(createElement(StudioContext.Provider, { value: ctx(notReady('KEY_NOT_CONFIGURED')) }, createElement(EditorReady, { meta, data })), lang);
    assert.match(out, /data-editor/);
    assert.match(out, /data-test-banner/, 'a test snapshot is said on screen');
    assert.match(out, /data-save-state="saved"/);
    assert.ok(out.includes(S.panelChat[lang]) && out.includes(S.panelLayers[lang]), `${lang}: the phone toolbar`);
    assert.ok(out.includes(S.fontsLoading[lang]), `${lang}: nothing is drawn before the fonts load`);
  }
});

test('the checks panel lists the checks that ran and the ones that did not — never a score', () => {
  const images = new ImageStore();
  const api = {
    docId: 'doc_test_1', doc, version: 3, saveState: 'saved', selection: [], verification: {}, provider: notReady('KEY_NOT_CONFIGURED'),
    data: { brand: ctx(null).brand!, snapshots: { main: snapshot }, claims: [], assets: [], opportunities: [] },
    measure: approximateMeasurer, fonts: { loaded: new Set<string>(), failed: [] }, images,
    stage: () => null, flush: async () => {}, current: () => ({ doc, version: 3, saveState: 'saved' as const }), setVerification: () => {},
  } as unknown as EditorApi;
  const out = html(createElement(QaPanel, { api }), 'en');
  assert.match(out, /data-qa-panel/);
  assert.match(out, new RegExp(S.qaNotAScore.en));
  assert.match(out, /Checks that ran/);
  assert.match(out, /Font that did not load|A font that did not load/, 'fonts not reported loaded is a blocker, not a pass');
  assert.match(out, /A picture that did not load/, 'pictures not decoded are a blocker');
  assert.match(out, /Marked test data/);
});
