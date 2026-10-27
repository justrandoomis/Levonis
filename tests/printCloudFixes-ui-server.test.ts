/**
 * LEVONIS PRINT CLOUD — the server findings of the interface review, each
 * closed and proven here:
 *
 *   u1  GET /reconcile handed a stock lot's `drawn_cost` (what the workshop
 *       paid) to money admins who may not read cost: stripped for them.
 *   u2  opening or closing the service (`enabled`) was owner-only in the
 *       console alone: the server now refuses it from anyone else.
 *   u3  a customer's job view carried the previous job's id and progress
 *       when the shared printer's reading still named it: machine fields only.
 *   u4  every notification linked to a /print-cloud/... path no app serves:
 *       now the customer app's own paths, opened on cloud.<root>.
 *   u5  stock receive / adjust / waste re-sent after a lost answer moved the
 *       stock twice: keyed doors now.
 *   u6  GET /packages listed packages of a printer class switched off, which
 *       every quote then refused.
 *   u7  the projection counted hours whose expiry had come but the sweep had
 *       not yet taken: «covered», then INSUFFICIENT_CREDIT on confirm.
 *   u8  a customer could cancel a shipment whose delivery fee was paid, and
 *       the fee stayed collected without a word: refused, the workshop decides.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-ui-server.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN, API, buy, call, estimatedJob, idem, ok, owned, pcWorld, readyFile, refused, row, rows, runToPrinting, seedCatalog, type Json } from './fixtures/printCloud';
import { cloudSection } from '../src/cloud/routes';
import { shipmentCancellable } from '../src/cloud/pages/account/logic';

const H = 3600;
const ROOT = join(import.meta.dirname, '..');
const ADDRESS = {
  recipient_name: 'Ali',
  phone: '07700000000',
  governorate: 'baghdad',
  city: 'Baghdad',
  address_line: 'Karrada, street 62',
};

// ============================================================ u1

test('u1: a stock lot that does not add up is reported to every money admin, its cost to the owner alone', async () => {
  const w = pcWorld();
  await seedCatalog(w);
  // One unit gone from a lot with no draw to account for it.
  w.raw.prepare('UPDATE pc_stock_lots SET on_hand_qty = on_hand_qty - 1 WHERE id = (SELECT id FROM pc_stock_lots ORDER BY id LIMIT 1)').run();
  const lots = (r: Json) => r.checks.find((c: Json) => c.name === 'stock_lots_equal_their_draws');
  const owner = lots(await ok(w.owner, 'GET', `${ADMIN}/reconcile`));
  assert.equal(owner.ok, false);
  assert.ok('drawn_cost' in owner.issues[0], 'the owner reads the cost evidence');
  await refused(w.full, 'GET', `${ADMIN}/stock/lots`, undefined, 'COST_ACCESS_DENIED');
  const full = lots(await ok(w.full, 'GET', `${ADMIN}/reconcile`));
  assert.equal(full.ok, false, 'the check still fails for the money admin');
  assert.equal(full.issues.length, owner.issues.length);
  for (const issue of full.issues) assert.ok(!('drawn_cost' in issue), 'never the cost');
  assert.equal(full.issues[0].lot_id, owner.issues[0].lot_id);
});

// ============================================================ u2

test('u2: only the owner opens or closes the service; a full admin still edits the rest', async () => {
  const w = pcWorld();
  const v = async () => (await ok(w.owner, 'GET', `${ADMIN}/settings`)).version;
  const denied = await refused(w.full, 'PATCH', `${ADMIN}/settings`, { version: await v(), config: { enabled: true } }, 'FORBIDDEN');
  assert.equal(denied.details.field, 'enabled');
  assert.equal(denied.details.reason, 'owner_only');
  assert.equal((await ok(w.owner, 'GET', `${ADMIN}/settings`)).config.enabled, false, 'still closed');
  await ok(w.full, 'PATCH', `${ADMIN}/settings`, {
    version: await v(),
    config: { quote_ttl_minutes: 45 },
  });
  const opened = await ok(w.owner, 'PATCH', `${ADMIN}/settings`, {
    version: await v(),
    config: { enabled: true },
  });
  assert.equal(opened.config.enabled, true);
});

// ============================================================ u3

test('u3: a reading that names another job leaves only the machine’s own state in this job’s view', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 500 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, {
    seconds: H,
    materials: [{ variant_id: cat.white, model_grams: 30 }],
  });
  await runToPrinting(w, w.a, jobId);
  const printerId = String(row(w, "SELECT printer_id FROM pc_printer_assignments WHERE job_id = ? AND state = 'active'", jobId)?.printer_id);
  const now = new Date().toISOString();
  const write = (job: string) =>
    w.raw
      .prepare(
        `INSERT OR REPLACE INTO pc_printer_telemetry (printer_id, boot, seq, received_at, arrived_at, machine_state, job_id, progress_permille, layer, total_layers, remaining_seconds, nozzle_temp_dc, bed_temp_dc)
         VALUES (?, 1, 1, ?, ?, 'finished', ?, 1000, 330, 330, 0, 2150, 600)`
      )
      .run(printerId, now, now, job);
  write('pcj_someone_else');
  const t = (await ok(w.a, 'GET', `${API}/jobs/${jobId}`)).telemetry;
  assert.equal(t.machine_state, 'finished');
  assert.equal(t.nozzle_temp_dc, 2150);
  for (const k of ['job_id', 'progress_permille', 'layer', 'total_layers', 'remaining_seconds']) assert.equal(t[k], null, `${k} of another job never travels`);
  assert.equal(t.live, false);
  write(jobId);
  const mine = (await ok(w.a, 'GET', `${API}/jobs/${jobId}`)).telemetry;
  assert.equal(mine.job_id, jobId);
  assert.equal(mine.progress_permille, 1000);
  assert.equal(mine.live, true);
});

// ============================================================ u4

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []));
}

test('u4: every Print Cloud notification links to a page the customer app serves, and the bell opens it on that host', async () => {
  const sources = [...walk(join(ROOT, 'worker/lib/printCloud')), join(ROOT, 'worker/routes/printCloudAdmin.ts')];
  const links: string[] = [];
  for (const f of sources) for (const m of readFileSync(f, 'utf8').matchAll(/\blink: ['`](\/[^'`$]*)/g)) links.push(m[1]);
  assert.ok(links.length >= 7, `found ${links.length} links`);
  for (const l of links) assert.ok(cloudSection(l), `${l} is a page of the cloud app`);
  assert.doesNotMatch(sources.map((f) => readFileSync(f, 'utf8')).join('\n'), /link: ['`]\/print-cloud\//);

  const w = pcWorld();
  const cat = await seedCatalog(w);
  const orderId = await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  const notes = rows(w, "SELECT link FROM user_notifications WHERE user_id = 'usr_pc_a' AND kind = 'print_cloud'");
  assert.ok(
    notes.some((n) => n.link === `/orders/${orderId}`),
    JSON.stringify(notes)
  );

  const bell = readFileSync(join(ROOT, 'src/components/notifications/NotificationBell.tsx'), 'utf8');
  assert.match(bell, /n\.kind === 'print_cloud' \? appReturnUrl\('cloud', mainSite, n\.link\)/);
});

// ============================================================ u5

test('u5: a stock receipt, correction or write-off re-sent with its key moves the stock once; no key is refused', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const onHand = () => Number(row(w, 'SELECT on_hand_qty FROM pc_stock_positions WHERE variant_id = ?', cat.white)?.on_hand_qty);
  const lotsOf = () => Number(row(w, 'SELECT COUNT(*) AS n FROM pc_stock_lots WHERE variant_id = ?', cat.white)?.n);
  const start = onHand();
  const lotsBefore = lotsOf();
  await refused(w.assistant, 'POST', `${ADMIN}/stock/receive`, { variant_id: cat.white, qty: 5000 }, 'IDEMPOTENCY_KEY_REQUIRED');
  const key = idem('receive');
  const first = await ok(w.assistant, 'POST', `${ADMIN}/stock/receive`, { variant_id: cat.white, qty: 5000 }, key);
  const again = await ok(w.assistant, 'POST', `${ADMIN}/stock/receive`, { variant_id: cat.white, qty: 5000 }, key);
  assert.equal(again.lot_id, first.lot_id);
  assert.equal(again.replayed, true);
  assert.equal(onHand(), start + 5000);
  assert.equal(lotsOf(), lotsBefore + 1);
  await refused(w.assistant, 'POST', `${ADMIN}/stock/receive`, { variant_id: cat.white, qty: 6000 }, 'IDEMPOTENCY_KEY_REUSED', key);

  const adj = idem('adjust');
  await ok(w.assistant, 'POST', `${ADMIN}/stock/adjust`, { variant_id: cat.white, qty_delta: -10, reason: 'recount' }, adj);
  await ok(w.assistant, 'POST', `${ADMIN}/stock/adjust`, { variant_id: cat.white, qty_delta: -10, reason: 'recount' }, adj);
  assert.equal(onHand(), start + 4990);
  const waste = idem('waste');
  await ok(w.assistant, 'POST', `${ADMIN}/stock/waste`, { variant_id: cat.white, qty: 40, reason: 'tangled' }, waste);
  assert.equal((await ok(w.assistant, 'POST', `${ADMIN}/stock/waste`, { variant_id: cat.white, qty: 40, reason: 'tangled' }, waste)).replayed, true);
  assert.equal(onHand(), start + 4950);
});

// ============================================================ u6

test('u6: a printer class switched off takes its packages off the shelf', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const listed = async () => (await ok(w.a, 'GET', `${API}/packages`)) as Json[];
  assert.ok((await listed()).some((p) => p.tier_id === cat.tier));
  w.raw.prepare('UPDATE pc_credit_tiers SET active = 0 WHERE id = ?').run(cat.tier);
  assert.ok(!(await listed()).some((p) => p.tier_id === cat.tier), 'none of its packages offered');
  assert.deepEqual(await listed(), []);
});

// ============================================================ u7

test('u7: hours whose expiry has come are not «covered», even before the sweep takes them', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 500 },
  ]);
  const { jobId } = await estimatedJob(w, w.a, cat, {
    seconds: H,
    materials: [{ variant_id: cat.white, model_grams: 30 }],
  });
  const before = await ok(w.a, 'GET', `${API}/jobs/${jobId}/projection`);
  assert.equal(before.credits.sufficient, true);
  // The lot expired an instant ago; the sweep has not run (the cached balance still counts it).
  w.raw.prepare("UPDATE pc_credit_lots SET created_at = '2020-01-01T00:00:00.000Z', expires_at = ? WHERE account_id LIKE '%usr_pc_a%'").run(new Date(Date.now() - 1000).toISOString());
  assert.ok(Number(row(w, "SELECT available_seconds FROM pc_credit_accounts WHERE user_id = 'usr_pc_a'")?.available_seconds) >= H, 'unswept');
  const after = await ok(w.a, 'GET', `${API}/jobs/${jobId}/projection`);
  assert.equal(after.credits.available_seconds, 0);
  assert.equal(after.credits.sufficient, false);
  assert.equal(after.sufficient, false);
  const review = await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal(review.credits.sufficient, false, 'the review says what confirming will do');
  await refused(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, 'INSUFFICIENT_CREDIT', idem('confirm'));
});

// ============================================================ u8

test('u8: a delivery whose fee is paid is not the customer’s to cancel; an unpaid one and a pickup still are', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const ship = await ok(
    w.a,
    'POST',
    `${API}/shipments`,
    {
      kind: 'delivery',
      items: [{ variant_id: cat.white, qty: 200 }],
      payment_method: 'dev',
      delivery_address: ADDRESS,
    },
    idem('ship')
  );
  assert.equal(ship.fee_iqd, 5000);
  assert.equal((await ok(w.a, 'POST', `${API}/orders/${ship.fee_order_id}/dev-pay`, {})).outcome, 'applied');
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', ship.shipment_id)?.status, 'preparing');
  const no = await call(w.a, 'POST', `${API}/shipments/${ship.shipment_id}/cancel`);
  assert.equal(no.status, 409);
  assert.equal(no.json.code, 'INVALID_TRANSITION');
  assert.equal(no.json.details.reason, 'delivery_fee_paid');
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', ship.shipment_id)?.status, 'preparing', 'still on its way');
  assert.equal((await owned(w.a, cat.white)).reserved_qty, 200, 'its material still held for it');
  // The workshop may still cancel it (and decides the fee's refund).
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${ship.shipment_id}/advance`, { to: 'cancelled' });

  // A pickup (no fee) in preparation is still the customer's to cancel.
  const pickup = await ok(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', items: [{ variant_id: cat.white, qty: 100 }] }, idem('pickup'));
  assert.equal(pickup.status, 'preparing');
  await ok(w.a, 'POST', `${API}/shipments/${pickup.shipment_id}/cancel`);

  // The app offers exactly what the server allows.
  assert.equal(shipmentCancellable('awaiting_payment', 5000), true);
  assert.equal(shipmentCancellable('preparing', 0), true);
  assert.equal(shipmentCancellable('preparing', 5000), false);
  assert.equal(shipmentCancellable('shipped', 0), false);
});

// ============================================================ u9 — the admin console

test('u9: the admin job view carries the job’s own variants before its first estimate, so an operator can enter one by hand', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const fileId = await readyFile(w, w.a);
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: 'Dragon', project_type: 'figure' });
  await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: fileId, quantity: 1, material_assignments: [{ part: 'default', variant_id: cat.white }] });
  const job = await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, title: 'Dragon' });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  const view = await ok(w.assistant, 'GET', `${ADMIN}/jobs/${job.job_id}`);
  assert.equal(view.requirements.filter((r: Json) => r.kind === 'filament').length, 0, 'no filament line before the first estimate');
  assert.deepEqual(
    view.slicing.variants.map((v: Json) => v.variant_id),
    [cat.white]
  );
  assert.equal(view.slicing.models[0].file_id, fileId);
  // The estimate the console now seeds is accepted.
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${job.job_id}/estimate`, { duration_seconds: H, materials: [{ variant_id: cat.white, model_grams: 30, support_grams: 0, purge_grams: 0 }] });
  // The customer's own view never carries it.
  assert.equal((await ok(w.a, 'GET', `${API}/jobs/${job.job_id}`)).slicing, undefined);
});

const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('u9: the console — refund rail from the confirmed payment, a failure’s figures never pre-filled, arrows and units in the reader’s language', () => {
  const orders = src('src/components/adminPrintCloud/sections/OrdersSection.tsx');
  assert.match(
    orders,
    /const wallet =\s+o\.status === 'awaiting_payment' \? o\.payment_method === 'levonis_wallet' : o\.payments\.some\(\(p\) => p\.provider === 'levonis_wallet' && p\.status === 'confirmed'\);/
  );
  const sheet = src('src/components/adminPrintCloud/sections/jobs/JobSheet.tsx');
  assert.match(sheet, /useState<number \| null>\(null\);\n\s*const \[failLines, setFailLines\] = useState<MatLine\[\]>\(\[\]\)/, 'the failure form starts empty');
  assert.match(sheet, /printed_seconds: failSeconds,\n\s*failed_materials: cleanLines\(failLines\)/);
  assert.match(sheet, /disabled=\{!reasonCode\.trim\(\) \|\| failSeconds === null\}/);
  assert.match(sheet, /<SelectField label=\{t\(S\.responsible\)\}/);
  for (const f of walk(join(ROOT, 'src/components/adminPrintCloud'))) {
    const code = readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && !/tri\(/.test(l) && !/^\s*'.*',?$/.test(l))
      .join('\n');
    assert.doesNotMatch(code, / → /, `${f}: a bare → points backwards in ar/ckb — arrow(lang)`);
    assert.doesNotMatch(code, /\} (IQD|µm|B|MB|g|s)</, `${f}: an English unit beside a figure`);
  }
  assert.doesNotMatch(src('src/components/adminPrintCloud/sections/catalog/fieldInputs.tsx'), /<bdi dir="ltr">= \{duration/);
});
