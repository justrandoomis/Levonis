/**
 * THE WRITER'S SCREENS (owner decision 8): THEIR WORDS IN ARABIC, ENGLISH AND
 * REAL SORANI, THEIR NOTICES, AND THE WIRING THAT SHOWS NEW PRICES BEFORE ANY
 * SAVE WRITES THEM.
 *
 *   - every key has ar, en and ckb, none empty; ckb is never the Arabic nor the
 *     English, carries a Sorani-only letter, and uses the pricing terms (never
 *     «گواستنەوە» or «کاڵا»); docs/DECISIONS.md row 183;
 *   - the notices a preview raises (held rate, the 1,000 step, COD at the
 *     direct price, a fall above 30%, the route fee folded in, member prices);
 *   - the product form: a save the server holds (409 with the preview) opens
 *     the sheet and the confirm re-sends the same body with the preview's hash;
 *     a save that writes prices never rides on the live preview's hash;
 *   - the purchase review: an apply that writes prices shows them with the
 *     15% tick, and a refused apply's fresh hash is taken only when it writes
 *     the prices already shown;
 *   - the stale list sits on «التسعير والشحن» and in the rates panel.
 *
 * Run: node --import tsx --test tests/engineSaveStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_SAVE_STRINGS, engineNotices } from '../src/components/adminOperations/engineSaveStrings';
import { samePrices, writesPrices, type EngineAdoption, type EngineAdoptionRow } from '../src/components/adminOperations/procurementPricing';
import { ROOT } from './fixtures/d1';

const SORANI_ONLY = /[ڕڵێۆەڤ]/;
const text = (v: unknown): string => (typeof v === 'function' ? (v as (...a: string[]) => string)('X', 'Y', 'Z') : String(v));
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('every key of the writer’s screens in ar, en and real Sorani', () => {
  const keys = Object.keys(ENGINE_SAVE_STRINGS.ar);
  assert.ok(keys.length >= 30, `${keys.length} keys`);
  assert.deepEqual(Object.keys(ENGINE_SAVE_STRINGS.en).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(ENGINE_SAVE_STRINGS.ckb).sort(), [...keys].sort());
  const problems: string[] = [];
  for (const k of keys) {
    const ar = text((ENGINE_SAVE_STRINGS.ar as unknown as Record<string, unknown>)[k]);
    const en = text((ENGINE_SAVE_STRINGS.en as unknown as Record<string, unknown>)[k]);
    const ckb = text((ENGINE_SAVE_STRINGS.ckb as unknown as Record<string, unknown>)[k]);
    if (!ar.trim() || !en.trim() || !ckb.trim()) problems.push(`${k}: empty`);
    if (ckb === ar) problems.push(`${k}: ckb copies the Arabic`);
    if (ckb === en) problems.push(`${k}: ckb copies the English`);
    if (!SORANI_ONLY.test(ckb)) problems.push(`${k}: no Sorani letter in «${ckb}»`);
    if (/گواستنەوە|کاڵا/.test(ckb)) problems.push(`${k}: ckb uses a word the pricing vocabulary forbids`);
    if (/[؀-ۿ]/.test(en)) problems.push(`${k}: Arabic script in the English`);
    if (/علاوة/.test(ar)) problems.push(`${k}: the retired word «علاوة»`);
  }
  assert.deepEqual(problems, []);
});

const row = (over: Partial<EngineAdoptionRow> = {}): EngineAdoptionRow => ({
  option_id: 'o1', name_ar: 'موديل', name_en: 'Model', name_ckb: 'مۆدێل', channel: 'pre_order_land',
  today_prepaid_iqd: 450_000, computed_price_iqd: 992_000, change_iqd: 542_000, change_pct: '120.44', large: true, drop_flag: false,
  replacement_cost_iqd: 827_000, target_profit_usd: '120', target_profit_iqd: 165_000, preorder_base_iqd: 992_000, direct_sale_extra_iqd: null,
  final_price_usd: '620', route_fee_removed: false, pro_before_iqd: null, pro_after_iqd: null, prime_before_iqd: null, prime_after_iqd: null,
  ...over,
});
const adoption = (over: Partial<EngineAdoption> = {}): EngineAdoption => ({
  kind: 'adopt', mode: 'manual', complete: true, missing_codes: [], needs_write: true, preview_hash: 'a'.repeat(64), large_change: true,
  drop_flag: false, legacy_step: false, cod_priced_as_direct: false, review_pending: false, usd_iqd_rate: '1650', rows: [row()], ...over,
});

test('the notices a preview raises, once each, in the viewer’s language', () => {
  assert.deepEqual(engineNotices(adoption(), 'ar'), []);
  const a = adoption({
    review_pending: true, legacy_step: true, cod_priced_as_direct: true, drop_flag: true,
    rows: [row({ route_fee_removed: true, pro_before_iqd: 440_000, pro_after_iqd: 980_000 }), row({ channel: 'direct_sale', pro_before_iqd: 440_000, pro_after_iqd: 980_000 })],
  });
  const en = engineNotices(a, 'en');
  assert.deepEqual(en, [
    ENGINE_SAVE_STRINGS.en.reviewPending('1650'),
    ENGINE_SAVE_STRINGS.en.legacyStep,
    ENGINE_SAVE_STRINGS.en.codAsDirect,
    ENGINE_SAVE_STRINGS.en.routeFeeRemoved,
    ENGINE_SAVE_STRINGS.en.dropFlag,
    `Model · ${ENGINE_SAVE_STRINGS.en.memberBeforeAfter('Pro', '440,000 د.ع', '980,000 د.ع')}`,
  ]);
  assert.match(engineNotices(a, 'ckb').at(-1)!, /^مۆدێل · نرخی ئەندامی Pro/);
});

test('an apply writes prices only for a complete product that needs the write; a fresh hash is taken only for the same prices', () => {
  assert.equal(writesPrices(adoption()), true);
  assert.equal(writesPrices(adoption({ kind: null })), false);
  assert.equal(writesPrices(adoption({ complete: false })), false);
  assert.equal(writesPrices(adoption({ needs_write: false })), false);
  assert.equal(writesPrices(null), false);
  assert.equal(samePrices(adoption(), adoption({ preview_hash: 'b'.repeat(64) })), true, 'another hash, the same prices');
  assert.equal(samePrices(adoption(), adoption({ rows: [row({ computed_price_iqd: 993_000 })] })), false, 'a moved price is a fresh look');
  assert.equal(samePrices(null, adoption({ kind: null })), true, 'no price write on either side');
  assert.equal(samePrices(null, adoption()), false, 'a price write the review did not show');
});

test('the product form: a held save opens the sheet; the confirm re-sends the body with the preview’s hash; the live preview never adopts', () => {
  const section = src('src/components/adminProducts/form/UsdPricingSection.tsx');
  assert.match(section, /REVIEW_CODES = new Set\(\['PRICING_PREVIEW_REQUIRED', 'PRICING_PREVIEW_STALE', 'PRICING_LARGE_CHANGE_CONFIRM'\]\)/);
  assert.match(section, /preview\.wire === w && !preview\.answer\.adoption\?\.kind \? preview\.answer\.preview_hash : null/, 'a price write goes without the live hash');
  assert.match(section, /\{ \.\.\.held\.body, preview_hash: held\.hash, \.\.\.\(confirmLarge \? \{ confirm_large_change: true \} : \{\}\) \}/);
  assert.match(section, /e\.code === 'REAUTH_REQUIRED'\) \{\s*setReview\(\{ \.\.\.held, error: es\.reauth \}\)/);
  assert.match(section, /r\.adoption\?\.kind && r\.adoption\.needs_write && r\.adoption\.complete && r\.preview_hash/, 'a product save that completed the product opens the sheet');
  assert.match(section, /\/products\/\$\{encodeURIComponent\(productId\)\}\/manual`, \{ write_seq: stored\.write_seq \?\? 0 \}/);
  const form = src('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /\{canSeeCost && <UsdPricingSaveSheet \/>\}/);
  assert.match(form, /await pricing\.afterProductSaved\(savedId\)/);
  assert.match(form, /onPricesWritten: \(id\) => void reloadKeepingEdits\(id\)/);
});

test('the purchase review: the prices an apply writes, the 15% tick, and no unseen prices on a retry', () => {
  const review = src('src/components/adminOperations/ProcurementPricingReview.tsx');
  assert.match(review, /data-pricing-adoption=\{writes\.kind\}/);
  assert.match(review, /<PricingRowsTable rows=\{adoptionRows\(writes\)\} \/>/);
  assert.match(review, /if \(!shown\?\.preview_hash \|\| !samePrices\(shown\.adoption, product\.adoption\)\) throw e;/);
  const panel = src('src/components/adminOperations/ProcurementPanel.tsx');
  assert.match(panel, /applyPurchase\(product\.product_id, purchaseId, hash, own, confirmLarge\[product\.product_id\] === true\)/);
  assert.match(panel, /samePrices\(shown\.adoption, product\.adoption\)/);
});

test('the stale list sits on «التسعير والشحن» and in the rates panel; it previews before the bulk save', () => {
  assert.match(src('src/components/adminPricing/AdminPricing.tsx'), /\{!productId && <EngineSaveList lang=\{lang\} \/>\}/);
  assert.match(src('src/components/adminPricing/RatesPanel.tsx'), /<EngineSaveList lang=\{lang\} compact reloadKey=\{ratesSeq\} \/>/);
  const list = src('src/components/adminPricing/EngineSaveList.tsx');
  assert.match(list, /previewSaveList\(firstBatch\(list\)\)/);
  assert.match(list, /saveBulk\(sheet\.map\(\(i\) => \(\{ product_id: i\.product_id, preview_hash: i\.preview\.preview_hash! \}\)\), confirmLarge\)/);
  const wire = src('src/components/adminPricing/api.ts');
  assert.match(wire, /`\$\{PRICING_API\}\/products\/save-bulk`, body/);
  assert.match(wire, /ENGINE_BULK_MAX = 20/);
});
