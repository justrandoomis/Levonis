/**
 * THE STUDIO'S SOURCE GUARDS — what must stay true of src/ whatever the
 * screens look like (docs/CREATIVE_STUDIO.md §1, §4, §7):
 *
 *  - the provider key never touches browser storage, the key field is a
 *    password field with autocomplete off and is cleared the moment the
 *    server confirms; the only storage the studio writes is the recovery
 *    draft (content, base version, time);
 *  - the route is lazy and nothing eager imports the studio; Konva is pinned
 *    exactly and imported only as its core plus the shapes it draws, only by
 *    the studio;
 *  - no letter spacing anywhere in the renderer or the text overlay;
 *  - the admin entry is the owner's and full admins', in the Growth group,
 *    lazily, with real Sorani on its own words.
 *
 * Run: node --import tsx --test tests/creativeStudioUiSource.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { codeOf, sourceOf } from './fixtures/source';

const DIR = 'src/components/creativeStudio';
const KURDISH = /[ەۆێڕڵڤگچپژ]|ی|ک/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) files(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
const studioFiles = files(DIR);

test('the provider key never reaches browser storage, and the field is cleared once the server has it', () => {
  const settings = codeOf(`${DIR}/SettingsTab.tsx`);
  assert.doesNotMatch(settings, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./, 'the settings screen touches browser storage');
  assert.match(settings, /<Input type="password" autoComplete="off"/, 'the key field is a password field with autocomplete off');
  assert.match(settings, /await providerApi\.saveKey\(key\.trim\(\)\);\s*setKey\(''\);/, 'the key is cleared right after the server confirms');
  // Across the studio: no session storage, no IndexedDB, and localStorage only for the recovery draft.
  for (const f of studioFiles) {
    const c = codeOf(f);
    assert.doesNotMatch(c, /sessionStorage|indexedDB|document\.cookie/, `${f} uses another browser store`);
    if (f !== `${DIR}/Editor.tsx`) assert.doesNotMatch(c, /localStorage/, `${f} writes to localStorage (only the editor's recovery draft may)`);
  }
  const editor = codeOf(`${DIR}/Editor.tsx`);
  const writes = [...editor.matchAll(/localStorage\.setItem\(([^)]*\))/g)].map((m) => m[1]);
  assert.equal(writes.length, 1, 'one localStorage write');
  assert.match(writes[0], /^draftKey, serializeDraft\(doc, versionRef\.current, new Date\(\)/, 'and it is the draft: content, base version, time');
  // The header name the old key transport used must not appear anywhere in the studio.
  for (const f of studioFiles) assert.doesNotMatch(sourceOf(f), /x-api-key/i, f);
});

test('the route is lazy, full-screen and admin-guarded; nothing eager imports the studio', () => {
  const app = codeOf('src/App.tsx');
  assert.match(app, /const CreativeStudio = React\.lazy\(\(\) => import\('\.\/pages\/CreativeStudio'\)\);/);
  const fullScreen = app.slice(app.indexOf('if (isFullScreenRoute)'));
  assert.match(fullScreen, /<Route path="\/admin\/creative-studio" element=\{<AdminRoute><CreativeStudio \/><\/AdminRoute>\} \/>/);
  assert.doesNotMatch(app, /from '\.\/(pages\/CreativeStudio|components\/creativeStudio)/, 'App.tsx imports the studio statically');
  const page = codeOf('src/pages/CreativeStudio.tsx');
  assert.match(page, /<Toaster \/>/, 'the page mounts its own Toaster (shellHasToaster hides the global one on /admin paths)');
  for (const f of files('src')) {
    if (f.startsWith(DIR) || f === 'src/pages/CreativeStudio.tsx') continue;
    const c = codeOf(f);
    const hits = [...c.matchAll(/(?:from|import\()\s*'([^']*(?:creativeStudio|pages\/CreativeStudio)[^']*)'/g)].map((m) => m[0]);
    if (f === 'src/App.tsx') { assert.deepEqual(hits, ["import('./pages/CreativeStudio'"]); continue; }
    if (f === 'src/pages/Admin.tsx') { assert.deepEqual(hits, ["import('../components/creativeStudio/StudioLauncher'"], 'Admin reaches only the launcher, lazily'); continue; }
    assert.deepEqual(hits, [], `${f} imports the studio`);
  }
});

test('Konva is pinned exactly and imported only as its core plus the shapes the studio draws, only by the studio', () => {
  const pkg = JSON.parse(sourceOf('package.json')) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies.konva, '10.9.0');
  const allowed = new Set(['konva/lib/Core', 'konva/lib/shapes/Text', 'konva/lib/shapes/Image', 'konva/lib/shapes/Rect', 'konva/lib/shapes/Ellipse', 'konva/lib/shapes/Line', 'konva/lib/shapes/Arrow', 'konva/lib/shapes/Transformer']);
  for (const f of files('src')) {
    const c = codeOf(f);
    for (const m of c.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'(konva[^']*)'/gm)) {
      assert.ok(f.startsWith(DIR), `${f} imports Konva`);
      if (m[1]) continue; // a type import costs nothing at run time
      assert.ok(allowed.has(m[2]), `${f}: ${m[2]} — only the core and the drawn shapes`);
    }
  }
  assert.match(codeOf(`${DIR}/stageView.ts`), /import Konva from 'konva\/lib\/Core';/);
});

test('no letter spacing: the renderer and the text overlay draw Arabic in one native run', () => {
  for (const f of studioFiles) {
    for (const m of codeOf(f).matchAll(/letterSpacing\s*:\s*([^,}\n]+)/g)) assert.equal(m[1].trim(), '0', `${f}: letterSpacing ${m[1]}`);
  }
  const view = codeOf(`${DIR}/stageView.ts`);
  assert.match(view, /wrap: 'none'/, 'the engine never re-wraps our lines');
  assert.match(view, /text: f\.lines\.join\('\\n'\)/, 'it draws the lines wrapText produced');
});

test('the admin entry: owner and full admins, in the Growth group, a lazy launcher with real Sorani', () => {
  const admin = codeOf('src/pages/Admin.tsx');
  assert.match(admin, /const canUseStudio = user\?\.isAdmin === true && user\?\.admin_scope !== 'assistant';/);
  assert.match(admin, /\.\.\.\(canUseStudio\s*\?\s*\[\{ id: 'creative_studio', icon: Palette, label: loc\('الاستوديو الإبداعي', 'Creative Studio', 'ستۆدیۆی داهێنەرانە'\), \.\.\.section\('growth',/);
  assert.match(admin, /activeTab === 'creative_studio' && canUseStudio && <StudioLauncher \/>/);
  const launcher = sourceOf(`${DIR}/StudioLauncher.tsx`);
  assert.match(launcher, /to="\/admin\/creative-studio"/);
  const calls = [...launcher.matchAll(/loc\('((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'\)/g)];
  assert.equal(calls.length, (launcher.match(/\bloc\(/g) ?? []).length, 'every loc( call has three arguments');
  assert.ok(calls.length >= 4);
  for (const [, ar, en, ckb] of calls) {
    assert.notEqual(ckb, ar);
    assert.notEqual(ckb, en);
    assert.doesNotMatch(ckb, /[ةىيك]/);
    assert.match(ckb, KURDISH);
  }
});

test('pictures in the studio UI use the shared image components; the canvas draws only same-origin paths', () => {
  for (const f of studioFiles.filter((x) => x.endsWith('.tsx'))) assert.doesNotMatch(codeOf(f), /<img\b/, `${f} draws a raw <img>`);
  const media = codeOf(`${DIR}/media.ts`);
  assert.match(media, /SITE_LOGO_VERSIONED_URL/, 'the site logo comes from src/lib/siteLogo.ts');
  assert.doesNotMatch(media, /crossOrigin/, 'no cross-origin picture is ever requested for the canvas');
  for (const f of studioFiles) assert.doesNotMatch(codeOf(f), /'\/icons\/|'\/files\/UiUx\//, `${f} names a site-media path`);
  void relative; void readFileSync;
});
