/**
 * §18 — THE PRODUCT-SCOPED MEMBERSHIP DISCOUNT, THROUGH THE REAL IMPORT DOOR.
 *
 * `tests/membershipBenefitsWired.test.ts` proves a rule an owner types in the
 * panel reaches the price a customer pays. This file proves the other half of
 * the mandate: that the same rule can be written, read back and removed with a
 * SPREADSHEET, and — much more importantly — that a spreadsheet which says
 * nothing about it cannot destroy it.
 *
 * Real migrations, real SQLite, the real `/api/admin/import` router. Nothing
 * about the benefit rules is stubbed: every write here goes through
 * `saveBenefitRule` / `deleteBenefitRule`, so the version row and the audit row
 * are the ones the production path appends, not ones the test arranged.
 *
 * THE DANGEROUS CASE IS TEST 4. An owner exports a catalogue on Monday, writes
 * a PRO discount in the admin panel on Tuesday, and re-imports Monday's file on
 * Wednesday to fix a typo in a name. If empty cells meant "no discount", that
 * import would silently delete Tuesday's pricing and nothing on any screen
 * would say so. Blank means UNCHANGED; only `__NULL__` deletes.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { EMPTY_DIMENSIONS } from '../worker/lib/productModel';
import { freshDb, asD1, stubApp, ctx, all, count, type App } from './fixtures/app';
import { adminImportRoutes } from '../worker/routes/adminImport';
import {
  buildBlankTemplate,
  buildExampleTemplate,
  templateDownloadDiagnostics,
  templateRoutes,
} from '../worker/routes/template';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import {
  MEMBERSHIP_COLUMNS,
  MEMBERSHIP_MAX_IQD,
  MEMBERSHIP_MAX_PERCENT,
  MEMBERSHIP_MAX_QUANTITY,
  MEMBERSHIP_NULL,
  membershipReadme,
  parseImport,
  readmeFor,
  serializeProducts,
  templateShape,
  toCsv,
  type ExportProduct,
} from '../worker/lib/importCsv';

// ------------------------------------------------------------------ fixture

const SECTION = 'tpl_printers';

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role)
      VALUES ('boss','Admin','boss@x.co','h','admin');
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,template_family,is_printer_catalog,active)
      VALUES ('${SECTION}',NULL,'tpl-printers','طابعات القالب','Template Printers','devices',1,1);
  `);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) =>
    a.route('/api/admin/import', adminImportRoutes)
  );
  return { raw, app };
}

/**
 * A minimal sheet: the columns this test writes and nothing else.
 *
 * That is not a shortcut — it is the point. `parseImport` reads the header the
 * FILE carries, so leaving the membership columns out of `head` reproduces an
 * older export exactly, with no shape surgery.
 */
const HEAD = ['row_type', 'key', 'name', 'status', 'category', 'price_iqd', 'stock'];

function sheet(columns: string[], cells: Record<string, string>): string {
  return toCsv([columns, columns.map((c) => cells[c] ?? '')]);
}

const productCells = (key: string, over: Record<string, string> = {}) => ({
  row_type: 'product',
  key,
  name: `Printer ${key}`,
  status: 'active',
  category: 'tpl-printers',
  price_iqd: '1000000',
  stock: '5',
  ...over,
});

/** The mandate's own example: PRO 10%, capped at 100,000 per unit. */
const PRO_TEN_PERCENT = {
  'membership.pro.discount_mode': 'percent',
  'membership.pro.percent': '10',
  'membership.pro.max_discount_iqd': '100000',
  'membership.pro.cap_scope': 'per_unit',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response) => (await res.json()) as Record<string, any>;

async function preview(app: App, csv: string) {
  const form = new FormData();
  form.set('file', new File([csv], 'data.csv', { type: 'text/csv' }));
  form.set('category', SECTION);
  const res = await app.request(
    '/api/admin/import/preview',
    { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  return body(res);
}

async function confirm(app: App, importId: string) {
  const res = await app.request(
    '/api/admin/import/confirm',
    {
      method: 'POST',
      body: JSON.stringify({ import_id: importId }),
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    },
    undefined,
    ctx
  );
  return body(res);
}

/** Preview then confirm, asserting the file was accepted on the way through. */
async function importSheet(app: App, csv: string) {
  const prev = await preview(app, csv);
  assert.equal(prev.success, true, JSON.stringify(prev));
  assert.deepEqual(
    prev.rows.flatMap((r: { errors: string[] }) => r.errors),
    [],
    'the preview refused a sheet this test expected it to accept'
  );
  return confirm(app, prev.import_id);
}

interface RuleRow {
  id: string;
  tier: string;
  benefit_type: string;
  scope: string;
  product_id: string | null;
  discount_mode: string | null;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: string | null;
  max_quantity: number | null;
  enabled: number;
  priority: number;
  valid_until: string | null;
  label: string | null;
}

const rules = (raw: DatabaseSync) =>
  all<RuleRow>(raw, "SELECT * FROM membership_benefit_rules WHERE scope = 'product' ORDER BY id");
const versions = (raw: DatabaseSync) => count(raw, 'SELECT COUNT(*) AS n FROM membership_benefit_versions');
const audits = (raw: DatabaseSync) =>
  count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'membership_benefit.%'");

// ------------------------------------------------ 1. the old file is safe

test('an old sheet with none of the membership columns leaves the stored rules untouched', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('OLD-1'), ...PRO_TEN_PERCENT }));
  const before = rules(raw);
  assert.equal(before.length, 1);
  const versionsBefore = versions(raw);

  // The same product, from a sheet whose header has never heard of these
  // columns. This is exactly what an export taken before §18 looks like.
  const res = await importSheet(app, sheet(HEAD, productCells('OLD-1', { name: 'Renamed printer' })));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.summary.updated, 1, 'the product itself was still updated');

  assert.deepEqual(rules(raw), before, 'an older file must not touch a single rule field');
  assert.equal(versions(raw), versionsBefore, 'and must not append a version for a change it never made');
});

// ------------------------------------------ 2. the rule is created, once

test('a sheet setting PRO 10% capped 100,000 per unit creates one product rule, a version and an audit row', async () => {
  const { raw, app } = setup();
  const versionsBefore = versions(raw);
  const auditsBefore = audits(raw);

  const res = await importSheet(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('NEW-1'), ...PRO_TEN_PERCENT }));
  assert.equal(res.summary.created, 1, JSON.stringify(res));

  const stored = rules(raw);
  assert.equal(stored.length, 1, 'exactly one rule, not one per row of the file');
  const rule = stored[0];
  const productId = (
    all<{ id: string }>(raw, 'SELECT id FROM products WHERE sku = ?', 'NEW-1')[0]
  ).id;
  assert.equal(rule.tier, 'pro');
  assert.equal(rule.benefit_type, 'product_discount');
  assert.equal(rule.scope, 'product');
  assert.equal(rule.product_id, productId, 'the rule names THIS product, not a section');
  assert.equal(rule.discount_mode, 'percent');
  assert.equal(rule.percent, 10);
  assert.equal(rule.max_discount_iqd, 100_000);
  assert.equal(rule.cap_scope, 'per_unit');
  assert.equal(rule.enabled, 1);

  assert.equal(versions(raw), versionsBefore + 1, 'a rule written from a sheet is still versioned');
  assert.equal(audits(raw), auditsBefore + 1, 'and still attributed to the admin who confirmed it');
  const version = all<{ actor_user_id: string; action: string; rule_id: string }>(
    raw,
    'SELECT actor_user_id, action, rule_id FROM membership_benefit_versions ORDER BY id DESC LIMIT 1'
  )[0];
  assert.equal(version.action, 'create');
  assert.equal(version.rule_id, rule.id);
  assert.equal(version.actor_user_id, 'boss');

  // PREMIUM said nothing, so PREMIUM has nothing.
  assert.equal(stored.filter((r) => r.tier === 'prime').length, 0);
});

// ------------------------------------------- 3. export, re-import, same row

test('exporting the product and re-importing the export reproduces the rule with no duplicate', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('RT-1'), ...PRO_TEN_PERCENT }));
  const before = rules(raw);
  assert.equal(before.length, 1);

  const exported = await app.request(
    `/api/admin/import/export?category=${SECTION}&format=csv`,
    { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  assert.equal(exported.status, 200);
  const csv = (await exported.text()).replace(/^\uFEFF/, '');
  assert.match(csv, /membership\.pro\.percent/, 'the export carries the columns');
  assert.ok(!csv.includes(MEMBERSHIP_NULL), 'an export never carries a deletion order');

  const res = await importSheet(app, csv);
  assert.equal(res.summary.updated, 1, JSON.stringify(res));

  const after = rules(raw);
  assert.equal(after.length, 1, 'a re-import updates the rule it found; it does not add a second one');
  assert.equal(after[0].id, before[0].id, 'and reuses its id, so the version history stays one story');
  assert.deepEqual(
    { ...after[0], updated_at: undefined },
    { ...before[0], updated_at: undefined },
    'every value survives the round trip'
  );
});

// --------------------------------------- 4. blank cells are not a deletion

test('a second import with the membership cells empty does not delete the rule', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('KEEP-1'), ...PRO_TEN_PERCENT }));
  const before = rules(raw);
  assert.equal(before.length, 1);
  const versionsBefore = versions(raw);

  // The columns are PRESENT and EMPTY — the file the owner downloaded before
  // they wrote the discount, re-imported after they wrote it.
  const res = await importSheet(
    app,
    sheet([...HEAD, ...MEMBERSHIP_COLUMNS], productCells('KEEP-1', { name: 'Still here' }))
  );
  assert.equal(res.summary.updated, 1, JSON.stringify(res));
  assert.deepEqual(rules(raw), before, 'blank means UNCHANGED, never "no discount"');
  assert.equal(versions(raw), versionsBefore, 'nothing was written, so nothing was versioned');
});

// -------------------------------- 5. an impossible rule is refused up front

test('a ceiling with no per-unit/per-order choice is refused in the preview, before anything is written', async () => {
  const { raw, app } = setup();
  const bad = sheet([...HEAD, ...MEMBERSHIP_COLUMNS], {
    ...productCells('BAD-1'),
    'membership.pro.discount_mode': 'percent',
    'membership.pro.percent': '10',
    'membership.pro.max_discount_iqd': '100000',
    // cap_scope deliberately left empty: "up to 100,000" per WHAT?
  });
  const prev = await preview(app, bad);
  assert.equal(prev.success, true);
  assert.equal(prev.summary.failed, 1);
  assert.equal(prev.rows[0].action, 'failed');
  const message = prev.rows[0].errors.join(' | ');
  assert.match(message, /membership\.pro\.cap_scope/);
  // The admin door's own sentence, so the sheet and the panel refuse alike.
  assert.match(message, /Say whether the ceiling is per unit or per order/);

  // A preview writes nothing at all — §10 — and that includes benefit rules.
  assert.equal(rules(raw).length, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0);

  const res = await confirm(app, prev.import_id);
  assert.equal(res.summary.created, 0, 'the refused row is not written by confirming either');
  assert.equal(rules(raw).length, 0);

  // The other refusals the admin door makes, made here too.
  for (const [cells, needle] of [
    [{ 'membership.pro.discount_mode': 'percent' }, /Enter the percentage/],
    [{ 'membership.pro.discount_mode': 'fixed' }, /Enter the amount in dinars/],
    [{ 'membership.pro.percent': '10' }, /A discount rule needs a percentage or a fixed amount/],
    [{ 'membership.pro.discount_mode': 'percent', 'membership.pro.percent': '10', 'membership.pro.cap_scope': 'per_unit' }, /Enter the ceiling/],
    [{ 'membership.pro.discount_mode': 'nearly' }, /القيم المتاحة: percent \/ fixed/],
    [{ 'membership.pro.discount_mode': 'percent', 'membership.pro.percent': '0' }, /between 1 and 100/],
  ] as Array<[Record<string, string>, RegExp]>) {
    const res2 = await preview(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('BAD-2'), ...cells }));
    assert.match(res2.rows[0].errors.join(' | '), needle, JSON.stringify(cells));
  }
});

// ------------------------------------- 6. removal has to be said out loud

test('__NULL__ in the discount_mode cell removes the rule, and is the only thing that does', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('DEL-1'), ...PRO_TEN_PERCENT }));
  assert.equal(rules(raw).length, 1);
  const versionsBefore = versions(raw);

  const res = await importSheet(
    app,
    sheet([...HEAD, ...MEMBERSHIP_COLUMNS], {
      ...productCells('DEL-1'),
      'membership.pro.discount_mode': MEMBERSHIP_NULL,
    })
  );
  assert.equal(res.summary.updated, 1, JSON.stringify(res));
  assert.equal(rules(raw).length, 0, 'the rule is gone');
  assert.equal(versions(raw), versionsBefore + 1, 'and the deletion is versioned like any other write');
  assert.equal(
    all<{ action: string }>(raw, 'SELECT action FROM membership_benefit_versions ORDER BY id DESC LIMIT 1')[0].action,
    'delete'
  );

  // Removing something that is not there is not an error.
  const again = await importSheet(
    app,
    sheet([...HEAD, ...MEMBERSHIP_COLUMNS], {
      ...productCells('DEL-1'),
      'membership.pro.discount_mode': MEMBERSHIP_NULL,
    })
  );
  assert.equal(again.summary.failed, 0);
});

// ------------------------- 7. what the sheet cannot say, it cannot destroy

test('a re-import keeps the date window, the label and the on/off switch the sheet has no column for', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('KEEP-2'), ...PRO_TEN_PERCENT }));
  const id = rules(raw)[0].id;
  raw
    .prepare(
      "UPDATE membership_benefit_rules SET enabled = 0, priority = 7, valid_until = '2027-01-01T00:00:00.000Z', label = 'Winter', notes = 'mine' WHERE id = ?"
    )
    .run(id);

  await importSheet(
    app,
    sheet([...HEAD, ...MEMBERSHIP_COLUMNS], {
      ...productCells('KEEP-2'),
      ...PRO_TEN_PERCENT,
      'membership.pro.percent': '15',
    })
  );
  const after = rules(raw)[0];
  assert.equal(after.percent, 15, 'the sheet changed what it named');
  assert.equal(after.enabled, 0, 'and nothing it did not');
  assert.equal(after.priority, 7);
  assert.equal(after.valid_until, '2027-01-01T00:00:00.000Z');
  assert.equal(after.label, 'Winter');
});

// ------------------------------------------- 8. the pure serialize/parse pair

const shape = templateShape('printer', ['tpl-printers'], { includeCost: true });

test('serializeProducts and parseImport are inverses for the membership block', () => {
  const base: ExportProduct = {
    key: 'SER-1',
    dimensions: EMPTY_DIMENSIONS(),
    // 0104 — the product's page in the Qi Card instalments app.
    gini_url: '',
    name: 'Serializer',
    description: '',
    status: 'active',
    sku: 'SER-1',
    display_order: 0,
    is_featured: false,
    brand: '',
    category: 'Template Printers',
    sub_category: '',
    sale_types: ['direct_sale'],
    inventory_mode: 'BASE',
    price_iqd: 500_000,
    prime_price_iqd: null,
    pro_price_iqd: null,
    cost_iqd: null,
    direct_surcharge_iqd: null,
    stock: 3,
    low_stock_threshold: null,
    warranty_base_months: null,
    serialized: null,
    payment_options: [],
    how_to_use: '',
    usage_url: '',
    hashtags: [],
    spec_fields: {},
    membership_rules: [
      {
        tier: 'pro',
        discount_mode: 'percent',
        percent: 10,
        fixed_iqd: null,
        max_discount_iqd: 100_000,
        cap_scope: 'per_unit',
        max_quantity: null,
      },
      {
        tier: 'prime',
        discount_mode: 'fixed',
        percent: null,
        fixed_iqd: 25_000,
        max_discount_iqd: null,
        cap_scope: null,
        max_quantity: 2,
      },
    ],
    options: [],
    colors: [],
    variants: [],
    images: [],
    transports: [],
    specs: [],
    labels: [],
    warranty_plans: [],
    content_blocks: [],
    guide_steps: [],
  };

  const once = serializeProducts([base], shape);
  const parsed = parseImport(once, shape);
  assert.deepEqual(parsed.issues.filter((i) => i.severity === 'error'), []);
  assert.deepEqual(
    parsed.products[0].membership_rules.map(({ line: _line, remove: _remove, ...rest }) => rest),
    base.membership_rules
  );
  // A second pass writes the identical bytes: no invented value, no drift.
  assert.equal(serializeProducts([{ ...base, membership_rules: parsed.products[0].membership_rules }], shape), once);

  // And a product with no rule writes six empty cells per tier, not __NULL__.
  const none = serializeProducts([{ ...base, membership_rules: [] }], shape);
  assert.ok(!none.includes(MEMBERSHIP_NULL));
  assert.deepEqual(parseImport(none, shape).products[0].membership_rules, []);
});

test('the template documents the columns it ships, with their units and the removal marker', () => {
  const readme = membershipReadme();
  for (const column of MEMBERSHIP_COLUMNS) {
    const field = column.slice(column.lastIndexOf('.') + 1);
    assert.ok(readme.includes(field), `the README omits ${column}`);
  }
  assert.ok(readme.includes(MEMBERSHIP_NULL), 'the removal marker is documented');
  // And the block is actually inside the README the ZIP ships, not orphaned.
  assert.ok(readmeFor(shape).includes(readme), 'readmeFor does not carry the membership block');
  assert.match(readme, /د\.ع/, 'dinars are named as the unit');
  assert.match(readme, /per_unit \/ per_order/);
  // And the two lists — the literal columns and the derived key names — are
  // the same set in both directions, so neither can grow a field alone.
  assert.deepEqual(
    shape.columns.filter((c) => c.startsWith('membership.')).sort(),
    [...MEMBERSHIP_COLUMNS].sort()
  );
});

/* ======================================================================== */
/*  THE TXT TEMPLATE — the same six values, the same three states.          */
/*                                                                          */
/*  The product editor's own file (`/api/admin/template`) carries the rule   */
/*  under `membership.<tier>.<field>` keys spelt exactly as the spreadsheet  */
/*  columns are, and validated by the same function. These tests exist to    */
/*  prove that "the same" is true in the database, not only in the source.   */
/* ======================================================================== */

const txtApp = (db: unknown) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) =>
    a.route('/api/admin/template', templateRoutes)
  );

const BASE_TXT = [
  'template_version=2',
  'slug=txt-membership',
  'name_ar=طابعة القالب',
  'name_en=Template printer',
  'status=draft',
  'price_iqd=1000000',
  'stock=5',
].join('\n');

const txtWith = (...lines: string[]) => [BASE_TXT, ...lines].join('\n');

const txtParse = async (app: App, text: string) =>
  body(
    await app.request(
      '/api/admin/template/parse',
      {
        method: 'POST',
        body: JSON.stringify({ text }),
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      },
      undefined,
      ctx
    )
  );

const txtApply = async (app: App, text: string, mode: 'draft' | 'update' = 'draft') =>
  body(
    await app.request(
      '/api/admin/template/apply',
      {
        method: 'POST',
        body: JSON.stringify({ text, mode, confirm: true }),
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      },
      undefined,
      ctx
    )
  );

const PRO_TXT = [
  'membership.pro.discount_mode=percent',
  'membership.pro.percent=10',
  'membership.pro.max_discount_iqd=100000',
  'membership.pro.cap_scope=per_unit',
];

test('the TXT template writes the product rule, and says what it will do before it does', async () => {
  const raw = freshDb();
  const app = txtApp(asD1(raw));

  const preview = await txtParse(app, txtWith(...PRO_TXT));
  assert.deepEqual(preview.errors, [], JSON.stringify(preview.errors));
  assert.deepEqual(preview.unknown_keys, [], 'the membership keys are known, not unknown');
  assert.deepEqual(preview.membership, [
    {
      tier: 'pro',
      action: 'set',
      discount_mode: 'percent',
      percent: 10,
      fixed_iqd: null,
      max_discount_iqd: 100_000,
      cap_scope: 'per_unit',
      max_quantity: null,
    },
  ]);
  assert.equal(rules(raw).length, 0, 'a parse writes nothing');

  const applied = await txtApply(app, txtWith(...PRO_TXT));
  assert.equal(applied.success, true, JSON.stringify(applied));
  const stored = rules(raw);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].tier, 'pro');
  assert.equal(stored[0].scope, 'product');
  assert.equal(stored[0].product_id, applied.product_id ?? applied.product?.id);
  assert.equal(stored[0].percent, 10);
  assert.equal(stored[0].cap_scope, 'per_unit');
  assert.equal(versions(raw), 2, 'the seeded version, then this one');
  assert.equal(audits(raw), 1);
});

test('the TXT export carries the rule, and re-applying that export changes nothing', async () => {
  const raw = freshDb();
  const app = txtApp(asD1(raw));
  const created = await txtApply(app, txtWith(...PRO_TXT));
  const productId = String(created.product_id ?? created.product?.id);
  const before = rules(raw);
  assert.equal(before.length, 1);

  const res = await app.request(
    `/api/admin/template/export/${productId}`,
    { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  assert.equal(res.status, 200);
  const exported = await res.text();
  assert.match(exported, /^membership\.pro\.percent=10$/m, 'the export states the rule it found');
  assert.match(exported, /^membership\.pro\.cap_scope=per_unit$/m);
  // PREMIUM has no rule, so its keys ship EMPTY — never __NULL__, which would
  // make the export a deletion order for a discount written tomorrow.
  assert.match(exported, /^membership\.premium\.discount_mode=$/m);
  assert.ok(!/^membership\.[a-z]+\.[a-z_]+=__NULL__$/m.test(exported));

  const again = await txtApply(app, exported, 'update');
  assert.equal(again.success, true, JSON.stringify(again));
  const after = rules(raw);
  assert.equal(after.length, 1, 'no second rule');
  assert.equal(after[0].id, before[0].id);
  assert.deepEqual({ ...after[0], updated_at: undefined }, { ...before[0], updated_at: undefined });
});

test('a TXT file that never mentions the keys leaves the rule alone; __NULL__ removes it', async () => {
  const raw = freshDb();
  const app = txtApp(asD1(raw));
  const created = await txtApply(app, txtWith(...PRO_TXT));
  const productId = String(created.product_id ?? created.product?.id);
  const before = rules(raw);
  const versionsBefore = versions(raw);

  const silent = await txtApply(app, `${txtWith()}\nproduct_id=${productId}\ndisplay_order=3`, 'update');
  assert.equal(silent.success, true, JSON.stringify(silent));
  assert.deepEqual(rules(raw), before, 'silence is not a deletion');
  assert.equal(versions(raw), versionsBefore);

  const removed = await txtApply(
    app,
    `${txtWith()}\nproduct_id=${productId}\nmembership.pro.discount_mode=${MEMBERSHIP_NULL}`,
    'update'
  );
  assert.equal(removed.success, true, JSON.stringify(removed));
  assert.equal(rules(raw).length, 0);
  assert.equal(versions(raw), versionsBefore + 1);
});

test('the TXT template refuses an impossible rule before the product is written', async () => {
  const raw = freshDb();
  const app = txtApp(asD1(raw));
  const text = txtWith(
    'membership.pro.discount_mode=percent',
    'membership.pro.percent=10',
    'membership.pro.max_discount_iqd=100000'
    // no cap_scope
  );

  const preview = await txtParse(app, text);
  assert.equal(preview.errors.length, 1, JSON.stringify(preview.errors));
  assert.equal(preview.errors[0].key, 'membership.pro.cap_scope');
  assert.match(preview.errors[0].message, /Say whether the ceiling is per unit or per order/);
  // The line number points at the block the admin is looking at, not at line 0.
  assert.ok(preview.errors[0].line > 1);

  const applied = await txtApply(app, text);
  assert.equal(applied.success, false);
  assert.equal(applied.code, 'TEMPLATE_ERRORS');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0, 'nothing was written');
  assert.equal(rules(raw).length, 0);
});

test('a membership line inside a heredoc is text, not a price', async () => {
  const raw = freshDb();
  const app = txtApp(asD1(raw));
  const text = [
    BASE_TXT,
    'description_en=<<<END',
    'membership.pro.discount_mode=percent',
    'membership.pro.percent=90',
    'END',
  ].join('\n');

  const applied = await txtApply(app, text);
  assert.equal(applied.success, true, JSON.stringify(applied));
  assert.equal(rules(raw).length, 0, 'a description can never set a discount');
  const stored = all<{ description: string }>(raw, 'SELECT description FROM products')[0];
  assert.match(stored.description, /membership\.pro\.percent=90/, 'and it is still there as text');
});

test('the blank template and the example teach the keys without carrying a value', async () => {
  const blank = buildBlankTemplate().text;
  const example = buildExampleTemplate();
  for (const text of [blank, example]) {
    for (const key of MEMBERSHIP_COLUMNS) {
      assert.ok(text.includes(key), `the download omits ${key}`);
      // Commented out, and with no number beside it: a downloaded file must
      // never hide a commercial value the owner did not type.
      // The dots are LITERAL: `membership.pro.percent` must not be allowed to
      // match `membershipXproXpercent`, and an unescaped `.` in a RegExp does.
      assert.match(text, new RegExp(`^#\\s*${key.replace(/[.]/g, '\\.')}=\\s*$`, 'm'), `${key} ships with a value`);
    }
  }
  // And what they ship still parses with zero errors and no unknown keys.
  const diag = templateDownloadDiagnostics();
  assert.equal(diag.blank.errors, 0);
  assert.deepEqual(diag.blank.unknown_keys, []);
  assert.equal(diag.example.errors, 0);
  assert.deepEqual(diag.example.unknown_keys, []);
});

/* ======================================================================== */
/*  THE SHEET IS NOT A WIDER DOOR THAN THE PANEL.                           */
/*                                                                          */
/*  A refusal that exists in `ruleFromBody` and not in                      */
/*  `membershipRuleFromCells` is a rule the owner cannot type in the admin   */
/*  screen and CAN type in a spreadsheet — which is the whole point of       */
/*  having one validator. These tests drive BOTH doors with the same value,  */
/*  so a ceiling moved on one side and not the other fails here rather than  */
/*  in the database.                                                        */
/* ======================================================================== */

const doorApp = (db: unknown) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => {
    a.route('/api/admin/import', adminImportRoutes);
    a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
  });

function setupBoth() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role)
      VALUES ('boss','Admin','boss@x.co','h','admin');
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,template_family,is_printer_catalog,active)
      VALUES ('${SECTION}',NULL,'tpl-printers','طابعات القالب','Template Printers','devices',1,1);
  `);
  return { raw, app: doorApp(asD1(raw)) };
}

/** The admin door, asked to store exactly what the sheet was asked to store. */
const adminRule = (app: App, over: Record<string, unknown>) =>
  app.request(
    '/api/admin/membership-benefits',
    {
      method: 'POST',
      body: JSON.stringify({
        tier: 'pro',
        benefit_type: 'product_discount',
        scope: 'product',
        product_id: 'any-product',
        ...over,
      }),
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    },
    undefined,
    ctx
  );

test('every range the admin door enforces, the sheet enforces — at the same boundary', async () => {
  /** [the cells, the admin body, a fragment of the refusal] */
  const overTheLine: Array<[Record<string, string>, Record<string, unknown>]> = [
    [
      { 'membership.pro.discount_mode': 'fixed', 'membership.pro.fixed_iqd': String(MEMBERSHIP_MAX_IQD + 1) },
      { discount_mode: 'fixed', fixed_iqd: MEMBERSHIP_MAX_IQD + 1 },
    ],
    [
      {
        'membership.pro.discount_mode': 'percent',
        'membership.pro.percent': '10',
        'membership.pro.max_discount_iqd': String(MEMBERSHIP_MAX_IQD + 1),
        'membership.pro.cap_scope': 'per_order',
      },
      { discount_mode: 'percent', percent: 10, max_discount_iqd: MEMBERSHIP_MAX_IQD + 1, cap_scope: 'per_order' },
    ],
    [
      {
        'membership.pro.discount_mode': 'percent',
        'membership.pro.percent': '10',
        'membership.pro.max_quantity': String(MEMBERSHIP_MAX_QUANTITY + 1),
      },
      { discount_mode: 'percent', percent: 10, max_quantity: MEMBERSHIP_MAX_QUANTITY + 1 },
    ],
    [
      { 'membership.pro.discount_mode': 'percent', 'membership.pro.percent': String(MEMBERSHIP_MAX_PERCENT + 1) },
      { discount_mode: 'percent', percent: MEMBERSHIP_MAX_PERCENT + 1 },
    ],
  ];

  for (const [cells, body_] of overTheLine) {
    const { raw, app } = setupBoth();
    // The panel refuses it…
    const viaDoor = await adminRule(app, body_);
    assert.equal(viaDoor.status, 400, `the admin door accepted ${JSON.stringify(body_)}`);

    // …so the sheet must refuse it too, in the preview, before any write.
    const prev = await preview(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('OVER-1'), ...cells }));
    assert.equal(prev.summary.failed, 1, `the sheet accepted ${JSON.stringify(cells)}`);
    assert.ok(prev.rows[0].errors.length > 0);
    await confirm(app, prev.import_id);
    assert.equal(rules(raw).length, 0, `${JSON.stringify(cells)} reached the database from a spreadsheet`);
  }
});

test('and the value ON the boundary is accepted by both, stored as a whole number', async () => {
  const { raw, app } = setupBoth();
  await importSheet(
    app,
    sheet([...HEAD, ...MEMBERSHIP_COLUMNS], {
      ...productCells('EDGE-1'),
      'membership.pro.discount_mode': 'fixed',
      'membership.pro.fixed_iqd': String(MEMBERSHIP_MAX_IQD),
      'membership.pro.max_quantity': String(MEMBERSHIP_MAX_QUANTITY),
      'membership.premium.discount_mode': 'percent',
      'membership.premium.percent': String(MEMBERSHIP_MAX_PERCENT),
    })
  );
  const stored = rules(raw);
  assert.equal(stored.length, 2, JSON.stringify(stored));
  const pro = stored.find((r) => r.tier === 'pro')!;
  assert.equal(pro.fixed_iqd, MEMBERSHIP_MAX_IQD);
  assert.equal(pro.max_quantity, MEMBERSHIP_MAX_QUANTITY);
  assert.equal(stored.find((r) => r.tier === 'prime')!.percent, MEMBERSHIP_MAX_PERCENT);

  // A dinar column that holds a REAL is a price that no longer adds up: a
  // twenty-digit cell used to land here as 1e20 and floor every member's
  // price to zero.
  assert.deepEqual(
    all<{ t: string }>(raw, "SELECT typeof(fixed_iqd) AS t FROM membership_benefit_rules WHERE fixed_iqd IS NOT NULL"),
    [{ t: 'integer' }]
  );
});

test('__NULL__ removes EVERY override for that tier, not only the one that wins', async () => {
  const { raw, app } = setupBoth();
  await importSheet(app, sheet([...HEAD, ...MEMBERSHIP_COLUMNS], { ...productCells('TWO-1'), ...PRO_TEN_PERCENT }));
  const productId = all<{ id: string }>(raw, 'SELECT id FROM products WHERE sku = ?', 'TWO-1')[0].id;

  // A second PRO override on the same product, written from the panel exactly
  // as an owner could write it — nothing in the door forbids it.
  const second = await adminRule(app, { product_id: productId, discount_mode: 'percent', percent: 25, priority: 5 });
  assert.equal(second.status, 200, JSON.stringify(await second.json()));
  assert.equal(rules(raw).length, 2);

  await importSheet(
    app,
    sheet([...HEAD, ...MEMBERSHIP_COLUMNS], {
      ...productCells('TWO-1'),
      'membership.pro.discount_mode': MEMBERSHIP_NULL,
    })
  );
  assert.deepEqual(
    rules(raw),
    [],
    'a discount the file, the preview and the next export all call gone was still pricing every PRO order'
  );
  // Both deletions are their own versioned, audited write.
  assert.equal(
    all<{ action: string }>(raw, 'SELECT action FROM membership_benefit_versions ORDER BY id DESC LIMIT 2').filter(
      (v) => v.action === 'delete'
    ).length,
    2
  );
});

test('a repeated membership key is ONE complaint, not also an "unknown key"', async () => {
  const raw = freshDb();
  const app = txtApp(asD1(raw));
  // The lines are lifted out of the text before `parseTemplate` runs. A
  // duplicate that was left behind reached the product parser, which knows
  // nothing about benefit rules, and the owner was told the same line was both
  // a duplicate AND an unknown key — two complaints, one of them wrong.
  const res = await txtParse(app, txtWith('membership.pro.discount_mode=percent', 'membership.pro.percent=10', 'membership.pro.percent=20'));
  assert.deepEqual(res.unknown_keys, [], 'a membership key reached the product parser');
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
  assert.equal(res.errors[0].key, 'membership.pro.percent');
  assert.match(res.errors[0].message, /duplicate key/);
  // And the first value stands, so the preview describes the rule the apply
  // would write — if the file were not refused for the duplicate.
  assert.equal(res.membership[0].percent, 10);
});
