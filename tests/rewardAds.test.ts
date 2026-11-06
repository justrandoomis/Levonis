/**
 * «شاهد إعلانًا»: THE VIDEO ADS (owner, 2026-11-05; migration 0227; docs/DECISIONS.md
 * row 300).
 *
 *   «add this as first ads i give a video [ 2 times he can see. one per day so the
 *    ads will run for 10 days so the user van watch it 2 times on whole 10 days but
 *    1 per day ,ex he watch it on day 2 and the second time on day 9 >»
 *
 * Against the real migrations, the real routes and the real ledger. A mocked clock
 * is the server's own clock here, so the owner's example is walked day by day and
 * second by second; nothing is backdated. The file's doors (the upload, /files,
 * Range) are tests/rewardAdsMedia.test.ts.
 *
 * Run: node --import tsx --test tests/rewardAds.test.ts
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import {
  OWNER,
  all,
  asD1,
  count,
  dbThrough,
  failingD1,
  freshDb,
  get,
  json,
  post,
  proOnSale,
  put,
  row,
  settledPoints,
  stubApp,
  type App,
  type StubUser,
} from './fixtures/app';
import { rewardRoutes } from '../worker/routes/rewards';
import { adminRewardsRoutes } from '../worker/routes/adminRewards';
import { adminRoutes } from '../worker/routes/admin';
import { firstAdWithViews, nextBaghdadMidnight, planVideoMission, type AdForCustomer } from '../worker/lib/rewards/ads';
import { baghdadDay } from '../worker/lib/pointsTasks';
import {
  adCard,
  adCardLine,
  adClaimFailure,
  adNewDayText,
  filmAt,
  filmEnded,
  missionsAllDone,
  parseFilmNote,
  recallFilm,
  stageAfterPause,
  type VideoMissionFacts,
} from '../src/components/points/adMission';
import { AdPlayer } from '../src/components/points/AdWatchModal';
import { AD_DEFAULT_DAYS, adWindowIso, defaultAdWindow, toLocalInput } from '../src/components/adminRewards/adForm';
import { LanguageProvider } from '../src/LanguageContext';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const buyer: StubUser = { id: 'u1', role: 'customer', email: 'a@x.co' };
const DAY = 86_400_000;
/** Noon in Baghdad on «day 1» of the owner's ten days. */
const DAY_1 = Date.parse('2026-11-05T09:00:00.000Z');
const onDay = (n: number) => DAY_1 + (n - 1) * DAY;
const VIDEO = '/files/rewards/ads/video/first.mp4';
const POSTER = '/files/rewards/ads/poster/first.webp';

function world(tier?: 'pro', raw: DatabaseSync = freshDb()): { raw: DatabaseSync; app: App } {
  proOnSale(raw);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','a@x.co','h','customer')`);
  if (tier) {
    raw
      .prepare(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES ('m1','u1','pro_12mo','pro','active',12,?,?)`)
      .run(new Date(DAY_1 - DAY).toISOString(), new Date(DAY_1 + 365 * DAY).toISOString());
  }
  return { raw, app: stubApp(asD1(raw), buyer, (a) => a.route('/api/rewards', rewardRoutes), { publishV2: false }) };
}

interface AdSeed {
  id?: string;
  starts?: number;
  ends?: number;
  max_views?: number;
  required?: number;
  active?: number;
  sort?: number;
  video?: string;
}

/** The owner's ad: ten days from day 1, two views, 45 seconds of a 47-second film. */
function ad(raw: DatabaseSync, o: AdSeed = {}) {
  const id = o.id ?? 'ad_first';
  raw
    .prepare(
      `INSERT INTO reward_ads (id,title_ar,title_en,title_ckb,video_url,poster_url,width,height,duration_seconds,required_seconds,starts_at,ends_at,max_views,active,sort)
       VALUES (?,?,?,?,?,?,720,1280,47,?,?,?,?,?,?)`
    )
    .run(
      id, 'الجمعة السوداء المبكرة', 'Early Black Friday', 'هەینیی ڕەشی زوو', o.video ?? VIDEO, POSTER, o.required ?? 45,
      new Date(o.starts ?? DAY_1 - 3_600_000).toISOString(), new Date(o.ends ?? onDay(10) + 12 * 3_600_000).toISOString(),
      o.max_views ?? 2, o.active ?? 1, o.sort ?? 0
    );
  return id;
}

const setting = (raw: DatabaseSync, url: string) =>
  raw.prepare(`INSERT INTO admin_settings (key,value) VALUES ('adVideoUrl',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(url));

const advance = (seconds: number) => mock.timers.setTime(Date.now() + seconds * 1000);
const videoOf = async (app: App) => (await json(await get(app, '/api/rewards'))).missions.video;

/** Start, let the server's seconds pass, claim: one view, as a customer makes one. */
async function watch(app: App, seconds = 45) {
  const start = await post(app, '/api/rewards/video/start');
  assert.equal(start.status, 200, JSON.stringify(await start.clone().json()));
  advance(seconds);
  return post(app, '/api/rewards/video');
}

function onTheClock(run: () => Promise<void>, now = onDay(1)): Promise<void> {
  mock.timers.enable({ apis: ['Date'], now });
  return run().finally(() => mock.timers.reset());
}

const claimsOf = (raw: DatabaseSync) =>
  all<{ day: string; state: string; points: number; ad_id: string | null; required_seconds: number }>(
    raw,
    "SELECT day, state, points, ad_id, required_seconds FROM reward_claims WHERE user_id='u1' AND mission='video' ORDER BY day"
  );

// ------------------------------------------------------------ the owner's example

test('THE OWNER’S EXAMPLE: ten days, two views, one a day — day 2 and day 9 pay; the same day, a third view and after the window do not', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw);

    // Day 1: the card says what is left, and until when. Nothing watched.
    const first = await videoOf(app);
    assert.equal(first.available, true);
    assert.equal(first.videoUrl, VIDEO);
    assert.equal(first.required_seconds, 45);
    assert.equal(first.claimed, false);
    assert.equal(first.started, false);
    assert.equal(first.done, false);
    assert.equal(first.next_at, null);
    assert.deepEqual(first.ad, {
      id: 'ad_first',
      title: { ar: 'الجمعة السوداء المبكرة', en: 'Early Black Friday', ckb: 'هەینیی ڕەشی زوو' },
      poster_url: POSTER,
      width: 720,
      height: 1280,
      views_used: 0,
      views_max: 2,
      ends_at: new Date(onDay(10) + 12 * 3_600_000).toISOString(),
    });

    // Day 2: the first view.
    mock.timers.setTime(onDay(2));
    const start = await json(await post(app, '/api/rewards/video/start'));
    assert.equal(start.required_seconds, 45, "the ad's own seconds, on the ticket");
    assert.equal(start.seconds_remaining, 45);
    assert.equal(start.videoUrl, VIDEO, 'the server says what plays');
    assert.equal(start.ad.id, 'ad_first');
    assert.equal(start.ad.views_used, 0);
    const early = await post(app, '/api/rewards/video');
    assert.equal(early.status, 409);
    assert.equal((await json(early)).code, 'TOO_SOON');
    advance(45);
    const paid = await json(await post(app, '/api/rewards/video'));
    assert.equal(paid.points, 20, 'the mission’s own points: an ad row has no points column');
    assert.equal(settledPoints(raw, 'u1'), 20);

    // Still day 2: the same day twice is refused, by the day's own row.
    const again = await post(app, '/api/rewards/video/start');
    assert.equal(again.status, 409);
    assert.equal((await json(again)).code, 'REWARD_ALREADY_CLAIMED');
    assert.equal((await post(app, '/api/rewards/video')).status, 409);
    assert.equal(settledPoints(raw, 'u1'), 20);
    const watched = await videoOf(app);
    assert.equal(watched.claimed, true);
    assert.equal(watched.done, false, 'another view remains');
    assert.equal(watched.next_at, nextBaghdadMidnight(onDay(2)), 'tomorrow');
    assert.equal(watched.ad.views_used, 1);
    assert.equal(adCard(watched).kind, 'watched');

    // Days 3–8 pass unwatched. Day 9: the second view.
    mock.timers.setTime(onDay(9));
    assert.equal((await videoOf(app)).claimed, false, 'a new Baghdad day');
    assert.equal((await videoOf(app)).ad.views_used, 1);
    assert.equal((await watch(app)).status, 200);
    assert.equal(settledPoints(raw, 'u1'), 40);
    const used = await videoOf(app);
    assert.equal(used.claimed, true);
    assert.equal(used.done, true, 'this ad is used up');
    assert.equal(used.next_at, null, 'no promise of tomorrow');
    assert.equal(used.videoUrl, null);
    assert.equal(adCard(used).kind, 'used_up');

    // Day 10: the window still runs, the views do not. A third is refused.
    mock.timers.setTime(onDay(10));
    const third = await post(app, '/api/rewards/video/start');
    assert.equal(third.status, 409);
    assert.equal((await json(third)).code, 'AD_LIMIT_REACHED');
    const tenth = await videoOf(app);
    assert.equal(tenth.claimed, false);
    assert.equal(tenth.available, false);
    assert.equal(tenth.done, true, 'still «you have watched it twice», with nothing claimed today');
    assert.equal(settledPoints(raw, 'u1'), 40);

    // Day 12: the window is over. No ad on the card at all.
    mock.timers.setTime(onDay(12));
    const over = await videoOf(app);
    assert.equal(over.ad, null);
    assert.equal(over.available, false);
    assert.equal(over.videoUrl, null);
    const late = await post(app, '/api/rewards/video/start');
    assert.equal(late.status, 503);
    assert.equal((await json(late)).code, 'NO_VIDEO');

    const rows = claimsOf(raw);
    assert.deepEqual(rows.map((r) => [r.day, r.state, r.points, r.ad_id]), [
      [baghdadDay(0, onDay(2)), 'awarded', 20, 'ad_first'],
      [baghdadDay(0, onDay(9)), 'awarded', 20, 'ad_first'],
    ]);
  });
});

test('before its window, an ad offers nothing and starts nothing', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw, { starts: onDay(3), ends: onDay(13) });
    const before = await videoOf(app);
    assert.equal(before.ad, null);
    assert.equal(before.available, false);
    assert.equal((await post(app, '/api/rewards/video/start')).status, 503);
    assert.equal(claimsOf(raw).length, 0);
    mock.timers.setTime(onDay(3));
    assert.equal((await videoOf(app)).available, true);
  });
});

test('a switched-off ad offers nothing, and neither does an old URL still in the setting once any ad row exists', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    setting(raw, 'https://cdn.example.com/old.mp4');
    ad(raw, { active: 0 });
    const v = await videoOf(app);
    assert.equal(v.available, false);
    assert.equal(v.videoUrl, null, 'the fallback is for a shop with no ad at all');
    assert.equal((await post(app, '/api/rewards/video/start')).status, 503);
  });
});

test('A SECOND AD AFTER THE FIRST IS USED UP: the next day it is the new one, with its own seconds and its own two views', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw, { id: 'ad_a', sort: 0 });
    ad(raw, { id: 'ad_b', sort: 1, required: 20, video: '/files/rewards/ads/video/second.mp4' });

    assert.equal((await videoOf(app)).ad.id, 'ad_a', 'the owner’s order');
    await watch(app);
    mock.timers.setTime(onDay(2));
    assert.equal((await videoOf(app)).ad.id, 'ad_a');
    await watch(app);
    const used = await videoOf(app);
    assert.equal(used.ad.id, 'ad_a');
    assert.equal(used.done, true, 'today’s card: this one is used up');

    mock.timers.setTime(onDay(3));
    const next = await videoOf(app);
    assert.equal(next.ad.id, 'ad_b');
    assert.equal(next.videoUrl, '/files/rewards/ads/video/second.mp4');
    assert.equal(next.required_seconds, 20);
    assert.equal(next.done, false);
    assert.equal(next.ad.views_used, 0);
    assert.equal((await watch(app, 20)).status, 200);
    assert.deepEqual(claimsOf(raw).map((r) => [r.ad_id, r.required_seconds]), [['ad_a', 45], ['ad_a', 45], ['ad_b', 20]]);
    assert.equal(settledPoints(raw, 'u1'), 60);
  });
});

// ------------------------------------------------------------ the count decides in the award

test('THE AWARD ITSELF COUNTS: a view landing while the claim is on its way refuses it, in the same transaction, and pays nothing', async () => {
  await onTheClock(async () => {
    const { raw } = world();
    const { failing, db } = failingD1(raw);
    const app = stubApp(db, buyer, (a) => a.route('/api/rewards', rewardRoutes), { publishV2: false });
    ad(raw, { max_views: 1 });
    await post(app, '/api/rewards/video/start');
    advance(45);

    // The rival fills the ad's only view from another Baghdad day, after this
    // request has read everything and before its write lands: the worst moment.
    let injected = false;
    failing.beforeBatch = (stmts) => {
      if (injected || !stmts.some((s) => s.sql.includes('UPDATE reward_claims'))) return;
      injected = true;
      raw.exec(
        `INSERT INTO reward_claims (id,user_id,mission,day,points,base_points,state,awarded_at,idempotency_key,wallet_tx_id,ad_id)
         VALUES ('rc_rival','u1','video','2026-01-01',20,20,'awarded','2026-01-01T00:00:00.000Z','reward:u1:video:2026-01-01','wtx_rc_rc_rival','ad_first')`
      );
    };
    const res = await post(app, '/api/rewards/video');
    assert.equal(injected, true);
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'AD_LIMIT_REACHED');
    assert.equal(settledPoints(raw, 'u1'), 0, 'nothing paid');
    assert.equal(row<{ state: string }>(raw, `SELECT state FROM reward_claims WHERE id <> 'rc_rival' AND user_id='u1'`)!.state, 'started', 'still only a ticket');
    assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='u1' AND currency='POINT'"), 0);
  });
});

test('the owner lowering the limit under an open ticket is honoured at the claim', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw);
    await watch(app);
    mock.timers.setTime(onDay(2));
    await post(app, '/api/rewards/video/start');
    advance(45);
    raw.exec("UPDATE reward_ads SET max_views = 1 WHERE id = 'ad_first'");
    const res = await post(app, '/api/rewards/video');
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'AD_LIMIT_REACHED');
    assert.equal(settledPoints(raw, 'u1'), 20);
  });
});

test('an ad removed from under an open ticket answers NO_VIDEO, and pays nothing', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw);
    await post(app, '/api/rewards/video/start');
    advance(45);
    raw.exec("DELETE FROM reward_ads WHERE id = 'ad_first'");
    const res = await post(app, '/api/rewards/video');
    assert.equal(res.status, 503);
    assert.equal((await json(res)).code, 'NO_VIDEO');
    assert.equal(settledPoints(raw, 'u1'), 0);
  });
});

// ------------------------------------------------------------ the ticket and the clock

test('leaving and coming back keeps the server’s clock; a crafted body changes nothing', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw);
    ad(raw, { id: 'ad_other', sort: 1, required: 5 });
    await post(app, '/api/rewards/video/start', { ad_id: 'ad_other', required_seconds: 0, seconds: 999 });
    assert.equal(claimsOf(raw)[0].ad_id, 'ad_first', 'the server picks the ad');
    assert.equal(claimsOf(raw)[0].required_seconds, 45, 'and its seconds');
    advance(30);

    const open = await videoOf(app);
    assert.equal(open.started, true);
    assert.equal(open.seconds_remaining, 15, 'the clock ran while they were away');
    const back = await json(await post(app, '/api/rewards/video/start'));
    assert.equal(back.seconds_remaining, 15, 'coming back does not restart it');
    assert.equal(claimsOf(raw).length, 1, 'one ticket per day');

    const crafted = await post(app, '/api/rewards/video', { ad_id: 'ad_other', started_at: '2000-01-01T00:00:00.000Z', required_seconds: 0, points: 99999 });
    assert.equal(crafted.status, 409);
    assert.equal((await json(crafted)).code, 'TOO_SOON');
    advance(15);
    const paid = await json(await post(app, '/api/rewards/video', { points: 99999 }));
    assert.equal(paid.points, 20);
    assert.equal(settledPoints(raw, 'u1'), 20);
  });
});

test('/video/start says WHICH TICKET this is: the same on every press of one day, and a new one on the next', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw);
    const first = await json(await post(app, '/api/rewards/video/start'));
    assert.equal(first.started_at, new Date(onDay(1)).toISOString(), 'the server’s own instant');
    advance(30);
    const back = await json(await post(app, '/api/rewards/video/start'));
    assert.equal(back.started_at, first.started_at, 'coming back is the same ticket');
    mock.timers.setTime(onDay(2));
    const tomorrow = await json(await post(app, '/api/rewards/video/start'));
    assert.notEqual(tomorrow.started_at, first.started_at, 'a new day’s ticket is another, so a film’s end does not carry over');
    assert.equal(tomorrow.seconds_remaining, 45);
  });
});

test('A TICKET FOR AN AD THAT ENDED may still be claimed that day if its time ran', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw, { ends: onDay(1) + 30_000 });
    await post(app, '/api/rewards/video/start');
    advance(45); // the window closed 15 seconds ago
    const open = await videoOf(app);
    assert.equal(open.ad.id, 'ad_first', 'the card stays on the ticket');
    assert.equal(open.available, true);
    assert.equal(open.started, true);
    assert.equal(open.seconds_remaining, 0);
    assert.equal((await json(await post(app, '/api/rewards/video/start'))).seconds_remaining, 0, 'reopening is not refused');
    const paid = await post(app, '/api/rewards/video');
    assert.equal(paid.status, 200);
    assert.equal(settledPoints(raw, 'u1'), 20);
  });
});

test('a ticket whose ad was switched off before its time ran moves to the next ad, and its clock starts again', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw, { id: 'ad_a', sort: 0 });
    ad(raw, { id: 'ad_b', sort: 1, required: 20 });
    await post(app, '/api/rewards/video/start');
    advance(10);
    raw.exec("UPDATE reward_ads SET active = 0 WHERE id = 'ad_a'");

    const v = await videoOf(app);
    assert.equal(v.ad.id, 'ad_b');
    assert.equal(v.started, false, 'its seconds belong to the ad it was opened for');
    assert.equal(v.seconds_remaining, null);

    const moved = await json(await post(app, '/api/rewards/video/start'));
    assert.equal(moved.ad.id, 'ad_b');
    assert.equal(moved.seconds_remaining, 20, 'a fresh clock for what will be watched');
    assert.deepEqual(claimsOf(raw).map((r) => [r.ad_id, r.required_seconds, r.state]), [['ad_b', 20, 'started']], 'still one row today');
    advance(20);
    assert.equal((await post(app, '/api/rewards/video')).status, 200);
  });
});

test('the multiplier is as before: a PRO is paid 20 × 2, and the row says so', async () => {
  await onTheClock(async () => {
    const { raw, app } = world('pro');
    ad(raw);
    const view = await videoOf(app);
    assert.equal(view.points, 40);
    assert.equal(view.base_points, 20);
    const paid = await json(await watch(app));
    assert.equal(paid.points, 40);
    assert.equal(paid.base_points, 20);
    assert.equal(paid.multiplier_x100, 200);
    const c = row<{ points: number; multiplier_x100: number; tier_at_award: string; ad_id: string }>(raw, "SELECT points, multiplier_x100, tier_at_award, ad_id FROM reward_claims WHERE mission='video'")!;
    assert.deepEqual({ ...c }, { points: 40, multiplier_x100: 200, tier_at_award: 'pro', ad_id: 'ad_first' });
    assert.equal(settledPoints(raw, 'u1'), 40);
  });
});

test('the owner’s switch for the whole mission still rules: off, an ad pays nothing', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw);
    raw
      .prepare("INSERT INTO admin_settings (key,value) VALUES ('rewardTaskConfig',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ video_enabled: false, video_min_seconds: 15, browse_enabled: true, push_enabled: true }));
    assert.equal((await videoOf(app)).available, false);
    const start = await post(app, '/api/rewards/video/start');
    assert.equal(start.status, 503);
    assert.equal((await json(start)).code, 'TASK_DISABLED');
  });
});

// ------------------------------------------------------------ nothing regresses

test('BEFORE 0227 the old setting still works: same fields, same statuses, no new column touched', async () => {
  await onTheClock(async () => {
    const before = dbThrough('0225');
    const { raw, app } = world(undefined, before);
    assert.throws(() => raw.exec('SELECT ad_id FROM reward_claims'), /no such column/, 'this really is a database before 0227');
    setting(raw, 'https://cdn.example.com/ad.mp4');

    const v = await videoOf(app);
    assert.equal(v.available, true);
    assert.equal(v.videoUrl, 'https://cdn.example.com/ad.mp4');
    assert.equal(v.required_seconds, 15, 'the task config’s seconds');
    assert.equal(v.ad, null);
    assert.equal(v.done, false);
    assert.equal(v.next_at, null);
    assert.equal(v.seconds_remaining, null);
    assert.equal(v.started, false);

    const start = await json(await post(app, '/api/rewards/video/start'));
    assert.equal(start.required_seconds, 15);
    assert.equal(start.videoUrl, 'https://cdn.example.com/ad.mp4');
    assert.equal(start.ad, null);
    assert.equal((await videoOf(app)).started, true);
    assert.equal((await videoOf(app)).seconds_remaining, 15);
    advance(15);
    const paid = await json(await post(app, '/api/rewards/video'));
    assert.equal(paid.points, 20);
    assert.equal(settledPoints(raw, 'u1'), 20);
    const done = await videoOf(app);
    assert.equal(done.claimed, true);
    assert.equal(done.done, false);
    assert.equal(adCard(done).kind, 'plain', 'the card as it always was');
  });
});

test('on 0227 with no ad row at all, the old setting still runs the mission; its rows name no ad', async () => {
  await onTheClock(async () => {
    const { raw, app } = world();
    setting(raw, 'https://cdn.example.com/ad.mp4');
    const v = await videoOf(app);
    assert.equal(v.available, true);
    assert.equal(v.videoUrl, 'https://cdn.example.com/ad.mp4');
    assert.equal(v.ad, null);
    assert.equal((await watch(app, 15)).status, 200);
    assert.equal(claimsOf(raw)[0].ad_id, null);
    assert.equal(settledPoints(raw, 'u1'), 20);
  });
});

test('with no ad and no setting the mission is off, as it is on live today', async () => {
  await onTheClock(async () => {
    const { app } = world();
    const v = await videoOf(app);
    assert.equal(v.available, false);
    assert.equal(v.videoUrl, null);
    const start = await post(app, '/api/rewards/video/start');
    assert.equal(start.status, 503);
    assert.equal((await json(start)).code, 'NO_VIDEO');
  });
});

// ------------------------------------------------------------ pure: the plan and the card

const planAd = (o: Partial<AdForCustomer> = {}): AdForCustomer => ({
  id: 'a', title_ar: 'ع', title_en: 'e', title_ckb: 'ک', video_url: VIDEO, poster_url: '', width: 720, height: 1280, duration_seconds: 47, required_seconds: 45,
  starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-11-20T00:00:00.000Z', max_views: 2, active: 1, sort: 0, views_used: 0, ...o,
});

test('the plan: the first running ad with a view left; tomorrow only while the ad still runs tomorrow', () => {
  const now = Date.parse('2026-11-10T09:00:00.000Z');
  assert.equal(firstAdWithViews([planAd({ id: 'off', active: 0 }), planAd({ id: 'spent', views_used: 2 }), planAd({ id: 'late', starts_at: '2026-12-01T00:00:00.000Z' }), planAd({ id: 'yes' })], new Date(now).toISOString())?.id, 'yes');

  assert.equal(nextBaghdadMidnight(now), '2026-11-10T21:00:00.000Z', 'Baghdad is UTC+3');
  assert.equal(nextBaghdadMidnight(Date.parse('2026-11-10T21:30:00.000Z')), '2026-11-11T21:00:00.000Z', 'already the 11th in Baghdad');

  const claim = { state: 'awarded', started_at: null, required_seconds: 45, ad_id: 'a' };
  const state = (ad: AdForCustomer) => ({ installed: true, rows: [ad], todayAdId: 'a' });
  const opts = { claim, nowMs: now, legacyUrl: null, minSeconds: 15 };
  assert.equal(planVideoMission(state(planAd({ views_used: 1 })), opts).nextAt, '2026-11-10T21:00:00.000Z');
  assert.equal(planVideoMission(state(planAd({ views_used: 1, ends_at: '2026-11-10T20:00:00.000Z' })), opts).nextAt, null, 'the ad ends tonight: no promise of tomorrow');
  assert.equal(planVideoMission(state(planAd({ views_used: 1, ends_at: '2026-11-10T20:00:00.000Z' })), opts).done, false, 'though a view was left');
  assert.equal(planVideoMission(state(planAd({ views_used: 2 })), opts).done, true);
});

const facts = (o: Partial<VideoMissionFacts> = {}): VideoMissionFacts => ({
  claimed: false,
  available: true,
  videoUrl: VIDEO,
  ad: { id: 'a', title: { ar: 'ع', en: 'e', ckb: 'ک' }, poster_url: null, width: 720, height: 1280, views_used: 0, views_max: 2, ends_at: '2026-11-14T20:59:00.000Z' },
  next_at: null,
  done: false,
  ...o,
});
const inLang = (pick: 0 | 1 | 2) => (ar: string, en: string, ckb: string) => [ar, en, ckb][pick];
const date = () => '14 NOV';

test('the card’s line, in the owner’s words and in three languages, with Arabic counting its noun', () => {
  const ready = adCard(facts());
  assert.deepEqual(ready, { kind: 'ready', left: 2, until: '2026-11-14T20:59:00.000Z' });
  assert.equal(adCardLine(ready, inLang(0), date), 'مرة واحدة في اليوم · تبقّت لك مشاهدتان حتى 14 NOV');
  assert.equal(adCardLine(ready, inLang(1), date), 'Once a day · 2 views left until 14 NOV');
  assert.equal(adCardLine(ready, inLang(2), date), 'ڕۆژانە یەک جار · 2 بینینت ماوە تا 14 NOV');

  const one = adCard(facts({ ad: { ...facts().ad!, views_used: 1 } }));
  assert.equal(adCardLine(one, inLang(0), date), 'مرة واحدة في اليوم · تبقّت لك مشاهدة واحدة حتى 14 NOV');
  assert.equal(adCardLine(one, inLang(1), date), 'Once a day · 1 view left until 14 NOV');
  const five = adCard(facts({ ad: { ...facts().ad!, views_max: 5 } }));
  assert.equal(adCardLine(five, inLang(0), date), 'مرة واحدة في اليوم · تبقّت لك 5 مشاهدات حتى 14 NOV');
  const twelve = adCard(facts({ ad: { ...facts().ad!, views_max: 12 } }));
  assert.equal(adCardLine(twelve, inLang(0), date), 'مرة واحدة في اليوم · تبقّت لك 12 مشاهدة حتى 14 NOV');

  const again = adCard(facts({ claimed: true, next_at: '2026-11-10T21:00:00.000Z' }));
  assert.deepEqual(again, { kind: 'watched', again: true });
  assert.equal(adCardLine(again, inLang(0), date), 'غدًا تستطيع مشاهدته مرة أخرى');
  assert.equal(adCardLine(again, inLang(1), date), 'You can watch it again tomorrow');
  assert.equal(adCardLine(again, inLang(2), date), 'سبەی دەتوانیت دووبارە بیبینیت');
  assert.equal(adCardLine(adCard(facts({ claimed: true })), inLang(0), date), 'شاهدته اليوم', 'never a promise the ad will not keep');

  const used = adCard(facts({ claimed: true, done: true }));
  assert.equal(adCardLine(used, inLang(0), date), 'شاهدت هذا الإعلان مرتين');
  assert.equal(adCardLine(used, inLang(1), date), "You've watched this ad twice");
  assert.equal(adCardLine(used, inLang(2), date), 'ئەم ڕیکلامەت دوو جار بینی');
  assert.equal(adCard(facts({ ad: null })).kind, 'plain');
  assert.equal(adCard({ claimed: false, available: true, videoUrl: VIDEO }).kind, 'plain', 'an older server');
});

test('with the whole mission switched off and an ad running, the disabled card promises no views', async () => {
  assert.equal(adCard(facts({ available: false })).kind, 'plain', 'it says «no ad today», as the old card did');
  assert.equal(adCard(facts({ available: false, claimed: true, next_at: '2026-11-10T21:00:00.000Z' })).kind, 'watched', 'what was already watched stays said');
  assert.equal(adCard(facts({ available: false, claimed: true, done: true })).kind, 'used_up');
  assert.equal(adCard(facts({ available: false, done: true })).kind, 'used_up');
  // And it is the answer the route really gives: the ad on the card, nothing to play.
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw);
    raw.prepare("INSERT INTO admin_settings (key,value) VALUES ('rewardTaskConfig',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ video_enabled: false, browse_enabled: true, push_enabled: true, video_min_seconds: 15 }));
    const video = await videoOf(app);
    assert.equal(video.available, false);
    assert.ok(video.ad, 'the case itself: an ad is still named');
    assert.equal(adCard(video).kind, 'plain');
  });
});

// ------------------------------------------------------------ the film's place

const NOTE = { url: VIDEO, ticket: '2026-11-05T09:00:00.000Z', at: 12, ended: false };
const TICKET = NOTE.ticket;

test('A FILM’S END IS KEPT AGAINST ITS TICKET: the same ticket comes back to the claim; a new day’s ticket, or another film, starts over', () => {
  const ended = filmEnded(filmAt(null, VIDEO, TICKET, 47), VIDEO, TICKET);
  assert.deepEqual(recallFilm(ended, VIDEO, TICKET), { at: 47, ended: true });
  assert.deepEqual(recallFilm(ended, VIDEO, '2026-11-06T09:00:00.000Z'), { at: 0, ended: false }, 'tomorrow’s ticket watches it again');
  assert.deepEqual(recallFilm(ended, '/files/rewards/ads/video/other.mp4', TICKET), { at: 0, ended: false }, 'the next ad is its own film');
  assert.deepEqual(recallFilm(null, VIDEO, TICKET), { at: 0, ended: false });
  assert.deepEqual(recallFilm(ended, VIDEO, null), { at: 0, ended: false }, 'with no ticket to tie it to, nothing is assumed');
  assert.equal(filmEnded(null, VIDEO, null), null);
  assert.equal(filmAt(null, VIDEO, null, 12), null);
  // A later position does not forget the end, and a new ticket's position does.
  assert.equal(filmAt(ended, VIDEO, TICKET, 3)!.ended, true);
  assert.equal(filmAt(ended, VIDEO, '2026-11-06T09:00:00.000Z', 3)!.ended, false);
});

test('a retried film returns to its place: reloading the element reports 0 before it is sought back, and that must not overwrite the place', () => {
  assert.equal(filmAt(NOTE, VIDEO, TICKET, 0), NOTE, 'the very event that restarted it from 0:00');
  assert.equal(filmAt(NOTE, VIDEO, TICKET, Number.NaN), NOTE);
  assert.equal(recallFilm(filmAt(NOTE, VIDEO, TICKET, 0), VIDEO, TICKET).at, 12);
  assert.equal(recallFilm(filmAt(NOTE, VIDEO, TICKET, 13.5), VIDEO, TICKET).at, 13.5);
});

test('the note read back from the tab’s storage is taken only if it is whole', () => {
  const round = JSON.stringify({ ...NOTE, ended: true });
  assert.deepEqual(parseFilmNote(round), { ...NOTE, ended: true });
  for (const bad of [null, '', 'null', 'not json', '{}', '[]', JSON.stringify({ ...NOTE, ended: 'yes' }), JSON.stringify({ ...NOTE, at: '12' }), JSON.stringify({ ...NOTE, ticket: null })]) {
    assert.equal(parseFilmNote(bad), null, String(bad));
  }
});

test('a film paused from outside offers the play button; a film at its end, or one already failed, stays what it is', () => {
  assert.equal(stageAfterPause('playing', false), 'blocked');
  assert.equal(stageAfterPause('loading', false), 'blocked');
  assert.equal(stageAfterPause('blocked', false), 'blocked');
  assert.equal(stageAfterPause('playing', true), 'playing', 'the pause every film fires at its end');
  assert.equal(stageAfterPause('failed', false), 'failed');
});

test('A CLAIM WITH NO ANSWER KEEPS THE FILM AND THE CLAIM ON SCREEN; a new day says so; a real refusal closes the window', () => {
  for (const noAnswer of [{ status: 0, code: 'NETWORK' }, new TypeError('fetch failed'), { status: 500 }, { status: 502 }, { status: 503, code: 'SERVICE_UNAVAILABLE' }, { status: 429, code: 'RATE_LIMITED' }, null]) {
    assert.equal(adClaimFailure(noAnswer), 'keep', JSON.stringify(noAnswer));
  }
  assert.equal(adClaimFailure({ status: 409, code: 'TOO_SOON' }), 'keep', 'the server’s clock has not run: the window stays, as ever');
  assert.equal(adClaimFailure({ status: 400, code: 'NO_TICKET' }), 'new_day');
  for (const answered of [
    { status: 409, code: 'REWARD_ALREADY_CLAIMED' },
    { status: 409, code: 'AD_LIMIT_REACHED' },
    { status: 503, code: 'NO_VIDEO' },
    { status: 503, code: 'TASK_DISABLED' },
    { status: 401, code: 'UNAUTHORIZED' },
    { status: 403 },
  ]) {
    assert.equal(adClaimFailure(answered), 'close', JSON.stringify(answered));
  }
  const page = read('src/pages/Rewards.tsx');
  const claim = page.slice(page.indexOf('const handleVideoClaim'), page.indexOf('const handleBrowseMission'));
  assert.match(claim, /const outcome = adClaimFailure\(err\);/);
  assert.match(claim, /outcome === 'new_day'\) toast\.info\(adNewDayText\(loc\)\)/);
  assert.match(claim, /if \(outcome === 'keep'\) \{[^}]*setAdNote\(failureText\(err\)\);\s*return;\s*\}/, 'said in the window that stays, not a toast over the claim');
  assert.match(claim, /else toast\.error\(failureText\(err\)\);\s*setAdShown\(null\);/, 'and anything else closes it');
  assert.match(claim, /Promise\.all\(\[loadRewards\(\), refreshWallet\(\)\]\);\s*\} finally/, 'the page and the wallet are read again, as an answer that went missing may have paid');
  assert.match(page, /setAdNote\(''\);\s*try \{\s*const res = await api\.post<\{ required_seconds/, 'a new press starts with a clean window');
  assert.match(page, /ticket: res\.started_at \?\? null/, 'what the film is remembered against is the server’s answer');
});

test('after a film that crossed midnight the customer is told a new day started, in three languages, not to play the ad first', async () => {
  const say = (pick: 0 | 1 | 2) => adNewDayText(inLang(pick));
  assert.match(say(0), /بدأ يوم جديد/);
  assert.match(say(1), /A new day started/);
  assert.match(say(2), /ڕۆژێکی نوێ/);
  assert.notEqual(say(2), say(0));
  // The refusal it words: the film ran across midnight, the old ticket is yesterday's.
  await onTheClock(async () => {
    const { raw, app } = world();
    ad(raw);
    mock.timers.setTime(Date.parse('2026-11-06T20:59:40.000Z')); // 23:59:40 in Baghdad
    await post(app, '/api/rewards/video/start');
    advance(48);
    const refused = await post(app, '/api/rewards/video');
    assert.equal(refused.status, 400);
    assert.equal(adClaimFailure({ status: refused.status, code: (await json(refused)).code }), 'new_day');
    assert.equal(settledPoints(raw, 'u1'), 0);
  });
});

// ------------------------------------------------------------ what the window draws

function renderPlayer(o: { ticket: string | null; secondsLeft?: number; note?: object | null; said?: string }) {
  // The tab's storage, as a browser would hold it (Node has none without a flag).
  const store = o.note ? JSON.stringify(o.note) : null;
  const had = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => store, setItem: () => undefined } });
  try {
    const player = createElement(AdPlayer, {
      videoUrl: VIDEO,
      ad: { id: 'a', title: { ar: 'ع', en: 'e', ckb: 'ک' }, poster_url: POSTER, width: 720, height: 1280, views_used: 0, views_max: 2, ends_at: '2026-11-14T20:59:00.000Z' },
      ticket: o.ticket,
      note: o.said,
      secondsLeft: o.secondsLeft ?? 0,
      points: 20,
      claiming: false,
      onClaim: () => undefined,
      onClose: () => undefined,
    });
    return renderToStaticMarkup(createElement(LanguageProvider, { children: player }));
  } finally {
    if (had) Object.defineProperty(globalThis, 'sessionStorage', had);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
}

test('the window as drawn: a fresh film loads and offers no claim; back on a finished film’s ticket, nothing plays and the claim is there at once, with the way out beside it', () => {
  // A ticket of its own: the module keeps the page's note between renders, as a page does.
  const fresh = renderPlayer({ ticket: '2026-11-04T09:00:00.000Z', note: null });
  assert.match(fresh, /preload="auto"/);
  assert.doesNotMatch(fresh, /احصل على 20 نقطة/, 'the film has not ended: no claim');
  assert.match(fresh, /aria-pressed/, 'the sound button');
  assert.match(fresh, /aria-valuenow="0"/);

  const back = renderPlayer({ ticket: TICKET, note: { ...NOTE, at: 47, ended: true } });
  assert.match(back, /preload="none"/, 'not even loaded: the film costs no more data');
  assert.match(back, /احصل على 20 نقطة/, 'the claim, at once');
  assert.match(back, /إغلاق/, 'and the way out: the window can now stay open after a claim that found no connection');
  assert.match(back, /انتهى الإعلان/, 'it says why nothing is playing');
  assert.doesNotMatch(back, /aria-pressed/, 'no sound to turn on');
  assert.match(back, /aria-valuenow="100"/);

  // The server's countdown still rules: a claim is offered only once that is over too.
  assert.doesNotMatch(renderPlayer({ ticket: TICKET, secondsLeft: 9, note: { ...NOTE, at: 47, ended: true } }), /احصل على 20 نقطة/);
  // Tomorrow's ticket does not read today's note, whichever the tab still holds.
  const tomorrow = renderPlayer({ ticket: '2026-11-06T09:00:00.000Z', note: { ...NOTE, at: 47, ended: true } });
  assert.match(tomorrow, /preload="auto"/);
  assert.doesNotMatch(tomorrow, /احصل على 20 نقطة/);
});

test('a claim that found no connection says so in the window, on the film, beside the claim to press again', () => {
  const said = 'تعذّر الاتصال بالخادم';
  const quiet = renderPlayer({ ticket: TICKET, note: { ...NOTE, at: 47, ended: true } });
  assert.doesNotMatch(quiet, /role="alert"/);
  const lost = renderPlayer({ ticket: TICKET, note: { ...NOTE, at: 47, ended: true }, said });
  assert.match(lost, new RegExp(`role="alert"[^>]*>${said}`));
  assert.match(lost, /احصل على 20 نقطة/, 'the claim is still there');
  const modal = read('src/components/points/AdWatchModal.tsx');
  assert.match(modal, /stage === 'playing' && loc\('الإعلان قيد التشغيل…'/, 'and a film that failed is not said to be playing');
});

test('«أنهيت كل مهام اليوم» is only said when it is true', () => {
  const m = (push: boolean, browse: boolean, video: Pick<VideoMissionFacts, 'claimed' | 'done'>) => missionsAllDone({ push: { claimed: push }, browse: { claimed: browse }, video });
  assert.equal(m(true, true, { claimed: true, done: false }), true, 'today’s view paid, another left for tomorrow: today is finished');
  assert.equal(m(true, true, { claimed: false, done: true }), true, 'used up: nothing more to give');
  assert.equal(m(true, true, { claimed: false, done: false }), false, 'a view waits to be watched, or no ad runs: not «finished»');
  assert.equal(m(true, true, { claimed: false }), false, 'an older server');
  assert.equal(m(true, false, { claimed: true, done: true }), false);
  assert.equal(m(false, true, { claimed: true, done: true }), false);
});

// ------------------------------------------------------------ the admin's door

const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };

function adminWorld(raw: DatabaseSync = freshDb()) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('usr_owner','Owner','boss@x.co','h','admin'), ('usr_full','Full','full@x.co','h','admin'),
      ('usr_asst','Asst','asst@x.co','h','admin'), ('u1','Sara','a@x.co','h','customer'), ('u2','Omar','b@x.co','h','customer');
  `);
  try {
    raw.exec(`
      INSERT INTO file_objects (object_key,visibility,domain,mime_type,byte_size,purpose) VALUES
        ('rewards/ads/video/first.mp4','public','rewards','video/mp4',7452322,'reward_ad'),
        ('rewards/ads/poster/first.webp','public','rewards','image/webp',20000,'reward_ad');
    `);
  } catch {
    /* a database before 0156 has no purpose column: not one this file builds */
  }
  const as = (user: StubUser, id?: string) => stubApp(asD1(raw), id ? { ...user, id } : user, (a) => a.route('/api/admin/rewards', adminRewardsRoutes), { publishV2: false });
  return { raw, as };
}

const FORM = {
  title_ar: 'الجمعة السوداء المبكرة',
  title_en: 'Early Black Friday',
  title_ckb: 'هەینیی ڕەشی زوو',
  video_url: VIDEO,
  poster_url: POSTER,
  width: 720,
  height: 1280,
  duration_seconds: 47,
  starts_at: '2026-11-05T00:00:00.000Z',
  ends_at: '2026-11-14T20:59:00.000Z',
  active: true,
};

test('ONLY THE OWNER publishes: create, edit and switch on; any admin may read and switch off; every act leaves an audit row', async () => {
  const { raw, as } = adminWorld();
  const owner = as(OWNER);
  const full = as(FULL);
  const assistant = as(ASSISTANT);

  for (const a of [full, assistant]) {
    const refused = await post(a, '/api/admin/rewards/ads', FORM);
    assert.equal(refused.status, 403);
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM reward_ads'), 0);
  }
  assert.equal((await json(await post(full, '/api/admin/rewards/ads', FORM))).code, 'OWNER_REQUIRED');

  const created = await post(owner, '/api/admin/rewards/ads', FORM);
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const { id } = await json(created);
  const stored = row<{ required_seconds: number; max_views: number; active: number; created_by: string }>(raw, 'SELECT required_seconds, max_views, active, created_by FROM reward_ads WHERE id = ?', id)!;
  assert.equal(stored.required_seconds, 45, 'minimum seconds: the default is duration − 2');
  assert.equal(stored.max_views, 2, 'the owner’s two views');
  assert.equal(stored.active, 1);
  assert.equal(stored.created_by, 'usr_owner');

  for (const a of [full, assistant]) {
    assert.equal((await put(a, `/api/admin/rewards/ads/${id}`, FORM)).status, 403, 'editing is the owner’s');
    assert.equal((await get(a, '/api/admin/rewards/ads')).status, 200, 'reading is any admin’s');
  }

  // Off: any admin, even the assistant, and a replay moves nothing.
  const off = await post(assistant, `/api/admin/rewards/ads/${id}/toggle`, { active: false });
  assert.equal(off.status, 200);
  assert.equal((await json(off)).changed, true);
  assert.equal(row<{ active: number }>(raw, 'SELECT active FROM reward_ads WHERE id = ?', id)!.active, 0);
  assert.equal((await json(await post(assistant, `/api/admin/rewards/ads/${id}/toggle`, { active: false }))).changed, false, 'a double press lands where it was meant');

  // On: the owner's, at the handler, since the same route also switches off.
  for (const a of [full, assistant]) assert.equal((await post(a, `/api/admin/rewards/ads/${id}/toggle`, { active: true })).status, 403);
  assert.equal(row<{ active: number }>(raw, 'SELECT active FROM reward_ads WHERE id = ?', id)!.active, 0, 'still off');
  assert.equal((await post(owner, `/api/admin/rewards/ads/${id}/toggle`, { active: true })).status, 200);
  assert.equal(row<{ active: number }>(raw, 'SELECT active FROM reward_ads WHERE id = ?', id)!.active, 1);

  assert.equal((await post(owner, `/api/admin/rewards/ads/${id}/toggle`, {})).status, 400, 'never a blind flip');
  assert.equal((await post(owner, '/api/admin/rewards/ads/nope/toggle', { active: false })).status, 404);

  const updated = await put(owner, `/api/admin/rewards/ads/${id}`, { ...FORM, title_ar: 'عنوان جديد', max_views: 3, required_seconds: 40 });
  assert.equal(updated.status, 200);
  assert.equal(row<{ title_ar: string; max_views: number; required_seconds: number }>(raw, 'SELECT title_ar, max_views, required_seconds FROM reward_ads WHERE id = ?', id)!.max_views, 3);
  assert.equal((await put(owner, '/api/admin/rewards/ads/nope', FORM)).status, 404);

  const acts = all<{ action: string; actor_id: string }>(raw, "SELECT action, actor_id FROM audit_log WHERE action LIKE 'rewards.ad.%' ORDER BY rowid");
  assert.deepEqual(acts.map((a) => [a.action, a.actor_id]), [
    ['rewards.ad.create', 'usr_owner'],
    ['rewards.ad.toggle', 'usr_asst'],
    ['rewards.ad.toggle', 'usr_owner'],
    ['rewards.ad.update', 'usr_owner'],
  ]);
});

test('the form is refused field by field, with a code the screen words, and a typo cannot be published', async () => {
  const { raw, as } = adminWorld();
  const owner = as(OWNER);
  const refused = async (patch: Record<string, unknown>, code: string) => {
    const res = await post(owner, '/api/admin/rewards/ads', { ...FORM, ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.equal((await json(res)).code, code, JSON.stringify(patch));
  };
  await refused({ title_ckb: '' }, 'REWARD_AD_TITLE_REQUIRED');
  await refused({ title_ckb: FORM.title_ar }, 'REWARD_AD_SORANI_COPY');
  await refused({ video_url: '' }, 'REWARD_AD_VIDEO_REQUIRED');
  await refused({ video_url: 'https://evil.example/ad.mp4' }, 'REWARD_AD_VIDEO_REQUIRED');
  await refused({ video_url: '/files/products/catalog/video/x.mp4' }, 'REWARD_AD_VIDEO_REQUIRED');
  await refused({ video_url: '/files/rewards/ads/video/typo.mp4' }, 'REWARD_AD_VIDEO_REQUIRED');
  await refused({ poster_url: 'https://evil.example/p.jpg' }, 'REWARD_AD_POSTER_INVALID');
  await refused({ poster_url: '/files/rewards/ads/poster/typo.webp' }, 'REWARD_AD_POSTER_INVALID');
  await refused({ width: 0 }, 'REWARD_AD_SIZE_INVALID');
  await refused({ duration_seconds: 3 }, 'REWARD_AD_DURATION_INVALID');
  await refused({ required_seconds: 2 }, 'REWARD_AD_SECONDS_INVALID');
  await refused({ required_seconds: 48 }, 'REWARD_AD_SECONDS_INVALID');
  await refused({ ends_at: FORM.starts_at }, 'REWARD_AD_WINDOW_INVALID');
  await refused({ starts_at: 'soon' }, 'REWARD_AD_WINDOW_INVALID');
  await refused({ max_views: 0 }, 'REWARD_AD_VIEWS_INVALID');
  await refused({ max_views: 51 }, 'REWARD_AD_VIEWS_INVALID');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM reward_ads'), 0, 'nothing refused was written');
  assert.equal((await post(owner, '/api/admin/rewards/ads', { ...FORM, poster_url: '', required_seconds: 30 })).status, 201, 'the poster is optional');
});

test('the owner’s list: views, viewers and points paid per ad, its state by the server’s clock, no cost anywhere', async () => {
  await onTheClock(async () => {
    const { raw, as } = adminWorld();
    ad(raw, { id: 'ad_live' });
    ad(raw, { id: 'ad_soon', sort: 1, starts: onDay(5) });
    ad(raw, { id: 'ad_past', sort: 2, starts: onDay(1) - 20 * DAY, ends: onDay(1) - 10 * DAY });
    ad(raw, { id: 'ad_off', sort: 3, active: 0 });
    raw.exec(`
      INSERT INTO reward_claims (id,user_id,mission,day,points,base_points,state,awarded_at,idempotency_key,wallet_tx_id,ad_id) VALUES
        ('r1','u1','video','2026-11-01',20,20,'awarded','x','k1','w1','ad_live'),
        ('r2','u1','video','2026-11-02',40,20,'awarded','x','k2','w2','ad_live'),
        ('r3','u2','video','2026-11-02',20,20,'awarded','x','k3','w3','ad_live'),
        ('r4','u2','video','2026-11-03',20,20,'started',NULL,'k4','w4','ad_live');
    `);
    const body = await json(await get(as(OWNER), '/api/admin/rewards/ads'));
    assert.equal(body.installed, true);
    assert.equal(body.mission_enabled, true);
    const by = Object.fromEntries(body.ads.map((a: { id: string }) => [a.id, a]));
    assert.equal(by.ad_live.phase, 'live');
    assert.equal(by.ad_soon.phase, 'upcoming');
    assert.equal(by.ad_past.phase, 'ended');
    assert.equal(by.ad_off.phase, 'off');
    assert.equal(by.ad_live.views, 3, 'paid views only: the open ticket is not one');
    assert.equal(by.ad_live.viewers, 2);
    assert.equal(by.ad_live.points_paid, 80);
    assert.equal(by.ad_soon.views, 0);
    assert.doesNotMatch(JSON.stringify(body), /cost/i);
  });
});

test('BEFORE 0227 an admin’s list is empty and a write says the table is not installed', async () => {
  const { as } = adminWorld(dbThrough('0225'));
  const list = await json(await get(as(OWNER), '/api/admin/rewards/ads'));
  assert.equal(list.installed, false);
  assert.deepEqual(list.ads, []);
  // The file check reads the ledger, which exists; the write is what cannot land.
  const res = await post(as(OWNER), '/api/admin/rewards/ads', FORM);
  assert.equal(res.status, 503);
  assert.equal((await json(res)).code, 'REWARDS_NOT_INSTALLED');
  const toggle = await post(as(OWNER), '/api/admin/rewards/ads/x/toggle', { active: false });
  assert.equal(toggle.status, 503);
});

// ------------------------------------------------------------ the page's wiring

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('the ad window fits a phone: the video’s own shape, never taller than the screen, inline, sound only if allowed, and it cannot hang', () => {
  const modal = read('src/components/points/AdWatchModal.tsx');
  assert.match(modal, /playsInline/);
  assert.match(modal, /width: `min\(100%, calc\(\$\{FRAME_HEIGHT\} \* \$\{ratio\}\)\)`/, 'width from the height it may take');
  assert.match(modal, /CSS\.supports\?\.\('height', '1dvh'\) \? '62dvh' : '62vh'/, 'of what the phone really shows');
  assert.match(modal, /aspectRatio: `\$\{shape\.w\} \/ \$\{shape\.h\}`/, 'its own aspect ratio');
  assert.doesNotMatch(modal, /aspect-video/, 'the old 16:9 box');
  assert.match(modal, /const chosenMute = useRef\(false\);/, 'with sound, until they choose otherwise');
  assert.match(modal, /video\.muted = chosenMute\.current;[\s\S]*await video\.play\(\);[\s\S]*NotAllowedError[\s\S]*video\.muted = true;/, 'muted only on a refusal, or their own choice');
  assert.match(modal, /chosenMute\.current = video\.muted;/, 'a choice survives a pause and a retry');
  assert.match(modal, /onPause=\{\(e\) => \{\s*const atEnd = e\.currentTarget\.ended;\s*setStage\(\(s\) => stageAfterPause\(s, atEnd\)\);/, 'a pause from outside offers the play button');
  assert.match(modal, /stage === 'playing' \|\| stage === 'blocked'/, 'and coming back to the page still carries on by itself');
  assert.match(modal, /if \(!cameBack\) void start\(\);/, 'a finished film is not played again');
  assert.match(modal, /filmNote = filmAt\(filmNote, videoUrl, ticket, v\.currentTime\);/, 'its place, through the one that ignores a 0');
  assert.match(modal, /v\.currentTime > 0 && Number\.isFinite\(v\.duration\)/, 'and the line does not jump back either');
  assert.match(modal, /keepFilmEnd\(filmEnded\(filmNote, videoUrl, ticket\)\);/);
  assert.match(modal, /toggleSound/);
  assert.match(modal, /poster=\{ad\?\.poster_url/);
  assert.match(modal, /role="progressbar"/);
  assert.match(modal, /onTimeUpdate=/, 'real playback');
  assert.match(modal, /onError=\{\(\) => setStage\('failed'\)\}/);
  assert.match(modal, /STUCK_AFTER_MS/, 'a watchdog: no spinner for ever');
  assert.match(modal, /const ready = ended && secondsLeft <= 0;/, 'the claim: ended, and the server’s seconds over');
  assert.doesNotMatch(modal, /\bautoPlay\b/, 'started by hand, so a refusal can be answered');
});

test('the points page draws the server’s ad and the card stays after today’s view; the admin has the tab', () => {
  const page = read('src/pages/Rewards.tsx');
  assert.match(page, /const allDailyDone = !!missions && missionsAllDone\(missions\);/);
  assert.match(page, /setAdShown\(\{ videoUrl: res\.videoUrl \?\? data\.missions\.video\.videoUrl, ad: res\.ad \?\? null, ticket: res\.started_at \?\? null \}\)/, 'what the server chose plays');
  assert.match(page, /videoClosed && videoCard &&/);
  assert.doesNotMatch(page, /\baspect-video\b/);
  const admin = read('src/components/adminRewards/AdminRewards.tsx');
  assert.match(admin, /\{ id: 'ads', label: loc\('الإعلانات', 'Ads', 'ڕیکلامەکان'\) \}/);
  assert.match(admin, /view === 'ads' && <AdminAds \/>/);
  assert.match(admin, /\{ id: 'settings', label: loc\('الإعدادات', 'Settings', 'ڕێکخستن'\) \}/, 'short enough for a quarter of a 390 px strip');
});

// ------------------------------------------------------------ the owner's form, on a phone

test('the form stays inside its panel while the owner’s real file uploads: one column on a phone that can shrink, and a tile that truncates', () => {
  const form = read('src/components/adminRewards/AdminAds.tsx');
  assert.match(form, /grid grid-cols-1 gap-4 sm:grid-cols-3" data-ad-form/, 'minmax(0, 1fr): an implicit column grows to its widest child');
  assert.match(form, /sm:col-span-2 min-w-0 space-y-2/, 'the column the tile sits in may shrink, so the file name truncates inside it');
  const tile = read('src/components/upload/UploadTile.tsx');
  assert.match(tile, /state\.status === 'failed' \? 'flex-wrap '/, 'a refusal is a sentence: its buttons take their own line');
  assert.match(tile, /flex w-full justify-end items-center gap-1/);
});

test('the form’s dates: the owner’s ten dates by default, and an empty date is a sentence, not a spinner left turning', () => {
  const dateOf = (s: string) => s.slice(0, 10);
  const count = (w: { starts_at: string; ends_at: string }) => (Date.parse(dateOf(w.ends_at)) - Date.parse(dateOf(w.starts_at))) / DAY + 1;
  for (const now of ['2026-11-06T02:30:00', '2026-11-06T23:59:00', '2026-11-25T12:00:00', '2026-12-28T00:00:00', '2027-02-25T08:00:00']) {
    const w = defaultAdWindow(new Date(now));
    assert.equal(count(w), AD_DEFAULT_DAYS, `${now}: ${w.starts_at} to ${w.ends_at}`);
    assert.equal(w.starts_at, toLocalInput(new Date(now).toISOString()));
    assert.match(w.ends_at, /T23:59$/);
  }
  assert.equal(AD_DEFAULT_DAYS, 10, 'the owner’s number');
  assert.deepEqual(defaultAdWindow(new Date('2026-11-06T02:30:00')), { starts_at: '2026-11-06T02:30', ends_at: '2026-11-15T23:59' });

  assert.deepEqual(adWindowIso({ starts_at: '2026-11-06T02:30', ends_at: '2026-11-15T23:59' }), {
    starts_at: new Date('2026-11-06T02:30').toISOString(),
    ends_at: new Date('2026-11-15T23:59').toISOString(),
  });
  assert.equal(adWindowIso({ starts_at: '', ends_at: '2026-11-15T23:59' }), null, 'the very case: new Date("").toISOString() threw');
  assert.equal(adWindowIso({ starts_at: '2026-11-06T02:30', ends_at: '' }), null);
  assert.equal(adWindowIso({ starts_at: 'garbage', ends_at: '2026-11-15T23:59' }), null);

  const form = read('src/components/adminRewards/AdminAds.tsx');
  const save = form.slice(form.indexOf('const save = async'), form.indexOf('const toggle = async'));
  assert.ok(save.indexOf('adWindowIso(form)') < save.indexOf("setBusy('save')"), 'asked before the spinner starts');
  assert.match(save, /if \(!dates\) \{\s*refuse\(apiRefusal\(\{ code: 'REWARD_AD_WINDOW_INVALID' \}, lang\)\);\s*return;/);
  assert.doesNotMatch(save, /toISOString/, 'nothing left here that can throw');
  assert.ok(REFUSAL_STRINGS.REWARD_AD_WINDOW_INVALID.ckb);
});

test('a refusal on the form comes into view: the sentence sits above a form taller than a phone, and «Save» at its foot', () => {
  const form = read('src/components/adminRewards/AdminAds.tsx');
  assert.match(form, /alertRef\.current\?\.scrollIntoView\(\{ block: 'center' \}\)/);
  assert.match(form, /\{error && <div ref=\{alertRef\} role="alert"/);
  assert.match(form, /setRefusals\(\(n\) => n \+ 1\)/, 'the same sentence twice comes into view twice: the text alone would not change');
  assert.doesNotMatch(form.replace('setError(text)', ''), /setError\((?!'')/, 'every refusal goes through it; only clearing sets the text directly');
});

// ------------------------------------------------------------ the old field is no way round

test('THE OLD FIELD IS THE OWNER’S TOO: while no ad row exists it publishes a film every customer is paid for, so it asks what the new tab asks; emptying it is any admin’s', async () => {
  const raw = freshDb();
  proOnSale(raw);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES
    ('u1','Sara','a@x.co','h','customer'), ('usr_owner','Owner','boss@x.co','h','admin'), ('usr_full','Full','full@x.co','h','admin'), ('usr_asst','Asst','asst@x.co','h','admin')`);
  const settings = (user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/admin', adminRoutes), { publishV2: false });
  const customer = stubApp(asD1(raw), buyer, (a) => a.route('/api/rewards', rewardRoutes), { publishV2: false });
  const FILM = 'https://example.com/anything.mp4';
  const put1 = (user: StubUser, value: string) => put(settings(user), '/api/admin/settings/adVideoUrl', { value });

  const assistant = await put1(ASSISTANT, FILM);
  assert.equal(assistant.status, 403, 'it answered 200, and a customer was paid for it');
  assert.equal((await json(assistant)).code, 'FINANCIAL_SCOPE_REQUIRED');
  const full = await put1(FULL, FILM);
  assert.equal(full.status, 403);
  assert.equal((await json(full)).code, 'OWNER_REQUIRED', 'the same answer the new tab gives a full admin');
  const unverified = await put1({ ...OWNER, email_verified_at: null }, FILM);
  assert.equal(unverified.status, 403);
  assert.equal((await json(unverified)).code, 'OWNER_EMAIL_UNVERIFIED');
  assert.equal((await videoOf(customer)).available, false, 'so no customer is offered it');

  assert.equal((await put1(OWNER, FILM)).status, 200, 'the owner may');
  const offered = await videoOf(customer);
  assert.equal(offered.available, true);
  assert.equal(offered.videoUrl, FILM);
  assert.equal((await put1(OWNER, 'ftp://x/y.mp4')).status, 400, 'still only a web address');

  assert.equal((await put1(ASSISTANT, '')).status, 200, 'switching it off gives nothing away, as on the new tab');
  assert.equal((await videoOf(customer)).available, false);

  const wallet = read('src/components/AdminWalletSettings.tsx');
  assert.match(wallet, /setUrlError\(apiRefusal\(e, lang, loc\('تعذّر الحفظ', 'Save failed', 'پاشەکەوت نەکرا'\)\)\);/, 'one sentence in the reader’s language, not «ar / en» at once');
});
