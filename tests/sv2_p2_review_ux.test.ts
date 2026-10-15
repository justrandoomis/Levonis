/**
 * Services S-P2 — the final review's screen findings (ux-i18n-design), each held here so it cannot
 * come back: the words the desk and the customer read (no raw machine word, a counted noun that
 * agrees with its count, a column named for what it holds), the controls (a radio group the
 * keyboard walks, 44 px targets at the counter, an arrow that follows the reading direction), and
 * the screens' honesty (nothing reads as chosen before it was, a refusal names what is missing, a
 * day's limit is not the request's, no dead end without an offer). LOCAL ONLY (reads the sources
 * and calls the screens' pure helpers).
 *
 * Run: node --import tsx --test tests/sv2_p2_review_ux.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ADMIN_COPY, PNL_COUNT, adminText } from '../src/components/adminTradeIn/copy';
import { COPY, COUNTED, copyText, countedText, countText } from '../src/components/tradeIn/copy';
import { blockerLines, missingFor } from '../src/components/tradeIn/ConditionScreen';
import { radioStep } from '../src/components/tradeIn/parts';
import { previewLimitScope } from '../src/components/tradeIn/OfferScreen';
import { scopeReasonKey } from '../src/components/tradeIn/ScopeSheet';
import { blankInputs } from '../packages/pricing/src/tradeIn';
import type { ComponentView } from '../src/components/tradeIn/model';

const read = (f: string) => readFileSync(f, 'utf8');
const t = (k: keyof typeof COPY, v?: Record<string, string | number>) => copyText(k, 'en', v);
const loc = (_ar: string, en: string) => en;

test('F-19: every event the trade-in server writes has its words on the desk, in three languages — no raw machine word', () => {
  // Every action literal written into trade_in_events by the worker and the migrations.
  const sources = [
    ...readdirSync('worker/lib').filter((f) => /^tradeIn.*\.ts$/.test(f)).map((f) => `worker/lib/${f}`),
    'worker/routes/tradeIn.ts',
    ...readdirSync('migrations').filter((f) => f >= '0143' && f.endsWith('.sql')).map((f) => `migrations/${f}`),
  ];
  const actions = new Set<string>(['approve', 'accept', 'reject', 'completion_failed', 'stock_failed']);
  for (const f of sources) {
    const src = read(f);
    for (const m of src.matchAll(/eventStatement\([^)]*?\},\s*'([a-z_]+)'/g)) actions.add(m[1]);
    for (const m of src.matchAll(/'system', '([a-z_]+)', /g)) actions.add(m[1]);
    for (const m of src.matchAll(/\? '([a-z_]+)' : '([a-z_]+)', from/g)) {
      actions.add(m[1]);
      actions.add(m[2]);
    }
  }
  actions.delete('preview'); // a counted log line, never drawn
  for (const must of ['credit_restored', 'cutover', 'stock_skipped', 'credit_reissued', 'intake', 'device_returned']) assert.ok(actions.has(must), must);
  const missing = [...actions].filter((a) => !(`ev.${a}` in ADMIN_COPY));
  assert.deepEqual(missing, []);
  for (const a of actions) {
    const [ar, en, ckb] = ADMIN_COPY[`ev.${a}` as keyof typeof ADMIN_COPY] as readonly string[];
    assert.ok(ar && en && ckb && ckb !== ar, a);
  }
  // The system reasons an event carries read as words, never as codes.
  for (const r of ['expired_offer', 'expired_credit', 'source_missing', 'no_price_today', 'below_minimum']) {
    assert.ok(`reason.${r}` in ADMIN_COPY, r);
    assert.notEqual(adminText(`reason.${r}` as keyof typeof ADMIN_COPY, 'en'), `reason.${r}`);
  }
  const detail = read('src/components/adminTradeIn/TradeInDetail.tsx');
  assert.ok(!/e\.detail\.reason as string\}<\/p>/.test(detail), 'the reason is put into words first');
  assert.match(detail, /reasonText\(e\.detail\.reason/);
});

test('F-26: a count agrees with its noun — Arabic one / two / 3–10 / 11–99 / 100+, English one / other, Sorani its own', () => {
  assert.equal(countText('offer.left', 1, 'ar'), 'بقي عرض واحد لهذا الطلب');
  assert.equal(countText('offer.left', 2, 'ar'), 'بقي عرضان لهذا الطلب');
  assert.equal(countText('offer.left', 19, 'ar'), 'بقي 19 عرضاً لهذا الطلب');
  assert.equal(countText('offer.left', 3, 'ar'), 'بقيت 3 عروض لهذا الطلب');
  assert.equal(countText('offer.left', 1, 'en'), '1 offer left for this request');
  assert.equal(countText('offer.left', 20, 'en'), '20 offers left for this request');
  assert.equal(countText('services.devicesCount', 1, 'ar'), 'جهاز واحد');
  assert.equal(countText('services.devicesCount', 2, 'ar'), 'جهازان');
  assert.equal(countText('services.devicesCount', 1, 'en'), '1 device');
  assert.equal(countText('services.openCases', 1, 'ar'), 'طلب مفتوح واحد');
  assert.equal(countText('services.openCases', 1, 'en'), '1 open request');
  assert.equal(countedText(PNL_COUNT, 5, 'ar'), '5 طلبات');
  assert.equal(countedText(PNL_COUNT, 11, 'ar'), '11 طلباً');
  assert.equal(countedText(PNL_COUNT, 100, 'ar'), '100 طلب');
  assert.equal(countedText(PNL_COUNT, 1, 'en'), '1 request');
  for (const c of [...Object.values(COUNTED), PNL_COUNT]) {
    for (const n of [0, 1, 2, 5, 12, 100]) assert.notEqual(countedText(c, n, 'ckb'), countedText(c, n, 'ar'));
  }
  // The old fixed plurals are gone from the copy.
  assert.ok(!('offer.left' in COPY) && !('services.devicesCount' in COPY) && !('pnl.count' in ADMIN_COPY));
});

test('F-28: the declared-vs-inspected table names its first column for what it holds, in every language', () => {
  assert.deepEqual([...ADMIN_COPY['col.field']], ['السؤال', 'Question', 'پرسیار']);
  assert.ok(!('col.answer' in ADMIN_COPY));
});

test('F-21: the day’s preview limit is not the request’s — only the request’s own limit leaves no offers', () => {
  assert.equal(previewLimitScope({ scope: 'day' }), 'day');
  assert.equal(previewLimitScope({ scope: 'request' }), 'request');
  assert.equal(previewLimitScope(undefined), 'request');
  const src = read('src/components/tradeIn/OfferScreen.tsx');
  assert.match(src, /TRADE_IN_PREVIEW_LIMIT' && previewLimitScope\(e\.details\) === 'request'\) setLeft\(0\)/);
});

test('F-22: no offer is not a dead end — contact us, or cancel the draft (which frees the device)', () => {
  const src = read('src/components/tradeIn/OfferScreen.tsx');
  assert.match(src, /to="\/support"[^>]*data-no-offer-contact/);
  assert.match(src, /data-no-offer-cancel/);
  assert.match(src, /\/cancel`, \{\}\)/);
  assert.match(read('src/components/tradeIn/TradeInFlow.tsx'), /onCancelled=\{onExit\}/);
  assert.equal(copyText('offer.contact', 'ckb'), 'پەیوەندیمان پێوە بکە');
});

test('F-24: a part that cannot be traded says why — the server’s reason, in the customer’s words', () => {
  assert.equal(scopeReasonKey('TRADE_IN_ALREADY_CLAIMED'), 'reason.claimed');
  assert.equal(scopeReasonKey('TRADE_IN_BELOW_MINIMUM'), 'reason.below');
  assert.equal(scopeReasonKey('TRADE_IN_SERVICE_OPEN'), 'reason.service');
  assert.equal(scopeReasonKey('TRADE_IN_LINKED_ELSEWHERE'), 'reason.linked');
  assert.equal(scopeReasonKey('TRADE_IN_SCOPE_UNAVAILABLE'), 'reason.scope');
  assert.equal(scopeReasonKey(null), 'reason.scope');
  assert.ok(!read('src/components/tradeIn/ScopeSheet.tsx').includes(": t('reason.scope')}"));
});

test('F-31: every new radio group is one Tab stop the arrow keys walk (RTL mirrored), skipping nothing it should not', () => {
  assert.equal(radioStep('ArrowDown', 'ltr', 0, 3), 1);
  assert.equal(radioStep('ArrowUp', 'ltr', 0, 3), 2, 'wraps');
  assert.equal(radioStep('ArrowRight', 'ltr', 1, 3), 2);
  assert.equal(radioStep('ArrowRight', 'rtl', 1, 3), 0, 'right goes back in RTL');
  assert.equal(radioStep('ArrowLeft', 'rtl', 1, 3), 2);
  assert.equal(radioStep('Home', 'rtl', 2, 3), 0);
  assert.equal(radioStep('End', 'ltr', 0, 3), 2);
  assert.equal(radioStep('ArrowDown', 'ltr', -1, 3), 0);
  assert.equal(radioStep('Enter', 'ltr', 0, 3), null);
  for (const f of ['ScopeSheet', 'ConditionScreen', 'OfferScreen', 'RequestTimeline']) {
    const src = read(`src/components/tradeIn/${f}.tsx`);
    assert.ok(!/role="radiogroup"/.test(src), `${f}: a bare radiogroup`);
    assert.match(src, /<RadioGroup/, f);
  }
});

test('F-23: nothing on «حالة الجهاز» reads as chosen before the customer chose it — the blanks are not answers', () => {
  const c = { role: 'device', family: 'fdm', photos: [], inputs: {} } as unknown as ComponentView;
  const inputs = blankInputs('fdm');
  const none = missingFor(c, inputs, undefined, 2, t, loc, (id) => id, {}, true);
  assert.ok(none.includes(t('missing.condition')), JSON.stringify(none));
  assert.ok(none.includes(t('missing.accessories')));
  assert.ok(none.includes(t('missing.hours')));
  assert.ok(none.includes(t('missing.damagePick')));
  const answered = missingFor(c, inputs, false, 2, t, loc, (id) => id, { overall: true, accessories: true, hours: true }, true);
  for (const k of ['missing.condition', 'missing.accessories', 'missing.hours', 'missing.damagePick'] as const) assert.ok(!answered.includes(t(k)), k);
  const screen = read('src/components/tradeIn/ConditionScreen.tsx');
  assert.match(screen, /answered\.overall \? overallOf\(value\) : null/);
  assert.match(screen, /value=\{answered\.hours \? String\(value\.hours \?\? 0\) : ''\}/);
});

test('F-32: the server’s blockers are named — a photo by its angle, the hours photo, a damage close-up by its fault', () => {
  const req = { components: [{ role: 'device', family: 'fdm', photos: [], inputs: {} }] } as never;
  const lines = blockerLines(req, { inputs: { device: ['original_accessories'] }, photos: { device: ['hours', 'damage:nozzle_clog', 'front'] } }, t, loc, () => (id) => (id === 'nozzle_clog' ? 'Clogged nozzle' : id));
  assert.ok(lines.includes(t('missing.accessories')));
  assert.ok(lines.includes(t('photo.hoursBound')));
  assert.ok(lines.includes(t('missing.damagePhoto', { x: 'Clogged nozzle' })));
  assert.ok(lines.some((l) => l.startsWith('Photo: ') && !l.endsWith('front')), JSON.stringify(lines));
  assert.match(read('src/components/tradeIn/TradeInFlow.tsx'), /setError\(`\$\{t\('missing\.title'\)\} \$\{left\.join/);
});

test('F-18 / F-25: the order label reads in the reader’s direction (only the number is LTR); an offer is «حتى X», a fixed value is bare', () => {
  const src = read('src/components/tradeIn/DeviceList.tsx');
  assert.match(src, /tx\('orderNo', \{ id: <bdi dir="ltr">\{u\.order_id\}<\/bdi> \}\)/);
  assert.ok(!/<bdi dir="ltr"[^>]*>\s*\{t\('orderNo'/.test(src));
  assert.match(src, /data-request-figure="up-to">\s*\{tx\('offer\.upTo'/);
});

test('F-27 / F-29 / F-30: the desk — a damage photo captioned by its fault, the queue’s arrow follows the direction, 44 px targets at the counter', () => {
  const detail = read('src/components/adminTradeIn/TradeInDetail.tsx');
  assert.ok(!detail.includes("p.proves && p.proves !== 'hours' ? p.proves :"), 'no raw fault id as a caption');
  assert.match(detail, /faults\.find\(\(x\) => x\.id === p\.proves\)/);
  const queue = read('src/components/adminTradeIn/TradeInQueue.tsx');
  assert.match(queue, /dir === 'rtl' \? '←' : '→'/);
  assert.ok(!queue.includes('ckb)} → {r.target_name'));
  for (const f of ['IntakeSheet', 'TradeInQueue', 'AdminTradeIn']) {
    const src = read(`src/components/adminTradeIn/${f}.tsx`);
    assert.ok(!/min-h-\[(36|40)px\]/.test(src), `${f}: a target under 44 px`);
    assert.ok(!/className=\{T\.chip\}/.test(src), `${f}: a 32 px chip`);
  }
  assert.match(read('src/components/adminTradeIn/TradeInQueue.tsx'), /\$\{T\.chip\} min-h-\[44px\]/);
});

test('F-20: the hours are read off the device — required at intake, with the customer’s figure shown as a hint', () => {
  const src = read('src/components/adminTradeIn/IntakeSheet.tsx');
  assert.match(src, /hoursMissing \|\|/);
  assert.match(src, /intake\.hoursDeclared/);
  assert.ok(!src.includes("countsHours && hours.trim() !== '' ? Number(hours) : null"), 'blank never silently keeps the declared figure');
  assert.equal(adminText('intake.hoursDeclared', 'en', { n: 120 }), 'The customer declared 120 h — type what the screen shows');
});

test('F-33: the product page offers the trade-in on every device a credit can buy — an AMS or a laser too', () => {
  assert.match(read('worker/routes/products.ts'), /out\.trade_in_target = isPrinter \|\| type === 'printer' \|\| type === 'laser' \|\| \(type === 'parts' && /);
  assert.match(read('src/pages/Product.tsx'), /product\.is_printer === true \|\| product\.trade_in_target === true/);
});

test('F-34: the browser journey runs the new screens at 360 px, measures horizontal overflow and runs once with reduced motion', () => {
  const src = read('scripts/e2e-trade-in-v2.mjs');
  assert.match(src, /width: 360/);
  assert.match(src, /scrollWidth/);
  assert.match(src, /reducedMotion: 'reduce'/);
});
