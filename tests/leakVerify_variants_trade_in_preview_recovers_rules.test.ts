/**
 * VARIANT VERIFY (DECISIONS row 220 port, fix/leak-port 5e6f581c) — #13
 * "client-bundles trade-in valuation rules shipped to the client".
 *
 * The port stops shipping the rule sets (factor effects, weights, floor, cap,
 * overrides) to the customer and gives the wizard a server door instead:
 * POST /api/trade-in/requests/:id/preview answers the FINAL figure for the
 * answers so far (`publicEstimate`: value per part, total, settlement — no
 * line, floor or cap), rate-limited to 600 calls an hour per customer.
 * (Services V2, trade-in G11: the door is now COUNTED — 20 figures a request,
 * 60 an account a day — and a draft's own view carries no figure. Two figures
 * still give one factor, so the recovery is slower, not closed: this stays
 * the owner's ruling, below.)
 *
 * The figure is the additive model of packages/pricing/src/tradeIn.ts (public
 * code): value = base + Σ trunc(base × effect × weight / 10⁸), rounded down to
 * the rule set's 1,000 IQD. So toggling ONE answer between two previews moves
 * the value by exactly that answer's effect × weight on the customer's own
 * base — the owner's tuned rule, recovered to ~1,000/base (≈ 12 bp on a
 * 850,000 IQD printer), one factor or checklist item per pair of calls. The
 * whole rule book is a few dozen calls, well inside one hour's limit.
 *
 * The test: the owner tunes one fault's effect to a value that is in no
 * default (−1,234 bp on «heating error»), saves it through the real admin
 * door, and a customer with a delivered A1 recovers it from two previews.
 * Same class as #21 (a final figure that is a public function of a private
 * input): only a change to what the door answers closes it — the owner rules.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real routers, no network.
 * Run: node --import tsx --test tests/leakVerify_variants_trade_in_preview_recovers_rules.test.ts
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
const DELIVERED = '2025-09-26T00:00:00.000Z';
const PAID = 850_000;
const OWNER_HEATING_BP = -1_234;

function world(): DatabaseSync {
  const raw = freshDb();
  const users = raw.prepare(`INSERT OR IGNORE INTO users (id,name,email,password_hash,role,admin_scope,is_investor,email_verified_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const u of [OWNER, CUSTOMER]) users.run(u.id, u.id, u.email, 'h', u.role, null, 0, '2026-01-01T00:00:00.000Z');
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_a1','a1','Bambu Lab A1','بامبو A1',${PAID},'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm');
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-DLV','u1','delivered','delivered','{}','standard','{}','cash',${PAID},0,1400,${PAID},0,'2025-09-20T00:00:00.000Z','${DELIVERED}','${DELIVERED}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_a1','ORD-DLV','p_a1','Bambu Lab A1','','',1,${PAID},${PAID},'','[]');
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      VALUES ('unit_a1','ORD-DLV','oi_a1','p_a1','u1',1,'${DELIVERED}',24,0,'${DELIVERED}','2027-09-26T00:00:00.000Z','{}');
  `);
  return raw;
}

const GOOD = { hours: 200, cleanliness: 5, exterior: 5, scratches: 5, accessory_condition: 5, faults: [] as string[], replaced_parts: [] as string[], repairs_count: 0, original_accessories: 'all' };

/**
 * Kept, failing, as `todo` — the owner rules. The preview answers exactly what
 * a saved request answers (tests/leakVerify_features_trade_in_preview_matches_saved_figure),
 * and the offer is a public function of the customer's answers: two drafts
 * saved with one answer toggled recover the same effect, only slower. Closing
 * it means an offer that is not such a function (coarser steps, or no live
 * figure before the admin values the device) — a change to what customers are
 * offered or shown, which is the owner's call.
 */
const OWNER_RULING =
  'OWNER RULING NEEDED (DECISIONS row 220): a trade-in offer is a public function of the customer’s answers, so two answers that differ in one fault give that fault’s private effect; only coarser offers or no live figure close it';

test('a customer recovers the owner’s tuned trade-in factor from two preview answers', { todo: OWNER_RULING }, async () => {
  const raw = world();
  // The owner tunes one fault's effect through the real admin door.
  const owner = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes), { env: ENV });
  const tuned: TradeInRuleSet = structuredClone(DEFAULT_RULE_SETS.fdm);
  tuned.factors = tuned.factors.map((f) =>
    f.factor === 'faults' && f.config.kind === 'checklist'
      ? { ...f, config: { ...f.config, items: f.config.items.map((i) => (i.id === 'heating_error' ? { ...i, effect_bp: OWNER_HEATING_BP } : i)) } }
      : f
  );
  const saved = await put(owner, '/api/admin/trade-in/rules/fdm', { rules: tuned, note: 'owner tuning' });
  assert.equal(saved.status, 200, await saved.clone().text());

  // The customer: a draft for their delivered A1, then two previews that differ in one checkbox.
  const app = stubApp(asD1(raw), CUSTOMER, (a) => a.route('/api/trade-in', tradeInRoutes), { env: ENV });
  const created = await post(app, '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' });
  assert.equal(created.status, 201, await created.clone().text());
  const draft = (await json(created)).request;
  const view = await json(await get(app, `/api/trade-in/requests/${draft.id}`));
  const role = String((view.request?.components ?? draft.components ?? [])[0]?.role ?? 'device');

  const preview = async (faults: string[]) => {
    const res = await post(app, `/api/trade-in/requests/${draft.id}/preview`, { components: { [role]: { ...GOOD, faults } } });
    assert.equal(res.status, 200, await res.clone().text());
    const est = (await json(res)).estimate;
    // Control: the port's projection holds — no rule, line, floor or cap in the answer.
    assert.ok(!/effect_bp|weight_bp|floor_bp|cap_bp|"lines"/.test(JSON.stringify(est)), JSON.stringify(est).slice(0, 300));
    return Number(est.components[0].value_iqd);
  };
  const clean = await preview([]);
  const faulty = await preview(['heating_error']);
  const derivedBp = Math.round(((faulty - clean) / PAID) * 10_000);
  const precisionBp = Math.ceil((1_000 / PAID) * 10_000);
  assert.ok(
    Math.abs(derivedBp - OWNER_HEATING_BP) > precisionBp,
    `two POST /api/trade-in/requests/:id/preview answers (${clean} → ${faulty} on a ${PAID} IQD base) give the owner's tuned ` +
      `«heating error» effect as ${derivedBp} bp (owner set ${OWNER_HEATING_BP} bp; precision ±${precisionBp} bp)`
  );
});
