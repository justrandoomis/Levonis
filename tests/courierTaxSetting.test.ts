/**
 * «ضريبة شركة التوصيل» — the delivery company's tax is the owner's to set
 * (2026-10-18: «اجعل بالامكان التعديل على رسوم ضريبه شركه التوصيل مثلا تكون
 * 5 الف لكل 500 الف»). Pins the write path the admin panel uses
 * (PUT /api/admin/settings/codTaxBlockIqd and …/codTaxPerBlockIqd): owner
 * only, whole dinars, a block of at least 1,000, a charge of 0 still legal
 * (it switches the tax off), and every accepted value audited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminRoutes } from '../worker/routes/admin';
import { asD1, freshDb, json, put, row, stubApp, OWNER } from './fixtures/app';
import { acceptedCodTaxField, calculateCodTaxIqd, COD_TAX_MIN_BLOCK_IQD } from '../packages/shipping/src/codTax';
import { readCourierTax } from '../src/components/adminWallet/CourierTaxPanel';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAFF = { id: 'usr_staff', role: 'admin' as const, email: 'staff@x.co' };

function setup(user: typeof OWNER) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES
    ('usr_owner','Owner','boss@x.co','h','admin'), ('usr_staff','Staff','staff@x.co','h','admin')`);
  const app = stubApp(asD1(raw), user, (router) => router.route('/api/admin', adminRoutes));
  return { raw, app };
}

const stored = (raw: ReturnType<typeof freshDb>, key: string) =>
  row<{ value: string }>(raw, 'SELECT value FROM admin_settings WHERE key = ?', key)?.value ?? null;

test("the owner's example — 5,000 for every 500,000 — saves, is audited with its value, and prices 1,200,000 at 10,000", async () => {
  const { raw, app } = setup(OWNER);
  for (const [key, value] of [['codTaxBlockIqd', 500_000], ['codTaxPerBlockIqd', 5_000]] as const) {
    const res = await put(app, `/api/admin/settings/${key}`, { value });
    assert.equal(res.status, 200, JSON.stringify(await json(res)));
    assert.equal(JSON.parse(stored(raw, key)!), value);
    const audit = row<{ actor_id: string; detail: string }>(raw,
      "SELECT actor_id, detail FROM audit_log WHERE action = 'settings.update' AND target = ? ORDER BY rowid DESC LIMIT 1", key);
    assert.equal(audit?.actor_id, 'usr_owner');
    assert.deepEqual(JSON.parse(audit!.detail), { value });
  }
  assert.equal(calculateCodTaxIqd(1_200_000, { perBlockIqd: 5_000, blockIqd: 500_000 }), 10_000);
  raw.close();
});

test('a charge of 0 is accepted (the tax is switched off); a fractional, negative or empty charge is refused', async () => {
  const { raw, app } = setup(OWNER);
  assert.equal((await put(app, '/api/admin/settings/codTaxPerBlockIqd', { value: 0 })).status, 200);
  assert.equal(JSON.parse(stored(raw, 'codTaxPerBlockIqd')!), 0);
  for (const value of [-1, 2500.5, '', null, 'abc']) {
    const res = await put(app, '/api/admin/settings/codTaxPerBlockIqd', { value });
    assert.equal(res.status, 400, `charge ${JSON.stringify(value)}`);
    assert.equal((await json(res)).code, 'COD_TAX_INVALID');
  }
  assert.equal(JSON.parse(stored(raw, 'codTaxPerBlockIqd')!), 0, 'a refused write leaves the saved charge alone');
  raw.close();
});

test('a block under 1,000 IQD, or not whole, is refused; 1,000 is the smallest block', async () => {
  const { raw, app } = setup(OWNER);
  for (const value of [0, 1, 999, 500_000.5, -500_000]) {
    const res = await put(app, '/api/admin/settings/codTaxBlockIqd', { value });
    assert.equal(res.status, 400, `block ${value}`);
    assert.equal((await json(res)).code, 'COD_TAX_INVALID');
  }
  assert.equal(stored(raw, 'codTaxBlockIqd'), null);
  assert.equal((await put(app, '/api/admin/settings/codTaxBlockIqd', { value: COD_TAX_MIN_BLOCK_IQD })).status, 200);
  raw.close();
});

test('another admin cannot change the courier tax; nothing is stored or audited', async () => {
  const { raw, app } = setup(STAFF);
  for (const key of ['codTaxBlockIqd', 'codTaxPerBlockIqd']) {
    const res = await put(app, `/api/admin/settings/${key}`, { value: 500_000 });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).code, 'OWNER_ONLY');
    assert.equal(stored(raw, key), null);
  }
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.update'")?.n, 0);
  raw.close();
});

test('the admin form reads the typed figures with the same limits, and keeps its three-language promise', () => {
  assert.deepEqual(readCourierTax('5000', '500000'), { ok: true, perBlockIqd: 5_000, blockIqd: 500_000 });
  assert.deepEqual(readCourierTax('0', '500000'), { ok: true, perBlockIqd: 0, blockIqd: 500_000 });
  assert.deepEqual(readCourierTax('-1', '500000'), { ok: false, field: 'perBlockIqd' });
  assert.deepEqual(readCourierTax('', '500000'), { ok: false, field: 'perBlockIqd' });
  assert.deepEqual(readCourierTax('5000', '999'), { ok: false, field: 'blockIqd' });
  assert.deepEqual(readCourierTax('5000', '500000.5'), { ok: false, field: 'blockIqd' });
  assert.equal(acceptedCodTaxField('blockIqd', COD_TAX_MIN_BLOCK_IQD), 1_000);
  const panel = readFileSync(join(ROOT, 'src/components/adminWallet/CourierTaxPanel.tsx'), 'utf8');
  assert.ok(panel.includes("'ضريبة شركة التوصيل', 'Delivery company tax', 'باجی کۆمپانیای گەیاندن'"));
  assert.ok(panel.includes('Set the charge to 0 to switch it off'), 'the on-screen promise that 0 switches it off');
  // «إدارة التوصيل» hosts the panel now (owner, 2026-10-18); the wallet settings keep a link to it.
  const page = readFileSync(join(ROOT, 'src/components/adminDeliveryPricing/DeliveryManagement.tsx'), 'utf8');
  assert.ok(page.includes('<CourierTaxPanel />'), 'the delivery management page hosts the panel');
  const wallet = readFileSync(join(ROOT, 'src/components/AdminWalletSettings.tsx'), 'utf8');
  assert.ok(wallet.includes('href="/admin?tab=delivery_pricing"'), 'the wallet settings link to it');
});
