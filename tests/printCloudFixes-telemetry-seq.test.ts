/**
 * LEVONIS PRINT CLOUD — telemetry ordered by the agent's sequence, not by a
 * clock (worker/lib/printCloud/printers.ts parseTelemetry, ingestTelemetry).
 *
 * Three rounds of clock heuristics each left a hole, because the server cannot
 * tell a replayed old body from an agent clock that stepped back. Every body
 * now carries `boot` (the agent's persisted boot counter) and `seq`
 * (strictly increasing within it), and readings are ordered by them alone:
 *
 *   - a replayed old body never replaces a newer error, whatever its stamps;
 *   - an agent clock stepped back 30 s or 300 s changes nothing;
 *   - a single stamp in the year 2100 freezes nothing;
 *   - within a boot the higher seq stands, whatever order they arrive in;
 *   - a new boot supersedes the old one even with lower numbers, and a late
 *     reading of the old boot is superseded after it;
 *   - an error that arrives after a newer reading records machine_error once
 *     and changes no state;
 *   - two racing readings end with the higher one stored and only its events;
 *   - a body without boot or seq is refused;
 *   - a printer re-bound to another agent takes that agent's first reading.
 * Clocks only date a reading for freshness (`readingTakenAt`).
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-telemetry-seq.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, AGENT, API, buy, call, estimatedJob, idem, ok, pcWorld, row, rows, seedCatalog, type Catalog, type Json, type World } from './fixtures/printCloud';
import { readingTakenAt } from '../worker/lib/printCloud/printers';

const H = 3600;
const STALE = 120;
const at = (secondsFromNow: number) => new Date(Date.now() + secondsFromNow * 1000).toISOString();
const NOZZLE = [{ code: 'HMS_0300', message: 'nozzle' }];

/** An agent with `telemetry` bound to the only printer: its sender, and its raw door for refusals. */
async function bound(w: World, cat: Catalog, name = 'Bay 1') {
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name, capabilities: ['telemetry'] });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${cat.printers[0]}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: 'lan-1' });
  const bearer = { Authorization: `Bearer ${agent.token}` };
  const door = (body: Json) => call(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, body, bearer);
  return { id: agent.agent_id as string, door, send: (body: Json) => ok(w.guest, 'POST', `${AGENT}/printers/${cat.printers[0]}/telemetry`, body, bearer) };
}

async function world() {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const printer = cat.printers[0];
  const view = async () => (await ok(w.assistant, 'GET', `${ADMIN}/printers`)).find((p: Json) => p.id === printer);
  const events = (kind: string) => rows(w, 'SELECT id, detail_json FROM pc_printer_events WHERE printer_id = ? AND kind = ?', printer, kind);
  const stored = () => row(w, 'SELECT * FROM pc_printer_telemetry WHERE printer_id = ?', printer);
  const assignedNow = async () => (await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned as Json[];
  return { w, cat, printer, view, events, stored, assignedNow };
}

/** A job waiting in the queue for the only machine. */
async function queuedJob(w: World, cat: Catalog): Promise<string> {
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  assert.equal((await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'))).status, 'queued');
  return jobId;
}

const superseded = (r: Json) => assert.deepEqual([r.stored, r.superseded], [false, true], JSON.stringify(r));

// ------------------------------------------------------------------ replay

test('a replayed old body (old seq, fresh sent_at) never replaces a newer error, and the faulted machine gets no work', async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  await queuedJob(x.w, x.cat);
  const boot = 1;
  assert.equal((await agent.send({ machine_state: 'idle', boot, seq: 1 })).stored, true);
  assert.equal((await agent.send({ machine_state: 'error', errors: NOZZLE, boot, seq: 2 })).stored, true);
  // The retry layer re-sends the first body, re-stamped as it goes out: as fresh as can be by every clock.
  superseded(await agent.send({ machine_state: 'idle', boot, seq: 1, sent_at: at(0) }));
  superseded(await agent.send({ machine_state: 'idle', boot, seq: 1, reported_at: at(-1), sent_at: at(0) }));
  const v = await x.view();
  assert.equal(v.telemetry.machine_state, 'error', 'the error stands');
  assert.deepEqual(v.telemetry.errors.map((e: Json) => e.code), ['HMS_0300']);
  assert.equal(v.telemetry.live, true);
  assert.deepEqual(await x.assignedNow(), [], 'a faulted machine gets no work');
  assert.equal(x.events('machine_error').length, 1);
});

// ------------------------------------------------------------------ clock stepped back

for (const step of [30, 300]) {
  test(`an agent clock stepped back ${step} s changes nothing: the error with the higher seq is stored, recorded, and the machine gets no work`, async () => {
    const x = await world();
    const agent = await bound(x.w, x.cat);
    await queuedJob(x.w, x.cat);
    const boot = step;
    assert.equal((await agent.send({ machine_state: 'idle', boot, seq: 41, reported_at: at(0), sent_at: at(0) })).stored, true);
    // NTP pulls the agent clock back; the machine faults right after.
    const fault = await agent.send({ machine_state: 'error', errors: NOZZLE, boot, seq: 42, reported_at: at(-step), sent_at: at(-step) });
    assert.equal(fault.stored, true);
    assert.deepEqual([x.stored()?.machine_state, x.stored()?.seq], ['error', 42]);
    assert.equal(x.events('machine_error').length, 1);
    assert.equal((await x.view()).telemetry.live, true, 'its age is 0 by the one clock that stepped');
    assert.deepEqual(await x.assignedNow(), []);
  });
}

// ------------------------------------------------------------------ a stamp in the year 2100

test('a single year-2100 stamp freezes nothing: the next reading with a higher seq is stored and live', async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  const boot = 1;
  // A clock that jumped to 2100 for one reading: alone, a stamp is no age.
  assert.equal((await agent.send({ machine_state: 'error', errors: NOZZLE, boot, seq: 1, reported_at: '2100-01-01T00:00:00.000Z' })).stored, true);
  assert.equal((await x.view()).telemetry.live, true);
  assert.equal((await agent.send({ machine_state: 'idle', boot, seq: 2, reported_at: at(-1), sent_at: at(0) })).stored, true);
  let v = await x.view();
  assert.deepEqual([v.telemetry.machine_state, v.telemetry.live, v.connectivity], ['idle', true, 'online']);
  // Sent «in 2100» from a reading taken now: the age is capped just past the window — stale, and dated no further back.
  assert.equal((await agent.send({ machine_state: 'paused', boot, seq: 3, reported_at: at(0), sent_at: '2100-01-01T00:00:00.000Z' })).stored, true);
  v = await x.view();
  assert.deepEqual([v.telemetry.machine_state, v.telemetry.stale], ['paused', true]);
  assert.ok(Date.now() - Date.parse(String(x.stored()?.received_at)) < (STALE + 30) * 1000, `dated ${x.stored()?.received_at}`);
  assert.equal((await agent.send({ machine_state: 'idle', boot, seq: 4 })).stored, true);
  v = await x.view();
  assert.deepEqual([v.telemetry.machine_state, v.telemetry.live], ['idle', true]);
});

// ------------------------------------------------------------------ order within a boot

test('readings of one boot arriving out of order: the higher seq stands, whatever the stamps say', async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  const boot = 1;
  assert.equal((await agent.send({ machine_state: 'error', errors: NOZZLE, boot, seq: 6, reported_at: at(-10), sent_at: at(-10) })).stored, true);
  // Overtaken in transit, and stamped later than the reading that overtook it.
  superseded(await agent.send({ machine_state: 'idle', boot, seq: 5, reported_at: at(0), sent_at: at(0) }));
  superseded(await agent.send({ machine_state: 'idle', boot, seq: 6 }));
  assert.deepEqual([x.stored()?.machine_state, x.stored()?.seq], ['error', 6]);
  assert.equal((await agent.send({ machine_state: 'idle', boot, seq: 7, reported_at: at(-30), sent_at: at(-30) })).stored, true);
  assert.deepEqual([x.stored()?.machine_state, x.stored()?.seq], ['idle', 7]);
});

// ------------------------------------------------------------------ a restart

test('a restart supersedes the old boot even with lower numbers, and a late reading of the old boot is superseded after it', async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  assert.equal((await agent.send({ machine_state: 'printing', job_id: 'sd-card-print', boot: 4, seq: 9000 })).stored, true);
  // The process restarts and counts from zero under a new boot id.
  assert.equal((await agent.send({ machine_state: 'idle', boot: 5, seq: 0 })).stored, true);
  assert.deepEqual([x.stored()?.boot, x.stored()?.seq, x.stored()?.machine_state], [5, 0, 'idle']);
  // A request of the dead process, held up in a proxy, lands afterwards: its fault is recorded, the state is not.
  superseded(await agent.send({ machine_state: 'error', errors: NOZZLE, boot: 4, seq: 9001 }));
  assert.deepEqual([x.stored()?.boot, x.stored()?.machine_state], [5, 'idle']);
  assert.equal(x.events('machine_error').length, 1);
  assert.equal((await agent.send({ machine_state: 'idle', boot: 5, seq: 1 })).stored, true);
  assert.equal(x.events('boot_regressed').length, 1, 'the late reading of boot 4 is said once: a counter below the stored one');
});

test("a dead process whose readings were never stored cannot outrank the live one: the boot counter orders, not arrival", async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  await queuedJob(x.w, x.cat);
  // Boot 7 crashed before any of its readings got through; boot 8 reports first.
  assert.equal((await agent.send({ machine_state: 'idle', boot: 8, seq: 0 })).stored, true);
  // Boot 7's request, held up on a lossy link, lands afterwards: superseded, whatever its seq.
  superseded(await agent.send({ machine_state: 'idle', boot: 7, seq: 3 }));
  // The live boot faults: stored, and the faulted machine gets no work.
  assert.equal((await agent.send({ machine_state: 'error', errors: NOZZLE, boot: 8, seq: 1 })).stored, true);
  assert.deepEqual([x.stored()?.boot, x.stored()?.seq, x.stored()?.machine_state], [8, 1, 'error']);
  assert.deepEqual(await x.assignedNow(), [], 'a faulted machine gets no work');
});

test('a boot counter that goes back is superseded until it passes the stored one, and said once per boot', async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  assert.equal((await agent.send({ machine_state: 'idle', boot: 12, seq: 5 })).stored, true);
  // The agent's counter file was restored from an old backup: it restarts as boot 3.
  superseded(await agent.send({ machine_state: 'idle', boot: 3, seq: 0 }));
  superseded(await agent.send({ machine_state: 'idle', boot: 3, seq: 1 }));
  assert.equal(x.events('boot_regressed').length, 1, 'once per boot');
  assert.deepEqual(JSON.parse(String(x.events('boot_regressed')[0].detail_json)), { boot: 3, stored_boot: 12 });
  // Re-binding the printer to a fresh agent token clears it.
  const fresh = await bound(x.w, x.cat, 'Bay 1 (new token)');
  assert.equal((await fresh.send({ machine_state: 'idle', boot: 0, seq: 0 })).stored, true);
});

// ------------------------------------------------------------------ a fault that arrives late

test('an error arriving after a newer idle records machine_error once and leaves idle stored', async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  await queuedJob(x.w, x.cat);
  const boot = 1;
  assert.equal((await agent.send({ machine_state: 'idle', boot, seq: 10 })).stored, true);
  superseded(await agent.send({ machine_state: 'error', errors: NOZZLE, boot, seq: 9 }));
  const faults = x.events('machine_error');
  assert.equal(faults.length, 1, 'no fault report is lost');
  assert.deepEqual(JSON.parse(String(faults[0].detail_json)), { errors: NOZZLE, boot, seq: 9, superseded: true });
  assert.deepEqual([x.stored()?.machine_state, x.stored()?.seq], ['idle', 10]);
  // Re-sent, it is the same report.
  superseded(await agent.send({ machine_state: 'error', errors: NOZZLE, boot, seq: 9 }));
  assert.equal(x.events('machine_error').length, 1);
  assert.equal((await x.assignedNow()).length, 1, 'the idle state stands: the machine takes the job');
});

// ------------------------------------------------------------------ races

test('two racing readings end with the higher seq stored and only its events, whichever lands first', async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  const boot = 1;
  await agent.send({ machine_state: 'idle', boot, seq: 1 });
  // seq 5 has read the row (seq 1) and planned; seq 7 lands just before its batch.
  x.w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_printer_telemetry'));
  x.w.race.hook = async () => {
    assert.equal((await agent.send({ machine_state: 'error', errors: NOZZLE, boot, seq: 7 })).stored, true);
  };
  superseded(await agent.send({ machine_state: 'idle', job_id: 'sd-card-print', boot, seq: 5 }));
  assert.deepEqual([x.stored()?.machine_state, x.stored()?.seq], ['error', 7]);
  assert.equal(x.events('machine_error').length, 1);
  assert.equal(x.events('telemetry_job_unassigned').length, 0, 'the superseded reading wrote none of its events');
  // The other way round: seq 9 has planned; seq 8 lands first; seq 9 still lands on top.
  x.w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_printer_telemetry'));
  x.w.race.hook = async () => {
    assert.equal((await agent.send({ machine_state: 'paused', job_id: 'sd-card-print', boot, seq: 8 })).stored, true);
  };
  assert.equal((await agent.send({ machine_state: 'idle', boot, seq: 9 })).stored, true);
  assert.deepEqual([x.stored()?.machine_state, x.stored()?.seq], ['idle', 9]);
  // And a copy of the stored reading racing itself is stored once.
  x.w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_printer_telemetry'));
  x.w.race.hook = async () => {
    assert.equal((await agent.send({ machine_state: 'printing', job_id: 'sd-card-print', boot, seq: 10 })).stored, true);
  };
  superseded(await agent.send({ machine_state: 'printing', job_id: 'sd-card-print', boot, seq: 10 }));
  assert.equal(x.events('telemetry_job_unassigned').length, 2, 'seq 8 and seq 10, once each');
});

// ------------------------------------------------------------------ the protocol

test('a body without boot or seq, or with either malformed, is refused and changes nothing', async () => {
  const x = await world();
  const agent = await bound(x.w, x.cat);
  const cases: Array<[Json, string]> = [
    [{ machine_state: 'idle' }, 'boot'],
    [{ machine_state: 'idle', seq: 1 }, 'boot'],
    [{ machine_state: 'idle', boot: 1 }, 'seq'],
    [{ machine_state: 'idle', boot: -1, seq: 1 }, 'boot'],
    [{ machine_state: 'idle', boot: 1.5, seq: 1 }, 'boot'],
    [{ machine_state: 'idle', boot: '1', seq: 1 }, 'boot'],
    [{ machine_state: 'idle', boot: 2 ** 53, seq: 1 }, 'boot'],
    [{ machine_state: 'idle', boot: 1, seq: -1 }, 'seq'],
    [{ machine_state: 'idle', boot: 1, seq: 1.5 }, 'seq'],
    [{ machine_state: 'idle', boot: 1, seq: '1' }, 'seq'],
    [{ machine_state: 'idle', boot: 1, seq: 2 ** 53 }, 'seq'],
  ];
  for (const [body, field] of cases) {
    const r = await agent.door(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 'VALIDATION', JSON.stringify(body));
    assert.equal(r.json.details?.field, field, `${JSON.stringify(body)} → ${JSON.stringify(r.json)}`);
  }
  assert.equal(x.stored(), undefined, 'nothing was stored');
  assert.equal((await x.view()).connectivity, 'never_connected');
  assert.equal((await agent.send({ machine_state: 'idle', boot: 1, seq: Number.MAX_SAFE_INTEGER })).stored, true);
});

// ------------------------------------------------------------------ a re-bound printer

test("a printer re-bound to another agent takes the new agent's first reading, whatever its numbers and age", async () => {
  const x = await world();
  const first = await bound(x.w, x.cat, 'Bay 1');
  assert.equal((await first.send({ machine_state: 'error', errors: NOZZLE, boot: 1, seq: 1000 })).stored, true);
  const second = await bound(x.w, x.cat, 'Bay 2');
  // Same boot id by chance, a lower seq, and a reading a minute old: it is another agent's sequence, and the newest word on the machine.
  assert.equal((await second.send({ machine_state: 'idle', boot: 1, seq: 0, reported_at: at(-60), sent_at: at(0) })).stored, true);
  assert.deepEqual([x.stored()?.agent_id, x.stored()?.machine_state, x.stored()?.seq], [second.id, 'idle', 0]);
  const v = await x.view();
  assert.deepEqual([v.telemetry.live, v.connectivity], [true, 'online']);
  // The agent it was taken from no longer reaches it.
  assert.equal((await first.door({ machine_state: 'error', errors: NOZZLE, boot: 1, seq: 1001 })).status, 404);
  assert.equal(x.stored()?.machine_state, 'idle');
  assert.equal((await second.send({ machine_state: 'idle', boot: 1, seq: 1 })).stored, true);
});

// ------------------------------------------------------------------ age, for freshness only

test('the age is sent_at - reported_at on the one agent clock, 0 when out of order or incomplete, capped just past the window', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');
  const taken = (reported_at: string | null, sent_at: string | null) => readingTakenAt({ reported_at, sent_at }, STALE, now);
  // A clock two hours fast: both stamps are, and the age is the 5 s between them.
  assert.equal(taken('2026-10-27T13:59:55.000Z', '2026-10-27T14:00:00.000Z'), '2026-10-27T11:59:55.000Z');
  assert.equal(taken('2026-10-27T12:00:05.000Z', '2026-10-27T12:00:00.000Z'), now.toISOString(), 'a pair out of order is age 0');
  assert.equal(taken('2026-10-27T11:00:00.000Z', null), now.toISOString(), 'one stamp is no age');
  assert.equal(taken(null, '2026-10-27T11:00:00.000Z'), now.toISOString());
  assert.equal(taken('2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z'), '2026-10-27T11:57:59.000Z', 'stale, and no further back');
});
