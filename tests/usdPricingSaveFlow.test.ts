/**
 * «التسعير بالدولار والشحن» — WHAT THE NEXT SAVE SENDS AFTER A REFUSED ONE, AND A NEW PRODUCT'S DINARS
 * (the verifiers' round on the owner's report of 2026-10-10; docs/DECISIONS.md row 213).
 *
 *   F1  a box corrected after an invalid or refused «نشر» is the box pricing saves: the product save
 *       leaves the owner's ACT behind (`adopt_measure`), never the box frozen at the first press;
 *   F2  a NEW product knows, before its first save, whether a dollar rate is approved: with none, the
 *       form stops «دينار» under its field; and when the form could not know, the save stores the rest
 *       of the entry (route, box, extras, minimum profit, Direct Sale Extra) without the dinars, which
 *       stay typed with their reason — never the whole batch lost to one field.
 *
 * Run: node --import tsx --test tests/usdPricingSaveFlow.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError } from '../src/lib/api';
import { ctx } from './fixtures/app';
import { SNAP, liveLikeWorld, persisted, type World } from './fixtures/usdPricingSave';
import {
  commitPricing,
  draftWire,
  draftsAfterProductSave,
  effectiveDrafts,
  invalidWhere,
  knownUsdRate,
  type PricingIo,
  type ScopeDraft,
  type UsdPricingAnswer,
  type UsdPricingFormContext,
} from '../src/components/adminProducts/form/UsdPricingSection';
import { USD_PRICING_FORM_STRINGS } from '../src/components/adminProducts/form/usdPricingStrings';
import type { ProductDimensionsV2 } from '../src/lib/productTypes';

const dims = (widthMm: number | null): ProductDimensionsV2 => ({
  net_weight_g: null,
  width_mm: null,
  depth_mm: null,
  height_mm: null,
  package_weight_g: null,
  package_width_mm: widthMm,
  package_depth_mm: widthMm === null ? null : 520,
  package_height_mm: widthMm === null ? null : 480,
});
const formOf = (base: ProductDimensionsV2, saved: ProductDimensionsV2): UsdPricingFormContext => ({
  baseDimensions: base,
  optionDimensions: {},
  savedBaseDimensions: saved,
  savedOptionDimensions: {},
  models: [],
  productSellsDirect: true,
  setMeasure: () => {},
});
const BASE_SCOPE = {
  scope: 'base' as const, scope_id: '', name_ar: '', name_en: '', name_ckb: '', pricing_inputs: null, minimum_target_profit_usd: null,
  target_profit_iqd: null, target_profit_state: null, direct_sale_extra_iqd: null, direct_sale_extra_state: null,
};
/** An existing manual product's stored answer with nothing stored yet for pricing. */
const ANSWER: UsdPricingAnswer = {
  product_id: 'prd_twin',
  mode: 'manual',
  inputs_seq: 0,
  rates: { usd_iqd_rate: '1600', review_pending: false, derived_stale: false },
  scopes: [BASE_SCOPE],
  models: [],
  rows: [],
  preview_hash: '',
};
const SECTION = () => readFileSync(new URL('../src/components/adminProducts/form/UsdPricingSection.tsx', import.meta.url), 'utf8');

test('F1 a box corrected after an invalid «نشر» is the box pricing saves — the product save leaves the owner’s act, not the frozen box', () => {
  // The owner types the entry in section ٣; the box fields ARE the product's package dimensions (60 × 52 × 48 cm).
  const typed: Record<string, ScopeDraft> = { base: { supplier_cost_currency: 'USD', supplier_cost_amount: '1,250', shipping_profile: 'CHINA_SEA', minimum_target_profit_usd: '120' } };
  // «نشر» #1: the snapshot is the effective drafts (the box taken from the form); the cost is invalid, nothing is sent.
  const effective = effectiveDrafts(typed, ANSWER, formOf(dims(600), dims(null)));
  assert.deepEqual(effective.base!.box, [520, 600, 480], 'the snapshot carries the form’s box');
  // What `saveAfterProduct` leaves as drafts: the typed values and the owner's act on the measure.
  let drafts = draftsAfterProductSave(typed, effective);
  assert.equal(drafts.base!.box, undefined, 'never the box value of that moment');
  assert.equal(drafts.base!.adopt_measure, true, 'the measure stays the owner’s act');
  // The product itself was saved by «نشر» #1 (its box is now 60 cm wide). The owner corrects the width to
  // 70 cm in the same panel (it edits the product's package dimensions) and fixes the cost.
  drafts = { ...drafts, base: { ...drafts.base, supplier_cost_amount: '1250' } };
  const after = effectiveDrafts(drafts, ANSWER, formOf(dims(700), dims(600)));
  const base = draftWire(after, ANSWER).inputs.find((e) => e.scope === 'base')!;
  assert.equal(base.shipping_width_mm, 700, 'pricing stores what the fields show');
  // A stored pricing box that differs (never adopted before) is replaced too: the act is the owner's.
  const stored: UsdPricingAnswer = { ...ANSWER, scopes: [{ ...BASE_SCOPE, pricing_inputs: { shipping_length_mm: 500, shipping_width_mm: 500, shipping_height_mm: 500 } as never }] };
  const wire2 = draftWire(effectiveDrafts(drafts, stored, formOf(dims(700), dims(700))), stored).inputs.find((e) => e.scope === 'base')!;
  assert.deepEqual([wire2.shipping_length_mm, wire2.shipping_width_mm, wire2.shipping_height_mm], [520, 700, 480]);
  // Nothing derived, nothing added: a typed draft with no measure carried stays exactly what was typed.
  assert.deepEqual(draftsAfterProductSave({ base: { minimum_target_profit_usd: '5' } }, { base: { minimum_target_profit_usd: '5' } }), { base: { minimum_target_profit_usd: '5' } });
  // The hook takes this path (and never freezes the snapshot as drafts again).
  const src = SECTION();
  assert.match(src, /setDrafts\(draftsAfterProductSave\(snap\.typed, snap\.drafts\)\);/);
  assert.doesNotMatch(src, /setDrafts\(snap\.drafts\)/);
});

/** The form's `io` over the real routes (as tests/usdPricingCommit.test.ts does). */
function ioOf(w: World, log: string[] = []): PricingIo {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await w.app.request(
      path,
      { method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      undefined,
      ctx
    );
    const out = (await res.json()) as Record<string, unknown>;
    log.push(`${method} ${res.status}${typeof out.code === 'string' ? ` ${out.code}` : ''}`);
    if (!res.ok) throw new ApiError(res.status, String(out.error ?? ''), out.code as string | undefined, out.details as Record<string, unknown> | undefined, out);
    return out as unknown as UsdPricingAnswer;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

const NEW_IQD: Record<string, ScopeDraft> = {
  base: { supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_450_000, shipping_profile: 'CHINA_SEA', box: [520, 600, 480], additional_cost_iqd: 15000, minimum_target_profit_usd: '120', direct_sale_extra_iqd: 25000 },
};

test('F2 «منتج جديد» with the central rates read and no dollar rate approved: the form stops «دينار» under its field, in each language', () => {
  // The new product's answer once GET …/rates said the dollar pair has no effective rate (the hook's `newAnswer`).
  const NEW: UsdPricingAnswer = { ...ANSWER, product_id: '', rates: { usd_iqd_rate: null, review_pending: false, derived_stale: false }, rates_known: true };
  assert.equal(knownUsdRate(NEW), null, 'known missing');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const said = invalidWhere(NEW_IQD, NEW, formOf(dims(null), dims(null)), lang);
    assert.ok(said.text.includes(USD_PRICING_FORM_STRINGS[lang].iqdNeedsRate), `${lang}: ${said.text}`);
    assert.equal(said.section, 3);
  }
  // Not read yet (or the read failed): unknown — the server answers at the save (next test).
  assert.equal(knownUsdRate({ ...NEW, rates_known: undefined }), undefined);
  assert.equal(invalidWhere(NEW_IQD, { ...NEW, rates_known: undefined }, formOf(dims(null), dims(null)), 'ar').text, '');
  // With a rate approved, «دينار» passes.
  assert.equal(invalidWhere(NEW_IQD, { ...NEW, rates: { ...NEW.rates, usd_iqd_rate: '1600' } }, formOf(dims(null), dims(null)), 'ar').text, '');
  // The hook reads the central rates for a new product only, and marks its answer known.
  const src = SECTION();
  assert.match(src, /if \(!enabled \|\| productId\) return;[\s\S]{0,200}`\$\{PRICING\}\/rates`/);
  assert.match(src, /rates_known: true/);
  assert.match(src, /const rateKnownMissing = knownUsdRate\(answer\) === null;/);
});

test('F2 when the form could not know (no rate approved): «نشر» stores the rest of the entry without the dinars, which stay typed with their reason', async () => {
  const w = liveLikeWorld();
  const log: string[] = [];
  // «نشر» on the new product: the product is created, then `saveAfterProduct` → `commitPricing` with a fresh read.
  const res = await commitPricing(ioOf(w, log), SNAP, NEW_IQD, { withProduct: true });
  assert.equal(res.kind, 'saved', JSON.stringify(res));
  if (res.kind !== 'saved') return;
  assert.equal(res.withheld?.reason, 'fx_missing');
  assert.deepEqual(res.withheld?.target, { key: 'base', field: 'supplier_cost_iqd', section: 3 });
  assert.deepEqual(log, ['GET 200', 'POST 409 PRICING_FX_RATE_MISSING', 'PUT 200']);
  const kept = persisted(w.raw);
  const base = kept.inputs.find((i) => i.scope === 'base');
  assert.equal(base?.shipping_profile, 'CHINA_SEA');
  assert.equal(base?.additional_cost_iqd, 15000);
  assert.deepEqual([base?.shipping_length_mm, base?.shipping_width_mm, base?.shipping_height_mm], [520, 600, 480]);
  assert.equal(base?.supplier_cost_amount ?? null, null, 'no dinars stored without a rate');
  assert.ok(kept.rules.some((r) => r.kind === 'target_profit' && r.amount_usd === '120'));
  assert.ok(kept.rules.some((r) => r.kind === 'direct_sale_extra' && r.amount_iqd === 25000));
  assert.equal(kept.state?.mode ?? 'manual', 'manual');
  // The hook keeps the withheld dinars as drafts (keepUnsent) and says the reason under their field.
  const src = SECTION();
  assert.match(src, /setDrafts\(\(all\) => keepUnsent\(all, res\.answer, w\?\.keys \?\? \[\]\)\);/);
  assert.match(src, /out = \{ kind: 'partial', tone: 'warn', text: s\.restSavedWithheld\(m\), section: w\.target\.section \};/);
});
