/**
 * /subscription — what the page is allowed to say.
 *
 * The owner's rule is that nothing shown to a customer may be fabricated. The
 * page used to list benefits nothing enforced (daily game tickets, PRO-only
 * products, advertising eligibility, a 3D-printable card) and called a PRIME
 * member "PLUS" in four places. These static checks pin the corrections:
 * they read the source the way a reviewer would, so a copy-paste from an old
 * branch fails here rather than on a customer's screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { translations } from '../src/translations';
import { cardNumberFor, maskCardNumber, CARD_PLACEHOLDER } from '../src/components/subscription/cardNumber';
import { TIER_META, membershipStateLabel, tierLabel } from '../src/components/subscription/tierMeta';
import { bestValuePlanId } from '../src/components/subscription/PlanPicker';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const COMPONENT_DIR = 'src/components/subscription';
const pageFiles = () => [
  'src/pages/Subscription.tsx',
  'src/components/ui/Segmented.tsx',
  ...readdirSync(join(ROOT, COMPONENT_DIR)).map((f) => `${COMPONENT_DIR}/${f}`),
];
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

// ------------------------------------------------------------- three tiers

test('all three tiers are named, and PREMIUM is never a fallback to PLUS', () => {
  assert.deepEqual(
    Object.values(TIER_META).map((m) => m.label),
    ['PLUS', 'PREMIUM', 'PRO']
  );
  assert.equal(tierLabel('prime'), 'PREMIUM');
  assert.equal(tierLabel('plus'), 'PLUS');
  assert.equal(tierLabel('pro'), 'PRO');

  // The binary ternary that mislabelled PRIME must not exist on any surface
  // that names a tier.
  for (const f of [...pageFiles(), 'src/pages/Profile.tsx', 'src/components/Header.tsx']) {
    const src = read(f);
    assert.equal(/'PRO'\s*:\s*'PLUS'/.test(src), false, `${f} still labels every non-PRO tier as PLUS`);
    assert.equal(/=== 'pro' \? 'PRO'/.test(src), false, `${f} still decides the label with a pro/else test`);
  }
  // The colour table has no grey fallback for a paid tier: every paid tier
  // has its own card face, glow and chip.
  for (const m of Object.values(TIER_META)) {
    assert.ok(m.cardFace && m.glow && m.chip && m.indicator && m.ring, `${m.id} is missing a style`);
  }
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

test('"best value" is only claimed when it is arithmetically true — on the figure the cards show', () => {
  // The server's shape: per_month_iqd is Math.round(price / months), computed there.
  const plan = (id: string, months: number, price: number | null) => ({
    id,
    tier: 'plus' as const,
    duration_months: months,
    price_iqd: price,
    purchasable: price !== null,
    per_month_iqd: price === null ? null : Math.round(price / months),
    sort: 1,
  });
  // PLUS 1/3/6/12 at the seeded prices: 12 months is the cheapest per month.
  assert.equal(bestValuePlanId([plan('a', 1, 4500), plan('b', 3, 10000), plan('c', 6, 17000), plan('d', 12, 29000)]), 'd');
  // A lone plan has nothing to be better than.
  assert.equal(bestValuePlanId([plan('x', 12, 99000)]), null);
  // A tie is not a best value.
  assert.equal(bestValuePlanId([plan('a', 1, 1000), plan('b', 2, 2000)]), null);
  // Two cards that READ the same per-month figure (2,417 and 2,416.67 → 2,417)
  // are a tie too: the badge compares what is displayed, not the unrounded
  // ratio the customer cannot see.
  assert.equal(bestValuePlanId([plan('a', 1, 2417), plan('b', 12, 29000)]), null);
  // Unpriced plans do not take part.
  assert.equal(bestValuePlanId([plan('a', 1, 1000), plan('b', 12, null)]), null);
  // And the page does no per-month arithmetic of its own.
  for (const f of ['src/components/subscription/PlanPicker.tsx', 'src/components/subscription/PlanSummary.tsx']) {
    const src = read(f);
    assert.equal(src.includes('Math.round('), false, `${f} computes a figure in the browser`);
    assert.match(src, /per_month_iqd/, `${f} should read the server's per_month_iqd`);
  }
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
  // The card's formerly hardcoded English strings are now keys.
  for (const k of ['levoId', 'tierWord', 'validThru', 'freeLabel', 'chooseCard', 'bestValue', 'confirmPurchase']) {
    assert.ok(keys.has(k), `the page should use t('${k}')`);
  }
});

test('the three language blocks have identical key sets', () => {
  const en = Object.keys(translations.en).sort();
  const ar = Object.keys(translations.ar).sort();
  const ckb = Object.keys(translations.ckb).sort();
  assert.deepEqual(ar, en, 'ar block differs from en');
  assert.deepEqual(ckb, en, 'ckb block differs from en');
});

// ---------------------------------------------------------- house rules

test('the selector is a radio group with a moving indicator on the house spring', () => {
  const seg = read('src/components/ui/Segmented.tsx');
  assert.match(seg, /role="radiogroup"/);
  assert.match(seg, /role="radio"/);
  assert.match(seg, /aria-checked/);
  assert.match(seg, /min-h-11/);
  assert.match(seg, /layoutId=/);
  assert.match(seg, /useMotion\(\)/);
  assert.match(seg, /spring\('quick'\)/);
  assert.match(read('src/components/subscription/PlanPicker.tsx'), /<Segmented/);
});

test('the purchase goes through the house window, never a browser dialog', () => {
  const src = allSource();
  assert.equal(/window\.(confirm|alert|prompt)\(/.test(src), false, 'no browser dialogs');
  const confirm = read('src/components/subscription/PurchaseConfirm.tsx');
  assert.match(confirm, /from '\.\.\/ui\/Overlay'/);
  assert.match(confirm, /<Sheet/);
  assert.match(confirm, /<Overlay/);
  assert.match(confirm, /anchor=\{anchor\}/, 'the desktop window grows from the CTA');
  // One key per attempt, reused only for a retry of that attempt.
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /if \(!attemptKey\.current\) attemptKey\.current = newIdempotencyKey\(\)/);
  assert.match(page, /attemptKey\.current = null/, 'a new attempt must get a new key');
  assert.match(page, /\/api\/memberships\/quote\?planId=/, 'every figure comes from the server quote');
  assert.equal(page.includes('setTimeout'), false, 'no auto-dismiss timers: the result persists until closed');
});

test('every button states its type and icon-only buttons are labelled', () => {
  for (const f of pageFiles()) {
    const src = read(f);
    // Attribute lists hold arrow functions with their own `>`, so count the
    // openings against the type declarations instead of parsing the tag.
    const buttons = (src.match(/<button\b/g) || []).length;
    const typed = (src.match(/type="button"/g) || []).length;
    assert.equal(typed, buttons, `${f}: ${buttons} <button> tags but ${typed} type="button" declarations`);
  }
  const card = read('src/components/subscription/LevoCard.tsx');
  assert.match(card, /aria-label=\{show \? t\('hideCardNumber'\) : t\('showCardNumber'\)\}/);
});

test('a failed plans fetch is an error with a retry, not "no plans"', () => {
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /setPlansError\(/);
  assert.equal(/catch\(\(\) => \{ if \(!cancelled\) setPlans\(\[\]\); \}\)/.test(page), false);
  const picker = read('src/components/subscription/PlanPicker.tsx');
  assert.match(picker, /<ErrorState error=\{error\} onRetry=\{onRetry\}/);
});

// ------------------------------------------------- adversarial-review fixes

test('the plans skeleton announces "Loading plans…", not the quote check', () => {
  const picker = read('src/components/subscription/PlanPicker.tsx');
  assert.match(picker, /t\('loadingPlans'\)/);
  assert.equal(/aria-busy="true"[\s\S]{0,200}t\('checkingQuote'\)/.test(picker), false, 'the skeleton still says "Checking price and balance…"');
  for (const lang of ['en', 'ar', 'ckb'] as const) {
    const block = translations[lang] as Record<string, string>;
    assert.ok(block.loadingPlans && block.loadingPlans.length > 0, `${lang}.loadingPlans missing`);
    assert.equal('plansLoadFailed' in block, false, `${lang}.plansLoadFailed is unused and should be gone`);
    assert.equal('alsoPrepaid' in block, false, `${lang}.alsoPrepaid describes a rule that no longer exists`);
    assert.ok(block.quoteChangedNotice && block.quoteChangedNotice.length > 0, `${lang}.quoteChangedNotice missing`);
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

test('logical properties: no physical corner radius on the end-anchored blob', () => {
  for (const f of pageFiles()) {
    assert.equal(read(f).includes('rounded-bl-'), false, `${f} uses a physical corner (rounded-bl-)`);
  }
  assert.match(read('src/components/subscription/BenefitsSection.tsx'), /rounded-es-\[100px\]/);
});

test('the Header draws every paid tier in its own colour, through the shared table', () => {
  const header = read('src/components/Header.tsx');
  assert.match(header, /tierMetaFor\(/);
  assert.equal(/subTier === 'pro' \? '#B03142'/.test(header), false, 'PRIME was drawn in PLUS colours by a pro/else test');
  assert.equal(/subTier === 'pro'\s*\?/.test(header), false, 'no pro/else colour ternary at all');
  for (const hex of ['#B03142', '#59A846', '#7f1d1d', '#a3e635']) {
    assert.equal(header.includes(hex), false, `${header.includes(hex) ? hex : ''} is hard-coded in the Header instead of coming from tierMeta`);
  }
  for (const m of Object.values(TIER_META)) assert.ok(m.accentDeep && m.accentLight, `${m.id} lacks gradient stops`);
});

/**
 * THE PAGE NEVER RENDERS A FIGURE IT DOES NOT HAVE.
 *
 * This test used to pin a hardcoded fallback sentence — "the store's approved
 * threshold" — which the page printed whenever it did not know the number. The
 * benefits mandate removed that sentence on purpose: §22 requires this page to
 * read the live configuration, and a fallback phrase is the same promise in
 * words rather than digits. The guarantee it was really protecting survives
 * and is asserted here instead: no threshold is ever interpolated unless it
 * exists, and where one is missing the copy says the figure-less thing rather
 * than leaving a gap.
 */
test('the benefits copy never renders an empty gap when the thresholds are unknown', () => {
  const src = read('src/components/subscription/BenefitsSection.tsx');
  // No interpolation may fall back to an empty string.
  assert.equal(/\? *formatIqd\([^)]*\) *: *''/.test(src), false, "a threshold still defaults to '' — an empty gap");
  assert.equal(/\$\{(threshold|subsidy) *\|\| *''\}/.test(src), false, 'an interpolation can still be blank');

  // A missing threshold takes figure-less wording in every language the line
  // is written in, rather than printing nothing or an empty span.
  assert.match(src, /توصيل مجاني على الطلبات المؤهلة/);
  assert.match(src, /Free delivery on eligible orders/);

  // EVERY interpolation of a figure sits inside a branch that has already
  // established the figure is there. `threshold` and `subsidy` are the two
  // locals the copy is built from, and both are `string | null`.
  for (const name of ['threshold', 'subsidy'] as const) {
    for (const m of src.matchAll(new RegExp(`\\$\\{${name}\\}`, 'g'))) {
      const before = src.slice(Math.max(0, m.index! - 900), m.index!);
      // `\s` rather than a literal space: the guard is often written across a
      // line break (`head = threshold\n  ? loc(`), and a space-only pattern
      // silently fails to see it — which would have made this assertion a
      // test that passes for the wrong reason.
      assert.match(
        before,
        new RegExp(`\\b${name}\\s*(\\?|&&|!==\\s*null)`),
        `an interpolation of ${name} is not guarded by a null check`
      );
    }
  }

  // And a tier with no rule at all contributes no line, rather than a claim.
  assert.match(src, /if \(!benefits\) return \[\];/);
});

test('the optional printer gift is a note under PLUS, not a fabricated core benefit', () => {
  const src = read('src/components/subscription/BenefitsSection.tsx');
  assert.equal(/plusLines\.push\(\{[\s\S]{0,300}printer purchase/.test(src), false, 'the gift is still pushed into the checkmarked list');
  assert.match(src, /features\?\.printer_gift \?/, 'still gated on features.printer_gift');
  assert.match(src, /note=\{plusNote\}/);
});

test('benefit cards state inheritance, keep BNPL PRO-only, and remove retired teasers', () => {
  const src = read('src/components/subscription/BenefitsSection.tsx');
  assert.match(src, /'Includes all PLUS benefits'/);
  assert.match(src, /'Includes all PLUS and PREMIUM benefits'/);
  const plus = /const plusLines = \[([\s\S]*?)\n {2}\];/.exec(src)?.[1] ?? '';
  const premium = /const premiumLines = \[([\s\S]*?)\n {2}\];/.exec(src)?.[1] ?? '';
  const pro = /const proLines = \[([\s\S]*?)\n {2}\];/.exec(src)?.[1] ?? '';
  assert.equal(/BNPL|Buy Now, Pay Later|ادفع لاحقًا/.test(plus), false, 'PLUS must not tease BNPL');
  assert.equal(/BNPL|Buy Now, Pay Later|ادفع لاحقًا/.test(premium), false, 'PREMIUM must not receive BNPL');
  assert.match(pro, /BNPL/);
  assert.equal(/Coming soon|قريباً|قريبًا|Custom domain|نطاق خاص/.test(src), false);
  assert.match(src, /self-start/);
  assert.match(src, /<details/);
});

test('PRO BNPL has a real customer account, approval, ledger and repayment surface', () => {
  const panel = read('src/components/subscription/BnplPanel.tsx');
  assert.match(panel, /\/api\/memberships\/bnpl'/);
  assert.match(panel, /\/api\/memberships\/bnpl\/request/);
  assert.match(panel, /\/api\/memberships\/bnpl\/repay/);
  assert.match(panel, /newIdempotencyKey\(\)/);
  assert.match(panel, /!activePro && !hasHistory/);
  assert.match(read('src/pages/Subscription.tsx'), /activePro=\{mine\.status\.active && mine\.status\.tier === 'pro'\}/);
});

test('the purchase result is announced and takes focus; a machine state never reaches the screen', () => {
  const confirm = read('src/components/subscription/PurchaseConfirm.tsx');
  assert.match(confirm, /<div role="status"[^>]*data-confirm-result="ok"/);
  assert.match(confirm, /<div role="alert"[^>]*data-confirm-result="err"/);
  assert.match(confirm, /ref=\{headingRef\} tabIndex=\{-1\}/);
  assert.match(confirm, /headingRef\.current\?\.focus\(\)/);
  assert.match(confirm, /membershipStateLabel\(result\.res\.membership\.state, lang\)/);
  assert.equal(confirm.includes('${result.res.membership.state}'), false, 'the raw state string is still printed');
  // The labels are the ledger's own.
  assert.equal(membershipStateLabel('pending_payment', 'en'), 'Pending payment');
  assert.equal(membershipStateLabel('pending_payment', 'ar'), 'بانتظار الدفع');
  assert.equal(membershipStateLabel('expired', 'ckb'), 'بەسەرچووە');
  assert.equal(membershipStateLabel('whatever', 'en'), 'whatever');
  assert.match(read('src/components/subscription/MembershipLedger.tsx'), /membershipStateLabel\(state, lang\)/);
});

test('a <dl> holds only its groups: the notes and the wallet link follow it', () => {
  const src = read('src/components/subscription/PlanSummary.tsx');
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
  assert.equal(/e\.key === 'Home'[\s\S]{0,120}onChange\(/.test(seg), false, 'Home still changes the value without moving focus');
});

test('the admin plan row announces its save result', () => {
  const admin = read('src/components/AdminMemberships.tsx');
  assert.match(admin, /role=\{note\.ok \? 'status' : 'alert'\}/);
});

test('the confirmation carries the displayed figures and a changed quote is shown, not charged', () => {
  const page = read('src/pages/Subscription.tsx');
  assert.match(page, /charge_iqd: quote\.charge_iqd, charge_usd_cents: quote\.charge_usd_cents/);
  assert.match(page, /code === 'QUOTE_CHANGED'/);
  assert.match(page, /setQuoteChanged\(true\)/);
  assert.match(page, /setPhase\('review'\)/, 'a changed quote returns the window to review, not to a result');
  const confirm = read('src/components/subscription/PurchaseConfirm.tsx');
  assert.match(confirm, /data-quote-changed/);
  assert.match(confirm, /t\('quoteChangedNotice'\)/);
  assert.match(confirm, /role="status" data-quote-changed/);
  // The two-reservations note is gone with the rule it described.
  assert.equal(allSource().includes('pending_tiers'), false);
});
