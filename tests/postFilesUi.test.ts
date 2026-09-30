/**
 * FILES ON A PROJECT, ON THE SCREEN (docs/COMMUNITY_ECOSYSTEM.md §9.4, Phase 4
 * client) — src/components/community/projects/FileRows.tsx and the pages
 * that mount it.
 *
 *   the words: every new key in ar, en AND real Sorani, never the Arabic
 *   pasted across;
 *   the render (`renderToStaticMarkup`, the technique of
 *   tests/ordersListUi.test.ts): a row per file with its name, size and
 *   kind; «عرض ثلاثي الأبعاد» only where a preview mesh exists; the download
 *   hidden from a guest and from a file the author kept, with the sentence
 *   why in its place; the anchor for a signed-in reader on a downloadable
 *   file, pointing at the gated route;
 *   the mint guard: a double tap on the 3D button mints ONE token;
 *   the pins: the composer sends `files[]` and mounts the file composer, the
 *   project page mounts the rows, the media picker and the chat route large
 *   files through the session path, the wizard's tiles carry the request id,
 *   tokens only (no hex, no `dark:`, no physical left/right utilities).
 *
 * Run: node --import tsx --test tests/postFilesUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { PostFile } from '../src/components/community/files/api';

// The language provider reads `levo_lang` from localStorage on mount; a stub
// lets each render pick its language the way the browser fixture does.
let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { useProjectStrings } = await import('../src/components/community/projects/strings');
const { FileRows, POST_FILE_ACCEPT, mintOnce, postFileKind, viewerPage } = await import('../src/components/community/projects/FileRows');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;

const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));
};
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
/** How many elements carry a boolean data mark (React writes `data-x="true"`). */
const marks = (s: string, name: string) => count(s, new RegExp(`${name}="(?:true|)"`, 'g'));

const FILES: PostFile[] = [
  { id: 'f1', name: 'dragon-body', bytes: 4_812_233, kind: 'model', downloadable: true, has_preview: true },
  { id: 'f2', name: 'assembly-notes', bytes: 288_120, kind: 'document', downloadable: false, has_preview: false },
];

// ------------------------------------------------------------------ words

const FILE_KEYS = [
  'files', 'modelFile', 'modelFileHint', 'addFile', 'fileName', 'downloadable', 'downloadableHint', 'filesLimit', 'fileKindRefused',
  'view3d', 'download', 'signInToDownload', 'notDownloadable', 'noPreview', 'removeFile', 'opening', 'viewerFailed', 'takePhoto', 'uploadingFiles',
] as const;

function Probe() {
  const s = useProjectStrings() as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of FILE_KEYS) picked[k] = s[k];
  picked.fileKinds = s.fileKinds;
  return createElement('pre', null, JSON.stringify(picked));
}

function words(lang: 'ar' | 'en' | 'ckb'): Record<string, unknown> {
  const out = html(createElement(Probe), lang);
  const json = out.replace(/^<pre>/, '').replace(/<\/pre>$/, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  return JSON.parse(json) as Record<string, unknown>;
}

test('every file string exists in ar, en and ckb; the Sorani is Sorani, never the Arabic or the English', () => {
  const ar = words('ar');
  const en = words('en');
  const ckb = words('ckb');
  let kurdish = 0;
  for (const k of FILE_KEYS) {
    for (const [lang, table] of [['ar', ar], ['en', en], ['ckb', ckb]] as const) {
      assert.ok(typeof table[k] === 'string' && (table[k] as string).trim(), `${lang}.${k} is written`);
    }
    assert.notEqual(ckb[k], ar[k], `${k}: ckb is a copy of the Arabic`);
    assert.notEqual(ckb[k], en[k], `${k}: ckb is a copy of the English`);
    assert.notEqual(en[k], ar[k], `${k}: en is a copy of the Arabic`);
    if (KURDISH.test(String(ckb[k]))) kurdish++;
  }
  assert.ok(kurdish >= FILE_KEYS.length - 1, `the Sorani column reads as Kurdish (${kurdish}/${FILE_KEYS.length})`);
  for (const table of [ar, en, ckb]) {
    const kinds = table.fileKinds as Record<string, string>;
    assert.ok(kinds.model && kinds.document, 'both kinds named');
  }
  assert.notEqual((ckb.fileKinds as Record<string, string>).model, (ar.fileKinds as Record<string, string>).model);
});

// ------------------------------------------------------------------ the rows

test('a guest sees every row, the 3D button only where a mesh exists, and never a download — the sentence why stands in its place', () => {
  const out = html(createElement(FileRows, { postId: 'prj_1', files: FILES, signedIn: false }));
  assert.equal(marks(out, 'data-project-file'), 2, 'two rows');
  assert.match(out, /dragon-body/);
  assert.match(out, /assembly-notes/);
  assert.equal(marks(out, 'data-project-file-view'), 1, 'one «عرض ثلاثي الأبعاد» — the document has no mesh');
  assert.equal(marks(out, 'data-project-file-download'), 0, 'no download for a guest');
  assert.doesNotMatch(out, /\/download/, 'the gated route is not even named to a guest');
  assert.equal(marks(out, 'data-project-file-why'), 2, 'each row says why');
  const ar = words('ar');
  assert.match(out, new RegExp(String(ar.signInToDownload)), 'the downloadable file asks the guest to sign in');
  assert.match(out, new RegExp(String(ar.notDownloadable)), 'the kept file says the maker kept it');
  assert.equal(marks(out, 'data-project-files'), 1, 'the section carries its mark');
  assert.match(out, /4\.6 م\.ب/, 'the size beside the name, in the reader\'s units');
});

test('a signed-in reader gets the download anchor on the downloadable file only, pointing at the gated route', () => {
  const out = html(createElement(FileRows, { postId: 'prj_1', files: FILES, signedIn: true }), 'en');
  assert.equal(marks(out, 'data-project-file-download'), 1, 'one anchor');
  assert.match(out, /href="\/api\/community\/posts\/prj_1\/files\/f1\/download"/, 'the route of the downloadable file');
  assert.doesNotMatch(out, /files\/f2\/download/, 'the kept file has no anchor');
  assert.equal(marks(out, 'data-project-file-why'), 1, 'only the kept file explains itself');
  assert.match(out, /The maker has not made this file downloadable\./);
  assert.match(out, /View in 3D/);
  assert.match(out, /Download/);
  assert.match(out, /4\.6 MB/);
});

test('nothing renders without files; the Sorani render carries Kurdish words', () => {
  assert.equal(html(createElement(FileRows, { postId: 'prj_1', files: [], signedIn: true })), '');
  const out = html(createElement(FileRows, { postId: 'prj_1', files: FILES, signedIn: true }), 'ckb');
  assert.match(out, /داگرتن/, '«تنزيل» in Sorani');
  assert.match(out, /بینینی سێ ڕەهەندی/, '«عرض ثلاثي الأبعاد» in Sorani');
});

// ------------------------------------------------------------------ the mint guard

test('mintOnce: a double tap mints one token; after it settles the next press mints again; a refusal resets the guard', async () => {
  let mints = 0;
  let release: (v: { token: string }) => void = () => undefined;
  const mint = mintOnce(() => {
    mints += 1;
    return new Promise<{ token: string }>((resolve) => {
      release = resolve;
    });
  });
  const first = mint();
  const second = mint();
  assert.equal(mints, 1, 'the second press did not mint');
  assert.equal(await second, null, 'the second press is a no-op');
  release({ token: 't1' });
  assert.deepEqual(await first, { token: 't1' });
  const third = mint();
  assert.equal(mints, 2, 'a press after the first settled mints again');
  release({ token: 't2' });
  assert.deepEqual(await third, { token: 't2' });

  let failed = 0;
  const failing = mintOnce(() => {
    failed += 1;
    return Promise.reject(new Error('VIEWER_NOT_ALLOWED'));
  });
  await assert.rejects(failing(), /VIEWER_NOT_ALLOWED/);
  await assert.rejects(failing(), /VIEWER_NOT_ALLOWED/);
  assert.equal(failed, 2, 'a refusal does not jam the guard');
});

test('the viewer page is the server\'s url, else the route from the token; kinds and accept list', () => {
  assert.equal(viewerPage({ token: 'abc', url: '/model-viewer/abc', expires_at: '', grant: 'preview' }), '/model-viewer/abc');
  assert.equal(viewerPage({ token: 'a b', url: '', expires_at: '', grant: 'full' }), '/model-viewer/a%20b');
  assert.equal(viewerPage({ token: 'x', url: 'https://evil.example/', expires_at: '', grant: 'full' }), '/model-viewer/x', 'never an absolute url');
  assert.equal(postFileKind('Dragon.STL'), 'model');
  assert.equal(postFileKind('part.3mf'), 'model');
  assert.equal(postFileKind('notes.pdf'), 'document');
  assert.equal(postFileKind('photo.jpg'), null, 'a picture belongs in the media grid');
  assert.equal(postFileKind('archive.zip'), null, 'zip is not admitted yet (mediaStorage allowlist)');
  assert.equal(postFileKind('noext'), null);
  for (const ext of ['.stl', '.3mf', '.obj', '.step', '.pdf']) assert.ok(POST_FILE_ACCEPT.includes(ext), ext);
});

// ------------------------------------------------------------------ the pins

test('the composer sends files[] and mounts the file composer; the project page mounts the rows', () => {
  const composer = code('src/pages/community/ProjectComposer.tsx');
  assert.match(composer, /files: d\.files\.map\(\(f\) => \(\{ file_key: f\.key, name: f\.name\.trim\(\), downloadable: f\.downloadable \}\)\)/, 'toInput carries files[] as {file_key, name, downloadable}');
  assert.match(composer, /<FileComposer value=\{draft\.files\}/, 'the file composer is mounted');
  assert.match(composer, /if \(code\.startsWith\('POST_FILE'\)\) return 'files';/, 'a POST_FILE_* refusal lands under the files');
  assert.match(composer, /\{s\.modelFile\}/, 'the section is named «ملف المجسم (اختياري)»');
  const project = code('src/pages/community/Project.tsx');
  assert.match(project, /<FileRows postId=\{post\.id\} files=\{files\} signedIn=\{!!user\} \/>/, 'the rows are mounted with the viewer\'s sign-in state');
});

test('the picker, the wizard and the chat route large files through the session path with the tile', () => {
  // Raw source here: `accept="image/*"` would open a fake block comment for the stripper.
  const picker = read('src/components/community/projects/MediaPicker.tsx');
  assert.match(picker, /pickUpload\(file\) === 'session'/, 'the media picker asks which door');
  assert.match(picker, /<UploadTile file=\{u\.file\} purpose="post"/, 'a large picture or clip is a tile');
  assert.match(picker, /capture="environment"/, 'the camera input on a phone');
  const composer = code('src/components/community/projects/FileComposer.tsx');
  assert.match(composer, /<UploadTile file=\{u\.file\} purpose="post"/, 'a model or a document always takes the session (the post API wants a PRIVATE post-files/ key)');
  assert.doesNotMatch(composer, /uploadFile\(/, 'never the whole-body route for a model');
  // The reader's rows are their own module (perf review 2026-09-30): the project
  // page must not download the tile, the switch and the input it never shows.
  const rows = code('src/components/community/projects/FileRows.tsx');
  assert.doesNotMatch(rows, /UploadTile|from '\.\.\/\.\.\/ui\/Switch'|from '\.\.\/\.\.\/ui\/Field'/, 'FileRows carries the composer\'s imports');
  assert.match(code('src/pages/community/ProjectComposer.tsx'), /from '\.\.\/\.\.\/components\/community\/projects\/FileComposer'/, 'the composer page imports the composer module');
  assert.doesNotMatch(code('src/pages/community/Project.tsx'), /FileComposer/, 'the reader page never imports the composer');
  const wizard = read('src/components/community/requests/RequestWizard.tsx');
  assert.match(wizard, /purpose="request"/);
  assert.match(wizard, /entityId=\{t\.entityId\}/, 'a request upload names its request');
  assert.match(wizard, /pickUpload\(f\) === 'session'/);
  assert.match(wizard, /capture="environment"/);
  const chat = read('src/pages/Chat.tsx');
  assert.match(chat, /pickUpload\(file\) === 'session'/);
  assert.match(chat, /<UploadTile file=\{u\.file\} purpose="chat" entityId=\{id\}/, 'a chat upload names its conversation');
  assert.match(chat, /result\.key \?\? result\.url\.replace\(\/\^\\\/files\\\/\/, ''\)/, 'the chat message is written with the session\'s key');
  assert.match(chat, /<input type="file" multiple accept="image\/\*"/, 'several photos at once');
});

test('the file rows and the composer use tokens only: no hex, no dark:, no physical left/right utilities', () => {
  for (const rel of ['src/components/community/projects/FileRows.tsx', 'src/components/community/projects/FileComposer.tsx']) {
    const src = code(rel);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, `${rel}: a hex colour`);
    assert.doesNotMatch(src, /\bdark:/, `${rel}: a dark: variant`);
    assert.doesNotMatch(src, /className="[^"]*\b(?:pl|pr|ml|mr|left|right|text-left|text-right)-/, `${rel}: a physical utility`);
    for (const cls of ['bg-surface', 'text-text-muted', 'border-border-subtle']) assert.match(src, new RegExp(cls), `${rel}: ${cls} in use`);
  }
  assert.match(code('src/components/community/projects/FileRows.tsx'), /text-text-primary/, 'the reader\'s file name is primary text');
});
