/**
 * SERVICES V2 — WARRANTY & MAINTENANCE: what the claim door does that the
 * warranty policy (worker/lib/policies/warranty.ts, v4) says it should not.
 * Reproductions from the survey (services-v2/warranty.md §A.3), ported onto
 * the default branch for stage S-P0: each failed before the fix and states
 * the fixed behaviour.
 *
 * Ported here (the warranty desk, S-P0a):
 *   - W-4 a closed claim takes no more messages;
 *   - W-5 one definition of «open» for the desk and the device;
 *   - W-6 a returned device answers its buyer with DEVICE_NOT_WITH_CUSTOMER.
 * Left for later phases: W-1 (coverage recorded at filing) and W-3 (one open
 * case per device, with its trigger) land with S-P1's migration; W-2 (an
 * expired device files a paid-repair request) lands with the service desk
 * (S-P3) and paid repair (S-P9).
 *
 * Run: node --import tsx --test tests/sv2_warranty_claims.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, post, patch, json } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One delivered, linked A1 whose warranty ends `endInDays` from now. */
function seed(endInDays: number): DatabaseSync {
  const raw = freshDb();
  const now = Date.now();
  const delivered = iso(now - 300 * DAY);
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('boss','Owner','boss@x.co','boss','h','admin','2026-01-01T00:00:00.000Z','ar');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'${delivered}');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi1','ORD-1','p1','Bambu A1',1,899000,899000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
       delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
     VALUES ('u1','ORD-1','oi1','p1','buyer',1,'${delivered}',12,'${delivered}','${iso(now + endInDays * DAY)}');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer');
  `);
  return raw;
}

const customer = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'sara@x.co' }, (a) => a.route('/api/devices', deviceRoutes));
const owner = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/devices', deviceRoutes));

async function fileClaim(raw: DatabaseSync, key: string) {
  return json(
    await post(customer(raw), '/api/devices/units/u1/claims', {
      subject: 'Extruder clicks',
      description: 'The extruder clicks and under-extrudes on every print.',
      idempotencyKey: key,
    })
  );
}

// ---------------------------------------------------------------- W-4
test('W-4 a resolved claim is closed: the customer cannot keep writing into it', async () => {
  const raw = seed(120);
  try {
    const filed = await fileClaim(raw, 'sv2-w4-key-0001');
    for (const [stage, decision] of [['approved', 'repair'], ['resolved', undefined]] as const) {
      const moved = await json(
        await patch(owner(raw), `/api/devices/admin/claims/${filed.id}`, { stage, decision, reason: 'Inspected and settled' })
      );
      assert.equal(moved.success, true, JSON.stringify(moved));
    }
    const res = await post(customer(raw), `/api/devices/claims/${filed.id}/messages`, { body: 'Still broken?' });
    // Before: 200 — a message landed in a closed thread, «🔥 Customer replied»
    // fired to the staff topic, and no queue showed it (the claim is resolved).
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'CLAIM_CLOSED');
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------- W-5
test('W-5 a legacy claim (stage NULL, status approved) reads the same — open or closed — on the queue and on the device', async () => {
  const raw = seed(120);
  try {
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, status)
              VALUES ('wc_legacy','buyer','oi1','Bambu A1','old claim, approved before stages existed','u1','approved')`);
    const queue = await json(await get(owner(raw), '/api/devices/admin/claims?stage=all'));
    const listed = queue.claims.find((c: { id: string }) => c.id === 'wc_legacy');
    assert.ok(listed, 'the queue lists it');
    const openOnQueue = !['rejected', 'replaced', 'resolved'].includes(listed.stage);
    const mine = await json(await get(customer(raw), '/api/devices/mine'));
    // Before: the queue listed it under «approved» (a stage with moves left:
    // repairing / replaced / resolved / rejected) while the device counted
    // (stage NULL, status approved) as CLOSED — the device said «no open
    // claim» and could be unlinked and handed on while the desk could still
    // move the same claim. One definition answers both.
    assert.equal(mine.devices[0].open_claims > 0, openOnQueue, `queue stage ${listed.stage}, device open_claims ${mine.devices[0].open_claims}`);
    assert.equal(listed.open, openOnQueue, 'the claim itself says which it is');
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------- W-6
test('W-6 a returned device answers its buyer with DEVICE_NOT_WITH_CUSTOMER, not «register it first»', async () => {
  const raw = seed(120);
  try {
    // What a resolved return does to the unit (serialAssignments.ts).
    raw.exec(`UPDATE order_item_units SET warranty_closed_at = '2026-10-01T00:00:00.000Z', warranty_closed_reason = 'returned' WHERE id = 'u1';
              UPDATE device_registrations SET revoked_at = '2026-10-01T00:00:00.000Z' WHERE unit_id = 'u1';`);
    const res = await post(customer(raw), '/api/devices/units/u1/claims', {
      subject: 'Broken',
      description: 'It does not power on any more.',
      idempotencyKey: 'sv2-w6-key-0001',
    });
    const body = await json(res);
    // Before: 400 NOT_REGISTERED («Register this device first») — and the
    // register door then refused with DEVICE_NOT_WITH_CUSTOMER: a loop.
    assert.equal(body.code, 'DEVICE_NOT_WITH_CUSTOMER', JSON.stringify(body));
  } finally {
    raw.close();
  }
});
