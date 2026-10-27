/**
 * THE REQUEST EDITOR, ITS ROUTE AND ITS FOUR STEPS (community UI plan C4;
 * P1-06, docs/DECISIONS.md row 268; design critiques 1–6, 8, 10–14, 19 and
 * 20) — source-level and `renderToStaticMarkup`.
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
const { WizardHeader, saveButtonWords, statusWords, stepOf, stepTitle } = await import('../src/components/community/requests/editor/WizardHeader');
const { PartsEditor, layerText } = await import('../src/components/community/requests/editor/PartsEditor');
const { DeliveryFields } = await import('../src/components/community/requests/editor/DeliveryFields');
const { ReviewStep, RequestSummary } = await import('../src/components/community/requests/editor/ReviewStep');
const { FORMATS_LINE, waysCarried } = await import('../src/components/community/requests/editor/SourcesArea');
const { MaterialPicker } = await import('../src/components/community/requests/editor/MaterialPicker');
const { ColourPicker } = await import('../src/components/community/requests/editor/ColourPicker');
const { editorPath, entryFrom, stepSearch, describeErrors } = await import('../src/components/community/requests/editor/RequestEditor');
const { blankState, addPart, anyColour, namedColour, hydrate } = await import('../src/components/community/requests/editor/state');
const { editorStrings } = await import('../src/components/community/requests/editor/strings');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));
};
/** The opening tag that carries `mark`, whatever the order of its attributes. */
const tagOf = (h: string, mark: string) => h.match(new RegExp(`<[a-z]+[^>]*${mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`))?.[0] ?? '';
const text = (h: string) => h.replace(/[\u2066-\u2069]/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const EDITOR_DIR = 'src/components/community/requests/editor';
const editorFiles = () => [...readdirSync(join(ROOT, EDITOR_DIR)).map((f) => `${EDITOR_DIR}/${f}`), 'src/pages/community/RequestNew.tsx'];

// ------------------------------------------------------------------ the route

test('the editor rides in the lazy page chunk the board loads; nothing eager imports it', () => {
  const page = read('src/pages/community/RequestNew.tsx');
  assert.match(page, /^import RequestEditor, \{ type EditorDone \} from '\.\.\/\.\.\/components\/community\/requests\/editor\/RequestEditor';$/m);
  assert.match(read('src/pages/Requests.tsx'), /const RequestNew = lazy\(\(\) => import\('\.\/community\/RequestNew'\)\);/, 'the page itself is a lazy chunk of the board');
  assert.match(page, /<RequestEditor requestId=\{id\} carriedLink=\{carriedLink\} onDone=\{finish\} onLeave=\{goBack\} \/>/);
  assert.doesNotMatch(page, /RequestWizard/, 'the old wizard is gone from the editor page');
  // The routes (B4): one element for /requests/new and /requests/new/:id, the edit address, behind the sign-in and the gate.
  const app = read('src/App.tsx');
  assert.match(app, /<Route path="\/requests\/new\/:id\?" element=\{requestEditor\} \/>/);
  assert.match(app, /<Route path="\/requests\/:id\/edit" element=\{requestEditor\} \/>/);
  assert.match(app, /const requestEditor = \(\s*<ProtectedRoute>\s*<CommunityGate closedExtra=\{<RunningCommunityOrders \/>\}>/);
  // Nothing eager imports it: not the board, not the request page, not a store page.
  for (const rel of ['src/pages/Requests.tsx', 'src/pages/community/Request.tsx', 'src/pages/Storefront.tsx', 'src/pages/StorefrontProduct.tsx', 'src/App.tsx']) {
    assert.doesNotMatch(read(rel), /requests\/editor\//, rel);
  }
  for (const f of readdirSync(join(ROOT, 'src/components/storefront'), { recursive: true }) as string[]) {
    if (!String(f).endsWith('.tsx') && !String(f).endsWith('.ts')) continue;
    assert.doesNotMatch(read(`src/components/storefront/${f}`), /requests\/editor\//, String(f));
  }
  assert.doesNotMatch(page, /<RequestEditor key=/, 'one instance across the address a new draft takes');
});

test('a request lives where it fits, and the step lives in the address (critique 20)', () => {
  assert.equal(editorPath('', 'draft'), '/requests/new');
  assert.equal(editorPath('req_1', 'draft'), '/requests/new/req_1');
  assert.equal(editorPath('req_1', 'receiving_offers'), '/requests/req_1/edit');
  // `?step=1..4`; anything else is step 1 (a reload of every step opens it again).
  assert.deepEqual(['1', '2', '3', '4', '', '0', '5', 'x', null].map((v) => stepOf(v)), [1, 2, 3, 4, 1, 1, 1, 1, 1]);
  // A step keeps the other keys of its address and drops the entry keys read on arrival.
  assert.equal(stepSearch(new URLSearchParams('step=1&project=p1&link=x&utm=a'), 3), '?step=3&utm=a');
  // A step forward is a new history entry (Android Back walks the steps), marked with its depth.
  const editor = read(`${EDITOR_DIR}/RequestEditor.tsx`);
  assert.match(editor, /const step: WizardStep = state && !state\.requestId \? 1 : stepOf\(params\.get\('step'\)\);/);
  assert.match(editor, /navigate\(\{ pathname: location\.pathname, search: stepSearch\(params, to\) \}, \{ state: mark \}\);/);
  // After a publish the pushed steps are walked back first (critique 5): Back from the request never lands in the editor.
  assert.match(editor, /window\.addEventListener\('popstate', \(\) => setTimeout\(then, 0\), \{ once: true \}\);\s*navigate\(-depth\);/);
  assert.match(editor, /unwind\(\(\) => onDone\(\{ id, how: publishedEdit \? 'saved' : 'published' \}\)\);/);
});

test('the entries: «اطلب طباعة مثلها» from the state or the address, a product and a store (row 268)', () => {
  assert.deepEqual(entryFrom(new URLSearchParams('project=post_1')), { kind: 'project', post_id: 'post_1' });
  assert.deepEqual(entryFrom(new URLSearchParams(''), { project: 'post_2' }), { kind: 'project', post_id: 'post_2' });
  assert.deepEqual(entryFrom(new URLSearchParams(''), { project: { id: 'post_3', title: 'x' } }), { kind: 'project', post_id: 'post_3' });
  assert.deepEqual(entryFrom(new URLSearchParams('product=p9&store=ali3d')), { kind: 'product', product_id: 'p9', store: 'ali3d' });
  assert.deepEqual(entryFrom(new URLSearchParams('store=m1')), { kind: 'store', merchant_id: 'm1' });
  assert.equal(entryFrom(new URLSearchParams('link=https://x.co/a')), null, 'a carried link is a blank request that adds the link');
  // A blank page creates nothing until the first act (critique 4); the first act moves the address to the draft, at step 1.
  const editor = read(`${EDITOR_DIR}/RequestEditor.tsx`);
  assert.match(editor, /if \(bodyKey\(state\) === blankKey\) return;/);
  assert.match(editor, /navigate\(`\/requests\/new\/\$\{encodeURIComponent\(request_id\)\}\?step=1`, \{ replace: true \}\);/);
});

test('step 1 asks the publish questions before step 2: a title of 4–140 and a description of 10+', () => {
  const t = editorStrings('ar');
  assert.deepEqual(describeErrors({ title: 'abc', description: 'short' }, t), { title: t.titleError, description: t.descError });
  assert.deepEqual(describeErrors({ title: 'A bracket', description: 'A wall bracket, black, four of them' }, t), {});
  assert.equal(describeErrors({ title: 'x'.repeat(141), description: 'y'.repeat(10) }, t).title, t.titleError);
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

test('the tab copy: other accounts dropped when the editor loads, cleared by a clean save, and nothing in the entry chunk', () => {
  const editor = read(`${EDITOR_DIR}/RequestEditor.tsx`);
  assert.match(editor, /dropOtherAccounts\(storage, userId\);/, 'the editor drops the copies of every other account on load');
  const p = read(`${EDITOR_DIR}/persistence.ts`);
  assert.match(p, /if \(clean\) clearMirror\(storage, userId, s\.requestId\);/, 'a clean save leaves no copy behind');
  // The sweep lives in the editor chunk: the app shell (in the entry, whose storefront payload has no room) imports none of it.
  assert.doesNotMatch(read('src/AuthContext.tsx'), /REQUEST_EDITOR_COPIES|forgetTabEntries|request-editor/);
  assert.doesNotMatch(read('src/lib/privateDrafts.ts'), /request-editor/);
  const mirror = read(`${EDITOR_DIR}/sessionMirror.ts`);
  assert.match(mirror, /export const REQUEST_EDITOR_COPIES = 'levonis\.request-editor\.';/);
  // A copy is read back only for its own account (readMirror checks `user`).
  assert.match(mirror, /if \(!v \|\| v\.v !== 1 \|\| v\.user !== userId \|\| v\.request !== requestId\) return null;/);
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

// ------------------------------------------------------------------ the header

const header = (props: Partial<Parameters<typeof WizardHeader>[0]>, lang: 'ar' | 'en' | 'ckb' = 'ar') =>
  html(
    createElement(WizardHeader, {
      step: 2,
      title: stepTitle(2, editorStrings(lang)),
      status: 'clean',
      edit: false,
      onBack: () => undefined,
      onSave: () => undefined,
      t: editorStrings(lang),
      ...props,
    }),
    lang
  );

test('the header: the step title, «احفظ مسودة» / «يُحفظ…» / «محفوظ» in the button, the four bars; only a failure is announced', () => {
  const t = editorStrings('ar');
  const h = header({});
  assert.ok(text(h).includes('إعدادات الطباعة'));
  assert.ok(text(h).includes('طلب طباعة · 2 من 4'));
  assert.match(h, /role="progressbar"[^>]*aria-valuenow="2"/);
  assert.match(h, /data-editor="save"/);
  assert.ok(text(h).includes(t.saveDraft));
  assert.equal(saveButtonWords('saving', false, t).label, t.statusSaving);
  assert.equal(saveButtonWords('saved', false, t).label, t.statusSaved);
  assert.equal(saveButtonWords('failed', false, t).action, 'retry', 'a failed save is the button that tries again');
  assert.equal(saveButtonWords('offline', false, t).long, t.statusOfflineLong);
  assert.match(header({ status: 'failed' }), /role="alert"/);
  assert.doesNotMatch(header({ status: 'saving' }), /role="alert"/, '«يُحفظ…» is not announced every few seconds');
  // A published request: the status only, no draft button; its changes go out with «احفظ التعديلات».
  const edit = header({ edit: true, status: 'dirty' });
  assert.doesNotMatch(edit, /data-editor="save"/);
  assert.ok(text(edit).includes(t.statusEditDirty));
  assert.equal(statusWords('dirty', true, t).long, t.statusEditDirtyLong);
  // Every step has its title in three languages, the Sorani its own.
  for (const lang of ['en', 'ckb'] as const) {
    const s = editorStrings(lang);
    for (const n of [1, 2, 3, 4] as const) assert.notEqual(stepTitle(n, s), stepTitle(n, editorStrings('ar')));
  }
  // The button gives up its words for its icon when the title row would wrap (Sorani at 360 and 320), and keeps them as its name.
  const src = read(`${EDITOR_DIR}/WizardHeader.tsx`);
  assert.match(src, /door\.getBoundingClientRect\(\)\.top > back\.getBoundingClientRect\(\)\.bottom - 4\) setRoomy\(false\)/);
  assert.match(src, /<span className="sr-only">\{name\}<\/span>/);
});

test('the in-app leave blocker (critique 3): the header back on step 1 asks when the work could not be saved', () => {
  const editor = read(`${EDITOR_DIR}/RequestEditor.tsx`);
  const back = editor.slice(editor.indexOf('const back = async () => {'), editor.indexOf('const pickFiles'));
  assert.match(back, /if \(step > 1\) \{\s*if \(depth > 0\) navigate\(-1\);\s*else jumpStep\(\(step - 1\) as WizardStep\);/);
  assert.match(back, /const saved = !publishedEdit && s\.requestId \? await persistence\.flush\(\) : false;/);
  assert.match(back, /title: t\.leaveTitle,\s*consequence: publishedEdit \? t\.leaveBodyEdit : t\.leaveBody/);
  assert.match(back, /if \(!ok\) return;\s*\}\s*\}\s*onLeave\(\);/);
  // Every other way out flushes with a keepalive save (the router cannot block it).
  assert.match(read(`${EDITOR_DIR}/persistence.ts`), /\/\/ The editor unmounting is a way out too[^\n]*\n\s*leave\(\);/);
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
    qualities: [{ id: 'standard' as const, layer_mm: 0.2 }],
    notes: '',
    files: [],
    measurable: [],
    measuring: new Set<string>(),
    measureLater: new Set<string>(),
    catalogue: [{ id: 'pla', process: 'fdm' as const, name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false }],
    refs: [],
    refName: () => '',
    estimates: new Map([[1, { kind: 'unpriced' as const, text: 'بلا تقدير: لا مجسم مقيس — يسعّرها التاجر' }]]),
    processNotes: new Set<string>(),
    lang,
    t: editorStrings(lang),
    onSets: () => undefined,
    onQuality: () => undefined,
    onNotes: () => undefined,
    onPart: () => undefined,
    onProcess: () => undefined,
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
  const en = text(html(createElement(PartsEditor, partsProps('en')), 'en'));
  assert.ok(en.includes('2 parts · 4 copies in a set'));
  assert.ok(en.includes('Sets'));
  const ckb = text(html(createElement(PartsEditor, partsProps('ckb')), 'ckb'));
  assert.ok(ckb.includes('2 پارچە'));
  assert.ok(ckb.includes('ژمارەی سێت'));
});

test('one part reads as the reference: the method tiles, material and colour, the quality with its layer, the quantity, the size, the notes', () => {
  const props = partsProps('ar');
  const t = editorStrings('ar');
  const h = html(createElement(PartsEditor, { ...props, parts: [props.parts[0]] }));
  assert.doesNotMatch(h, /data-editor-part-toggle/, 'one part has no card of its own');
  const order = ['process', 'material', 'quality', 'quantity', 'size', 'notes'].map((c) => h.indexOf(`data-editor-card="${c}"`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `cards in the reference order: ${order.join(',')}`);
  for (const id of ['fdm', 'resin', 'unsure']) assert.match(h, new RegExp(`role="radio"[^>]*data-choice="${id}"`));
  assert.match(h, /data-editor-unsure-material="on"/, '«لست متأكدًا من المادة» is the open material');
  assert.match(tagOf(h, 'data-editor-material-button'), /aria-haspopup="listbox"/);
  assert.ok(text(h).includes(t.layerHeight) && text(h).includes('0.20 mm'), 'the layer height of the catalogue');
  assert.equal(layerText('fine', [{ id: 'standard', layer_mm: 0.2 }]), '', 'no figure the catalogue does not give');
  assert.ok(text(h).includes(t.quantity));
  // The size: «مقاسة» says why it is not offered while nothing is measured.
  assert.match(h, /data-editor-card="size"[\s\S]*disabled[\s\S]*مقاسة/);
  assert.ok(text(h).includes(t.sizeNotMeasured));
  // The notes for the merchants keep their phone warning.
  assert.ok(text(h).includes(t.notesHint));
  // A resin job has no layer height to show.
  const resin = { ...props.parts[0], process: 'resin' as const };
  assert.ok(!text(html(createElement(PartsEditor, { ...props, parts: [resin] }))).includes('0.20 mm'));
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

// ------------------------------------------------------------------ step 1

test('step 1: the four ways are ticked by what the request carries, and the formats come from the contract', async () => {
  const { REQUEST_FILE_EXTENSIONS } = await import('../packages/contracts/src/requestFiles');
  for (const ext of [...REQUEST_FILE_EXTENSIONS.model, ...REQUEST_FILE_EXTENSIONS.image, 'pdf']) assert.ok(FORMATS_LINE.includes(ext.toUpperCase()), ext);
  for (const ext of ['AMF', 'GLB', 'GLTF', 'STP', 'AVIF']) assert.ok(FORMATS_LINE.includes(ext), ext);
  const s = blankState();
  assert.deepEqual(waysCarried(s, []), []);
  const withLink = { ...s, sources: [{ key: 'l1', id: null, kind: 'link' as const, fileId: null, url: 'https://x.co/a', canonical: 'https://x.co/a', provider: '', refText: '', note: '', primary: false, original: false, baseRole: '' }] };
  assert.deepEqual(waysCarried(withLink, []), ['link']);
  // A picture on its way already ticks «صور مرجعية»; a refused one does not.
  const row = (kind: 'image' | 'model', status: 'uploading' | 'rejected') => ({ key: `u_${kind}_${status}`, file: {} as File, name: 'x', kind, preview: null, status, loaded: 0, total: 1, reason: '', door: 'simple' as const });
  assert.deepEqual(waysCarried(s, [row('image', 'uploading'), row('model', 'rejected')]), ['pictures']);
  // The tiles are checkboxes (not a choice of one); a press opens the adder of its kind.
  const area = read(`${EDITOR_DIR}/SourcesArea.tsx`);
  assert.match(area, /<ChoiceTiles\s+multiple/);
  assert.match(area, /if \(way === 'model'\) modelInput\.current\?\.click\(\);\s*else if \(way === 'pictures'\) pictureInput\.current\?\.click\(\);/);
  // Every row has its eye and its bin, each named with the file.
  assert.match(area, /label=\{fill\(t\.removeNamed, \{ name: short \}\)\}/);
  // The title and the description are counted at the server limits: 140 and 6000.
  const editor = read(`${EDITOR_DIR}/RequestEditor.tsx`);
  assert.match(editor, /id="editor-title"\s+label=\{t\.reqTitle\}\s+max=\{140\}/);
  assert.match(editor, /id="editor-description"\s+label=\{t\.reqDesc\}\s+multiline\s+rows=\{4\}\s+max=\{6000\}/);
});

// ------------------------------------------------------------------ step 3

const delivery = (patch: object = {}) => ({ notes: '', governorate: '', handover: '', deadline: '', budget: null, budgetVisible: false, ...patch });

test('step 3: the budget switch is OFF by default, appears once there is a budget, and says what it means now (Q2)', () => {
  const t = editorStrings('ar');
  const props = { direct: false, published: false, onChange: () => undefined, lang: 'ar' as const, t };
  const none = html(createElement(DeliveryFields, { ...props, value: delivery() }));
  assert.doesNotMatch(none, /data-editor-budget-switch/, 'no switch before a budget (critique 19)');
  assert.ok(text(none).includes(t.budgetOptional));
  const off = html(createElement(DeliveryFields, { ...props, value: delivery({ budget: 45000 }) }));
  assert.match(off, /data-editor-budget-switch="off"/);
  assert.match(off, /role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
  assert.ok(text(off).includes(t.budgetOff), '«مخفية عن التجار والعموم.»');
  assert.ok(!text(off).includes('يراها الصنّاع'), 'never the reference hint that promises the opposite');
  const on = html(createElement(DeliveryFields, { ...props, value: delivery({ budget: 45000, budgetVisible: true }) }));
  assert.ok(text(on).includes(t.budgetOn));
  const direct = html(createElement(DeliveryFields, { ...props, direct: true, value: delivery({ budget: 45000, budgetVisible: true }) }));
  assert.ok(text(direct).includes(t.budgetOnDirect) && text(direct).includes(t.budgetSwitchDirect));
  // Emptying the budget turns the switch off with it.
  assert.match(read(`${EDITOR_DIR}/DeliveryFields.tsx`), /onChange\(\{ budget: v && v > 0 \? v : null, \.\.\.\(v && v > 0 \? \{\} : \{ budgetVisible: false \}\) \}\)/);
  // The governorate opens as radios in a tall sheet; the handover is three tiles; the day is also written in words.
  assert.match(tagOf(off, 'data-editor="governorate"'), /aria-haspopup="listbox"/);
  for (const id of ['delivery', 'pickup', 'either']) assert.match(off, new RegExp(`data-choice="${id}"`));
  const day = html(createElement(DeliveryFields, { ...props, value: delivery({ deadline: '2026-11-05' }) }));
  assert.match(day, /data-editor-deadline-words[^>]*>5 /);
  for (const lang of ['en', 'ckb'] as const) {
    const s = editorStrings(lang);
    const h = text(html(createElement(DeliveryFields, { ...props, lang, t: s, value: delivery({ budget: 45000 }) }), lang));
    assert.ok(h.includes(s.budgetSwitch) && h.includes(s.budgetOff), lang);
  }
});

// ------------------------------------------------------------------ step 4

const reviewState = (patch: object = {}) => {
  const s = blankState();
  return {
    ...s,
    requestId: 'req_1',
    requestState: 'draft',
    title: 'حامل تثبيت للحائط',
    description: 'أحتاج أربع قطع متينة',
    sets: 4,
    delivery: delivery({ governorate: 'baghdad', handover: 'delivery', deadline: '2026-11-05', budget: 45000 }),
    ...patch,
  };
};
const review = (state: ReturnType<typeof reviewState>, lang: 'ar' | 'en' | 'ckb' = 'ar', quote: unknown = null) =>
  html(
    createElement(ReviewStep, {
      state,
      catalogue: [],
      qualities: [{ id: 'standard', layer_mm: 0.2 }],
      refName: () => '',
      quote: quote as never,
      onEdit: () => undefined,
      lang,
      t: editorStrings(lang),
    }),
    lang
  );

test('step 4: the cards each with «تعديل», the budget said hidden, the price from the offers, the estimate coverage, what others see', () => {
  const t = editorStrings('ar');
  const h = review(reviewState());
  for (const card of ['files', 'specs', 'delivery', 'budget']) assert.match(h, new RegExp(`data-review-card="${card}"`));
  assert.equal((h.match(/data-review-edit/g) ?? []).length, 4);
  assert.match(h, /aria-label="تعديل: التسليم"/);
  assert.match(h, /data-editor-review-budget="hidden"/);
  assert.ok(text(h).includes(t.budgetOff));
  assert.ok(text(h).includes(t.finalPrice));
  assert.ok(text(h).includes('45,000 د.ع'), 'Latin digits in every language (R13)');
  assert.ok(text(h).includes('بغداد · توصيل'));
  assert.match(h, /data-editor-audience="open"/, '«ما يراه الآخرون» opens by itself in the review');
  assert.ok(text(h).includes(t.privacyLine));
  const shown = review(reviewState({ delivery: delivery({ budget: 45000, budgetVisible: true }) }));
  assert.match(shown, /data-editor-review-budget="shown"/);
  // An estimate of part of the job says so.
  const partial = review(reviewState(), 'ar', { priced: true, price_low_iqd: 22000, price_high_iqd: 28000, coverage: { complete: false, parts_total: 2, priced_parts: [{}] } });
  assert.match(partial, /data-editor-estimate-coverage/);
  assert.ok(text(partial).includes('22,000–28,000'));
  // No budget: said, never a zero.
  assert.ok(text(review(reviewState({ delivery: delivery() }))).includes(t.noBudget));
  // The verb: publish, save the edits, or send to the store; it waits for the uploads.
  const editor = read(`${EDITOR_DIR}/RequestEditor.tsx`);
  assert.match(editor, /const verb = publishedEdit \? t\.saveChanges : s\.direct \? fill\(t\.sendTo, \{ store: s\.direct\.store_name \}\) : t\.publishCta;/);
  assert.match(editor, /disabled: working > 0, busy: publishing, note: working > 0 \? fill\(t\.waitUploads, \{ n: working \}\) : ''/);
  assert.match(editor, /const closed = e instanceof ApiError && e\.code === 'COMMUNITY_CLOSED';/);
  for (const lang of ['en', 'ckb'] as const) {
    const w = text(review(reviewState(), lang));
    assert.ok(w.includes(editorStrings(lang).budgetCard), lang);
    assert.ok(!w.includes('الميزانية المقترحة'), `${lang}: the Arabic stands in`);
  }
});

test('step 3 summary: the picture well beside the facts in short, in the job words', () => {
  const t = editorStrings('ar');
  const h = text(html(createElement(RequestSummary, { state: reviewState(), catalogue: [], refName: () => '', lang: 'ar', t })));
  assert.ok(h.includes(t.summaryTitle));
  assert.ok(h.includes('4 نسخ'), 'four copies of one part, never «4 قطع» (critique 8)');
  assert.ok(h.includes(t.colourAny));
});

test('a draft opened from «أكمل وانشر» opens at its review: `?step=4` is read from the address on load', () => {
  assert.equal(stepOf(new URLSearchParams('step=4').get('step')), 4);
  const draft = hydrate({ id: 'req_9', state: 'draft', revision: 1, title: 'x', description: 'y', customer_notes: '', quantity: 1, governorate: '', delivery_pref: '', deadline: '', budget_iqd: null, files: [], updated_at: '2026-10-27T00:00:00Z' } as never);
  assert.equal(draft.requestId, 'req_9');
});
