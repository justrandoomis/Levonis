/**
 * LEAK AUDIT — candidate `dark-audit-service-detail-to-full-admins`
 * (channel: logs-errors / audit rows, the Audit service read surface).
 *
 * THE CLAIM. With EVENT_BUS_ENABLED on (the dark stack today, the live site at
 * G2), every `audit()` of the core dual-writes an `AuditRecorded` event plus the
 * body in `core_audit_details`; the pump delivers to the Audit service, which
 * stores `audit_events.detail`; `GET /api/v1/audit/admin/events` admits any
 * principal `isFullAdmin` lets through (scope `full`, or a NULL-scope admin) —
 * not only the owner (`canViewCostPrincipal`) — and `queryEntries` returns
 * `detail` unfiltered. So, says the candidate, a non-owner full admin reads
 * `stock.lot_cost_adjusted {new_unit_cost_iqd, amount_iqd}`,
 * `procurement.profile.updated {exchange_rate, shipping_rate_iqd}`,
 * `investment.contract_created` (the full input), the pricing.engine.* /
 * pricing.inputs.updated / pricing.applied_from_purchase rows, the
 * finance.wage_* and finance.staff_* families, invest.* and trade_in.*.
 *
 * WHAT THIS TEST RUNS — locally, on in-memory databases, no network:
 *
 *   1. REAL ROUTES as the owner on a migrated core database with the bus on
 *      and the Audit consumer bound as `AUDIT`:
 *        - POST /api/admin/inventory/incoming/:id/receive      (inventory.received)
 *        - POST /api/admin/investment-finance/contracts         (investment.contract_created)
 *        - POST /api/admin/investment-finance/lot-cost-adjustments (stock.lot_cost_adjusted,
 *          adminInvestmentFinance.ts:151 — the line the candidate cites)
 *        - PUT  /api/admin/procurement/cost-profiles/china_air  (procurement.profile.updated,
 *          adminProcurement.ts:219 — the line the candidate cites)
 *   2. THE REAL FACADE (`audit()` and `auditStatements()` in a batch) with the
 *      exact detail shapes of every other family the candidate lists, each
 *      figure a sentinel cost.
 *   3. THE REAL DISPATCHER (`pumpOutbox`) → THE REAL Audit consumer on the
 *      service's REAL migration → THE REAL seal.
 *   4. THE REAL READ SURFACE (`services/audit/src/http.ts`) behind a principal
 *      signed by an Identity key published through ALLOWED_CALLER_KIDS, for
 *      every non-owner role of tests/fixtures/roleMatrix.ts plus a hand-built
 *      NULL-scope admin principal.
 *   5. THE LOGS: every console line of the core and every structured line the
 *      Audit consumer and HTTP app log (sampleRate 1) during 1–4.
 *
 * Positive controls prove the path is exercised: the producer's bodies DO hold
 * the costs; every listed action DOES reach audit_events; the full / NULL-scope
 * admins ARE served those rows; and (second test) the read surface DOES serve a
 * body — which the scanner DOES flag — when one is filled through the
 * `record()` path, so an empty answer in the first test is the mapper, not a
 * blind test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { HopEnvelope } from '@levonis/contracts/rpc/common';
import type { AuditEventsResponse } from '@levonis/contracts/http/audit';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { canonicalHash } from '@levonis/contracts/canonical';
import { buildPrincipal, signPrincipal, type MintInput } from '@levonis/platform-kit/principal';
import { generateKeyPair, importSigningKey, KeyRing } from '@levonis/platform-kit/keys';
import { createLogger } from '@levonis/platform-kit/log';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, stubApp, post, put, json, all, row, OWNER } from './fixtures/app';
import { COST, DECIMAL_SENTINELS, leaks } from './fixtures/costlyProduct';
import { ROLES, seedRoleMatrix, type RoleName } from './fixtures/roleMatrix';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { audit, auditStatements } from '../worker/lib/audit';
import { configureEventBus, pumpOutbox, resetEventBus } from '../worker/lib/eventBus';
import type { Env as CoreEnv } from '../worker/lib/types';
import { auditConsumer, directEntryStatements } from '../services/audit/src/consumer';
import { ENTRY_MAPPERS } from '../services/audit/src/entries';
import { createApp as createAuditApp } from '../services/audit/src/http';
import { sealOnce } from '../services/audit/src/seal';
import type { Env as AuditEnv } from '../services/audit/src/env';
import { auditDb } from '../services/audit/test/_db';

const INCOMING = 'inc_dark_detail';

/** Every action the candidate names, written below through a real route or the real facade. */
const ROUTE_ACTIONS = ['inventory.received', 'investment.contract_created', 'stock.lot_cost_adjusted', 'procurement.profile.updated'] as const;
const FACADE_ACTIONS = [
  'pricing.engine.adopted',
  'pricing.engine.repriced',
  'pricing.engine.repriced_auto',
  'pricing.engine.reprice_blocked',
  'pricing.inputs.updated',
  'pricing.applied_from_purchase',
  'finance.wage_reconciled',
  'finance.wage_change_applied',
  'finance.staff_employment_adjusted',
  'finance.staff_cost_materialized',
  'finance.staff_percentage_recalculated',
  'finance.staff_updated',
  'invest.create',
  'invest.update',
  'trade_in.approve',
  'trade_in.change_value',
] as const;
const ALL_ACTIONS: readonly string[] = [...ROUTE_ACTIONS, ...FACADE_ACTIONS];

// ------------------------------------------------------------------ logs

/** Every line any part of the stack logs while the test runs. */
const logLines: string[] = [];
function captureConsole(): () => void {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const grab =
    (k: keyof typeof orig) =>
    (...args: unknown[]) => {
      logLines.push(
        args
          .map((a) => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(' ')
      );
      void k;
    };
  console.log = grab('log');
  console.info = grab('info');
  console.warn = grab('warn');
  console.error = grab('error');
  console.debug = grab('debug');
  return () => Object.assign(console, orig);
}
const svcLog = createLogger({ svc: 'audit', sampleRate: 1, sink: (line) => logLines.push(line) });

// ------------------------------------------------------------------ the dark stack

interface Stack {
  core: DatabaseSync;
  coreEnv: CoreEnv;
  auditD1: D1Database;
  auditRaw: DatabaseSync;
  auditEnv: AuditEnv;
  principal(patch: Partial<MintInput>): Promise<string>;
  read(path: string, header?: string): Response | Promise<Response>;
}

async function darkStack(): Promise<Stack> {
  resetEventBus();
  const core = seedRoleMatrix(freshDb());
  // A purchase whose stated unit cost is a sentinel and whose freight is a
  // stated zero, so the received unit cost IS COST.incomingUnit.
  core.exec(`
    INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,status,
                                    shipping_total_iqd,internal_delivery_total_iqd)
      VALUES ('${INCOMING}','p_a1','base','',2,${COST.incomingUnit},'incoming',0,0);
  `);
  const { db: auditD1, raw: auditRaw } = auditDb();
  // dark runs ACCEPT_FIXTURE_SIG=on (services/audit/wrangler.jsonc), so the
  // core's fixture-signed envelopes are accepted exactly as they are there.
  const consumer = auditConsumer({
    keys: new KeyRing(),
    acceptFixtureSig: true,
    log: svcLog,
    onRejected: (eventId, type, reason) => svcLog.error('audit.rejected', { event_id: eventId, type, reason }),
  });
  const AUDIT = { deliver: (batch: EventEnvelope[], hop?: HopEnvelope) => consumer.deliver(auditD1, batch, hop) };
  const coreEnv = { DB: asD1(core), INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', EVENT_BUS_ENABLED: 'on', AUDIT } as unknown as CoreEnv;
  configureEventBus(coreEnv);

  const material = await generateKeyPair();
  const signer = await importSigningKey(material.privateKeyB64, material.publicKeyB64);
  const auditEnv: AuditEnv = { DB: auditD1, ALLOWED_CALLER_KIDS: `identity:${material.kid}:${material.publicKeyB64}`, SVC_VERSION: 'test' };
  const app = createAuditApp({ log: svcLog });
  const principal = (patch: Partial<MintInput>) =>
    signPrincipal(
      signer,
      buildPrincipal(
        { sub: 'usr_x', sid_hash: 'sid', role: 'admin', scope: 'full', investor: false, tier: null, locale: 'en', host_kind: 'main', cid: 'cid_dark', ...patch },
        Math.floor(Date.now() / 1000)
      )
    );
  const read = (path: string, header?: string) =>
    app.fetch(new Request(`https://audit.internal${path}`, { headers: header ? { [PRINCIPAL_HEADER]: header } : {} }), auditEnv);
  return { core, coreEnv, auditD1, auditRaw, auditEnv, principal, read };
}

/** The principal Identity mints for each matrix role (`scopeFor`): admin → `assistant` or `full`. */
function mintFor(role: RoleName): Partial<MintInput> | null {
  const u = ROLES[role];
  if (!u) return null;
  if (u.role !== 'admin') return { sub: u.id, role: u.role, scope: null, investor: !!u.is_investor, tier: 'free' };
  return { sub: u.id, role: 'admin', scope: u.admin_scope === 'assistant' ? 'assistant' : 'full' };
}

/** Every number (≥ 1000) and every decimal of every body the producer kept: the private figures to look for. */
function producerFigures(core: DatabaseSync): { numbers: number[]; decimals: string[] } {
  const numbers = new Set<number>();
  const decimals = new Set<string>([String(DECIMAL_SENTINELS.fxRate)]);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    else if (typeof v === 'number' && Math.abs(v) >= 1000) numbers.add(v);
    else if (typeof v === 'number' && !Number.isInteger(v)) decimals.add(String(v));
  };
  for (const r of all<{ detail: string }>(core, 'SELECT detail FROM core_audit_details')) walk(JSON.parse(r.detail));
  return { numbers: [...numbers], decimals: [...decimals] };
}

/** The `detail_hash` of every producer body — a served hash of a low-entropy body is a brute-force oracle. */
async function producerHashes(core: DatabaseSync): Promise<string[]> {
  const out: string[] = [];
  for (const r of all<{ detail: string }>(core, 'SELECT detail FROM core_audit_details')) out.push(await canonicalHash(JSON.parse(r.detail)));
  return out;
}

/** Digits inside text that spell any private figure (the shared scanner only spells the fixed sentinels in text). */
function figuresInText(raw: string, figures: { numbers: number[]; decimals: string[] }): string[] {
  // A SHA-256 digest (the audit chain's hash / prev_hash) is random hex that
  // can spell a four-digit figure by chance; it is never a cost, so it is
  // blanked before the scan (a figure anywhere else is still found).
  const text = raw.replace(/\b[0-9a-f]{64}\b/gi, '#');
  const nums = new Set(figures.numbers.map((n) => String(n)));
  const out: string[] = [];
  for (const m of text.match(/\d[\d,]{3,}(?:\.\d+)?/g) ?? []) {
    const plain = m.replace(/,/g, '');
    if (nums.has(plain) || nums.has(plain.split('.')[0])) out.push(m);
  }
  for (const d of figures.decimals) if (text.includes(d)) out.push(d);
  return out;
}

// ------------------------------------------------------------------ the writers

async function writeCostAudits(s: Stack): Promise<void> {
  const env = { EVENT_BUS_ENABLED: 'on', AUDIT: (s.coreEnv as unknown as { AUDIT: unknown }).AUDIT };
  const app = stubApp(
    s.coreEnv.DB,
    OWNER,
    (a) => {
      a.route('/api/admin/inventory', adminInventoryRoutes);
      a.route('/api/admin/investment-finance', adminInvestmentFinanceRoutes);
      a.route('/api/admin/procurement', adminProcurementRoutes);
    },
    { env }
  );

  // 1a. «إضافة إلى المخزون الحالي» — the lots the later correction needs.
  let res = await post(app, `/api/admin/inventory/incoming/${INCOMING}/receive`, { receipt_id: 'r-dark-1', qty: 2 });
  assert.equal(res.status, 200, `receive: ${JSON.stringify(await json(res.clone()))}`);

  // 1b. investment.contract_created — the full input is the audit body.
  res = await post(app, '/api/admin/investment-finance/contracts', {
    operation_id: 'op_contract_dark',
    incoming_id: INCOMING,
    user_id: ROLES.assistant!.id,
    name: 'dark contract',
    principal_iqd: COST.lotPurchase,
    capital_share_bps: 10000,
    profit_share_bps: 3500,
    loss_share_bps: 10000,
  });
  assert.equal(res.status, 200, `contract: ${JSON.stringify(await json(res.clone()))}`);

  // 1c. stock.lot_cost_adjusted (adminInvestmentFinance.ts:151).
  res = await post(app, '/api/admin/investment-finance/lot-cost-adjustments', {
    operation_id: 'op_lotcost_dark',
    incoming_id: INCOMING,
    new_unit_cost_iqd: COST.lotUnit,
    title: 'dark correction',
  });
  assert.equal(res.status, 200, `lot cost: ${JSON.stringify(await json(res.clone()))}`);

  // 1d. procurement.profile.updated (adminProcurement.ts:219).
  const prof = row<{ version: number }>(s.core, "SELECT version FROM procurement_cost_profiles WHERE id='china_air'");
  assert.ok(prof, 'the migration seeds the china_air profile');
  res = await put(app, '/api/admin/procurement/cost-profiles/china_air', {
    version: prof!.version,
    exchange_rate: DECIMAL_SENTINELS.fxRate,
    shipping_rate_iqd: COST.incomingShipping,
  });
  assert.equal(res.status, 200, `profile: ${JSON.stringify(await json(res.clone()))}`);

  // 2. THE FACADE, with each call site's own detail shape.
  const db = s.coreEnv.DB;
  const batch = async (action: string, target: string, detail: Record<string, unknown>) =>
    db.batch((await auditStatements(db, OWNER.id, action, target, detail)).statements);
  // engineWrite.ts:919 / autoReprice.ts:353 / adminPricing.ts:929,1173
  await batch('pricing.engine.adopted', 'p_a1', { product_id: 'p_a1', rows_changed: 3, entered: true, source: 'inputs', inputs_changed: 4, rules_changed: 1 });
  await batch('pricing.engine.repriced', 'p_a1', { product_id: 'p_a1', rows_changed: 3, entered: false, source: 'purchase', purchase_id: 'po_1' });
  await batch('pricing.engine.repriced_auto', 'p_a1', { product_id: 'p_a1', rows_changed: 2, entered: false, source: 'fx', trigger: 'fx', reasons: ['usd_iqd'] });
  await batch('pricing.engine.reprice_blocked', 'p_a1', { product_id: 'p_a1', code: 'BELOW_MIN_PROFIT', trigger: 'fx', reasons: ['deficit'] });
  await batch('pricing.inputs.updated', 'p_a1', { product_id: 'p_a1', inputs_changed: 4, rules_changed: 1, inputs_seq: 7 });
  await batch('pricing.applied_from_purchase', 'p_a1', { product_id: 'p_a1', purchase_id: 'po_1', rows_changed: 3, entered: false });
  // financeWageCalculation.ts:140, financeWageChanges.ts:178, financeEmployment.ts:82,141, financeParticipants.ts:377,384
  await batch('finance.wage_reconciled', 'fc_1', { order_id: 'ord1', staff_id: 'st1', before_iqd: COST.orderCogs, after_iqd: COST.orderLine, earning_day: '2026-10-01', wage_version_id: 'wv1', reason: 'r' });
  await batch('finance.wage_change_applied', 'wr_1', { operation_id: 'op_w', wage_version_id: 'wv2', effective_from: '2026-10-01', effective_until: null, reason: 'r', delta_iqd: COST.purchaseCharge });
  await batch('finance.staff_employment_adjusted', 'fc_2', { before_iqd: COST.cellAdjust * 100, after_iqd: COST.colorAdjust * 100, order_id: 'ord1', start_work_date: '2026-01-01' });
  await batch('finance.staff_cost_materialized', 'fc_3', { amount_iqd: COST.lotShipping, order_id: 'ord1' });
  await batch('finance.staff_percentage_recalculated', 'fc_4', { before_iqd: COST.option, after_iqd: COST.color, order_id: 'ord1' });
  await batch('finance.staff_updated', 'st1', { before: { name: 'a', role: 'packer', user_id: null, active: 1 }, after: { name: 'b', role: 'packer', user_id: null, active: 1 } });
  // admin.ts:4384,4413
  await audit(db, OWNER.id, 'invest.create', 'inv1', { userId: 'usr_inv', amount: COST.product, profit: COST.route, days: 30 });
  await audit(db, OWNER.id, 'invest.update', 'inv1', { amount: COST.product, profit: COST.cell, status: 'active' });
  // tradeIn.ts:1508,1576
  await batch('trade_in.approve', 'ti1', { value_iqd: COST.purchaseUnit, trade_in_value_iqd: COST.purchaseUnit, difference_iqd: COST.orderLine });
  await batch('trade_in.change_value', 'ti1', { value_iqd: COST.purchaseUnit, estimated_iqd: COST.orderCogs, reason: 'r', offer_no: 2 });

  // 3. THE DISPATCHER → THE AUDIT CONSUMER, then THE SEAL.
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  await pumpOutbox(s.coreEnv, 'dark-detail');
  await pumpOutbox(s.coreEnv, 'dark-detail');
  await sealOnce(s.auditEnv.DB, { chainKey: undefined, limit: 500, now: new Date().toISOString() });
}

// ------------------------------------------------------------------ tests

test('dark Audit service: a full or NULL-scope admin is served every cost action the candidate lists — never its body, its hash, or a log line carrying it', async () => {
  logLines.length = 0;
  const restore = captureConsole();
  let s!: Stack;
  try {
    s = await darkStack();
    await writeCostAudits(s);
  } finally {
    restore();
  }

  // ---- POSITIVE CONTROL 1: the producer's bodies ARE cost-bearing.
  const body = (action: string) => {
    const r = row<{ detail: string }>(
      s.core,
      `SELECT d.detail FROM core_audit_details d JOIN core_outbox_events e ON e.event_id = d.event_id
        WHERE json_extract(e.envelope, '$.payload.action') = ?`,
      action
    );
    assert.ok(r, `the bus was on: ${action} kept its body in core_audit_details`);
    return JSON.parse(r!.detail) as Record<string, unknown>;
  };
  assert.equal(body('stock.lot_cost_adjusted').new_unit_cost_iqd, COST.lotUnit, 'the lot-cost body carries the new unit cost');
  assert.equal(body('procurement.profile.updated').exchange_rate, DECIMAL_SENTINELS.fxRate, 'the profile body carries the FX rate');
  assert.equal(body('procurement.profile.updated').shipping_rate_iqd, COST.incomingShipping, 'and the freight rate');
  assert.equal(body('investment.contract_created').principal_iqd, COST.lotPurchase, 'the contract body carries the principal');
  assert.equal(body('inventory.received').unit_cost_iqd, COST.incomingUnit, 'the receive body carries the unit cost');
  const figures = producerFigures(s.core);
  const hashes = await producerHashes(s.core);
  const extra = { numbers: figures.numbers, decimals: figures.decimals };

  // ---- POSITIVE CONTROL 2: every listed action reached the Audit service.
  const stored = all<{ action: string; detail: string | null; detail_hash: string; detail_ref: string | null }>(
    s.auditRaw,
    'SELECT action, detail, detail_hash, detail_ref FROM audit_events'
  );
  for (const action of ALL_ACTIONS) assert.ok(stored.some((r) => r.action === action), `the Audit service holds a row for ${action}`);
  assert.deepEqual(
    leaks(
      stored.map((r) => ({ action: r.action, detail: r.detail })),
      extra
    ),
    [],
    'audit_events.detail must not store a private body'
  );

  // ---- THE READ SURFACE, for every caller that is not the owner.
  const callers: Array<{ name: string; header: string | undefined; passesGate: boolean }> = [];
  for (const role of Object.keys(ROLES) as RoleName[]) {
    const patch = mintFor(role);
    callers.push({ name: role, header: patch ? await s!.principal(patch) : undefined, passesGate: !!patch && patch.role === 'admin' && patch.scope !== 'assistant' });
  }
  callers.push({ name: 'null-scope admin principal', header: await s!.principal({ sub: 'usr_legacy', scope: null }), passesGate: true });

  const paths = ['/api/v1/audit/admin/events?limit=200', ...ALL_ACTIONS.map((a) => `/api/v1/audit/admin/events?action=${encodeURIComponent(a)}`), '/api/v1/audit/admin/verify'];
  let served = 0;
  logLines.length = 0;
  const restore2 = captureConsole();
  try {
    for (const caller of callers) {
      for (const path of paths) {
        const res = await s!.read(path, caller.header);
        const text = await res.text();
        const parsed = JSON.parse(text) as unknown;
        assert.deepEqual(leaks(parsed, extra), [], `${caller.name} GET ${path} (HTTP ${res.status}) must carry no private value`);
        assert.deepEqual(figuresInText(text, figures), [], `${caller.name} GET ${path}: no private figure as text`);
        for (const h of hashes) assert.ok(!text.includes(h), `${caller.name} GET ${path}: no producer detail_hash (a brute-force oracle on a low-entropy body)`);
        if (caller.passesGate && path === '/api/v1/audit/admin/events?limit=200') {
          assert.equal(res.status, 200, `${caller.name} passes isFullAdmin, so the path really serves it`);
          const rows = (parsed as AuditEventsResponse).rows;
          const actions = new Set(rows.map((r) => r.action));
          for (const action of ALL_ACTIONS) assert.ok(actions.has(action), `${caller.name} is served the ${action} row`);
          for (const r of rows) {
            if (ALL_ACTIONS.includes(r.action)) assert.equal(r.detail, null, `${caller.name}: the ${r.action} row must not carry the producer's body`);
          }
          served += 1;
        }
        if (!caller.passesGate && path.includes('/events')) {
          assert.ok(res.status === 401 || res.status === 403, `${caller.name} is refused the read surface (got ${res.status})`);
        }
      }
    }
  } finally {
    restore2();
  }
  assert.ok(served >= 4, `full, legacy_null, grantee_off and the null-scope principal were all served the log (served ${served})`);
  assert.ok(stored.length >= ALL_ACTIONS.length);
});

test('logs and errors of the dark write → pump → consume → read path carry no private figure', async () => {
  logLines.length = 0;
  const restore = captureConsole();
  let s!: Stack;
  try {
    s = await darkStack();
    await writeCostAudits(s);
    const full = await s.principal(mintFor('full')!);
    for (const path of ['/api/v1/audit/admin/events?limit=200', '/api/v1/audit/admin/verify', '/api/v1/audit/admin/events?action=stock.lot_cost_adjusted']) {
      await (await s.read(path, full)).text();
    }
    // An error path: a malformed cursor / unknown route must not echo anything either.
    await (await s.read('/api/v1/audit/admin/events?cursor=abc&limit=-5', full)).text();
    await (await s.read('/api/v1/audit/admin/nope', full)).text();
  } finally {
    restore();
  }
  const figures = producerFigures(s!.core);
  const hashes = await producerHashes(s!.core);
  assert.ok(logLines.some((l) => /audit\.query/.test(l)), 'the Audit app really logged (positive control: the sink is wired)');
  const offenders: string[] = [];
  for (const line of logLines) {
    let parsed: unknown = line;
    try {
      parsed = JSON.parse(line);
    } catch {
      /* plain console text */
    }
    const hit = [...leaks(parsed, { numbers: figures.numbers, decimals: figures.decimals }), ...figuresInText(line, figures), ...hashes.filter((h) => line.includes(h))];
    if (hit.length) offenders.push(`${line.slice(0, 160)} → ${hit.join(', ')}`);
  }
  assert.deepEqual(offenders, [], 'no log line of the dark audit path may carry a private figure');
});

/**
 * THE CONTROL THAT MAKES THE ANSWER ABOVE MEAN SOMETHING, and THE LATENT GAP,
 * pinned: the read surface serves `detail` verbatim to a non-owner full admin
 * whenever a body is filled — which only `record()` (`directEntryStatements` →
 * `fillDetailStatement`) does. The scanner flags it. So the first test's empty
 * answer is the AuditRecorded mapper (`detail: null`), not a blind test; and
 * the day a producer calls `AUDIT.record(...)` with a cost body, a `full` admin
 * reads it — there is no `canViewCostPrincipal` on this surface.
 */
test('control: a body filled through record() IS served to a full admin and IS flagged — the surface has no owner gate, only the mapper keeps cost out', async () => {
  const s = await darkStack();
  const eventId = '0192f0e0-0000-7000-8000-00000000c0de';
  const statements = await directEntryStatements(s.auditD1, {
    event_id: eventId,
    actor_id: OWNER.id,
    action: 'stock.lot_cost_adjusted',
    target: 'lot_ctrl',
    detail: { incoming_id: 'inc_ctrl', new_unit_cost_iqd: COST.lotUnit, amount_iqd: COST.lotTotal },
    source_service: 'core',
    correlation_id: 'cid_ctrl',
    occurred_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
  });
  await s.auditD1.batch(statements);
  const res = await s.read('/api/v1/audit/admin/events', await s.principal(mintFor('full')!));
  assert.equal(res.status, 200);
  const parsed = (await res.json()) as AuditEventsResponse;
  assert.equal(parsed.rows[0]?.detail?.new_unit_cost_iqd, COST.lotUnit, 'the surface serves whatever body is stored');
  assert.notDeepEqual(leaks(parsed), [], 'and the scanner sees it — the first test would have caught a body');

  // The AuditRecorded mapper is what keeps the body out on the deployed path.
  const draft = ENTRY_MAPPERS['AuditRecorded.v1']({
    payload: { actor_id: 'usr_owner', action: 'stock.lot_cost_adjusted', target: 'lot1', detail_hash: 'h', detail_ref: 'e', source_service: 'core' },
  } as unknown as EventEnvelope);
  assert.equal(draft.detail, null, 'AuditRecorded is stored by hash and reference only');
});

/**
 * THE CONDITION OF THE REFUTATION: no deployed code hands a body to the Audit
 * service. `record()` is open to every service (guard.ts `'*'`), so a single
 * `AUDIT.record({... detail})` anywhere outside dev rigs turns the latent gap
 * above into a live leak to every `full` admin.
 */
test('no deployed producer calls the Audit record() path or fills audit_events.detail', () => {
  const roots = [join(ROOT, 'worker'), join(ROOT, 'packages'), join(ROOT, 'services')];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dev' || name === 'test' || name === 'tests') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) {
        const rel = p.slice(ROOT.length + 1).split(sep).join('/');
        const src = readFileSync(p, 'utf8');
        if (/\bAUDIT\??\.record\s*\(/.test(src)) offenders.push(`${rel}: AUDIT.record(`);
        if (rel !== 'services/audit/src/index.ts' && rel !== 'services/audit/src/consumer.ts' && /\bdirectEntryStatements\s*\(/.test(src)) offenders.push(`${rel}: directEntryStatements(`);
        if (rel !== 'services/audit/src/consumer.ts' && rel !== 'services/audit/src/store.ts' && /\bfillDetailStatement\s*\(/.test(src)) offenders.push(`${rel}: fillDetailStatement(`);
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(offenders, [], 'a producer now sends audit bodies to the Audit service, whose read surface admits non-owner full admins');
});
