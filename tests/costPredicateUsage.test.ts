/**
 * ONE PREDICATE FAMILY, NO ALIASES — owner decision 2, master plan §2.1 and
 * conflict C1/C2, step S1.
 *
 * Before S1 one predicate (`canViewFinancials`) answered "may this admin see a
 * cost?" and "may this admin move money?" at once, and every full or NULL
 * scope admin saw every cost. The area specs then invented five more names for
 * the owner check. This file is the static net that keeps it at one family:
 *
 *   - `canViewFinancials` and the C1 alias names never come back in code;
 *   - the predicates are DEFINED in worker/lib/adminScope.ts and nowhere else;
 *   - every cost router has a door — rate limit first, then the cost guard —
 *     on a `use()` line that runs before any route reads an id;
 *   - delegation is off (PRIVATE_DELEGATION_ENABLED === false);
 *   - a non-owner hears one refusal code, COST_ACCESS_DENIED (C2), and none of
 *     the dropped codes of §6.1 exists anywhere.
 *
 * Run: node --import tsx --test tests/costPredicateUsage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { codeOf } from './fixtures/source';
import { PRIVATE_DELEGATION_ENABLED } from '../worker/lib/adminScope';
import { costDenied } from '../worker/lib/costAccess';

const SCAN = ['worker', 'packages', 'services', 'src', 'scripts'];

function files(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) files(relative(ROOT, p), out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}
const ALL = SCAN.flatMap((d) => files(d));

/** Source with comments removed, string-aware (tests/fixtures/source.ts). */
const code = codeOf;

test('the scan reaches the code it claims to scan', () => {
  assert.ok(ALL.includes('worker/lib/adminScope.ts'));
  assert.ok(ALL.includes('packages/platform-kit/src/scope.ts'));
  assert.ok(ALL.includes('src/pages/Admin.tsx'));
  assert.ok(ALL.length > 500, `only ${ALL.length} files scanned`);
});

test('`canViewFinancials` is gone from every line of code (comments may still name it as history)', () => {
  const offenders = ALL.filter((f) => /\bcanViewFinancials\b/.test(code(f)));
  assert.deepEqual(offenders, [], 'the old one-predicate rule is back');
});

test('C1: none of the alias names the area specs invented exists, in code or as a shim file', () => {
  const aliases = /\b(canReadPricingPrivate|canWritePricingPrivate|projectPricingPrivate|assertPricingPrivate)\b/;
  assert.deepEqual(ALL.filter((f) => aliases.test(code(f))), []);
  for (const shim of ['worker/lib/pricingEngine/access.ts', 'worker/lib/pricingPrivate/access.ts']) {
    assert.equal(existsSync(join(ROOT, shim)), false, `${shim} is a shim C1 deletes`);
  }
});

test('the predicates are DEFINED in worker/lib/adminScope.ts and nowhere else', () => {
  const def = (name: string) => new RegExp(`(function\\s+${name}\\s*[(<]|(const|let|var)\\s+${name}\\s*[=:])`);
  for (const name of ['canViewCost', 'canWriteCost', 'canMoveMoney', 'viewerClass', 'hasPrivateGrant', 'projectForAdmin']) {
    const where = ALL.filter((f) => def(name).test(code(f)));
    assert.deepEqual(where, ['worker/lib/adminScope.ts'], `${name} is defined once`);
  }
  // stripFinancials has exactly ONE more definition: the byte-identical copy
  // the dark gateway carries, pinned by tests/edgeParity.test.ts.
  assert.deepEqual(
    ALL.filter((f) => def('stripFinancials').test(code(f))).sort(),
    ['packages/platform-kit/src/scope.ts', 'worker/lib/adminScope.ts']
  );
  // `isOwner` is also a common LOCAL name for "owns this resource" (print
  // requests, marketplace, uploads); only the env-taking owner predicate counts.
  const owner = ALL.filter((f) => /function\s+isOwner\s*\(\s*env\b/.test(code(f)));
  assert.deepEqual(owner, ['worker/lib/adminScope.ts']);
});

test('delegation is OFF (decision 2): the constant, and the literal a reviewer reads', () => {
  assert.equal(PRIVATE_DELEGATION_ENABLED, false);
  assert.match(readFileSync(join(ROOT, 'worker/lib/adminScope.ts'), 'utf8'), /^export const PRIVATE_DELEGATION_ENABLED = false;$/m);
  // Nothing passes `delegation: true` in shipped code — that switch is for tests.
  const shipped = ALL.filter((f) => !f.startsWith('scripts/') && /delegation\s*:\s*true/.test(code(f)));
  assert.deepEqual(shipped, []);
});

test('C2: a non-owner hears COST_ACCESS_DENIED, and none of the dropped codes exists anywhere', () => {
  assert.equal(costDenied().code, 'COST_ACCESS_DENIED');
  assert.equal(costDenied().status, 403);
  const dropped = [
    'PRICING_OWNER_ONLY',
    'PRICING_PRIVATE_REQUIRED',
    'PRICE_NOT_READY',
    'PRODUCT_NOT_AVAILABLE_NOW',
    'PRICING_MANAGED',
    'PRICE_MANAGED_BY_ENGINE',
    'PRICE_PINNED_MANUAL',
    'STALE_PRICING',
    'PRICING_VERSION_CHANGED',
    'PRICING_NOT_MIGRATED',
    'PRICING_NOT_READY',
    'ENGINE_BATCH_NOT_UNDOABLE',
    'PRICING_OPERATION_REUSED',
    'PRICING_COMPOSITION_NOT_SUPPORTED',
    'PRICING_HIDE_NOT_ACCEPTED',
  ];
  const re = new RegExp(`['"\`](${dropped.join('|')})['"\`]`);
  assert.deepEqual(ALL.filter((f) => re.test(code(f))), [], 'a dropped refusal code is in use');
});

// ------------------------------------------------------------- the doors

/**
 * The dedicated cost routers. Each one's door is a `use()` line carrying the
 * rate limit and then `requireCostRead` (or `requireOwner`), and it sits
 * above the first route the router declares — so a refused caller spends
 * budget, and no handler ever runs (or reads an id) before the guard.
 */
const COST_ROUTERS: Array<{ file: string; router: string; guard: RegExp; paths?: string[] }> = [
  { file: 'worker/routes/adminFinance.ts', router: 'adminFinanceRoutes', guard: /requireCostRead/ },
  { file: 'worker/routes/adminFinanceReport.ts', router: 'adminFinanceReportRoutes', guard: /requireCostRead/ },
  { file: 'worker/routes/adminFinanceWorkspace.ts', router: 'adminFinanceWorkspaceRoutes', guard: /requireCostRead/ },
  { file: 'worker/routes/adminFinancePeople.ts', router: 'adminFinancePeopleRoutes', guard: /requireCostRead/ },
  { file: 'worker/routes/adminFinanceOperations.ts', router: 'adminFinanceOperationsRoutes', guard: /requireCostRead/ },
  // Path-scoped on purpose: it is mounted at the root of investment-finance.
  {
    file: 'worker/routes/adminInvestmentProfiles.ts',
    router: 'adminInvestmentProfilesRoutes',
    guard: /requireCostRead/,
    paths: ['/profiles', '/profiles/*', '/legacy', '/legacy/*'],
  },
];
// Routers a later step adds: if the file exists, it carries its door.
const LATER_ROUTERS: Array<{ file: string; guard: RegExp }> = [
  { file: 'worker/routes/adminSecurity.ts', guard: /requireOwner/ },
  { file: 'worker/routes/adminPricing.ts', guard: /requireCost(Read|Write)/ },
];

function firstRouteAt(src: string, router: string): number {
  const m = new RegExp(`\\b${router}\\s*\\.\\s*(get|post|put|patch|delete)\\s*\\(`).exec(src);
  return m ? m.index : Number.POSITIVE_INFINITY;
}

for (const r of COST_ROUTERS) {
  test(`${r.file}: the door — rate limit, then the cost guard — runs before every route`, () => {
    const src = code(r.file);
    let doorAt: number;
    if (r.paths) {
      const door = /const\s+(\w+)\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/.exec(src);
      assert.ok(door, 'a named door');
      const [, name, parts] = door!;
      assert.match(parts!, /limitByMethod\([^)]*\)[\s\S]*,\s*requireCostRead/, 'the limit first, then the guard');
      const loop = new RegExp(`for\\s*\\(const\\s+\\w+\\s+of\\s+\\[([^\\]]*)\\]\\)\\s*${r.router}\\.use\\(\\w+,\\s*\\.\\.\\.${name}\\)`).exec(src);
      assert.ok(loop, 'the door is mounted on its paths with use()');
      for (const p of r.paths) assert.ok(loop![1]!.includes(`'${p}'`), `the door covers ${p}`);
      doorAt = loop!.index;
    } else {
      const use = new RegExp(`${r.router}\\.use\\(\\s*'\\*'\\s*,\\s*limitByMethod\\([^)]*\\]\\s*\\)\\s*,\\s*requireCostRead\\s*\\)`).exec(src);
      assert.ok(use, `${r.router}.use('*', limitByMethod(…), requireCostRead)`);
      doorAt = use!.index;
    }
    assert.ok(doorAt < firstRouteAt(src, r.router), 'the door is declared above the first route');
    assert.match(src, r.guard);
  });
}

test('a later cost router, once it exists, carries its own door', () => {
  for (const r of LATER_ROUTERS) {
    if (!existsSync(join(ROOT, r.file))) continue;
    const src = code(r.file);
    assert.match(src, new RegExp(`\\.use\\(\\s*'\\*'[^;]*${r.guard.source}`), `${r.file} has a use('*') door`);
  }
});

test('the legacy investment register (/api/admin/invest/*) is behind the cost-read gate', () => {
  const src = code('worker/routes/admin.ts');
  assert.match(src, /adminRoutes\.use\('\/invest\/\*',\s*async \(c, next\) => \{\s*assertCostRead\(c\);/);
});

test('money guards stay MONEY: assertFinancialScope is canMoveMoney, not a cost predicate', () => {
  const src = code('worker/lib/walletAdjust.ts');
  const fn = src.slice(src.indexOf('export function assertFinancialScope'), src.indexOf('export async function requireFinancialScope'));
  assert.match(fn, /canMoveMoney\(c\.env, c\.get\('user'\)\)/);
  assert.doesNotMatch(fn, /canViewCost|canWriteCost/);
});

test('every projection of an admin payload goes through the cost-based projectForAdmin', () => {
  const src = code('worker/lib/adminScope.ts');
  const fn = src.slice(src.indexOf('export function projectForAdmin'));
  assert.match(fn.slice(0, 200), /return canViewCost\(env, user\) \? payload : stripFinancials\(payload\);/);
});
