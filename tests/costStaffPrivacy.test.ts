import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { adminRoutes } from '../worker/routes/admin';
import { toCsv } from '../worker/lib/importCsv';
import { ADMIN_ROLES, OWNER, OWNER_UNVERIFIED, ROLES, appFor, call, leaks, seededCopy } from './fixtures/roleMatrix';
import { COST } from './fixtures/costlyProduct';
import { ctx, stubApp } from './fixtures/app';
import { SqliteD1, type SqliteStatement } from './fixtures/d1';
import { audit } from '../worker/lib/audit';

const MOUNTS = [['/api/admin/import', adminImportRoutes]] as const;

test('an audit write failure logs the event without database values', async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args));
  const db = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error(`D1_ERROR cost_iqd=${COST.product}`); } }) }) } as unknown as D1Database;
  await audit(db, 'usr_owner', 'product.save', 'p_a1', { product_cost_iqd: COST.product });
  assert.equal(logged.length, 1);
  // Error.message is not enumerable; inspect the strings the log transport sees.
  assert.deepEqual(leaks(logged.map((line) => line.map(String))), []);
  assert.match(logged.flat().map(String).join(' '), /audit write failed/);
});

test('staff settings keep public fees and remove the nested print margin', async () => {
  const raw = seededCopy();
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run('printServicePricing', JSON.stringify({ machine_iqd_per_hour: 1500, setup_fee_iqd: 3000, margin_percent: 31.25 }));
  for (const role of ADMIN_ROLES) {
    const response = await call(appFor(raw, ROLES[role], [['/api/admin', adminRoutes]]), 'GET', '/api/admin/settings');
    assert.equal(response.status, 200);
    const settings = (response.body as { settings: Record<string, unknown> }).settings;
    assert.deepEqual(settings.printServicePricing, { machine_iqd_per_hour: 1500, setup_fee_iqd: 3000 });
    assert.deepEqual(leaks(settings.printServicePricing), []);
  }
  const owner = await call(appFor(raw, OWNER, [['/api/admin', adminRoutes]]), 'GET', '/api/admin/settings');
  assert.equal((owner.body as { settings: { printServicePricing: { margin_percent: number } } }).settings.printServicePricing.margin_percent, 31.25);
  raw.close();
});

test('staff cannot overwrite the private print margin through the generic settings writer', async () => {
  const raw = seededCopy();
  const settings = { machine_iqd_per_hour: 1500, setup_fee_iqd: 3000, margin_percent: 31.25 };
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run('printServicePricing', JSON.stringify(settings));
  for (const role of ADMIN_ROLES) {
    for (const [key, value] of [
      ['printServicePricing', { margin_percent: 0 }],
      ['printAccessories', [{ id: 'magnet', cost_iqd: COST.product }]],
    ]) {
      const response = await call(appFor(raw, ROLES[role], [['/api/admin', adminRoutes]]), 'PUT', `/api/admin/settings/${key}`, { value });
      assert.equal(response.status, 403, `${role}: ${key}`);
    }
  }
  assert.deepEqual(JSON.parse((raw.prepare("SELECT value FROM admin_settings WHERE key = 'printServicePricing'").get() as { value: string }).value), settings);
  raw.close();
});

test('another admin cannot read the owner import validation messages in JSON or CSV, or its filename', async () => {
  const raw = seededCopy();
  raw.exec("INSERT INTO catalogs (id,slug,name_en,name_ar,template_family,active) VALUES ('cost_import_section','cost-import','Printers','طابعات','devices',1)");
  const owner = appFor(raw, OWNER, MOUNTS);
  const file = new FormData();
  file.set('category', 'cost_import_section');
  file.set('file', new File([toCsv([
    ['row_type', 'key', 'name', 'status', 'price_iqd', 'cost_iqd'],
    ['product', 'private-import', 'Printer', 'draft', '900000', `${COST.product}invalid`],
  ])], `supplier-${COST.product}.csv`, { type: 'text/csv' }));
  const preview = await owner.request('/api/admin/import/preview', { method: 'POST', body: file, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(preview.status, 200);
  const body = await preview.json() as { import_id: string };
  const ownerReport = await call(owner, 'GET', `/api/admin/import/${body.import_id}/report`);
  assert.equal(ownerReport.status, 200);
  assert.ok(leaks(ownerReport.body).length > 0, 'a real parser validation message carries the owner-supplied private cost');
  for (const role of ADMIN_ROLES) {
    const app = appFor(raw, ROLES[role], MOUNTS);
    for (const suffix of ['', '?format=csv']) {
      const response = await call(app, 'GET', `/api/admin/import/${body.import_id}/report${suffix}`);
      assert.equal(response.status, 403, `${role} cannot read someone else’s report`);
      assert.deepEqual(leaks(response.body), []);
    }
    const history = await call(app, 'GET', '/api/admin/import/history');
    assert.equal(history.status, 200);
    assert.deepEqual(leaks(history.body), []);
    assert.doesNotMatch(JSON.stringify(history.body), new RegExp(body.import_id));
  }
  raw.close();
});

test('an import created with cost access cannot be read or replayed after that permission is lost', async () => {
  const raw = seededCopy();
  raw.prepare(`INSERT INTO product_imports (id, actor_user_id, template_family, state, payload_hash, report, payload, source_name)
    VALUES ('private_replay', ?, 'devices', 'applied', 'test', ?, ?, 'private.csv')`).run(
      OWNER.id,
      JSON.stringify([{ key: 'p', reason: `cost_iqd: ${COST.product}` }]),
      JSON.stringify({ cost_access: true, products: [] }),
    );
  const app = appFor(raw, OWNER_UNVERIFIED, MOUNTS);
  for (const [method, path, body] of [
    ['GET', '/api/admin/import/private_replay/report', undefined],
    ['POST', '/api/admin/import/confirm', { import_id: 'private_replay' }],
  ] as const) {
    const response = await call(app, method, path, body);
    assert.equal(response.status, 403);
    assert.deepEqual(leaks(response.body), []);
  }
  raw.close();
});

test('a staff member retains their own safe import report and filename', async () => {
  const raw = seededCopy();
  const staff = ROLES.assistant!;
  const report = [{ key: 'p', reason: 'name is required', price_iqd: 900000 }];
  raw.prepare(`INSERT INTO product_imports (id, actor_user_id, template_family, state, payload_hash, report, payload, source_name)
    VALUES ('staff_report', ?, 'devices', 'applied', 'test', ?, ?, 'catalogue.csv')`).run(staff.id, JSON.stringify(report), JSON.stringify({ cost_access: false, products: [] }));
  const app = appFor(raw, staff, MOUNTS);
  const response = await call(app, 'GET', '/api/admin/import/staff_report/report');
  assert.equal(response.status, 200);
  assert.deepEqual((response.body as { rows: unknown }).rows, report);
  assert.match(JSON.stringify((await call(app, 'GET', '/api/admin/import/history')).body), /catalogue.csv/);
  raw.close();
});

test('historical reports without a provenance stamp fail closed for staff and remain readable by the owner', async () => {
  const raw = seededCopy();
  raw.prepare(`INSERT INTO product_imports (id, actor_user_id, template_family, state, payload_hash, report, payload, source_name)
    VALUES ('legacy_report', ?, 'devices', 'applied', 'test', ?, '{}', 'legacy.csv')`).run(ROLES.assistant!.id, JSON.stringify([{ reason: `cost_iqd: ${COST.product}` }]));
  const staff = appFor(raw, ROLES.assistant, MOUNTS);
  assert.equal((await call(staff, 'GET', '/api/admin/import/legacy_report/report')).status, 403);
  const history = await call(staff, 'GET', '/api/admin/import/history');
  assert.doesNotMatch(JSON.stringify(history.body), /legacy_report|legacy.csv/);
  const owner = await call(appFor(raw, OWNER, MOUNTS), 'GET', '/api/admin/import/legacy_report/report');
  assert.equal(owner.status, 200);
  assert.ok(leaks(owner.body).length > 0);
  raw.close();
});

test('an unexpected import database error never becomes a report containing cost data', async () => {
  const raw = seededCopy();
  raw.exec("INSERT INTO catalogs (id,slug,name_en,name_ar,template_family,active) VALUES ('safe_import','safe-import','Printers','طابعات','devices',1)");
  class CostErrorD1 extends SqliteD1 {
    override batch(statements: SqliteStatement[]) {
      if (statements.some((statement) => /INSERT\s+INTO\s+products\b/i.test(statement.sql))) {
        throw new Error(`D1_ERROR: product_cost_iqd bound ${COST.product}: SQLITE_ERROR`);
      }
      return super.batch(statements);
    }
  }
  const app = stubApp(new CostErrorD1(raw) as unknown as D1Database, ROLES.assistant, (a) => a.route('/api/admin/import', adminImportRoutes));
  const file = new FormData();
  file.set('category', 'safe_import');
  file.set('file', new File([toCsv([
    ['row_type', 'key', 'name', 'status', 'price_iqd', 'stock', 'category'],
    ['product', 'safe-new', 'Printer', 'draft', '900000', '2', 'safe-import'],
  ])], 'catalogue.csv', { type: 'text/csv' }));
  const preview = await app.request('/api/admin/import/preview', { method: 'POST', body: file, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json() as { import_id: string; rows: Array<{ errors: string[] }> };
  assert.deepEqual(previewBody.rows[0]?.errors, [], JSON.stringify(previewBody));
  const { import_id } = previewBody;
  const response = await call(app, 'POST', '/api/admin/import/confirm', { import_id });
  assert.equal(response.status, 200);
  assert.equal((response.body as { summary: { failed: number } }).summary.failed, 1);
  assert.deepEqual(leaks(response.body), []);
  assert.doesNotMatch(JSON.stringify(response.body), /D1_ERROR|SQLITE_ERROR/);
  const report = await call(app, 'GET', `/api/admin/import/${import_id}/report`);
  assert.deepEqual(leaks(report.body), []);
  raw.close();
});
