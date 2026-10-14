/**
 * Services V2 S-P0a — PRICE PROTECTION RULE FIXES AND THE MINIMAL ADMIN QUEUE
 * (price-protection design B.13 P0; plan §2.3 S-P0a «Protection rule fixes»).
 *
 * Beyond the ported reproductions (tests/sv2_price-protection_bugs.test.ts):
 *   - the rung (PP-B2): a model that inherits the base price is compared with
 *     the base; a model's own price dip that was raised back still counts; a
 *     line whose rung moved since checkout reads no raw history rows;
 *   - the channel (PP-B3): a pre-order paid cash on delivery is compared with
 *     the direct schedule it was charged; a channel closed today is never
 *     compared with another channel's price;
 *   - the class (PP-B4): a PRIME buyer priced by a membership rule is compared
 *     with today's PRIME price from the same rule;
 *   - the notices (PP-B6): a declined claim tells the customer the reason in
 *     ar/en/ckb, in the same batch; a refused approval tells nothing;
 *   - the projection (PP-B7): the customer never reads the staff snapshot;
 *   - the queue: counts, search, the evidence sheet (no cost row), who may
 *     approve (assistant 403, owner above the 250,000 line or as the price's
 *     author).
 *
 * Run: node --import tsx --test tests/sv2_price-protection_rules.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRE_V5, ppWorld, type PpWorld } from './sv2_price-protection_fixture';
import { get, json, post, stubApp } from './fixtures/app';
import { priceProtectionRoutes } from '../worker/routes/returns';
import { PRICE_PROTECTION_NOTICES, PRICE_PROTECTION_REASONS, PRICE_PROTECTION_REASON_CODES } from '../packages/contracts/src/priceProtection';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function plain(w: PpWorld, id = 'p', price = 40_000) {
  w.raw.prepare(`INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES (?, ?, 'Plain', 'active', ?, 5)`).run(id, id, price);
}

/** A full-scope admin who is not the owner: approves up to the owner line. */
function financialAdmin(w: PpWorld) {
  w.raw.exec(`INSERT OR IGNORE INTO users(id,name,email,password_hash,role) VALUES ('fin','Finance','fin@x.co','h','admin')`);
  return stubApp(w.db, { id: 'fin', role: 'admin', email: 'fin@x.co', admin_scope: 'full' }, (a) => a.route('/api/price-protection', priceProtectionRoutes));
}

const bell = (w: PpWorld) =>
  w.raw.prepare("SELECT kind, title_ar, title_en, body_ar, body_en, meta, event_key, link FROM user_notifications WHERE user_id = 'buyer' ORDER BY created_at").all() as Array<Record<string, string>>;

/** A printer with two models: the Combo carries its own price, the Solo inherits the base. */
function printer(w: PpWorld) {
  w.raw.exec(`
    INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('pm', 'pm', 'Printer', 'active', 200000, 5);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('pm_g', 'pm', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, regular_price_iqd)
      VALUES ('pm_combo', 'pm', 'pm_g', 'Combo', 0, 1, 5, 350000), ('pm_solo', 'pm', 'pm_g', 'Solo', 1, 1, 5, NULL);`);
}

// ------------------------------------------------------------------ PP-B2

test('PP-B2 a model that inherits the base price IS compared with the base price', async () => {
  const w = ppWorld();
  printer(w);
  const { itemId } = w.deliveredLine({ productId: 'pm', unit: 200_000, optionId: 'pm_solo' });
  w.raw.exec(`UPDATE products SET price_iqd = 190000 WHERE id = 'pm'`);
  w.priceRow('pm', '', 200_000, 190_000);
  const c = await w.claim(itemId);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.claim.observed_unit_iqd, 190_000);
});

test('PP-B2 the model’s own dip, raised back inside the window, still counts — and the base rows never do', async () => {
  const w = ppWorld();
  printer(w);
  // Since the clean start (DECISIONS row 222) the Combo's own price is its V2 model price: the V2 writer
  // alone moves it and records each move in the Combo's own `sku:` history — no base row is its price.
  await w.publish('pm');
  const { itemId } = w.deliveredLine({ productId: 'pm', unit: 350_000, optionId: 'pm_combo', createdAt: PRE_V5 });
  await w.priceV2('pm', { product: 200_000, models: { pm_combo: 320_000 } });
  await w.priceV2('pm', { product: 200_000, models: { pm_combo: 350_000 } });
  w.priceRow('pm', '', 200_000, 150_000, ago(20_000));
  const c = await w.claim(itemId);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.claim.observed_unit_iqd, 320_000, 'the Combo’s own 320,000, never the base’s 150,000');
  const snap = JSON.parse(String((w.raw.prepare('SELECT policy_snapshot p FROM price_protection_claims').get() as { p: string }).p));
  assert.deepEqual(snap.history_keys, [], 'no hand-written row is a V2 model’s price');
  assert.equal(snap.today_rung, 'sku');
});

test('PP-B2 a line whose model changed rung since checkout reads only today’s price, never the raw rows', async () => {
  const w = ppWorld();
  printer(w);
  // Bought when the Combo still inherited the base (200,000); today it carries its own 350,000.
  const { itemId } = w.deliveredLine({ productId: 'pm', unit: 200_000, optionId: 'pm_combo', pricing: { price_source: 'base' } });
  w.priceRow('pm', '', 200_000, 150_000, ago(20_000));
  const c = await w.claim(itemId);
  assert.equal(c.status, 400, `a base row was read as the Combo’s price: ${JSON.stringify(c.body)}`);
  assert.equal(c.body.code, 'NO_ELIGIBLE_DROP');
});

// ------------------------------------------------------------------ PP-B3

function twoChannels(w: PpWorld) {
  w.raw.exec(`
    INSERT INTO products (id, slug, name, status, price_iqd, stock, sale_types) VALUES ('pf', 'pf', 'Printer', 'active', 900000, 5, '["direct_sale","pre_order"]');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('pf_g', 'pf', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, regular_price_iqd)
      VALUES ('pf_a', 'pf', 'pf_g', 'A', 0, 1, 5, 900000);
    INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd)
      VALUES ('pf_a_d', 'pf', 'pf_a', 'direct_sale', 1, 950000), ('pf_a_p', 'pf', 'pf_a', 'pre_order', 1, 900000);
    INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled, surcharge_iqd, regular_price_iqd)
      VALUES ('pf_a_p_air', 'pf', 'pf_a_p', 'air', 1, 0, 900000);`);
}

test('PP-B3 a pre-order paid cash on delivery is compared with the direct schedule it was charged', async () => {
  const w = ppWorld();
  twoChannels(w);
  // The clean start (DECISIONS row 222): published in V2 — direct 950,000, the air pre-order 900,000 under it.
  await w.publish('pf');
  const { itemId } = w.deliveredLine({
    productId: 'pf', unit: 950_000, optionId: 'pf_a', createdAt: PRE_V5,
    pricing: { pricing_basis: 'direct', fulfillment: { type: 'pre_order' } },
    transport: { method: 'air', commission_iqd: 0, waived: true, waived_by: 'cod_direct_pricing' },
  });
  // Only the pre-order price falls: the cash-on-delivery buyer paid the direct price, which did not.
  await w.priceV2('pf', { product: 950_000, preorder: 870_000 });
  const none = await w.claim(itemId);
  assert.equal(none.body.code, 'NO_ELIGIBLE_DROP', JSON.stringify(none.body));
  // The direct price falls: that is this buyer's drop.
  await w.priceV2('pf', { product: 920_000, preorder: 870_000 });
  const c = await w.claim(itemId);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.claim.observed_unit_iqd, 920_000);
});

test('PP-B3 a pre-order channel closed today is never compared with the direct price', async () => {
  const w = ppWorld();
  twoChannels(w);
  const { itemId } = w.deliveredLine({
    productId: 'pf', unit: 900_000, optionId: 'pf_a', createdAt: PRE_V5,
    pricing: { pricing_basis: 'preorder' }, transport: { method: 'air', commission_iqd: 0 },
  });
  // Today the model is no longer sold by pre-order and its direct price is lower — the product as the
  // clean start publishes it in V2 (DECISIONS row 222): the pre-order channel has no V2 result.
  w.raw.exec(`UPDATE product_option_fulfillment SET enabled = 0 WHERE id = 'pf_a_p';
              UPDATE product_option_fulfillment SET regular_price_iqd = 850000 WHERE id = 'pf_a_d';`);
  await w.publish('pf');
  const c = await w.claim(itemId);
  assert.equal(c.status, 400, `the pre-order buyer was paid at the direct price: ${JSON.stringify(c.body)}`);
  assert.equal(c.body.code, 'NO_ELIGIBLE_DROP', 'a closed channel has no price today — not a support case');
});

// ------------------------------------------------------------------ PP-B4

test('PP-B4 a member buyer of a model is compared with that model’s own member price; a regular buyer of it only with the regular one', async () => {
  const w = ppWorld();
  printer(w);
  // Since the clean start (DECISIONS row 222) a member price is a membership rule over the model's V2
  // price, never a typed rung — and only PRO carries a discount rule (PREMIUM/PRIME: free delivery only).
  await w.publish('pm');
  const member = w.deliveredLine({ productId: 'pm', unit: 330_000, optionId: 'pm_combo', createdAt: PRE_V5, pricing: { applied_tier: 'pro', applied_iqd: 330_000, regular_iqd: 350_000 } });
  const regular = w.deliveredLine({ productId: 'pm', unit: 350_000, optionId: 'pm_combo', createdAt: PRE_V5 });
  // Today a 10% PRO rule prices the Combo's PRO buyers at 315,000; its regular price never moves.
  await w.memberRule('pro', 'pm', 10);
  const p = await w.claim(member.itemId);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.claim.observed_unit_iqd, 315_000);
  const r = await w.claim(regular.itemId);
  assert.equal(r.body.code, 'NO_ELIGIBLE_DROP', 'a member price is never a regular buyer’s drop');
  // The model's own price falls for good: the PRO buyer is compared with that model's PRO price.
  await w.decide(w.owner, p.body.claim.id);
  await w.priceV2('pm', { product: 200_000, models: { pm_combo: 330_000 } });
  const again = await w.claim(member.itemId);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.claim.observed_unit_iqd, 297_000, '330,000 less the 10% PRO rule');
});

// ------------------------------------------------------------------ PP-B6 / PP-B7

test('PP-B6 a declined claim tells the customer why, in ar/en/ckb, and the claim card carries the reason — never the staff snapshot (PP-B7)', async () => {
  const w = ppWorld();
  plain(w);
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const c = await w.claim(itemId);
  // A reason is required: a code from the list, or a note; «other» needs the note.
  const bare = await post(w.owner, `/api/price-protection/admin/claims/${c.body.claim.id}/decide`, { decision: 'rejected' });
  assert.equal(bare.status, 400);
  const other = await post(w.owner, `/api/price-protection/admin/claims/${c.body.claim.id}/decide`, { decision: 'rejected', reason_code: 'other' });
  assert.equal(other.status, 400);
  assert.equal(bell(w).length, 0, 'no refusal told the customer anything');

  const r = await json(await post(w.owner, `/api/price-protection/admin/claims/${c.body.claim.id}/decide`, { decision: 'rejected', reason_code: 'manifest', reason: 'Fixed within minutes.' }));
  assert.equal(r.success, true, JSON.stringify(r));
  const rows = bell(w);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, 'price_protection');
  assert.equal(row.event_key, `pp:${c.body.claim.id}:rejected`);
  assert.ok(row.link.startsWith('/orders/'));
  const meta = JSON.parse(row.meta);
  assert.ok(row.body_ar.includes(PRICE_PROTECTION_REASONS.manifest.ar) && row.body_ar.includes('Fixed within minutes.'), row.body_ar);
  assert.ok(row.body_en.includes(PRICE_PROTECTION_REASONS.manifest.en), row.body_en);
  assert.ok(String(meta.body_ckb).includes(PRICE_PROTECTION_REASONS.manifest.ckb), meta.body_ckb);
  assert.notEqual(meta.title_ckb, row.title_ar);

  // A second decision is refused and tells nothing more.
  const again = await post(w.owner, `/api/price-protection/admin/claims/${c.body.claim.id}/decide`, { decision: 'rejected', reason_code: 'no_drop' });
  assert.equal(again.status, 400);
  assert.equal(bell(w).length, 1);

  const mine = await w.myClaims();
  const card = mine.claims[0];
  assert.equal('policy' in card, false, 'the staff snapshot is not the customer’s');
  assert.deepEqual(card.decision_reason, { code: 'manifest', note: 'Fixed within minutes.' });
  assert.doesNotMatch(JSON.stringify(mine), /history_keys|current_applied|computed_eligible|DECISIONS/);
});

test('PP-B6 an approval the server refuses writes no notice; the credit and its notice land together', async () => {
  const w = ppWorld();
  plain(w);
  const { orderId, itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const c = await w.claim(itemId);
  // A return opened after the claim decides the line first (PF-1).
  w.raw
    .prepare(`INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,within_window) VALUES ('r1', ?, ?, 'buyer', 1, 'defective', 'received', 1)`)
    .run(orderId, itemId);
  const held = await w.decide(w.owner, c.body.claim.id);
  assert.equal(held.status, 400);
  assert.equal(bell(w).length, 0);
  assert.equal(w.n("SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_pp_%'"), 0);
  w.raw.exec(`UPDATE return_cases SET state = 'rejected' WHERE id = 'r1'`);
  const ok = await w.decide(w.owner, c.body.claim.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const rows = bell(w);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_key, `pp:${c.body.claim.id}:credited`);
  assert.ok(rows[0].title_ar.includes('10,000') && rows[0].title_en.includes('10,000 IQD'), rows[0].title_en);
  assert.equal(w.n("SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_pp_%'"), 1);
  assert.equal('channel_note' in ok.body.credit, false, 'the owner decided the wallet (row 223): no «pending» note');
});

// ------------------------------------------------------------------ the queue

test('the queue: counts per state, search by customer and order, and the staff row carries the snapshot', async () => {
  const w = ppWorld();
  plain(w);
  const a = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const b = w.deliveredLine({ productId: 'p', unit: 45_000 });
  const ca = await w.claim(a.itemId);
  const cb = await w.claim(b.itemId);
  await post(w.owner, `/api/price-protection/admin/claims/${cb.body.claim.id}/decide`, { decision: 'rejected', reason_code: 'no_drop' });
  const all = await json(await get(w.owner, '/api/price-protection/admin/claims'));
  assert.deepEqual(all.counts, { requested: 1, rejected: 1 });
  assert.ok(all.claims[0].policy, 'staff read the comparison');
  const byEmail = await json(await get(w.owner, '/api/price-protection/admin/claims?q=s%40x.co'));
  assert.equal(byEmail.claims.length, 2);
  const byOrder = await json(await get(w.owner, `/api/price-protection/admin/claims?q=${a.orderId}`));
  assert.deepEqual(byOrder.claims.map((x: { id: string }) => x.id), [ca.body.claim.id]);
  const requested = await json(await get(w.owner, '/api/price-protection/admin/claims?state=requested'));
  assert.deepEqual(requested.claims.map((x: { id: string }) => x.id), [ca.body.claim.id]);
});

test('the sheet: the price rows of the window (never a cost row), which ones this claim compares, and what approving credits now', async () => {
  const w = ppWorld();
  plain(w);
  // Fixed ids, so the leak scan below can never match a random one.
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 50_000, orderId: 'ORD-sheet1' });
  w.priceRow('p', '', 50_000, 45_000, ago(20_000));
  w.priceRow('p', '', 30_000, 20_000, ago(15_000), 'cost');
  w.priceRow('p', 'option:elsewhere', 50_000, 10_000, ago(10_000));
  w.priceRow('p', '', 50_000, 1_000, ago(30 * 24 * HOUR)); // before the delivery: outside the window
  const c = await w.claim(itemId);
  assert.equal(c.body.claim.observed_unit_iqd, 40_000);
  const sheet = await json(await get(w.owner, `/api/price-protection/admin/claims/${c.body.claim.id}`));
  assert.equal(sheet.success, true, JSON.stringify(sheet));
  assert.deepEqual(
    sheet.evidence.map((e: { key: string; field: string; new_iqd: number; counted: boolean; by_owner: boolean }) => [e.key, e.field, e.new_iqd, e.counted, e.by_owner]),
    // Since the clean start (DECISIONS row 222) the product sells at its V2 price: the row the V2 writer
    // recorded when it published it (`sku:`, the line's own SKU × channel) is the one compared; the
    // hand-written base row is shown but is no longer the line's price.
    [['', 'regular', 45_000, false, true], ['option:elsewhere', 'regular', 10_000, false, true], ['sku:@direct_sale', 'regular', 40_000, true, true]]
  );
  assert.doesNotMatch(JSON.stringify(sheet), /cost|profit|usd|rate/i, 'no cost, profit or rate on the staff sheet');
  assert.deepEqual(sheet.now, { paid_unit_iqd: 50_000, per_unit_iqd: 10_000, units: 1, prior_credited_iqd: 0, credit_iqd: 10_000 });
  assert.equal(sheet.blocked, null);
  assert.deepEqual(sheet.approval, { financial_scope: true, owner_scope: true, needs_owner: false, why: null });

  // An assistant reads the sheet (to answer the customer) but decides nothing.
  const helper = await json(await get(w.assistant, `/api/price-protection/admin/claims/${c.body.claim.id}`));
  assert.equal(helper.approval.financial_scope, false);
  assert.equal((await w.decide(w.assistant, c.body.claim.id)).status, 403);
  assert.equal((await post(w.assistant, `/api/price-protection/admin/claims/${c.body.claim.id}/decide`, { decision: 'rejected', reason_code: 'no_drop' })).status, 403);
});

test('who approves: a financial admin up to 250,000; above it, or as the author of a price in the window, the owner with a reason', async () => {
  const w = ppWorld();
  plain(w, 'big', 700_000);
  const fin = financialAdmin(w);
  const { itemId } = w.deliveredLine({ productId: 'big', unit: 1_000_000 });
  const c = await w.claim(itemId);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const sheet = await json(await get(fin, `/api/price-protection/admin/claims/${c.body.claim.id}`));
  assert.deepEqual(sheet.approval, { financial_scope: true, owner_scope: false, needs_owner: true, why: 'above_line' });
  const refused = await json(await post(fin, `/api/price-protection/admin/claims/${c.body.claim.id}/decide`, { decision: 'approved' }));
  assert.equal(refused.code, 'OWNER_REQUIRED');
  const noReason = await json(await post(w.owner, `/api/price-protection/admin/claims/${c.body.claim.id}/decide`, { decision: 'approved' }));
  assert.equal(noReason.code, 'OWNER_REASON_REQUIRED');
  const ok = await json(await post(w.owner, `/api/price-protection/admin/claims/${c.body.claim.id}/decide`, { decision: 'approved', reason: 'Checked the price record' }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(ok.credit.amount_iqd, 300_000);

  // Four eyes: the financial admin wrote a price of this product inside the window.
  const w2 = ppWorld();
  plain(w2);
  const fin2 = financialAdmin(w2);
  const line = w2.deliveredLine({ productId: 'p', unit: 50_000 });
  w2.raw.prepare(`INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by, changed_at) VALUES ('p','', 'regular', 50000, 40000, 'fin', ?)`).run(ago(10_000));
  const c2 = await w2.claim(line.itemId);
  const sheet2 = await json(await get(fin2, `/api/price-protection/admin/claims/${c2.body.claim.id}`));
  assert.equal(sheet2.approval.why, 'price_author');
  const refused2 = await json(await post(fin2, `/api/price-protection/admin/claims/${c2.body.claim.id}/decide`, { decision: 'approved' }));
  assert.equal(refused2.code, 'OWNER_REQUIRED');
});

// ------------------------------------------------------------------ strings

test('every decision reason and notice reads in ar, en and its own Sorani (row 183)', () => {
  for (const code of PRICE_PROTECTION_REASON_CODES) {
    const t = PRICE_PROTECTION_REASONS[code];
    assert.ok(t.ar && t.en && t.ckb, code);
    assert.notEqual(t.ckb, t.ar, `${code}: ckb copies the Arabic`);
    assert.notEqual(t.ckb, t.en, `${code}: ckb copies the English`);
  }
  const n = PRICE_PROTECTION_NOTICES;
  for (const t of [n.credited.title('1'), n.credited.body('X'), n.rejected.title(), n.rejected.body('X', PRICE_PROTECTION_REASONS.fx), n.outbound.subject, n.outbound.body('X')]) {
    assert.ok(t.ar && t.en && t.ckb);
    assert.notEqual(t.ckb, t.ar);
  }
  // The outbound line carries the event and where to read it — never an amount or a reason.
  assert.doesNotMatch(JSON.stringify(n.outbound.body('X')), /\d/);
});
