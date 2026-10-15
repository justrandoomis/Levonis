/**
 * THE BAMBU IMPORT RUNNER (import spec §A.1, §A.3, §A.7, §B.5, §I.1, §J;
 * build step 8), driven against a FAKE ops endpoint that keeps the §B.3 state
 * machine, a FAKE clock and a FAKE store serving the committed fixture pages
 * (tests/fixtures/bambuImportWorld.ts). Nothing here leaves the process.
 *
 *   - the happy path: one item at a time, the stage order, the event
 *     sequence, every ops call authenticated with the job token and protocol 2;
 *   - EXTRACT never before the previous COMPLETE (the event sequence, and a
 *     COMPLETE that did not commit stops the queue);
 *   - ≥ 11 s between store requests, the import's User-Agent, no cookie;
 *   - robots.txt Disallow and every form of the bot challenge → BLOCKED
 *     ACCESS_CHALLENGE at once, never retried around;
 *   - retries (in-call for idempotent calls, stage-level with RETRYING for an
 *     ambiguous /write), eight attempts → RETRIES_EXHAUSTED;
 *   - a BLOCKED item stops the loop; resume continues it once;
 *   - every §A.7 deadline rule, among them a 30-minute backoff near the
 *     deadline that releases and exits, and /write never started with less
 *     than 13 minutes left;
 *   - the chain outputs (more, blocked, run_id); the open, close and withdraw
 *     modes; the reviewed-bundle and revoked-token stops.
 *
 * Run: node --import tsx --test tests/bambuImportRunner.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_ID, STORE, TOKEN, UA, World } from './fixtures/bambuImportWorld';
import { Deadline, WRITE_RESERVE, ITEM_RESERVE, backoff, retryAfterMs, WORST } from '../scripts/bambu-import/deadline';
import { classify, normaliseCode, OpsClient } from '../scripts/bambu-import/opsClient';
import { parseRobots, robotsAllows } from '../scripts/bambu-import/robots';
import { ImportStop, StoreFetcher } from '../scripts/bambu-import/fetch';
import { ExtractGate, stageAfter } from '../scripts/bambu-import/run';
import { reviewedDifferences } from '../scripts/bambu-import/discover';

const MIN = 60_000;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const pagePaths = (w: World) => w.storeRequests.filter((r) => r.path.startsWith('/products/'));
const callsTo = (w: World, re: RegExp) => w.calls.filter((c) => re.test(c.path));

test('the happy path: two products, one at a time, each verified on the public site before the next is read', async () => {
  const w = new World();
  try {
    const code = await w.importer().main();
    assert.equal(code, 0, w.logLines.join('\n'));
    assert.deepEqual(w.outputs, { more: 'false', blocked: 'false', run_id: RUN_ID });
    for (const h of ['filament-buffer', 'ams-2-pro']) assert.equal(w.item(h).state, 'COMPLETE', h);

    // The stage order of each item, exactly the §B.3 graph.
    for (const h of ['filament-buffer', 'ams-2-pro']) {
      const states = w.events.filter((e) => e.sid === w.sid(h)).map((e) => e.state);
      assert.deepEqual(states, ['EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING', 'WRITTEN', 'COMPLETE'], h);
    }

    // EXTRACT of item 2 (its start event and its store page) only after item 1's COMPLETE committed.
    const complete1 = w.events.find((e) => e.sid === w.sid('filament-buffer') && e.state === 'COMPLETE')!.seq;
    const start2 = w.events.find((e) => e.sid === w.sid('ams-2-pro') && e.state === 'EXTRACTING')!.seq;
    const page2 = pagePaths(w).find((r) => r.path === '/products/ams-2-pro')!.seq;
    assert.ok(complete1 < start2 && start2 < page2, `COMPLETE ${complete1} < EXTRACTING ${start2} < store page ${page2}`);
    const page1 = pagePaths(w).find((r) => r.path === '/products/filament-buffer')!.seq;
    const start1 = w.events.find((e) => e.sid === w.sid('filament-buffer') && e.state === 'EXTRACTING')!.seq;
    assert.ok(start1 < page1, 'the store page is read only after the EXTRACTING start committed');

    // The store: ≥ 11 s apart (robots.txt included), our User-Agent, no cookie, br/gzip.
    assert.deepEqual(w.storeRequests.map((r) => r.path), ['/robots.txt', '/products/filament-buffer', '/products/ams-2-pro']);
    for (let i = 1; i < w.storeRequests.length; i++) assert.ok(w.storeRequests[i].at - w.storeRequests[i - 1].at >= 11_000, `store requests ${i - 1}→${i} are ≥ 11 s apart`);
    for (const r of w.storeRequests) {
      assert.equal(r.ua, UA);
      assert.equal(r.cookie, '');
      assert.equal(r.acceptEncoding, 'br, gzip');
    }

    // Every ops call: the bearer token and protocol 2; nothing else identifies anyone.
    for (const c of w.calls) {
      assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(c.headers['x-levonis-import-protocol'], '2');
      assert.equal(c.headers.cookie, undefined);
    }
    // Media in calls of at most 4; /write after the WRITING event; publish-finish, readback, complete.
    for (const c of callsTo(w, /\/media$/)) assert.ok((c.body!.media as unknown[]).length <= 4);
    assert.equal(callsTo(w, /\/write$/).length, 2);
    assert.equal(callsTo(w, /\/complete$/).length, 2);
    const evidence = callsTo(w, /\/complete$/)[0].body!.edge_evidence as Record<string, unknown>;
    assert.ok(evidence && typeof evidence === 'object' && 'checks' in evidence, 'the runner sends its edge evidence');
    assert.equal(callsTo(w, /\/complete$/)[0].body!.live_url, 'https://levonis-iq.com/product/bambu-filament-buffer');

    // Artifacts: sealed item reports and screenshots only.
    assert.deepEqual(w.sealed.map((s) => s.name), ['item-0001.json', 'item-0001-shot-1.png', 'item-0002.json', 'item-0002-shot-1.png']);
    for (const s of w.sealed) assert.equal(s.bytes.subarray(0, 6).toString(), 'LVSEAL');
  } finally {
    w.dispose();
  }
});

test('ops client: the §B.5 classification and the IMPORT_ codes of §C.11', () => {
  assert.equal(classify(404, ''), 'gone');
  assert.equal(classify(404, 'ITEM_NOT_IN_RUN'), 'permanent');
  assert.equal(classify(429, 'RATE_LIMITED'), 'transient');
  assert.equal(classify(500, ''), 'transient');
  assert.equal(classify(503, 'X'), 'transient');
  assert.equal(classify(409, 'SQLITE_BUSY'), 'transient');
  assert.equal(classify(409, 'IMPORT_LEASE_LOST'), 'stale');
  assert.equal(classify(409, 'IMPORT_ILLEGAL_TRANSITION'), 'stale');
  assert.equal(classify(400, 'IMPORT_PAYLOAD_KEY_REFUSED'), 'permanent');
  assert.equal(normaliseCode('IMPORT_PAYLOAD_KEY_REFUSED'), 'PAYLOAD_REFUSED');
  assert.equal(normaliseCode('IMPORT_REVIEWED_SCOPE_REFUSED'), 'REVIEWED_SCOPE_REFUSED');
  assert.equal(normaliseCode('IMPORT_IDENTITY_AMBIGUOUS'), 'IDENTITY_AMBIGUOUS');
  assert.equal(normaliseCode('IMPORT_FINANCIAL_WRITE_REFUSED'), 'IMPORT_FINANCIAL_WRITE_REFUSED');
  assert.equal(normaliseCode('PLAN_TOO_LARGE'), 'PLAN_TOO_LARGE');
  assert.throws(() => new OpsClient({ siteOrigin: 'https://levonis-iq.com', token: 'short', fetch: async () => json(200, {}), clock: { now: () => 0, sleep: async () => {} }, deadline: new Deadline(1e12, { now: () => 0, sleep: async () => {} }) }));
});

test('retries: an idempotent call is retried in the call; an ambiguous /write asks /lease and retries the stage with RETRYING', async () => {
  const w = new World({ handles: ['filament-buffer'] });
  try {
    w.inject(/\/stage$/, 2, () => json(503, { code: 'OVERLOADED', message: 'busy' }));
    let wrote = false;
    w.inject(/\/write$/, 1, () => {
      wrote = true;
      return json(500, { code: 'INTERNAL', message: 'x' });
    });
    const code = await w.importer().main();
    assert.equal(code, 0, w.logLines.join('\n'));
    assert.ok(wrote);
    assert.equal(w.item('filament-buffer').state, 'COMPLETE');
    assert.equal(callsTo(w, /\/stage$/).length, 3, 'two 503s, then the answer, inside one call');
    // The ambiguous /write: a lease to learn what committed, then RETRYING with the 30 s backoff, then WRITING again.
    const states = w.events.map((e) => e.state);
    assert.deepEqual(states.slice(states.indexOf('WRITING')), ['WRITING', 'RETRYING', 'WRITING', 'WRITTEN', 'COMPLETE']);
    const retry = w.events.find((e) => e.state === 'RETRYING')!;
    assert.equal(retry.code, 'INTERNAL');
    assert.equal(retry.release, false, 'a wait that fits keeps the lease');
    const leases = callsTo(w, /\/lease$/).length;
    assert.ok(leases >= 2, 'the ambiguous write was followed by a lease');
    assert.equal(callsTo(w, /\/write$/).length, 2);
  } finally {
    w.dispose();
  }
});

test('an answer lost after the Worker committed (/write, /complete): /lease says what happened and the runner continues from there', async () => {
  const w = new World();
  try {
    w.loseAnswer(/\/items\/6945416380552\/write$/);
    w.loseAnswer(/\/items\/580876092009701376\/complete$/);
    const code = await w.importer().main();
    assert.equal(code, 0, w.logLines.join('\n'));
    assert.equal(w.item('filament-buffer').state, 'COMPLETE');
    assert.equal(w.item('ams-2-pro').state, 'COMPLETE');
    assert.equal(callsTo(w, /6945416380552\/write$/).length, 1, 'a committed write is never sent again');
    assert.equal(callsTo(w, /580876092009701376\/complete$/).length, 1);
    assert.ok(!w.events.some((e) => e.state === 'RETRYING'), 'nothing to retry: the lease showed the commit');
    assert.deepEqual(w.outputs, { more: 'false', blocked: 'false', run_id: RUN_ID });
  } finally {
    w.dispose();
  }
});

test('a BLOCKED item stops the loop: a 403 at the store is ACCESS_CHALLENGE at once, the next item is never touched', async () => {
  const w = new World({ storePage: (h) => (h === 'filament-buffer' ? new Response('Forbidden', { status: 403 }) : null) });
  try {
    const code = await w.importer().main();
    assert.equal(code, 0);
    assert.deepEqual(w.outputs, { more: 'false', blocked: 'true', run_id: RUN_ID });
    assert.equal(w.item('filament-buffer').state, 'BLOCKED');
    assert.equal(w.item('filament-buffer').blocker_code, 'ACCESS_CHALLENGE');
    assert.equal(pagePaths(w).length, 1, 'one request, never repeated around the challenge');
    assert.equal(w.item('ams-2-pro').state, 'DISCOVERED');
    assert.equal(w.calls.filter((c) => c.path.includes(w.sid('ams-2-pro'))).length, 0, 'the next item was never leased');
    assert.ok(w.logLines.some((l) => /BLOCKED ACCESS_CHALLENGE; the queue stops here/.test(l)));
  } finally {
    w.dispose();
  }
});

test('the bot challenge in every form is never bypassed: cf-mitigated, "Just a moment…", a challenge 503', async () => {
  const forms: Array<() => Response> = [
    () => new Response('<html>ok</html>', { status: 200, headers: { 'cf-mitigated': 'challenge' } }),
    () => new Response('<title>Just a moment...</title>', { status: 200 }),
    () => new Response('<title>Just a moment...</title>', { status: 503 }),
  ];
  for (const form of forms) {
    const w = new World({ handles: ['filament-buffer'], storePage: () => form() });
    try {
      await w.importer().main();
      assert.equal(w.item('filament-buffer').blocker_code, 'ACCESS_CHALLENGE');
      assert.equal(pagePaths(w).length, 1);
      assert.equal(w.outputs.blocked, 'true');
    } finally {
      w.dispose();
    }
  }
});

test('robots.txt: a Disallow matching the planned product URL is BLOCKED ACCESS_CHALLENGE, and the page is never requested', async () => {
  const w = new World({ robots: 'User-agent: *\nDisallow: /products/filament-*\n' });
  try {
    await w.importer().main();
    assert.equal(w.item('filament-buffer').blocker_code, 'ACCESS_CHALLENGE');
    assert.deepEqual(w.storeRequests.map((r) => r.path), ['/robots.txt']);
    assert.ok(w.logLines.some((l) => /robots\.txt disallows a planned store path/.test(l)));
  } finally {
    w.dispose();
  }
});

test('robots.txt is read the RFC 9309 way: our group, the longest match, Allow on a tie, * and $', () => {
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: LevonisCatalogImport\nDisallow: /*filter*\nDisallow: /cart$\nAllow: /cart$\n');
  assert.ok(robotsAllows(r, '/products/a1'), 'our group replaces *');
  assert.ok(!robotsAllows(r, '/collections/x?filter=1'));
  assert.ok(robotsAllows(r, '/cart'), 'Allow wins a tie');
  const star = parseRobots('User-agent: *\nDisallow: /products/\nAllow: /products/a1$\n');
  assert.ok(robotsAllows(star, '/products/a1'));
  assert.ok(!robotsAllows(star, '/products/a1-combo'));
  assert.ok(robotsAllows(parseRobots(''), '/products/x'));
});

test('resume: a BLOCKED item stays blocked without resume, and continues at the stage after its last completed one with it', async () => {
  const blocked = { state: 'BLOCKED', last_completed: 'ENRICHING', blocker_code: 'PAYLOAD_REFUSED', attempts: 1 };
  const w1 = new World({ items: { '6945416380552': blocked } });
  try {
    await w1.importer().main();
    assert.deepEqual(w1.outputs, { more: 'false', blocked: 'true', run_id: RUN_ID });
    assert.equal(pagePaths(w1).length, 0, 'no store request for a blocked queue');
    assert.equal(w1.events.length, 0);
  } finally {
    w1.dispose();
  }
  const w2 = new World({ items: { '6945416380552': blocked } });
  try {
    await w2.importer({ resume: true }).main();
    const first = w2.events.filter((e) => e.sid === '6945416380552');
    assert.equal(first[0].state, 'VALIDATING', 'BLOCKED → the stage after ENRICHING');
    assert.equal(first[0].outcome, 'resume');
    assert.equal(w2.item('filament-buffer').state, 'COMPLETE');
    assert.equal(w2.item('ams-2-pro').state, 'COMPLETE');
    assert.deepEqual(w2.outputs, { more: 'false', blocked: 'false', run_id: RUN_ID });
    assert.equal(pagePaths(w2).filter((r) => r.path === '/products/filament-buffer').length, 1, 'the work is rebuilt from the page, once');
  } finally {
    w2.dispose();
  }
});

test('resume: a RETRYING item continues when its retry time has come', async () => {
  const w = new World({ handles: ['filament-buffer'], items: { '6945416380552': { state: 'RETRYING', last_completed: 'INGESTING_MEDIA', retry_at: '2026-10-16T07:00:00.000Z', stage_attempts: 2 } } });
  try {
    await w.importer().main();
    assert.equal(w.events[0].state, 'WRITING');
    assert.equal(w.item('filament-buffer').state, 'COMPLETE');
  } finally {
    w.dispose();
  }
});

test('deadline: a 30-minute backoff near the deadline releases the lease and exits more=true blocked=false', async () => {
  const w = new World({ handles: ['filament-buffer'] });
  try {
    w.inject(/\/stage$/, 9, () => json(429, { code: 'RATE_LIMITED', message: 'later' }, { 'retry-after': '1800' }));
    const imp = w.importer({ deadlineMs: w.clock.now() + 25 * MIN });
    await imp.main();
    assert.deepEqual(w.outputs, { more: 'true', blocked: 'false', run_id: RUN_ID });
    const last = w.events.at(-1)!;
    assert.equal(last.state, 'RETRYING');
    assert.equal(last.release, true, 'the lease is set to expire now');
    assert.equal(Date.parse(last.retry_at) - w.clock.now(), 30 * MIN, 'retry_at is the 30-minute wait');
    assert.equal(callsTo(w, /\/write$/).length, 0);
    assert.ok(w.logLines.some((l) => /deadline: .* the lease is released and the job exits \(more\)/.test(l)));
    assert.ok(w.clock.now() < imp.deadline.at, 'the job ended before its deadline');
  } finally {
    w.dispose();
  }
});

test('deadline: /write is never started with less than 13 minutes left', async () => {
  // A 540 s Retry-After from the store fits; with 21.9 minutes at the start it leaves 12.7 at the write.
  for (const [left, writes] of [
    [21.9 * MIN, 0],
    [24 * MIN, 1],
  ] as const) {
    let first = true;
    const w = new World({
      handles: ['filament-buffer'],
      storePage: () => {
        if (!first) return null;
        first = false;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '540' } });
      },
    });
    try {
      await w.importer({ deadlineMs: w.clock.now() + left }).main();
      assert.equal(callsTo(w, /\/write$/).length, writes, `${left / MIN} min at the start`);
      if (!writes) {
        assert.deepEqual(w.outputs, { more: 'true', blocked: 'false', run_id: RUN_ID });
        const park = w.events.at(-1)!;
        assert.equal(park.state, 'RETRYING');
        assert.equal(park.release, true);
        const at = w.calls.at(-1)!.at;
        assert.ok(w.config().deadlineMs - at > 0);
      } else {
        assert.equal(w.item('filament-buffer').state, 'COMPLETE');
      }
    } finally {
      w.dispose();
    }
  }
  // The rule itself, at the millisecond.
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  const d = new Deadline(100 * MIN, clock);
  assert.equal(WRITE_RESERVE, 13 * MIN);
  t = 100 * MIN - 13 * MIN - 1;
  assert.equal(d.canStartWrite(), true);
  t = 100 * MIN - 13 * MIN;
  assert.equal(d.canStartWrite(), false);
});

test('deadline: a fresh item is not started without a whole item of time, and a retry time that does not fit exits at once', async () => {
  const w = new World();
  try {
    await w.importer({ deadlineMs: w.clock.now() + ITEM_RESERVE - 1 }).main();
    assert.deepEqual(w.outputs, { more: 'true', blocked: 'false', run_id: RUN_ID });
    assert.equal(w.storeRequests.length, 0);
    assert.equal(callsTo(w, /\/lease$/).length, 0);
  } finally {
    w.dispose();
  }
  const w2 = new World({ handles: ['filament-buffer'], items: { '6945416380552': { state: 'RETRYING', last_completed: 'ENRICHING', retry_at: '2026-10-16T10:00:00.000Z' } } });
  try {
    await w2.importer({ deadlineMs: w2.clock.now() + 60 * MIN }).main();
    assert.deepEqual(w2.outputs, { more: 'true', blocked: 'false', run_id: RUN_ID });
    assert.equal(w2.events.length, 0, 'nothing moved');
    assert.equal(w2.storeRequests.length, 0);
  } finally {
    w2.dispose();
  }
});

test('deadline: the store spacing is a wait like any other', async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  const deadline = new Deadline(WORST.EXTRACT + 5_000, clock);
  let sent = 0;
  const store = new StoreFetcher({ fetch: async () => (sent++, new Response('<html></html>', { status: 200 })), clock, deadline, origin: STORE });
  await store.robotsTxt();
  await assert.rejects(store.productPage('filament-buffer'), (e: unknown) => e instanceof ImportStop && e.kind === 'deadline');
  assert.equal(sent, 1, 'the second request was never sent');
});

test('eight attempts of one stage → BLOCKED RETRIES_EXHAUSTED', async () => {
  const w = new World({ handles: ['filament-buffer'], items: { '6945416380552': { state: 'RETRYING', last_completed: 'ENRICHING', retry_at: '2026-10-16T07:00:00.000Z', stage_attempts: 7 } } });
  try {
    w.inject(/\/stage$/, 99, () => json(503, { code: 'OVERLOADED', message: 'busy' }));
    await w.importer().main();
    assert.equal(w.item('filament-buffer').state, 'BLOCKED');
    assert.equal(w.item('filament-buffer').blocker_code, 'RETRIES_EXHAUSTED');
    assert.equal(w.outputs.blocked, 'true');
  } finally {
    w.dispose();
  }
  assert.equal(backoff(0), 30_000);
  assert.equal(backoff(3), 240_000);
  assert.equal(backoff(12), 30 * MIN);
  assert.equal(retryAfterMs('120', 0), 120_000);
  assert.equal(retryAfterMs('99999', 0), 30 * MIN);
  assert.equal(retryAfterMs(null, 0), null);
});

test('EXTRACT never before the previous COMPLETE: a COMPLETE that did not commit stops the queue', async () => {
  const w = new World();
  try {
    // /complete answers without committing (the Worker refused): the item is not COMPLETE.
    w.inject(/\/items\/6945416380552\/complete$/, 9, () => json(200, { state: 'VERIFYING_LIVE' }));
    await w.importer().main();
    assert.equal(w.item('filament-buffer').state, 'BLOCKED');
    assert.equal(w.item('filament-buffer').blocker_code, 'VERIFY_FAILED_PERSISTENT');
    assert.equal(pagePaths(w).filter((r) => r.path === '/products/ams-2-pro').length, 0, 'the next page was never read');
  } finally {
    w.dispose();
  }
  const gate = new ExtractGate();
  gate.noteStart('1');
  gate.assertMayExtract('1', 5);
  gate.noteComplete('1', 9);
  gate.noteStart('2');
  assert.throws(() => gate.assertMayExtract('2', 9), /EXTRACT before the previous COMPLETE/);
  assert.throws(() => gate.assertMayExtract('3', 12), /did not start/);
  assert.throws(() => gate.noteStart('3'), /has not completed/);
  gate.assertMayExtract('2', 10);
  assert.equal(stageAfter(''), 'EXTRACTING');
  assert.equal(stageAfter('PUBLISHING'), 'VERIFYING_LIVE');
  assert.equal(stageAfter('VERIFYING_LIVE'), null);
});

test('the chain outputs: max_items stops with more=true; the next job finishes the queue with more=false', async () => {
  const w = new World();
  try {
    await w.importer({ maxItems: 1 }).main();
    assert.deepEqual(w.outputs, { more: 'true', blocked: 'false', run_id: RUN_ID });
    assert.equal(w.item('ams-2-pro').state, 'DISCOVERED');
    await w.importer({ maxItems: 0, chainCount: 1 }).main();
    assert.deepEqual(w.outputs, { more: 'false', blocked: 'false', run_id: RUN_ID });
    assert.equal(w.item('ams-2-pro').state, 'COMPLETE');
  } finally {
    w.dispose();
  }
});

test('/hello: a reviewed file that differs from the Worker bundle stops the job before any item', async () => {
  const w = new World({ reviewed: (own) => ({ ...own, 'manifest.json': '0'.repeat(64) }) });
  try {
    const code = await w.importer().main();
    assert.equal(code, 1);
    assert.equal(w.outputs.blocked, 'true');
    assert.equal(callsTo(w, /\/lease$/).length, 0);
    assert.ok(w.logLines.some((l) => /reviewed files differ from the Worker bundle \(1 differ\)/.test(l)));
  } finally {
    w.dispose();
  }
  assert.deepEqual(reviewedDifferences({ 'manifest.json': 'a', 'curated/index.json': 'b' }, { 'data/bambu-import/manifest.json': 'a', curated_index: 'b' }), ['curated/index.json', 'curated_index.json']);
  assert.deepEqual(reviewedDifferences({ 'manifest.json': 'a' }, { manifest: 'a' }), []);
});

test('a revoked token: every path answers 404, the job stops and says so', async () => {
  const w = new World();
  try {
    w.runState = 'closed';
    const code = await w.importer().main();
    assert.equal(code, 1);
    assert.equal(w.outputs.blocked, 'true');
    assert.ok(w.logLines.some((l) => /the run token answers 404/.test(l)));
  } finally {
    w.dispose();
  }
});

test('mode open: hello, the manifest in calls of ≤ 100 rows, the taxonomy, the protected snapshot before; a sealed report', async () => {
  const w = new World();
  try {
    const code = await w.importer({ mode: 'open', runId: '' }).main();
    assert.equal(code, 0, w.logLines.join('\n'));
    assert.deepEqual(w.calls.map((c) => c.path), ['/hello', '/manifest', '/run/prepare-taxonomy', '/run/protect-snapshot', '/run/status']);
    const rows = w.calls[1].body!.rows as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(rows[0]).sort(), ['breadcrumbs', 'canonical_url', 'curated', 'discovered_at', 'discovery_sources', 'handle', 'hold_code', 'queue_position', 'source_collections', 'source_product_id', 'type']);
    assert.deepEqual(w.calls[3].body, { phase: 'before' });
    assert.deepEqual(w.sealed.map((s) => s.name), ['open-report.json']);
    assert.equal(w.outputs.run_id, RUN_ID, 'the run id the token belongs to');
  } finally {
    w.dispose();
  }
});

test('mode close: refused while the queue holds work; then the sitemaps, the sweep, the protected snapshot after, finish, and a dead token', async () => {
  const w = new World();
  try {
    assert.equal(await w.importer({ mode: 'close' }).main(), 1, 'items are still DISCOVERED');
    assert.equal(callsTo(w, /\/run\/finish$/).length, 0);
    await w.importer().main();
    const before = w.calls.length;
    const code = await w.importer({ mode: 'close' }).main();
    assert.equal(code, 0, w.logLines.join('\n'));
    const paths = w.calls.slice(before).map((c) => c.path);
    assert.deepEqual(paths, ['/hello', '/run/status', '/run/protect-snapshot', '/run/finish', '/hello']);
    assert.ok(w.storeRequests.some((r) => r.path === '/sitemap_products_1.xml'));
    assert.ok(w.logLines.some((l) => /the old token now answers 404: yes/.test(l)));
    assert.ok(w.logLines.some((l) => /run finished: state closed/.test(l)));
    assert.ok(w.sealed.some((s) => s.name === 'close-report.json'));
  } finally {
    w.dispose();
  }
});

test('mode withdraw: only with the second fetch gone and the sitemap no longer listing it', async () => {
  const blocked = { '6945416380552': { state: 'BLOCKED', last_completed: '', blocker_code: 'SOURCE_WITHDRAWN' } };
  const w = new World({ handles: ['filament-buffer'], items: blocked, storePage: () => new Response('gone', { status: 404 }) });
  try {
    // The sitemap still lists it: refused, nothing sent.
    assert.equal(await w.importer({ mode: 'withdraw', item: '6945416380552' }).main(), 1);
    assert.equal(w.item('filament-buffer').state, 'BLOCKED');
    assert.equal(callsTo(w, /\/withdraw$/).length, 0);
  } finally {
    w.dispose();
  }
  const g = new World({ handles: ['filament-buffer'], items: blocked, storePage: () => new Response('gone', { status: 410 }), sitemapExclude: ['filament-buffer'] });
  try {
    assert.equal(await g.importer({ mode: 'withdraw', item: '6945416380552' }).main(), 0, g.logLines.join('\n'));
    assert.equal(g.item('filament-buffer').state, 'WITHDRAWN_AT_SOURCE');
    const body = callsTo(g, /\/withdraw$/)[0].body!;
    assert.match(String(body.approval_ref), /^workflow-60-run-\d+$/);
    assert.deepEqual((body.evidence as Record<string, unknown>).sitemap_absent, true);
    assert.equal(((body.evidence as Record<string, Record<string, unknown>>).second_fetch).status, 410);
  } finally {
    g.dispose();
  }
});

test('verification: a stale public answer is purged again and waited for, then VERIFY_FAILED_PERSISTENT; COMPLETE is never sent', async () => {
  const w = new World({
    handles: ['filament-buffer'],
    siteOverride: (method, path) =>
      method === 'GET' && /^\/api\/public\/v1\/products\/[^/]+$/.test(path)
        ? new Response(JSON.stringify({ data: { name: { en: 'Old' }, sections: [], images: [], price: { status: 'priced', amount: 1000 }, purchase: {} } }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=120' },
          })
        : null,
  });
  try {
    await w.importer().main();
    assert.equal(w.item('filament-buffer').state, 'BLOCKED');
    assert.equal(w.item('filament-buffer').blocker_code, 'VERIFY_FAILED_PERSISTENT');
    assert.equal(callsTo(w, /\/complete$/).length, 0, 'COMPLETE is never claimed');
    assert.equal(callsTo(w, /\/publish-finish$/).length, 2, 'the purge is asked again');
    const purge2 = callsTo(w, /\/publish-finish$/)[1].at;
    const nextRead = w.calls.filter((c) => c.at > purge2);
    assert.ok(nextRead.length > 0);
    assert.ok(w.logLines.some((l) => /a stale answer; purge again and wait 180 s/.test(l)), 's-maxage + 60 s');
    assert.equal(w.outputs.blocked, 'true');
  } finally {
    w.dispose();
  }
});

test('verification: what the runner records and sends as edge evidence, read from the public answers', async () => {
  const w = new World({ handles: ['ams-2-pro'] });
  try {
    await w.importer().main();
    const ev = callsTo(w, /\/complete$/)[0].body!.edge_evidence as Record<string, any>;
    assert.deepEqual(Object.keys(ev.checks).sort(), ['browser', 'compare', 'fingerprint', 'knowledge', 'listings', 'media', 'search', 'sellable', 'structure', 'v1']);
    for (const [name, c] of Object.entries(ev.checks as Record<string, { ok: boolean }>)) assert.equal(c.ok, true, name);
    assert.equal(ev.checks.v1.counts.expected_images, ev.checks.v1.counts.images);
    assert.equal(ev.checks.structure.counts.variants, 15);
    assert.equal(ev.checks.sellable.detail.quote_code, 'PRICE_NOT_AVAILABLE');
    assert.equal(ev.checks.sellable.detail.price_request_status, 401);
    assert.equal(ev.checks.fingerprint.detail.expected, ev.checks.fingerprint.detail.live);
    assert.deepEqual(ev.sections, { leaf: 'ams-filament-feeding', root: 'printer-accessories', secondary: [] });
    assert.equal(ev.live_url, 'https://levonis-iq.com/product/bambu-ams-2-pro');
    assert.ok(Array.isArray(ev.selections_checked) && ev.selections_checked[0].length === 2, 'the default selection, for the Worker\'s eligibility check');
    // The public site was read anonymously: no ops token on a site request.
    assert.ok(w.calls.every((c) => c.path.startsWith('/')));
  } finally {
    w.dispose();
  }
});

