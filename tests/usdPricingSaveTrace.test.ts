/**
 * THE OWNER'S «التسعير بالدولار والشحن» SAVE, TRACED THROUGH THE REAL ROUTES
 * (owner's report 2026-10-10: «بالرغم من كتابة التسعير بالدولار والشحن وملء
 * الحقول فعند الضغط على كلمة نشر والحفظ لا يحفظ وعند الرجوع إلى تعديل المنتج
 * تبقى القيم فارغة»).
 *
 * The product is the census twin of the owner's: `snapmaker-u1` — a manual
 * store price, a legacy product cost («التكلفة القديمة»), ONE option group with
 * ONE value, no colours, sold direct and by sea pre-order. Every save below is
 * the body the product form's `draftWire` builds (src/components/adminProducts/
 * form/UsdPricingSection.tsx), sent as the owner to PUT /api/admin/pricing/
 * products/:id/inputs, then read back with GET …/inputs exactly where the form
 * reads it (`scopes[].pricing_inputs`, `minimum_target_profit_usd`,
 * `direct_sale_extra_iqd`).
 *
 * Two worlds:
 *   LIVE-LIKE  no effective FX rate (each pair holds a FIRST_VALUE candidate the
 *              owner has not approved, the market adjustment untouched) and no
 *              central shipping rate — the live site on 2026-10-10;
 *   NORMAL     the brief's rates (1 USD = 1,600 IQD, EUR/USD 1.1, CNY/USD 0.14)
 *              approved and the three central shipping rates set.
 *
 * Each test asserts what the code does and writes one diagnostic line per step
 * (status, code, what persisted) — the trace the report quotes. Two of them
 * changed with the fix (docs/DECISIONS.md, the row of 2026-10-10): the dinar
 * refusal names its field and scope, and «٨٩٩٫٥» / '899,5' are read as typed.
 * The product form's own save path (`data_only`) is proven in
 * tests/usdPricingDataFirst.test.ts and tests/usdPricingCommit.test.ts; the
 * saves here are the bodies WITHOUT it (every other caller), unchanged.
 *
 * Run: node --import tsx --test tests/usdPricingSaveTrace.test.ts
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { count, get, json, stubApp } from './fixtures/app';
import { OWNER_USER, pricingWorld } from './fixtures/procurementPricing';
import { OWNER_BASE, OWNER_RULES, SNAP, SNAP_MODEL, liveLikeWorld, persisted, readBack, storePrice, type Answer } from './fixtures/usdPricingSave';
import { adminProductsRoutes } from '../worker/routes/adminProducts';

type ScopeKey = { scope: string; scope_id: string };

const trace = (t: TestContext, step: string, r: { status: number; body: Answer }, extra: unknown = undefined) =>
  t.diagnostic(`${step} → ${r.status}${r.body?.code ? ` ${r.body.code}` : ''}${r.body?.details?.field ? ` field=${r.body.details.field}` : ''}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);

// ------------------------------------------------------------------ the live-like state

test('LIVE-LIKE: GET before any save — the panel reads empty fields, the store has nothing, rates are absent', async (t) => {
  const w = liveLikeWorld();
  const g = await w.getInputs(SNAP);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  trace(t, 'GET inputs', g, { mode: g.body.mode, inputs_seq: g.body.inputs_seq, rates: g.body.rates, scopes: g.body.scopes.map((s: ScopeKey) => `${s.scope}:${s.scope_id}`) });
  assert.equal(g.body.mode, 'manual');
  assert.equal(g.body.inputs_seq, 0);
  assert.deepEqual(
    g.body.scopes.map((s: ScopeKey) => `${s.scope}:${s.scope_id}`),
    ['base:', `option:${SNAP_MODEL}`]
  );
  assert.equal(g.body.rates.usd_iqd_rate, null);
  assert.equal(g.body.scopes[0].pricing_inputs, null);
  assert.equal(g.body.adoption.kind, null);
  assert.ok(g.body.adoption.missing_codes.includes('FX_RATE_MISSING'), JSON.stringify(g.body.adoption.missing_codes));
  t.diagnostic(`model bar: ${JSON.stringify({ state: g.body.models[0].pricing_summary.state, issues: g.body.models[0].pricing_summary.issue_codes })}`);
});

test('LIVE-LIKE: the owner’s full USD entry (cost, currency, sea route + box, extra cost, minimum profit, Direct Sale Extra) IS STORED at the product scope and read back field for field; the store price and the old cost stay', async (t) => {
  const w = liveLikeWorld();
  const before = storePrice(w.raw);
  const g0 = await w.getInputs(SNAP);
  const preview = await w.previewInputs(SNAP, { inputs: [OWNER_BASE], rules: OWNER_RULES });
  trace(t, 'POST preview (full entry)', preview, { adoption: preview.body.adoption && { kind: preview.body.adoption.kind, missing: preview.body.adoption.missing_codes } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const r = await w.putInputs(SNAP, { inputs_seq: g0.body.inputs_seq, inputs: [OWNER_BASE], rules: OWNER_RULES });
  trace(t, 'PUT inputs (full entry)', r);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = persisted(w.raw);
  t.diagnostic(`persisted: ${JSON.stringify(p)}`);
  assert.equal(p.inputs.length, 1);
  assert.deepEqual(p.inputs[0], {
    scope: 'base',
    scope_id: '',
    supplier_cost_amount: '899',
    supplier_cost_currency: 'USD',
    supplier_input_mode: 'SOURCE_CURRENCY',
    original_input_amount: null,
    conversion_rate_snapshot: null,
    shipping_profile: 'CHINA_SEA',
    shipping_weight_g: null,
    shipping_length_mm: 600,
    shipping_width_mm: 520,
    shipping_height_mm: 480,
    manual_cbm: null,
    additional_cost_iqd: 15000,
  });
  assert.deepEqual(
    p.rules.map((x) => [x.kind, x.scope, x.scope_id, x.state, x.amount_usd, x.amount_iqd]),
    [
      ['direct_sale_extra', 'product', '', 'ACTIVE', null, 25000],
      ['target_profit', 'product', '', 'ACTIVE', '120', null],
    ]
  );
  assert.equal(p.state?.mode, 'manual');
  // Data only: no price, no cost of the store moved (decision 8 — the engine prices only once complete).
  assert.equal(storePrice(w.raw), before);

  const back = await w.getInputs(SNAP);
  const base = readBack(back.body, 'base');
  t.diagnostic(`GET read-back (base): ${JSON.stringify(base)}`);
  assert.deepEqual(base, {
    supplier_cost_amount: '899',
    supplier_cost_currency: 'USD',
    supplier_input_mode: 'SOURCE_CURRENCY',
    original_input_amount: null,
    shipping_profile: 'CHINA_SEA',
    shipping_weight_g: null,
    box: [600, 520, 480],
    manual_cbm: null,
    additional_cost_iqd: 15000,
    minimum_target_profit_usd: '120',
    direct_sale_extra_iqd: 25000,
  });
  assert.equal(back.body.mode, 'manual');
  assert.equal(back.body.adoption.kind, null);
  t.diagnostic(`after save: adoption.missing_codes=${JSON.stringify(back.body.adoption.missing_codes)} bar=${JSON.stringify({ state: back.body.models[0].pricing_summary.state, issues: back.body.models[0].pricing_summary.issue_codes })}`);
  assert.ok(back.body.adoption.missing_codes.includes('FX_RATE_MISSING'));
});

test('LIVE-LIKE: a partial entry (cost + currency only — no route, no minimum profit) is stored; EUR and CNY with no approved rate are stored; a route with no central rate is stored', async (t) => {
  const w = liveLikeWorld();
  const a = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [{ scope: 'base', supplier_cost_amount: '899', supplier_cost_currency: 'USD' }], rules: [] });
  trace(t, 'PUT cost+currency only', a);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(
    [readBack(a.body, 'base')!.supplier_cost_amount, readBack(a.body, 'base')!.supplier_cost_currency, readBack(a.body, 'base')!.shipping_profile],
    ['899', 'USD', null]
  );

  const eur = await w.putInputs(SNAP, { inputs_seq: a.body.inputs_seq, inputs: [{ scope: 'base', supplier_cost_amount: '820', supplier_cost_currency: 'EUR' }] });
  trace(t, 'PUT EUR (no EUR rate)', eur);
  assert.equal(eur.status, 200, JSON.stringify(eur.body));
  const cny = await w.putInputs(SNAP, { inputs_seq: eur.body.inputs_seq, inputs: [{ scope: 'base', supplier_cost_amount: '6400', supplier_cost_currency: 'CNY', shipping_profile: 'CHINA_AIR', shipping_weight_g: 28000 }] });
  trace(t, 'PUT CNY + CHINA_AIR (no CNY rate, no air rate)', cny);
  assert.equal(cny.status, 200, JSON.stringify(cny.body));
  assert.deepEqual(persisted(w.raw).inputs.map((r) => [r.supplier_cost_amount, r.supplier_cost_currency, r.shipping_profile, r.shipping_weight_g]), [['6400', 'CNY', 'CHINA_AIR', 28000]]);

  // A currency with no amount is a legal row (0181 CHECK is amount → currency only).
  const cur = await w.putInputs(SNAP, { inputs_seq: cny.body.inputs_seq, inputs: [{ scope: 'base', supplier_cost_amount: null, supplier_cost_currency: 'USD' }] });
  trace(t, 'PUT amount=null + currency USD', cur);
  assert.equal(cur.status, 200, JSON.stringify(cur.body));
  assert.deepEqual([readBack(cur.body, 'base')!.supplier_cost_amount, readBack(cur.body, 'base')!.supplier_cost_currency], [null, 'USD']);
});

test('LIVE-LIKE: the supplier cost typed IN DINARS is refused 409 PRICING_FX_RATE_MISSING — preview and save alike, naming the field and scope (never the amount) — and nothing of that batch is stored', async (t) => {
  const w = liveLikeWorld();
  const entry = { scope: 'base', supplier_cost_iqd: 1_450_000, shipping_profile: 'CHINA_SEA', additional_cost_iqd: 15000 };
  const preview = await w.previewInputs(SNAP, { inputs: [entry], rules: OWNER_RULES });
  trace(t, 'POST preview (IQD cost)', preview);
  assert.equal(preview.status, 409);
  assert.equal(preview.body.code, 'PRICING_FX_RATE_MISSING');
  // The form's save carries the preview's hash only when it has one; a failed preview has none.
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [entry], rules: OWNER_RULES });
  trace(t, 'PUT inputs (IQD cost, no hash)', r);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'PRICING_FX_RATE_MISSING');
  // The form puts the reason under «تكلفة المورد بالدينار» of the product level (ids only, no value).
  assert.deepEqual(r.body.details, { field: 'supplier_cost_iqd', scope: 'base', scope_id: '' });
  assert.doesNotMatch(JSON.stringify(r.body), /1450000|1,450,000/);
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
});

test('LIVE-LIKE: the supplier cost and the CBM read a decimal AS TYPED — «٨٩٩٫٥», \'899,5\', \'0,15\', «٠٫١٥» are stored canonical; a thousands separator or a trailing point is still refused by field, and nothing of that batch is stored', async (t) => {
  const w = liveLikeWorld();
  const pv = await w.previewInputs(SNAP, { inputs: [{ ...OWNER_BASE, supplier_cost_amount: '٨٩٩٫٥' }], rules: OWNER_RULES });
  trace(t, 'POST preview supplier_cost_amount="٨٩٩٫٥"', pv);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(readBack(pv.body, 'base')!.supplier_cost_amount, '899.5');
  for (const amount of ['1,250', '1,250,000', '899.']) {
    const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [{ ...OWNER_BASE, supplier_cost_amount: amount }], rules: OWNER_RULES });
    trace(t, `PUT supplier_cost_amount=${JSON.stringify(amount)}`, r);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRICING_INPUT_INVALID');
    assert.equal(r.body.details.field, 'supplier_cost_amount');
  }
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
  let seq = 0;
  for (const amount of ['899,5', '٨٩٩٫٥']) {
    const r = await w.putInputs(SNAP, { inputs_seq: seq, inputs: [{ ...OWNER_BASE, supplier_cost_amount: amount }], rules: OWNER_RULES });
    trace(t, `PUT supplier_cost_amount=${JSON.stringify(amount)}`, r);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(readBack(r.body, 'base')!.supplier_cost_amount, '899.5');
    seq = r.body.inputs_seq;
  }
  for (const cbm of ['0,15', '٠٫١٥']) {
    const r = await w.putInputs(SNAP, { inputs_seq: seq, inputs: [{ scope: 'base', manual_cbm: cbm }] });
    trace(t, `PUT manual_cbm=${JSON.stringify(cbm)}`, r);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(readBack(r.body, 'base')!.manual_cbm, '0.15');
    seq = r.body.inputs_seq;
  }
  const badCbm = await w.putInputs(SNAP, { inputs_seq: seq, inputs: [{ scope: 'base', manual_cbm: '0,155' }] });
  trace(t, 'PUT manual_cbm="0,155"', badCbm);
  assert.equal(badCbm.status, 400);
  assert.equal(badCbm.body.details.field, 'manual_cbm');
  // Arabic-Indic digits with no separator, and the minimum profit's decimal comma, are read as before.
  const ok = await w.putInputs(SNAP, { inputs_seq: seq, inputs: [{ ...OWNER_BASE, supplier_cost_amount: '٨٩٩' }], rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '120,5' }] });
  trace(t, 'PUT supplier_cost_amount="٨٩٩" + amount_usd="120,5"', ok);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(readBack(ok.body, 'base')!.supplier_cost_amount, '899');
  assert.equal(readBack(ok.body, 'base')!.minimum_target_profit_usd, '120.5');
});

test('LIVE-LIKE: every other refusal of PUT …/inputs, by code — and nothing persists on any of them', async (t) => {
  const w = liveLikeWorld();
  const cases: Array<[string, Record<string, unknown>, number, string, string?]> = [
    ['inputs_seq missing', { inputs: [OWNER_BASE] }, 400, 'PRICING_INPUT_INVALID', 'inputs_seq'],
    ['inputs_seq stale', { inputs_seq: 7, inputs: [OWNER_BASE] }, 409, 'PRICING_CHANGED'],
    ['unknown body key', { inputs_seq: 0, inputs: [OWNER_BASE], extra: 1 }, 400, 'UNKNOWN_FIELD'],
    ['unknown entry key', { inputs_seq: 0, inputs: [{ ...OWNER_BASE, pricing_weight_g: 10 }] }, 400, 'UNKNOWN_FIELD'],
    ['amount as JSON number', { inputs_seq: 0, inputs: [{ ...OWNER_BASE, supplier_cost_amount: 899 }] }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_amount'],
    ['amount with no currency', { inputs_seq: 0, inputs: [{ scope: 'base', supplier_cost_amount: '899' }] }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_currency'],
    ['currency ""', { inputs_seq: 0, inputs: [{ ...OWNER_BASE, supplier_cost_currency: '' }] }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_currency'],
    ['currency IQD with an amount', { inputs_seq: 0, inputs: [{ ...OWNER_BASE, supplier_cost_currency: 'IQD' }] }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_currency'],
    ['route ""', { inputs_seq: 0, inputs: [{ ...OWNER_BASE, shipping_profile: '' }] }, 400, 'PRICING_INPUT_INVALID', 'shipping_profile'],
    ['box with two axes', { inputs_seq: 0, inputs: [{ scope: 'base', shipping_length_mm: 600, shipping_width_mm: 520 }] }, 400, 'PRICING_INPUT_INVALID', 'shipping_box'],
    ['extra cost as text', { inputs_seq: 0, inputs: [{ ...OWNER_BASE, additional_cost_iqd: '15000' }] }, 400, 'PRICING_INPUT_INVALID', 'additional_cost_iqd'],
    ['weight as text', { inputs_seq: 0, inputs: [{ scope: 'base', shipping_weight_g: '28000' }] }, 400, 'PRICING_INPUT_INVALID', 'shipping_weight_g'],
    ['option scope unknown id', { inputs_seq: 0, inputs: [{ scope: 'option', scope_id: 'nope', additional_cost_iqd: 1 }] }, 400, 'PRICING_INPUT_INVALID', 'inputs[0].scope_id'],
    ['minimum profit 3 decimals', { inputs_seq: 0, rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '120.555' }] }, 400, 'PRICING_INPUT_INVALID', 'minimum_target_profit_usd'],
    ['minimum profit as dinars', { inputs_seq: 0, rules: [{ kind: 'target_profit', scope: 'product', amount_iqd: 150000 }] }, 400, 'PRICING_INPUT_INVALID', 'rules[0].amount_iqd'],
    ['Direct Sale Extra off the step', { inputs_seq: 0, rules: [{ kind: 'direct_sale_extra', scope: 'product', amount_iqd: 25500 }] }, 400, 'DIRECT_SALE_EXTRA_NOT_ON_STEP'],
    ['Direct Sale Extra as text', { inputs_seq: 0, rules: [{ kind: 'direct_sale_extra', scope: 'product', amount_iqd: '25000' }] }, 400, 'PRICING_INPUT_INVALID', 'direct_sale_extra_iqd'],
    ['empty rules list entry', { inputs_seq: 0, rules: [{}] }, 400, 'PRICING_INPUT_INVALID', 'rules[0].kind'],
  ];
  for (const [label, body, status, code, field] of cases) {
    const r = await w.putInputs(SNAP, body);
    trace(t, label, r);
    assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code, label);
    if (field) assert.equal(r.body.details?.field, field, label);
  }
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
});

test('LIVE-LIKE: a value saved at the MODEL (option) scope is stored there and read back there — the product scope stays empty', async (t) => {
  const w = liveLikeWorld();
  const r = await w.putInputs(SNAP, {
    inputs_seq: 0,
    inputs: [{ scope: 'option', scope_id: SNAP_MODEL, supplier_cost_amount: '899', supplier_cost_currency: 'USD', shipping_weight_g: 28000 }],
    rules: [{ kind: 'target_profit', scope: 'option', scope_id: SNAP_MODEL, amount_usd: '120' }],
  });
  trace(t, 'PUT at option scope', r);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const back = await w.getInputs(SNAP);
  t.diagnostic(`read-back base=${JSON.stringify(readBack(back.body, 'base'))}`);
  t.diagnostic(`read-back option=${JSON.stringify(readBack(back.body, 'option', SNAP_MODEL))}`);
  assert.equal(readBack(back.body, 'base')!.supplier_cost_amount, null);
  assert.equal(readBack(back.body, 'base')!.minimum_target_profit_usd, null);
  assert.equal(readBack(back.body, 'option', SNAP_MODEL)!.supplier_cost_amount, '899');
  assert.equal(readBack(back.body, 'option', SNAP_MODEL)!.minimum_target_profit_usd, '120');
});

test('LIVE-LIKE: the same body sent twice (a second «نشر») is a no-op 200 at the new counter, a stale counter is 409 PRICING_CHANGED; clearing with null hands the field back', async (t) => {
  const w = liveLikeWorld();
  const first = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ?', SNAP);
  const again = await w.putInputs(SNAP, { inputs_seq: first.body.inputs_seq, inputs: [OWNER_BASE], rules: OWNER_RULES });
  trace(t, 'PUT same body, fresh counter', again);
  assert.equal(again.status, 200);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ?', SNAP), audits);
  const stale = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES });
  trace(t, 'PUT same body, counter 0', stale);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PRICING_CHANGED');
  const cleared = await w.putInputs(SNAP, {
    inputs_seq: again.body.inputs_seq,
    inputs: [{ scope: 'base', supplier_cost_amount: null, shipping_profile: null, additional_cost_iqd: null }],
    rules: [
      { kind: 'target_profit', scope: 'product', amount_usd: null },
      { kind: 'direct_sale_extra', scope: 'product', amount_iqd: null },
    ],
  });
  trace(t, 'PUT clears', cleared);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const base = readBack(cleared.body, 'base')!;
  assert.deepEqual([base.supplier_cost_amount, base.supplier_cost_currency, base.shipping_profile, base.additional_cost_iqd, base.minimum_target_profit_usd, base.direct_sale_extra_iqd], [
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  // The box was not in the clearing body: it stays.
  assert.deepEqual(base.box, [600, 520, 480]);
});

test('LIVE-LIKE: the whole «نشر» sequence — product save (POST /products-v2), GET …/inputs, PUT …/inputs, then a second «نشر» and the reopen — keeps the values; the product save never touches the pricing store', async (t) => {
  const w = liveLikeWorld();
  const admin = stubApp(w.db, { ...OWNER_USER, email_verified_at: '2026-01-01T00:00:00.000Z' } as never, (a) => {
    a.route('/api/admin/products-v2', adminProductsRoutes);
  });
  const send = async (method: string, path: string, body: unknown) => {
    const res = await admin.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await json(res) };
  };
  const publish = async () => {
    const detail = await json(await get(admin, `/api/admin/products-v2/${SNAP}`));
    const { options: _o, colors: _c, media: _m, ...doc } = detail.product as Record<string, unknown>;
    void _o; void _c; void _m;
    return send('POST', '/api/admin/products-v2', { ...doc, expected_updated_at: doc.updated_at });
  };
  const p1 = await publish();
  trace(t, '«نشر» 1: POST /products-v2', p1);
  assert.equal(p1.status, 200, JSON.stringify(p1.body).slice(0, 400));
  // saveAfterProduct → putDrafts(pid, snap, hash, null): a fresh GET, then the PUT at its counter.
  const fresh = await w.getInputs(SNAP);
  const put1 = await w.putInputs(SNAP, { inputs_seq: fresh.body.inputs_seq, inputs: [OWNER_BASE], rules: OWNER_RULES });
  trace(t, '«نشر» 1: PUT …/inputs', put1);
  assert.equal(put1.status, 200, JSON.stringify(put1.body));
  const p2 = await publish();
  trace(t, '«نشر» 2: POST /products-v2 (no pricing drafts)', p2);
  assert.equal(p2.status, 200, JSON.stringify(p2.body).slice(0, 400));
  const reopen = await w.getInputs(SNAP);
  trace(t, 'reopen «تعديل المنتج»: GET …/inputs', reopen, readBack(reopen.body, 'base'));
  assert.equal(readBack(reopen.body, 'base')!.supplier_cost_amount, '899');
  assert.equal(readBack(reopen.body, 'base')!.minimum_target_profit_usd, '120');
  assert.equal(readBack(reopen.body, 'base')!.direct_sale_extra_iqd, 25000);
  assert.equal(reopen.body.inputs_seq, put1.body.inputs_seq);
});

// ------------------------------------------------------------------ the normal state

test('NORMAL: a save that COMPLETES the product is held — 409 PRICING_PREVIEW_REQUIRED and NOTHING is stored (inputs, rules, state) until the owner saves again with the preview’s hash', async (t) => {
  const w = pricingWorld();
  const before = storePrice(w.raw);
  const body = { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES };
  const held = await w.putInputs(SNAP, body);
  trace(t, 'PUT complete entry, no hash', held, held.body.details?.preview?.adoption && { kind: held.body.details.preview.adoption.kind, large: held.body.details.preview.adoption.large_change });
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(held.body.details.preview.adoption.kind, 'adopt');
  // The values the owner typed are not in the store: a GET now shows the panel empty.
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
  const g = await w.getInputs(SNAP);
  assert.equal(g.body.scopes[0].pricing_inputs, null);
  assert.equal(g.body.scopes[0].minimum_target_profit_usd, null);
  assert.equal(storePrice(w.raw), before);

  const hash = held.body.details.preview.preview_hash;
  let saved = await w.putInputs(SNAP, { ...body, preview_hash: hash });
  trace(t, 'PUT with the preview hash', saved);
  if (saved.status === 409 && saved.body.code === 'PRICING_LARGE_CHANGE_CONFIRM') {
    assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
    saved = await w.putInputs(SNAP, { ...body, preview_hash: hash, confirm_large_change: true });
    trace(t, 'PUT with hash + confirm_large_change', saved);
  }
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.mode, 'engine');
  const base = readBack(saved.body, 'base')!;
  assert.equal(base.supplier_cost_amount, '899');
  assert.equal(base.minimum_target_profit_usd, '120');
  assert.equal(base.direct_sale_extra_iqd, 25000);
  assert.notEqual(storePrice(w.raw), before, 'the adopting save writes the engine price');
});

test('NORMAL: a large change after the hash needs the tick AND a sign-in under 10 minutes — 401 REAUTH_REQUIRED otherwise, nothing stored', async (t) => {
  const w = pricingWorld({ sessionAgeSeconds: 20 * 60 });
  const body = { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES };
  const held = await w.putInputs(SNAP, body);
  assert.equal(held.body.code, 'PRICING_PREVIEW_REQUIRED');
  const large = held.body.details.preview.adoption.large_change === true;
  t.diagnostic(`adoption large_change=${large}`);
  const r = await w.putInputs(SNAP, { ...body, preview_hash: held.body.details.preview.preview_hash, confirm_large_change: true });
  trace(t, 'PUT hash + tick, session 20 min old', r);
  if (large) {
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'REAUTH_REQUIRED');
    assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
  } else {
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});

test('NORMAL: an incomplete entry (no minimum profit) is data only — stored, read back, the price stays manual', async (t) => {
  const w = pricingWorld();
  const before = storePrice(w.raw);
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: [] });
  trace(t, 'PUT without minimum profit', r);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  assert.equal(readBack(r.body, 'base')!.supplier_cost_amount, '899');
  assert.equal(storePrice(w.raw), before);
});

test('NORMAL: dinars convert once at the approved rate — without the preview’s hash 400 (field preview_hash), with it stored as IQD_CONVERTED and read back as the dinars typed', async (t) => {
  const w = pricingWorld();
  const entry = { scope: 'base', supplier_cost_iqd: 1_450_000, shipping_profile: 'CHINA_SEA' };
  const noHash = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [entry] });
  trace(t, 'PUT IQD cost, no hash', noHash);
  assert.equal(noHash.status, 400);
  assert.equal(noHash.body.details.field, 'preview_hash');
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
  const preview = await w.previewInputs(SNAP, { inputs: [entry] });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [entry], preview_hash: preview.body.preview_hash });
  trace(t, 'PUT IQD cost with the preview hash', r);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const base = readBack(r.body, 'base')!;
  t.diagnostic(`read-back: ${JSON.stringify(base)}`);
  assert.equal(base.supplier_input_mode, 'IQD_CONVERTED');
  assert.equal(base.original_input_amount, '1450000');
  assert.equal(base.supplier_cost_currency, 'USD');
  assert.equal(base.supplier_cost_amount, '906.25');
});
