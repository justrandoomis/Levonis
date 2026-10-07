/**
 * Who may change whom — PATCH /api/admin/users/:id.
 *
 * THE HOLE. admin_scope was gated (only a financial admin hands out financial
 * access) but `role` was not, and a newly promoted admin has admin_scope NULL,
 * which reads as FULL. An assistant — who must never see a cost — could
 * therefore promote any account, sign in to it, and read every cost and
 * margin. The same assistant could demote the owner and every other admin,
 * and hand out investor status.
 *
 * The rule is one pure function so it fails here, in `npm run test:unit`,
 * rather than only over HTTP.
 *
 * OWNER DECISION 2 (2026-10-07, S1): every new admin starts as an assistant;
 * only the owner widens a scope or changes investor status. A refusal is a
 * code (`{ status, code, message }`), rendered in the viewer's language.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userPatchElevates, userPatchRefusal, type UserPatchTarget } from '../worker/lib/adminScope';
import type { Env, SessionUser } from '../worker/lib/types';

const env = { INITIAL_ADMIN_EMAIL: 'owner@levonis-iq.com' } as unknown as Env;

function admin(over: Partial<SessionUser>): SessionUser {
  return {
    id: 'u_full',
    email: 'full@levonis-iq.com',
    username: null,
    name: 'Admin',
    role: 'admin',
    is_investor: 0,
    subscription_plan: 'free',
    membership_tier: 'free',
    admin_scope: null,
    locale: 'ar',
    ...over,
  } as unknown as SessionUser;
}

const owner = admin({ id: 'u_owner', email: 'owner@levonis-iq.com' });
const full = admin({ id: 'u_full', email: 'full@levonis-iq.com', admin_scope: null });
const assistant = admin({ id: 'u_asst', email: 'asst@levonis-iq.com', admin_scope: 'assistant' });

const customer: UserPatchTarget = { id: 'u_c', role: 'customer', email: 'c@x.com', is_investor: 0 };
const merchant: UserPatchTarget = { id: 'u_m', role: 'merchant', email: 'm@x.com', is_investor: 0 };
const otherAdmin: UserPatchTarget = { id: 'u_a2', role: 'admin', email: 'a2@levonis-iq.com', is_investor: 0, admin_scope: 'assistant' };
const fullAdmin: UserPatchTarget = { id: 'u_a3', role: 'admin', email: 'a3@levonis-iq.com', is_investor: 0, admin_scope: 'full' };
const ownerRow: UserPatchTarget = { id: 'u_owner', role: 'admin', email: 'Owner@Levonis-IQ.com', is_investor: 1 };
const investor: UserPatchTarget = { id: 'u_i', role: 'customer', email: 'i@x.com', is_investor: 1 };

const code = (r: ReturnType<typeof userPatchRefusal>) => r?.code ?? null;

// ------------------------------------------------------------- THE ESCALATION

test('an assistant cannot mint an administrator', () => {
  assert.equal(code(userPatchRefusal(env, assistant, customer, { role: 'admin' })), 'ROLE_CHANGE_DENIED');
  assert.equal(code(userPatchRefusal(env, assistant, merchant, { role: 'admin' })), 'ROLE_CHANGE_DENIED');
});

test('nor demote one', () => {
  assert.equal(code(userPatchRefusal(env, assistant, otherAdmin, { role: 'customer' })), 'ROLE_CHANGE_DENIED');
  assert.equal(code(userPatchRefusal(env, assistant, otherAdmin, { role: 'merchant' })), 'ROLE_CHANGE_DENIED');
});

test('a money-scope administrator may do both — the promotion lands as an assistant', () => {
  assert.equal(userPatchRefusal(env, full, customer, { role: 'admin' }), null);
  assert.equal(userPatchRefusal(env, full, customer, { role: 'admin', admin_scope: 'assistant' }), null);
  assert.equal(userPatchRefusal(env, full, otherAdmin, { role: 'customer' }), null);
  assert.equal(userPatchRefusal(env, owner, customer, { role: 'admin' }), null);
});

// ------------------------------------------------- EVERY NEW ADMIN STARTS AS AN ASSISTANT

test('a promotion that asks for a wider scope is refused for everyone but the owner (decision 2)', () => {
  const r = userPatchRefusal(env, full, customer, { role: 'admin', admin_scope: 'full' });
  assert.equal(r?.code, 'PROMOTION_STARTS_ASSISTANT');
  assert.equal(r?.status, 400);
  assert.equal(code(userPatchRefusal(env, full, customer, { role: 'admin', admin_scope: null })), 'PROMOTION_STARTS_ASSISTANT');
  // The owner may promote and elevate in one request (critique D5); the route
  // writes the two as separate statements and asks for a fresh sign-in.
  assert.equal(userPatchRefusal(env, owner, customer, { role: 'admin', admin_scope: 'full' }), null);
  assert.equal(userPatchElevates(customer, { role: 'admin', admin_scope: 'full' }), true);
  assert.equal(userPatchElevates(customer, { role: 'admin', admin_scope: 'assistant' }), false);
});

test('widening a scope is the owner\'s alone; restricting needs money scope', () => {
  assert.equal(code(userPatchRefusal(env, full, otherAdmin, { admin_scope: 'full' })), 'SCOPE_ELEVATION_OWNER_ONLY');
  assert.equal(code(userPatchRefusal(env, full, otherAdmin, { admin_scope: null })), 'SCOPE_ELEVATION_OWNER_ONLY');
  assert.equal(code(userPatchRefusal(env, assistant, otherAdmin, { admin_scope: 'full' })), 'SCOPE_ELEVATION_OWNER_ONLY');
  assert.equal(userPatchRefusal(env, owner, otherAdmin, { admin_scope: 'full' }), null);
  assert.equal(userPatchElevates(otherAdmin, { admin_scope: 'full' }), true);
  assert.equal(userPatchRefusal(env, full, fullAdmin, { admin_scope: 'assistant' }), null);
  assert.equal(code(userPatchRefusal(env, assistant, fullAdmin, { admin_scope: 'assistant' })), 'ROLE_CHANGE_DENIED');
});

// ------------------------------------------------------------- the owner

test('the owner cannot be demoted by anyone, whatever the case of the stored address', () => {
  assert.equal(code(userPatchRefusal(env, full, ownerRow, { role: 'customer' })), 'OWNER_LOCKED');
  assert.equal(code(userPatchRefusal(env, assistant, ownerRow, { role: 'merchant' })), 'OWNER_LOCKED');
});

test('nobody removes their own administrator role', () => {
  const self: UserPatchTarget = { id: full.id, role: 'admin', email: full.email, is_investor: 0 };
  assert.equal(code(userPatchRefusal(env, full, self, { role: 'merchant' })), 'SELF_DEMOTE');
  const ownerSelf: UserPatchTarget = { id: owner.id, role: 'admin', email: owner.email, is_investor: 0 };
  assert.equal(code(userPatchRefusal(env, owner, ownerSelf, { role: 'customer' })), 'SELF_DEMOTE');
});

// ----------------------------------------------- what is NOT an attempt

test('the panel echoes the unchanged row — an unchanged value is not an attempt', () => {
  // An assistant saving an admin's membership tier sends role: 'admin' back.
  assert.equal(userPatchRefusal(env, assistant, otherAdmin, { role: 'admin', is_investor: false }), null);
  // …the stored scope back…
  assert.equal(userPatchRefusal(env, assistant, otherAdmin, { role: 'admin', admin_scope: 'assistant' }), null);
  // …and is_investor: true back for someone who already is one.
  assert.equal(userPatchRefusal(env, assistant, investor, { role: 'customer', is_investor: true }), null);
  assert.equal(userPatchRefusal(env, assistant, customer, { role: 'customer', is_investor: false }), null);
});

test('customer ↔ merchant is an operations task, open to an assistant', () => {
  assert.equal(userPatchRefusal(env, assistant, customer, { role: 'merchant' }), null);
  assert.equal(userPatchRefusal(env, assistant, merchant, { role: 'customer' }), null);
});

// ---------------------------------------------------------------- investors

test('investor status is changed by the owner alone (decision 2)', () => {
  assert.equal(code(userPatchRefusal(env, assistant, customer, { is_investor: true })), 'INVESTOR_FLAG_OWNER_ONLY');
  assert.equal(code(userPatchRefusal(env, assistant, investor, { is_investor: false })), 'INVESTOR_FLAG_OWNER_ONLY');
  assert.equal(code(userPatchRefusal(env, full, customer, { is_investor: true })), 'INVESTOR_FLAG_OWNER_ONLY');
  assert.equal(userPatchRefusal(env, owner, customer, { is_investor: true }), null);
});

// -------------------------------------------------------------- admin_scope

test('the owner is never restricted, and a demotion may carry a scope', () => {
  assert.equal(code(userPatchRefusal(env, full, { ...ownerRow, admin_scope: null }, { admin_scope: 'assistant' })), 'OWNER_LOCKED');
  assert.equal(userPatchRefusal(env, full, otherAdmin, { role: 'customer', admin_scope: null }), null);
});

test('every refusal carries a bilingual server sentence', () => {
  const r = userPatchRefusal(env, assistant, customer, { role: 'admin' })!;
  assert.match(r.message, / \/ /, 'ar / en');
});
