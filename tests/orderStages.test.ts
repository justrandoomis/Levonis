/**
 * §2/§3/§4 — the tracking paths and the clock that walks them.
 *
 * The owner's rules that a test can actually hold:
 *
 *   * five stages direct, fourteen pre-order, in the order given;
 *   * each stage owned by a person, the clock, or the courier — and the clock
 *     never owns confirmation, dispatch or delivery;
 *   * "المؤقتات تبدأ دائمًا من وقت دخول الطلب إلى الحالة الحالية، وليس من وقت
 *     إنشاء الطلب" — every wait measured from entry, so an order confirmed
 *     three days late is not already overdue;
 *   * every duration editable from admin settings;
 *   * a manual change cancels the pending automatic transition.
 *
 * The last one is the one worth stating plainly: it is not implemented as
 * "remember the old transition and skip it". scheduleFrom() recomputes the
 * whole schedule at every entry, so the pending transition is overwritten and
 * there is nothing left to skip. These tests pin the consequence, not the
 * mechanism.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STAGE_DURATIONS,
  DIRECT_STAGES,
  PREORDER_STAGES,
  STAGE_LEGACY_STATUS,
  STAGE_SOURCE,
  canMoveStage,
  nextStageOf,
  resolveDurations,
  scheduleFrom,
  spreadFor,
  stageForLegacyStatus,
  stageLabel,
  stagesFor,
  stageWaitMinutes,
  type OrderStage,
} from '../worker/lib/orderStages';

const LEGACY_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

// ------------------------------------------------------------- the paths

test('the direct path is the owner\'s five stages, in order', () => {
  assert.deepEqual(DIRECT_STAGES, [
    'received',        // تم استلام الطلب
    'confirmed',       // تم تأكيد الطلب
    'preparing',       // جارٍ تجهيز الطلب
    'out_for_delivery',// في الطريق إليك
    'delivered',       // تم التوصيل
  ]);
  assert.equal(DIRECT_STAGES.length, 5);
});

test('the pre-order path is the owner\'s fourteen stages, in order', () => {
  assert.deepEqual(PREORDER_STAGES, [
    'received',
    'confirmed',
    'supplier_preparing',
    'at_origin_warehouse',
    'preparing_freight',
    'handed_to_carrier',
    'left_origin_warehouse',
    'en_route_to_iraq',
    'arrived_iraq',
    'en_route_to_levo',
    'at_levo_warehouse',
    'local_delivery_prep',
    'out_for_delivery',
    'delivered',
  ]);
  assert.equal(PREORDER_STAGES.length, 14);
});

test('all three pre-order types walk the same fourteen stages', () => {
  for (const t of ['preorder_air', 'preorder_sea', 'preorder_land'] as const) {
    assert.deepEqual(stagesFor(t), PREORDER_STAGES);
  }
  assert.deepEqual(stagesFor('direct'), DIRECT_STAGES);
});

// ------------------------------------------------------- who owns each move

test('the owner\'s manual/automatic marking is reproduced exactly', () => {
  assert.equal(STAGE_SOURCE.received, 'automatic');          // فور إنشاء الطلب
  assert.equal(STAGE_SOURCE.confirmed, 'manual');            // يدوي من الإدمن
  assert.equal(STAGE_SOURCE.preparing, 'automatic');
  assert.equal(STAGE_SOURCE.supplier_preparing, 'automatic');
  assert.equal(STAGE_SOURCE.at_origin_warehouse, 'manual');
  assert.equal(STAGE_SOURCE.preparing_freight, 'automatic');
  assert.equal(STAGE_SOURCE.handed_to_carrier, 'automatic');
  assert.equal(STAGE_SOURCE.left_origin_warehouse, 'automatic');
  assert.equal(STAGE_SOURCE.en_route_to_iraq, 'automatic');
  assert.equal(STAGE_SOURCE.arrived_iraq, 'manual');
  assert.equal(STAGE_SOURCE.en_route_to_levo, 'automatic');
  assert.equal(STAGE_SOURCE.at_levo_warehouse, 'manual');
  assert.equal(STAGE_SOURCE.local_delivery_prep, 'manual');
  // The two the owner explicitly forbade a timer for.
  assert.equal(STAGE_SOURCE.out_for_delivery, 'delivery_api');
  assert.equal(STAGE_SOURCE.delivered, 'delivery_api');
});

test('the admin is asked for five decisions on a pre-order, not fourteen', () => {
  // "لا تعرض للإدمن عشرات الخطوات اليدوية." Five confirmations a human
  // actually has knowledge of: the order is real, it reached the source
  // warehouse, it reached Iraq, it reached our warehouse, and we are sending
  // it out locally. The other nine move on their own.
  const manual = PREORDER_STAGES.filter((s) => STAGE_SOURCE[s] === 'manual');
  assert.deepEqual(manual, ['confirmed', 'at_origin_warehouse', 'arrived_iraq', 'at_levo_warehouse', 'local_delivery_prep']);
  assert.equal(manual.length, 5);
  // And exactly one on a direct order.
  assert.deepEqual(DIRECT_STAGES.filter((s) => STAGE_SOURCE[s] === 'manual'), ['confirmed']);
});

// --------------------------------------------------- the legacy status map

test('every stage maps to a status the 0001 CHECK constraint allows', () => {
  // The stage column is new; `orders.status` is not, and writing a value
  // outside the six would make the UPDATE fail at the database, not in code.
  for (const stage of Object.keys(STAGE_LEGACY_STATUS) as OrderStage[]) {
    assert.ok(
      LEGACY_STATUSES.includes(STAGE_LEGACY_STATUS[stage]),
      `${stage} maps to "${STAGE_LEGACY_STATUS[stage]}", which the CHECK forbids`
    );
  }
});

test('everything from confirmation onwards keeps the stock deducted', () => {
  // The stock lifecycle keys off the legacy status. If a warehouse stage
  // mapped back to 'pending', reaching it would silently hand the units back.
  const deducted = new Set(['confirmed', 'processing', 'shipped', 'delivered']);
  for (const path of [DIRECT_STAGES, PREORDER_STAGES]) {
    for (const stage of path.slice(path.indexOf('confirmed'))) {
      assert.ok(deducted.has(STAGE_LEGACY_STATUS[stage]), `${stage} would release the stock`);
    }
  }
});

test('a legacy status maps back to the EARLIEST stage carrying it, never the furthest', () => {
  // Five pre-order stages share 'shipped'. Choosing any but the first would
  // tell a customer their parcel had reached Iraq because an admin ticked
  // "shipped" in the old panel.
  assert.equal(stageForLegacyStatus('shipped', 'preorder_air'), 'handed_to_carrier');
  assert.equal(stageForLegacyStatus('processing', 'preorder_sea'), 'supplier_preparing');
  assert.equal(stageForLegacyStatus('processing', 'direct'), 'preparing');
  assert.equal(stageForLegacyStatus('shipped', 'direct'), 'out_for_delivery');
  assert.equal(stageForLegacyStatus('pending', 'direct'), 'received');
  assert.equal(stageForLegacyStatus('cancelled', 'direct'), 'cancelled');
});

// --------------------------------------------------------------- the labels

test('the freight stage names the mode the owner asked it to name', () => {
  assert.equal(stageLabel('preparing_freight', 'preorder_air', 'ar'), 'جارٍ التجهيز للشحن الجوي');
  assert.equal(stageLabel('preparing_freight', 'preorder_sea', 'ar'), 'جارٍ التجهيز للشحن البحري');
  assert.equal(stageLabel('preparing_freight', 'preorder_land', 'ar'), 'جارٍ التجهيز للشحن البري');
});

test('the owner\'s stage wording is used verbatim', () => {
  assert.equal(stageLabel('received', 'direct', 'ar'), 'تم استلام الطلب');
  assert.equal(stageLabel('confirmed', 'direct', 'ar'), 'تم تأكيد الطلب');
  assert.equal(stageLabel('preparing', 'direct', 'ar'), 'جارٍ تجهيز الطلب');
  assert.equal(stageLabel('supplier_preparing', 'preorder_air', 'ar'), 'جارٍ تجهيز الطلب لدى المورد');
  assert.equal(stageLabel('at_origin_warehouse', 'preorder_air', 'ar'), 'وصل إلى مخزن بلد المصدر');
  assert.equal(stageLabel('handed_to_carrier', 'preorder_air', 'ar'), 'تم تسليمه لشركة النقل');
  assert.equal(stageLabel('left_origin_warehouse', 'preorder_air', 'ar'), 'غادر مخزن بلد المصدر');
  assert.equal(stageLabel('en_route_to_iraq', 'preorder_air', 'ar'), 'في الطريق إلى العراق');
  assert.equal(stageLabel('arrived_iraq', 'preorder_air', 'ar'), 'وصل إلى العراق');
  assert.equal(stageLabel('en_route_to_levo', 'preorder_air', 'ar'), 'في الطريق إلى مخزن LEVO');
  assert.equal(stageLabel('at_levo_warehouse', 'preorder_air', 'ar'), 'وصل إلى مخزن LEVO');
  assert.equal(stageLabel('local_delivery_prep', 'preorder_air', 'ar'), 'جارٍ تجهيز التوصيل المحلي');
  assert.equal(stageLabel('out_for_delivery', 'direct', 'ar'), 'في الطريق إليك');
  assert.equal(stageLabel('delivered', 'direct', 'ar'), 'تم التوصيل');
});

test('every stage has a label in all three languages', () => {
  for (const stage of Object.keys(STAGE_SOURCE) as OrderStage[]) {
    for (const lang of ['ar', 'en', 'ckb']) {
      const label = stageLabel(stage, 'preorder_air', lang);
      assert.ok(label.length > 0, `${stage} has no ${lang} label`);
    }
  }
});

// ------------------------------------------------------------- the schedule

test('the clock never confirms an order', () => {
  // Confirmation is where money and stock become real. Nothing but a person
  // may do it, so `received` has no wait at all.
  assert.equal(stageWaitMinutes('received', 'direct', DEFAULT_STAGE_DURATIONS), null);
  assert.equal(scheduleFrom('received', 'direct', DEFAULT_STAGE_DURATIONS, '2026-01-01T00:00:00.000Z').next_stage_at, null);
  assert.equal(scheduleFrom('received', 'preorder_air', DEFAULT_STAGE_DURATIONS, '2026-01-01T00:00:00.000Z').next_stage, 'confirmed');
});

test('no manual or courier stage is ever given a time', () => {
  // The sweep only sees rows with a next_stage_at. Anything that must wait on
  // a person or on Al-Waseet must therefore have none.
  const at = '2026-01-01T00:00:00.000Z';
  for (const type of ['direct', 'preorder_air', 'preorder_sea', 'preorder_land'] as const) {
    for (const stage of stagesFor(type)) {
      const s = scheduleFrom(stage, type, DEFAULT_STAGE_DURATIONS, at);
      if (s.next_stage && STAGE_SOURCE[s.next_stage] !== 'automatic') {
        assert.equal(s.next_stage_at, null, `${stage} -> ${s.next_stage} was scheduled but is ${STAGE_SOURCE[s.next_stage]}`);
      }
    }
  }
});

test('nothing at all is scheduled towards "out for delivery" or "delivered"', () => {
  // "لا تستخدم Timer للانتقال إلى في الطريق إليك أو تم التوصيل" — stated
  // once for Al-Waseet, true for both paths.
  const at = '2026-01-01T00:00:00.000Z';
  for (const type of ['direct', 'preorder_air'] as const) {
    for (const stage of stagesFor(type)) {
      const s = scheduleFrom(stage, type, DEFAULT_STAGE_DURATIONS, at);
      if (s.next_stage === 'out_for_delivery' || s.next_stage === 'delivered') {
        assert.equal(s.next_stage_at, null, `${type}: ${stage} would time its way to ${s.next_stage}`);
      }
    }
  }
});

test('the timer runs from entry into the stage, not from the order\'s creation', () => {
  // An order placed on the 1st and confirmed on the 4th waits its configured
  // minutes from the 4th. Measuring from creation would promote it instantly.
  const confirmedAt = '2026-01-04T09:00:00.000Z';
  const s = scheduleFrom('confirmed', 'direct', DEFAULT_STAGE_DURATIONS, confirmedAt);
  assert.equal(s.next_stage, 'preparing');
  assert.equal(
    s.next_stage_at,
    new Date(Date.parse(confirmedAt) + DEFAULT_STAGE_DURATIONS.preparing * 60_000).toISOString()
  );
});

test('a manual change re-arms the clock from the new entry time', () => {
  // This is the "تلغي الانتقال التلقائي السابق" rule. The schedule is
  // recomputed wholesale at every entry, so the transition that was pending
  // is overwritten rather than remembered and skipped.
  const first = scheduleFrom('confirmed', 'preorder_air', DEFAULT_STAGE_DURATIONS, '2026-01-01T00:00:00.000Z');
  const afterManualJump = scheduleFrom('at_origin_warehouse', 'preorder_air', DEFAULT_STAGE_DURATIONS, '2026-01-03T00:00:00.000Z');
  assert.equal(first.next_stage, 'supplier_preparing');
  assert.equal(afterManualJump.next_stage, 'preparing_freight');
  // Nothing about the earlier schedule survives into the new one.
  assert.notEqual(first.next_stage, afterManualJump.next_stage);
  assert.ok(afterManualJump.next_stage_at! > first.next_stage_at!);
});

test('the supplier wait lands inside the owner\'s 30–120 minute range', () => {
  for (const id of ['ord_a', 'ord_b', 'ord_c', 'ord_zzzz', 'ord_1', '']) {
    const wait = stageWaitMinutes('confirmed', 'preorder_air', DEFAULT_STAGE_DURATIONS, spreadFor(id))!;
    assert.ok(wait >= 30 && wait <= 120, `${id} waited ${wait} minutes`);
  }
});

test('the transit-to-Iraq wait lands inside the owner\'s 6–12 hour range', () => {
  for (const id of ['ord_a', 'ord_b', 'ord_c', 'ord_zzzz']) {
    const wait = stageWaitMinutes('left_origin_warehouse', 'preorder_sea', DEFAULT_STAGE_DURATIONS, spreadFor(id))!;
    assert.ok(wait >= 360 && wait <= 720, `${id} waited ${wait} minutes`);
  }
});

test('an order sits at the same point of a range every time it is recomputed', () => {
  // Redrawing at random on every sweep would make the promised time jump
  // backwards between two checks.
  assert.equal(spreadFor('ord_abc123'), spreadFor('ord_abc123'));
  assert.notEqual(spreadFor('ord_abc123'), spreadFor('ord_abc124'));
  assert.ok(spreadFor('ord_abc123') >= 0 && spreadFor('ord_abc123') < 1);
});

test('air, sea and land wait different, separately-configurable times', () => {
  const air = stageWaitMinutes('at_origin_warehouse', 'preorder_air', DEFAULT_STAGE_DURATIONS)!;
  const sea = stageWaitMinutes('at_origin_warehouse', 'preorder_sea', DEFAULT_STAGE_DURATIONS)!;
  const land = stageWaitMinutes('at_origin_warehouse', 'preorder_land', DEFAULT_STAGE_DURATIONS)!;
  assert.equal(air, DEFAULT_STAGE_DURATIONS.preparing_freight_air);
  assert.equal(sea, DEFAULT_STAGE_DURATIONS.preparing_freight_sea);
  assert.equal(land, DEFAULT_STAGE_DURATIONS.preparing_freight_land);
  assert.equal(new Set([air, sea, land]).size, 3);
});

// ----------------------------------------------------- admin-configurable

test('every duration can be overridden from admin settings', () => {
  const keys = Object.keys(DEFAULT_STAGE_DURATIONS);
  const allOnes = Object.fromEntries(keys.map((k) => [k, 1]));
  const d = resolveDurations(allOnes);
  for (const k of keys) assert.equal(d[k as keyof typeof d], 1, `${k} was not editable`);
});

test('the freight waits the owner singled out are editable one by one', () => {
  const d = resolveDurations({ preparing_freight_air: 90, preparing_freight_sea: 5000, preparing_freight_land: 700 });
  assert.equal(stageWaitMinutes('at_origin_warehouse', 'preorder_air', d), 90);
  assert.equal(stageWaitMinutes('at_origin_warehouse', 'preorder_sea', d), 5000);
  assert.equal(stageWaitMinutes('at_origin_warehouse', 'preorder_land', d), 700);
});

test('junk in the settings row falls back to the defaults instead of breaking the clock', () => {
  assert.deepEqual(resolveDurations(null), DEFAULT_STAGE_DURATIONS);
  assert.deepEqual(resolveDurations('nonsense'), DEFAULT_STAGE_DURATIONS);
  assert.deepEqual(resolveDurations({}), DEFAULT_STAGE_DURATIONS);
  // A negative wait would schedule the promotion in the past — every order in
  // that stage would be promoted on the very next sweep.
  assert.equal(resolveDurations({ preparing: -30 }).preparing, DEFAULT_STAGE_DURATIONS.preparing);
  assert.equal(resolveDurations({ preparing: 'abc' }).preparing, DEFAULT_STAGE_DURATIONS.preparing);
  // A year is the ceiling; anything past it is a typo, not a policy.
  assert.equal(resolveDurations({ preparing: 99_999_999 }).preparing, DEFAULT_STAGE_DURATIONS.preparing);
  // Zero is legitimate — an owner testing the flow wants instant promotion.
  assert.equal(resolveDurations({ preparing: 0 }).preparing, 0);
  // A numeric string is what an <input> gives you.
  assert.equal(resolveDurations({ preparing: '45' }).preparing, 45);
});

test('an inverted range is repaired, not left to produce a negative wait', () => {
  const d = resolveDurations({ supplier_preparing_min: 120, supplier_preparing_max: 30 });
  assert.equal(d.supplier_preparing_max, 120);
  const wait = stageWaitMinutes('confirmed', 'preorder_air', d, 0.5)!;
  assert.ok(wait >= 0);
});

// ------------------------------------------------------------- the moves

test('the path runs forward end to end', () => {
  for (const type of ['direct', 'preorder_air'] as const) {
    const path = stagesFor(type);
    for (let i = 0; i < path.length - 1; i++) {
      assert.equal(nextStageOf(path[i], type), path[i + 1]);
    }
    assert.equal(nextStageOf(path[path.length - 1], type), null);
  }
});

test('an admin may jump forward but only step back one', () => {
  // Forward: someone holding the goods should not tap through six screens.
  assert.ok(canMoveStage('confirmed', 'at_levo_warehouse', 'preorder_air'));
  // Back one, to undo a mis-tap.
  assert.ok(canMoveStage('arrived_iraq', 'en_route_to_iraq', 'preorder_air'));
  // Not back two — that is a different order's history being rewritten.
  assert.ok(!canMoveStage('arrived_iraq', 'left_origin_warehouse', 'preorder_air'));
  assert.ok(!canMoveStage('confirmed', 'confirmed', 'direct'));
});

test('a direct order can never be moved to a pre-order stage', () => {
  assert.ok(!canMoveStage('confirmed', 'en_route_to_iraq', 'direct'));
  assert.ok(!canMoveStage('preparing', 'at_levo_warehouse', 'direct'));
});

test('cancelling is allowed until the goods are delivered, and re-opening lands early', () => {
  assert.ok(canMoveStage('received', 'cancelled', 'direct'));
  assert.ok(canMoveStage('en_route_to_iraq', 'cancelled', 'preorder_air'));
  // A delivered order cannot be cancelled — it must be walked back first.
  assert.ok(!canMoveStage('delivered', 'cancelled', 'direct'));
  // Re-opening puts it back at the start, never at a dispatch stage: a
  // cancelled order was never on a lorry.
  assert.ok(canMoveStage('cancelled', 'received', 'direct'));
  assert.ok(canMoveStage('cancelled', 'confirmed', 'direct'));
  assert.ok(!canMoveStage('cancelled', 'out_for_delivery', 'direct'));
  assert.ok(!canMoveStage('cancelled', 'arrived_iraq', 'preorder_air'));
});
