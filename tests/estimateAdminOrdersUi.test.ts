/**
 * «تأكيد السعر النهائي» ON THE ADMIN'S ORDER SCREENS (docs/SMART_PRICING.md
 * §6.5, §6.7, §7, §12 WP13; DECISIONS row 280; migration 0218).
 *
 *   - THE CONFIRM PANEL (src/components/adminOrders/EstimateConfirmPanel.tsx)
 *     shows per line the price the customer ordered at, today's published
 *     price and a final-price input, with «تأكيد السعر كما هو» and «إرسال
 *     السعر النهائي للزبون». CUSTOMER PRICES ONLY: it reads and prints nothing
 *     else, even when a payload carries more, and calls nothing but the two
 *     order doors. ACTIONS ONLY WITH FINANCIAL SCOPE: any admin reads the
 *     lines; only `can_confirm` (a financial admin, a line waiting, no
 *     proposal pending) draws an input or a button.
 *   - Its arithmetic is the server's: every open or rejected line is named,
 *     each final on the one rounding rule, the total moved by Σ(final −
 *     estimate) × qty — a change asks the customer, an unchanged total does
 *     not — and the admin's own total rides only a changed line.
 *   - THE PRICE PANEL shows the confirm panel INSTEAD of the free proposal
 *     form while estimated lines wait, and reads an estimate proposal the way
 *     its customer does (the localized reason, the lines old → new).
 *   - THE BOARD offers «بانتظار تأكيد السعر» (absence-tolerant) and badges the
 *     row; THE MODAL notes the gate above the stage path and chips each line.
 *   - THREE LANGUAGES: no string in these five screens is Arabic and English
 *     only, and no Sorani slot carries the Arabic (DECISIONS row 183).
 *
 * Run: node --import tsx --test tests/estimateAdminOrdersUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { LanguageProvider } from '../src/LanguageContext';
import { formatIqd } from '../src/lib/api';
import EstimateConfirmPanel, {
  confirmAsIsBody,
  estimateStateText,
  isFinalUnitPrice,
  sendFinalBody,
  settlementPreview,
  todayFinalOf,
  waitingLines,
  type EstimatePanelData,
} from '../src/components/adminOrders/EstimateConfirmPanel';
import { PendingAdjustment, type PublicAdjustment } from '../src/components/adminOrders/PriceAdjustPanel';
import { EstimateBadge, PriceHoldBadge, type EstimateBoardRow } from '../src/components/adminOrders/OrderBoardBadges';
import { FINANCIAL_FIELDS } from '../packages/platform-kit/src/scope';
import { ESTIMATE_LINE_STATES, ESTIMATE_REASON_CODE, ESTIMATE_STRINGS, type EstimateLang } from '../packages/contracts/src/priceEstimates';
import { PRICE_ROUNDING_STEP_IQD, PRICE_ROUNDING_THRESHOLD_IQD } from '../packages/pricing/src/priceRounding';
import { PRICE_ADJUST_MAX_IQD } from '../packages/pricing/src/priceAdjustment';
import { estimateLineView } from '../worker/lib/orderEstimates';
import { publicAdjustment } from '../worker/lib/orderPriceAdjust';

const LANGS: readonly EstimateLang[] = ['ar', 'en', 'ckb'];
const PANEL = 'src/components/adminOrders/EstimateConfirmPanel.tsx';
const PRICE_PANEL = 'src/components/adminOrders/PriceAdjustPanel.tsx';
const MODAL = 'src/components/adminOrders/OrderDetailModal.tsx';
const BOARD = 'src/components/adminOrders/OrdersBoard.tsx';
const BADGES = 'src/components/adminOrders/OrderBoardBadges.tsx';
const SCREENS = [PANEL, PRICE_PANEL, MODAL, BOARD, BADGES];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code of a file without its comments: a comment may quote a word it explains. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژ]/;

// The language provider reads `levo_lang` from localStorage when it mounts.
let LANG: EstimateLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const html = (node: ReactNode, lang: EstimateLang = 'ar') => {
  LANG = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: node }));
};
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
/** The `loc` the board hands its badges, for one language (the badges take it as a prop). */
const locIn = (lang: EstimateLang) => (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar);

// ------------------------------------------------------------------ fixtures

/** Keys a customer-price read never carries, planted with figures no screen may print. */
const PLANTED = { est_cost_iqd: 919_193, supplier_price_amount: 828_287, min_profit_usd: 737_371, cost_iqd: 646_469 } as const;

function panelData(over: Partial<EstimatePanelData> = {}): EstimatePanelData {
  const base = {
    order: {
      id: 'ORD-EST1',
      status: 'pending',
      stage: 'received',
      total_iqd: 74_500,
      due_on_delivery_iqd: 74_500,
      wallet_applied_iqd: 0,
      payment_method_id: 'cod',
      price_hold_id: null,
    },
    lines: [
      {
        order_item_id: 'oi-tpu',
        name: 'TPU 95A HF',
        variant: 'Black',
        qty: 2,
        channel: 'pre_order_sea',
        estimate_unit_iqd: 24_250,
        current_unit_iqd: 25_500,
        final_unit_iqd: null,
        state: 'open',
        adjustment_id: null,
        decided_at: null,
        ...PLANTED,
      },
      {
        order_item_id: 'oi-petg',
        name: 'PETG HF',
        variant: '',
        qty: 1,
        channel: 'pre_order_sea',
        estimate_unit_iqd: 13_000,
        current_unit_iqd: null,
        final_unit_iqd: 14_000,
        state: 'rejected',
        adjustment_id: 'padj_000000000000000000000001',
        decided_at: '2026-10-31T10:00:00.000Z',
        ...PLANTED,
      },
      {
        order_item_id: 'oi-ams',
        name: 'AMS HT',
        variant: '',
        qty: 1,
        channel: 'pre_order_land',
        estimate_unit_iqd: 13_000,
        current_unit_iqd: 13_000,
        final_unit_iqd: 13_000,
        state: 'confirmed',
        adjustment_id: null,
        decided_at: '2026-10-31T09:00:00.000Z',
        ...PLANTED,
      },
    ],
    unsettled: 2,
    pending: null,
    financial_scope: true,
    can_confirm: true,
    ...PLANTED,
  };
  return { ...base, ...over } as unknown as EstimatePanelData;
}

/** The panel as the server renders it, with a read already in hand (no request is made). */
const panel = (data: EstimatePanelData, lang: EstimateLang = 'ar') =>
  html(createElement(EstimateConfirmPanel, { orderId: data.order.id, onChanged: () => undefined, initial: data }), lang);

const estimateFinals = (data: EstimatePanelData) =>
  Object.fromEntries(waitingLines(data.lines).map((l) => [l.order_item_id, l.estimate_unit_iqd])) as Record<string, number | null>;

// =========================================================================
//  THE CONFIRM PANEL
// =========================================================================

test('the confirm panel, for a financial admin: per line the estimate, today’s price and a final input, with both acts — in three languages', () => {
  const titles = {
    ar: 'تأكيد السعر النهائي للمنتجات التقديرية',
    en: 'Confirm the final price of the estimated items',
    ckb: 'پشتڕاستکردنەوەی نرخی کۆتایی بەرهەمە خەمڵێنراوەکان',
  } as const;
  const acts = {
    ar: ['تأكيد السعر كما هو', 'إرسال السعر النهائي للزبون'],
    en: ['Confirm the price as it is', 'Send the final price to the customer'],
    ckb: ['نرخەکە وەک خۆی پشتڕاست بکەرەوە', 'نرخی کۆتایی بۆ کڕیار بنێرە'],
  } as const;
  for (const lang of LANGS) {
    const h = panel(panelData(), lang);
    const t = text(h);
    assert.ok(t.includes(titles[lang]), `${lang}: the title`);
    for (const act of acts[lang]) assert.ok(t.includes(act), `${lang}: «${act}»`);
    assert.match(h, /data-estimate-confirm="act"/);
    assert.match(h, /data-action="estimate-confirm-as-is"/);
    assert.match(h, /data-action="estimate-send-final"/);
    // One final input per WAITING line (open, rejected) — none on a settled one.
    assert.deepEqual([...h.matchAll(/data-estimate-final="([^"]+)"/g)].map((m) => m[1]), ['oi-tpu', 'oi-petg'], lang);
    // The estimate, today's price, and the price the customer rejected — each a customer price.
    for (const n of [24_250, 25_500, 13_000, 14_000]) assert.ok(t.includes(formatIqd(n)), `${lang}: ${formatIqd(n)}`);
    // Nothing changed yet: the send act waits for a changed line and says how to make one.
    assert.match(h, /<button[^>]*disabled=""[^>]*data-action="estimate-send-final"|<button[^>]*data-action="estimate-send-final"[^>]*disabled=""/);
    assert.match(h, /data-estimate-outcome="none"/);
  }
  assert.match(text(panel(panelData(), 'ckb')), KURDISH, 'the Sorani panel is written in Sorani letters');
  assert.doesNotMatch(text(panel(panelData(), 'ar')), KURDISH, 'the Arabic panel carries no Sorani');
  // The line states, in the admin's words, per language.
  const ckb = text(panel(panelData(), 'ckb'));
  for (const s of ['open', 'rejected', 'confirmed'] as const) assert.ok(ckb.includes(estimateStateText(s, locIn('ckb'))), s);
  assert.notEqual(titles.ckb, titles.ar);
});

test('customer prices only: a payload carrying private keys prints none of them — and the panel names no private field and calls only the two order doors', () => {
  for (const lang of LANGS) {
    for (const data of [panelData(), panelData({ financial_scope: false, can_confirm: false })]) {
      const h = panel(data, lang);
      for (const [k, v] of Object.entries(PLANTED)) {
        assert.ok(!h.includes(k), `${lang}: the key ${k} reached the markup`);
        for (const shown of [String(v), v.toLocaleString('en-US'), formatIqd(v)]) assert.ok(!h.includes(shown), `${lang}: ${k}'s figure (${shown}) reached the markup`);
      }
    }
  }
  const src = code(PANEL);
  for (const k of FINANCIAL_FIELDS as readonly string[]) {
    assert.doesNotMatch(src, new RegExp(`(?<![A-Za-z0-9_])${k}(?![A-Za-z0-9_])`), `the panel names the private field ${k}`);
  }
  // Every request: the order's estimate read and its confirm door — never the owner's pricing routes.
  const calls = [...src.matchAll(/\bapi\.(\w+)\s*(?:<[^>]*>)?\s*\(\s*([`'"])([^`'"]*)\2/g)].map((m) => `${m[1]} ${m[3]}`).sort();
  assert.deepEqual(calls, [
    'get /api/admin/orders/${encodeURIComponent(orderId)}/price-estimate',
    'post /api/admin/orders/${encodeURIComponent(orderId)}/price-estimate/confirm',
  ]);
  assert.equal((src.match(/\bapi\./g) ?? []).length, 2, 'a request the pin above did not read');
  assert.doesNotMatch(read(PANEL), /\/api\/admin\/pricing|\/procurement|cost-first|supplier_/);
});

test('actions only with financial scope: any other admin reads the same lines and one sentence — no input, no button that acts', () => {
  const scope = {
    ar: 'تأكيد السعر النهائي للمالك أو الدور المالي فقط.',
    en: 'Only the owner or a financial admin can confirm the final price.',
    ckb: 'تەنها خاوەن یان بەڕێوەبەری دارایی دەتوانێت نرخی کۆتایی پشتڕاست بکاتەوە.',
  } as const;
  for (const lang of LANGS) {
    const h = panel(panelData({ financial_scope: false, can_confirm: false }), lang);
    assert.match(h, /data-estimate-confirm="scope"/);
    assert.match(h, /data-estimate-readonly="scope"/);
    assert.ok(text(h).includes(scope[lang]), lang);
    assert.doesNotMatch(h, /<input|<textarea|data-action="estimate-/, `${lang}: an input or an act reached a non-financial admin`);
    // The lines themselves are the same customer prices any admin may read.
    assert.ok(text(h).includes(formatIqd(24_250)) && text(h).includes(formatIqd(25_500)), lang);
  }
  // A financial admin while the settlement's proposal waits on the customer: nothing to act on either.
  const pending = panelData({
    order: { ...panelData().order, price_hold_id: 'padj_000000000000000000000002' },
    lines: panelData().lines.map((l) => (l.state === 'open' || l.state === 'rejected' ? { ...l, state: 'proposed' as const, final_unit_iqd: 15_000 } : l)),
    unsettled: 2,
    can_confirm: false,
  });
  for (const lang of LANGS) {
    const h = panel(pending, lang);
    assert.match(h, /data-estimate-readonly="pending"/, lang);
    assert.doesNotMatch(h, /<input|<textarea|data-action="estimate-/, lang);
  }
  // The gate on the act is the SERVER's `can_confirm`, never the scope alone.
  assert.match(code(PANEL), /\{data\.can_confirm \? \(/);
  assert.match(code(PANEL), /const editable = data\.can_confirm && \(l\.state === 'open' \|\| l\.state === 'rejected'\)/);
});

test('the arithmetic is the server’s: every waiting line named, finals on the rule, the total moved by the difference, the own total only with a change', () => {
  const data = panelData();
  const at = (finals: Record<string, number | null>, editedTotal: number | null = null) => settlementPreview(data, { finals, editedTotal });

  // Every final equal to its estimate: nothing changes, the customer is not asked.
  const same = at(estimateFinals(data));
  assert.deepEqual(same, { invalid: [], changed: false, delta: 0, total: 74_500, target: 74_500, asksCustomer: false });
  // One line up by 1,250 on two units: +2,500, and the customer is asked.
  const up = at({ ...estimateFinals(data), 'oi-tpu': 25_500 });
  assert.deepEqual([up.changed, up.delta, up.target, up.asksCustomer], [true, 2_500, 77_000, true]);
  // Differences that cancel out: confirmed without asking (the server's equal-total case).
  const even = at({ 'oi-tpu': 24_000, 'oi-petg': 13_500 });
  assert.deepEqual([even.changed, even.delta, even.target, even.asksCustomer], [true, 0, 74_500, false]);
  // The admin's own total rides a changed line only.
  assert.equal(at({ ...estimateFinals(data), 'oi-tpu': 25_500 }, 70_000).target, 70_000);
  assert.equal(at(estimateFinals(data), 70_000).target, 74_500, 'an own total with no changed line is ignored');
  // Off the rule, empty, or over the ceiling: named, and nothing is asked.
  const off = at({ 'oi-tpu': PRICE_ROUNDING_THRESHOLD_IQD + 1, 'oi-petg': null });
  assert.deepEqual([off.invalid, off.asksCustomer], [['oi-tpu', 'oi-petg'], false]);
  assert.equal(isFinalUnitPrice(PRICE_ROUNDING_THRESHOLD_IQD), true);
  assert.equal(isFinalUnitPrice(PRICE_ROUNDING_THRESHOLD_IQD - 1), true, 'at or under the threshold any whole dinar is a price');
  assert.equal(isFinalUnitPrice(PRICE_ROUNDING_THRESHOLD_IQD + PRICE_ROUNDING_STEP_IQD), true);
  assert.equal(isFinalUnitPrice(PRICE_ROUNDING_THRESHOLD_IQD + 1), false);
  assert.equal(isFinalUnitPrice(0), false);
  assert.equal(isFinalUnitPrice(12_250.5), false);
  assert.equal(isFinalUnitPrice(PRICE_ADJUST_MAX_IQD + PRICE_ROUNDING_STEP_IQD), false);

  // «as it is»: every open or rejected line at its estimate — never a settled one, never a total.
  assert.deepEqual(confirmAsIsBody(data, 'key-0000-0001'), {
    idempotency_key: 'key-0000-0001',
    lines: [
      { order_item_id: 'oi-tpu', final_unit_iqd: 24_250 },
      { order_item_id: 'oi-petg', final_unit_iqd: 13_000 },
    ],
  });
  // «send»: nothing to send while unchanged or unreadable; the own total and the note only when given.
  assert.equal(sendFinalBody(data, { finals: estimateFinals(data), editedTotal: null }, 'key-0000-0002'), null);
  assert.equal(sendFinalBody(data, { finals: { 'oi-tpu': 24_300, 'oi-petg': 13_000 }, editedTotal: null }, 'key-0000-0002'), null);
  assert.deepEqual(sendFinalBody(data, { finals: { 'oi-tpu': 25_500, 'oi-petg': 13_000 }, editedTotal: null }, 'key-0000-0003', '  '), {
    idempotency_key: 'key-0000-0003',
    lines: [
      { order_item_id: 'oi-tpu', final_unit_iqd: 25_500 },
      { order_item_id: 'oi-petg', final_unit_iqd: 13_000 },
    ],
  });
  assert.deepEqual(sendFinalBody(data, { finals: { 'oi-tpu': 25_500, 'oi-petg': 13_000 }, editedTotal: 76_000 }, 'key-0000-0004', ' مع الشكر '), {
    idempotency_key: 'key-0000-0004',
    lines: [
      { order_item_id: 'oi-tpu', final_unit_iqd: 25_500 },
      { order_item_id: 'oi-petg', final_unit_iqd: 13_000 },
    ],
    new_total_iqd: 76_000,
    note: 'مع الشكر',
  });
  // The rule's figures are the rounding module's, never written into the screen.
  const src = code(PANEL);
  assert.match(src, /import \{ isOnPriceRule, PRICE_ROUNDING_STEP_IQD, PRICE_ROUNDING_THRESHOLD_IQD \} from '\.\.\/\.\.\/\.\.\/packages\/pricing\/src\/priceRounding'/);
  assert.match(src, /planPriceAdjustment\(\{/, 'the money preview is the 0140 planner');
  assert.doesNotMatch(src, /\b(250|1_?000)\b/, 'a rounding figure written into the panel');
});

test('a changed price: the preview names the new total and the door amount, and the send act asks the customer', () => {
  const data = panelData();
  // The form is seeded from the read; a typed change is the component's state, so the preview is
  // pinned through the same pure function the component renders (`settlementPreview`).
  const p = settlementPreview(data, { finals: { 'oi-tpu': 25_500, 'oi-petg': 13_000 }, editedTotal: null });
  assert.equal(p.asksCustomer, true);
  const src = code(PANEL);
  // The send act's label follows the outcome: «إرسال…» when the total moves, «تأكيد الأسعار النهائية» when it does not.
  assert.match(src, /preview\.changed && !preview\.asksCustomer\s*\?\s*loc\('تأكيد الأسعار النهائية'/);
  // The note goes only with a proposal (the equal-total confirmation sends no words to the customer).
  assert.match(src, /sendFinalBody\(data, \{ finals, editedTotal: ownTotal \}, key, preview\.asksCustomer \? note : ''\)/);
  // A refusal reads in the admin's language: the contract's estimate sentence first, the shop's table after.
  assert.match(src, /estimateRefusalText\(e, lang\) \?\? apiRefusal\(e, lang, fallback\)/);
  // «as it is» asks first, through the house dialog, mounted on first use.
  assert.match(src, /\{askMounted && \(\s*<ConfirmDialog/);
  // One idempotency key per panel, kept across retries: renewed only once a settlement landed, or
  // once the order moved past the panel (a proposal already waits) — and then the caller re-reads.
  assert.match(src, /const \[key, setKey\] = useState\(newKey\)/);
  assert.equal((src.match(/setKey\(newKey\(\)\)/g) ?? []).length, 2);
  assert.match(src, /if \(movedOn\(e\)\) \{\s*toast\.error\(sentence\);\s*setKey\(newKey\(\)\);\s*await onChanged\(\);/);
  assert.match(src, /code === 'PRICE_APPROVAL_PENDING' \|\| code === 'IDEMPOTENCY_KEY_REUSED'/);
});

test('a line bought under an offer: the price before it, the same offer today and a sentence saying so — «استخدم سعر اليوم» only once today’s price moved', () => {
  const offerLine = (over: Record<string, unknown>) => ({
    order_item_id: 'oi-offer', name: 'TPU Spool', variant: '', qty: 1, channel: 'pre_order_sea',
    estimate_unit_iqd: 40_500, current_unit_iqd: 45_000, offer_before_unit_iqd: 45_000, offer_today_unit_iqd: 40_500,
    final_unit_iqd: null, state: 'open', adjustment_id: null, decided_at: null,
    ...over,
  });
  const one = (l: Record<string, unknown>) => panelData({ lines: [l] as unknown as EstimatePanelData['lines'], unsettled: 1 });
  const words = {
    ar: 'اشترى الزبون هذا المنتج ضمن عرض',
    en: 'The customer bought this item under an offer',
    ckb: 'ئەم بەرهەمە لە ماوەی ئۆفەرێکدا کڕدرا',
  } as const;
  // The act's label: on an offer line it names the same offer (it sets that, not the published price).
  const useToday = {
    offer: { ar: 'استخدم سعر اليوم بنفس العرض', en: 'Use today’s price under the same offer', ckb: 'نرخی ئەمڕۆ بە هەمان ئۆفەر بەکاربهێنە' },
    plain: { ar: 'استخدم سعر اليوم', en: 'Use today’s price', ckb: 'نرخی ئەمڕۆ بەکاربهێنە' },
  } as const;
  const actLabels = (h: string) => [...h.matchAll(/<button[^>]*data-action="estimate-use-current"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!).trim());
  for (const lang of LANGS) {
    assert.deepEqual(actLabels(panel(one(offerLine({ current_unit_iqd: 50_000, offer_today_unit_iqd: 45_000 })), lang)), [useToday.offer[lang]], `${lang}: an offer line`);
    assert.deepEqual(actLabels(panel(panelData(), lang)), [useToday.plain[lang]], `${lang}: a plain line keeps its label`);
  }
  for (const lang of LANGS) {
    // Nothing moved: today's published price is still the one before the offer — nothing to use.
    const still = panel(one(offerLine({})), lang);
    assert.ok(text(still).includes(words[lang]), `${lang}: the sentence`);
    for (const attr of ['data-estimate-offer', 'data-offer-before-unit', 'data-offer-today-unit']) assert.ok(still.includes(attr), `${lang}: ${attr}`);
    assert.doesNotMatch(still, /data-action="estimate-use-current"/, `${lang}: the offer's saving is not offered back`);
    // Moved: the same offer on today's price is shown, and the act appears.
    const moved = panel(one(offerLine({ current_unit_iqd: 50_000, offer_today_unit_iqd: 45_000 })), lang);
    for (const n of [40_500, 45_000, 50_000]) assert.ok(text(moved).includes(formatIqd(n)), `${lang}: ${formatIqd(n)}`);
    assert.match(moved, /data-action="estimate-use-current"/, lang);
  }
  assert.match(text(panel(one(offerLine({})), 'ckb')), KURDISH);
  assert.doesNotMatch(text(panel(one(offerLine({})), 'ar')), KURDISH, 'the Arabic offer line carries no Sorani');
  // The act sets the same offer on today's price, never the bare published price.
  assert.equal(todayFinalOf(offerLine({ current_unit_iqd: 50_000, offer_today_unit_iqd: 45_000 }) as EstimatePanelData['lines'][number]), 45_000);
  assert.match(code(PANEL), /setFinals\(\(prev\) => \(\{ \.\.\.prev, \[id\]: today \}\)\)/);
  // A plain line keeps the act it always had: today's published price.
  assert.equal(todayFinalOf(panelData().lines[0]!), 25_500);
  assert.match(panel(panelData(), 'en'), /data-action="estimate-use-current"/);
  assert.doesNotMatch(panel(panelData(), 'en'), /data-estimate-offer|data-offer-before-unit|data-offer-today-unit/);
});

// =========================================================================
//  THE PRICE PANEL
// =========================================================================

test('the price panel shows the confirm panel INSTEAD of the free proposal form while estimated lines wait', () => {
  const src = code(PRICE_PANEL);
  assert.match(src, /import EstimateConfirmPanel from '\.\/EstimateConfirmPanel'/);
  // pending → its block; else estimate_open → the confirm panel; only then the free form, the button, the blocked line.
  assert.match(
    src,
    /\{p \? \(\s*<PendingAdjustment p=\{p\} onWithdraw=\{\(\) => setWithdrawOpen\(true\)\} \/>\s*\) : data\.estimate_open === true \? \(\s*<EstimateConfirmPanel orderId=\{orderId\} onChanged=\{changed\} \/>\s*\) : open \? \(/
  );
  assert.equal((src.match(/<EstimateConfirmPanel\b/g) ?? []).length, 1);
  // An older server sends no `estimate_open`: the panel is exactly what it was.
  assert.match(src, /estimate_open\?: boolean;/);
  // Every refusal a request answers reads in the admin's language — an estimate code from the contract first (§5.5).
  for (const f of [PRICE_PANEL, PANEL]) {
    const c = code(f);
    assert.match(c, /const refusalOf = \(e: unknown, lang: Lang, fallback: string\): string => estimateRefusalText\(e, lang\) \?\? apiRefusal\(e, lang, fallback\);/, f);
    assert.equal((c.match(/apiRefusal\(e\b/g) ?? []).length, 1, `${f}: a request's refusal skips the estimate sentences`);
  }
  assert.match(code(BOARD), /estimateRefusalText\(e, l\) \?\? apiRefusal\(e, l, e\.message\)/, 'the board’s one-tap move too');
});

const ESTIMATE_PROPOSAL: PublicAdjustment = {
  id: 'padj_000000000000000000000003',
  state: 'pending',
  old_total_iqd: 74_500,
  new_total_iqd: 77_000,
  delta_iqd: 2_500,
  old_due_iqd: 74_500,
  new_due_iqd: 77_000,
  wallet_refund_iqd: 0,
  // What the row stores: the reason in three languages, for the CHECK and older readers.
  reason: `${ESTIMATE_STRINGS.estimateReason.ar} / ${ESTIMATE_STRINGS.estimateReason.en} / ${ESTIMATE_STRINGS.estimateReason.ckb}`,
  note: 'TPU 95A HF — Black × 2: 24,250 → 25,500',
  created_at: '2026-10-31T11:00:00.000Z',
  decided_at: null,
  decided_via: null,
  reason_code: ESTIMATE_REASON_CODE,
  lines: [{ order_item_id: 'oi-tpu', name: 'TPU 95A HF', variant: 'Black', qty: 2, estimate_unit_iqd: 24_250, final_unit_iqd: 25_500 }],
};

test('an estimate proposal reads as its customer reads it: the localized reason, never the stored three-language line, and its lines old → new', () => {
  for (const lang of LANGS) {
    const h = html(createElement(PendingAdjustment, { p: ESTIMATE_PROPOSAL, onWithdraw: () => undefined }), lang);
    const t = text(h);
    assert.match(h, /data-price-adjust-kind="estimate"/);
    assert.ok(t.includes(ESTIMATE_STRINGS.estimateReason[lang]), `${lang}: the localized reason`);
    for (const other of LANGS.filter((l) => l !== lang)) {
      assert.ok(!t.includes(ESTIMATE_STRINGS.estimateReason[other]), `${lang}: the ${other} reason printed beside it`);
    }
    assert.match(h, /data-price-adjust-lines/);
    assert.ok(t.includes('TPU 95A HF') && t.includes(formatIqd(24_250)) && t.includes(formatIqd(25_500)), lang);
    assert.match(h, /data-price-adjust-estimate-reject/, `${lang}: what a rejection leads to`);
    assert.match(h, /data-action="price-withdraw"/);
  }
  // An ordinary proposal is what it always was: the admin's own reason, no lines.
  const ordinary: PublicAdjustment = { ...ESTIMATE_PROPOSAL, reason: 'Shipping rate changed', reason_code: '', lines: undefined };
  const h = html(createElement(PendingAdjustment, { p: ordinary, onWithdraw: () => undefined }), 'ckb');
  assert.match(h, /data-price-adjust-kind="ordinary"/);
  assert.ok(text(h).includes('Shipping rate changed'));
  assert.doesNotMatch(h, /data-price-adjust-lines|data-price-adjust-estimate-reject/);
  assert.ok(text(h).includes('چاوەڕێی پەسەندکردنی نرخەکە لەلایەن کڕیارەوە'), 'the panel speaks Sorani');
});

// =========================================================================
//  THE BOARD AND THE MODAL
// =========================================================================

test('the board row badge: «بانتظار تأكيد السعر» while estimated lines wait — the 0140 badge while the customer decides', () => {
  const row = (over: Partial<EstimateBoardRow>) => ({ id: 'ORD-EST1', ...over }) as unknown as EstimateBoardRow;
  const words = {
    ar: 'بانتظار تأكيد السعر',
    en: 'Awaiting price confirmation',
    ckb: 'چاوەڕێی پشتڕاستکردنەوەی نرخ',
  } as const;
  for (const lang of LANGS) {
    const loc = locIn(lang);
    const estimate = renderToStaticMarkup(createElement(EstimateBadge, { order: row({ price_estimate_open: true }), loc }));
    assert.match(estimate, /data-order-price-estimate/);
    assert.ok(text(estimate).includes(words[lang]), lang);
    // The row's one price slot carries it…
    const viaRow = renderToStaticMarkup(createElement(PriceHoldBadge, { order: row({ price_estimate_open: true }), loc }));
    assert.match(viaRow, /data-order-price-estimate/);
    // …unless the settlement's proposal waits on the customer: then theirs is the next move.
    const held = renderToStaticMarkup(createElement(PriceHoldBadge, { order: row({ price_hold_id: 'padj_x', price_estimate_open: true }), loc }));
    assert.match(held, /data-order-price-hold/);
    assert.doesNotMatch(held, /data-order-price-estimate/);
    assert.equal(renderToStaticMarkup(createElement(PriceHoldBadge, { order: row({}), loc })), '', `${lang}: no hold, no badge`);
    assert.equal(renderToStaticMarkup(createElement(EstimateBadge, { order: row({ price_estimate_open: false }), loc })), '');
  }
  assert.notEqual(words.ckb, words.ar);
});

test('the board filter «بانتظار تأكيد السعر»: the live board only, sent only when chosen, shown only while some order waits', () => {
  const src = code(BOARD);
  assert.match(src, /const \[priceEstimate, setPriceEstimate\] = useState\(false\);/);
  assert.match(src, /if \(priceEstimate && !archive\) params\.set\('price_estimate', '1'\);/);
  assert.match(src, /\[archive, archiveScope, archiveSort, journey, status, query, page, lang, priceHold, priceEstimate\]/, 'a toggle re-reads the board');
  // Absence-tolerant: no count from an older server, none from a database without 0218 — no button.
  assert.match(src, /\(priceEstimate \|\| \(data\?\.price_estimate_count \?\? 0\) > 0\) && \(\s*<button\s+type="button"\s+data-order-filter="price-estimate"/);
  assert.match(src, /\{!archive && \(priceHold \|\| priceEstimate \|\| \(data\?\.price_hold_count \?\? 0\) > 0 \|\| \(data\?\.price_estimate_count \?\? 0\) > 0\) && \(/);
  // Choosing it starts again from the first page.
  assert.match(src, /setPriceEstimate\(\(v\) => !v\);\s*setPage\(0\);/);
  assert.match(src, /loc\('بانتظار تأكيد السعر', 'Awaiting price confirmation', 'چاوەڕێی پشتڕاستکردنەوەی نرخ'\)/);
});

test('the modal: the gate above the stage path, the receipt amount marked as an estimate, and each estimated line’s state', () => {
  const src = code(MODAL);
  assert.match(src, /const estimateOpen = detail\?\.price_estimate_open === true;/);
  // Above the stage path, after the 0140 hold note — which is the true one while the customer decides.
  assert.match(src, /\{detail\.price_hold_id \? \(\s*<p data-price-hold-note[\s\S]*?\) : estimateOpen \? \(\s*<p data-price-estimate-note role="status"/);
  assert.ok(src.indexOf('data-price-estimate-note') < src.indexOf('<OrderStagePanel'), 'the note sits above the path it freezes');
  assert.match(src, /\{estimateOpen && \(\s*<p data-collect-estimate/);
  assert.match(src, /\{it\.price_estimate && \([\s\S]{0,160}<EstimateLineChip state=\{it\.price_estimate\.state\} labelled \/>/);
  // The confirm panel lives in the modal through the price panel, which every order shows.
  assert.match(src, /<PriceAdjustPanel orderId=\{orderId\} onChanged=\{load\} \/>/);
  // Every state an estimated line can be in has its admin words, in three languages and never the Arabic twice.
  for (const state of ESTIMATE_LINE_STATES) {
    const [ar, en, ckb] = LANGS.map((l) => estimateStateText(state, locIn(l)));
    assert.ok(ar && en && ckb, state);
    assert.notEqual(ckb, ar, `${state}: the Sorani is the Arabic`);
    assert.match(ckb, KURDISH, `${state}: Sorani letters`);
  }
});

// =========================================================================
//  THE SCREENS READ WHAT THE SERVER SENDS (WP9, landed)
// =========================================================================

test('the screens read what the server sends: the line view, the proposal projection, the panel read, the board and the order read', () => {
  // The line view any admin reads (worker/lib/orderEstimates.ts): every key the panel reads, and no other figure.
  const view = estimateLineView(
    {
      order_item_id: 'oi-tpu', order_id: 'ORD-EST1', product_id: 'p-tpu', combo_key: 'k', channel: 'pre_order_sea', qty: 2,
      estimate_unit_iqd: 24_250, notice_version: 1, state: 'open', final_unit_iqd: null, adjustment_id: null, decided_by: '',
      decided_at: null, created_at: '2026-10-31T08:00:00.000Z', name_snapshot: 'TPU 95A HF', option_snapshot: 'Black',
    },
    25_500
  );
  assert.deepEqual(Object.keys(view).sort(), [
    'adjustment_id', 'channel', 'current_unit_iqd', 'decided_at', 'estimate_unit_iqd', 'final_unit_iqd', 'name', 'order_item_id', 'qty', 'state', 'variant',
  ]);
  const fromServer = panelData({ lines: [view as EstimatePanelData['lines'][number]] });
  const t = text(panel(fromServer, 'en'));
  assert.ok(t.includes('TPU 95A HF') && t.includes('Black') && t.includes(formatIqd(24_250)) && t.includes(formatIqd(25_500)));

  // The proposal as the server projects it (worker/lib/orderPriceAdjust.ts), rendered by the price panel.
  const row = {
    id: 'padj_000000000000000000000004', order_id: 'ORD-EST1', user_id: 'u1', state: 'pending' as const,
    old_total_iqd: 74_500, new_total_iqd: 77_000, delta_iqd: 2_500, old_due_iqd: 74_500, new_due_iqd: 77_000,
    old_wallet_iqd: 0, new_wallet_iqd: 0, wallet_refund_iqd: 0, reason: ESTIMATE_PROPOSAL.reason, note: '', proposed_by: 'admin-1',
    idempotency_key: 'key-0000-0005', created_at: '2026-10-31T11:00:00.000Z', decided_at: null, decided_by: null, decided_via: '',
    tg_chat_id: null, tg_message_id: null, reason_code: ESTIMATE_REASON_CODE,
  };
  const lines = new Map([[row.id, [{ order_item_id: 'oi-tpu', name: 'TPU 95A HF', variant: 'Black', qty: 2, estimate_unit_iqd: 24_250, final_unit_iqd: 25_500 }]]]);
  const projected = publicAdjustment(row, lines) as unknown as PublicAdjustment;
  for (const lang of LANGS) {
    const h = text(html(createElement(PendingAdjustment, { p: projected, onWithdraw: () => undefined }), lang));
    assert.ok(h.includes(ESTIMATE_STRINGS.estimateReason[lang]) && h.includes(formatIqd(25_500)), lang);
  }

  // The panel read, the confirm door, the price panel's flag, the board and the order read (the routes' own keys).
  const adjust = read('worker/routes/orderPriceAdjust.ts');
  for (const k of ['unsettled:', 'pending:', 'financial_scope: financial,', 'can_confirm:', 'price_hold_id:', 'estimate_open: estimate,']) assert.ok(adjust.includes(k), k);
  assert.match(adjust, /adminOrderPriceRoutes\.get\('\/:id\/price-estimate'/);
  assert.match(adjust, /adminOrderPriceRoutes\.post\('\/:id\/price-estimate\/confirm', requireFinancialScope/);
  assert.match(adjust, /body\.idempotency_key/);
  assert.match(adjust, /body\.new_total_iqd/);
  const admin = read('worker/routes/admin.ts');
  assert.match(admin, /c\.req\.query\('price_estimate'\) === '1'/);
  assert.match(admin, /price_estimate_count: Number\(/);
  assert.match(admin, /price_estimate_open: true as const/);
  assert.match(admin, /price_estimate_open: itemsHoldOrder\(items\)/);
});

// =========================================================================
//  THREE LANGUAGES
// =========================================================================

/** A string the source spells out whole: `'…'`, `"…"` or a template with nothing in it. */
const literal = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

/** `loc(…)` calls passing fewer than three languages, or the Arabic again in the Sorani slot (tests/soraniStorefrontGaps.test.ts's check). */
function twoLanguageLoc(rel: string): string[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['loc', 'locOutside'].includes(n.expression.text)) {
      const ar = literal(n.arguments[0]);
      if (n.arguments.length < 3 || (ar !== null && ar === literal(n.arguments[2]))) {
        out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText().slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('three languages: no string on the admin’s order and price screens is Arabic and English only, and no Sorani slot carries the Arabic', () => {
  assert.deepEqual(SCREENS.flatMap(twoLanguageLoc), []);
  for (const f of [PANEL, PRICE_PANEL, MODAL, BOARD, BADGES]) {
    assert.doesNotMatch(read(f), /OWNER: Sorani to be written by hand/, `${f} still says its Sorani is missing`);
  }
  // The price panel's own words in Sorani, as its customer's copy (CUSTOMER_COPY.ckb) says them.
  assert.ok(read(PRICE_PANEL).includes("loc('السعر النهائي', 'Final price', 'نرخی کۆتایی')"));
  assert.ok(read(PRICE_PANEL).includes("loc('سحب الاقتراح', 'Withdraw proposal', 'کشاندنەوەی پێشنیار')"));
  // The words the estimate shares with the customer are the contract's, not a copy.
  assert.match(code(PANEL), /ESTIMATE_STRINGS\.label\[langOf\(lang\)\]/);
  assert.match(code(PRICE_PANEL), /ESTIMATE_STRINGS\.estimateReason\[L\]/);
});
