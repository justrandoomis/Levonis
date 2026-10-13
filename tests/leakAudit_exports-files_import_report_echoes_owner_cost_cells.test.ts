/**
 * LEAK AUDIT — candidate `import-report-echoes-owner-cost-cells`
 * (channel: exports-files — the CSV/ZIP import report, JSON and CSV forms,
 * stored in `product_imports.report`).
 *
 * THE CLAIM. The owner (the only account whose import sheet carries the
 * `cost_iqd` / `cost_adjust_iqd` columns) previews a sheet whose cost cell is
 * not a plain ASCII integer — Excel's thousands separators («611,111»), a
 * currency suffix («622222 IQD»), Arabic-Indic digits. `intCell` /
 * `signedCell` (worker/lib/importCsv.ts) refuse the cell and ECHO IT VERBATIM
 * into the row error: `cost_iqd: "611,111" ليس رقمًا صحيحًا`. POST /preview
 * stores `rows[].errors` in `product_imports.report`; GET /history lists every
 * admin's import id with no actor filter; GET /:id/report returns the stored
 * rows (JSON) — or, after confirm, the same errors as `reason` (CSV) — to ANY
 * admin, with no owner or actor check (/confirm, by contrast, refuses another
 * admin's import). A second, weaker path: the row error «سعر البيع يساوي
 * التكلفة» tells the reader the owner's cost equals one of that line's prices.
 *
 * WHAT THIS TEST RUNS — the real router (worker/routes/adminImport.ts) on the
 * role-matrix database (tests/fixtures/roleMatrix.ts: the costly product, one
 * account per role, the verified owner), mounted at the prefix worker/index.ts
 * uses, nothing stubbed but the session:
 *
 *   1. the VERIFIED OWNER previews a real multipart CSV for a `devices`
 *      section whose cost cells are the fixture's sentinel costs, typed the
 *      way a spreadsheet saves them (positive control: the owner's own answer
 *      echoes them, and the stored report holds them);
 *   2. every non-owner — each admin role of the matrix, the owner's own
 *      address before verification, and every non-admin — reads
 *      GET /api/admin/import/history (to discover the id, as the panel does)
 *      and GET /api/admin/import/<id>/report in JSON and CSV;
 *   3. the owner confirms (every row failed, so nothing is written to the
 *      catalogue), which copies the errors into `reason`, and step 2 repeats.
 *
 * The leak assertion is the shared scanner `leaks()` of
 * tests/fixtures/costlyProduct.ts on every answer, plus the cost cell texts
 * themselves (the scanner reads ASCII digits only, so the Arabic-Indic cell is
 * checked as text).
 *
 * LOCAL ONLY: in-memory/temporary SQLite databases, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_exports-files_import_report_echoes_owner_cost_cells.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { ctx, type StubUser } from './fixtures/app';
import { COST, leaks } from './fixtures/costlyProduct';
import {
  ADMIN_ROLES,
  OWNER,
  OWNER_UNVERIFIED,
  ROLES,
  appFor,
  call,
  seededCopy,
  type MatrixApp,
  type MountSpec,
  type Router,
} from './fixtures/roleMatrix';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { toCsv } from '../worker/lib/importCsv';

const MOUNTS: readonly MountSpec[] = [['/api/admin/import', adminImportRoutes as Router]];
const SECTION = 'tpl_audit_printers';

/** The cost cells exactly as a spreadsheet hands them back — each spells a sentinel cost of the fixture. */
const CELLS = {
  // Excel, a number column formatted with thousands separators.
  productCost: COST.product.toLocaleString('en-US'), // "611,111"
  // A currency suffix typed by hand.
  optionCost: `${COST.option} IQD`, // "622222 IQD"
  // A signed adjustment with a separator.
  optionAdjust: COST.optionAdjust.toLocaleString('en-US'), // "6,333"
  // A colour's cost with a separator.
  colorCost: COST.color.toLocaleString('en-US'), // "688,888"
  // A colour's adjustment in Arabic-Indic digits (the scanner reads ASCII only).
  colorAdjustArabic: String(COST.colorAdjust).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]), // "٦٩٩٩"
} as const;

const HEAD = [
  'row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'cost_iqd', 'cost_adjust_iqd', 'stock',
  'group', 'value', 'hex',
];
const line = (cells: Record<string, string>) => HEAD.map((h) => cells[h] ?? '');

/** The owner's sheet: one new printer, an option and a colour, every cost cell a sentinel. */
function ownerSheet(): string {
  return toCsv([
    HEAD,
    line({
      row_type: 'product', key: 'AUD-PRN-1', name: 'Audit Printer One', status: 'active',
      category: 'tpl-audit-printers', price_iqd: '1500000', cost_iqd: CELLS.productCost, stock: '3',
    }),
    line({ row_type: 'group', key: 'AUD-PRN-1', group: 'Model', value: 'Model' }),
    line({
      row_type: 'option', key: 'AUD-PRN-1', group: 'Model', value: 'Combo',
      cost_iqd: CELLS.optionCost, cost_adjust_iqd: CELLS.optionAdjust, stock: '1',
    }),
    line({
      row_type: 'color', key: 'AUD-PRN-1', value: 'Black', hex: '#000000',
      cost_iqd: CELLS.colorCost, cost_adjust_iqd: CELLS.colorAdjustArabic,
    }),
  ]);
}

/**
 * The weaker path: an export → edit → import round trip of the seeded product
 * `a1` (public price 900,000) where the owner's typed cost equals that price.
 */
function ownerEqualSheet(): string {
  return toCsv([
    HEAD,
    line({
      row_type: 'product', key: 'a1', name: 'Bambu Lab A1', status: 'active',
      category: 'tpl-audit-printers', price_iqd: '900000', cost_iqd: '900000', stock: '5',
    }),
  ]);
}

function seed(): DatabaseSync {
  const raw = seededCopy();
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,template_family,is_printer_catalog,active)
      VALUES ('${SECTION}',NULL,'tpl-audit-printers','طابعات التدقيق','Audit Printers','devices',1,1);
  `);
  return raw;
}

async function preview(app: MatrixApp, csv: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.set('file', new File([csv], 'owner-costs.csv', { type: 'text/csv' }));
  form.set('category', SECTION);
  const res = await app.request(
    '/api/admin/import/preview',
    { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Every caller that must see no cost: each admin role, the unverified owner, and every non-admin. */
function nonOwners(): Array<[string, StubUser | null]> {
  const admins = ADMIN_ROLES.map((r) => [r, ROLES[r]] as [string, StubUser | null]);
  const others = (Object.keys(ROLES) as Array<keyof typeof ROLES>)
    .filter((r) => !ADMIN_ROLES.includes(r))
    .map((r) => [r, ROLES[r]] as [string, StubUser | null]);
  return [...admins, ['owner_unverified', OWNER_UNVERIFIED], ...others];
}

/** The raw cost texts the owner typed — any of them in a non-owner's answer is the leak, whatever its digits. */
const RAW_TEXTS = Object.values(CELLS);

interface Seen {
  /** what this caller read, per path: status */
  statuses: Record<string, number>;
  /** every private value found */
  found: string[];
  /** did this caller discover the owner's import through /history */
  discovered: boolean;
}

async function sweep(raw: DatabaseSync, importId: string, user: StubUser | null): Promise<Seen> {
  const app = appFor(raw, user, MOUNTS);
  const seen: Seen = { statuses: {}, found: [], discovered: false };
  const hist = await call(app, 'GET', '/api/admin/import/history');
  seen.statuses['/history'] = hist.status;
  const ids = ((hist.body as { imports?: Array<{ id: string }> })?.imports ?? []).map((i) => i.id);
  seen.discovered = ids.includes(importId);
  for (const path of [`/api/admin/import/${importId}/report`, `/api/admin/import/${importId}/report?format=csv`]) {
    const r = await call(app, 'GET', path);
    seen.statuses[path.replace(`/api/admin/import/${importId}`, '')] = r.status;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    for (const l of leaks(r.body)) seen.found.push(`${path}  ${l}`);
    for (const t of RAW_TEXTS) if (text.includes(t)) seen.found.push(`${path}  ⊃ the owner's cost cell "${t}"`);
  }
  return seen;
}

async function sweepAll(raw: DatabaseSync, importId: string) {
  const out: Record<string, Seen> = {};
  for (const [name, user] of nonOwners()) out[name] = await sweep(raw, importId, user);
  return out;
}

/**
 * THE PATH IS EXERCISED. The owner's own read of the report serves the echoed
 * cells (so an empty answer below is the gate, not a dead route), and every
 * non-owner admin asked for the owner's import by its id. Since the cost-access
 * provenance on import reports (DECISIONS row 216) a non-owner neither lists
 * nor reads an owner's import: a refusal passes, as would an answer with no
 * cost in it — what fails is a private cell reaching them.
 */
async function assertExercised(owner: MatrixApp, importId: string, all: Record<string, Seen>, path: string) {
  const own = await call(owner, 'GET', `/api/admin/import/${importId}${path}`);
  assert.equal(own.status, 200, `control: the owner reads their own report (${path})`);
  const text = typeof own.body === 'string' ? own.body : JSON.stringify(own.body);
  assert.ok(RAW_TEXTS.some((t) => text.includes(t)), `control: the owner's report (${path}) carries the echoed cells`);
  for (const r of ADMIN_ROLES) assert.ok(all[r].statuses[path] !== undefined, `${r} asked for ${path}`);
  assert.deepEqual(ADMIN_ROLES.filter((r) => all[r].discovered), [], 'no non-owner admin lists the owner’s import');
}

const leaksOf = (all: Record<string, Seen>) =>
  Object.fromEntries(Object.entries(all).filter(([, s]) => s.found.length).map(([r, s]) => [r, s.found]));

test('the owner’s typed cost cells, echoed into the import report, reach no non-owner (preview state)', async () => {
  const raw = seed();
  const owner = appFor(raw, OWNER, MOUNTS);
  const prev = await preview(owner, ownerSheet());
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const importId = String(prev.body.import_id);

  // POSITIVE CONTROL — the path is exercised: the owner's own preview echoes
  // the cost cells, and the stored report row (what /report reads) holds them.
  const ownerText = JSON.stringify(prev.body.rows);
  for (const t of RAW_TEXTS) assert.ok(ownerText.includes(t), `the owner's preview must echo "${t}" (control): ${ownerText}`);
  const stored = String(
    (raw.prepare('SELECT report FROM product_imports WHERE id = ?').get(importId) as { report: string }).report
  );
  assert.ok(leaks(JSON.parse(stored)).length > 0, 'the stored report must hold a sentinel cost (control)');

  const all = await sweepAll(raw, importId);
  await assertExercised(owner, importId, all, '/report');
  assert.deepEqual(
    leaksOf(all),
    {},
    'a non-owner read the owner’s private cost out of GET /api/admin/import/:id/report'
  );
});

test('…nor after the owner confirms, when the errors become the CSV report’s `reason`', async () => {
  const raw = seed();
  const owner = appFor(raw, OWNER, MOUNTS);
  const prev = await preview(owner, ownerSheet());
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const importId = String(prev.body.import_id);
  const conf = await call(owner, 'POST', '/api/admin/import/confirm', { import_id: importId });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.equal(
    (raw.prepare('SELECT state FROM product_imports WHERE id = ?').get(importId) as { state: string }).state,
    'applied'
  );
  // Control: the confirmed report's `reason` (the CSV column) carries the echo.
  const reasons = ((conf.body as { rows: Array<{ reason: string }> }).rows ?? []).map((r) => r.reason).join(' ');
  assert.ok(RAW_TEXTS.some((t) => reasons.includes(t)), `confirm must copy the echoed cells into reason (control): ${reasons}`);

  const all = await sweepAll(raw, importId);
  await assertExercised(owner, importId, all, '/report?format=csv');
  assert.deepEqual(
    leaksOf(all),
    {},
    'a non-owner read the owner’s private cost out of the confirmed import report (JSON or CSV)'
  );
});

test('…and no non-owner learns that the owner’s cost for a line equals its (public) price', async () => {
  const raw = seed();
  const owner = appFor(raw, OWNER, MOUNTS);
  const prev = await preview(owner, ownerEqualSheet());
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const importId = String(prev.body.import_id);
  const ownerText = JSON.stringify(prev.body.rows);
  assert.match(ownerText, /سعر البيع يساوي التكلفة/, `control: the owner's preview carries the equality refusal: ${ownerText}`);

  const told: Record<string, string> = {};
  for (const [name, user] of nonOwners()) {
    const app = appFor(raw, user, MOUNTS);
    for (const path of [`/api/admin/import/${importId}/report`, `/api/admin/import/${importId}/report?format=csv`]) {
      const r = await call(app, 'GET', path);
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      if (/يساوي التكلفة/.test(text)) told[`${name} ${path}`] = 'cost = price of a line whose price it can read';
    }
  }
  assert.deepEqual(told, {}, 'a non-owner was told the owner’s cost equals the line’s price');
});
