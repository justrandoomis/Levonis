/**
 * COMMUNITY V3 PUSH 1.3 — WAVE 1 OF THE MERCHANT ADMIN (DECISIONS row 260;
 * the Shopify gap matrix rows 0–3, our words).
 *
 *   - ONE refusal mapper (src/lib/approvalGate.ts): MERCHANT_NOT_APPROVED and
 *     the selling reason 'not_approved' are one sentence, «يُفعَّل بعد اعتماد
 *     متجرك», in every toast mapper and beside every held control, which stays
 *     visible; drafts are never held;
 *   - readiness before opening: the verdicts from fixtures of the server's own
 *     setup read, needed vs recommended, opening a deliberate tap;
 *   - Today's approval card for every state of the application;
 *   - every new string in Arabic, English and real Sorani.
 *
 * Run: node --import tsx --test tests/merchantApprovalWave1Ui.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { APPROVAL_GATE_CODE, APPROVAL_GATE_REASON, APPROVAL_GATE_WORDS, approvalGateText, gateHint, isApprovalGate } from '../src/lib/approvalGate';
import { REFUSAL_STRINGS, refusalText } from '../src/lib/refusalStrings';
import { merchantRefusal } from '../src/components/merchant/shell/refusal';
import { sellingReason, W } from '../src/components/merchant/shell/strings';
import { storeStatus } from '../src/components/merchant/shell/status';
import { catalogRefusalText, catalogStrings } from '../src/components/merchant/catalog/strings';
import { builderRefusal } from '../src/components/merchant/storeDesign/refusal';
import { applicationCta } from '../src/components/merchantApplication/approvalWords';
import { COUNTER_STRINGS } from '../src/components/merchant/counter/strings';
import { APPLICATION_LINK, missingRequired, opensThroughReadiness, readinessVerdicts, type Setup } from '../src/components/merchant/counter/readiness';
import { approvalTone } from '../src/components/merchant/counter/ApprovalCard';
import { LanguageProvider } from '../src/LanguageContext';
import { WorkspaceContext, type WorkspaceValue } from '../src/components/merchant/shell/context';
import CommandCenter from '../src/components/merchant/shell/sections/CommandCenter';
import type { ApplicationSummary, MerchantMe } from '../src/lib/merchant';
import { APPROVAL_REQUIRED_LINK, approvalRequiredNotice } from '../worker/lib/merchantNotify';
import { workspaceLinkTarget } from '../src/components/merchant/shell/routeTable';

type L = 'ar' | 'en' | 'ckb';
const LANGS: L[] = ['ar', 'en', 'ckb'];
const locOf = (l: L) => (ar: string, en: string, ckb?: string) => (l === 'en' ? en : l === 'ckb' ? ckb ?? `MISSING:${ar}` : ar);
const SORANI = /[ەێۆڕڵ]/u;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

// ======================================================== the one mapper

test('the gate is ONE sentence in three languages, with a real Sorani', () => {
  const words = LANGS.map((l) => approvalGateText(locOf(l)));
  assert.deepEqual(words, [APPROVAL_GATE_WORDS.ar, APPROVAL_GATE_WORDS.en, APPROVAL_GATE_WORDS.ckb]);
  assert.equal(APPROVAL_GATE_WORDS.ar, 'يُفعَّل بعد اعتماد متجرك');
  assert.equal(new Set(words).size, 3);
  assert.notEqual(APPROVAL_GATE_WORDS.ckb, APPROVAL_GATE_WORDS.ar);
  assert.match(APPROVAL_GATE_WORDS.ckb, SORANI);
});

test('both spellings of the cause map to it — the server code and the selling reason — and nothing else does', () => {
  for (const cause of [APPROVAL_GATE_CODE, APPROVAL_GATE_REASON, { code: 'MERCHANT_NOT_APPROVED' }, Object.assign(new Error('x'), { code: 'MERCHANT_NOT_APPROVED' })]) {
    assert.equal(isApprovalGate(cause), true, JSON.stringify(cause));
  }
  for (const cause of ['STORE_PAUSED', 'subscription_inactive', 'store_paused', { code: 'MERCHANT_SUSPENDED' }, null, undefined, 3]) {
    assert.equal(isApprovalGate(cause), false, String(cause));
  }
  const loc = locOf('ar');
  assert.equal(gateHint('not_approved', loc, 'other'), APPROVAL_GATE_WORDS.ar);
  assert.equal(gateHint('store_paused', loc, 'other'), 'other', 'a pause keeps its own reason');
});

test('every toast mapper says the same words for a 403 MERCHANT_NOT_APPROVED', () => {
  const err = { code: 'MERCHANT_NOT_APPROVED', status: 403, message: 'Your merchant account is not approved yet' };
  for (const l of LANGS) {
    const want = APPROVAL_GATE_WORDS[l];
    const loc = locOf(l);
    assert.equal(REFUSAL_STRINGS.MERCHANT_NOT_APPROVED[l], want, `the refusal table (${l})`);
    assert.equal(refusalText('MERCHANT_NOT_APPROVED', l), want, `refusalText / apiRefusal (${l})`);
    assert.equal(merchantRefusal(err, l, 'fallback'), want, `the workspace mapper (${l})`);
    assert.equal(catalogRefusalText('MERCHANT_NOT_APPROVED', loc, 'fallback'), want, `the catalogue (${l})`);
    assert.equal(builderRefusal(err, loc), want, `the store builder (${l})`);
    assert.equal(sellingReason('not_approved', loc), want, `the status pill and quick create (${l})`);
  }
});

/**
 * REVIEW FINDING 6: the pill reads the store's OWN state — an open store of a
 * merchant awaiting approval reads «open», never «paused» (a tap on the
 * switch would then pause it for real, and re-opening is refused until
 * approval). The KEY and the LABEL are asserted, not only the reason.
 */
test('the pill under review: an OPEN store reads open, a merchant pause reads paused and says the gate (re-opening waits for approval), a lapsed plan reads lapsed', () => {
  const at = (status: string, selling: MerchantMe['selling']) =>
    storeStatus({ store: { status, merchant: { status: 'active' } } as never, selling, approved: false, application: null });
  const open = at('active', { canSell: false, reason: 'not_approved', canDraft: true, operational: '' });
  assert.equal(open.key, 'open');
  assert.deepEqual(open.label, W.open);
  assert.equal(open.tone, 'success');
  assert.equal(open.reason(locOf('ar')), '');
  assert.ok(open.approval, 'approval is its own notice beside the pill');
  // An older server without `operational`: the store's own status decides.
  assert.equal(at('active', { canSell: false, reason: 'not_approved' }).key, 'open');

  const paused = at('paused', { canSell: false, reason: 'not_approved', canDraft: false, operational: 'store_paused' });
  assert.equal(paused.key, 'paused');
  assert.deepEqual(paused.label, W.paused);
  for (const l of LANGS) {
    const why = paused.reason(locOf(l));
    assert.notEqual(why, sellingReason('store_paused', locOf(l)), `${l}: never «re-open it from store settings» — that is refused`);
    assert.equal(why, APPROVAL_GATE_WORDS[l], `${l}: the gate's one sentence`);
  }

  const lapsed = at('active', { canSell: false, reason: 'not_approved', canDraft: false, operational: 'subscription_inactive' });
  assert.equal(lapsed.key, 'lapsed', 'a lapsed PLUS still reads lapsed under review');
  assert.deepEqual(lapsed.label, W.lapsed);

  // An APPROVED merchant's pause still says to re-open from settings.
  const approvedPause = storeStatus({ store: { status: 'paused', merchant: { status: 'active' } } as never, selling: { canSell: false, reason: 'store_paused' }, approved: true, application: null });
  assert.equal(approvedPause.reason(locOf('en')), sellingReason('store_paused', locOf('en')));

  // The open/pause switch's word and Today's line are the pill's label.
  const strip = code('src/components/merchant/counter/StatusStrip.tsx');
  assert.match(strip, /say\(loc, status\.label\)/);
});

// ==================================================== every held control

test('quick create: a product (a DRAFT) stays open under review; coupon and section say the gate', () => {
  const shell = code('src/components/merchant/shell/MerchantShell.tsx');
  assert.match(shell, /const canDraft = me\.selling\.canDraft \?\? canSell;/);
  assert.match(shell, /id: 'new-product'[^\n]*disabled: !canDraft, hint: canDraft \? undefined : sellingReason/);
  assert.match(shell, /id: 'new-coupon'[^\n]*disabled: !canSell, hint: canSell \? undefined : sellingReason/);
  assert.match(shell, /id: 'new-collection'[^\n]*disabled: !canSell, hint: canSell \? undefined : sellingReason/);
  assert.match(shell, /sellingReason=\{heldHint\}/);
  assert.match(shell, /const heldHint = gateHint\(me\.selling\.reason, loc, status\.reason\(loc\)\) \?\? '';/, 'the hint is the gate while approval holds selling — the pill reason ("" for open) never is');
  // The search palette's «new product» follows the same draft rule; coupons and sections stay with selling.
  assert.match(shell, /canSell=\{canSell\} canDraft=\{canDraft\}/);
  const palette = code('src/components/merchant/shell/WorkspacePalette.tsx');
  assert.match(palette, /\.\.\.\(canDraft \? \[\{ id: 'new-product'/);
  assert.match(palette, /\.\.\.\(canSell\s+\? \[\s+\{ id: 'new-coupon'/);
  // The shell notice yields to Today's card on Today, and no second banner repeats it elsewhere.
  assert.match(shell, /\{status\.approval && section !== 'home' && \(/);
  assert.match(shell, /status\.key !== 'open' && section !== 'home' && me\.selling\.reason !== 'not_approved'/);
});

test('the catalogue: Publish and every selling item carry the gate; «new product» and editing stay open', () => {
  const cm = code('src/components/merchant/catalog/CatalogManager.tsx');
  assert.match(cm, /const held = canSell \? undefined : gateHint\(sellingReason, loc\);/);
  assert.match(cm, /id: 'publish'[^\n]*disabled: !canSell \|\| admin, hint: admin \? undefined : held/, 'the row menu Publish says why');
  for (const id of ['duplicate', 'feature', 'price', 'stock', 'add', 'import']) {
    assert.match(cm, new RegExp(`id: '${id}'[^\\n]*disabled: !canSell, hint: held`), `${id} says why`);
  }
  assert.match(cm, /onClick=\{\(\) => setEditing\(\{ id: null \}\)\} disabled=\{!drafts\} data-new-product/);
  assert.match(cm, /if \(drafts\) setEditing\(\{ id: null \}\)/, 'the quick-create door opens the editor under review');
  // Drafts are offered only while they ARE open (review finding 7).
  assert.match(cm, /gated \? `\$\{held\} — \$\{drafts \? s\.draftsUnderReview : store\.status === 'paused' \? s\.draftsAfterReopen : s\.cannotSell\}` : s\.cannotSell/);
  assert.match(cm, /\{ id: 'edit', label: s\.edit, [^\n]*onSelect: \(\) => setEditing\(\{ id: p\.id \}\) \}/, 'edit is never held');
  const sections = code('src/components/merchant/shell/sections.tsx');
  assert.match(sections, /canDraft=\{ws\.canDraft\}\s+sellingReason=\{ws\.me\.selling\.reason\}/);
  const editor = code('src/components/merchant/catalog/ProductEditorSheet.tsx');
  assert.match(editor, /disabled: id === 'published' && \(hiddenByAdmin \|\| gated \|\|/);
  assert.match(editor, /\{gated && \([\s\S]{0,200}data-approval-gate[\s\S]{0,120}approvalGateText\(loc\)/);
});

test('the store settings save: a re-open or a selling switch refused under review says the gate, after «nothing was saved»', () => {
  const settings = code('src/components/merchant/dashboard/StoreSettingsTab.tsx');
  assert.match(settings, /case 'MERCHANT_NOT_APPROVED':\s+return `\$\{loc\('لم يُحفظ شيء', 'Nothing was saved', 'هیچ شتێک پاشەکەوت نەکرا'\)\}: \$\{approvalGateText\(loc\)\}`;/);
});

test('the store builder: Publish and «restore and publish» are held with the sentence beside them; the draft saves', () => {
  const panel = code('src/components/merchant/storeDesign/StoreDesignPanel.tsx');
  assert.match(panel, /const gate = ws\?\.me\.approved === false \? approvalGateText\(loc\) : null;/);
  assert.match(panel, /disabled=\{!!gate \|\| nothingToPublish/);
  assert.match(panel, /\{gate && \([\s\S]{0,160}data-approval-gate/);
  assert.match(panel, /gate=\{gate\}/);
  const flows = code('src/components/merchant/storeDesign/flows.tsx');
  assert.match(flows, /disabled=\{!!busy \|\| !!gate\} title=\{gate \?\? undefined\} onClick=\{\(\) => restore\(r, true\)\}/);
  assert.match(flows, /disabled=\{!!busy\} onClick=\{\(\) => restore\(r, false\)\}/, 'restoring into the DRAFT stays open (E10)');
});

// ============================================================ readiness

const LINKS = { settings: '/merchant/store_settings', delivery: '/merchant/store_delivery', products: '/merchant/products?new=1', services: '/merchant/services', design: '/merchant/store_design' };
function setup(over: Partial<Setup> = {}): Setup {
  return { approved: true, logo: true, banner: true, about: true, phone: true, delivery: true, reach: 3, pickup: false, products: 2, services: 0, design: true, links: LINKS, ...over };
}

test('readiness from fixtures: a ready store is ticks only; each missing needed step is a door to its fix', () => {
  const ready = readinessVerdicts(setup(), true);
  assert.deepEqual(ready.map((v) => v.id), ['approved', 'delivery', 'offer', 'phone', 'design', 'logo', 'banner', 'about']);
  assert.deepEqual(ready.filter((v) => v.required).map((v) => v.id), ['approved', 'delivery', 'offer', 'phone', 'design']);
  assert.ok(ready.every((v) => v.ok));
  assert.equal(missingRequired(ready), 0);

  const bare = readinessVerdicts(setup({ reach: 0, pickup: false, products: 0, services: 0, phone: false, design: false, logo: false, banner: false, about: false }), true);
  assert.equal(missingRequired(bare), 4);
  const byId = Object.fromEntries(bare.map((v) => [v.id, v]));
  assert.equal(byId.delivery.link, LINKS.delivery);
  assert.equal(byId.offer.link, LINKS.products);
  assert.equal(byId.phone.link, LINKS.settings);
  assert.equal(byId.design.link, LINKS.design);
  // Cosmetic steps are recommended, never needed.
  for (const id of ['logo', 'banner', 'about']) assert.equal(byId[id].required, false, id);
});

test('readiness: a service counts as something to buy; pickup counts as reach (the re-open door\'s own rule)', () => {
  const services = readinessVerdicts(setup({ products: 0, services: 1 }), true);
  assert.equal(services.find((v) => v.id === 'offer')!.ok, true);
  const pickup = readinessVerdicts(setup({ reach: 0, pickup: true }), true);
  assert.equal(pickup.find((v) => v.id === 'delivery')!.ok, true);
  const nowhere = readinessVerdicts(setup({ reach: 0, pickup: false }), true);
  assert.equal(nowhere.find((v) => v.id === 'delivery')!.ok, false);
  // An older server without `reach`: a delivery profile stands for it.
  const older = readinessVerdicts(setup({ reach: undefined, pickup: undefined, delivery: true }), true);
  assert.equal(older.find((v) => v.id === 'delivery')!.ok, true);
});

test('readiness: approval comes from the server; unapproved, its row points at the application and has no other fix', () => {
  const v = readinessVerdicts(setup({ approved: false }), true);
  assert.deepEqual(v[0], { id: 'approved', ok: false, required: true, link: APPLICATION_LINK });
  assert.equal(APPLICATION_LINK, '/merchant/start');
  // The setup read predating the field falls back to /me's answer.
  assert.equal(readinessVerdicts(setup({ approved: undefined }), false)[0].ok, false);
  assert.equal(readinessVerdicts(setup({ approved: undefined }), true)[0].ok, true);
});

test('opening goes through the verdict only for an APPROVED merchant opening a CLOSED store; pausing never waits', () => {
  assert.equal(opensThroughReadiness(true, true, 'paused'), true);
  assert.equal(opensThroughReadiness(false, true, 'active'), false, 'pausing');
  assert.equal(opensThroughReadiness(true, false, 'paused'), false, 'unapproved: the server answers with the gate');
  assert.equal(opensThroughReadiness(true, undefined, 'paused'), false, 'an older server');
  assert.equal(opensThroughReadiness(true, true, 'suspended'), false);
  const strip = code('src/components/merchant/counter/StatusStrip.tsx');
  assert.match(strip, /if \(opensThroughReadiness\(next, ws\.me\.approved, store\.status\)\) \{/);
  assert.match(strip, /const ReadinessSheet = lazy\(\(\) => import\('\.\/ReadinessSheet'\)\);/, 'its chunk loads on first use');
  const sheet = code('src/components/merchant/counter/ReadinessSheet.tsx');
  assert.match(sheet, /readinessVerdicts\(setup, ws\.me\.approved === true\)/, 'the verdict is the checklist\'s own read');
  assert.match(sheet, /onClick=\{onOpenStore\}/, 'opening is a deliberate tap');
  assert.match(sheet, /ready \? s\.readiness\.open : s\.readiness\.openAnyway/);
  const ws = code('worker/routes/merchantWorkspace.ts');
  assert.match(ws, /approved: merchantApproved\(ctx\.merchant\)/);
  assert.match(ws, /deliveryCoverage\(cfg\.profile, cfg\.rules\)/);
});

// ================================================== Today's approval card

function me(application: ApplicationSummary | null, approved: boolean): MerchantMe {
  return {
    approved,
    application,
    eligible: true,
    tier: 'plus',
    tier_active: true,
    expires_at: null,
    gated_benefits: [],
    can: { store: true, products: true, orders: true, offers: true, analytics: true, subdomain: true },
    store: {
      id: 's1', merchant_id: 'm1', slug: 'ali3d', url: 'https://ali3d.levonis-iq.com', name: 'Dragon Forge', tagline: '', description: '',
      logoUrl: null, bannerUrl: null, accent: 'gold', categories: [], governorate: 'baghdad', service_areas: [], contact_phone: null,
      business_hours: [], policies: {}, social_links: {}, accepts_custom_requests: true, sells_direct_products: true, status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      merchant: { id: 'm1', name: 'Ali', verified: false, status: 'active', badge: 'new', rating: null, rating_count: 0, completed_orders: 0 },
    } as unknown as MerchantMe['store'],
    selling: approved ? { canSell: true, reason: '', canDraft: true } : { canSell: false, reason: 'not_approved', canDraft: true },
    suggested_slug: null,
  } as MerchantMe;
}

function today(m: MerchantMe): string {
  const ws: WorkspaceValue = {
    me: m,
    store: m.store!,
    canSell: m.selling.canSell,
    canDraft: true,
    base: '/merchant',
    onStoreHost: false,
    href: (l) => l,
    mainHref: (p) => p,
    resolveLink: (l) => ({ internal: true, to: l }),
    go: () => {},
    query: { create: false },
    clearQuery: () => {},
    reloadMe: () => {},
    attention: { data: null, error: null, loading: false, refresh: () => {} },
    setBellUnread: () => {},
  };
  return renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(MemoryRouter, null, createElement(WorkspaceContext.Provider, { value: ws }, createElement(CommandCenter))),
    })
  );
}
const attr = (h: string, name: string) => [...h.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((x) => x[1]);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('Today\'s approval card: one card per state, the reviewer\'s PUBLIC reason, the one action that moves it', () => {
  const app = (state: ApplicationSummary['state'], reason = ''): ApplicationSummary => ({ state, revision: 2, reason_public: reason });
  const cases: Array<[ApplicationSummary | null, string, string, 'info' | 'warning']> = [
    [null, 'none', 'قدّم طلب اعتماد التاجر', 'warning'],
    [app('draft'), 'draft', 'أكمل طلبك', 'warning'],
    [app('in_review'), 'in_review', 'تابع طلبك', 'info'],
    [app('submitted'), 'submitted', 'تابع طلبك', 'info'],
    [app('changes_requested', 'ADD-A-CLEARER-PHOTO'), 'changes_requested', 'عدّل الطلب', 'warning'],
    [app('rejected', 'NOT-A-WORKSHOP'), 'rejected', 'قدّم من جديد', 'warning'],
  ];
  for (const [a, key, cta, tone] of cases) {
    const h = today(me(a, false));
    assert.deepEqual(attr(h, 'data-approval-card'), [key], key);
    assert.deepEqual(attr(h, 'data-approval-action'), [key]);
    assert.ok(text(h).includes(cta), `${key}: «${cta}»`);
    assert.equal(approvalTone(a), tone, key);
    assert.match(h, new RegExp(`class="lv-alert lv-alert-${tone}`), `${key} is ${tone}`);
    if (a?.reason_public) assert.ok(text(h).includes(a.reason_public), `${key}: the public reason is said`);
    assert.ok(text(h).includes(COUNTER_STRINGS.ar.approval.stillWorks), `${key}: what still works`);
    assert.match(h, /href="\/merchant\/start"/);
    assert.doesNotMatch(h, /role="alert"[^>]*data-approval|data-approval[^>]*role="alert"/, 'a decision never interrupts');
  }
  assert.deepEqual(attr(today(me(null, true)), 'data-approval-card'), [], 'an approved merchant has no card');
});

/**
 * REVIEW FINDING 7: under review AND paused by the merchant, product drafts
 * are held too (the pause) and re-opening waits for approval — the card
 * promises no drafts and says so; while drafts ARE open it promises them.
 */
test('Today\'s approval card promises product drafts only while they are open; a merchant pause says re-opening waits for approval', () => {
  const pausedMe = me({ state: 'in_review', revision: 1, reason_public: '' }, false);
  pausedMe.selling = { canSell: false, reason: 'not_approved', canDraft: false, operational: 'store_paused' };
  pausedMe.store = { ...pausedMe.store!, status: 'paused' };
  const h = today(pausedMe);
  assert.deepEqual(attr(h, 'data-approval-still-works'), ['no-drafts']);
  assert.ok(text(h).includes(COUNTER_STRINGS.ar.approval.stillWorksNoDrafts));
  assert.ok(!text(h).includes(COUNTER_STRINGS.ar.approval.stillWorks), 'never «product drafts» while they are held');
  assert.ok(text(h).includes(COUNTER_STRINGS.ar.approval.reopenAfterApproval));

  const openMe = today(me({ state: 'in_review', revision: 1, reason_public: '' }, false));
  assert.deepEqual(attr(openMe, 'data-approval-still-works'), ['drafts']);
  assert.ok(!text(openMe).includes(COUNTER_STRINGS.ar.approval.reopenAfterApproval));

  const [ar, en, ckb] = LANGS.map((l) => catalogStrings(locOf(l)).draftsAfterReopen);
  assert.ok(ar && en && ckb && ckb !== ar && !ckb.startsWith('MISSING'));
  assert.match(ckb, SORANI);
});

test('the changes-requested action is «عدّل الطلب», in three languages', () => {
  const cta = LANGS.map((l) => applicationCta({ state: 'changes_requested', revision: 2, reason_public: '' }, locOf(l)));
  assert.deepEqual(cta, ['عدّل الطلب', 'Edit your application', 'داواکارییەکە دەستکاری بکە']);
  assert.notEqual(applicationCta({ state: 'draft', revision: 1, reason_public: '' }, locOf('ar')), cta[0], 'a draft is completed, a returned one is edited');
});

/**
 * REVIEW FINDING 8: approval has its own code on the board and in the
 * diagnostics, mapped to the gate's sentence — never «your account is not
 * active» or «open your store / check your plan».
 */
test('the workshop board and the printers diagnostics say the gate for MERCHANT_NOT_APPROVED, with no «open / renew» advice', () => {
  const board = code('src/components/merchant/workshop/RequestBoard.tsx');
  assert.match(board, /blocked === 'MERCHANT_NOT_APPROVED'\s+\? approvalGateText\(loc\)/);
  const desc = /blocked === 'MERCHANT_NOT_APPROVED'\s+\? loc\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\s*\)/.exec(board);
  assert.ok(desc, 'the description is three-language');
  assert.match(desc![3], SORANI);
  assert.notEqual(desc![3], desc![1]);
  for (const words of desc!.slice(1)) assert.doesNotMatch(words, /افتح|Open your store|plan|اشتراك/i);
  const printers = code('src/components/merchant/dashboard/PrintersTab.tsx');
  assert.match(printers, /case 'MERCHANT_NOT_APPROVED':\s+return approvalGateText\(loc\);/);
  const api = code('src/components/merchant/workshop/api.ts');
  assert.match(api, /blocked\?: 'CANNOT_TAKE_WORK' \| 'NOT_TAKING_REQUESTS' \| 'MERCHANT_NOT_APPROVED';/);
});

// ====================================================== the notice's link

/**
 * REVIEW FINDING 9: the approval-required notice links to the application at
 * `/merchant/start` — a MAIN-SITE page. The centre re-based every link onto
 * the store's host, so from a store's own `/admin` it opened Today. Its rows
 * now resolve through the workspace's own `resolveLink`.
 */
test('the approval notice opens the application on the main site from a store\'s own /admin; workspace links stay in the router', () => {
  const main = (p: string) => `https://levonis-iq.com${p}`;
  assert.equal(APPROVAL_REQUIRED_LINK, '/merchant/start');
  assert.deepEqual(workspaceLinkTarget(APPROVAL_REQUIRED_LINK, '/admin', true, main), { internal: false, to: 'https://levonis-iq.com/merchant/start' });
  assert.deepEqual(workspaceLinkTarget(APPROVAL_REQUIRED_LINK, '/merchant', false, main), { internal: true, to: '/merchant/start' });
  assert.deepEqual(workspaceLinkTarget('/merchant/orders/ORD-1', '/admin', true, main), { internal: true, to: '/admin/orders/ORD-1' });
  assert.deepEqual(workspaceLinkTarget('/merchant/orders/ORD-1', '/merchant', false, main), { internal: true, to: '/merchant/orders/ORD-1' });

  const shell = code('src/components/merchant/shell/MerchantShell.tsx');
  assert.match(shell, /const resolveLink = useCallback\(\(link: string\) => workspaceLinkTarget\(link, base, onStoreHost, mainHref\)/);
  const section = code('src/components/merchant/shell/sections/NotificationsSection.tsx');
  assert.match(section, /<MerchantNotificationCenter\s+resolveLink=\{ws\.resolveLink\}/);
  const centre = code('src/components/merchant/notifications/MerchantNotificationCenter.tsx');
  assert.match(centre, /<RowLink\s+target=\{target\(n\.link \|\| '\/merchant'\)\}/);
  assert.match(centre, /target\.internal \? \(\s*<Link to=\{target\.to\}[\s\S]{0,120}\) : \(\s*<a href=\{target\.to\}/, 'another site is a plain link — a full navigation');
  assert.doesNotMatch(centre, /to=\{hostPath\(n\.link/, 'no row re-bases a platform page onto the store host');
});

// ============================================================== strings

test('every new string is in Arabic, English and real Sorani', () => {
  for (const block of ['approval', 'readiness'] as const) {
    const keys = Object.keys(COUNTER_STRINGS.ar[block]);
    for (const l of LANGS) assert.deepEqual(Object.keys(COUNTER_STRINGS[l][block]), keys, `${block} keys in ${l}`);
    for (const k of keys) {
      const [ar, en, ckb] = LANGS.map((l) => (COUNTER_STRINGS[l][block] as Record<string, string>)[k]);
      assert.ok(ar && en && ckb, `${block}.${k}`);
      assert.notEqual(ckb, ar, `${block}.${k}: Sorani is not the Arabic`);
      assert.notEqual(en, ar, `${block}.${k}`);
      assert.match(ckb, SORANI, `${block}.${k}: Sorani letters`);
    }
  }
  const [ar, en, ckb] = LANGS.map((l) => catalogStrings(locOf(l)).draftsUnderReview);
  assert.ok(ar && en && !ckb.startsWith('MISSING'));
  assert.match(ckb, SORANI);
  const [par, pen, pckb] = LANGS.map((l) => catalogStrings(locOf(l)).publishing);
  assert.ok(par !== pen && !pckb.startsWith('MISSING') && pckb !== par);
  // The notice is three-language too: Arabic and English on the row, Sorani in its meta.
  const n = approvalRequiredNotice('m1');
  assert.ok(n.title_ar && n.title_en && n.body_ar && n.body_en);
  assert.match(String(n.meta?.title_ckb) + String(n.meta?.body_ckb), SORANI);
  assert.notEqual(n.meta?.title_ckb, n.title_ar);
});

test('the Sorani readiness sentence fills its count', () => {
  for (const l of LANGS) assert.match(COUNTER_STRINGS[l].readiness.missing, /\{n\}/, l);
});
