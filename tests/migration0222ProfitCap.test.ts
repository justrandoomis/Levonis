/**
 * MIGRATION 0222 — THE PROFIT CEILING OF AN ESTIMATED PRICE, PROVEN ON THE REAL SCHEMA
 * (owner decisions 2026-11-05, DECISIONS row 291; docs/SMART_PRICING.md §4.11).
 *
 *   harness      scripts/migrate-check.mjs --twice is green with 0222: one ADD COLUMN, present after the first
 *                pass, the second pass a no-op, no foreign-key violation
 *   column       `price_estimate_types.profit_cap_pct`, nullable, NULL for every seeded type — no seed, nothing
 *                hard-coded (I8); its CHECK takes a percentage of cost from 0 to 100, two decimals
 *   import       the 0218 guard triggers refuse writing it inside an import batch, as every other figure
 *   the door     PUT /estimates/types/:key writes it in a statement of its own, audited with its figures in
 *                `pricing_audit` (before → after) and by NAME only in `audit_log`; 0 is a ceiling (the floor),
 *                null clears it; a figure the CHECK would refuse is refused first (400), never a 500; a column
 *                gone between the read and the write is refused as not installed (503), nothing written; POST
 *                /estimates/types answers and audits the new type's ceiling (null) as GET does
 *   before 0222  the column is absent
 *
 * LOCAL ONLY: in-memory SQLite and a temporary directory, no network.
 *
 * Run: node --import tsx --test tests/migration0222ProfitCap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { all, asD1, dbThrough, freshDb, get, hasColumn, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { OWNER_ROW_SQL } from './fixtures/fx';
// @ts-expect-error — plain JS module shared with scripts/
import { splitStatements } from '../scripts/lib/sql-split.mjs';
import { IMPORT_GUARD_ID, IMPORT_GUARD_REFUSAL } from '../worker/lib/catalogImport/protectedTables';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const FILE = '0222_estimate_profit_cap.sql';
const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';

/** The refusal's message, or null when `sql` went through — run in a savepoint, so a refused batch leaves nothing (as a D1 batch). */
function refusal(db: DatabaseSync, sql: string): string | null {
  db.exec('SAVEPOINT t');
  try {
    db.exec(sql);
    db.exec('RELEASE t');
    return null;
  } catch (e) {
    db.exec('ROLLBACK TO t');
    db.exec('RELEASE t');
    return String((e as Error).message);
  }
}

test('the file is one additive ADD COLUMN, with no seed', () => {
  const sql = readFileSync(join(ROOT, 'migrations', FILE), 'utf8');
  const statements = splitStatements(sql) as string[];
  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /^ALTER TABLE price_estimate_types ADD COLUMN profit_cap_pct TEXT CHECK \(/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(INSERT|UPDATE|DELETE|DROP)\b/i, 'additive: no row written, nothing dropped');
});

test('scripts/migrate-check.mjs --twice: 0222 applies once, its column is there, the second pass is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-mc-0222-'));
  try {
    const out = execFileSync(process.execPath, ['scripts/migrate-check.mjs', '--twice'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MIGRATE_CHECK_DIR: dir },
      timeout: 180_000,
    });
    assert.match(out, new RegExp(`✔ ${FILE.replace('.', '\\.')} \\(1 statements\\)`));
    assert.match(out, /second full pass applied 0 files/);
    assert.match(out, /foreign_key_check violations: 0/);
    // While 0222 is the newest file, the harness proves its column is present (an ADD COLUMN is not re-runnable).
    const newest = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort().at(-1);
    if (newest === FILE) assert.match(out, new RegExp(`✔ ${FILE.replace('.', '\\.')} is 1 ADD COLUMN\\(s\\), every one present`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the column: absent before 0222; nullable and NULL for every seeded type; its CHECK is the ceiling’s grammar, 0 to 100', () => {
  assert.equal(hasColumn(dbThrough('0221'), 'price_estimate_types', 'profit_cap_pct'), false, 'a database before 0222 has no such column');
  const db = freshDb();
  assert.equal(hasColumn(db, 'price_estimate_types', 'profit_cap_pct'), true);
  const caps = all<{ key: string; profit_cap_pct: string | null }>(db, 'SELECT key, profit_cap_pct FROM price_estimate_types ORDER BY key');
  assert.equal(caps.length, 13);
  assert.ok(caps.every((c) => c.profit_cap_pct === null), 'no seed: the owner types every ceiling');
  // The owner's own ceilings of 2026-11-05 (3–10%), 0 (the floor) and the ends of the range.
  for (const ok of ['0', '3', '4', '6', '8', '10', '0.01', '37.5', '99.99', '100', '100.00']) {
    assert.equal(refusal(db, `UPDATE price_estimate_types SET profit_cap_pct = '${ok}' WHERE key = 'spare_part'`), null, ok);
  }
  assert.equal(refusal(db, "UPDATE price_estimate_types SET profit_cap_pct = NULL WHERE key = 'spare_part'"), null, 'NULL is no ceiling');
  for (const bad of ['-1', '37.123', '1e2', '37,5', '100.01', '101', '1000', '37.', '.5', '25%', '']) {
    assert.match(refusal(db, `UPDATE price_estimate_types SET profit_cap_pct = '${bad}' WHERE key = 'spare_part'`) ?? 'went through', /CHECK constraint failed/, bad);
  }
});

test('the import guard refuses writing the cap inside an import batch, as every other figure of the table', () => {
  const db = freshDb();
  const armed = `INSERT INTO ops_guards (id, ok) VALUES ('${IMPORT_GUARD_ID}', 1); UPDATE price_estimate_types SET profit_cap_pct = '25' WHERE key = 'spare_part'; DELETE FROM ops_guards WHERE id = '${IMPORT_GUARD_ID}';`;
  assert.equal(refusal(db, armed), IMPORT_GUARD_REFUSAL);
  assert.equal(row<{ p: string | null }>(db, "SELECT profit_cap_pct AS p FROM price_estimate_types WHERE key = 'spare_part'")!.p, null);
  assert.equal(refusal(db, "UPDATE price_estimate_types SET profit_cap_pct = '25' WHERE key = 'spare_part'"), null, 'disarmed, the owner’s write goes through');
});

test('PUT /estimates/types/:key writes the cap in a statement of its own, audited (figures in pricing_audit, the name only in audit_log); null clears it', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const app = stubApp(
    asD1(raw),
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
    },
    { publishV2: false }
  );
  const typeOf = async (key: string) => ((await json(await get(app, `${BASE}/types`))).types as Json[]).find((t) => t.key === key)!;
  const before = await typeOf('spare_part');
  assert.equal(before.profit_cap_pct, null, 'the key is answered: the field is offered');

  const res = await put(app, `${BASE}/types/spare_part`, { version: before.version, profit_cap_pct: '25.50' });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual([body.type.profit_cap_pct, body.type.version], ['25.5', before.version + 1], 'stored canonical');
  assert.equal(row<{ p: string }>(raw, "SELECT profit_cap_pct AS p FROM price_estimate_types WHERE key = 'spare_part'")!.p, '25.5');
  const audit = row<Json>(raw, "SELECT entity, action, pricing_before_json, pricing_after_json FROM pricing_audit WHERE entity_key = 'estimate_type:spare_part'")!;
  assert.deepEqual([audit.entity, audit.action], ['rule', 'rule_set']);
  assert.equal(JSON.parse(audit.pricing_before_json).profit_cap_pct, null);
  assert.equal(JSON.parse(audit.pricing_after_json).profit_cap_pct, '25.5');
  const log = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'price_estimate.type_set' AND target = 'spare_part'")!;
  assert.deepEqual(JSON.parse(log.detail), { key: 'spare_part', fields: ['profit_cap_pct'] }, 'the name, never the figure');

  // Refused before any write, by name: a figure the CHECK would refuse, a number, a comma.
  for (const bad of ['100.01', '101', '1000', '-1', '37.123', '37,5', 25, 0, '']) {
    const r = await put(app, `${BASE}/types/spare_part`, { version: before.version + 1, profit_cap_pct: bad });
    const b = await json(r);
    assert.deepEqual([r.status, b.code, b.details?.field], [400, 'PRICING_INPUT_INVALID', 'profit_cap_pct'], JSON.stringify(bad));
  }
  // Another figure alone leaves the ceiling as it is; 0 is a ceiling (the floor), stored canonical; null clears it.
  const other = await json(await put(app, `${BASE}/types/spare_part`, { version: before.version + 1, min_profit_usd: '6' }));
  assert.deepEqual([other.type.min_profit_usd, other.type.profit_cap_pct], ['6', '25.5']);
  const zero = await json(await put(app, `${BASE}/types/spare_part`, { version: before.version + 2, profit_cap_pct: '0.00' }));
  assert.equal(zero.type.profit_cap_pct, '0');
  assert.equal(row<{ p: string | null }>(raw, "SELECT profit_cap_pct AS p FROM price_estimate_types WHERE key = 'spare_part'")!.p, '0');
  const full = await json(await put(app, `${BASE}/types/spare_part`, { version: before.version + 3, profit_cap_pct: '100' }));
  assert.equal(full.type.profit_cap_pct, '100');
  const cleared = await json(await put(app, `${BASE}/types/spare_part`, { version: before.version + 4, profit_cap_pct: null }));
  assert.equal(cleared.type.profit_cap_pct, null);
  assert.equal(row<{ p: string | null }>(raw, "SELECT profit_cap_pct AS p FROM price_estimate_types WHERE key = 'spare_part'")!.p, null);
});

test('POST /estimates/types answers and audits the new type’s cap (null) as GET does; a column gone between the read and the write is refused as not installed, nothing written', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const mount = (db: unknown) =>
    stubApp(
      db,
      OWNER,
      (a) => {
        a.use('/api/admin/*', noStoreUnlessSet);
        a.route('/api/admin/pricing', adminPricingRoutes);
        a.route(BASE, adminPriceEstimatesRoutes);
      },
      { publishV2: false }
    );
  const app = mount(asD1(raw));
  const res = await post(app, `${BASE}/types`, { key: 'resin', name_ar: 'راتنج', name_en: 'Resin', name_ckb: 'ڕێزن', sourcing: 'CHINA_CNY', route: 'sea' });
  const created = await json(res);
  assert.equal(res.status, 201, JSON.stringify(created));
  assert.equal(created.type.profit_cap_pct, null, 'the key is answered, as GET answers it: no cap, the field offered');
  const listed = ((await json(await get(app, `${BASE}/types`))).types as Json[]).find((t) => t.key === 'resin')!;
  assert.deepEqual({ ...created.type, updated_at: '' }, { ...listed, updated_at: '' });
  const audit = row<Json>(raw, "SELECT action, pricing_after_json FROM pricing_audit WHERE entity_key = 'estimate_type:resin'")!;
  assert.deepEqual([audit.action, JSON.parse(audit.pricing_after_json).profit_cap_pct], ['create', null]);

  // A database restored behind 0222 after the type was read: the cap's own statement fails — 503, never a 500, and
  // the batch leaves nothing (the row's other figures neither).
  const real = asD1(raw);
  const gone = {
    prepare: (sql: string) => real.prepare(sql),
    batch: async (statements: Array<{ sql: string }>) => {
      if (statements.some((s) => /SET profit_cap_pct/.test(s.sql))) throw new Error('D1_ERROR: no such column: profit_cap_pct: SQLITE_ERROR');
      return real.batch(statements as never);
    },
  };
  const spare = ((await json(await get(app, `${BASE}/types`))).types as Json[]).find((t) => t.key === 'spare_part')!;
  const refused = await put(mount(gone), `${BASE}/types/spare_part`, { version: spare.version, min_profit_usd: '7', profit_cap_pct: '25' });
  const body = await json(refused);
  assert.deepEqual([refused.status, body.code, body.details?.field], [503, 'PRICE_ESTIMATES_NOT_INSTALLED', 'profit_cap_pct']);
  const stored = row<{ v: number; m: string | null; p: string | null }>(raw, "SELECT version AS v, min_profit_usd AS m, profit_cap_pct AS p FROM price_estimate_types WHERE key = 'spare_part'")!;
  assert.deepEqual([stored.v, stored.m, stored.p], [spare.version, spare.min_profit_usd, null], 'nothing written');
});
