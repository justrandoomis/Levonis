/**
 * «ما لديك» ON THE SCREEN (plan P1-06, acceptance 13; design §4–§5,
 * critiques 10, 13, 14) — rendered with `renderToStaticMarkup`, in Arabic,
 * English and Sorani.
 *
 *   a picture is a PICTURE: its device preview (`blob:`) while it is on its
 *   way, a sized copy of its authorised route (`?w=`) once stored; a model
 *   or a document its glyph — and no row, tile or line ever shows an id;
 *   every file of one pick is asked the request table in turn: the ones that
 *   may go are queued, a refused one says why and is never sent;
 *   one failure never stops the others (partial success), and a failed file
 *   keeps its own named «أعد المحاولة» and «ألغِ»;
 *   the grid is a list of tile buttons, with the failure buttons beside the
 *   tile, never inside it.
 *
 * The retry that never stores a second copy is proved against the real
 * session door in tests/requestEditorDraft.test.ts.
 *
 * Run: node --import tsx --test tests/requestEditorSources.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';

const REACT = pathToFileURL(join(ROOT, 'node_modules/react/index.js')).href;
const stubUrl = (src: string) => 'data:text/javascript,' + encodeURIComponent(src);
const SHEET = stubUrl(`import React from '${REACT}'; export function Sheet(p) { return p.open ? React.createElement('div', null, p.children) : null; }`);
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
let previews = 0;
(URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => `blob:https://levonis-iq.com/p${++previews}`;
(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;

const { LanguageProvider } = await import('../src/LanguageContext');
const { AuthContext } = await import('../src/AuthContext');
const { SourcesArea } = await import('../src/components/community/requests/editor/SourcesArea');
const { ImageGrid, gridPictures } = await import('../src/components/community/requests/editor/ImageGrid');
const { SourceThumb } = await import('../src/components/community/requests/editor/SourceThumb');
const { rowsForPick, uploadSummary, landedMeanwhile, storedFile, unfinishedUploads } = await import('../src/components/community/requests/editor/uploads');
const { hydrate, addLink, addTextRef } = await import('../src/components/community/requests/editor/state');
const { editorStrings } = await import('../src/components/community/requests/editor/strings');
const { REQUEST_FILE_LIMITS } = await import('../packages/contracts/src/requestFiles');
type UploadRow = import('../src/components/community/requests/editor/uploads').UploadRow;
type UploadsApi = import('../src/components/community/requests/editor/uploads').UploadsApi;
type DraftShape = import('../src/components/community/requests/api').DraftShape;

const auth = {
  isAuthenticated: true,
  user: { id: 'u1', username: 'eve', name: 'Eve' },
  login: async () => {},
  loginWithGoogle: async () => 'ok' as const,
  register: async () => {},
  refreshUser: async () => {},
  adoptSession: async () => 'ok' as const,
  logout: async () => {},
  isLoaded: true,
};
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, { value: auth as never }, createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }))
  );
};
const text = (h: string) => h.replace(/[\u2066-\u2069]/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const srcs = (h: string) => [...h.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

const ROUTE = '/api/marketplace/requests/req_1/files';
const f = (id: string, kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  file_name: name,
  content_type: kind === 'reference' ? 'image/jpeg' : kind === 'model' ? 'model/stl' : 'application/pdf',
  size_bytes: 120_000,
  kind,
  inline: kind === 'reference',
  url: `${ROUTE}/${id}`,
  analysis: null,
  ...extra,
});

function state() {
  const d = {
    id: 'req_1', state: 'draft', revision: 1, updated_at: '2026-10-20T10:00:00.000Z', title: 'A clip', description: 'A clip, please',
    customer_notes: '', quantity: 1, governorate: '', delivery_pref: '', deadline: '', budget_iqd: null, expires_at: null, live_offers: 0, print: null,
    files: [
      f('crf_front', 'reference', 'front.jpg'),
      f('crf_side', 'reference', 'side.png'),
      f('crf_stl', 'model', 'bracket.stl', { analysis: { measured: true, format: 'stl', dimensions_mm: { x: 82, y: 64, z: 41 }, volume_mm3: 1, warnings: [] } }),
      f('crf_pdf', 'document', 'guide.pdf'),
    ],
    model: null,
  } as unknown as DraftShape;
  let s = hydrate(d);
  s = addLink(s, 'https://makerworld.com/en/models/12345', 'makerworld')[0];
  s = addTextRef(s, 'Same size as the old one, 62 mm across')[0];
  return s;
}

const fileOf = (name: string, type: string, size = 1000) => new File([new Uint8Array(size) as unknown as BlobPart], name, { type });

function uploadsWith(rows: UploadRow[]): UploadsApi {
  return {
    rows,
    add: () => undefined,
    retry: () => undefined,
    cancel: () => undefined,
    dismiss: () => undefined,
    working: rows.filter((r) => ['queued', 'checking', 'uploading', 'finishing'].includes(r.status)).length,
    failed: rows.filter((r) => r.status === 'failed').length,
    storedThisVisit: 0,
  };
}

// ------------------------------------------------------------------ one pick, asked in turn

test('one pick of four: three may go, the format the request refuses says why and is never queued', () => {
  let n = 0;
  const rows = rowsForPick(
    [fileOf('bracket.stl', 'model/stl'), fileOf('front.jpg', 'image/jpeg'), fileOf('side.png', 'image/png'), fileOf('virus.exe', 'application/octet-stream')],
    'ar',
    0,
    () => `up_${++n}`
  );
  assert.deepEqual(rows.map((r) => [r.name, r.status, r.door]), [
    ['bracket.stl', 'queued', 'session'],
    ['front.jpg', 'queued', 'simple'],
    ['side.png', 'queued', 'simple'],
    ['virus.exe', 'rejected', 'simple'],
  ]);
  assert.match(rows[3].reason, /‎\.exe|\.exe/);
  assert.match(rows[3].reason, /STL/, 'what a request DOES take is said');
  assert.ok(rows[1].preview?.startsWith('blob:'), 'a picture is a preview from the moment it is picked');
  assert.equal(rows[0].preview, null, 'a model has no device preview');
  assert.equal(rows[3].preview, null);
  // The seventh file is refused by the count, with the words of the limit.
  const full = rowsForPick([fileOf('a.jpg', 'image/jpeg')], 'en', REQUEST_FILE_LIMITS.maxFiles, () => 'x');
  assert.equal(full[0].status, 'rejected');
  assert.match(full[0].reason, /at most 6 files/);
});

test('partial success: the summary counts what landed, what is working and what failed', () => {
  const row = (status: UploadRow['status']) => ({ status }) as UploadRow;
  assert.equal(uploadSummary([row('queued'), row('uploading')], 2), null, 'nothing failed: nothing to say');
  assert.deepEqual(uploadSummary([row('failed'), row('uploading'), row('rejected')], 3), { ok: 3, all: 5, failed: 1 });
});

test('a whole-body retry adopts the file a lost answer stored, and only that file', () => {
  const files = [f('crf_old', 'reference', 'front.jpg'), f('crf_new', 'reference', 'front.jpg')] as never;
  const known = new Set(['crf_old']);
  assert.equal(landedMeanwhile(files, known, { name: 'front.jpg', size: 120_000 })?.id, 'crf_new');
  assert.equal(landedMeanwhile(files, known, { name: 'front.jpg', size: 1 }), null, 'another size is another file');
  assert.equal(landedMeanwhile(files, new Set(['crf_old', 'crf_new']), { name: 'front.jpg', size: 120_000 }), null);
  assert.equal(storedFile({ id: 'crf_1', file_name: 'a.png', content_type: 'image/png', size_bytes: 3, kind: 'reference', url: `${ROUTE}/crf_1` })?.inline, true);
  assert.equal(storedFile(null), null);
});

test('an upload a reload cut short is named, so the same file can be picked again', () => {
  const store = {
    length: 3,
    key: (i: number) => ['levonis.upload.request:req_1:1000:5:bracket.stl', 'levonis.upload.request:req_2:1:1:other.stl', 'levonis.request-editor.u1.req_1'][i] ?? null,
  };
  assert.deepEqual(unfinishedUploads('req_1', store), ['bracket.stl']);
  assert.deepEqual(unfinishedUploads('', store), []);
});

// ------------------------------------------------------------------ the area, rendered

function area(lang: 'ar' | 'en' | 'ckb') {
  const s = state();
  const rows: UploadRow[] = [
    { key: 'up_1', file: fileOf('flaky.stl', 'model/stl'), name: 'flaky.stl', kind: 'model', preview: null, status: 'failed', loaded: 0, total: 1000, reason: 'the connection dropped', door: 'session' },
    { key: 'up_2', file: fileOf('virus.exe', ''), name: 'virus.exe', kind: null, preview: null, status: 'rejected', loaded: 0, total: 1000, reason: '.exe files are not accepted on a request.', door: 'simple' },
    { key: 'up_3', file: fileOf('back.jpg', 'image/jpeg'), name: 'back.jpg', kind: 'image', preview: 'blob:https://levonis-iq.com/back', status: 'uploading', loaded: 400, total: 1000, reason: '', door: 'simple' },
  ];
  const uploads = uploadsWith(rows);
  const t = editorStrings(lang);
  return html(
    createElement(SourcesArea, {
      state: s,
      uploads,
      pictures: gridPictures(s, rows),
      touch: true,
      unfinished: [],
      measuring: new Set<string>(),
      measureLater: new Set<string>(),
      t,
      onPickFiles: () => undefined,
      onAddLink: async () => '',
      onAddTextRef: () => '',
      onOpenPicture: () => undefined,
      onNote: () => undefined,
      onPrimary: () => undefined,
      onOriginal: () => '',
      onView3d: () => undefined,
      onRemove: () => undefined,
    }),
    lang
  );
}

test('pictures are pictures — a preview before the upload, a sized copy after — and nothing on screen is an id', () => {
  const h = area('ar');
  const s = srcs(h);
  assert.ok(s.includes('blob:https://levonis-iq.com/back'), 'the picture on its way is drawn from its preview');
  assert.ok(s.some((x) => x.startsWith(`${ROUTE}/crf_front?w=`)), 'a stored picture asks its route for a sized copy');
  assert.ok(!s.some((x) => x === `${ROUTE}/crf_front`), 'never the phone original');
  assert.match(h, /data-editor-thumb="pending"/);
  assert.match(h, /data-editor-thumb="stored"/);
  assert.match(h, /data-editor-thumb="glyph"/, 'a model and a document are their glyphs');
  const words = text(h);
  for (const id of ['crf_', 'rps_', 'tmp_', 'up_']) assert.ok(!words.includes(id), `«${id}» reached the screen`);
  // What a merchant sees of each source: the measured size, the kinds, the main mark.
  assert.match(words, /82×64×41/);
  assert.match(h, /data-editor-primary/);
  assert.match(words, /bracket\.stl/);
  assert.match(words, /makerworld\.com/);
  assert.match(words, /Same size as the old one/);
});

test('one failure never stops the others: the failed file says why, with its own named retry and cancel; the refused one only hides', () => {
  const h = area('ar');
  const t = editorStrings('ar');
  const words = text(h);
  assert.ok(words.includes('لم يُرفع: the connection dropped'));
  assert.ok(words.includes(`لن يُرفع: .exe files are not accepted on a request.`));
  assert.match(h, new RegExp(`aria-label="${t.retry}: flaky\\.stl"`));
  assert.match(h, new RegExp(`aria-label="${t.cancelUpload}: flaky\\.stl"`));
  assert.ok(words.includes(t.dismiss));
  assert.match(h, /data-editor="upload-summary"/);
  assert.ok(words.includes('رُفع 0 من 2 — 1 لم يُرفع'));
});

test('one list of every kind: each row its eye and its bin named with the file, and no button inside a button', () => {
  const h = area('ar');
  assert.match(h, /aria-label="اعرض front\.jpg"/, 'a picture opens the in-page viewer');
  assert.match(h, /aria-label="احذف bracket\.stl"/);
  assert.equal(/<button[^>]*>(?:(?!<\/button>).)*<button/s.test(h), false, 'a control nested in a control');
  // The picture grid of P1-06 is still the viewer list and stays a list of tile buttons when it is drawn.
  const s = state();
  const failed: UploadRow = { key: 'up_9', file: fileOf('x.jpg', 'image/jpeg'), name: 'x.jpg', kind: 'image', preview: 'blob:x', status: 'failed', loaded: 0, total: 1, reason: 'no', door: 'simple' };
  const grid = html(createElement(ImageGrid, { pictures: gridPictures(s, [failed]), onOpen: () => undefined, onRetry: () => undefined, onCancel: () => undefined, t: editorStrings('en') }), 'en');
  assert.match(grid, /data-editor-picture-failed/);
  assert.match(grid, /aria-label="Try again: x\.jpg"/);
  assert.equal(/<button[^>]*>(?:(?!<\/button>).)*<button/s.test(grid), false);
});

test('the same area in English and in Sorani: its own words in each, never the Arabic standing in', () => {
  const en = text(area('en'));
  for (const w of ['What you have', 'Model file', 'Model link', 'Description only', 'Reference pictures', 'Attached files', 'Add a file or picture', 'Supported formats:']) assert.ok(en.includes(w), w);
  const ckb = text(area('ckb'));
  for (const w of ['فایلی مۆدێل', 'بەستەری مۆدێل', 'تەنها وەسف', 'وێنەی سەرچاوە', 'فایلە هاوپێچکراوەکان']) assert.ok(ckb.includes(w), w);
  assert.ok(!ckb.includes('طريقة الطلب') && !ckb.includes('أضف ملفًا'), 'the Arabic does not stand in for Sorani');
});

test('SourceThumb: the preview, the stored copy, the glyph', () => {
  assert.match(html(createElement(SourceThumb, { kind: 'image', preview: 'blob:x' })), /src="blob:x"[^>]*data-editor-thumb="pending"|data-editor-thumb="pending"[^>]*/);
  const stored = html(createElement(SourceThumb, { kind: 'image', url: `${ROUTE}/crf_1` }));
  assert.match(stored, /w=160/);
  assert.match(html(createElement(SourceThumb, { kind: 'model' })), /data-editor-thumb="glyph"/);
});
