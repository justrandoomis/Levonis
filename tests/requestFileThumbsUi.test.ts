/**
 * P1-03 ON THE SCREEN — request pictures are PICTURES (never ids), the pasted
 * link is its card, and every refusal and every wizard line reads in Arabic,
 * English and real Sorani (Community V3 R1, R4, R5, R8, R9, R12).
 *
 *   the wizard: a picture is a thumbnail from the moment it is chosen (its
 *   object URL, revoked when it leaves) and after it is stored (the sized
 *   route); a file the request cannot take is refused before the upload, by
 *   the same table the server reads; every `loc` carries written Sorani;
 *   the details: the attachment list draws sized thumbnails and kind words;
 *   the page draws the source link and hands the files to the offer panel;
 *   the offer panel: what the workshop prices — the pictures and the link —
 *   above every state of the offer;
 *   the board: the thumbnail is a sized copy, the link its card;
 *   the mirrors: material and colour in the reader's language.
 *
 * `renderToStaticMarkup`, the technique of tests/requestPageUi.test.ts.
 *
 * Run: node --import tsx --test tests/requestFileThumbsUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { REQUEST_FILE_LIMITS } from '../packages/contracts/src/requestFiles';
import { FORMAT_CAPABILITIES } from '../packages/contracts/src/modelFormats';
import { FORMAT_CAPABILITIES as SERVER_FORMATS } from '../worker/lib/modelGeometry';

const REACT = pathToFileURL(join(ROOT, 'node_modules/react/index.js')).href;
const stubUrl = (src: string) => 'data:text/javascript,' + encodeURIComponent(src);
const SHEET = stubUrl(`import React from '${REACT}'; export function Sheet(p) { return p.open ? React.createElement('div', null, p.children) : null; }`);
const CONFIRM = stubUrl('export function useConfirm(){ return [async () => false, null]; } export function ConfirmDialog(){ return null; }');
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `const SHEET = ${JSON.stringify(SHEET)};
       const CONFIRM = ${JSON.stringify(CONFIRM)};
       export async function resolve(specifier, context, next) {
         if (/\\/ui\\/Sheet(\\.tsx)?$/.test(specifier)) return { url: SHEET, shortCircuit: true };
         if (/\\/ui\\/ConfirmDialog(\\.tsx)?$/.test(specifier)) return { url: CONFIRM, shortCircuit: true };
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
const { AuthContext } = await import('../src/AuthContext');
const { AttachmentList } = await import('../src/components/media/RequestAttachments');
const { MerchantOfferSection } = await import('../src/components/community/requests/OfferComposer');
const { WizardFileThumb, previewUrl, releasePreviews } = await import('../src/components/community/requests/RequestWizard');
const { requestImageSrc, requestImageSrcSet, pictureFiles } = await import('../src/components/community/requests/RequestFileThumbs');
const { requestFileCheck, requestFilesCheck, requestFileProblemText, requestUploadRefusal, modelFormatGroups, namedForUpload } = await import('../src/components/community/requests/fileRefusals');
const { localColour, localMaterial, REQUEST_COLOURS } = await import('../src/components/community/requests/mirrors');
const { bareLinkCard } = await import('../src/components/community/links/LinkCard');
const { ApiError } = await import('../src/lib/api');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;

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
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const srcs = (h: string) => [...h.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

const ROUTE = '/api/marketplace/requests/req_1/files';
const files = [
  { id: 'crf_pic1', file_name: 'front.jpg', content_type: 'image/jpeg', size_bytes: 120_000, kind: 'reference', inline: true, url: `${ROUTE}/crf_pic1` },
  { id: 'crf_pic2', file_name: 'side.png', content_type: 'image/png', size_bytes: 90_000, kind: 'reference', inline: true, url: `${ROUTE}/crf_pic2` },
  { id: 'crf_model', file_name: 'part.stl', content_type: 'model/stl', size_bytes: 2_000_000, kind: 'model', inline: false, url: `${ROUTE}/crf_model` },
];
const LINK = 'https://makerworld.com/en/models/12345';

// ------------------------------------------------------------ the pieces

test('a stored request picture is asked for as a sized copy of its route; anything else is drawn as given', () => {
  assert.equal(requestImageSrc(`${ROUTE}/crf_pic1`, 160), `${ROUTE}/crf_pic1?w=160`);
  assert.equal(requestImageSrcSet(`${ROUTE}/crf_pic1`), `${ROUTE}/crf_pic1?w=160 160w, ${ROUTE}/crf_pic1?w=320 320w, ${ROUTE}/crf_pic1?w=640 640w`);
  assert.equal(requestImageSrc('blob:https://levonis-iq.com/1', 160), 'blob:https://levonis-iq.com/1');
  assert.equal(requestImageSrcSet('blob:https://levonis-iq.com/1'), undefined);
  assert.deepEqual(pictureFiles(files).map((f) => f.id), ['crf_pic1', 'crf_pic2'], 'only pictures with a route');
  assert.deepEqual(pictureFiles([{ id: 'x', inline: true, url: null }]), [], 'a picture this reader may not open is not drawn');
});

test('the wizard: a stored picture is its sized thumbnail, a picture on the device its object URL, a model its glyph — never an id', () => {
  const stored = html(createElement(WizardFileThumb, { url: `${ROUTE}/crf_pic1`, kind: 'image' }));
  assert.deepEqual(srcs(stored), [`${ROUTE}/crf_pic1?w=160`]);
  assert.match(stored, /data-wizard-thumb="stored"/);
  assert.match(stored, /srcSet="[^"]*\?w=320 320w/i);
  const pending = html(createElement(WizardFileThumb, { objectUrl: 'blob:https://levonis-iq.com/abc', kind: 'image' }));
  assert.deepEqual(srcs(pending), ['blob:https://levonis-iq.com/abc']);
  assert.match(pending, /data-wizard-thumb="pending"/);
  const model = html(createElement(WizardFileThumb, { url: `${ROUTE}/crf_model`, kind: 'model' }));
  assert.equal(srcs(model).length, 0, 'a model is not drawn as a broken picture');
  for (const h of [stored, pending, model]) assert.doesNotMatch(text(h), /crf_/, 'no id on the screen');
});

test('the wizard: a picture gets an object URL, a model none, and every URL is revoked when its file leaves', () => {
  const made: string[] = [];
  const revoked: string[] = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = ((b: Blob) => {
    const u = `blob:test/${made.length}-${(b as File).name}`;
    made.push(u);
    return u;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((u: string) => revoked.push(u)) as typeof URL.revokeObjectURL;
  try {
    const pic = previewUrl(new File([new Uint8Array(4)], 'photo.jpg', { type: 'image/jpeg' }));
    const stl = previewUrl(new File([new Uint8Array(4)], 'part.stl'));
    assert.equal(pic, 'blob:test/0-photo.jpg');
    assert.equal(stl, null);
    releasePreviews([{ objectUrl: pic }, { objectUrl: stl }]);
    assert.deepEqual(revoked, [pic]);
  } finally {
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  }
  // …and the wizard calls it on every exit: removed, uploaded, closed.
  const wizard = code('src/components/community/requests/RequestWizard.tsx');
  assert.match(wizard, /useEffect\(\(\) => \(\) => releasePreviews\(pendingRef\.current\), \[\]\);/, 'on unmount');
  assert.match(wizard, /function dropPending\(tempId: string\) \{[\s\S]*?releasePreviews\(/, 'on removal');
  assert.match(wizard, /setPending\(\[\]\);[\s\S]{0,200}releasePreviews\(leaving\);/, 'on upload');
  assert.match(wizard, /interface PendingFile \{\s*tempId: string;\s*file: File;\s*objectUrl: string \| null;\s*\}/);
});

test('the wizard: files are checked before the upload by the table the server reads, the review shows the pictures and the link', () => {
  const wizard = code('src/components/community/requests/RequestWizard.tsx');
  assert.match(wizard, /requestFilesCheck\(Array\.from\(list\), L, files\.length \+ pending\.length\)/);
  assert.match(wizard, /const MAX_FILES = REQUEST_FILE_LIMITS\.maxFiles;/);
  assert.doesNotMatch(wizard, /const MAX_FILES = 6/);
  assert.match(wizard, /data-wizard="review-sources"/);
  assert.match(wizard, /<RequestThumb url=\{f\.url\} size=\{56\} alt=\{f\.file_name\} \/>/);
  assert.match(wizard, /<SourceLinkCard key=\{linkWarm \|\| 'bare'\} url=\{s\.source_url\} \/>/);
  assert.match(wizard, /void warmLink\(canonical\)/, 'the author resolve warms the card readers draw');
  assert.match(wizard, /requestUploadRefusal\(reasons\[0\], L,/, 'a failed upload says why, not only how many');
  assert.doesNotMatch(wizard, /SWATCHES/, 'one colour table, with Sorani (mirrors.ts)');
});

test('R9: every line of the wizard is written in Sorani — never the Arabic pasted across', () => {
  const src = read('src/components/community/requests/RequestWizard.tsx');
  const calls = [...src.matchAll(/loc\(\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*,\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*(?:,\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`))?\s*\)/g)];
  assert.ok(calls.length >= 110, `the wizard has its loc calls (${calls.length})`);
  const missing = calls.filter((m) => !m[3]).map((m) => m[2]);
  assert.deepEqual(missing, [], 'a loc call without Sorani falls back to the Arabic');
  for (const m of calls) {
    const [ar, , ckb] = [m[1], m[2], m[3]!];
    assert.notEqual(ckb, ar, `${m[2]}: the Sorani is the Arabic`);
    // A sentence carries Sorani letters; a single loanword («ستاندارد») may share all of its letters with Arabic.
    if (/[؀-ۿ]{2,}\s+[؀-ۿ]{2,}/.test(ckb)) assert.match(ckb, KURDISH, `${m[2]}: «${ckb}» has no Sorani letter`);
  }
  for (const c of REQUEST_COLOURS) {
    assert.ok(c.ckb.trim(), c.en);
    assert.notEqual(c.ckb, c.ar, `${c.en}: the Sorani colour is the Arabic`);
  }
});

// ------------------------------------------------------------ R5: the words

test('R5: refusals are rendered from the limits table and FORMAT_CAPABILITIES, in three languages', () => {
  assert.deepEqual(FORMAT_CAPABILITIES, SERVER_FORMATS, 'the browser reads the table the server measures by');
  const g = modelFormatGroups();
  assert.match(g.printable, /STL/);
  assert.match(g.printable, /3MF/);
  assert.match(g.convert, /GLB/);
  assert.match(g.convert, /glTF/);
  assert.equal(g.reference, 'STEP', 'STEP is a reference only — no promise the server does not keep');

  const seventh = { name: 'x.png', size: 10 };
  const bigPic = { name: 'big.jpg', size: REQUEST_FILE_LIMITS.maxBytes.image + 1 };
  const zip = { name: 'files.zip', size: 10 };
  const said: Record<string, string[]> = { ar: [], en: [], ckb: [] };
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const full = requestFileCheck(seventh, lang, REQUEST_FILE_LIMITS.maxFiles);
    const large = requestFileCheck(bigPic, lang);
    const kind = requestFileCheck(zip, lang);
    assert.match(full, new RegExp(String(REQUEST_FILE_LIMITS.maxFiles)));
    assert.match(large, /25/);
    assert.match(kind, /zip/);
    assert.match(kind, /STEP/);
    said[lang] = [full, large, kind];
    assert.equal(requestFileCheck({ name: 'ok.stl', size: 1000 }, lang), '', 'a file that fits is not refused');
  }
  for (let i = 0; i < 3; i++) {
    assert.notEqual(said.ckb[i], said.ar[i], 'the Sorani is its own');
    assert.match(said.ckb[i], KURDISH);
  }
  // The server answer reads the same way as the browser check.
  const server = new ApiError(400, 'That file is too large', 'UPLOAD_TOO_LARGE', { limit_bytes: REQUEST_FILE_LIMITS.maxBytes.model, kind: 'model' });
  assert.equal(requestUploadRefusal(server, 'ckb'), requestFileProblemText({ code: 'UPLOAD_TOO_LARGE', kind: 'model', limit_bytes: REQUEST_FILE_LIMITS.maxBytes.model }, 'ckb'));
  const kindRefusal = new ApiError(400, 'no', 'UPLOAD_KIND_NOT_ALLOWED', { extension: 'zip', purpose: 'request' });
  assert.match(requestUploadRefusal(kindRefusal, 'en'), /^\.zip files are not accepted on a request\. A request takes pictures/);
});

// ------------------------------------------------------------ review fixes

test('one pick, one refusal: each refused file named with its short reason, the formats said ONCE, nothing past the sixth dropped silently', () => {
  const f = (name: string, size = 10, type = '') => new File([new Uint8Array(size)], name, { type });
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    // Two wrong formats: the accepted-formats paragraph appears once, not once per file.
    const two = requestFilesCheck([f('a.zip'), f('b.rar'), f('ok.stl')], lang);
    assert.deepEqual(two.accepted.map((x) => x.name), ['ok.stl'], lang);
    assert.match(two.refusal, /«a\.zip»/);
    assert.match(two.refusal, /«b\.rar»/);
    assert.equal(two.refusal.split('STEP').length - 1, 1, `${lang}: the format list is said once`);
    assert.ok(two.refusal.length < requestFileCheck({ name: 'a.zip', size: 10 }, lang).length * 1.6, `${lang}: two refusals do not repeat the paragraph`);
    // Four saved, three picked: two go, the third is NAMED with the count sentence.
    const full = requestFilesCheck([f('1.png'), f('2.png'), f('3.png')], lang, 4);
    assert.deepEqual(full.accepted.map((x) => x.name), ['1.png', '2.png'], lang);
    assert.match(full.refusal, /«3\.png»/, `${lang}: the file past the sixth is named, not sliced away`);
    assert.match(full.refusal, new RegExp(String(REQUEST_FILE_LIMITS.maxFiles)));
    const fine = requestFilesCheck([f('x.jpg')], lang);
    assert.equal(fine.refusal, '', `${lang}: a file that fits is not refused`);
    assert.equal(fine.accepted.length, 1);
  }
});

test('a picture with no extension (a camera shot named by digits) is named from its type, then checked and sent like any other', () => {
  const shot = new File([new Uint8Array(2_000_000)], '1697812345678', { type: 'image/jpeg' });
  const named = namedForUpload(shot);
  assert.equal(named.name, '1697812345678.jpg');
  assert.equal(named.size, shot.size);
  assert.equal(requestFileCheck(shot, 'en'), '', 'the browser no longer refuses it');
  const { accepted, refusal } = requestFilesCheck([shot], 'ar');
  assert.equal(refusal, '');
  assert.equal(accepted[0].name, '1697812345678.jpg', 'and it is sent with the name every door asks');
  // Only a picture type is named; anything else without an extension is still refused.
  assert.equal(namedForUpload(new File([new Uint8Array(4)], 'blob', { type: 'application/octet-stream' })).name, 'blob');
  assert.match(requestFileCheck(new File([new Uint8Array(4)], 'blob', { type: 'image/heic' }), 'en'), /not accepted/);
});

test('a listed extension whose bytes are something else reads as a mismatch, and HEIC as HEIC — never ".jpg files are not accepted"', () => {
  const mismatch = new ApiError(400, 'no', 'UPLOAD_KIND_NOT_ALLOWED', { declared: 'jpg', detected: null });
  const heic = new ApiError(400, 'no', 'IMAGE_HEIC_UNSUPPORTED');
  const said: Record<string, [string, string]> = {};
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const m = requestUploadRefusal(mismatch, lang);
    const h = requestUploadRefusal(heic, lang);
    assert.match(m, /\.jpg/);
    assert.doesNotMatch(m, /STEP/, `${lang}: no accepted-formats list for an accepted extension`);
    assert.notEqual(m, requestFileProblemText({ code: 'UPLOAD_KIND_NOT_ALLOWED', extension: 'jpg' }, lang));
    assert.match(h, /HEIC/);
    assert.match(h, /JPEG/);
    said[lang] = [m, h];
  }
  assert.match(said.en[0], /^The contents of this file do not match its name/);
  for (let i = 0; i < 2; i++) {
    assert.notEqual(said.ckb[i], said.ar[i], 'the Sorani is its own');
    assert.match(said.ckb[i], KURDISH);
  }
});

test('the chat print-request sheet reads the one table and takes the door it picks', () => {
  const sheet = code('src/components/chat/commerce/PrintRequestSheet.tsx');
  assert.doesNotMatch(sheet, /const MAX_FILES = 6/);
  assert.doesNotMatch(sheet, /image\/jpeg,image\/png/, 'no accept list of its own');
  assert.match(sheet, /const ACCEPT = ATTACHMENT_ACCEPT;/);
  assert.match(sheet, /const MAX_FILES = MAX_ATTACHMENTS;/);
  assert.match(sheet, /requestFilesCheck\(picked, L, files\.length\)/, 'each picked file asked count, kind and size');
  assert.match(sheet, /uploadRequestFiles\(request\.id, \[files\[i\]\]/, 'a model or a large file takes the session');
  assert.match(sheet, /requestUploadRefusal\(err, L,/);
  assert.doesNotMatch(code('src/lib/chatCommerceApi.ts'), /uploadRequestFile:/, 'no whole-body-only helper left to call');
});

test('the chat print-request sheet is written in Sorani line by line — never the Arabic falling back', () => {
  const src = read('src/components/chat/commerce/PrintRequestSheet.tsx');
  const calls = [...src.matchAll(/loc\(\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*,\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*(?:,\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`))?\s*\)/g)];
  assert.ok(calls.length >= 29, `the sheet has its loc calls (${calls.length})`);
  assert.equal(calls.length, (src.match(/\bloc\(/g) ?? []).length, 'every loc call is a literal triple the check can read');
  assert.deepEqual(calls.filter((m) => !m[3]).map((m) => m[2]), [], 'a loc call without Sorani falls back to the Arabic');
  for (const m of calls) {
    const [ar, , ckb] = [m[1], m[2], m[3]!];
    assert.notEqual(ckb, ar, `${m[2]}: the Sorani is the Arabic`);
    if (/[؀-ۿ]{2,}\s+[؀-ۿ]{2,}/.test(ckb)) assert.match(ckb, KURDISH, `${m[2]}: «${ckb}» has no Sorani letter`);
  }
  const sorani = (en: string) => calls.find((m) => m[2].slice(1, -1) === en)?.[3]?.slice(1, -1);
  assert.equal(sorani('Attach pictures or the model file'), 'وێنە یان فایلی مۆدێلەکە هاوپێچ بکە');
  assert.equal(sorani('Sending…'), 'دەنێردرێت…');
  assert.equal(sorani('Remove ${file.name}'), 'لابردنی ${file.name}');
  assert.doesNotMatch(src, /OWNER: Sorani to be written/);
});

test('the request page: session uploads draw the shared tile, the meta line follows the page direction, My requests says the colour in the reader words', () => {
  const list = code('src/components/media/RequestAttachments.tsx');
  assert.doesNotMatch(list, /slice\(0, room\)/, 'no silent slice');
  assert.match(list, /requestFilesCheck\(Array\.from\(list\), L, files\.length \+ tiles\.length\)/);
  assert.match(list, /<UploadTile[\s\S]{0,80}purpose="request"[\s\S]{0,40}entityId=\{requestId\}/, 'progress, cancel and retry for a 300 MB model');
  for (const lang of ['ar', 'ckb'] as const) {
    const h = html(createElement(AttachmentList, { requestId: 'req_1', files, canEdit: false, onChanged: () => undefined }), lang);
    assert.doesNotMatch(h, /<p[^>]*dir="ltr"[^>]*>[^<]*(صورة|وێنە|مجسم|مۆدێل)/, `${lang}: the kind word is not forced left-to-right`);
    assert.match(h, /<span dir="ltr">[0-9.]+ (KB|MB)<\/span>/, `${lang}: only the size is isolated`);
  }
  assert.match(code('src/components/print/MyRequestsList.tsx'), /localColour\(p\.color_name \|\| p\.color_hex,/);
  assert.match(read('src/components/community/requests/RequestWizard.tsx'), /`هەنگاوی \$\{step\} لە 4`/, 'one digit system in the step line');
});

// ------------------------------------------------------------ the details page

test('details: the attachment list draws sized thumbnails and the kind in words — never an id or a code', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const h = html(createElement(AttachmentList, { requestId: 'req_1', files, canEdit: false, onChanged: () => undefined }), lang);
    assert.deepEqual(srcs(h), [`${ROUTE}/crf_pic1?w=160`, `${ROUTE}/crf_pic2?w=160`], lang);
    assert.doesNotMatch(text(h), /crf_|reference/, `${lang}: an id or a kind code on the screen`);
  }
  assert.match(text(html(createElement(AttachmentList, { requestId: 'req_1', files, canEdit: false, onChanged: () => undefined }), 'ckb')), /مۆدێل/);
  const page = code('src/pages/community/Request.tsx');
  assert.match(page, /setSourceUrl\(f\?\.source_url \? f\.source_url : null\);/, 'the link comes from the print summary');
  assert.match(page, /<SourceLinkCard url=\{sourceUrl\} \/>/, 'and is drawn as its card on the details');
  assert.match(page, /jobFiles=\{files\}\s*sourceUrl=\{sourceUrl\}/, 'the offer panel gets the pictures and the link');
  assert.match(page, /localMaterial\(current\.material, L, materials\)/, 'R8: the material in the reader words');
  assert.match(page, /localColour\(current\.color, L\)/, 'R8: the colour in the reader words');
});

// ------------------------------------------------------------ the offer panel

test('offer panel: what the workshop prices — the pictures as thumbnails and the link as its card — above the offer', () => {
  const words = { ar: 'ما ستسعّره', en: 'What you are pricing', ckb: 'ئەوەی نرخی بۆ دادەنێیت' } as const;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const h = html(
      createElement(MerchantOfferSection, {
        requestId: 'req_1', offers: [], draft: null, canOffer: true, takingOffers: true, materials: [], onChanged: () => undefined,
        jobFiles: files, sourceUrl: LINK,
      }),
      lang
    );
    assert.match(h, /data-offer-job/);
    assert.deepEqual(srcs(h), [`${ROUTE}/crf_pic1?w=160`, `${ROUTE}/crf_pic2?w=160`], `${lang}: thumbnails, the model is not a picture`);
    assert.match(h, /data-request-link/);
    assert.match(h, new RegExp(`href="${LINK.replace(/[/.]/g, '\\$&')}"`), 'the card opens the model page');
    assert.match(text(h), /makerworld\.com/, 'a bare card names the host');
    assert.ok(text(h).includes(words[lang]), `${lang}: ${words[lang]}`);
    assert.doesNotMatch(text(h), /crf_/, `${lang}: no id on the screen`);
  }
  // Nothing to show, nothing drawn.
  const none = html(createElement(MerchantOfferSection, { requestId: 'req_1', offers: [], draft: null, canOffer: true, takingOffers: true, materials: [], onChanged: () => undefined }));
  assert.doesNotMatch(none, /data-offer-job/);
});

test('R1: a link with no stored card is still drawn — the host as its title; a non-web address is not a card', () => {
  assert.deepEqual(bareLinkCard('https://www.printables.com/model/1'), {
    url: 'https://www.printables.com/model/1', host: 'printables.com', title: '', description: '', image_url: null, kind: 'unknown',
  });
  assert.equal(bareLinkCard('javascript:alert(1)'), null);
  assert.equal(bareLinkCard('not a url'), null);
});

// ------------------------------------------------------------ the board

test('the board: the thumbnail is a sized copy through the route, the link its card outside the row button', () => {
  const board = code('src/components/merchant/workshop/RequestBoard.tsx');
  assert.match(board, /<RequestThumb url=\{r\.thumb_url\} size=\{64\}/);
  assert.doesNotMatch(board, /<VariantImg sizes="64px" src=\{r\.thumb_url\}/, 'no full original for a 64 px box');
  assert.match(board, /<\/button>\s*\{r\.source_url && <SourceLinkCard url=\{r\.source_url\} className="mt-1\.5" \/>\}\s*<\/li>/);
  const route = code('worker/routes/merchantWorkshop.ts');
  assert.match(route, /p\.source_url,/);
  assert.match(route, /source_url: typeof r\.source_url === 'string' && r\.source_url \? r\.source_url : null,/);
});

// ------------------------------------------------------------ R8: the mirrors

test('R8: the English mirrors read in the reader language — Sorani its own, free text as written', () => {
  assert.equal(localMaterial('Standard Resin', 'ar'), 'ريزن قياسي');
  assert.equal(localMaterial('Standard Resin', 'ckb'), 'ڕێزنی ستاندارد');
  assert.equal(localMaterial('Standard Resin', 'en'), 'Standard Resin');
  assert.equal(localMaterial('resin-standard', 'ckb'), 'ڕێزنی ستاندارد', 'by id too (a print fact)');
  assert.equal(localMaterial('PLA', 'ckb'), 'PLA', 'a technical name is the same in every language');
  assert.equal(localMaterial('petg', 'ar', [{ id: 'petg', name_en: 'PETG', name_ar: 'بيتج' }]), 'بيتج', 'the live catalogue Arabic first');
  assert.equal(localMaterial('Wood fill', 'ckb'), 'Wood fill', 'an unknown material is shown as written');
  assert.equal(localColour('Black', 'ar'), 'أسود');
  assert.equal(localColour('Black', 'ckb'), 'ڕەش');
  assert.equal(localColour('#1976d2', 'en'), 'Blue');
  assert.equal(localColour('dark teal', 'ckb'), 'dark teal');
  // The stored colour word stays English: it is a priced fact (REVISION_FIELDS `color_name`).
  assert.match(code('src/components/community/requests/RequestWizard.tsx'), /color_hex: c\.hex, color_name: c\.en/);
  for (const f of ['src/components/community/hub/RequestCard.tsx', 'src/components/chat/cards/DealCards.tsx', 'src/components/print/MyRequestsList.tsx']) {
    assert.match(code(f), /localMaterial\(/, `${f} renders the material through the table`);
  }
});
