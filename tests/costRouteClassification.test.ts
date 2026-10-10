/**
 * EVERY ADMIN ROUTE IS CLASSIFIED, AND EVERY CLASS IS PROVED — owner decision
 * 2, security spec §7, master plan §4.0 "Route classification", critique A3.
 * Step S1.
 *
 * The classification lives in tests/routeClass/*.ts (vocabulary in
 * tests/routeClass/_types.ts): one file per family of admin routers, each
 * naming every route of every router it covers as cost_read, cost_write,
 * money, owner, op or open. This file holds it to worker/index.ts and to the
 * running code:
 *
 *   STATIC   every mount of worker/index.ts is read (any other spelling of
 *            `app.route(` fails), is in the role-matrix BASE_MOUNTS or
 *            exempted with a reason (critique G-30); every `/api/admin/*`
 *            mount has a file; every
 *            route of every router has a class; no class names a route that is
 *            gone; every op write names a valid body or says why none is needed;
 *            the role-matrix sweeps mount every classified router.
 *   COST     every non-owner admin — assistant, full, legacy NULL, a grantee
 *            while delegation is off, a support assistant — is refused at the
 *            guard with 403 COST_ACCESS_DENIED (the profit preview: 404), with
 *            the SAME body for a real id and an invented one, and the same with
 *            `?include=cost&expand=all&fields=cost_iqd&role=owner&admin_scope=full`
 *            appended; the owner is not refused; and every 2xx the owner gets is
 *            `private, no-store`.
 *   MONEY    an assistant is refused, a full and a legacy admin are not.
 *   OWNER    every other admin is refused, the owner is not.
 *   BODIES   every valid write body a file names is accepted for the owner —
 *            a body nobody can use proves nothing in the write sweep.
 *
 * Run: node --import tsx --test tests/costRouteClassification.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './fixtures/d1';
import { asD1, stubApp, type StubUser } from './fixtures/app';
import { codeOf } from './fixtures/source';
import {
  BASE_MOUNTS,
  OWNER,
  OWNER_UNVERIFIED,
  ROLES,
  call,
  concrete,
  leaks,
  resolveBody,
  seededCopy,
  seededCopyUnverifiedOwner,
  type Router,
  type WriteBody,
} from './fixtures/roleMatrix';
import { serverMessage } from '../packages/contracts/src/costRefusals';
import type { DatabaseSync } from 'node:sqlite';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { ruleOf, type MountClass, type RouteClassFile, type RouteRule } from './routeClass/_types';

// ------------------------------------------------------------- loading

let loaded: Promise<MountClass[]> | null = null;
function classified(): Promise<MountClass[]> {
  loaded ??= (async () => {
    const dir = join(ROOT, 'tests/routeClass');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.startsWith('_')).sort();
    const out: MountClass[] = [];
    for (const f of files) {
      const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default: RouteClassFile };
      assert.ok(mod.default && Array.isArray(mod.default.mounts), `${f} exports a RouteClassFile as default`);
      out.push(...mod.default.mounts);
    }
    return out;
  })();
  return loaded;
}

/**
 * EVERY `app.route('<prefix>', <router>)` of worker/index.ts, in order,
 * comments ignored. Only that one spelling is read — a single-quoted literal
 * prefix and a bare identifier — and the test below counts every
 * `app.route(` call, so a mount written any other way (another quote, a
 * template literal, a computed prefix, a router built inline) fails loudly
 * instead of slipping past the classification unread.
 */
function allIndexMounts(): Array<{ prefix: string; name: string }> {
  const src = codeOf('worker/index.ts');
  return [...src.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)].map((m) => ({ prefix: m[1]!, name: m[2]! }));
}

/** The `/api/admin…` mounts — the ones a tests/routeClass file classifies route by route. */
function indexMounts(): Array<{ prefix: string; name: string }> {
  return allIndexMounts().filter((m) => m.prefix === '/api/admin' || m.prefix.startsWith('/api/admin/'));
}

/** `import { a, b as c } from './…'` of worker/index.ts: local name → module and export. */
function indexImports(): Map<string, { from: string; exported: string }> {
  const out = new Map<string, { from: string; exported: string }>();
  for (const m of codeOf('worker/index.ts').matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/g)) {
    for (const part of m[1]!.split(',')) {
      const spec = part.trim();
      if (!spec || spec.startsWith('type ')) continue;
      const [exported, local] = spec.split(/\s+as\s+/).map((x) => x.trim());
      out.set(local ?? exported!, { from: m[2]!, exported: exported! });
    }
  }
  return out;
}

/** The router object worker/index.ts mounts under `name` — the same module instance the sweeps import. */
async function routerNamed(name: string): Promise<unknown> {
  const imp = indexImports().get(name);
  assert.ok(imp, `worker/index.ts mounts ${name}, but its import could not be read`);
  const mod = (await import(pathToFileURL(join(ROOT, 'worker', `${imp.from}.ts`)).href)) as Record<string, unknown>;
  return mod[imp.exported];
}

/**
 * MOUNTS THE SWEEPS DO NOT CALL, EACH WITH ITS REASON (critique G-30). A new
 * entry needs the same: a sentence that says why no cost can travel through
 * the router, not a shrug. Everything else in worker/index.ts must be in
 * tests/fixtures/roleMatrix.ts BASE_MOUNTS.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // The deception layer's decoys (DECISIONS row 206): its fake `cost` keys
  // would rightly trip the sweeps, which is why it is exempted, not swept.
  '/ decoyRoutes':
    'synthetic decoy answers generated in memory; reads no table and carries no real figure (tests/deceptionDecoys.test.ts proves no stored value appears)',
};

const key = (m: { prefix: string; name: string }) => `${m.prefix} ${m.name}`;

function declared(router: Router): string[] {
  const out = new Set<string>();
  for (const r of router.routes) if (r.method !== 'ALL') out.add(`${r.method} ${r.path}`);
  return [...out];
}

interface Entry {
  mount: MountClass;
  method: string;
  path: string;
  rule: RouteRule;
}
async function entries(filter?: (e: Entry) => boolean): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const mount of await classified()) {
    for (const [route, spec] of Object.entries(mount.routes)) {
      const [method, path] = route.split(' ') as [string, string];
      const e = { mount, method, path, rule: ruleOf(spec) };
      if (!filter || filter(e)) out.push(e);
    }
  }
  return out;
}

const realPath = (e: Entry) => e.rule.path ?? concrete(e.mount.prefix, e.path)[0] ?? `${e.mount.prefix}${e.path}`;
const fakePath = (e: Entry) => `${e.mount.prefix}${e.path.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, 'zz-no-such-id')}`;
const TAMPER = '?include=cost&expand=all&fields=cost_iqd&role=owner&admin_scope=full';

/** The router on its prefix, behind the same no-store layer worker/index.ts mounts on /api/admin/*. */
function mountApp(e: Pick<Entry, 'mount'>, user: StubUser | null, seed: () => DatabaseSync = seededCopy) {
  return stubApp(asD1(seed()), user, (a) => {
    a.use('/api/admin/*', noStoreUnlessSet);
    a.route(e.mount.prefix, e.mount.router);
  });
}

const NON_OWNER_ADMINS = ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'] as const;
const codeOfBody = (b: unknown) => (b && typeof b === 'object' ? ((b as { code?: unknown }).code as string | undefined) : undefined);

// ------------------------------------------------------------- static

test('every /api/admin mount of worker/index.ts has a classification — and no classification outlives its mount', async () => {
  const mounts = indexMounts();
  assert.ok(mounts.length >= 30, `only ${mounts.length} admin mounts found in worker/index.ts`);
  const have = new Set((await classified()).map(key));
  const missing = mounts.filter((m) => !have.has(key(m))).map(key);
  assert.deepEqual(missing, [], 'add a tests/routeClass/<family>.ts entry for these mounts');
  const live = new Set(mounts.map(key));
  const stale = [...have].filter((k) => !live.has(k));
  assert.deepEqual(stale, [], 'these classified mounts are no longer in worker/index.ts');
});

test('every app.route( call of worker/index.ts is read — no mount slips past in another spelling', () => {
  const calls = (codeOf('worker/index.ts').match(/\bapp\.route\(/g) ?? []).length;
  const read = allIndexMounts().length;
  assert.ok(read >= 100, `only ${read} mounts read from worker/index.ts`);
  assert.equal(read, calls, `${calls - read} app.route( calls are not written as app.route('<prefix>', <router>) — spell them that way so they are classified`);
});

test('critique G-30: EVERY mount of worker/index.ts is swept by the role matrix or exempted with a reason', async () => {
  const problems: string[] = [];
  const exemptUsed = new Set<string>();
  for (const m of allIndexMounts()) {
    const router = await routerNamed(m.name);
    const swept = BASE_MOUNTS.some(([p, r]) => p === m.prefix && r === router);
    const exempt = EXEMPT[key(m)];
    if (exempt !== undefined) {
      exemptUsed.add(key(m));
      if (swept) problems.push(`${key(m)} is both swept and exempted — drop the exemption`);
      if (exempt.trim().length <= 20) problems.push(`${key(m)}: an exemption says why in more than 20 characters`);
    } else if (!swept) {
      problems.push(`${key(m)} is neither in tests/fixtures/roleMatrix.ts BASE_MOUNTS nor exempted here`);
    }
  }
  for (const k of Object.keys(EXEMPT)) if (!exemptUsed.has(k)) problems.push(`stale exemption: ${k} is no longer mounted`);
  assert.deepEqual(problems, []);
});

test('every route of every classified router has a class — and no class names a route that is gone', async () => {
  const problems: string[] = [];
  for (const m of await classified()) {
    const routes = declared(m.router);
    for (const r of routes) if (!(r in m.routes)) problems.push(`unclassified: ${m.prefix} ${r}`);
    for (const r of Object.keys(m.routes)) if (!routes.includes(r)) problems.push(`stale: ${m.prefix} ${r}`);
  }
  assert.deepEqual(problems, []);
});

test('critique A3: every op/open write names a valid body or says why none is needed', async () => {
  const silent = await entries(
    (e) => e.method !== 'GET' && (e.rule.cls === 'op' || e.rule.cls === 'open') && e.rule.body === undefined && !e.rule.noBody && !e.mount.writes
  );
  assert.deepEqual(silent.map((e) => `${e.method} ${e.mount.prefix}${e.path}`), []);
  for (const e of await entries((x) => !!x.rule.noBody)) assert.ok(e.rule.noBody!.length > 20, `${e.mount.prefix}${e.path}: say why`);
});

test('the role-matrix sweeps mount every classified router on its own prefix', async () => {
  for (const m of await classified()) {
    assert.ok(
      BASE_MOUNTS.some(([p, r]) => p === m.prefix && r === m.router),
      `${m.prefix} (${m.name}) is not in tests/fixtures/roleMatrix.ts BASE_MOUNTS`
    );
  }
});

test('worker/index.ts puts every admin answer behind the no-store layer the cost check below relies on', () => {
  assert.match(codeOf('worker/index.ts'), /app\.use\('\/api\/admin\/\*', noStoreUnlessSet\);/);
});

// ------------------------------------------------------------- cost

test('COST: every non-owner admin is refused at the guard — one answer for a real id, an invented one, and a tampered query', async () => {
  const cost = await entries((e) => e.rule.cls === 'cost_read' || e.rule.cls === 'cost_write');
  assert.ok(cost.length >= 90, `only ${cost.length} cost routes classified`);
  const problems: string[] = [];
  for (const role of NON_OWNER_ADMINS) {
    const byMount = new Map<MountClass, Entry[]>();
    for (const e of cost) byMount.set(e.mount, [...(byMount.get(e.mount) ?? []), e]);
    for (const [mount, list] of byMount) {
      const app = mountApp({ mount }, ROLES[role]);
      for (const e of list) {
        const status = e.rule.refusal?.status ?? 403;
        const answers = [];
        for (const path of [realPath(e), fakePath(e), `${realPath(e)}${TAMPER}`]) {
          const res = await call(app, e.method, path, {});
          answers.push(res);
          if (res.status !== status) problems.push(`${role} ${e.method} ${path}: ${res.status} (want ${status})`);
          if (status === 403 && codeOfBody(res.body) !== 'COST_ACCESS_DENIED') {
            problems.push(`${role} ${e.method} ${path}: code ${codeOfBody(res.body)}`);
          }
          // The sentence too, byte for byte: the amendment added a second
          // answer for the owner's own session and changed nothing here.
          if (status === 403 && (res.body as { error?: unknown } | null)?.error !== serverMessage('COST_ACCESS_DENIED')) {
            problems.push(`${role} ${e.method} ${path}: the COST_ACCESS_DENIED sentence changed`);
          }
        }
        const [a, b, c] = answers.map((x) => JSON.stringify(x.body));
        if (a !== b || a !== c) problems.push(`${role} ${e.method} ${e.mount.prefix}${e.path}: the refusal differs between a real id, a fake id and a tampered query`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('COST, DECISIONS row 185 amendment: the owner before the address is verified hears OWNER_EMAIL_UNVERIFIED at every cost route — one answer for a real id, an invented one and a tampered query, and no cost in it', async () => {
  const cost = await entries((e) => e.rule.cls === 'cost_read' || e.rule.cls === 'cost_write');
  assert.ok(cost.length >= 90);
  const problems: string[] = [];
  const byMount = new Map<MountClass, Entry[]>();
  for (const e of cost) byMount.set(e.mount, [...(byMount.get(e.mount) ?? []), e]);
  for (const [mount, list] of byMount) {
    const app = mountApp({ mount }, OWNER_UNVERIFIED, seededCopyUnverifiedOwner);
    for (const e of list) {
      const answers: string[] = [];
      for (const path of [realPath(e), fakePath(e), `${realPath(e)}${TAMPER}`]) {
        const res = await call(app, e.method, path, {});
        answers.push(JSON.stringify(res.body));
        // Every cost route, the profit preview's 404 included: the way out, with nothing about the target.
        if (res.status !== 403 || codeOfBody(res.body) !== 'OWNER_EMAIL_UNVERIFIED') {
          problems.push(`${e.method} ${path}: ${res.status} ${codeOfBody(res.body)}`);
        }
        for (const l of leaks(res.body)) problems.push(`${e.method} ${path}: cost in the refusal ${l}`);
      }
      if (answers[0] !== answers[1] || answers[0] !== answers[2]) {
        problems.push(`${e.method} ${e.mount.prefix}${e.path}: the answer differs between a real id, a fake id and a tampered query`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('COST: nobody but the owner-address admin can ever hear OWNER_EMAIL_UNVERIFIED — not a guest, a customer, a merchant, another admin, or a non-admin row holding the owner address in any spelling', async () => {
  const cost = await entries((e) => e.rule.cls === 'cost_read' || e.rule.cls === 'cost_write');
  const callers: Array<[string, StubUser | null]> = [
    ['guest', null],
    ['customer', ROLES.customer],
    ['merchant', ROLES.merchant],
    ['assistant', ROLES.assistant],
    ['full', ROLES.full],
    ['unverified full admin', { ...ROLES.full!, email_verified_at: null }],
    ['customer with the owner address', { id: 'u1', role: 'customer', email: 'boss@x.co', email_verified_at: null }],
    ['merchant with the owner address, upper case', { id: 'u_m', role: 'merchant', email: 'BOSS@X.CO', email_verified_at: null }],
    ['customer with the owner address, padded', { id: 'u1', role: 'customer', email: '  Boss@x.co ', email_verified_at: null }],
    ['admin with a lookalike address', { id: 'usr_full', role: 'admin', email: 'boss@x.co.evil', admin_scope: 'full', email_verified_at: null }],
  ];
  const problems: string[] = [];
  // One route per mount is enough for the non-admins (requireAdmin stops them
  // before any cost door); every route for the admins.
  const byMount = new Map<MountClass, Entry[]>();
  for (const e of cost) byMount.set(e.mount, [...(byMount.get(e.mount) ?? []), e]);
  for (const [who, user] of callers) {
    const admin = user?.role === 'admin';
    for (const [mount, list] of byMount) {
      const app = mountApp({ mount }, user, seededCopyUnverifiedOwner);
      for (const e of admin ? list : list.slice(0, 1)) {
        const res = await call(app, e.method, realPath(e), {});
        if (codeOfBody(res.body) === 'OWNER_EMAIL_UNVERIFIED') problems.push(`${who} ${e.method} ${realPath(e)}`);
        if (res.status >= 200 && res.status < 300) problems.push(`${who} ${e.method} ${realPath(e)}: answered ${res.status}`);
        if (admin && e.rule.refusal?.status !== 404 && codeOfBody(res.body) !== 'COST_ACCESS_DENIED') {
          problems.push(`${who} ${e.method} ${realPath(e)}: ${res.status} ${codeOfBody(res.body)} (want COST_ACCESS_DENIED)`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('COST: the owner is not refused by the guard (and the 404 route answers the owner)', async () => {
  const cost = await entries((e) => e.rule.cls === 'cost_read' || e.rule.cls === 'cost_write');
  const problems: string[] = [];
  const byMount = new Map<MountClass, Entry[]>();
  for (const e of cost) byMount.set(e.mount, [...(byMount.get(e.mount) ?? []), e]);
  for (const [mount, list] of byMount) {
    const app = mountApp({ mount }, OWNER);
    for (const e of list) {
      const res = await call(app, e.method, realPath(e), {});
      if (res.status === 403 || codeOfBody(res.body) === 'COST_ACCESS_DENIED') problems.push(`${e.method} ${realPath(e)}: ${res.status}`);
      if (e.rule.refusal?.status === 404 && res.status === 404) problems.push(`${e.method} ${realPath(e)}: the owner gets the refusal`);
      if (res.status >= 500) problems.push(`${e.method} ${realPath(e)}: ${res.status} for the owner`);
    }
  }
  assert.deepEqual(problems, []);
});

test('COST: every 2xx the owner reads from a cost route is private, no-store (§34)', async () => {
  const reads = await entries((e) => e.rule.cls === 'cost_read');
  let answered = 0;
  const problems: string[] = [];
  for (const e of reads) {
    const res = await call(mountApp(e, OWNER), 'GET', realPath(e));
    if (res.status < 200 || res.status >= 300) continue;
    answered += 1;
    const cc = res.headers.get('cache-control') ?? '';
    if (!/no-store/.test(cc) || !/private/.test(cc)) problems.push(`${realPath(e)}: Cache-Control "${cc}"`);
  }
  assert.ok(answered >= 25, `only ${answered} cost reads answered the owner — the check proves little`);
  assert.deepEqual(problems, []);
});

// ------------------------------------------------------------- money and owner

test('MONEY: an assistant is refused at the guard; full and legacy NULL-scope admins are not', async () => {
  const money = await entries((e) => e.rule.cls === 'money');
  assert.ok(money.length >= 20, `only ${money.length} money routes classified`);
  const problems: string[] = [];
  for (const e of money) {
    const want = e.rule.refusal?.code ?? 'FINANCIAL_SCOPE_REQUIRED';
    for (const role of ['assistant', 'support_assistant'] as const) {
      const res = await call(mountApp(e, ROLES[role]), e.method, realPath(e), {});
      if (res.status !== 403 || codeOfBody(res.body) !== want) problems.push(`${role} ${e.method} ${realPath(e)}: ${res.status} ${codeOfBody(res.body)}`);
    }
    for (const role of ['full', 'legacy_null'] as const) {
      const res = await call(mountApp(e, ROLES[role]), e.method, realPath(e), {});
      if (res.status === 403) problems.push(`${role} ${e.method} ${realPath(e)}: refused (${codeOfBody(res.body)}) — decision 2 keeps money with full admins`);
    }
  }
  assert.deepEqual(problems, []);
});

test('OWNER: every other admin is refused; the owner is not', async () => {
  const owner = await entries((e) => e.rule.cls === 'owner');
  assert.ok(owner.length >= 2);
  const problems: string[] = [];
  for (const e of owner) {
    for (const role of NON_OWNER_ADMINS) {
      const res = await call(mountApp(e, ROLES[role]), e.method, realPath(e), {});
      const want = e.rule.refusal?.code;
      if (res.status !== 403 || (want && codeOfBody(res.body) !== want)) problems.push(`${role} ${e.method} ${realPath(e)}: ${res.status} ${codeOfBody(res.body)}`);
    }
    const res = await call(mountApp(e, OWNER), e.method, realPath(e), {});
    if (res.status === 403) problems.push(`owner ${e.method} ${realPath(e)}: refused`);
  }
  assert.deepEqual(problems, []);
});

// ------------------------------------------------------------- the bodies

test('every valid write body a classification names is accepted for the owner', async () => {
  const withBody = await entries((e) => e.method !== 'GET' && e.rule.body !== undefined);
  assert.ok(withBody.length >= 25, `only ${withBody.length} valid bodies — the write sweep would prove little`);
  const problems: string[] = [];
  for (const e of withBody) {
    const app = mountApp(e, OWNER);
    const res = await call(app, e.method, realPath(e), await resolveBody(app, e.rule.body as WriteBody));
    if (res.status < 200 || res.status >= 300) problems.push(`${e.method} ${realPath(e)}: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  }
  assert.deepEqual(problems, []);
});
