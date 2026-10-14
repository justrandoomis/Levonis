/**
 * SERVICES V2 — WARRANTY & MAINTENANCE: who may move a warranty clock, and
 * whether a claim decision means what it says. Reproductions from the survey
 * (services-v2/warranty.md §A), ported onto the default branch for stage
 * S-P0: each failed before the fix and describes the fixed behaviour
 * (owner decision 3, DECISIONS row 223; plan §1.3 for G-5).
 *
 * Run: node --import tsx --test tests/sv2_warranty_governance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, patch, json, row, type StubUser } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';
import { listEligible } from '../worker/lib/tradeIn';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const DELIVERED = iso(Date.now() - 60 * DAY);
const END = iso(Date.now() + 305 * DAY);

/** The «المجهز» / support assistant: admin_scope 'assistant' (cannot move money). */
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'sara@x.co' };

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale,admin_scope) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('boss','Owner','boss@x.co','boss','h','admin','2026-01-01T00:00:00.000Z','ar',NULL),
      ('helper','Helper','helper@x.co','helper','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,category_id,sub_category_id)
      VALUES ('p1','a1','Bambu A1','بامبو A1',899000,'active','cat_printers','cat_printers_fdm');
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'${DELIVERED}');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi1','ORD-1','p1','Bambu A1',1,899000,899000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
       delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
     VALUES ('u1','ORD-1','oi1','p1','buyer',1,'${DELIVERED}',12,'${DELIVERED}','${END}');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer');
  `);
  return raw;
}
const as = (raw: DatabaseSync, who: StubUser) => stubApp(asD1(raw), who, (a) => a.route('/api/devices', deviceRoutes));

// ---------------------------------------------------------------- G-1
test('G-1 an ASSISTANT admin cannot lengthen a customer\'s warranty (12 → 36 months is a money decision)', async () => {
  const raw = seed();
  try {
    const res = await patch(as(raw, ASSISTANT), '/api/devices/admin/units/u1/warranty', {
      base_months: 12,
      ext_months: 24,
      reason: 'customer asked nicely',
    });
    const body = await json(res);
    // Today: 200 — any admin scope, including the preparer and support, can
    // add up to 228 months of free cover on any unit; the extension is a
    // product the shop SELLS (7.5–10% of the printer price, row 91).
    assert.equal(res.status, 403, JSON.stringify(body));
    const unit = row<{ warranty_ext_months: number }>(raw, 'SELECT warranty_ext_months FROM order_item_units WHERE id = ?', 'u1')!;
    assert.equal(unit.warranty_ext_months, 0);
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------- G-2
test('G-2 an ASSISTANT admin cannot move a delivery date LATER (it moves the warranty end with it)', async () => {
  const raw = seed();
  try {
    const res = await patch(as(raw, ASSISTANT), '/api/devices/admin/units/u1/delivery', {
      delivered_at: iso(Date.now()),
      reason: 'courier said today',
    });
    const body = await json(res);
    // Today: 200 — the window slides two months later with no owner check and
    // no «confirm_longer», while shortening the months needs confirm_shorter.
    assert.equal(res.status, 403, JSON.stringify(body));
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------- G-3
test('G-3 a claim decision must agree with its stage: «rejected» cannot carry decision «repair»', async () => {
  const raw = seed();
  try {
    const filed = await json(
      await post(as(raw, BUYER), '/api/devices/units/u1/claims', {
        subject: 'Hotend heater fault',
        description: 'Heater fault error on every print start.',
        idempotencyKey: 'sv2-g3-key-0001',
      })
    );
    assert.equal(filed.success, true, JSON.stringify(filed));
    const res = await patch(as(raw, OWNER), `/api/devices/admin/claims/${filed.id}`, {
      stage: 'rejected',
      decision: 'repair',
      reason: 'contradiction on purpose',
    });
    // Today: 200 — the row says rejected/repair; the customer is told
    // «rejected», the desk report reads «repair».
    assert.equal(res.status, 400, JSON.stringify(await json(res)));
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------- G-4
test('G-4 «replaced» needs the replacement: the stage cannot be set while the device was never replaced', async () => {
  const raw = seed();
  try {
    const filed = await json(
      await post(as(raw, BUYER), '/api/devices/units/u1/claims', {
        subject: 'Mainboard dead',
        description: 'No power at all, the screen stays dark.',
        idempotencyKey: 'sv2-g4-key-0001',
      })
    );
    await patch(as(raw, OWNER), `/api/devices/admin/claims/${filed.id}`, { stage: 'approved', reason: 'Board failure confirmed' });
    const res = await patch(as(raw, OWNER), `/api/devices/admin/claims/${filed.id}`, {
      stage: 'replaced',
      reason: 'Swapped the unit',
    });
    // Today: 200 — the customer is notified «replaced» while u1 has no
    // replaced_by_unit_id, no part was recorded, and no stock moved.
    assert.equal(res.status, 409, JSON.stringify(await json(res)));
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------- G-5
test('G-5 a printer that is in the shop under an OPEN warranty claim cannot be offered for trade-in', async () => {
  const raw = seed();
  try {
    const filed = await json(
      await post(as(raw, BUYER), '/api/devices/units/u1/claims', {
        subject: 'Under repair',
        description: 'Device handed to the store for repair.',
        idempotencyKey: 'sv2-g5-key-0001',
      })
    );
    await patch(as(raw, OWNER), `/api/devices/admin/claims/${filed.id}`, { stage: 'approved', reason: 'Accepted for repair' });
    await patch(as(raw, OWNER), `/api/devices/admin/claims/${filed.id}`, { stage: 'repairing' });
    const env = { DB: asD1(raw) } as never;
    const units = await listEligible(env, 'buyer');
    const u = units.find((x) => x.unit_id === 'u1');
    assert.ok(u, `the unit is listed: ${JSON.stringify(units.map((x) => x.key))}`);
    const whole = u!.scopes.find((s) => s.scope === 'whole')!;
    // Today: worker/lib/tradeIn.ts never reads warranty_claims — a device on
    // the repair bench is «available» for a trade-in valuation.
    assert.equal(whole.available, false, JSON.stringify(whole));
  } finally {
    raw.close();
  }
});
