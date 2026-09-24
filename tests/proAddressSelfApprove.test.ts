/**
 * «زر بجانب الحذف: اعتمد العنوان … يظهر أن هذه العملية لا يمكن تغييرها لاحقاً
 *  … ثم أنا متأكد وأعتمد العنوان».
 *
 * A PRO member approves their own first PRO address. After it, the address is
 * the one `isApprovedDefaultAddress` recognises — so PRO prices and free
 * delivery apply there — and it cannot be replaced from this door again.
 *
 * Run: node --import tsx --test tests/proAddressSelfApprove.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, asD1, stubApp, post, count } from './fixtures/app';
import { kycRoutes } from '../worker/routes/kyc';
import { isApprovedDefaultAddress, defaultAddressOf } from '../worker/lib/entitlements';

const FUTURE = '2099-01-01T00:00:00.000Z';

function setup(tier: 'pro' | 'prime' | null = 'pro') {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,email,password_hash) VALUES ('u1','u1@x.co','h')`);
  if (tier) {
    raw.exec(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
              VALUES ('m1','u1','${tier}_12mo','${tier}','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}')`);
  }
  raw.exec(`
    INSERT INTO addresses (id,user_id,label,name,phone,address,is_default) VALUES
      ('a_home','u1','Home','Sara','+9647701234567','Baghdad, Karrada',1),
      ('a_work','u1','Work','Sara','+9647701234567','Baghdad, Mansour',0);
  `);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'u1', role: 'customer', email: 'u1@x.co' }, (a) => a.route('/api/kyc', kycRoutes));
  return { raw, db, app };
}

const approve = (app: Parameters<typeof post>[0], addressId: string, confirm = 'APPROVE_ADDRESS') =>
  post(app, '/api/kyc/address-self-approve', { addressId, confirm });

test('a PRO member approves an address, it becomes the default, and PRO context holds there', async () => {
  const { raw, db, app } = setup();
  const res = await approve(app, 'a_work');
  assert.equal(res.status, 200, await res.text());
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM approved_addresses WHERE user_id='u1' AND state='approved'"), 1);
  const def = await defaultAddressOf(db, 'u1');
  assert.equal(def?.id, 'a_work', 'the approved address is the default');
  assert.equal(await isApprovedDefaultAddress(db, 'u1', def!), true);
});

test('it cannot be done twice — the second approval is refused', async () => {
  const { raw, app } = setup();
  assert.equal((await approve(app, 'a_home')).status, 200);
  const again = await approve(app, 'a_work');
  assert.equal(again.status, 409);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM approved_addresses WHERE state='approved'"), 1);
});

test('without the confirmation, or without an active PRO, nothing is written', async () => {
  const noConfirm = setup();
  assert.equal((await approve(noConfirm.app, 'a_home', 'yes')).status, 400);
  const premium = setup('prime');
  assert.equal((await approve(premium.app, 'a_home')).status, 400);
  const free = setup(null);
  assert.equal((await approve(free.app, 'a_home')).status, 400);
  for (const s of [noConfirm, premium, free]) {
    assert.equal(count(s.raw, 'SELECT COUNT(*) AS n FROM approved_addresses'), 0);
  }
});

test('someone else\'s address is not found', async () => {
  const { raw, app } = setup();
  raw.exec(`INSERT INTO users (id,email,password_hash) VALUES ('u2','u2@x.co','h');
            INSERT INTO addresses (id,user_id,label,name,phone,address,is_default)
            VALUES ('a_other','u2','X','Ali','+9647700000000','Basra',1)`);
  assert.equal((await approve(app, 'a_other')).status, 404);
});

test('the addresses page asks twice, warns it is final, and ends on «أنا متأكد وأعتمد العنوان»', () => {
  const page = readFileSync(new URL('../src/pages/Addresses.tsx', import.meta.url), 'utf8');
  assert.match(page, /اعتمد العنوان/);
  assert.match(page, /لا يمكن تغييرها لاحقًا/);
  assert.match(page, /أنا متأكد وأعتمد العنوان/);
  assert.match(page, /setApproveStep\(2\)/, 'a second step exists');
  assert.match(page, /\/api\/kyc\/address-self-approve/);
});
