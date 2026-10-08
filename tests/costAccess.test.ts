/**
 * THE PREDICATES — owner decision 2 (2026-10-07), step S1.
 *
 * «Main Admin / Owner فقط … حتى لو كان Assistant Admin يستطيع تعديل المنتجات أو
 * الطلبات، لا يستطيع رؤية أي Cost Data … أي Admin جديد يبدأ Assistant Admin بدون
 * PRICING_PRIVATE_READ / PRICING_PRIVATE_WRITE … لا أريد تفويض بيانات التكلفة».
 *
 * One truth table over every kind of caller × every predicate, so a
 * regression to the old rule ("a non-assistant admin sees cost") fails here,
 * in a pure test, before any route is involved. Then the grant path (proved
 * with the test-only `delegation` switch and shown dead without it), the
 * projection, the refusals, the readiness answer by viewer, the fresh-sign-in
 * gate, the grant loader, and — critique G-3 — that every predicate decides
 * the owner BEFORE it reads a stored scope.
 *
 * Run: node --import tsx --test tests/costAccess.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  PRIVATE_DELEGATION_ENABLED,
  canMoveMoney,
  canViewCost,
  canWriteCost,
  hasPrivateGrant,
  isUnverifiedOwner,
  projectForAdmin,
  viewerClass,
  type CostSubject,
} from '../worker/lib/adminScope';
import {
  assertCostRead,
  assertCostWrite,
  costDenied,
  costRefusal,
  loadPrivateGrants,
  ownerEmailUnverified,
  ownerOnly,
  pricingUnavailable,
  requireCostRead,
  requireCostWrite,
  requireFreshSession,
  requireOwner,
} from '../worker/lib/costAccess';
import { serverMessage } from '../packages/contracts/src/costRefusals';
import { HttpError } from '../worker/lib/http';
import { ROOT } from './fixtures/d1';
import { asD1, dbThrough, freshDb, json, stubApp, get } from './fixtures/app';
import { COST } from './fixtures/costlyProduct';
import type { AppContext, Env } from '../worker/lib/types';

const env = { INITIAL_ADMIN_EMAIL: 'owner@levonis-iq.com' } as unknown as Env;
const VERIFIED = '2026-01-01T00:00:00.000Z';
const subject = (over: Partial<CostSubject> & { id?: string }): CostSubject =>
  ({ role: 'customer', email: 'someone@example.com', admin_scope: null, email_verified_at: VERIFIED, ...over }) as CostSubject;

// ------------------------------------------------------------- the table

interface Row {
  who: string;
  user: CostSubject | null;
  view: boolean;
  write: boolean;
  money: boolean;
  cls: ReturnType<typeof viewerClass>;
  envOverride?: Env;
}

const ROWS: Row[] = [
  { who: 'guest', user: null, view: false, write: false, money: false, cls: 'guest' },
  { who: 'customer', user: subject({ role: 'customer' }), view: false, write: false, money: false, cls: 'customer' },
  {
    who: "merchant carrying a stray 'full' scope",
    user: subject({ role: 'merchant', admin_scope: 'full' }),
    view: false,
    write: false,
    money: false,
    cls: 'merchant',
  },
  {
    who: 'a customer row holding the owner address',
    user: subject({ role: 'customer', email: 'owner@levonis-iq.com' }),
    view: false,
    write: false,
    money: false,
    cls: 'customer',
  },
  { who: 'assistant admin', user: subject({ role: 'admin', admin_scope: 'assistant' }), view: false, write: false, money: false, cls: 'assistant_admin' },
  // THE TWO ROWS DECISION 2 CHANGED: they moved money and saw every cost; now money only.
  { who: "full admin ('full')", user: subject({ role: 'admin', admin_scope: 'full' }), view: false, write: false, money: true, cls: 'full_admin' },
  { who: 'legacy admin (NULL scope)', user: subject({ role: 'admin', admin_scope: null }), view: false, write: false, money: true, cls: 'full_admin' },
  {
    who: "unrecognised scope ('assisstant')",
    user: subject({ role: 'admin', admin_scope: 'assisstant' }),
    view: false,
    write: false,
    money: false,
    cls: 'assistant_admin',
  },
  {
    who: "owner whose row the trigger left 'assistant'",
    user: subject({ role: 'admin', email: 'owner@levonis-iq.com', admin_scope: 'assistant' }),
    view: true,
    write: true,
    money: true,
    cls: 'owner',
  },
  {
    who: 'owner with a mixed-case, padded address',
    user: subject({ role: 'admin', email: '  Owner@LEVONIS-iq.com ', admin_scope: null }),
    view: true,
    write: true,
    money: true,
    cls: 'owner',
  },
  {
    // Critique A10: owner status is the address; cost needs it PROVEN.
    who: 'owner whose address is not verified',
    user: subject({ role: 'admin', email: 'owner@levonis-iq.com', email_verified_at: null }),
    view: false,
    write: false,
    money: true,
    cls: 'owner',
  },
  {
    who: 'owner address with a blank verification stamp',
    user: subject({ role: 'admin', email: 'owner@levonis-iq.com', email_verified_at: '   ' }),
    view: false,
    write: false,
    money: true,
    cls: 'owner',
  },
  {
    who: 'owner address with an empty-string verification stamp',
    user: subject({ role: 'admin', email: 'owner@levonis-iq.com', email_verified_at: '' }),
    view: false,
    write: false,
    money: true,
    cls: 'owner',
  },
  {
    who: 'owner row read without the stamp column at all',
    user: subject({ role: 'admin', email: 'owner@levonis-iq.com', email_verified_at: undefined }),
    view: false,
    write: false,
    money: true,
    cls: 'owner',
  },
  {
    // A blank INITIAL_ADMIN_EMAIL must grant NOBODY, least of all an admin with a blank address.
    who: 'INITIAL_ADMIN_EMAIL blank, admin with a blank address',
    user: subject({ role: 'admin', email: '', admin_scope: 'full' }),
    view: false,
    write: false,
    money: true,
    cls: 'full_admin',
    envOverride: { INITIAL_ADMIN_EMAIL: '' } as unknown as Env,
  },
  {
    who: 'INITIAL_ADMIN_EMAIL unset, the would-be owner',
    user: subject({ role: 'admin', email: 'owner@levonis-iq.com', admin_scope: 'assistant' }),
    view: false,
    write: false,
    money: false,
    cls: 'assistant_admin',
    envOverride: {} as unknown as Env,
  },
];

for (const r of ROWS) {
  test(`truth table — ${r.who}`, () => {
    const e = r.envOverride ?? env;
    assert.equal(canViewCost(e, r.user), r.view, 'canViewCost');
    assert.equal(canWriteCost(e, r.user), r.write, 'canWriteCost');
    assert.equal(canMoveMoney(e, r.user), r.money, 'canMoveMoney');
    assert.equal(viewerClass(e, r.user), r.cls, 'viewerClass');
    // The way out is the owner's alone, and only while cost is shut to them.
    assert.equal(isUnverifiedOwner(e, r.user), r.cls === 'owner' && !r.view, 'isUnverifiedOwner');
  });
}

test('DECISIONS row 185 amendment: the unverified owner sees no cost until the stamp, then sees it — whatever the stamp looked like before', () => {
  const owner = (email_verified_at: string | null | undefined) =>
    subject({ role: 'admin', email: 'owner@levonis-iq.com', admin_scope: 'assistant', email_verified_at });
  for (const stamp of [null, undefined, '', '   ', '\t\n']) {
    assert.equal(canViewCost(env, owner(stamp)), false, `view, stamp ${JSON.stringify(stamp)}`);
    assert.equal(canWriteCost(env, owner(stamp)), false, `write, stamp ${JSON.stringify(stamp)}`);
    assert.equal(isUnverifiedOwner(env, owner(stamp)), true);
    assert.deepEqual(projectForAdmin(env, owner(stamp), costlyDoc), { id: 'p1', price_iqd: 900_000, options: [{ id: 'o1' }] });
  }
  const stamped = owner(VERIFIED);
  assert.equal(canViewCost(env, stamped), true);
  assert.equal(canWriteCost(env, stamped), true);
  assert.equal(isUnverifiedOwner(env, stamped), false);
});

test('isUnverifiedOwner is the owner-address ADMIN row only: never a customer or merchant with the address, never another admin', () => {
  for (const email of ['owner@levonis-iq.com', 'OWNER@LEVONIS-IQ.COM', '  owner@levonis-iq.com ']) {
    for (const role of ['customer', 'merchant'] as const) {
      assert.equal(isUnverifiedOwner(env, subject({ role, email, email_verified_at: null })), false, `${role} ${email}`);
    }
    // The same address, any case or padding, on the admin row IS the owner (isOwner trims and folds case).
    assert.equal(isUnverifiedOwner(env, subject({ role: 'admin', email, email_verified_at: null })), true, `admin ${email}`);
  }
  for (const email of ['owner@levonis-iq.com.evil', 'xowner@levonis-iq.com', 'owner@levonis-iq.co', 'owner+1@levonis-iq.com', '']) {
    assert.equal(isUnverifiedOwner(env, subject({ role: 'admin', email, email_verified_at: null })), false, email);
  }
  assert.equal(isUnverifiedOwner(env, null), false);
  assert.equal(isUnverifiedOwner({ INITIAL_ADMIN_EMAIL: '' } as unknown as Env, subject({ role: 'admin', email: '', email_verified_at: null })), false);
  assert.equal(isUnverifiedOwner({} as unknown as Env, subject({ role: 'admin', email: 'owner@levonis-iq.com', email_verified_at: null })), false);
});

test('THE DECISION IN ONE LINE: a full or NULL-scope non-owner moves money and never sees a cost', () => {
  for (const admin_scope of ['full', null] as const) {
    const u = subject({ role: 'admin', email: 'full@x.co', admin_scope });
    assert.equal(canMoveMoney(env, u), true);
    assert.equal(canViewCost(env, u), false);
    assert.equal(canWriteCost(env, u), false);
  }
});

// ------------------------------------------------------------- grants

test('delegation is OFF in the code (decision 2) — a reviewed one-line change, pinned here and in costPredicateUsage', () => {
  assert.equal(PRIVATE_DELEGATION_ENABLED, false);
});

test('a grant is ignored while delegation is off, however it reached the session', () => {
  const grantee = subject({ role: 'admin', email: 'g@x.co', admin_scope: 'full', private_grants: ['PRICING_PRIVATE_READ', 'PRICING_PRIVATE_WRITE'] });
  assert.equal(hasPrivateGrant(grantee, 'PRICING_PRIVATE_READ'), false);
  assert.equal(canViewCost(env, grantee), false);
  assert.equal(canWriteCost(env, grantee), false);
  assert.equal(viewerClass(env, grantee), 'full_admin', 'not a cost grantee while delegation is off');
});

test('the grant path, proved with the test-only switch: READ reads, WRITE needs READ, nothing reaches a non-admin', () => {
  const on = { delegation: true };
  const read = subject({ role: 'admin', email: 'g@x.co', admin_scope: 'assistant', private_grants: ['PRICING_PRIVATE_READ'] });
  assert.equal(canViewCost(env, read, on), true);
  assert.equal(canWriteCost(env, read, on), false, 'read alone never writes');
  assert.equal(viewerClass(env, read, on), 'cost_grantee');

  const both = { ...read, private_grants: ['PRICING_PRIVATE_READ', 'PRICING_PRIVATE_WRITE'] };
  assert.equal(canViewCost(env, both, on), true);
  assert.equal(canWriteCost(env, both, on), true);

  const writeOnly = { ...read, private_grants: ['PRICING_PRIVATE_WRITE'] };
  assert.equal(canViewCost(env, writeOnly, on), false);
  assert.equal(canWriteCost(env, writeOnly, on), false, 'write without read is nothing');

  const customer = subject({ role: 'customer', private_grants: ['PRICING_PRIVATE_READ', 'PRICING_PRIVATE_WRITE'] });
  assert.equal(canViewCost(env, customer, on), false);
  assert.equal(canWriteCost(env, customer, on), false);

  const notAList = { ...read, private_grants: 'PRICING_PRIVATE_READ' as unknown as string[] };
  assert.equal(canViewCost(env, notAList, on), false, 'only a real list of grants counts');
});

// ------------------------------------------------------------- projection

const costlyDoc = {
  id: 'p1',
  price_iqd: 900_000,
  product_cost_iqd: COST.product,
  target_profit_iqd: 200_000,
  options: [{ id: 'o1', cost_iqd: COST.option, fx_rate: '1310.5', effective_cbm: '0.4' }],
};

test('projectForAdmin is COST-based: a full admin gets the document stripped, the owner gets it whole', () => {
  const full = subject({ role: 'admin', email: 'full@x.co', admin_scope: 'full' });
  const owner = subject({ role: 'admin', email: 'owner@levonis-iq.com', admin_scope: 'assistant' });
  assert.deepEqual(projectForAdmin(env, full, costlyDoc), { id: 'p1', price_iqd: 900_000, options: [{ id: 'o1' }] });
  assert.deepEqual(projectForAdmin(env, subject({ role: 'admin', admin_scope: null }), costlyDoc), {
    id: 'p1',
    price_iqd: 900_000,
    options: [{ id: 'o1' }],
  });
  assert.deepEqual(projectForAdmin(env, owner, costlyDoc), costlyDoc);
});

// ------------------------------------------------------------- refusals

test('COST_ACCESS_DENIED is one generic answer: no id, no number, field NAMES only on a write', () => {
  const read = costDenied();
  assert.ok(read instanceof HttpError);
  assert.equal(read.status, 403);
  assert.equal(read.code, 'COST_ACCESS_DENIED');
  assert.equal(read.message, serverMessage('COST_ACCESS_DENIED'));
  assert.equal(read.details, undefined);
  assert.doesNotMatch(read.message, /\d/, 'no number in the refusal');

  const write = costDenied({ fields: ['product_cost_iqd'] });
  assert.deepEqual(write.details, { fields: ['product_cost_iqd'] });
  assert.equal(costDenied({ fields: [] }).details, undefined, 'an empty list says nothing');

  for (const code of ['OWNER_ONLY', 'SCOPE_ELEVATION_OWNER_ONLY', 'INVESTOR_FLAG_OWNER_ONLY', 'PRIVATE_DELEGATION_DISABLED', 'OWNER_EMAIL_LOCKED'] as const) {
    const e = ownerOnly(code);
    assert.equal(e.status, 403);
    assert.equal(e.code, code);
    assert.equal(e.message, serverMessage(code));
  }
  assert.equal(ownerOnly().code, 'OWNER_ONLY');
});

test('costRefusal: OWNER_EMAIL_UNVERIFIED for the unverified owner alone; every other caller gets the EXACT COST_ACCESS_DENIED', () => {
  const unverified = subject({ role: 'admin', email: 'owner@levonis-iq.com', email_verified_at: null });
  const e = costRefusal(env, unverified);
  assert.equal(e.status, 403);
  assert.equal(e.code, 'OWNER_EMAIL_UNVERIFIED');
  assert.equal(e.message, serverMessage('OWNER_EMAIL_UNVERIFIED'));
  assert.equal(e.details, undefined, 'a read refusal carries nothing');
  assert.deepEqual(costRefusal(env, unverified, { fields: ['product_cost_iqd'] }).details, { fields: ['product_cost_iqd'] }, 'names only on a write');
  assert.deepEqual(ownerEmailUnverified(), e);

  const same = (a: HttpError, b: HttpError) =>
    assert.deepEqual({ s: a.status, m: a.message, c: a.code, d: a.details }, { s: b.status, m: b.message, c: b.code, d: b.details });
  const others: Array<CostSubject | null> = [
    null,
    subject({ role: 'customer' }),
    subject({ role: 'customer', email: 'owner@levonis-iq.com', email_verified_at: null }),
    subject({ role: 'merchant', email: ' OWNER@levonis-iq.com', email_verified_at: null }),
    subject({ role: 'admin', email: 'full@x.co', admin_scope: 'full', email_verified_at: null }),
    subject({ role: 'admin', email: 'a@x.co', admin_scope: 'assistant', email_verified_at: null }),
    subject({ role: 'admin', email: 'owner@levonis-iq.com.evil', email_verified_at: null }),
  ];
  for (const u of others) {
    same(costRefusal(env, u), costDenied());
    same(costRefusal(env, u, { fields: ['cost_iqd'] }), costDenied({ fields: ['cost_iqd'] }));
  }
});

test('pricingUnavailable answers by viewer: customer wording, admin "incomplete", the missing list for the owner only', () => {
  const missing = [{ level: 'variant' as const, id: 'v1', field: 'supplier_cost' }];
  const owner = subject({ role: 'admin', email: 'owner@levonis-iq.com' });
  const ownerAnswer = pricingUnavailable(env, owner, missing);
  assert.equal(ownerAnswer.status, 409);
  assert.equal(ownerAnswer.code, 'PRICING_INCOMPLETE');
  assert.deepEqual(ownerAnswer.details, { missing });

  // An unverified owner address is not trusted with the list either (A10).
  const unverified = pricingUnavailable(env, { ...owner, email_verified_at: null }, missing);
  assert.equal(unverified.code, 'PRICING_INCOMPLETE');
  assert.equal(unverified.details, undefined);

  for (const admin_scope of ['assistant', 'full', null] as const) {
    const e = pricingUnavailable(env, subject({ role: 'admin', email: 'a@x.co', admin_scope }), missing);
    assert.equal(e.code, 'PRICING_INCOMPLETE');
    assert.equal(e.details, undefined, `no missing list for ${admin_scope}`);
  }

  for (const u of [null, subject({ role: 'customer' }), subject({ role: 'merchant' })]) {
    const line = pricingUnavailable(env, u, missing, { status: 404 });
    assert.equal(line.code, 'PRODUCT_UNAVAILABLE', 'the existing code and wording (F19)');
    assert.equal(line.status, 404);
    assert.equal(line.details, undefined);
    const add = pricingUnavailable(env, u, missing, { door: 'add' });
    assert.equal(add.code, 'PRODUCT_CURRENTLY_UNAVAILABLE', 'critique G-34');
    assert.equal(add.status, 409);
    assert.equal(add.message, serverMessage('PRODUCT_CURRENTLY_UNAVAILABLE'));
  }
});

// ------------------------------------------------------------- middleware

function doorApp(user: Record<string, unknown> | null, opts: { sessionAgeSeconds?: number } = {}) {
  return stubApp(asD1(freshDb()), user as never, (a) => {
    const r = new Hono<AppContext>();
    r.get('/read', requireCostRead, (c) => c.json({ ok: true }));
    r.get('/write', requireCostWrite, (c) => c.json({ ok: true }));
    r.get('/owner', requireOwner, (c) => c.json({ ok: true }));
    r.get('/assert-read', (c) => {
      assertCostRead(c);
      return c.json({ ok: true });
    });
    r.get('/assert-write', (c) => {
      assertCostWrite(c, ['cost_iqd']);
      return c.json({ ok: true });
    });
    r.get('/fresh', (c) => {
      requireFreshSession(c);
      return c.json({ ok: true });
    });
    a.route('/t', r);
  }, opts);
}

test('the doors: the owner passes, a full admin gets COST_ACCESS_DENIED, a full admin is not the owner', async () => {
  const owner = { id: 'usr_owner', role: 'admin', email: 'boss@x.co', admin_scope: 'assistant' };
  const full = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
  for (const p of ['/t/read', '/t/write', '/t/owner', '/t/assert-read', '/t/assert-write']) {
    assert.equal((await get(doorApp(owner), p)).status, 200, `owner ${p}`);
    const res = await get(doorApp(full), p);
    assert.equal(res.status, 403, `full ${p}`);
    const body = await json(res);
    assert.equal(body.code, p === '/t/owner' ? 'OWNER_ONLY' : 'COST_ACCESS_DENIED', p);
  }
  const w = await json(await get(doorApp(full), '/t/assert-write'));
  assert.deepEqual(w.details, { fields: ['cost_iqd'] }, 'a write refusal names the field, never its value');
  assert.equal((await get(doorApp(null), '/t/owner')).status, 403, 'a guest is not the owner');
  assert.equal((await get(doorApp({ ...owner, role: 'customer' }), '/t/owner')).status, 403, 'the owner address on a customer row is nothing');
});

test('the doors, for the owner before the address is verified: OWNER_EMAIL_UNVERIFIED at every cost door, a field NAME on a write, and the stamp opens them', async () => {
  const unverified = { id: 'usr_owner', role: 'admin', email: 'boss@x.co', admin_scope: 'assistant', email_verified_at: null };
  for (const p of ['/t/read', '/t/write', '/t/assert-read', '/t/assert-write']) {
    const res = await get(doorApp(unverified), p);
    assert.equal(res.status, 403, p);
    const body = await json(res);
    assert.equal(body.code, 'OWNER_EMAIL_UNVERIFIED', p);
    assert.equal(body.error, serverMessage('OWNER_EMAIL_UNVERIFIED'));
    if (p === '/t/assert-write') assert.deepEqual(body.details, { fields: ['cost_iqd'] });
    else assert.equal(body.details, undefined);
    assert.equal((await get(doorApp({ ...unverified, email_verified_at: VERIFIED }), p)).status, 200, `${p} once stamped`);
  }
  // A full admin's refusal is untouched, byte for byte.
  const full = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full', email_verified_at: null };
  const text = await (await get(doorApp(full), '/t/read')).text();
  assert.equal(text, JSON.stringify({ success: false, error: serverMessage('COST_ACCESS_DENIED'), code: 'COST_ACCESS_DENIED' }));
});

test('requireFreshSession: a sign-in younger than ten minutes passes, an older one is REAUTH_REQUIRED', async () => {
  const owner = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
  assert.equal((await get(doorApp(owner, { sessionAgeSeconds: 60 }), '/t/fresh')).status, 200);
  const stale = await get(doorApp(owner, { sessionAgeSeconds: 11 * 60 }), '/t/fresh');
  assert.equal(stale.status, 401);
  assert.equal((await json(stale)).code, 'REAUTH_REQUIRED');
});

// ------------------------------------------------------------- grant loader

test('loadPrivateGrants: nothing is read while delegation is off; the 0176 database and a broken table fail closed', async () => {
  // Delegation off: the database is never touched.
  const untouchable = { prepare() { throw new Error('the grants table must not be read while delegation is off'); } } as unknown as D1Database;
  assert.deepEqual(await loadPrivateGrants(untouchable, 'usr_grant'), []);

  // Delegation on, the Worker ahead of migration 0177: no table, no grants, no throw.
  assert.deepEqual(await loadPrivateGrants(asD1(dbThrough('0176')), 'usr_grant', { delegation: true }), []);

  // Delegation on, the table present: live grants only, unknown keys dropped.
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('usr_owner','O','boss@x.co','h','admin'), ('usr_grant','G','g@x.co','h','admin');
    INSERT INTO admin_private_grants (id,user_id,grant_key,granted_by,operation_id) VALUES
      ('apg1','usr_grant','PRICING_PRIVATE_READ','usr_owner','op-read-1'),
      ('apg2','usr_grant','PRICING_PRIVATE_WRITE','usr_owner','op-write-1');
    UPDATE admin_private_grants SET revoked_at = '2026-10-07T00:00:00Z', revoked_by = 'usr_owner' WHERE id = 'apg2';`);
  assert.deepEqual(await loadPrivateGrants(asD1(raw), 'usr_grant', { delegation: true }), ['PRICING_PRIVATE_READ']);

  const broken = { prepare() { throw new Error('D1 is down'); } } as unknown as D1Database;
  assert.deepEqual(await loadPrivateGrants(broken, 'usr_grant', { delegation: true }), []);
});

// ------------------------------------------------------------- G-3, statically

/** The body of `export function <name>(` up to the next top-level `export`. */
function body(src: string, name: string): string {
  const at = src.indexOf(`export function ${name}(`);
  assert.ok(at >= 0, `${name} must exist`);
  const next = src.indexOf('\nexport ', at + 10);
  return src.slice(at, next < 0 ? undefined : next);
}

test('critique G-3: every predicate decides the OWNER before it reads a stored scope or a grant', () => {
  const scope = readFileSync(join(ROOT, 'worker/lib/adminScope.ts'), 'utf8');
  for (const name of ['canViewCost', 'canWriteCost']) {
    const b = body(scope, name);
    const owner = b.indexOf('isVerifiedOwner(env, user)');
    assert.ok(owner > 0, `${name} asks for the owner`);
    for (const later of ['hasPrivateGrant(', 'admin_scope', 'normalizeAdminScope(']) {
      const at = b.indexOf(later);
      if (at >= 0) assert.ok(at > owner, `${name} reads ${later} before deciding the owner`);
    }
  }
  const money = body(scope, 'canMoveMoney');
  assert.ok(money.indexOf('isOwner(env, user)') > 0 && money.indexOf('isOwner(env, user)') < money.indexOf('normalizeAdminScope('), 'canMoveMoney: owner first');
  const cls = body(scope, 'viewerClass');
  const ownerAt = cls.indexOf('isOwner(env, user)');
  assert.ok(ownerAt > 0 && ownerAt < cls.indexOf('canViewCost(') && ownerAt < cls.indexOf('canMoveMoney('), 'viewerClass: owner first');
  const patch = body(scope, 'userPatchRefusal');
  assert.ok(patch.indexOf('isOwner(env, actor)') < patch.indexOf('canMoveMoney(env, actor)'), 'userPatchRefusal: owner first');

  const ops = readFileSync(join(ROOT, 'worker/lib/operations.ts'), 'utf8');
  const cap = ops.slice(ops.indexOf('export async function requireCapability'), ops.indexOf('/** The capabilities that read or write cost'));
  const opsOwner = cap.lastIndexOf('if (isOwner(env, user)) return;');
  assert.ok(opsOwner > 0 && opsOwner < cap.indexOf("'SELECT allowed FROM ops_permissions", opsOwner), 'requireCapability: the owner passes before a permission row is read');

  const types = readFileSync(join(ROOT, 'worker/lib/types.ts'), 'utf8');
  const pub = types.slice(types.indexOf('export function publicUser('));
  for (const hint of ['is_owner: u.role === \'admin\' && isOwner(ownerEnv, u)', 'can_view_cost: canViewCost(ownerEnv, u)', 'can_write_cost: canWriteCost(ownerEnv, u)', 'can_move_money: canMoveMoney(ownerEnv, u)', 'can_view_financials: canViewCost(ownerEnv, u)', 'owner_email_unverified: isUnverifiedOwner(ownerEnv, u)']) {
    assert.ok(pub.includes(hint), `publicUser derives ${hint.split(':')[0]} from the predicate itself`);
  }
});
