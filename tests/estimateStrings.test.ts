/**
 * THE WORDS OF AN ESTIMATED PRICE (docs/SMART_PRICING.md §5.5; DECISIONS rows
 * 183 and 281) — packages/contracts/src/priceEstimates.ts.
 *
 *   - every sentence and every refusal exists in ar, en and ckb, trimmed and
 *     non-empty, with the same placeholders in all three;
 *   - the Sorani is its own: never the Arabic or the English, at least one
 *     Sorani-only letter, none of the Arabic-only ones (ة ى ي ك); the Arabic is
 *     Arabic script and the English carries none;
 *   - the notice and the acknowledgement are pinned to ESTIMATE_NOTICE_VERSION:
 *     changing their words without bumping it fails here;
 *   - refusals resolve by code (or by the error carrying it), unknown codes do
 *     not, the server sentence is "ar / en", and the statuses are the design's;
 *   - the gate module's sentences are the contract's own;
 *   - the confirm panel's «استخدم سعر اليوم» labels (its own words) pass the
 *     same Sorani checks, and on an offer line the label names the same offer;
 *   - no runtime value of the contract names a private field (FINANCIAL_FIELDS),
 *     because lazy CUSTOMER chunks import it, and it imports nothing.
 *
 * Run: node --import tsx --test tests/estimateStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import * as contract from '../packages/contracts/src/priceEstimates';
import {
  ESTIMATE_BLOCKING_FLAGS,
  ESTIMATE_DB_ABORTS,
  ESTIMATE_HARD_FLAGS,
  ESTIMATE_INFO_FLAGS,
  ESTIMATE_LINE_STATES,
  ESTIMATE_NOTICE_VERSION,
  ESTIMATE_REASON_CODE,
  ESTIMATE_REFUSALS,
  ESTIMATE_SETTLED_STATES,
  ESTIMATE_SOFT_FLAGS,
  ESTIMATE_STRINGS,
  ESTIMATE_SUPPORT_INTENT,
  ESTIMATE_UNSETTLED_STATES,
  estimateLineText,
  estimateRefusalText,
  estimateServerMessage,
  fillEstimateText,
  isEstimateLineState,
  isEstimateRefusalCode,
  type EstimateLang,
  type EstimateText,
} from '../packages/contracts/src/priceEstimates';
import { PRICE_ESTIMATE_REOPEN_REFUSED_MESSAGE, PRICE_ESTIMATE_UNCONFIRMED_MESSAGE } from '../worker/lib/priceEstimateGate';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';

const LANGS: readonly EstimateLang[] = ['ar', 'en', 'ckb'];
const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

const isText = (v: unknown): v is EstimateText =>
  !!v && typeof v === 'object' && LANGS.every((l) => typeof (v as Record<string, unknown>)[l] === 'string');

/** Every three-language entry of the contract, by a dotted key: the sentences (nested) and the refusals. */
function entries(): Array<[string, EstimateText]> {
  const out: Array<[string, EstimateText]> = [];
  const walk = (v: unknown, path: string) => {
    if (isText(v)) out.push([path, v]);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(ESTIMATE_STRINGS, '');
  for (const [code, r] of Object.entries(ESTIMATE_REFUSALS)) out.push([code, r]);
  return out;
}

/** The design's keys (§5.5), every one of them. */
const DESIGN_KEYS = [
  'label', 'labelShort', 'notice', 'contact', 'cartNotice', 'checkoutAck', 'checkoutButton', 'checkoutCancel',
  'line.open', 'line.proposed', 'line.confirmed', 'line.rejected', 'orderPlaced', 'confirmedNoChange', 'confirmedTotalUnchanged',
  'estimateReason', 'estimateRejectNote', 'support.chip', 'support.answer', 'support.subject', 'priceRequest.title',
];
const CUSTOMER_REFUSALS = [
  'PRICE_ESTIMATE_ACK_REQUIRED', 'PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED', 'PRICE_ESTIMATE_PREORDER_ONLY', 'PRICE_ESTIMATE_QUICK_BUY',
  'PRICE_ESTIMATE_ORDERING_PAUSED', 'PRICE_PROTECTION_ESTIMATE_PENDING', 'PRICE_ESTIMATES_READ_FAILED',
];
const STAFF_REFUSALS = ['PRICE_ESTIMATE_UNCONFIRMED', 'PRICE_ESTIMATE_REOPEN_REFUSED', 'PRICE_ESTIMATE_OPEN'];
const OWNER_REFUSALS = [
  'PRICE_ESTIMATES_NOT_INSTALLED', 'PRICE_ESTIMATES_DISABLED', 'PRICE_ESTIMATE_POLICY_MISSING', 'PRICE_ESTIMATE_NOT_ELIGIBLE',
  'PRICE_ESTIMATE_DEFAULT_MEASURES', 'PRICE_ESTIMATE_FLAGS_OPEN', 'PRICE_ESTIMATE_TYPE_RULE', 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE',
  // The owner's own supplier links on a database without 0223 (§3.10, DECISIONS row 293).
  'SUPPLIER_LINKS_NOT_INSTALLED',
];

test('every key of the design and every refusal is there, in ar, en and ckb, trimmed and non-empty', () => {
  const all = new Map(entries());
  for (const k of DESIGN_KEYS) assert.ok(all.has(k), `${k} is missing`);
  assert.deepEqual(Object.keys(ESTIMATE_REFUSALS).sort(), [...CUSTOMER_REFUSALS, ...STAFF_REFUSALS, ...OWNER_REFUSALS].sort());
  assert.equal(all.size, DESIGN_KEYS.length + Object.keys(ESTIMATE_REFUSALS).length, 'an entry nobody checks');
  for (const [key, text] of all) {
    for (const l of LANGS) {
      assert.ok(text[l].trim().length > 0, `${key}.${l} is empty`);
      assert.equal(text[l], text[l].trim(), `${key}.${l} has stray whitespace`);
    }
  }
});

/** Row 183: the Sorani is never the Arabic or the English, has a Sorani letter and no Arabic-only one; each script is its own. */
function assertOwnSorani(key: string, text: EstimateText): void {
  assert.notEqual(text.ckb, text.ar, `${key}: the Sorani slot carries the Arabic`);
  assert.notEqual(text.ckb, text.en, `${key}: the Sorani slot carries the English`);
  assert.match(text.ckb, SORANI_ONLY, `${key}: no Sorani-only letter in «${text.ckb}»`);
  assert.doesNotMatch(text.ckb, ARABIC_ONLY, `${key}: an Arabic-only letter in the Sorani «${text.ckb}»`);
  assert.match(text.ar, ARABIC_SCRIPT, `${key}: the Arabic is not Arabic script`);
  assert.doesNotMatch(text.en, ARABIC_SCRIPT, `${key}: Arabic script in the English`);
}

test('the Sorani is its own (row 183): never the Arabic or the English, a Sorani letter, no Arabic-only letter', () => {
  for (const [key, text] of entries()) assertOwnSorani(key, text);
});

/**
 * «استخدم سعر اليوم» on the confirm panel (src/components/adminOrders/EstimateConfirmPanel.tsx,
 * the panel's own words, not the contract's). On a line bought under an offer it sets the same
 * offer on today's price, so its label says so; a plain line keeps its label.
 */
const USE_TODAY = {
  plain: { ar: 'استخدم سعر اليوم', en: 'Use today’s price', ckb: 'نرخی ئەمڕۆ بەکاربهێنە' },
  offer: { ar: 'استخدم سعر اليوم بنفس العرض', en: 'Use today’s price under the same offer', ckb: 'نرخی ئەمڕۆ بە هەمان ئۆفەر بەکاربهێنە' },
} as const satisfies Record<string, EstimateText>;

test('the confirm panel’s «استخدم سعر اليوم»: an offer line’s label names the same offer, in three languages of its own', () => {
  const panel = readFileSync(join(ROOT, 'src/components/adminOrders/EstimateConfirmPanel.tsx'), 'utf8');
  for (const [key, text] of Object.entries(USE_TODAY)) {
    assert.equal(panel.split(`loc('${text.ar}', '${text.en}', '${text.ckb}')`).length - 1, 1, `${key}: the panel says it once, in all three languages`);
    assertOwnSorani(`useToday.${key}`, text);
  }
  for (const l of LANGS) assert.notEqual(USE_TODAY.offer[l], USE_TODAY.plain[l], `${l}: two acts, two labels`);
  // Built from the panel's own words: its «سعر اليوم بنفس العرض» row and the plain act's verb.
  assert.ok(panel.includes("loc('سعر اليوم بنفس العرض', 'Today, under the same offer', 'نرخی ئەمڕۆ بە هەمان ئۆفەر')"));
  assert.ok(USE_TODAY.offer.ckb.startsWith('نرخی ئەمڕۆ بە هەمان ئۆفەر') && USE_TODAY.offer.ckb.endsWith('بەکاربهێنە'));
});

test('the three languages carry the same placeholders, and fillEstimateText fills them in each', () => {
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
  for (const [key, text] of entries()) {
    assert.deepEqual(holes(text.en), holes(text.ar), `${key}: en and ar disagree on placeholders`);
    assert.deepEqual(holes(text.ckb), holes(text.ar), `${key}: ckb and ar disagree on placeholders`);
  }
  assert.deepEqual(holes(ESTIMATE_STRINGS.confirmedNoChange.ar), ['id']);
  assert.deepEqual(holes(ESTIMATE_STRINGS.confirmedTotalUnchanged.ar), ['id']);
  assert.deepEqual(holes(ESTIMATE_STRINGS.support.subject.ar), ['name']);
  assert.deepEqual(holes(ESTIMATE_STRINGS.priceRequest.title.ar), ['name']);
  for (const text of [ESTIMATE_STRINGS.confirmedNoChange, ESTIMATE_STRINGS.confirmedTotalUnchanged]) {
    const done = fillEstimateText(text, { id: 'ORD-7K2' });
    for (const l of LANGS) {
      assert.ok(done[l].includes('ORD-7K2'), l);
      assert.ok(!done[l].includes('{id}'), l);
    }
  }
  // Two different facts, so two different sentences in every language.
  for (const l of LANGS) assert.notEqual(ESTIMATE_STRINGS.confirmedTotalUnchanged[l], ESTIMATE_STRINGS.confirmedNoChange[l], l);
  const named = fillEstimateText(ESTIMATE_STRINGS.support.subject, { name: { ar: 'خيط PLA', en: 'PLA Basic', ckb: '' } });
  assert.equal(named.ar, 'سؤال عن السعر التقديري: خيط PLA');
  assert.equal(named.en, 'Question about the estimated price: PLA Basic');
  assert.equal(named.ckb, 'پرسیار دەربارەی نرخی خەمڵێنراو: خيط PLA', 'an empty Sorani name falls back to the Arabic');
  assert.equal(fillEstimateText(ESTIMATE_STRINGS.priceRequest.title, { name: 'A1 mini' }).en, 'A1 mini can now be pre-ordered at an estimated price');
  assert.equal(fillEstimateText(ESTIMATE_STRINGS.support.subject).en, ESTIMATE_STRINGS.support.subject.en, 'nothing given, nothing filled');
});

/**
 * THE ACKNOWLEDGEMENT BINDS TO THESE WORDS. The fingerprint of the notice and
 * the checkbox per notice version: a change of either text must come with a
 * new ESTIMATE_NOTICE_VERSION and a new line here — never an edited one.
 */
const NOTICE_FINGERPRINTS: Readonly<Record<number, string>> = {
  1: 'c6e1e748f99bcb5e2bfbdd6c0cee72eec039a6b5772a787b2687079d9d45364d',
};

test('the notice and the acknowledgement are pinned to ESTIMATE_NOTICE_VERSION', () => {
  assert.ok(Number.isInteger(ESTIMATE_NOTICE_VERSION) && ESTIMATE_NOTICE_VERSION >= 1);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([ESTIMATE_STRINGS.notice, ESTIMATE_STRINGS.checkoutAck]))
    .digest('hex');
  assert.equal(
    fingerprint,
    NOTICE_FINGERPRINTS[ESTIMATE_NOTICE_VERSION],
    'the notice or the acknowledgement changed: bump ESTIMATE_NOTICE_VERSION and pin the new words here'
  );
});

test('refusals: resolved by code or by the error carrying it, unknown codes are not ours, the server sends "ar / en"', () => {
  for (const code of Object.keys(ESTIMATE_REFUSALS) as Array<keyof typeof ESTIMATE_REFUSALS>) {
    assert.equal(isEstimateRefusalCode(code), true);
    for (const l of LANGS) {
      assert.equal(estimateRefusalText(code, l), ESTIMATE_REFUSALS[code][l]);
      assert.equal(estimateRefusalText({ code, message: 'server text' }, l), ESTIMATE_REFUSALS[code][l]);
    }
    assert.equal(estimateServerMessage(code), `${ESTIMATE_REFUSALS[code].ar} / ${ESTIMATE_REFUSALS[code].en}`);
  }
  for (const other of ['PRICE_APPROVAL_PENDING', 'COST_ACCESS_DENIED', '', 'toString', '__proto__', null, undefined, 7, {}]) {
    assert.equal(isEstimateRefusalCode(other), false, String(other));
    assert.equal(estimateRefusalText(other, 'ar'), null, String(other));
  }
});

test('the statuses and audiences are the design’s', () => {
  const status = Object.fromEntries(Object.entries(ESTIMATE_REFUSALS).map(([k, v]) => [k, v.status]));
  assert.deepEqual(status, {
    PRICE_ESTIMATE_ACK_REQUIRED: 409,
    PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED: 400,
    PRICE_ESTIMATE_PREORDER_ONLY: 409,
    PRICE_ESTIMATE_QUICK_BUY: 409,
    PRICE_ESTIMATE_ORDERING_PAUSED: 409,
    PRICE_PROTECTION_ESTIMATE_PENDING: 409,
    PRICE_ESTIMATES_READ_FAILED: 503,
    PRICE_ESTIMATE_UNCONFIRMED: 409,
    PRICE_ESTIMATE_REOPEN_REFUSED: 409,
    PRICE_ESTIMATE_OPEN: 409,
    PRICE_ESTIMATES_NOT_INSTALLED: 503,
    PRICE_ESTIMATES_DISABLED: 409,
    PRICE_ESTIMATE_POLICY_MISSING: 409,
    PRICE_ESTIMATE_NOT_ELIGIBLE: 409,
    PRICE_ESTIMATE_DEFAULT_MEASURES: 409,
    PRICE_ESTIMATE_FLAGS_OPEN: 409,
    PRICE_ESTIMATE_TYPE_RULE: 409,
    // §3.6: the owner's one-page store read answered no price (refused, challenged or no offers).
    PRICE_ESTIMATE_STORE_PAGE_UNREADABLE: 502,
    // §3.10: saving the owner's own supplier links on a database without 0223.
    SUPPLIER_LINKS_NOT_INSTALLED: 503,
  });
  for (const c of CUSTOMER_REFUSALS) assert.equal(ESTIMATE_REFUSALS[c as keyof typeof ESTIMATE_REFUSALS].audience, 'customer', c);
  for (const c of STAFF_REFUSALS) assert.equal(ESTIMATE_REFUSALS[c as keyof typeof ESTIMATE_REFUSALS].audience, 'staff', c);
  for (const c of OWNER_REFUSALS) assert.equal(ESTIMATE_REFUSALS[c as keyof typeof ESTIMATE_REFUSALS].audience, 'owner', c);
});

test('the gate module answers with the contract’s own sentences', () => {
  assert.equal(PRICE_ESTIMATE_UNCONFIRMED_MESSAGE, estimateServerMessage('PRICE_ESTIMATE_UNCONFIRMED'));
  assert.equal(PRICE_ESTIMATE_REOPEN_REFUSED_MESSAGE, estimateServerMessage('PRICE_ESTIMATE_REOPEN_REFUSED'));
  // The database's words and the refusals agree where they are the same fact.
  assert.equal(ESTIMATE_DB_ABORTS.UNCONFIRMED, 'PRICE_ESTIMATE_UNCONFIRMED');
  assert.equal(ESTIMATE_DB_ABORTS.REOPEN_REFUSED, 'PRICE_ESTIMATE_REOPEN_REFUSED');
  assert.equal(ESTIMATE_DB_ABORTS.TYPE_RULE, 'PRICE_ESTIMATE_TYPE_RULE');
  for (const code of [ESTIMATE_DB_ABORTS.UNCONFIRMED, ESTIMATE_DB_ABORTS.REOPEN_REFUSED, ESTIMATE_DB_ABORTS.TYPE_RULE]) {
    assert.ok(isEstimateRefusalCode(code), `${code} has its sentences`);
  }
});

test('line states: every state of the migration, the gate’s three, a chip for each but void', () => {
  assert.deepEqual([...ESTIMATE_LINE_STATES], ['open', 'proposed', 'confirmed', 'approved', 'rejected', 'void']);
  const migration = readFileSync(join(ROOT, 'migrations', '0218_price_estimates.sql'), 'utf8');
  assert.match(migration, /state TEXT NOT NULL DEFAULT 'open' CHECK \(state IN \('open','proposed','confirmed','approved','rejected','void'\)\)/);
  assert.match(migration, new RegExp(`e\\.state IN \\(${ESTIMATE_UNSETTLED_STATES.map((s) => `'${s}'`).join(',')}\\)`), 'the gate holds exactly the unsettled states');
  assert.deepEqual([...ESTIMATE_UNSETTLED_STATES, ...ESTIMATE_SETTLED_STATES, 'void'].sort(), [...ESTIMATE_LINE_STATES].sort());
  for (const l of LANGS) {
    assert.equal(estimateLineText('open', l), ESTIMATE_STRINGS.line.open[l]);
    assert.equal(estimateLineText('proposed', l), ESTIMATE_STRINGS.line.proposed[l]);
    assert.equal(estimateLineText('confirmed', l), ESTIMATE_STRINGS.line.confirmed[l]);
    assert.equal(estimateLineText('approved', l), ESTIMATE_STRINGS.line.confirmed[l], 'approved reads as confirmed');
    assert.equal(estimateLineText('rejected', l), ESTIMATE_STRINGS.line.rejected[l]);
    assert.equal(estimateLineText('void', l), null);
  }
  assert.equal(isEstimateLineState('open'), true);
  assert.equal(isEstimateLineState('pending'), false);
  assert.equal(ESTIMATE_REASON_CODE, 'ESTIMATE_FINAL_PRICE');
  assert.match(migration, /reason_code IN \('','ESTIMATE_FINAL_PRICE'\)/);
  assert.equal(ESTIMATE_SUPPORT_INTENT, 'price_estimate');
});

test('flag codes: four disjoint owner-only families, every code EST_-prefixed and shouted', () => {
  const families = [ESTIMATE_BLOCKING_FLAGS, ESTIMATE_HARD_FLAGS, ESTIMATE_SOFT_FLAGS, ESTIMATE_INFO_FLAGS] as const;
  const all = families.flatMap((f) => [...f]);
  assert.equal(new Set(all).size, all.length, 'a flag in two families');
  for (const f of all) assert.match(f, /^EST_[A-Z_]+$/);
  assert.deepEqual([...ESTIMATE_HARD_FLAGS], ['EST_DEFAULT_WEIGHT', 'EST_DEFAULT_BOX']);
});

/** Every string a value of the contract carries at runtime (what a bundle would carry). */
function runtimeStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        walk(x);
      }
    }
  };
  for (const [name, value] of Object.entries(contract)) {
    out.push(name);
    if (typeof value === 'function') out.push(String(value));
    else walk(value);
  }
  return out;
}

test('privacy: lazy customer chunks import the contract, so no value of it names a private field, and it imports nothing', () => {
  const strings = runtimeStrings();
  assert.ok(strings.length > 100, `only ${strings.length} strings`);
  const hits: string[] = [];
  for (const name of FINANCIAL_FIELDS as readonly string[]) {
    // The bundle scan reads names of six characters or more; a shorter one is a common word.
    if (name.length < 6) continue;
    for (const s of strings) if (s.includes(name)) hits.push(`«${name}» in ${JSON.stringify(s.slice(0, 80))}`);
  }
  assert.deepEqual(hits, []);
  const src = readFileSync(join(ROOT, 'packages/contracts/src/priceEstimates.ts'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m, 'the contract imports nothing');
  assert.doesNotMatch(src, /\bfetch\(|\/api\/admin/, 'and calls nothing');
});
