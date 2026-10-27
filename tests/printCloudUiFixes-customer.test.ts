/**
 * THE CUSTOMER APP'S REVIEW FIXES (cloud.<root>), one test per finding:
 * honesty first — no «lowest cost» without costs, no unnamed accessory in a
 * guessed unit, no «live» from a one-time reading, no «slicer connected» from
 * the app's first load, no sell-back amount that never moved, links that land
 * on the item they name, a cancel that says what it cancels, a failure reason
 * in words, a phone typed on a native keyboard — then languages, RTL and
 * accessibility.
 *
 * Run: node --import tsx --test tests/printCloudUiFixes-customer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { tx } from '../src/cloud/text';
import * as M from '../src/cloud/pages/print/model';
import * as L from '../src/cloud/pages/account/logic';
import * as P from '../src/cloud/strings/print';
import * as S from '../src/cloud/strings/store';
import { common } from '../src/cloud/strings/common';
import type { PrinterRecommendations } from '../src/cloud/types';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const LANGS = ['ar', 'en', 'ckb'] as const;

// ------------------------------------------------------------------ Configure: the server's picks

type Model = PrinterRecommendations['models'][number];
const model = (id: string, over: { cost?: number | null; held?: number; compatible?: boolean } = {}): Model => ({
  printer_model_id: id,
  code: id,
  name: id,
  compatible: over.compatible ?? true,
  reasons: [],
  credit: {
    tier_id: 'tier_std',
    available_seconds: over.held ?? 0,
    estimated_seconds: over.cost == null ? null : 3600,
    estimated_cost_iqd: over.cost ?? null,
    basis: over.cost == null ? 'needs_estimate_for_this_model' : 'measured_estimate',
    enough_credit: null,
  },
  quality_rank: 1,
  jobs_ahead_on_model: 0,
});

test('Configure: «Lowest cost» and «Most hours held» only where the server’s figures back them', () => {
  // No estimate, no hours: the server still names a model for both picks.
  const bare = { models: [model('p1s'), model('x1c')], best: { lowest_cost: 'p1s', best_quality: 'x1c', shortest_queue: 'p1s', most_credit_available: 'p1s' } };
  assert.deepEqual(M.printerBadges(bare, 'p1s'), ['shortestQueue']);
  assert.deepEqual(M.printerBadges(bare, 'x1c'), ['bestQuality']);

  // A comparison needs every compatible model measured: one costed model among unmeasured ones is not one
  // (the server's sort cannot order the rest), and a lone model is compared with nothing.
  const one = { models: [model('p1s', { cost: 9000 }), model('x1c')], best: { ...bare.best, lowest_cost: 'p1s' } };
  assert.ok(!M.printerBadges(one, 'p1s').includes('lowestCost'));
  const lone = { models: [model('p1s', { cost: 9000 }), model('a1', { compatible: false })], best: { ...bare.best, lowest_cost: 'p1s' } };
  assert.ok(!M.printerBadges(lone, 'p1s').includes('lowestCost'));
  const two = { models: [model('p1s', { cost: 9000, held: 7200 }), model('x1c', { cost: 12000 })], best: { ...bare.best, lowest_cost: 'p1s' } };
  assert.deepEqual(M.printerBadges(two, 'p1s'), ['shortestQueue', 'mostCredit', 'lowestCost']);
  // An incompatible model wears nothing.
  assert.deepEqual(M.printerBadges({ models: [model('a', { compatible: false })], best: { lowest_cost: 'a', best_quality: 'a', shortest_queue: 'a', most_credit_available: 'a' } }, 'a'), []);

  const src = read('src/cloud/pages/print/Configure.tsx');
  assert.match(src, /printerBadges\(recs, id\)/, 'the screen draws the badges through printerBadges');
  assert.doesNotMatch(src, /recs\.best\.lowest_cost === id/, 'never the bare pick');
});

test('Configure: an accessory suggestion names its item and counts it in its own unit', () => {
  const src = read('src/cloud/pages/print/Configure.tsx');
  const block = src.slice(src.indexOf('function AccessoryChoices'), src.indexOf('// ------------------------------------------------------------------ the page'));
  assert.match(block, /useVariantNames\(\)/);
  assert.doesNotMatch(block, /formatQuantity\([^)]*'pc'/, 'no guessed «pc»');
  assert.match(block, /aria-label=\{`\$\{t\(projectWords\.accept\)\}: \$\{name\}`\}/, 'Accept names what it accepts');
  assert.match(block, /aria-label=\{`\$\{t\(projectWords\.dismiss\)\}: \$\{name\}`\}/, 'Dismiss names what it dismisses');
  for (const lang of LANGS) assert.ok(tx(P.configure.accessoryUnnamed, lang).trim(), lang);
});

// ------------------------------------------------------------------ links and failures

test('a material shortfall opens that variant’s page; hours keep the class tab', () => {
  assert.equal(M.shortfallLink({ kind: 'filament', code: 'INSUFFICIENT_INVENTORY', id: 'pcv a', amount: 120 }), '/store/variant/pcv%20a?qty=120');
  assert.equal(M.shortfallLink({ kind: 'accessory', code: 'INSUFFICIENT_INVENTORY', id: 'pcv_ring', amount: 0 }), '/store/variant/pcv_ring');
  assert.equal(M.shortfallLink({ kind: 'hours', code: 'INSUFFICIENT_CREDIT', id: 'tier_std', amount: 60 }), '/store?tab=hours&tier=tier_std');
  assert.match(read('src/cloud/pages/store/StoreRoutes.tsx'), /path="\/store\/variant\/:variantId"/, 'the route exists');
});

test('a failed print’s reason is words in every language, never the raw code alone', () => {
  for (const lang of LANGS) {
    assert.equal(M.failureReasonText('nozzle_clog', lang), tx(P.failureReason.nozzle_clog, lang));
    assert.equal(M.failureReasonText('NOZZLE_CLOG', lang), tx(P.failureReason.nozzle_clog, lang), 'the operator’s capitals');
    assert.equal(M.failureReasonText('POWER', lang), tx(P.failureReason.power_loss, lang));
    const other = M.failureReasonText('HMS_0300_0100', lang);
    assert.equal(other, tx(P.failureReason.other, lang, { code: 'HMS_0300_0100' }));
    assert.notEqual(other, 'HMS_0300_0100');
  }
  assert.match(read('src/cloud/pages/print/JobDetail.tsx'), /failureReasonText\(f\.reason_code, lang\)/);
});

// ------------------------------------------------------------------ live, stale and connected

test('Home: the current print is read again while on a machine, and a failed re-read is never live', () => {
  const src = read('src/cloud/pages/Home.tsx');
  const card = src.slice(src.indexOf('function CurrentPrintCard'), src.indexOf('function basisText'));
  assert.match(card, /usePoll\(view\.reload, ON_A_MACHINE\.includes\(v\?\.status \?\? job\.status\), CURRENT_POLL_MS\)/);
  assert.match(card, /const live = !view\.error && !!telemetry && telemetry\.live;/);
  assert.match(src, /const ON_A_MACHINE: readonly string\[\] = \['preparing', 'printing', 'paused'\];/);
  assert.deepEqual(['preparing', 'printing', 'paused'].map((s) => M.jobPollMs(s as never)), [10_000, 10_000, 10_000], 'the same states the job page polls');
});

test('Home: «running low» uses the workshop’s default while the customer set none', () => {
  const src = read('src/cloud/pages/Home.tsx');
  assert.match(src, /import \{ isLow \} from '\.\/account\/logic';/);
  assert.doesNotMatch(src, /const isLow = /, 'no second rule that ignores the default');
  assert.equal(L.isLow({ available_qty: 80, low_stock_alert_qty: null, low_stock_alert_default_qty: 100 }), true);
});

test('the slicer’s «connected» is read again — on a timer, on return, and with each poll of a job being measured', () => {
  const ctx = read('src/cloud/CloudContext.tsx');
  assert.match(ctx, /refreshStatus: \(\) => void;/);
  assert.match(ctx, /window\.setInterval\(refreshStatus, STATUS_REFRESH_MS\)/);
  assert.match(ctx, /addEventListener\('visibilitychange', onShow\)/);
  const silent = ctx.slice(ctx.indexOf('const refreshStatus = useCallback'), ctx.indexOf('useEffect(() => {\n    const timer'));
  assert.doesNotMatch(silent, /setStatus\(null\)/, 'a refresh never blanks the status (the whole app would flash)');
  const job = read('src/cloud/pages/print/JobDetail.tsx');
  assert.match(job, /if \(job\.status === 'analyzing'\) refreshStatus\(\);\n {2}\}, \[job, refreshStatus\]\);/);
});

// ------------------------------------------------------------------ money that never moved

test('a sell-back row shows money only as its status allows', () => {
  assert.equal(L.buybackFigure('approved'), 'final');
  assert.equal(L.buybackFigure('requested'), 'estimated');
  assert.equal(L.buybackFigure('rejected'), null);
  assert.equal(L.buybackFigure('cancelled'), null);
  const src = read('src/cloud/pages/account/AccountTransactions.tsx');
  assert.match(src, /buybackFigure\(status\) === 'estimated' \? \(\s*<MoneyLine text=\{buybackText\.estimated\}/);
});

test('cancelling a delivery fee’s order says it cancels the delivery request', () => {
  for (const lang of LANGS) {
    const text = tx(S.orders.cancelBodyShipping, lang);
    assert.ok(text.trim() && text !== tx(S.orders.cancelBody, lang), lang);
  }
  assert.notEqual(S.orders.cancelBodyShipping.ckb, S.orders.cancelBodyShipping.ar);
  assert.match(read('src/cloud/pages/store/OrderPage.tsx'), /order\.kind === 'shipping' \? words\.cancelBodyShipping : words\.cancelBody/);
});

// ------------------------------------------------------------------ the delivery phone

test('a delivery phone typed in Arabic-Indic or Persian digits is accepted and sent in ASCII', () => {
  const ids = new Set(['baghdad']);
  const good = { recipient_name: 'Ali', phone: '07701234567', governorate: 'baghdad', city: 'Karrada', address_line: 'Street 1', notes: '' };
  assert.deepEqual(L.addressProblems({ ...good, phone: '٠٧٧٠١٢٣٤٥٦٧' }, ids), {});
  assert.deepEqual(L.addressProblems({ ...good, phone: '۰۷۷۰ ۱۲۳ ۴۵۶۷' }, ids), {});
  assert.deepEqual(L.addressProblems({ ...good, phone: '0770-123-4567' }, ids), {});
  assert.deepEqual(L.addressProblems({ ...good, phone: 'abc' }, ids), { phone: 'format' });
  assert.equal(L.deliveryPhone(' ٠٧٧٠١٢٣٤٥٦٧ '), '07701234567');
  assert.equal(L.deliveryPhone('+964 ۷۷۰-۱۲۳'), '+964 770123');
  assert.match(L.deliveryPhone('٠٧٧٠١٢٣٤٥٦٧'), L.PHONE_RE);
  assert.match(read('src/cloud/pages/account/AccountShipmentNew.tsx'), /phone: deliveryPhone\(address\.phone\),/, 'the body carries the same digits that were checked');
});

// ------------------------------------------------------------------ languages, RTL and accessibility

test('a ledger figure is isolated in its own words’ direction, the sign alone in LTR', () => {
  const src = read('src/cloud/pages/account/shared.tsx');
  const fn = src.slice(src.indexOf('export function MovementFigure'), src.indexOf('export function MoneyLine'));
  assert.doesNotMatch(fn, /<bdi dir="ltr" className=/, 'no forced LTR around unit words');
  assert.match(fn, /\{sign \? <bdi dir="ltr">\{sign\}<\/bdi> : null\}/);
});

test('no block element carries dir="ltr": only the Latin run is isolated', () => {
  for (const rel of ['src/cloud/pages/Landing.tsx', 'src/cloud/pages/account/AccountShipment.tsx', 'src/cloud/pages/account/AccountHome.tsx']) {
    assert.doesNotMatch(read(rel), /<(?:h1|h2|p|div)\b[^>]*\sdir="ltr"/, rel);
  }
});

test('a struck-through price is announced as the price before the discount', () => {
  for (const rel of ['src/cloud/pages/store/CheckoutPage.tsx', 'src/cloud/pages/store/CartPage.tsx', 'src/cloud/pages/store/OrderPage.tsx']) {
    const src = read(rel);
    const at = src.indexOf('line-through">');
    assert.ok(at > 0, rel);
    assert.match(src.slice(at, at + 200), /<span className="sr-only">\{t\(goods\.beforeDiscount\)\} <\/span>/, rel);
  }
});

test('the upload counter stays out of the live region; the skeleton says «loading» in words', () => {
  const up = read('src/cloud/pages/print/PrintStart.tsx');
  assert.match(up, /<p aria-hidden="true" className="[^"]*">\s*<span>\{t\(upload\.sentOf/);
  const sk = read('src/cloud/ui/CloudPageFallback.tsx');
  assert.match(sk, /<span className="sr-only">\{t\(common\.loading\)\}<\/span>/);
  assert.doesNotMatch(sk, /sr-only">…</);
  for (const lang of LANGS) assert.ok(tx(common.loading, lang).trim(), lang);
  assert.notEqual(common.signedOut.ckb, common.signedOut.ar);
});

test('counts beside formatted figures share their digits (formatFigure)', () => {
  const checks: Array<[string, RegExp]> = [
    ['src/cloud/pages/Home.tsx', /\{formatFigure\(telemetry\.layer, lang\)\} \/ \{formatFigure\(telemetry\.total_layers, lang\)\}/],
    ['src/cloud/pages/Home.tsx', /home\.position, \{ n: formatFigure\(est\.position, lang\) \}/],
    ['src/cloud/pages/Home.tsx', /home\.freeOfActive, \{ idle: formatFigure\(m\.machines_idle, lang\), active: formatFigure\(m\.machines_active, lang\) \}/],
    ['src/cloud/pages/print/JobDetail.tsx', /\{formatFigure\(d\.layerCount, lang\)\}/],
    ['src/cloud/pages/print/JobDetail.tsx', /formatFigure\(d\.colourChanges, lang\)/],
    ['src/cloud/pages/PrinterDetail.tsx', /\{formatFigure\(of\(avail\.data!\), lang\)\}/],
    ['src/cloud/pages/PrinterDetail.tsx', /upToColours, \{ n: formatFigure\(model\.max_colors, lang\) \}/],
    ['src/cloud/pages/account/AccountHome.tsx', /acrossClasses, \{ n: formatFigure\(tiers\.length, lang\) \}/],
    ['src/cloud/pages/account/shared.tsx', /latestShown, \{ n: formatFigure\(cap, lang\) \}/],
    ['src/cloud/pages/account/AccountShipmentNew.tsx', /prints: formatFigure\(shown\.jobs\.length, lang\), materials: formatFigure\(shown\.items\.length, lang\)/],
  ];
  for (const [rel, re] of checks) assert.match(read(rel), re, rel);
});
