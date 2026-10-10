import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { COST } from './fixtures/costlyProduct';
import { codeOf } from './fixtures/source';
import { notificationRoutes } from '../worker/routes/notifications';
import { privateDrafts, purgeLegacyPrivateDrafts } from '../src/lib/privateDrafts';

function inbox(owner: boolean) {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES
    ('former-owner','Owner','boss@x.co','h','admin','2026-10-01');
    INSERT INTO user_notifications (id,user_id,kind,title_ar,title_en,body_ar,body_en,link,entity_type) VALUES
    ('finance','former-owner','payout_available','طلب سحب','Withdrawal','${COST.product}','${COST.product}','/admin?tab=finance','payout'),
    ('fx','former-owner','fx_attention','تسعير','Pricing','مراجعة','Review','/admin?tab=pricing',''),
    ('security','former-owner','security_alert','أمان','Security','','','/admin?tab=security',''),
    ('own-payout','former-owner','payout_available','أرباحك','Your earnings','5000','5000','/earnings','payout');`);
  const app = stubApp(asD1(raw), {
    id: 'former-owner', role: 'admin', email: owner ? 'boss@x.co' : 'assistant@x.co', admin_scope: 'full',
  }, a => a.route('/api/notifications', notificationRoutes));
  return { app, raw };
}

test('the owner finance inbox cannot be kept in the browser or a shared cache', async () => {
  const { app, raw } = inbox(true);
  try {
    const response = await get(app, '/api/notifications');
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.ok(JSON.stringify(body).includes(String(COST.product)), 'the owner still receives the financial notice');
    assert.match(response.headers.get('Cache-Control') ?? '', /\bno-store\b/);
    assert.match((await get(app, '/api/notifications/unread-count')).headers.get('Cache-Control') ?? '', /\bno-store\b/);
  } finally { raw.close(); }
});

test('owner-only notices are re-authorized on every inbox read, including badge counts', async () => {
  const { app, raw } = inbox(false);
  try {
    const response = await get(app, '/api/notifications');
    const body = await json(response);
    assert.deepEqual(body.notifications.map((n: { id: string }) => n.id), ['own-payout']);
    assert.equal(body.unread, 1);
    assert.equal((await json(await get(app, '/api/notifications/unread-count'))).unread, 1);
  } finally { raw.close(); }
});

test('the purchase and payroll editors never persist private drafts to browser storage', () => {
  for (const path of ['src/components/adminOperations/ProcurementPanel.tsx', 'src/components/financePeople/WageChangeDialog.tsx']) {
    assert.doesNotMatch(codeOf(path), /\b(?:localStorage|sessionStorage|indexedDB)\b/, path);
  }
});

test('incomplete supplier drafts are memory-only and old browser remnants are removed at boot', () => {
  const local = new Map([['levonis-purchase-draft-v2', JSON.stringify({ supplier_cost: COST.product })], ['levonis.theme.v1', 'dark']]);
  const session = new Map([['wage-preview:fixture', JSON.stringify({ amount: COST.optionAdjust })], ['unrelated', 'keep']]);
  const storage = (values: Map<string, string>) => ({
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: () => { assert.fail('private drafts must never write browser storage'); },
  });
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage(local) });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage(session) });
  try {
    const draft = JSON.stringify({ supplier_cost: COST.product });
    privateDrafts.setItem('purchase', draft);
    assert.equal(privateDrafts.getItem('purchase'), draft);
    privateDrafts.clear();
    assert.equal(privateDrafts.getItem('purchase'), null);
    purgeLegacyPrivateDrafts();
    assert.deepEqual([...local.keys()], ['levonis.theme.v1']);
    assert.deepEqual([...session.keys()], ['unrelated']);
    assert.match(codeOf('src/AuthContext.tsx'), /useEffect\(purgeLegacyPrivateDrafts, \[\]\)/);
  } finally {
    privateDrafts.clear();
    if (previousLocal) Object.defineProperty(globalThis, 'localStorage', previousLocal);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (previousSession) Object.defineProperty(globalThis, 'sessionStorage', previousSession);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('the bell resets before displaying a new account or reduced permissions, and its real route is mounted', () => {
  assert.match(codeOf('src/components/notifications/NotificationBell.tsx'), /<NotificationBellSession key=\{`\$\{user\?\.id \?\? ''\}:\$\{user\?\.can_view_cost === true\}`\} \/>/);
  assert.match(codeOf('worker/index.ts'), /app\.route\('\/api\/notifications', notificationRoutes\)/);
});
