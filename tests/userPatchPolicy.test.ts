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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userPatchRefusal, type UserPatchTarget } from '../worker/lib/adminScope';
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
const otherAdmin: UserPatchTarget = { id: 'u_a2', role: 'admin', email: 'a2@levonis-iq.com', is_investor: 0 };
const ownerRow: UserPatchTarget = { id: 'u_owner', role: 'admin', email: 'Owner@Levonis-IQ.com', is_investor: 1 };
const investor: UserPatchTarget = { id: 'u_i', role: 'customer', email: 'i@x.com', is_investor: 1 };

// ------------------------------------------------------------- THE ESCALATION

test('an assistant cannot mint an administrator', () => {
  assert.match(userPatchRefusal(env, assistant, customer, { role: 'admin' })!, /financial administrator/);
  assert.match(userPatchRefusal(env, assistant, merchant, { role: 'admin' })!, /financial administrator/);
});

test('nor demote one', () => {
  assert.match(userPatchRefusal(env, assistant, otherAdmin, { role: 'customer' })!, /financial administrator/);
  assert.match(userPatchRefusal(env, assistant, otherAdmin, { role: 'merchant' })!, /financial administrator/);
});

test('a financial administrator may do both', () => {
  assert.equal(userPatchRefusal(env, full, customer, { role: 'admin' }), null);
  assert.equal(userPatchRefusal(env, full, otherAdmin, { role: 'customer' }), null);
  assert.equal(userPatchRefusal(env, owner, customer, { role: 'admin' }), null);
});

// ------------------------------------------------------------- the owner

test('the owner cannot be demoted by anyone, whatever the case of the stored address', () => {
  assert.match(userPatchRefusal(env, full, ownerRow, { role: 'customer' })!, /owner/);
  assert.match(userPatchRefusal(env, assistant, ownerRow, { role: 'merchant' })!, /owner|financial/);
});

test('nobody removes their own administrator role', () => {
  const self: UserPatchTarget = { id: full.id, role: 'admin', email: full.email, is_investor: 0 };
  assert.match(userPatchRefusal(env, full, self, { role: 'merchant' })!, /own administrator role/);
  const ownerSelf: UserPatchTarget = { id: owner.id, role: 'admin', email: owner.email, is_investor: 0 };
  assert.match(userPatchRefusal(env, owner, ownerSelf, { role: 'customer' })!, /own administrator role/);
});

// ----------------------------------------------- what is NOT an attempt

test('the panel echoes the unchanged row — an unchanged value is not an attempt', () => {
  // An assistant saving an admin's membership tier sends role: 'admin' back.
  assert.equal(userPatchRefusal(env, assistant, otherAdmin, { role: 'admin', is_investor: false }), null);
  // …and sends is_investor: true back for someone who already is one.
  assert.equal(userPatchRefusal(env, assistant, investor, { role: 'customer', is_investor: true }), null);
  assert.equal(userPatchRefusal(env, assistant, customer, { role: 'customer', is_investor: false }), null);
});

test('customer ↔ merchant is an operations task, open to an assistant', () => {
  assert.equal(userPatchRefusal(env, assistant, customer, { role: 'merchant' }), null);
  assert.equal(userPatchRefusal(env, assistant, merchant, { role: 'customer' }), null);
});

// ---------------------------------------------------------------- investors

test('investor status is financial standing: an assistant cannot grant or revoke it', () => {
  assert.match(userPatchRefusal(env, assistant, customer, { is_investor: true })!, /investor/);
  assert.match(userPatchRefusal(env, assistant, investor, { is_investor: false })!, /investor/);
  assert.equal(userPatchRefusal(env, full, customer, { is_investor: true }), null);
});

// -------------------------------------------------------------- admin_scope

test('the admin_scope rule is unchanged: financial only, and the owner is never restricted', () => {
  assert.match(userPatchRefusal(env, assistant, otherAdmin, { admin_scope: 'full' })!, /financial access/);
  assert.match(userPatchRefusal(env, full, ownerRow, { admin_scope: 'assistant' })!, /owner/);
  assert.equal(userPatchRefusal(env, full, otherAdmin, { admin_scope: 'assistant' }), null);
  assert.equal(userPatchRefusal(env, full, otherAdmin, { admin_scope: null }), null);
});
