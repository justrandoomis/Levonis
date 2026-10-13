/**
 * LEAK AUDIT — exports-files: the catalogue export
 * `GET /api/admin/import/export` (worker/routes/adminImport.ts) and the
 * guards that are supposed to prove it never hands a non-owner the cost sheet.
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price — never a purchase cost or a cost adjustment, in any
 * channel, an exported file included. The export serialises raw `SELECT *`
 * rows of products, option values, colours and variants; the only thing
 * between those rows and the file is `canViewCost` (`money`), which drops the
 * `cost_iqd` column from the shape (`shapeFor(…, money)`) and blanks every
 * cost cell (`money0`, `cost_iqd: money ? doc.product_cost_iqd : null`).
 *
 * This file proves, LOCALLY, each half of the candidate:
 *
 *   A. THE REAL PATH TODAY (control — expected to PASS).
 *      The role-matrix database, with the costly product `p_a1` filed under a
 *      real templated section (`cat_printers` › `cat_printers_fdm`) and one
 *      costed variant added, so the export's data path is reached.
 *      A1. the verified owner's CSV and ZIP carry every seeded cost cell
 *          (product, option, option adjust, colour, colour adjust, variant):
 *          the path is exercised and the sentinels are where they should be;
 *      A2. every non-owner ADMIN — assistant, full, legacy NULL scope, the
 *          grantee while delegation is off, the support assistant, and the
 *          owner's own session before the address is verified — downloads the
 *          same exports (200, the product/option/colour/variant rows ARE in
 *          the file) and no cost reaches any of them, in the CSV, in any ZIP
 *          entry after unzipping, or in the headers;
 *      A3. every non-admin role (guest, customer, merchant, employee,
 *          investor) is refused, and the refusal carries no cost.
 *
 *   B. THE GUARD GAPS (expected to FAIL on the current code):
 *      B1. the role-matrix GET sweep (tests/costRoleMatrix.test.ts via
 *          tests/fixtures/roleMatrix.ts `concrete()`) calls the export only as
 *          the bare path, with no `?category=` / `?ids=`; the route answers
 *          400 to EVERY caller there (even `?ids=p_a1` would: the seed product
 *          has no section), so not even the owner's sweep reaches the data
 *          path, and a non-owner regression would sail through.
 *          tests/routeClass/templates.ts classifies `GET /export` as `op` with
 *          no `path`, and costRouteClassification only uses `path` for refusal
 *          checks anyway — it never walks an `op` answer for cost;
 *      B2. the shared scanner (`leaks` in tests/fixtures/costlyProduct.ts),
 *          given the owner's plain CSV export exactly as the sweep's `call()`
 *          reads it (a string), finds NO cost although six sentinel costs sit
 *          in its cells: the digit pattern `\d[\d,]{3,}` takes the CSV commas
 *          for thousands separators and fuses neighbouring cells into one
 *          number (`900000,,,611111,,,…,5` → 900000611111…5), so a cost in a
 *          CSV row is invisible to it;
 *      B3. the same scanner, given the owner's ZIP export, finds nothing: the
 *          cost sits inside a deflate stream (`zipSync`, level 6) that a byte
 *          or digit scan cannot read.
 *
 * LOCAL ONLY: temp-file SQLite copies of the role-matrix database (every
 * migration), the real `/api/admin/import` router, the stub session of
 * tests/fixtures/app.ts. No network, no secret, no live host.
 *
 * Run: node --import tsx --test tests/leakAudit_exports-files_import_export_cost_gate_unproven_query_and_zip_blind.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { strFromU8, unzipSync } from 'fflate';
import { ctx } from './fixtures/app';
import { COST, SENTINELS, leaks } from './fixtures/costlyProduct';
import {
  BASE_MOUNTS,
  NOT_A_COST,
  OWNER,
  OWNER_UNVERIFIED,
  ROLES,
  appFor,
  call,
  getPaths,
  seededCopy,
  seededCopyUnverifiedOwner,
  sweepGets,
  type MountSpec,
  type RoleName,
  type Router,
} from './fixtures/roleMatrix';
import type { StubUser } from './fixtures/app';
import { parseCsv } from '../worker/lib/importCsv';
import { adminImportRoutes } from '../worker/routes/adminImport';

// ------------------------------------------------------------------ fixture

const PARENT = 'cat_printers';
const SECTION = 'cat_printers_fdm';
/** A variant cost sentinel of this file's own (the shared seed holds no variant). */
const VARIANT_COST = 657_777;
const EXTRA = { numbers: [VARIANT_COST] };

/** Every cost the export's data path serialises for the owner. */
const OWNER_SHEET: Record<string, number> = {
  'product.cost_iqd': COST.product,
  'option.cost_iqd': COST.option,
  'option.cost_adjust_iqd': COST.optionAdjust,
  'color.cost_iqd': COST.color,
  'color.cost_adjust_iqd': COST.colorAdjust,
  'variant.cost_iqd': VARIANT_COST,
};

const MOUNT: readonly MountSpec[] = [['/api/admin/import', adminImportRoutes as Router]];

/** The role-matrix database, with the costly product filed under a templated section and one costed variant. */
function seed(base: () => DatabaseSync = seededCopy): DatabaseSync {
  const raw = base();
  raw.exec(`
    UPDATE products SET category_id = '${PARENT}', sub_category_id = '${SECTION}' WHERE id = 'p_a1';
    INSERT INTO product_variants (id,product_id,combo_key,sku,active,cost_iqd,regular_price_iqd)
      VALUES ('pv_leak','p_a1','o:v_a1|c:c_blk','A1-BLK',1,${VARIANT_COST},950000);
  `);
  return raw;
}

/** Every way the export can be asked for: by section (leaf and parent), by product, CSV and ZIP. */
const EXPORTS = [
  `/api/admin/import/export?category=${SECTION}`,
  `/api/admin/import/export?category=${SECTION}&format=csv`,
  `/api/admin/import/export?category=${SECTION}&format=zip`,
  `/api/admin/import/export?category=${PARENT}&format=csv`,
  `/api/admin/import/export?category=${PARENT}&format=zip`,
  `/api/admin/import/export?ids=p_a1&format=csv`,
  `/api/admin/import/export?ids=p_a1&format=zip`,
  `/api/admin/import/export?ids=p_a1&category=${SECTION}&format=zip`,
];

interface Download {
  status: number;
  headers: Headers;
  /** Every file the answer carries, decoded: the CSV itself, or each ZIP entry. */
  files: Record<string, string>;
  /** The undecoded body as a string — what the sweep's `call()` hands `leaks`. */
  rawText: string;
}

async function download(app: ReturnType<typeof appFor>, path: string): Promise<Download> {
  const res = await app.request(path, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  const rawText = new TextDecoder().decode(bytes);
  const files: Record<string, string> = {};
  if (res.status >= 200 && res.status < 300 && type.includes('zip')) {
    for (const [name, data] of Object.entries(unzipSync(bytes))) files[name] = strFromU8(data).replace(/^\uFEFF/, '');
  } else if (res.status >= 200 && res.status < 300) {
    files['export.csv'] = rawText.replace(/^\uFEFF/, '');
  } else {
    files.body = rawText;
  }
  return { status: res.status, headers: res.headers, files, rawText };
}

/** A CSV as records keyed by its own header; numbers as numbers, an empty cell as null. */
function records(csv: string): Array<Record<string, unknown>> {
  const [header = [], ...rows] = parseCsv(csv);
  return rows.map((r) =>
    Object.fromEntries(
      header.map((h, i) => {
        const cell = (r[i] ?? '').trim();
        const value = cell === '' ? null : /^-?\d+(\.\d+)?$/.test(cell) ? Number(cell) : cell;
        return [h || `col${i}`, value];
      })
    )
  );
}

/**
 * Every private value in a download, cell by cell: the shared scanner over the
 * CSV as records (a cost-named key with a number, a FINANCIAL_FIELDS key with
 * a value, a sentinel number) and over the text of every file, plus any cell
 * that spells a sentinel.
 */
function privateIn(d: Download): string[] {
  const out: string[] = [];
  for (const [name, text] of Object.entries(d.files)) {
    for (const l of leaks(text, EXTRA)) out.push(`${name} (text) ${l}`);
    if (!name.endsWith('.csv')) continue;
    // The data sheet as records. labels.csv is the header's Arabic captions
    // (a caption under `cost_adjust_iqd` is text, not a value), so it gets the
    // text and cell scans only.
    if (name !== 'labels.csv') for (const l of leaks(records(text), EXTRA)) out.push(`${name} ${l}`);
    parseCsv(text).forEach((row, i) =>
      row.forEach((cell, j) => {
        const n = Number(cell.replace(/,/g, '').trim());
        if (cell.trim() !== '' && (SENTINELS.has(n) || n === VARIANT_COST)) out.push(`${name} row ${i} col ${j} = ${cell}`);
      })
    );
  }
  d.headers.forEach((v, k) => {
    for (const l of leaks(v, EXTRA)) out.push(`header ${k} ${l}`);
  });
  return out;
}

/** The cost cells of the owner's sheet, as `<row_type>.<column>` → value. */
function costCells(csv: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records(csv)) {
    for (const col of ['cost_iqd', 'cost_adjust_iqd']) {
      if (typeof r[col] === 'number') out[`${String(r.row_type)}.${col}`] = r[col] as number;
    }
  }
  return out;
}

const dataCsv = (d: Download) => d.files['data.csv'] ?? d.files['export.csv'] ?? '';
const rowTypes = (csv: string) => new Set(records(csv).filter((r) => r.key === 'a1').map((r) => String(r.row_type)));

const NON_OWNER_ADMINS: readonly RoleName[] = ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant'];
const NON_ADMINS: readonly RoleName[] = ['guest', 'customer', 'merchant', 'employee', 'investor'];

// ---------------------------------------------------------- A. the real path

test('A1 (control) the verified owner exports the whole cost sheet — the data path is exercised', async () => {
  const app = appFor(seed(), OWNER, MOUNT);
  for (const path of EXPORTS) {
    const d = await download(app, path);
    assert.equal(d.status, 200, `${path} → ${d.status} ${d.rawText.slice(0, 200)}`);
    const csv = dataCsv(d);
    assert.ok(csv, `${path}: no data file in the answer (${Object.keys(d.files).join(', ')})`);
    assert.deepEqual(costCells(csv), OWNER_SHEET, `${path}: the owner's sheet carries every seeded cost`);
    assert.ok(parseCsv(csv)[0].includes('cost_iqd'), `${path}: the owner's header has cost_iqd`);
    assert.ok(privateIn(d).length >= Object.keys(OWNER_SHEET).length, `${path}: the cell scan sees the owner's costs`);
  }
});

test('A2 every non-owner admin (and the unverified owner) downloads the export — and no cost is in any file', async () => {
  const callers: Array<[string, StubUser, () => DatabaseSync]> = [
    ...NON_OWNER_ADMINS.map((r) => [r, ROLES[r]!, () => seed()] as [string, StubUser, () => DatabaseSync]),
    ['owner_unverified', OWNER_UNVERIFIED, () => seed(seededCopyUnverifiedOwner)],
  ];
  const problems: string[] = [];
  let exercised = 0;
  for (const [who, user, db] of callers) {
    const app = appFor(db(), user, MOUNT);
    for (const path of EXPORTS) {
      const d = await download(app, path);
      if (d.status !== 200) {
        problems.push(`${who} ${path}: ${d.status} — the export was expected to answer an admin (path not exercised)`);
        continue;
      }
      const csv = dataCsv(d);
      const types = rowTypes(csv);
      for (const t of ['product', 'option', 'color', 'variant']) {
        if (!types.has(t)) problems.push(`${who} ${path}: no ${t} row for a1 — the data path was not exercised`);
      }
      exercised += 1;
      if (parseCsv(csv)[0]?.includes('cost_iqd')) problems.push(`${who} ${path}: the header carries cost_iqd`);
      const cells = costCells(csv);
      if (Object.keys(cells).length) problems.push(`${who} ${path}: cost cells ${JSON.stringify(cells)}`);
      for (const l of privateIn(d)) problems.push(`${who} ${path}: ${l}`);
      const cc = d.headers.get('cache-control') ?? '';
      if (!/no-store/.test(cc)) problems.push(`${who} ${path}: Cache-Control "${cc}"`);
    }
  }
  assert.equal(exercised, callers.length * EXPORTS.length, `only ${exercised} exports answered:\n${problems.join('\n')}`);
  assert.deepEqual(problems, [], `a private cost reached a non-owner through the catalogue export:\n${problems.join('\n')}`);
});

test('A3 every non-admin role is refused the export, and the refusal carries no cost', async () => {
  const problems: string[] = [];
  for (const role of NON_ADMINS) {
    const app = appFor(seed(), ROLES[role] ?? null, MOUNT);
    for (const path of EXPORTS) {
      const d = await download(app, path);
      if (d.status !== 401 && d.status !== 403) problems.push(`${role} ${path}: ${d.status}`);
      for (const l of privateIn(d)) problems.push(`${role} ${path}: ${l}`);
    }
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------- B. the guard gaps

test('B1 GUARD GAP: the role-matrix GET sweep reaches the export’s data path (the owner’s sweep sees its cost)', async () => {
  const swept = getPaths(BASE_MOUNTS).filter((p) => p.startsWith('/api/admin/import/export'));
  // What the sweep calls, on the database the sweep uses.
  const result = await sweepGets({ mounts: MOUNT, roles: { owner: OWNER } });
  const owner = result.owner!;
  const statuses = Object.fromEntries(Object.entries(owner.statuses).filter(([p]) => p.startsWith('/api/admin/import/export')));
  // Even the one query the sweep could plausibly add answers 400 on the seed: p_a1 has no section.
  const byIds = await call(appFor(seededCopy(), OWNER, MOUNT), 'GET', '/api/admin/import/export?ids=p_a1');
  const reached = Object.entries(statuses).filter(([p, s]) => s >= 200 && s < 300 && owner.costSeen.includes(p));
  assert.ok(
    reached.length > 0,
    `the cost sweep never reaches /api/admin/import/export's data path, so a non-owner regression there is invisible to it: ` +
      `swept paths ${JSON.stringify(swept)}, owner statuses ${JSON.stringify(statuses)}, ` +
      `?ids=p_a1 on the seed → ${byIds.status} ${JSON.stringify(byIds.body)}`
  );
});

test('B2 GUARD GAP: the shared scanner finds the cost in the owner’s CSV export as the sweep reads it', async () => {
  const app = appFor(seed(), OWNER, MOUNT);
  const path = `/api/admin/import/export?category=${SECTION}&format=csv`;
  const res = await call(app, 'GET', path);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'string', 'the sweep hands the scanner the CSV as text');
  // Ground truth: the cost cells are there (A1).
  assert.deepEqual(costCells((res.body as string).replace(/^\uFEFF/, '')), OWNER_SHEET);
  const seen = leaks(res.body, EXTRA).filter((l) => !NOT_A_COST.some((x) => x.path.test(path) && x.leak.test(l)));
  assert.ok(
    seen.length > 0,
    `leaks() reads the owner's CSV export (cost cells ${JSON.stringify(OWNER_SHEET)}) and finds nothing: ` +
      `its digit pattern takes CSV commas for thousands separators and fuses neighbouring cells ` +
      `(e.g. ${JSON.stringify(((res.body as string).match(/\d[\d,]{3,}/g) ?? []).find((m) => m.includes(String(COST.product)))?.slice(0, 40))}…), ` +
      `so a cost in any CSV answer is invisible to every sweep that uses it`
  );
});

test('B3 GUARD GAP: the shared scanner finds the cost in the owner’s ZIP export as the sweep reads it', async () => {
  const app = appFor(seed(), OWNER, MOUNT);
  const path = `/api/admin/import/export?category=${SECTION}&format=zip`;
  const d = await download(app, path);
  assert.equal(d.status, 200);
  // Ground truth: unzipped, data.csv carries the whole cost sheet.
  assert.deepEqual(costCells(d.files['data.csv']), OWNER_SHEET);
  const res = await call(app, 'GET', path);
  assert.equal(res.status, 200);
  const seen = leaks(res.body, EXTRA).filter((l) => !NOT_A_COST.some((x) => x.path.test(path) && x.leak.test(l)));
  assert.ok(
    seen.length > 0,
    `leaks() reads the owner's ZIP export and finds nothing although its data.csv carries ${JSON.stringify(OWNER_SHEET)}: ` +
      `the cost is inside a deflate stream (raw body contains "${COST.product}": ${d.rawText.includes(String(COST.product))})`
  );
});
