/**
 * LEAK AUDIT — candidate `guard-gap-private-columns-unseeded-unnamed`
 * (channel: staff-api — the role-matrix sweep and its FINANCIAL_FIELDS net).
 *
 * THE CLAIM. A run of private procurement, order-snapshot and print-economics
 * columns is neither SEEDED by the role-matrix fixture nor NAMED in
 * FINANCIAL_FIELDS, so the two nets every cost test leans on cannot see them:
 *
 *   - `leaks()` (tests/fixtures/costlyProduct.ts), the walker of every
 *     role-matrix sweep, finds a cost by its KEY (FINANCIAL_FIELDS, or "cost"
 *     in the name) or by its VALUE (a seeded sentinel). These columns carry
 *     neither, so a regression that served them to a non-owner would pass
 *     tests/costRoleMatrix.test.ts and tests/costRoleMatrixWrites.test.ts;
 *   - `stripFinancials()` / `projectForAdmin()` (worker/lib/adminScope.ts),
 *     the "second net" every non-owner admin answer may pass through, removes
 *     keys of FINANCIAL_FIELDS only, so it would hand every one of them over.
 *
 *   purchase_orders.invoice_total_iqd, purchase_orders.attachment_url (the
 *   supplier invoice), purchase_charges.amount_iqd / unit_amount_iqd,
 *   supplier_payments.amount_iqd (and the derived paid_iqd),
 *   purchase_investor_agreements.batch_cost_iqd (funding.batch_cost_iqd),
 *   purchase_investor_lot_capital.unit_principal_iqd,
 *   order_items.usd_iqd_at_purchase / base_usd_at_purchase (FINANCIAL_FIELDS
 *   has `usd_iqd_rate_at_purchase`, the inventory_lots name, only),
 *   printer_models.purchase_iqd / residual_iqd / maintenance_iqd_per_hour.
 *
 * (`printServicePricing.machine_iqd_per_hour / setup_fee_iqd`, also named by
 * the candidate, are NOT treated as private here: worker/lib/settings.ts puts
 * `printServicePricing` in PUBLIC_SETTING_KEYS on purpose — «the rates on it
 * are a published price list» — and its margin_percent is a separate
 * candidate. They are left out so this test does not flag a published price.)
 *
 * WHAT THIS TEST RUNS — the real routers of tests/fixtures/roleMatrix.ts
 * BASE_MOUNTS on the role-matrix database, with each private column above
 * given a unique sentinel nothing else in the fixture can equal:
 *
 *   1. the REAL PATH, as every non-owner of the matrix (guest, customer,
 *      merchant, assistant, full, legacy NULL, grantee, employee, investor,
 *      support assistant) and the owner before the address is verified: every
 *      GET of every mount, and every write of the mounts that hold these
 *      tables (empty body and the route's own valid body from
 *      tests/routeClass), success and refusal bodies walked for the
 *      sentinels. Positive control: the verified owner DOES get each served
 *      value on its door (procurement documents, the two finance order
 *      screens, the printer-model editor) — so the sweep reaches the place.
 *   2. THE SCANNER GAP: on the owner's real answers, every place a private
 *      value sits must be flagged by the role matrix's own `leaks()` — by
 *      key, or because the role-matrix fixture seeds that column with a value
 *      the scanner knows. A value neither named nor seeded is invisible to
 *      both sweeps.
 *   3. THE NET GAP: the owner's real answers passed through the REAL
 *      `projectForAdmin()` as each non-owner admin must come out without any
 *      private value. Positive control: the same projection DOES remove the
 *      named costs (lines[].purchase_unit_iqd) from the same answer.
 *
 * 1 passing and 2/3 failing = no non-owner receives these values TODAY, and
 * the guards that would catch the first regression that serves them are blind.
 *
 * LOCAL ONLY: in-memory/temp SQLite databases, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_staff-api_guard_gap_private_columns_unseeded_unnamed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import {
  ADMIN_ROLES,
  OWNER,
  OWNER_UNVERIFIED,
  ROLES,
  appFor,
  call,
  getPaths,
  leaks,
  seededCopy,
  sweepWrites,
  type WriteBodies,
} from './fixtures/roleMatrix';
import type { StubUser } from './fixtures/app';
import { ruleOf, type RouteClassFile } from './routeClass/_types';
import { FINANCIAL_FIELDS, canViewCost, projectForAdmin } from '../worker/lib/adminScope';
import type { Env } from '../worker/lib/types';

// ------------------------------------------------------------- the sentinels

/** Whole-dinar sentinels — 7xx_xxx, apart from the fixture's 6xx_xxx costs. */
const V = {
  invoiceTotal: 733_301,
  chargeAmount: 744_402,
  chargeUnit: 74_503,
  supplierPayment: 755_604,
  batchCost: 766_705,
  unitPrincipal: 777_806,
  printerPurchase: 788_907,
  printerResidual: 79_908,
  printerMaintenance: 71_919,
} as const;
/** The order line's private FX snapshot, decimal text as the column stores it. */
const USD_IQD_AT_PURCHASE = '1471.37';
const BASE_USD_AT_PURCHASE = '593.187654';
/** The supplier invoice link: a text value, found by its mark. */
const ATTACHMENT_MARK = 'ZQX7731';
const ATTACHMENT = `https://files.example/supplier-invoice-${ATTACHMENT_MARK}.pdf`;

const NUMBERS: ReadonlySet<number> = new Set(Object.values(V));
const TEXTS: readonly string[] = [USD_IQD_AT_PURCHASE, BASE_USD_AT_PURCHASE, ATTACHMENT_MARK];

/** The engine-priced line added to `ord1`, the order every order route of the sweep opens. */
const SNAPSHOT_LINE = 'oi_engine_snap';
/** The printer model given the private economics. */
const PRINTER = 'bbl-a1';

/**
 * Each private value, the key a door serves it under, the owner doors that
 * serve it (empty = read only inside the Worker), and how to read what the
 * UNMODIFIED role-matrix fixture holds in the column.
 */
interface PrivateColumn {
  column: string;
  key: string;
  value: number | string;
  doors: readonly string[];
  fixtureSql: string;
}
const DOCS = '/api/admin/procurement/documents';
const DOC = '/api/admin/procurement/documents/po1';
/** This file's own investor-funded purchase (see seedPrivateColumns) and its document door. */
const FUNDED_PO = 'po_pc_audit';
const FUNDED_DOC = `/api/admin/procurement/documents/${FUNDED_PO}`;
const FW_ORDER = '/api/admin/finance-workspace/orders/ord1';
const FO_PROFIT = '/api/admin/finance-operations/orders/ord1/profit';
const PRINTERS = '/api/admin/print-quote/printer-models';
const PRIVATE_COLUMNS: readonly PrivateColumn[] = [
  { column: 'purchase_orders.invoice_total_iqd', key: 'invoice_total_iqd', value: V.invoiceTotal, doors: [DOCS, DOC], fixtureSql: 'SELECT invoice_total_iqd AS v FROM purchase_orders' },
  { column: 'purchase_orders.attachment_url', key: 'attachment_url', value: ATTACHMENT, doors: [DOCS, DOC], fixtureSql: 'SELECT attachment_url AS v FROM purchase_orders' },
  { column: 'purchase_charges.amount_iqd', key: 'amount_iqd', value: V.chargeAmount, doors: [DOC], fixtureSql: 'SELECT amount_iqd AS v FROM purchase_charges' },
  { column: 'purchase_charges.unit_amount_iqd', key: 'unit_amount_iqd', value: V.chargeUnit, doors: [DOC], fixtureSql: 'SELECT unit_amount_iqd AS v FROM purchase_charges' },
  { column: 'supplier_payments.amount_iqd (and paid_iqd)', key: 'amount_iqd', value: V.supplierPayment, doors: [DOCS, DOC], fixtureSql: 'SELECT amount_iqd AS v FROM supplier_payments' },
  { column: 'purchase_investor_agreements.batch_cost_iqd', key: 'batch_cost_iqd', value: V.batchCost, doors: [FUNDED_DOC], fixtureSql: 'SELECT batch_cost_iqd AS v FROM purchase_investor_agreements' },
  { column: 'purchase_investor_lot_capital.unit_principal_iqd', key: 'unit_principal_iqd', value: V.unitPrincipal, doors: [], fixtureSql: 'SELECT unit_principal_iqd AS v FROM purchase_investor_lot_capital' },
  { column: 'order_items.usd_iqd_at_purchase', key: 'usd_iqd_at_purchase', value: USD_IQD_AT_PURCHASE, doors: [FW_ORDER, FO_PROFIT], fixtureSql: 'SELECT usd_iqd_at_purchase AS v FROM order_items' },
  { column: 'order_items.base_usd_at_purchase', key: 'base_usd_at_purchase', value: BASE_USD_AT_PURCHASE, doors: [FW_ORDER, FO_PROFIT], fixtureSql: 'SELECT base_usd_at_purchase AS v FROM order_items' },
  { column: 'printer_models.purchase_iqd', key: 'purchase_iqd', value: V.printerPurchase, doors: [PRINTERS], fixtureSql: 'SELECT purchase_iqd AS v FROM printer_models' },
  { column: 'printer_models.residual_iqd', key: 'residual_iqd', value: V.printerResidual, doors: [PRINTERS], fixtureSql: 'SELECT residual_iqd AS v FROM printer_models' },
  { column: 'printer_models.maintenance_iqd_per_hour', key: 'maintenance_iqd_per_hour', value: V.printerMaintenance, doors: [PRINTERS], fixtureSql: 'SELECT maintenance_iqd_per_hour AS v FROM printer_models' },
];

/** The private columns, written on top of the role-matrix database (po1, lot1, ord1, ic_rm, usr_inv are its rows). */
function seedPrivateColumns(raw: DatabaseSync): DatabaseSync {
  raw.exec(`
    UPDATE purchase_orders SET invoice_total_iqd = ${V.invoiceTotal}, attachment_url = '${ATTACHMENT}' WHERE id = 'po1';
    INSERT INTO purchase_charges (id,purchase_id,title,amount_iqd,basis,scope,unit_amount_iqd,position)
      VALUES ('pc_audit','po1','Air freight',${V.chargeAmount},'quantity','unit',${V.chargeUnit},0);
    INSERT INTO supplier_payments (id,purchase_id,amount_iqd,payment_day,reference,actor_id,created_at)
      VALUES ('sp_audit','po1',${V.supplierPayment},'2026-09-02','wire','usr_owner','2026-09-02T00:00:00Z');
    -- A purchase of this file's own for the funded batch: the role matrix already
    -- funds po1 (its investment-remainder seed), and funded terms are immutable.
    INSERT INTO purchase_orders (id,currency,exchange_rate,purchase_day,status,cost_state,created_by,created_at,updated_at)
      VALUES ('${FUNDED_PO}','IQD',1,'2026-09-01','ordered','final','usr_owner','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
    INSERT INTO purchase_investor_agreements (purchase_id,user_id,agreed_iqd,allocated_iqd,batch_cost_iqd,profit_share_bps,
                                              loss_share_bps,actor_id,created_at,request_json)
      VALUES ('${FUNDED_PO}','usr_inv',500000,500000,${V.batchCost},3500,0,'usr_owner','2026-09-01T00:00:00Z','{}');
    INSERT INTO purchase_investor_lot_capital (lot_id,contract_id,unit_principal_iqd,qty) VALUES ('lot1','ic_rm',${V.unitPrincipal},2);
    UPDATE printer_models SET purchase_iqd = ${V.printerPurchase}, residual_iqd = ${V.printerResidual},
                              maintenance_iqd_per_hour = ${V.printerMaintenance} WHERE id = '${PRINTER}';
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,
                             price_basis,engine_combo_key,engine_channel,engine_regular_iqd,usd_iqd_at_purchase,base_usd_at_purchase)
      VALUES ('${SNAPSHOT_LINE}','ord1','p_a1','Bambu Lab A1',1,900000,900000,
              'engine','v_a1','direct_sale',900000,'${USD_IQD_AT_PURCHASE}','${BASE_USD_AT_PURCHASE}');
  `);
  return raw;
}
const seeded = () => seedPrivateColumns(seededCopy());
const seededUnverifiedOwner = () => {
  const raw = seeded();
  raw.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'usr_owner'");
  return raw;
};

/** Every place one of THIS file's sentinels sits in a value: a number, digits inside text, or the decimal / attachment text. */
function privateHits(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`);
    else if (typeof v === 'number' && NUMBERS.has(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') {
      for (const n of v.match(/\d[\d,]{3,}/g) ?? []) if (NUMBERS.has(Number(n.replace(/,/g, '')))) out.push(`${path} ⊃ "${n}"`);
      for (const t of TEXTS) if (v.includes(t)) out.push(`${path} ⊃ "${t}"`);
    }
  };
  walk(value, '$');
  return out;
}
const locationOf = (hit: string) => hit.replace(/ (=|⊃) .*$/, '');
const valueMatches = (hit: string, value: number | string) =>
  typeof value === 'number'
    ? hit.endsWith(`= ${value}`) || hit.endsWith(`"${value}"`)
    : hit.includes(value === ATTACHMENT ? ATTACHMENT_MARK : value);

// ------------------------------------------------- the non-owner callers

/** Every caller of the role matrix who must see no cost, plus the owner before the address is verified. */
const NON_OWNERS: ReadonlyArray<readonly [string, StubUser | null, () => DatabaseSync]> = [
  ...Object.entries(ROLES).map(([name, user]) => [name, user, seeded] as const),
  ['owner_unverified', OWNER_UNVERIFIED, seededUnverifiedOwner] as const,
];

/** One GET sweep per caller: every path of every mount, walked for this file's sentinels. */
async function sweepPrivate(user: StubUser | null, seed: () => DatabaseSync) {
  const app = appFor(seed(), user);
  const bodies: Record<string, unknown> = {};
  const hits: string[] = [];
  let answered = 0;
  for (const path of [...getPaths(), FUNDED_DOC]) {
    const { status, body } = await call(app, 'GET', path);
    if (status >= 200 && status < 300) {
      answered += 1;
      bodies[path] = body;
    }
    for (const h of privateHits(body)) hits.push(`${status} ${path}  ${h}`);
  }
  return { answered, hits, bodies };
}

let ownerSweep: Promise<Awaited<ReturnType<typeof sweepPrivate>>> | null = null;
const owner = () => (ownerSweep ??= sweepPrivate(OWNER, seeded));

// ---------------------------------------------------------- 1. the real path

test('positive control — the verified owner DOES receive every served private value on its door (the seeding reaches the routes)', async () => {
  const o = await owner();
  const missing: string[] = [];
  for (const c of PRIVATE_COLUMNS) {
    for (const door of c.doors) {
      const found = privateHits(o.bodies[door]).some((h) => valueMatches(h, c.value));
      if (!found) missing.push(`${c.column} on ${door}`);
    }
  }
  assert.deepEqual(missing, [], 'the owner did not see a seeded private value where it lives — the fixture no longer reaches it');
});

for (const [name, user, seed] of NON_OWNERS) {
  test(`real path — no GET answer to ${name} carries any of these private values (${getPaths().length} paths)`, async () => {
    const r = await sweepPrivate(user, seed);
    assert.ok(r.answered >= (user ? 50 : 25), `only ${r.answered} routes answered ${name} — the sweep is not reaching anything`);
    assert.deepEqual(r.hits, [], `a private value reached ${name}:\n${r.hits.join('\n')}`);
  });
}

/** The routes' own valid bodies, exactly as tests/costRoleMatrixWrites.test.ts wires them. */
async function validBodies(): Promise<WriteBodies> {
  const dir = join(ROOT, 'tests/routeClass');
  const out: Record<string, { body: unknown; path?: string } | { noBody: string; path?: string }> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.startsWith('_'))) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default: RouteClassFile };
    for (const m of mod.default.mounts) {
      for (const [route, spec] of Object.entries(m.routes)) {
        const [method, path] = route.split(' ') as [string, string];
        if (method === 'GET') continue;
        const rule = ruleOf(spec);
        const k = `${method} ${m.prefix}${path === '/' ? '' : path}`;
        if (rule.body !== undefined) out[k] = { body: rule.body, path: rule.path };
        else if (rule.path) out[k] = { noBody: rule.noBody ?? m.writes ?? rule.cls, path: rule.path };
      }
    }
  }
  return out;
}

/** The writes of the mounts that read these tables: procurement, print quotes, finance, inventory, investment, orders. */
const WRITES_TOUCHING =
  /^(POST|PUT|PATCH|DELETE) \/api\/(admin\/(procurement|print-quote|finance-workspace|finance-operations|investment-finance|inventory|stock-operations|orders|finance)|print-quote|orders|price-protection|invest|merchant)(\/|$)/;

test('real path — no write answer (success or refusal) to any non-owner carries any of these private values', async () => {
  const bodies = await validBodies();
  const extra = { numbers: Object.values(V), decimals: [USD_IQD_AT_PURCHASE, BASE_USD_AT_PURCHASE] };
  const mine = (l: string) => [...NUMBERS].some((n) => l.includes(String(n))) || TEXTS.some((t) => l.includes(t));
  const found: string[] = [];
  let called = 0;
  for (const [name, user, seed] of NON_OWNERS) {
    const r = (await sweepWrites({ roles: { [name]: user }, seed, bodies, extra, filter: (k) => WRITES_TOUCHING.test(k) }))[name]!;
    called += r.called;
    for (const l of r.leaks.filter(mine)) found.push(`${name}  ${l}`);
  }
  assert.ok(called > 200, `only ${called} write requests were made`);
  assert.deepEqual(found, [], `a private value reached a non-owner through a write:\n${found.join('\n')}`);
});

// ------------------------------------------------------- 2. the scanner gap

/**
 * Is a column VISIBLE to the role-matrix sweeps? Either `leaks()` flags every
 * place the owner's doors serve it by KEY (it carries no seeded value here, so
 * a flag can only come from the key), or the UNMODIFIED role-matrix fixture
 * seeds the column with a value `leaks()` recognises — so a regression that
 * serves it to a non-owner fails tests/costRoleMatrix*.test.ts.
 */
test('THE SCANNER GAP — every private value the owner’s doors serve is visible to the role-matrix `leaks()`: named by key, or seeded by the fixture with a sentinel', async () => {
  const o = await owner();
  const fixture = seededCopy();
  const blind: string[] = [];
  for (const c of PRIVATE_COLUMNS) {
    // Seeded: the fixture holds a value in this column that the scanner knows.
    const held = (fixture.prepare(c.fixtureSql).all() as Array<{ v: unknown }>).map((r) => r.v).filter((v) => v !== null && v !== '');
    const seededKnown = held.some((v) => leaks({ probe: v }).length > 0);
    if (seededKnown) continue;
    // Named: wherever the owner's door serves it, leaks() flags that place.
    const places: string[] = [];
    const unflagged: string[] = [];
    for (const door of c.doors) {
      const body = o.bodies[door];
      const flagged = leaks(body);
      for (const h of privateHits(body).filter((x) => valueMatches(x, c.value))) {
        const where = locationOf(h);
        places.push(`${door} ${where}`);
        if (!flagged.some((l) => l.startsWith(`${where} `))) unflagged.push(`${door} ${where}`);
      }
    }
    // A column no door serves: the scanner's verdict on its own key.
    const keyNamed = places.length ? unflagged.length === 0 : leaks({ [c.key]: c.value }).length > 0;
    if (!keyNamed) {
      blind.push(
        `${c.column} — fixture holds ${held.length ? JSON.stringify(held.slice(0, 3)) : 'nothing'}; ` +
          (places.length ? `unflagged at ${unflagged.join(', ')}` : `served by no door; key \`${c.key}\` unknown to leaks()`)
      );
    }
  }
  fixture.close();
  assert.deepEqual(blind, [], `private values neither seeded by the role-matrix fixture nor named for leaks():\n${blind.join('\n')}`);
});

// ----------------------------------------------------------- 3. the net gap

/** The env and session user the Worker hands projectForAdmin (stubApp's own shape). */
const ENV = { INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
const sessionOf = (u: StubUser) =>
  ({ admin_scope: null, username: u.id, is_investor: 0, email_verified_at: '2026-01-01T00:00:00.000Z', ...u }) as never;

test('THE NET GAP — the owner’s answers passed through the REAL projectForAdmin() as each non-owner admin keep no private value', async () => {
  const o = await owner();
  const doors = [...new Set(PRIVATE_COLUMNS.flatMap((c) => c.doors))];
  // Controls: the env names the owner, the non-owners are not the owner, and
  // the projection DOES strip what FINANCIAL_FIELDS names from the same answer.
  assert.equal(canViewCost(ENV, sessionOf(OWNER)), true, 'the env must name the owner');
  const doc = o.bodies[DOC] as { lines?: Array<Record<string, unknown>> };
  assert.ok(doc?.lines?.[0] && 'purchase_unit_iqd' in doc.lines[0], 'the owner’s document carries lines[].purchase_unit_iqd');
  assert.ok((FINANCIAL_FIELDS as readonly string[]).includes('purchase_unit_iqd'));
  const kept: string[] = [];
  for (const role of ADMIN_ROLES) {
    const user = sessionOf(ROLES[role]!);
    assert.equal(canViewCost(ENV, user), false, `${role} is not a cost viewer`);
    const stripped = projectForAdmin(ENV, user, doc) as { lines?: Array<Record<string, unknown>> };
    assert.ok(stripped.lines?.[0] && !('purchase_unit_iqd' in stripped.lines[0]), `the net strips a named cost for ${role}`);
    for (const door of doors) {
      for (const h of privateHits(projectForAdmin(ENV, user, o.bodies[door]))) kept.push(`${role} ${door} ${h}`);
    }
  }
  assert.deepEqual(kept, [], `projectForAdmin() handed private values to non-owner admins:\n${kept.join('\n')}`);
});
