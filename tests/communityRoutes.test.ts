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
 *     without its review («أكمل وانشر» opens `?step=4`, critique 5).
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
  for (const [file, panel, title] of [
    ['src/pages/community/Following.tsx', '<FollowingPanel viewer=', 's.tabs.following'],
    ['src/pages/community/Stores.tsx', '<StoresPanel q={q}', 's.tabs.stores'],
    ['src/pages/community/Makers.tsx', '<CreatorsPanel q={q}', 's.tabs.creators'],
  ] as const) {
    const src = code(file);
    assert.match(src, /<CommunitySurface\b[^>]*>[\s\S]*<\/CommunitySurface>/, `${file}: the page root is not stamped`);
    assert.ok(src.includes(`<SectionPageHeader title={${title}} trailing={<SectionsButton />} />`), `${file}: no section header with the sections door`);
    assert.ok(src.includes(panel), `${file}: not the list of today`);
    // The list is a lazy chunk the home tab shares: the page and the entry that names it stay small.
    assert.match(src, /= lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/hub\/(FollowingPanel|StoresPanel|CreatorsPanel)'\)\);/, `${file}: the list is imported eagerly`);
  }
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
  // The board own «طلب جديد» is a step forward, so Back returns to the board.
  assert.match(board, /if \(user\) navigate\('\/requests\/new'\);\s*else signIn\(\);/);
  assert.doesNotMatch(board, /<RequestWizard\b|import RequestWizard/, 'the board still opens the wizard in place');

  // The editor reads both halves of a carried link: the state (a signed-in tap) and ?link= (it survives sign-in).
  const editor = code('src/pages/community/RequestNew.tsx');
  assert.match(editor, /const fromState = \(state as \{ printLink\?: unknown \} \| null\)\?\.printLink;\s*return typeof fromState === 'string' \? fromState : params\.get\('link'\) \?\? '';/);
  // A new request leaves «طلباتي» behind it; the channel window rides with a PUBLISHED request only.
  assert.match(editor, /navigate\('\/requests\?view=mine', \{ replace: true \}\);\s*navigate\(requestPath\(rid\), how === 'published' \? \{ state: \{ published: true \} \} : undefined\);/);
  assert.match(editor, /else if \(how === 'published'\) navigate\(requestPath\(rid\), \{ replace: true, state: \{ published: true \} \}\);\s*else goBack\(\);/);
});

test('the request page edits at its own address and never publishes a draft without the review', () => {
  const page = code('src/pages/community/Request.tsx');
  assert.match(page, /draft \? `\/requests\/new\/\$\{encodeURIComponent\(rid\)\}` : `\/requests\/\$\{encodeURIComponent\(rid\)\}\/edit`/);
  assert.match(page, /onEdit=\{\(rid, draft\) => navigate\(editPath\(rid, !!draft\)\)\}/);
  assert.match(page, /onFinish=\{\(rid\) => navigate\(`\$\{editPath\(rid, true\)\}\?step=4`\)\}/, '«أكمل وانشر» opens the draft at its review');
  assert.match(page, /onNewRequest=\{\(\) => \(user \? navigate\('\/requests\/new'\) : signIn\(\)\)\}/);
  assert.doesNotMatch(page, /\/publish`/, 'the page publishes a draft by itself (critique 5)');
  assert.doesNotMatch(page, /RequestWizard|setEditing|\{editing \? \(/, 'the wizard is still in place on the request page');
  assert.match(page, /loc\('أكمل وانشر', 'Finish and publish', 'تەواوی بکە و بڵاوی بکەرەوە'\)/);
  assert.match(page, /onClick=\{\(\) => onEdit\(current\.id, true\)\} data-requests="continue-draft"/);
  // The channel window is still latched from the router state the editor leaves, and rendered once.
  assert.match(page, /useState\(\(\) => justPublished\(location\.state\)\)/);
  assert.equal(page.match(/\{nudge\}/g)?.length, 1);
});
