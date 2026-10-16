/**
 * THE COURIER'S RECORD OF WHAT IS IN THE BOX (docs/ux/COLOUR-QUANTITIES.md §7).
 *
 * The waybill used to send `${name} x${qty}` per line, cut at 500 characters:
 * no colour, and a cut that could fall inside a line (an «x50» left as «x5»).
 * These hold the three rules that replace it: every line carries its stored
 * selection; when the text is too long the NAMES shrink first and a selection
 * or a quantity never does; and whole lines are dropped with «+N more» rather
 * than a line cut in half.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { courierItemsSummary, COURIER_NAME_SHORT } from '../worker/lib/courierSummary';

const ROOT = join(import.meta.dirname, '..');

const PLA = 'Bambu Lab PLA Basic Filament';
const incident = [
  { name_snapshot: PLA, option_snapshot: 'With spool — 1 kg / BLACK', qty: 50 },
  { name_snapshot: PLA, option_snapshot: 'With spool — 1 kg / COLD WHITE', qty: 5 },
  { name_snapshot: PLA, option_snapshot: 'With spool — 1 kg / BEIGE', qty: 1 },
];

test('the incident\'s shape: each colour is its own entry with its own quantity', () => {
  assert.equal(
    courierItemsSummary(incident),
    `${PLA} [With spool — 1 kg / BLACK] x50, ${PLA} [With spool — 1 kg / COLD WHITE] x5, ${PLA} [With spool — 1 kg / BEIGE] x1`
  );
});

test('a line with no selection keeps the old shape', () => {
  assert.equal(courierItemsSummary([{ name_snapshot: 'Bambu Lab A1', option_snapshot: '', qty: 1 }]), 'Bambu Lab A1 x1');
  assert.equal(courierItemsSummary([{ name_snapshot: 'Nozzle', option_snapshot: null, qty: 2 }]), 'Nozzle x2');
});

test('over 500: names shrink first, the selections and quantities stay whole', () => {
  const longName = 'Bambu Lab PLA Basic Filament with an extraordinarily long marketing name that goes on';
  const items = Array.from({ length: 6 }, (_, i) => ({
    name_snapshot: longName,
    option_snapshot: `With spool — 1 kg / COLOUR ${i}`,
    qty: 10 + i,
  }));
  const full = items.map((i) => `${i.name_snapshot} [${i.option_snapshot}] x${i.qty}`).join(', ');
  assert.ok(full.length > 500, 'the fixture must overflow');
  const out = courierItemsSummary(items, 500);
  assert.ok(out.length <= 500, `${out.length} characters`);
  for (const i of items) assert.ok(out.includes(`[${i.option_snapshot}] x${i.qty}`), `${i.option_snapshot} lost`);
  assert.ok(!out.includes(longName), 'the name was not shortened');
  assert.ok(out.includes(`${longName.slice(0, COURIER_NAME_SHORT - 1).trimEnd()}…`));
  assert.ok(!out.includes('more'), 'nothing had to be dropped once the names shrank');
});

test('still too long: whole lines are dropped from the end as «+N more», never cut inside a line', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    name_snapshot: 'PLA Basic',
    option_snapshot: `With spool — 1 kg / A VERY LONG COLOUR NAME NUMBER ${i}`,
    qty: 100 + i,
  }));
  const out = courierItemsSummary(items, 500);
  assert.ok(out.length <= 500, `${out.length} characters`);
  const parts = out.split(', ');
  const more = parts.pop()!;
  assert.match(more, /^\+\d+ more$/);
  assert.equal(parts.length + Number(more.slice(1, -5)), 30, 'kept plus dropped is every line');
  parts.forEach((p, i) => assert.equal(p, `PLA Basic [${items[i].option_snapshot}] x${items[i].qty}`, 'a kept line is whole'));
});

test('the waybill reads the stored selection and leaves bundle parts out', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/admin.ts'), 'utf8');
  assert.match(
    src,
    /SELECT name_snapshot, option_snapshot, qty FROM order_items WHERE order_id = \? AND bundle_parent_item_id IS NULL/,
    'the courier query must read option_snapshot and still exclude bundle children'
  );
  assert.match(src, /itemsSummary: courierItemsSummary\(items \?\? \[\], 500\)/);
  assert.ok(!/\.join\(', '\)\.slice\(0, 500\)/.test(src), 'the mid-line cut is gone');
});

test('the packing caption speaks Sorani', () => {
  const src = readFileSync(join(ROOT, 'src/components/adminOrders/OrderDetailModal.tsx'), 'utf8');
  assert.ok(src.includes("loc('الخيار واللون المطلوبان', 'Selected option and colour', 'هەڵبژاردە و ڕەنگی داواکراو')"));
});
