/**
 * LEAK AUDIT — candidate `import-report-echoes-owner-cost-cells`
 * (channel: logs-errors — the VALIDATION MESSAGES the import parser writes,
 * stored as `rows[].errors` in `product_imports.report` and, after confirm,
 * as `rows[].reason`).
 *
 * THE CLAIM. `intCell` / `signedCell` (worker/lib/importCsv.ts) refuse a cell
 * that is not a plain ASCII integer and build the error message FROM THE RAW
 * CELL: `${col}: "${s}" ليس رقمًا صحيحًا`. They run on `cost_iqd` of a product
 * row and on `cost_iqd` / `cost_adjust_iqd` of every option, colour and
 * variant row (the shared `money()` of the child rows). Only the owner's sheet
 * carries those columns — and the owner's spreadsheet hands back exactly the
 * cells that fail: a thousands separator («611,111», Excel's #,##0), a
 * currency suffix, a decimal. POST /api/admin/import/preview copies the issues
 * into `row.errors` and stores the rows in `product_imports.report`; POST
 * /confirm copies them into `reason` (previewSkippedRows). GET /history lists
 * every admin's import (no actor filter) and GET /:id/report hands any admin
 * the stored rows, unprojected, in JSON and CSV. The key `errors` / `reason`
 * is free text, not a FINANCIAL_FIELDS key, so even `projectForAdmin` would
 * leave it in place. A weaker line in the same channel: the ladder refusal
 * «سعر البيع يساوي التكلفة» says the owner's cost equals one of that row's
 * prices.
 *
 * WHAT THIS TEST RUNS — the real router (worker/routes/adminImport.ts) on the
 * role-matrix database (tests/fixtures/roleMatrix.ts), mounted where
 * worker/index.ts mounts it, nothing stubbed but the session:
 *   1. the VERIFIED OWNER previews a real multipart CSV whose product, option,
 *      colour and variant rows carry the fixture's sentinel costs, typed the
 *      way a spreadsheet saves them (controls: the owner's own answer carries
 *      them in `errors`, and so does the stored report);
 *   2. every non-owner — each admin role of the matrix, the owner's address
 *      before verification, every non-admin — reads GET /history (to find the
 *      id, as the panel does) and GET /:id/report (JSON and CSV), and the
 *      error strings it receives are scanned;
 *   3. the owner confirms (every row failed, so nothing reaches the
 *      catalogue): the same messages become `reason`, and step 2 repeats.
 * The leak assertion is the shared scanner `leaks()` of
 * tests/fixtures/costlyProduct.ts over every answer, plus the raw cell texts
 * (so a non-ASCII spelling would still be caught), and `projectForAdmin` is
 * applied to the JSON answer to show the existing projector would not stop it.
 *
 * LOCAL ONLY: temporary SQLite copies, in-process requests, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_logs-errors_import_report_echoes_owner_cost_cells.test.ts
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
import { projectForAdmin } from '../worker/lib/adminScope';

const MOUNTS: readonly MountSpec[] = [['/api/admin/import', adminImportRoutes as Router]];
const SECTION = 'tpl_logerr_printers';
const ENV = { INITIAL_ADMIN_EMAIL: OWNER.email } as never;

/** A variant's cost — not in the fixture, so it is handed to the scanner as an extra sentinel. */
const VARIANT_COST = 674_747;
const VARIANT_ADJUST = 7_313;
const EXTRA = { numbers: [VARIANT_COST, VARIANT_ADJUST] };

const sep = (n: number) => n.toLocaleString('en-US');

/**
 * The owner's cost cells exactly as a spreadsheet or a hand hands them back.
 * Every one fails `/^\d+$/` (or `/^[+-]?\d+$/`) and is echoed verbatim.
 */
const CELLS = {
  productCost: sep(COST.product), //              "611,111"   (Excel #,##0)
  optionCost: `${COST.option}.00`, //             "622222.00" (a decimal)
  optionAdjust: `+${sep(COST.optionAdjust)}`, //  "+6,333"    (signed, separator)
  colorCost: `${COST.color} IQD`, //              "688888 IQD" (currency suffix)
  colorAdjust: `${sep(COST.colorAdjust)} د.ع`, // "6,999 د.ع"  (Arabic currency suffix)
  variantCost: sep(VARIANT_COST), //              "674,747"
  variantAdjust: `-${sep(VARIANT_ADJUST)}`, //    "-7,313"
} as const;
const RAW_TEXTS = Object.values(CELLS);

const HEAD = [
  'row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'cost_iqd', 'cost_adjust_iqd', 'stock',
  'group', 'value', 'hex', 'links',
];
const line = (cells: Record<string, string>) => HEAD.map((h) => cells[h] ?? '');

function ownerSheet(): string {
  return toCsv([
    HEAD,
    line({
      row_type: 'product', key: 'LE-PRN-1', name: 'Errors Printer One', status: 'active',
      category: 'tpl-logerr-printers', price_iqd: '1500000', cost_iqd: CELLS.productCost, stock: '3',
    }),
    line({
      row_type: 'option', key: 'LE-PRN-1', group: 'Model', value: 'Combo',
      cost_iqd: CELLS.optionCost, cost_adjust_iqd: CELLS.optionAdjust, stock: '1',
    }),
    line({
      row_type: 'color', key: 'LE-PRN-1', value: 'Black', hex: '#000000',
      cost_iqd: CELLS.colorCost, cost_adjust_iqd: CELLS.colorAdjust,
    }),
    line({
      row_type: 'variant', key: 'LE-PRN-1', links: 'Model:Combo|color:Black',
      cost_iqd: CELLS.variantCost, cost_adjust_iqd: CELLS.variantAdjust, stock: '1',
    }),
  ]);
}

/** An export → edit → import of the seeded product `a1` (public price 900,000) with the owner's cost = that price. */
function ownerEqualSheet(): string {
  return toCsv([
    HEAD,
    line({
      row_type: 'product', key: 'a1', name: 'Bambu Lab A1', status: 'active',
      category: 'tpl-logerr-printers', price_iqd: '900000', cost_iqd: '900000', stock: '5',
    }),
  ]);
}

function seed(): DatabaseSync {
  const raw = seededCopy();
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,template_family,is_printer_catalog,active)
      VALUES ('${SECTION}',NULL,'tpl-logerr-printers','طابعات أخطاء الاستيراد','Import Errors Printers','devices',1,1);
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

function nonOwners(): Array<[string, StubUser | null]> {
  const admins = ADMIN_ROLES.map((r) => [r, ROLES[r]] as [string, StubUser | null]);
  const others = (Object.keys(ROLES) as Array<keyof typeof ROLES>)
    .filter((r) => !ADMIN_ROLES.includes(r))
    .map((r) => [r, ROLES[r]] as [string, StubUser | null]);
  return [...admins, ['owner_unverified', OWNER_UNVERIFIED], ...others];
}

/** Only the free-text error channel of a report answer: rows[].errors, rows[].warnings, rows[].reason. */
function messagesOf(body: unknown): string[] {
  if (typeof body === 'string') return [body];
  const rows = ((body as { rows?: Array<Record<string, unknown>> })?.rows ?? []) as Array<Record<string, unknown>>;
  const out: string[] = [];
  for (const r of rows) {
    for (const k of ['errors', 'warnings']) if (Array.isArray(r[k])) out.push(...(r[k] as string[]));
    if (typeof r.reason === 'string') out.push(r.reason);
  }
  return out;
}

interface Seen {
  statuses: Record<string, number>;
  discovered: boolean;
  found: string[];
}

const ALL_SENTINELS = new Set<number>([...Object.values(COST), ...EXTRA.numbers]);

/**
 * What a list of messages gives away: each raw cost cell it contains, and
 * each digit run that spells a sentinel. (The shared scanner reads
 * `extra.numbers` as JSON numbers only, never inside text — so the variant's
 * costs, which are not fixture sentinels, are looked for here.)
 */
function giveaways(msgs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const m of msgs) {
    for (const t of RAW_TEXTS) if (m.includes(t)) out.add(`cell "${t}"`);
    for (const n of m.match(/\d[\d,]{3,}/g) ?? []) if (ALL_SENTINELS.has(Number(n.replace(/,/g, '')))) out.add(`cost ${n}`);
  }
  return [...out];
}

async function sweep(raw: DatabaseSync, importId: string, user: StubUser | null): Promise<Seen> {
  const app = appFor(raw, user, MOUNTS);
  const seen: Seen = { statuses: {}, discovered: false, found: [] };
  const hist = await call(app, 'GET', '/api/admin/import/history');
  seen.statuses['/history'] = hist.status;
  seen.discovered = ((hist.body as { imports?: Array<{ id: string }> })?.imports ?? []).some((i) => i.id === importId);
  for (const suffix of ['/report', '/report?format=csv']) {
    const r = await call(app, 'GET', `/api/admin/import/${importId}${suffix}`);
    seen.statuses[suffix] = r.status;
    const given = giveaways(messagesOf(r.body));
    if (given.length) seen.found.push(`${suffix} error text gives: ${given.join(', ')}`);
    // The shared scanner over the whole answer, as every cost suite runs it.
    const scanned = leaks(r.body, EXTRA);
    if (scanned.length) seen.found.push(`${suffix} leaks(): ${scanned.length} hit(s), e.g. ${scanned[0]}`);
    // The existing projector would not stop it: `errors` / `reason` are free text, no FINANCIAL_FIELDS key.
    if (suffix === '/report' && r.status === 200 && user) {
      const left = giveaways(messagesOf(projectForAdmin(ENV, user as never, r.body)));
      if (left.length) seen.found.push(`${suffix} still after projectForAdmin: ${left.join(', ')}`);
    }
  }
  return seen;
}

async function sweepAll(raw: DatabaseSync, importId: string) {
  const out: Record<string, Seen> = {};
  for (const [name, user] of nonOwners()) out[name] = await sweep(raw, importId, user);
  return out;
}

const leaksOf = (all: Record<string, Seen>) =>
  Object.fromEntries(Object.entries(all).filter(([, s]) => s.found.length).map(([r, s]) => [r, s.found]));

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
  const given = giveaways(messagesOf(own.body));
  assert.ok(RAW_TEXTS.every((t) => given.includes(`cell "${t}"`)), `control: the owner's report (${path}) carries every echoed cell: ${given}`);
  for (const r of ADMIN_ROLES) assert.ok(all[r].statuses[path] !== undefined, `${r} asked for ${path}`);
  assert.deepEqual(ADMIN_ROLES.filter((r) => all[r].discovered), [], 'no non-owner admin lists the owner’s import');
}

test('the validation messages that echo the owner’s cost cells reach no non-owner (preview report, rows[].errors)', async () => {
  const raw = seed();
  const owner = appFor(raw, OWNER, MOUNTS);
  const prev = await preview(owner, ownerSheet());
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const importId = String(prev.body.import_id);

  // CONTROL — the owner's own preview carries every cost cell inside `errors`,
  // from the product, option, colour and variant rows.
  const ownerMsgs = messagesOf(prev.body).join('\n');
  for (const t of RAW_TEXTS) assert.ok(ownerMsgs.includes(t), `control: the owner's errors must echo "${t}":\n${ownerMsgs}`);
  // CONTROL — the stored report (what /report reads) holds them.
  const stored = JSON.parse(
    String((raw.prepare('SELECT report FROM product_imports WHERE id = ?').get(importId) as { report: string }).report)
  );
  const storedGiven = giveaways(messagesOf({ rows: stored }));
  for (const t of RAW_TEXTS) assert.ok(storedGiven.includes(`cell "${t}"`), `control: the stored errors hold "${t}": ${storedGiven}`);

  const all = await sweepAll(raw, importId);
  await assertExercised(owner, importId, all, '/report');
  assert.deepEqual(leaksOf(all), {}, 'a non-owner read the owner’s private cost out of the import report’s error messages');
});

test('…nor after confirm, when the same messages become `reason` (JSON and CSV report)', async () => {
  const raw = seed();
  const owner = appFor(raw, OWNER, MOUNTS);
  const prev = await preview(owner, ownerSheet());
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const importId = String(prev.body.import_id);
  const conf = await call(owner, 'POST', '/api/admin/import/confirm', { import_id: importId });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  // CONTROL — nothing reached the catalogue; the messages moved into `reason`.
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM products WHERE slug LIKE 'le-prn%' OR name = 'Errors Printer One'").get() as { n: number }).n, 0);
  const reasons = messagesOf(conf.body).join('\n');
  for (const t of RAW_TEXTS) assert.ok(reasons.includes(t), `control: confirm must copy "${t}" into reason:\n${reasons}`);

  const all = await sweepAll(raw, importId);
  await assertExercised(owner, importId, all, '/report?format=csv');
  assert.deepEqual(leaksOf(all), {}, 'a non-owner read the owner’s private cost out of the confirmed import report’s `reason`');
});

test('…and no non-owner is told by an error message that the owner’s cost equals a line’s (public) price', async () => {
  const raw = seed();
  const owner = appFor(raw, OWNER, MOUNTS);
  const prev = await preview(owner, ownerEqualSheet());
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  const importId = String(prev.body.import_id);
  assert.match(messagesOf(prev.body).join('\n'), /سعر البيع يساوي التكلفة/, 'control: the owner hears the equality refusal');

  const told: Record<string, string> = {};
  for (const [name, user] of nonOwners()) {
    const app = appFor(raw, user, MOUNTS);
    for (const suffix of ['/report', '/report?format=csv']) {
      const r = await call(app, 'GET', `/api/admin/import/${importId}${suffix}`);
      const m = messagesOf(r.body).find((x) => /يساوي التكلفة/.test(x));
      if (m) told[`${name} ${suffix}`] = m;
    }
  }
  assert.deepEqual(told, {}, 'a non-owner was told by an import error message that the owner’s cost equals a public price of product a1');
});
