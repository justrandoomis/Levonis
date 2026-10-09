/**
 * ONE CANONICALISER FOR EVERY SOURCE AND EVERY DOOR (serial scan; owner brief
 * §5, §6, §23; critique-2 H1, L1, L10, L16).
 *
 * H1's failure was a second identity for one device: a box SN, a UPC or an
 * ITF-14 read by a USB scanner after the product SN, or «SN 0391…» typed with
 * a space instead of a colon, each became a NEW serial_inventory row. These
 * tests drive every one of those values through every way in — the four scan
 * sources, the change and override doors, the post-delivery and replacement
 * doors — and prove the store still holds one device.
 *
 * Run: node --import tsx --test tests/serialPrepCanonical.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, row, count, stubApp, failingD1 } from './fixtures/app';
import { world, order, op, SN, SN2, SN3, BOX, EAN, USERS } from './fixtures/serialPrep';
import { adminOrderSerialRoutes } from '../worker/routes/adminOrderSerials';
import { classifyScanInput, stripSerialPrefix } from '../worker/lib/serialAssignments';
import { classifyCode } from '../packages/catalog/src/deviceSerials';
import { GENERIC_RULE, LEGACY_RULE } from '../packages/catalog/src/serialRules';
import { ruleFromRow, type RuleRow } from '../worker/lib/serialRules';

/** The Bambu Lab rule exactly as migration 0181 seeds it (owner decision 2). */
const bambuRule = () => {
  const w = world();
  return ruleFromRow(row<RuleRow>(w.raw, "SELECT * FROM serial_brand_rules WHERE id = 'sbr_bambu_lab'")!);
};

type W = ReturnType<typeof world>;
const scanBody = (item: string, unit: number, code: string, extra: Record<string, unknown> = {}) => ({
  order_item_id: item, unit_index: unit, code, source: 'camera', op_id: op(), ...extra,
});
const scan = (w: W, who: 'adm' | 'boss' | 'ast', o: string, item: string, unit: number, code: string, extra: Record<string, unknown> = {}) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, scanBody(item, unit, code, extra));

/** Values that are never a device, with the problem the server names. */
const NOT_A_DEVICE: ReadonlyArray<readonly [string, string, string]> = [
  [EAN, 'SERIAL_LOOKS_LIKE_EAN', 'EAN-13 from the same label'],
  ['012345678905', 'SERIAL_LOOKS_LIKE_EAN', 'UPC-A'],
  ['96385074', 'SERIAL_LOOKS_LIKE_EAN', 'EAN-8'],
  ['10012345678902', 'SERIAL_LOOKS_LIKE_EAN', 'ITF-14 on the carton'],
  ['6977 2524 25445', 'SERIAL_LOOKS_LIKE_EAN', 'an EAN typed with spaces'],
  ['WR-2026-0905-001', 'SERIAL_LOOKS_LIKE_RECEIPT', 'a warranty receipt number'],
  ['https://levonis-iq.com/warranty/WR-2026-0905-001', 'SERIAL_LOOKS_LIKE_RECEIPT', 'the receipt QR link'],
  ['A1B2', 'SERIAL_TOO_SHORT', 'under six characters'],
  ['X'.repeat(41), 'SERIAL_TOO_LONG', 'over forty characters'],
  ['03919D58/607841', 'SERIAL_CHARS', 'a slash'],
  ['ي03919D580607841', 'SERIAL_CHARS', 'a layout-garbled letter'],
  [BOX, 'BOX_ONLY', 'a box SN nobody filed'],
];

// ------------------------------------------------------------------ the pure rule

test('H1 the pure rule: one device in every written form is one key; what is not a device says what it is', () => {
  const forms = [
    '03919D580607841', '03919d58-0607841', ' 0391 9D58 0607841 ', 'SN: 03919D580607841', 'SN 03919D580607841',
    'sn 03919D580607841', 'S/N 03919D580607841', 'S/N:03919D580607841', 'Product SN: 03919D580607841', 'SN#03919D580607841',
    '٠٣٩١٩D580607841', '0391٩D58٠607841', '03919D58‏0607841', '03919D58–0607841',
  ];
  for (const f of forms) {
    const c = classifyScanInput(f);
    assert.equal(c.kind, 'serial', JSON.stringify(f));
    assert.equal((c as { norm: string }).norm, SN, JSON.stringify(f));
    // The shared classifier (camera, label reader) agrees with the server's.
    assert.equal(classifyCode({ text: f }).value, SN, `classifyCode ${JSON.stringify(f)}`);
  }
  // The raw value keeps what was printed, without the prefix and with spaces collapsed.
  assert.equal((classifyScanInput('SN 03919D580607841') as { raw: string }).raw, SN);
  assert.equal((classifyScanInput(' 0391  9D58 0607841 ') as { raw: string }).raw, '0391 9D58 0607841');
  // A separator is what makes «SN» a prefix: a serial that merely starts with S and N is kept whole.
  assert.equal(stripSerialPrefix('SNOW12345678'), 'SNOW12345678');
  assert.equal((classifyScanInput('SNOW12345678') as { norm: string }).norm, 'SNOW12345678');
  assert.equal(stripSerialPrefix('SN '), 'SN', 'a bare prefix is not stripped down to nothing');

  // Owner decision 2: the box-number shape is a box SN only under a rule that
  // names it — Bambu Lab's seed, and LEGACY_RULE (today's reading, before 0181).
  // Every other value is judged the same under every rule.
  const bambu = bambuRule();
  for (const rule of [bambu, LEGACY_RULE, GENERIC_RULE]) {
    for (const [code, problem, what] of NOT_A_DEVICE) {
      const c = classifyScanInput(code, rule);
      if (problem === 'BOX_ONLY' && rule === GENERIC_RULE) {
        assert.deepEqual(c, { kind: 'serial', norm: BOX, raw: BOX }, `${what}: another brand's serial of that shape (generic rule)`);
      } else if (problem === 'BOX_ONLY') {
        assert.deepEqual(c, { kind: 'box_sn', box: BOX }, `${what} (${rule.id})`);
        assert.deepEqual(classifyScanInput(`SN ${BOX}`, rule), { kind: 'box_sn', box: BOX }, 'a box SN behind the whitespace prefix is still a box SN');
      } else {
        assert.deepEqual(c, { kind: 'invalid', problem }, `${what} (${rule.id})`);
      }
    }
  }
  assert.deepEqual(classifyScanInput(BOX), { kind: 'box_sn', box: BOX }, 'no rule named: today\'s reading');
  assert.deepEqual(classifyScanInput(''), { kind: 'invalid', problem: 'SERIAL_EMPTY' });
  assert.deepEqual(classifyScanInput(null), { kind: 'invalid', problem: 'SERIAL_EMPTY' });
  assert.deepEqual(classifyScanInput({ toString: () => EAN }), { kind: 'invalid', problem: 'SERIAL_LOOKS_LIKE_EAN' }, 'whatever arrives is read as text');
});

// ------------------------------------------------------------------ every source, every door

test('H1 every scan source — camera, scanner, typing, re-link — refuses the same values the same way, and writes nothing', async () => {
  const w = world();
  order(w.raw, 'ORD-SRC', [{ id: 'l1', product: 'pA1' }]);
  for (const source of ['camera', 'scanner', 'manual', 'relink'] as const) {
    for (const [code, problem, what] of NOT_A_DEVICE) {
      const r = await scan(w, 'adm', 'ORD-SRC', 'l1', 1, code, { source });
      const body = await json(r);
      assert.equal(r.status, 400, `${source} · ${what}: ${JSON.stringify(body)}`);
      assert.equal(body.code, 'SERIAL_INVALID');
      assert.equal(body.details.problem, problem, `${source} · ${what}`);
      assert.equal(body.error, 'هذا ليس رقمًا تسلسليًا صالحًا — امسح «Product SN» أو اكتبه كما هو مطبوع.');
      assert.ok(!/at .*\.ts:\d+|Error:|SQLITE/.test(JSON.stringify(body)), '§31 never a trace');
    }
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory'), 0, 'not one asset');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0, 'not one binding');
  // An unknown source is not a way around it.
  const odd = await scan(w, 'adm', 'ORD-SRC', 'l1', 1, SN, { source: 'import' });
  assert.equal(odd.status, 400);
});

test('H1 the change, override, post-delivery and replacement doors run the same canonicaliser', async () => {
  const w = world();
  order(w.raw, 'ORD-DR', [{ id: 'l1', product: 'pA1', qty: 2 }]);
  const first = await json(await scan(w, 'adm', 'ORD-DR', 'l1', 1, SN));
  // Change: refused, the old link intact.
  for (const [code, problem] of [[EAN, 'SERIAL_LOOKS_LIKE_EAN'], [BOX, 'BOX_ONLY'], ['10012345678902', 'SERIAL_LOOKS_LIKE_EAN']] as const) {
    const ch = await json(await post(w.as('adm'), '/api/admin/orders/ORD-DR/serials/change', { assignment_id: first.assignment_id, code, source: 'scanner', op_id: op() }));
    assert.equal(ch.code, 'SERIAL_INVALID');
    assert.equal(ch.details.problem, problem);
  }
  assert.equal(row(w.raw, 'SELECT released_at FROM serial_assignments WHERE id = ?', first.assignment_id)!.released_at, null);
  // The owner's exception is not a way around it either.
  const ov = await json(await post(w.as('boss'), '/api/admin/orders/ORD-DR/serials/override', {
    order_item_id: 'l1', unit_index: 2, code: '012345678905', kind: 'outside_window', reason: 'owner typing the label', op_id: op(),
  }));
  assert.equal(ov.code, 'SERIAL_INVALID');

  // The post-delivery door and the replacement door (devices.ts).
  w.raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-PD','u2','delivered','{}','home','{}','cash',1,1400,1,0,'2026-09-01T00:00:00.000Z');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES ('lpd','ORD-PD','pA1','A1',1,1,1);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
      VALUES ('unit_pd','ORD-PD','lpd','pA1','u2',1,'2026-09-01T00:00:00.000Z',12,'2026-09-01T00:00:00.000Z','2027-09-01T00:00:00.000Z');
  `);
  for (const [code, problem] of [[EAN, 'SERIAL_LOOKS_LIKE_EAN'], [BOX, 'BOX_ONLY'], ['WR-2026-0905-001', 'SERIAL_LOOKS_LIKE_RECEIPT'], ['AB12', 'SERIAL_TOO_SHORT']] as const) {
    const pd = await json(await post(w.as('boss'), '/api/devices/admin/units/unit_pd/serial', { serial: code }));
    assert.equal(pd.code, 'SERIAL_INVALID', `post-delivery ${code}`);
    assert.equal(pd.details.problem, problem);
    const rp = await json(await post(w.as('boss'), '/api/devices/admin/units/unit_pd/replace', { reason: 'dead on arrival, swapped', new_serial: code }));
    assert.equal(rp.code, 'SERIAL_INVALID', `replacement ${code}`);
  }
  // «SN 0391…» through the post-delivery door is the SAME device as at preparation.
  const sameDevice = await json(await post(w.as('boss'), '/api/devices/admin/units/unit_pd/serial', { serial: `SN ${SN}` }));
  assert.equal(sameDevice.code, 'SERIAL_IN_USE', 'it is bound to ORD-DR, not a new SN0391… device');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm LIKE 'SN%'"), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM device_serials'), 0, 'nothing was assigned');
});

// ------------------------------------------------------------------ one device, one asset

test('H1 the same device typed, scanned and pasted in every form on one order: ONE asset, ONE binding', async () => {
  const w = world();
  order(w.raw, 'ORD-ONE', [{ id: 'l1', product: 'pA1', qty: 6 }]);
  assert.equal((await json(await scan(w, 'adm', 'ORD-ONE', 'l1', 1, 'S/N: 03919d58-0607841', { source: 'manual' }))).outcome, 'created');
  const others = ['SN 03919D580607841', '٠٣٩١٩D580607841', '03919D58‏0607841', ' 0391 9D58 0607841 ', 'Product SN: 03919D580607841'];
  for (const [i, f] of others.entries()) {
    const body = await json(await scan(w, 'adm', 'ORD-ONE', 'l1', i + 2, f, { source: i % 2 ? 'scanner' : 'manual' }));
    assert.equal(body.code, 'SERIAL_IN_USE_THIS_ORDER', JSON.stringify(f));
    assert.equal(body.details.unit_index, 1, 'it names the unit that holds it');
  }
  // On the same slot it is the same link, whatever the form.
  const again = await json(await scan(w, 'adm', 'ORD-ONE', 'l1', 1, 'sn 03919D580607841'));
  assert.equal(again.outcome, 'already');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory'), 1);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 1);
  assert.equal(row(w.raw, 'SELECT serial_norm FROM serial_inventory')!.serial_norm, SN);
});

// ------------------------------------------------------------------ box ↔ serial

test('H1 box and serial never cross: a companion box that is a device, a device that is a box, a box only through its device', async () => {
  const w = world();
  order(w.raw, 'ORD-BX', [{ id: 'l1', product: 'pA1', qty: 3 }]);
  order(w.raw, 'ORD-BY', [{ id: 'l2', product: 'pA1' }]);
  // The camera reads the whole label: SN + box SN + EAN. The asset keeps the companions.
  const label = await json(await scan(w, 'adm', 'ORD-BX', 'l1', 1, SN, { box_sn: BOX, ean: EAN }));
  assert.equal(label.outcome, 'created', JSON.stringify(label));
  const asset = row<{ box_sn: string; ean: string }>(w.raw, 'SELECT box_sn, ean FROM serial_inventory WHERE serial_norm = ?', SN)!;
  assert.deepEqual({ ...asset }, { box_sn: BOX, ean: EAN });
  // A later box-only read on another order IS that device.
  assert.equal((await json(await scan(w, 'adm', 'ORD-BY', 'l2', 1, BOX))).code, 'SERIAL_IN_USE');
  // A new serial whose companion box is ANOTHER device's serial: the same box read twice.
  const crossed = await json(await scan(w, 'adm', 'ORD-BX', 'l1', 2, SN2, { box_sn: SN }));
  assert.equal(crossed.code, 'SERIAL_INVALID');
  assert.equal(crossed.details.problem, 'BOX_SN_IS_SERIAL');
  // A value shaped like a box SN that the store holds AS a device serial is that device.
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('B1234X567','B1234X567','pA1','boss')`);
  const boxShaped = await json(await scan(w, 'adm', 'ORD-BX', 'l1', 2, 'B1234X567'));
  assert.equal(boxShaped.outcome, 'existing', JSON.stringify(boxShaped));
  // Companions that are not what they claim are dropped, never stored (L1: no NULL into NOT NULL).
  const junk = await json(await scan(w, 'adm', 'ORD-BX', 'l1', 3, SN3, { box_sn: 'not a box!', ean: '123' }));
  assert.equal(junk.outcome, 'created', JSON.stringify(junk));
  assert.deepEqual({ ...row(w.raw, 'SELECT box_sn, ean FROM serial_inventory WHERE serial_norm = ?', SN3)! }, { box_sn: '', ean: '' });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', BOX), 0, 'the box SN never became a device');
});

test('H1 a box SN filed on another device between the scan\'s read and its batch is caught inside the batch (S4)', async () => {
  const w = world();
  order(w.raw, 'ORD-S4', [{ id: 'l1', product: 'pA1' }]);
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES ('${SN2}','${SN2}','pA1','boss')`);
  const { failing, db } = failingD1(w.raw);
  failing.beforeBatch = (s) => {
    if (s.some((x) => /INSERT INTO serial_assignments/.test(x.sql))) {
      w.raw.exec(`UPDATE serial_inventory SET box_sn = '${SN}' WHERE serial_norm = '${SN2}'`);
    }
  };
  const app = stubApp(db, USERS.adm, (a) => a.route('/api/admin/orders', adminOrderSerialRoutes));
  const r = await post(app, '/api/admin/orders/ORD-S4/serials/scan', scanBody('l1', 1, SN));
  const body = await json(r);
  assert.equal(r.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'SERIAL_INVALID');
  assert.equal(body.details.problem, 'BOX_SN', 'the honest reason, re-read after the batch failed — not SERIAL_RACE');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', SN), 0, 'nothing of the batch survived');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0);
});

// ------------------------------------------------------------------ L10 / L16

test('L10/L16 out-of-range input gets its own answer, never a fake race: long codes, long reasons, the AMS part, a missing op_id', async () => {
  const w = world();
  order(w.raw, 'ORD-L16', [{ id: 'l1', product: 'pA1' }]);
  const long = await json(await scan(w, 'adm', 'ORD-L16', 'l1', 1, '9'.repeat(300)));
  assert.equal(long.code, 'SERIAL_INVALID');
  assert.equal(long.details.problem, 'SERIAL_TOO_LONG');
  const reason = await json(await post(w.as('boss'), '/api/admin/orders/ORD-L16/serials/override', {
    order_item_id: 'l1', unit_index: 1, code: SN, kind: 'outside_window', reason: 'r'.repeat(501), op_id: op(),
  }));
  assert.equal(reason.code, 'OVERRIDE_REASON_REQUIRED');
  const ams = await json(await scan(w, 'adm', 'ORD-L16', 'l1', 1, SN, { part: 'ams' }));
  assert.equal(ams.code, 'SERIAL_NOT_REQUIRED', 'one serial per Combo today (owner default) — no AMS part that could never activate');
  const noOp = await post(w.as('adm'), '/api/admin/orders/ORD-L16/serials/scan', { order_item_id: 'l1', unit_index: 1, code: SN, source: 'camera' });
  assert.equal(noOp.status, 400);
  const badUnit = await scan(w, 'adm', 'ORD-L16', 'l1', 0, SN);
  assert.equal(badUnit.status, 400);
  const outOfQty = await json(await scan(w, 'adm', 'ORD-L16', 'l1', 2, SN));
  assert.equal(outOfQty.code, 'SERIAL_NOT_REQUIRED', 'a unit the line does not have');
  const notInOrder = await json(await scan(w, 'adm', 'ORD-L16', 'nope', 1, SN));
  assert.equal(notInOrder.code, 'ITEM_NOT_IN_ORDER');
  for (const o of ['ORD-NOPE', 'ORD%24X']) {
    const missing = await scan(w, 'adm', o, 'l1', 1, SN);
    assert.equal(missing.status, 404, o);
    assert.equal((await json(missing)).code, 'ORDER_NOT_FOUND', o);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory'), 0);
});
