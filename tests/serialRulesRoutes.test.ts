/**
 * /api/admin/serial-rules — THE OWNER'S SERIAL FORMATS (owner decision 2,
 * 2026-10-09; migration 0180; worker/routes/adminSerialRules.ts).
 *
 *   READ  every admin who writes serials (the scan sheet and the inventory
 *         camera need the rules) — never a cost, so `op`;
 *   WRITE the owner alone: every other admin is refused 403 OWNER_ONLY with
 *         no row changed and no audit row; the owner's write lands WITH its
 *         audit row in one batch; a stale version is 409 and writes neither;
 *         an invalid rule is 400 with the field to fix;
 *   BEFORE 0180 the reads say `installed: false` and every serial door keeps
 *         today's rule; the writes say 503.
 *
 * Run: node --import tsx --test tests/serialRulesRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, count, failingD1, get, json, post, put, row, stubApp, type StubUser } from './fixtures/app';
import { BEFORE_RULES, USERS, world } from './fixtures/serialPrep';
import { adminSerialRulesRoutes } from '../worker/routes/adminSerialRules';
import { ruleForProduct } from '../worker/lib/serialRules';

const BASE = '/api/admin/serial-rules';
const MERCHANT: StubUser = { id: 'm1', role: 'merchant', email: 'm1@x.co' };

/** The serial world (Bambu Lab bound) plus Snapmaker, Creality and a printer with no brand. */
function rulesWorld(opts: { through?: string; bindSnapmaker?: boolean } = {}) {
  const w = world(opts.through ? { through: opts.through } : {});
  w.raw.exec(`
    INSERT INTO brands (id, slug, name_ar, name_en, name_ckb) VALUES
      ('brd_snap','snapmaker','سنابميكر','Snapmaker','سناپمەیکەر'), ('brd_crea','creality','كريالتي','Creality','کریالیتی');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,ops_policy,brand_id) VALUES
      ('pU1','sp-u1','Snapmaker U1','سنابميكر U1',1500000,'{}','brd_snap'),
      ('pK1C','sp-k1c','Creality K1C','كريالتي K1C',900000,'{}','brd_crea'),
      ('pNB','sp-nb','Mystery Printer X9','طابعة X9',500000,'{}',NULL);
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('pU1','ct_print',3), ('pK1C','ct_print',4), ('pNB','ct_print',5);
  `);
  if (opts.bindSnapmaker !== false && !opts.through) w.raw.exec("UPDATE serial_brand_rules SET brand_id = 'brd_snap' WHERE id = 'sbr_snapmaker'");
  return w;
}

const appFor = (db: unknown, user: StubUser | null) => stubApp(db, user, (a) => a.route(BASE, adminSerialRulesRoutes));
const rulesSnapshot = (raw: DatabaseSync) => JSON.stringify(all(raw, 'SELECT * FROM serial_brand_rules ORDER BY id'));
const ruleAudits = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'serial_rule.%'");

/** A valid full rule body (what the screen sends). */
const bambuBody = (over: Record<string, unknown> = {}) => ({
  label: 'Bambu Lab',
  mode: 'warn',
  charset: 'ALNUM',
  min_len: 15,
  max_len: 18,
  lengths: [15, 18],
  prefixes: [{ p: '039', m: 'A1' }, { p: '00M', m: 'X1C', a: ['X1 Carbon'] }],
  prefix_policy: 'hint',
  positions: [],
  box_sn_shape: 'bambu',
  family_check: true,
  source_note: 'wiki.bambulab.com/en/general/find-sn',
  ...over,
});

test('every admin READS the rules: the seeds, the brands with their serialized products, and the products that need a serial but have no brand', async () => {
  const w = rulesWorld();
  for (const who of ['ast', 'adm', 'boss'] as const) {
    const res = await get(appFor(w.db, USERS[who]), BASE);
    assert.equal(res.status, 200, who);
    const b = await json(res);
    assert.equal(b.installed, true);
    assert.equal(b.can_edit, who === 'boss', `${who}: only the owner edits`);
    const ids = b.rules.map((r: { id: string }) => r.id).sort();
    assert.deepEqual(ids, ['sbr_bambu_lab', 'sbr_snapmaker']);
    const bambu = b.rules.find((r: { id: string }) => r.id === 'sbr_bambu_lab');
    assert.equal(bambu.brand_id, 'brd_bambu');
    assert.equal(bambu.bound, true);
    assert.equal(bambu.box_sn_shape, 'bambu');
    const counts = Object.fromEntries(b.brands.map((x: { id: string; serialized_products: number }) => [x.id, x.serialized_products]));
    assert.equal(counts.brd_bambu, 2, 'the A1 Combo and the X2D: printers need a serial; the AMS Lite does not yet');
    assert.equal(counts.brd_snap, 1);
    assert.deepEqual(b.unbranded.map((p: { id: string }) => p.id), ['pNB'], 'the owner\'s list: a printer with no brand falls to the generic rule');
    assert.equal(b.generic.id, 'generic');
  }
  const resolved = await json(await get(appFor(w.db, USERS.ast), `${BASE}/resolve?product_id=pU1`));
  assert.equal(resolved.rule.id, 'sbr_snapmaker');
  assert.equal(resolved.public.box_sn_shape, 'none');
  assert.equal((await json(await get(appFor(w.db, USERS.ast), `${BASE}/resolve?product_id=pNB`))).rule.id, 'generic');
  assert.equal((await json(await get(appFor(w.db, USERS.ast), `${BASE}/resolve?product_id=pA1`))).public.box_sn_shape, 'bambu');
});

test('every WRITE is the owner\'s: assistants, full admins, merchants, customers and strangers change nothing and leave no audit row', async () => {
  const w = rulesWorld();
  const before = rulesSnapshot(w.raw);
  const writes: Array<[string, string, unknown]> = [
    ['POST', BASE, { scope: 'brand', brand_id: 'brd_crea', label: 'Creality' }],
    ['PUT', `${BASE}/sbr_bambu_lab`, { ...bambuBody({ mode: 'enforce' }), expected_version: 1 }],
    ['POST', `${BASE}/sbr_bambu_lab/deactivate`, { expected_version: 1 }],
    ['POST', `${BASE}/dry-run`, { rule: { label: 'x' }, serials: ['03919D580607841'], brand_id: 'brd_bambu' }],
  ];
  const callers: Array<[string, StubUser | null, number, string | null]> = [
    ['assistant', USERS.ast, 403, 'OWNER_ONLY'],
    ['full admin', USERS.adm, 403, 'OWNER_ONLY'],
    ['merchant', MERCHANT, 403, null],
    ['customer', USERS.u1, 403, null],
    ['anonymous', null, 401, null],
  ];
  for (const [label, user, status, code] of callers) {
    for (const [method, path, body] of writes) {
      const app = appFor(w.db, user);
      const res = method === 'PUT' ? await put(app, path, body) : await post(app, path, body);
      assert.equal(res.status, status, `${label} ${method} ${path}`);
      if (code) assert.equal((await json(res)).code, code, `${label} ${method} ${path}`);
    }
  }
  assert.equal(rulesSnapshot(w.raw), before, 'no rule changed');
  assert.equal(ruleAudits(w.raw), 0, 'no audit row');
  // Reads are admins' only.
  assert.equal((await get(appFor(w.db, USERS.u1), BASE)).status, 403);
  assert.equal((await get(appFor(w.db, null), BASE)).status, 401);
});

test('the owner\'s save bumps the version and writes `serial_rule.update {from,to}` IN THE SAME BATCH; a stale version is 409 and writes neither', async () => {
  const w = rulesWorld();
  const { failing, db } = failingD1(w.raw);
  const owner = appFor(db, USERS.boss);
  const ok = await put(owner, `${BASE}/sbr_bambu_lab`, { ...bambuBody({ mode: 'enforce' }), expected_version: 1 });
  const body = await json(ok);
  assert.equal(ok.status, 200, JSON.stringify(body));
  assert.equal(body.rule.version, 2);
  assert.equal(body.rule.mode, 'enforce');
  // One batch: the UPDATE and its audit row together.
  const batch = failing.batches.find((b) => b.some((sql) => sql.startsWith('UPDATE serial_brand_rules')));
  assert.ok(batch, 'the update ran in a batch');
  assert.ok(batch!.some((sql) => sql.startsWith('INSERT INTO audit_log')), `the audit row is in the same batch: ${JSON.stringify(batch)}`);
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'serial_rule.update' AND target = 'sbr_bambu_lab'")!.detail);
  assert.equal(audit.from.mode, 'warn');
  assert.equal(audit.from.version, 1);
  assert.equal(audit.to.mode, 'enforce');
  assert.equal(audit.to.version, 2);
  assert.equal(audit.from.prefixes.length, 13, 'the whole rule before');
  assert.equal(audit.to.prefixes.length, 2, 'and after');
  assert.equal(row<{ updated_by: string }>(w.raw, "SELECT updated_by FROM serial_brand_rules WHERE id = 'sbr_bambu_lab'")!.updated_by, 'boss');

  // The second save of the same screen, read at version 1: refused, and the screen gets the new rule.
  const auditsBefore = ruleAudits(w.raw);
  const snapshot = rulesSnapshot(w.raw);
  const stale = await put(owner, `${BASE}/sbr_bambu_lab`, { ...bambuBody({ mode: 'off' }), expected_version: 1 });
  assert.equal(stale.status, 409);
  const staleBody = await json(stale);
  assert.equal(staleBody.code, 'SERIAL_RULE_CHANGED');
  assert.equal(staleBody.details.rule.version, 2, 'the current rule, for the reload');
  assert.equal(ruleAudits(w.raw), auditsBefore, 'no audit row for a save that did not land');
  assert.equal(rulesSnapshot(w.raw), snapshot);

  // A batch that fails writes neither the rule nor its audit.
  failing.failWhen = (stmts) => stmts.some((s) => s.sql.startsWith('UPDATE serial_brand_rules'));
  const broken = await put(owner, `${BASE}/sbr_bambu_lab`, { ...bambuBody({ mode: 'off' }), expected_version: 2 });
  assert.equal(broken.status, 500);
  assert.equal(ruleAudits(w.raw), auditsBefore);
  assert.equal(rulesSnapshot(w.raw), snapshot);
});

test('an invalid rule is 400 SERIAL_RULE_INVALID naming the field — a pattern, an unknown key, a bound broken; nothing written', async () => {
  const w = rulesWorld();
  const owner = appFor(w.db, USERS.boss);
  const before = rulesSnapshot(w.raw);
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ ...bambuBody({ prefixes: [{ p: '^0', m: 'A1' }] }), expected_version: 1 }, 'prefixes[0].p', 'PATTERN_NOT_ALLOWED'],
    [{ ...bambuBody({ regex: '^03' }), expected_version: 1 }, 'regex', 'UNKNOWN_KEY'],
    [{ ...bambuBody({ min_len: 3 }), expected_version: 1 }, 'min_len', 'OUT_OF_RANGE'],
    [{ ...bambuBody({ label: '(a+)+' }), expected_version: 1 }, 'label', 'PATTERN_NOT_ALLOWED'],
  ];
  for (const [body, field, reason] of cases) {
    const res = await put(owner, `${BASE}/sbr_bambu_lab`, body);
    assert.equal(res.status, 400, field);
    const b = await json(res);
    assert.equal(b.code, 'SERIAL_RULE_INVALID');
    assert.deepEqual(b.details, { field, reason });
    assert.ok(b.error.includes(field), 'the server sentence names the field');
  }
  const bad = await json(await post(owner, BASE, { scope: 'catalog', brand_id: 'brd_crea' }));
  assert.equal(bad.code, 'SERIAL_RULE_INVALID');
  assert.equal(bad.details.field, 'scope', "'catalog' is reserved, unused in v1");
  assert.equal(rulesSnapshot(w.raw), before);
  assert.equal(ruleAudits(w.raw), 0);
});

test('create, one active rule per brand, a product rule wins over its brand\'s, deactivation, and binding an unbound seed', async () => {
  const w = rulesWorld({ bindSnapmaker: false });
  const owner = appFor(w.db, USERS.boss);
  // The Snapmaker seed found no brand at migration time: it judges nothing.
  assert.equal((await ruleForProduct(w.db, 'pU1')).id, 'generic');
  const bind = await json(await put(owner, `${BASE}/sbr_snapmaker`, { label: 'Snapmaker', mode: 'warn', min_len: 6, max_len: 40, expected_version: 1, brand_id: 'brd_snap' }));
  assert.equal(bind.rule.brand_id, 'brd_snap');
  assert.equal((await ruleForProduct(w.db, 'pU1')).id, 'sbr_snapmaker', 'one tap binds it');
  assert.equal((await json(await put(owner, `${BASE}/sbr_snapmaker`, { label: 'Snapmaker', expected_version: 2, brand_id: 'brd_nope' }))).code, 'SERIAL_RULE_TARGET_UNKNOWN');

  // Creality: a rule added WITHOUT a rebuild (owner decision 2).
  assert.equal((await ruleForProduct(w.db, 'pK1C')).id, 'generic');
  const made = await post(owner, BASE, { scope: 'brand', brand_id: 'brd_crea', label: 'Creality', mode: 'warn', min_len: 10, max_len: 30 });
  const madeBody = await json(made);
  assert.equal(made.status, 200, JSON.stringify(madeBody));
  const crea = await ruleForProduct(w.db, 'pK1C');
  assert.equal(crea.id, madeBody.rule.id);
  assert.equal(crea.min_len, 10);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial_rule.create' AND target = ?", madeBody.rule.id), 1);
  const twice = await post(owner, BASE, { scope: 'brand', brand_id: 'brd_crea', label: 'Creality again' });
  assert.equal(twice.status, 409);
  assert.equal((await json(twice)).code, 'SERIAL_RULE_EXISTS');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM serial_brand_rules WHERE brand_id = 'brd_crea'"), 1, 'the refused insert left nothing');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial_rule.create'"), 1, '…and no audit row');
  assert.equal((await json(await post(owner, BASE, { scope: 'brand', brand_id: 'brd_gone', label: 'x' }))).code, 'SERIAL_RULE_TARGET_UNKNOWN');

  // A product rule (the U1 once the owner has read its label) beats the brand's.
  const u1 = await json(await post(owner, BASE, { scope: 'product', product_id: 'pU1', label: 'U1 label', lengths: [20], mode: 'warn' }));
  assert.equal((await ruleForProduct(w.db, 'pU1')).id, u1.rule.id);
  assert.equal((await json(await get(appFor(w.db, USERS.ast), `${BASE}/resolve?product_id=pU1`))).rule.scope, 'product');

  // Deactivation: soft, audited, and the brand's rule judges the product again.
  const off = await json(await post(owner, `${BASE}/${u1.rule.id}/deactivate`, { expected_version: 1 }));
  assert.equal(off.rule.active, false);
  assert.equal((await ruleForProduct(w.db, 'pU1')).id, 'sbr_snapmaker');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial_rule.deactivate' AND target = ?", u1.rule.id), 1);
  assert.equal((await json(await post(owner, `${BASE}/${u1.rule.id}/deactivate`, {}))).already, true, 'twice is the same answer');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'serial_rule.deactivate'"), 1);
  // …and a second product rule may then be made (one ACTIVE per product).
  assert.equal((await post(owner, BASE, { scope: 'product', product_id: 'pU1', label: 'U1 v2' })).status, 200);
  assert.equal((await json(await put(owner, `${BASE}/sbr_nope`, { label: 'x', expected_version: 1 }))).code, 'SERIAL_RULE_NOT_FOUND');
});

test('the dry run: a verdict per serial and the impact on that brand\'s inventory — read-only', async () => {
  const w = rulesWorld();
  w.raw.exec(`
    INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, created_by) VALUES
      ('03919D580607841','03919D580607841','pA1','boss'), ('03919D5806078419','03919D5806078419','pA1','boss'), ('ZZZ19D580607841','ZZZ19D580607841','pX2D','boss');
  `);
  const before = rulesSnapshot(w.raw);
  const res = await post(appFor(w.db, USERS.boss), `${BASE}/dry-run`, {
    rule: bambuBody({ mode: 'enforce', prefix_policy: 'known_only' }),
    serials: ['03919D580607841', 'B07119G5811000AB', '6977252425445', '0391'],
    brand_id: 'brd_bambu',
  });
  const b = await json(res);
  assert.equal(res.status, 200, JSON.stringify(b));
  assert.deepEqual(
    b.verdicts.map((v: { problem: string | null; refuse: unknown[]; warnings: unknown[] }) => [v.problem, v.refuse.length, v.warnings.length]),
    [[null, 0, 0], [null, 1, 0], ['SERIAL_LOOKS_LIKE_EAN', 0, 0], ['SERIAL_TOO_SHORT', 0, 0]]
  );
  assert.equal(b.verdicts[0].family, 'A1');
  assert.deepEqual({ ...b.impact, by_code: undefined }, { checked: 3, ok: 1, warn: 0, refuse: 2, capped: false, by_code: undefined });
  assert.equal(b.impact.by_code.LENGTH_UNEXPECTED, 1);
  assert.equal(b.impact.by_code.PREFIX_UNKNOWN, 1);
  assert.equal(rulesSnapshot(w.raw), before, 'nothing saved');
  assert.equal((await json(await post(appFor(w.db, USERS.boss), `${BASE}/dry-run`, { rule: { label: '^x' } }))).code, 'SERIAL_RULE_INVALID');
  const tooMany = await post(appFor(w.db, USERS.boss), `${BASE}/dry-run`, { rule: {}, serials: Array.from({ length: 1001 }, (_, i) => `SN${i}AAAAAA`) });
  assert.equal(tooMany.status, 400);
});

test('DEPLOY-AHEAD: before 0180 the reads say installed:false (the owner\'s lists still work), every product keeps today\'s rule, the writes are 503', async () => {
  const w = rulesWorld({ through: BEFORE_RULES });
  const b = await json(await get(appFor(w.db, USERS.ast), BASE));
  assert.equal(b.installed, false);
  assert.deepEqual(b.rules, []);
  assert.deepEqual(b.unbranded.map((p: { id: string }) => p.id), ['pNB'], 'the brand list reads no new table');
  const resolved = await json(await get(appFor(w.db, USERS.ast), `${BASE}/resolve?product_id=pU1`));
  assert.equal(resolved.installed, false);
  assert.equal(resolved.rule.id, 'legacy', "today's rule — the Bambu box refusal for every product");
  assert.equal(resolved.public.box_sn_shape, 'bambu');
  const owner = appFor(w.db, USERS.boss);
  for (const res of [
    await post(owner, BASE, { scope: 'brand', brand_id: 'brd_crea', label: 'Creality' }),
    await put(owner, `${BASE}/sbr_bambu_lab`, { ...bambuBody(), expected_version: 1 }),
    await post(owner, `${BASE}/sbr_bambu_lab/deactivate`, {}),
  ]) {
    assert.equal(res.status, 503);
    assert.equal((await json(res)).code, 'SERIAL_RULES_NOT_INSTALLED');
  }
  // The non-owner is still refused FIRST, before the database is asked anything.
  assert.equal((await json(await post(appFor(w.db, USERS.ast), BASE, {}))).code, 'OWNER_ONLY');
});
