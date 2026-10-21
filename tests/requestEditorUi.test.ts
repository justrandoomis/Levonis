/**
 * THE REQUEST EDITOR, ITS ROUTE AND ITS SCREENS (plan P1-06; docs/DECISIONS.md
 * row 268; design critiques 1, 3, 6, 8, 11–14 and 20) — source-level and
 * `renderToStaticMarkup`.
 *
 *   the route is a lazy chunk of its own, behind the sign-in and the gate:
 *     /requests/new[/:id] (one optional-segment route, so the editor keeps its
 *     state when a new draft takes its address) and /requests/:id/edit;
 *   the entry door is on the main site, behind the gate, signed in;
 *   no 3D code and no slicer in the editor (BASE 6);
 *   the bar fits 360 px — a status and «مراجعة» — and steps aside for the
 *     keyboard; a failed save is a button that tries again;
 *   the parts count in the cards' word, fold to one line when there are
 *     several, and ask the process only while every material is open;
 *   the pickers are native radios and checkboxes in a tall sheet that a
 *     landscape phone docks too;
 *   the tab copy survives a reload: the app shell forgets it only on a
 *     sign-out or another account, never on the first check after a reload.
 *
 * Run: node --import tsx --test tests/requestEditorUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';

const REACT = pathToFileURL(join(ROOT, 'node_modules/react/index.js')).href;
const stubUrl = (src: string) => 'data:text/javascript,' + encodeURIComponent(src);
const SHEET = stubUrl(`import React from '${REACT}'; export function Sheet(p) { return p.open ? React.createElement('div', { 'data-sheet': p.testId }, p.header, p.children, p.footer) : null; }`);
const MENU = stubUrl(
  `export function Menu(p) { return p.trigger({ ref() {}, 'aria-haspopup': 'menu', 'aria-expanded': false, 'aria-controls': undefined, onClick() {}, onKeyDown() {} }); }`
);
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `const SHEET = ${JSON.stringify(SHEET)};
       const MENU = ${JSON.stringify(MENU)};
       export async function resolve(specifier, context, next) {
         if (/\\/ui\\/Sheet(\\.tsx)?$/.test(specifier)) return { url: SHEET, shortCircuit: true };
         if (/\\/ui\\/Menu(\\.tsx)?$/.test(specifier)) return { url: MENU, shortCircuit: true };
         return next(specifier, context);
       }`
    )
);

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { ActionBar, statusWords } = await import('../src/components/community/requests/editor/ActionBar');
const { PartsEditor } = await import('../src/components/community/requests/editor/PartsEditor');
const { MaterialPicker } = await import('../src/components/community/requests/editor/MaterialPicker');
const { ColourPicker } = await import('../src/components/community/requests/editor/ColourPicker');
const { editorPath } = await import('../src/components/community/requests/editor/RequestEditor');
const { blankState, addPart, anyColour, namedColour } = await import('../src/components/community/requests/editor/state');
const { editorStrings } = await import('../src/components/community/requests/editor/strings');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const EDITOR_DIR = 'src/components/community/requests/editor';
const editorFiles = () => [...readdirSync(join(ROOT, EDITOR_DIR)).map((f) => `${EDITOR_DIR}/${f}`), 'src/pages/community/RequestEditor.tsx'];

// ------------------------------------------------------------------ the route

test('the editor is a lazy chunk of its own, behind the sign-in and the gate, before the request page', () => {
  const app = read('src/App.tsx');
  // Fetched through the request page's module, whose modules it reuses (the first paint carries one route, not its dependency list).
  assert.match(app, /const RequestEditorPage = React\.lazy\(\(\) => import\('\.\/pages\/community\/Request'\)\.then\(\(m\) => m\.loadRequestEditor\(\)\)\);/);
  const requestPage = read('src/pages/community/Request.tsx');
  assert.match(requestPage, /export const loadRequestEditor = \(\) => import\('\.\/RequestEditor'\);/);
  assert.doesNotMatch(requestPage, /^import[^\n]*['"]\.\/RequestEditor['"]/m, 'never a static import of the request page');
  const newRoute = app.indexOf('path="/requests/new/:id?"');
  const editRoute = app.indexOf('path="/requests/:id/edit"');
  const page = app.indexOf('path="/requests/:id" ');
  assert.ok(newRoute > 0 && editRoute > 0 && page > 0);
  assert.ok(newRoute < page && editRoute < page, 'declared before /requests/:id');
  for (const at of [newRoute, editRoute]) {
    const line = app.slice(at, app.indexOf('\n', at));
    assert.match(line, /element=\{requestEditorRoute\}/);
  }
  assert.match(app, /const requestEditorRoute = <ProtectedRoute><CommunityGate closedExtra=\{<RunningCommunityOrders \/>\}><RequestEditorPage \/><\/CommunityGate><\/ProtectedRoute>;/);
  // Nothing eager imports it: not the board, not the request page, not a store page.
  for (const rel of ['src/pages/Requests.tsx', 'src/pages/community/Request.tsx', 'src/pages/Storefront.tsx', 'src/pages/StorefrontProduct.tsx']) {
    assert.doesNotMatch(read(rel), /requests\/editor\//, rel);
  }
  for (const f of readdirSync(join(ROOT, 'src/components/storefront'), { recursive: true }) as string[]) {
    if (!String(f).endsWith('.tsx') && !String(f).endsWith('.ts')) continue;
    assert.doesNotMatch(read(`src/components/storefront/${f}`), /requests\/editor\//, String(f));
  }
});

test('a request lives where it fits: a draft at /requests/new/:id, a published one at /requests/:id/edit', () => {
  assert.equal(editorPath('', 'draft'), '/requests/new');
  assert.equal(editorPath('req_1', 'draft'), '/requests/new/req_1');
  assert.equal(editorPath('req_1', 'receiving_offers'), '/requests/req_1/edit');
  const page = read('src/pages/community/RequestEditor.tsx');
  assert.doesNotMatch(page, /key=\{/, 'one instance across the address a new draft takes');
});

test('the entry door: on the main site, behind the gate, signed in — in that order', () => {
  const src = read('worker/routes/requestEntries.ts');
  assert.match(src, /requestEntryRoutes\.post\('\/requests', requireMainHost, requireCommunityOpen, requireAuth,/);
  assert.match(read('worker/index.ts'), /app\.route\('\/api\/marketplace\/print', requestEntryRoutes\)/);
});

test('no 3D code and no slicer in the editor (BASE 6); «عرض ثلاثي الأبعاد» opens the existing viewer in a new tab', () => {
  for (const rel of editorFiles()) {
    const src = read(rel);
    assert.doesNotMatch(src, /from ['"](three|ogl|@react-three\/[^'"]+)['"]/, rel);
    assert.doesNotMatch(src, /import[^;]*(ModelViewer|ModelPreview|slicer|Slicer|vendor-webgl)/, rel);
  }
  assert.match(read(`${EDITOR_DIR}/RequestEditor.tsx`), /window\.open\(d\.url, '_blank', 'noopener'\)/);
  assert.match(read(`${EDITOR_DIR}/RequestEditor.tsx`), /useSuppressBottomNav\(\)/, 'the bar sits where the floating nav would');
});

test('no apostrophe in an English comment of the editor (the clay census reads quotes)', () => {
  for (const rel of editorFiles()) {
    const comments = (read(rel).match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? []).join('\n');
    assert.doesNotMatch(comments, /[A-Za-z]'[A-Za-z]/, rel);
  }
});

// ------------------------------------------------------------------ the tab copy and the app shell

test('the app shell forgets the editor copy on a sign-out and for another account — never on the first check after a reload', () => {
  const auth = read('src/AuthContext.tsx');
  assert.match(auth, /forgetTabEntries\(REQUEST_EDITOR_COPIES\);\s*setUser\(null\);/, 'a sign-out forgets them all');
  // The scope change runs on the first /me after every load: there it keeps
  // the copies of the account it names, and a session that ran out keeps them all.
  const scopeBlock = auth.slice(auth.indexOf('if (scope !== sessionScope.current)'), auth.indexOf('setSessionUser(next);'));
  const calls = scopeBlock.match(/forgetTabEntries\([^;]*\);/g) ?? [];
  assert.deepEqual(calls, ['forgetTabEntries(REQUEST_EDITOR_COPIES, `${REQUEST_EDITOR_COPIES}${next.id}.`);']);
  assert.match(scopeBlock, /if \(next\) forgetTabEntries\(/);
  // The editor uses the same prefix and the same helper.
  const mirror = read(`${EDITOR_DIR}/sessionMirror.ts`);
  assert.match(mirror, /import \{ REQUEST_EDITOR_COPIES, forgetTabEntries \} from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/privateDrafts';/);
});

test('the leaving save is a keepalive request without the stamp, and an edit of a published request never autosaves', () => {
  const api = read('src/components/community/requests/api.ts');
  const leave = api.slice(api.indexOf('saveOnLeave:'), api.indexOf('saveOnLeave:') + 900);
  assert.match(leave, /keepalive: true/);
  assert.doesNotMatch(leave, /expected_updated_at/);
  const p = read(`${EDITOR_DIR}/persistence.ts`);
  assert.match(p, /if \(!s \|\| !s\.requestId \|\| isPublishedEdit\(s\)\) return false;/);
  assert.match(p, /window\.addEventListener\('pagehide', leave\)/);
  assert.match(p, /\/\/ The editor unmounting is a way out too[^\n]*\n\s*leave\(\);/);
});

// ------------------------------------------------------------------ the bar

const bar = (props: Partial<Parameters<typeof ActionBar>[0]>, lang: 'ar' | 'en' | 'ckb' = 'ar') =>
  html(
    createElement(ActionBar, {
      status: 'saved',
      edit: false,
      hidden: false,
      wide: false,
      primaryLabel: editorStrings(lang).review,
      onPrimary: () => undefined,
      onRetry: () => undefined,
      onSave: () => undefined,
      t: editorStrings(lang),
      ...props,
    }),
    lang
  );

test('the bar holds a status and «مراجعة»; a failed save is the button that tries again; the keyboard hides it', () => {
  const t = editorStrings('ar');
  const saved = bar({});
  assert.ok(text(saved).includes(t.statusSaved));
  assert.ok(text(saved).includes(t.review));
  assert.doesNotMatch(saved, /data-editor="save"/, 'no second «احفظ» on a phone');
  assert.match(bar({ wide: true }), /data-editor="save"/, 'from 640 px a draft also shows «احفظ»');
  const failed = bar({ status: 'failed' });
  assert.match(failed, new RegExp(`<button[^>]*aria-label="${t.statusFailedLong}"`));
  assert.match(failed, /role="alert"/, 'a failure is announced');
  assert.doesNotMatch(bar({ status: 'saving' }), /role="alert"/, '«يُحفظ…» is not announced every few seconds');
  assert.match(bar({ hidden: true }), /data-editor-bar="keyboard"/);
  assert.ok(text(bar({ edit: true, status: 'dirty' })).includes(t.statusEditDirty));
  assert.equal(statusWords('offline', false, t).long, t.statusOfflineLong);
  for (const lang of ['en', 'ckb'] as const) {
    const h = text(bar({}, lang));
    assert.ok(h.includes(editorStrings(lang).review));
  }
});

// ------------------------------------------------------------------ the parts

const partsProps = (lang: 'ar' | 'en' | 'ckb') => {
  let s = blankState();
  s = addPart(s)[0];
  s = { ...s, parts: s.parts.map((p, i) => (i === 1 ? { ...p, perSet: 3, materials: [{ ...p.materials[0], materialId: 'pla', colours: [namedColour('Black', '#1a1a1a')] }] } : p)) };
  return {
    parts: s.parts,
    sets: 2,
    quality: 'standard' as const,
    files: [],
    measurable: [],
    measuring: new Set<string>(),
    measureLater: new Set<string>(),
    catalogue: [{ id: 'pla', process: 'fdm' as const, name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false }],
    refs: [],
    refName: () => '',
    estimates: new Map([[1, { kind: 'unpriced' as const, text: 'بلا تقدير: لا مجسم مقيس — يسعّرها التاجر' }]]),
    lang,
    t: editorStrings(lang),
    onSets: () => undefined,
    onQuality: () => undefined,
    onPart: () => undefined,
    onMaterial: () => undefined,
    onChooseMaterial: () => undefined,
    onColours: () => undefined,
    onAddMaterial: () => undefined,
    onRemoveMaterial: () => undefined,
    onAddPart: () => '',
    onDuplicate: () => '',
    onMove: () => undefined,
    onRemove: async () => false,
  };
};

test('several parts: counted in the cards’ word, folded to one line but the open one, «عدد الأطقم» for the quantity', () => {
  const h = html(createElement(PartsEditor, partsProps('ar')));
  const words = text(h);
  assert.ok(words.includes('قطعتان · 4 نسخ في الطقم'), 'two parts, and four pieces in a set (1 + 3)');
  assert.ok(!/الأجزاء/.test(words), 'never «الأجزاء» beside «القطعة»');
  assert.ok(words.includes('عدد الأطقم'));
  assert.equal((h.match(/data-editor-part-toggle/g) ?? []).length, 2);
  assert.equal((h.match(/aria-expanded="true"[^>]*data-editor-part-toggle/g) ?? []).length, 1, 'one card open');
  assert.ok(words.includes('القطعة 2'), 'a part without a name is «القطعة n»');
  assert.ok(words.includes('بلا تقدير: لا مجسم مقيس'), 'the folded card still says why it has no estimate');
  assert.match(h, /aria-label="خيارات القطعة 1"/);
  // English and Sorani in their own words.
  const en = text(html(createElement(PartsEditor, partsProps('en')), 'en'));
  assert.ok(en.includes('2 parts · 4 copies in a set'));
  assert.ok(en.includes('Sets'));
  const ckb = text(html(createElement(PartsEditor, partsProps('ckb')), 'ckb'));
  assert.ok(ckb.includes('2 پارچە'));
  assert.ok(ckb.includes('ژمارەی سێت'));
});

test('one part reads as «ماذا نطبع»: no card, the quantity, and the process asked only while the material is open', () => {
  const props = partsProps('ar');
  const one = { ...props, parts: [props.parts[0]] };
  const h = html(createElement(PartsEditor, one));
  assert.doesNotMatch(h, /data-editor-part-toggle/);
  assert.ok(text(h).includes('الكمية'));
  assert.ok(text(h).includes('طريقة الطباعة'), 'every material open: the process is the customer’s to say');
  const chosen = { ...props, parts: [props.parts[1]] };
  assert.ok(!text(html(createElement(PartsEditor, chosen))).includes('طريقة الطباعة'), 'a chosen material decides the process');
});

// ------------------------------------------------------------------ the pickers

test('the material picker: native radios, «لست متأكدًا» first, a named search field; a tall sheet a landscape phone docks', () => {
  const h = html(
    createElement(MaterialPicker, {
      open: true,
      onClose: () => undefined,
      value: 'pla',
      initialProcess: 'fdm',
      catalogue: [
        { id: 'pla', process: 'fdm', name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false },
        { id: 'pa-cf', process: 'fdm', name_en: 'PA-CF', name_ar: 'نايلون كربون', needs_enclosure: true, abrasive: true },
      ],
      onChoose: () => undefined,
      lang: 'ckb',
      t: editorStrings('ckb'),
    }),
    'ckb'
  );
  const radios = [...h.matchAll(/<input[^>]*type="radio"[^>]*value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(radios, ['unsure', 'pla', 'pa-cf']);
  assert.match(h, /aria-label="بەدوای ماددەدا بگەڕێ"/);
  assert.ok(text(h).includes('نۆزڵی پتەو'), 'a nozzle, never a summit');
  assert.match(h, /data-selected="true"[^>]*>|data-material-option="pla"[^>]*data-selected="true"/);
  for (const rel of [`${EDITOR_DIR}/MaterialPicker.tsx`, `${EDITOR_DIR}/ColourPicker.tsx`]) {
    const src = read(rel);
    assert.match(src, /const sheetPlacement = useSheetPlacement\(\);/, `${rel}: docked on a compact screen`);
    assert.match(src, /\{\.\.\.sheetPlacement\}\s+detents=\{\['large'\]\}/, `${rel}: tall, and docked on a short screen`);
    assert.doesNotMatch(src, /aria-activedescendant|role="listbox"/, `${rel}: no listbox wiring`);
  }
  // The sheet takes `placement` through the props it hands the Overlay, AFTER its own default.
  const sheet = read('src/components/ui/Sheet.tsx');
  assert.match(sheet, /placement\?: 'bottom' \| 'dock';/);
  assert.match(sheet, /placement="bottom"[\s\S]{0,200}\{\.\.\.rest\}/);
  const kb = read(`${EDITOR_DIR}/useKeyboardOpen.ts`);
  assert.match(kb, /COMPACT_QUERY = '\(max-width: 639px\), \(max-height: 480px\)'/);
  assert.match(kb, /useMediaQuery\(COMPACT_QUERY\) \? \{ placement: 'dock', panelClassName: 'h-\[85dvh\]' \} : \{ placement: 'bottom' \}/);
});

test('the colour picker: «أي لون مناسب» checked alone, the palette as named checkboxes, one name field', () => {
  const t = editorStrings('ar');
  const h = html(
    createElement(ColourPicker, { open: true, onClose: () => undefined, colours: [anyColour()], onChange: () => undefined, refs: [{ key: 'tmp_1', label: 'side.png' }], lang: 'ar', t }),
    'ar'
  );
  const boxes = [...h.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
  assert.equal(boxes.length, 1 + 1 + 7, '«any», «as in the reference», and the seven palette colours');
  assert.match(boxes[0], /checked/);
  assert.ok(text(h).includes('أي لون مناسب'));
  assert.ok(text(h).includes('أسود'), 'every swatch carries its name');
  assert.ok(text(h).includes(t.colourName));
  assert.equal((h.match(/type="search"/g) ?? []).length, 1, 'one field searches and names');
  const asRef = html(
    createElement(ColourPicker, {
      open: true,
      onClose: () => undefined,
      colours: [namedColour('Black', '#1a1a1a'), { mode: 'as_reference', hex: '', label: '', ref: 'tmp_1' }],
      onChange: () => undefined,
      refs: [{ key: 'tmp_1', label: 'side.png' }],
      lang: 'en',
      t: editorStrings('en'),
    }),
    'en'
  );
  assert.ok(text(asRef).includes('As in which reference?'));
  assert.ok(text(asRef).includes('side.png'));
  assert.ok(text(asRef).includes('More than one colour') === false, 'one named colour is no multicolour job');
});

// ------------------------------------------------------------------ the viewer

test('the viewer takes its own touches (no pinch-zoom of the page behind), swipes only at 1×, and needs no library', () => {
  const v = read(`${EDITOR_DIR}/ImageViewer.tsx`);
  assert.match(v, /touchAction: 'none'/);
  assert.doesNotMatch(v, /pinch-zoom/);
  assert.match(v, /if \(zoom === 1 && p\.moved && Math\.abs\(dx\) > Math\.abs\(dy\)\)/);
  assert.match(v, /requestImageSrc\(pic\.url, 1280\)/, 'a sized copy, never the phone original');
  assert.doesNotMatch(v, /from ['"](?!react|lucide-react|\.)/, 'nothing but React, the icons and the app');
});
