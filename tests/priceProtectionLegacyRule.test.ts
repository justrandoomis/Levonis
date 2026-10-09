/**
 * TODAY'S PRICE-PROTECTION RULE, PINNED — so price_protection version 4 is
 * provably what the code does (owner decisions 6 and 7, 2026-10-09; DECISIONS
 * rows 190 and 191).
 *
 * Decision 6 says a fall caused only by the USD/IQD rate is not price
 * protection and that the comparison is on the product's base price in US
 * dollars. The claim code cannot apply that yet (no order line stores a base
 * dollar price or a rate, and no product is engine-priced), so version 4 of
 * the policy still states the DINAR rule of chapter 10, and the decision-6
 * text waits for version 5, published with its code. This file runs the real
 * claim route (worker/routes/returns.ts) over every migration and pins each
 * article version 4 describes:
 *   - 10.4  the paid unit price against the lower of today's price for the
 *           same price class and the lowest price recorded within the window,
 *           times the quantity;
 *   - 10.6  a fall raised back within the window still counts;
 *   - 10.5  a regular buyer is never compared with a PRO-only price, a PRO
 *           buyer is compared with the PRO price or the regular one;
 *   - bundles: the parent is refused by name, a part is measured from its
 *           paid share;
 *   - 10.8  the cumulative cap, and 10.9 one open claim at a time.
 *
 * When FX-4 adds the dollar rule for engine-priced products, every case here
 * is a MANUALLY priced product and must stay green unchanged.
 *
 * Run: node --import tsx --test tests/priceProtectionLegacyRule.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, json, post, row, type StubUser } from './fixtures/app';
import { priceProtectionRoutes } from '../worker/routes/returns';

const RATE = 1400;
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
/** Delivered a day ago: inside the seven-day window. */
const DELIVERED_AT = iso(24 * HOUR);

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const proBuyer: StubUser = { id: 'pro_b', role: 'customer', email: 'r@x.co' };
const admin: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };
const appFor = (raw: DatabaseSync, user: StubUser) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/price-protection', priceProtectionRoutes));
const claim = async (raw: DatabaseSync, user: StubUser, orderItemId: string) =>
  json(await post(appFor(raw, user), '/api/price-protection/claims', { orderItemId }));
const decide = async (raw: DatabaseSync, id: string) =>
  json(await post(appFor(raw, admin), `/api/price-protection/admin/claims/${id}/decide`, { decision: 'approved' }));

interface Line {
  id: string;
  product: string;
  qty?: number;
  paid: number;
  tier?: 'free' | 'pro';
  parent?: string;
  componentValue?: number;
  componentAlloc?: number;
  optionId?: string;
}

/**
 * One manually priced product — 100,000 regular, 90,000 PRO — and one
 * delivered order per buyer holding the given lines, each with the checkout
 * snapshot of the price class it was bought at.
 */
function world(lines: { buyer?: Line[]; pro_b?: Line[] }): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('pro_b','Rami','r@x.co','h','customer'), ('boss','Admin','a@x.co','h','admin');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT INTO products (id,slug,name,price_iqd,pro_price_iqd,status,stock,inventory_mode,selling_type,sale_types) VALUES
      ('p1','p1','Printer',100000,90000,'active',10,'BASE','direct_sale','["direct_sale"]'),
      ('p_bundle','p-bundle','Starter bundle',180000,NULL,'active',5,'BASE','bundle','["bundle"]');
  `);
  for (const [user, items] of Object.entries(lines) as Array<[string, Line[]]>) {
    const orderId = `ORD-${user}`;
    const total = items.reduce((n, l) => n + l.paid * (l.qty ?? 1), 0);
    raw
      .prepare(
        `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                             subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
         VALUES (?,?,'delivered','{}','standard','{}','cash',?,0,?,?,0,?)`
      )
      .run(orderId, user, total, RATE, total, DELIVERED_AT);
    for (const l of items) {
      const qty = l.qty ?? 1;
      raw
        .prepare(
          `INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,
                                    option_id,option_value_ids,color_id,pricing_snapshot,
                                    bundle_parent_item_id,component_value_iqd,component_alloc_iqd)
           VALUES (?,?,?,?,'',?,?,?,?,'[]','',?,?,?,?)`
        )
        .run(
          l.id, orderId, l.product, l.product, qty, l.paid, l.paid * qty, l.optionId ?? '',
          JSON.stringify({ applied_tier: l.tier ?? 'free', applied_iqd: l.paid }),
          l.parent ?? null, l.componentValue ?? null, l.componentAlloc ?? null
        );
    }
  }
  return raw;
}

const history = (raw: DatabaseSync, field: 'regular' | 'pro', newIqd: number, msAgo: number) =>
  raw
    .prepare("INSERT INTO price_history (product_id,variant_key,field,old_iqd,new_iqd,changed_by,changed_at) VALUES ('p1','',?,NULL,?,'boss',?)")
    .run(field, newIqd, iso(msAgo));
const setPrice = (raw: DatabaseSync, regular: number, pro: number | null = 90_000) =>
  raw.prepare("UPDATE products SET price_iqd = ?, pro_price_iqd = ? WHERE id = 'p1'").run(regular, pro);
const snapshot = (c: Record<string, unknown>) => c.policy as Record<string, unknown>;

test('10.4 — a drop: the paid unit price against today’s price, times the quantity, in dinars', async () => {
  const raw = world({ buyer: [{ id: 'oi_1', product: 'p1', qty: 2, paid: 100_000 }] });

  // No fall, no claim.
  const none = await claim(raw, buyer, 'oi_1');
  assert.equal(none.code, 'NO_ELIGIBLE_DROP', JSON.stringify(none));

  setPrice(raw, 92_000);
  const res = await claim(raw, buyer, 'oi_1');
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.claim.original_unit_iqd, 100_000);
  assert.equal(res.claim.observed_unit_iqd, 92_000);
  assert.equal(res.claim.qty, 2);
  const policy = snapshot(res.claim);
  assert.equal(policy.basis, 'min(current_applied, price_history window minimum)', 'the rule 10.4 states, by name');
  assert.equal(policy.buyer_class, 'regular');
  assert.equal(policy.eligible_total_iqd, 16_000, '(100,000 − 92,000) × 2');
  assert.equal(policy.computed_eligible_iqd, 16_000);
  // Dinars against dinars: nothing about the order's dollar rate enters the claim.
  assert.equal(Object.keys(policy).some((k) => /usd|rate|fx/i.test(k)), false, `a currency field in ${Object.keys(policy).join(', ')}`);
});

test('10.6 — a fall raised back within the window still counts; one before delivery, or on the PRO price, does not', async () => {
  const raw = world({ buyer: [{ id: 'oi_1', product: 'p1', paid: 100_000 }] });
  // Today's price is back at 100,000, but it was 85,000 twelve hours ago.
  history(raw, 'regular', 85_000, 12 * HOUR);
  // Neither of these can lower a regular buyer's comparison:
  history(raw, 'regular', 70_000, 72 * HOUR); // before the delivery
  history(raw, 'pro', 60_000, 6 * HOUR); //      a PRO-only price
  const res = await claim(raw, buyer, 'oi_1');
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.claim.observed_unit_iqd, 85_000);
  assert.equal(snapshot(res.claim).history_min_iqd, 85_000);
  assert.equal(snapshot(res.claim).current_applied_iqd, 100_000);
  assert.equal(snapshot(res.claim).computed_eligible_iqd, 15_000);
});

test('10.5 — a regular buyer is never compared with a PRO price; a PRO buyer is compared with the PRO price or the regular one', async () => {
  const raw = world({
    buyer: [{ id: 'oi_r', product: 'p1', paid: 100_000 }],
    pro_b: [{ id: 'oi_p', product: 'p1', paid: 90_000, tier: 'pro' }],
  });

  // Only the PRO price fell: the regular buyer has nothing to claim.
  setPrice(raw, 100_000, 80_000);
  const regular = await claim(raw, buyer, 'oi_r');
  assert.equal(regular.code, 'NO_ELIGIBLE_DROP', JSON.stringify(regular));

  // The PRO buyer is measured against the PRO price…
  const pro = await claim(raw, proBuyer, 'oi_p');
  assert.equal(pro.success, true, JSON.stringify(pro));
  assert.equal(snapshot(pro.claim).buyer_class, 'pro');
  assert.equal(pro.claim.original_unit_iqd, 90_000);
  assert.equal(pro.claim.observed_unit_iqd, 80_000);

  // …and, for a PRO buyer, a regular price recorded lower in the window counts too.
  const raw2 = world({ pro_b: [{ id: 'oi_p', product: 'p1', paid: 90_000, tier: 'pro' }] });
  history(raw2, 'regular', 75_000, 6 * HOUR);
  const pro2 = await claim(raw2, proBuyer, 'oi_p');
  assert.equal(pro2.success, true, JSON.stringify(pro2));
  assert.equal(pro2.claim.observed_unit_iqd, 75_000);
});

test('bundles — the parent is refused by name; a part is measured from its paid share, never its catalogue value', async () => {
  const raw = world({
    buyer: [
      { id: 'oi_parent', product: 'p_bundle', paid: 180_000, optionId: 'bx_starter' },
      { id: 'oi_part', product: 'p1', paid: 0, parent: 'oi_parent', componentValue: 100_000, componentAlloc: 80_000 },
    ],
  });
  const parent = await claim(raw, buyer, 'oi_parent');
  assert.equal(parent.code, 'COMPOSITION_NOT_ELIGIBLE', JSON.stringify(parent));

  // 90,000 is below the catalogue value but above the 80,000 actually paid.
  setPrice(raw, 90_000);
  const above = await claim(raw, buyer, 'oi_part');
  assert.equal(above.code, 'NO_ELIGIBLE_DROP', JSON.stringify(above));

  setPrice(raw, 70_000);
  const res = await claim(raw, buyer, 'oi_part');
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.claim.original_unit_iqd, 80_000, 'the paid share');
  assert.equal(res.claim.observed_unit_iqd, 70_000);
  assert.equal(snapshot(res.claim).component_value_iqd, 100_000, 'the catalogue value is provenance only');
});

test('10.8 and 10.9 — one open claim at a time, and earlier credits are deducted up to the whole difference', async () => {
  const raw = world({ buyer: [{ id: 'oi_1', product: 'p1', paid: 100_000 }] });

  setPrice(raw, 90_000);
  const first = await claim(raw, buyer, 'oi_1');
  assert.equal(first.success, true, JSON.stringify(first));
  const pending = await claim(raw, buyer, 'oi_1');
  assert.equal(pending.code, 'CLAIM_PENDING', '10.9: one open claim per item');
  const approved = await decide(raw, first.claim.id);
  assert.equal(approved.success, true, JSON.stringify(approved));
  assert.equal(approved.claim.credited_iqd, 10_000);

  // A further fall: only the part not already paid out.
  setPrice(raw, 85_000);
  const second = await claim(raw, buyer, 'oi_1');
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(snapshot(second.claim).eligible_total_iqd, 15_000);
  assert.equal(snapshot(second.claim).prior_credited_iqd, 10_000);
  assert.equal(snapshot(second.claim).computed_eligible_iqd, 5_000);
  const approved2 = await decide(raw, second.claim.id);
  assert.equal(approved2.claim.credited_iqd, 5_000);

  // The whole difference is now paid: nothing more, ever, for the same fall.
  const third = await claim(raw, buyer, 'oi_1');
  assert.equal(third.code, 'ALREADY_COMPENSATED', JSON.stringify(third));
  const total = row<{ n: number }>(raw, "SELECT SUM(credited_iqd) AS n FROM price_protection_claims WHERE order_item_id = 'oi_1'")!;
  assert.equal(total.n, 15_000, 'never more than (paid − lowest) × qty');
});
