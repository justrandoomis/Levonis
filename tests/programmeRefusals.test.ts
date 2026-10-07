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
  'critique G-34': ['PRODUCT_CURRENTLY_UNAVAILABLE'],
  'ENG §6.3': ['ENGINE_MANAGED', 'ENGINE_MANAGED_PRICES_KEPT', 'PREMIUM_NOT_ON_STEP'],
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
  assert.match(COST_REFUSALS.CENTRAL_RATES_MOVED.ckb, /نرخدانان و ناردن/, 'the screen is «نرخدانان و ناردن»');
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
