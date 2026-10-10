/**
 * THE PRODUCT FORM'S ONE PRICING SAVE PATH, DRIVEN AGAINST THE REAL ROUTES
 * (owner report 2026-10-10: «نشر» kept nothing of «التسعير بالدولار والشحن»).
 *
 * `commitPricing` (src/components/adminProducts/form/UsdPricingSection.tsx) is
 * what «حفظ التسعير بالدولار», «نشر» and «مسودة» all call. It takes its
 * requests as `io`; here `io` is the real admin pricing routes over a real
 * migrated database (tests/fixtures/procurementPricing.ts), so this is the
 * client's own request sequence against the server, without a browser:
 *   - the owner's entry (Arabic digits, «٨٩٩٫٥») is stored and read back, in
 *     both rate worlds, as data first; a complete one comes back `ready` for
 *     the sheet, whose confirm alone writes the price;
 *   - dinars preview themselves and carry the conversion hash; with no rate
 *     the refusal is pinned to the field and scope;
 *   - an engine product is held; an older server (no `data_only`) is retried
 *     without it; a stale cached preview is looked at again once.
 * And the pure pieces: the server's own validation per field, the canonical
 * wire, where a refusal belongs, the review a stored answer opens, and the
 * «<scope> · <field>: <reason>» line.
 *
 * Run: node --import tsx --test tests/usdPricingCommit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/lib/api';
import { ctx } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { SNAP, legacyCost, liveLikeWorld, readBack, storePrice, type World } from './fixtures/usdPricingSave';
import {
  commitPricing,
  convertedLines,
  draftProblems,
  draftWire,
  inputsPath,
  invalidWhere,
  previewPath,
  readyReview,
  refusalTarget,
  usdRuleProblem,
  type PricingIo,
  type ScopeDraft,
  type UsdPricingAnswer,
} from '../src/components/adminProducts/form/UsdPricingSection';
import { USD_PRICING_FORM_STRINGS } from '../src/components/adminProducts/form/usdPricingStrings';
import { PROCUREMENT_PRICING_STRINGS } from '../src/components/adminOperations/procurementPricingStrings';

const S = USD_PRICING_FORM_STRINGS.ar;
const HEX64 = /^[0-9a-f]{64}$/;

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  status?: number;
  code?: string;
}

/** The form's `io`, over the real routes: a refusal is the same ApiError `api.ts` throws. */
function ioOf(w: World, log: Call[] = []): PricingIo {
  const call = async (method: string, path: string, body?: unknown) => {
    const entry: Call = { method, path, ...(body === undefined ? {} : { body: body as Record<string, unknown> }) };
    log.push(entry);
    const res = await w.app.request(
      path,
      { method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      undefined,
      ctx
    );
    const out = (await res.json()) as Record<string, unknown>;
    entry.status = res.status;
    entry.code = typeof out.code === 'string' ? out.code : undefined;
    if (!res.ok) throw new ApiError(res.status, String(out.error ?? ''), out.code as string | undefined, out.details as Record<string, unknown> | undefined, out);
    return out as unknown as UsdPricingAnswer;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

/** The owner's entry exactly as typed in section ٣ (Arabic digits and the Arabic decimal key). */
const OWNER_DRAFTS = (): Record<string, ScopeDraft> => ({
  base: {
    supplier_cost_currency: 'USD',
    supplier_cost_amount: '٨٩٩٫٥',
    shipping_profile: 'CHINA_SEA',
    box: [600, 520, 480],
    additional_cost_iqd: 15000,
    minimum_target_profit_usd: '١٢٠',
    direct_sale_extra_iqd: 25000,
  },
});
const IQD_DRAFTS = (): Record<string, ScopeDraft> => ({
  base: { supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_450_000, shipping_profile: 'CHINA_SEA', box: [600, 520, 480], additional_cost_iqd: 15000, minimum_target_profit_usd: '120', direct_sale_extra_iqd: 25000 },
});

const describe = (shown: UsdPricingAnswer, body: ReturnType<typeof draftWire>) => convertedLines(shown, body, S.converted);

test('LIVE-LIKE (no approved rate): the owner’s entry as typed is saved as data in ONE request after the read, and every value reads back canonical; the price and the old cost stay', async () => {
  const w = liveLikeWorld();
  const before = storePrice(w.raw);
  const cost = legacyCost(w.raw);
  const log: Call[] = [];
  const res = await commitPricing(ioOf(w, log), SNAP, OWNER_DRAFTS(), { describe });
  assert.equal(res.kind, 'saved', JSON.stringify(res));
  assert.equal(res.kind === 'saved' && res.ready, null, 'nothing to adopt without a rate');
  assert.deepEqual(log.map((c) => `${c.method} ${c.path} ${c.status}`), [`GET ${inputsPath(SNAP)} 200`, `PUT ${inputsPath(SNAP)} 200`]);
  const put = log[1]!.body!;
  assert.equal(put.data_only, true);
  assert.equal((put.inputs as Array<Record<string, unknown>>)[0]!.supplier_cost_amount, '899.5', 'the canonical text, not the typed «٨٩٩٫٥»');
  assert.equal((put.rules as Array<Record<string, unknown>>)[0]!.amount_usd, '120');
  assert.equal(put.preview_hash, undefined, 'no dinars, no hash');
  const back = readBack((await w.getInputs(SNAP)).body, 'base')!;
  assert.deepEqual(
    [back.supplier_cost_amount, back.supplier_cost_currency, back.shipping_profile, back.box, back.additional_cost_iqd, back.minimum_target_profit_usd, back.direct_sale_extra_iqd],
    ['899.5', 'USD', 'CHINA_SEA', [600, 520, 480], 15000, '120', 25000]
  );
  assert.equal(storePrice(w.raw), before);
  assert.equal(legacyCost(w.raw), cost);
});

test('NORMAL: a complete entry is saved as data and comes back READY (stored) — the sheet’s confirm alone writes the price', async () => {
  const w = pricingWorld();
  const before = storePrice(w.raw);
  const io = ioOf(w);
  const drafts = OWNER_DRAFTS();
  drafts.base!.supplier_cost_amount = '899';
  const res = await commitPricing(io, SNAP, drafts, { describe });
  assert.equal(res.kind, 'saved', JSON.stringify(res));
  if (res.kind !== 'saved') return;
  assert.equal(res.answer.mode, 'manual');
  assert.equal(storePrice(w.raw), before, 'saved, not priced');
  assert.ok(res.ready, 'the review the sheet opens');
  assert.equal(res.ready!.stored, true);
  assert.equal(res.ready!.adoption.kind, 'adopt');
  assert.deepEqual(res.ready!.body, { inputs_seq: res.answer.inputs_seq, inputs: [], rules: [] });
  assert.match(res.ready!.hash, HEX64);
  // «حفظ» in the sheet: exactly what confirmReview sends.
  const r = await io.put(inputsPath(SNAP), { ...res.ready!.body, preview_hash: res.ready!.hash, confirm_large_change: true });
  assert.equal(r.mode, 'engine');
  assert.notEqual(storePrice(w.raw), before);
  // Nothing typed any more: a second save sends nothing and offers the same review only while one is due.
  const again = await commitPricing(io, SNAP, {}, {});
  assert.equal(again.kind, 'nothing');
});

test('NORMAL: dinars with no cached preview — the save previews them itself, carries the conversion hash, stores IQD_CONVERTED and says the conversion', async () => {
  const w = pricingWorld();
  const log: Call[] = [];
  const res = await commitPricing(ioOf(w, log), SNAP, IQD_DRAFTS(), { describe });
  assert.equal(res.kind, 'saved', JSON.stringify(res));
  assert.deepEqual(log.map((c) => `${c.method} ${c.path}`), [`GET ${inputsPath(SNAP)}`, `POST ${previewPath(SNAP)}`, `PUT ${inputsPath(SNAP)}`]);
  assert.match(String(log[2]!.body!.preview_hash), HEX64);
  if (res.kind !== 'saved') return;
  assert.equal(res.converted.length, 1);
  assert.equal(res.converted[0], S.converted('1,450,000', '906.25', '1600'));
  const base = readBack(res.answer as never, 'base')!;
  assert.equal(base.supplier_input_mode, 'IQD_CONVERTED');
  assert.equal(base.original_input_amount, '1450000');
  assert.equal(res.answer.mode, 'manual');
});

test('LIVE-LIKE: dinars with no approved rate are withheld AT their field — the rest of the entry (route, box, extras, minimum profit, DSE) is stored without them (verifier F2)', async () => {
  const w = liveLikeWorld();
  const log: Call[] = [];
  const res = await commitPricing(ioOf(w, log), SNAP, IQD_DRAFTS(), { describe });
  assert.equal(res.kind, 'saved', JSON.stringify(res));
  if (res.kind !== 'saved') return;
  assert.equal(res.withheld?.reason, 'fx_missing');
  assert.equal((res.withheld?.error as ApiError).code, 'PRICING_FX_RATE_MISSING');
  assert.deepEqual(res.withheld?.keys, ['base']);
  assert.deepEqual(res.withheld?.target, { key: 'base', field: 'supplier_cost_iqd', section: 3 });
  // The preview refused the dinars; the save went without them (no hash, no dinars), data first.
  assert.deepEqual(log.map((c) => `${c.method} ${c.status}${c.code ? ` ${c.code}` : ''}`), ['GET 200', 'POST 409 PRICING_FX_RATE_MISSING', 'PUT 200']);
  const put = log[2]!.body!;
  assert.equal(put.data_only, true);
  assert.equal(put.preview_hash, undefined);
  assert.ok(!(put.inputs as Array<Record<string, unknown>>).some((e) => 'supplier_cost_iqd' in e));
  const back = readBack((await w.getInputs(SNAP)).body, 'base')!;
  assert.deepEqual(
    [back.supplier_cost_amount, back.shipping_profile, back.box, back.additional_cost_iqd, back.minimum_target_profit_usd, back.direct_sale_extra_iqd],
    [null, 'CHINA_SEA', [600, 520, 480], 15000, '120', 25000]
  );
});

test('LIVE-LIKE: dinars alone with no approved rate — nothing is sent, the dinars stay typed with their reason', async () => {
  const w = liveLikeWorld();
  const log: Call[] = [];
  const res = await commitPricing(ioOf(w, log), SNAP, { base: { supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_450_000 } }, {});
  assert.equal(res.kind, 'withheld', JSON.stringify(res));
  if (res.kind === 'withheld') assert.equal(res.withheld.reason, 'fx_missing');
  assert.ok(!log.some((c) => c.method === 'PUT'), 'nothing sent');
});

test('ENGINE product: the save is held for the sheet (nothing stored, review.stored false) and the sheet’s body never carries data_only', async () => {
  const w = pricingWorld();
  const io = ioOf(w);
  const first = await commitPricing(io, SNAP, { base: { ...OWNER_DRAFTS().base, supplier_cost_amount: '899' } }, {});
  assert.equal(first.kind, 'saved');
  const ready = first.kind === 'saved' ? first.ready! : null;
  await io.put(inputsPath(SNAP), { ...ready!.body, preview_hash: ready!.hash, confirm_large_change: true });
  const res = await commitPricing(io, SNAP, { base: { additional_cost_iqd: 40000 } }, {});
  assert.equal(res.kind, 'held', JSON.stringify(res));
  if (res.kind !== 'held') return;
  assert.equal(res.review.stored, false);
  assert.equal(res.review.adoption.kind, 'reprice');
  assert.equal('data_only' in res.review.body, false);
  assert.deepEqual(res.review.body.inputs, [{ scope: 'base', additional_cost_iqd: 40000 }]);
  assert.equal(readBack((await w.getInputs(SNAP)).body, 'base')!.additional_cost_iqd, 15000);
  const done = await io.put(inputsPath(SNAP), { ...res.review.body, preview_hash: res.review.hash, confirm_large_change: true });
  assert.equal(readBack(done as never, 'base')!.additional_cost_iqd, 40000);
});

test('an OLDER server that refuses data_only (UNKNOWN_FIELD): the save is sent again without it, once — the completing save is then held, never lost silently', async () => {
  const w = pricingWorld();
  const real = ioOf(w);
  let refusedOnce = 0;
  const io: PricingIo = {
    ...real,
    put: async (p, b) => {
      if ((b as Record<string, unknown>).data_only !== undefined) {
        refusedOnce++;
        throw new ApiError(400, 'unknown', 'UNKNOWN_FIELD', { fields: ['data_only'] });
      }
      return real.put(p, b);
    },
  };
  const drafts = { base: { ...OWNER_DRAFTS().base, supplier_cost_amount: '899' } };
  const res = await commitPricing(io, SNAP, drafts, {});
  assert.equal(refusedOnce, 1);
  assert.equal(res.kind, 'held', JSON.stringify(res));
  if (res.kind === 'held') assert.equal(res.review.stored, false);
});

test('a cached preview whose conversion went stale: one fresh look, then the save', async () => {
  const w = pricingWorld();
  const io = ioOf(w);
  const current = await io.get(inputsPath(SNAP));
  const drafts = IQD_DRAFTS();
  const body = draftWire(drafts, current);
  const real = await io.post(previewPath(SNAP), { draft: body });
  const log: Call[] = [];
  const res = await commitPricing(ioOf(w, log), SNAP, drafts, { base: current, preview: { wire: JSON.stringify(body), answer: { ...real, conversion_hash: 'f'.repeat(64) } }, describe });
  assert.equal(res.kind, 'saved', JSON.stringify(res));
  assert.deepEqual(log.map((c) => `${c.method} ${c.status}${c.code ? ` ${c.code}` : ''}`), ['PUT 409 PRICING_PREVIEW_STALE', 'POST 200', 'PUT 200']);
});

test('the server’s own validation, field by field, before anything is sent', () => {
  // The supplier cost: a thousands separator, a trailing point, too many digits; the Arabic decimal key is fine.
  assert.deepEqual(draftProblems({ supplier_cost_amount: '1,250' }), { supplier_cost_amount: 'separator' });
  assert.deepEqual(draftProblems({ supplier_cost_amount: '1 100' }), { supplier_cost_amount: 'separator' });
  assert.deepEqual(draftProblems({ supplier_cost_amount: '899.' }), { supplier_cost_amount: 'invalid' });
  assert.deepEqual(draftProblems({ supplier_cost_amount: '0' }), { supplier_cost_amount: 'invalid' });
  assert.deepEqual(draftProblems({ supplier_cost_amount: '1234567890123' }), { supplier_cost_amount: 'too_long' });
  assert.deepEqual(draftProblems({ supplier_cost_amount: '1.1234567' }), { supplier_cost_amount: 'too_long' });
  for (const ok of ['٨٩٩٫٥', '899,5', '899.50', '۸۹۹']) assert.deepEqual(draftProblems({ supplier_cost_amount: ok }), {}, ok);
  // The CBM: 3 integer digits, 9 decimals, 12 characters.
  assert.deepEqual(draftProblems({ manual_cbm: '٠٫١٥' }), {});
  assert.deepEqual(draftProblems({ manual_cbm: '0,155' }), { manual_cbm: 'separator' });
  assert.deepEqual(draftProblems({ manual_cbm: '1.1234567891' }), { manual_cbm: 'too_long' });
  // The minimum profit: canonicalUsdRuleAmount's grammar (two decimals after trailing zeros drop; ≤ 100,000).
  for (const ok of ['120', '١٢٠', '120,5', '120.50', '120.500', '100000']) assert.equal(usdRuleProblem(ok), null, ok);
  for (const bad of ['120.555', '0', '100000.01', '1,200', '12.']) assert.notEqual(usdRuleProblem(bad), null, bad);
  // Direct Sale Extra: the 1,000 step; additional cost and box: the server's bounds.
  assert.deepEqual(draftProblems({ direct_sale_extra_iqd: 1500 }), { direct_sale_extra_iqd: 'step' });
  assert.deepEqual(draftProblems({ additional_cost_iqd: 2_000_000_000 }), { additional_cost_iqd: 'too_long' });
  assert.deepEqual(draftProblems({ box: [600, 520, 200_000] }), { box: 'too_long' });
  // Dinars: new ones need an approved rate (known missing = null); the same stored dinars convert nothing.
  const storedIqd = { supplier_input_mode: 'IQD_CONVERTED', original_input_amount: '1450000' } as never;
  assert.deepEqual(draftProblems({ supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_450_000 }, null, { usdIqdRate: null }), { supplier_cost_iqd: 'fx_missing' });
  assert.deepEqual(draftProblems({ supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_450_000 }, null, { usdIqdRate: '1600' }), {});
  assert.deepEqual(draftProblems({ supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_450_000 }, null), {}, 'unknown (a new product): the server answers');
  assert.deepEqual(draftProblems({ supplier_cost_iqd: 1_450_000 }, storedIqd, { usdIqdRate: null }), {}, 'the stored dinars again');
  assert.deepEqual(draftProblems({ supplier_cost_iqd: 1_450_000, reconvert: true }, storedIqd, { usdIqdRate: null }), { supplier_cost_iqd: 'fx_missing' });
  // A currency cleared while a stored amount stays: refused by the server, named here first.
  assert.deepEqual(draftProblems({ supplier_cost_currency: '' }, { supplier_cost_amount: '899', supplier_input_mode: 'SOURCE_CURRENCY' } as never), { supplier_cost_currency: 'needs_currency' });
});

test('the wire is the canonical text the server stores; a refusal is placed at its draft and section; a stored complete answer opens the review', () => {
  const answer = {
    product_id: 'p1', mode: 'manual', inputs_seq: 2, rates: { usd_iqd_rate: '1600', review_pending: false, derived_stale: false }, models: [], rows: [], preview_hash: 'a'.repeat(64),
    scopes: [
      { scope: 'base', scope_id: '', name_ar: '', name_en: '', name_ckb: '', pricing_inputs: null, minimum_target_profit_usd: null, target_profit_iqd: null, target_profit_state: null, direct_sale_extra_iqd: null, direct_sale_extra_state: null },
      { scope: 'option', scope_id: 'm1', name_ar: 'موديل', name_en: 'Model', name_ckb: 'مۆدێل', pricing_inputs: null, minimum_target_profit_usd: null, target_profit_iqd: null, target_profit_state: null, direct_sale_extra_iqd: null, direct_sale_extra_state: null },
    ],
  } as unknown as UsdPricingAnswer;
  const wire = draftWire({ base: { supplier_cost_amount: '٠٨٩٩٫٥٠', manual_cbm: '٠٫١٥٠', minimum_target_profit_usd: '١٢٠,٥' } }, answer);
  assert.deepEqual(wire.inputs, [{ scope: 'base', supplier_cost_amount: '899.5', supplier_cost_currency: 'USD', manual_cbm: '0.15' }]);
  assert.deepEqual(wire.rules, [{ kind: 'target_profit', scope: 'product', amount_usd: '120.5' }]);

  const drafts = { 'option:m1': { minimum_target_profit_usd: '5' }, base: { supplier_cost_amount: '1' } };
  const at = (code: string, details: Record<string, unknown>) => refusalTarget(new ApiError(400, '', code, details), drafts);
  assert.deepEqual(at('PRICING_INPUT_INVALID', { field: 'supplier_cost_amount' }), { key: 'base', field: 'supplier_cost_amount', section: 3 });
  assert.deepEqual(at('PRICING_INPUT_INVALID', { field: 'minimum_target_profit_usd' }), { key: 'option:m1', field: 'minimum_target_profit_usd', section: 5 });
  assert.deepEqual(at('PRICING_INPUT_INVALID', { field: 'rules[0].amount_usd' }), { key: 'option:m1', field: 'minimum_target_profit_usd', section: 5 });
  assert.deepEqual(at('PRICING_FX_RATE_MISSING', { field: 'supplier_cost_iqd', scope: 'option', scope_id: 'm1' }), { key: 'option:m1', field: 'supplier_cost_iqd', section: 5 });
  assert.deepEqual(at('PRICING_CHANGED', {}), { key: null, field: null, section: 3 });
  assert.deepEqual(refusalTarget(new Error('network'), drafts), { key: null, field: null, section: 3 });

  const adoption = { kind: 'adopt', complete: true, needs_write: true } as never;
  assert.deepEqual(readyReview('p1', { ...answer, adoption }), { pid: 'p1', body: { inputs_seq: 2, inputs: [], rules: [] }, hash: 'a'.repeat(64), adoption, error: '', stored: true });
  for (const off of [{ kind: null, complete: true, needs_write: true }, { kind: 'adopt', complete: false, needs_write: true }, { kind: 'adopt', complete: true, needs_write: false }])
    assert.equal(readyReview('p1', { ...answer, adoption: off as never }), null, JSON.stringify(off));
  assert.equal(readyReview('p1', { ...answer, adoption, preview_hash: '' }), null);
  assert.equal(readyReview('p1', null), null);

  // «<scope> · <field>: <reason>», the product first, in each language.
  const where = invalidWhere({ 'option:m1': { minimum_target_profit_usd: '120.555' }, base: { supplier_cost_amount: '1,250' } }, answer, null, 'ar');
  assert.equal(where.section, 3);
  assert.equal(where.text, `${S.productLevel} · ${S.supplierCost}: ${S.decimalSeparator}؛ موديل · ${S.minProfit}: ${PROCUREMENT_PRICING_STRINGS.ar.invalid}`);
  const en = invalidWhere({ 'option:m1': { direct_sale_extra_iqd: 1500 } }, answer, null, 'en');
  assert.deepEqual(en, { text: `Model · ${USD_PRICING_FORM_STRINGS.en.extra}: ${USD_PRICING_FORM_STRINGS.en.extraInvalid}`, section: 5 });
  assert.deepEqual(invalidWhere({ base: { supplier_cost_amount: '899' } }, answer, null, 'ckb'), { text: '', section: 3 });
});
