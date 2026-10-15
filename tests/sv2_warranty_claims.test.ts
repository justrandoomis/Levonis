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
 * Landed with S-P1 (migration 0191, DECISIONS row 237):
 *   - W-1 the claim records the cover it was filed under, once (policy 5.16);
 *   - W-3 one open case per device — inside the claim insert, the desk's
 *     reopen and two triggers — with the database's «open» checked against
 *     claimIsOpen() for every stage and legacy status (no drift).
 * Left for later phases: W-2 (an expired device files a paid-repair request)
 * lands with the service desk (S-P3) and paid repair (S-P9).
 *
 * Run: node --import tsx --test tests/sv2_warranty_claims.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { freshDb, dbThrough, asD1, stubApp, get, post, patch, json, row, all } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';
import { adminRoutes } from '../worker/routes/admin';
import { CLAIM_ALREADY_OPEN_CUSTOMER, CLAIM_ALREADY_OPEN_DESK, CLAIM_STAGES, claimIsOpen } from '../worker/lib/deviceOps';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One delivered, linked A1 whose warranty ends `endInDays` from now. */
function seed(endInDays: number, raw: DatabaseSync = freshDb()): DatabaseSync {
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

// ---------------------------------------------------------------- W-1 (S-P1)
test('W-1 a claim filed inside the warranty stays «filed in cover» after the end date passes (policy 5.16)', async () => {
  const raw = seed(5); // five days of cover left
  try {
    const filed = await fileClaim(raw, 'sv2-w1-key-0001');
    assert.equal(filed.success, true, JSON.stringify(filed));
    assert.equal(filed.warranty_facts.state, 'active');
    const unitEnd = row<{ warranty_end_at: string }>(raw, "SELECT warranty_end_at FROM order_item_units WHERE id = 'u1'")!.warranty_end_at;

    // Ten days later the admin opens the claim to diagnose it.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * DAY;
    try {
      const seen = await json(await get(owner(raw), `/api/devices/claims/${filed.id}`));
      assert.equal(seen.success, true, JSON.stringify(seen));
      assert.equal(seen.warranty_facts.state, 'expired', 'today the cover is over…');
      // …and the claim still says what it was filed under, recorded by its INSERT.
      assert.deepEqual(seen.claim.coverage_at_filing, { state: 'active', via: 'original', end_at: unitEnd, policy_version: 'warranty@4' });
      const queue = await json(await get(owner(raw), '/api/devices/admin/claims?stage=all'));
      assert.equal(queue.claims.find((c: { id: string }) => c.id === filed.id).coverage_at_filing.state, 'active', 'the desk queue reads the same');
    } finally {
      Date.now = realNow;
    }

    // Written once: nothing rewrites it, not even a back-fill.
    assert.throws(() => raw.exec(`UPDATE warranty_claims SET filed_cover_state = 'expired' WHERE id = '${filed.id}'`), /CLAIM_FILED_COVER_FROZEN/);
    assert.throws(() => raw.exec(`UPDATE warranty_claims SET filed_policy_version = 'warranty@5' WHERE id = '${filed.id}'`), /CLAIM_FILED_COVER_FROZEN/);

    // A claim written without them (every claim filed before 0191) shows nothing.
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status)
              VALUES ('wc_old','buyer','oi1','Bambu A1','filed before 0191',NULL,'received','submitted')`);
    const old = await json(await get(owner(raw), '/api/devices/claims/wc_old'));
    assert.equal(old.claim.coverage_at_filing, null);
  } finally {
    raw.close();
  }
});

test('W-1 a claim filed after the warranty ended records «expired» — the desk sees it was filed out of cover', async () => {
  const raw = seed(-3);
  try {
    const filed = await fileClaim(raw, 'sv2-w1-key-0002');
    assert.equal(filed.success, true, JSON.stringify(filed));
    const seen = await json(await get(customer(raw), `/api/devices/claims/${filed.id}`));
    assert.equal(seen.claim.coverage_at_filing.state, 'expired');
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------- W-3 (S-P1)
test('W-3 one open case per device: a second claim while the first is open is refused and points at it', async () => {
  const raw = seed(120);
  try {
    const first = await fileClaim(raw, 'sv2-w3-key-0001');
    assert.equal(first.success, true);
    const res = await post(customer(raw), '/api/devices/units/u1/claims', {
      subject: 'Extruder clicks again',
      description: 'Same printer, opened from another tab.',
      idempotencyKey: 'sv2-w3-key-0002',
    });
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'CLAIM_ALREADY_OPEN');
    assert.equal(body.details?.claim_id, first.id, 'the caller\'s own open claim is named');
    assert.equal(all(raw, "SELECT id FROM warranty_claims WHERE unit_id = 'u1'").length, 1);

    // The same key replays the first claim, as before.
    const replay = await json(await post(customer(raw), '/api/devices/units/u1/claims', {
      subject: 'Extruder clicks', description: 'The extruder clicks and under-extrudes on every print.', idempotencyKey: 'sv2-w3-key-0001',
    }));
    assert.deepEqual([replay.success, replay.replay, replay.id], [true, true, first.id]);

    // Once the first is resolved, a new case opens.
    raw.exec(`UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = '${first.id}'`);
    const second = await fileClaim(raw, 'sv2-w3-key-0003');
    assert.equal(second.success, true, JSON.stringify(second));

    // The desk cannot reopen the old one beside it.
    raw.exec(`UPDATE warranty_claims SET stage = 'rejected', status = 'rejected' WHERE id = '${first.id}'`);
    const reopen = await patch(owner(raw), `/api/devices/admin/claims/${first.id}`, { stage: 'diagnosing' });
    const rb = await json(reopen);
    assert.equal(reopen.status, 409, JSON.stringify(rb));
    assert.equal(rb.code, 'CLAIM_ALREADY_OPEN');
    assert.equal(rb.error, CLAIM_ALREADY_OPEN_DESK, 'the desk is told to close the other claim first');
    assert.equal(rb.details?.claim_id, second.id, 'staff see which claim holds the device');
    assert.equal(row<{ stage: string }>(raw, 'SELECT stage FROM warranty_claims WHERE id = ?', first.id)!.stage, 'rejected');
    // Closing the open one lets the desk reopen the other.
    raw.exec(`UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = '${second.id}'`);
    assert.equal((await patch(owner(raw), `/api/devices/admin/claims/${first.id}`, { stage: 'diagnosing' })).status, 200);
  } finally {
    raw.close();
  }
});

test('W-3 another account\'s open claim on the device is never named', async () => {
  const raw = seed(120);
  try {
    // The device was handed on: an open claim of the previous holder is still on it.
    raw.exec(`INSERT INTO users (id,name,email,username,password_hash,role) VALUES ('prev','Prev','prev@x.co','prev','h','customer');
              INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status)
              VALUES ('wc_prev','prev','oi1','Bambu A1','previous holder','u1','diagnosing','in_review')`);
    const res = await post(customer(raw), '/api/devices/units/u1/claims', {
      subject: 'Extruder clicks', description: 'The extruder clicks and under-extrudes on every print.', idempotencyKey: 'sv2-w3-key-0010',
    });
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'CLAIM_ALREADY_OPEN');
    assert.equal(body.details, undefined, JSON.stringify(body));
    assert.ok(!JSON.stringify(body).includes('wc_prev'));
    // No customer route closes a claim, and this one is not even theirs to see:
    // the sentence never asks them to close it, and points to «مطالباتي» and support.
    assert.equal(body.error, CLAIM_ALREADY_OPEN_CUSTOMER);
    for (const said of [body.error as string, ...Object.values(REFUSAL_STRINGS.CLAIM_ALREADY_OPEN)]) {
      assert.ok(!/أغلقه|close it first|دایبخە/i.test(said), said);
    }
    assert.match(REFUSAL_STRINGS.CLAIM_ALREADY_OPEN.ar, /مطالبة/);
    assert.match(REFUSAL_STRINGS.CLAIM_ALREADY_OPEN.ar, /«مطالباتي»/);
    assert.match(REFUSAL_STRINGS.CLAIM_ALREADY_OPEN.en, /claim/);
    assert.match(REFUSAL_STRINGS.CLAIM_ALREADY_OPEN.ckb, /«داواکارییەکانم»/);
    assert.ok(!REFUSAL_STRINGS.CLAIM_ALREADY_OPEN.ckb.includes('ئامێرەیە هەیە'), 'one «is», not two');
    // The form offers support when the refusal names no claim of the caller's own,
    // and the desk reads its own sentence, not the customer's.
    const form = readFileSync(new URL('../src/components/warranty/ClaimForms.tsx', import.meta.url), 'utf8');
    assert.match(form, /openElsewhere\?\.id && onOpenClaim[\s\S]*?data-claim-open-support/);
    const desk = readFileSync(new URL('../src/components/AdminSerials.tsx', import.meta.url), 'utf8');
    assert.match(desk, /e\.code === 'CLAIM_ALREADY_OPEN'\s*\?\s*s\.claimAlreadyOpen/);
  } finally {
    raw.close();
  }
});

test('W-3 the legacy desk door (PATCH /api/admin/warranty-claims/:id) cannot reopen a claim beside an open one', async () => {
  const raw = seed(120);
  try {
    // A claim from before stages (stage NULL), rejected; a newer one is open on the same device.
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status)
              VALUES ('wc_old','buyer','oi1','Bambu A1','old','u1',NULL,'rejected'),
                     ('wc_open','buyer','oi1','Bambu A1','open','u1','diagnosing','in_review')`);
    const legacy = stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes));
    const res = await patch(legacy, '/api/admin/warranty-claims/wc_old', { status: 'in_review', adminNote: 'looking again' });
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'CLAIM_ALREADY_OPEN');
    assert.equal(body.error, CLAIM_ALREADY_OPEN_DESK);
    assert.equal(row<{ status: string }>(raw, "SELECT status FROM warranty_claims WHERE id = 'wc_old'")!.status, 'rejected');
    // Once the open one is closed, the old one may be looked at again.
    raw.exec("UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = 'wc_open'");
    assert.equal((await patch(legacy, '/api/admin/warranty-claims/wc_old', { status: 'in_review', adminNote: 'looking again' })).status, 200);
  } finally {
    raw.close();
  }
});

test('W-3 two open claims on one device from before 0191 stay workable: each moves through its stages and closes', async () => {
  // A database at 0190 with the duplicate already in it, then 0191 applied (the live upgrade).
  const raw = seed(120, dbThrough('0190'));
  try {
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status) VALUES
                ('wc_a','buyer','oi1','Bambu A1','first','u1','received','submitted'),
                ('wc_b','buyer','oi1','Bambu A1','second','u1','received','submitted')`);
    raw.exec(readFileSync(new URL('../migrations/0191_services_integrity.sql', import.meta.url), 'utf8'));
    for (const id of ['wc_a', 'wc_b']) {
      for (const body of [{ stage: 'diagnosing' }, { stage: 'approved', decision: 'repair', reason: 'Bench test done' }, { stage: 'resolved', reason: 'Repaired and returned' }]) {
        const res = await patch(owner(raw), `/api/devices/admin/claims/${id}`, body);
        assert.equal(res.status, 200, `${id} → ${body.stage}: ${await res.clone().text()}`);
      }
    }
    assert.deepEqual(all(raw, "SELECT id, stage FROM warranty_claims WHERE unit_id = 'u1' ORDER BY id"), [
      { id: 'wc_a', stage: 'resolved' },
      { id: 'wc_b', stage: 'resolved' },
    ]);
  } finally {
    raw.close();
  }
});

test('W-3 drift: the database refuses exactly the claims claimIsOpen() calls open — every stage, every legacy status', () => {
  const raw = seed(120);
  try {
    raw.exec(`INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status)
              VALUES ('anchor','buyer','oi1','Bambu A1','the open case','u1','received','submitted')`);
    const stages: Array<string | null> = [...CLAIM_STAGES, null, 'unknown_stage'];
    const statuses = ['submitted', 'in_review', 'approved', 'rejected'];
    const insert = raw.prepare(
      `INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, stage, status)
       VALUES (?, 'buyer', 'oi1', 'Bambu A1', 'matrix row', 'u1', ?, ?)`
    );
    let n = 0;
    const closedRows: string[] = [];
    for (const stage of stages) {
      for (const status of statuses) {
        const id = `wc_d${n++}`;
        let refused = false;
        try {
          insert.run(id, stage, status);
        } catch (e) {
          assert.match(String((e as Error).message), /CLAIM_ALREADY_OPEN/);
          refused = true;
        }
        assert.equal(refused, claimIsOpen(stage, status), `insert (${stage}, ${status})`);
        if (!refused) closedRows.push(id);
      }
    }
    // The reopen trigger agrees too: a closed claim moved to an open stage beside the anchor is refused…
    for (const id of closedRows) {
      assert.throws(() => raw.exec(`UPDATE warranty_claims SET stage = 'diagnosing', status = 'in_review' WHERE id = '${id}'`), /CLAIM_ALREADY_OPEN/, id);
      // …and a move that stays closed is not.
      raw.exec(`UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = '${id}'`);
    }
    // Moves of the open anchor between open stages are never refused.
    raw.exec("UPDATE warranty_claims SET stage = 'diagnosing', status = 'in_review' WHERE id = 'anchor'");
    raw.exec("UPDATE warranty_claims SET stage = 'repairing', status = 'approved' WHERE id = 'anchor'");
  } finally {
    raw.close();
  }
});
