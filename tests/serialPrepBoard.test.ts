/**
 * «الأرقام n/m» ON THE ORDERS BOARD (serial scan, migration 0177; spec §5.5)
 * — through the real board route over the real migrations.
 *
 * The row says how many of the units on the shelf carry their serial, with
 * the same slot rule as the order window (printers, a 'required' section,
 * never an accessory, a bundle parent or a community-store order), and says
 * when the owner's §19 gate would refuse the row's one-tap move — so the
 * board draws the count instead of a button that can only be refused.
 *
 * Run: node --import tsx --test tests/serialPrepBoard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, put, get } from './fixtures/app';
import { world, order, op, SN, SN2 } from './fixtures/serialPrep';

type BoardRow = { id: string; serials?: { required: number; linked: number; gate: boolean; holds_next: boolean }; quick_next?: { stage: string } | null };

const board = async (w: ReturnType<typeof world>) => {
  const body = await json(await get(w.as('adm'), '/api/admin/orders?scope=all&limit=100'));
  return new Map((body.orders as BoardRow[]).map((o) => [o.id, o]));
};

test('each shelf row counts its serial units — printers yes, accessories no, linked as they are scanned', async () => {
  const w = world();
  order(w.raw, 'ORD-B1', [
    { id: 'b1a', product: 'pA1', qty: 2 },
    { id: 'b1p', product: 'pPLA', qty: 3 },
  ]);
  order(w.raw, 'ORD-B2', [{ id: 'b2p', product: 'pPLA', qty: 1 }]);
  order(w.raw, 'ORD-B3', [{ id: 'b3a', product: 'pA1' }], { status: 'pending', stage: 'received' });

  let rows = await board(w);
  assert.deepEqual(rows.get('ORD-B1')?.serials, { required: 2, linked: 0, gate: false, holds_next: false });
  assert.equal(rows.get('ORD-B2')?.serials, undefined, 'a filament order has no serial units');
  assert.equal(rows.get('ORD-B3')?.serials, undefined, 'a pending order is not on the shelf yet');

  const res = await post(w.as('adm'), '/api/admin/orders/ORD-B1/serials/scan', { order_item_id: 'b1a', unit_index: 1, code: SN, source: 'scanner', op_id: op() });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  rows = await board(w);
  assert.equal(rows.get('ORD-B1')?.serials?.linked, 1);

  // The AMS section switched to «مطلوب» by the owner: the AMS line counts too.
  order(w.raw, 'ORD-B4', [{ id: 'b4m', product: 'pAMS' }]);
  assert.equal((await board(w)).get('ORD-B4')?.serials, undefined);
  await put(w.as('boss'), '/api/admin/taxonomy/catalogs/ct_ams/serial-policy', { policy: 'required' });
  assert.deepEqual((await board(w)).get('ORD-B4')?.serials, { required: 1, linked: 0, gate: false, holds_next: false });
});

test('the owner\'s gate: the row says the next move is held — and stops saying it once every unit is linked', async () => {
  const w = world();
  const before = new Date(Date.now() - 86_400_000).toISOString();
  order(w.raw, 'ORD-G1', [{ id: 'g1a', product: 'pA1', qty: 2 }]);
  order(w.raw, 'ORD-G0', [{ id: 'g0a', product: 'pA1' }], { created_at: before });
  const on = await put(w.as('boss'), '/api/admin/settings/serialPrepGate', { value: { enabled: true, since: new Date(Date.now() - 60_000).toISOString() } });
  assert.equal(on.status, 200);

  let rows = await board(w);
  const g1 = rows.get('ORD-G1');
  assert.equal(g1?.quick_next?.stage, 'out_for_delivery', 'the fixture order sits at «preparing»');
  assert.deepEqual(g1?.serials, { required: 2, linked: 0, gate: true, holds_next: true });
  assert.deepEqual(rows.get('ORD-G0')?.serials, { required: 1, linked: 0, gate: false, holds_next: false }, 'an order created before the cutover is never held');

  for (const [unit, code] of [[1, SN], [2, SN2]] as const) {
    const r = await post(w.as('adm'), '/api/admin/orders/ORD-G1/serials/scan', { order_item_id: 'g1a', unit_index: unit, code, source: 'camera', op_id: op() });
    assert.equal(r.status, 200);
  }
  rows = await board(w);
  assert.deepEqual(rows.get('ORD-G1')?.serials, { required: 2, linked: 2, gate: true, holds_next: false });
});

test('deploy-ahead: before migration 0177 the board answers exactly as before, with no serial field', async () => {
  const w = world({ through: '0176' });
  order(w.raw, 'ORD-OLD', [{ id: 'oa', product: 'pA1' }]);
  const res = await get(w.as('adm'), '/api/admin/orders?scope=all');
  assert.equal(res.status, 200);
  const rows = (await json(res)).orders as BoardRow[];
  assert.equal(rows.find((o) => o.id === 'ORD-OLD')?.serials, undefined);
});

test('the row draws the count, and never a one-tap move the gate would refuse', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/components/adminOrders/OrderBoardRow.tsx', import.meta.url), 'utf8');
  assert.match(src, /<SerialsChip/);
  assert.match(src, /!order\.serials\?\.holds_next/, 'the quick move is withheld while the gate holds it');
  assert.match(src, /data-serial-board-chip/);
});
