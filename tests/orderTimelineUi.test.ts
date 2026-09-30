/**
 * THE ORDER TIMELINE ON THE SCREEN (docs/COMMUNITY_ECOSYSTEM.md §9.5, Client
 * 5d) — src/components/community/requests/OrderTimeline.tsx, the merchant's
 * CustomOrderScreen and the customer's timeline sheet.
 *
 *   the words: every key in ar, en AND real Sorani, never the Arabic pasted
 *   across (./timelineStrings.ts and the custom order's table);
 *   the render (`renderToStaticMarkup`, the technique of
 *   tests/ordersListUi.test.ts): the spine draws every kind the server sends
 *   with its own sentence, the actor as a role («أنت» for the reader's side),
 *   the «جاهز» mark; the workshop gets the composer (text, photo, «جاهز»),
 *   the customer «اطلب تعديلًا» — and never after delivery, whatever a stale
 *   hint says; cancel / dispute follow the policy handed in; a photo is the
 *   authorised file route — no key in any href or src;
 *   the pins: the list lazy-loads the screen, the screen hands its policy to
 *   the timeline, the customer's row opens it in a Sheet v2 with detents,
 *   polling stops on a finished order, the photo goes through UploadTile with
 *   purpose `order_update`.
 *
 * Run: node --import tsx --test tests/orderTimelineUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { OrderTimeline as TimelineData, OrderTimelineEvent } from '../src/components/community/requests/api';

// The app's confirm dialog portals into `document.body` even while closed —
// nothing the server renderer can draw — so its module is answered here with
// a stand-in that renders nothing; that the component ASKS through it is
// pinned in the source below.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
         if (/\\/ui\\/ConfirmDialog(\\.tsx)?$/.test(specifier)) {
           return { url: 'data:text/javascript,' + encodeURIComponent('export function useConfirm(){ return [async () => false, null]; } export function ConfirmDialog(){ return null; }'), shortCircuit: true };
         }
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
const timeline = await import('../src/components/community/requests/OrderTimeline');
const { TimelineBody, TimelineSpine, OrderActions, TIMELINE_KINDS, BEFORE_DELIVERY, TERMINAL_STATES, actorWord, canAskChange, eventSentence } = timeline;
const { TIMELINE_STRINGS, timelineStrings, soraniAgo } = await import('../src/components/community/requests/timelineStrings');
const requestStrings = await import('../src/components/community/requests/strings');
const { CUSTOM_ORDER_STRINGS, deliveredConsequence, releaseAfter } = await import('../src/components/merchant/orders/strings');
const { readCustomOrder, stateWord, workPrice } = await import('../src/components/merchant/orders/CustomOrderScreen');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const attrs = (h: string, name: string) => [...h.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const FILE = (uid: string) => `/api/marketplace/orders/cord_1/updates/${uid}/file`;

/** One event of every kind the server's merged timeline sends, in its order. */
const EVERY: OrderTimelineEvent[] = [
  { kind: 'created', at: ago(900), actor: 'customer' },
  { kind: 'funded', at: ago(899), actor: 'customer' },
  { kind: 'started', at: ago(800), actor: 'merchant', id: 'u_s' },
  { kind: 'progress', at: ago(700), actor: 'merchant', id: 'u_p', body: 'انتهت الطبقات الأولى' },
  { kind: 'photo', at: ago(650), actor: 'merchant', id: 'u_ph', body: 'هكذا تبدو الآن', file: { url: FILE('u_ph'), inline: true } },
  { kind: 'note', at: ago(600), actor: 'merchant', id: 'u_n', body: 'سأستخدم PETG' },
  { kind: 'modification_request', at: ago(550), actor: 'customer', id: 'u_m', body: 'اجعل اللون أغمق' },
  { kind: 'ready', at: ago(500), actor: 'merchant', id: 'u_r' },
  { kind: 'delivered', at: ago(400), actor: 'merchant', id: 'u_d' },
  { kind: 'confirmed', at: ago(300), actor: 'customer' },
  { kind: 'released', at: ago(299), actor: 'system', amount_iqd: 45_000 },
  { kind: 'completed', at: ago(298), actor: 'customer' },
  { kind: 'dispute', at: ago(200), actor: 'customer' },
  { kind: 'dispute_resolved', at: ago(150), actor: 'admin' },
  { kind: 'refunded', at: ago(100), actor: 'admin', amount_iqd: 45_000 },
  { kind: 'cancelled', at: ago(90), actor: 'customer' },
];

function data(over: Partial<TimelineData> & { state?: string; ready_at?: string | null } = {}): TimelineData {
  const { state = 'in_progress', ready_at = null, ...rest } = over;
  return {
    role: 'merchant',
    order: {
      id: 'cord_1',
      request_id: 'creq_1',
      request_title: 'حامل شاشة',
      state,
      price_iqd: 50_000,
      completion_days: 5,
      delivery_method: 'courier',
      created_at: ago(900),
      started_at: ago(800),
      ready_at,
      delivered_at: null,
      confirmed_at: null,
      completed_at: null,
      cancelled_at: null,
      auto_complete_at: null,
      chat_id: 'chat_1',
    },
    timeline: EVERY.slice(0, 8),
    can: { update: true, ready: true, modification_request: false },
    ...rest,
  };
}

// ------------------------------------------------------------------ words

test('every timeline word exists in ar, en and ckb; the Sorani is Sorani, never the Arabic pasted across', () => {
  const flat = (o: Record<string, unknown>, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${prefix}${k}.`));
      else out[`${prefix}${k}`] = String(v);
    }
    return out;
  };
  for (const [name, table] of [
    ['timeline', TIMELINE_STRINGS],
    ['custom order', CUSTOM_ORDER_STRINGS],
  ] as const) {
    const ar = flat(table.ar as unknown as Record<string, unknown>);
    const en = flat(table.en as unknown as Record<string, unknown>);
    const ckb = flat(table.ckb as unknown as Record<string, unknown>);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort(), `${name}: en carries every key`);
    assert.deepEqual(Object.keys(ckb).sort(), Object.keys(ar).sort(), `${name}: ckb carries every key`);
    for (const k of Object.keys(ar)) {
      assert.ok(ar[k].trim() && en[k].trim() && ckb[k].trim(), `${name}.${k} is empty somewhere`);
      assert.notEqual(en[k], ar[k], `${name}: en.${k} is the Arabic`);
      assert.notEqual(ckb[k], ar[k], `${name}: ckb.${k} is the Arabic pasted across`);
      assert.match(ckb[k], KURDISH, `${name}: ckb.${k} has no Sorani letter`);
    }
  }
  // Every kind the spine knows has its own sentence in every language.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = timelineStrings(lang);
    for (const kind of TIMELINE_KINDS) assert.notEqual(eventSentence(kind, s), s.event.other, `${lang}: ${kind} has no sentence`);
    assert.equal(eventSentence('something_new', s), s.event.other, 'an unknown kind reads «حدث على الطلب», never its code');
  }
  // The request page reads the same table through its own door.
  assert.equal(requestStrings.TIMELINE_STRINGS, TIMELINE_STRINGS);
});

// ------------------------------------------------------------------ the spine

test('the spine draws every kind the server sends, the actor as a role, and the «جاهز» mark', () => {
  const h = html(createElement(TimelineSpine, { events: EVERY, role: 'merchant' }));
  assert.deepEqual(attrs(h, 'data-timeline-kind'), EVERY.map((e) => e.kind), 'one row per event, in the server\'s order');
  const t = text(h);
  const s = timelineStrings('ar');
  for (const e of EVERY) assert.ok(t.includes(eventSentence(e.kind, s)), `«${eventSentence(e.kind, s)}» for ${e.kind}`);
  // The merchant reads its own rows as «أنت»; the customer's as «الزبون»; Levonis's as its name.
  assert.ok(t.includes(s.you) && t.includes(s.actor.customer) && t.includes(s.actor.admin));
  assert.equal(actorWord('merchant', 'merchant', s), 'أنت');
  assert.equal(actorWord('merchant', 'customer', s), 'الورشة');
  assert.equal(actorWord('system', 'customer', s), 'تلقائيًا');
  assert.equal((h.match(/data-timeline-ready="true"/g) ?? []).length, 1, 'the «جاهز» mark sits on the ready row only');
  assert.ok(t.includes('انتهت الطبقات الأولى') && t.includes('اجعل اللون أغمق'), 'the parties\' own words are drawn');
  assert.match(t, /45,000|٤٥٬٠٠٠|45٬000/, 'a release carries its amount');
  // Sorani and English: the same rows in the reader's words.
  const en = text(html(createElement(TimelineSpine, { events: EVERY, role: 'customer' }), 'en'));
  assert.ok(en.includes('Work started') && en.includes('The workshop') && en.includes('You'));
  const ckb = text(html(createElement(TimelineSpine, { events: EVERY, role: 'customer' }), 'ckb'));
  assert.ok(ckb.includes('کارەکە دەستی پێکرد') && ckb.includes('وۆرکشۆپەکە') && ckb.includes('تۆ'));
  // …and says WHEN in Sorani too — Intl has no Sorani relative time, so the timeline writes its own.
  assert.ok(ckb.includes('پێش 15 کاتژمێر') && ckb.includes('پێش 11 کاتژمێر'), 'Sorani hours on the spine (the created row is 15 hours old, the progress row 11)');
  assert.doesNotMatch(ckb, /قبل|ساعة|أمس/, 'no Arabic time words for a Sorani reader');
  const at = Date.parse('2026-09-30T12:00:00.000Z');
  const back = (min: number) => new Date(at - min * 60_000).toISOString();
  assert.deepEqual([0, 5, 90, 60 * 30, 60 * 24 * 3, 60 * 24 * 45, 60 * 24 * 400].map((m) => soraniAgo(back(m), at)), ['ئێستا', 'پێش 5 خولەک', 'پێش 1 کاتژمێر', 'دوێنێ', 'پێش 3 ڕۆژ', 'پێش 1 مانگ', 'پێش 1 ساڵ']);
  assert.equal(soraniAgo(new Date(at + 30_000).toISOString(), at), 'ئێستا', 'a clock ahead of the server is «now», never «پێش -1»');
  assert.equal(soraniAgo('not a date', at), '');
  assert.ok(text(html(createElement(TimelineSpine, { events: [], role: 'customer' }))).includes(s.empty));
});

test('a photo is the authorised file route: no key in any href or src, a new tab without an opener', () => {
  const h = html(createElement(TimelineBody, { data: data({ timeline: EVERY }), policy: null, onChanged: () => {} }));
  const links = [...attrs(h, 'href'), ...attrs(h, 'src')];
  assert.ok(links.length >= 2, 'the photo is linked and drawn');
  for (const l of links) {
    assert.match(l, /^\/api\/marketplace\/orders\/cord_1\/updates\/[A-Za-z0-9_]+\/file$/, l);
    assert.doesNotMatch(l, /community-orders\/|\/files\/|merchants\//, `a storage key in ${l}`);
  }
  assert.doesNotMatch(h, /community-orders\//, 'no key anywhere in the markup');
  assert.ok(h.includes('rel="noopener noreferrer"'));
});

// ------------------------------------------------------------ who writes what

test('the workshop gets the composer — text, photo, «جاهز» — and no change request', () => {
  const h = html(createElement(TimelineBody, { data: data(), policy: null, onChanged: () => {} }));
  assert.match(h, /data-timeline-composer/);
  assert.match(h, /data-timeline-text/);
  assert.match(h, /data-timeline-photo="true"/);
  assert.match(h, /accept="image\/\*"/, 'a photo is a picture');
  assert.match(h, /data-timeline-ready-button/, '«جاهز» while in progress and not yet ready');
  assert.doesNotMatch(h, /data-timeline-ask-change/);
  assert.deepEqual(attrs(h, 'data-update-kind').sort(), ['note', 'progress']);
  // Ready once: the server's `can.ready` is false after it, and the button goes.
  const readied = html(createElement(TimelineBody, { data: data({ ready_at: ago(5), can: { update: true, ready: false, modification_request: false } }), policy: null, onChanged: () => {} }));
  assert.doesNotMatch(readied, /data-timeline-ready-button/);
  assert.match(readied, /data-order-ready="true"/);
  // A finished order: nothing more to write.
  const done = html(createElement(TimelineBody, { data: data({ state: 'completed', can: { update: false, ready: false, modification_request: false } }), policy: null, onChanged: () => {} }));
  assert.doesNotMatch(done, /data-timeline-composer/);
});

test('a timeline that carries only the newest 200 updates says so above the spine, in each language (perf review 2026-09-30)', () => {
  assert.doesNotMatch(html(createElement(TimelineBody, { data: data(), policy: null, onChanged: () => {} })), /data-timeline-older/);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const h = html(createElement(TimelineBody, { data: data({ older_updates: true }), policy: null, onChanged: () => {} }), lang);
    assert.match(h, /data-timeline-older/);
    assert.ok(text(h).includes(TIMELINE_STRINGS[lang].older), lang);
    assert.ok(h.indexOf('data-timeline-older') < h.indexOf('data-order-timeline='), `${lang}: the note sits above the spine`);
  }
  assert.match(TIMELINE_STRINGS.ckb.older, KURDISH, 'the Sorani is Sorani');
});

test('the customer asks for a change before delivery — and never after, whatever a stale hint says', () => {
  const customer = (state: string, hint: boolean) =>
    data({ role: 'customer', state, can: { update: false, ready: false, modification_request: hint } });
  for (const state of ['funded', 'in_progress']) {
    const h = html(createElement(TimelineBody, { data: customer(state, true), policy: null, onChanged: () => {} }));
    assert.match(h, /data-timeline-ask-change/, `${state}: «اطلب تعديلًا» is offered`);
    assert.doesNotMatch(h, /data-timeline-composer/, 'the customer never gets the workshop\'s composer');
    assert.ok(text(h).includes('اطلب تعديلًا'));
  }
  for (const state of ['merchant_marked_delivered', 'completed', 'disputed', 'cancelled', 'refunded']) {
    const h = html(createElement(TimelineBody, { data: customer(state, true), policy: null, onChanged: () => {} }));
    assert.doesNotMatch(h, /data-timeline-ask-change/, `${state}: no change request after delivery`);
    assert.equal(canAskChange(customer(state, true)), false);
  }
  assert.equal(canAskChange(customer('in_progress', false)), false, 'the server said no');
  assert.deepEqual([...BEFORE_DELIVERY].sort(), ['funded', 'in_progress'], 'the server\'s BEFORE_DELIVERY');
  assert.deepEqual([...TERMINAL_STATES].sort(), ['cancelled', 'completed', 'refunded']);
});

test('cancel and dispute follow the policy handed in — for both sides', () => {
  const both = html(createElement(OrderActions, { orderId: 'cord_1', role: 'merchant', can: { cancel: true, dispute: true }, onDone: () => {} }));
  assert.match(both, /data-timeline-cancel/);
  assert.match(both, /data-timeline-dispute/);
  const disputeOnly = html(createElement(OrderActions, { orderId: 'cord_1', role: 'customer', can: { cancel: false, dispute: true }, onDone: () => {} }));
  assert.doesNotMatch(disputeOnly, /data-timeline-cancel/);
  assert.match(disputeOnly, /data-timeline-dispute/);
  assert.equal(html(createElement(OrderActions, { orderId: 'cord_1', role: 'customer', can: { cancel: false, dispute: false }, onDone: () => {} })), '');
  // Inside the body: drawn only when a policy is handed in (the customer's row keeps its own buttons).
  assert.doesNotMatch(html(createElement(TimelineBody, { data: data(), policy: null, onChanged: () => {} })), /data-timeline-actions/);
  assert.match(html(createElement(TimelineBody, { data: data(), policy: { cancel: false, dispute: true }, onChanged: () => {} })), /data-timeline-actions/);
});

// ------------------------------------------------------------ the merchant's screen

test('the custom order screen reads the order defensively: the total is the money identity, the fee from the snapshot', () => {
  const v = readCustomOrder({
    order: { id: 'cord_1', state: 'in_progress', price_iqd: 55_000, completion_days: 5, delivery_method: 'courier', request_title: 'حامل', customer_name: 'نور', ready_at: ago(3), offer_snapshot: { price_iqd: 50_000, delivery_fee_iqd: 5_000, quantity: 2, color: 'أسود', terms: '' } },
    escrow: { merchant_receivable_iqd: 52_250, platform_fee_iqd: 2_750 },
    can: { start_work: false, mark_delivered: true, cancel: false, dispute: true, confirm: false },
  });
  assert.equal(v.price_iqd, 55_000);
  assert.equal(workPrice(v), 50_000);
  assert.equal(v.snapshot.delivery_fee_iqd, 5_000);
  assert.deepEqual(v.can, { start_work: false, mark_delivered: true, cancel: false, dispute: true });
  assert.equal(v.ready_at !== null, true);
  // An order accepted before 0159: no fee, the price is the total.
  const old = readCustomOrder({ order: { id: 'x', state: 'funded', price_iqd: '40000', offer_snapshot: '{bad json' }, escrow: null, can: {} });
  assert.equal(workPrice(old), 40_000);
  assert.equal(old.snapshot.delivery_fee_iqd, 0);
  assert.deepEqual(old.can, { start_work: false, mark_delivered: false, cancel: false, dispute: false });
  assert.equal(stateWord('merchant_marked_delivered', CUSTOM_ORDER_STRINGS.ar), 'بانتظار تأكيد الزبون');
  assert.equal(stateWord('weird', CUSTOM_ORDER_STRINGS.en), 'weird');
  // The confirmation window is the server's number (review 2026-09-30), read with the order.
  assert.equal(readCustomOrder({ order: { id: 'x', state: 'in_progress' }, escrow: null, can: {}, auto_complete_days: 7 }).auto_complete_days, 7);
});

test('«سلّمت العمل» names the SERVER\'s confirmation window — never a number in the copy — and says nothing of it when auto-release is off', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = CUSTOM_ORDER_STRINGS[lang];
    assert.doesNotMatch(s.deliveredConsequence, /\d|ثلاثة|three|سێ/, `${lang}: no number in the copy`);
    const seven = deliveredConsequence(s, 7, lang);
    assert.ok(seven.includes(releaseAfter(7, lang)) && seven.startsWith(s.deliveredConsequence), `${lang}: ${seven}`);
    assert.equal(deliveredConsequence(s, 0, lang), s.deliveredConsequence, `${lang}: 0 turns auto-release off, so no promise`);
    assert.equal(deliveredConsequence(s, null, lang), s.deliveredConsequence, `${lang}: unknown, no promise`);
  }
  assert.deepEqual([1, 2, 3, 7, 11].map((n) => releaseAfter(n, 'ar')), ['يوم واحد', 'يومين', '3 أيام', '7 أيام', '11 يومًا']);
  assert.equal(releaseAfter(7, 'en'), '7 days');
  assert.equal(releaseAfter(1, 'en'), '1 day');
  assert.match(code('src/components/merchant/orders/CustomOrderScreen.tsx'), /consequence: deliveredConsequence\(s, order\?\.auto_complete_days, ordersLang\(lang\)\)/);
});

// ------------------------------------------------------------------ the pins

test('pins: the list opens the screen lazily, the screen hands down its policy, the customer gets a Sheet v2', () => {
  const tabs = code('src/components/merchant/dashboard/SalesTabs.tsx');
  assert.match(tabs, /const CustomOrderScreen = lazy\(\(\) => import\('\.\.\/orders\/CustomOrderScreen'\)\);/);
  assert.match(tabs, /<CustomOrderScreen key=\{openId\} id=\{openId\} onBack=\{close\} onChanged=\{load\} \/>/);
  // In the workspace the screen is a real page: a row goes to the order's address, «رجوع» to the list's.
  assert.match(tabs, /ws\.go\(ws\.href\(merchantHref\.customOrder\(id\)\)\)/);
  assert.match(tabs, /ws\.go\(ws\.href\(merchantHref\.customOrders\(\)\)\)/);
  assert.match(tabs, /const openId = ws \? focusOrderId :/, 'the address decides what the section shows');
  assert.doesNotMatch(tabs, /OrderContactCard/, 'the contact card lives on the screen now');

  const screen = code('src/components/merchant/orders/CustomOrderScreen.tsx');
  assert.match(screen, /<OrderTimeline orderId=\{id\} actions=\{\{ cancel: order\.can\.cancel, dispute: order\.can\.dispute \}\}/);
  assert.match(screen, /<OrderContactCard orderId=\{id\} compact \/>/);
  assert.match(screen, /can\.start_work/);
  assert.match(screen, /can\.mark_delivered/);

  const page = code('src/pages/Requests.tsx');
  assert.match(page, /const OrderTimeline = lazy\(\(\) => import\('\.\.\/components\/community\/requests\/OrderTimeline'\)\);/);
  assert.match(page, /from '\.\.\/components\/community\/requests\/timelineStrings'/, 'the row reads the small table, not the request page\'s');
  assert.match(page, /detents=\{\['medium', 'large'\]\}/);
  assert.match(page, /<OrderTimeline orderId=\{timelineFor\.id\} actions=\{false\} onChanged=\{load\} \/>/);

  // Raw source: `accept="image/*"` would open a block comment for the stripper above.
  const tl = read('src/components/community/requests/OrderTimeline.tsx');
  assert.match(tl, /useFreshOnReturn\(load, \{ pollWhileVisibleMs: 30_000, enabled: !settled \}\)/, 'a finished order is read once');
  assert.match(tl, /purpose="order_update"/);
  assert.match(tl, /discussionApi\.postOrderUpdate\(orderId, \{ kind: 'modification_request', body \}\)/);
  assert.match(tl, /m\.spring\('ui'\)/, 'rows arrive on the ui spring');
  assert.match(tl, /m\.travel\(6\)/, 'and reduced motion drops the travel');
  assert.doesNotMatch(tl, /window\.(confirm|prompt|alert)\(/, 'asked in the app\'s own dialog');
  // «جاهز» and a cancel are asked first, in the app's dialog (stood in for above).
  assert.equal((tl.match(/const \[confirm, confirmDialog\] = useConfirm\(\);/g) ?? []).length, 2, 'the composer and the actions each ask');
  assert.match(tl, /consequence: s\.composer\.readyConsequence/);
  assert.match(tl, /consequence: role === 'merchant' \? s\.actions\.cancelMerchant : s\.actions\.cancelCustomer,[\s\S]*?destructive: true/);
  assert.match(tl, /if \(text\.length < DISPUTE_MIN \|\| busy\) return;/, 'a dispute says why, ten characters at least');
  assert.doesNotMatch(tl, /\bdark:|#[0-9a-fA-F]{3,6}\b/, 'tokens only');
});

test('the order-update chat cards say their sentence in Sorani too (D6), never the Arabic standing in', async () => {
  const { eventText } = await import('../src/components/chat/cards/cardWords');
  const loc = (lang: 'ar' | 'ckb') => (ar: string, en: string, ckb?: string) => (lang === 'ckb' ? ckb || ar : ar);
  for (const e of ['progress', 'photo', 'ready', 'note', 'modification_request']) {
    const card = { type: 'custom_order', original: { event: e } } as never;
    const ar = eventText(card, loc('ar'));
    const ckb = eventText(card, loc('ckb'));
    assert.ok(ar && ckb && ckb !== ar, `${e}: «${ckb}»`);
  }
});
