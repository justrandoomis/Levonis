/**
 * THE REQUEST PAGE (docs/COMMUNITY_ECOSYSTEM.md §9.5 «Client», Client 5c) —
 * src/pages/community/Request.tsx (/requests/:id), the offers V2
 * (src/components/community/requests/OfferCompare.tsx, OfferComposer.tsx),
 * the discussion (Discussion.tsx), and the redirect from the old
 * `/requests?request=<id>` (src/pages/Requests.tsx).
 *
 *   the words: every key in ar, en AND real Sorani (./strings.ts), counted
 *   Arabic nouns («3 أيام», «14 يومًا»), a handover in the READER's words on
 *   a card and in the merchant's own voice in the composer;
 *   the address: `?request=<id>&cost=1#discussion` → `/requests/<id>?cost=1#discussion`,
 *   replaced (never pushed), and the route file's own back, key and lazy doors;
 *   the landmarks: the sections in the owner's order;
 *   the offers (`renderToStaticMarkup`, the technique of
 *   tests/orderTimelineUi.test.ts): every card shows its TOTAL, a revised
 *   offer says «عرض معدّل» with the old price, only a live offer can be
 *   accepted, the acceptance body is `expected_total_iqd` + `offer_revision`
 *   and never a price; the workshop gets «قدّم عرضًا», its draft card «أرسل
 *   العرض» / «أكمل المسودة», and the composer «احفظ مسودة» / «أرسل العرض»
 *   with the total previewed — an edit of a sent offer only «احفظ النسخة
 *   الجديدة»; `draft: true` only on the draft, the validity only when it is
 *   the merchant's choice;
 *   the discussion by role: the customer answers a question («أجب», only an
 *   unanswered one) and is never offered «سؤال للعميل»; a workshop that may
 *   ask gets the picker; a guest the sign-in line; a closed request says so;
 *   the pins: tokens only, no key on any card, the timeline door is Client
 *   5d's lazy OrderTimeline.
 *
 * Run: node --import tsx --test tests/requestPageUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { CommentsPage, OfferV2, RequestComment } from '../src/components/community/requests/api';

// The app's windows portal into `document.body` even while closed — nothing
// the server renderer can draw — so three modules are answered here with
// stand-ins: the Sheet draws its header, body and footer inline while open
// (so the composer's two exits can be read), the confirm dialog and the menu
// draw nothing but the menu's trigger. That the components ASK through them
// is pinned in the sources below.
const REACT = pathToFileURL(join(ROOT, 'node_modules/react/index.js')).href;
const stubUrl = (src: string) => 'data:text/javascript,' + encodeURIComponent(src);
const SHEET = stubUrl(
  `import React from '${REACT}';
   export function Sheet(p) {
     if (!p.open) return null;
     return React.createElement('div', { 'data-sheet-stub': p.testId || '' }, p.header || null, typeof p.children === 'function' ? null : p.children, p.footer || null);
   }`
);
const CONFIRM = stubUrl('export function useConfirm(){ return [async () => false, null]; } export function ConfirmDialog(){ return null; }');
const MENU = stubUrl(
  `export function Menu(p) {
     return p.trigger({ ref() {}, 'aria-haspopup': 'menu', 'aria-expanded': false, 'aria-controls': undefined, onClick() {}, onKeyDown() {} });
   }`
);
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `const SHEET = ${JSON.stringify(SHEET)};
       const CONFIRM = ${JSON.stringify(CONFIRM)};
       const MENU = ${JSON.stringify(MENU)};
       export async function resolve(specifier, context, next) {
         if (/\\/ui\\/Sheet(\\.tsx)?$/.test(specifier)) return { url: SHEET, shortCircuit: true };
         if (/\\/ui\\/ConfirmDialog(\\.tsx)?$/.test(specifier)) return { url: CONFIRM, shortCircuit: true };
         if (/\\/ui\\/Menu(\\.tsx)?$/.test(specifier)) return { url: MENU, shortCircuit: true };
         return next(specifier, context);
       }`
    )
);

// The language provider reads `levo_lang` from localStorage on mount; a stub
// lets each render pick its language the way the browser fixtures do.
let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { AuthContext } = await import('../src/AuthContext');
const strings = await import('../src/components/community/requests/strings');
const states = await import('../src/components/community/requests/requestStates');
const compare = await import('../src/components/community/requests/OfferCompare');
const composer = await import('../src/components/community/requests/OfferComposer');
const discussion = await import('../src/components/community/requests/Discussion');
const { REQUEST_STRINGS, requestStrings, daysLabel, jobsLabel, shortDay, offerStateWords, orderStateWord, escrowSentence, systemUpdateLabel, fillNodes, handoverLabel, composerHandover, fill } = strings;
const { requestStepIndex, requestStateTone, requestTakesOffers, requestPath, requestRedirect, REQUEST_STEPS, REQUEST_SECTIONS, latestEvent } = states;
const OfferCompare = compare.default;
const { offerIsLive, bestOffers, sortOffers, acceptBody } = compare;
const OfferComposer = composer.default;
const { MerchantOfferSection, offerFileKind, previewTotal, defaultHandover, termsFrom, offerBody, VALIDITY } = composer;
const Discussion = discussion.default;
const { startKinds, threadsOf, awaitsAnswer, sortThread, roleWord, COMMENT_MAX } = discussion;

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

const auth = (signedIn: boolean) => ({
  isAuthenticated: signedIn,
  user: signedIn ? { id: 'u1', username: 'eve', name: 'Eve' } : null,
  login: async () => {},
  loginWithGoogle: async () => {},
  register: async () => {},
  refreshUser: async () => {},
  logout: async () => {},
  isLoaded: true,
});
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar', signedIn = true) => {
  storedLang = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, { value: auth(signedIn) as never }, createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }))
  );
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const attrs = (h: string, name: string) => [...h.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length;

const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const merchant = (id: string, name: string, rating: number | null) => ({ id, name, verified: false, badge: '', rating, rating_count: 3, completed_orders: 12, store_slug: id });
function offer(over: Partial<OfferV2> = {}): OfferV2 {
  return {
    id: 'off_1',
    request_id: 'req_1',
    merchant_id: 'm1',
    store_id: 's1',
    price_iqd: 18000,
    delivery_fee_iqd: 2000,
    total_iqd: 20000,
    quantity: 2,
    color: '',
    terms: '',
    completion_days: 3,
    delivery_method: 'merchant_delivery',
    message: '',
    materials: '',
    material_ids: ['petg'],
    included: '',
    warranty_terms: '',
    state: 'pending',
    draft: false,
    expires_at: day(6),
    valid_until: day(6),
    created_at: day(-1),
    updated_at: day(-1),
    revision: 1,
    request_revision: 1,
    revised: false,
    stale: false,
    expired: false,
    files: [],
    history: [],
    merchant: merchant('m1', 'Ali 3D', 4.8),
    ...over,
  };
}
const materials = [
  { id: 'pla', process: 'fdm' as const, name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false },
  { id: 'petg', process: 'fdm' as const, name_en: 'PETG', name_ar: 'PETG', needs_enclosure: false, abrasive: false },
];
const noop = () => {};

// ------------------------------------------------------------------ the words

test('the words: every key in ar, en AND written Sorani — never the Arabic pasted across', () => {
  const { ar, en, ckb } = REQUEST_STRINGS;
  // Two plain Sorani words that happen to need none of the letters Arabic lacks.
  const SORANI_WITHOUT_KURDISH_LETTERS = new Set(['نرخ', 'ناردن']);
  const walk = (a: unknown, e: unknown, k: unknown, path: string) => {
    if (typeof a === 'string') {
      assert.equal(typeof e, 'string', `en${path} is missing`);
      assert.equal(typeof k, 'string', `ckb${path} is missing`);
      assert.ok(a.trim() && (e as string).trim() && (k as string).trim(), `${path} is empty somewhere`);
      if (ARABIC_SCRIPT.test(a)) {
        assert.notEqual(e, a, `en${path} is the Arabic`);
        assert.notEqual(k, a, `ckb${path} is the Arabic pasted across`);
        assert.ok(KURDISH.test(k as string) || SORANI_WITHOUT_KURDISH_LETTERS.has(k as string), `ckb${path} has no Sorani letter: «${k}»`);
      }
      return;
    }
    assert.deepEqual(Object.keys(e as object).sort(), Object.keys(a as object).sort(), `en${path}: the same keys`);
    assert.deepEqual(Object.keys(k as object).sort(), Object.keys(a as object).sort(), `ckb${path}: the same keys`);
    for (const key of Object.keys(a as object)) {
      walk((a as Record<string, unknown>)[key], (e as Record<string, unknown>)[key], (k as Record<string, unknown>)[key], `${path}.${key}`);
    }
  };
  walk(ar, en, ckb, '');
  assert.equal(requestStrings('ckb'), ckb);
  assert.equal(requestStrings('fr'), ar, 'an unknown language reads Arabic, the app default');
});

test('counted words, dates and states — the Arabic noun agrees with its number', () => {
  assert.deepEqual([1, 2, 3, 10, 11, 14, 99, 100, 103].map((n) => daysLabel(n, 'ar')), ['يوم واحد', 'يومان', '3 أيام', '10 أيام', '11 يومًا', '14 يومًا', '99 يومًا', '100 يوم', '103 أيام']);
  assert.equal(daysLabel(1, 'en'), '1 day');
  assert.equal(daysLabel(7, 'en'), '7 days');
  assert.equal(daysLabel(7, 'ckb'), '7 ڕۆژ', 'Sorani keeps the singular after a number');
  assert.deepEqual([1, 2, 5, 12].map((n) => jobsLabel(n, 'ar')), ['عمل منجز واحد', 'عملان منجزان', '5 أعمال منجزة', '12 عملًا منجزًا']);
  assert.equal(jobsLabel(41, 'en'), '41 jobs done');
  assert.match(jobsLabel(3, 'ckb'), KURDISH);
  assert.equal(shortDay(null, 'ar'), '');
  assert.equal(shortDay('not a date', 'en'), '');
  assert.match(shortDay('2026-10-03T12:00:00Z', 'en'), /3 Oct/);

  const s = requestStrings('ar');
  assert.deepEqual(offerStateWords({ state: 'accepted' }, s), { text: s.stateAccepted, tone: 'success' });
  assert.equal(offerStateWords({ state: 'superseded' }, s).text, s.stateAwaiting);
  assert.equal(offerStateWords({ state: 'pending', stale: true }, s).tone, 'warning');
  assert.equal(offerStateWords({ state: 'pending', expired: true }, s).text, s.stateExpired);
  assert.equal(offerStateWords({ state: 'rejected' }, s).text, s.stateNotChosen);
  assert.equal(offerStateWords({ state: 'withdrawn' }, s).text, s.stateWithdrawn);
  assert.equal(offerStateWords({ state: 'draft', draft: true }, s).text, s.stateDraft);
  assert.deepEqual(offerStateWords({ state: 'pending' }, s), { text: s.stateOpen, tone: 'info' });
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const t = requestStrings(lang);
    for (const st of ['pending', 'superseded', 'accepted', 'rejected', 'withdrawn', 'expired', 'draft']) {
      assert.doesNotMatch(offerStateWords({ state: st }, t).text, /^[a-z_]+$/, `${lang}: ${st} reads as words`);
    }
    assert.equal(orderStateWord('someday_new', t), t.orderStates.in_progress, 'an unknown order state never prints its code');
    for (const st of ['pending', 'held', 'released', 'refunded', 'partially_refunded', 'disputed', 'cancelled']) {
      assert.ok(escrowSentence(st, t).length > 8, `${lang}: the money line for ${st}`);
    }
  }
  assert.equal(escrowSentence('held', s), s.escrowHeld);
  assert.equal(escrowSentence(null, s), s.escrowPending);
  assert.equal(systemUpdateLabel('revised', { change: 'edit', revision: 3 }, s), 'عُدّل الطلب — النسخة 3');
  assert.equal(systemUpdateLabel('revised', {}, s), s.systemRevisedPlain, 'a revision without its number reads without it');
  assert.equal(systemUpdateLabel('accepted', {}, requestStrings('en')), 'The requester chose an offer');
  assert.equal(systemUpdateLabel('brand_new', {}, s), 'brand_new');
  assert.equal(fill('خلال {days}', { days: daysLabel(3, 'ar') }), 'خلال 3 أيام');
  const nodes = renderToStaticMarkup(createElement('p', null, ...fillNodes(s.was, { price: createElement('b', null, '50') })));
  assert.equal(nodes, '<p>كان <b>50</b></p>', 'an element keeps its place in the sentence');
});

test('a handover reads in the reader\'s words on a card, in the merchant\'s own voice in the composer', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = requestStrings(lang);
    assert.equal(handoverLabel('merchant_delivery', s), s.handoverMerchant);
    assert.equal(handoverLabel('pickup', s), s.handoverPickup);
    assert.equal(handoverLabel('courier', s), s.handoverCourier);
    assert.equal(composerHandover('merchant_delivery', s), s.deliverMyself);
    assert.equal(composerHandover('pickup', s), s.pickup);
    assert.notEqual(handoverLabel('merchant_delivery', s), composerHandover('merchant_delivery', s), `${lang}: a customer never reads «I deliver it»`);
  }
  assert.equal(handoverLabel('', requestStrings('ar')), '—');
  assert.equal(handoverLabel('بسيارتي', requestStrings('ar')), 'بسيارتي', 'a free-text method from before v2 is shown as written');
});

// ---------------------------------------------------------------- the address

test('the old ?request= address is REPLACED by /requests/<id>, carrying the rest of the query and the hash', () => {
  assert.equal(requestPath('req 1/x'), '/requests/req%201%2Fx');
  assert.equal(requestRedirect('req_1', new URLSearchParams('request=req_1&cost=1'), '#discussion'), '/requests/req_1?cost=1#discussion');
  assert.equal(requestRedirect('req_1', new URLSearchParams('request=req_1'), ''), '/requests/req_1');
  assert.equal(requestRedirect('req_1', new URLSearchParams('request=req_1'), '#'), '/requests/req_1');
  assert.equal(requestRedirect('req_1', new URLSearchParams('request=req_1'), '#timeline'), '/requests/req_1#timeline');

  const board = code('src/pages/Requests.tsx');
  assert.match(board, /const deepLinked = params\.get\('request'\) \?\? '';/);
  assert.match(board, /navigate\(requestRedirect\(deepLinked, params, location\.hash\), \{ replace: true \}\);/, 'replaced, so Back does not walk into a redirect');
  assert.match(board, /if \(deepLinked\) return null;/, 'nothing of the board flashes first');
  assert.match(board, /const openRequestId = useCallback\(\(id: string\) => navigate\(requestPath\(id\)\), \[navigate\]\);/, 'opening a request is a step forward to its page');
  assert.match(board, /navigate\(requestPath\(id\), how === 'published' \? \{ state: \{ published: true \} \} : undefined\);/, 'the channel window rides with a PUBLISHED request only');
  assert.match(board, /navigate\('\/requests\?view=mine', \{ replace: true \}\);/, 'Back from a new request lands on «طلباتي»');
  // The detail left this file; the one place it still shows is under the maintenance card, lazily.
  assert.doesNotMatch(board, /function RequestDetail\(/);
  assert.doesNotMatch(board, /function OnlookerCard\(/);
  assert.match(board, /const RequestDetail = lazy\(\(\) => import\('\.\/community\/Request'\)\.then\(\(m\) => \(\{ default: m\.RequestDetail \}\)\)\);/);
  assert.match(board, /<RequestDetail request=\{open\} me=\{null\} onBack=\{\(\) => setOpen\(null\)\} \/>/);
});

test('the route file: /requests/:id keyed on its id, a real back, the wizard in place, the timeline door lazy', () => {
  const route = code('src/pages/community/Request.tsx');
  assert.match(route, /const \{ id = '' \} = useParams\(\);/);
  assert.match(route, /const goBack = useGoBack\('\/requests'\);/, 'a visitor who arrived by a link goes up to the board, never out of the app');
  assert.match(route, /key=\{id\}/, 'another request never inherits this one\'s offers, files or answers');
  assert.match(route, /const RequestWizard = lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/requests\/RequestWizard'\)\);/);
  assert.match(route, /const OrderTimeline = lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/requests\/OrderTimeline'\)\);/, 'Client 5d\'s timeline, by the agreed path');
  // The channel window: latched from the router state, the state dropped at once, one instance outside the branch.
  assert.match(route, /useState\(\(\) => justPublished\(location\.state\)\)/);
  assert.match(route, /navigate\(\{ pathname: location\.pathname, search: location\.search, hash: location\.hash \}, \{ replace: true, state: null \}\);/);
  assert.match(route, /if \(how === 'published'\) setRequestJustCreated\(true\);/);
  assert.match(route, /<ChannelNudge context="request" active=\{requestJustCreated\} \/>/);
  assert.equal(route.match(/\{nudge\}/g)?.length, 1, 'rendered from exactly one place');
  assert.ok(route.indexOf('{nudge}') > route.indexOf('{editing ? ('), 'outside the wizard / detail conditional');
  // The old page's rules, kept.
  assert.match(route, /const canOffer = !!me\?\.store && !!me\?\.can\.offers && !isCustomer && open;/);
  assert.match(route, /<OnlookerCard me=\{me\} onNewRequest=\{onNewRequest\} \/>/);
  assert.match(route, /\{me\?\.store && !isCustomer && !isOwner && current\.state !== 'draft' && \(/, 'the workshop card only for a merchant with a store');
  assert.match(route, /\{open && formatDate\(current\.expires_at, lang\) && \(/);
  assert.match(route, /\/publish`, \{\}\);\s*forgetCommunityFeed\('requests'\);/);
  assert.equal(route.match(/\/cancel`\);\s*forgetCommunityFeed\('requests'\);/g)?.length, 2, 'closing a published request and discarding a draft');
  assert.match(route, /onConfirm=\{closePublished\}/);
  assert.match(route, /\.catch\(\(e: unknown\) => setOffersError\(e\)\)/, 'offers that did not load are not «no offers»');
});

test('the landmarks come in the owner\'s order', () => {
  assert.deepEqual([...REQUEST_SECTIONS], ['header', 'status', 'files', 'details', 'discussion', 'offers', 'compare', 'chat', 'accepted', 'timeline', 'escrow', 'delivery', 'review']);
  // In the page's source every section is drawn in that order; `compare`
  // is the offers' own table (OfferCompare), drawn inside the offers.
  const route = code('src/pages/community/Request.tsx');
  const drawn = [...route.matchAll(/data-request-section="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(drawn, REQUEST_SECTIONS.filter((x) => x !== 'compare'));
  assert.match(code('src/components/community/requests/OfferCompare.tsx'), /data-request-section="compare"/);
  assert.deepEqual(REQUEST_STEPS, ['published', 'offers', 'chosen', 'in_progress', 'delivered', 'completed']);
  assert.equal(requestStepIndex('receiving_offers'), 1);
  assert.equal(requestStepIndex('in_progress'), 3);
  for (const off of ['draft', 'cancelled', 'expired', 'disputed']) assert.equal(requestStepIndex(off), -1, `${off} is said in a sentence, not on the line`);
  assert.equal(requestStateTone('disputed'), 'danger');
  assert.equal(requestStateTone('receiving_offers'), 'success');
  assert.equal(requestTakesOffers('open'), true);
  assert.equal(requestTakesOffers('in_progress'), false);
  const t = { timeline: [{ kind: 'created', at: day(-2), actor: 'customer' as const }, { kind: 'photo', at: day(-0.1), actor: 'merchant' as const }, { kind: 'funded', at: day(-1), actor: 'system' as const }] };
  assert.equal(latestEvent(t)?.kind, 'photo', '«آخر تحديث» is the newest moment, whatever order the list came in');
  assert.equal(latestEvent(null), null);
});

// ------------------------------------------------------------------ the offers

test('the customer\'s offers: every card shows its TOTAL; a revised offer says so; only a live one can be accepted', () => {
  const revised = offer({
    id: 'off_1',
    revision: 2,
    revised: true,
    history: [
      { revision: 1, request_revision: 1, price_iqd: 21000, completion_days: 3, delivery_method: 'merchant_delivery', reason: 'create', created_at: day(-2) },
      { revision: 2, request_revision: 1, price_iqd: 18000, completion_days: 3, delivery_method: 'merchant_delivery', reason: 'edit', created_at: day(-1) },
    ],
    files: [{ id: 'ofl_1', kind: 'pdf', name: 'fit-check.pdf', bytes: 9000, content_type: 'application/pdf', url: '/api/marketplace/offers/off_1/files/ofl_1' }],
  });
  const free = offer({ id: 'off_2', merchant_id: 'm2', price_iqd: 24500, delivery_fee_iqd: 0, total_iqd: 24500, completion_days: 2, delivery_method: 'courier', merchant: merchant('m2', 'Omar Print Lab', 4.5) });
  const stale = offer({ id: 'off_3', merchant_id: 'm3', price_iqd: 15000, delivery_fee_iqd: 0, total_iqd: 15000, state: 'superseded', stale: true, merchant: merchant('m3', 'Basra Makers', null) });
  const h = html(createElement(OfferCompare, { requestId: 'req_1', offers: [stale, free, revised], takingOffers: true, materials, onChanged: noop }));
  assert.deepEqual(attrs(h, 'data-offer-total'), ['20000', '24500', '15000'], 'the total leads each card, cheapest live first; the stale one last');
  const s = requestStrings('ar');
  const t = text(h);
  assert.ok(t.includes(s.revised), '«عرض معدّل»');
  assert.equal(count(h, /data-offer-was/g), 1, 'the price it replaced');
  assert.ok(t.includes('21,000') || t.includes('٢١٬٠٠٠'), 'the old price is on the card');
  assert.equal(count(h, /data-offer-history="off_1"/g), 1, 'the history opens from the card');
  assert.deepEqual(attrs(h, 'data-offer-accept'), ['off_1', 'off_2'], 'only a live offer can be accepted');
  assert.equal(count(h, /data-offer-note="stale"/g), 1, 'the stale one says why');
  assert.ok(t.includes(s.feeShort) && t.includes(s.noFee), 'the fee is named where there is one, «بلا رسوم» where there is none');
  assert.equal(count(h, /data-request-section="compare"/g), 1, 'the quick comparison, two offers being live');
  assert.ok(t.includes(daysLabel(2, 'ar')), '«يومان», not «2 يوم»');
  assert.equal(attrs(h, 'href').filter((x) => x.includes('/offers/off_1/files/ofl_1')).length, 1, 'the file is a URL on the Worker');
  assert.doesNotMatch(h, /merchants\/[^"]*\/offers\//, 'never a key');
  // A request that no longer takes offers: nothing to accept or decline.
  const closed = html(createElement(OfferCompare, { requestId: 'req_1', offers: [revised, free], takingOffers: false, materials, onChanged: noop }));
  assert.equal(count(closed, /data-offer-accept=/g), 0);
  assert.equal(count(closed, /data-offer-decline=/g), 0);
  // English reads the same card.
  const en = text(html(createElement(OfferCompare, { requestId: 'req_1', offers: [revised], takingOffers: true, materials, onChanged: noop }), 'en'));
  assert.ok(en.includes('Revised offer') && en.includes('The merchant delivers') && en.includes('3 days'));
});

test('accepting sends the TOTAL and the version on screen — never a price', () => {
  assert.deepEqual(acceptBody(offer({ total_iqd: 20000, revision: 2 }), 'a1'), { expected_total_iqd: 20000, offer_revision: 2, address_id: 'a1' });
  assert.deepEqual(acceptBody(offer({ total_iqd: 15000, revision: 1, delivery_method: 'pickup' }), 'a1'), { expected_total_iqd: 15000, offer_revision: 1 }, 'a pickup names no address');
  assert.deepEqual(acceptBody(offer({ total_iqd: 20000, revision: 1 }), ''), { expected_total_iqd: 20000, offer_revision: 1 });
  const src = code('src/components/community/requests/OfferCompare.tsx');
  assert.match(src, /await offersV2Api\.acceptOffer\(o\.id, acceptBody\(o, addressId\)\);/);
  assert.match(src, /if \(code === 'OFFER_CHANGED' \|\| code === 'OFFER_STALE'\)/);
  assert.match(src, /setNotice\(\{ code, text: apiRefusal\(e, L, s\.couldNotAccept\) \}\);/, 'the refusal\'s own sentence');
  assert.match(src, /data-accept-refresh/, '«حدّث»');
  assert.match(src, /setShown\(\{ \.\.\.o, \.\.\.fresh, merchant: o\.merchant, files: o\.files, history: o\.history \}\);/, 'OFFER_CHANGED swaps in the fresh terms');
  for (const f of ['OfferCompare', 'OfferComposer', 'Discussion']) {
    assert.doesNotMatch(code(`src/components/community/requests/${f}.tsx`), /expected_price_iqd/, `${f}: the fee-less legacy field is gone from V2`);
  }
  assert.equal(offerIsLive(offer()), true);
  assert.equal(offerIsLive(offer({ workshop_unable: true })), false);
  assert.equal(offerIsLive(offer({ expired: true })), false);
  const a = offer({ id: 'a', total_iqd: 30000, completion_days: 1, merchant: merchant('m1', 'A', 3.9) });
  const b = offer({ id: 'b', total_iqd: 12000, completion_days: 9, merchant: merchant('m2', 'B', 4.9) });
  const c = offer({ id: 'c', total_iqd: 1000, state: 'superseded', stale: true });
  const best = bestOffers([a, b, c]);
  assert.equal(best.cheapest?.id, 'b', 'the cheapest LIVE total, not the stale one');
  assert.equal(best.fastest?.id, 'a');
  assert.equal(best.topRated?.id, 'b');
  assert.deepEqual(sortOffers([c, a, b], 'price').map((o) => o.id), ['b', 'a', 'c']);
  assert.deepEqual(sortOffers([c, a, b, offer({ id: 'win', state: 'accepted' })], 'time').map((o) => o.id), ['win', 'a', 'b', 'c']);
});

test('the workshop: «قدّم عرضًا», its draft card with «أرسل العرض» / «أكمل المسودة», its offer with the total', () => {
  const s = requestStrings('ar');
  const none = html(createElement(MerchantOfferSection, { requestId: 'req_1', offers: [], draft: null, canOffer: true, takingOffers: true, materials, onChanged: noop }));
  assert.equal(count(none, /data-offer-make/g), 1);
  assert.equal(count(none, /data-offer-accept/g), 0, 'a workshop never sees an accept button');
  const cannot = text(html(createElement(MerchantOfferSection, { requestId: 'req_1', offers: [], draft: null, canOffer: false, takingOffers: true, materials, onChanged: noop })));
  assert.ok(cannot.includes(s.cannotOfferNow));

  const draft = offer({ id: 'ofd_1', state: 'draft', draft: true, revision: 0, price_iqd: 19000, delivery_fee_iqd: 1500, total_iqd: 20500, merchant: null });
  const d = html(createElement(MerchantOfferSection, { requestId: 'req_1', offers: [], draft, canOffer: true, takingOffers: true, materials, onChanged: noop }));
  assert.equal(attrs(d, 'data-merchant-offer')[0], 'draft');
  assert.equal(count(d, /data-offer-draft-send/g), 1, '«أرسل العرض» on the card');
  assert.equal(count(d, /data-offer-draft-continue/g), 1, '«أكمل المسودة»');
  assert.equal(attrs(d, 'data-offer-total')[0], '20500', 'the draft shows its total');
  assert.ok(text(d).includes(s.draftHint), 'it says the customer cannot see it');

  const live = html(createElement(MerchantOfferSection, { requestId: 'req_1', offers: [offer({ revision: 2 })], draft: null, canOffer: true, takingOffers: true, materials, onChanged: noop }));
  assert.equal(attrs(live, 'data-offer-total')[0], '20000');
  assert.equal(count(live, /data-offer-edit=/g), 1);
  assert.equal(count(live, /data-offer-withdraw=/g), 1);
  assert.ok(text(live).includes(fill(s.yourOfferVersion, { n: 2 })));
  const stale = html(createElement(MerchantOfferSection, { requestId: 'req_1', offers: [offer({ state: 'superseded', stale: true })], draft: null, canOffer: true, takingOffers: true, materials, onChanged: noop }));
  assert.equal(count(stale, /data-offer-reconfirm=/g), 1, 're-confirm as is');
  assert.equal(count(stale, /data-offer-note="superseded"/g), 1);
  const won = text(html(createElement(MerchantOfferSection, { requestId: 'req_1', offers: [offer({ state: 'accepted' })], draft: null, canOffer: true, takingOffers: false, materials, onChanged: noop })));
  assert.ok(won.includes(s.acceptedByCustomer));
});

test('the composer: «احفظ مسودة» and «أرسل العرض», the total previewed; an edit of a sent offer is a new version only', () => {
  const s = requestStrings('ar');
  const fresh = html(createElement(OfferComposer, { open: true, requestId: 'req_1', offer: null, materials, defaultQuantity: 2, deliveryPref: 'pickup', onClose: noop, onSaved: noop }));
  assert.equal(attrs(fresh, 'data-offer-composer')[0], 'new');
  assert.equal(count(fresh, /data-offer-save-draft/g), 1);
  assert.equal(count(fresh, /data-offer-send/g), 1);
  assert.ok(text(fresh).includes(s.saveDraft) && text(fresh).includes(s.sendOffer));
  assert.equal(attrs(fresh, 'data-offer-total-preview')[0], '', 'nothing priced yet — «—», not «0»');
  assert.equal(count(fresh, /data-offer-fee/g), 0, 'a pickup request starts on pickup: no delivery fee to ask');
  // The composer speaks in the merchant's own voice.
  assert.ok(text(fresh).includes(s.deliverMyself));

  const draft = offer({ id: 'ofd_1', state: 'draft', draft: true, revision: 0, price_iqd: 19000, delivery_fee_iqd: 1500, total_iqd: 20500, valid_days: 14, files: [{ id: null, kind: 'image', name: 'a.png', bytes: 2048, content_type: 'image/png', url: null, key: 'merchants/u1/offers/x.png' }], merchant: null });
  const d = html(createElement(OfferComposer, { open: true, requestId: 'req_1', offer: draft, materials, onClose: noop, onSaved: noop }));
  assert.equal(attrs(d, 'data-offer-composer')[0], 'draft');
  assert.equal(attrs(d, 'data-offer-total-preview')[0], '20500', 'price + fee');
  assert.equal(count(d, /data-offer-save-draft/g), 1);
  assert.equal(count(d, /data-offer-file="image"/g), 1, 'the draft\'s file comes back with its key, to be kept');

  const edit = html(createElement(OfferComposer, { open: true, requestId: 'req_1', offer: offer({ revision: 2 }), materials, onClose: noop, onSaved: noop }));
  assert.equal(attrs(edit, 'data-offer-composer')[0], 'edit');
  assert.equal(count(edit, /data-offer-save-draft/g), 0, 'a sent offer is not saved back into a draft');
  assert.ok(text(edit).includes(s.saveNewVersion) && text(edit).includes(s.editHint));
  assert.equal(html(createElement(OfferComposer, { open: false, requestId: 'req_1', offer: null, materials, onClose: noop, onSaved: noop })), '');
});

test('the composer\'s body: draft only for the draft, the validity only when it is the merchant\'s choice, the fee never on a pickup', () => {
  assert.equal(offerFileKind('part.STL', ''), 'model');
  assert.equal(offerFileKind('photo.webp', 'image/webp'), 'image');
  assert.equal(offerFileKind('spec.pdf', 'application/pdf'), 'pdf');
  assert.equal(offerFileKind('notes.docx', 'application/msword'), null, 'the worker refuses anything else — so does the picker');
  assert.equal(previewTotal(18000, 2000, 'merchant_delivery'), 20000);
  assert.equal(previewTotal(18000, 2000, 'pickup'), 18000, 'no fee on a pickup');
  assert.equal(previewTotal(null, null, 'courier'), 0);
  assert.equal(defaultHandover('pickup'), 'pickup');
  assert.equal(defaultHandover('delivery'), 'merchant_delivery');
  assert.deepEqual([...VALIDITY], [3, 7, 14, 30]);

  const t = termsFrom(null, null, { quantity: 2, delivery: 'merchant_delivery' });
  assert.equal(t.quantity, 2, 'the request\'s own quantity is the default');
  assert.equal(t.valid, 7);
  const priced = { ...t, price: 18000, days: 3, fee: 2000 };
  const asDraft = offerBody(priced, { draft: true, editingSent: false, validTouched: false, quoteId: 'q1' });
  assert.equal(asDraft.draft, true);
  assert.equal(asDraft.valid_days, 7);
  assert.equal(asDraft.quote_id, 'q1');
  const sent = offerBody(priced, { draft: false, editingSent: false, validTouched: false });
  assert.equal('draft' in sent, false, '«أرسل العرض» carries no draft flag');
  assert.deepEqual([sent.price_iqd, sent.delivery_fee_iqd, sent.completion_days, sent.quantity], [18000, 2000, 3, 2]);
  const edit = offerBody(priced, { draft: false, editingSent: true, validTouched: false, quoteId: 'q1' });
  assert.equal('valid_days' in edit, false, 'an edit leaves the stored validity alone unless the merchant moved it');
  assert.equal('quote_id' in edit, false);
  assert.equal(offerBody(priced, { draft: false, editingSent: true, validTouched: true }).valid_days, 7);
  const pickup = offerBody({ ...priced, delivery: 'pickup' }, { draft: false, editingSent: false, validTouched: false });
  assert.equal(pickup.delivery_fee_iqd, 0);
  const empty = offerBody(t, { draft: true, editingSent: false, validTouched: false });
  assert.equal('price_iqd' in empty, false, 'a draft may be saved without a price');
  // A sent offer's file without a key (another uploader's) cannot be kept on an edit.
  const kept = termsFrom(offer({ files: [{ id: 'f1', kind: 'pdf', name: 'x.pdf', bytes: 1, content_type: 'application/pdf', url: '/u' }] }), null, {});
  assert.deepEqual(kept.files, []);
  const src = code('src/components/community/requests/OfferComposer.tsx');
  assert.match(src, /purpose="offer"/, 'the offer\'s files go up as purpose `offer`');
  assert.match(src, /entityId=\{requestId\}/);
  assert.match(src, /OFFER_FILES_MAX = 6/);
});

// -------------------------------------------------------------- the discussion

const person = (id: string, name: string, role: 'customer' | 'merchant' | 'member') => ({ id, name, username: null, role });
function row(over: Partial<RequestComment> & Pick<RequestComment, 'id' | 'kind'>): RequestComment {
  return {
    request_id: 'req_1',
    parent_id: null,
    body: 'نص',
    state: 'visible',
    created_at: new Date(Date.parse('2026-09-29T10:00:00Z') + Number(over.id.replace(/\D/g, '') || 0) * 60_000).toISOString(),
    author: person('u_x', 'Ahmed', 'member'),
    system: null,
    viewer: { mine: false, can_remove: false },
    ...over,
  };
}
const thread: RequestComment[] = [
  row({ id: 'c1', kind: 'public_comment', body: 'هل يناسب هاتفًا بغطاء سميك؟' }),
  row({ id: 'c2', kind: 'public_comment', parent_id: 'c1', author: person('u_sara', 'Sara', 'customer'), body: 'غطاء رفيع فقط.' }),
  row({ id: 's3', kind: 'system_update', author: null, body: '', system: { code: 'revised', meta: { revision: 2 } } }),
  row({ id: 'q4', kind: 'merchant_question', author: person('u_ali', 'Ali 3D', 'merchant'), body: 'فتحة الشاحن للأسفل؟' }),
  row({ id: 'a5', kind: 'customer_answer', parent_id: 'q4', author: person('u_sara', 'Sara', 'customer'), body: 'نعم.' }),
  row({ id: 'q6', kind: 'merchant_question', author: person('u_omar', 'Omar', 'merchant'), body: 'بلون أسود مطفي؟' }),
];
const pageOf = (can: CommentsPage['can']): CommentsPage => ({ comments: thread, next_cursor: null, total: 5, can });

test('the discussion by role: the customer answers, the workshop asks, a guest signs in', () => {
  const s = requestStrings('ar');
  // The customer, the request on the board.
  const customer = html(createElement(Discussion, { requestId: 'req_1', open: true, initial: pageOf({ comment: true, ask: false, answer: true }) }));
  assert.deepEqual(attrs(customer, 'data-comment-kind'), ['public_comment', 'public_comment', 'system_update', 'merchant_question', 'customer_answer', 'merchant_question']);
  assert.deepEqual(attrs(customer, 'data-comment-answer'), ['q6'], '«أجب» only on the question nobody answered');
  assert.equal(count(customer, /data-discussion-pick=/g), 0, 'the customer is never offered «سؤال للعميل»');
  assert.deepEqual(attrs(customer, 'data-comment-reply'), ['c1'], 'a reply to a comment, one level');
  assert.ok(text(customer).includes('عُدّل الطلب — النسخة 2'), 'the server\'s row, worded inline');
  assert.ok(text(customer).includes(s.answerLabel) && text(customer).includes(s.roleCustomer) && text(customer).includes(s.roleMerchant));
  assert.equal(attrs(customer, 'data-discussion-kind')[0], 'public_comment');

  // A workshop that may ask: the picker with both kinds, no «أجب».
  const workshop = html(createElement(Discussion, { requestId: 'req_1', open: true, initial: pageOf({ comment: true, ask: true, answer: false }) }));
  assert.deepEqual(attrs(workshop, 'data-discussion-pick'), ['public_comment', 'merchant_question']);
  assert.equal(count(workshop, /data-comment-answer=/g), 0);
  // The store a direct request was sent to may only ask: it starts on the question.
  const direct = html(createElement(Discussion, { requestId: 'req_1', open: false, initial: pageOf({ comment: false, ask: true, answer: false }) }));
  assert.equal(attrs(direct, 'data-discussion-kind')[0], 'merchant_question');

  // A guest: the thread, and the sign-in line instead of a composer.
  const guest = html(createElement(Discussion, { requestId: 'req_1', open: true, initial: pageOf({ comment: false, ask: false, answer: false }) }), 'ar', false);
  assert.equal(count(guest, /data-discussion-signin/g), 1);
  assert.equal(count(guest, /data-discussion-composer/g), 0);
  assert.equal(count(guest, /data-comment-menu=/g), 0, 'nothing to report or remove for a guest');

  // A closed request: read-only, and it says so.
  const closed = html(createElement(Discussion, { requestId: 'req_1', open: false, initial: pageOf({ comment: false, ask: false, answer: false }) }));
  assert.equal(count(closed, /data-discussion-closed/g), 1);
  assert.equal(count(closed, /data-discussion-composer/g), 0);
  // Sorani and English draw the same thread in their own words.
  assert.ok(text(html(createElement(Discussion, { requestId: 'req_1', open: true, initial: pageOf({ comment: true, ask: true, answer: false }) }), 'ckb')).includes(requestStrings('ckb').kindQuestion));
  assert.ok(text(html(createElement(Discussion, { requestId: 'req_1', open: true, initial: pageOf({ comment: true, ask: false, answer: true }) }), 'en')).includes('The request was edited — version 2'));
});

test('the discussion\'s pieces: kinds from `can`, one level of threads, oldest first', () => {
  assert.deepEqual(startKinds({ comment: true, ask: true, answer: true }), ['public_comment', 'merchant_question']);
  assert.deepEqual(startKinds({ comment: false, ask: false, answer: true }), [], 'the customer answers from a question, never from the picker');
  const threads = threadsOf(thread);
  assert.deepEqual(threads.map((t) => t.row.id), ['c1', 's3', 'q4', 'q6']);
  assert.deepEqual(threads.find((t) => t.row.id === 'q4')?.replies.map((r) => r.id), ['a5']);
  assert.equal(awaitsAnswer(thread[3], [thread[4]]), false);
  assert.equal(awaitsAnswer(thread[5], []), true);
  assert.equal(awaitsAnswer(thread[0], []), false, 'a comment is not a question');
  assert.deepEqual(sortThread([thread[3], thread[0]]).map((r) => r.id), ['c1', 'q4']);
  assert.equal(roleWord('member', requestStrings('ar')), '');
  assert.equal(COMMENT_MAX, 1000);
  const src = code('src/components/community/requests/Discussion.tsx');
  assert.match(src, /await discussionApi\.postComment\(requestId, payload\);/);
  assert.match(src, /kind: target\.kind, body, \.\.\.\(target\.parent \? \{ parent_id: target\.parent\.id \} : \{\}\)/);
  assert.match(src, /apiRefusal\(e, L, s\.actionFailed\)/, 'COMMENT_INDECENT, BLOCKED and the rest in the reader\'s words');
  assert.match(src, /onPaste=\{warmLinksOnPaste\}/, 'a pasted link warms its card');
  assert.match(src, /<LinkRow text=\{c\.body\} variant="compact"/, 'the first link of a row, as a card');
  assert.match(src, /discussionApi\.reportComment\(requestId, comment\.id, \{ reason \}\)/);
  assert.match(src, /e\.code === 'COMMUNITY_CLOSED'\) onUnavailableRef\.current\?\.\(\)/, 'under the maintenance card the section folds away');
});

// ------------------------------------------------------------------- the pins

test('tokens only: no hex, no dark:, no physical sides, no legacy greys in the new files', () => {
  for (const f of [
    'src/pages/community/Request.tsx',
    'src/components/community/requests/OfferCompare.tsx',
    'src/components/community/requests/OfferComposer.tsx',
    'src/components/community/requests/Discussion.tsx',
  ]) {
    const src = code(f);
    const classes = [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]).join(' ');
    assert.doesNotMatch(classes, /#[0-9a-fA-F]{3,8}\b/, `${f}: a hex colour`);
    assert.doesNotMatch(classes, /(^|\s)dark:/, `${f}: a dark: variant`);
    assert.doesNotMatch(classes, /(^|\s)-?(ml|mr|pl|pr|left|right)-[\w[]/, `${f}: a physical side — use ms/me/ps/pe/start/end`);
    assert.doesNotMatch(classes, /\b(text|bg|border)-(zinc|gray|white|black)\b/, `${f}: a legacy grey — theme tokens only`);
    assert.doesNotMatch(src, /style=\{\{[^}]*#[0-9a-fA-F]{3,8}/, `${f}: a hex in a style`);
  }
  // No key on the page: the customer reads files through the Worker's routes.
  const route = code('src/pages/community/Request.tsx');
  assert.doesNotMatch(route, /file_key|\.key\b/, 'the page never reads a file key');
  // The timeline line is worded by the timeline's own table (Client 5d).
  assert.match(route, /const t = useTimelineStrings\(\);/);
  assert.match(route, /words\[last\.kind\] \?\? t\.event\.other/);
  // The chat door is the one door: POST /api/chats/open { requestId, merchantId }.
  assert.match(route, /offersApi\.openThread\(current\.id, merchantId\)/);
});
