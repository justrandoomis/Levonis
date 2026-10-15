/**
 * Services S-P2 pass B (DECISIONS row 238; spec §11, §13.7, §10.2–§10.3) — THE SCREENS' WORDS AND
 * THEIR BUNDLES. Every customer and desk string exists in Arabic, English and Sorani, and the
 * Sorani is its own (row 183: a ckb slot never carries the Arabic); every new refusal code reads
 * in the three languages; no new client file calls loc(ar, en) without the Sorani; the new
 * screens arrive lazily, and no client file imports the owner's private offer parameters.
 * LOCAL ONLY (reads the sources).
 *
 * Run: node --import tsx --test tests/sv2_p2_strings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { COPY, copyText } from '../src/components/tradeIn/copy';
import { dateText } from '../src/components/tradeIn/model';
import { ADMIN_COPY, adminText } from '../src/components/adminTradeIn/copy';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const read = (f: string) => readFileSync(f, 'utf8');
const CUSTOMER = readdirSync('src/components/tradeIn').map((f) => `src/components/tradeIn/${f}`);
const DESK = readdirSync('src/components/adminTradeIn').map((f) => `src/components/adminTradeIn/${f}`);
const FILES = ['src/pages/TradeIn.tsx', ...CUSTOMER, ...DESK].filter((f) => /\.(tsx?|ts)$/.test(f));

test('every customer string (copy.ts) has three non-empty slots, and the Sorani is not the Arabic', () => {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(COPY) as Array<[string, readonly string[]]>) {
    if (v.length !== 3 || v.some((x) => !x.trim())) bad.push(`${k}: empty slot`);
    else if (v[2] === v[0]) bad.push(`${k}: ckb = ar`);
  }
  assert.deepEqual(bad, []);
  assert.ok(Object.keys(COPY).length >= 150, 'the five screens, the timeline and the entries');
});

test('every desk string (adminTradeIn/copy.ts) has three non-empty slots, and the Sorani is not the Arabic', () => {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(ADMIN_COPY) as Array<[string, readonly string[]]>) {
    if (v.length !== 3 || v.some((x) => !x.trim())) bad.push(`${k}: empty slot`);
    else if (v[2] === v[0]) bad.push(`${k}: ckb = ar`);
  }
  assert.deepEqual(bad, []);
});

test('the spec\'s own sentences are the screens\' sentences (§11.1, §11.4, B.11)', () => {
  const exact: Array<[keyof typeof COPY, string, string, string]> = [
    ['offer.upTo', 'حتى {x}', 'Up to {x}', 'تا {x}'],
    ['offer.final', 'القيمة النهائية بعد فحص الجهاز في المتجر، ولن تزيد على هذا العرض', 'The final value follows our in-store inspection and will not exceed this offer', 'بەهای کۆتایی دوای پشکنینی ئامێرەکە لە فرۆشگا دیاری دەکرێت و لەم پێشنیارە زیاتر نابێت'],
    ['credit.note', 'رصيد يُخصم من الجهاز الجديد فقط، ولا يُصرف نقداً', 'Credit toward the new device only, never paid out in cash', 'باڵانسێکە تەنها لە نرخی ئامێرە نوێیەکە کەم دەکرێتەوە و بە پارەی نەقد نادرێت'],
    ['entry.title', 'لديك جهاز قديم؟ استبدله بهذا', 'Have an old device? Trade it in for this one', 'ئامێرێکی کۆنت هەیە؟ بیگۆڕەوە بەمە'],
    ['services.title', 'خدماتي', 'My services', 'خزمەتگوزارییەکانم'],
    ['st.reissued', 'عاد رصيد الاستبدال حتى {date}', 'Your trade-in credit is back until {date}', 'باڵانسی گۆڕینەوەکەت تا {date} گەڕایەوە'],
    ['handover.fee', 'تُخصم أجرة الاستلام {fee} من الرصيد', 'A collection fee of {fee} comes off the credit', 'کرێی وەرگرتن {fee} لە باڵانسەکە کەم دەکرێتەوە'],
    ['promise', 'بعرض واضح قبل الإرسال', 'With a clear offer before you send', 'بە پێشنیارێکی ڕوون پێش ناردن'],
  ];
  for (const [k, ar, en, ckb] of exact) assert.deepEqual([...COPY[k]], [ar, en, ckb], k);
  const desk: Array<[keyof typeof ADMIN_COPY, string, string, string]> = [
    ['group', 'الخدمات', 'Services', 'خزمەتگوزارییەکان'],
    ['ceiling', 'الحد الأعلى المسموح', 'Highest allowed value', 'بەرزترین بەهای ڕێگەپێدراو'],
    ['override', 'تجاوز المالك', 'Owner override', 'تێپەڕاندنی خاوەن'],
    ['ackLoss', 'أفهم أن الهامش يقل وقد يكون خسارة', 'I understand the margin shrinks and may be a loss', 'تێدەگەم کە پەراوێزەکە کەم دەبێتەوە و لەوانەیە زیان بێت'],
    ['chip.device_to_collect', 'أجهزة تُعاد للزبون', 'Devices to hand back', 'ئامێرەکان بۆ گەڕاندنەوە بۆ کڕیار'],
  ];
  for (const [k, ar, en, ckb] of desk) assert.deepEqual([...ADMIN_COPY[k]], [ar, en, ckb], k);
  // The marks fill in every language; an unknown desk key reads as itself, never a crash.
  assert.equal(copyText('offer.left', 'ckb', { n: 3 }), '3 پێشنیار بۆ ئەم داواکارییە ماوە');
  assert.equal(adminText('approveX', 'en', { x: '545,000 IQD' }), 'Approve 545,000 IQD');
  assert.equal(adminText('ev.unheard_of' as keyof typeof ADMIN_COPY, 'ar'), 'ev.unheard_of');
});

test('every §11.2 refusal code reads in Arabic, English and Sorani, the Sorani its own', () => {
  for (const code of [
    'TRADE_IN_NO_OFFER',
    'TRADE_IN_TARGET_NOT_LISTED',
    'TRADE_IN_DEVICE_NOT_RECEIVED',
    'TRADE_IN_OFFER_EXPIRED',
    'TRADE_IN_SERIAL_MISMATCH',
    'TRADE_IN_ALREADY_RECEIVED',
    'TRADE_IN_INTAKE_REQUIRED',
    'TRADE_IN_OWN_REQUEST',
    'TRADE_IN_ORDER_NOT_DELIVERED',
    'TRADE_IN_ORDER_DELIVERED',
    'TRADE_IN_DEVICE_IN_SHOP',
    'TRADE_IN_MARGIN_ACK_REQUIRED',
    'TRADE_IN_HOURS_PHOTO',
    'TRADE_IN_DAMAGE_PHOTO',
    'TRADE_IN_V2_NOT_INSTALLED',
  ]) {
    const r = REFUSAL_STRINGS[code];
    assert.ok(r?.ar && r.en && r.ckb, `${code} is missing a language`);
    assert.notEqual(r.ckb, r.ar, `${code}: the Sorani copies the Arabic`);
  }
});

/** Every loc()/L() call in a file, read from the syntax tree. */
function locCalls(file: string) {
  const src = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; args: number }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'loc' || n.expression.text === 'L')) {
      out.push({ line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1, args: n.arguments.length });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

test('no S-P2 client file — customer or desk — calls loc(ar, en) without the Sorani (S2, admin files included)', () => {
  const twoArg = /\b(?:loc|L)\(\s*(['`])(?:\\.|(?!\1).)*\1\s*,\s*(['`])(?:\\.|(?!\2).)*\2\s*\)/gs;
  const literal = FILES.map((f) => [f, (read(f).match(twoArg) ?? []).length] as const).filter(([, n]) => n > 0);
  assert.deepEqual(literal, [], 'two-argument loc() with literal strings');
  const short = FILES.flatMap((f) => locCalls(f).filter((c) => c.args < 3).map((c) => `${f}:${c.line}`));
  assert.deepEqual(short, [], 'loc()/L() calls without a third argument');
  // The old desk helper is gone.
  for (const f of DESK) assert.doesNotMatch(read(f), /const L = \(ar: string, en: string\) =>/, f);
});

test('the 7-step wizard and its request card are gone; the five screens replace them', () => {
  assert.equal(existsSync('src/components/tradeIn/TradeInWizard.tsx'), false);
  assert.equal(existsSync('src/components/tradeIn/TradeInRequest.tsx'), false);
  for (const f of ['TradeInFlow', 'DeviceList', 'ScopeSheet', 'ConditionScreen', 'TargetSearchSheet', 'OfferScreen', 'RequestTimeline', 'HowItWorksSheet']) {
    assert.ok(existsSync(`src/components/tradeIn/${f}.tsx`), f);
  }
  for (const f of ['TradeInQueue', 'TradeInDetail', 'IntakeSheet', 'ValuePanel', 'OwnerValuationPanel', 'TradeInSettings', 'ComponentRefs']) {
    assert.ok(existsSync(`src/components/adminTradeIn/${f}.tsx`), f);
  }
});

test('the entries and the owner\'s panels arrive lazily: the product page, the profile and the desk carry an import line', () => {
  assert.match(read('src/pages/Product.tsx'), /const ProductTradeInEntry = React\.lazy\(\(\) => import\('\.\.\/components\/tradeIn\/ProductTradeInEntry'\)\)/);
  assert.match(read('src/pages/Profile.tsx'), /const MyServicesCard = React\.lazy\(\(\) => import\('\.\.\/components\/tradeIn\/MyServicesCard'\)\)/);
  assert.doesNotMatch(read('src/pages/Product.tsx'), /from '\.\.\/components\/tradeIn\//, 'a static trade-in import on the product page');
  assert.doesNotMatch(read('src/pages/Profile.tsx'), /from '\.\.\/components\/tradeIn\//, 'a static trade-in import on the profile');
  assert.match(read('src/components/adminTradeIn/TradeInDetail.tsx'), /const OwnerValuationPanel = React\.lazy\(/);
  assert.match(read('src/components/adminTradeIn/AdminTradeIn.tsx'), /const TradeInSettings = React\.lazy\(/);
  assert.match(read('src/components/adminTradeIn/IntakeSheet.tsx'), /const BarcodeScanner = React\.lazy\(/);
  // The product page asks for the entry only for a signed-in customer on a printer.
  assert.match(read('src/pages/Product.tsx'), /source === 'catalog' && isAuthenticated && product\.is_printer === true \? \(\s*<React\.Suspense fallback=\{null\}>\s*<ProductTradeInEntry/);
});

test('no client file imports the owner\'s offer parameters or the default rule sets (private: never in a bundle)', () => {
  const offenders = [...FILES, 'src/pages/Admin.tsx', 'src/pages/Profile.tsx', 'src/pages/Product.tsx'].filter((f) => /tradeInOffer|tradeInDefaults|DEFAULT_OFFER_PARAMS/.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  assert.deepEqual(offenders, []);
});

test('the admin «الخدمات» group holds the trade-in desk and the price-protection claims, each with its badge', () => {
  const admin = read('src/pages/Admin.tsx');
  assert.match(admin, /id: 'trade_in', icon: Repeat, label: loc\('الاستبدال', 'Trade-in', 'گۆڕینەوە'\), badge: servicesWaiting\?\.trade_in \?\? 0, \.\.\.section\('services', 'الخدمات', 'Services', 'خزمەتگوزارییەکان'\)/);
  assert.match(admin, /id: 'price_protection', icon: ShieldCheck, label: loc\('حماية السعر', 'Price protection', 'پاراستنی نرخ'\), badge: servicesWaiting\?\.price_protection \?\? 0, \.\.\.section\('services'/);
  assert.match(read('src/components/adminTradeIn/servicesBadge.ts'), /\/api\/admin\/services\/badge/);
});

test('a Sorani date is written in Sorani, never with the Arabic month names (the browser may carry no ckb calendar)', () => {
  const ckb = dateText('2026-10-15T09:00:00.000Z', 'ckb');
  assert.match(ckb, /تشرینی یەکەم/);
  assert.doesNotMatch(ckb, /تشرين الأول/);
  assert.match(dateText('2026-10-15T09:00:00.000Z', 'ar'), /2026/);
  assert.equal(dateText(null, 'ckb'), '—');
});

test('the desk names every answer of the declared-vs-inspected table (no raw key reaches the page)', () => {
  const detail = read('src/components/adminTradeIn/TradeInDetail.tsx');
  for (const k of ['hours', 'cleanliness', 'exterior', 'scratches', 'faults', 'repairs_count', 'replaced_parts', 'accessory_condition', 'original_accessories', 'fault_notes', 'repair_notes', 'notes']) {
    assert.match(detail, new RegExp(`\\b${k}: 'f\\.${k}'`), k);
    assert.ok(`f.${k}` in ADMIN_COPY, `f.${k}`);
  }
  assert.doesNotMatch(detail, /\{d\.field\}|JSON\.stringify\(d\.(declared|seen)\)/);
});
