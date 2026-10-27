/**
 * LEVONIS PRINT CLOUD — the third round, telemetry: ordering and recorded
 * outages (worker/lib/printCloud/printers.ts ingestTelemetry), each finding
 * of the review pinned. The order these findings were first fixed with (the
 * agent's own clock) is now the agent's sequence — `boot` and `seq`
 * (tests/printCloudFixes-telemetry-seq.test.ts) — and the findings hold
 * under it.
 *
 *   0  a re-sent or overtaken reading is superseded by its sequence — in the
 *      pre-read and inside the batch — whatever its stamps say, and a
 *      re-bound printer takes the new agent's sequence.
 *   1  the first POST after a silence records the outage on the row even when
 *      its reading is superseded, so the outage and its reconcile_needed are
 *      never lost.
 *   2  a buffer flushed oldest-first still records reconcile_needed for a
 *      print finished during the outage — once per job per outage — and a
 *      finish on a connection steady since then records none.
 *   3  two POSTs racing at reconnection record the outage once, and
 *      `arrived_at` never moves back.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-telemetry2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  AGENT,
  API,
  buy,
  estimatedJob,
  idem,
  ok,
  pcWorld,
  row,
  rows,
  runToPrinting,
  seedCatalog,
  type Catalog,
  type Json,
  type World,
} from './fixtures/printCloud';
import type { App } from './fixtures/app';
import { parseTelemetry, readingTakenAt } from '../worker/lib/printCloud/printers';

const H = 3600;
const at = (secondsFromNow: number) => new Date(Date.now() + secondsFromNow * 1000).toISOString();

/**
 * An agent with `telemetry` bound to the only printer. Its sender numbers each
 * reading as the next of one boot unless the body names its own `seq` — a
 * re-sent body carries the number it was first sent with.
 */
async function bound(w: World, cat: Catalog, name = 'Bay 1') {
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name, capabilities: ['telemetry'] });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: 'lan-1' });
  const bearer = { Authorization: `Bearer ${agent.token}` };
  let seq = 0;
  return (body: Json) => {
    seq = typeof body.seq === 'number' ? Math.max(seq, body.seq) : seq + 1;
    return ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, { boot: 1, seq, ...body }, bearer);
  };
}

async function world() {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const printer = cat.printers[0];
  const view = async () => (await ok(w.assistant, 'GET', `${ADMIN}/printers`)).find((p: Json) => p.id === printer);
  const events = (kind: string) => rows(w, 'SELECT id, detail_json FROM pc_printer_events WHERE printer_id = ? AND kind = ?', printer, kind);
  const stored = () => row(w, 'SELECT machine_state, seq, received_at, arrived_at, outage_from, outage_to FROM pc_printer_telemetry WHERE printer_id = ?', printer)!;
  /** An hour of silence: the stored reading was taken, and last heard from, an hour ago. */
  const silence = () => {
    const hourAgo = at(-H);
    w.raw.prepare('UPDATE pc_printer_telemetry SET arrived_at = ?, received_at = ?, observed_at = ? WHERE printer_id = ?').run(hourAgo, hourAgo, hourAgo, printer);
    return hourAgo;
  };
  return { w, cat, printer, view, events, stored, silence };
}

async function queuedJob(w: World, app: App, cat: Catalog): Promise<string> {
  const { jobId } = await estimatedJob(w, app, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await ok(app, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal((await ok(app, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'))).status, 'queued');
  return jobId;
}

/** A job printing on the agent printer, with a live `printing` reading naming it. */
async function printingOnAgent(x: Awaited<ReturnType<typeof world>>, send: (b: Json) => Promise<Json>): Promise<string> {
  await send({ machine_state: 'idle', reported_at: at(-2), sent_at: at(0) });
  await buy(x.w.a, [{ kind: 'credit_package', package_id: x.cat.packages.h6 }, { kind: 'material', variant_id: x.cat.white, quantity: 250 }]);
  const { jobId } = await estimatedJob(x.w, x.w.a, x.cat, { seconds: H, materials: [{ variant_id: x.cat.white, model_grams: 20 }] });
  await runToPrinting(x.w, x.w.a, jobId);
  assert.equal(row(x.w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status, 'printing');
  assert.equal((await send({ machine_state: 'printing', job_id: jobId, reported_at: at(-1), sent_at: at(0) })).stored, true);
  return jobId;
}

// ------------------------------------------------------------------ 0: ordering

test('0: an hour-old body re-sent with its original stamps after an error is superseded, the error stands and the machine gets no work', async () => {
  const x = await world();
  const send = await bound(x.w, x.cat);
  await buy(x.w.a, [{ kind: 'credit_package', package_id: x.cat.packages.h6 }, { kind: 'material', variant_id: x.cat.white, quantity: 250 }]);
  await queuedJob(x.w, x.w.a, x.cat);
  await send({ machine_state: 'idle', seq: 1, reported_at: at(-H), sent_at: at(-H + 1) });
  await send({ machine_state: 'error', errors: [{ code: 'HMS_0300', message: 'nozzle' }], seq: 2, reported_at: at(-5), sent_at: at(-4) });
  assert.deepEqual((await ok(x.w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, []);
  // The retry layer re-sends the body serialised an hour ago, number and stamps and all.
  const replay = await send({ machine_state: 'idle', seq: 1, reported_at: at(-H), sent_at: at(-H + 1) });
  assert.deepEqual([replay.stored, replay.superseded], [false, true]);
  const v = await x.view();
  assert.equal(v.telemetry.machine_state, 'error', 'the error stands');
  assert.deepEqual(v.telemetry.errors.map((e: Json) => e.code), ['HMS_0300']);
  assert.deepEqual((await ok(x.w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [], 'a faulted machine gets no work');
});

test('0: two readings that arrive out of order: the lower seq is superseded, whatever the stamps say', async () => {
  const x = await world();
  const send = await bound(x.w, x.cat);
  await send({ machine_state: 'error', errors: [{ code: 'HMS_0300', message: 'nozzle' }], seq: 20, reported_at: at(-10), sent_at: at(-10) });
  const late = await send({ machine_state: 'idle', seq: 19, reported_at: at(-5), sent_at: at(-5) });
  assert.deepEqual([late.stored, late.superseded], [false, true]);
  assert.equal(x.stored().machine_state, 'error');
  assert.deepEqual((await x.view()).telemetry.errors.map((e: Json) => e.code), ['HMS_0300']);
});

test('0: inside the batch too — a lower reading whose pre-read passed loses to a higher one stored meanwhile', async () => {
  const x = await world();
  const send = await bound(x.w, x.cat);
  await send({ machine_state: 'idle', seq: 1 });
  // Just before the lower reading's batch lands, the higher one is stored.
  x.w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_printer_telemetry'));
  x.w.race.hook = async () => {
    assert.equal((await send({ machine_state: 'error', errors: [{ code: 'HMS_0300', message: 'nozzle' }], seq: 3, reported_at: at(-10), sent_at: at(-10) })).stored, true);
  };
  const late = await send({ machine_state: 'idle', seq: 2, reported_at: at(-1), sent_at: at(-1) });
  assert.deepEqual([late.stored, late.superseded], [false, true]);
  assert.equal(x.stored().machine_state, 'error', 'the higher reading stands');
  assert.equal(x.events('machine_error').length, 1);
});

test("0: a re-bound printer takes the new agent's sequence, and stamps never order its readings", async () => {
  const x = await world();
  const first = await bound(x.w, x.cat, 'Bay 1');
  await first({ machine_state: 'error', errors: [{ code: 'HMS_0300', message: 'nozzle' }], seq: 500, reported_at: at(-5), sent_at: at(-4) });
  // Re-bound to a second agent whose clock runs two hours behind and whose count starts low.
  const second = await bound(x.w, x.cat, 'Bay 2');
  assert.equal((await second({ machine_state: 'idle', seq: 1, reported_at: at(-2 * H), sent_at: at(-2 * H) })).stored, true);
  assert.equal(x.stored().machine_state, 'idle');
  // A reading without stamps, and one stamped earlier still, follow the sequence.
  assert.equal((await second({ machine_state: 'paused' })).stored, true);
  assert.equal((await second({ machine_state: 'idle', reported_at: at(-2 * H - 60), sent_at: at(-2 * H - 60) })).stored, true);
  assert.equal(x.stored().machine_state, 'idle');
  assert.equal((await x.view()).connectivity, 'online');
});

test('0: a stamp outside four-digit years is only a stamp: parsed, and used for age at most', () => {
  const p = parseTelemetry({ machine_state: 'idle', boot: 7, seq: 0, reported_at: '+010000-01-01T00:00:00.000Z', sent_at: '2026-10-27T10:00:00+03:00' });
  assert.deepEqual([p.boot, p.seq, p.reported_at, p.sent_at], [7, 0, '+010000-01-01T00:00:00.000Z', '2026-10-27T07:00:00.000Z']);
  const now = new Date('2026-10-27T07:00:01.000Z');
  assert.equal(readingTakenAt(p, 120, now), now.toISOString(), 'a pair out of order is age 0');
});

// ------------------------------------------------------------------ 1: the first POST after an outage is superseded

test('1: a superseded first POST after a silence records the outage, and the live finish that follows asks for reconciliation', async () => {
  const x = await world();
  const send = await bound(x.w, x.cat);
  const jobId = await printingOnAgent(x, send);
  const hourAgo = x.silence();
  // The agent first re-sends a buffered reading older than the one the cloud stored (its ack was lost with the link).
  const dup = await send({ machine_state: 'printing', job_id: jobId, seq: Number(x.stored().seq) - 1, reported_at: at(-H - 5), sent_at: at(0) });
  assert.deepEqual([dup.stored, dup.superseded], [false, true]);
  const restored = x.events('connection_restored');
  assert.equal(restored.length, 1, 'the outage is recorded by the POST that ended it, superseded or not');
  assert.equal(JSON.parse(String(restored[0].detail_json)).silent_since, hourAgo);
  const r = x.stored();
  assert.equal(r.outage_from, hourAgo);
  assert.equal(r.outage_to, r.arrived_at);
  assert.ok(String(r.arrived_at) > hourAgo);
  // The print finished meanwhile; the record still says printing.
  assert.equal((await send({ machine_state: 'finished', job_id: jobId, reported_at: at(-1), sent_at: at(0) })).stored, true);
  const reconcile = x.events('reconcile_needed');
  assert.equal(reconcile.length, 1);
  assert.equal(JSON.parse(String(reconcile[0].detail_json)).job_id, jobId);
  assert.equal(x.events('connection_restored').length, 1);
});

// ------------------------------------------------------------------ 2: a buffer flushed oldest-first

test('2: a buffer flushed oldest-first records reconcile_needed for a print finished during the outage, once', async () => {
  const x = await world();
  const send = await bound(x.w, x.cat);
  const jobId = await printingOnAgent(x, send);
  x.silence();
  for (const minutes of [50, 40, 30, 20]) {
    assert.equal((await send({ machine_state: 'printing', job_id: jobId, reported_at: at(-minutes * 60), sent_at: at(0) })).stored, true);
  }
  assert.equal(x.events('connection_restored').length, 1, 'the first flushed reading ended the silence');
  assert.equal(x.events('reconcile_needed').length, 0, 'still printing');
  await send({ machine_state: 'finished', job_id: jobId, reported_at: at(-600), sent_at: at(0) });
  await send({ machine_state: 'finished', job_id: jobId, reported_at: at(-1), sent_at: at(0) });
  assert.equal(x.events('reconcile_needed').length, 1, 'the machine finished during the outage while the record says printing — once per job per outage');
  assert.equal(x.stored().machine_state, 'finished');
  assert.equal(row(x.w, 'SELECT status FROM pc_print_jobs WHERE id = ?', jobId)?.status, 'printing', 'never «fixed» by guessing');
  assert.equal(x.events('connection_restored').length, 1);
});

test('2: a finish on a connection steady since the outage ended is not a reconciliation', async () => {
  const x = await world();
  const send = await bound(x.w, x.cat);
  const jobId = await printingOnAgent(x, send);
  x.silence();
  await send({ machine_state: 'printing', job_id: jobId, reported_at: at(-30), sent_at: at(0) });
  assert.equal(x.events('connection_restored').length, 1);
  // That reconnection was an hour ago, and live readings have arrived since.
  x.w.raw.prepare('UPDATE pc_printer_telemetry SET outage_from = ?, outage_to = ? WHERE printer_id = ?').run(at(-3 * H), at(-2 * H), x.printer);
  await send({ machine_state: 'printing', job_id: jobId, reported_at: at(-10), sent_at: at(-10) });
  await send({ machine_state: 'finished', job_id: jobId, reported_at: at(-1), sent_at: at(-1) });
  assert.equal(x.events('reconcile_needed').length, 0, 'the agent reports its own completion');
});

// ------------------------------------------------------------------ 3: racing POSTs at reconnection

test('3: two POSTs racing at reconnection record the outage once, and arrived_at never moves back', async () => {
  const x = await world();
  const send = await bound(x.w, x.cat);
  await send({ machine_state: 'idle', seq: 1, reported_at: at(-2), sent_at: at(0) });
  const hourAgo = x.silence();
  // While the live reading is about to land, an older buffered one is flushed in parallel and lands first.
  x.w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_printer_telemetry'));
  x.w.race.hook = async () => {
    assert.equal((await send({ machine_state: 'idle', seq: 2, reported_at: at(-30), sent_at: at(0) })).stored, true);
  };
  const live = await send({ machine_state: 'idle', seq: 3, reported_at: at(-1), sent_at: at(0) });
  assert.equal(live.stored, true);
  assert.equal(x.stored().seq, 3);
  const restored = x.events('connection_restored');
  assert.equal(restored.length, 1, 'once per outage');
  assert.equal(JSON.parse(String(restored[0].detail_json)).silent_since, hourAgo);
  const r = x.stored();
  assert.equal(r.outage_from, hourAgo);
  assert.ok(String(r.arrived_at) >= String(r.outage_to), `arrived_at ${r.arrived_at} moved back behind the reconnection ${r.outage_to}`);
  assert.equal((await x.view()).connectivity, 'online');
});

test('2: a finish buffered during the outage and flushed long after the reconnection still asks for reconciliation', async () => {
  const x = await world();
  const send = await bound(x.w, x.cat);
  const jobId = await printingOnAgent(x, send);
  x.silence();
  await send({ machine_state: 'printing', job_id: jobId, reported_at: at(-30), sent_at: at(0) });
  assert.equal(x.events('connection_restored').length, 1);
  // The reconnection was 200 s ago, and live readings have come in since; the outage ran for the hour before it.
  x.w.raw
    .prepare('UPDATE pc_printer_telemetry SET outage_from = ?, outage_to = ?, received_at = ?, observed_at = ? WHERE printer_id = ?')
    .run(at(-H - 200), at(-200), at(-150), at(-150), x.printer);
  // Now the agent flushes a reading it took half an hour ago — during the outage — saying the print finished.
  await send({ machine_state: 'finished', job_id: jobId, reported_at: at(-1800), sent_at: at(0) });
  assert.equal(x.events('reconcile_needed').length, 1, 'taken during the outage, however late it arrives');
});
