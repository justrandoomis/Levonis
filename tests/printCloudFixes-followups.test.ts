/**
 * LEVONIS PRINT CLOUD — the second round: what the independent verifiers of
 * the review fixes found still open, each pinned.
 *
 *   files      a failed print whose failure is still undecided keeps its model
 *              file: the reprint may need it.
 *   scheduler  releasing a stranded job asks for room sized to its
 *              reservations, so a bounded run never overshoots its share.
 *   telemetry  a reading's age is measured on the agent's one clock
 *              (sent_at - reported_at), and «back from silence» by arrivals:
 *              a slow agent clock is live, a buffered flush is one outage.
 *   credits    a confirmation after a lot's expiry cannot shield the expired
 *              seconds (round 3: it holds only good hours rather than
 *              expiring them first); the expiry page skips lots wholly held
 *              for jobs; a conversion's extra groups never collide with
 *              another key.
 *   orders     a shipment whose fee order already closed unpaid can still be
 *              cancelled; a receipt already applied, re-entered with a typo,
 *              is that receipt again — never money on the refund desk.
 *   catalogue  registering a machine needs money scope.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-followups.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  AGENT,
  API,
  buy,
  call,
  credits,
  estimatedJob,
  idem,
  ok,
  owned,
  pcWorld,
  reading,
  readyFile,
  reconcileClean,
  refused,
  row,
  rows,
  runToPrinting,
  seedCatalog,
  type Catalog,
  type Json,
  type World,
} from './fixtures/printCloud';
import { PRINT_CLOUD_TASK_OVERHEAD, PRINT_CLOUD_UNIT_STATEMENTS, roomWithin, runPrintCloudTasks } from '../worker/lib/printCloud/background';
import { expiredLots } from '../worker/lib/printCloud/credits';
import { enqueueTask } from '../worker/lib/printCloud/tasks';
import { countingD1 } from '../worker/lib/d1Count';

const H = 3600;
const PAST = '2000-01-01T00:00:00.000Z';
const ADDRESS = { recipient_name: 'Ali', phone: '07700000000', governorate: 'baghdad', city: 'Baghdad', address_line: 'Karrada, street 62' };
const status = (w: World, jobId: string) => row(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status;

// ------------------------------------------------------------------ files

test('a failed print whose failure is undecided keeps its model file; once decided without a reprint the file may go', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const fileId = await readyFile(w, w.a);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], fileId });
  await runToPrinting(w, w.a, jobId);
  const fail = await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/fail`, { reason_code: 'NOZZLE_CLOG', responsible: 'workshop', printed_seconds: 600 });
  await refused(w.a, 'DELETE', `${API}/files/${fileId}`, undefined, 'INVALID_TRANSITION');
  assert.ok(w.bucket.objects.size > 0, 'the bytes are still there');
  await ok(w.assistant, 'POST', `${ADMIN}/failures/${fail.failure_id}/resolve`, { responsible: 'workshop', reprint: false });
  await ok(w.a, 'DELETE', `${API}/files/${fileId}`);
});

// ------------------------------------------------------------------ scheduler

/** A queued job of three colours and two accessories (one credit and five material reservations), waiting for `dependsOn`. */
async function wideJobAfter(w: World, cat: Catalog, dependsOn: string): Promise<string> {
  const fileId = await readyFile(w, w.a);
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: 'Lid', project_type: 'figure' });
  await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, {
    file_id: fileId,
    quantity: 1,
    material_assignments: [
      { part: 'default', variant_id: cat.white },
      { part: 'band', variant_id: cat.black },
      { part: 'logo', variant_id: cat.red },
    ],
  });
  const job = await ok(w.a, 'POST', `${API}/jobs`, {
    project_id: project.project_id,
    printer_model_id: cat.model,
    title: 'Lid',
    depends_on_job_id: dependsOn,
    accessories: [
      { variant_id: cat.magnets, qty: 2 },
      { variant_id: cat.rings, qty: 1 },
    ],
  });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${job.job_id}/estimate`, {
    duration_seconds: H,
    materials: [
      { variant_id: cat.white, model_grams: 20 },
      { variant_id: cat.black, model_grams: 5 },
      { variant_id: cat.red, model_grams: 5 },
    ],
    slicer_name: 'OrcaSlicer',
  });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/confirm`, undefined, idem('confirm'))).status, 'queued');
  return job.job_id;
}

test('releasing a stranded job asks for room sized to its reservations: a run never spends more than it was given', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false });
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h24 },
    { kind: 'material', variant_id: cat.white, quantity: 500 },
    { kind: 'material', variant_id: cat.black, quantity: 250 },
    { kind: 'material', variant_id: cat.red, quantity: 250 },
    { kind: 'material', variant_id: cat.magnets, quantity: 20 },
    { kind: 'material', variant_id: cat.rings, quantity: 10 },
  ]);
  const { jobId: head } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Cap' });
  await ok(w.a, 'POST', `${API}/jobs/${head}/review`);
  await ok(w.a, 'POST', `${API}/jobs/${head}/confirm`, undefined, idem('confirm'));
  const wide = await wideJobAfter(w, cat, head);
  await ok(w.a, 'POST', `${API}/jobs/${head}/cancel`, { reason: 'changed my mind' });
  await w.runTasks();
  assert.equal(Number(row(w, "SELECT COUNT(*) AS n FROM pc_inventory_reservations WHERE ref_id = ? AND state = 'active'", wide)?.n), 5);

  const counted = countingD1(w.db);
  const env = { DB: counted.db, BUCKET: w.bucket, R2_PRIVATE: w.bucket } as never;
  const pass = async (budget: number) => {
    await w.db.batch([enqueueTask(w.db, { kind: 'schedule_queue', dedupeKey: `sched-${budget}`, now: new Date() })]);
    const before = counted.executed;
    await runPrintCloudTasks(env, { limit: 1, room: roomWithin(() => counted.executed, budget) });
    return counted.executed - before;
  };
  // Exactly what a task needs to start: the release does not fit, so it waits — nothing overshoots.
  const tight = PRINT_CLOUD_TASK_OVERHEAD + PRINT_CLOUD_UNIT_STATEMENTS;
  const spentTight = await pass(tight);
  assert.ok(spentTight <= tight, `a tight run spent ${spentTight} of ${tight}`);
  assert.equal(status(w, wide), 'queued', 'the release waits for room');
  // A whole share: released, every reservation back, still inside the share.
  const spentFull = await pass(120);
  assert.ok(spentFull <= 120, `a full run spent ${spentFull} of 120`);
  assert.equal(status(w, wide), 'cancelled');
  assert.equal(Number(row(w, "SELECT COUNT(*) AS n FROM pc_inventory_reservations WHERE ref_id = ? AND state = 'active'", wide)?.n), 0);
  assert.equal((await owned(w.a, cat.magnets)).reserved_qty, 0);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ telemetry

async function agentPrinter(w: World, cat: Catalog) {
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Bay 1', capabilities: ['telemetry'] });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: 'lan-1' });
  const bearer = { Authorization: `Bearer ${agent.token}` };
  const send = (body: Json) => ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, reading(body), bearer);
  const live = async () => (await ok(w.assistant, 'GET', `${ADMIN}/printers`)).find((p: Json) => p.id === cat.printers[0]);
  const restored = () => rows(w, "SELECT id FROM pc_printer_events WHERE printer_id = ? AND kind = 'connection_restored'", cat.printers[0]).length;
  return { send, live, restored };
}

const at = (secondsFromNow: number) => new Date(Date.now() + secondsFromNow * 1000).toISOString();

test('an agent whose clock runs ten minutes slow is live when it says when it sent each reading, and reconnecting after silence is one event', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a = await agentPrinter(w, cat);
  // The agent clock is 600 s behind: both of its stamps are, so the reading's age (sent - reported) is 2 s.
  await a.send({ machine_state: 'idle', reported_at: at(-602), sent_at: at(-600) });
  const first = await a.live();
  assert.equal(first.connectivity, 'online', JSON.stringify(first));
  await a.send({ machine_state: 'idle', reported_at: at(-598), sent_at: at(-597) });
  assert.equal(a.restored(), 0, 'a steady connection is never «restored»');
  // An hour of silence: the stored reading's arrival is moved back an hour, as if nothing came since.
  w.raw.prepare('UPDATE pc_printer_telemetry SET arrived_at = ?, received_at = ? WHERE printer_id = ?').run(at(-3600), at(-3600), cat.printers[0]);
  // Reconnection flushes five buffered readings (50 to 10 minutes old by the agent clock), next in its sequence, then a live one.
  for (const minutes of [50, 40, 30, 20, 10]) await a.send({ machine_state: 'idle', reported_at: at(-600 - minutes * 60), sent_at: at(-600) });
  await a.send({ machine_state: 'idle', reported_at: at(-601), sent_at: at(-600) });
  assert.equal(a.restored(), 1, 'one outage, one event');
  assert.equal((await a.live()).connectivity, 'online');
});

test('a buffered reading is as old as it was when sent, whatever the agent clock says: it is stale, never live', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a = await agentPrinter(w, cat);
  // Clock 2 h fast; the reading was taken an hour before it was sent.
  await a.send({ machine_state: 'idle', reported_at: at(7200 - 3600), sent_at: at(7200) });
  assert.equal((await a.live()).connectivity, 'offline', 'stale: an hour old on arrival');
});

// ------------------------------------------------------------------ credits

async function expiringPackage(w: World, cat: Catalog): Promise<string> {
  const pkg = await ok(w.owner, 'POST', `${ADMIN}/catalog/packages`, {
    tier_id: cat.tier,
    code: 'x2d-6h-30d',
    name_en: '6 hours, 30 days',
    name_ar: '6 ساعات لمدة 30 يوماً',
    name_ckb: '6 کاتژمێر بۆ 30 ڕۆژ',
    seconds: 6 * H,
    price_iqd: 9000,
    expires_after_days: 30,
  });
  return pkg.id as string;
}

test('a job confirmed after a lot expired cannot shield it: the confirmation holds only good hours, and the sweep takes the expired lot whole', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }]);
  w.raw.prepare("UPDATE pc_credit_lots SET expires_at = ? WHERE user_id = 'usr_pc_a' AND expires_at IS NOT NULL").run(PAST);
  const expiredLot = () => row(w, "SELECT seconds_remaining, seconds_held FROM pc_credit_lots WHERE user_id = 'usr_pc_a' AND expires_at IS NOT NULL");
  // Before any sweep has run, the customer confirms a 6 h job: it holds the plain hours, none of the expired lot.
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
  assert.deepEqual(expiredLot(), { seconds_remaining: 6 * H, seconds_held: 0 }, 'not held, so left whole for the sweep');
  // The unswept expired hours still count as available, yet a second confirmation is refused rather than holding them.
  assert.deepEqual([(await credits(w.a, cat.tier)).available_seconds, (await credits(w.a, cat.tier)).reserved_seconds], [6 * H, 6 * H]);
  const { jobId: second } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Second' });
  await ok(w.a, 'POST', `${API}/jobs/${second}/review`);
  await refused(w.a, 'POST', `${API}/jobs/${second}/confirm`, undefined, 'INSUFFICIENT_CREDIT', idem('confirm'));
  await w.db.batch([enqueueTask(w.db, { kind: 'expire_credit_lots', dedupeKey: 'followups-expiry', now: new Date() })]);
  await w.runTasks();
  assert.deepEqual(expiredLot(), { seconds_remaining: 0, seconds_held: 0 });
  assert.deepEqual([(await credits(w.a, cat.tier)).available_seconds, (await credits(w.a, cat.tier)).reserved_seconds], [0, 6 * H]);
  await reconcileClean(w);
});

test('the expiry page leaves out lots wholly held for jobs, so the lots that can expire are always reached', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const pkg = await expiringPackage(w, cat);
  // A: an expiring 6 h lot wholly held by a printing job, plus 6 plain hours available.
  await buy(w.a, [{ kind: 'credit_package', package_id: pkg }, { kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 6 * H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await runToPrinting(w, w.a, jobId);
  // B: an expiring lot nothing holds.
  await buy(w.b, [{ kind: 'credit_package', package_id: pkg }]);
  // A's lot expired first, so without the filter it would take the only slot.
  w.raw.prepare("UPDATE pc_credit_lots SET expires_at = ? WHERE expires_at IS NOT NULL AND user_id = 'usr_pc_a'").run(PAST);
  w.raw.prepare("UPDATE pc_credit_lots SET expires_at = ? WHERE expires_at IS NOT NULL AND user_id = 'usr_pc_b'").run('2000-01-02T00:00:00.000Z');
  const page = await expiredLots(w.db, new Date(), 1);
  assert.deepEqual(page.map((l) => l.user_id), ['usr_pc_b'], 'one slot, and it goes to the lot that can expire');
});

test("a conversion's extra groups are keyed apart from any other conversion's key", async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a1 = await ok(w.owner, 'POST', `${ADMIN}/catalog/tiers`, { code: 'a1', name_en: 'A1 hours', name_ar: 'ساعات A1', name_ckb: 'کاتژمێرەکانی A1', hourly_rate_iqd: 750 });
  const rule = await ok(w.full, 'POST', `${ADMIN}/catalog/conversion_rules`, { from_tier_id: cat.tier, to_tier_id: a1.id, ratio_num: 1, ratio_den: 1 });
  await ok(w.full, 'PATCH', `${ADMIN}/catalog/conversion_rules/${rule.id}`, { enabled: true });
  await buy(w.a, [{ kind: 'credit_package', package_id: await expiringPackage(w, cat) }, { kind: 'credit_package', package_id: cat.packages.h6 }]);
  const convert = (seconds: number, key: string) =>
    ok(w.a, 'POST', `${API}/me/credits/convert`, { from_tier_id: cat.tier, to_tier_id: a1.id, seconds }, { 'Idempotency-Key': key });
  // 7 h: 6 expiring + 1 plain — two groups, so a second conversion lot.
  await convert(7 * H, 'KKKKKKKKKKKK');
  await convert(H, 'KKKKKKKKKKKK:1');
  assert.equal((await credits(w.a, a1.id)).available_seconds, 8 * H);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ orders

test('a shipment whose fee order already closed unpaid can still be cancelled, and gives its units back', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const ship = await ok(w.a, 'POST', `${API}/shipments`, { kind: 'delivery', items: [{ variant_id: cat.white, qty: 200 }], payment_method: 'dev', delivery_address: ADDRESS }, idem('ship'));
  assert.equal(ship.status, 'awaiting_payment');
  // The state an older two-step cancellation could leave: the fee order closed, the shipment still waiting.
  w.raw.prepare("UPDATE pc_orders SET status = 'cancelled' WHERE id = ?").run(ship.fee_order_id);
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${ship.shipment_id}/advance`, { to: 'cancelled' });
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', ship.shipment_id)?.status, 'cancelled');
  assert.equal((await owned(w.a, cat.white)).reserved_qty, 0, 'the 200 g are the customer’s again');
});

test('a receipt already applied, re-entered with a mistyped amount, is that receipt again — never money on the refund desk', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const q = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'credit_package', package_id: cat.packages.h24 }] });
  const order = await ok(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'manual' }, idem('o'));
  const confirm = (amount: number, reference = 'RCPT-1') => ok(w.full, 'POST', `${ADMIN}/orders/${order.order_id}/confirm-payment`, { reference, amount_iqd: amount });
  assert.equal((await confirm(36000)).outcome, 'applied');
  const typo = await confirm(36001);
  assert.deepEqual([typo.outcome, typo.previous_outcome, typo.previous_amount_iqd], ['duplicate_event', 'applied', 36000]);
  assert.equal(Number(row(w, 'SELECT COUNT(*) AS n FROM pc_payment_events WHERE order_id = ?', order.order_id)?.n), 1, 'no second event');
  // A reference that only ENDS like the applied one is another receipt.
  assert.equal((await confirm(36000, 'X:RCPT-1')).outcome, 'duplicate_order');
  const refunds = (await ok(w.owner, 'GET', `${ADMIN}/reconcile`)).checks.find((c: Json) => c.name === 'payments_needing_refund').issues;
  assert.equal(refunds.length, 1, 'only the genuinely second receipt waits for a refund');
});

// ------------------------------------------------------------------ catalogue

test('registering a machine needs money scope: an operator cannot put one on a tier', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const body = { model_id: cat.model, name: 'X2D #9', serial_number: 'SN-X2D-0009', equipment_code: 'LEV-X2D-09' };
  const denied = await call(w.assistant, 'POST', `${ADMIN}/catalog/printers`, body);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.details?.reason, 'financial_scope_required');
  assert.equal(Number(row(w, "SELECT COUNT(*) AS n FROM pc_printers WHERE serial_number = 'SN-X2D-0009'")?.n), 0);
  await ok(w.full, 'POST', `${ADMIN}/catalog/printers`, body);
});
