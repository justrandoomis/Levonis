/**
 * THE REWARDS AREA'S PURE MODEL (rewards spec §1.2, §2.3, §2.4, §3.1): which
 * page an address is, where Back falls back to, the clock rules, and which of
 * the server's facts a screen leads with. No React and no DOM, so
 * tests/rewardsModel.test.ts runs it as it is.
 *
 * It DECIDES NOTHING the server owns. States, windows, gates, holdings,
 * targets and counts arrive in the answer; this module only orders them,
 * picks the one card the hub leads with, and names the copy key each reads
 * as. Day counts use the server's clock, never the device's.
 */
import type { Language } from '../../translations';
import { formatDate, formatDayMonth } from '../orders/format';
import { copyText, countText, ordinal, pointsForm, type CopyKey } from './copy';
import type { Competition, PrinterToRate, RewardCoupon, RewardsHubData, Tri } from './types';

// ------------------------------------------------------------ addresses (§1.2)

export type Section = 'home' | 'coupons' | 'shop' | 'rate' | 'competitions' | 'competition' | 'unknown';

export interface SectionMatch {
  section: Section;
  /** The competition's id, decoded and checked; undefined when the address holds no valid one (NotFound, no fetch). */
  id?: string;
}

/** A competition id as the server mints and checks it. */
export const COMPETITION_ID = /^[A-Za-z0-9_-]{1,64}$/;

const LEAVES = new Map<string, Section>([
  ['coupons', 'coupons'],
  ['shop', 'shop'],
  ['rate', 'rate'],
  ['competitions', 'competitions'],
]);

function competitionId(segment: string): string | undefined {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  return COMPETITION_ID.test(id) ? id : undefined;
}

/**
 * The area's page for a pathname. Matching is case-blind and forgives one
 * trailing slash; the id keeps its own case. Anything else under /rewards
 * (the splat) is 'unknown', the area's own NotFound.
 */
export function sectionOf(pathname: string): SectionMatch {
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const original = path.split('/');
  const parts = path.toLowerCase().split('/');
  if (parts[0] !== '' || parts[1] !== 'rewards') return { section: 'unknown' };
  if (parts.length === 2) return { section: 'home' };
  if (parts.length === 3) return { section: LEAVES.get(parts[2]) ?? 'unknown' };
  if (parts.length === 4 && parts[2] === 'competitions') return { section: 'competition', id: competitionId(original[3]) };
  return { section: 'unknown' };
}

export type CompetitionsView = 'current' | 'results';

/** «النتائج» only for `view=results`; anything else is «الحالية». */
export function viewOf(search: string): CompetitionsView {
  return new URLSearchParams(search).get('view') === 'results' ? 'results' : 'current';
}

/** «مشاركاتي فقط»: `mine=1`, honoured only with the results. */
export function mineOf(search: string): boolean {
  return viewOf(search) === 'results' && new URLSearchParams(search).get('mine') === '1';
}

/** Where Back goes when there is no history to pop (`useGoBack`'s fallback). */
export const PARENT: Readonly<Record<Section, string>> = {
  home: '/',
  coupons: '/rewards',
  shop: '/rewards',
  rate: '/rewards',
  competitions: '/rewards',
  competition: '/rewards/competitions',
  unknown: '/rewards',
};

/** The h1 of each page. */
export const TITLE: Readonly<Record<Section, CopyKey>> = {
  home: 'title.home',
  coupons: 'title.coupons',
  shop: 'title.shop',
  rate: 'title.rate',
  competitions: 'title.competitions',
  competition: 'title.competition',
  unknown: 'title.home',
};

// ------------------------------------------------------------ clocks (§2.3)

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** A coupon this close to its end takes the hub's card before anything else. */
export const COUPON_ENDING_MS = 48 * HOUR_MS;

/** Milliseconds from the server's now to `iso`: negative once passed, NaN when either is unreadable. */
export function msLeft(iso: string, serverTime: string): number {
  return Date.parse(iso) - Date.parse(serverTime);
}

/** Whole days left by the SERVER's clock: 23 h → 0, 30 h → 1, 72 h → 3. */
export function wholeDaysLeft(iso: string, serverTime: string): number {
  return Math.floor(msLeft(iso, serverTime) / DAY_MS);
}

/** Under 24 hours left by the server's clock: the moment a live countdown replaces the date. */
export function underADay(iso: string, serverTime: string): boolean {
  return msLeft(iso, serverTime) < DAY_MS;
}

/**
 * The device-clock instant a live countdown counts to, so a phone with a
 * wrong clock still reaches the server's instant. `skewMs` is
 * Date.parse(server_time) − Date.now(), taken at each response.
 */
export function toDeviceTarget(iso: string, skewMs: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  return new Date(at - (Number.isFinite(skewMs) ? skewMs : 0)).toISOString();
}

// ------------------------------------------------------------ words the server sends

/** Own language, then English, then Arabic: a table per language, so Sorani never lands in an Arabic branch. */
const TRI_ORDER: Readonly<Record<Language, ReadonlyArray<keyof Tri>>> = {
  ar: ['ar', 'en'],
  en: ['en', 'ar'],
  ckb: ['ckb', 'en', 'ar'],
};

/**
 * A PRODUCT'S NAME, OR ITS OPTION'S OR ITS COLOUR'S: English on every screen, in every language
 * (product-form mandate §3 and §7; src/pages/Product.tsx `pickName`). The product page, the cart and
 * the checkout print it that way, so the rewards screens do too: one product, one name, from the
 * points shop to the invoice. `pickTri` is for what the owner writes in three languages.
 */
export function pickName(value: Partial<Tri> | null | undefined): string {
  return (value?.en || value?.ar || value?.ckb || '').trim();
}

const LATIN_RUN = /[A-Za-z0-9](?:[A-Za-z0-9 .,:/_+-]*[A-Za-z0-9+])?/g;

/**
 * THE OWNER'S WORDS IN AN ARABIC LINE KEEP THEIR ORDER. Every Latin or number run becomes its own left-to-right
 * isolate, so a title ending in «eSUN PLA+» keeps its plus (it was drawn «+eSUN PLA») and «1 كغم» its figure beside its
 * unit. Latin text is left alone. The rule of src/lib/bidi.ts `ltrRuns`, as a string: it takes any element and costs
 * no import of that module, which rides with the product page (tests/motionLazy.test.ts counts what a new importer splits).
 */
export function isolateLatin(text: string): string {
  return /[\u0600-\u06FF]/.test(text) ? text.replace(LATIN_RUN, (run) => `\u2066${run}\u2069`) : text;
}

/** The owner's three-language text (a title, a description) in the reader's language, or the nearest one written. */
export function pickTri(value: Partial<Tri> | null | undefined, lang: Language): string {
  if (!value) return '';
  for (const k of TRI_ORDER[lang] ?? TRI_ORDER.ar) {
    const s = value[k];
    if (typeof s === 'string' && s.trim()) return s;
  }
  return '';
}

/** «14 تشرين الثاني» inside the server's current year, the full date with its year otherwise. */
export function nearDate(iso: string | null | undefined, serverIso: string, lang: Language): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const now = new Date(serverIso);
  const sameYear = !Number.isNaN(now.getTime()) && at.getFullYear() === now.getFullYear();
  return sameYear ? formatDayMonth(iso, lang) : formatDate(iso, lang);
}

/** The list joiner in each language («PLA Basic، PETG HF»). Joiners are code, not copy. */
export const SEP: Readonly<Record<Language, string>> = { ar: '، ', en: ', ', ckb: '، ' };

// ------------------------------------------------------------ coupons (§3.2)

export type CouponDestination = { kind: 'path'; to: string } | { kind: 'choose' } | { kind: 'none' };

/**
 * Where «استخدمه الآن» takes the customer once the code is saved: free
 * delivery to the cart; a filament coupon to its one product, to a choice of
 * its products, or to its section. An older server sends no `targets` (the
 * cart takes the code); `null`, or targets with nothing on sale, is nowhere,
 * and the coupon shows no use button.
 */
export function couponDestination(c: RewardCoupon): CouponDestination {
  if (c.kind === 'free_shipping') return { kind: 'path', to: '/cart' };
  if (c.targets === undefined) return { kind: 'path', to: '/cart' };
  const t = c.targets;
  if (!t) return { kind: 'none' };
  const only = t.products?.[0];
  if (t.products_total === 1 && only?.slug) return { kind: 'path', to: `/product/${encodeURIComponent(only.slug)}` };
  if (t.products_total > 1) return { kind: 'choose' };
  if (t.section?.path) return { kind: 'path', to: t.section.path };
  return { kind: 'none' };
}

/** Live, and there is something to spend it on. */
export function usable(c: RewardCoupon): boolean {
  return c.state === 'active' && couponDestination(c).kind !== 'none';
}

export type RevokeKey = 'past.withdrawnOrder' | 'past.withdrawnReturn' | 'past.withdrawnTeam' | 'chip.withdrawn';

/** Why a coupon was withdrawn, as the past list says it (the reasons migration 0220 and the desk write). */
export function revokeKey(reason: string | null | undefined): RevokeKey {
  if (reason === 'order_cancelled') return 'past.withdrawnOrder';
  if (reason?.startsWith('return:')) return 'past.withdrawnReturn';
  if (reason === 'admin') return 'past.withdrawnTeam';
  return 'chip.withdrawn';
}

// ------------------------------------------------------------ the hub's card (§2.4)

export type NextAction =
  | { kind: 'coupon-ending'; coupon: RewardCoupon }
  | { kind: 'gift'; printer: PrinterToRate }
  | { kind: 'gift-code'; printer: PrinterToRate }
  | { kind: 'competition'; competition: Competition }
  | { kind: 'rate'; printer: PrinterToRate }
  | { kind: 'coupon'; coupon: RewardCoupon };

/** The item whose instant comes first; ties and unreadable instants keep the server's order. */
function soonest<T>(items: readonly T[], at: (item: T) => string): T | undefined {
  let best: T | undefined;
  let bestAt = Infinity;
  for (const item of items) {
    const t = Date.parse(at(item));
    const value = Number.isFinite(t) ? t : Infinity;
    if (best === undefined || value < bestAt) {
      best = item;
      bestAt = value;
    }
  }
  return best;
}

/**
 * The ONE thing «بانتظارك» offers, first match wins: a usable coupon ending
 * within 48 h (server order: active by soonest end), a gift to choose, an
 * approved review whose code is unwritten, the open competition closing first that this customer can enter, the newest
 * delivered printer to rate (with a page), any usable coupon. Otherwise
 * null, and no card is drawn. The shop never takes the card.
 */
export function nextAction(hub: RewardsHubData): NextAction | null {
  const coupons = hub.coupons ?? [];
  const printers = hub.printers ?? [];
  const ending = coupons.find((c) => usable(c) && msLeft(c.expires_at, hub.server_time) <= COUPON_ENDING_MS);
  if (ending) return { kind: 'coupon-ending', coupon: ending };
  const gift = printers.find((p) => p.state === 'reward_approved');
  if (gift) return { kind: 'gift', printer: gift };
  const code = printers.find((p) => p.state === 'code_ready');
  if (code) return { kind: 'gift-code', printer: code };
  const competition = soonest(
    (hub.competitions ?? []).filter((c) => c.gate?.can_enter === true),
    (c) => c.ends_at
  );
  if (competition) return { kind: 'competition', competition };
  const rate = printers.find((p) => p.state === 'to_rate' && !!p.slug);
  if (rate) return { kind: 'rate', printer: rate };
  const coupon = coupons.find(usable);
  if (coupon) return { kind: 'coupon', coupon };
  return null;
}

/** Where the hub's gift card goes, and what it says: a code's gift lives on «قيّم طابعتك», at its own step. */
export function giftCardCta(p: Pick<PrinterToRate, 'gift'>): { to: string; label: CopyKey } {
  if (p.gift?.scope !== 'up_to') return { to: '/gifts', label: 'rate.chooseGift' };
  if (p.gift.status === 'ADDED_TO_ORDER') return { to: '/cart', label: 'reveal.checkout' };
  return { to: '/rewards/rate', label: p.gift.status === 'REDEEMED' ? 'reveal.addToCart' : 'rate.chooseGift' };
}

// ------------------------------------------------------------ the hub's doors (§3.1)

/** One status line of a hub door: a counted sentence, or a copy key with the one value it takes. */
export type DoorText =
  | { count: 'couponsActive' | 'competitionsToEnter' | 'competitionsOpen' | 'printersToRate'; n: number }
  | {
      key:
        | 'door.coupons.hours'
        | 'door.coupons.how'
        | 'door.coupons.howWeekly'
        | 'door.competitions.judging'
        | 'door.competitions.none'
        | 'door.rate.gift'
        | 'door.rate.code'
        | 'door.rate.pending'
        | 'door.rate.done'
        | 'door.rate.void.returned'
        | 'door.rate.void.cancelled'
        | 'door.rate.how'
        | 'door.shop.checkout';
    }
  | { key: 'door.coupons.soonest' | 'door.competitions.upcoming'; date: string }
  | { key: 'door.competitions.won'; place: number }
  | { key: 'door.shop.from' | 'door.shop.fromBoth' | 'door.shop.fromProducts'; points: number };

export interface Door {
  lines: DoorText[];
  /** The figure the door's counted line spells, as a neutral, aria-hidden badge; 0 draws none. */
  badge: number;
}

export interface Doors {
  coupons: Door;
  competitions: Door;
  rate: Door;
  shop: Door;
}

/** Open, not entered, eligible and below its cap: the server's `open_to_enter`, counted from the preview when an older server sends no counts. */
function openToEnter(c: Competition): boolean {
  return c.phase === 'open' && !c.my_entry && c.eligible && (c.max_entries == null || c.entries_count < c.max_entries);
}

type CountedLine = Extract<DoorText, { count: string }>;

/**
 * A door from its lines. THE BADGE IS THE FIGURE THE LINE SPELLS (spec §2.2;
 * the owner chose it over §3.1's per-door badges, 2026-11-05 — DECISIONS row
 * 290): the badge is hidden from assistive tech, so a figure the line does
 * not say would reach no screen-reader user, and a sighted one would see a
 * number beside a sentence about something else («فزت بالمركز الثاني!» beside
 * a count of open competitions). A door whose line counts nothing shows none.
 */
function door(lines: DoorText[]): Door {
  const counted = lines.find((l): l is CountedLine => 'count' in l);
  return { lines, badge: counted && counted.n > 0 ? counted.n : 0 };
}

function couponsDoor(hub: RewardsHubData): Door {
  const active = (hub.coupons ?? []).filter((c) => c.state === 'active');
  const a = hub.coupon_counts?.active ?? active.length;
  if (a <= 0) return door([hub.program?.enabled ? { key: hub.program.weekly?.enabled ? 'door.coupons.howWeekly' : 'door.coupons.how' } : { count: 'couponsActive', n: 0 }]);
  const lines: DoorText[] = [{ count: 'couponsActive', n: a }];
  const first = soonest(active, (c) => c.expires_at);
  const left = first ? msLeft(first.expires_at, hub.server_time) : NaN;
  if (first && Number.isFinite(left)) lines.push(left < DAY_MS ? { key: 'door.coupons.hours' } : { key: 'door.coupons.soonest', date: first.expires_at });
  return door(lines);
}

function competitionsDoor(hub: RewardsHubData): Door {
  const preview = hub.competitions ?? [];
  const counts = hub.competition_counts;
  const toEnter = counts?.open_to_enter ?? preview.filter(openToEnter).length;
  const open = counts?.open ?? preview.filter((c) => c.phase === 'open').length;
  const place = preview.find((c) => c.phase === 'finished' && c.my_entry?.state === 'winner' && (c.my_entry.place ?? 0) >= 1)?.my_entry?.place;
  if (place) return door([{ key: 'door.competitions.won', place }]);
  if (preview.some((c) => c.phase === 'closed' && c.my_entry?.state === 'entered')) return door([{ key: 'door.competitions.judging' }]);
  if (toEnter > 0) return door([{ count: 'competitionsToEnter', n: toEnter }]);
  if (open > 0) return door([{ count: 'competitionsOpen', n: open }]);
  const upcoming = soonest(
    preview.filter((c) => c.phase === 'upcoming'),
    (c) => c.starts_at
  );
  if (upcoming) return door([{ key: 'door.competitions.upcoming', date: upcoming.starts_at }]);
  return door([{ key: 'door.competitions.none' }]);
}

function rateDoor(hub: RewardsHubData): Door {
  const printers = hub.printers ?? [];
  const toRate = printers.filter((p) => p.state === 'to_rate').length;
  // A code waiting is the news on this door, and a printer still to rate stays said beside it.
  if (printers.some((p) => p.state === 'code_ready')) {
    return door([{ key: 'door.rate.code' }, ...(toRate > 0 ? [{ count: 'printersToRate' as const, n: toRate }] : [])]);
  }
  if (toRate > 0) return door([{ count: 'printersToRate', n: toRate }]);
  if (printers.some((p) => p.state === 'reward_approved')) return door([{ key: 'door.rate.gift' }]);
  if (printers.some((p) => p.state === 'reward_pending')) return door([{ key: 'door.rate.pending' }]);
  // Row 303 R1: nothing else is waiting, and a code died with its printer: the door says why, not «all done».
  const voided = printers.find((p) => p.code_void);
  if (voided) return door([{ key: voided.code_void === 'cancelled' ? 'door.rate.void.cancelled' : 'door.rate.void.returned' }]);
  if (printers.length > 0) return door([{ key: 'door.rate.done' }]);
  return door([{ key: 'door.rate.how' }]);
}

/** What the shop sells, from its cheapest. A product out of stock is not what the door promises. */
function shopDoor(hub: RewardsHubData): Door {
  const coupons = (hub.shop ?? []).map((s) => s.points);
  const products = (hub.shop_items ?? []).filter((s) => s.available).map((s) => s.points);
  if (!coupons.length && !products.length) return door([{ key: 'door.shop.checkout' }]);
  const key = !products.length ? 'door.shop.from' : coupons.length ? 'door.shop.fromBoth' : 'door.shop.fromProducts';
  return door([{ key, points: Math.min(...coupons, ...products) }]);
}

/**
 * The four doors' status lines and badges, first match per door; each badge
 * is the figure its line spells, or none. Figures come from `coupon_counts`
 * and `competition_counts`, never from the length of a truncated preview; an
 * older server's answer falls back to the lists. `null` (the hub could not
 * load) gives the how-lines and no badges, and the competitions door no line
 * at all, since nothing is known about them.
 */
export function doorLines(hub: RewardsHubData | null | undefined): Doors {
  if (!hub) {
    return {
      // Weekly is the owner's programme (DECISIONS row 295): with no answer to read, the tile says so.
      coupons: door([{ key: 'door.coupons.howWeekly' }]),
      competitions: door([]),
      rate: door([{ key: 'door.rate.how' }]),
      shop: door([{ key: 'door.shop.checkout' }]),
    };
  }
  return { coupons: couponsDoor(hub), competitions: competitionsDoor(hub), rate: rateDoor(hub), shop: shopDoor(hub) };
}

/** A door line in the reader's words; `serverTime` dates it (the day and month inside the current year). */
export function doorText(line: DoorText, lang: Language, serverTime: string): string {
  if ('count' in line) return countText(line.count, line.n, lang);
  switch (line.key) {
    case 'door.coupons.soonest':
    case 'door.competitions.upcoming':
      return copyText(line.key, lang, { date: nearDate(line.date, serverTime, lang) });
    case 'door.competitions.won':
      return copyText(line.key, lang, { place: ordinal(line.place, lang) });
    case 'door.shop.from':
    case 'door.shop.fromBoth':
    case 'door.shop.fromProducts':
      return copyText(line.key, lang, { points: countText(pointsForm(line.key), line.points, lang) });
    default:
      return copyText(line.key, lang);
  }
}

// ------------------------------------------------------------ competitions (§3.5, §3.6)

export type CurrentPhase = 'open' | 'upcoming' | 'closed';

export interface CompetitionGroup {
  phase: CurrentPhase;
  items: Competition[];
}

const GROUP_ORDER: readonly CurrentPhase[] = ['open', 'upcoming', 'closed'];

/** «مفتوحة الآن», «تبدأ قريبًا», «قيد التحكيم», each in the server's order; an empty group is dropped. */
export function competitionGroups(items: readonly Competition[]): CompetitionGroup[] {
  return GROUP_ORDER.map((phase) => ({ phase, items: items.filter((c) => c.phase === phase) })).filter((g) => g.items.length > 0);
}

export type MyResult = 'won' | 'refunded_cancel' | 'rejected_refund' | 'rejected' | 'entered' | 'awaiting' | 'not_won' | 'cancelled_free';

const ENTERED_BY_PHASE: Partial<Record<Competition['phase'], MyResult>> = {
  open: 'entered',
  upcoming: 'entered',
  closed: 'awaiting',
  finished: 'not_won',
  cancelled: 'cancelled_free',
};

/** What became of this customer's entry: null with no entry. */
export function myResult(c: Pick<Competition, 'phase' | 'my_entry'>): MyResult | null {
  const e = c.my_entry;
  if (!e) return null;
  if (e.state === 'winner') return 'won';
  if (e.state === 'refunded') return c.phase === 'cancelled' ? 'refunded_cancel' : 'rejected_refund';
  if (e.state === 'disqualified') return 'rejected';
  if (e.state === 'entered') return ENTERED_BY_PHASE[c.phase] ?? 'entered';
  return null;
}

export type ResultWhen = { key: 'row.results' | 'row.ended'; date: string } | { key: 'chip.cancelled' };

/**
 * What a row of «النتائج» says of when it ended (§3.5): the day its winners
 * were announced, else the day it ended. A cancelled one («مشاركاتي فقط» lists
 * the ones this customer entered) has no announcement, and its planned end may
 * still be ahead, so it only says it was cancelled — and nothing when its chip
 * already says «أُلغيت» (a free entry's).
 */
export function resultWhen(c: Pick<Competition, 'phase' | 'my_entry' | 'results_at' | 'ends_at'>): ResultWhen | null {
  if (c.phase === 'cancelled') return myResult(c) === 'cancelled_free' ? null : { key: 'chip.cancelled' };
  return c.results_at ? { key: 'row.results', date: c.results_at } : { key: 'row.ended', date: c.ends_at };
}
