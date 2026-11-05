/**
 * THE REWARDS AREA'S PURE MODEL (rewards spec §1.2, §2.3, §2.4, §3.1, §11):
 * which page an address is, where Back falls back to, the clock rules, the
 * one card the hub leads with, the doors' lines and badges, the competition
 * groups and the entry results. Every clock rule reads `server_time`: the
 * fixtures sit years away from the device's clock, and the answers do not
 * move when the server's year does.
 *
 * Run: node --import tsx --test tests/rewardsModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  PARENT,
  SEP,
  TITLE,
  competitionGroups,
  couponDestination,
  doorLines,
  doorText,
  mineOf,
  myResult,
  nearDate,
  nextAction,
  pickTri,
  resultWhen,
  revokeKey,
  sectionOf,
  toDeviceTarget,
  underADay,
  usable,
  viewOf,
  wholeDaysLeft,
  type DoorText,
  type Section,
} from '../src/components/rewards/model';
import type {
  Competition,
  CompetitionEntry,
  CompetitionGate,
  CouponTargets,
  PrinterToRate,
  RewardCoupon,
  RewardsHubData,
} from '../src/components/rewards/types';
import { formatDate, formatDayMonth } from '../src/components/orders/format';
import { formatFigure } from '../src/lib/localeNumber';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3_600_000;

// ------------------------------------------------------------ fixtures

/** Two server clocks, both years from the device's: 2021 and 2031. */
const SERVERS = ['2021-02-10T09:00:00.000Z', '2031-06-15T10:00:00.000Z'] as const;
const SERVER = SERVERS[1];
const at = (hours: number, server: string = SERVER) => new Date(Date.parse(server) + hours * HOUR).toISOString();

const tri = (en: string) => ({ ar: `${en} (ar)`, en, ckb: `${en} (ckb)` });

function targets(total: number, over: Partial<CouponTargets> = {}): CouponTargets {
  const products = Array.from({ length: Math.min(total, 20) }, (_, i) => ({ id: `p${i + 1}`, slug: `filament-${i + 1}`, name: tri(`Filament ${i + 1}`), image: '' }));
  return { products, products_total: total, section: null, ...over };
}

/** A free-delivery coupon, live for a week; no `targets` key (free delivery's is null on the new server, absent on an older one). */
function coupon(over: Partial<RewardCoupon> = {}, server: string = SERVER): RewardCoupon {
  return {
    id: 'g-ship',
    kind: 'free_shipping',
    source: 'printer',
    state: 'active',
    code: 'RWS7K2M9P4QX',
    percent: 100,
    max_discount_iqd: null,
    scope: 'global',
    category_id: null,
    product_ids: [],
    issued_at: at(-24, server),
    expires_at: at(24 * 7, server),
    order_id: 'o1',
    points_spent: 0,
    used_on_order_id: null,
    revoke_reason: '',
    ...over,
  };
}

function filament(total: number, over: Partial<RewardCoupon> = {}, server: string = SERVER): RewardCoupon {
  return coupon({ id: 'g-fil', kind: 'filament_discount', percent: 15, max_discount_iqd: 25000, scope: 'products', product_ids: ['p1'], targets: targets(total), ...over }, server);
}

function printer(state: PrinterToRate['state'], over: Partial<PrinterToRate> = {}): PrinterToRate {
  return {
    order_id: `o-${state}`,
    product_id: `pr-${state}`,
    slug: `printer-${state}`,
    name: tri(`Printer ${state}`),
    image: '',
    delivered_at: at(-72),
    state,
    stars: state === 'rated' ? 5 : null,
    reward_level: state === 'reward_approved' ? 3 : null,
    ...over,
  };
}

function entry(state: CompetitionEntry['state'], over: Partial<CompetitionEntry> = {}): CompetitionEntry {
  return { id: `e-${state}`, state, place: state === 'winner' ? 1 : null, prize_points: 0, entry_points: 0, answer: '', media_url: null, created_at: at(-48), ...over };
}

const OPEN_GATE: CompetitionGate = { can_enter: true, blocked_by: null, points_short: 0, spots_left: null };

function competition(phase: Competition['phase'], over: Partial<Competition> = {}, server: string = SERVER): Competition {
  return {
    id: `cmp_${phase}`,
    title: tri(`Competition ${phase}`),
    description: tri('Rules'),
    prize: tri(''),
    entry_mode: 'free',
    entry_points: 0,
    submission: 'photo_text',
    eligibility: 'everyone',
    prize_points: [5000, 2000, 1000],
    max_entries: null,
    starts_at: at(-24 * 3, server),
    ends_at: at(24 * 10, server),
    phase,
    entries_count: 0,
    eligible: true,
    my_entry: null,
    winners: [],
    ...over,
  };
}

function hub(over: Partial<RewardsHubData> = {}, server: string = SERVER): RewardsHubData {
  return {
    installed: true,
    server_time: server,
    point_balance: 12450,
    pending_points: { points: 0, next_available_at: null },
    program: {
      enabled: true,
      valid_days: 7,
      free_shipping: { enabled: true },
      filament: { enabled: true, percent: 15, max_discount_iqd: 25000, products: [], section: null },
    },
    coupons: [],
    printers: [],
    rating: { gift_levels: [], review_points: 500 },
    shop: [],
    competitions: [],
    ...over,
  };
}

// ------------------------------------------------------------ addresses

test('sectionOf: the area pages, case-blind, one trailing slash forgiven, ids decoded and checked', () => {
  const cases: Array<[string, { section: Section; id?: string }]> = [
    ['/rewards', { section: 'home' }],
    ['/rewards/', { section: 'home' }],
    ['/REWARDS', { section: 'home' }],
    ['/rewards/coupons', { section: 'coupons' }],
    ['/Rewards/Coupons/', { section: 'coupons' }],
    ['/rewards/shop', { section: 'shop' }],
    ['/rewards/rate', { section: 'rate' }],
    ['/rewards/competitions', { section: 'competitions' }],
    ['/rewards/competitions/', { section: 'competitions' }],
    ['/rewards/competitions/cmp_0123456789abcdef0123', { section: 'competition', id: 'cmp_0123456789abcdef0123' }],
    // The id keeps its own case; only the matching is case-blind.
    ['/Rewards/COMPETITIONS/Cmp_AbC-9', { section: 'competition', id: 'Cmp_AbC-9' }],
    ['/rewards/competitions/cmp_1/', { section: 'competition', id: 'cmp_1' }],
    // An encoded id is decoded.
    ['/rewards/competitions/cmp%5F1', { section: 'competition', id: 'cmp_1' }],
    [`/rewards/competitions/${'a'.repeat(64)}`, { section: 'competition', id: 'a'.repeat(64) }],
    // A malformed escape or an id that is not one: the competition page, no id (NotFound, no fetch).
    ['/rewards/competitions/%E0%A4%A', { section: 'competition', id: undefined }],
    ['/rewards/competitions/a%2Fb', { section: 'competition', id: undefined }],
    ['/rewards/competitions/bad.id', { section: 'competition', id: undefined }],
    ['/rewards/competitions/%20', { section: 'competition', id: undefined }],
    [`/rewards/competitions/${'a'.repeat(65)}`, { section: 'competition', id: undefined }],
    // Everything else under /rewards is the splat: the area's own NotFound.
    ['/rewards/nope', { section: 'unknown' }],
    ['/rewards/coupons/extra', { section: 'unknown' }],
    ['/rewards/competitions/cmp_1/entries', { section: 'unknown' }],
    ['/rewards//', { section: 'unknown' }],
    ['/rewardsx', { section: 'unknown' }],
    ['/points', { section: 'unknown' }],
    ['/', { section: 'unknown' }],
    ['', { section: 'unknown' }],
  ];
  for (const [path, want] of cases) assert.deepEqual(sectionOf(path), want, path);
});

test('viewOf and mineOf: «النتائج» only for view=results, «مشاركاتي فقط» only with it', () => {
  for (const s of ['?view=results', 'view=results', '?x=1&view=results', '?view=results&mine=1']) assert.equal(viewOf(s), 'results', s);
  for (const s of ['', '?', '?view=current', '?view=Results', '?view=', '?view=resultsx', '?mine=1']) assert.equal(viewOf(s), 'current', s);
  assert.equal(mineOf('?view=results&mine=1'), true);
  assert.equal(mineOf('?mine=1&view=results'), true);
  for (const s of ['?mine=1', '?view=current&mine=1', '?view=results', '?view=results&mine=true', '?view=results&mine=0']) assert.equal(mineOf(s), false, s);
});

test('PARENT and TITLE: Back falls back one level up; each page names itself', () => {
  assert.deepEqual(PARENT, {
    home: '/',
    coupons: '/rewards',
    shop: '/rewards',
    rate: '/rewards',
    competitions: '/rewards',
    competition: '/rewards/competitions',
    unknown: '/rewards',
  });
  assert.deepEqual(TITLE, {
    home: 'title.home',
    coupons: 'title.coupons',
    shop: 'title.shop',
    rate: 'title.rate',
    competitions: 'title.competitions',
    competition: 'title.competition',
    unknown: 'title.home',
  });
});

// ------------------------------------------------------------ clocks

test('wholeDaysLeft counts by the server clock: 23 h → 0, 30 h → 1, 72 h → 3', () => {
  for (const server of SERVERS) {
    assert.equal(wholeDaysLeft(at(23, server), server), 0);
    assert.equal(wholeDaysLeft(at(30, server), server), 1);
    assert.equal(wholeDaysLeft(at(72, server), server), 3);
    assert.equal(wholeDaysLeft(at(-1, server), server), -1);
    assert.equal(underADay(at(23, server), server), true);
    assert.equal(underADay(at(25, server), server), false);
  }
});

test('toDeviceTarget moves the server instant onto the device clock by the measured skew', () => {
  const iso = '2031-06-20T18:00:00.000Z';
  assert.equal(toDeviceTarget(iso, 0), iso);
  // The server is an hour ahead of this phone: the phone reaches that instant an hour earlier by its own clock.
  assert.equal(toDeviceTarget(iso, HOUR), '2031-06-20T17:00:00.000Z');
  assert.equal(toDeviceTarget(iso, -90_000), '2031-06-20T18:01:30.000Z');
  assert.equal(toDeviceTarget(iso, Number.NaN), iso);
  assert.equal(toDeviceTarget('not a date', HOUR), 'not a date');
});

test('pickTri: own language, then English, then Arabic', () => {
  const all = { ar: 'عربي', en: 'English', ckb: 'کوردی' };
  assert.equal(pickTri(all, 'ckb'), 'کوردی');
  assert.equal(pickTri(all, 'en'), 'English');
  assert.equal(pickTri(all, 'ar'), 'عربي');
  assert.equal(pickTri({ ...all, ckb: '' }, 'ckb'), 'English', 'Sorani missing: English before Arabic');
  assert.equal(pickTri({ ...all, ckb: '  ', en: '' }, 'ckb'), 'عربي', 'Arabic only when English is empty too');
  assert.equal(pickTri({ ...all, en: '' }, 'en'), 'عربي');
  assert.equal(pickTri({ ...all, ar: '' }, 'ar'), 'English');
  assert.equal(pickTri({ ar: '', en: '', ckb: 'کوردی' }, 'ar'), '', 'never another reader\'s Sorani');
  assert.equal(pickTri(null, 'ar'), '');
  assert.equal(pickTri(undefined, 'ckb'), '');
});

test('nearDate: the day and month inside the server\'s year, the full date outside it', () => {
  const server = '2031-06-15T10:00:00.000Z';
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.equal(nearDate('2031-11-14T12:00:00Z', server, lang), formatDayMonth('2031-11-14T12:00:00Z', lang), lang);
    assert.equal(nearDate('2032-01-20T12:00:00Z', server, lang), formatDate('2032-01-20T12:00:00Z', lang), lang);
    assert.equal(nearDate('2030-12-01T12:00:00Z', server, lang), formatDate('2030-12-01T12:00:00Z', lang), lang);
    assert.equal(nearDate('2031-11-14T12:00:00Z', 'not a date', lang), formatDate('2031-11-14T12:00:00Z', lang), lang);
    assert.equal(nearDate('', server, lang), '');
    assert.equal(nearDate(null, server, lang), '');
  }
  assert.equal(nearDate('2031-11-14T12:00:00Z', server, 'en'), '14 Nov');
  assert.ok(nearDate('2032-01-20T12:00:00Z', server, 'en').includes('2032'));
});

test('SEP joins lists in each language; joiners are code, not copy', () => {
  assert.deepEqual(SEP, { ar: '، ', en: ', ', ckb: '، ' });
});

// ------------------------------------------------------------ coupons

test('couponDestination: cart, the one product, a choice, the section, or nowhere', () => {
  assert.deepEqual(couponDestination(coupon()), { kind: 'path', to: '/cart' }, 'free delivery');
  const older = filament(1);
  delete older.targets;
  assert.deepEqual(couponDestination(older), { kind: 'path', to: '/cart' }, 'an older server sends no targets: the cart takes the code');
  assert.deepEqual(couponDestination(filament(1)), { kind: 'path', to: '/product/filament-1' });
  assert.deepEqual(
    couponDestination(filament(1, { targets: targets(1, { products: [{ id: 'p1', slug: 'pla basic/1', name: tri('PLA'), image: '' }] }) })),
    { kind: 'path', to: '/product/pla%20basic%2F1' },
    'the slug is encoded'
  );
  assert.deepEqual(couponDestination(filament(2)), { kind: 'choose' });
  assert.deepEqual(couponDestination(filament(200)), { kind: 'choose' });
  const section = { id: 'cat1', slug: 'filament', path: '/category/filament', name: tri('Filament') };
  assert.deepEqual(couponDestination(filament(0, { scope: 'category', targets: targets(0, { section }) })), { kind: 'path', to: '/category/filament' });
  assert.deepEqual(couponDestination(filament(0)), { kind: 'none' }, 'nothing it covers is on sale');
  assert.deepEqual(couponDestination(filament(1, { targets: targets(1, { products: [{ id: 'p1', slug: '', name: tri('PLA'), image: '' }] }) })), { kind: 'none' }, 'one product with no page');
  assert.deepEqual(couponDestination(filament(1, { targets: null })), { kind: 'none' });

  assert.equal(usable(coupon()), true);
  assert.equal(usable(filament(2)), true);
  assert.equal(usable(filament(0)), false, 'live, but nothing to spend it on');
  for (const state of ['used', 'expired', 'revoked'] as const) assert.equal(usable(coupon({ state })), false, state);
});

test('revokeKey names why a coupon was withdrawn', () => {
  assert.equal(revokeKey('order_cancelled'), 'past.withdrawnOrder');
  assert.equal(revokeKey('return:rc_0123'), 'past.withdrawnReturn');
  assert.equal(revokeKey('admin'), 'past.withdrawnTeam');
  for (const r of ['', 'returned', 'something else', null, undefined]) assert.equal(revokeKey(r), 'chip.withdrawn', String(r));
});

// ------------------------------------------------------------ the hub's card

test('nextAction: the one card, first match wins (1 → 5, then none), by the server clock only', () => {
  for (const server of SERVERS) {
    const ending = coupon({ id: 'g-ending', expires_at: at(30, server) }, server);
    const later = coupon({ id: 'g-later', expires_at: at(24 * 6, server) }, server);
    const approved = printer('reward_approved');
    const noPage = printer('to_rate', { order_id: 'o-nopage', slug: '' });
    const toRate = printer('to_rate');
    const closingFirst = competition('open', { id: 'cmp_first', ends_at: at(24 * 2, server), gate: OPEN_GATE }, server);
    const closingLater = competition('open', { id: 'cmp_later', ends_at: at(24 * 5, server), gate: OPEN_GATE }, server);
    const blocked = competition('open', { id: 'cmp_blocked', ends_at: at(24, server), gate: { ...OPEN_GATE, can_enter: false, blocked_by: 'entered' } }, server);
    const noGate = competition('open', { id: 'cmp_nogate', ends_at: at(12, server) }, server);
    const full = (over: Partial<RewardsHubData>) =>
      hub({ coupons: [ending, later], printers: [approved, noPage, toRate], competitions: [closingLater, blocked, noGate, closingFirst], ...over }, server);

    assert.deepEqual(nextAction(full({})), { kind: 'coupon-ending', coupon: ending }, `${server}: 1`);
    assert.deepEqual(nextAction(full({ coupons: [later] })), { kind: 'gift', printer: approved }, `${server}: 2`);
    assert.deepEqual(nextAction(full({ coupons: [later], printers: [noPage, toRate] })), { kind: 'competition', competition: closingFirst }, `${server}: 3`);
    assert.deepEqual(nextAction(full({ coupons: [later], printers: [noPage, toRate], competitions: [blocked, noGate] })), { kind: 'rate', printer: toRate }, `${server}: 4`);
    assert.deepEqual(nextAction(full({ coupons: [filament(0, {}, server), later], printers: [noPage], competitions: [blocked] })), { kind: 'coupon', coupon: later }, `${server}: 5`);
    assert.equal(nextAction(full({ coupons: [filament(0, {}, server)], printers: [noPage], competitions: [blocked] })), null, `${server}: none`);

    // The 48-hour edge, and an ending coupon with nothing to spend it on never takes the card.
    assert.equal(nextAction(hub({ coupons: [coupon({ expires_at: at(48, server) }, server)] }, server))?.kind, 'coupon-ending');
    assert.equal(nextAction(hub({ coupons: [coupon({ expires_at: new Date(Date.parse(at(48, server)) + 1).toISOString() }, server)] }, server))?.kind, 'coupon');
    assert.equal(nextAction(hub({ coupons: [filament(0, { expires_at: at(2, server) }, server)] }, server)), null);
  }
  // The shop never takes the card.
  assert.equal(nextAction(hub({ shop: [{ kind: 'free_shipping', points: 5000, affordable: true, holding: false, points_short: 0 }] })), null);
});

// ------------------------------------------------------------ the hub's doors

test('doorLines «كوبوناتي»: the count from coupon_counts, then the soonest end; the how-line when there is none', () => {
  const soon = coupon({ id: 'g1', expires_at: at(10) });
  const week = coupon({ id: 'g2', expires_at: at(24 * 7) });
  assert.deepEqual(doorLines(hub({ coupons: [soon, week], coupon_counts: { active: 5, past: 12 } })).coupons, {
    lines: [{ count: 'couponsActive', n: 5 }, { key: 'door.coupons.hours' }],
    badge: 5,
  });
  const inDays = coupon({ id: 'g3', expires_at: at(24 * 3) });
  assert.deepEqual(doorLines(hub({ coupons: [week, inDays], coupon_counts: { active: 2, past: 0 } })).coupons, {
    lines: [{ count: 'couponsActive', n: 2 }, { key: 'door.coupons.soonest', date: inDays.expires_at }],
    badge: 2,
  });
  // Counts absent (an older server): the list's live coupons.
  assert.deepEqual(doorLines(hub({ coupons: [week, coupon({ id: 'g4', state: 'used' })] })).coupons, {
    lines: [{ count: 'couponsActive', n: 1 }, { key: 'door.coupons.soonest', date: week.expires_at }],
    badge: 1,
  });
  assert.deepEqual(doorLines(hub({ coupon_counts: { active: 0, past: 3 } })).coupons, { lines: [{ key: 'door.coupons.how' }], badge: 0 });
  const off = hub();
  off.program.enabled = false;
  assert.deepEqual(doorLines(off).coupons, { lines: [{ count: 'couponsActive', n: 0 }], badge: 0 });
});

test('doorLines «المسابقات»: a win, then judging, then the counts, then the next start, then none', () => {
  const won = competition('finished', { id: 'cmp_won', my_entry: entry('winner', { place: 2 }) });
  const judging = competition('closed', { id: 'cmp_judging', my_entry: entry('entered') });
  const counts = { open: 2, upcoming: 1, closed: 1, open_to_enter: 1 };
  const door = (over: Partial<RewardsHubData>) => doorLines(hub(over)).competitions;
  // The win and the judging lines count nothing, so the door shows no figure beside them (owner, 2026-11-05).
  assert.deepEqual(door({ competitions: [judging, won], competition_counts: counts }), { lines: [{ key: 'door.competitions.won', place: 2 }], badge: 0 });
  assert.deepEqual(door({ competitions: [judging], competition_counts: counts }), { lines: [{ key: 'door.competitions.judging' }], badge: 0 });
  assert.deepEqual(door({ competition_counts: { ...counts, open_to_enter: 3 } }), { lines: [{ count: 'competitionsToEnter', n: 3 }], badge: 3 });
  // «مسابقتان مفتوحتان الآن»: the badge is the figure the line says.
  assert.deepEqual(door({ competition_counts: { ...counts, open_to_enter: 0 } }), { lines: [{ count: 'competitionsOpen', n: 2 }], badge: 2 });
  const later = competition('upcoming', { id: 'cmp_u2', starts_at: at(24 * 9) });
  const sooner = competition('upcoming', { id: 'cmp_u1', starts_at: at(24 * 4) });
  assert.deepEqual(door({ competitions: [later, sooner], competition_counts: { open: 0, upcoming: 2, closed: 0, open_to_enter: 0 } }), {
    lines: [{ key: 'door.competitions.upcoming', date: sooner.starts_at }],
    badge: 0,
  });
  assert.deepEqual(door({ competition_counts: { open: 0, upcoming: 0, closed: 0, open_to_enter: 0 } }), { lines: [{ key: 'door.competitions.none' }], badge: 0 });
  // A finished competition this customer did not win, or a closed one they did not enter, says nothing of them.
  assert.deepEqual(door({ competitions: [competition('finished', { my_entry: entry('entered') }), competition('closed')] }), { lines: [{ key: 'door.competitions.none' }], badge: 0 });

  // Counts absent (an older server): open-to-enter counted from the preview — not entered, eligible, below the cap.
  const preview = [
    competition('open', { id: 'a' }),
    competition('open', { id: 'b', max_entries: 50, entries_count: 49 }),
    competition('open', { id: 'c', my_entry: entry('entered') }),
    competition('open', { id: 'd', eligible: false }),
    competition('open', { id: 'e', max_entries: 50, entries_count: 50 }),
  ];
  assert.deepEqual(door({ competitions: preview }), { lines: [{ count: 'competitionsToEnter', n: 2 }], badge: 2 });
  assert.deepEqual(door({ competitions: preview.slice(2) }), { lines: [{ count: 'competitionsOpen', n: 3 }], badge: 3 });
});

test('doorLines «قيّم طابعتك» and «استبدل نقاطك»: to rate, a gift, pending, done, how; the cheapest swap or checkout', () => {
  const rate = (printers: PrinterToRate[]) => doorLines(hub({ printers })).rate;
  // «طابعتان بانتظار مراجعتك»: 2, not the gift beside them that the line does not mention.
  assert.deepEqual(rate([printer('reward_approved'), printer('to_rate'), printer('to_rate', { order_id: 'o2' }), printer('rated')]), {
    lines: [{ count: 'printersToRate', n: 2 }],
    badge: 2,
  });
  assert.deepEqual(rate([printer('rated'), printer('reward_approved')]), { lines: [{ key: 'door.rate.gift' }], badge: 0 });
  assert.deepEqual(rate([printer('rated'), printer('reward_pending')]), { lines: [{ key: 'door.rate.pending' }], badge: 0 });
  assert.deepEqual(rate([printer('rated')]), { lines: [{ key: 'door.rate.done' }], badge: 0 });
  assert.deepEqual(rate([]), { lines: [{ key: 'door.rate.how' }], badge: 0 });

  const shop = doorLines(
    hub({
      shop: [
        { kind: 'filament_discount', points: 8000, affordable: true },
        { kind: 'free_shipping', points: 5000, affordable: true },
      ],
    })
  ).shop;
  assert.deepEqual(shop, { lines: [{ key: 'door.shop.from', points: 5000 }], badge: 0 });
  assert.deepEqual(doorLines(hub()).shop, { lines: [{ key: 'door.shop.checkout' }], badge: 0 });
});

test('doorLines with no hub (it could not load): the how-lines and no badges', () => {
  assert.deepEqual(doorLines(null), {
    coupons: { lines: [{ key: 'door.coupons.how' }], badge: 0 },
    competitions: { lines: [], badge: 0 },
    rate: { lines: [{ key: 'door.rate.how' }], badge: 0 },
    shop: { lines: [{ key: 'door.shop.checkout' }], badge: 0 },
  });
});

test('every door\'s badge is the figure its line spells, or none (owner, 2026-11-05: spec §2.2 over §3.1)', () => {
  // The badge is hidden from assistive tech, so the line is where its figure is heard.
  // Each hub's badges are written out, never derived from its lines:
  // [«كوبوناتي», «المسابقات», «قيّم طابعتك», «استبدل نقاطك»].
  const toRate = (n: number) => Array.from({ length: n }, (_, i) => printer('to_rate', { order_id: `o-rate-${i + 1}` }));
  const cases: Array<[string, RewardsHubData | null, readonly [number, number, number, number]]> = [
    ['nothing yet', hub(), [0, 0, 0, 0]],
    ['five coupons', hub({ coupons: [coupon({ expires_at: at(10) })], coupon_counts: { active: 5, past: 2 } }), [5, 0, 0, 0]],
    ['two coupons', hub({ coupons: [coupon()], coupon_counts: { active: 2, past: 0 } }), [2, 0, 0, 0]],
    [
      'a win beside three to enter',
      hub({ competitions: [competition('finished', { my_entry: entry('winner', { place: 1 }) })], competition_counts: { open: 4, upcoming: 0, closed: 0, open_to_enter: 3 } }),
      [0, 0, 0, 0],
    ],
    [
      'judging beside four open',
      hub({ competitions: [competition('closed', { my_entry: entry('entered') })], competition_counts: { open: 4, upcoming: 0, closed: 1, open_to_enter: 0 } }),
      [0, 0, 0, 0],
    ],
    ['twelve open, none to enter', hub({ competition_counts: { open: 12, upcoming: 0, closed: 0, open_to_enter: 0 } }), [0, 12, 0, 0]],
    ['eleven to enter', hub({ competition_counts: { open: 12, upcoming: 0, closed: 0, open_to_enter: 11 } }), [0, 11, 0, 0]],
    ['gifts waiting', hub({ printers: [printer('reward_approved'), printer('reward_approved', { order_id: 'o9' }), printer('reward_pending')] }), [0, 0, 0, 0]],
    ['three to rate beside a gift', hub({ printers: [...toRate(3), printer('reward_approved')] }), [0, 0, 3, 0]],
    ['one to rate', hub({ printers: toRate(1) }), [0, 0, 1, 0]],
    ['the shop', hub({ shop: [{ kind: 'free_shipping', points: 5000, affordable: true }] }), [0, 0, 0, 0]],
    ['no hub', null, [0, 0, 0, 0]],
  ];
  // The Arabic says one and two in words, not figures.
  const AR_WORDS: Readonly<Record<string, string>> = { 'coupons:2': 'كوبونان صالحان', 'rate:1': 'طابعة واحدة بانتظار مراجعتك' };
  const DOORS = ['coupons', 'competitions', 'rate', 'shop'] as const;
  let badges = 0;
  for (const [what, h, want] of cases) {
    const doors = doorLines(h);
    assert.deepEqual(DOORS.map((name) => doors[name].badge), [...want], what);
    DOORS.forEach((name, i) => {
      const n = want[i];
      if (!n) return;
      badges++;
      const counted = doors[name].lines.find((l) => 'count' in l);
      assert.ok(counted, `${what}: «${name}» shows ${n} beside a line that counts nothing`);
      for (const lang of ['en', 'ckb'] as const) {
        assert.ok(doorText(counted, lang, SERVER).includes(formatFigure(n, lang)), `${what} (${lang}): «${name}»'s line does not spell ${n}`);
      }
      const ar = doorText(counted, 'ar', SERVER);
      if (n >= 3) assert.ok(ar.includes(formatFigure(n, 'ar')), `${what} (ar): «${name}»'s line does not spell ${n}`);
      else assert.equal(ar, AR_WORDS[`${name}:${n}`], `${what} (ar)`);
    });
  }
  assert.equal(badges, 6, 'the coupons, open, to-enter and to-rate hubs draw a badge; the win, judging, gift, shop and how-lines none');
});

test('doorText words a door line: counted, dated by the server\'s year, the ordinal, the oblique points', () => {
  const lines: Array<[DoorText, 'ar' | 'en' | 'ckb', string]> = [
    [{ count: 'couponsActive', n: 2 }, 'ar', 'كوبونان صالحان'],
    [{ key: 'door.coupons.hours' }, 'en', 'The next one ends within hours'],
    [{ key: 'door.competitions.won', place: 2 }, 'ar', 'فزت بالمركز الثاني!'],
    [{ key: 'door.competitions.won', place: 2 }, 'en', 'You won 2nd place!'],
    [{ key: 'door.competitions.won', place: 2 }, 'ckb', 'پلەی دووەمت بردەوە!'],
    [{ key: 'door.shop.from', points: 2 }, 'ar', 'كوبونات تبدأ من نقطتين'],
    [{ key: 'door.coupons.soonest', date: '2031-11-14T12:00:00Z' }, 'ckb', 'نزیکترین کۆپۆن لە 14ی تشرینی دووەم کۆتایی دێت'],
    [{ key: 'door.competitions.upcoming', date: '2031-11-14T12:00:00Z' }, 'en', 'A new competition starts on 14 Nov'],
  ];
  for (const [line, lang, want] of lines) assert.equal(doorText(line, lang, SERVER), want, JSON.stringify(line));
});

// ------------------------------------------------------------ competitions

test('competitionGroups: open, upcoming, judging — each in the server\'s order, empty groups dropped', () => {
  const o1 = competition('open', { id: 'o1' });
  const o2 = competition('open', { id: 'o2' });
  const u1 = competition('upcoming', { id: 'u1' });
  const c1 = competition('closed', { id: 'c1' });
  const f1 = competition('finished', { id: 'f1' });
  const ids = (items: Competition[]) => competitionGroups(items).map((g) => [g.phase, g.items.map((c) => c.id)]);
  assert.deepEqual(ids([c1, o2, f1, u1, o1]), [
    ['open', ['o2', 'o1']],
    ['upcoming', ['u1']],
    ['closed', ['c1']],
  ]);
  assert.deepEqual(ids([c1, o1]), [
    ['open', ['o1']],
    ['closed', ['c1']],
  ]);
  assert.deepEqual(ids([f1]), []);
  assert.deepEqual(ids([]), []);
});

test('myResult: what became of the entry, by its state and the competition\'s phase', () => {
  const r = (phase: Competition['phase'], e: CompetitionEntry | null) => myResult({ phase, my_entry: e });
  assert.equal(r('open', null), null);
  assert.equal(r('finished', entry('winner')), 'won');
  assert.equal(r('cancelled', entry('refunded')), 'refunded_cancel');
  assert.equal(r('finished', entry('refunded')), 'rejected_refund');
  assert.equal(r('closed', entry('refunded')), 'rejected_refund');
  assert.equal(r('finished', entry('disqualified')), 'rejected');
  assert.equal(r('closed', entry('disqualified')), 'rejected');
  assert.equal(r('open', entry('entered')), 'entered');
  assert.equal(r('upcoming', entry('entered')), 'entered');
  assert.equal(r('closed', entry('entered')), 'awaiting');
  assert.equal(r('finished', entry('entered')), 'not_won');
  assert.equal(r('cancelled', entry('entered')), 'cancelled_free');
});

test('resultWhen: a result row is dated by its announcement, else its end; a cancelled one is never dated', () => {
  const announced = at(-24 * 2);
  assert.deepEqual(resultWhen(competition('finished', { results_at: announced, ends_at: at(-24 * 9) })), { key: 'row.results', date: announced });
  // An older server sends no results_at: the day it ended.
  assert.deepEqual(resultWhen(competition('finished', { ends_at: at(-24 * 9) })), { key: 'row.ended', date: at(-24 * 9) });
  assert.deepEqual(resultWhen(competition('finished', { results_at: null, ends_at: at(-24 * 9) })), { key: 'row.ended', date: at(-24 * 9) });
  // «مشاركاتي فقط» lists a cancelled competition its customer entered. Its planned end
  // is nine days ahead here: never «انتهت في …», only «أُلغيت» — once, so not beside the chip that says it.
  const cancelled = (e: CompetitionEntry) => competition('cancelled', { my_entry: e, ends_at: at(24 * 9) });
  assert.deepEqual(resultWhen(cancelled(entry('refunded', { entry_points: 500 }))), { key: 'chip.cancelled' }, 'beside «أُعيدت نقاطك»');
  assert.deepEqual(resultWhen(cancelled(entry('disqualified'))), { key: 'chip.cancelled' }, 'beside «لم تُقبل مشاركتك»');
  assert.equal(resultWhen(cancelled(entry('entered'))), null, 'a free entry\'s chip already says «أُلغيت»');
});

test('the model is pure: no React, no DOM', () => {
  const DOM = new Set(['document', 'window', 'localStorage', 'sessionStorage', 'navigator']);
  for (const f of ['src/components/rewards/model.ts', 'src/components/rewards/copy.ts', 'src/components/rewards/types.ts']) {
    const src = ts.createSourceFile(f, readFileSync(join(ROOT, f), 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = src.statements.filter(ts.isImportDeclaration).map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    assert.ok(!imports.some((m) => m === 'react' || m.startsWith('react-') || m.startsWith('react/')), `${f} imports ${imports.join(', ')}`);
    // Code, not strings: the copy key 'window.range' is a period of time, not the browser's window.
    const used: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && DOM.has(n.expression.text)) used.push(n.getText(src));
      ts.forEachChild(n, visit);
    };
    visit(src);
    assert.deepEqual(used, [], f);
  }
});
