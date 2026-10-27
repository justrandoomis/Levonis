/**
 * THE COMMUNITY ROUTES AND SEAMS (community UI plan B4).
 *
 *   * /community/following, /community/stores and /community/makers, and the
 *     request editor at /requests/new, /requests/new/:id and
 *     /requests/:id/edit: each a lazy chunk, each inside CommunityGate (plan
 *     R1), the editor behind ProtectedRoute too, and the /requests* family
 *     keeps the escrowed orders under the closed card.
 *   * The placeholders are useful the day they land: the section header and
 *     the list the home tab shows today.
 *   * Every old door still reaches the editor with what it carried: `?view=new`,
 *     `?link=`, `?project=` and the router state are forwarded by the board,
 *     replacing its entry; the request page edits at /requests/:id/edit,
 *     continues a draft at /requests/new/:id, and never publishes a draft
 *     without its review (critique 5).
 *
 * Fix round 1 (B2R1): a draft or an edit published from the editor goes back
 * onto the request page that opened it instead of stacking a second copy
 * (REG-3, `returnPublished`, run below); «أكمل وانشر» is not offered until
 * the editor opens a draft at its review, `?step=4` (REG-4, a C4 follow-up);
 * the Following page draws «مجتمع ليفو» under its title (FID-3, IMG_8486).
 *
 * Fix round 2 (B2R2): a new request lands on its own page with «طلباتي»
 * behind it, written outside the router so no board mounts between the two
 * writes (REG-1, `leaveNewRequest`, run below against a history whose pushes
 * wait in a view transition); an editor address for a request this person
 * cannot open says so in the reader language instead of drawing the wizard
 * (L10N-1, `requestMissing`).
 *
 * Fix round 3 (B2R3): a new request opened from the board «طلب جديد» steps
 * back onto the board and rewrites that entry as «طلباتي», so the board never
 * stays behind «طلباتي» unchanged on screen, and two Backs leave as they did
 * when the board opened the wizard in place (REG-1, run below on a history
 * that starts at the board).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { ROOT } from './fixtures/d1';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const app = code('src/App.tsx');

test('every new route is lazy and inside CommunityGate, the editor behind ProtectedRoute, and the entry names no new chunk', async () => {
  // The section pages are reached through the community home chunk, the editor through the board
  // chunk: the entry gains two cheap lazy doors to chunks it already names, and no preload list.
  assert.match(app, /const CommunitySections = React\.lazy\(\(\) => import\('\.\/pages\/Community'\)\.then\(\(m\) => \(\{ default: m\.CommunitySections \}\)\)\);/);
  assert.match(app, /const RequestEditor = React\.lazy\(\(\) => import\('\.\/pages\/Requests'\)\.then\(\(m\) => \(\{ default: m\.RequestEditor \}\)\)\);/);
  assert.match(code('src/pages/Community.tsx'), /export \{ default as CommunitySections \} from '\.\/community\/Sections';/);
  const board = code('src/pages/Requests.tsx');
  assert.match(board, /const RequestNew = lazy\(\(\) => import\('\.\/community\/RequestNew'\)\);/);
  // A component: React refuses a lazy that resolves to another lazy.
  assert.match(board, /export function RequestEditor\(\) \{\s*return \(\s*<Suspense fallback=\{null\}>\s*<RequestNew \/>\s*<\/Suspense>\s*\);\s*\}/);
  const doors = code('src/pages/community/Sections.tsx');
  for (const page of ['Following', 'Stores', 'Makers']) assert.match(doors, new RegExp(`lazy\\(\\(\\) => import\\('\\./${page}'\\)\\)`), `${page} is not its own lazy chunk`);
  // No module imports a page statically: each arrives with its route.
  for (const f of ['src/App.tsx', 'src/pages/Community.tsx', 'src/pages/Requests.tsx', 'src/pages/community/Sections.tsx']) {
    assert.doesNotMatch(read(f), /^import [^\n]*'\.{1,2}\/(?:pages\/)?(?:community\/)?(?:Following|Stores|Makers|RequestNew)'/m, `${f} imports a page eagerly`);
  }
  // The section door answers its three addresses, a trailing slash allowed, and nothing else.
  const { sectionOf } = await import('../src/pages/community/Sections');
  assert.equal(sectionOf('/community/following'), '/community/following');
  assert.equal(sectionOf('/community/stores/'), '/community/stores');
  assert.equal(sectionOf('/community/makers'), '/community/makers');
  assert.equal(sectionOf('/community/projects'), null);
  assert.equal(sectionOf('/community'), null);

  // Inside the gate (plan R1): one element answers the three section addresses.
  assert.match(app, /const communitySection = \(\s*<CommunityGate>\s*<CommunitySections \/>\s*<\/CommunityGate>\s*\);/);
  for (const path of ['/community/following', '/community/stores', '/community/makers']) {
    assert.match(app, new RegExp(`<Route path="${path.replace(/\//g, '\\/')}" element=\\{communitySection\\} />`), `${path} is not routed through the gate`);
  }
  // One element answers the three editor addresses (the optional segment folds /requests/new and
  // /requests/new/:id into one route): behind sign-in and the gate, the escrowed orders kept under the card.
  assert.match(app, /const requestEditor = \(\s*<ProtectedRoute>\s*<CommunityGate closedExtra=\{<RunningCommunityOrders \/>\}>\s*<RequestEditor \/>\s*<\/CommunityGate>\s*<\/ProtectedRoute>\s*\);/);
  assert.match(app, /<Route path="\/requests\/new\/:id\?" element=\{requestEditor\} \/>/);
  assert.match(app, /<Route path="\/requests\/:id\/edit" element=\{requestEditor\} \/>/);
  assert.equal(app.match(/element=\{requestEditor\}/g)?.length, 2);
  // «new» is a static segment, so it outranks the request page /requests/:id whatever the order.
  assert.match(app, /<Route path="\/requests\/:id" element=\{<CommunityGate closedExtra=\{<RunningCommunityOrders \/>\}><CommunityRequest \/><\/CommunityGate>\} \/>/);
});

test('the placeholders render the section header and the list the home tab shows today, inside the scope', () => {
  for (const [file, panel, header] of [
    ['src/pages/community/Stores.tsx', '<StoresPanel q={q}', '<SectionPageHeader title={s.tabs.stores} trailing={<SectionsButton />} />'],
    ['src/pages/community/Makers.tsx', '<CreatorsPanel q={q}', '<SectionPageHeader title={s.tabs.creators} trailing={<SectionsButton />} />'],
  ] as const) {
    const src = code(file);
    assert.match(src, /<CommunitySurface\b[^>]*>[\s\S]*<\/CommunitySurface>/, `${file}: the page root is not stamped`);
    assert.ok(src.includes(header), `${file}: no section header with the sections door`);
    assert.ok(src.includes(panel), `${file}: not the list of today`);
    // The list is a lazy chunk the home tab shares: the page and the entry that names it stay small.
    assert.match(src, /= lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/hub\/(FollowingPanel|StoresPanel|CreatorsPanel)'\)\);/, `${file}: the list is imported eagerly`);
  }
  // «أتابعهم» over «مجتمع ليفو», as IMG_8486 draws it (B2R1-FID-3); C2.1 moved its feed to feed/FollowingFeed.tsx.
  const following = code('src/pages/community/Following.tsx');
  assert.match(following, /<CommunitySurface\b[^>]*>[\s\S]*<\/CommunitySurface>/);
  assert.ok(following.includes('<SectionPageHeader title={s.tabs.following} kicker trailing={<SectionsButton />} />'));
  assert.ok(following.includes('<FollowingFeed from={from} composerLink={composerLink} />'));
  assert.match(following, /= lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/feed\/FollowingFeed'\)\);/, 'the feed is imported eagerly');
  // The stores directory left the home for its own module, and the home tab renders the same one.
  const home = code('src/pages/Community.tsx');
  assert.doesNotMatch(home, /function StoresPanel\(|function YourStore\(/, 'the stores panel is still a copy inside the home');
  assert.match(home, /const StoresPanel = React\.lazy\(\(\) => import\('\.\.\/components\/community\/hub\/StoresPanel'\)\);/);
  assert.match(home, /<StoresPanel q=\{q\} viewer=\{viewer\} me=\{me\} onClear=\{clearSearch\} \/>/);
  assert.match(code('src/components/community/hub/StoresPanel.tsx'), /export default function StoresPanel\(\{ q, viewer, me, onClear \}/);
  // The editor: the wizard of today under its own header.
  const editor = code('src/pages/community/RequestNew.tsx');
  assert.match(editor, /const RequestWizard = lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/requests\/RequestWizard'\)\);/, 'the wizard stays its own chunk');
  assert.match(editor, /<SectionPageHeader title=\{editing \? s\.editRequest : id \? s\.continueDraft : s\.kicker\}/);
  assert.match(editor, /<RequestWizard key=\{id \|\| 'new'\} requestId=\{id \|\| undefined\} initialLink=\{carriedLink \|\| undefined\} onDone=\{done\} onCancel=\{goBack\} \/>/);
});

/** The board forward, run as written (its types stripped). */
async function forwardOf(): Promise<(params: URLSearchParams) => string> {
  const src = read('src/pages/Requests.tsx');
  const at = src.indexOf('export function newRequestTarget(');
  assert.ok(at >= 0, 'the board no longer forwards to the editor');
  const body = src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
  const { code: js } = await transform(body, { loader: 'ts' });
  return new Function(`${js}; return newRequestTarget;`)() as (params: URLSearchParams) => string;
}

test('every old door still reaches the editor with its state: ?view=new, ?link=, ?project= and the router state', async () => {
  const target = await forwardOf();
  assert.equal(target(new URLSearchParams('view=new')), '/requests/new');
  const model = 'https://www.printables.com/model/12345-bracket';
  assert.equal(target(new URLSearchParams(`view=new&link=${encodeURIComponent(model)}`)), `/requests/new?link=${encodeURIComponent(model)}`);
  assert.equal(target(new URLSearchParams('view=new&project=p_lamp')), '/requests/new?project=p_lamp');
  assert.equal(target(new URLSearchParams('view=new&link=x&project=p&tab=foo')), '/requests/new?link=x&project=p', 'only what the editor reads rides along');

  const board = code('src/pages/Requests.tsx');
  // The address names the section once, at mount; a signed-in reader asking for the editor (or carrying a link) is forwarded.
  assert.match(board, /if \(\(asked === 'new' \|\| asked === 'orders'\) && user\) return asked;/);
  assert.match(board, /return carriedLink && user \? 'new' : 'board';/);
  assert.match(board, /printLink/, 'the price calculator link in the router state still opens the editor');
  // Replaced, with the router state (printLink, project), so Back never lands on the forward.
  assert.match(board, /if \(view === 'new'\) \{\s*navigate\(newRequestTarget\(params\), \{ replace: true, state: location\.state \}\);\s*return;\s*\}/);
  assert.match(board, /if \(deepLinked \|\| view === 'new'\) return null;/, 'nothing of the board flashes first');
  // The board own «طلب جديد» is a step forward, so Back returns to the board; it marks the editor
  // entry as pushed from the board, so a new request leaves «طلباتي» in its place (B2R3-REG-1).
  assert.match(board, /if \(user\) navigate\('\/requests\/new', \{ state: \{ from: 'board' \} \}\);\s*else signIn\(\);/);
  assert.doesNotMatch(board, /<RequestWizard\b|import RequestWizard/, 'the board still opens the wizard in place');

  // The editor reads both halves of a carried link: the state (a signed-in tap) and ?link= (it survives sign-in).
  const editor = code('src/pages/community/RequestNew.tsx');
  assert.match(editor, /const fromState = \(state as \{ printLink\?: unknown \} \| null\)\?\.printLink;\s*return typeof fromState === 'string' \? fromState : params\.get\('link'\) \?\? '';/);
  // A new request lands on its own page with «طلباتي» behind it, the board never routed in between
  // (B2R2-REG-1, run below); the channel window rides with a PUBLISHED request only.
  assert.match(editor, /if \(!id\) leaveNewRequest\(navigate, requestPath\(rid\), how === 'published', window, fromBoard\);/);
  assert.match(editor, /const fromBoard = !id && cameFromBoard\(location\.state\);/);
  assert.doesNotMatch(editor, /navigate\(\s*['"`]\/requests\?view=mine|navigate\(\s*MY_REQUESTS/, 'the editor routes the board before the request page again');
  // A draft or an edit published goes back onto the page that opened the editor (B2R1-REG-3).
  assert.match(editor, /else if \(how === 'published'\) returnPublished\(navigate, requestPath\(rid\)\);\s*else goBack\(\);/);
});

/** One exported function of the editor page, run as written (its types stripped), with what it names supplied. */
async function editorFn<T>(name: string, scope: Record<string, unknown> = {}): Promise<T> {
  const src = read('src/pages/community/RequestNew.tsx');
  const at = src.indexOf(`export function ${name}(`);
  assert.ok(at >= 0, `the editor page no longer has ${name}`);
  const body = src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
  const { code: js } = await transform(body, { loader: 'ts' });
  return new Function(...Object.keys(scope), `${js}; return ${name};`)(...Object.values(scope)) as T;
}

/**
 * A browser history and a router over it, wired as NavigationRouter wires them
 * (src/components/NavigationRouter.tsx, src/lib/stackNavigation.ts): every
 * write reaches the browser history at once; a router REPLACE renders at once,
 * a PUSH is held in a view transition until the script settles. The board,
 * mounting at `?view=`, strips it with a router replace of the BROWSER entry
 * it is on, which also calls off a commit still held (src/pages/Requests.tsx).
 * A step back from the script (`navigate(-1)`) moves the browser at once and
 * tells the router first, whose commit is held like a push, then the page
 * listeners; a later router write calls off a commit still held. The history
 * starts where a test says, the last entry being the editor.
 */
type Entry = { url: string; state: Record<string, unknown> };
const FROM_COMMUNITY: Entry[] = [
  { url: '/community', state: { usr: null, key: 'home', idx: 0 } },
  { url: '/requests/new', state: { usr: { printLink: 'https://www.printables.com/model/1-bracket' }, key: 'edit', idx: 1 } },
];
function historyWorld(start: Entry[] = FROM_COMMUNITY) {
  const entries: Entry[] = start.map((e) => ({ url: e.url, state: { ...e.state } }));
  let at = entries.length - 1;
  let listeners: Array<() => void> = [];
  const log: string[] = [];
  const mounted: string[] = [];
  let renders: string[] = [];
  let held: string[] = [];
  const mount = (url: string) => {
    mounted.push(url);
    if (/^\/requests\?(?:.*&)?view=/.test(url)) {
      log.push('board strips ?view');
      entries[at] = { ...entries[at], url: '/requests' };
      held = [];
    }
  };
  const win = {
    history: {
      get state() {
        return entries[at].state;
      },
      replaceState(state: Record<string, unknown>, _unused: string, url: string) {
        log.push(`replaceState ${url}`);
        entries[at] = { url, state };
      },
    },
    location: {
      get pathname() {
        return entries[at].url.split('?')[0];
      },
    },
    addEventListener(type: string, fn: () => void, opts?: { once?: boolean }) {
      assert.equal(type, 'popstate');
      assert.equal(opts?.once, true, 'the listener outlives the one step back');
      listeners.push(fn);
    },
  };
  const popstate = () => {
    const now = listeners;
    listeners = [];
    now.forEach((fn) => fn());
  };
  const navigate: Nav = (to, opts) => {
    if (to === -1) {
      log.push('router back');
      if (at === 0) {
        log.push('left the app');
        return;
      }
      at -= 1;
      held = [entries[at].url];
      popstate();
      return;
    }
    const url = String(to);
    if (opts?.replace) {
      log.push(`router replace ${url}`);
      entries[at] = { url, state: { usr: opts.state ?? null, key: `k${log.length}`, idx: entries[at].state.idx } };
      renders.push(url);
      held = [];
      return;
    }
    log.push(`router push ${url}`);
    entries.splice(at + 1, entries.length, { url, state: { usr: opts?.state ?? null, key: `k${log.length}`, idx: at + 1 } });
    at += 1;
    held = [url];
  };
  const settle = () => {
    const now = renders;
    renders = [];
    now.forEach(mount);
    const later = held;
    held = [];
    later.forEach(mount);
  };
  /** The person presses Back: the page behind is drawn, or the app is left when nothing of it is behind. */
  const back = () => {
    if (at === 0) return 'left the app';
    at -= 1;
    mount(entries[at].url);
    popstate();
    return entries[at].url;
  };
  return { entries, log, mounted, win, navigate, settle, back, at: () => at, here: () => entries[at], behind: () => entries[at - 1], ahead: () => entries[at + 1] };
}

test('a new request lands on its own page with «طلباتي» behind it, and no board mounts between the two writes (B2R2-REG-1)', async () => {
  type Leave = (navigate: Nav, path: string, published: boolean, win: unknown) => void;
  const leave = await editorFn<Leave>('leaveNewRequest', { MY_REQUESTS: '/requests?view=mine' });

  // The old two router writes, in this world, are the bug the harness saw: the board mounts first
  // and its strip takes the request entry, so the request page never arrives.
  const old = historyWorld();
  old.navigate('/requests?view=mine', { replace: true });
  old.navigate('/requests/rq_new', { state: { published: true } });
  old.settle();
  assert.deepEqual(old.mounted, ['/requests?view=mine'], 'the world no longer models the race');
  assert.equal(old.here().url, '/requests');

  const published = historyWorld();
  leave(published.navigate, '/requests/rq_new', true, published.win);
  published.settle();
  // The editor entry is rewritten as «طلباتي» outside the router, then the request page is pushed:
  // the one router write is the push, so nothing mounts between the two writes.
  assert.deepEqual(published.log, ['replaceState /requests?view=mine', 'router push /requests/rq_new']);
  assert.deepEqual(published.mounted, ['/requests/rq_new'], 'something mounted between the rewrite and the request page');
  assert.equal(published.here().url, '/requests/rq_new', 'the request page entry was overwritten');
  assert.deepEqual(published.here().state.usr, { published: true }, 'the channel window mark is lost');
  // Behind it: «طلباتي» in the place of the editor, a key of its own, no carried state (a model link would reopen the editor).
  assert.equal(published.behind().url, '/requests?view=mine');
  assert.equal(published.behind().state.idx, 1);
  assert.equal(published.behind().state.usr, null);
  assert.equal(typeof published.behind().state.key, 'string');
  assert.notEqual(published.behind().state.key, 'edit');
  // Back from the request page lands on «طلباتي»: only then does the board mount, and its strip stays on its own entry.
  published.back();
  assert.deepEqual(published.mounted, ['/requests/rq_new', '/requests?view=mine']);
  assert.equal(published.here().url, '/requests');
  assert.equal(published.ahead().url, '/requests/rq_new', 'the strip landed on the request entry');

  // Saved as a draft: the same way, with no mark.
  const saved = historyWorld();
  leave(saved.navigate, '/requests/rq_new', false, saved.win);
  saved.settle();
  assert.deepEqual(saved.log, ['replaceState /requests?view=mine', 'router push /requests/rq_new']);
  assert.deepEqual(saved.mounted, ['/requests/rq_new']);
  assert.equal(saved.here().state.usr, null);

  // A window that refuses the rewrite: the request page replaces the editor, never the board between.
  const refused = historyWorld();
  refused.win.history.replaceState = () => {
    throw new Error('SecurityError');
  };
  leave(refused.navigate, '/requests/rq_new', true, refused.win);
  refused.settle();
  assert.deepEqual(refused.log, ['router replace /requests/rq_new']);
  assert.deepEqual(refused.mounted, ['/requests/rq_new']);
  assert.deepEqual(refused.here().state.usr, { published: true });
});

test('a new request opened from the board «طلب جديد» puts «طلباتي» in the place of the board: two Backs leave, each one changing the screen (B2R3-REG-1)', async () => {
  type Leave = (navigate: Nav, path: string, published: boolean, win: unknown, fromBoard?: boolean) => void;
  const leave = await editorFn<Leave>('leaveNewRequest', { MY_REQUESTS: '/requests?view=mine' });
  const fromBoard = await editorFn<(state: unknown) => boolean>('cameFromBoard');
  // The board pushed the editor with its mark; any other door (a forward, a link, the request page) did not.
  assert.equal(fromBoard({ from: 'board' }), true);
  for (const other of [null, undefined, {}, { printLink: 'x' }, { from: 'community' }, 'board']) assert.equal(fromBoard(other), false, JSON.stringify(other));
  const FROM_BOARD: Entry[] = [
    { url: '/requests', state: { usr: null, key: 'board', idx: 0 } },
    { url: '/requests/new', state: { usr: { from: 'board' }, key: 'edit', idx: 1 } },
  ];

  // What the harness saw (the editor entry rewritten, the board left behind it): three entries
  // of this app, and the Back from «طلباتي» lands on another /requests entry, where the mounted
  // board keeps the view it had: nothing changes on screen, and a third Back is needed to leave.
  const before = historyWorld(FROM_BOARD);
  leave(before.navigate, '/requests/rq_new', true, before.win);
  before.settle();
  assert.deepEqual(before.entries.map((e) => e.url), ['/requests', '/requests?view=mine', '/requests/rq_new'], 'the world no longer models the bug');

  // Marked from the board: one step back onto the board, its entry rewritten as «طلباتي», then the request page.
  const board = historyWorld(FROM_BOARD);
  leave(board.navigate, '/requests/rq_new', true, board.win, true);
  board.settle();
  assert.deepEqual(board.log, ['router back', 'replaceState /requests?view=mine', 'router push /requests/rq_new']);
  assert.deepEqual(board.mounted, ['/requests/rq_new'], 'the board mounted between the step back and the request page');
  assert.deepEqual(board.entries.map((e) => e.url), ['/requests?view=mine', '/requests/rq_new'], 'the board is still behind «طلباتي»');
  assert.equal(board.here().state.idx, 1);
  assert.deepEqual(board.here().state.usr, { published: true }, 'the channel window mark is lost');
  assert.equal(board.behind().state.idx, 0);
  assert.equal(board.behind().state.usr, null);
  assert.notEqual(board.behind().state.key, 'board', 'the scroll of the board is carried onto «طلباتي»');
  // Back 1: «طلباتي», the board mounting at ?view=mine (a page of its own, not the board kept on screen);
  // its strip stays on its own entry. Back 2: out of the app, as when the board opened the wizard in place.
  assert.equal(board.back(), '/requests');
  assert.equal(board.mounted.at(-1), '/requests?view=mine');
  assert.equal(board.ahead().url, '/requests/rq_new', 'the strip landed on the request entry');
  assert.equal(board.back(), 'left the app');

  // Saved as a draft from the board: the same way, with no mark.
  const saved = historyWorld(FROM_BOARD);
  leave(saved.navigate, '/requests/rq_new', false, saved.win, true);
  saved.settle();
  assert.deepEqual(saved.entries.map((e) => e.url), ['/requests?view=mine', '/requests/rq_new']);
  assert.equal(saved.here().state.usr, null);

  // The board deeper in the history (the home, then the board): «طلباتي» in the place of the board, the home behind it.
  const deeper = historyWorld([
    { url: '/community', state: { usr: null, key: 'home', idx: 0 } },
    { url: '/requests', state: { usr: null, key: 'board', idx: 1 } },
    { url: '/requests/new', state: { usr: { from: 'board' }, key: 'edit', idx: 2 } },
  ]);
  leave(deeper.navigate, '/requests/rq_new', true, deeper.win, true);
  deeper.settle();
  assert.deepEqual(deeper.entries.map((e) => e.url), ['/community', '/requests?view=mine', '/requests/rq_new']);
  assert.equal(deeper.back(), '/requests');
  assert.equal(deeper.back(), '/community');

  // A step back that lands somewhere other than the board rewrites nothing: the request page follows that page.
  const elsewhere = historyWorld([
    { url: '/requests/rq_old', state: { usr: null, key: 'old', idx: 0 } },
    { url: '/requests/new', state: { usr: { from: 'board' }, key: 'edit', idx: 1 } },
  ]);
  leave(elsewhere.navigate, '/requests/rq_new', true, elsewhere.win, true);
  elsewhere.settle();
  assert.deepEqual(elsewhere.log, ['router back', 'router push /requests/rq_new']);
  assert.deepEqual(elsewhere.entries.map((e) => e.url), ['/requests/rq_old', '/requests/rq_new']);

  // A mark with nothing of this app behind (the editor first in its tab): the editor entry is rewritten, as from any door.
  const alone = historyWorld([{ url: '/requests/new', state: { usr: { from: 'board' }, key: 'edit', idx: 0 } }]);
  leave(alone.navigate, '/requests/rq_new', true, alone.win, true);
  alone.settle();
  assert.deepEqual(alone.log, ['replaceState /requests?view=mine', 'router push /requests/rq_new']);
  assert.deepEqual(alone.entries.map((e) => e.url), ['/requests?view=mine', '/requests/rq_new']);

  // A window that refuses the rewrite after the step back: the board as it was, the request page after it.
  const refused = historyWorld(FROM_BOARD);
  refused.win.history.replaceState = () => {
    throw new Error('SecurityError');
  };
  leave(refused.navigate, '/requests/rq_new', true, refused.win, true);
  refused.settle();
  assert.deepEqual(refused.entries.map((e) => e.url), ['/requests', '/requests/rq_new']);
  assert.deepEqual(refused.mounted, ['/requests/rq_new']);
});

test('an editor address for a request this person cannot open says so in three languages, with the way to the board (B2R2-L10N-1)', async () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string
    ) {
      super(message);
    }
  }
  const missing = await editorFn<(e: unknown) => boolean>('requestMissing', { ApiError });
  assert.equal(missing(new ApiError(404, 'Request not found', 'NOT_FOUND')), true, 'the server answer for another person request');
  assert.equal(missing(new ApiError(404, 'Request not found')), true);
  assert.equal(missing(new ApiError(410, 'Gone', 'NOT_FOUND')), true);
  assert.equal(missing(new ApiError(500, 'Internal error', 'INTERNAL')), false, 'any other refusal is the wizard own to say');
  assert.equal(missing(new ApiError(409, 'Stale', 'STALE_DRAFT')), false);
  assert.equal(missing(new TypeError('Failed to fetch')), false);

  const editor = code('src/pages/community/RequestNew.tsx');
  // The draft is asked beside the wizard (one request: lib/api.ts coalesces a GET in flight); only a 404 changes the page.
  assert.match(editor, /requestsApi\.draft\(id\)\.catch\(\(e: unknown\) => \{\s*if \(alive && requestMissing\(e\)\) setMissing\(true\);\s*\}\);/);
  // Missing: the request page own words and its way to the board, and no wizard (no empty form, no English sentence).
  const start = editor.indexOf('if (missing) {');
  const branch = editor.slice(start, editor.indexOf('\n  return (', start + 20));
  assert.match(branch, /<SectionPageHeader title=\{s\.kicker\} backTo="\/requests" \/>/);
  assert.match(branch, /<NotFoundState title=\{s\.notFoundTitle\} description=\{s\.notFoundBody\} \/>/);
  assert.match(branch, /<Link to="\/requests" className="lv-button lv-button-secondary lv-button-sm">\s*\{s\.toBoard\}\s*<\/Link>/);
  assert.doesNotMatch(branch, /RequestWizard/, 'the wizard is drawn for a request that cannot be opened');
  assert.ok(start > 0 && start < editor.indexOf('<RequestWizard '), 'the missing state is not decided before the wizard');
  // The words exist in all three languages, the Sorani its own (row 183), the English without Arabic script.
  const { REQUEST_STRINGS } = await import('../src/components/community/requests/strings');
  for (const key of ['kicker', 'notFoundTitle', 'notFoundBody', 'toBoard'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(REQUEST_STRINGS[lang][key], `${key}: ${lang} is empty`);
    assert.notEqual(REQUEST_STRINGS.ckb[key], REQUEST_STRINGS.ar[key], `${key}: the Sorani is the Arabic`);
    assert.doesNotMatch(REQUEST_STRINGS.en[key], /[؀-ۿ]/, `${key}: the English carries Arabic script`);
  }
});

type Nav = (to: string | number, opts?: { replace?: boolean; state?: unknown }) => void;

/** The editor return, run as written (its types stripped), against a window of our own. */
async function returnOf(): Promise<(navigate: Nav, path: string, win: unknown) => void> {
  const src = read('src/pages/community/RequestNew.tsx');
  const at = src.indexOf('export function returnPublished(');
  assert.ok(at >= 0, 'the editor no longer returns to the request page');
  const body = src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
  const { code: js } = await transform(body, { loader: 'ts' });
  return new Function(`${js}; return returnPublished;`)() as (navigate: Nav, path: string, win: unknown) => void;
}

/** A window with a history index, an address, and the popstate the browser fires after a step back. */
function fakeWindow(idx: unknown, behindPath: string) {
  let onPop: (() => void) | null = null;
  const win = {
    history: { state: idx === undefined ? null : { idx } },
    location: { pathname: '/requests/new/rq_1' },
    addEventListener: (type: string, fn: () => void, opts?: { once?: boolean }) => {
      assert.equal(type, 'popstate');
      assert.equal(opts?.once, true, 'the listener outlives the one step back');
      onPop = fn;
    },
  };
  const calls: unknown[] = [];
  const navigate: Nav = (to, opts) => {
    calls.push(opts === undefined ? [to] : [to, opts]);
    if (to === -1) {
      // The browser steps back, then tells the page.
      win.location.pathname = behindPath;
      onPop?.();
    }
  };
  return { win, calls, navigate, listening: () => onPop !== null };
}

test('a draft published from the editor goes back onto its request page: one entry for the request, Back leaves it (B2R1-REG-3)', async () => {
  const returnPublished = await returnOf();
  const published = { published: true };
  // Opened from the request page (an entry of this app behind): one step back, and that entry is marked.
  const back = fakeWindow(2, '/requests/rq_1');
  returnPublished(back.navigate, '/requests/rq_1', back.win);
  assert.deepEqual(back.calls, [[-1], ['/requests/rq_1', { replace: true, state: published }]]);
  // Opened by its address (nothing of this app behind): the request page replaces the editor.
  for (const idx of [0, undefined, 'x']) {
    const fresh = fakeWindow(idx, '/elsewhere');
    returnPublished(fresh.navigate, '/requests/rq_1', fresh.win);
    assert.deepEqual(fresh.calls, [['/requests/rq_1', { replace: true, state: published }]], `idx ${String(idx)}`);
    assert.equal(fresh.listening(), false, 'no listener is left behind when nothing steps back');
  }
  // Another page behind (never the case today): the request page follows it rather than replacing it.
  const other = fakeWindow(3, '/requests');
  returnPublished(other.navigate, '/requests/rq_1', other.win);
  assert.deepEqual(other.calls, [[-1], ['/requests/rq_1', { replace: false, state: published }]]);
  // A history that cannot be read is treated as nothing behind.
  const odd = fakeWindow(1, '/requests/rq_1');
  Object.defineProperty(odd.win.history, 'state', { get: () => { throw new Error('blocked'); } });
  returnPublished(odd.navigate, '/requests/rq_1', odd.win);
  assert.deepEqual(odd.calls, [['/requests/rq_1', { replace: true, state: published }]]);
});

test('the request page edits at its own address and never publishes a draft without the review', () => {
  const page = code('src/pages/community/Request.tsx');
  assert.match(page, /draft \? `\/requests\/new\/\$\{encodeURIComponent\(rid\)\}` : `\/requests\/\$\{encodeURIComponent\(rid\)\}\/edit`/);
  assert.match(page, /onEdit=\{\(rid, draft\) => navigate\(editPath\(rid, !!draft\)\)\}/);
  // «أكمل وانشر» is not offered while the editor opens at its first step whatever the address says
  // (B2R1-REG-4): the label would promise the review. The seam stays for C4 (the prop and its words).
  assert.doesNotMatch(page, /onFinish=\{/, '«أكمل وانشر» is offered before the editor opens a draft at its review');
  assert.match(page, /\{onFinish && \(\s*<Button variant="primary" size="sm" onClick=\{\(\) => onFinish\(current\.id\)\} data-requests="publish-draft">/);
  assert.match(page, /loc\('أكمل وانشر', 'Finish and publish', 'تەواوی بکە و بڵاوی بکەرەوە'\)/);
  // Continuing the draft is then the way forward: the primary button.
  assert.match(page, /<Button variant=\{onFinish \? 'secondary' : 'primary'\} size="sm" onClick=\{\(\) => onEdit\(current\.id, true\)\} data-requests="continue-draft">/);
  assert.match(page, /onNewRequest=\{\(\) => \(user \? navigate\('\/requests\/new'\) : signIn\(\)\)\}/);
  assert.doesNotMatch(page, /\/publish`/, 'the page publishes a draft by itself (critique 5)');
  assert.doesNotMatch(page, /RequestWizard|setEditing|\{editing \? \(/, 'the wizard is still in place on the request page');
  // The channel window is still latched from the router state the editor leaves, and rendered once.
  assert.match(page, /useState\(\(\) => justPublished\(location\.state\)\)/);
  assert.equal(page.match(/\{nudge\}/g)?.length, 1);
  // The mark is read on every arrival, not only the first render: the editor steps back onto this page and
  // marks its entry as it lands (returnPublished), so the page can be on screen a moment before its mark.
  assert.match(page, /if \(!justPublished\(location\.state\)\) return;\s*setRequestJustCreated\(true\);\s*navigate\(\{ pathname: location\.pathname, search: location\.search, hash: location\.hash \}, \{ replace: true, state: null \}\);\s*\}, \[location\]\);/);
});
