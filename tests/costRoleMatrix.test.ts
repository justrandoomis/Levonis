/**
 * THE ROLE MATRIX: every GET route a cost could travel through, swept as every
 * caller who must see none — owner decision 2 (2026-10-07), step S1.
 *
 * tests/costLeaksPhase0.test.ts pins the leaks the audit found, one by one.
 * This file is the net for the ones nobody has found yet: it mounts every
 * product-, cart-, order-, wallet-, inventory-, procurement-, pricing- and
 * finance-facing router the way worker/index.ts does (every `/api/admin/*`
 * mount included — tests/fixtures/roleMatrix.ts `BASE_MOUNTS`), enumerates
 * each one's GET routes from Hono itself (so a route added tomorrow is swept
 * tomorrow), fills the path parameters with the seeded product, lot, purchase
 * and order, and calls each as every role of the fixture:
 *
 *   guest, customer, merchant, assistant, full, legacy_null, grantee_off,
 *   employee, investor, support_assistant
 *
 * Any 2xx answer is walked to its last leaf. It fails on a key naming cost
 * that carries a number, on ANY key of FINANCIAL_FIELDS that carries a value,
 * and on any value — number, decimal, or digits inside a string such as an
 * exported .txt or .csv — equal to one of the seeded costs. A refusal is a
 * pass: what is not served cannot leak.
 *
 * `full` and `legacy_null` are the two that saw every cost before S1. They
 * keep their money screens (asserted below) and see no cost. The owner is
 * swept in the opposite direction: the seeded costs must reach the owner on
 * the screens that exist to show them, or the fixture is not reaching the
 * places this file claims to search.
 *
 * Run: node --import tsx --test tests/costRoleMatrix.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_MOUNTS,
  OWNER,
  OWNER_UNVERIFIED,
  ROLES,
  getPaths,
  seededCopyUnverifiedOwner,
  sweepGets,
  type RoleName,
  type SweepResult,
} from './fixtures/roleMatrix';

const PATHS = getPaths();

/** One sweep per role, computed once and shared by the tests that read it. */
const cache = new Map<string, Promise<SweepResult>>();
function sweep(role: RoleName | 'owner' | 'owner_unverified'): Promise<SweepResult> {
  let p = cache.get(role);
  if (!p) {
    // The owner before the address is verified reads a database whose owner
    // row carries no stamp either (DECISIONS row 185 amendment).
    p =
      role === 'owner_unverified'
        ? sweepGets({ roles: { [role]: OWNER_UNVERIFIED }, seed: seededCopyUnverifiedOwner }).then((r) => r[role]!)
        : sweepGets({ roles: { [role]: role === 'owner' ? OWNER : ROLES[role] } }).then((r) => r[role]!);
    cache.set(role, p);
  }
  return p;
}

/** How many 2xx answers each role must at least reach — a sweep that reaches nothing proves nothing. */
const FLOOR: Record<RoleName, number> = {
  guest: 25,
  customer: 50,
  merchant: 50,
  assistant: 150,
  full: 150,
  legacy_null: 150,
  grantee_off: 150,
  employee: 50,
  investor: 50,
  support_assistant: 150,
};

test('the sweep reaches a real number of routes, every /api/admin mount included (or it proves nothing)', () => {
  assert.ok(PATHS.length > 300, `only ${PATHS.length} GET paths were enumerated`);
  const prefixes = new Set(BASE_MOUNTS.map(([p]) => p));
  for (const p of ['/api/admin/finance', '/api/admin/community', '/api/admin/wallet-adjust', '/api/admin/chats', '/api/admin/media', '/api/invest', '/api/wallet']) {
    assert.ok(prefixes.has(p), `${p} is mounted in the sweep`);
  }
});

for (const role of Object.keys(ROLES) as RoleName[]) {
  test(`no GET answer to ${role} carries a cost (${PATHS.length} paths)`, async () => {
    const r = await sweep(role);
    assert.ok(r.answered >= FLOOR[role], `only ${r.answered} routes answered ${role} — the sweep is not reaching anything`);
    assert.deepEqual(r.leaks, [], `cost reached ${role}:\n${r.leaks.join('\n')}`);
  });
}

test('DECISIONS row 185 amendment — the owner BEFORE the address is verified: no GET answer or refusal carries a cost, and every cost door says OWNER_EMAIL_UNVERIFIED', async () => {
  const r = await sweep('owner_unverified');
  assert.ok(r.answered >= 150, `only ${r.answered} routes answered the unverified owner — the sweep is not reaching anything`);
  assert.deepEqual(r.leaks, [], `cost reached the unverified owner:\n${r.leaks.join('\n')}`);
  // Never the generic refusal: every door that refuses this session names the way out.
  const generic = Object.entries(r.codes).filter(([, c]) => c === 'COST_ACCESS_DENIED').map(([p]) => p);
  assert.deepEqual(generic, [], 'a cost door answered the unverified owner with COST_ACCESS_DENIED instead of OWNER_EMAIL_UNVERIFIED');
  const owner = await sweep('owner');
  const problems: string[] = [];
  let wayOut = 0;
  for (const path of owner.costSeen) {
    const status = r.statuses[path];
    if (status === undefined || status >= 500) problems.push(`${path}: ${status}`);
    else if (status === 403) {
      if (r.codes[path] !== 'OWNER_EMAIL_UNVERIFIED') problems.push(`${path}: 403 ${r.codes[path]}`);
      else wayOut += 1;
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(wayOut >= 5, `the unverified owner was shown the way out on only ${wayOut} of the owner's cost screens`);
  // The finance screens are shut to this session, every one of them, with the way out.
  const finance = PATHS.filter((p) => /^\/api\/admin\/(finance|finance-workspace|finance-people|finance-operations)(\/|$)/.test(p));
  const open = finance.filter((p) => r.statuses[p] !== 403 || r.codes[p] !== 'OWNER_EMAIL_UNVERIFIED');
  assert.deepEqual(open, []);
});

test('the owner sees the seeded costs where they live: the product, the lot, the order, the finance screens', async () => {
  const r = await sweep('owner');
  for (const path of [
    '/api/admin/products-v2/p_a1',
    '/api/admin/products/p_a1/price-grid',
    '/api/admin/inventory/overview',
    '/api/admin/inventory/incoming',
    '/api/admin/finance-workspace/orders/ord1',
    '/api/admin/finance-workspace/summary',
    '/api/admin/finance-operations/orders/ord1/profit',
    '/api/admin/template/export/p_a1',
  ]) {
    assert.ok(r.costSeen.includes(path), `the owner saw no cost on ${path} — the fixture no longer reaches it`);
  }
  assert.ok(r.costSeen.length >= 15, `the owner saw cost on only ${r.costSeen.length} routes: ${r.costSeen.join(', ')}`);
});

test('wherever the owner saw a cost, every non-owner admin got a refusal or a clean answer — and never a crash', async () => {
  const owner = await sweep('owner');
  const problems: string[] = [];
  for (const role of ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'] as const) {
    const r = await sweep(role);
    for (const path of owner.costSeen) {
      const status = r.statuses[path];
      if (status === undefined || status >= 500) problems.push(`${role} ${path}: ${status}`);
    }
    // The clean-answer half is the leak sweep above; this prints where they stood.
    const refused = owner.costSeen.filter((p) => r.statuses[p] === 403);
    assert.ok(refused.length > 0, `${role} was refused nowhere the owner saw cost`);
  }
  assert.deepEqual(problems, []);
});

test('decision 2 keeps MONEY with full and legacy admins: their money screens answer, an assistant’s do not', async () => {
  const money = [
    '/api/admin/wallet-adjust/rounding-drift',
    '/api/admin/community/payouts',
    '/api/admin/community/reconciliation/store-orders',
    '/api/admin/community/ledger/parity',
  ];
  for (const role of ['full', 'legacy_null', 'grantee_off'] as const) {
    const r = await sweep(role);
    for (const p of money) assert.equal(r.statuses[p], 200, `${role} keeps ${p}`);
  }
  const a = await sweep('assistant');
  for (const p of money) assert.equal(a.statuses[p], 403, `an assistant is refused ${p}`);
});

test('the finance screens are the owner’s alone: full and legacy admins are refused at the door', async () => {
  const owner = await sweep('owner');
  const finance = PATHS.filter((p) =>
    /^\/api\/admin\/(finance|finance-workspace|finance-people|finance-operations)(\/|$)/.test(p)
  );
  assert.ok(finance.length > 20);
  for (const role of ['full', 'legacy_null', 'grantee_off'] as const) {
    const r = await sweep(role);
    const open = finance.filter((p) => r.statuses[p] !== 403);
    assert.deepEqual(open, [], `${role} reached a finance route`);
  }
  assert.ok(finance.filter((p) => owner.statuses[p] === 200).length > 15, 'the owner reaches them');
});

test('«التسعير والشحن» (pricing engine MVP P1): the owner reads cost there; every other admin is refused at its door with COST_ACCESS_DENIED; customers and guests never reach it', async () => {
  const detail = '/api/admin/pricing/products/p_a1';
  const routes = ['/api/admin/pricing/overview', detail];
  assert.ok(routes.every((p) => PATHS.includes(p)), 'the sweep enumerates the pricing router');
  const owner = await sweep('owner');
  for (const p of routes) assert.equal(owner.statuses[p], 200, `the owner reads ${p}`);
  assert.ok(owner.costSeen.includes(detail), 'the owner sees the costly product’s landed cost there');
  for (const role of ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'] as const) {
    const r = await sweep(role);
    for (const p of routes) {
      assert.equal(r.statuses[p], 403, `${role} ${p}`);
      assert.equal(r.codes[p], 'COST_ACCESS_DENIED', `${role} ${p}`);
    }
  }
  for (const role of ['customer', 'merchant', 'employee', 'investor'] as const) {
    const r = await sweep(role);
    for (const p of routes) assert.equal(r.statuses[p], 403, `${role} ${p}`);
  }
  const guest = await sweep('guest');
  for (const p of routes) assert.equal(guest.statuses[p], 401, `guest ${p}`);
  const unverified = await sweep('owner_unverified');
  for (const p of routes) assert.equal(unverified.codes[p], 'OWNER_EMAIL_UNVERIFIED', `unverified owner ${p}`);
});
