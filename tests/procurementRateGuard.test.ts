/**
 * THE PURCHASE DOCUMENT'S EXCHANGE RATE (Pricing V2 stage V2-0, F4 and F17;
 * docs/DECISIONS.md row 224).
 *
 * F4: a new purchase and every currency switch started at `exchange_rate: 1`
 * and the server accepted any positive rate, so a USD purchase saved with the
 * prefilled 1 booked one dinar per dollar into an immutable lot. Now the rate
 * is prefilled from the APPROVED central rate (the engine's `pricing_fx_rates`),
 * a save without an approved rate is refused, and a rate more than 6% away
 * needs `confirm_rate: true` — decided by the server.
 *
 * F17: the owner's finance screens (the purchase panel with its funding and
 * product steps, the selection price dialog, the legacy investment register)
 * carry their own Sorani for every `loc()` call instead of falling back to the
 * Arabic (row 183).
 *
 * Run: node --import tsx --test tests/procurementRateGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { get, json, post, put, type StubUser } from './fixtures/app';
import { AMS, pricingWorld } from './fixtures/procurementPricing';
import { ROOT } from './fixtures/d1';
import { procurementRateFar, PROCUREMENT_RATE_DRIFT_PCT } from '../packages/contracts/src/procurementRate';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import { approvedRateOf, prefillRate, procurementRateStrings, rateStanding } from '../src/components/adminOperations/procurementRate';

const STAFF: StubUser = { id: 'usr_staff', role: 'admin', email: 'staff@x.co', admin_scope: 'assistant' };

/** A manual (no route) document in `currency` at `rate`, one AMS line. */
const manualDoc = (currency: string, rate: number, extra: Record<string, unknown> = {}) => ({
  operation_id: `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
  currency,
  exchange_rate: rate,
  status: 'ordered',
  cost_state: 'final',
  lines: [{ product_id: AMS, scope: 'option', scope_id: `${AMS}_o0`, qty_ordered: 1, source_unit_amount: currency === 'IQD' ? 450_000 : 300, weight_g: 2500, volume_mm3: 0 }],
  charges: [],
  ...extra,
});

const purchases = (w: ReturnType<typeof pricingWorld>) => Number((w.raw.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get() as { n: number }).n);

// ---------------------------------------------------------------- the 6% rule

test('more than 6% either side is far; exactly 6% is not; an unreadable rate is never close', () => {
  assert.equal(PROCUREMENT_RATE_DRIFT_PCT, 6);
  assert.equal(procurementRateFar(1600, 1600), false);
  assert.equal(procurementRateFar(1696, 1600), false, '+6% exactly is accepted');
  assert.equal(procurementRateFar(1504, 1600), false, '−6% exactly is accepted');
  assert.equal(procurementRateFar(1696.01, 1600), true);
  assert.equal(procurementRateFar(1503.99, 1600), true);
  assert.equal(procurementRateFar(1, 1600), true, 'the old prefilled 1 is far');
  for (const bad of [NaN, 0, -5, Infinity]) assert.equal(procurementRateFar(bad, 1600), true);
  assert.equal(procurementRateFar(1600, 0), true);
});

// ---------------------------------------------------------------- the server decides

test('/config hands the owner the approved central rates the engine prices at — EUR and CNY through the dollar', async () => {
  const w = pricingWorld();
  const res = await get(w.app, '/api/admin/procurement/config');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.approved_rates, [
    { currency: 'USD', rate_iqd: '1600', usd_iqd_rate: '1600', cross_rate: null },
    { currency: 'EUR', rate_iqd: '1760', usd_iqd_rate: '1600', cross_rate: '1.1' },
    { currency: 'CNY', rate_iqd: '224', usd_iqd_rate: '1600', cross_rate: '0.14' },
  ]);
  // Every route carries its Sorani name (F17).
  assert.deepEqual(body.cost_profiles.map((p: { name_ckb: string }) => p.name_ckb), ['ئەڵمانیا — ناردنی وشکانی', 'چین — ناردنی ئاسمانی', 'چین — ناردنی دەریایی']);
});

test('no approved rate: nothing to prefill, and a USD, EUR or CNY save is refused — never booked at 1; IQD still saves', async () => {
  const w = pricingWorld({ rates: false });
  assert.deepEqual((await json(await get(w.app, '/api/admin/procurement/config'))).approved_rates, []);
  for (const currency of ['USD', 'CNY']) {
    const res = await post(w.app, '/api/admin/procurement/documents', manualDoc(currency, 1500, { confirm_rate: true }));
    assert.equal(res.status, 409, currency);
    const body = await json(res);
    assert.equal(body.code, 'PURCHASE_RATE_NOT_APPROVED', 'the tick cannot stand in for an approved rate');
  }
  const eur = await post(w.app, '/api/admin/procurement/documents', w.draft());
  assert.equal((await json(eur)).code, 'PURCHASE_RATE_NOT_APPROVED');
  assert.equal(purchases(w), 0, 'nothing written');
  const iqd = await post(w.app, '/api/admin/procurement/documents', manualDoc('IQD', 1));
  assert.equal(iqd.status, 200, JSON.stringify(await json(iqd)));
});

test('the old prefilled 1 is refused without the tick; within 6% saves as typed; the refusal names no figure', async () => {
  const w = pricingWorld();
  const res = await post(w.app, '/api/admin/procurement/documents', manualDoc('USD', 1));
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'PURCHASE_RATE_CONFIRM_REQUIRED');
  assert.equal(body.details, undefined);
  assert.doesNotMatch(JSON.stringify(body), /1600|1,600|1٬600/, 'the refusal carries no rate');
  assert.equal(purchases(w), 0);
  // 3% above the approved 1,600, and exactly 6% below: no tick needed; the document keeps the rate typed.
  for (const rate of [1648, 1504]) {
    const id = await w.save(manualDoc('USD', rate));
    assert.equal((w.raw.prepare('SELECT exchange_rate FROM purchase_orders WHERE id = ?').get(id) as { exchange_rate: number }).exchange_rate, rate);
  }
});

test('a far rate saves only with the owner’s explicit confirm_rate — on a routed EUR purchase too', async () => {
  const w = pricingWorld();
  // 1,900 IQD per euro is 8% above the approved 1.1 × 1,600 = 1,760.
  const refused = await post(w.app, '/api/admin/procurement/documents', w.draft({ exchange_rate: 1900 }));
  assert.equal((await json(refused)).code, 'PURCHASE_RATE_CONFIRM_REQUIRED');
  for (const flag of ['true', 1, 'yes']) {
    const loose = await post(w.app, '/api/admin/procurement/documents', w.draft({ exchange_rate: 1900, confirm_rate: flag }));
    assert.equal((await json(loose)).code, 'PURCHASE_RATE_CONFIRM_REQUIRED', `confirm_rate must be the boolean true, not ${JSON.stringify(flag)}`);
  }
  const id = await w.save(w.draft({ exchange_rate: 1900, confirm_rate: true }));
  assert.equal((w.raw.prepare('SELECT exchange_rate FROM purchase_orders WHERE id = ?').get(id) as { exchange_rate: number }).exchange_rate, 1900);
  // The approved rate itself needs nothing.
  await w.save(w.draft());
});

test('an edit is checked again: moving a saved purchase’s rate far away needs the tick', async () => {
  const w = pricingWorld();
  const id = await w.save(manualDoc('USD', 1600, { status: 'draft' }));
  const version = (w.raw.prepare('SELECT version FROM purchase_orders WHERE id = ?').get(id) as { version: number }).version;
  const far = await put(w.app, `/api/admin/procurement/documents/${id}`, manualDoc('USD', 1200, { status: 'draft', version }));
  assert.equal(far.status, 409);
  assert.equal((await json(far)).code, 'PURCHASE_RATE_CONFIRM_REQUIRED');
  const ok = await put(w.app, `/api/admin/procurement/documents/${id}`, manualDoc('USD', 1200, { status: 'draft', version, confirm_rate: true }));
  assert.equal(ok.status, 200, JSON.stringify(await json(ok)));
});

test('no visibility is widened: an assistant admin reads no rates and saves no purchase', async () => {
  const w = pricingWorld({ user: STAFF });
  const config = await get(w.app, '/api/admin/procurement/config');
  assert.equal(config.status, 403);
  const body = await json(config);
  assert.equal(body.approved_rates, undefined);
  assert.doesNotMatch(JSON.stringify(body), /1600|1760|224/);
  const save = await post(w.app, '/api/admin/procurement/documents', manualDoc('USD', 1600));
  assert.equal(save.status, 403);
});

// ---------------------------------------------------------------- the screen asks first

const APPROVED = [
  { currency: 'USD' as const, rate_iqd: '1600', usd_iqd_rate: '1600', cross_rate: null },
  { currency: 'EUR' as const, rate_iqd: '1760', usd_iqd_rate: '1600', cross_rate: '1.1' },
];

test('the screen prefills from the approved rate, leaves the field empty without one, and asks for the tick when far', () => {
  assert.equal(prefillRate(APPROVED, 'USD'), 1600);
  assert.equal(prefillRate(APPROVED, 'EUR'), 1760);
  assert.ok(Number.isNaN(prefillRate(APPROVED, 'CNY')), 'no approved CNY rate: empty, never 1');
  assert.ok(Number.isNaN(prefillRate([], 'USD')));
  assert.equal(prefillRate(APPROVED, 'IQD'), 1);
  assert.equal(approvedRateOf(APPROVED, 'IQD'), null);
  assert.equal(rateStanding(APPROVED, 'IQD', 1), 'iqd');
  assert.equal(rateStanding(APPROVED, 'CNY', 224), 'missing');
  assert.equal(rateStanding(APPROVED, 'USD', 1), 'far');
  assert.equal(rateStanding(APPROVED, 'EUR', 1900), 'far');
  assert.equal(rateStanding(APPROVED, 'EUR', 1800), 'ok');
  assert.equal(rateStanding(APPROVED, 'USD', NaN), 'ok', 'an empty field is the input’s own check');
});

test('the rate strings exist in three languages; the Sorani is its own', () => {
  const [ar, en, ckb] = (['ar', 'en', 'ckb'] as const).map(procurementRateStrings);
  const eur = APPROVED[1]!;
  for (const key of ['confirm', 'useCentral', 'missing'] as const) {
    assert.notEqual(ckb[key], ar[key], key);
    assert.notEqual(ckb[key], en[key], key);
    assert.match(ckb[key], /[ڕڵێۆەڤگچپژ]/, key);
    assert.doesNotMatch(ckb[key], /[ةىيك]/, key);
  }
  assert.equal(ckb.missing, COST_REFUSALS.PURCHASE_RATE_NOT_APPROVED.ckb);
  for (const s of [ar, en, ckb]) {
    assert.match(s.central(eur), /1,760/);
    assert.match(s.central(eur), /1\.1/, 'the chain through the dollar is shown');
    assert.match(s.far(eur), /6/);
  }
  assert.doesNotMatch(ckb.far(eur), /[ةىيك]/);
  assert.doesNotMatch(ckb.central(eur), /[ةىيك]/);
});

const src = (path: string) => readFileSync(join(ROOT, path), 'utf8');

test('the purchase panel never seeds 1 for a foreign currency; it prefills, blocks and sends the tick', () => {
  const panel = src('src/components/adminOperations/ProcurementPanel.tsx');
  assert.doesNotMatch(panel, /update\('exchange_rate', 1\)/, 'a currency switch no longer seeds 1');
  assert.doesNotMatch(panel, /profile\.exchange_rate \?\? NaN : 1/, 'a route no longer seeds its saved rate');
  assert.match(panel, /update\('exchange_rate', prefillRate\(config\.approved_rates, v\)\)/);
  assert.match(panel, /exchange_rate: prefillRate\(config\.approved_rates, profile\?\.currency \?\? 'IQD'\)/);
  assert.match(panel, /clone \? \{ exchange_rate: prefillRate\(config\.approved_rates, snapshot\.currency\) \}/, 'a copy is priced today');
  assert.match(panel, /rateStand === 'far' && rateConfirmed \? \{ confirm_rate: true \}/);
  assert.match(panel, /fundingNeedsFinalCost \|\| !rateReady/, 'the confirm waits for the rate');
  assert.match(panel, /data-purchase-rate="missing"/);
  assert.match(panel, /data-purchase-rate="far"/);
});

test('«Keep this session’s draft» (serials, local only) shows no rate refusal; the server draft save still waits for the rate', () => {
  const panel = src('src/components/adminOperations/ProcurementPanel.tsx');
  const handler = panel.match(/onClick=\{\(\) => \{ saveLocal\(\);([^\n]*?)\}\}>\{hasDraftSerials/)?.[1];
  assert.ok(handler, 'the draft button handler');
  // The rate refusal sits inside the branch that sends the draft to the server…
  assert.match(handler, /^ if \(costsValid && originsValid && !hasDraftSerials\) \{ if \(!rateReady\) \{ op\.setError\([^;]*\); return; \} op\.run\(\(\) => save\('draft'\)/);
  // …so a local-only keep (a draft with serials) never reaches it.
  assert.equal(handler.indexOf('!rateReady') > handler.indexOf('!hasDraftSerials'), true);
});

/** Every `loc()` call of a file: its argument texts (null for a non-literal) and its line. */
function locCalls(path: string) {
  const sf = ts.createSourceFile(path, src(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ line: number; args: Array<string | null>; raw: string[] }> = [];
  const visit = (node: ts.Node) => {
    // `loc(...STATUS_LABELS[x])` spreads a typed [ar, en, ckb] triple: the tuple type holds it.
    const spread = ts.isCallExpression(node) && node.arguments.length === 1 && ts.isSpreadElement(node.arguments[0]!);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'loc' && !spread)
      out.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        args: node.arguments.map((a) => (ts.isStringLiteralLike(a) ? a.text : null)),
        raw: node.arguments.map((a) => a.getText()),
      });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

test('F17: the owner finance screens give every loc() its own Sorani — never the Arabic fallback (row 183)', () => {
  for (const path of [
    'src/components/adminOperations/ProcurementPanel.tsx',
    // The panel's funding step (step 0) and product step (step 1).
    'src/components/adminOperations/PurchaseFundingFields.tsx',
    'src/components/adminOperations/StockSelection.tsx',
    // SelectionPriceUpdate (a dinar store-price door) was deleted by the Pricing V2 clean start (DECISIONS
    // row 222); its successor, the product's purchase review, is pinned below.
    'src/components/financePeople/LegacyInvestmentHistory.tsx',
  ]) {
    const calls = locCalls(path);
    assert.ok(calls.length > 0, path);
    for (const call of calls) {
      const where = `${path}:${call.line}`;
      assert.equal(call.args.length, 3, `${where} falls back to the Arabic: ${call.raw.join(', ')}`);
      const [ar, , ckb] = call.args;
      if (ar === null || ckb === null) continue; // a route's own names (name_ar, name_en, name_ckb)
      assert.notEqual(ckb, ar, `${where}: the Sorani slot carries the Arabic`);
      assert.doesNotMatch(ckb, /[ةىيك]/, `${where}: an Arabic-only letter in the Sorani`);
    }
  }
  // «إضافة مخزون موجود», the finding's example, reads in Sorani.
  assert.match(src('src/components/adminOperations/ProcurementPanel.tsx'), /loc\('إضافة مخزون موجود', 'Add stock on hand', 'زیادکردنی کۆگای ئامادە'\)/);
  assert.match(src('src/components/adminOperations/ProcurementPanel.tsx'), /loc\(p\.name_ar, p\.name_en, p\.name_ckb\)/);
  // The purchase review (Pricing V2 D1) that replaced SelectionPriceUpdate: every entry of its string
  // table carries its own Sorani.
  const review = src('src/components/adminProducts/form/v2/PurchaseReviewCard.tsx');
  const entries = [...review.matchAll(/\{ ar: '([^']*)', en: '[^']*', ckb: '([^']*)' \}/g)];
  assert.ok(entries.length >= 9, 'the purchase review string table');
  for (const [, ar, ckb] of entries) {
    assert.notEqual(ckb, ar, `PurchaseReviewCard: the Sorani slot carries the Arabic (${ar})`);
    assert.doesNotMatch(ckb!, /[ةىيك]/, `PurchaseReviewCard: an Arabic-only letter in the Sorani (${ckb})`);
  }
});
