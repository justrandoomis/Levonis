/**
 * LEAK AUDIT — candidate `audit-detail-readers-no-cost-strip-guard-gap`
 * (channel: logs-errors / audit rows, the non-owner readers of
 * `audit_log.detail`).
 *
 * THE CLAIM. These readers hand `audit_log.detail` to a non-owner:
 *   - GET /api/gifts/admin/grants/:id and /:id/audit   (giftAuditTimeline, raw)
 *   - GET /api/devices/admin/units/:unitId/history     (device.%, maskedDetail)
 *   - GET /api/devices/admin/serial-inventory/:serial  (serial_inventory.% + device.%,
 *                                                       and the story: serial% / device.% /
 *                                                       warranty.%, maskedDetail)
 *   - GET /api/admin/warranties/:id                    (warranty.%, maskedDetail)
 *   - GET /api/merchant/orders/:id/timeline            (order.status)
 * Each filters by an action prefix only. `maskedDetail` masks serials and
 * order refs; it does not strip FINANCIAL_FIELDS. `audit()` stores any object.
 * No action under these prefixes carries a cost TODAY (the candidate checked,
 * and this audit re-checked every writer and the 0175 / 0178 triggers), so the
 * claim is a GUARD GAP: the first `audit()` that puts a cost under one of
 * these prefixes reaches assistants and full admins, and no guard catches it.
 *
 * WHAT THIS TEST RUNS — locally, on in-memory databases, no network:
 *   1. The gift world (real gift routes): the owner grants a gift; the REAL
 *      writer `audit()` records a `gift.fulfill` row whose detail carries the
 *      lot cost / COGS of the gifted unit (sentinels); the timeline is read as
 *      a full admin, a NULL-scope admin and an assistant.
 *   2. The serial world (real admin + device + warranty routes): an order is
 *      scanned and delivered (a real unit, a real serial asset), a receipt is
 *      issued; `audit()` records `device.unit_replace`, `serial_inventory.update`
 *      (cost nested under `to`), `serial.released` and `warranty.replaced`, each
 *      carrying a sentinel cost; the unit history, the serial page (row
 *      history + story) and the receipt are read as the same three non-owners.
 *   3. The merchant order timeline (real route): `audit()` records an
 *      `order.status` row with a cost; the store owner reads the timeline.
 *   4. THE GUARD: the role-matrix fixture (tests/fixtures/roleMatrix.ts) —
 *      what every cost sweep runs on — is asked whether its sweep of these
 *      readers ever reads a populated history.
 *
 * Positive controls: each body is scanned BEFORE the cost row is written (it
 * must be clean, so a later hit is the audit row and nothing else), and the
 * owner reads the same row back (so a clean non-owner answer would be a strip,
 * not a missing row).
 *
 * RESULT ON THE AUDITED CODE: 1, 2 and 4 FAIL (the guard gap is real: every
 * admin history reader serves a cost-bearing detail to a full admin, a
 * NULL-scope admin and an assistant, nested keys included, and the role
 * matrix never reads a populated history); 3 PASSES (the merchant timeline
 * projects `order.status` to `to` / `stage` / `stage_recorded` in
 * buildOrderTimeline — that part of the candidate does not hold).
 *
 * Run: node --import tsx --test tests/leakAudit_logs-errors_audit_detail_readers_no_cost_strip_guard_gap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, get, json, patch, post, row, stubApp, type StubUser } from './fixtures/app';
import { COST, DECIMAL_SENTINELS, leaks } from './fixtures/costlyProduct';
import { ROLES, appFor, call, getPaths, seededCopy } from './fixtures/roleMatrix';
import { world, order, op, SN, mountSerialWorld } from './fixtures/serialPrep';
import { BOSS, PLAIN, appAs, giftWorld, grantOk } from './fixtures/giftWorld';
import { OWNER as STORE_OWNER, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import { merchantOrderRoutes } from '../worker/routes/merchantOrders';
import { audit } from '../worker/lib/audit';

/**
 * What a future audit() might plausibly record next to a gift, a unit, a
 * serial or a receipt: the lot it came from and what that lot cost. Every
 * figure is a sentinel the leak scanner knows; every key is in FINANCIAL_FIELDS.
 */
const COST_DETAIL = {
  lot_id: 'lot1',
  unit_cost_iqd: COST.lotUnit,
  cogs_iqd: COST.orderCogs,
  supplier_cost: COST.purchaseUnit,
  fx_rate: DECIMAL_SENTINELS.fxRate,
} as const;

/** The non-owner admins that pass requireAdmin: a full admin, a legacy NULL-scope admin, an assistant. */
const NON_OWNER_ADMINS: Record<'full' | 'legacy_null' | 'assistant', StubUser> = {
  full: { id: 'la_full', role: 'admin', email: 'la_full@x.co', admin_scope: 'full' },
  legacy_null: { id: 'la_null', role: 'admin', email: 'la_null@x.co', admin_scope: null },
  assistant: { id: 'la_ast', role: 'admin', email: 'la_ast@x.co', admin_scope: 'assistant' },
};

function addNonOwnerAdmins(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope,email_verified_at) VALUES
      ('la_full','Full','la_full@x.co','h','admin','full','2026-01-01T00:00:00.000Z'),
      ('la_null','Legacy','la_null@x.co','h','admin',NULL,'2026-01-01T00:00:00.000Z'),
      ('la_ast','Asst','la_ast@x.co','h','admin','assistant',NULL);
  `);
}

const actionsOf = (list: unknown): string[] =>
  Array.isArray(list) ? (list as Array<{ action?: unknown }>).map((h) => String(h.action ?? '')) : [];

/**
 * The scanner's hits for one answer, as `<role> GET <path>  <key path>` —
 * deduplicated (the scanner reports a key and its sentinel value separately)
 * and without the value, so the failure names where, not what.
 */
const hitsOf = (who: string, path: string, body: unknown): string[] => [
  ...new Set(leaks(body).map((l) => `${who} GET ${path}  ${l.replace(/ (∈ FINANCIAL_FIELDS )?= .*$/, '')}`)),
];

// ====================================================================== 1

test('gift timeline: a cost-bearing gift.* audit row reaches no non-owner admin (GET /api/gifts/admin/grants/:id[/audit])', async () => {
  const raw = giftWorld();
  addNonOwnerAdmins(raw);
  const db = asD1(raw);
  const owner = appAs(db, BOSS);
  const g = await grantOk(owner, { mode: 'product', level: 1, product: { ...PLAIN, qty: 1 }, reason: 'admin_gift', note: 'n1' });
  const paths = [`/api/gifts/admin/grants/${g.id}/audit`, `/api/gifts/admin/grants/${g.id}`];

  // Control 1: before the cost row, every non-owner answer is clean.
  for (const [role, user] of Object.entries(NON_OWNER_ADMINS)) {
    for (const path of paths) {
      const res = await get(appAs(db, user), path);
      assert.equal(res.status, 200, `${role} ${path}`);
      assert.deepEqual(leaks(await json(res)), [], `${role} ${path}: clean before the cost row`);
    }
  }

  // The REAL writer, under the reader's prefix, on the gift's id.
  await audit(db, BOSS.id, 'gift.fulfill', g.id, { user_id: 'buyer', level: 1, ...COST_DETAIL });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.fulfill' AND target = ?", g.id), 1, 'audit() stored the row');

  // Control 2: the owner is served the row (allowed) — the path is exercised.
  const mine = await json(await get(owner, paths[0]));
  assert.ok(actionsOf(mine.audit).includes('gift.fulfill'), 'the owner reads the gift.fulfill row');

  const found: string[] = [];
  for (const [role, user] of Object.entries(NON_OWNER_ADMINS)) {
    for (const path of paths) {
      const body = await json(await get(appAs(db, user), path));
      assert.ok(actionsOf(body.audit).includes('gift.fulfill'), `${role} ${path}: the row is served`);
      found.push(...hitsOf(role, path, body));
    }
  }
  assert.equal(found.length, 0, `a gift.* audit detail reached non-owner admins unstripped (${found.length} key paths):\n${found.join('\n')}`);
});

// ====================================================================== 2

test('device / serial / warranty histories: maskedDetail strips no cost for non-owner admins', async () => {
  const w = world();
  addNonOwnerAdmins(w.raw);
  const as = (user: StubUser) => stubApp(w.db, user, mountSerialWorld);
  order(w.raw, 'ORD-LEAKAUD', [{ id: 'l1', product: 'pA1', qty: 1 }]);
  const scan = await post(w.as('boss'), '/api/admin/orders/ORD-LEAKAUD/serials/scan', {
    order_item_id: 'l1',
    unit_index: 1,
    code: SN,
    source: 'scanner',
    op_id: op(),
  });
  assert.equal(scan.status, 200, await scan.clone().text());
  assert.equal((await patch(w.as('boss'), '/api/admin/orders/ORD-LEAKAUD/stage', { stage: 'delivered' })).status, 200);
  const unit = row<{ id: string }>(w.raw, 'SELECT u.id FROM order_item_units u JOIN device_serials d ON d.unit_id = u.id WHERE d.serial_norm = ?', SN);
  assert.ok(unit, 'delivery made the unit');
  w.raw.exec(`
    INSERT INTO warranty_receipts (id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id, serial_norm, serial_raw, status)
      VALUES ('wr_leakaud','LV-W-000991','${unit.id}','ORD-LEAKAUD','l1','pA1','u1','${SN}','${SN}','active');
  `);

  const paths = [
    `/api/devices/admin/units/${unit.id}/history`,
    `/api/devices/admin/serial-inventory/${SN}`,
    '/api/admin/warranties/wr_leakaud',
  ];

  // Control 1: clean before the cost rows.
  for (const [role, user] of Object.entries(NON_OWNER_ADMINS)) {
    for (const path of paths) {
      const res = await get(as(user), path);
      const body = await json(res);
      assert.equal(res.status, 200, `${role} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
      assert.deepEqual(leaks(body), [], `${role} ${path}: clean before the cost rows`);
    }
  }

  // The REAL writer, one row per reader prefix, each on a target its reader reads.
  await audit(w.db, 'boss', 'device.unit_replace', unit.id, { reason: 'dead on arrival', new_unit_id: null, ...COST_DETAIL });
  await audit(w.db, 'boss', 'serial_inventory.update', SN, { from: { note: '' }, to: { note: 'relabelled', ...COST_DETAIL } });
  await audit(w.db, 'boss', 'serial.released', SN, { reason: 'manual', order_id: 'ORD-LEAKAUD', cogs_iqd: COST.orderCogs });
  await audit(w.db, 'boss', 'warranty.replaced', 'wr_leakaud', { new_receipt_no: 'LV-W-000992', cost_iqd: COST.orderLine, ...COST_DETAIL });
  assert.equal(
    count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('device.unit_replace','serial_inventory.update','serial.released','warranty.replaced') AND detail LIKE '%cogs_iqd%'"),
    4,
    'audit() stored the four rows'
  );

  // Control 2: the owner is served the rows (allowed).
  const ownerPage = await json(await get(w.as('boss'), paths[1]));
  assert.ok(actionsOf(ownerPage.story?.history).includes('warranty.replaced'), 'the owner reads the story with the receipt row');

  const found: string[] = [];
  for (const [role, user] of Object.entries(NON_OWNER_ADMINS)) {
    for (const path of paths) {
      const body = await json(await get(as(user), path));
      const served = [...actionsOf(body.history), ...actionsOf(body.story?.history)];
      assert.ok(
        served.some((a) => ['device.unit_replace', 'serial_inventory.update', 'serial.released', 'warranty.replaced'].includes(a)),
        `${role} ${path}: the cost row is served (${served.join(', ')})`
      );
      found.push(...hitsOf(role, path, body));
    }
  }
  assert.equal(found.length, 0, `device/serial/warranty audit details reached non-owner admins unstripped (${found.length} key paths):\n${found.join('\n')}`);
});

// ====================================================================== 3

test('merchant order timeline: an order.status row with a cost reaches the store owner as to/stage only (projection)', async () => {
  const raw = seedW2E();
  addOrder(raw, { id: 'ORD-LEAKAUD-M', status: 'processing', total: 23000 });
  const app = () => appOf(raw, STORE_OWNER, (a) => a.route('/api/merchant/orders', merchantOrderRoutes));
  await audit(asD1(raw), 'boss', 'order.status', 'ORD-LEAKAUD-M', {
    from: 'confirmed',
    to: 'processing',
    stage: 'preparing',
    stage_recorded: false,
    cost_iqd: COST.orderLine,
    ...COST_DETAIL,
  });
  const res = await get(app(), '/api/merchant/orders/ORD-LEAKAUD-M/timeline');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  // Control: the admin's audit row IS read (it becomes a «levonis» status event).
  assert.ok(
    (body.events as Array<{ kind: string; status?: string; actor?: string }>).some((e) => e.kind === 'status' && e.status === 'processing' && e.actor === 'levonis'),
    'the order.status row is turned into an event'
  );
  assert.deepEqual(leaks(body), [], 'the merchant timeline projects order.status to its to/stage fields');
});

// ====================================================================== 4

test('guard gap: the role-matrix sweep never reads a populated audit history on these readers', async () => {
  const raw = seededCopy();
  const historyRows = count(
    raw,
    "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'gift.%' OR action LIKE 'device.%' OR action LIKE 'serial%' OR action LIKE 'warranty.%' OR action = 'order.status'"
  );
  // The paths the matrix itself sweeps for these readers (its own `concrete()` filling).
  // Only the parameterised readers — the ones `concrete()` filled with a seeded id.
  const readerPaths = getPaths().filter(
    (p) =>
      /^\/api\/gifts\/admin\/grants\/[^/]+(\/audit)?$|^\/api\/devices\/admin\/units\/[^/]+\/history$|^\/api\/devices\/admin\/serial-inventory\/[^/]+$|^\/api\/admin\/warranties\/[^/]+$|^\/api\/merchant\/orders\/[^/]+\/timeline$/.test(p) &&
      // …or with the unit / serial seedAuditRows adds for them (DECISIONS row 220).
      /\/(p_a1|ord1|unit_rm|SNRMAUDIT0001)(\/|$)/.test(p)
  );
  assert.ok(readerPaths.length >= 5, `the matrix lists the readers: ${readerPaths.join(', ')}`);
  const app = appFor(raw, ROLES.full);
  const populated: string[] = [];
  const statuses: string[] = [];
  for (const path of readerPaths) {
    const r = await call(app, 'GET', path);
    statuses.push(`${path} → ${r.status}`);
    const b = (r.body ?? {}) as Record<string, unknown>;
    const story = (b.story ?? {}) as Record<string, unknown>;
    const n = [b.audit, b.history, story.history].reduce<number>((s, x) => s + (Array.isArray(x) ? x.length : 0), 0);
    if (r.status === 200 && n > 0) populated.push(path);
  }
  assert.ok(
    historyRows > 0 && populated.length > 0,
    `role-matrix guard gap: the seed holds ${historyRows} audit_log row(s) under gift./device./serial/warranty./order.status, ` +
      `and the full-admin sweep of the history readers reads no populated history:\n${statuses.join('\n')}`
  );
});
