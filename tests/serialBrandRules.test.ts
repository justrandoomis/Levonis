/**
 * BRAND- AND PRODUCT-AWARE SERIAL FORMATS AT EVERY DOOR (owner decision 2,
 * 2026-10-09; migration 0180; worker/lib/serialRules.ts).
 *
 * The owner: «لا تعتمد على شكل سيريال Bambu وحده لمنع الإضافة … Bambu لها
 * قواعدها، Snapmaker لها قواعدها» — the shop sells Bambu Lab and Snapmaker (a
 * Snapmaker product is live), and Creality, Anycubic, ELEGOO too. Every door
 * that adds a serial judges it by the rule of its product (its own, its
 * brand's, else the generic rule): the preparation scan, the post-delivery
 * door, a replacement's new serial, Bulk Add's preview and commit and the
 * inventory camera. The Bambu box refusal and the model check stay hard for
 * Bambu; another brand's serial of the Bambu box shape is accepted WITH A
 * WARNING that is shown and written into the audit in the same batch. Before
 * migration 0180, today's behaviour exactly.
 *
 * Run: node --import tsx --test tests/serialBrandRules.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { all, count, dbThrough, freshDb, get, json, post, put, row } from './fixtures/app';
import { world, order, op, SN, EAN, BEFORE_RULES, RULES_MIGRATION } from './fixtures/serialPrep';

const BOX = 'B07119G5811000AB';
const BOX2 = 'B07119G5811000AC';
const BOX3 = 'B07119G5811000AD';
const INV = '/api/devices/admin/serial-inventory';

/** The serial world (Bambu Lab bound) plus a Snapmaker U1, a Creality K1C, a Bambu X1C and a printer with no brand. */
function brandWorld(opts: { through?: string } = {}) {
  const w = world(opts.through ? { through: opts.through } : {});
  w.raw.exec(`
    INSERT INTO brands (id, slug, name_ar, name_en, name_ckb) VALUES
      ('brd_snap','snapmaker','سنابميكر','Snapmaker','سناپمەیکەر'), ('brd_crea','creality','كريالتي','Creality','کریالیتی');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,ops_policy,brand_id) VALUES
      ('pU1','sp-u1','Snapmaker U1','سنابميكر U1',1500000,'{}','brd_snap'),
      ('pK1C','sp-k1c','Creality K1C','كريالتي K1C',900000,'{}','brd_crea'),
      ('pX1C','sp-x1c','Bambu Lab X1C','طابعة X1C',2500000,'{}','brd_bambu'),
      ('pNB','sp-nb','Mystery Printer X9','طابعة X9',500000,'{}',NULL);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pU1','ct_print',3), ('pK1C','ct_print',4), ('pX1C','ct_print',5), ('pNB','ct_print',6);
  `);
  if (!opts.through) w.raw.exec("UPDATE serial_brand_rules SET brand_id = 'brd_snap' WHERE id = 'sbr_snapmaker'");
  return w;
}

type W = ReturnType<typeof brandWorld>;
const scan = (w: W, who: 'adm' | 'ast' | 'boss', o: string, item: string, unit: number, code: string, extra: Record<string, unknown> = {}) =>
  post(w.as(who), `/api/admin/orders/${o}/serials/scan`, { order_item_id: item, unit_index: unit, code, source: 'camera', op_id: op(), ...extra });
const linkedAudit = (w: W, serial: string) =>
  JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial.linked' AND target = ? ORDER BY id DESC LIMIT 1", serial)!.detail);

/** A delivered order with one unit per product (the post-delivery and replacement doors). */
function delivered(w: W, id: string, units: Array<{ unit: string; item: string; product: string }>) {
  w.raw.prepare(
    `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
     VALUES (?,'u2','delivered','{}','home','{}','cash',1,1400,1,0,'2026-09-01T00:00:00.000Z')`
  ).run(id);
  for (const u of units) {
    w.raw.prepare('INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES (?,?,?,?,1,1,1)').run(u.item, id, u.product, u.product);
    w.raw.prepare(
      `INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
       VALUES (?,?,?,?,'u2',1,'2026-09-01T00:00:00.000Z',12,'2026-09-01T00:00:00.000Z','2027-09-01T00:00:00.000Z')`
    ).run(u.unit, id, u.item, u.product);
  }
}

// ------------------------------------------------------------------ the preparation scan

test('preparation: a Snapmaker serial of the Bambu box shape is LINKED with a warning, audited in the same batch; on a Bambu product it is still BOX_ONLY', async () => {
  const w = brandWorld();
  order(w.raw, 'ORD-U1', [{ id: 'lu', product: 'pU1' }]);
  order(w.raw, 'ORD-A1', [{ id: 'la', product: 'pA1' }]);
  const res = await scan(w, 'ast', 'ORD-U1', 'lu', 1, BOX);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.outcome, 'created');
  assert.deepEqual(body.format, { rule_id: 'sbr_snapmaker', rule_version: 1, warnings: [{ code: 'LOOKS_LIKE_BAMBU_BOX' }] });
  assert.deepEqual(body.warnings, [], 'the stock warnings are their own list');
  assert.equal(row<{ product_id: string }>(w.raw, 'SELECT product_id FROM serial_inventory WHERE serial_norm = ?', BOX)!.product_id, 'pU1');
  assert.deepEqual(linkedAudit(w, BOX).format, { rule_id: 'sbr_snapmaker', rule_version: 1, warnings: ['LOOKS_LIKE_BAMBU_BOX'] });

  const a1 = await json(await scan(w, 'adm', 'ORD-A1', 'la', 1, BOX2));
  assert.equal(a1.code, 'SERIAL_INVALID');
  assert.equal(a1.details.problem, 'BOX_ONLY', 'Bambu Lab keeps its box-number refusal');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', BOX2), 0);
  // A real Bambu serial links with no format note.
  const ok = await json(await scan(w, 'adm', 'ORD-A1', 'la', 1, SN));
  assert.equal(ok.outcome, 'created');
  assert.deepEqual(ok.format, { rule_id: 'sbr_bambu_lab', rule_version: 1, warnings: [] });
  // A Snapmaker device whose BOX SN (of the same shape) the store already holds: that box read is that device.
  order(w.raw, 'ORD-U2', [{ id: 'lu2', product: 'pU1' }]);
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, box_sn, created_by) VALUES ('U1SERIAL00000077','U1SERIAL00000077','pU1','${BOX3}','boss')`);
  const viaBox = await json(await scan(w, 'adm', 'ORD-U2', 'lu2', 1, BOX3));
  assert.equal(viaBox.outcome, 'existing', JSON.stringify(viaBox));
  assert.equal(viaBox.slot.assignment.serial_full, 'U1SERIAL00000077', 'one box read twice is one device, never a second asset');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', BOX3), 0);
  // The order screen carries each slot's rule, so a reader knows how to read a lone box-shaped code.
  const view = await json(await get(w.as('ast'), '/api/admin/orders/ORD-U1/serials'));
  assert.equal(view.serials.slots[0].rule.box_sn_shape, 'none');
  assert.equal(view.serials.slots[0].rule.id, 'sbr_snapmaker');
  const viewA1 = await json(await get(w.as('ast'), '/api/admin/orders/ORD-A1/serials'));
  assert.equal(viewA1.serials.slots[0].rule.box_sn_shape, 'bambu');
});

test('Bambu Lab: an 18-character serial links clean, a 16 links with LENGTH_UNEXPECTED in its audit; under `enforce` it is refused and NOTHING is written', async () => {
  const w = brandWorld();
  order(w.raw, 'ORD-L', [{ id: 'l1', product: 'pA1', qty: 4 }]);
  const s18 = '03919D580607841ABC';
  assert.deepEqual((await json(await scan(w, 'adm', 'ORD-L', 'l1', 1, s18))).format.warnings, []);
  const s16 = '03919D5806078412';
  const warned = await json(await scan(w, 'adm', 'ORD-L', 'l1', 2, s16));
  assert.equal(warned.outcome, 'created');
  assert.deepEqual(warned.format.warnings, [{ code: 'LENGTH_UNEXPECTED', len: 16, expected: '15 / 18' }]);
  assert.deepEqual(linkedAudit(w, s16).format.warnings, ['LENGTH_UNEXPECTED']);

  // The owner switches Bambu Lab to «رفض».
  const rule = await json(await get(w.as('boss'), '/api/admin/serial-rules'));
  const bambu = rule.rules.find((r: { id: string }) => r.id === 'sbr_bambu_lab');
  const { id: _id, version, scope: _s, brand_id: _b, product_id: _p, active: _a, bound: _bo, product_name: _pn, product_name_ar: _pna, updated_by: _u, created_at: _c, updated_at: _ua, ...spec } = bambu;
  void [_id, _s, _b, _p, _a, _bo, _pn, _pna, _u, _c, _ua];
  const saved = await put(w.as('boss'), '/api/admin/serial-rules/sbr_bambu_lab', { ...spec, mode: 'enforce', expected_version: version });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));

  const s16b = '03919D5806078413';
  const auditBefore = count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log');
  const refused = await scan(w, 'adm', 'ORD-L', 'l1', 3, s16b);
  assert.equal(refused.status, 400);
  const rb = await json(refused);
  assert.equal(rb.code, 'SERIAL_FORMAT_MISMATCH');
  assert.equal(rb.error, 'الرقم التسلسلي لا يطابق صيغة الأرقام التي ضبطها المالك لهذه العلامة التجارية.');
  assert.equal(rb.details.rule_id, 'sbr_bambu_lab');
  assert.deepEqual(rb.details.problems, [{ code: 'LENGTH_UNEXPECTED', len: 16, expected: '15 / 18' }]);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = ?', s16b), 0, 'no asset');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM serial_assignments WHERE serial_norm = ?', s16b), 0, 'no binding');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log'), auditBefore, 'no audit row');
  // A serial that matches still links; the 16 linked BEFORE the switch is never re-refused (a replay answers it).
  assert.equal((await json(await scan(w, 'adm', 'ORD-L', 'l1', 3, SN))).outcome, 'created');
  assert.equal((await json(await scan(w, 'adm', 'ORD-L', 'l1', 2, s16))).outcome, 'already');
});

test('no brand → the generic rule; Creality is never refused for an A1-looking prefix; the X1C alias ends the model-mismatch defect', async () => {
  const w = brandWorld();
  order(w.raw, 'ORD-G', [{ id: 'ln', product: 'pNB' }, { id: 'lk', product: 'pK1C' }, { id: 'lx', product: 'pX1C' }]);
  const nb = await json(await scan(w, 'adm', 'ORD-G', 'ln', 1, BOX));
  assert.equal(nb.outcome, 'created');
  assert.deepEqual(nb.format, { rule_id: 'generic', rule_version: 1, warnings: [{ code: 'LOOKS_LIKE_BAMBU_BOX' }] });
  const k1 = await json(await scan(w, 'adm', 'ORD-G', 'lk', 1, '039ABCDEF012345'));
  assert.equal(k1.outcome, 'created', `a Creality serial starting 039 on «K1C»: ${JSON.stringify(k1)}`);
  const x1 = await json(await scan(w, 'adm', 'ORD-G', 'lx', 1, '00M00A123456789'));
  assert.equal(x1.outcome, 'created', `a real X1C on «Bambu Lab X1C»: ${JSON.stringify(x1)}`);
  // …while a family the product contradicts is still refused for Bambu.
  order(w.raw, 'ORD-G2', [{ id: 'la', product: 'pA1' }]);
  assert.equal((await json(await scan(w, 'adm', 'ORD-G2', 'la', 1, '03000A123456789'))).code, 'SERIAL_MODEL_MISMATCH');
});

test('DEPLOY-AHEAD: before 0180 every product keeps today\'s rule exactly — the box refusal and the old model check everywhere, no format in the answer or the audit', async () => {
  const w = brandWorld({ through: BEFORE_RULES });
  order(w.raw, 'ORD-D', [{ id: 'lu', product: 'pU1' }, { id: 'lx', product: 'pX1C' }, { id: 'lk', product: 'pK1C' }]);
  const u1 = await json(await scan(w, 'adm', 'ORD-D', 'lu', 1, BOX));
  assert.equal(u1.code, 'SERIAL_INVALID');
  assert.equal(u1.details.problem, 'BOX_ONLY', "today's behaviour: the box refusal for every brand");
  assert.equal((await json(await scan(w, 'adm', 'ORD-D', 'lx', 1, '00M00A123456789'))).code, 'SERIAL_MODEL_MISMATCH', 'the X1C defect waits for 0180');
  assert.equal((await json(await scan(w, 'adm', 'ORD-D', 'lk', 1, '039ABCDEF012345'))).code, 'SERIAL_MODEL_MISMATCH');
  const u1Serial = 'U1SERIAL00000001';
  const ok = await json(await scan(w, 'adm', 'ORD-D', 'lu', 1, u1Serial));
  assert.equal(ok.outcome, 'created', JSON.stringify(ok));
  assert.equal(ok.format, null);
  assert.equal('format' in linkedAudit(w, u1Serial), false, 'the audit row is exactly today\'s');
  const view = await json(await get(w.as('adm'), '/api/admin/orders/ORD-D/serials'));
  assert.equal(view.serials.slots[0].rule.id, 'legacy');
  // Bulk Add judges by today's rule too.
  const pv = await json(await post(w.as('adm'), `${INV}/preview`, { text: BOX, product_id: 'pU1' }));
  assert.equal(pv.rows[0].problem, 'SERIAL_LOOKS_LIKE_BOX');
  assert.equal(pv.format.rule.id, 'legacy');
  const sc = await json(await post(w.as('adm'), `${INV}/scan`, { serial: BOX, product_id: 'pU1' }));
  assert.equal(sc.outcome, 'invalid');
  assert.equal(sc.problem, 'SERIAL_LOOKS_LIKE_BOX');
  // The post-delivery door as well.
  delivered(w, 'ORD-DP', [{ unit: 'u_dp', item: 'ldp', product: 'pU1' }]);
  const pd = await json(await post(w.as('boss'), '/api/devices/admin/units/u_dp/serial', { serial: BOX3 }));
  assert.equal(pd.details.problem, 'BOX_ONLY');
});

// ------------------------------------------------------------------ after delivery

test('the post-delivery door and the replacement judge by the rule of the UNIT\'s product', async () => {
  const w = brandWorld();
  delivered(w, 'ORD-PD', [
    { unit: 'u_snap', item: 'ls', product: 'pU1' },
    { unit: 'u_bambu', item: 'lb', product: 'pA1' },
    { unit: 'u_snap2', item: 'ls2', product: 'pU1' },
  ]);
  const pd = await post(w.as('boss'), '/api/devices/admin/units/u_snap/serial', { serial: BOX });
  const pdb = await json(pd);
  assert.equal(pd.status, 200, JSON.stringify(pdb));
  assert.deepEqual(pdb.format, { rule_id: 'sbr_snapmaker', rule_version: 1, warnings: [{ code: 'LOOKS_LIKE_BAMBU_BOX' }] });
  assert.equal(row<{ unit_id: string }>(w.raw, 'SELECT unit_id FROM device_serials WHERE serial_norm = ?', BOX)!.unit_id, 'u_snap');
  const assignAudit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'device.serial_assign' AND target = 'u_snap'")!.detail);
  assert.deepEqual(assignAudit.format, { rule_id: 'sbr_snapmaker', rule_version: 1, warnings: ['LOOKS_LIKE_BAMBU_BOX'] });

  const bambu = await json(await post(w.as('boss'), '/api/devices/admin/units/u_bambu/serial', { serial: BOX2 }));
  assert.equal(bambu.code, 'SERIAL_INVALID');
  assert.equal(bambu.details.problem, 'BOX_ONLY');

  const rp = await post(w.as('boss'), '/api/devices/admin/units/u_snap2/replace', { reason: 'dead on arrival, swapped', new_serial: BOX3 });
  const rpb = await json(rp);
  assert.equal(rp.status, 200, JSON.stringify(rpb));
  assert.equal(rpb.format.rule_id, 'sbr_snapmaker');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM device_serials WHERE serial_norm = ?', BOX3), 1);
  const rpBambu = await json(await post(w.as('boss'), '/api/devices/admin/units/u_bambu/replace', { reason: 'dead on arrival, swapped', new_serial: 'B07119G5811000AE' }));
  assert.equal(rpBambu.details.problem, 'BOX_ONLY');
});

// ------------------------------------------------------------------ Bulk Add and the inventory camera

test('Bulk Add: the chosen product\'s rule judges the rows; no product = the generic rule; the commit audit counts the warnings', async () => {
  const w = brandWorld();
  const snap = await json(await post(w.as('adm'), `${INV}/preview`, { text: `${BOX}\nU1SERIAL00000001`, product_id: 'pU1' }));
  assert.deepEqual(snap.rows.map((r: { outcome: string }) => r.outcome), ['new', 'new']);
  assert.deepEqual(snap.rows[0].warnings, [{ code: 'LOOKS_LIKE_BAMBU_BOX' }]);
  assert.deepEqual(snap.rows[1].warnings, []);
  assert.equal(snap.format.rule.id, 'sbr_snapmaker');
  assert.equal(snap.format.warned, 1);

  const bam = await json(await post(w.as('adm'), `${INV}/preview`, { text: BOX, product_id: 'pA1' }));
  assert.equal(bam.rows[0].outcome, 'invalid');
  assert.equal(bam.rows[0].problem, 'SERIAL_LOOKS_LIKE_BOX');

  const none = await json(await post(w.as('adm'), `${INV}/preview`, { text: BOX }));
  assert.equal(none.rows[0].outcome, 'new');
  assert.equal(none.format.rule.id, 'generic');
  assert.deepEqual(none.rows[0].warnings, [{ code: 'LOOKS_LIKE_BAMBU_BOX' }]);
  // An unknown product is still refused, in today's order (the rule read never throws).
  assert.equal((await json(await post(w.as('adm'), `${INV}/preview`, { text: BOX, product_id: 'p-nope' }))).code, 'SERIAL_PRODUCT_UNKNOWN');

  const commit = await json(await post(w.as('adm'), `${INV}/commit`, { text: `${BOX}\nU1SERIAL00000001`, product_id: 'pU1' }));
  assert.equal(commit.inserted, 2);
  assert.deepEqual(commit.rows[0].warnings, [{ code: 'LOOKS_LIKE_BAMBU_BOX' }]);
  const added = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial_inventory.add' ORDER BY id DESC LIMIT 1")!.detail);
  assert.deepEqual(added.format, { rule_id: 'sbr_snapmaker', rule_version: 1, warned: 1, by_code: { LOOKS_LIKE_BAMBU_BOX: 1 } });
});

test('the inventory camera (/scan): the chosen product — or the label\'s own — decides how a box-shaped read is judged', async () => {
  const w = brandWorld();
  const u1 = await json(await post(w.as('adm'), `${INV}/scan`, { serial: BOX, product_id: 'pU1' }));
  assert.equal(u1.outcome, 'added');
  assert.deepEqual(u1.warnings, [{ code: 'LOOKS_LIKE_BAMBU_BOX' }]);
  assert.equal(u1.rule.id, 'sbr_snapmaker');
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial_inventory.add' ORDER BY id DESC LIMIT 1")!.detail);
  assert.deepEqual(audit.format, { rule_id: 'sbr_snapmaker', rule_version: 1, warnings: ['LOOKS_LIKE_BAMBU_BOX'] });

  const a1 = await json(await post(w.as('adm'), `${INV}/scan`, { serial: BOX2, product_id: 'pA1' }));
  assert.equal(a1.outcome, 'invalid');
  assert.equal(a1.problem, 'SERIAL_LOOKS_LIKE_BOX');

  // No product chosen: the label's EAN names a Bambu product the store learned → the Bambu rule.
  w.raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, ean, created_by) VALUES ('${SN}','${SN}','pA1','${EAN}','boss')`);
  const byEan = await json(await post(w.as('adm'), `${INV}/scan`, { serial: BOX3, ean: EAN }));
  assert.equal(byEan.outcome, 'invalid');
  assert.equal(byEan.problem, 'SERIAL_LOOKS_LIKE_BOX', 'the label is a Bambu box: its BOX SN is not the device');
  // No product and an unknown label: the generic rule (registered without a product, with the warning).
  const unknown = await json(await post(w.as('adm'), `${INV}/scan`, { serial: 'B12345X6789ZZ' }));
  assert.equal(unknown.outcome, 'added');
  assert.equal(unknown.needs_product, true);
  assert.deepEqual(unknown.warnings, [{ code: 'LOOKS_LIKE_BAMBU_BOX' }]);

  // `enforce` on the chosen product: the row is refused with its reasons, nothing stored.
  w.raw.exec("UPDATE serial_brand_rules SET mode = 'enforce', lengths = '[20]' WHERE id = 'sbr_snapmaker'");
  const strict = await json(await post(w.as('adm'), `${INV}/scan`, { serial: 'U1SHORT0001', product_id: 'pU1' }));
  assert.equal(strict.outcome, 'invalid');
  assert.equal(strict.problem, 'SERIAL_FORMAT_MISMATCH');
  assert.deepEqual(strict.warnings, [{ code: 'LENGTH_UNEXPECTED', len: 11, expected: '20' }]);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_inventory WHERE serial_norm = 'U1SHORT0001'"), 0);
});

// ------------------------------------------------------------------ the migration

test('the migration: the seeds bind to the brands that exist when it runs (exact slug first), stay unbound otherwise, re-run without a duplicate; one ACTIVE rule per brand and per product', () => {
  // Every migration before this one — the live database's state when it lands.
  const raw = dbThrough(BEFORE_RULES);
  raw.exec(`
    INSERT INTO brands (id, slug, name_ar, name_en, active, created_at) VALUES
      ('b_name','bambu-lab-iq','بامبو','Bambu Lab',1,'2026-01-02T00:00:00.000Z'),
      ('b_slug','bambu-lab','بامبو لاب','Bambu Lab Official',1,'2026-01-01T00:00:00.000Z'),
      ('s_old','snap-old','سناب','Snapmaker',0,'2026-01-03T00:00:00.000Z'),
      ('s_new','snap-iq','سناب','Snapmaker ',1,'2026-01-01T00:00:00.000Z');
  `);
  const sql = readFileSync(join(ROOT, 'migrations', RULES_MIGRATION), 'utf8');
  raw.exec(sql);
  const bound = () => Object.fromEntries(all<{ id: string; brand_id: string | null }>(raw, 'SELECT id, brand_id FROM serial_brand_rules ORDER BY id').map((r) => [r.id, r.brand_id]));
  assert.deepEqual(bound(), { sbr_bambu_lab: 'b_slug', sbr_snapmaker: 's_new' }, 'the exact slug first; then an active brand by its English name');
  raw.exec(sql);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM serial_brand_rules'), 2, 're-run: INSERT OR IGNORE, no duplicate');
  assert.deepEqual(bound(), { sbr_bambu_lab: 'b_slug', sbr_snapmaker: 's_new' });
  // At most ONE active rule per brand and per product.
  assert.throws(() => raw.exec("INSERT INTO serial_brand_rules (id, scope, brand_id) VALUES ('x2','brand','b_slug')"), /UNIQUE/);
  raw.exec("INSERT INTO serial_brand_rules (id, scope, brand_id, active) VALUES ('x3','brand','b_slug',0)");
  raw.exec("INSERT INTO serial_brand_rules (id, scope, product_id) VALUES ('p1','product','prod1')");
  assert.throws(() => raw.exec("INSERT INTO serial_brand_rules (id, scope, product_id) VALUES ('p2','product','prod1')"), /UNIQUE/);
  assert.throws(() => raw.exec("INSERT INTO serial_brand_rules (id, scope) VALUES ('p3','product')"), /CHECK/, 'a product rule names its product');
  assert.throws(() => raw.exec("INSERT INTO serial_brand_rules (id, scope, brand_id, prefixes) VALUES ('p4','brand','zz','not json')"), /CHECK/);
  assert.throws(() => raw.exec("INSERT INTO serial_brand_rules (id, scope, brand_id, min_len) VALUES ('p5','brand','zz',5)"), /CHECK/);

  // A database with no such brand: both seeds land UNBOUND, judging nothing until the owner binds them.
  const fresh = freshDb();
  assert.deepEqual(all(fresh, 'SELECT id, brand_id, mode, box_sn_shape, family_check FROM serial_brand_rules ORDER BY id'), [
    { id: 'sbr_bambu_lab', brand_id: null, mode: 'warn', box_sn_shape: 'bambu', family_check: 1 },
    { id: 'sbr_snapmaker', brand_id: null, mode: 'warn', box_sn_shape: 'none', family_check: 0 },
  ]);
  // Additive: the file creates one table and touches no other.
  const stripped = sql.replace(/--.*$/gm, '');
  assert.equal(/\b(ALTER|DROP|DELETE|UPDATE)\b/i.test(stripped), false, 'nothing but a new table, its indexes and its seeds');
  assert.equal((stripped.match(/INSERT OR IGNORE INTO (\w+)/g) ?? []).every((s) => s.endsWith('serial_brand_rules')), true);
  assert.equal(/END\)/.test(stripped), false, "Wrangler's splitter: `END )`, never `END)`");
});
