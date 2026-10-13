/**
 * LEAK AUDIT — candidate `dark-audit-service-cost-details-to-full-admins`.
 *
 * THE CLAIM. With EVENT_BUS_ENABLED on (the dark stack today, live at G2),
 * every `audit()` call of the core also publishes an `AuditRecorded` event; the
 * Audit service stores it in `audit_events`, and `GET /api/v1/audit/admin/events`
 * answers any principal that passes `isFullAdmin` — the owner, but also a
 * `full` admin and a legacy NULL-scope admin, neither of whom may see a cost
 * (DECISIONS row 185 (3)). If the stored row carried the audit BODY, every
 * cost-bearing audit (`inventory.received {unit_cost_iqd,total_cost_iqd}`,
 * `stock.lot_cost_adjusted`, `procurement.profile.updated`,
 * `finance.staff_cost_adjusted`, `finance.order_adjusted`,
 * `investment.contract_created`) would reach those admins.
 *
 * WHAT THIS TEST RUNS — the whole dark path, locally, with nothing stubbed but
 * the session and the service binding's transport:
 *
 *   1. the REAL receive route (`worker/routes/adminInventory.ts`) as the
 *      owner, on a migrated core database, with the bus on and the Audit
 *      service bound as `AUDIT` — so the route's own `audit()` dual-writes;
 *   2. the REAL facade (`worker/lib/audit.ts` `audit()` and
 *      `auditStatements()` in a batch) with the exact detail shapes the other
 *      cost writers send, every figure a sentinel cost;
 *   3. the REAL dispatcher (`pumpOutbox`) delivering to the REAL Audit
 *      consumer (`services/audit/src/consumer.ts`) on the service's REAL
 *      migration, then the REAL seal;
 *   4. the REAL read surface (`services/audit/src/http.ts`) behind a principal
 *      signed with an Identity key published through `ALLOWED_CALLER_KIDS`,
 *      exactly as `services/audit/test/http.test.ts` signs one, for every
 *      non-owner role of tests/fixtures/roleMatrix.ts.
 *
 * Positive controls prove the path is exercised: the producer's body
 * (`core_audit_details`) DOES hold the cost, the Audit service DOES hold a row
 * for every cost action, and the full / NULL-scope admins DO get those rows
 * back. The leak assertion is then that no private value is in what they get.
 *
 * LOCAL ONLY: in-memory databases, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { HopEnvelope } from '@levonis/contracts/rpc/common';
import type { AuditEventsResponse } from '@levonis/contracts/http/audit';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { buildPrincipal, signPrincipal, type MintInput } from '@levonis/platform-kit/principal';
import { generateKeyPair, importSigningKey, KeyRing } from '@levonis/platform-kit/keys';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, stubApp, post, json, all, row, OWNER } from './fixtures/app';
import { COST, DECIMAL_SENTINELS, leaks } from './fixtures/costlyProduct';
import { ROLES, seedRoleMatrix, type RoleName } from './fixtures/roleMatrix';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { audit, auditStatements } from '../worker/lib/audit';
import { configureEventBus, pumpOutbox, resetEventBus } from '../worker/lib/eventBus';
import type { Env as CoreEnv } from '../worker/lib/types';
import { auditConsumer } from '../services/audit/src/consumer';
import { createApp as createAuditApp } from '../services/audit/src/http';
import { sealOnce } from '../services/audit/src/seal';
import type { Env as AuditEnv } from '../services/audit/src/env';
import { auditDb } from '../services/audit/test/_db';

/** The cost actions the candidate names, and the incoming purchase the route receives. */
const COST_ACTIONS = [
  'inventory.received',
  'stock.lot_cost_adjusted',
  'procurement.profile.updated',
  'finance.staff_cost_adjusted',
  'finance.order_adjusted',
  'investment.contract_created',
] as const;
const INCOMING = 'inc_audit_leak';

interface Stack {
  core: DatabaseSync;
  coreEnv: CoreEnv;
  auditRaw: DatabaseSync;
  auditEnv: AuditEnv;
  principal(patch: Partial<MintInput>): Promise<string>;
  read(path: string, header?: string): Promise<Response>;
}

/**
 * The dark stack in one process: the core's database with the bus on, the
 * Audit service's database behind an `AUDIT` binding that is the service's own
 * consumer (dark runs ACCEPT_FIXTURE_SIG=on, so the core's unsigned envelopes
 * are accepted exactly as they are there), and the service's HTTP app.
 */
async function darkStack(): Promise<Stack> {
  resetEventBus();
  const core = seedRoleMatrix(freshDb());
  // A purchase whose stated cost is a sentinel and whose freight is a stated
  // zero, so the received unit cost IS COST.incomingUnit.
  core.exec(`
    INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,status,
                                    shipping_total_iqd,internal_delivery_total_iqd)
      VALUES ('${INCOMING}','p_a1','base','',2,${COST.incomingUnit},'incoming',0,0);
  `);
  const { db: auditD1, raw: auditRaw } = auditDb();
  const consumer = auditConsumer({ keys: new KeyRing(), acceptFixtureSig: true });
  const AUDIT = {
    deliver: (batch: EventEnvelope[], hop?: HopEnvelope) => consumer.deliver(auditD1, batch, hop),
  };
  const coreEnv = { DB: asD1(core), INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', EVENT_BUS_ENABLED: 'on', AUDIT } as unknown as CoreEnv;
  configureEventBus(coreEnv);

  const material = await generateKeyPair();
  const signer = await importSigningKey(material.privateKeyB64, material.publicKeyB64);
  const auditEnv: AuditEnv = { DB: auditD1, ALLOWED_CALLER_KIDS: `identity:${material.kid}:${material.publicKeyB64}`, SVC_VERSION: 'test' };
  const app = createAuditApp();
  const principal = (patch: Partial<MintInput>) =>
    signPrincipal(
      signer,
      buildPrincipal(
        { sub: 'usr_x', sid_hash: 'sid', role: 'admin', scope: 'full', investor: false, tier: null, locale: 'en', host_kind: 'main', cid: 'cid_leak', ...patch },
        Math.floor(Date.now() / 1000)
      )
    );
  const read = async (path: string, header?: string): Promise<Response> =>
    app.fetch(new Request(`https://audit.internal${path}`, { headers: header ? { [PRINCIPAL_HEADER]: header } : {} }), auditEnv);
  return { core, coreEnv, auditRaw, auditEnv, principal, read };
}

/**
 * The principal Identity mints for each matrix role (`IdentityEntrypoint.resolve`
 * → `scopeFor`): an admin is `assistant` or `full`; a legacy NULL row is
 * minted `full`, and a hand-built NULL-scope admin principal (the schema allows
 * it, and `isFullAdmin` lets it through) is covered as its own caller below.
 */
function mintFor(role: RoleName): Partial<MintInput> | null {
  const u = ROLES[role];
  if (!u) return null;
  if (u.role !== 'admin') return { sub: u.id, role: u.role, scope: null, investor: !!u.is_investor, tier: 'free' };
  return { sub: u.id, role: 'admin', scope: u.admin_scope === 'assistant' ? 'assistant' : 'full' };
}

/** Every number of every cost body the producer kept, as extra sentinels (small counters excluded). */
function producerNumbers(core: DatabaseSync): number[] {
  const out = new Set<number>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    else if (typeof v === 'number' && Math.abs(v) >= 1000) out.add(v);
  };
  for (const r of all<{ detail: string }>(core, 'SELECT detail FROM core_audit_details')) walk(JSON.parse(r.detail));
  return [...out];
}

/** Drive every cost writer the candidate lists through the core, then deliver and seal. */
async function writeCostAudits(s: Stack): Promise<void> {
  // 1. THE REAL ROUTE: «إضافة إلى المخزون الحالي» as the owner.
  const app = stubApp(s.coreEnv.DB, OWNER, (a) => a.route('/api/admin/inventory', adminInventoryRoutes), {
    env: { EVENT_BUS_ENABLED: 'on', AUDIT: (s.coreEnv as unknown as { AUDIT: unknown }).AUDIT },
  });
  const res = await post(app, `/api/admin/inventory/incoming/${INCOMING}/receive`, { receipt_id: 'r-leak-1', qty: 2 });
  const body = await json(res);
  assert.equal(res.status, 200, `the owner's receive must succeed: ${JSON.stringify(body)}`);

  // 2. THE FACADE, with the detail shapes the other cost writers send.
  const db = s.coreEnv.DB;
  await audit(db, 'usr_owner', 'stock.lot_cost_adjusted', 'lot1', {
    incoming_id: 'inc1',
    new_unit_cost_iqd: COST.lotUnit,
    amount_iqd: COST.lotTotal,
  });
  await audit(db, 'usr_owner', 'procurement.profile.updated', 'cp_air', {
    exchange_rate: DECIMAL_SENTINELS.fxRate,
    shipping_rate_iqd: COST.incomingShipping,
    version: 2,
  });
  await audit(db, 'usr_owner', 'investment.contract_created', 'ic_new', {
    incoming_id: 'inc1',
    principal_iqd: COST.lotPurchase,
    profit_share_bps: 3500,
    capital_share_bps: 10000,
  });
  // The batch form (`auditStatements` inside the writer's own batch), as
  // adminFinancePeople.ts and adminFinanceWorkspace.ts call it.
  const staff = await auditStatements(db, 'usr_owner', 'finance.staff_cost_adjusted', 'fc_1', {
    before_iqd: COST.orderCogs,
    after_iqd: COST.orderLine,
    order_id: 'ord1',
  });
  await db.batch(staff.statements);
  const order = await auditStatements(db, 'usr_owner', 'finance.order_adjusted', 'ord1', {
    field: 'cost_iqd',
    line_id: 'oi1',
    before: COST.orderLine,
    after: COST.purchaseUnit,
    version: 1,
    operation_id: 'op_leak',
  });
  await db.batch(order.statements);

  // 3. THE DISPATCHER → THE AUDIT CONSUMER, then THE SEAL. `audit()` already
  // pumped in the background; the cron's pump picks up anything left, and the
  // consumer is idempotent by event id.
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  await pumpOutbox(s.coreEnv, 'leak-audit');
  await sealOnce(s.auditEnv.DB, { chainKey: undefined, limit: 500, now: new Date().toISOString() });
}

test('dark Audit service: a full or NULL-scope admin reads the cost actions, never their cost', async () => {
  const s = await darkStack();
  await writeCostAudits(s);

  // ---- POSITIVE CONTROL 1: the producer's body IS cost-bearing.
  const received = row<{ detail: string }>(
    s.core,
    `SELECT d.detail FROM core_audit_details d
       JOIN core_outbox_events e ON e.event_id = d.event_id
      WHERE json_extract(e.envelope, '$.payload.action') = 'inventory.received'`
  );
  assert.ok(received, 'the receive route wrote its audit body to core_audit_details (the bus was on)');
  const receivedBody = JSON.parse(received!.detail) as Record<string, unknown>;
  assert.equal(receivedBody.unit_cost_iqd, COST.incomingUnit, 'the body the route audits carries the unit cost');
  assert.equal(receivedBody.total_cost_iqd, COST.incomingUnit * 2, 'and the total cost');
  const extra = { numbers: producerNumbers(s.core), decimals: [String(DECIMAL_SENTINELS.fxRate)] };

  // ---- POSITIVE CONTROL 2: every cost action reached the Audit service.
  const stored = all<{ action: string; detail: string | null }>(s.auditRaw, 'SELECT action, detail FROM audit_events');
  for (const action of COST_ACTIONS) {
    assert.ok(stored.some((r) => r.action === action), `the Audit service holds a row for ${action}`);
  }
  // The stored table itself — what any future read model, export or verify
  // page of this service would serve — holds none of the body.
  assert.deepEqual(leaks(stored, extra), [], 'audit_events must not store a private cost');

  // ---- THE READ SURFACE, for every caller that is not the owner.
  const callers: Array<{ name: string; header: string | undefined; passesGate: boolean }> = [];
  for (const role of Object.keys(ROLES) as RoleName[]) {
    const patch = mintFor(role);
    const header = patch ? await s.principal(patch) : undefined;
    const passesGate = !!patch && patch.role === 'admin' && patch.scope !== 'assistant';
    callers.push({ name: role, header, passesGate });
  }
  // The legacy NULL-scope admin principal (schema-valid; isFullAdmin admits it).
  callers.push({ name: 'legacy_null(scope=null principal)', header: await s.principal({ sub: 'usr_legacy', scope: null }), passesGate: true });

  let servedToNonOwner = 0;
  for (const caller of callers) {
    for (const path of [
      '/api/v1/audit/admin/events?limit=200',
      ...COST_ACTIONS.map((a) => `/api/v1/audit/admin/events?action=${encodeURIComponent(a)}`),
      '/api/v1/audit/admin/verify',
    ]) {
      const res = await s.read(path, caller.header);
      const text = await res.text();
      const parsed = JSON.parse(text) as unknown;
      assert.deepEqual(leaks(parsed, extra), [], `${caller.name} GET ${path} (HTTP ${res.status}) must carry no private cost value`);
      if (caller.passesGate && path === '/api/v1/audit/admin/events?limit=200') {
        assert.equal(res.status, 200, `${caller.name} passes isFullAdmin, so the path really serves it`);
        const actions = new Set((parsed as AuditEventsResponse).rows.map((r) => r.action));
        for (const action of COST_ACTIONS) assert.ok(actions.has(action), `${caller.name} is served the ${action} row`);
        servedToNonOwner += 1;
        // No cost-bearing row carries a body at all.
        for (const r of (parsed as AuditEventsResponse).rows) {
          if ((COST_ACTIONS as readonly string[]).includes(r.action)) {
            assert.equal(r.detail, null, `${caller.name}: the ${r.action} row must not carry the producer's body`);
          }
        }
      }
      if (!caller.passesGate && path.includes('/events')) {
        assert.ok(res.status === 401 || res.status === 403, `${caller.name} is refused the read surface (got ${res.status})`);
      }
    }
  }
  assert.ok(servedToNonOwner >= 3, 'full, grantee_off and the NULL-scope admin were all served the log');
});

/**
 * THE REASON THE ANSWER ABOVE IS EMPTY, pinned: the body reaches `audit_events`
 * only through the `record()` RPC (`directEntryStatements` → `fillDetailStatement`);
 * the consumer stores `AuditRecorded` with `detail: null`. No production code
 * calls `AUDIT.record(...)` today — only the never-deployed
 * `services/audit/dev/producer-stub`. The day a producer starts handing the
 * body over, this test fails and the read surface needs an owner gate first.
 */
test('no deployed producer hands an audit body to the Audit service (record())', () => {
  const roots = [join(ROOT, 'worker'), join(ROOT, 'packages'), join(ROOT, 'services')];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dev' || name === 'test' || name === 'tests') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) {
        const src = readFileSync(p, 'utf8');
        if (/\bAUDIT\??\.record\s*\(/.test(src) || /\bQ_AUDIT\b[^\n]*detail/.test(src)) offenders.push(p.slice(ROOT.length + 1));
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(offenders, [], 'a producer now sends audit bodies to the Audit service, whose read surface admits non-owner full admins');
});
