#!/usr/bin/env node
/**
 * LEVO Printer Farm — one real session, end to end, with evidence.
 *
 * WHY THIS EXISTS. The farm is three slices (engine + routes, the game client,
 * the balancing console) built against docs/PRINTER_FARM.md. Unit tests prove
 * each slice against an in-memory D1; this script proves them as ONE game on
 * the real worker, the real migrated D1 and the BUILT dist:
 *
 *   1. a brand-new account opens the farm and receives exactly the starter kit
 *      the config promises — and a second read creates nothing more;
 *   2. the first job is accepted, assigned to the starter printer with the
 *      starter spool, printed on the server clock, collected and PAID: the
 *      balance moves by exactly `reward_coins`, reputation rises, a replayed
 *      collect (same idempotency key) pays nothing extra;
 *   3. a spool is bought at the config price and lands in the inventory;
 *   4. the public leaderboard lists the player with public fields only;
 *   5. every game page — the hub (guest and signed in), the farm's four tabs
 *      and the assign sheet, the leaderboards, the farm profile, the redeem
 *      page and the admin balancing tab — renders at 360, 390, 768 and 1024
 *      wide with no horizontal overflow and no console error, and each shot
 *      is kept under docs/evidence/farm/ as the evidence of it;
 *   6. a second job is printed on the server clock and collected FROM THE
 *      BROWSER: the collect notice the page shows (paid / failed / deferred)
 *      is checked against the ledger the server wrote, and the printer sheet
 *      after the hand-over is shot too.
 *
 * Every number asserted below comes from a server response or the public
 * config the server sent; the script never computes an outcome itself.
 *
 *   npm run build
 *   npx wrangler d1 migrations apply levonis-db --local
 *   npx wrangler dev --local --port 8787         (another shell)
 *   node scripts/e2e-farm.mjs
 *
 * Env: BASE_URL (default http://127.0.0.1:8787), SHOTS_DIR (default
 * docs/evidence/farm), PROMOTE_CMD (a shell template with {SQL}, default the
 * local D1), CHROMIUM_PATH.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'docs', 'evidence', 'farm');
const MAX_SHOT_BYTES = 400 * 1024;
/** Longest real wait the script accepts for the first print before it asks the admin console for a faster clock. */
const MAX_REAL_WAIT_S = 180;
const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
];

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
  }
}

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 160) => JSON.stringify(v ?? null).slice(0, n);

const rnd = Math.random().toString(36).slice(2, 8);
let keyN = 0;
/** A fresh idempotency key per intent (8–80 chars), reused only when a replay is the point. */
const key = (tag) => `e2e-${tag}-${rnd}-${(keyN++).toString(36)}`;

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(method, p, body) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data, headers: res.headers };
  }
  get(p) {
    return this.req('GET', p);
  }
  post(p, b) {
    return this.req('POST', p, b);
  }
  put(p, b) {
    return this.req('PUT', p, b);
  }
  cookiePair() {
    const i = this.cookie.indexOf('=');
    return { name: this.cookie.slice(0, i), value: this.cookie.slice(i + 1), domain: '127.0.0.1', path: '/' };
  }
}

/** Promotes an account outside the API (the controlled bootstrap), like scripts/api-tests.mjs. */
const sql = (statement) => {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' });
};

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  console.log(`\nLEVO PRINTER FARM — ${BASE}\n`);

  // ----------------------------------------------------------- accounts
  section('1. accounts');
  const player = new Client();
  const admin = new Client();
  const anon = new Client();
  const playerEmail = `farm-${rnd}@test.local`;
  const adminEmail = `farm-admin-${rnd}@test.local`;
  const username = `farm${rnd}`;
  let r = await player.post('/api/auth/register', { email: playerEmail, username, name: 'Farm Tester', password: 'farm-tester-pass-1' });
  check('a new player registers and holds a session at once', r.status === 200 && !!player.cookie, `status=${r.status}`);
  r = await admin.post('/api/auth/register', { email: adminEmail, username: `farmadm${rnd}`, name: 'Farm Admin', password: 'farm-admin-pass-1' });
  check('an admin account registers', r.status === 200 && !!admin.cookie, `status=${r.status}`);
  sql(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  r = await admin.get('/api/auth/me');
  check('and is promoted through the controlled bootstrap', r.data?.user?.isAdmin === true, short(r.data));
  check('a guest is refused the farm state', (await anon.get('/api/farm/state')).status === 401);

  // ---------------------------------------------------------- bootstrap
  section('2. the starter kit');
  const s1 = await player.get('/api/farm/state');
  check('GET /api/farm/state answers', s1.status === 200 && s1.data?.success === true, `status=${s1.status} ${short(s1.data)}`);
  const cfg = s1.data?.config;
  if (!cfg) throw new Error('no public config in the state — nothing below can be asserted');
  const starter = cfg.starter;
  const st = s1.data;
  const printer0 = st.printers[0];
  const spool0 = st.spools[0];
  check(
    'one starter printer, the configured model, in slot 0, idle and healthy',
    st.printers.length === 1 && printer0.model_key === starter.printer_model && printer0.slot === 0 && printer0.state === 'idle' && printer0.health === 100,
    short(st.printers)
  );
  check(
    'one starter spool of the configured material, colour and grams',
    st.spools.length === 1 && spool0.material === starter.spool.material && spool0.color === starter.spool.color && spool0.grams_left === starter.spool.grams && spool0.grams_total === starter.spool.grams,
    short(st.spools)
  );
  check('coins equal the configured starter coins', st.profile.coins === cfg.economy.starter_coins, `coins=${st.profile.coins} starter=${cfg.economy.starter_coins}`);
  check('level 1, no xp, reputation at the configured start', st.profile.level === 1 && st.profile.xp === 0 && st.profile.reputation_bp === cfg.progression.reputation_start_bp, short(st.profile));
  const offered = st.jobs.offered;
  const first = offered.find((j) => j.id.startsWith('fjob_first_')) ?? offered.find((j) => j.product_key === starter.first_job?.product);
  check('at least one offer is on the board and one of them is the first job', offered.length >= 1 && !!first, short(offered.map((j) => `${j.id}:${j.product_key}`)));
  check(
    'the first job matches the starter template (product, qty, material of the starter spool)',
    !!first && first.product_key === starter.first_job.product && first.qty === starter.first_job.qty && first.material === spool0.material && first.colors.includes(spool0.color),
    short(first)
  );
  check('the first job needs less filament than the starter spool holds', !!first && first.grams <= spool0.grams_left, `grams=${first?.grams} spool=${spool0.grams_left}`);
  check('the first job is priced above zero and earns reputation', !!first && first.reward_coins > 0 && first.reputation_gain_bp > 0, short(first));
  check('unlocks are flags and STORE/UPGRADES are closed in Phase 1', st.unlocks && st.unlocks.market === true && st.unlocks.store === false && st.unlocks.upgrades === false, short(st.unlocks));
  check('the state carries unlock levels and limits for the client', typeof st.unlock_levels?.store === 'number' && typeof st.limits?.max_active_jobs === 'number', short({ u: st.unlock_levels, l: st.limits }));

  const ledger1 = await player.get('/api/farm/ledger');
  check(
    'the ledger holds exactly one row: the starter grant, and its running balance is the balance',
    ledger1.status === 200 && ledger1.data.entries.length === 1 && ledger1.data.entries[0].kind === 'starter' && ledger1.data.entries[0].amount === cfg.economy.starter_coins && ledger1.data.entries[0].balance_after === st.profile.coins,
    short(ledger1.data)
  );

  const s2 = await player.get('/api/farm/state');
  const ledger2 = await player.get('/api/farm/ledger');
  check(
    'a second GET /state creates nothing new (same printer, spool, offers, coins; still one ledger row)',
    s2.status === 200 &&
      s2.data.printers.map((p) => p.id).join() === st.printers.map((p) => p.id).join() &&
      s2.data.spools.map((p) => p.id).join() === st.spools.map((p) => p.id).join() &&
      s2.data.jobs.offered.map((j) => j.id).sort().join() === offered.map((j) => j.id).sort().join() &&
      s2.data.profile.coins === st.profile.coins &&
      ledger2.data.entries.length === 1,
    short({ p: s2.data.printers.length, s: s2.data.spools.length, o: s2.data.jobs.offered.length, l: ledger2.data.entries.length })
  );

  const cfgRes = await player.get('/api/farm/config');
  const etag = cfgRes.headers.get('etag');
  check('GET /config carries an ETag and answers 304 to it', cfgRes.status === 200 && !!etag && (await fetch(`${BASE}/api/farm/config`, { headers: { Cookie: player.cookie, 'If-None-Match': etag } })).status === 304, `etag=${etag}`);
  check('the public config never carries limits or the rewards budget', cfgRes.data?.config && cfgRes.data.config.limits === undefined && cfgRes.data.config.rewards === undefined, Object.keys(cfgRes.data?.config ?? {}).join());

  // ----------------------------------------------- the admin console read
  section('3. the balancing console');
  const adminCfg = await admin.get('/api/admin/farm/config');
  check(
    'an admin reads the versioned config with defaults, the public projection and no problems',
    adminCfg.status === 200 && typeof adminCfg.data.version === 'number' && adminCfg.data.config && adminCfg.data.defaults && adminCfg.data.public && Array.isArray(adminCfg.data.problems) && adminCfg.data.problems.length === 0 && Array.isArray(adminCfg.data.sections) && adminCfg.data.sections.includes('time'),
    `status=${adminCfg.status} ${short({ v: adminCfg.data?.version, problems: adminCfg.data?.problems, sections: adminCfg.data?.sections })}`
  );
  check('a player is refused the admin console', (await player.get('/api/admin/farm/config')).status === 403);
  check('the config cannot promise a Points conversion', (await admin.put('/api/admin/farm/config/rewards', { value: { ...adminCfg.data.config.rewards, levonis_points: { ...adminCfg.data.config.rewards.levonis_points, enabled: true } }, expected_version: adminCfg.data.version })).status === 400);
  check('the generic settings route refuses the farm key', (await admin.put('/api/admin/settings/printerFarmConfig', { value: {} })).status === 400);

  // The first print runs on the server clock; the estimate below only decides
  // whether the wait is too long for a script (the server's ends_at is what is
  // actually waited on). If it is, the admin console makes the game clock
  // faster BEFORE the job is assigned — the assignment fixes its own ends_at.
  const model = cfg.printers[printer0.model_key];
  const refSpeed = cfg.time.reference_speed_mms ?? model.speed;
  const estRealS = (first.print_seconds * (refSpeed / model.speed) * (cfg.quality[first.quality]?.time_factor ?? 1)) / cfg.time.time_scale;
  console.log(`  ·    first job estimate: ${first.print_seconds} game s → ~${Math.round(estRealS)} real s at time_scale ${cfg.time.time_scale}`);
  if (estRealS > MAX_REAL_WAIT_S) {
    const scale = Math.ceil(cfg.time.time_scale * (estRealS / 120));
    const put = await admin.put('/api/admin/farm/config/time', { value: { ...adminCfg.data.config.time, time_scale: scale }, expected_version: adminCfg.data.version });
    check(`the admin console raises time_scale to ${scale} so the print fits the script`, put.status === 200 && put.data.version === adminCfg.data.version + 1, `status=${put.status} ${short(put.data)}`);
    const stale = await admin.put('/api/admin/farm/config/time', { value: { ...adminCfg.data.config.time, time_scale: scale }, expected_version: adminCfg.data.version });
    check('a stale version is refused with 409', stale.status === 409 && stale.data?.code === 'CONFIG_VERSION_MISMATCH', short(stale.data));
    const fresh = await player.get('/api/farm/state');
    check('the player sees the new config version', fresh.data.config_version === put.data.version, `v=${fresh.data.config_version}`);
  }

  // ------------------------------------------------------- accept + assign
  section('4. the first job');
  const acc = await player.post(`/api/farm/jobs/${first.id}/accept`, { idempotencyKey: key('accept') });
  check('the first job is accepted', acc.status === 200 && acc.data.job_id === first.id && acc.data.replayed === false, `status=${acc.status} ${short(acc.data)}`);
  check('the mutation answers with the whole state (no config)', typeof acc.data.now === 'string' && Array.isArray(acc.data.printers) && acc.data.config === undefined && acc.data.jobs.active.some((j) => j.id === first.id && j.state === 'accepted'), short(acc.data.jobs));
  const again = await player.post(`/api/farm/jobs/${first.id}/accept`, { idempotencyKey: key('accept2') });
  check('accepting it again is refused, not duplicated', again.status === 409 && again.data?.code === 'JOB_NOT_OFFERED', `status=${again.status} ${short(again.data)}`);

  const coinsBeforeAssign = acc.data.profile.coins;
  const asg = await player.post(`/api/farm/jobs/${first.id}/assign`, {
    allocations: [{ printer_id: printer0.id, qty: first.qty, spool_id: spool0.id }],
    quality: first.quality,
    idempotencyKey: key('assign'),
  });
  const batch = asg.data?.assignments?.[0];
  check('the job is assigned to the starter printer with the starter spool and starts at once', asg.status === 200 && !!batch && batch.printer_id === printer0.id && batch.qty === first.qty && batch.started === true && typeof batch.ends_at === 'string', `status=${asg.status} ${short(asg.data)}`);
  const printerAfter = asg.data?.printers?.find((p) => p.id === printer0.id);
  const spoolAfter = asg.data?.spools?.find((s) => s.id === spool0.id);
  check('the printer is printing that batch and the grams are reserved off the spool', printerAfter?.state === 'printing' && printerAfter?.current?.assignment_id === batch?.assignment_id && spoolAfter?.grams_left === spool0.grams_left - first.grams, short({ p: printerAfter?.state, cur: printerAfter?.current?.assignment_id, grams: spoolAfter?.grams_left }));
  check('assigning moves no coins', asg.data?.profile?.coins === coinsBeforeAssign, `coins=${asg.data?.profile?.coins}`);
  check('the job is now printing', asg.data?.jobs?.active?.find((j) => j.id === first.id)?.state === 'printing');
  const early = await player.post(`/api/farm/printers/${printer0.id}/collect`, { idempotencyKey: key('early') });
  check('collecting before the print ends is refused', early.status === 409 && early.data?.code === 'PRINT_NOT_FINISHED', `status=${early.status} ${short(early.data)}`);

  // ------------------------------------------------------------- the wait
  section('5. the print, on the server clock');
  const waitFor = async (endsAtIso) => {
    const endsAt = Date.parse(endsAtIso);
    const deadline = endsAt + 90_000;
    let last = null;
    for (;;) {
      const s = await player.get('/api/farm/state?config=0');
      if (s.status !== 200) throw new Error(`state ${s.status}: ${short(s.data)}`);
      last = s.data;
      const p = last.printers.find((x) => x.id === printer0.id);
      const ended = p?.current && p.current.state !== 'printing';
      const serverNow = Date.parse(last.now);
      if (ended) return last;
      if (serverNow >= endsAt + 5_000) throw new Error(`the server clock passed ends_at but the batch still prints: ${short(p)}`);
      if (Date.now() > deadline) throw new Error('timed out waiting for the print');
      await sleep(Math.min(5_000, Math.max(1_000, endsAt - serverNow + 1_000)));
    }
  };
  let endsAt = batch.ends_at;
  console.log(`  ·    waiting until ${endsAt} (~${Math.max(0, Math.round((Date.parse(endsAt) - Date.now()) / 1000))} s)`);
  let done = await waitFor(endsAt);
  let cur = done.printers.find((p) => p.id === printer0.id).current;
  check('the batch ended on the server clock, with a server-decided outcome', cur && (cur.state === 'done' || cur.state === 'failed'), short(cur));
  check('the events of the print are recorded', Array.isArray(done.events_unseen) && done.events_unseen.some((e) => e.kind === 'print_done' || e.kind === 'print_failed'), short(done.events_unseen.map((e) => e.kind)));

  // A failure is a legitimate, seeded outcome (health, reliability, material
  // and complexity all weigh in). The game's answer to it is to clear the bed
  // and print the missing parts again — so that is what the script does.
  let attempts = 0;
  while (cur.state === 'failed' && attempts < 3) {
    attempts++;
    console.log(`  ·    the print FAILED (${cur.failure_kind}) — clearing the bed and printing the missing parts again (attempt ${attempts})`);
    const coinsBefore = done.profile.coins;
    const col = await player.post(`/api/farm/printers/${printer0.id}/collect`, { idempotencyKey: key('collect-failed') });
    check('a failed batch is collected without pay', col.status === 200 && col.data.collected?.outcome === 'failed' && col.data.delivered === null && col.data.profile.coins === coinsBefore, short(col.data));
    const p = col.data.printers.find((x) => x.id === printer0.id);
    if (p.state === 'broken') {
      const rep = await player.post(`/api/farm/printers/${printer0.id}/repair`, { idempotencyKey: key('repair') });
      check('a broken printer is repaired at the configured cost', rep.status === 200 && rep.data.cost === cfg.economy.repair.cost, short(rep.data));
      await waitForService(player, printer0.id, rep.data.state_until);
    }
    const job = col.data.jobs.active.find((j) => j.id === first.id);
    const remaining = job?.assignments_summary?.remaining ?? first.qty;
    const spool = col.data.spools.find((s) => s.id === spool0.id);
    if (!spool || spool.grams_left < (first.grams / first.qty) * remaining) {
      const buy = await player.post('/api/farm/market/filament', { material: spool0.material, color: spool0.color, grams: Math.min(...cfg.economy.spool_sizes_g), idempotencyKey: key('refill') });
      check('a refill spool is bought for the retry', buy.status === 200, short(buy.data));
    }
    const state = (await player.get('/api/farm/state?config=0')).data;
    const usable = state.spools.find((s) => s.material === first.material && first.colors.includes(s.color) && s.grams_left >= (first.grams / first.qty) * remaining);
    const re = await player.post(`/api/farm/jobs/${first.id}/assign`, { allocations: [{ printer_id: printer0.id, qty: remaining, spool_id: usable.id }], quality: first.quality, idempotencyKey: key('reassign') });
    check('the missing parts are assigned again', re.status === 200 && re.data.assignments?.[0]?.started === true, short(re.data));
    endsAt = re.data.assignments[0].ends_at;
    console.log(`  ·    waiting until ${endsAt}`);
    done = await waitFor(endsAt);
    cur = done.printers.find((p) => p.id === printer0.id).current;
  }
  check('the parts printed', cur.state === 'done', short(cur));
  const kwhRows = (await player.get('/api/farm/ledger')).data.entries.filter((e) => e.kind === 'electricity');
  check('electricity for the finished batch was debited by the resolver, if the config charges for it', cfg.economy.energy.coins_per_kwh === 0 || kwhRows.length >= 1, short(kwhRows));

  // ------------------------------------------------------- collect + pay
  section('6. delivery');
  const coinsBeforeCollect = done.profile.coins;
  const repBefore = done.profile.reputation_bp;
  const collectKey = key('collect');
  const col = await player.post(`/api/farm/printers/${printer0.id}/collect`, { idempotencyKey: collectKey });
  check('the finished batch is collected and the job delivered in the same batch', col.status === 200 && col.data.collected?.outcome === 'done' && col.data.delivered?.job_id === first.id, `status=${col.status} ${short(col.data)}`);
  check('coins rose by EXACTLY reward_coins', col.data.profile?.coins === coinsBeforeCollect + first.reward_coins, `before=${coinsBeforeCollect} after=${col.data.profile?.coins} reward=${first.reward_coins}`);
  check('the payout the server reports is the offer\'s reward', col.data.delivered?.reward_coins === first.reward_coins && col.data.delivered?.late === false, short(col.data.delivered));
  check('reputation rose', col.data.profile?.reputation_bp > repBefore && col.data.delivered?.reputation_bp === col.data.profile?.reputation_bp, `before=${repBefore} after=${col.data.profile?.reputation_bp}`);
  check('the stats count one delivery and the job left the active list', col.data.profile?.stats?.delivered === 1 && !col.data.jobs.active.some((j) => j.id === first.id), short(col.data.profile?.stats));
  check('the printer is idle again with nothing on the bed', col.data.printers.find((p) => p.id === printer0.id)?.state === 'idle' && col.data.printers.find((p) => p.id === printer0.id)?.current === null);
  const payouts = (await player.get('/api/farm/ledger')).data.entries.filter((e) => e.kind === 'job_payout');
  check('one job_payout row of reward_coins is in the ledger', payouts.length === 1 && payouts[0].amount === first.reward_coins && payouts[0].ref_id === first.id, short(payouts));

  const replay = await player.post(`/api/farm/printers/${printer0.id}/collect`, { idempotencyKey: collectKey });
  check('a replayed collect with the same key is a no-op: replayed=true, same coins', replay.status === 200 && replay.data.replayed === true && replay.data.profile.coins === col.data.profile.coins, `status=${replay.status} ${short(replay.data)}`);
  const payouts2 = (await player.get('/api/farm/ledger')).data.entries.filter((e) => e.kind === 'job_payout');
  check('and the ledger still holds one payout', payouts2.length === 1);
  const reuse = await player.post('/api/farm/market/filament', { material: spool0.material, color: spool0.color, grams: Math.min(...cfg.economy.spool_sizes_g), idempotencyKey: collectKey });
  check('the same key for a different intent is refused', reuse.status === 409 && reuse.data?.code === 'IDEMPOTENCY_KEY_REUSED', `status=${reuse.status} ${short(reuse.data)}`);

  // ---------------------------------------------------------- the market
  section('7. the market');
  const grams = Math.min(...cfg.economy.spool_sizes_g);
  const material = cfg.materials[spool0.material];
  const cost = Math.ceil(material.price_per_gram * grams);
  const coinsBeforeBuy = replay.data.profile.coins;
  const buy = await player.post('/api/farm/market/filament', { material: spool0.material, color: spool0.color, grams, idempotencyKey: key('buy') });
  check('a spool is bought at price_per_gram × grams', buy.status === 200 && buy.data.cost === cost && buy.data.profile.coins === coinsBeforeBuy - cost, `status=${buy.status} cost=${buy.data?.cost} expected=${cost} coins=${buy.data?.profile?.coins}`);
  const bought = buy.data?.spools?.find((s) => s.id === buy.data.spool_id);
  check('the new spool appears in the inventory, full', buy.data?.spools?.length === 2 && !!bought && bought.grams_left === grams && bought.material === spool0.material && bought.color === spool0.color, short(buy.data?.spools));
  const unknown = await player.post('/api/farm/market/filament', { material: spool0.material, color: spool0.color, grams: 7, idempotencyKey: key('size') });
  check('a spool size the config does not sell is refused', unknown.status === 400 && unknown.data?.code === 'SPOOL_SIZE_UNKNOWN', short(unknown.data));
  const dear = Object.entries(cfg.printers).sort((a, b) => b[1].price - a[1].price)[0];
  const poor = await player.post('/api/farm/market/printers', { model_key: dear[0], idempotencyKey: key('h2c') });
  check('the dearest printer is refused (level or coins), nothing bought', poor.status >= 400 && (poor.data?.code === 'LEVEL_TOO_LOW' || poor.data?.code === 'INSUFFICIENT_COINS'), short(poor.data));
  const afterPoor = await player.get('/api/farm/state?config=0');
  check('and the farm is unchanged by the refusal', afterPoor.data.printers.length === 1 && afterPoor.data.profile.coins === buy.data.profile.coins);

  // A second offer accepted (not assigned) so the assign sheet has something
  // to show in the browser; the hub and jobs tab then carry a real active job.
  const offers = afterPoor.data.jobs.offered;
  const second = offers.find((j) => j.material === spool0.material && j.colors.every((c) => c === spool0.color)) ?? offers[0];
  if (second) {
    const acc2 = await player.post(`/api/farm/jobs/${second.id}/accept`, { idempotencyKey: key('accept-second') });
    check('a second offer is accepted for the assign sheet', acc2.status === 200, short(acc2.data));
  }

  // -------------------------------------------------------- leaderboard
  section('8. the public leaderboard');
  const ALLOWED = new Set(['rank', 'username', 'avatar_key', 'farm_name', 'score']);
  for (const board of ['reputation', 'farm_value', 'jobs_delivered']) {
    const lb = await anon.get(`/api/farm/leaderboard?board=${board}&limit=50`);
    const mine = lb.data?.rows?.find((row) => row.username === username);
    check(`board ${board} lists the player, signed out`, lb.status === 200 && lb.data.board === board && !!mine, short(lb.data));
    check(`board ${board} rows carry public fields only`, (lb.data?.rows ?? []).every((row) => Object.keys(row).every((k) => ALLOWED.has(k))), short(lb.data?.rows?.[0]));
    if (board === 'reputation') check('the reputation score is the server\'s basis points', mine?.score === col.data.profile.reputation_bp, `score=${mine?.score}`);
    if (board === 'jobs_delivered') check('the delivered score is 1', mine?.score === 1, `score=${mine?.score}`);
  }
  check('an unknown board is refused', (await anon.get('/api/farm/leaderboard?board=coins')).status === 400);

  // -------------------------------------------------------- the browser
  section('9. every page, at every width');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  try {
    for (const vp of VIEWPORTS) {
      const w = vp.width;
      const guest = await newVisitor(browser, vp, null);
      await visit(guest, '/games', `games-guest-${w}`, '[data-hub-farm]', (t) => !t.includes(username));
      await guest.ctx.close();

      const me = await newVisitor(browser, vp, player.cookiePair());
      await visit(me, '/games', `games-${w}`, '[data-hub-farm-summary]', (t) => t.includes(username));
      const farm = await visit(me, '/games/printer-farm', `farm-${w}`, '[data-farm-page]');
      if (farm) {
        const slots = await me.page.locator('[data-farm-slot]').count();
        const tabs = await me.page.locator('[data-farm-tab]').count();
        check(`farm ${w}: the room has slots and the bar has six tabs`, slots >= 1 && tabs === 6, `slots=${slots} tabs=${tabs}`);
        check(`farm ${w}: the room is inline SVG, no canvas`, (await me.page.locator('canvas').count()) === 0 && (await me.page.locator('[data-farm-room] svg').count()) >= 1);
        const tabH = await me.page.evaluate(() => Math.min(...[...document.querySelectorAll('[data-farm-tab]')].map((el) => el.getBoundingClientRect().height)));
        check(`farm ${w}: every tab is at least 44 px tall`, tabH >= 44, `min=${tabH}`);
        if (w === 360) {
          // On a phone the printer window is a bottom Sheet whose draggable
          // panel carries its own ref; initial focus must still land INSIDE the
          // aria-modal dialog, and the dialog must have a name (a nameless
          // machine is called "<model> <slot>").
          await me.page.focus('[data-farm-slot-button="0"]');
          await me.page.keyboard.press('Enter');
          await me.page.waitForTimeout(900);
          const focus = await me.page.evaluate(() => {
            const panel = document.querySelector('[data-overlay="farm-printer-sheet"] [data-overlay-panel]');
            const a = document.activeElement;
            const by = panel?.getAttribute('aria-labelledby');
            const name = by ? (document.getElementById(by)?.textContent ?? '').trim() : (panel?.getAttribute('aria-label') ?? '').trim();
            return { panel: !!panel, modal: panel?.getAttribute('aria-modal'), inside: !!(panel && a && panel.contains(a)), name };
          });
          check(`farm ${w}: the printer sheet opens and document.activeElement is inside [data-overlay-panel]`, focus.panel && focus.modal === 'true' && focus.inside, JSON.stringify(focus));
          check(`farm ${w}: the printer sheet has a non-empty accessible name`, focus.name.length > 0, JSON.stringify(focus));
          await me.page.keyboard.press('Escape');
          await me.page.waitForTimeout(600);
          check(`farm ${w}: Escape closes the sheet`, (await me.page.locator('[data-overlay="farm-printer-sheet"]').count()) === 0);
          // A locked tab is tappable (aria-disabled, not disabled) and says why
          // instead of switching — the title alone is unreachable on a phone.
          // Playwright's own actionability gate treats aria-disabled as "not
          // enabled" and would wait forever; a finger does not, so the tap is
          // forced — the assertion below is what judges the element.
          await me.page.tap('[data-farm-tab="store"]', { force: true });
          await me.page.waitForTimeout(500);
          const locked = await me.page.evaluate(() => {
            const el = document.querySelector('[data-farm-tab="store"]');
            return { selected: el?.getAttribute('aria-selected'), ariaDisabled: el?.getAttribute('aria-disabled'), disabled: el?.hasAttribute('disabled'), hint: document.querySelectorAll('[data-farm-notice="hint"]').length, text: (document.querySelector('[data-farm-notice="hint"]')?.textContent ?? '').trim() };
          });
          check(`farm ${w}: tapping the locked STORE tab shows the reason and does not switch`, locked.selected === 'false' && locked.ariaDisabled === 'true' && locked.disabled === false && locked.hint === 1 && locked.text.length > 0, JSON.stringify(locked));
          check(`farm ${w}: the back button is a 44px control`, await me.page.evaluate(() => { const r = document.querySelector('[data-games-header] button')?.getBoundingClientRect(); return !!r && r.width >= 44 && r.height >= 44; }));
        }
        for (const tab of ['jobs', 'market', 'inventory']) {
          await me.page.click(`[data-farm-tab="${tab}"]`);
          await me.page.waitForTimeout(900);
          await measureAndShoot(me, `farm-${tab}-${w}`, `[data-farm-tab="${tab}"][aria-selected="true"]`);
        }
        // The assign sheet, from the JOBS tab's active job.
        await me.page.click('[data-farm-tab="jobs"]');
        await me.page.waitForTimeout(700);
        if (w === 360) {
          // Bidi: an Arabic duration cell ("1س 18د") must keep every number+unit
          // token intact, the unit letter drawn immediately LEFT of its digits
          // — read per character from the glyph boxes, not from the DOM order.
          const bidi = await me.page.evaluate(() => {
            const el = [...document.querySelectorAll('[data-farm-offer] [data-farm-duration]')].find((e) => /[؀-ۿ]/.test(e.textContent || '') && /\d/.test(e.textContent || ''));
            if (!el) return null;
            const chars = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              for (let i = 0; i < node.data.length; i++) {
                const range = document.createRange();
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                const r = range.getBoundingClientRect();
                // The isolate format characters are zero-width (a sub-pixel box at most): only drawn glyphs count.
                if (r.width > 0.5) chars.push({ ch: node.data[i], x: r.left, line: Math.round(r.top / 4) });
              }
            }
            const visual = chars.sort((a, b) => a.line - b.line || a.x - b.x).map((c) => c.ch).join('');
            const logical = (el.textContent || '').replace(/[⁦-⁩]/g, '');
            const tokens = [...logical.matchAll(/(\d+)([؀-ۿ])/g)].map((m) => m[2] + m[1]);
            return { logical, visual, tokens, ok: tokens.length > 0 && tokens.every((t) => visual.includes(t)) };
          });
          if (bidi) check(`farm ${w}: Arabic duration tokens keep their order (unit left of its digits)`, bidi.ok, JSON.stringify(bidi));
          else console.log('  ·    no Arabic offer card with a duration on screen — bidi order not checked');
        }
        const assignBtn = me.page.locator('[data-farm-action="assign-job"]').first();
        if (check(`farm ${w}: an active job offers "assign"`, (await assignBtn.count()) > 0)) {
          await assignBtn.click();
          await me.page.waitForTimeout(900);
          const sheet = me.page.locator('[data-overlay="farm-job-sheet"]');
          check(`farm ${w}: the assign sheet opens`, (await sheet.count()) > 0 && (await sheet.first().isVisible()));
          const allocs = await me.page.locator('[data-farm-alloc]').count();
          check(`farm ${w}: the sheet lists the owned printer`, allocs >= 1, `allocs=${allocs}`);
          await measureAndShoot(me, `farm-job-sheet-${w}`, '[data-overlay="farm-job-sheet"]');
          await me.page.keyboard.press('Escape');
          await me.page.waitForTimeout(500);
        }
      }
      await visit(me, '/leaderboards', `leaderboards-${w}`, '[data-lb-row]', (t) => t.includes(username));
      await visit(me, '/games/profile', `profile-${w}`, '[data-profile-head]', (t) => t.includes(username));
      await visit(me, '/games/redeem', `redeem-${w}`, '[data-testid="redeem-closed"]');
      await me.ctx.close();

      const boss = await newVisitor(browser, vp, admin.cookiePair());
      await boss.page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' }).catch(() => {});
      await boss.page.waitForTimeout(2500);
      // The tab hook exists twice — the desktop sidebar (hidden below lg) and
      // the phone drawer — so only the VISIBLE one counts; on a phone the
      // drawer is opened first through its stable `data-action` hook.
      let tabBtn = boss.page.locator('[data-tab="printer_farm"]:visible');
      if (!(await tabBtn.count())) {
        const menu = boss.page.locator('button[data-action="open-sidebar"]:visible').first();
        if (await menu.count()) {
          await menu.click();
          await boss.page.waitForTimeout(700);
        }
        tabBtn = boss.page.locator('[data-tab="printer_farm"]:visible');
      }
      if (check(`admin ${w}: the Printer Farm tab is reachable`, (await tabBtn.count()) > 0 && (await tabBtn.first().isVisible()))) {
        await tabBtn.first().click();
        await boss.page.waitForTimeout(2500);
        const version = await boss.page.locator('[data-farm-version]').count();
        const sections = await boss.page.locator('[data-farm-sections] > *').count();
        check(`admin ${w}: the console shows the version chip and every section`, version === 1 && sections >= adminCfg.data.sections.length, `version=${version} sections=${sections}`);
        await measureAndShoot(boss, `admin-farm-${w}`, '[data-farm-admin]');
      }
      check(`admin ${w}: no console error`, boss.errors.length === 0, boss.errors.join(' | ').slice(0, 300));
      await boss.ctx.close();
    }

    // ------------------------------------------- collect, from the browser
    // The first job was collected over the API (§6). The page's own Collect
    // must tell the player what the server did with the batch — paid, failed
    // or payout deferred by the daily cap — so the second job is printed now
    // (the game clock raised first so the print fits the script) and collected
    // by clicking the card. The notice is then checked against the ledger.
    section('10. the collect notice, in the browser');
    let timeBefore = null;
    if (second) {
      const cur0 = await admin.get('/api/admin/farm/config');
      const model0 = cfg.printers[printer0.model_key];
      const scaleNow = cur0.data.config.time.time_scale;
      const est2 = (second.print_seconds * (refSpeed / model0.speed) * (cfg.quality[second.quality]?.time_factor ?? 1)) / scaleNow;
      console.log(`  ·    second job estimate: ${second.print_seconds} game s → ~${Math.round(est2)} real s at time_scale ${scaleNow}`);
      if (est2 > 45) {
        const scale = Math.ceil(scaleNow * (est2 / 30));
        timeBefore = { value: cur0.data.config.time, version: cur0.data.version };
        const put = await admin.put('/api/admin/farm/config/time', { value: { ...cur0.data.config.time, time_scale: scale }, expected_version: cur0.data.version });
        check(`the admin console raises time_scale to ${scale} so the second print fits the script`, put.status === 200, `status=${put.status} ${short(put.data)}`);
        timeBefore.version = put.data?.version ?? timeBefore.version;
      }
      let st2 = (await player.get('/api/farm/state?config=0')).data;
      const perPart = second.grams / second.qty;
      const usableFor = (state) => state.spools.find((sp) => sp.material === second.material && second.colors.every((c) => c === sp.color) && sp.grams_left >= perPart * second.qty);
      let spool2 = usableFor(st2);
      if (!spool2) {
        const size = cfg.economy.spool_sizes_g.filter((g) => g >= perPart * second.qty).sort((a, b) => a - b)[0];
        if (size) {
          const buy2 = await player.post('/api/farm/market/filament', { material: second.material, color: second.colors[0], grams: size, idempotencyKey: key('buy-second') });
          check('a spool for the second job is bought', buy2.status === 200, short(buy2.data));
          st2 = buy2.data;
          spool2 = usableFor(st2);
        }
      }
      if (check('a spool that fits the second job is on the shelf', !!spool2, short(st2.spools))) {
        const asg2 = await player.post(`/api/farm/jobs/${second.id}/assign`, { allocations: [{ printer_id: printer0.id, qty: second.qty, spool_id: spool2.id }], quality: second.quality, idempotencyKey: key('assign-second') });
        if (check('the second job is assigned to the starter printer and starts', asg2.status === 200 && asg2.data.assignments?.[0]?.started === true, `status=${asg2.status} ${short(asg2.data)}`)) {
          console.log(`  ·    waiting until ${asg2.data.assignments[0].ends_at} (~${Math.max(0, Math.round((Date.parse(asg2.data.assignments[0].ends_at) - Date.now()) / 1000))} s)`);
          const ended = await waitFor(asg2.data.assignments[0].ends_at);
          const bed = ended.printers.find((p) => p.id === printer0.id).current;
          check('the second batch ended on the server clock', bed && (bed.state === 'done' || bed.state === 'failed'), short(bed));
          const coinsBefore2 = ended.profile.coins;
          const payoutsBefore = (await player.get('/api/farm/ledger')).data.entries.filter((e) => e.kind === 'job_payout' && e.ref_id === second.id).length;

          const vp = VIEWPORTS[1];
          const me = await newVisitor(browser, vp, player.cookiePair());
          await me.page.goto(`${BASE}/games/printer-farm`, { waitUntil: 'networkidle' }).catch(() => {});
          await me.page.waitForTimeout(1100);
          const collectBtn = me.page.locator(`[data-farm-machine="${printer0.id}"] [data-farm-action="collect"]`);
          if (check(`farm ${vp.width}: the machine card offers Collect for the finished batch`, (await collectBtn.count()) === 1)) {
            await collectBtn.click();
            await me.page.waitForSelector('[data-farm-notice="collect"] [data-farm-collect-kind]', { timeout: 15_000 }).catch(() => {});
            await me.page.waitForTimeout(700);
            const note = await me.page.evaluate(() => {
              const region = document.querySelector('[data-farm-notice="collect"]');
              const el = region?.querySelector('[data-farm-collect-kind]');
              const noteEl = region?.querySelector('[role="note"]');
              return {
                live: region?.getAttribute('aria-live'),
                kind: el?.getAttribute('data-farm-collect-kind') ?? null,
                tone: noteEl?.getAttribute('data-note-tone') ?? null,
                text: (el?.textContent ?? '').replace(/[\u2068\u2069]/g, ''),
                closeH: region?.querySelector('button')?.getBoundingClientRect().height ?? 0,
              };
            });
            // The server's own account of the same collect: the ledger and the job.
            const after = (await player.get('/api/farm/state?config=0')).data;
            const payoutsAfter = (await player.get('/api/farm/ledger')).data.entries.filter((e) => e.kind === 'job_payout' && e.ref_id === second.id);
            const paid = payoutsAfter.length === payoutsBefore + 1;
            const jobAfter = after.jobs.active.find((j) => j.id === second.id);
            const deferred = !!jobAfter?.payout_deferred_day;
            const failed = bed.state === 'failed';
            const expectedKind = failed ? 'failed' : paid ? 'paid' : deferred ? 'deferred' : 'parts';
            check(`farm ${vp.width}: the collect notice appears in the live region`, note.live === 'polite' && !!note.kind && note.text.length > 0, JSON.stringify(note));
            check(`farm ${vp.width}: the notice says what the server did (${expectedKind})`, note.kind === expectedKind, JSON.stringify({ note, paid, deferred, failed }));
            if (paid) {
              check(`farm ${vp.width}: the paid notice carries the server's reward (${second.reward_coins}) and the coins rose by it`, note.text.replace(/\D/g, '').includes(String(second.reward_coins)) && after.profile.coins === coinsBefore2 + second.reward_coins && note.tone === 'gold', JSON.stringify({ text: note.text, before: coinsBefore2, after: after.profile.coins }));
            }
            if (deferred) {
              check(`farm ${vp.width}: the deferred notice names the coins that wait and no payout row was written`, note.text.replace(/\D/g, '').includes(String(second.reward_coins)) && payoutsAfter.length === payoutsBefore && note.tone === 'amber', JSON.stringify({ text: note.text, job: jobAfter }));
              check(`farm ${vp.width}: the jobs tab badges the deferred payout`, (await (async () => { await me.page.click('[data-farm-tab="jobs"]'); await me.page.waitForTimeout(700); return me.page.locator(`[data-farm-payout-pending="${second.id}"]`).count(); })()) === 1);
              await me.page.click('[data-farm-tab="farm"]');
              await me.page.waitForTimeout(500);
            }
            if (failed) check(`farm ${vp.width}: a failed batch is announced without pay`, after.profile.coins === coinsBefore2 && note.tone === 'amber', JSON.stringify({ text: note.text }));
            check(`farm ${vp.width}: the notice's close control is 44px`, note.closeH >= 44, `h=${note.closeH}`);
            await measureAndShoot(me, `farm-collect-${expectedKind}-${vp.width}`, '[data-farm-notice="collect"]');
            // The printer sheet after the hand-over: idle, the bed clear, the notice repeated beside the machine.
            await me.page.click(`[data-farm-machine="${printer0.id}"] [data-farm-action="details"]`);
            await me.page.waitForTimeout(900);
            const sheetNote = await me.page.locator('[data-overlay="farm-printer-sheet"] [data-testid="farm-collect-note-sheet"]').count();
            check(`farm ${vp.width}: the printer sheet repeats the notice for this machine`, sheetNote === 1, `count=${sheetNote}`);
            const machine = after.printers.find((p) => p.id === printer0.id);
            check(`farm ${vp.width}: after the collect the server shows the printer ${failed ? 'free of the failed batch' : 'idle with a clear bed'}`, machine.current === null && (machine.state === 'idle' || machine.state === 'broken'), short(machine));
            await measureAndShoot(me, `farm-printer-sheet-after-collect-${vp.width}`, '[data-overlay="farm-printer-sheet"]');
            await me.page.keyboard.press('Escape');
            await me.page.waitForTimeout(400);
          }
          check(`farm ${vp.width}: no console error`, me.errors.length === 0, me.errors.join(' | ').slice(0, 300));
          await me.ctx.close();
        }
      }
    } else {
      console.log('  ·    no second offer was on the board — the browser collect is not exercised');
    }
    // Leave the local balancing config as it was found.
    if (timeBefore) {
      const cur1 = await admin.get('/api/admin/farm/config');
      const back = await admin.put('/api/admin/farm/config/time', { value: timeBefore.value, expected_version: cur1.data.version });
      check('the time section is restored to what the run found', back.status === 200, short(back.data));
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

/** Waits until a maintenance/repair window has passed on the server clock. */
async function waitForService(client, printerId, untilIso) {
  const until = Date.parse(untilIso);
  for (;;) {
    const s = await client.get('/api/farm/state?config=0');
    const p = s.data.printers.find((x) => x.id === printerId);
    if (p.state !== 'maintenance') return;
    if (Date.parse(s.data.now) > until + 10_000) throw new Error(`service never ended: ${short(p)}`);
    await sleep(Math.min(5_000, Math.max(1_000, until - Date.parse(s.data.now) + 1_000)));
  }
}

// ------------------------------------------------------------- browser helpers

async function newVisitor(browser, viewport, cookie) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ar', colorScheme: 'dark', hasTouch: viewport.width < 1024 });
  if (cookie) await ctx.addCookies([cookie]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // A guest's 401 on a signed-in read and a missing favicon are not errors of the page.
    if (/favicon|net::ERR_|status of (401|404)/i.test(text)) return;
    errors.push(`console: ${text.slice(0, 160)}`);
  });
  return { ctx, page, errors, width: viewport.width };
}

/** Opens a path, asserts it rendered, measures it, screenshots it, and reports console errors. */
async function visit(v, p, shot, marker, textRule) {
  v.errors.length = 0;
  await v.page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' }).catch(() => {});
  await v.page.waitForTimeout(1100);
  const landed = new URL(v.page.url()).pathname;
  const rendered = (await v.page.locator(marker).count()) > 0;
  const ok = check(`${shot}: ${p} renders (${marker})`, landed === p && rendered, `landed on ${landed}, marker=${rendered}`);
  if (textRule) {
    const text = (await v.page.locator('body').innerText().catch(() => '')) || '';
    check(`${shot}: the page shows what it should`, textRule(text), text.slice(0, 120).replace(/\n/g, ' '));
  }
  await measureAndShoot(v, shot, marker);
  check(`${shot}: no console error`, v.errors.length === 0, v.errors.join(' | ').slice(0, 300));
  return ok;
}

/** No horizontal scroll at the document AND inside the page's own scroll container; then the viewport shot. */
async function measureAndShoot(v, shot, marker) {
  const m = await v.page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const inner = [...document.querySelectorAll('[data-farm-scroll], [data-games-page] > div, [data-farm-admin], [data-overlay] > *')]
      .map((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
      .filter((x) => x.cw > 0);
    const spill = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > innerWidth + 2 && getComputedStyle(el).position !== 'fixed';
    }).length;
    return { docScroll: doc.scrollWidth, innerWidth, inner, spill };
  });
  check(
    `${shot}: no horizontal overflow (document ${m.docScroll}/${m.innerWidth})`,
    m.docScroll <= m.innerWidth && m.inner.every((x) => x.sw <= x.cw + 1),
    `inner=${JSON.stringify(m.inner)}`
  );
  const file = path.join(SHOTS, `${shot}.png`);
  await v.page.screenshot({ path: file, fullPage: false });
  const bytes = statSync(file).size;
  check(`${shot}: screenshot kept (${Math.round(bytes / 1024)} KB ≤ 400 KB)`, bytes > 0 && bytes <= MAX_SHOT_BYTES, `${bytes} bytes`);
  void marker;
}

main().catch((e) => {
  console.error(`\nABORTED: ${e?.stack || e}`);
  process.exit(1);
});
