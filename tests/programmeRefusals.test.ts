/**
 * THE PROGRAMME'S REFUSAL CONTRACT — master plan §6.1, critique-2 §6, landed
 * whole in step S1 (packages/contracts/src/costRefusals.ts, spread into
 * src/lib/refusalStrings.ts).
 *
 * Every code the pricing, batch and profit steps will raise is listed once,
 * here, with its three sentences, so no later step can ship a refusal in one
 * language or with the Arabic pasted into the Sorani slot (docs/DECISIONS.md
 * row 183). The server carries `serverMessage(code)` ("ar / en"); the client
 * renders the viewer's language by code.
 *
 * Run: node --import tsx --test tests/programmeRefusals.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_REFUSALS,
  PRODUCT_UNAVAILABLE_SERVER_MESSAGE,
  isCostRefusalCode,
  serverMessage,
  type CostRefusalCode,
} from '../packages/contracts/src/costRefusals';
import { REFUSAL_STRINGS, refusalText } from '../src/lib/refusalStrings';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';

const CODES = Object.keys(COST_REFUSALS) as CostRefusalCode[];

/** §6.1, every code by the area table it comes from, plus the S1 additions. */
const REQUIRED: Record<string, readonly string[]> = {
  'SEC §6': [
    'PRICING_INCOMPLETE',
    'COST_ACCESS_DENIED',
    'OWNER_ONLY',
    'PRIVATE_DELEGATION_DISABLED',
    'SCOPE_ELEVATION_OWNER_ONLY',
    'PROMOTION_STARTS_ASSISTANT',
    'INVESTOR_FLAG_OWNER_ONLY',
    'ROLE_CHANGE_DENIED',
    'OWNER_EMAIL_LOCKED',
    'REAUTH_REQUIRED',
    'GRANT_TARGET_INVALID',
    'GRANT_EXISTS',
  ],
  'S1 user PATCH (security spec §5.2)': ['SELF_DEMOTE', 'OWNER_LOCKED'],
  // The owner chose the most secure option: the verified-owner rule stays, and
  // an unverified owner is told how to verify instead of being locked out.
  'DECISIONS row 185 amendment (2026-10-08)': ['OWNER_EMAIL_UNVERIFIED', 'VERIFY_SIGN_IN_REQUIRED', 'OWNER_FIRST_PROOF_REQUIRED'],
  'critique G-34': ['PRODUCT_CURRENTLY_UNAVAILABLE'],
  'ENG §6.3': ['ENGINE_MANAGED', 'ENGINE_MANAGED_PRICES_KEPT', 'DIRECT_SALE_EXTRA_NOT_ON_STEP'],
  'RUN §6': ['PRICING_INCOMPLETE_KEPT_HIDDEN', 'PRICING_PREVIEW_STALE', 'PRICING_PREVIEW_EXPIRED', 'PRICING_ENGINE_PAUSED', 'COMPOSITION_NOT_PRICEABLE'],
  'IMP §6.3': ['IMPORT_PREVIEW_EXPIRED', 'AUDIT_UNAVAILABLE'],
  'INV §6.6': [
    'FIFO_OVERRIDE_TOO_LATE',
    'FIFO_OVERRIDE_REASON_REQUIRED',
    'FIFO_OVERRIDE_LOT_MISMATCH',
    'FIFO_OVERRIDE_QTY',
    'FIFO_OVERRIDE_NOT_NEEDED',
    'FIFO_OVERRIDE_NOT_DEDUCTED',
    'FIFO_OVERRIDE_REVOKE_REFUSED',
    'FIFO_OVERRIDES_NOT_INSTALLED',
    'SERIAL_LOT_NOT_FIFO',
    'SCAN_ORDER_MISMATCH',
    'SNAPSHOT_MISMATCH',
    'COST_CORRECTIONS_NOT_INSTALLED',
  ],
  'ORD §6': [
    'REOPEN_STOCK_UNAVAILABLE',
    'RETURN_RESOLUTION_RETRY',
    'LOT_OVER_ATTRIBUTED',
    'PREORDER_LINK_NOT_ELIGIBLE',
    'PREORDER_LEGACY_CAPACITY_HOLD',
    'HISTORICAL_RECONCILIATION_NOT_ELIGIBLE',
    'RECONCILIATION_QTY_MISMATCH',
    'PREORDER_AWAITING_BATCH',
  ],
  '§6.1 new and merged': [
    'UNKNOWN_FIELD',
    'IDEMPOTENCY_MISMATCH',
    'PRICING_CHANGED',
    'PRICING_NOT_INSTALLED',
    'PRICING_PREVIEW_REQUIRED',
    'PRICING_PREVIEW_BUSY',
    'PRICING_PREVIEW_INCOMPLETE',
    'PRICING_RUN_REVISION_CHANGED',
    'PRICING_NOT_MANAGED',
    'PRICING_SET_TOO_LARGE',
    'LOT_PRODUCT_MISMATCH',
    'CENTRAL_RATES_MOVED',
  ],
  'critique-2 §6': [
    'PRICING_LARGE_CHANGE_CONFIRM',
    'PRICING_PINS_BELOW_TARGET_ACK',
    'PRICING_RUN_MARK_ERRONEOUS_REFUSED',
    'PRICE_PROTECTION_MANUAL_REVIEW',
    'PREORDER_LINK_SKIP_OWNER_ONLY',
    'OFFER_FIXED_NOT_FOR_ENGINE',
  ],
  // MVP plan V14: §6.1's PRICING_INPUT_INVALID, landed with P1's what-if validation.
  'MVP plan V14 (P1)': ['PRICING_INPUT_INVALID'],
  // L3 `confirm_incomplete`, L4 `measures_confirmed`, and GATE (C52). The two
  // PRICING_GATE_* codes were retired by owner decision 8 (2026-10-09;
  // DECISIONS row 191): there is no gate, the save that completes a product
  // adopts the engine. They stay listed because the contract only grows, and
  // the test at the end of this file holds that nothing raises them.
  'master plan v2 check §3.9': [
    'PRICING_CLEAR_INCOMPLETE_CONFIRM',
    'PRICING_MEASURES_UNCONFIRMED',
    'PRICING_GATE_ITEMS_MISSING',
    'PRICING_GATE_NOT_CONFIRMED',
  ],
  // A non-owner's catalog edit or product save that lost its in-batch answer
  // fence (worker/lib/serialPolicy.ts `serialAnswerFence`).
  'serial scan landing round 4 (R2)': ['SERIAL_FILING_CHANGED'],
  // FX programme plan §8 "New refusal codes" (all of them land with FX-1, so
  // no later FX push ships one in a single language), plus FX_RATE_NOT_SET:
  // a pair the owner tries to confirm, turn off or keep as manual before any
  // rate is in force.
  'FX plan §8': [
    'FX_REFRESH_IN_PROGRESS',
    'FX_REVIEW_NOT_PENDING',
    'FX_PAIR_MANUAL',
    'FX_RATE_OUT_OF_BOUNDS',
    'FX_RATE_NOT_SET',
    'PRICING_FX_RATE_MISSING',
    'FX_SNAPSHOT_IMMUTABLE',
    'FX_REVIEW_STALE',
    'FX_BOUNDS_EXCLUDE_EFFECTIVE',
    'FX_DERIVED_STALE',
    'PRICING_DELTA_CURRENCY_MISMATCH',
    'PRICING_INPUT_REINSERT',
    'BATCH_COST_IMMUTABLE',
  ],
  // P-A of the USD-pricing design (owner brief 2026-10-09, "Accounting
  // Currency"): a promotion in another currency is booked at the rate actually
  // paid, never at the wallet's (fix F3, worker/routes/adminFinanceWorkspace.ts).
  'P-A fix F3': ['PROMOTION_RATE_REQUIRED'],
};

/** §6.1 "Dropped codes": merged into one of the codes above, never raised. */
const DROPPED = [
  'PRICING_OWNER_ONLY',
  'PRICING_PRIVATE_REQUIRED',
  'PRICE_NOT_READY',
  'PRODUCT_NOT_AVAILABLE_NOW',
  'PRICING_MANAGED',
  'PRICE_MANAGED_BY_ENGINE',
  'PRICE_PINNED_MANUAL',
  'STALE_PRICING',
  'PRICING_VERSION_CHANGED',
  'PRICING_NOT_MIGRATED',
  'PRICING_NOT_READY',
  'ENGINE_BATCH_NOT_UNDOABLE',
  'PRICING_OPERATION_REUSED',
  'PRICING_COMPOSITION_NOT_SUPPORTED',
  'PRICING_HIDE_NOT_ACCEPTED',
];

/** Letters Sorani has and Arabic does not — a Sorani sentence carries at least one. */
const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
// Arabic-only forms: teh marbuta, alef maksura, Arabic yeh and kaf (Sorani writes ی and ک).
const ARABIC_ONLY = /[ةىيك]/;

test('the contract carries every code §6.1 and the critiques name — and nothing it dropped', () => {
  for (const [source, codes] of Object.entries(REQUIRED)) {
    for (const code of codes) assert.ok(isCostRefusalCode(code), `${code} (${source}) is missing from the contract`);
  }
  for (const code of DROPPED) {
    assert.equal(isCostRefusalCode(code), false, `${code} was dropped (§6.1) and must not come back`);
    assert.equal(code in REFUSAL_STRINGS, false, `${code} is translated though no step may raise it`);
  }
  const listed = new Set(Object.values(REQUIRED).flat());
  assert.deepEqual(CODES.filter((c) => !listed.has(c)), [], 'a code with no source in the plan');
});

test('every code has ar, en and ckb — non-empty, trimmed, the Sorani its own (never the Arabic, never the English)', () => {
  for (const code of CODES) {
    const { ar, en, ckb } = COST_REFUSALS[code];
    for (const [lang, s] of Object.entries({ ar, en, ckb })) {
      assert.equal(typeof s, 'string', `${code}.${lang}`);
      assert.ok(s.trim().length > 0, `${code}.${lang} is empty`);
      assert.equal(s, s.trim(), `${code}.${lang} has stray whitespace`);
    }
    assert.notEqual(ckb, ar, `${code}: the Sorani slot carries the Arabic (row 183)`);
    assert.notEqual(ckb, en, `${code}: the Sorani slot carries the English`);
    assert.match(ckb, SORANI_ONLY, `${code}: the ckb sentence has no Sorani letter — is it Arabic?`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${code}: the ckb sentence uses an Arabic-only letter`);
    assert.match(ar, /[؀-ۿ]/, `${code}: the Arabic is not Arabic`);
    assert.doesNotMatch(en, /[؀-ۿ]/, `${code}: the English carries Arabic script`);
  }
});

test('the terminology of C32 holds in every Sorani sentence: «بەرهەم», never «کاڵا»', () => {
  for (const code of CODES) assert.doesNotMatch(COST_REFUSALS[code].ckb, /کاڵا/, code);
  // The screen's Sorani name, as its tab and title write it (tests/adminPricingStrings.test.ts holds them equal).
  assert.match(COST_REFUSALS.CENTRAL_RATES_MOVED.ckb, /«نرخدانان و ناردنی بەرهەم»/, 'the screen is «نرخدانان و ناردنی بەرهەم»');
  assert.match(COST_REFUSALS.LOT_PRODUCT_MISMATCH.ckb, /وەجبە/, 'batch is «وەجبە»');
});

test('serverMessage(code) is exactly "ar / en" for every code', () => {
  for (const code of CODES) {
    const { ar, en } = COST_REFUSALS[code];
    assert.equal(serverMessage(code), `${ar} / ${en}`, code);
  }
});

test('REFUSAL_STRINGS carries every contract code, with the very same three sentences', () => {
  for (const code of CODES) {
    assert.deepEqual(REFUSAL_STRINGS[code], COST_REFUSALS[code], code);
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(refusalText(code, lang), COST_REFUSALS[code][lang]);
  }
});

test('the access refusals carry no number, id or field value — one oracle-free answer (brief 1 §38)', () => {
  for (const code of [
    'COST_ACCESS_DENIED',
    'OWNER_ONLY',
    'PRICING_INCOMPLETE',
    'PRODUCT_CURRENTLY_UNAVAILABLE',
    'SCOPE_ELEVATION_OWNER_ONLY',
    'PROMOTION_STARTS_ASSISTANT',
    'INVESTOR_FLAG_OWNER_ONLY',
    'ROLE_CHANGE_DENIED',
    'OWNER_EMAIL_LOCKED',
    'OWNER_EMAIL_UNVERIFIED',
    'VERIFY_SIGN_IN_REQUIRED',
    'OWNER_FIRST_PROOF_REQUIRED',
    'REAUTH_REQUIRED',
  ] as const) {
    assert.doesNotMatch(serverMessage(code), /[0-9٠-٩]/, code);
    assert.doesNotMatch(COST_REFUSALS[code].ckb, /[0-9٠-٩]/, code);
  }
});

test('the security spec §6 sentences, verbatim', () => {
  assert.deepEqual(COST_REFUSALS.COST_ACCESS_DENIED, {
    ar: 'هذه البيانات متاحة للأدمن الرئيسي فقط.',
    en: 'This information is available to the main admin only.',
    ckb: 'ئەم زانیارییانە تەنها بۆ بەڕێوەبەری سەرەکی بەردەستن.',
  });
  assert.deepEqual(COST_REFUSALS.PRICING_INCOMPLETE, {
    ar: 'بيانات التسعير غير مكتملة. راجع الأدمن الرئيسي.',
    en: 'Pricing data is incomplete. Please check with the main admin.',
    ckb: 'زانیارییەکانی نرخدانان تەواو نین. پەیوەندی بە بەڕێوەبەری سەرەکییەوە بکە.',
  });
  assert.deepEqual(COST_REFUSALS.PROMOTION_STARTS_ASSISTANT, {
    ar: 'يبدأ كل أدمن جديد مساعداً. امنحه الدور أولاً، ثم يقرر الأدمن الرئيسي أي صلاحية أوسع.',
    en: 'Every new admin starts as an assistant. Grant the role first; the main admin decides any wider access afterwards.',
    ckb: 'هەموو بەڕێوەبەرێکی نوێ وەک یاریدەدەر دەست پێدەکات. سەرەتا ڕۆڵەکە بدە؛ دواتر بەڕێوەبەری سەرەکی بڕیار لەسەر دەسەڵاتی فراوانتر دەدات.',
  });
  assert.deepEqual(COST_REFUSALS.OWNER_EMAIL_LOCKED, {
    ar: 'لا يمكن تغيير بريد حساب المالك من هنا.',
    en: "The owner account's email cannot be changed here.",
    ckb: 'ناتوانرێت ئیمەیڵی هەژماری خاوەن لێرەوە بگۆڕدرێت.',
  });
});

test('critique G-34: the add and quote doors say exactly «هذا المنتج غير متوفر حالياً.», and PRODUCT_UNAVAILABLE keeps its cart wording (F19)', () => {
  assert.deepEqual(COST_REFUSALS.PRODUCT_CURRENTLY_UNAVAILABLE, {
    ar: 'هذا المنتج غير متوفر حالياً.',
    en: 'This product is currently unavailable.',
    ckb: 'ئەم بەرهەمە لە ئێستادا بەردەست نییە.',
  });
  assert.equal(isCostRefusalCode('PRODUCT_UNAVAILABLE'), false, 'the existing code is not re-worded by the contract');
  const existing = REFUSAL_STRINGS.PRODUCT_UNAVAILABLE;
  assert.ok(existing, 'PRODUCT_UNAVAILABLE keeps its own table entry');
  assert.notDeepEqual(existing, COST_REFUSALS.PRODUCT_CURRENTLY_UNAVAILABLE, 'the cart wording stays the cart wording');
  assert.equal(PRODUCT_UNAVAILABLE_SERVER_MESSAGE, 'هذا المنتج غير متوفر حالياً. / This product is currently unavailable.');
});

test('OWNER_EMAIL_UNVERIFIED names the way out in all three languages, in the contract’s own terms', () => {
  const { ar, en, ckb } = COST_REFUSALS.OWNER_EMAIL_UNVERIFIED;
  // Not the "main admin only" sentence: a different answer, said only to the owner's own session.
  assert.notEqual(serverMessage('OWNER_EMAIL_UNVERIFIED'), serverMessage('COST_ACCESS_DENIED'));
  // Verify the email…
  assert.match(ar, /أكّد بريدك الإلكتروني/);
  assert.match(en, /Verify your email/);
  assert.match(ckb, /ئیمەیڵەکەت پشتڕاست بکەرەوە/);
  // …with the link in the verification email, the only way the owner's address
  // is first proven (worker/lib/emailStamp.ts): no Google or code sign-in is
  // offered, and never a "connect Google in your settings" control, which the
  // settings page lacks. Google is named only among what that proof removes.
  assert.match(en, /Verify your email with the link in the verification email/);
  assert.match(ar, /برابط رسالة التأكيد/);
  assert.match(ckb, /بە بەستەری ناو ئیمەیڵی پشتڕاستکردنەوە/);
  assert.doesNotMatch(en, /sign in with Google|already connected/i);
  assert.doesNotMatch(ar, /سجّل الدخول بحساب Google|مربوطًا/);
  assert.doesNotMatch(ckb, /بە Google بچۆ ژوورەوە|بەستراوە/);
  assert.doesNotMatch(en, /settings/i);
  assert.doesNotMatch(ar, /إعدادات/);
  assert.doesNotMatch(ckb, /ڕێکخستن/);
  // C32 terminology: main admin «بەڕێوەبەری سەرەکی», cost «تێچوو».
  assert.match(ckb, /بەڕێوەبەری سەرەکی/);
  assert.match(ckb, /تێچوو/);
  assert.notEqual(ckb, ar);
  assert.notEqual(ckb, en);
  assert.deepEqual(REFUSAL_STRINGS.OWNER_EMAIL_UNVERIFIED, COST_REFUSALS.OWNER_EMAIL_UNVERIFIED);
});

test('VERIFY_SIGN_IN_REQUIRED tells the holder of the owner’s link to confirm it signed in to that account, in all three languages', () => {
  const { ar, en, ckb } = COST_REFUSALS.VERIFY_SIGN_IN_REQUIRED;
  assert.match(ar, /سجّل الدخول/);
  assert.match(en, /Sign in to it in this browser/);
  assert.match(ckb, /بچۆ ژوورەوە/);
  assert.match(ckb, /بەڕێوەبەری سەرەکی/);
  assert.match(ckb, SORANI_ONLY);
  assert.doesNotMatch(ckb, ARABIC_ONLY);
  assert.notEqual(ckb, ar);
  assert.notEqual(ckb, en);
  assert.deepEqual(REFUSAL_STRINGS.VERIFY_SIGN_IN_REQUIRED, COST_REFUSALS.VERIFY_SIGN_IN_REQUIRED);
});

test('OWNER_FIRST_PROOF_REQUIRED says what the first proof ends and asks to confirm or cancel — ar, en and real Sorani', () => {
  const { ar, en, ckb } = COST_REFUSALS.OWNER_FIRST_PROOF_REQUIRED;
  assert.match(en, /^This is the first verification of the main admin's email\./);
  assert.match(en, /removes its password, Telegram link, phone sign-in and any Google account with a different email/);
  assert.match(en, /Confirm to continue, or cancel to leave everything as it is\.$/);
  assert.match(ar, /هذا أول تأكيد لبريد الأدمن الرئيسي/);
  assert.match(ar, /وأي حساب Google ببريد آخر/);
  assert.match(ar, /أكّد للمتابعة، أو ألغِ ليبقى كل شيء كما هو\.$/);
  assert.match(ckb, /بەڕێوەبەری سەرەکی/);
  assert.match(ckb, /هەر هەژمارێکی Google بە ئیمەیڵێکی تر/);
  assert.match(ckb, SORANI_ONLY);
  assert.doesNotMatch(ckb, ARABIC_ONLY);
  assert.notEqual(ckb, ar);
  assert.notEqual(ckb, en);
  // Google on the same address is not "lost": it links again (review U3).
  assert.match(en, /or with Google on this same email/);
  assert.deepEqual(REFUSAL_STRINGS.OWNER_FIRST_PROOF_REQUIRED, COST_REFUSALS.OWNER_FIRST_PROOF_REQUIRED);
});

/** Every .ts / .tsx file under one directory, at any depth. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test('decision 8: the retired gate codes stay in the contract, and no server or client file raises them', () => {
  const RETIRED = ['PRICING_GATE_ITEMS_MISSING', 'PRICING_GATE_NOT_CONFIRMED'] as const;
  for (const code of RETIRED) assert.ok(isCostRefusalCode(code), `${code} left the contract, which only grows`);
  const files = [...sources(join(ROOT, 'worker')), ...sources(join(ROOT, 'src'))];
  assert.ok(files.length >= 500, `only ${files.length} files scanned`);
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const code of RETIRED) if (text.includes(code)) hits.push(`${relative(ROOT, file)}: ${code}`);
  }
  assert.deepEqual(hits, [], 'there is no gate: the save that completes a product adopts the engine (DECISIONS row 191)');
});
