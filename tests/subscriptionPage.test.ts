/**
 * /subscription — what the page is allowed to say, and how it behaves.
 *
 * The owner's rule is that nothing shown to a customer may be fabricated. The
 * page used to list benefits nothing enforced (daily game tickets, PRO-only
 * products, advertising eligibility, a 3D-printable card), called a PRIME
 * member "PLUS" in four places, told a customer on a live site that their card
 * was "reserved until the launch", listed a discount once per product, and
 * printed the wallet in dollars beside a wallet page in dinars. These checks
 * pin the corrections — some by reading the source the way a reviewer would,
 * the rest by running the pure sentence builders and rendering the checkout
 * for real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { translations } from '../src/translations';
import { cardNumberFor, maskCardNumber, CARD_PLACEHOLDER } from '../src/components/subscription/cardNumber';
import {
  MEMBERSHIP_STATE_LABELS,
  TIER_META,
  durationLabel,
  durationSep,
  membershipStateLabel,
  pickDefaultTier,
  tierLabel,
} from '../src/components/subscription/tierMeta';
import { bestValuePlanId } from '../src/components/subscription/PlanPicker';
import {
  discountLine,
  isolatedMoney,
  sectionLines,
  shoppingLines,
  type BenefitDiscountRule,
  type TierBenefits,
} from '../src/components/subscription/benefitLines';
import { buildCompare, rowIsUniform, tierHighlights } from '../src/components/subscription/compareModel';
import { CheckoutBar } from '../src/components/subscription/CheckoutBar';
import type { ApiPlan, PurchaseQuote } from '../src/components/subscription/types';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import { formatIqd } from '../src/lib/api';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const COMPONENT_DIR = 'src/components/subscription';
const pageFiles = () => [
  'src/pages/Subscription.tsx',
  'src/components/ui/Segmented.tsx',
  ...readdirSync(join(ROOT, COMPONENT_DIR)).map((f) => `${COMPONENT_DIR}/${f}`),
];
const customerFiles = () => pageFiles().filter((f) => !f.endsWith('Segmented.tsx'));
const allSource = () => pageFiles().map((f) => `// ${f}\n${read(f)}`).join('\n');

// ------------------------------------------------------------ fake copy gone

test('no removed fake benefit survives anywhere on the page', () => {
  const src = allSource();
  const banned = [
    'daily ticket',
    'daily tickets',
    'تذكرة يوميه',
    'تذاكر مجانيه',
    'تکتی',
    'benefitPlus5',
    'benefitPro4',
    'PRO-only products',
    'منتجات وعروض حصرية',
    'advertising',
    'أهلية الإعلانات',
    'random filament',
    'الفيلامنت العشوائي',
    'special offers',
    'العروض الخاصة',
    'tangiblePhysicalCard',
    'levoIdSubtext',
    'unlockedWithAnnual',
    '3D-printable',
    'Free last-mile delivery on all orders',
    'لجميع الطلبات',
  ];
  for (const phrase of banned) {
    assert.equal(src.includes(phrase), false, `fake benefit copy is back: "${phrase}"`);
  }
});

test('the removed translation keys are gone from every language block', () => {
  const gone = ['tangiblePhysicalCard', 'levoIdSubtext', 'unlockedWithAnnual', 'benefitPlus5', 'benefitPro4', 'benefitPro2', 'benefitPlus1'];
  for (const lang of ['en', 'ar', 'ckb'] as const) {
    const block = translations[lang] as Record<string, string>;
    for (const k of gone) assert.equal(k in block, false, `${lang}.${k} should have been removed`);
  }
});

// --------------------------------------------------- the site is live now

/**
 * «يظهر حجز البطاقة وتفعيل عند اطلاق الموقع وهذا خطأ لأن الموقع يعمل». The
 * server no longer reserves (DEFAULT_LAUNCH, migration 0109, the lazy
 * conversion — tests/membershipsSubscribe.test.ts); this is the other half: no
 * screen a customer sees can say it again, in any language.
 */
test('no customer screen can say a card is reserved until the site launches', () => {
  for (const f of [...customerFiles(), 'src/pages/Profile.tsx']) {
    const src = read(f);
    for (const key of ['launchNote', 'confirmAndReserve', 'pendingLaunch']) {
      assert.equal(src.includes(`'${key}'`), false, `${f} still uses t('${key}')`);
    }
    assert.equal(/إطلاق الموقع|site launch|تُفعّل عند الإطلاق|محجوزة حتى|بانتظار الإطلاق|awaiting the launch|چاوەڕێی دەستپێکردن/.test(src), false, `${f} still carries launch copy`);
  }
  for (const lang of ['en', 'ar', 'ckb'] as const) {
    const block = translations[lang] as Record<string, string>;
    for (const key of ['launchNote', 'confirmAndReserve', 'pendingLaunch']) {
      assert.equal(key in block, false, `${lang}.${key} should be gone`);
    }
    assert.ok(block.pendingActivation, `${lang}.pendingActivation missing`);
  }
  for (const label of Object.values(MEMBERSHIP_STATE_LABELS.prepaid_pending_launch)) {
    assert.equal(/إطلاق|launch|دەستپێک/i.test(label), false, `the ledger still says "${label}"`);
  }
  assert.equal(membershipStateLabel('prepaid_pending_launch', 'ar'), 'قيد التفعيل');
  // The confirmation has one button label: it pays.
  const confirm = read('src/components/subscription/PurchaseConfirm.tsx');
  assert.match(confirm, /t\('confirmAndPay'\)/);
  assert.equal(confirm.includes('activate_now'), false, 'no reserve branch is left to take');
});

// ------------------------------------------------------------- three tiers

test('all three tiers are named, and PREMIUM is never a fallback to PLUS', () => {
  assert.deepEqual(
    Object.values(TIER_META).map((m) => m.label),
    ['PLUS', 'PREMIUM', 'PRO']
  );
  assert.equal(tierLabel('prime'), 'PREMIUM');
  assert.equal(tierLabel('plus'), 'PLUS');
  assert.equal(tierLabel('pro'), 'PRO');

  for (const f of [...pageFiles(), 'src/pages/Profile.tsx', 'src/components/Header.tsx']) {
    const src = read(f);
    assert.equal(/'PRO'\s*:\s*'PLUS'/.test(src), false, `${f} still labels every non-PRO tier as PLUS`);
    assert.equal(/=== 'pro' \? 'PRO'/.test(src), false, `${f} still decides the label with a pro/else test`);
  }
  for (const m of Object.values(TIER_META)) {
    assert.ok(m.cardFace && m.chip && m.text && m.hex, `${m.id} is missing a style`);
  }
});

test('months are counted the way Arabic counts them', () => {
  assert.equal(durationLabel(1, 'ar'), 'شهر واحد');
  assert.equal(durationLabel(2, 'ar'), 'شهران');
  assert.equal(durationLabel(3, 'ar').endsWith('أشهر'), true);
  assert.equal(durationLabel(12, 'ar').endsWith('شهرًا'), true);
  assert.match(durationLabel(1, 'en'), /month$/);
  assert.match(durationLabel(12, 'en'), /months$/);
});

// ------------------------------------------------------- the card number

test('the Levo ID is twelve digits in three groups (was sixteen in four)', () => {
  for (const seed of ['u1', 'usr_9f8e7d6c5b4a', 'a', 'someone@example.com']) {
    const n = cardNumberFor(seed);
    assert.match(n, /^\d{4} \d{4} \d{4}$/, `unexpected card number "${n}" for "${seed}"`);
    assert.equal(cardNumberFor(seed), n, 'the number must be stable for the same account');
    assert.match(maskCardNumber(n), /^\*{4} \*{4} \d{4}$/);
    assert.equal(maskCardNumber(n).slice(-4), n.slice(-4));
  }
  assert.equal(CARD_PLACEHOLDER.split(' ').length, 3, 'the guest placeholder has three groups too');
  assert.equal(cardNumberFor(''), CARD_PLACEHOLDER);
  assert.equal(maskCardNumber(CARD_PLACEHOLDER), CARD_PLACEHOLDER);
  assert.equal(read('src/components/subscription/cardNumber.ts').includes('4521'), false, 'the old prefix is gone');
});

// ------------------------------------------------------------ best value

test('"best value" is only claimed when it is arithmetically true — on the figure the options show', () => {
  const plan = (id: string, months: number, price: number | null) => ({
    id,
    tier: 'plus' as const,
    duration_months: months,
    price_iqd: price,
    purchasable: price !== null,
    per_month_iqd: price === null ? null : Math.round(price / months),
    sort: 1,
  });
  assert.equal(bestValuePlanId([plan('a', 1, 4500), plan('b', 3, 10000), plan('c', 6, 17000), plan('d', 12, 29000)]), 'd');
  assert.equal(bestValuePlanId([plan('x', 12, 99000)]), null);
  assert.equal(bestValuePlanId([plan('a', 1, 1000), plan('b', 2, 2000)]), null);
  assert.equal(bestValuePlanId([plan('a', 1, 2417), plan('b', 12, 29000)]), null);
  assert.equal(bestValuePlanId([plan('a', 1, 1000), plan('b', 12, null)]), null);
  // And the page does no per-month arithmetic of its own.
  for (const f of ['PlanPicker.tsx', 'TierCards.tsx', 'CheckoutBar.tsx', 'CompareMatrix.tsx'].map((x) => `${COMPONENT_DIR}/${x}`)) {
    const src = read(f);
    assert.equal(/Math\.round\(|\/\s*p\.duration_months|\/\s*plan\.duration_months/.test(src), false, `${f} computes a figure in the browser`);
  }
  assert.match(read(`${COMPONENT_DIR}/PlanPicker.tsx`), /per_month_iqd/);
  assert.match(read(`${COMPONENT_DIR}/TierCards.tsx`), /per_month_iqd/);
});

// --------------------------------------------------- translation parity

test('every t() key the page uses exists in all three language blocks', () => {
  const src = allSource();
  const keys = new Set<string>();
  for (const m of src.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) keys.add(m[1]);
  assert.ok(keys.size > 20, `expected the page to use the shared table, found ${keys.size} keys`);
  for (const lang of ['en', 'ar', 'ckb'] as const) {
    const block = translations[lang] as Record<string, string>;
    for (const k of keys) {
      assert.ok(typeof block[k] === 'string' && block[k].length > 0, `translations.${lang}.${k} is missing`);
    }
  }
  for (const k of ['chooseCard', 'bestValue', 'confirmPurchase', 'planComparisons', 'yourMembership', 'upgradeBadge', 'includedInYours', 'differencesOnly']) {
    assert.ok(keys.has(k), `the page should use t('${k}')`);
  }
  assert.equal(translations.ar.planComparisons, 'مقارنة الخطط', 'the owner calls it «مقارنة الخطط»');
});

test('the three language blocks have identical key sets', () => {
  const en = Object.keys(translations.en).sort();
  const ar = Object.keys(translations.ar).sort();
  const ckb = Object.keys(translations.ckb).sort();
  assert.deepEqual(ar, en, 'ar block differs from en');
  assert.deepEqual(ckb, en, 'ckb block differs from en');
});

// ---------------------------------------------------------- «اختر بطاقتك»

test('the cards are a real radio group with ONE travelling selection cue and no glow', () => {
  const cards = read(`${COMPONENT_DIR}/TierCards.tsx`);
  assert.match(cards, /role="radiogroup"/);
  assert.match(cards, /role="radio"/);
  assert.match(cards, /aria-checked=\{on\}/);
  assert.match(cards, /tabIndex=\{on \? 0 : -1\}/, 'a roving tabindex');
  assert.match(cards, /dir === 'rtl' \? 'ArrowLeft' : 'ArrowRight'/, 'arrow keys follow the writing direction');
  assert.match(cards, /e\.key === 'Home'/);
  assert.match(cards, /e\.key === 'End'/);
  assert.match(cards, /layoutId="tier-card-ring"/, 'one ring shared across the cards');
  assert.match(cards, /m\.reduced \? \{ duration: 0 \} : m\.spring\('quick'\)/, 'it travels on the house spring and jumps under reduced motion');
  // The compare control sits beside the radio, never inside it.
  const radioOpen = cards.indexOf('role="radio"');
  const radioClose = cards.indexOf('</button>', radioOpen);
  assert.equal(cards.slice(radioOpen, radioClose).includes('onCompare'), false, 'an interactive element is nested in the radio');
  // Restraint: no glow anywhere on the page, and the canvas token as ground.
  for (const f of customerFiles()) {
    const src = read(f);
    assert.equal(/blur-\[1\d\dpx\]|0 0 2\dpx \$\{|shadow-\[0_0_/.test(src), false, `${f} still glows`);
  }
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /bg-canvas/);
  assert.equal(page.includes('bg-[#0a0a0a]'), false);
});

test('the page opens on the tier above yours — never always PRO', () => {
  const all = ['plus', 'prime', 'pro'] as const;
  const onSale = () => true;
  assert.equal(pickDefaultTier([...all], 'free', onSale), 'plus', 'a guest or free account starts at the first tier on sale');
  assert.equal(pickDefaultTier([...all], 'plus', onSale), 'prime', 'a PLUS member is shown the upgrade');
  assert.equal(pickDefaultTier([...all], 'prime', onSale), 'pro');
  assert.equal(pickDefaultTier([...all], 'pro', onSale), 'pro', 'a PRO member lands on their own card');
  assert.equal(pickDefaultTier([...all], 'free', (t) => t !== 'plus'), 'prime', 'an unpriced tier is skipped');
  // The catalogue's order does not decide the default; the ladder does.
  assert.equal(pickDefaultTier(['pro', 'prime', 'plus'], 'free', onSale), 'plus');
  const page = read('src/pages/Subscription.tsx');
  assert.equal(/useState<PaidTier>\('pro'\)/.test(page), false, 'the old hard default is back');
});

test('the choice lives in the URL, and signing in brings the customer back to it', () => {
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /readSelection\(location\.search\)/, 'the tier and plan are read from ?tier=&plan=');
  assert.match(page, /window\.history\.replaceState\(window\.history\.state/, 'written without a router navigation (which would scroll to the top)');
  assert.match(page, /navigate\('\/auth', \{ state: \{ from: `\$\{location\.pathname\}\$\{selectionSearch\}` \} \}\)/);
});

test('a duration control appears only where there is a choice', () => {
  const picker = read(`${COMPONENT_DIR}/PlanPicker.tsx`);
  assert.match(picker, /<Segmented/);
  assert.match(picker, /tierPlans\.length === 1/);
  assert.match(picker, /data-single-plan/);
});

// -------------------------------------------------------------- house rules

test('the segmented control keeps its radio semantics and house spring', () => {
  const seg = read('src/components/ui/Segmented.tsx');
  assert.match(seg, /role="radiogroup"/);
  assert.match(seg, /role="radio"/);
  assert.match(seg, /aria-checked/);
  assert.match(seg, /min-h-11/);
  assert.match(seg, /layoutId=/);
  assert.match(seg, /useMotion\(\)/);
  assert.match(seg, /spring\('quick'\)/);
});

test('the purchase goes through the house window, never a browser dialog, and holds the screen while it charges', () => {
  const src = allSource();
  assert.equal(/window\.(confirm|alert|prompt)\(/.test(src), false, 'no browser dialogs');
  const confirm = read(`${COMPONENT_DIR}/PurchaseConfirm.tsx`);
  assert.match(confirm, /from '\.\.\/ui\/Overlay'/);
  assert.match(confirm, /<Sheet/);
  assert.match(confirm, /<Overlay/);
  assert.match(confirm, /anchor=\{anchor\}/, 'the desktop window grows from the CTA');
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /if \(!attemptKey\.current\) attemptKey\.current = newIdempotencyKey\(\)/);
  assert.match(page, /attemptKey\.current = null/, 'a new attempt must get a new key');
  assert.match(page, /\/api\/memberships\/quote\?planId=/, 'every figure comes from the server quote');
  assert.equal(page.includes('setTimeout'), false, 'no auto-dismiss timers: the result persists until closed');
  assert.match(page, /useBusy\(phase === 'busy', 'subscribe'\)/, 'the charge holds the app-wide busy screen');
  assert.match(read(`${COMPONENT_DIR}/BnplPanel.tsx`), /useBusy\(busy !== null, 'subscribe'\)/, 'so does a BNPL repayment');
});

test('every button states its type and icon-only buttons are labelled', () => {
  for (const f of pageFiles()) {
    const src = read(f);
    const buttons = (src.match(/<button\b/g) || []).length;
    const typed = (src.match(/type="button"/g) || []).length;
    assert.equal(typed, buttons, `${f}: ${buttons} <button> tags but ${typed} type="button" declarations`);
  }
  const card = read(`${COMPONENT_DIR}/LevoCard.tsx`);
  assert.match(card, /aria-label=\{show \? t\('hideCardNumber'\) : t\('showCardNumber'\)\}/);
});

test('a failed plans fetch is an error with a retry, not "no plans"; the skeleton says what it is waiting for', () => {
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /setPlansError\(/);
  const cards = read(`${COMPONENT_DIR}/TierCards.tsx`);
  assert.match(cards, /<ErrorState error=\{error\} onRetry=\{onRetry\}/);
  assert.match(cards, /t\('loadingPlans'\)/);
  for (const lang of ['en', 'ar', 'ckb'] as const) {
    const block = translations[lang] as Record<string, string>;
    assert.ok(block.loadingPlans && block.quoteChangedNotice, `${lang} is missing a page string`);
    assert.equal('plansLoadFailed' in block, false);
    assert.equal('alsoPrepaid' in block, false);
  }
});

test('benefitPro1 says PLUS, the way every other surface does', () => {
  for (const lang of ['en', 'ar', 'ckb'] as const) {
    const v = (translations[lang] as Record<string, string>).benefitPro1;
    assert.equal(/\bPlus\b/.test(v), false, `${lang}.benefitPro1 says "Plus": ${v}`);
  }
  assert.match(translations.en.benefitPro1, /PLUS/);
  assert.match(translations.ckb.benefitPro1, /PLUS/);
});

test('logical properties only: no physical corner or side on the page', () => {
  for (const f of pageFiles()) {
    assert.equal(/rounded-(bl|br|tl|tr)-|\b(ml|mr|pl|pr)-\d/.test(read(f)), false, `${f} uses a physical side`);
  }
});

test('the Header draws every paid tier in its own colour, through the shared table', () => {
  const header = read('src/components/Header.tsx');
  assert.match(header, /tierMetaFor\(/);
  assert.equal(/subTier === 'pro'\s*\?/.test(header), false, 'no pro/else colour ternary at all');
  for (const hex of ['#B03142', '#59A846', '#7f1d1d', '#a3e635']) {
    assert.equal(header.includes(hex), false, `${hex} is hard-coded in the Header instead of coming from tierMeta`);
  }
});

test('the benefit sentences never render an empty gap when a figure is unknown', () => {
  const src = read(`${COMPONENT_DIR}/benefitLines.ts`);
  assert.equal(/\$\{(threshold|subsidy) *\|\| *''\}/.test(src), false, 'an interpolation can still be blank');
  assert.match(src, /توصيل مجاني على الطلبات المؤهلة/);
  assert.match(src, /Free delivery on eligible orders/);
  for (const name of ['threshold', 'subsidy'] as const) {
    for (const m of src.matchAll(new RegExp(`\\$\\{${name}\\}`, 'g'))) {
      const before = src.slice(Math.max(0, m.index! - 900), m.index!);
      assert.match(before, new RegExp(`\\b${name}\\s*(\\?|&&|!==\\s*null)`), `an interpolation of ${name} is not guarded by a null check`);
    }
  }
  assert.match(src, /if \(!benefits\) return \[\];/);
});

test('the printer gift is not advertised: it is granted by hand now', () => {
  for (const f of customerFiles().filter((x) => !x.endsWith('types.ts'))) {
    assert.equal(read(f).includes('printer_gift'), false, `${f} still reads features.printer_gift`);
  }
});

test('the PRO card no longer advertises a referral reward', () => {
  const src = allSource();
  assert.equal(/مكافأة إحالة|Referral reward/.test(src), false);
});

test('PRO BNPL has a real customer account, approval, ledger and repayment surface', () => {
  const panel = read(`${COMPONENT_DIR}/BnplPanel.tsx`);
  assert.match(panel, /\/api\/memberships\/bnpl'/);
  assert.match(panel, /\/api\/memberships\/bnpl\/request/);
  assert.match(panel, /\/api\/memberships\/bnpl\/repay/);
  assert.match(panel, /newIdempotencyKey\(\)/);
  assert.match(panel, /!activePro && !hasHistory/);
  assert.match(read('src/pages/Subscription.tsx'), /activePro=\{mine\.status\.active && mine\.status\.tier === 'pro'\}/);
});

test('the purchase result is announced and takes focus; a machine state never reaches the screen', () => {
  const confirm = read(`${COMPONENT_DIR}/PurchaseConfirm.tsx`);
  assert.match(confirm, /<div role="status" data-confirm-result="ok"/);
  assert.match(confirm, /<div role="alert" data-confirm-result="err"/);
  assert.match(confirm, /ref=\{headingRef\} tabIndex=\{-1\}/);
  assert.match(confirm, /headingRef\.current\?\.focus\(\)/);
  assert.match(confirm, /membershipStateLabel\(result\.res\.membership\.state, lang\)/);
  assert.equal(confirm.includes('${result.res.membership.state}'), false, 'the raw state string is still printed');
  assert.equal(membershipStateLabel('pending_payment', 'en'), 'Pending payment');
  assert.equal(membershipStateLabel('expired', 'ckb'), 'بەسەرچووە');
  assert.equal(membershipStateLabel('whatever', 'en'), 'whatever');
  assert.match(read(`${COMPONENT_DIR}/MembershipLedger.tsx`), /membershipStateLabel\(m\.state, lang\)/);
});

test('a <dl> holds only its groups: the notes and the wallet link follow it', () => {
  const src = read(`${COMPONENT_DIR}/CheckoutBar.tsx`);
  const dlOpen = src.indexOf('<dl');
  const dlClose = src.indexOf('</dl>');
  assert.ok(dlOpen > 0 && dlClose > dlOpen);
  const inside = src.slice(dlOpen, dlClose);
  assert.equal(inside.includes('<p'), false, 'a <p> is a direct child of the <dl>');
  assert.equal(inside.includes('<Link'), false, 'a <Link> is inside the <dl>');
  assert.ok(src.indexOf('to="/wallet"') > dlClose, 'the shortfall link follows the list');
  assert.ok(src.indexOf("t('upgradeCreditNote')") > dlClose, 'the credit note follows the list');
});

test('Home and End move the focus with the value in the segmented control', () => {
  const seg = read('src/components/ui/Segmented.tsx');
  assert.match(seg, /e\.key === 'Home'[\s\S]{0,120}choose\(/);
  assert.match(seg, /e\.key === 'End'[\s\S]{0,160}choose\(/);
});

test('the admin plan row announces its save result', () => {
  assert.match(read('src/components/AdminMemberships.tsx'), /role=\{note\.ok \? 'status' : 'alert'\}/);
});

test('after the launch the admin can still reach the leftover sweep, and sees how many are waiting', () => {
  const admin = read('src/components/AdminMemberships.tsx');
  assert.match(admin, /setPrepaidCount\(Number\(d\.prepaid_count\) \|\| 0\)/);
  assert.match(admin, /disabled=\{!launch \|\| \(launch\.activated && prepaidCount === 0\)\}/);
  assert.equal(admin.includes('disabled={!launch || launch.activated}'), false, 'the button dies with the launch again');
  assert.match(admin, /launch\?\.activated \? ps\.sweep\(prepaidCount\) : ps\.activate/);
  assert.match(admin, /setDeferredCount\(Number\(d\.deferred_count\) \|\| 0\)/);
  assert.match(admin, /deferredCount > 0 && <p[^>]*>\{ps\.deferred\(deferredCount\)\}/);
});

test('the confirmation carries the displayed figures and a changed quote is shown, not charged', () => {
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /charge_iqd: quote\.charge_iqd, charge_usd_cents: quote\.charge_usd_cents/);
  assert.match(page, /code === 'QUOTE_CHANGED'/);
  assert.match(page, /setQuoteChanged\(true\)/);
  assert.match(page, /setPhase\('review'\)/);
  const confirm = read(`${COMPONENT_DIR}/PurchaseConfirm.tsx`);
  assert.match(confirm, /role="status" data-quote-changed/);
  assert.match(confirm, /t\('quoteChangedNotice'\)/);
  assert.equal(allSource().includes('pending_tiers'), false);
});

// ------------------------------------------------ «خصم 10% حتى 100,000 …»

const discountRule = (over: Partial<BenefitDiscountRule>): BenefitDiscountRule => ({
  rule_id: 'r', scope: 'global', target_id: null, target_name_ar: '', target_name_en: '',
  discount_mode: 'percent', percent: 10, fixed_iqd: null, max_discount_iqd: null,
  cap_scope: null, max_quantity: null, min_subtotal_iqd: null, label: null, product_count: null, ...over,
});
const tierBenefits = (discounts: BenefitDiscountRule[]): TierBenefits => ({ discounts, free_shipping: null, cod_tax_exempt: false });
const ar: Parameters<typeof shoppingLines>[2] = (a) => a;
const en: Parameters<typeof shoppingLines>[2] = (_a, e) => e;
const iqd: Parameters<typeof shoppingLines>[3] = (n) => `${n.toLocaleString('en-US')} د.ع`;
const printers = { scope: 'category' as const, target_id: 'c1', target_name_ar: 'الطابعات', target_name_en: 'Printers' };

test('the owner\'s template: «خصم 10% حتى 100,000 لكل وحدة على الطابعات»', () => {
  // A group of per-product rules, as the server now publishes it.
  assert.deepEqual(
    shoppingLines('pro', tierBenefits([discountRule({ ...printers, product_count: 150, max_discount_iqd: 100000, cap_scope: 'per_unit' })]), ar, iqd),
    ['خصم 10% حتى 100,000 د.ع لكل وحدة على الطابعات']
  );
  assert.equal(
    discountLine(discountRule({ ...printers, max_discount_iqd: 100000, cap_scope: 'per_unit' }), en, iqd),
    '10% off, up to 100,000 د.ع per unit, on Printers'
  );
  // No ceiling: no «حتى».
  assert.equal(discountLine(discountRule({ ...printers, percent: 8 }), ar, iqd), 'خصم 8% على الطابعات');
  // The whole store names itself instead of trailing off after the figure.
  assert.equal(discountLine(discountRule({ max_discount_iqd: 100000, cap_scope: 'per_unit' }), ar, iqd), 'خصم 10% حتى 100,000 د.ع لكل وحدة على جميع المنتجات');
  // A fixed amount with a ceiling at or above it says the amount once.
  assert.equal(
    discountLine(discountRule({ ...printers, discount_mode: 'fixed', percent: null, fixed_iqd: 25000, max_discount_iqd: 25000, cap_scope: 'per_unit' }), ar, iqd),
    'خصم 25,000 د.ع لكل وحدة على الطابعات'
  );
  // A per-order ceiling is one budget for the whole order, as the cart says.
  assert.equal(
    discountLine(discountRule({ ...printers, max_discount_iqd: 50000, cap_scope: 'per_order' }), ar, iqd),
    'خصم 10% حتى 50,000 د.ع لكل طلب على الطابعات'
  );
  // What narrows the rule follows a dash.
  assert.equal(
    discountLine(discountRule({ ...printers, max_quantity: 2, min_subtotal_iqd: 500000 }), ar, iqd),
    'خصم 10% على الطابعات — لأول 2 من الكمية، للطلبات من 500,000 د.ع فأكثر'
  );
});

test('one Arabic sentence, one digit system: the percentage takes the digits the money beside it takes', () => {
  // `money` (formatIqd) formats with the device's locale; on an Arabic device
  // that is Arabic-Indic, and a raw «10%» beside «١٠٠٬٠٠٠ د.ع» mixed the two.
  const orig = Number.prototype.toLocaleString;
  const indic = (n: number) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
  Number.prototype.toLocaleString = function (this: number, ...args: unknown[]) {
    return args.length ? orig.apply(this, args as []) : indic(this.valueOf());
  };
  try {
    const money = (n: number) => `${n.toLocaleString()} د.ع`;
    const rule = discountRule({ ...printers, max_discount_iqd: 100000, cap_scope: 'per_unit', max_quantity: 2 });
    const line = discountLine(rule, ar, money)!;
    assert.equal(line, 'خصم ١٠% حتى ١٠٠٠٠٠ د.ع لكل وحدة على الطابعات — لأول ٢ من الكمية');
    assert.equal(/[0-9]/.test(line), false, `Latin digits in «${line}»`);
    const cell = sectionLines({ key: 'id:c1', name: 'الطابعات', rules: [rule] }, ar, money, true);
    assert.equal(cell.some((c) => /[0-9]/.test(c)), false, `Latin digits in «${cell.join(' | ')}»`);
  } finally {
    Number.prototype.toLocaleString = orig;
  }
});

test('the separator between a figure and its duration is not a middle dot in Arabic or Sorani — it reads as ٠', () => {
  assert.equal(durationSep('ar'), '، ');
  assert.equal(durationSep('ckb'), '، ');
  assert.equal(durationSep('en'), ' · ');
  for (const f of ['CheckoutBar.tsx', 'TierCards.tsx', 'PurchaseConfirm.tsx', 'MembershipLedger.tsx']) {
    const src = read(`${COMPONENT_DIR}/${f}`);
    assert.equal(/·\s*\{durationLabel\(/.test(src), false, `${f} puts a middle dot before the duration`);
    assert.equal(/\{' · '\}/.test(src), false, `${f} hardcodes a middle dot`);
    assert.match(src, /\{durationSep\(lang\)\}/, `${f} uses durationSep`);
  }
});

test('the PRO card promises PLUS, not PREMIUM: a PREMIUM pricing rule never applies to a PRO member', () => {
  const lines = tierHighlights('pro', { contract: null, benefits: null, points: null, loc: ar, money: iqd } as Parameters<typeof tierHighlights>[1]);
  assert.equal(lines.some((l) => l.includes('PREMIUM')), false, lines.join(' | '));
  assert.ok(lines.includes('يشمل جميع مزايا PLUS'));
});

test('a section lists at most three offers, then its honest ceiling — never one line per product', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => discountRule({ ...printers, rule_id: `p${i}`, product_count: 1, percent: 5 + i }));
  assert.equal(shoppingLines('pro', tierBenefits(many(3)), ar, iqd).length, 3);
  assert.deepEqual(shoppingLines('pro', tierBenefits(many(40)), ar, iqd), ['خصم حتى 44% على الطابعات']);
  // Mixed modes have no single ceiling to state, so no figure is invented.
  const mixed = [
    ...many(3),
    discountRule({ ...printers, rule_id: 'f', discount_mode: 'fixed', percent: null, fixed_iqd: 5000, product_count: 1 }),
  ];
  const line = shoppingLines('pro', tierBenefits(mixed), ar, iqd);
  assert.deepEqual(line, ['خصومات العضوية على الطابعات']);
  assert.equal(/\d/.test(line[0]), false);
});

test('a product is never named, whatever an older server still sends', () => {
  const legacy = Array.from({ length: 50 }, (_, i) =>
    discountRule({ rule_id: `p${i}`, scope: 'product', target_id: `prod-${i}`, target_name_ar: '', target_name_en: '', max_discount_iqd: 100000, cap_scope: 'per_unit' })
  );
  const lines = shoppingLines('pro', tierBenefits(legacy), ar, iqd);
  assert.deepEqual(lines, ['خصم 10% حتى 100,000 د.ع لكل وحدة على المنتجات المؤهلة']);
  // A product group with no section is still a benefit; a section that lost its name is not sayable.
  assert.deepEqual(shoppingLines('pro', tierBenefits([discountRule({ scope: 'category', product_count: 3, percent: 7 })]), ar, iqd), ['خصم 7% على المنتجات المؤهلة']);
  assert.deepEqual(shoppingLines('pro', tierBenefits([discountRule({ scope: 'category', target_id: 'gone', percent: 7 })]), ar, iqd), []);
});

test('an amount stays one unit in either direction on screen', () => {
  const rtl = isolatedMoney(iqd, 'rtl')(29000);
  const ltr = isolatedMoney(iqd, 'ltr')(29000);
  assert.equal(rtl, '⁧29,000 د.ع⁩');
  assert.equal(ltr, '⁦29,000 د.ع⁩');
});

// ------------------------------------------------------ «مقارنة الخطط»

/** The contract GET /plans sends: ENTITLEMENT_MINIMUM_TIER resolved per tier. */
async function realContract() {
  const { ENTITLEMENT_MINIMUM_TIER, entitlementSnapshot } = await import('../worker/lib/entitlements');
  const tiers = { plus: {}, prime: {}, pro: {} } as Record<'plus' | 'prime' | 'pro', Record<string, boolean>>;
  for (const tier of ['plus', 'prime', 'pro'] as const) {
    tiers[tier] = entitlementSnapshot({ tier, active: true, expires_at: null, pending_launch: null, gated_benefits: [] });
  }
  return { minimum: ENTITLEMENT_MINIMUM_TIER, tiers };
}

test('the comparison ticks come from the server\'s contract, so inheritance is a tick in every higher column', async () => {
  const { tiers: contract } = await realContract();
  const model = buildCompare({
    tiers: ['plus', 'prime', 'pro'],
    contract,
    benefits: {
      prime: { discounts: [discountRule({ ...printers, percent: 5, max_discount_iqd: 25000, cap_scope: 'per_unit' })], free_shipping: { rule_id: 's', threshold_iqd: 100000, methods: ['standard'], max_subsidy_iqd: null }, cod_tax_exempt: false },
      pro: { discounts: [discountRule({ ...printers, product_count: 12, max_discount_iqd: 100000, cap_scope: 'per_unit' })], free_shipping: { rule_id: 't', threshold_iqd: 75000, methods: null, max_subsidy_iqd: null }, cod_tax_exempt: true },
    },
    features: { printer_gift: false, preorder_gift: false },
    points: { plus: 100, prime: 150, pro: 200 },
    loc: ar,
    money: iqd,
  });
  const rows = new Map(model.groups.flatMap((g) => g.rows).map((r) => [r.key, r]));
  const kinds = (key: string) => (['plus', 'prime', 'pro'] as const).map((t) => rows.get(key)!.cells[t].kind);

  // Inherited: the store is PLUS's and every higher tier keeps it.
  assert.deepEqual(kinds('merchantStore'), ['yes', 'yes', 'yes']);
  // BNPL stays PRO-only.
  assert.deepEqual(kinds('bnpl'), ['no', 'no', 'yes']);
  assert.deepEqual(kinds('priorityService'), ['no', 'no', 'yes']);
  // The discount row is the section, with each tier's own offer.
  const printersRow = rows.get('discount:id:c1')!;
  assert.equal(printersRow.label, 'خصم على الطابعات');
  assert.deepEqual(printersRow.cells.plus, { kind: 'no' });
  assert.deepEqual(printersRow.cells.prime, { kind: 'text', lines: ['5% حتى 25,000 د.ع لكل وحدة'] });
  assert.deepEqual(printersRow.cells.pro, { kind: 'text', lines: ['10% حتى 100,000 د.ع لكل وحدة'] });
  // Figures only from the server: the points multiplier is its number.
  assert.deepEqual(rows.get('points')!.cells.prime, { kind: 'text', lines: ['×1.5'] });
  assert.deepEqual(kinds('cod_tax'), ['no', 'no', 'yes']);
  // A gift that is switched off has no row.
  assert.equal(rows.has('preorder_gift'), false);
  // Conditions are footnotes, and every footnote is referenced by a row.
  const referenced = new Set([...rows.values()].map((r) => r.note).filter(Boolean));
  assert.equal(referenced.size, model.notes.length);
  // «الفروقات فقط» hides a row every tier shares, and keeps one they do not.
  assert.equal(rowIsUniform(rows.get('merchantStore')!, ['plus', 'prime', 'pro']), true);
  assert.equal(rowIsUniform(rows.get('bnpl')!, ['plus', 'prime', 'pro']), false);
});

test('each card says three things it is for, from the same data — BNPL only on PRO', async () => {
  const { tiers: contract } = await realContract();
  const input = { contract, benefits: null, points: { plus: 100, prime: 150, pro: 200 }, loc: ar, money: iqd };
  for (const tier of ['plus', 'prime', 'pro'] as const) {
    const lines = tierHighlights(tier, input);
    assert.ok(lines.length > 0 && lines.length <= 3, `${tier}: ${lines.length} highlights`);
    assert.equal(lines.some((l) => l.includes('BNPL')), tier === 'pro', `${tier} BNPL line`);
  }
  // No rule, no figure: without benefits PREMIUM states no discount and no threshold.
  assert.equal(tierHighlights('prime', input).some((l) => /خصم|توصيل/.test(l)), false);
});

// -------------------------------------------- the checkout, rendered for real

const plan = (id: string, tier: 'plus' | 'prime' | 'pro', price: number): ApiPlan => ({
  id, tier, duration_months: 12, price_iqd: price, purchasable: true, per_month_iqd: null, sort: 1,
});
const okQuote = (p: ApiPlan, over: Partial<Extract<PurchaseQuote, { ok: true }>> = {}): PurchaseQuote => ({
  ok: true,
  plan: p,
  price_iqd: p.price_iqd as number,
  credit_iqd: 0,
  charge_iqd: p.price_iqd as number,
  exchange_rate: 1400,
  charge_usd_cents: 7071,
  balance_usd_cents: 3571,
  shortfall_usd_cents: 0,
  balance_iqd: 1234567,
  shortfall_iqd: 0,
  activate_now: true,
  launch_at: null,
  expires_at: '2027-09-23T00:00:00.000Z',
  upgrade_from_tier: null,
  ...over,
});

function renderBar(p: ApiPlan, quote: PurchaseQuote | null): string {
  const bar = createElement(CheckoutBar, {
    plan: p,
    standing: 'open',
    quote,
    quoteLoading: false,
    quoteError: null,
    onRetryQuote: () => {},
    isGuest: false,
    busy: false,
    onSubscribe: () => {},
    ctaRef: { current: null },
    currentExpiry: null,
  });
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, {
      value: {
        isAuthenticated: true,
        user: null,
        login: async () => {},
        loginWithGoogle: async () => {},
        register: async () => {},
        refreshUser: async () => {},
        logout: async () => {},
        isLoaded: true,
      },
      children: createElement(WalletProvider, {
        children: createElement(CurrencyProvider, {
          children: createElement(LanguageProvider, { children: createElement(MemoryRouter, null, bar) }),
        }),
      }),
    })
  );
}

test('a quote for the previous plan is never shown under the new one', () => {
  const twelve = plan('plus_12mo', 'plus', 29000);
  const one = plan('plus_1mo', 'plus', 4500);
  // Just switched from 12 months to 1: the quote in hand is still the 12-month one.
  const stale = renderBar(one, okQuote(twelve));
  assert.equal(stale.includes(formatIqd(1234567)), false, 'the previous plan\'s wallet figures are on screen');
  assert.match(stale, new RegExp(translations.ar.checkingQuote), 'it reads as still loading');
  assert.match(stale, /data-subscribe-cta[^>]*disabled/, 'and cannot be confirmed');
  // The same quote under its own plan is shown.
  assert.equal(renderBar(twelve, okQuote(twelve)).includes(formatIqd(1234567)), true);
  // And the page clears it the moment the plan changes, keeping it only for a same-plan refresh.
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /if \(quotedPlan\.current !== quotePlanId\) \{\s*quotedPlan\.current = quotePlanId;\s*setQuote\(null\);/);
});

test('the wallet is stated in dinars — the figure /wallet prints — never in dollars', () => {
  const pro = plan('pro_12mo', 'pro', 499000);
  const short = renderBar(pro, okQuote(pro, { balance_iqd: 50000, shortfall_iqd: 449000, shortfall_usd_cents: 32072 }));
  assert.equal(short.includes(formatIqd(50000)), true, 'the balance in dinars');
  assert.equal(short.includes(formatIqd(449000)), true, 'the shortfall in dinars');
  assert.equal(/\$\d/.test(short), false, 'a dollar figure is on the bar');
  assert.match(short, /href="\/wallet"/, 'the way to top up');
  assert.match(short, /data-subscribe-cta[^>]*disabled/, 'and the purchase cannot start');
  // The confirmation keeps the dollar debit as one quiet line only.
  const confirm = read(`${COMPONENT_DIR}/PurchaseConfirm.tsx`);
  assert.equal((confirm.match(/formatUsdCents\(ok\.charge_usd_cents\)/g) || []).length, 1);
  assert.match(confirm, /data-usd-line/);
  assert.match(confirm, /ok\.balance_iqd !== undefined \? money\(ok\.balance_iqd\)/);
});

test('the current card and a card already included are information, not an amber error', () => {
  const pro = plan('pro_12mo', 'pro', 499000);
  const current = renderBar(pro, { ok: false, code: 'ALREADY_SUBSCRIBED', message: 'x', plan: pro });
  assert.match(current, new RegExp(translations.ar.yourCurrentPlan));
  assert.equal(current.includes('text-warning'), false);
  const plus = plan('plus_12mo', 'plus', 29000);
  const included = renderBar(plus, { ok: false, code: 'DOWNGRADE_BLOCKED', message: 'x', plan: plus });
  assert.match(included, new RegExp(translations.ar.includedInYours));
});
