/**
 * «تصفّح المنتجات» WORKS (owner, 2026-11-05: «make sure for اجمع النقاط is work
 * espissaly تصفّح المنتجات»; docs/DECISIONS.md row 300).
 *
 * WHAT WAS BROKEN, ON THE LIVE SITE: the clock is mounted only in the main shell
 * and /points is a full-screen route. Pressing the mission fired an event nobody
 * was listening to; then the clock mounted, read `progress_seconds: 0`, stayed
 * hidden, and sent no ping. So the seconds stayed 0 and the mission could never
 * finish, for any customer, ever.
 *
 * WHAT THIS HOLDS: the real path, against the real routes and the real clock
 * logic (src/lib/browseMissionClock.ts, all of the component but its drawing), on
 * a mocked clock that is the SERVER's clock too. Nothing is backdated in the
 * database: the mission is walked second by second, exactly as a customer does.
 * The first test and the path below fail on the code this replaced.
 *
 * Run: node --import tsx --test tests/browseMission.test.ts
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, post, proOnSale, row, count, settledPoints, stubApp, type App, type StubUser } from './fixtures/app';
import { rewardRoutes } from '../worker/routes/rewards';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import {
  IDLE_LIMIT_MS,
  PING_INTERVAL_MS,
  browseAwardText,
  clockShows,
  clockText,
  createBrowseClock,
  isPassingFailure,
  type BrowsePing,
  type BrowseView,
  type ClockState,
} from '../src/lib/browseMissionClock';

const buyer: StubUser = { id: 'u1', role: 'customer', email: 'a@x.co' };
const NOW = Date.parse('2026-11-10T09:00:00.000Z');

function world(tier?: 'pro'): { raw: DatabaseSync; app: App } {
  const raw = proOnSale(freshDb());
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','a@x.co','h','customer')`);
  if (tier) {
    raw
      .prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES ('m1','u1','pro_12mo','pro','active',12,?,?)`)
      .run(new Date(NOW - 86_400_000).toISOString(), new Date(NOW + 365 * 86_400_000).toISOString());
  }
  return { raw, app: stubApp(asD1(raw), buyer, (a) => a.route('/api/rewards', rewardRoutes), { publishV2: false }) };
}

/** The clock, wired to the real routes the way the component wires it to the API client. */
function mount(app: App, opts: { hidden?: () => boolean } = {}) {
  const log = { awards: [] as BrowsePing[], pings: 0, state: { visible: false, seconds: 0, required: 0, paused: false } as ClockState };
  let inflight: Promise<unknown> = Promise.resolve();
  const clock = createBrowseClock({
    read: async () => (await json(await get(app, '/api/rewards'))).missions.browse as BrowseView,
    ping: () => {
      log.pings++;
      const answer = Promise.resolve(post(app, '/api/rewards/browse/ping')).then(async (res) => {
        const body = await json(res);
        if (!res.ok) throw Object.assign(new Error(String(body.error)), { status: res.status, code: body.code });
        return body as unknown as BrowsePing;
      });
      inflight = answer.catch(() => undefined);
      return answer;
    },
    isHidden: opts.hidden ?? (() => false),
    onChange: (s) => (log.state = s),
    onAward: (reply) => log.awards.push(reply),
  });
  /** One ping interval of real time on the shared clock, the customer active, and its answer awaited. */
  const pass = async (ms = PING_INTERVAL_MS, active = true) => {
    if (active) clock.activity();
    mock.timers.tick(ms);
    await inflight;
    await new Promise((r) => setImmediate(r));
  };
  return { clock, log, pass };
}

function onTheClock<T>(run: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: NOW });
  return run().finally(() => mock.timers.reset());
}

// ------------------------------------------------------------ the server's one new fact

test('GET /api/rewards answers whether the ticket is open: no, yes on the press with 0 seconds on record, no once paid', async () => {
  await onTheClock(async () => {
    const { app } = world();
    const before = (await json(await get(app, '/api/rewards'))).missions.browse;
    assert.equal(before.started, false, 'nothing pressed: no ticket');

    assert.equal((await post(app, '/api/rewards/browse/start')).status, 200);
    const pressed = (await json(await get(app, '/api/rewards'))).missions.browse;
    assert.equal(pressed.started, true, 'THE FACT THE CLOCK WAS MISSING');
    assert.equal(pressed.progress_seconds, 0, 'and why today’s clock stayed hidden: no second is on record yet');
    assert.equal(pressed.claimed, false);
  });
});

test('the clock shows for an open ticket, seconds on record or a press on this page — and not for a mission paid or switched off', () => {
  const view = (o: Partial<BrowseView>): BrowseView => ({ claimed: false, available: true, required_seconds: 180, progress_seconds: 0, started: false, ...o });
  assert.equal(clockShows(view({}), false), false, 'no mission running: nothing on the screen');
  assert.equal(clockShows(view({ started: true }), false), true, 'an open ticket with 0 progress: the case that never showed');
  assert.equal(clockShows(view({ progress_seconds: 40 }), false), true);
  assert.equal(clockShows(view({}), true), true, 'pressed on this very page');
  assert.equal(clockShows(view({ started: true, claimed: true }), false), false);
  assert.equal(clockShows(view({ started: true, available: false }), true), false, 'the owner switched the mission off');
  // A server older than this code answers no `started`; `available` absent reads as on.
  assert.equal(clockShows({ claimed: false, required_seconds: 180, progress_seconds: 0 }, false), false);
});

// ------------------------------------------------------------ THE PATH

test('THE PATH: press on /points, mount in the shop with an open ticket and 0 progress → it shows, pings every 15 s → the server pays once', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    // On /points, a full-screen route: no clock is mounted, so no event can reach one.
    assert.equal((await post(app, '/api/rewards/browse/start')).status, 200);
    mock.timers.tick(5000); // the customer moves to the shop

    // The clock mounts in the shop. It has heard nothing; it only asks the server.
    const { clock, log, pass } = mount(app);
    await clock.sync();
    assert.equal(log.state.visible, true, 'it shows, with nothing on record yet');
    assert.equal(log.state.seconds, 0);
    assert.equal(log.state.required, 180);
    assert.equal(clockText(log.state), '3:00');

    for (let i = 0; i < 11; i++) {
      await pass();
      assert.equal(log.awards.length, 0, `not paid before the server's three minutes (ping ${i + 1})`);
      assert.equal(log.state.visible, true);
    }
    assert.equal(settledPoints(raw, 'u1'), 0);
    await pass();

    assert.equal(log.pings, 12, 'one ping every 15 seconds');
    assert.equal(log.awards.length, 1, 'said once');
    assert.equal(log.awards[0].awarded, true);
    assert.equal(log.awards[0].points, 20);
    assert.equal(log.state.visible, false, 'finished: the clock is gone');
    assert.equal(settledPoints(raw, 'u1'), 20, 'the points are in the ledger');
    assert.equal(count(raw, "SELECT COUNT(*) n FROM reward_claims WHERE mission='browse' AND state='awarded'"), 1);

    // No more pings once it is done, and the page says so.
    await pass();
    assert.equal(log.pings, 12);
    const after = (await json(await get(app, '/api/rewards'))).missions.browse;
    assert.equal(after.claimed, true);
    assert.equal(after.started, false);
    clock.stop();
  });
});

test('a PRO is paid double, and the sentence states what the server paid', async () => {
  await onTheClock(async () => {
    const { raw, app } = world('pro');
    await post(app, '/api/rewards/browse/start');
    const { clock, log, pass } = mount(app);
    await clock.sync();
    for (let i = 0; i < 12; i++) await pass();
    assert.equal(log.awards[0].points, 40);
    assert.equal(settledPoints(raw, 'u1'), 40);
    const loc = (ar: string, en: string, ckb: string) => ({ ar, en, ckb });
    const say = (pick: 'ar' | 'en' | 'ckb') => browseAwardText(log.awards[0], (a, b, c) => loc(a, b, c)[pick]);
    assert.equal(say('ar'), 'أنهيت مهمة التصفّح · +40 نقطة (20 × 2)');
    assert.equal(say('en'), 'Browse mission done · +40 pts (20 × 2)');
    assert.equal(say('ckb'), 'ئەرکی گەڕانەکەت تەواو کرد · +40 خاڵ (20 × 2)');
    clock.stop();
  });
});

test('it survives a reload and a new tab: a fresh mount carries on from the server’s seconds, and the award is one', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    await post(app, '/api/rewards/browse/start');
    const first = mount(app);
    await first.clock.sync();
    for (let i = 0; i < 4; i++) await first.pass();
    assert.equal(first.log.state.seconds, 60);
    first.clock.stop(); // the page reloads

    const second = mount(app);
    await second.clock.sync();
    assert.equal(second.log.state.visible, true);
    assert.equal(second.log.state.seconds, 60, 'the server kept them');
    for (let i = 0; i < 8; i++) await second.pass();
    assert.equal(second.log.awards.length, 1);
    assert.equal(settledPoints(raw, 'u1'), 20);
    second.clock.stop();

    // Tomorrow the same device shows nothing until the mission is pressed again.
    mock.timers.tick(86_400_000);
    const third = mount(app);
    await third.clock.sync();
    assert.equal(third.log.state.visible, false);
    third.clock.stop();
  });
});

test('another tab finishing first: this one hides without a second sentence or a second credit', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    await post(app, '/api/rewards/browse/start');
    const a = mount(app);
    const b = mount(app);
    await a.clock.sync();
    await b.clock.sync();
    for (let i = 0; i < 12; i++) await a.pass();
    assert.equal(a.log.awards.length, 1);
    await b.pass();
    assert.equal(b.log.awards.length, 0, 'it did not earn this one');
    assert.equal(b.log.state.visible, false);
    assert.equal(settledPoints(raw, 'u1'), 20);
    a.clock.stop();
    b.clock.stop();
  });
});

// ------------------------------------------------------------ pausing stays

test('pause while hidden stays: a hidden tab sends no ping, and coming back credits no more than the server’s cap', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    await post(app, '/api/rewards/browse/start');
    let hidden = false;
    const { clock, log, pass } = mount(app, { hidden: () => hidden });
    await clock.sync();
    await pass();
    assert.equal(log.pings, 1);
    assert.equal(log.state.seconds, 15);

    hidden = true;
    const shown = log.state.seconds;
    for (let i = 0; i < 8; i++) await pass();
    assert.equal(log.pings, 1, 'two minutes hidden: no ping');
    assert.equal(log.state.seconds, shown, 'and the display does not run on');

    hidden = false;
    await pass();
    assert.equal(log.pings, 2);
    assert.equal(row<{ seconds: number }>(raw, "SELECT seconds FROM browse_sessions WHERE user_id='u1'")!.seconds, 45, 'the server credits at most 30 s for the gap');
    clock.stop();
  });
});

test('idle pauses after 30 seconds without activity, sends nothing, says so, and any activity resumes it', async () => {
  await onTheClock(async () => {
    const { app } = world();
    await post(app, '/api/rewards/browse/start');
    const { clock, log, pass } = mount(app);
    await clock.sync();
    await pass(PING_INTERVAL_MS, false);
    assert.equal(log.pings, 1);
    await pass(IDLE_LIMIT_MS, false);
    assert.equal(log.state.paused, true);
    const pings = log.pings;
    await pass(PING_INTERVAL_MS, false);
    assert.equal(log.pings, pings, 'paused: no ping');

    clock.activity();
    assert.equal(log.state.paused, false);
    await pass();
    assert.equal(log.pings, pings + 1);
    clock.stop();
  });
});

// ------------------------------------------------------------ failures

test('a network blip keeps the clock on; the server saying the mission is over hides it', async () => {
  assert.equal(isPassingFailure({ status: 0, code: 'NETWORK' }), true);
  assert.equal(isPassingFailure({ status: 429 }), true, 'too many: try again at the next ping');
  assert.equal(isPassingFailure({ status: 500 }), true);
  assert.equal(isPassingFailure(new TypeError('fetch failed')), true);
  assert.equal(isPassingFailure({ status: 400 }), false, 'no session: a new day');
  assert.equal(isPassingFailure({ status: 401 }), false);
  assert.equal(isPassingFailure({ status: 503, code: 'TASK_DISABLED' }), false, 'the owner switched it off');

  await onTheClock(async () => {
    const answers: Array<() => Promise<BrowsePing>> = [
      () => Promise.reject({ status: 0, code: 'NETWORK' }),
      async () => ({ done: false, seconds: 30 }),
      () => Promise.reject({ status: 400 }),
    ];
    let state = { visible: false } as ClockState;
    const clock = createBrowseClock({
      read: async () => ({ claimed: false, required_seconds: 180, progress_seconds: 15, started: true }),
      ping: () => answers.shift()!(),
      isHidden: () => false,
      onChange: (s) => (state = s),
      onAward: () => assert.fail('nothing was paid'),
    });
    await clock.sync();
    clock.activity();
    await clock.ping();
    assert.equal(state.visible, true, 'the mobile network dropped one ping: the mission is still on');
    await clock.ping();
    assert.equal(state.seconds, 30);
    await clock.ping();
    assert.equal(state.visible, false, 'a refusal: hide rather than pretend');
    clock.stop();
  });
});

test('a first read that fails on the network is tried again, so a bad minute does not lose the mission', async () => {
  await onTheClock(async () => {
    let reads = 0;
    let state = { visible: false } as ClockState;
    const clock = createBrowseClock({
      read: async () => {
        reads++;
        if (reads < 3) throw { status: 0 };
        return { claimed: false, required_seconds: 180, progress_seconds: 0, started: true };
      },
      ping: async () => ({ done: false, seconds: 0 }),
      isHidden: () => false,
      onChange: (s) => (state = s),
      onAward: () => undefined,
    });
    await clock.sync();
    assert.equal(state.visible, false);
    for (let i = 0; i < 2; i++) {
      mock.timers.tick(PING_INTERVAL_MS);
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(reads, 3);
    assert.equal(state.visible, true);
    clock.stop();
  });
});

// ------------------------------------------------------------ what the screen does

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');

test('no alert and no forced move away from the product; a toast in the shop’s words, and the wallet refreshed', () => {
  const clock = code('src/components/BrowseMissionTimer.tsx');
  assert.doesNotMatch(clock, /\balert\(/, 'the English alert is gone');
  assert.doesNotMatch(clock, /useNavigate|navigate\(/, 'a customer looking at a product stays on it');
  assert.match(clock, /toast\.success\(browseAwardText\(reply, latest\.current\.loc\)\)/);
  assert.match(clock, /latest\.current\.refreshWallet\(\)/);
  assert.doesNotMatch(clock, /Paused \(Inactive\)/, 'in three languages now');
  assert.match(clock, /loc\('متوقف — لا نشاط', 'Paused — inactive', 'وەستاوە — بێ چالاکی'\)/);
});

test('the clock sits on the reading end, above the bottom nav, clear of the cart’s summary bar, and watches the real scroller', () => {
  const clock = code('src/components/BrowseMissionTimer.tsx');
  assert.match(clock, /lv-browse-clock fixed end-4/, 'logical, so it follows the language');
  assert.doesNotMatch(clock, /\bright-4\b|\bleft-4\b|\bbottom-24\b/, 'no physical side, no guessed height');
  assert.match(clock, /capture: true/, 'a scroll inside #main-scroll-container does not bubble to the window');
  const css = read('src/index.css');
  assert.match(css, /\.lv-browse-clock \{\s*inset-block-end: calc\(max\(var\(--shell-bottom-inset, 0px\), var\(--nav-stack\)\) \+ 0\.5rem\);/);
  assert.match(css, /body:has\(\[data-bottom-bar\]\) \.lv-browse-clock \{\s*inset-block-end: calc\(var\(--nav-stack\) \+ 9rem\);/);
  assert.match(read('src/pages/Cart.tsx'), /data-bottom-bar/, 'the bar this clears is still the one that declares itself');
});

test('ON A PRODUCT PAGE, the page this mission is about, the clock sits just above the buy bar and not mid-screen over the page', () => {
  const css = read('src/index.css');
  const general = /body:has\(\[data-bottom-bar\]\) \.lv-browse-clock/;
  const buyBar = /body:has\(\[data-testid='product-buybar'\]\) \.lv-browse-clock \{\s*inset-block-end: calc\(var\(--shell-bottom-inset\) \+ 0\.5rem\);/;
  assert.match(css, buyBar, 'the bar’s own measured height, and no room kept for a nav this page does not have');
  assert.ok(css.search(buyBar) > css.search(general), 'after the cart’s rule, which the buy bar also matches: same weight, so the later one rules');
  const page = read('src/pages/Product.tsx');
  assert.match(page, /data-testid="product-buybar" data-bottom-bar/, 'the bar the rule names');
  assert.match(page, /root\.style\.setProperty\('--shell-bottom-inset', `\$\{h\}px`\)/, 'and it does measure itself into the inset');
  assert.match(read('src/components/BottomNav.tsx'), /pathname\.startsWith\('\/product\/'\)/, 'the page has no nav');
});

test('paused, the pill stays solid and only its words go quiet: at reduced opacity the page’s own text showed through it', () => {
  const clock = code('src/components/BrowseMissionTimer.tsx');
  assert.doesNotMatch(clock, /\bopacity-\d+/, 'nothing on the clock is see-through');
  assert.match(clock, /lv-surface-raised rounded-full/, 'on the shop’s solid raised surface');
  assert.match(clock, /state\.paused \? 'text-text-secondary' : 'text-text-primary'/, 'the time goes quiet');
  assert.match(clock, /state\.paused \? 'text-text-muted' : 'text-gold animate-pulse'/, 'the icon goes quiet, and stops pulsing');
});

test('A STALE PRESS IS ANSWERED BY CODE, so the page can say it in the reader’s language: the browse mission paid elsewhere, a check-in already done', async () => {
  await onTheClock(async () => {
    const { app } = world();
    await post(app, '/api/rewards/browse/start');
    const { clock, log, pass } = mount(app);
    await clock.sync();
    for (let i = 0; i < 12; i++) await pass();
    assert.equal(log.awards.length, 1);
    clock.stop();

    const browse = await post(app, '/api/rewards/browse/start');
    assert.equal(browse.status, 409);
    assert.equal((await json(browse)).code, 'REWARD_ALREADY_CLAIMED', 'the raw English reached an Arabic page');

    assert.equal((await post(app, '/api/rewards/checkin')).status, 200);
    const second = await post(app, '/api/rewards/checkin');
    assert.equal(second.status, 409);
    assert.equal((await json(second)).code, 'CHECKIN_ALREADY_DONE');
  });
  for (const refusal of ['REWARD_ALREADY_CLAIMED', 'CHECKIN_ALREADY_DONE']) {
    const sentence = REFUSAL_STRINGS[refusal];
    assert.ok(sentence?.ar && sentence.en && sentence.ckb, refusal);
    assert.notEqual(sentence.ckb, sentence.ar, `${refusal}: the Sorani copies the Arabic`);
  }
  const page = code('src/pages/Rewards.tsx');
  const refused = page.slice(page.indexOf('const handleBrowseMission'), page.indexOf('const missions = data?.missions'));
  assert.match(refused, /catch \(err\) \{\s*toast\.error\(failureText\(err\)\);/, 'on the screen they are on: the page’s notice sits far above the card they pressed');
});

test('the mission says the time passes only while browsing the shop, before it leaves the page and on the card', () => {
  const page = read('src/pages/Rewards.tsx');
  assert.match(page, /الوقت يُحسب أثناء تصفّحك للمتجر فقط/);
  assert.match(page, /The time counts only while you browse the shop/);
  assert.match(page, /کاتەکە تەنها لە کاتی گەڕان بە فرۆشگادا دەژمێردرێت/);
  assert.match(page, /يُحسب الوقت أثناء تصفّح المتجر فقط/);
  assert.match(page, /toast\.info\(/, 'a toast, because the page leaves right after');
});

/** Every `loc(...)` of a file: three languages, and the Sorani its own. */
function locProblems(rel: string): string[] {
  const src = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const text = (n: ts.Expression | undefined) => (n && (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) ? n.getText(src).slice(1, -1) : null);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'loc') {
      const at = `${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      if (n.arguments.length < 3) out.push(`${at} has no Sorani`);
      else if (text(n.arguments[2]) !== null && text(n.arguments[2]) === text(n.arguments[0])) out.push(`${at} copies the Arabic`);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

test('every word of the clock, the ad window, the ad card and the admin tab is in three languages, the Sorani its own', () => {
  const files = [
    'src/components/BrowseMissionTimer.tsx',
    'src/lib/browseMissionClock.ts',
    'src/components/points/AdWatchModal.tsx',
    'src/components/points/adMission.ts',
    'src/components/adminRewards/AdminAds.tsx',
  ];
  assert.deepEqual(files.flatMap(locProblems), []);
});
