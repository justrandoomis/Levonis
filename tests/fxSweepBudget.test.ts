/**
 * FX-5 — THE QUARTER-HOUR INVOCATION STAYS UNDER D1'S 1,000 STATEMENTS
 * (FX programme plan §7.4, critique H2; DECISIONS rows 198 and 201).
 *
 * The `*\/15` tick runs every job in ONE Worker invocation. D1 allows 1,000
 * queries per invocation, a batch counting each statement. The share-out is
 * worker/lib/quarterHourBudget.ts: the staff reconciliation (one job, one
 * order a tick), the durable jobs and the upload-session sweep (200) run
 * together within their own bounds; once they have settled, the search-index
 * catch-up spends only what they left of 1,000 less the reserve; FX-5's
 * engine sweep runs last with what is left after that.
 *
 * This runs the REAL `scheduled()` handler of worker/index.ts on a real
 * database: the census products with a dozen engine-priced products left
 * stale by a rate move, two staff recalculations waiting (24 delivered orders
 * each), 200 expired upload sessions and 200 closed ones to delete, a full
 * outbox and — on a catch-up tick — the whole catalogue's search index stale.
 * Every statement the invocation executes is counted at the binding. Proves:
 *   - the invocation's total stays under 1,000 with EVERY job at its bound at
 *     once, the sweep included;
 *   - the catch-up runs after the jobs and spends no more than they left
 *     (`quarterHourSearchBudget`), the sweep last within what is left
 *     (`quarterHourSweepBudget`: its 200, cut to 1,000 − 50 − the rest);
 *   - the catch-up's backfill pays for the search aliases (Bambu import spec
 *     §C.1, migration 0194: every census product here carries a part code, a
 *     colour code and an identity model and series) inside its own share: the
 *     presence probe once per binding and one alias read per 90 products;
 *   - the jobs' own statements are the same with and without sweep work;
 *   - nothing is lost to the pacing: tick after tick the staff recalculations,
 *     the index and the stale prices finish, each tick under the limit, and
 *     end exactly where the same work done unpaced ends.
 *
 * Run: node --import tsx --test tests/fxSweepBudget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asD1, count, json, post, stubApp } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { SqliteD1, type SqliteStatement } from './fixtures/d1';
import worker from '../worker/index';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { planOrderFinanceSnapshot } from '../worker/lib/orderFinance';
import { listPricedProducts } from '../worker/lib/pricingEngine/load';
import { AUTO_REPRICE_SWEEP_BUDGET, D1_INVOCATION_STATEMENT_LIMIT, QUARTER_HOUR_RESERVE, quarterHourSweepBudget, sweepStaleEnginePrices } from '../worker/lib/fx/reprice';
import { statementBudget } from '../worker/lib/fx/budget';
import { countingD1, d1Base } from '../worker/lib/d1Count';
import { COMPLETENESS_TICK_BUDGET, PRINT_CLOUD_TICK_BUDGET, QUARTER_HOUR_TICK_LIMIT, REQUEST_MODEL_TICK_BUDGET, SERVICES_TICK_BUDGET, STAFF_RECONCILIATION_TICK, quarterHourCompletenessBudget, quarterHourPrintCloudBudget, quarterHourRequestModelBudget, quarterHourSearchBudget, quarterHourServicesBudget } from '../worker/lib/quarterHourBudget';
import { drainStaffReconciliations } from '../worker/lib/financeStaffAccrual';
import { INDEX_FAILED_MARK, INDEX_STAMP, backfillSearchIndex } from '../worker/lib/search/store';
import { resetEventBus } from '../worker/lib/eventBus';
import type { Env } from '../worker/lib/types';
import { writeV2 } from './fixtures/pricingV2';

// ------------------------------------------------------------- counting at the binding

/** The engine sweep's first read (autoReprice.ts ENGINE_STATES_SQL): no other quarter-hour job runs it. */
const SWEEP_FIRST = /FROM product_pricing_state s JOIN products p ON p\.id = s\.product_id\s+WHERE s\.mode = 'engine'/;
/** The search-index catch-up's first statement (jobs.ts `catchUpSearchIndex`): no other quarter-hour job runs it. */
const CATCH_UP_FIRST = 'PRAGMA table_info("search_tokens")';
/** One-time saved-price repair runs after repricing and has its own bounded share. */
const RECEIVED_RECOVERY_FIRST = /^SELECT product_id, inputs_seq, write_seq FROM pricing_received_recovery/;
/**
 * The completeness catch-up's first statement (productCompleteness.ts `sweepCompleteness`, after the engine
 * sweep): its presence probe on the tick's counted binding, or its facts read once the table is known.
 */
const COMPLETENESS_FIRST = /^SELECT 1 AS x FROM product_completeness LIMIT 1$|^SELECT p\.id AS id, p\.slug AS slug, p\.status AS status/;
/**
 * The services sweep's first statement (Services S-P2, worker/lib/tradeInSweep.ts, after the completeness
 * catch-up): the 0192 probe on a fresh binding, or its settings read and first trade-in read once known.
 */
const SERVICES_FIRST = /^SELECT intake_at, valuation_version FROM trade_in_requests LIMIT 0$|WHERE status IN \('submitted','under_review','value_changed'\) AND intake_at IS NULL AND offer_expires_at IS NULL/;
/** The request-model cache's first statement (P1-04, worker/lib/requestModelBackfill.ts, after the services sweep): its page read. */
const REQUEST_MODEL_FIRST = /FROM community_print_requests\s+WHERE model_mirror = '' AND schema_version = 1/;
/** Levonis Print Cloud's step (0215, DECISIONS row 271): the first statement that names one of its tables. */
const PRINT_CLOUD_FIRST = /\bpc_[a-z_]+/;

class CountStmt {
  constructor(
    readonly inner: SqliteStatement,
    private readonly log: string[],
    private readonly sql: string
  ) {}
  get yieldsRows() {
    return this.inner.yieldsRows;
  }
  bind(...values: unknown[]) {
    return new CountStmt(this.inner.bind(...values), this.log, this.sql);
  }
  run() {
    this.log.push(this.sql);
    return this.inner.run();
  }
  first<T = Record<string, unknown>>() {
    this.log.push(this.sql);
    return this.inner.first<T>();
  }
  all<T = Record<string, unknown>>() {
    this.log.push(this.sql);
    return this.inner.all<T>();
  }
  raw<T = unknown[]>() {
    this.log.push(this.sql);
    return (this.inner as unknown as { raw: () => Promise<T[]> }).raw();
  }
}

/** Every statement the invocation executes, in order (a batch logs each of its statements). */
class CountD1 {
  readonly log: string[] = [];
  private readonly inner: SqliteD1;
  constructor(raw: DatabaseSync) {
    this.inner = new SqliteD1(raw);
  }
  prepare(sql: string) {
    return new CountStmt(this.inner.prepare(sql), this.log, sql);
  }
  async batch(statements: CountStmt[]) {
    for (const s of statements) this.log.push((s as unknown as { sql: string }).sql ?? '(batch)');
    return this.inner.batch(statements.map((s) => s.inner));
  }
}

const event = () => ({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} }) as unknown as ScheduledEvent;

/** One quarter-hour tick of the real handler; every promise it hands to waitUntil settled. */
async function tick(raw: DatabaseSync) {
  resetEventBus();
  const d1 = new CountD1(raw);
  const env = { DB: d1 as unknown as D1Database, INITIAL_ADMIN_EMAIL: 'boss@x.co', STORE_ROOT_DOMAIN: 'levonis-iq.com' } as unknown as Env;
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    worker.scheduled(event(), env, ctx);
    // Five: the fifth is the image-copy sweep (DECISIONS row 226), which lists R2
    // and runs no D1 statement — every count below is unchanged by it.
    assert.equal(waited.length, 5, 'five jobs handed to waitUntil');
    await Promise.all(waited);
  } finally {
    console.error = original;
  }
  // Print Cloud's tasks run last of all (worker/index.ts, DECISIONS row 271), the request-model cache
  // (P1-04) before them, the services sweep before it, the completeness catch-up before that, on what
  // the engine sweep left.
  const pc = d1.log.findIndex((sql) => PRINT_CLOUD_FIRST.test(sql));
  const cloud = pc === -1 ? d1.log.length : pc;
  const rm = d1.log.slice(0, cloud).findIndex((sql) => REQUEST_MODEL_FIRST.test(sql));
  const tail = rm === -1 ? cloud : rm;
  const svc = d1.log.slice(0, tail).findIndex((sql) => SERVICES_FIRST.test(sql));
  const stop = svc === -1 ? tail : svc;
  const last = d1.log.slice(0, stop).findIndex((sql) => COMPLETENESS_FIRST.test(sql));
  const end = last === -1 ? stop : last;
  const recovery = d1.log.slice(0, end).findIndex((sql) => RECEIVED_RECOVERY_FIRST.test(sql));
  const sweepEnd = recovery === -1 ? end : recovery;
  const first = d1.log.slice(0, sweepEnd).findIndex((sql) => SWEEP_FIRST.test(sql));
  const jobs = first === -1 ? sweepEnd : first;
  // The tick's own jobs end where the catch-up's probe begins (it runs once, after them, or not at all).
  const probes = d1.log.flatMap((sql, i) => (sql === CATCH_UP_FIRST ? [i] : []));
  assert.ok(probes.length <= 1, 'the catch-up probe runs once a tick, and no other job runs it');
  const own = probes.length === 1 && probes[0] < jobs ? probes[0] : jobs;
  return { total: d1.log.length, own, catchUp: jobs - own, jobs, sweep: sweepEnd - jobs, recovery: end - sweepEnd, completeness: stop - end, services: tail - stop, requestModel: cloud - tail, printCloud: d1.log.length - cloud, log: d1.log, errors };
}

// ------------------------------------------------------------- the world, every job at its bound

/**
 * Engine-priced products — since the clean start (spec addendum A.6) V2 products, the only ones the
 * automatic run selects: cost-first through the V2 writer (USD supplier cost, Germany land 1 kg, a $20
 * minimum profit), skipping a census product this shape cannot price.
 */
async function adoptProducts(w: ReturnType<typeof pricingWorld>, n: number): Promise<string[]> {
  const out: string[] = [];
  for (const p of await listPricedProducts(w.db)) {
    if (out.length === n) break;
    if (p.id === AMS) continue;
    try {
      await writeV2(w.db, p.id, {
        method: 'cost',
        inputs: { supplier_cost_amount: String(100 + out.length * 50), supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1000 },
        minimumProfitUsd: '20',
      });
      out.push(p.id);
    } catch {
      /* not this product */
    }
  }
  assert.equal(out.length, n, 'enough census products adopt');
  return out;
}

/** Two staff recalculations waiting, each with more delivered orders than one page (10) takes. */
async function seedStaffRecalculations(raw: DatabaseSync) {
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
      ('emp_1','emp1@example.test','Sajjad','admin','assistant'),
      ('emp_2','emp2@example.test','Hussein','admin','assistant'),
      ('buyer_q','buyer_q@example.test','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES ('q_printer','Printer','quarter-printer',50000,0,'BASE');`);
  const db = asD1(raw);
  const boss = stubApp(db, { id: 'usr_owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => {
    a.route('/people', adminFinancePeopleRoutes);
    a.route('/operations', adminFinanceOperationsRoutes);
  });
  for (let i = 0; i < 24; i++) {
    const id = `q_ord_${String(i).padStart(2, '0')}`;
    const created = '2026-09-01T10:00:00.000Z';
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer_q','delivered','{}','standard','{}','cash',50000,1500,55000,55000,5000,?,?)`).run(id, created, `2026-09-${String(21 + (i % 8)).padStart(2, '0')}T10:00:00.000Z`);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,'q_printer','Printer',1,50000,50000,20000,'snapshot')`).run(`line:${id}`, id);
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES (?,'q_printer','base',1,0,20000,'opening',?)`).run(`lot:${id}`, created);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES (?,?,?,?,'base',1,20000,20000,?)`).run(`alloc:${id}`, id, `line:${id}`, `lot:${id}`, `consumed:${id}`);
    await db.batch(await planOrderFinanceSnapshot(db, id, [{ id: `line:${id}`, product_id: 'q_printer' }], created));
  }
  for (const user of ['emp_1', 'emp_2']) {
    const staff = await post(boss, '/people/staff', { user_id: user, start_work_date: '2026-09-20' });
    const staffBody = await json(staff);
    assert.equal(staff.status, 200, JSON.stringify(staffBody));
    const rule = await post(boss, '/operations/rules', { staff_id: staffBody.id, basis: 'unit', amount: 5000, milestone: 'delivered' });
    assert.equal(rule.status, 200, JSON.stringify(await json(rule)));
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM finance_staff_reconciliations WHERE state <> 'complete'"), 2, 'two recalculations wait');
}

/** 200 upload sessions past their expiry and 200 closed a week ago (the sweep's own bound, both halves). */
function seedUploadSessions(raw: DatabaseSync) {
  const insert = raw.prepare(
    `INSERT INTO upload_sessions (id, owner_id, purpose, declared_bytes, sha256, chunk_bytes, r2_upload_id, object_key, state, expires_at, updated_at)
     VALUES (?, 'usr_owner', 'asset', 1000, ?, 1000, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < 400; i++) {
    const open = i < 200;
    insert.run(`us_${i}`, 'a'.repeat(64), `r2_${i}`, `media/q/${i}`, open ? 'open' : 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  }
}

/** More outbox mail than a run delivers (25 a step). */
function seedOutbox(raw: DatabaseSync) {
  const insert = raw.prepare("INSERT INTO outbox (id, kind, event_key, recipient, payload, state, created_at) VALUES (?, 'email', ?, 'someone@example.test', ?, 'pending', ?)");
  for (let i = 0; i < 60; i++) insert.run(`ob_${i}`, `quarter:${i}`, JSON.stringify({ subject: 'x', text: 'y' }), `2026-10-0${1 + (i % 9)}T00:00:00.000Z`);
}

/**
 * THE SEARCH ALIASES OF MIGRATION 0194 on every product (Bambu import spec
 * §C.1): a searchable part code and colour code, an opaque store id the index
 * never reads, and the identity model and series. A catch-up tick's backfill
 * reads them (worker/lib/search/aliases.ts) and writes their tokens, so every
 * tick below carries the alias read and the larger documents it brings.
 */
function seedSearchAliases(raw: DatabaseSync): void {
  const ids = (raw.prepare('SELECT id FROM products ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
  const ext = raw.prepare('INSERT INTO product_external_ids (product_id, id_type, value, searchable) VALUES (?, ?, ?, ?)');
  const spec = raw.prepare(
    `INSERT INTO product_spec_values (id, product_id, canonical_key, group_key, data_type, value_text, status, confidence, source_kind, source_ref)
     VALUES (?, ?, ?, 'identity', 'string', ?, 'verified', 'official_page', 'store_page', 'https://store.example/p')`
  );
  ids.forEach((id, i) => {
    ext.run(id, 'part_code', `FAP${100 + i}`, 1);
    ext.run(id, 'color_code', String(20000 + i), 1);
    ext.run(id, 'bambu_product_id', String(9_000_000_000 + i), 0);
    spec.run(`psv_qm_${i}`, id, 'identity.model', `Q${i}X`);
    spec.run(`psv_qs_${i}`, id, 'identity.series', `Q${i} Series`);
  });
}

/** The alias loader's presence probe (worker/lib/catalogKnowledge.ts) and its read (worker/lib/search/aliases.ts). */
const ALIAS_PROBE = /^SELECT \(SELECT 1 FROM product_source_refs LIMIT 1\) AS r/;
const ALIAS_READ = /FROM product_external_ids\s+WHERE searchable = 1 AND product_id IN/;

/**
 * The world once, copied: the same jobs at their bound, with and without stale
 * engine products. `steady` is the live database's state: the search index is
 * current (every product save writes its own rows; the backfill of the
 * pre-0089 catalogue finished long ago), so that durable step does its one
 * cheap read. Without it, the copy is a CATCH-UP tick: the backfill indexes
 * its 50-product chunk in the same invocation.
 */
let template: string | null = null;
let scratch: string | null = null;
/** Every copy opened, closed before the scratch directory is removed (Windows cannot unlink an open file). */
const opened: DatabaseSync[] = [];
async function copies(opts: { steady: boolean; staff?: boolean }): Promise<{ stale: DatabaseSync; current: DatabaseSync; engine: string[] }> {
  let engine: string[] = [];
  if (!template) {
    const w = pricingWorld();
    engine = await adoptProducts(w, 12);
    await seedStaffRecalculations(w.raw);
    seedUploadSessions(w.raw);
    seedOutbox(w.raw);
    seedSearchAliases(w.raw);
    scratch = mkdtempSync(join(tmpdir(), 'levonis-fx-sweep-'));
    template = join(scratch, 'template.db');
    w.raw.exec(`VACUUM INTO '${template.replace(/'/g, "''")}'`);
  }
  let n = 0;
  const open = async () => {
    const file = join(scratch!, `copy_${process.pid}_${Date.now()}_${n++}.db`);
    copyFileSync(template!, file);
    const raw = new DatabaseSync(file);
    opened.push(raw);
    raw.exec('PRAGMA foreign_keys = ON;');
    if (opts.steady) {
      const done = await backfillSearchIndex(asD1(raw), { limit: 1000 });
      assert.deepEqual(done.failed, []);
    }
    // No staff recalculation waiting — the usual tick (one runs only after an employment change).
    if (!opts.staff) raw.exec("UPDATE finance_staff_reconciliations SET state = 'complete'");
    return raw;
  };
  const stale = await open();
  const current = await open();
  // A confirmed USD/IQD move (+6.25%): every engine product is stale in one copy, none in the other.
  applyRate(stale, 'USD_IQD', '1700');
  if (!engine.length) engine = (stale.prepare("SELECT product_id FROM product_pricing_state WHERE mode = 'engine' AND pricing_method IS NOT NULL").all() as Array<{ product_id: string }>).map((r) => r.product_id);
  return { stale, current, engine };
}

process.on('exit', () => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Engine products whose stored figures were computed at the old USD/IQD (1,600) — the sweep's work. */
const staleCount = (raw: DatabaseSync) => count(raw, "SELECT COUNT(DISTINCT product_id) AS n FROM pricing_v2_sku_results WHERE usd_iqd_rate <> '1700'");

// ------------------------------------------------------------- the tests

test('the usual tick at its bounds — 200 upload sessions expired and 200 deleted, a full outbox, the search index current, no staff recalculation waiting — plus a full FX-5 sweep: under 1,000 statements; the sweep last, within what the jobs left; the jobs the same with and without it', async () => {
  const { stale, current, engine } = await copies({ steady: true, staff: false });
  assert.equal(engine.length, 12);
  assert.equal(staleCount(stale), 12, 'a dozen engine products wait for the sweep');

  const withSweep = await tick(stale);
  const without = await tick(current);

  // Every job did its bounded work.
  assert.equal(count(stale, "SELECT COUNT(*) AS n FROM upload_sessions WHERE state = 'expired'"), 200, '200 expired sessions closed');
  assert.equal(count(stale, 'SELECT COUNT(*) AS n FROM upload_sessions'), 200, '200 closed sessions deleted');
  assert.ok(withSweep.log.some((sql) => /UPDATE outbox SET attempts = attempts \+ 1/.test(sql)), 'the outbox was worked');

  // The sweep repriced what its share allowed — deficit first — and the rest wait for the next tick.
  const left = staleCount(stale);
  assert.ok(left < 12, `the sweep repriced some (${12 - left})`);
  assert.ok(left > 0, 'a dozen do not fit one tick');

  // THE LIMIT: the invocation's total, the sweep's share, the jobs untouched.
  const share = quarterHourSweepBudget(withSweep.jobs);
  assert.ok(withSweep.total < D1_INVOCATION_STATEMENT_LIMIT, `the tick executed ${withSweep.total} statements (jobs ${withSweep.jobs}, sweep ${withSweep.sweep})`);
  assert.ok(withSweep.sweep <= share && share <= AUTO_REPRICE_SWEEP_BUDGET, `the sweep spent ${withSweep.sweep} of its ${share}`);
  assert.ok(withSweep.total <= Math.max(withSweep.jobs, D1_INVOCATION_STATEMENT_LIMIT - QUARTER_HOUR_RESERVE));
  assert.equal(withSweep.jobs, without.jobs, `the jobs executed the same statements with and without sweep work (${withSweep.jobs} / ${without.jobs})`);
  assert.ok(without.sweep <= 4, `nothing stale: one indexed read and the rates (${without.sweep})`);
  assert.ok(without.recovery <= 2, 'no saved receipt prices or old holds: two indexed recovery reads');
  assert.ok(withSweep.recovery <= Math.min(200, quarterHourSearchBudget(withSweep.jobs + withSweep.sweep)), 'recovery spends only what the preceding jobs left');
  // The sweep's first statement comes after every job's last: it ran LAST.
  assert.ok(withSweep.log.slice(withSweep.jobs).every((sql) => !/upload_sessions|finance_staff_reconciliations|FROM outbox|search_tokens/.test(sql)));
  // The completeness catch-up (0184) after the sweep, within its own share of what the sweep left.
  const completenessShare = quarterHourCompletenessBudget(withSweep.jobs + withSweep.sweep + withSweep.recovery);
  assert.ok(withSweep.completeness <= completenessShare && completenessShare <= COMPLETENESS_TICK_BUDGET, `the completeness catch-up spent ${withSweep.completeness} of its ${completenessShare}`);
  const lateSweep = withSweep.log.slice(withSweep.jobs + withSweep.sweep + withSweep.recovery).filter((sql) => /(?:INSERT INTO|UPDATE) pricing_(?:sku_costs|v2_sku_results)|upload_sessions|FROM outbox|search_tokens/.test(sql));
  assert.deepEqual(lateSweep, [], 'nothing of the sweep or the jobs after the completeness catch-up began');
  // The services sweep (S-P2) last of all, within its own share of what everything before it left.
  const servicesShare = quarterHourServicesBudget(withSweep.total - withSweep.services);
  assert.ok(withSweep.services > 0, 'the services sweep looked');
  assert.ok(withSweep.services <= servicesShare && servicesShare <= SERVICES_TICK_BUDGET, `the services sweep spent ${withSweep.services} of its ${servicesShare}`);
  // The request-model cache (P1-04) after it: one indexed read when nothing is pending.
  const beforeCloud = withSweep.total - withSweep.printCloud;
  assert.ok(withSweep.requestModel >= 1 && withSweep.requestModel <= quarterHourRequestModelBudget(beforeCloud - withSweep.requestModel), `the request-model cache spent ${withSweep.requestModel}`);
  // Print Cloud's tasks (DECISIONS row 271) last of all, within their own share of what everything before them left.
  const cloudShare = quarterHourPrintCloudBudget(beforeCloud);
  assert.ok(withSweep.printCloud >= 1 && withSweep.printCloud <= cloudShare && cloudShare <= PRINT_CLOUD_TICK_BUDGET, `Print Cloud spent ${withSweep.printCloud} of its ${cloudShare}`);
  assert.ok(withSweep.log.slice(beforeCloud).every((sql) => /\bpc_[a-z_]+|^SELECT COUNT\(\*\) AS n FROM sqlite_master/.test(sql)), 'nothing but Print Cloud after its step began');
  console.log(`usual quarter-hour tick at its bounds: jobs ${withSweep.jobs}, sweep ${withSweep.sweep} (share ${share}), completeness ${withSweep.completeness} (share ${completenessShare}), services ${withSweep.services} (share ${servicesShare}), total ${withSweep.total} < ${D1_INVOCATION_STATEMENT_LIMIT}`);
});

/**
 * Services S-P2 work at every sub-step's bound (worker/lib/tradeInSweep.ts): 30 requests open since
 * before the cut-over, 30 offers ending today, 30 ended, 30 credits ending today, 30 ended — more
 * than one tick takes of each.
 */
function seedServicesWork(raw: DatabaseSync) {
  const now = Date.now();
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
  raw.exec(`INSERT INTO users (id, email, name, role) VALUES ('svc_cust', 'svc@example.test', 'Svc', 'customer');
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, shipping_iqd, created_at, delivered_at)
      VALUES ('svc_ord', 'svc_cust', 'delivered', '{}', 'standard', '{}', 'cash', 0, 1500, 0, 0, 0, '2026-09-01T10:00:00.000Z', '2026-09-02T10:00:00.000Z');`);
  const line = raw.prepare(`INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd) VALUES (?, 'svc_ord', 'q_printer', 'Printer', 1, 0, 0)`);
  const request = raw.prepare(
    `INSERT INTO trade_in_requests (id, user_id, status, order_id, order_item_id, unit_index, family, scope, created_at, updated_at, submitted_at, offer_expires_at, intake_at, coupon_id, credit_iqd)
     VALUES (?, 'svc_cust', ?, 'svc_ord', ?, 1, 'fdm', 'whole', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?, ?, ?, ?)`
  );
  const coupon = raw.prepare(
    `INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active, created_at, assigned_user_id, scope, trade_in_id, ends_at)
     VALUES (?, ?, 'fixed_iqd', 100000, 0, 1, 1, 1, '2026-10-01T00:00:00.000Z', 'svc_cust', 'product', ?, ?)`
  );
  const kinds: Array<[string, string | null, string | null, string | null]> = [
    ['submitted', null, null, null], // cut-over
    ['submitted', at(12), null, null], // offer ending today
    ['submitted', at(-24), null, null], // offer ended
    ['awaiting_payment', at(72), at(-48), at(12)], // credit ending today
    ['awaiting_payment', at(72), at(-48), at(-24)], // credit ended
  ];
  kinds.forEach(([status, offerEnds, intake, creditEnds], k) => {
    for (let i = 0; i < 30; i++) {
      const id = `tin_svc_${k}_${i}`;
      line.run(`svc_oi_${k}_${i}`);
      const cpn = status === 'awaiting_payment' ? `cpn_svc_${k}_${i}` : null;
      request.run(id, status, `svc_oi_${k}_${i}`, offerEnds, intake, cpn, cpn ? 100000 : null);
      if (cpn) coupon.run(cpn, `TISVC${k}${String(i).padStart(3, '0')}`, id, creditEnds);
    }
  });
}

test('the services sweep LAST, with every sub-step at its bound: within its own 120 of what the tick left, and the tick under 1,000', async () => {
  const { current } = await copies({ steady: true, staff: false });
  seedServicesWork(current);
  const t = await tick(current);
  assert.deepEqual(t.errors, [], 'no job reported an error');
  const share = quarterHourServicesBudget(t.total - t.services);
  assert.ok(t.total < D1_INVOCATION_STATEMENT_LIMIT, `the tick executed ${t.total} statements`);
  assert.ok(t.services <= share && share <= SERVICES_TICK_BUDGET, `the services sweep spent ${t.services} of its ${share}`);
  assert.ok(t.services > 60, `the sweep worked up to its share (${t.services})`);
  assert.ok(count(current, "SELECT COUNT(*) AS n FROM trade_in_requests WHERE id LIKE 'tin_svc_0_%' AND offer_expires_at IS NOT NULL") > 0, 'cut-over stamps landed');
  // Nothing of the earlier steps after the services sweep began.
  assert.ok(t.log.slice(t.total - t.services).every((sql) => !/pricing_(?:sku_costs|v2_sku_results)|upload_sessions|FROM outbox|search_tokens|product_completeness/.test(sql)));
  console.log(`services sweep at its bound: ${t.services} of ${share}, total ${t.total} < ${D1_INVOCATION_STATEMENT_LIMIT}`);
});

/**
 * P1-04's cache at its bound: 100 version-1 print requests whose model was never built — four pages
 * more than one tick takes.
 */
function seedUnbuiltRequestModels(raw: DatabaseSync) {
  raw.exec(`INSERT INTO users (id, email, name, role) VALUES ('rm_cust', 'rm@example.test', 'Rm', 'customer')`);
  const req = raw.prepare(
    `INSERT INTO community_requests (id, customer_id, title, description, status, state, quantity, governorate)
     VALUES (?, 'rm_cust', 'A bracket', 'A bracket for a shelf', 'open', 'open', 1, 'baghdad')`
  );
  const print = raw.prepare(`INSERT INTO community_print_requests (request_id, material_id, colors_count, source_type) VALUES (?, 'pla', ?, 'description')`);
  for (let i = 0; i < 100; i++) {
    const id = `req_rm_${String(i).padStart(3, '0')}`;
    req.run(id);
    print.run(id, (i % 3) + 1);
  }
}

test('the request-model cache LAST, at its bound: within its own 40 of what the tick left, and the tick under 1,000', async () => {
  const { current } = await copies({ steady: true, staff: false });
  seedUnbuiltRequestModels(current);
  const t = await tick(current);
  assert.deepEqual(t.errors, [], 'no job reported an error');
  const beforeCloud = t.total - t.printCloud;
  const share = quarterHourRequestModelBudget(beforeCloud - t.requestModel);
  assert.ok(t.total < D1_INVOCATION_STATEMENT_LIMIT, `the tick executed ${t.total} statements`);
  assert.ok(t.requestModel <= share && share <= REQUEST_MODEL_TICK_BUDGET, `the request-model cache spent ${t.requestModel} of its ${share}`);
  assert.ok(t.printCloud <= quarterHourPrintCloudBudget(beforeCloud), `Print Cloud after it, within its share (${t.printCloud})`);
  assert.ok(t.requestModel > 20, `the cache worked up to its share (${t.requestModel})`);
  const built = count(current, "SELECT COUNT(*) AS n FROM community_print_requests WHERE request_id LIKE 'req_rm_%' AND model_mirror <> ''");
  assert.ok(built >= 50 && built < 100, `whole pages built, the rest left for the next tick (${built})`);
  // Nothing of the earlier steps after the cache began.
  assert.ok(t.log.slice(beforeCloud - t.requestModel).every((sql) => !/trade_in_requests|pricing_(?:sku_costs|v2_sku_results)|upload_sessions|FROM outbox|search_tokens|product_completeness/.test(sql)));
  console.log(`request-model cache at its bound: ${t.requestModel} of ${share}, ${built} built, total ${t.total} < ${D1_INVOCATION_STATEMENT_LIMIT}`);
});

/** Active products whose index rows are missing or stale — the catch-up's work. */
const staleIndex = (raw: DatabaseSync) =>
  Number(
    (
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM products p WHERE p.status = 'active' AND NOT EXISTS (SELECT 1 FROM search_tokens t WHERE t.product_id = p.id AND t.token IN (?, ?))"
        )
        .get(INDEX_STAMP, INDEX_FAILED_MARK) as { n: number }
    ).n
  );
/** Staff recalculations still waiting (each one a durable cursor). */
const pendingStaff = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM finance_staff_reconciliations WHERE state <> 'complete'");
const ordersProcessed = (raw: DatabaseSync) => count(raw, 'SELECT COALESCE(SUM(processed_orders), 0) AS n FROM finance_staff_reconciliations');

test('EVERY job at its bound in ONE tick — a staff recalculation waiting (two jobs, 24 orders each), the whole search index stale (a catch-up), 200 upload sessions expired and 200 deleted, a full outbox — plus a full FX-5 sweep: under 1,000 statements; the catch-up spends only what the jobs left, the sweep last within what is left', async () => {
  assert.deepEqual({ ...STAFF_RECONCILIATION_TICK }, { maxJobs: 1, maxOrders: 1 }, 'one job, one order a tick');
  const { stale, current } = await copies({ steady: false, staff: true });
  const indexBefore = staleIndex(stale);
  assert.ok(indexBefore >= 40, `the whole catalogue waits for the index (${indexBefore})`);
  assert.equal(pendingStaff(stale), 2);
  assert.equal(staleCount(stale), 12);

  const withSweep = await tick(stale);
  const without = await tick(current);
  assert.deepEqual(withSweep.errors, [], 'no job reported an error');

  // Every job did its bounded work, the paced two included.
  assert.ok(withSweep.log.some((sql) => /UPDATE finance_staff_reconciliations SET cursor/.test(sql)), 'the staff recalculation moved');
  assert.equal(ordersProcessed(stale), 1, 'ONE order of ONE job this tick; the cursor resumes next tick');
  assert.equal(count(stale, "SELECT COUNT(*) AS n FROM upload_sessions WHERE state = 'expired'"), 200, '200 expired sessions closed');
  assert.equal(count(stale, 'SELECT COUNT(*) AS n FROM upload_sessions'), 200, '200 closed sessions deleted');
  assert.ok(withSweep.log.some((sql) => /UPDATE outbox SET attempts = attempts \+ 1/.test(sql)), 'the outbox was worked');
  const indexed = indexBefore - staleIndex(stale);
  assert.ok(indexed > 0, 'the catch-up indexed what fitted');

  // THE LIMIT, part by part.
  const searchShare = quarterHourSearchBudget(withSweep.own);
  const sweepShare = quarterHourSweepBudget(withSweep.jobs);
  assert.ok(withSweep.total < D1_INVOCATION_STATEMENT_LIMIT, `the tick executed ${withSweep.total} statements (jobs ${withSweep.own}, catch-up ${withSweep.catchUp}, sweep ${withSweep.sweep})`);
  assert.ok(withSweep.catchUp <= searchShare, `the catch-up spent ${withSweep.catchUp} of the ${searchShare} the jobs left`);
  assert.ok(withSweep.sweep <= sweepShare && sweepShare <= AUTO_REPRICE_SWEEP_BUDGET, `the sweep spent ${withSweep.sweep} of its ${sweepShare}`);
  assert.ok(withSweep.total <= Math.max(withSweep.own, QUARTER_HOUR_TICK_LIMIT), 'the catch-up and the sweep never take the tick past 1,000 − the reserve');
  assert.ok(withSweep.own < QUARTER_HOUR_TICK_LIMIT, `the jobs alone, every one at its bound: ${withSweep.own}`);
  // Order: the jobs, then the catch-up, then the sweep.
  assert.ok(withSweep.log.slice(withSweep.own).every((sql) => !/upload_sessions|finance_staff_reconciliations|FROM outbox/.test(sql)), 'nothing of the jobs after the catch-up began');
  assert.ok(withSweep.log.slice(withSweep.jobs).every((sql) => !/search_tokens/.test(sql)), 'nothing of the catch-up after the sweep began');
  // The jobs and the catch-up are the same with and without sweep work.
  assert.equal(withSweep.own, without.own, `the jobs: ${withSweep.own} / ${without.own}`);
  assert.equal(withSweep.catchUp, without.catchUp, `the catch-up: ${withSweep.catchUp} / ${without.catchUp}`);
  console.log(
    `every quarter-hour job at its bound: jobs ${withSweep.own}, catch-up ${withSweep.catchUp} (share ${searchShare}, ${indexed} of ${indexBefore} products), sweep ${withSweep.sweep} (share ${sweepShare}), total ${withSweep.total} < ${D1_INVOCATION_STATEMENT_LIMIT}`
  );
});

test('the alias read rides inside the catch-up: a catch-up tick sends the 0194 probe once and one alias read for its 50 products, all within the catch-up share — and the tick stays under its limit', async () => {
  const { stale } = await copies({ steady: false, staff: true });
  const before = staleIndex(stale);
  assert.ok(before >= 40, `the whole catalogue waits for the index (${before})`);
  const t = await tick(stale);
  assert.deepEqual(t.errors, [], 'no job reported an error');

  const catchUp = t.log.slice(t.own, t.jobs);
  const probes = t.log.flatMap((sql, i) => (ALIAS_PROBE.test(sql) ? [i] : []));
  const reads = t.log.flatMap((sql, i) => (ALIAS_READ.test(sql) ? [i] : []));
  assert.equal(probes.length, 1, 'the presence probe once a tick (live, too: worker/index.ts wraps a fresh counting binding every tick)');
  assert.equal(reads.length, 1, 'ONE alias read: a pass selects 50 products, one statement per 90');
  assert.ok([...probes, ...reads].every((i) => i >= t.own && i < t.jobs), 'both inside the catch-up, before the sweep');
  assert.equal(catchUp.filter((sql) => ALIAS_PROBE.test(sql) || ALIAS_READ.test(sql)).length, 2);

  // The catch-up, the alias read included, spent no more than the jobs left; the tick stays under its limit.
  const searchShare = quarterHourSearchBudget(t.own);
  assert.ok(t.catchUp <= searchShare, `the catch-up spent ${t.catchUp} of its ${searchShare}`);
  assert.ok(t.total <= Math.max(t.own, QUARTER_HOUR_TICK_LIMIT), `the tick: ${t.total} statements (limit ${QUARTER_HOUR_TICK_LIMIT})`);
  assert.ok(t.total < D1_INVOCATION_STATEMENT_LIMIT);

  // What it indexed carries the aliases.
  const indexed = before - staleIndex(stale);
  assert.ok(indexed > 0, 'the catch-up indexed what fitted');
  const withAliases = count(
    stale,
    `SELECT COUNT(DISTINCT t.product_id) AS n FROM search_tokens t
      WHERE t.token = ? AND EXISTS (SELECT 1 FROM search_tokens a WHERE a.product_id = t.product_id AND a.token LIKE 'fap1%')
        AND EXISTS (SELECT 1 FROM search_tokens s WHERE s.product_id = t.product_id AND s.token = 'series')`,
    INDEX_STAMP
  );
  assert.ok(withAliases >= indexed, `every product the tick indexed carries its part code and series (${withAliases} of ${indexed})`);
  assert.equal(count(stale, "SELECT COUNT(*) AS n FROM search_tokens WHERE token LIKE '90000000%'"), 0, 'never an opaque store id');
  console.log(`catch-up tick with the alias read: jobs ${t.own}, catch-up ${t.catchUp} (share ${searchShare}, ${indexed} products), total ${t.total} <= ${QUARTER_HOUR_TICK_LIMIT}`);
});

test('nothing is lost to the pacing: tick after tick the staff recalculations, the search index and the stale prices finish — every tick under 1,000 — and end exactly where the same work done unpaced ends', async () => {
  const paced = (await copies({ steady: false, staff: true })).stale;
  const reference = (await copies({ steady: false, staff: true })).stale;

  // UNPACED, on the reference copy: the same three pieces of work, no budget at all (the old bounds).
  resetEventBus();
  const refEnv = { DB: asD1(reference), INITIAL_ADMIN_EMAIL: 'boss@x.co', STORE_ROOT_DOMAIN: 'levonis-iq.com' } as unknown as Env;
  for (let i = 0; i < 10 && pendingStaff(reference) > 0; i++) await drainStaffReconciliations(refEnv, { maxJobs: 2, maxOrders: 25 });
  for (let i = 0; i < 10 && staleIndex(reference) > 0; i++) await backfillSearchIndex(asD1(reference), { limit: 50 });
  for (let i = 0; i < 10 && staleCount(reference) > 0; i++) await sweepStaleEnginePrices(refEnv, { trigger: 'sweep', budget: statementBudget(100_000) });
  assert.equal(pendingStaff(reference) + staleIndex(reference) + staleCount(reference), 0, 'the reference finished');

  // PACED: the real scheduled() handler, tick after tick.
  const totals: number[] = [];
  while ((pendingStaff(paced) > 0 || staleIndex(paced) > 0 || staleCount(paced) > 0) && totals.length < 150) {
    const t = await tick(paced);
    assert.deepEqual(t.errors, [], `tick ${totals.length + 1}: no job reported an error`);
    assert.ok(t.total < D1_INVOCATION_STATEMENT_LIMIT, `tick ${totals.length + 1}: ${t.total} statements`);
    totals.push(t.total);
  }
  assert.equal(pendingStaff(paced), 0, 'every staff recalculation finished');
  assert.equal(staleIndex(paced), 0, 'every product indexed');
  assert.equal(staleCount(paced), 0, 'every stale price repriced');

  // The same end state, row for row.
  const same = (sql: string, what: string) => assert.deepEqual(paced.prepare(sql).all(), reference.prepare(sql).all(), what);
  same(
    'SELECT order_id, order_item_id, rule_id, rule_version, staff_id, milestone, base_iqd, qty, amount_iqd, cost_day, state FROM finance_order_costs ORDER BY order_id, order_item_id, rule_id',
    'the same wage costs, each once'
  );
  same('SELECT staff_id, revision, state, processed_orders, adjusted_orders, error FROM finance_staff_reconciliations ORDER BY staff_id', 'the same recalculations');
  same('SELECT product_id, token, weight FROM search_tokens ORDER BY product_id, token', 'the same search index');
  assert.ok(
    count(paced, "SELECT COUNT(DISTINCT product_id) AS n FROM search_tokens WHERE token LIKE 'fap1%'") >= 40,
    'the index the pacing finished carries the aliases (one loader, every pass)'
  );
  same('SELECT product_id, combo_key, channel, usd_iqd_rate, replacement_cost_iqd, final_price_iqd FROM pricing_v2_sku_results ORDER BY product_id, combo_key, channel', 'the same engine figures');
  same('SELECT id, price_iqd FROM products ORDER BY id', 'the same prices');
  console.log(`paced to completion in ${totals.length} ticks, the largest ${Math.max(...totals)} statements (D1 allows ${D1_INVOCATION_STATEMENT_LIMIT})`);
});

test('the sweep yields: its share is its own 200 cut to what the jobs left of 1,000 less the reserve — and nothing when they left nothing', async () => {
  assert.equal(AUTO_REPRICE_SWEEP_BUDGET, 200);
  assert.equal(quarterHourSweepBudget(0), 200);
  assert.equal(quarterHourSweepBudget(700), 200);
  assert.equal(quarterHourSweepBudget(800), 150);
  assert.equal(quarterHourSweepBudget(949), 1);
  assert.equal(quarterHourSweepBudget(950), 0);
  assert.equal(quarterHourSweepBudget(5000), 0);
  // The catch-up's share before it: all the jobs left of 1,000 less the reserve.
  assert.equal(QUARTER_HOUR_TICK_LIMIT, 950);
  assert.equal(quarterHourSearchBudget(0), 950);
  assert.equal(quarterHourSearchBudget(589), 361);
  assert.equal(quarterHourSearchBudget(950), 0);
  assert.equal(quarterHourSearchBudget(5000), 0);
  for (let used = 0; used <= 1200; used += 7) {
    const search = quarterHourSearchBudget(used);
    const sweep = quarterHourSweepBudget(used + search);
    assert.ok(used + search + sweep <= Math.max(used, QUARTER_HOUR_TICK_LIMIT), `used ${used}: catch-up ${search}, sweep ${sweep}`);
  }
  for (let used = 0; used <= 1200; used += 7) {
    const share = quarterHourSweepBudget(used);
    assert.ok(share >= 0 && share <= 200);
    assert.ok(used + share < D1_INVOCATION_STATEMENT_LIMIT || share === 0, `used ${used}: share ${share}`);
  }

  // With the jobs having used 850, the real sweep on the stale world spends at most 100 — and with 950, none at all.
  for (const [used, cap] of [
    [850, 100],
    [950, 0],
  ] as const) {
    const { stale } = await copies({ steady: true });
    const d1 = new CountD1(stale);
    const env = { DB: d1 as unknown as D1Database, INITIAL_ADMIN_EMAIL: 'boss@x.co', STORE_ROOT_DOMAIN: 'levonis-iq.com' } as unknown as Env;
    const report = await sweepStaleEnginePrices(env, { trigger: 'sweep', budget: statementBudget(quarterHourSweepBudget(used)) });
    assert.ok(d1.log.length <= cap, `jobs ${used}: the sweep executed ${d1.log.length}, its share ${cap}`);
    assert.ok(used + d1.log.length < D1_INVOCATION_STATEMENT_LIMIT);
    if (cap === 0) assert.equal(report.skipped, 'BUDGET');
    else assert.ok(report.repriced.length >= 1 && report.repriced.length < 12, `${report.repriced.length} repriced in 100 statements`);
  }
});

test('the counting view is the binding: one view per binding, statements counted (a batch each of its own), the event bus sees the binding behind it', async () => {
  const raw = (await copies({ steady: true })).current;
  const base = asD1(raw);
  const a = countingD1(base);
  const b = countingD1(base);
  assert.equal(a.db, b.db, 'one view per binding (the memos keyed by it keep working across ticks)');
  assert.equal(countingD1(a.db).db, a.db, 'a view of the view is the view');
  assert.equal(d1Base(a.db), base);
  assert.equal(d1Base(base), base);
  const start = a.executed;
  await a.db.prepare('SELECT 1 AS one').first();
  await a.db.prepare('SELECT ? AS v').bind(2).all();
  await a.db.batch([a.db.prepare('SELECT 1'), a.db.prepare('SELECT 2').bind(), a.db.prepare('SELECT 3')]);
  assert.equal(a.executed - start, 5);
  // The statements reach the real database unchanged.
  const got = await a.db.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>();
  assert.equal(got?.n, count(raw, 'SELECT COUNT(*) AS n FROM products'));
  // The event bus answers for the view as for the binding (worker/lib/eventBus.ts busFor).
  const bus = await import('../worker/lib/eventBus');
  bus.resetEventBus();
  bus.configureEventBus({ DB: base, EVENT_BUS_ENABLED: 'on' } as unknown as Env);
  assert.ok(bus.busFor(base), 'the binding has its bus');
  assert.equal(bus.busFor(a.db), bus.busFor(base), 'the view has the same bus');
  assert.equal(bus.busFor(asD1(raw)), null, 'another binding has none');
  bus.resetEventBus();
});
