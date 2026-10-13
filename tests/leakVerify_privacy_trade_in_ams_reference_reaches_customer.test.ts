/**
 * PRIVACY VERIFY (DECISIONS row 220 port, fix/leak-port 5e6f581c) — #13
 * "client-bundles trade-in valuation rules shipped to the client".
 *
 * The port stops shipping the trade-in rule sets to the customer: GET
 * /api/trade-in/eligible and GET /api/trade-in/requests/:id now carry
 * `questions` instead of `rules`, because «its rules (each factor's effect and
 * weight, the floor and the cap, the resale view and the per-product
 * overrides) are the calculation behind that price, and the owner's rule gives
 * anyone but the owner the final figure alone» (worker/lib/tradeIn.ts
 * `publicQuestions`). The audit test lists `ams_reference_iqd` among those
 * private rule values (tests/leakAudit_client-bundles_trade_in_valuation_rules_client_side).
 *
 * ONE RULE VALUE STILL GOES OUT, LITERALLY. For a Combo whose AMS share cannot
 * be read off two option prices, `amsSplit` (worker/lib/tradeIn.ts) bases the
 * AMS on the owner's `ams_reference_iqd`:
 *
 *     { method: 'reference', share_bp: null, ams_base_iqd: min(reference, paid / 2) }
 *
 * and `buildEligibility` returns that object as-is on every eligible unit
 * (`ams_split`), plus `scopes[].components[].base_iqd` = the reference for the
 * AMS and paid − reference for the printer. The request view repeats it as
 * `components[].base_iqd`. With any Combo bought at more than twice the
 * reference (every real one), the customer reads the owner's rule to the
 * dinar — `method: 'reference'` even says what it is. The shipped default is
 * 0 (packages/pricing/src/tradeInDefaults.ts), so any figure there is one the
 * owner typed.
 *
 * The test: the owner sets the AMS reference through the real admin door
 * (PUT /api/admin/trade-in/rules/ams), a customer with a delivered X1C Combo
 * opens «استبدال» — GET /eligible, then an AMS-only draft and its GET
 * /requests/:id — and no answer may carry the reference (or paid − reference).
 * Controls: the port's own fix holds (no `rules` key reaches the customer),
 * the owner's value is in force, and a Combo is what the customer is shown.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real routers, the
 * stub session of tests/fixtures/app.ts. No network.
 * Run: node --import tsx --test tests/leakVerify_privacy_trade_in_ams_reference_reaches_customer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, put, stubApp, OWNER, type StubUser } from './fixtures/app';
import { tradeInRoutes, adminTradeInRoutes } from '../worker/routes/tradeIn';
import { DEFAULT_RULE_SETS } from '../packages/pricing/src/tradeInDefaults';
import type { TradeInRuleSet } from '../packages/pricing/src/tradeIn';

const ENV = { APP_ORIGIN: 'https://shop.example', TELEGRAM_ADMIN_CHAT_ID: '' };
const CUSTOMER: StubUser = { id: 'u1', role: 'customer', email: 's@x.co' };
const DELIVERED = '2025-12-01T00:00:00.000Z';
/** What the customer paid for the X1C Combo (public: their own order). */
const PAID = 2_400_000;
/** The owner's private AMS reference — a value in no default and no price of the fixture. */
const OWNER_AMS_REFERENCE = 287_653;

function world(): DatabaseSync {
  const raw = freshDb();
  const users = raw.prepare(`INSERT OR IGNORE INTO users (id,name,email,password_hash,role,admin_scope,is_investor,email_verified_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const u of [OWNER, CUSTOMER]) users.run(u.id, u.id, u.email, 'h', u.role, null, 0, '2026-01-01T00:00:00.000Z');
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_x1c','x1c','Bambu Lab X1C','بامبو X1C',${PAID},'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm');
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-X1C','u1','delivered','delivered','{}','standard','{}','cash',${PAID},0,1400,${PAID},0,'2025-11-25T00:00:00.000Z','${DELIVERED}','${DELIVERED}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_x1c','ORD-X1C','p_x1c','Bambu Lab X1C','','X1C Combo',1,${PAID},${PAID},'','[]');
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      VALUES ('unit_x1c','ORD-X1C','oi_x1c','p_x1c','u1',1,'${DELIVERED}',24,0,'${DELIVERED}','2027-12-01T00:00:00.000Z','{}');
  `);
  return raw;
}

/** Every place the owner's reference — or the printer's base it was subtracted from — sits in an answer. */
function referenceIn(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    else if (v === OWNER_AMS_REFERENCE) out.push(`${path} = ${v} (the owner's AMS reference)`);
    else if (v === PAID - OWNER_AMS_REFERENCE) out.push(`${path} = ${v} (paid − the owner's AMS reference)`);
    else if (typeof v === 'string' && (v.includes(String(OWNER_AMS_REFERENCE)) || v.includes('287,653'))) out.push(`${path} ⊃ the owner's AMS reference`);
  };
  walk(value, '$');
  return out;
}

test('control: the shipped AMS reference is 0, so any reference a customer meets is one the owner typed', () => {
  assert.equal(DEFAULT_RULE_SETS.ams.ams_reference_iqd, 0);
});

test('#13 variant: the owner’s AMS reference reaches the customer on GET /api/trade-in/eligible and GET /api/trade-in/requests/:id', async () => {
  const raw = world();
  const owner = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes), { env: ENV });
  const tuned: TradeInRuleSet = { ...structuredClone(DEFAULT_RULE_SETS.ams), ams_reference_iqd: OWNER_AMS_REFERENCE };
  const saved = await put(owner, '/api/admin/trade-in/rules/ams', { rules: tuned, note: 'owner tuning' });
  assert.equal(saved.status, 200, await saved.clone().text());
  const rules = await json(await get(owner, '/api/admin/trade-in/rules'));
  assert.equal(rules.rules.ams.ams_reference_iqd, OWNER_AMS_REFERENCE, 'control: the owner’s reference is in force');

  const app = stubApp(asD1(raw), CUSTOMER, (a) => a.route('/api/trade-in', tradeInRoutes), { env: ENV });
  const eligibleRes = await get(app, '/api/trade-in/eligible');
  assert.equal(eligibleRes.status, 200, await eligibleRes.clone().text());
  const eligible = await json(eligibleRes);
  // Control: the port's fix holds — the customer is told what to ask, never sent the rule sets.
  assert.equal('rules' in eligible, false, 'the port removed `rules` from /eligible');
  assert.ok(eligible.questions?.ams, 'the wizard is told what to ask');
  const unit = (eligible.units as Array<Record<string, unknown>>).find((u) => u.order_item_id === 'oi_x1c');
  assert.ok(unit, 'the delivered X1C is listed');
  assert.equal(unit!.is_combo, true, 'control: the customer is shown a Combo');

  // The AMS-only draft the wizard opens on it, and the request it reads back.
  const created = await post(app, '/api/trade-in/requests', { order_item_id: 'oi_x1c', unit_index: 1, scope: 'ams_only' });
  assert.equal(created.status, 201, await created.clone().text());
  const draftId = String((await json(created)).request.id);
  const viewRes = await get(app, `/api/trade-in/requests/${draftId}`);
  assert.equal(viewRes.status, 200);
  const view = await json(viewRes);
  assert.equal('rules' in (view.request ?? {}), false, 'the port removed `rules` from the request view');

  const found = [
    ...referenceIn(eligible).map((l) => `GET /api/trade-in/eligible ${l}`),
    ...referenceIn(view).map((l) => `GET /api/trade-in/requests/${draftId} ${l}`),
  ];
  assert.deepEqual(
    found,
    [],
    `the owner's trade-in rule value ams_reference_iqd = ${OWNER_AMS_REFERENCE} reached the customer:\n${found.join('\n')}`
  );
});
