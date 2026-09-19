/**
 * §11 AT THE ROUTE, NOT AT THE SCREEN — the members console's endpoints.
 *
 *   «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن
 *    العادي لا يراها في API ولا في HTML ولا في export»
 *
 * worker/lib/adminScope.ts states the rule and tests/adminScope.test.ts pins
 * the two pure functions it is made of. What is pinned HERE is the thing those
 * cannot see: whether the ROUTES actually call them.
 *
 * Two defects lived in the gap, and both were reachable by an ordinary
 * restricted assistant with nothing but curl:
 *
 *   1. GET /api/support/admin/members/:userId was mounted behind `requireAdmin`
 *      alone and shipped the BNPL credit limit, the outstanding debt, the
 *      available credit, every ledger amount and every membership's
 *      `price_paid_iqd`. The sibling profile — GET /api/admin/users/:id/detail
 *      — has always omitted its whole `financial` key for the same reader, so
 *      one screen obeyed the rule and its neighbour did not.
 *
 *   2. PUT /api/memberships/admin/bnpl/:userId had no financial check at all,
 *      so that same assistant could GRANT or SUSPEND a line of credit they are
 *      not allowed to be told the size of. The write is an UPSERT, so a suspend
 *      issued without the figure in hand writes the approved line down to 0.
 *
 * THE ASSERTIONS ARE ABOUT THE RAW JSON, deliberately. A field hidden in the
 * browser is still in the devtools network tab, in a saved copy of the page and
 * in any export — which is the wording §11 uses, and the reason this file reads
 * the response body rather than a component.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, put, stubApp, type StubUser } from './fixtures/app';
import { supportRoutes } from '../worker/routes/support';
import { membershipsRoutes } from '../worker/routes/memberships';
import type { DatabaseSync } from 'node:sqlite';

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co', admin_scope: null };
const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };

const MEMBER = 'usr_member';
/** Distinct, odd, five- and six-digit figures: a leak names itself in the raw
 *  body, and an assertion on the digits cannot pass by coincidence. */
const CREDIT_LIMIT = 654_321;
const CHARGE = 123_457;
const PRICE_PAID = 777_111;

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.prepare("INSERT INTO users (id, email, username, name, role) VALUES (?,?,?,?,'customer')")
    .run(MEMBER, 'member@x.co', 'member', 'Member');
  raw.prepare(
    `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, purchased_at)
     VALUES ('mem_1', ?, 'pro_12mo', 'pro', 'active', 12, ?, datetime('now'))`
  ).run(MEMBER, PRICE_PAID);
  raw.prepare("INSERT INTO bnpl_accounts (user_id, state, credit_limit_iqd) VALUES (?, 'approved', ?)")
    .run(MEMBER, CREDIT_LIMIT);
  // An 'adjustment', not a 'charge': migration 0066's guard requires a real
  // BNPL order behind every charge, and this file is about who may READ the
  // amount, not about how a charge comes to exist.
  raw.prepare("INSERT INTO bnpl_ledger (id, user_id, kind, amount_iqd) VALUES ('led_1', ?, 'adjustment', ?)")
    .run(MEMBER, CHARGE);
  return raw;
}

const memberApp = (raw: DatabaseSync, who: StubUser) =>
  stubApp(asD1(raw), who, (a) => a.route('/api/support', supportRoutes));

const bnplApp = (raw: DatabaseSync, who: StubUser) =>
  stubApp(asD1(raw), who, (a) => a.route('/api/memberships', membershipsRoutes));

// ------------------------------------------------------------------- read

test('a restricted assistant reads the member detail with every figure of money ABSENT', async () => {
  const raw = seed();
  const res = await get(memberApp(raw, ASSISTANT), `/api/support/admin/members/${MEMBER}`);
  assert.equal(res.status, 200, 'the screen must still open — this is a scope, not a wall');
  const body = await json(res);
  assert.equal(body.success, true);
  assert.equal(body.can_view_financials, false);

  // ABSENT, NOT ZEROED. A 0 reads as a fact — «this member owes nothing» —
  // which the screen cannot tell apart from the truth and is a worse answer
  // than «محجوب».
  const debt = body.member.debt;
  assert.equal('credit_limit_iqd' in debt, false);
  assert.equal('outstanding_iqd' in debt, false);
  assert.equal('available_iqd' in debt, false);
  for (const row of debt.ledger) assert.equal('amount_iqd' in row, false);
  for (const m of body.member.memberships) assert.equal('price_paid_iqd' in m, false);

  // The raw body is what §11 names, so the raw body is what is searched.
  const wire = JSON.stringify(body);
  for (const secret of [CREDIT_LIMIT, CHARGE, PRICE_PAID]) {
    assert.doesNotMatch(wire, new RegExp(String(secret)), `${secret} reached a restricted admin`);
  }

  // AND THE OPERATIONS SURVIVE. Withholding the size of the line must not
  // withhold whether it exists, or the assistant cannot answer the customer at
  // all and the gate turns into an outage.
  assert.equal(debt.account_state, 'approved');
  assert.equal(typeof debt.eligible, 'boolean');
  assert.equal(debt.ledger[0].kind, 'adjustment', 'the KIND is operations and stays');
  assert.equal(body.member.memberships[0].tier, 'pro');
  assert.equal(body.member.memberships[0].duration_months, 12);
});

test('the owner reads the same endpoint with every figure present', async () => {
  const raw = seed();
  const body = await json(await get(memberApp(raw, OWNER), `/api/support/admin/members/${MEMBER}`));
  assert.equal(body.can_view_financials, true);
  assert.equal(body.member.debt.credit_limit_iqd, CREDIT_LIMIT);
  assert.equal(body.member.debt.outstanding_iqd, CHARGE);
  assert.equal(body.member.debt.ledger[0].amount_iqd, CHARGE);
  assert.equal(body.member.memberships[0].price_paid_iqd, PRICE_PAID);
});

// ------------------------------------------------------------------ write

test('a restricted assistant cannot set or suspend a credit limit', async () => {
  const raw = seed();
  const res = await put(bnplApp(raw, ASSISTANT), `/api/memberships/admin/bnpl/${MEMBER}`, {
    state: 'suspended',
    credit_limit_iqd: 0,
  });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'FORBIDDEN');

  // THE UPSERT IS THE DAMAGE. A suspend carries `credit_limit_iqd` and
  // overwrites the stored one, so a refused request that still ran would have
  // written this member's approved line down to 0 — and the assistant is not
  // allowed to have been told what it was in order to send it back.
  const row = raw.prepare('SELECT state, credit_limit_iqd FROM bnpl_accounts WHERE user_id = ?').get(MEMBER) as
    { state: string; credit_limit_iqd: number };
  assert.equal(row.state, 'approved');
  assert.equal(row.credit_limit_iqd, CREDIT_LIMIT);
});

test('the owner can still suspend a line — the guard is a scope, not a freeze', async () => {
  const raw = seed();
  const res = await put(bnplApp(raw, OWNER), `/api/memberships/admin/bnpl/${MEMBER}`, {
    state: 'suspended',
    credit_limit_iqd: CREDIT_LIMIT,
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  const row = raw.prepare('SELECT state, credit_limit_iqd FROM bnpl_accounts WHERE user_id = ?').get(MEMBER) as
    { state: string; credit_limit_iqd: number };
  assert.equal(row.state, 'suspended');
  assert.equal(row.credit_limit_iqd, CREDIT_LIMIT, 'and the figure the owner sent is the figure stored');
});
