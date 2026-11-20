/**
 * PHASE 8 — THE WARRANTY DESK READS WHAT THE CUSTOMER BOUGHT (owner 2026-11-21, DECISIONS row 364).
 *
 * Pinned here:
 *  1. THE RECEIPT HOLE. A printer sold with NO warranty got a 12-month receipt that verified publicly as covered
 *     (the route read «0 months» as «not configured» and the screen filled the shop's default). Now: no receipt
 *     (NO_WARRANTY_BOUGHT) on issue, activate and reissue; a paper already issued that way never verifies as
 *     covered; a services unit's paper prints the device record and takes no other months or dates.
 *  2. Unit payloads carry `services` (what was sold), `care` (the window) and `cover` (what holds today) — «no
 *     warranty bought» is never «expired».
 *  3. The months form on a services unit: no extension, never below what was sold, the owner's goodwill alone —
 *     and Levo Care's window follows the device's real warranty end, never shorter than what was sold.
 *  4. The cover verdict of a claim (four situations), judged at its filing; the queue's filters and search.
 *  5. Rejecting for misuse on a Care holder needs an explicit confirmation; nothing is voided in silence.
 *  6. The quote keeps the desk's «misuse» tick; a replacement keeps a zero-month warranty at zero; a Care-only
 *     device is replaced only on an explicit confirmation.
 *
 * Run: node --import tsx --test tests/warrantyDeskPhase8.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, post, patch, json, row, all, type StubUser } from './fixtures/app';
import { deviceRoutes } from '../worker/routes/devices';
import { warrantyAdminRoutes, warrantyPublicRoutes } from '../worker/routes/warranty';
import { careEntitlements, careWindow } from '../worker/lib/careClaims';
import { addMonths } from '../worker/lib/membershipOps';
import { ownUnitWindow, soldServicesOf, unitMonthsExact, unitTotalMonths } from '../worker/lib/deviceOps';
import { coverVerdictOf, deskCover } from '../worker/lib/warrantyDesk';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { WARRANTY_FREE_RETURN_DAYS } from '../src/components/product/printerServicesStrings';
import { FREE_RETURN_DAYS } from '../src/components/adminWarranty/deskStrings';
import type { CareTerms } from '../packages/pricing/src/printerServices';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'sara@x.co' };
const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const FINANCE: StubUser = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' };

const TERMS: CareTerms = {
  eligible_parts: [{ key: 'nozzle', label: { ar: 'الفوهة', en: 'Nozzle', ckb: 'نۆزڵ' } }],
  discount_pct: 50,
  max_claims: 2,
  max_benefit_iqd: 30_000,
  labor: 'discounted',
  shipping: 'full_price',
  exclusions: [],
};

/** A frozen services snapshot as the checkout writes it (the fields the desk reads). */
function snapshot(warranty: 0 | 12 | 24, care: boolean, pkg = warranty === 0 && !care ? 'just' : 'custom'): string {
  const lines: Array<Record<string, unknown>> = [];
  if (warranty) lines.push({ service: 'warranty', choice: `w${warranty}`, fee_iqd: 25_000, policy_version: 1 });
  if (care) lines.push({ service: 'care', choice: 'c12', fee_iqd: 19_000, policy_version: 1 });
  return JSON.stringify({
    lines,
    fee_iqd: lines.reduce((s, l) => s + Number(l.fee_iqd), 0),
    package_discount_iqd: 0,
    warranty_months: warranty,
    care_months: care ? 12 : 0,
    care_total_months: care ? warranty + 12 : 0,
    revision: 3,
    selection: {
      v: 1, package: pkg, warranty: warranty === 0 ? 'none' : `w${warranty}`, care: care ? 'c12' : 'none', packaging: 'standard',
      inspection: 'none', academy: 'none', delivery: 'economy', confirmed: true, ack_no_warranty: warranty === 0,
    },
  });
}

/**
 * One delivered order, 60 days ago, four printers — each unit written exactly as the delivery hook writes it
 * (`ownUnitWindow`): uNone «Just Printer» (no warranty, no Care); uCare Care alone; u12 a 12-month warranty with
 * Care; uOld a printer sold before the services existed (12-month base, no snapshot).
 */
function seed(deliveredDaysAgo = 60): { raw: DatabaseSync; delivered: string } {
  const raw = freshDb();
  const delivered = iso(Date.now() - deliveredDaysAgo * DAY);
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale,admin_scope) VALUES
      ('buyer','Sara','sara@x.co','sara','h','customer','2026-01-01T00:00:00.000Z','ar',NULL),
      ('boss','Owner','boss@x.co','boss','h','admin','2026-01-01T00:00:00.000Z','ar',NULL),
      ('staff','Staff','staff@x.co','staff','h','admin','2026-01-01T00:00:00.000Z','ar','full');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at)
     VALUES ('ORD-1','buyer','delivered','{"name":"Sara","phone":"0770"}','standard','{}','cash',3600000,0,1400,3600000,0,'${delivered}');
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES
      ('oiNone','ORD-1','p1','Bambu A1',1,855000,855000), ('oiCare','ORD-1','p1','Bambu A1',1,874000,874000),
      ('oi12','ORD-1','p1','Bambu A1',1,943000,943000), ('oiOld','ORD-1','p1','Bambu A1',1,899000,899000);
  `);
  const lines: Array<[string, string, string | null]> = [
    ['uNone', 'oiNone', snapshot(0, false)],
    ['uCare', 'oiCare', snapshot(0, true)],
    ['u12', 'oi12', snapshot(12, true)],
    ['uOld', 'oiOld', null],
  ];
  for (const [unitId, itemId, snap] of lines) {
    if (snap) raw.prepare('UPDATE order_items SET services_snapshot = ? WHERE id = ?').run(snap, itemId);
    const { cov, policyVersion } = ownUnitWindow(12, null, delivered, snap);
    raw.prepare(
      `INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at,
          warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version)
       VALUES (?, 'ORD-1', ?, 'p1', 'buyer', 1, ?, ?, ?, ?, ?, ?)`
    ).run(unitId, itemId, delivered, cov.base_months, cov.ext_months, delivered, cov.end_at, policyVersion);
    raw.prepare("INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES (?, ?, ?, 'boss')").run(`SN${unitId.toUpperCase()}01`, `SN${unitId.toUpperCase()}01`, unitId);
    raw.prepare('INSERT INTO device_registrations (unit_id, user_id) VALUES (?, ?)').run(unitId, 'buyer');
  }
  raw.prepare('INSERT INTO printer_care_policies (policy_version, terms, published_at, published_by) VALUES (1, ?, ?, ?)').run(JSON.stringify(TERMS), iso(Date.now()), 'boss');
  return { raw, delivered };
}

const dev = (raw: DatabaseSync, who: StubUser) => stubApp(asD1(raw), who, (a) => a.route('/api/devices', deviceRoutes));
const war = (raw: DatabaseSync, who: StubUser) => stubApp(asD1(raw), who, (a) => a.route('/api/admin/warranties', warrantyAdminRoutes));
const pub = (raw: DatabaseSync) => stubApp(asD1(raw), null, (a) => a.route('/api/warranty', warrantyPublicRoutes));

async function file(raw: DatabaseSync, unit: string, kind?: 'care') {
  const res = await json(await post(dev(raw, BUYER), `/api/devices/units/${unit}/claims`, {
    subject: 'Nozzle clogs', description: 'The nozzle clogs after every second print.', idempotencyKey: `k-${unit}-${Math.random().toString(36).slice(2, 9)}`,
    ...(kind ? { kind } : {}),
  }));
  assert.equal(res.success, true, JSON.stringify(res));
  return res.id as string;
}

// ------------------------------------------------------------------ 1. the receipt hole

test('the hole, as it was: zero months read as «not configured» and the default months filled in', () => {
  const { cov, policyVersion } = ownUnitWindow(12, null, '2026-09-01T00:00:00.000Z', snapshot(0, false));
  const unit = { warranty_base_months: cov.base_months, warranty_ext_months: cov.ext_months, policy_version: policyVersion };
  // What the receipt route used: null → `?? cfg.default_months` (12).
  assert.equal(unitTotalMonths(unit), null);
  // What it uses now: the zero the customer bought.
  assert.equal(unitMonthsExact(unit), 0);
  assert.equal(unitMonthsExact({ warranty_base_months: 12, warranty_ext_months: 0, policy_version: '{"v":2,"total":12}' }), 12);
  // «Not configured» stays null (a serialized product with no duration) — it is not a zero.
  assert.equal(unitMonthsExact({ warranty_base_months: null, warranty_ext_months: 0, policy_version: '{"v":1,"total":null}' }), null);
  // A row whose policy_version predates the recorded zero: base 0 and a window that ends where it starts.
  assert.equal(unitMonthsExact({ warranty_base_months: 0, warranty_ext_months: 0, policy_version: '{}', warranty_start_at: '2026-09-01T00:00:00.000Z', warranty_end_at: '2026-09-01T00:00:00.000Z' }), 0);
});

test('no warranty receipt for a printer bought with no warranty — whatever months the page sends', async () => {
  const { raw } = seed();
  for (const body of [{ unit_id: 'uNone', months: 12 }, { unit_id: 'uNone' }, { unit_id: 'uNone', months: 12, activate: false }, { unit_id: 'uCare', months: 12 }]) {
    const res = await post(war(raw, OWNER), '/api/admin/warranties', body);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal((await json(res)).code, 'NO_WARRANTY_BOUGHT');
  }
  assert.equal((row(raw, 'SELECT COUNT(*) AS n FROM warranty_receipts') as { n: number }).n, 0);
});

test('a services unit’s paper prints the device record: its own months, no other months, start or end', async () => {
  const { raw, delivered } = seed();
  for (const body of [{ months: 24 }, { warranty_start_at: '2026-01-01' }, { warranty_end_at: '2030-01-01' }]) {
    const res = await post(war(raw, OWNER), '/api/admin/warranties', { unit_id: 'u12', ...body });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'RECEIPT_FOLLOWS_DEVICE');
  }
  const ok = await json(await post(war(raw, FINANCE), '/api/admin/warranties', { unit_id: 'u12', months: 12 }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(ok.receipt.warranty_months, 12);
  assert.equal(ok.receipt.warranty_start_at, delivered);
  assert.equal(ok.receipt.warranty_end_at, addMonths(delivered, 12));
  // A printer sold before the services keeps the rules it had: the months field is free.
  const old = await json(await post(war(raw, FINANCE), '/api/admin/warranties', { unit_id: 'uOld', months: 18 }));
  assert.equal(old.receipt.warranty_months, 18);
});

test('a paper already issued for a no-warranty printer: not valid on the public page, flagged on the order, never activated or reissued', async () => {
  const { raw, delivered } = seed();
  // The row the old code wrote: live, 12 months from delivery.
  const insert = (id: string, no: string, status: string, unit: string) =>
    raw.prepare(
      `INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id, serial_norm, serial_raw, status,
          customer_name, customer_phone, customer_address, customer_email, product_description, product_model, purchase_date, order_receipt_no,
          warranty_type, warranty_type_en, warranty_months, coverage_text, coverage_text_en, terms_json, retailer_json,
          warranty_start_at, warranty_end_at, issued_by, issued_at)
       VALUES (?, ?, ?, 'ORD-1', ?, 'p1', 'buyer', ?, ?, ?, 'Sara', '0770', '', '', 'Bambu A1', '', ?, 'ORD-1', 'ضمان', 'Warranty', 12, '', '', '[]', '{}', ?, ?, 'staff', ?)`
    ).run(id, no, unit, unit === 'uNone' ? 'oiNone' : 'oi12', `SN${unit.toUpperCase()}01`, `SN${unit.toUpperCase()}01`, status, delivered, delivered, addMonths(delivered, 12), delivered);
  insert('wrBad', 'WR-2026-1101-001', 'active', 'uNone');
  insert('wrGood', 'WR-2026-1101-002', 'active', 'u12');

  const bad = await json(await get(pub(raw), '/api/warranty/verify/WR-2026-1101-001'));
  assert.equal(bad.found, true);
  assert.equal(bad.warranty.status, 'void');
  assert.equal(bad.warranty.note, 'void');
  assert.equal(bad.warranty.days_remaining, null);
  assert.equal(bad.warranty.no_warranty, true);
  // …by the serial too.
  assert.equal((await json(await get(pub(raw), '/api/warranty/verify/SNUNONE01'))).warranty.status, 'void');
  // A real warranty verifies as before.
  const good = await json(await get(pub(raw), '/api/warranty/verify/WR-2026-1101-002'));
  assert.equal(good.warranty.status, 'active');
  assert.equal(good.warranty.no_warranty, undefined);

  // The order screen is told which paper is wrong.
  const order = await json(await get(war(raw, FINANCE), '/api/admin/warranties/orders/ORD-1'));
  const byId = new Map<string, Record<string, any>>(order.units.map((u: Record<string, any>) => [u.id, u]));
  assert.equal(byId.get('uNone')!.receipt.no_warranty, true);
  assert.equal(byId.get('u12')!.receipt.no_warranty, false);

  // Reissue would put a new live number on it; a draft would become live.
  const re = await post(war(raw, OWNER), '/api/admin/warranties/wrBad/reissue', { reason: 'lost paper' });
  assert.equal((await json(re)).code, 'NO_WARRANTY_BOUGHT');
  raw.prepare("UPDATE warranty_receipts SET status = 'void' WHERE id = 'wrBad'").run();
  insert('wrDraft', 'WR-2026-1101-003', 'draft', 'uNone');
  const act = await post(war(raw, OWNER), '/api/admin/warranties/wrDraft/activate', {});
  assert.equal((await json(act)).code, 'NO_WARRANTY_BOUGHT');
  // The lead's audit query (phase8 report) finds exactly the wrong papers.
  const found = all(raw, `
    SELECT w.receipt_no FROM warranty_receipts w
      JOIN order_item_units u ON u.id = w.unit_id
      JOIN order_items oi ON oi.id = u.order_item_id
     WHERE oi.services_snapshot IS NOT NULL
       AND json_extract(oi.services_snapshot, '$.warranty_months') = 0
       AND COALESCE(json_extract(u.policy_version, '$.total'), 0) = 0
     ORDER BY w.receipt_no`) as Array<{ receipt_no: string }>;
  assert.deepEqual(found.map((r) => r.receipt_no), ['WR-2026-1101-001', 'WR-2026-1101-003']);
});

// ------------------------------------------------------------------ 2. what the screens are told

test('unit payloads say what was bought and what holds today — «no warranty bought» is never «expired»', async () => {
  const { raw, delivered } = seed();
  const res = await json(await get(dev(raw, FINANCE), '/api/devices/admin/orders/ORD-1/units'));
  const u = new Map<string, Record<string, any>>(res.units.map((x: Record<string, any>) => [x.unit_id, x]));

  const none = u.get('uNone')!;
  assert.deepEqual(none.services, {
    package: 'just', warranty_months: 0, care: false, care_total_months: 0, inspection: 'none', inspection_done_at: null,
    free_return: false, ack_no_warranty: true, order_id: 'ORD-1',
  });
  assert.equal(none.care, null);
  assert.equal(none.cover.now, 'none');
  assert.equal(none.cover.warranty, 'none');
  assert.equal(none.cover.warranty_end_at, null);
  assert.equal(none.cover.months, 0);

  const careOnly = u.get('uCare')!;
  assert.equal(careOnly.services.care, true);
  assert.equal(careOnly.cover.now, 'care');
  assert.equal(careOnly.cover.warranty, 'none');
  assert.equal(careOnly.cover.until, addMonths(delivered, 12));
  assert.equal(careOnly.care.state, 'active');
  assert.equal(careOnly.care.care_only_from, delivered);
  assert.deepEqual([careOnly.care.claims_left, careOnly.care.benefit_left_iqd, careOnly.care.discount_pct], [2, 30_000, 50]);

  const both = u.get('u12')!;
  assert.equal(both.services.warranty_months, 12);
  assert.equal(both.services.free_return, true);
  assert.equal(both.cover.now, 'warranty');
  assert.equal(both.cover.until, addMonths(delivered, 12));
  assert.equal(both.cover.care_misuse, true);
  assert.equal(both.care.end_at, addMonths(delivered, 24));
  assert.equal(both.care.care_only_from, addMonths(delivered, 12));

  // A printer sold before the services: nothing invented.
  const old = u.get('uOld')!;
  assert.equal(old.services, null);
  assert.equal(old.care, null);
  assert.equal(old.cover.now, 'warranty');
  assert.equal(old.cover.sold_months, null);

  // The order screen's section carries the same facts, and the months as a number (0, not null).
  const order = await json(await get(war(raw, FINANCE), '/api/admin/warranties/orders/ORD-1'));
  const o = new Map<string, Record<string, any>>(order.units.map((x: Record<string, any>) => [x.id, x]));
  assert.equal(o.get('uNone')!.months, 0);
  assert.equal(o.get('uNone')!.cover.warranty, 'none');
  assert.equal(o.get('u12')!.months, 12);
  assert.equal(o.get('u12')!.services.warranty_months, 12);

  // The inspection, when bought: pending until the task is done.
  raw.prepare('UPDATE order_items SET services_snapshot = ? WHERE id = ?').run(
    JSON.stringify({ ...JSON.parse(snapshot(12, true)), lines: [...JSON.parse(snapshot(12, true)).lines, { service: 'inspection', choice: 'full', fee_iqd: 9000 }] }), 'oi12');
  raw.prepare(
    "INSERT INTO order_service_tasks (id, order_id, order_item_id, kind, choice, qty, note, status, created_at) VALUES ('t1','ORD-1','oi12','inspection','full',1,'افحص', 'open', ?)"
  ).run(delivered);
  const again = await json(await get(dev(raw, FINANCE), '/api/devices/admin/units?serial=SNU1201'));
  assert.equal(again.units[0].services.inspection, 'pending');
});

test('the sold services are read from the frozen snapshot alone', () => {
  assert.equal(soldServicesOf(null), null);
  assert.equal(soldServicesOf('{"warranty_months":36}'), null);
  assert.deepEqual(soldServicesOf(snapshot(24, true, 'complete')), {
    package: 'complete', warranty_months: 24, care_months: 12, care_total_months: 36, inspection: false, ack_no_warranty: false, revision: 3,
  });
  // A line frozen before the snapshot carried care_total_months is computed from its own two figures.
  assert.equal(soldServicesOf('{"warranty_months":12,"care_months":12}')!.care_total_months, 24);
});

// ------------------------------------------------------------------ 3. the months form and the Care window

test('the Care window is never shorter than what was sold, and follows the real warranty end', () => {
  const d = '2026-01-10T08:00:00.000Z';
  const cases: Array<[number, number]> = [[0, 12], [12, 24], [24, 36]];
  for (const [w, total] of cases) {
    const sold = careWindow(d, { warranty_months: w, total_months: total });
    assert.deepEqual(sold, { start_at: d, care_only_from: addMonths(d, w), end_at: addMonths(d, total) });
    // Every real warranty end — none recorded, earlier than sold, the same, later — keeps at least the sold window.
    for (const real of [null, d, addMonths(d, w), addMonths(d, w + 1), addMonths(d, w + 6), addMonths(d, w + 40), 'garbage']) {
      const win = careWindow(d, { warranty_months: w, total_months: total }, real);
      assert.ok(Date.parse(win.end_at!) >= Date.parse(sold.end_at!), `end w=${w} real=${real}`);
      assert.ok(Date.parse(win.care_only_from!) >= Date.parse(sold.care_only_from!), `only-from w=${w} real=${real}`);
      // Twelve months of Care after the warranty, always.
      assert.ok(Date.parse(win.end_at!) >= Date.parse(addMonths(win.care_only_from!, 12)), `12 after w=${w} real=${real}`);
      if (real && real !== 'garbage' && Date.parse(real) > Date.parse(sold.care_only_from!)) assert.equal(win.care_only_from, real);
      else assert.deepEqual(win, sold);
    }
  }
  assert.deepEqual(careWindow(null, { warranty_months: 12, total_months: 24 }), { start_at: null, care_only_from: null, end_at: null });
});

test('the months form on a services unit: no extension, never below what was sold, the owner alone', async () => {
  const { raw, delivered } = seed();
  const url = (u: string) => `/api/devices/admin/units/${u}/warranty`;
  // The two old fields are refused, never guessed at.
  for (const body of [{ base_months: 12, ext_months: 12 }, { base_months: 24 }, { total_months: 12, ext_months: 6 }]) {
    const res = await patch(dev(raw, OWNER), url('u12'), { ...body, reason: 'customer asked' });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await json(res)).code, 'SERVICES_WARRANTY_NO_EXTENSION');
  }
  // Below what was sold: never, the owner included.
  const below = await patch(dev(raw, OWNER), url('u12'), { total_months: 6, reason: 'customer asked', confirm_shorter: true });
  assert.equal((await json(below)).code, 'SERVICES_WARRANTY_BELOW_SOLD');
  // A financial admin cannot grant goodwill.
  const staff = await patch(dev(raw, FINANCE), url('uNone'), { total_months: 12, reason: 'goodwill for a loyal customer' });
  assert.equal(staff.status, 403);
  assert.equal((await json(staff)).code, 'OWNER_REQUIRED');
  // Zero stays zero when nothing is granted.
  const same = await json(await patch(dev(raw, OWNER), url('uNone'), { total_months: 0, reason: 'checked: no warranty' }));
  assert.deepEqual([same.success, same.months, same.state], [true, 0, 'none']);
  assert.equal(unitMonthsExact(row(raw, "SELECT * FROM order_item_units WHERE id = 'uNone'") as never), 0);

  // The owner's goodwill: 0 → 12 months, audited with what was sold.
  const grant = await json(await patch(dev(raw, OWNER), url('uNone'), { total_months: 12, reason: 'goodwill for a loyal customer' }));
  assert.deepEqual([grant.months, grant.sold_months, grant.goodwill, grant.warranty_end_at], [12, 0, true, addMonths(delivered, 12)]);
  const audit = row(raw, "SELECT detail FROM audit_log WHERE action = 'device.unit_warranty_months' AND target = 'uNone' ORDER BY id DESC LIMIT 1") as { detail: string };
  const detail = JSON.parse(audit.detail);
  assert.deepEqual([detail.services_unit, detail.goodwill, detail.sold_total_months, detail.old_total_months, detail.new_total_months], [true, true, 0, 0, 12]);
  // The receipt may now be issued — and prints the granted record.
  const receipt = await json(await post(war(raw, OWNER), '/api/admin/warranties', { unit_id: 'uNone' }));
  assert.equal(receipt.receipt.warranty_months, 12);
  assert.equal(receipt.receipt.warranty_end_at, addMonths(delivered, 12));
  // The unit says so on the desk.
  const unit = (await json(await get(dev(raw, OWNER), '/api/devices/admin/units?serial=SNUNONE01'))).units[0];
  assert.deepEqual([unit.cover.now, unit.cover.months, unit.cover.sold_months, unit.cover.goodwill], ['warranty', 12, 0, true]);
  // Taking the goodwill back shortens a window the customer was told about: the explicit confirmation, as before.
  const back = await patch(dev(raw, OWNER), url('uNone'), { total_months: 0, reason: 'granted by mistake' });
  assert.equal((await json(back)).code, 'CONFIRM_SHORTER_REQUIRED');
  // A printer sold before the services keeps the old form exactly.
  const legacy = await json(await patch(dev(raw, OWNER), url('uOld'), { base_months: 12, ext_months: 6, reason: 'sold with an extension' }));
  assert.deepEqual([legacy.base_months, legacy.ext_months, legacy.months], [12, 6, 18]);
});

test('after an owner’s goodwill change «care_only_from» is the device’s real warranty end — and Care never shrinks', async () => {
  const { raw, delivered } = seed();
  const d1 = asD1(raw);
  const before = (await careEntitlements(d1, ['u12', 'uCare'])).get('u12')!;
  assert.deepEqual([before.care_only_from, before.end_at], [addMonths(delivered, 12), addMonths(delivered, 24)]);
  const url = (u: string) => `/api/devices/admin/units/${u}/warranty`;

  // 12 → 18 months of warranty: Care is the only cover from month 18, and still runs 12 months after it.
  await json(await patch(dev(raw, OWNER), url('u12'), { total_months: 18, reason: 'goodwill after a slow repair' }));
  const after = (await careEntitlements(d1, ['u12'])).get('u12')!;
  assert.equal(after.care_only_from, addMonths(delivered, 18));
  assert.equal(after.end_at, addMonths(addMonths(delivered, 18), 12));
  assert.ok(Date.parse(after.end_at!) >= Date.parse(before.end_at!));
  // What was SOLD is still reported as sold.
  assert.deepEqual([after.warranty_months, after.total_months], [12, 24]);

  // Back to what was sold: exactly the sold window again, never less.
  await json(await patch(dev(raw, OWNER), url('u12'), { total_months: 12, reason: 'goodwill granted by mistake', confirm_shorter: true }));
  const restored = (await careEntitlements(d1, ['u12'])).get('u12')!;
  assert.deepEqual([restored.care_only_from, restored.end_at], [before.care_only_from, before.end_at]);

  // Care alone (no warranty) + a goodwill warranty of 24 months: Care-only from month 24, ending month 36 (sold: 12).
  await json(await patch(dev(raw, OWNER), url('uCare'), { total_months: 24, reason: 'goodwill for a loyal customer' }));
  const lone = (await careEntitlements(d1, ['uCare'])).get('uCare')!;
  assert.deepEqual([lone.care_only_from, lone.end_at], [addMonths(delivered, 24), addMonths(delivered, 36)]);
  assert.equal(lone.state, 'active');
  // A claim filed now is the warranty's unless the desk finds misuse (the no-stacking rule reads the same record).
  const id = await file(raw, 'uCare');
  const q = await post(dev(raw, FINANCE), `/api/devices/admin/claims/${id}/care-quote`, { parts: [{ key: 'nozzle', qty: 1, unit_iqd: 20_000 }] });
  assert.equal((await json(q)).code, 'CARE_NOT_WARRANTY');
});

// ------------------------------------------------------------------ 4. the claim's cover verdict

test('the four situations of a claim, judged at its filing', async () => {
  assert.equal(coverVerdictOf('active', null), 'warranty');
  assert.equal(coverVerdictOf('active', 'active'), 'warranty_care');
  assert.equal(coverVerdictOf('ended', 'active'), 'care');
  assert.equal(coverVerdictOf('none', 'active'), 'care');
  assert.equal(coverVerdictOf('none', null), 'none');
  assert.equal(coverVerdictOf('ended', 'expired'), 'none');
  assert.equal(coverVerdictOf('unknown', null), 'unknown');

  const { raw, delivered } = seed();
  const ids = { none: await file(raw, 'uNone'), care: await file(raw, 'uCare', 'care'), both: await file(raw, 'u12'), old: await file(raw, 'uOld') };
  const list = await json(await get(dev(raw, FINANCE), '/api/devices/admin/claims'));
  const c = new Map<string, Record<string, any>>(list.claims.map((x: Record<string, any>) => [x.id, x]));
  assert.deepEqual(c.get(ids.none)!.cover, { verdict: 'none', warranty: 'none', warranty_end_at: null, care: null, care_only_from: null, care_end_at: null });
  assert.equal(c.get(ids.care)!.cover.verdict, 'care');
  assert.equal(c.get(ids.care)!.cover.warranty, 'none');
  assert.equal(c.get(ids.care)!.cover.care_end_at, addMonths(delivered, 12));
  assert.equal(c.get(ids.both)!.cover.verdict, 'warranty_care');
  assert.equal(c.get(ids.both)!.cover.warranty_end_at, addMonths(delivered, 12));
  assert.equal(c.get(ids.old)!.cover.verdict, 'warranty');
  // The links a claim leads to.
  assert.equal(c.get(ids.both)!.order_id, 'ORD-1');
  assert.equal(c.get(ids.both)!.customer_name, 'Sara');

  // The verdict is the FILING's: the Care that ends later does not change a claim filed while it ran.
  raw.prepare("UPDATE order_item_units SET delivered_at = ?, warranty_start_at = ?, warranty_end_at = ? WHERE id = 'uCare'").run(
    iso(Date.now() - 800 * DAY), iso(Date.now() - 800 * DAY), iso(Date.now() - 800 * DAY));
  const later = await json(await get(dev(raw, FINANCE), '/api/devices/admin/claims'));
  assert.equal(later.claims.find((x: Record<string, any>) => x.id === ids.care).cover.verdict, 'none');

  // Filters and search run in the database, before the page.
  const of = async (qs: string) => (await json(await get(dev(raw, FINANCE), `/api/devices/admin/claims?${qs}`))).claims.map((x: Record<string, any>) => x.id).sort();
  assert.deepEqual(await of('kind=care'), [ids.care]);
  assert.deepEqual(await of('kind=warranty'), [ids.none, ids.both, ids.old].sort());
  assert.deepEqual(await of('cover=warranty_care'), [ids.both]);
  assert.deepEqual(await of('cover=none'), [ids.none, ids.care].sort());
  assert.deepEqual(await of('q=SNU1201'), [ids.both]);
  assert.deepEqual(await of('q=sara%40x.co'), Object.values(ids).sort());
  assert.deepEqual(await of('q=ORD-1&cover=warranty'), [ids.old]);
  assert.deepEqual(await of('q=nobody'), []);
  assert.equal((await get(dev(raw, FINANCE), '/api/devices/admin/claims?cover=bogus')).status, 400);
  // The counts follow the search and the kind (so each stage tab says what it would show).
  const counted = await json(await get(dev(raw, FINANCE), '/api/devices/admin/claims?kind=care'));
  assert.equal(counted.counts.all, 1);
});

test('the desk strip: open claims by kind and verdict, Care holders, inspections, part offers', async () => {
  const { raw } = seed(350);
  await file(raw, 'uCare', 'care');
  await file(raw, 'u12');
  raw.prepare(
    "INSERT INTO order_service_tasks (id, order_id, order_item_id, kind, choice, qty, note, status, created_at) VALUES ('t1','ORD-1','oi12','inspection','full',2,'افحص', 'open', ?)"
  ).run(iso(Date.now()));
  raw.prepare("UPDATE orders SET status = 'processing' WHERE id = 'ORD-1'").run();
  const res = await json(await get(dev(raw, FINANCE), '/api/devices/admin/claims'));
  assert.deepEqual(res.summary.open_claims, {
    total: 2, warranty: 1, care: 1,
    by_verdict: { warranty: 0, warranty_care: 1, care: 1, none: 0, unknown: 0 },
  });
  // uCare: Care alone, delivered 350 days ago → ends within 30 days; u12 runs another year.
  assert.deepEqual(res.summary.care, { holders: 2, ending_30d: 1 });
  assert.equal(res.summary.inspections_pending, 2);
  assert.deepEqual(res.summary.part_offers, { live: 0, used: 0, used_discount_iqd: 0 });
  // Only the first page carries it.
  const next = await json(await get(dev(raw, FINANCE), `/api/devices/admin/claims?after=${encodeURIComponent(res.next_cursor)}`));
  assert.equal(next.summary, undefined);
});

// ------------------------------------------------------------------ 5. misuse on a Care holder

test('rejecting for misuse on a Care holder is refused until confirmed; nothing is voided in silence', async () => {
  const { raw } = seed();
  const id = await file(raw, 'uCare', 'care');
  const quoted = await json(await post(dev(raw, FINANCE), `/api/devices/admin/claims/${id}/care-quote`, { parts: [{ key: 'nozzle', qty: 1, unit_iqd: 20_000 }], misuse: true }));
  assert.equal(quoted.quote.state, 'quoted');
  // 6: the desk's tick is kept and read back (staff only).
  assert.equal(quoted.quote.misuse, true);
  const mine = await json(await get(dev(raw, BUYER), `/api/devices/claims/${id}`));
  assert.equal('misuse' in mine.care.quote, false);

  const url = `/api/devices/admin/claims/${id}`;
  const refused = await patch(dev(raw, FINANCE), url, { stage: 'rejected', decision: 'misuse', reason: 'dropped on the floor' });
  assert.equal(refused.status, 409);
  const body = await json(refused);
  assert.equal(body.code, 'CLAIM_MISUSE_CARE_ACTIVE');
  assert.ok(body.details.care_end_at);
  assert.equal((row(raw, 'SELECT stage FROM warranty_claims WHERE id = ?', id) as { stage: string }).stage, 'received');
  assert.equal((row(raw, 'SELECT state FROM care_claim_benefits WHERE claim_id = ?', id) as { state: string }).state, 'quoted');

  // An ordinary rejection (not misuse) and a device without Care are as before.
  const plain = await file(raw, 'uNone');
  assert.equal((await json(await patch(dev(raw, FINANCE), `/api/devices/admin/claims/${plain}`, { stage: 'rejected', decision: 'misuse', reason: 'dropped on the floor' }))).success, true);

  // Confirmed: the move goes through and the quote is voided, as it always was — now on purpose, and audited.
  const ok = await json(await patch(dev(raw, FINANCE), url, { stage: 'rejected', decision: 'misuse', reason: 'dropped on the floor', confirm_care_void: true }));
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal((row(raw, 'SELECT state FROM care_claim_benefits WHERE claim_id = ?', id) as { state: string }).state, 'void');
  const audit = row(raw, "SELECT detail FROM audit_log WHERE action = 'warranty.claim_stage' AND target = ? ORDER BY id DESC LIMIT 1", id) as { detail: string };
  assert.equal(JSON.parse(audit.detail).care_void_confirmed, true);
});

// ------------------------------------------------------------------ 6. replacement

test('a replacement keeps a zero-month warranty at zero, and a Care-only device needs an explicit yes', async () => {
  const { raw } = seed();
  const none = await json(await post(dev(raw, OWNER), '/api/devices/admin/units/uNone/replace', { reason: 'dead on arrival, owner decision' }));
  assert.equal(none.success, true, JSON.stringify(none));
  const repl = row(raw, 'SELECT * FROM order_item_units WHERE id = ?', none.new_unit_id) as Record<string, unknown>;
  assert.equal(JSON.parse(String(repl.policy_version)).total, 0);
  assert.equal(unitMonthsExact(repl as never), 0);
  // …so the replacement cannot be handed a receipt either.
  raw.prepare("INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES (?, ?, ?, 'boss')").run('SNREPL0001', 'SNREPL0001', none.new_unit_id);
  assert.equal((await json(await post(war(raw, OWNER), '/api/admin/warranties', { unit_id: none.new_unit_id, months: 12 }))).code, 'NO_WARRANTY_BOUGHT');

  // Care alone holds uCare: Levo Care is a discount on parts, not a free replacement.
  const refused = await post(dev(raw, OWNER), '/api/devices/admin/units/uCare/replace', { reason: 'customer insists on a new one' });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'REPLACE_CARE_ONLY');
  const ok = await json(await post(dev(raw, OWNER), '/api/devices/admin/units/uCare/replace', { reason: 'customer insists on a new one', confirm_care_only: true }));
  assert.equal(ok.success, true);
  // Under warranty (with Care beside it): no extra question.
  assert.equal((await json(await post(dev(raw, OWNER), '/api/devices/admin/units/u12/replace', { reason: 'board failed twice in a month' }))).success, true);
});

// ------------------------------------------------------------------ the pure cover, the words, the number

test('the cover of a unit today, from its own record', () => {
  const d = iso(Date.now() - 400 * DAY);
  const unit = (months: number, end: string) => ({
    id: 'u', order_item_id: 'oi', delivered_at: d, warranty_base_months: months, warranty_ext_months: 0,
    warranty_start_at: d, warranty_end_at: end, policy_version: JSON.stringify({ v: 2, total: months }),
  });
  const sold12 = soldServicesOf(snapshot(12, false))!;
  // A 12-month warranty that ran out: «ended», with its date — a warranty really was bought.
  const ended = deskCover(unit(12, addMonths(d, 12)), sold12, null);
  assert.deepEqual([ended.now, ended.warranty, ended.warranty_end_at], ['none', 'ended', addMonths(d, 12)]);
  // No warranty bought: «none», no end date to print in red.
  const none = deskCover(unit(0, d), soldServicesOf(snapshot(0, false)), null);
  assert.deepEqual([none.now, none.warranty, none.warranty_end_at, none.goodwill], ['none', 'none', null, false]);
});

test('every new refusal has its ar / en / ckb words, and the free-return number is the storefront’s', () => {
  for (const code of ['NO_WARRANTY_BOUGHT', 'RECEIPT_FOLLOWS_DEVICE', 'SERVICES_WARRANTY_NO_EXTENSION', 'SERVICES_WARRANTY_BELOW_SOLD',
    'CLAIM_MISUSE_CARE_ACTIVE', 'REPLACE_CARE_ONLY', 'CARRIED_END', 'CONFIRM_SHORTER_REQUIRED']) {
    const t = REFUSAL_STRINGS[code];
    assert.ok(t && t.ar && t.en && t.ckb, code);
    assert.notEqual(t.ckb, t.ar, code);
  }
  assert.equal(FREE_RETURN_DAYS, WARRANTY_FREE_RETURN_DAYS);
});

// ------------------------------------------------------------------ review round (2026-11-21)

test('a paper already issued for a no-warranty printer is DRAWN void — the desk’s view and the holder’s own copy', async () => {
  const { raw, delivered } = seed();
  raw.prepare(
    `INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id, serial_norm, serial_raw, status,
        customer_name, customer_phone, customer_address, customer_email, product_description, product_model, purchase_date, order_receipt_no,
        warranty_type, warranty_type_en, warranty_months, coverage_text, coverage_text_en, terms_json, retailer_json,
        warranty_start_at, warranty_end_at, issued_by, issued_at)
     VALUES ('wrBad', 'WR-2026-1101-001', 'uNone', 'ORD-1', 'oiNone', 'p1', 'buyer', 'SNUNONE01', 'SNUNONE01', 'active', 'Sara', '0770', '', '',
        'Bambu A1', '', ?, 'ORD-1', 'ضمان', 'Warranty', 12, '', '', '[]', '{}', ?, ?, 'staff', ?)`
  ).run(delivered, delivered, addMonths(delivered, 12), delivered);
  const holder = stubApp(asD1(raw), BUYER, (a) => a.route('/api/warranty', warrantyPublicRoutes));
  const cases: Array<[ReturnType<typeof war>, string]> = [
    [war(raw, FINANCE), '/api/admin/warranties/wrBad/document'],
    [war(raw, FINANCE), '/api/admin/warranties/wrBad/document?lang=en'],
    [holder, '/api/warranty/receipts/WR-2026-1101-001/document'],
  ];
  for (const [who, url] of cases) {
    const res = await get(who, url);
    assert.equal(res.status, 200, url);
    const html = await res.text();
    assert.match(html, /class="banner bad"/, url);
    assert.match(html, url.includes('lang=en') ? /No warranty was bought/ : /لم يُشترَ ضمان/, url);
    // No window is printed: the «12 months» the paper claimed is gone.
    assert.doesNotMatch(html, url.includes('lang=en') ? /12 months/ : /12 شهر/, url);
  }
  // A real warranty's paper is drawn as before: no banner.
  const good = await json(await post(war(raw, FINANCE), '/api/admin/warranties', { unit_id: 'u12' }));
  const html = await (await get(war(raw, FINANCE), `/api/admin/warranties/${good.receipt.id}/document`)).text();
  assert.doesNotMatch(html, /class="banner bad"/);
});

test('ANY move into «rejected» that would take Levo Care back needs the explicit yes — a page that sends no decision too', async () => {
  const { raw } = seed();
  // A Care claim with a live quote, rejected by an older page: no decision, no flag.
  const id = await file(raw, 'uCare', 'care');
  await json(await post(dev(raw, FINANCE), `/api/devices/admin/claims/${id}/care-quote`, { parts: [{ key: 'nozzle', qty: 1, unit_iqd: 20_000 }] }));
  const url = `/api/devices/admin/claims/${id}`;
  for (const body of [{ stage: 'rejected', reason: 'not our fault' }, { stage: 'rejected', decision: 'reject', reason: 'not our fault' }]) {
    const res = await patch(dev(raw, FINANCE), url, body);
    assert.equal(res.status, 409, JSON.stringify(body));
    const out = await json(res);
    assert.deepEqual([out.code, out.details.would_void], ['CLAIM_MISUSE_CARE_ACTIVE', true]);
  }
  assert.equal((row(raw, 'SELECT state FROM care_claim_benefits WHERE claim_id = ?', id) as { state: string }).state, 'quoted');
  assert.equal((row(raw, 'SELECT stage FROM warranty_claims WHERE id = ?', id) as { stage: string }).stage, 'received');

  // A warranty-kind claim on a Care holder, no quote: an ordinary rejection passes…
  const plain = await file(raw, 'u12');
  const purl = `/api/devices/admin/claims/${plain}`;
  assert.equal((await json(await patch(dev(raw, FINANCE), purl, { stage: 'rejected', reason: 'no fault found' }))).success, true);
  // …and turning its decision into misuse afterwards is answered with the same pointer, nothing changed.
  const later = await patch(dev(raw, FINANCE), purl, { stage: 'rejected', decision: 'misuse', reason: 'it was dropped' });
  assert.deepEqual([later.status, (await json(later)).code], [409, 'CLAIM_MISUSE_CARE_ACTIVE']);
  assert.equal((row(raw, 'SELECT decision FROM warranty_claims WHERE id = ?', plain) as { decision: string }).decision, 'reject');
  assert.equal((await json(await patch(dev(raw, FINANCE), purl, { stage: 'rejected', decision: 'misuse', reason: 'it was dropped', confirm_care_void: true }))).success, true);
  // A device with no Care is never asked.
  const none = await file(raw, 'uNone');
  assert.equal((await json(await patch(dev(raw, FINANCE), `/api/devices/admin/claims/${none}`, { stage: 'rejected', reason: 'no fault found' }))).success, true);
});

test('a carried (resold) window never extends Care; only the owner’s recorded goodwill does', async () => {
  const { raw, delivered } = seed();
  const d1 = asD1(raw);
  // uCare resold from a device that still carries 20 months of its first sale's warranty: the unit's end is later
  // than anything this line sold, and no goodwill is recorded.
  const carriedEnd = addMonths(delivered, 20);
  raw.prepare('UPDATE order_item_units SET warranty_base_months = 24, warranty_end_at = ?, policy_version = ? WHERE id = ?').run(
    carriedEnd, JSON.stringify({ v: 1, carried: 'original_end', resale_of: 'unit_x', base: 24, ext: 0, total: 24 }), 'uCare');
  const ent = (await careEntitlements(d1, ['uCare'])).get('uCare')!;
  assert.deepEqual([ent.care_only_from, ent.end_at], [delivered, addMonths(delivered, 12)], 'Care is exactly what was sold');
  // The warranty itself is the carried one, as before; the desk does not call it goodwill.
  const unit = (await json(await get(dev(raw, OWNER), '/api/devices/admin/units?serial=SNUCARE01'))).units[0];
  assert.deepEqual([unit.cover.now, unit.cover.until, unit.cover.goodwill, unit.cover.sold_months], ['warranty', carriedEnd, false, 0]);
  // Its months are not the goodwill door's lever.
  const res = await patch(dev(raw, OWNER), '/api/devices/admin/units/uCare/warranty', { total_months: 30, reason: 'goodwill attempt' });
  assert.equal((await json(res)).code, 'CARRIED_END');
});

test('goodwill granted on the REPLACEMENT the customer holds moves Care — never shorter than sold', async () => {
  const { raw, delivered } = seed();
  const d1 = asD1(raw);
  const repl = await json(await post(dev(raw, OWNER), '/api/devices/admin/units/u12/replace', { reason: 'board failed twice in a month' }));
  const id = repl.new_unit_id as string;
  const before = (await careEntitlements(d1, [id])).get(id)!;
  assert.deepEqual([before.care_only_from, before.end_at], [addMonths(delivered, 12), addMonths(delivered, 24)]);
  const grant = await json(await patch(dev(raw, OWNER), `/api/devices/admin/units/${id}/warranty`, { total_months: 18, reason: 'goodwill after the replacement' }));
  assert.deepEqual([grant.success, grant.months, grant.goodwill, grant.warranty_end_at], [true, 18, true, addMonths(delivered, 18)]);
  const after = (await careEntitlements(d1, [id])).get(id)!;
  assert.deepEqual([after.care_only_from, after.end_at], [addMonths(delivered, 18), addMonths(addMonths(delivered, 18), 12)]);
  // Below what was sold stays refused on a replacement too.
  const low = await patch(dev(raw, OWNER), `/api/devices/admin/units/${id}/warranty`, { total_months: 6, reason: 'too short', confirm_shorter: true });
  assert.equal((await json(low)).code, 'SERVICES_WARRANTY_BELOW_SOLD');
});
