/**
 * THE HINTS THE CLIENT HIDES SCREENS BY — owner decision 2, security spec
 * §2.4, master plan C16, step S1.
 *
 * `publicUser` used to compute `can_view_financials` on its own: it ignored
 * the owner (no env), treated an unrecognised scope as allowed, and let every
 * full or NULL-scope admin see the finance tab. The hints are now the very
 * predicates the routes apply, owner folded in first, so a hint cannot drift
 * from the rule it describes; and `can_view_financials` is an alias of COST
 * so a client build from before S1 hides the finance tab from a full admin.
 *
 * Run: node --import tsx --test tests/publicUserHint.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicUser, type Env, type SessionUser } from '../worker/lib/types';
import { asD1, freshDb, get, json, stubApp, type StubUser } from './fixtures/app';
import { authRoutes } from '../worker/routes/auth';

const env = { INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
const VERIFIED = '2026-01-01T00:00:00.000Z';

const user = (over: Partial<SessionUser>): SessionUser =>
  ({
    id: 'u1',
    email: 'someone@x.co',
    username: 'someone',
    name: 'Someone',
    role: 'customer',
    is_investor: 0,
    subscription_plan: 'free',
    membership_tier: 'free',
    admin_scope: null,
    email_verified_at: VERIFIED,
    locale: 'ar',
    ...over,
  }) as unknown as SessionUser;

const hints = (u: SessionUser) => {
  const p = publicUser(u, env);
  return {
    admin_scope: p.admin_scope,
    is_owner: p.is_owner,
    can_view_cost: p.can_view_cost,
    can_write_cost: p.can_write_cost,
    can_move_money: p.can_move_money,
    can_view_financials: p.can_view_financials,
    owner_email_unverified: p.owner_email_unverified,
  };
};

test("a full admin: money yes, cost no — and the legacy flag follows COST, not money", () => {
  assert.deepEqual(hints(user({ role: 'admin', email: 'full@x.co', admin_scope: 'full' })), {
    admin_scope: 'full',
    is_owner: false,
    can_view_cost: false,
    can_write_cost: false,
    can_move_money: true,
    can_view_financials: false,
    owner_email_unverified: false,
  });
});

test('a legacy NULL-scope admin is shown as full and gets the same hints', () => {
  assert.deepEqual(hints(user({ role: 'admin', email: 'legacy@x.co', admin_scope: null })), {
    admin_scope: 'full',
    is_owner: false,
    can_view_cost: false,
    can_write_cost: false,
    can_move_money: true,
    can_view_financials: false,
    owner_email_unverified: false,
  });
});

test("the owner, even with the 'assistant' the promotion trigger may leave on the row: every hint true", () => {
  assert.deepEqual(hints(user({ role: 'admin', email: 'BOSS@x.co', admin_scope: 'assistant' })), {
    admin_scope: 'assistant',
    is_owner: true,
    can_view_cost: true,
    can_write_cost: true,
    can_move_money: true,
    can_view_financials: true,
    owner_email_unverified: false,
  });
});

test('an owner address that is not verified is the owner, moves money, is not trusted with cost (critique A10) — and is shown the way out', () => {
  for (const stamp of [null, '', '   ', undefined]) {
    const h = hints(user({ role: 'admin', email: 'boss@x.co', email_verified_at: stamp as never }));
    assert.equal(h.is_owner, true);
    assert.equal(h.can_move_money, true);
    assert.equal(h.can_view_cost, false);
    assert.equal(h.can_write_cost, false);
    assert.equal(h.can_view_financials, false);
    assert.equal(h.owner_email_unverified, true, `stamp ${JSON.stringify(stamp)}`);
  }
  // Stamped: cost opens and the prompt is gone, on the very same row.
  const after = hints(user({ role: 'admin', email: 'boss@x.co', email_verified_at: VERIFIED }));
  assert.equal(after.can_view_cost, true);
  assert.equal(after.owner_email_unverified, false);
});

test('the way-out hint is on the owner-address ADMIN session only — never a customer, merchant or other admin, whatever the spelling', () => {
  for (const email of ['boss@x.co', 'BOSS@X.CO', '  boss@x.co ', 'Boss@x.Co']) {
    for (const role of ['customer', 'merchant'] as const) {
      const h = hints(user({ role, email, email_verified_at: null }));
      assert.equal(h.owner_email_unverified, false, `${role} ${email}`);
      assert.equal(h.can_view_cost, false);
    }
  }
  for (const email of ['boss@x.co.evil', 'xboss@x.co', 'boss@x.com', 'boss+1@x.co', 'boss@xx.co', '']) {
    for (const admin_scope of ['full', 'assistant', null]) {
      const h = hints(user({ role: 'admin', email, admin_scope, email_verified_at: null }));
      assert.equal(h.owner_email_unverified, false, `admin ${email}`);
      assert.equal(h.can_view_cost, false);
    }
  }
  // A blank INITIAL_ADMIN_EMAIL makes nobody the owner, and nobody gets the prompt.
  const blank = publicUser(user({ role: 'admin', email: '', email_verified_at: null }), { INITIAL_ADMIN_EMAIL: '' } as Env);
  assert.equal(blank.owner_email_unverified, false);
});

test("an unrecognised scope ('assisstant') is an assistant: shown as one, and no money", () => {
  assert.deepEqual(hints(user({ role: 'admin', email: 'a@x.co', admin_scope: 'assisstant' })), {
    admin_scope: 'assistant',
    is_owner: false,
    can_view_cost: false,
    can_write_cost: false,
    can_move_money: false,
    can_view_financials: false,
    owner_email_unverified: false,
  });
});

test('a customer, a merchant, and a customer row holding the owner address: every hint false, no scope', () => {
  for (const u of [
    user({ role: 'customer' }),
    user({ role: 'merchant', admin_scope: 'full' }),
    user({ role: 'customer', email: 'boss@x.co' }),
  ]) {
    assert.deepEqual(hints(u), {
      admin_scope: null,
      is_owner: false,
      can_view_cost: false,
      can_write_cost: false,
      can_move_money: false,
      can_view_financials: false,
      owner_email_unverified: false,
    });
  }
});

test('a grant on the session changes no hint while delegation is off', () => {
  const grantee = user({ role: 'admin', email: 'g@x.co', admin_scope: 'full', private_grants: ['PRICING_PRIVATE_READ', 'PRICING_PRIVATE_WRITE'] });
  assert.equal(hints(grantee).can_view_cost, false);
  assert.equal(hints(grantee).can_write_cost, false);
});

test('every hint is a real boolean — the client compares with === true, so undefined would hide, never show', () => {
  for (const u of [user({ role: 'customer' }), user({ role: 'admin', admin_scope: 'full' }), user({ role: 'admin', email: 'boss@x.co' })]) {
    const h = hints(u);
    for (const k of ['is_owner', 'can_view_cost', 'can_write_cost', 'can_move_money', 'can_view_financials', 'owner_email_unverified'] as const) {
      assert.equal(typeof h[k], 'boolean', k);
    }
  }
});

test('GET /api/auth/me carries the hints the server computed for this session', async () => {
  const raw = freshDb();
  const me = async (u: StubUser) =>
    (await json(await get(stubApp(asD1(raw), u, (a) => a.route('/api/auth', authRoutes)), '/api/auth/me'))).user as Record<string, unknown>;
  const full = await me({ id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' });
  assert.equal(full.can_move_money, true);
  assert.equal(full.can_view_cost, false);
  assert.equal(full.can_view_financials, false);
  assert.equal(full.is_owner, false);
  const owner = await me({ id: 'usr_owner', role: 'admin', email: 'boss@x.co', admin_scope: 'assistant' });
  assert.equal(owner.is_owner, true);
  assert.equal(owner.can_view_cost, true);
  assert.equal(owner.can_write_cost, true);
  assert.equal(owner.can_move_money, true);
  assert.equal(owner.owner_email_unverified, false);
  // Never a grant list, never the verification stamp: the hints are the answer.
  assert.equal('private_grants' in owner, false);
  assert.equal('email_verified_at' in owner, false);
  const unverified = await me({ id: 'usr_owner', role: 'admin', email: 'boss@x.co', email_verified_at: null });
  assert.equal(unverified.is_owner, true);
  assert.equal(unverified.can_view_cost, false);
  assert.equal(unverified.owner_email_unverified, true, 'the owner’s own session carries the way out');
  assert.equal(full.owner_email_unverified, false);
});
