/**
 * Upload validation, tested as forgery.
 *
 * Two separate rules are under test and they fail in opposite directions:
 *
 *   classifyAttachment  must not accept a file that is lying about what it
 *                       is — a renamed executable, a ZIP calling itself a
 *                       model, a text file calling itself an STL.
 *
 *   ownedMediaKey       must not accept a reference to something that is not
 *                       this merchant's — an absolute URL, a data: URI, a
 *                       traversal, another merchant's object.
 *
 * Both are pure functions on purpose, so the rule can be attacked here
 * exhaustively rather than only through a route that needs a bucket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAttachment,
  maxBytesFor,
  safeFileName,
  IMAGE_MAX_BYTES,
  MODEL_MAX_BYTES,
} from '../worker/lib/attachments';
import { ownedMediaKey, ownedMediaUrl, ownedMediaUrls } from '../worker/lib/mediaRefs';

// ------------------------------------------------------------- fixtures

const bytes = (...head: number[]): Uint8Array => {
  const b = new Uint8Array(64);
  b.set(head, 0);
  return b;
};

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04);

function webp(): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  return b;
}

/** A structurally valid binary STL with `n` triangles. */
function binaryStl(n: number): Uint8Array {
  const b = new Uint8Array(84 + n * 50);
  new DataView(b.buffer).setUint32(80, n, true);
  return b;
}

const text = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------- pictures

test('pictures are recognised from their bytes, not their name', () => {
  for (const [buf, ext] of [[JPEG, 'jpg'], [PNG, 'png'], [GIF, 'gif'], [webp(), 'webp']] as const) {
    // Named as a model, and still identified as the picture it is.
    const got = classifyAttachment(buf, 'totally-a-model.stl');
    assert.equal(got?.ext, ext);
    assert.equal(got?.kind, 'reference');
    assert.equal(got?.inline, true);
  }
});

test('a picture is the only thing served inline', () => {
  assert.equal(classifyAttachment(PDF, 'drawing.pdf')?.inline, false);
  assert.equal(classifyAttachment(binaryStl(2), 'part.stl')?.inline, false);
  assert.equal(classifyAttachment(ZIP, 'part.3mf')?.inline, false);
});

// ------------------------------------------------------------- forgeries

test('an executable renamed to .stl is refused', () => {
  // MZ header, the classic. It satisfies no magic check and, critically, its
  // length does not satisfy the binary-STL triangle identity.
  const exe = bytes(0x4d, 0x5a, 0x90, 0x00);
  assert.equal(classifyAttachment(exe, 'model.stl'), null);
});

test('a binary STL whose header lies about its triangle count is refused', () => {
  const b = binaryStl(3);
  // Same bytes, claim four triangles: 84 + 200 != the file length.
  new DataView(b.buffer).setUint32(80, 4, true);
  assert.equal(classifyAttachment(b, 'part.stl'), null);
});

test('a binary STL header claiming billions of triangles cannot overflow the check', () => {
  const b = new Uint8Array(200);
  new DataView(b.buffer).setUint32(80, 0xffffffff, true);
  assert.equal(classifyAttachment(b, 'part.stl'), null);
});

test('a valid binary STL is accepted', () => {
  const got = classifyAttachment(binaryStl(5), 'bracket.stl');
  assert.equal(got?.ext, 'stl');
  assert.equal(got?.kind, 'model');
});

test('a ZIP is only a 3MF when the name agrees — a .docx is not a model', () => {
  assert.equal(classifyAttachment(ZIP, 'part.3mf')?.ext, '3mf');
  assert.equal(classifyAttachment(ZIP, 'contract.docx'), null);
  assert.equal(classifyAttachment(ZIP, 'payload.jar'), null);
});

test('ASCII STL and OBJ are accepted only when the text says what the name says', () => {
  assert.equal(classifyAttachment(text('solid part\nfacet normal 0 0 1\n'), 'part.stl')?.ext, 'stl');
  assert.equal(classifyAttachment(text('v 0 0 0\nv 1 0 0\n'), 'mesh.obj')?.ext, 'obj');

  // Text that is not the format it claims.
  assert.equal(classifyAttachment(text('hello world'), 'part.stl'), null);
  assert.equal(classifyAttachment(text('<script>alert(1)</script>'), 'mesh.obj'), null);
  // The right content under the wrong extension is still refused — the two
  // must agree, because the extension is what picks the branch.
  assert.equal(classifyAttachment(text('solid part\n'), 'part.obj'), null);
});

test('an OBJ comment does not decide the format', () => {
  // A leading `#` line is ordinary in OBJ; the first MEANINGFUL line decides.
  assert.equal(classifyAttachment(text('# exported by something\nv 0 0 0\n'), 'm.obj')?.ext, 'obj');
  assert.equal(classifyAttachment(text('# v 0 0 0\nnot an obj\n'), 'm.obj'), null);
});

test('an unnamed file is never guessed into a model', () => {
  assert.equal(classifyAttachment(text('solid part\n'), ''), null);
  // A binary STL is the exception, because its own structure proves it.
  assert.equal(classifyAttachment(binaryStl(2), '')?.ext, 'stl');
});

test('empty and truncated input are refused rather than crashing', () => {
  assert.equal(classifyAttachment(new Uint8Array(0), 'x.stl'), null);
  assert.equal(classifyAttachment(new Uint8Array([0xff, 0xd8]), 'x.jpg'), null);
});

// ----------------------------------------------------------------- sizes

test('a model may be larger than a picture, and each has its own ceiling', () => {
  assert.equal(maxBytesFor('reference'), IMAGE_MAX_BYTES);
  assert.equal(maxBytesFor('model'), MODEL_MAX_BYTES);
  assert.equal(maxBytesFor('document'), MODEL_MAX_BYTES);
  assert.ok(MODEL_MAX_BYTES > IMAGE_MAX_BYTES);
});

// ------------------------------------------------------------- filenames

test('a filename cannot inject a header, a path or a quote', () => {
  assert.equal(safeFileName('a\r\nX-Evil: 1.stl', 'stl'), 'aX-Evil: 1.stl');
  assert.equal(safeFileName('../../etc/passwd', 'stl'), '.._.._etc_passwd');
  assert.equal(safeFileName('he said "hi".png', 'png'), 'he said hi.png');
  assert.equal(safeFileName('', 'stl'), 'attachment.stl');
  assert.equal(safeFileName(null, 'png'), 'attachment.png');
  assert.equal(safeFileName('x'.repeat(400), 'png').length, 120);
});

// -------------------------------------------------------- media ownership

test('only this merchant\'s own uploads are accepted as image references', () => {
  assert.equal(ownedMediaKey('community/u1/abc123.jpg', 'u1'), 'community/u1/abc123.jpg');
  assert.equal(ownedMediaKey('/files/community/u1/abc123.jpg', 'u1'), 'community/u1/abc123.jpg');
  assert.equal(ownedMediaKey('merchants/u1/public/abc123.webp', 'u1'), 'merchants/u1/public/abc123.webp');
  assert.equal(ownedMediaKey('/files/merchants/u1/public/abc123.webp', 'u1'), 'merchants/u1/public/abc123.webp');
  // Another merchant's object.
  assert.equal(ownedMediaKey('community/u2/abc123.jpg', 'u1'), null);
  assert.equal(ownedMediaKey('merchants/u2/public/abc123.webp', 'u1'), null);
  // A prefix that is not merchant media at all.
  assert.equal(ownedMediaKey('receipts/u1/abc123.jpg', 'u1'), null);
  assert.equal(ownedMediaKey('products/abc123.jpg', 'u1'), null);
});

test('an off-platform URL is never accepted — that is the tracking pixel', () => {
  for (const hostile of [
    'https://evil.example/pixel.gif',
    'http://evil.example/pixel.gif',
    '//evil.example/pixel.gif',
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'HTTPS://evil.example/x.png',
  ]) {
    assert.equal(ownedMediaKey(hostile, 'u1'), null, hostile);
  }
});

test('traversal and separator tricks are refused', () => {
  for (const hostile of [
    'community/u1/../u2/a.jpg',
    'community/u1/..%2Fu2.jpg',
    'community\\u1\\a.jpg',
    '/files/community/u1/sub/dir/a.jpg',
    'community/u1/a.jpg/../../u2/b.jpg',
  ]) {
    assert.equal(ownedMediaKey(hostile, 'u1'), null, hostile);
  }
});

test('the object name must look like something the platform issued', () => {
  assert.equal(ownedMediaKey('community/u1/a.jpg', 'u1'), null);              // too short
  assert.equal(ownedMediaKey('community/u1/abcd.svg', 'u1'), null);           // SVG is script
  assert.equal(ownedMediaKey('community/u1/abcd.jpg.html', 'u1'), null);
  assert.equal(ownedMediaKey('community/u1/ab cd.jpg', 'u1'), null);
  assert.equal(ownedMediaKey('community/u1/abcd.png', 'u1'), 'community/u1/abcd.png');
});

test('non-strings and oversized strings are refused without throwing', () => {
  for (const junk of [null, undefined, 42, {}, [], true, 'x'.repeat(300)]) {
    assert.equal(ownedMediaKey(junk, 'u1'), null);
  }
});

test('the URL form is what the frontend renders', () => {
  assert.equal(ownedMediaUrl('community/u1/abcd.jpg', 'u1'), '/files/community/u1/abcd.jpg');
  assert.equal(ownedMediaUrl('https://evil.example/x.jpg', 'u1'), null);
});

test('a product gallery keeps what is owned, drops what is not, and de-duplicates', () => {
  const got = ownedMediaUrls(
    [
      'community/u1/aaaa.jpg',
      'https://evil.example/pixel.gif',
      '/files/community/u1/aaaa.jpg',   // the same object in the other form
      'community/u2/bbbb.jpg',
      'community/u1/cccc.png',
    ],
    'u1'
  );
  // Filtered, not refused: a merchant fixing a price is not blocked because
  // one old reference no longer resolves.
  assert.deepEqual(got, ['/files/community/u1/aaaa.jpg', '/files/community/u1/cccc.png']);
});

test('a gallery is capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => `community/u1/img${String(i).padStart(4, '0')}.jpg`);
  assert.equal(ownedMediaUrls(many, 'u1', 8).length, 8);
  assert.deepEqual(ownedMediaUrls('not an array', 'u1'), []);
});
