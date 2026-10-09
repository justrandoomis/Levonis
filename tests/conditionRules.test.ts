import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseConditionDoc } from '../worker/lib/condition';
import { printerWarrantyRules, WARRANTY_NOT_EXTENDABLE } from '../worker/lib/warrantyPlans';

const usedDoc = (months: 1 | 12) =>
  parseConditionDoc({ kind: 'refurbished', grade: 'like_new', warranty_months: months });

const guard = (over: Record<string, unknown> = {}) => ({
  warranty_plans: [] as Array<{ id: string; active: boolean; duration_kind: string; duration_months: number }>,
  serialized: null as boolean | null,
  warranty_base_months: null as number | null,
  condition: null as ReturnType<typeof parseConditionDoc>,
  ...over,
});

const EXTENSION = { id: 'w12', active: true, duration_kind: 'extension', duration_months: 12 };

test('a NEW printer is untouched: 12-month base, extensions allowed', () => {
  const doc = guard();
  // The rule this feature must not disturb.
  assert.deepEqual(printerWarrantyRules(doc as never, true), []);
  assert.equal(doc.warranty_base_months, 12);
  assert.equal(doc.serialized, true);

  const withPlan = guard({ warranty_plans: [EXTENSION] });
  assert.deepEqual(printerWarrantyRules(withPlan as never, true), []);
});

test('a used printer carries the owner’s months, not the 12-month default', () => {
  // A used printer is still a printer, so without the condition branch running
  // FIRST the printer default would overwrite the one month the owner chose.
  const oneMonth = guard({ condition: usedDoc(1) });
  assert.deepEqual(printerWarrantyRules(oneMonth as never, true), []);
  assert.equal(oneMonth.warranty_base_months, 1, 'the owner said one month');

  const twelve = guard({ condition: usedDoc(12) });
  assert.deepEqual(printerWarrantyRules(twelve as never, true), []);
  assert.equal(twelve.warranty_base_months, 12);
});

test('extended coverage is refused on a used unit, with its own code', () => {
  const doc = guard({ condition: usedDoc(12), warranty_plans: [EXTENSION] });
  const issues = printerWarrantyRules(doc as never, true);
  assert.equal(issues.length, 1);
  assert.match(issues[0], new RegExp(WARRANTY_NOT_EXTENDABLE));
  // Named separately from WARRANTY_NOT_PRINTER so the admin form can say the
  // real reason: this IS a printer, it is simply not a new one.
  assert.notEqual(WARRANTY_NOT_EXTENDABLE, 'WARRANTY_NOT_PRINTER');
});

test('an INACTIVE stored plan does not block saving a used listing', () => {
  // Grading an existing printer must not be blocked by a plan the owner
  // already switched off — that would make the feature unusable on exactly the
  // products it is for.
  const doc = guard({ condition: usedDoc(1), warranty_plans: [{ ...EXTENSION, active: false }] });
  assert.deepEqual(printerWarrantyRules(doc as never, true), []);
  assert.equal(doc.warranty_base_months, 1);
});

test('a used NON-printer is graded too, and still sells no coverage', () => {
  // Open box applies to filament, accessories and parts as much as to
  // printers; the condition branch must not depend on printer-ness.
  const doc = guard({ condition: usedDoc(1) });
  assert.deepEqual(printerWarrantyRules(doc as never, false), []);
  assert.equal(doc.warranty_base_months, 1);
  assert.equal(doc.serialized, null, 'owner decision 4: grading an accessory does not switch serial tracking on');

  const withPlan = guard({ condition: usedDoc(1), warranty_plans: [EXTENSION] });
  assert.match(printerWarrantyRules(withPlan as never, false)[0], new RegExp(WARRANTY_NOT_EXTENDABLE));
});

test('a used PRINTER is serialized, so its certificate can name its months', () => {
  const doc = guard({ condition: usedDoc(1) });
  printerWarrantyRules(doc as never, true);
  assert.equal(doc.serialized, true);
  // An explicit false is respected — the owner may sell an unserialized
  // accessory — and is not forced back on.
  const unserialized = guard({ condition: usedDoc(1), serialized: false });
  printerWarrantyRules(unserialized as never, false);
  assert.equal(unserialized.serialized, false);
});

test('owner decision 4 (2026-10-09): a grade turns tracking on for a printer only; a non-printer keeps its own word or none', () => {
  for (const kind of ['open_box', 'used', 'refurbished'] as const) {
    const condition = parseConditionDoc({ kind, grade: 'good', warranty_months: 1 });
    // A printer with no word of its own: tracked per unit.
    const printer = guard({ condition });
    printerWarrantyRules(printer as never, true);
    assert.equal(printer.serialized, true, `${kind} printer`);
    // An accessory (or an AMS — no name matching here) with no word: unset,
    // so its section policy or the owner's own setting decides at read time.
    const accessory = guard({ condition });
    printerWarrantyRules(accessory as never, false);
    assert.equal(accessory.serialized, null, `${kind} accessory`);
    // An explicit word is never overwritten, either way.
    for (const word of [true, false]) {
      for (const isPrinter of [true, false]) {
        const own = guard({ condition, serialized: word });
        printerWarrantyRules(own as never, isPrinter);
        assert.equal(own.serialized, word, `${kind} · printer ${isPrinter} · own word ${word}`);
      }
    }
  }
  // A NEW accessory is untouched too (the rule this decision must not disturb).
  const fresh = guard();
  printerWarrantyRules(fresh as never, false);
  assert.equal(fresh.serialized, null);
});
