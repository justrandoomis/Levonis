/**
 * «المكافآت» — THE OLD ADDRESSES OF THE REWARDS KEEP WORKING (rewards spec
 * §1.5, §11; DECISIONS row 290).
 *
 * The rewards were four sections of /points, reached as /points#coupons,
 * #shop, #rate and #competitions. They are pages of their own now, but the old
 * addresses live on: in every notice already sent (a notice is written once,
 * INSERT OR IGNORE, and never rewritten), in the home tiles of row 288 an open
 * tab still holds, in bookmarks. Three things keep them working, and this
 * holds each:
 *   1. /points forwards the four hashes to their pages BEFORE the points page
 *      mounts — a <Navigate replace>, never an effect after a first paint and
 *      a wasted GET /api/rewards. Any other hash stays on /points.
 *   2. The bell opens a stored competition notice on that competition's own
 *      page (the notice names it), and a stored coupon notice on «كوبوناتي».
 *   3. Nothing new is written with an old address, and the doors name the
 *      pages: Profile's «المكافآت» opens /rewards, while its points figure and
 *      «تسجيل الدخول اليومي» stay on /points.
 *
 * Source assertions for the wiring — this repository has no browser runner,
 * and what is pinned is structural — and the pure mapping run as it is.
 *
 * Run: node --import tsx --test tests/rewardsLegacyLinks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { noticeDestination, type NotificationRow } from '../src/lib/notifications';
import { sectionOf } from '../src/components/rewards/model';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code only: a comment that names an old address must not fail the test that bans it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

/** Every .ts/.tsx file under a directory, as a repository-relative path. */
function sources(rel: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, rel))) {
    const child = `${rel}/${name}`;
    if (statSync(join(ROOT, child)).isDirectory()) sources(child, out);
    else if (/\.tsx?$/.test(name)) out.push(child);
  }
  return out;
}

/** The four sections that left /points, and the page each became. */
const MOVED: Readonly<Record<string, string>> = {
  coupons: '/rewards/coupons',
  shop: '/rewards/shop',
  rate: '/rewards/rate',
  competitions: '/rewards/competitions',
};

// ------------------------------------------------------------ 1. /points forwards before it mounts

test('/points knows exactly the four sections that moved, each to its own page of the rewards area', () => {
  const page = code('src/pages/Rewards.tsx');
  const table = /const MOVED_SECTIONS: Record<string, string> = \{([^}]*)\};/.exec(page);
  assert.ok(table, 'the forward table moved — update this check, do not delete it');
  assert.deepEqual(Object.fromEntries([...table[1].matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]])), MOVED);
  // Each target is a literal route of the area, and the area reads it as the section the hash named.
  const app = code('src/App.tsx');
  for (const [hash, to] of Object.entries(MOVED)) {
    assert.ok(app.includes(`<Route path="${to}" element={<RewardsArea />} />`), `${to} is not a route of the rewards area`);
    assert.equal(sectionOf(to).section, hash, `#${hash} lands on another page of the area`);
  }
});

test('the forward is a <Navigate replace> chosen before the points page mounts, on own keys only', () => {
  const page = code('src/pages/Rewards.tsx');
  const wrapper = /export default function Rewards\(\) \{([\s\S]*?)\n\}/.exec(page);
  assert.ok(wrapper, 'the default export moved — update this check, do not delete it');
  const body = wrapper[1];
  assert.match(body, /const \{ hash \} = useLocation\(\);/);
  assert.match(body, /Object\.prototype\.hasOwnProperty\.call\(MOVED_SECTIONS, section\)/, '«#constructor» is a hash, not a destination');
  assert.match(body, /return to \? <Navigate to=\{to\} replace \/> : <PointsPage \/>;/);
  // Nothing else happens first: no state, no effect, no read — the points page and its fetch never start on a moved hash.
  assert.doesNotMatch(body, /\buse(Effect|LayoutEffect|State|Wallet|Auth)\b|\bapi\.|navigate\(/);
  assert.match(page, /\nfunction PointsPage\(\) \{/, 'the points page itself is PointsPage, not exported');
  assert.equal((page.match(/\bexport default\b/g) ?? []).length, 1);
  assert.match(page, /import \{ Navigate, useLocation, useNavigate \} from 'react-router-dom';/);
});

test('no effect forwards any more, and the points page reaches for no hash or element', () => {
  const rel = 'src/pages/Rewards.tsx';
  const src = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^use(Layout)?Effect$/.test(n.expression.text)) effects.push(n.getText(src));
    ts.forEachChild(n, visit);
  };
  visit(src);
  assert.ok(effects.length > 0, 'the points page has effects (its read, the ad countdown) — the parse found none');
  for (const e of effects) assert.doesNotMatch(e, /MOVED_SECTIONS|\bhash\b|\/rewards/, `an effect still forwards: ${e.slice(0, 120)}`);
  assert.doesNotMatch(code(rel), /location\.hash|getElementById|scrollIntoView|scroll-mt-/, 'the old hash landing is back');
});

// ------------------------------------------------------------ 2. the bell maps stored notices

type Stored = Pick<NotificationRow, 'link' | 'entity_type' | 'entity_id'>;
/** A stored notice as the inbox serves it; `entity_id` is a nullable column, whatever the type says. */
const stored = (link: string, entity_type: string | null = null, entity_id: unknown = null): Stored => ({ link, entity_type, entity_id }) as Stored;

test('noticeDestination: a stored «🏆» or refund notice opens its competition; a stored coupon notice opens «كوبوناتي»', () => {
  // competitions.ts tell() wrote these, naming the competition.
  assert.equal(noticeDestination(stored('/points#competitions', 'competition', 'cmp_1')), '/rewards/competitions/cmp_1');
  assert.equal(noticeDestination(stored('/points#competitions', 'competition', 'Cmp-9_x')), '/rewards/competitions/Cmp-9_x');
  // No valid competition: the stored link stands, and /points forwards it to the list. Never «/rewards/competitions/null».
  const invalid: Array<[string | null, unknown]> = [
    ['competition', null],
    ['competition', undefined],
    ['competition', ''],
    ['competition', 'cmp 1'],
    ['competition', '../admin'],
    ['competition', 'x'.repeat(65)],
    ['competition', 42],
    ['order', 'cmp_1'],
    [null, null],
  ];
  for (const [type, id] of invalid) {
    assert.equal(noticeDestination(stored('/points#competitions', type, id)), '/points#competitions', `${String(type)} / ${String(id)}`);
  }
  // The printer coupons (an order) and the day-before reminder (a grant) both open «كوبوناتي».
  assert.equal(noticeDestination(stored('/points#coupons', 'order', 'ORD-1')), '/rewards/coupons');
  assert.equal(noticeDestination(stored('/points#coupons', 'reward_grant', 'g_1')), '/rewards/coupons');
  assert.equal(noticeDestination(stored('/points#coupons')), '/rewards/coupons');
});

test('noticeDestination leaves every other link as it was stored — the new notices\' own links included', () => {
  for (const link of [
    '/rewards/competitions/cmp_1',
    '/rewards/coupons',
    '/orders/ORD-1',
    '/requests/req_1',
    '/points',
    '/points#missions',
    '/points#shop',
    '/points#rate',
    '',
  ]) {
    assert.equal(noticeDestination(stored(link, 'competition', 'cmp_1')), link, link || '(no link)');
  }
});

test('the bell opens every in-app notice through noticeDestination; a Print Cloud notice keeps its own host', () => {
  const bell = code('src/components/notifications/NotificationBell.tsx');
  assert.match(bell, /import \{[^}]*\bnoticeDestination\b[^}]*\} from '\.\.\/\.\.\/lib\/notifications';/);
  assert.match(bell, /if \(cloud\) window\.location\.assign\(cloud\);\s*else navigate\(noticeDestination\(n\)\);/);
  assert.match(bell, /n\.kind === 'print_cloud' \? appReturnUrl\('cloud', mainSite, n\.link\) : null/);
  assert.doesNotMatch(bell, /navigate\(n\.link\)/, 'a stored link is followed as it is again');
});

// ------------------------------------------------------------ 3. nothing new uses an old address

test('no rewards writer names /points# any more: new notices link to the pages themselves', () => {
  const files = sources('worker/lib/rewards');
  assert.ok(files.includes('worker/lib/rewards/competitions.ts') && files.includes('worker/lib/rewards/coupons.ts'), 'the rewards library moved');
  assert.deepEqual(files.filter((f) => read(f).includes('/points#')), []);
});

test('no code links to a moved section: the doors, the tiles and the assistant name the pages', () => {
  const OLD = /\/points#(coupons|shop|rate|competitions)\b/;
  // The one reader of the old addresses is the bell's mapping of stored notices.
  const readers = new Set(['src/lib/notifications.ts']);
  const hits = [...sources('worker'), ...sources('src')].filter((f) => !readers.has(f) && OLD.test(code(f)));
  assert.deepEqual(hits, [], 'an old address is written again; link to its page of the rewards area instead');
});

test('Profile: «المكافآت» opens the rewards area; the points figure and «تسجيل الدخول اليومي» stay on /points (spec §1.6)', () => {
  const profile = code('src/pages/Profile.tsx');
  // The card's button, with the sub-line that says what is there now.
  assert.match(
    profile,
    /onClick=\{\(\) => navigate\('\/rewards'\)\}[^>]*>\s*<span[^>]*>\{loc\('المكافآت', 'Rewards', 'خەڵاتەکان'\)\}<\/span>\s*<span[^>]*>\{loc\('كوبونات ومسابقات', 'Coupons & contests', 'کۆپۆن و پێشبڕکێ'\)\}<\/span>/
  );
  assert.doesNotMatch(profile, /'اكسب النقاط'/, 'the old sub-line is back');
  // The quick tile.
  assert.match(profile, /\{ icon: Star, label: loc\('المكافآت', 'Rewards', 'خەڵاتەکان'\), to: '\/rewards', soon: false \}/);
  // The balance's own page keeps its doors: the points figure and the daily sign-in.
  assert.match(profile, /onClick=\{\(\) => navigate\('\/points'\)\}>\s*<span[^>]*>\{loc\('النقاط', 'Points', 'خاڵەکان'\)\}<\/span>/);
  assert.match(profile, /\{ icon: Zap, label: loc\('تسجيل الدخول اليومي', 'Daily Sign-in', 'چوونەژوورەوەی ڕۆژانە'\), to: '\/points', soon: false \}/);
});
