/**
 * THE COURIER HANDOVER SETTING THROUGH THE REAL ROUTES (DECISIONS row 324):
 * «إدارة التوصيل» writes it with PUT /api/admin/settings/deliveryHandover,
 * which refuses junk in three languages and stores only the canonical form;
 * the same page reads it back from GET /api/admin/delivery-policy; and the
 * checkout reads it, signed out, from GET /api/settings/public — where a row
 * written any other way is clamped on the way out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, put, row, stubApp } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';
import { miscRoutes } from '../worker/routes/misc';
import { DEFAULT_DELIVERY_HANDOVER, handoverAdminView } from '../worker/lib/deliveryEta';

function world() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users(id,name,email,password_hash,role,admin_scope) VALUES('boss','Boss','boss@x.co','h','admin',NULL);
    INSERT INTO users(id,name,email,password_hash,role,admin_scope) VALUES('helper','Helper','helper@x.co','h','admin','assistant');
    INSERT INTO users(id,name,email,password_hash,role) VALUES('buyer','Sara','buyer@x.co','h','customer');
  `);
  const db = asD1(raw);
  const admin = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null }, (a) => a.route('/api/admin', adminRoutes));
  const assistant = stubApp(db, { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' }, (a) => a.route('/api/admin', adminRoutes));
  const customer = stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/admin', adminRoutes));
  const visitor = stubApp(db, null, (a) => a.route('/api', miscRoutes));
  const stored = () => row<{ value: string }>(raw, "SELECT value FROM admin_settings WHERE key = 'deliveryHandover'")?.value ?? null;
  return { raw, admin, assistant, customer, visitor, stored };
}

test('junk is refused in three languages and never stored', async () => {
  const w = world();
  // A midnight or morning hour too (the review): the arrival windows are the owner's words for an evening handover.
  for (const value of [null, 'tonight', { hour: 24 }, { hour: 0 }, { hour: 9 }, { hour: '19' }, { enabled: 'yes' }, { tiers: { atlantis: 'near' } }, { tiers: { baghdad: 'mars' } }, { closed_weekdays: [0, 1, 2, 3, 4, 5, 6] }]) {
    const res = await put(w.admin, '/api/admin/settings/deliveryHandover', { value });
    assert.equal(res.status, 400, JSON.stringify(value));
    const body = await json(res);
    assert.equal(body.code, 'DELIVERY_HANDOVER_INVALID', JSON.stringify(value));
    const m = body.details?.message as { ar: string; en: string; ckb: string };
    assert.ok(m?.ar && m?.en && m?.ckb, 'the refusal carries all three languages for «إدارة التوصيل» to show');
    assert.equal(w.stored(), null, 'nothing was written');
  }
  w.raw.close();
});

test('a good save is stored canonical and audited; the page and the public settings read it back', async () => {
  const w = world();
  // Before any save: the shipped defaults, on both doors.
  const before = await json(await get(w.admin, '/api/admin/delivery-policy'));
  assert.deepEqual(before.handover, DEFAULT_DELIVERY_HANDOVER);
  // The page's table and words come with it (the checkout is the module's only browser importer).
  assert.deepEqual(before.handover_view, JSON.parse(JSON.stringify(handoverAdminView())));
  assert.equal(before.handover_view.words.ckb.hours.find((x: { hour: number }) => x.hour === 19)?.label, '٧ی ئێوارە');
  const shipped = await json(await get(w.visitor, '/api/settings/public'));
  assert.deepEqual(shipped.settings.deliveryHandover, DEFAULT_DELIVERY_HANDOVER, 'public, before any order exists');

  const res = await put(w.admin, '/api/admin/settings/deliveryHandover', {
    value: { enabled: true, hour: 18, tiers: { baghdad: 'near', muthanna: 'near' }, closed_weekdays: [5], note: 'dropped' },
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const canonical = { enabled: true, hour: 18, tiers: { muthanna: 'near' }, closed_weekdays: [5] };
  assert.deepEqual(JSON.parse(w.stored()!), canonical, 'the override equal to the table and the stray key are gone');
  const audit = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'settings.update' AND target = 'deliveryHandover'");
  assert.ok(audit && audit.detail.includes('muthanna'), 'the audit keeps the value as saved');

  assert.deepEqual((await json(await get(w.admin, '/api/admin/delivery-policy'))).handover, canonical);
  assert.deepEqual((await json(await get(w.visitor, '/api/settings/public'))).settings.deliveryHandover, canonical);
  w.raw.close();
});

test('a row written any other way is clamped on the way out', async () => {
  const w = world();
  w.raw
    .prepare("INSERT INTO admin_settings (key, value) VALUES ('deliveryHandover', ?)")
    .run(JSON.stringify({ enabled: 'maybe', hour: 31, tiers: { erbil: 'far', atlantis: 'near', basra: 'moon' }, closed_weekdays: [9, 5, 5] }));
  const out = (await json(await get(w.visitor, '/api/settings/public'))).settings.deliveryHandover;
  // Hour 31 reads as the owner's 7 pm, not the nearest end (23 before the review).
  assert.deepEqual(out, { enabled: true, hour: 19, tiers: { erbil: 'far' }, closed_weekdays: [5] });
  w.raw.close();
});

test('who may write it: any admin, as the delivery fees beside it — never a customer', async () => {
  const w = world();
  const helper = await put(w.assistant, '/api/admin/settings/deliveryHandover', { value: { enabled: false } });
  assert.equal(helper.status, 200, 'an assistant admin edits «إدارة التوصيل» as they edit its fees');
  assert.deepEqual(JSON.parse(w.stored()!), { ...DEFAULT_DELIVERY_HANDOVER, enabled: false });
  const fees = await put(w.assistant, '/api/admin/settings/deliveryPolicy', { value: (await json(await get(w.admin, '/api/admin/delivery-policy'))).policy });
  assert.equal(fees.status, 200, 'the same door as the fees');
  const buyer = await put(w.customer, '/api/admin/settings/deliveryHandover', { value: { enabled: true } });
  assert.equal(buyer.status, 403);
  assert.deepEqual(JSON.parse(w.stored()!).enabled, false, 'the customer changed nothing');
  w.raw.close();
});
