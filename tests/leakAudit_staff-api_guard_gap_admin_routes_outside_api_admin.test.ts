/**
 * LEAK AUDIT — staff-api: the admin routes mounted OUTSIDE `/api/admin/*`.
 *
 * About 130 admin routes live on routers mounted under a non-admin prefix:
 * `/api/returns/admin/*`, `/api/price-protection/admin/*`, `/api/devices/admin/*`
 * (the serial inventory included), `/api/gifts/admin/*`, `/api/reviews/admin/*`,
 * `/api/wallet/admin/*`, `/api/memberships/admin/*`, `/api/kyc/admin/*`,
 * `/api/support/admin/*`, `/api/telegram/admin/*`, `/api/referrals/admin/*`,
 * `/api/policies/admin/*` and the inline ones (`/api/invoices/:id/{revise,resend}`).
 * Several touch cost-bearing rows: the return transition restores a sold
 * unit's lot (and its COGS) through `planLotRestore`; the device units carry
 * `inventory_lot_id`; the serial inventory and its assignments sit on lots.
 *
 * Three nets protect an admin answer, and all three are keyed on the PREFIX
 * `/api/admin`:
 *
 *   1. worker/index.ts applies `noStoreUnlessSet` («No shared or stored copy of
 *      an admin or cart answer») and `securityEventsDoor` to `/api/admin/*`
 *      (and `/api/cart*`) only;
 *   2. tests/costRouteClassification.test.ts classifies only the mounts whose
 *      prefix is `/api/admin…` (`indexMounts()`), so none of these routes has a
 *      class and none is held to the COST/MONEY/OWNER/BODIES proofs;
 *   3. the role-matrix sweep (tests/costRoleMatrix.test.ts) does call them, but
 *      the seeded database holds no return case, claim, device unit, serial or
 *      ticket, and PARAM fills `:id`/`:unitId`/`:serial` with the product id —
 *      so the lists come back empty and the id routes answer 404: walked, but
 *      over nothing.
 *
 * This file drives the REAL Worker (worker/index.ts fetch, a real session row
 * and cookie per role, the apex host) on a role-matrix database to which it
 * adds the rows those routes read — a return case, a price-protection claim,
 * a delivered device unit taken from the costly lot, its serial in the serial
 * inventory, linked to the lot and assigned on the order, a warranty claim and
 * a support ticket on the same order — and:
 *
 *   A. VALUE: walks every GET answer (and the cost-touching writes: the return
 *      refund that restores the lot, the claim approval) for every non-owner
 *      admin with the shared leak scanner. No private value may appear.
 *   B. CACHE NET: every 2xx admin answer leaves `private, no-store`, exactly as
 *      the same session's `/api/admin/*` answers do (the owner's list names
 *      «Cache» as a channel).
 *   C. CLASS NET: every one of these routes has a class in tests/routeClass.
 *   D. SWEEP NET: the role-matrix seed holds a row for these routes to answer
 *      with, or the sentinel sweep proves nothing about them.
 *
 * A is the leak; B–D are the guard gap the candidate names. A failing B, C or
 * D with a passing A is a guard gap with no value seen leaking (today).
 *
 * LOCAL ONLY: an in-memory SQLite copy of the role-matrix database, the real
 * Worker and route modules, no network, no live host.
 *
 * Run: node --import tsx --test tests/leakAudit_staff-api_guard_gap_admin_routes_outside_api_admin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { sha256Hex } from '../worker/lib/crypto';
import { ROOT } from './fixtures/d1';
import { APEX, asD1, ctx } from './fixtures/app';
import { COST } from './fixtures/costlyProduct';
import { ADMIN_ROLES, BASE_MOUNTS, NOT_A_COST, OWNER, ROLES, leaks, seededCopy, type RoleName } from './fixtures/roleMatrix';
import type { RouteClassFile } from './routeClass/_types';

// ------------------------------------------------------------- the surface

interface AdminRoute {
  method: string;
  prefix: string;
  path: string;
  /** `METHOD /full/path` as the Worker serves it. */
  key: string;
}

/** Routes behind `requireAdmin` inline that carry no `/admin` segment (tests/adminHostGuard.test.ts names them). */
const INLINE_ADMIN = new Set(['POST /api/invoices/:id/revise', 'POST /api/invoices/:id/resend', 'POST /api/translate']);

const isAdminPrefix = (p: string) => p === '/api/admin' || p.startsWith('/api/admin/');

/**
 * Every admin route of the role-matrix mounts (which are worker/index.ts's
 * mounts — tests/costRouteClassification.test.ts holds the two to each other)
 * whose MOUNT is not under `/api/admin`.
 */
function offPrefixAdminRoutes(): AdminRoute[] {
  const out: AdminRoute[] = [];
  const seen = new Set<string>();
  for (const [prefix, router] of BASE_MOUNTS) {
    if (isAdminPrefix(prefix)) continue;
    for (const r of router.routes) {
      if (r.method === 'ALL') continue;
      const full = `${prefix}${r.path === '/' ? '' : r.path}`.replace(/\/{2,}/g, '/');
      const key = `${r.method} ${full}`;
      if (!/\/admin(\/|$)/.test(full) && !INLINE_ADMIN.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method: r.method, prefix, path: r.path, key });
    }
  }
  return out;
}

const SURFACE = offPrefixAdminRoutes();

// ------------------------------------------------------------- the world

/** Ids of the rows this file adds — every one of them on the costly order `ord1` / line `oi1` / lot `lot1`. */
const IDS = {
  returnCase: 'rc_leak1',
  claim: 'ppc_leak1',
  unit: 'unit_leak1',
  serial: 'SNLEAKAUDIT0001',
  warrantyClaim: 'wc_leak1',
  ticket: 'tk_leak1',
  assignment: 'sa_leak1',
} as const;

const NON_OWNER_ADMINS = ADMIN_ROLES as readonly RoleName[];
const SESSION_USERS: Record<string, string> = Object.fromEntries([
  ...NON_OWNER_ADMINS.map((r) => [r, ROLES[r]!.id] as const),
  ['owner', OWNER.id] as const,
]);
const tokenOf = (who: string) => `leak-audit-offprefix-session-${who}-000000000001`;

/**
 * The role-matrix database (the costly product, its lot `lot1` at
 * COST.lotUnit, the delivered order `ord1` whose line `oi1` carries
 * COST.orderLine and whose allocation out of `lot1` carries COST.orderCogs)
 * plus what the off-prefix admin routes read, and one session per caller.
 */
async function world(): Promise<DatabaseSync> {
  const raw = seededCopy();
  raw.exec(`
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,
                                  warranty_base_months,warranty_start_at,warranty_end_at,policy_version,inventory_lot_id)
      VALUES ('${IDS.unit}','ord1','oi1','p_a1','u1',1,'2026-09-02T10:00:00Z',12,'2026-09-02T10:00:00Z','2027-09-02T10:00:00Z','v1','lot1');
    INSERT INTO device_serials (serial_norm,serial_raw,unit_id,assigned_by) VALUES ('${IDS.serial}','${IDS.serial}','${IDS.unit}','usr_owner');
    INSERT INTO serial_inventory (serial_norm,serial_raw,model_code,model_name,product_id,source,created_by)
      VALUES ('${IDS.serial}','${IDS.serial}','A1','Bambu Lab A1','p_a1','manual','usr_owner');
    INSERT INTO stock_serial_links (serial_norm,lot_id,order_item_id,linked_by,linked_at)
      VALUES ('${IDS.serial}','lot1','oi1','usr_owner','2026-09-01T10:00:00Z');
    INSERT INTO serial_assignments (id,serial_norm,serial_raw,order_id,order_item_id,order_ref,unit_index,product_id,lot_id,
                                    lot_source,allocation_id,source,idempotency_key,linked_by,unit_id,activated_at)
      VALUES ('${IDS.assignment}','${IDS.serial}','${IDS.serial}','ord1','oi1','ord1',1,'p_a1','lot1','allocation','oa1','scanner',
              'leak-audit-sa1','usr_owner','${IDS.unit}','2026-09-02T10:00:00Z');
    INSERT INTO return_cases (id,order_id,order_item_id,unit_id,user_id,qty,reason,description,delivered_at_snapshot,within_window,state)
      VALUES ('${IDS.returnCase}','ord1','oi1','${IDS.unit}','u1',1,'defective','does not heat','2026-09-02T10:00:00Z',1,'inspected');
    INSERT INTO price_protection_claims (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state,policy_snapshot)
      VALUES ('${IDS.claim}','u1','ord1','oi1',900000,850000,1,'requested','{"basis":"min(current_applied, price_history window minimum)"}');
    INSERT INTO warranty_claims (id,user_id,order_item_id,product_name,description,unit_id,subject)
      VALUES ('${IDS.warrantyClaim}','u1','oi1','Bambu Lab A1','nozzle clog','${IDS.unit}','nozzle');
    INSERT INTO support_tickets (id,user_id,subject,order_id,unit_id) VALUES ('${IDS.ticket}','u1','where is my refund','ord1','${IDS.unit}');
    -- The sale as the ledger knows it: ord1's line took one unit (the deduct the
    -- return replays), and that unit left lot1 (allocation oa1, COST.orderCogs).
    INSERT INTO inventory_ledger (id,product_id,scope,scope_id,kind,qty,order_id,idempotency_key)
      VALUES ('lg_leak1','p_a1','base','','deduct',1,'ord1','deduct:ord1:oi1:base:-');
    UPDATE inventory_lots SET qty_remaining = 1 WHERE id = 'lot1';
  `);
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  for (const [who, userId] of Object.entries(SESSION_USERS)) {
    raw.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(await sha256Hex(tokenOf(who)), userId, expires);
  }
  return raw;
}

// ------------------------------------------------------------- the Worker

interface Answer {
  status: number;
  cacheControl: string;
  body: unknown;
}

let ipSeq = 0;
/** One request through the REAL Worker on the apex, signed in as `who`. */
async function send(raw: DatabaseSync, who: string, method: string, path: string, body?: unknown): Promise<Answer> {
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  ipSeq += 1;
  const headers: Record<string, string> = {
    Host: APEX,
    Cookie: `levonis_session=${tokenOf(who)}`,
    // A fresh address per call: the sweep is not a rate-limit test.
    'CF-Connecting-IP': `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`,
  };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers.Origin = `https://${APEX}`;
  }
  const res = await worker.fetch(
    new Request(`https://${APEX}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }),
    env as never,
    ctx
  );
  const text = await res.text();
  let parsed: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep the text */
    }
  }
  return { status: res.status, cacheControl: res.headers.get('Cache-Control') ?? '', body: parsed };
}

const filteredLeaks = (path: string, body: unknown) =>
  leaks(body).filter((l) => !NOT_A_COST.some((x) => x.path.test(path) && x.leak.test(l)));

// ------------------------------------------------------------- the concrete GETs

/** Each route's parameters filled with the row THIS world seeded for it — never the product id by default. */
function fill(route: AdminRoute): string[] {
  const full = `${route.prefix}${route.path === '/' ? '' : route.path}`.replace(/\/{2,}/g, '/');
  if (full.includes('*')) return [];
  const byFamily = (name: string): string => {
    if (name === 'orderId') return 'ord1';
    if (name === 'unitId') return IDS.unit;
    if (name === 'serial') return IDS.serial;
    if (name === 'userId') return 'u1';
    if (name === 'id') {
      if (full.startsWith('/api/returns/')) return IDS.returnCase;
      if (full.startsWith('/api/price-protection/')) return IDS.claim;
      if (full.startsWith('/api/devices/admin/claims')) return IDS.warrantyClaim;
      if (full.startsWith('/api/support/admin/tickets')) return IDS.ticket;
      if (full.startsWith('/api/invoices/')) return 'ord1';
      return 'p_a1';
    }
    return 'p_a1';
  };
  const path = full.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, name: string) => byFamily(name));
  // The queries a list needs to answer with rows rather than a 400.
  if (path === '/api/devices/admin/units') return [`${path}?user_id=u1`, `${path}?serial=${IDS.serial}`];
  if (path === '/api/devices/admin/serial-inventory') return [path, `${path}?product_id=p_a1`];
  if (path === '/api/devices/admin/serial-inventory/variants') return [`${path}?product_id=p_a1`];
  if (path === '/api/devices/admin/serial-inventory/resolve') return [`${path}?q=${IDS.serial}`, `${path}?ean=0`];
  return [path];
}

const GETS = [...new Set(SURFACE.filter((r) => r.method === 'GET').flatMap(fill))].sort();

interface Sweep {
  answers: Record<string, Answer>;
  leaks: string[];
}

const sweeps = new Map<string, Promise<Sweep>>();
function sweep(who: string): Promise<Sweep> {
  let p = sweeps.get(who);
  if (!p) {
    p = (async () => {
      const raw = await world();
      const out: Sweep = { answers: {}, leaks: [] };
      for (const path of GETS) {
        const a = await send(raw, who, 'GET', path);
        out.answers[path] = a;
        for (const l of filteredLeaks(path, a.body)) out.leaks.push(`${path} [${a.status}]  ${l}`);
      }
      return out;
    })();
    sweeps.set(who, p);
  }
  return p;
}

const ok = (a: Answer | undefined) => !!a && a.status >= 200 && a.status < 300;

// ------------------------------------------------------------- 0. the surface is real

test('the surface: the off-prefix admin routes exist, and this world makes them answer with real rows (or nothing below proves anything)', async () => {
  assert.ok(SURFACE.length >= 100, `only ${SURFACE.length} off-prefix admin routes were found — the discovery regressed`);
  for (const prefix of ['/api/returns', '/api/price-protection', '/api/devices', '/api/gifts', '/api/wallet', '/api/support', '/api/kyc', '/api/memberships']) {
    assert.ok(SURFACE.some((r) => r.prefix === prefix), `no admin route found under ${prefix}`);
  }
  const full = await sweep('full');
  const body = (p: string) => JSON.stringify(full.answers[p]?.body ?? null);
  const reached: Array<[string, string]> = [
    ['/api/returns/admin/queue', IDS.returnCase],
    ['/api/price-protection/admin/claims', IDS.claim],
    ['/api/devices/admin/orders/ord1/units', IDS.unit],
    [`/api/devices/admin/units?user_id=u1`, IDS.unit],
    [`/api/devices/admin/serial-inventory/${IDS.serial}`, IDS.serial],
    ['/api/devices/admin/claims', IDS.warrantyClaim],
    [`/api/support/admin/tickets/${IDS.ticket}`, IDS.ticket],
  ];
  for (const [path, id] of reached) {
    assert.ok(ok(full.answers[path]), `${path} did not answer the full admin: ${full.answers[path]?.status} ${body(path).slice(0, 300)}`);
    assert.ok(body(path).includes(id), `${path} answered without the seeded row ${id}: ${body(path).slice(0, 300)}`);
  }
  const answered = GETS.filter((p) => ok(full.answers[p])).length;
  assert.ok(answered >= 25, `only ${answered} of ${GETS.length} off-prefix admin GETs answered the full admin`);
});

// ------------------------------------------------------------- A. value

for (const role of NON_OWNER_ADMINS) {
  test(`A — no off-prefix admin GET answer to ${role} carries a private cost (real Worker, real rows on the costly lot and order)`, async () => {
    const r = await sweep(role);
    assert.deepEqual(r.leaks, [], `cost reached ${role} on an off-prefix admin route:\n${r.leaks.join('\n')}`);
  });
}

test('A — the cost-touching writes (return refund that restores the costly lot; claim approval) answer a non-owner admin without a cost', async () => {
  for (const role of ['full', 'legacy_null', 'grantee_off'] as const) {
    const raw = await world();
    // One door per defect (Services V2 plan §1.3): no refund while the repair
    // desk holds the same device. This case is about the refund's answer, so
    // its world closes the warranty claim first.
    raw.prepare("UPDATE warranty_claims SET stage='resolved' WHERE id=?").run(IDS.warrantyClaim);
    const remainingBefore = (raw.prepare("SELECT qty_remaining AS q FROM inventory_lots WHERE id='lot1'").get() as { q: number }).q;
    const ret = await send(raw, role, 'POST', `/api/returns/admin/${IDS.returnCase}/transition`, {
      to: 'resolved',
      resolution: 'refund',
      reason: 'inspected: faulty heater',
    });
    assert.equal(ret.status, 200, `${role}: the return refund did not run: ${JSON.stringify(ret.body).slice(0, 400)}`);
    // The path really touched the lot: its unit came back (planLotRestore) and
    // the restore row carries the sold unit's COGS — the private figure this
    // answer must not repeat.
    const remainingAfter = (raw.prepare("SELECT qty_remaining AS q FROM inventory_lots WHERE id='lot1'").get() as { q: number }).q;
    assert.ok(remainingAfter > remainingBefore, `${role}: the refund did not restore lot1 (${remainingBefore} → ${remainingAfter}) — the cost path was not exercised`);
    const restoredCogs = raw
      .prepare("SELECT COUNT(*) AS n FROM order_item_inventory_allocations WHERE order_id='ord1' AND id <> 'oa1'")
      .get() as { n: number };
    assert.ok(restoredCogs.n >= 1, `${role}: no lot restore row was written — the cost path was not exercised`);
    assert.deepEqual(filteredLeaks('/api/returns/admin/transition', ret.body), [], `${role}: the return transition answer carries a cost`);

    // The claim is decided on a world of its own: a price-protection payout on
    // an item whose return was just refunded is refused before any money moves
    // (PRICE_PROTECTION_RETURN_REVIEW), and so is one while the line's return
    // is still open (review 2026-10-13, PF-1). This case is about each write's
    // answer, so the claim's world closes the return without a refund first.
    const claimWorld = await world();
    claimWorld.prepare("UPDATE return_cases SET state='rejected' WHERE id=?").run(IDS.returnCase);
    const pp = await send(claimWorld, role, 'POST', `/api/price-protection/admin/claims/${IDS.claim}/decide`, { decision: 'approved' });
    assert.equal(pp.status, 200, `${role}: the claim approval did not run: ${JSON.stringify(pp.body).slice(0, 400)}`);
    assert.deepEqual(filteredLeaks('/api/price-protection/admin/claims/decide', pp.body), [], `${role}: the claim decision carries a cost`);

    // …and none of the lot's or order line's private figures entered either answer as text.
    const text = JSON.stringify([ret.body, pp.body]);
    for (const n of [COST.lotUnit, COST.lotTotal, COST.orderLine, COST.orderCogs]) {
      assert.ok(!text.includes(String(n)), `${role}: a private figure (${n}) reached a write answer`);
    }
  }
});

// ------------------------------------------------------------- B. the cache net

test('B — control: the same non-owner admin session gets `private, no-store` on an /api/admin/* answer through the real Worker', async () => {
  const raw = await world();
  const a = await send(raw, 'full', 'GET', '/api/admin/orders');
  assert.ok(ok(a), `control route did not answer: ${a.status}`);
  assert.equal(a.cacheControl, 'private, no-store');
});

test('B — every 2xx off-prefix admin answer to a non-owner admin leaves `no-store`, like every /api/admin/* answer («No shared or stored copy of an admin answer»)', async () => {
  const missing: string[] = [];
  for (const role of NON_OWNER_ADMINS) {
    const r = await sweep(role);
    for (const [path, a] of Object.entries(r.answers)) {
      if (!ok(a)) continue;
      if (!/\bno-store\b/i.test(a.cacheControl)) missing.push(`${role} GET ${path}  Cache-Control: ${a.cacheControl || '(none)'}`);
    }
  }
  assert.deepEqual(
    missing.slice(0, 40),
    [],
    `${missing.length} admin answers outside /api/admin/* leave without no-store (first 40 shown) — noStoreUnlessSet is mounted on '/api/admin/*' and '/api/cart*' only (worker/index.ts):\n${missing.slice(0, 40).join('\n')}`
  );
});

// ------------------------------------------------------------- C. the class net

test('C — every off-prefix admin route has a cost class in tests/routeClass (costRouteClassification classifies /api/admin* mounts only)', async () => {
  const dir = join(ROOT, 'tests/routeClass');
  const classified = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.startsWith('_')).sort()) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default: RouteClassFile };
    for (const m of mod.default.mounts) {
      for (const k of Object.keys(m.routes)) {
        const [method, path] = k.split(' ');
        classified.add(`${method} ${`${m.prefix}${path === '/' ? '' : path}`.replace(/\/{2,}/g, '/')}`);
      }
    }
  }
  const unclassified = SURFACE.map((r) => r.key).filter((k) => !classified.has(k));
  assert.deepEqual(
    unclassified.slice(0, 40),
    [],
    `${unclassified.length} of ${SURFACE.length} admin routes mounted outside /api/admin/* have no route class (first 40 shown):\n${unclassified.slice(0, 40).join('\n')}`
  );
});

// ------------------------------------------------------------- D. the sweep net

test('D — the role-matrix seed gives these routes a row to answer with (otherwise costRoleMatrix walks empty lists and 404s here)', () => {
  const raw = seededCopy();
  const empty: string[] = [];
  for (const [table, routes] of [
    ['return_cases', '/api/returns/admin/queue, /api/returns/admin/:id/transition'],
    ['price_protection_claims', '/api/price-protection/admin/claims, …/:id/decide'],
    ['order_item_units', '/api/devices/admin/orders/:orderId/units, /units/:unitId/*'],
    ['serial_inventory', '/api/devices/admin/serial-inventory/*'],
    ['warranty_claims', '/api/devices/admin/claims'],
    ['support_tickets', '/api/support/admin/tickets/*'],
  ] as const) {
    const n = (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (n === 0) empty.push(`${table} is empty → ${routes} answer an empty list or 404 in the sweep`);
  }
  raw.close();
  assert.deepEqual(empty, [], `the sentinel sweep proves nothing on these admin routes:\n${empty.join('\n')}`);
});
