/**
 * THE REVIEW MEDIA PICKER'S RULES (docs/REVIEWS_GIFTS.md §5, §8 C1), driven
 * as pure functions — the same functions ReviewMediaPicker and ReviewSheet
 * call, with no DOM in between.
 *
 * What is pinned, from the owner's brief §1 and §9:
 *  - 10 photos and 2 videos per review; the 11th photo and the 3rd video are
 *    REFUSED and REPORTED, never sliced off silently;
 *  - type and size are checked before a byte travels, with the door's own
 *    codes (HEIC by name, so an iPhone owner knows what to do);
 *  - the same file picked twice is caught;
 *  - replace keeps the tile's place and never costs room;
 *  - «نشر» stays closed while any upload is unfinished or failed, or while
 *    the text rule fails — and says why;
 *  - the body sent is every stored key, in gallery order.
 *
 * Run: node --import tsx --test tests/reviewMediaPickerLogic.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReviewText, REVIEW_LIMITS } from '../packages/catalog/src/reviewRules';
import {
  MEDIA_LIMITS,
  PHOTO_ACCEPT,
  VIDEO_ACCEPT,
  classifyReviewFile,
  fingerprintOf,
  keyOfStoredMedia,
  mediaCounts,
  mediaPayload,
  planPick,
  slotsFromStored,
  storedKeysComplete,
  submitBlock,
  textCode,
  type MediaSlot,
  type PickedFile,
} from '../src/components/reviews/reviewUpload';

const MB = 1024 * 1024;
const jpg = (i: number, size = 2 * MB): PickedFile => ({ name: `photo-${i}.jpg`, type: 'image/jpeg', size, lastModified: 1000 + i });
const mp4 = (i: number, size = 12 * MB): PickedFile => ({ name: `clip-${i}.mp4`, type: 'video/mp4', size, lastModified: 5000 + i });

let n = 0;
function slot(kind: 'image' | 'video', status: MediaSlot['status'] = 'done', extra: Partial<MediaSlot> = {}): MediaSlot {
  n += 1;
  return {
    id: `s${n}`,
    kind,
    status,
    progress: status === 'done' ? 1 : 0,
    previewUrl: `blob:local/${n}`,
    key: status === 'done' ? `reviews/u1/${kind === 'video' ? 'video' : 'photos'}/k${n}.${kind === 'video' ? 'mp4' : 'webp'}` : null,
    error: null,
    name: `f${n}`,
    fingerprint: `f${n}|1|0`,
    ...extra,
  };
}
const many = (count: number, kind: 'image' | 'video', status: MediaSlot['status'] = 'done') =>
  Array.from({ length: count }, () => slot(kind, status));

const GOOD_TEXT = 'The first layer came out clean and the bed stayed level for a whole week.';

// ------------------------------------------------------------ the numbers

test('the limits are the server’s own numbers, not a second copy', () => {
  assert.equal(MEDIA_LIMITS.maxImages, 10);
  assert.equal(MEDIA_LIMITS.maxVideos, 2);
  assert.equal(MEDIA_LIMITS.maxImages, REVIEW_LIMITS.maxImages);
  assert.equal(MEDIA_LIMITS.maxVideos, REVIEW_LIMITS.maxVideos);
  assert.equal(MEDIA_LIMITS.imageMaxBytes, 8 * MB);
  assert.equal(MEDIA_LIMITS.videoMaxBytes, 40 * MB);
  // What the inputs offer is what the door accepts (§5), HEIC never offered.
  assert.equal(PHOTO_ACCEPT, 'image/jpeg,image/png,image/webp,image/gif,image/avif');
  assert.equal(VIDEO_ACCEPT, 'video/mp4,video/quicktime,video/webm');
  assert.ok(!/heic|heif/i.test(PHOTO_ACCEPT));
});

// ------------------------------------------------------------- 10 and 2

test('10 photos are accepted; the 11th is refused and reported, never sliced silently', () => {
  const plan = planPick([], Array.from({ length: 11 }, (_, i) => jpg(i)));
  assert.equal(plan.accepted.length, 10);
  assert.equal(plan.skippedImages, 1);
  assert.deepEqual(plan.accepted.map((a) => a.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'taken in the order picked');

  // A review that already holds 10: one more photo is refused, a video still fits.
  const full = many(10, 'image');
  const more = planPick(full, [jpg(50), mp4(1)]);
  assert.equal(more.skippedImages, 1);
  assert.deepEqual(more.accepted.map((a) => a.kind), ['video']);
});

test('2 videos are accepted; a 3rd is refused and reported', () => {
  const plan = planPick([], [mp4(1), mp4(2), mp4(3)]);
  assert.equal(plan.accepted.length, 2);
  assert.equal(plan.skippedVideos, 1);
  const again = planPick(many(2, 'video'), [mp4(9)]);
  assert.equal(again.accepted.length, 0);
  assert.equal(again.skippedVideos, 1);
});

test('photos only, video only, both, or nothing are all fine', () => {
  assert.equal(planPick([], [jpg(1)]).accepted.length, 1);
  assert.equal(planPick([], [mp4(1)]).accepted.length, 1);
  const both = planPick([], [...Array.from({ length: 10 }, (_, i) => jpg(i)), mp4(1), mp4(2)]);
  assert.equal(both.accepted.length, 12);
  assert.equal(both.skippedImages + both.skippedVideos, 0);
  assert.deepEqual(mediaCounts([]), { images: 0, videos: 0 });
  assert.equal(submitBlock({ stars: 4, text: checkReviewText(GOOD_TEXT), slots: [] }), null, 'no media is a complete review');
});

// ------------------------------------------------------------ type and size

test('the type is checked before a byte travels: HEIC by name, anything else as unsupported', () => {
  assert.deepEqual(classifyReviewFile({ name: 'IMG_0042.HEIC', type: 'image/heic', size: MB }), { ok: false, code: 'IMAGE_HEIC_UNSUPPORTED' });
  assert.deepEqual(classifyReviewFile({ name: 'IMG_0042.heif', type: '', size: MB }), { ok: false, code: 'IMAGE_HEIC_UNSUPPORTED' });
  assert.deepEqual(classifyReviewFile({ name: 'notes.pdf', type: 'application/pdf', size: MB }), { ok: false, code: 'REVIEW_UPLOAD_UNSUPPORTED' });
  assert.deepEqual(classifyReviewFile({ name: 'clip.avi', type: 'video/x-msvideo', size: MB }), { ok: false, code: 'REVIEW_UPLOAD_UNSUPPORTED' });
  assert.deepEqual(classifyReviewFile({ name: 'empty.jpg', type: 'image/jpeg', size: 0 }), { ok: false, code: 'REVIEW_UPLOAD_UNSUPPORTED' });
  // A blank or generic browser type falls back to the extension (Android pickers).
  assert.deepEqual(classifyReviewFile({ name: 'clip.MOV', type: '', size: MB }), { ok: true, kind: 'video', convertible: false });
  assert.deepEqual(classifyReviewFile({ name: 'p.jpeg', type: 'application/octet-stream', size: MB }), { ok: true, kind: 'image', convertible: true });
  assert.deepEqual(classifyReviewFile({ name: 'p.webp', type: 'image/webp', size: MB }), { ok: true, kind: 'image', convertible: false });
  assert.deepEqual(classifyReviewFile({ name: 'c.webm', type: 'video/webm', size: MB }), { ok: true, kind: 'video', convertible: false });
  assert.deepEqual(classifyReviewFile({ name: 'c.mov', type: 'video/quicktime', size: MB }), { ok: true, kind: 'video', convertible: false });
  // The NAME alone never makes a document a photo: the server sniffs the bytes, and a declared type that is not media is refused here.
  assert.deepEqual(classifyReviewFile({ name: 'fake.jpg', type: 'text/plain', size: MB }), { ok: false, code: 'REVIEW_UPLOAD_UNSUPPORTED' });
});

test('the size is checked against what will travel', () => {
  // Video: the door's 40 MB.
  assert.deepEqual(classifyReviewFile(mp4(1, 40 * MB)), { ok: true, kind: 'video', convertible: false });
  assert.deepEqual(classifyReviewFile(mp4(1, 40 * MB + 1)), { ok: false, code: 'REVIEW_UPLOAD_TOO_LARGE' });
  // A photo that is NOT shrunk on the device travels as picked: 8 MB.
  assert.deepEqual(classifyReviewFile({ name: 'a.gif', type: 'image/gif', size: 8 * MB + 1 }), { ok: false, code: 'REVIEW_UPLOAD_TOO_LARGE' });
  // A JPEG/PNG is shrunk to WebP first, so a 12 MB camera photo is not refused before it is converted.
  assert.deepEqual(classifyReviewFile(jpg(1, 12 * MB)), { ok: true, kind: 'image', convertible: true });
  assert.deepEqual(classifyReviewFile(jpg(1, 64 * MB + 1)), { ok: false, code: 'REVIEW_UPLOAD_TOO_LARGE' });
  const plan = planPick([], [jpg(1), mp4(2, 41 * MB), { name: 'x.heic', type: 'image/heic', size: MB }]);
  assert.equal(plan.accepted.length, 1);
  assert.deepEqual(
    plan.refused.map((r) => [r.name, r.code]),
    [
      ['clip-2.mp4', 'REVIEW_UPLOAD_TOO_LARGE'],
      ['x.heic', 'IMAGE_HEIC_UNSUPPORTED'],
    ]
  );
});

// ------------------------------------------------------------ duplicates

test('the same file picked twice is caught on the device (the server’s SHA-256 is the real gate)', () => {
  const first = planPick([], [jpg(1), jpg(1)]);
  assert.equal(first.accepted.length, 1);
  assert.deepEqual(first.refused.map((r) => r.code), ['REVIEW_MEDIA_DUPLICATE']);
  const existing = [slot('image', 'done', { fingerprint: fingerprintOf(jpg(7)) })];
  const again = planPick(existing, [jpg(7), jpg(8)]);
  assert.deepEqual(again.refused.map((r) => r.code), ['REVIEW_MEDIA_DUPLICATE']);
  assert.equal(again.accepted.length, 1);
});

// --------------------------------------------------------------- replace

test('replace keeps the tile’s place and never costs room, even at 10/10', () => {
  const full = many(10, 'image');
  const target = full[4];
  const plan = planPick(full, [jpg(99)], target.id);
  assert.equal(plan.accepted.length, 1, 'a full review can still swap a photo');
  assert.equal(plan.skippedImages, 0);
  // Replacing a photo by a video needs video room, not photo room.
  const withVideos = [...many(9, 'image'), ...many(2, 'video')];
  const swap = planPick(withVideos, [mp4(42)], withVideos[0].id);
  assert.equal(swap.accepted.length, 0);
  assert.equal(swap.skippedVideos, 1);
});

// ------------------------------------------------------- the blocked submit

test('«نشر» is closed while an upload is queued, preparing or running, and says how many', () => {
  const text = checkReviewText(GOOD_TEXT);
  for (const status of ['queued', 'preparing', 'uploading'] as const) {
    const slots = [slot('image'), slot('image', status), slot('video', status)];
    assert.deepEqual(submitBlock({ stars: 5, text, slots }), { reason: 'uploading', count: 2 }, status);
  }
  assert.equal(submitBlock({ stars: 5, text, slots: [slot('image'), slot('video')] }), null);
});

test('«نشر» is closed while an upload has failed, until it is retried or removed', () => {
  const text = checkReviewText(GOOD_TEXT);
  const slots = [slot('image'), slot('image', 'failed', { error: 'REVIEW_UPLOAD_TOO_LARGE' }), slot('image', 'uploading')];
  // A failure is named before a running upload: it needs the customer, the other does not.
  assert.deepEqual(submitBlock({ stars: 5, text, slots }), { reason: 'failed', count: 1 });
});

test('«نشر» is closed without stars and while the text rule fails — the server’s own rule', () => {
  const slots = [slot('image')];
  assert.deepEqual(submitBlock({ stars: 0, text: checkReviewText(GOOD_TEXT), slots }), { reason: 'stars' });
  assert.deepEqual(submitBlock({ stars: 6, text: checkReviewText(GOOD_TEXT), slots }), { reason: 'stars' });
  assert.deepEqual(submitBlock({ stars: 3, text: checkReviewText('Good printer.'), slots }), { reason: 'text', code: 'REVIEW_TEXT_TOO_SHORT' });
  assert.deepEqual(submitBlock({ stars: 3, text: checkReviewText(' '.repeat(40)), slots }), { reason: 'text', code: 'REVIEW_TEXT_TOO_SHORT' });
  assert.deepEqual(submitBlock({ stars: 3, text: checkReviewText('جيد جيد جيد جيد جيد جيد جيد جيد جيد'), slots }), { reason: 'text', code: 'REVIEW_TEXT_REPETITIVE' });
  assert.equal(textCode(checkReviewText(GOOD_TEXT)), null);
  assert.equal(textCode(checkReviewText('x'.repeat(4001))), 'REVIEW_TEXT_TOO_LONG');
  // 1-star reviews are as publishable as 5-star ones: stars are never a gate.
  assert.equal(submitBlock({ stars: 1, text: checkReviewText(GOOD_TEXT), slots }), null);
});

test('more than the limit already on a review (a server kind correction) blocks with its own reason', () => {
  const slots = [...many(10, 'image'), ...many(3, 'video')];
  assert.deepEqual(submitBlock({ stars: 5, text: checkReviewText(GOOD_TEXT), slots }), { reason: 'limit' });
});

// ------------------------------------------------------------ what is sent

test('the body sends every stored key, in gallery order, and nothing still on its way', () => {
  const a = slot('image');
  const b = slot('video');
  const c = slot('image', 'uploading');
  const d = slot('image');
  assert.deepEqual(mediaPayload([a, b, c, d]), [{ key: a.key }, { key: b.key }, { key: d.key }]);
  assert.deepEqual(mediaPayload([]), [], 'an empty list clears the media on an edit (PUT)');
});

test('an edited review’s stored media become tiles that are never re-uploaded', () => {
  const stored = slotsFromStored([
    { url: '/api/reviews/media/reviews/u1/photos/abc.webp', kind: 'image', key: 'reviews/u1/photos/abc.webp' },
    { url: '/api/reviews/media/reviews/u1/video/def.mp4', kind: 'video' },
  ]);
  assert.deepEqual(stored.map((x) => [x.status, x.existing, x.kind, x.key]), [
    ['done', true, 'image', 'reviews/u1/photos/abc.webp'],
    // An older answer without `key`: the door's URL names it.
    ['done', true, 'video', 'reviews/u1/video/def.mp4'],
  ]);
  assert.ok(storedKeysComplete(stored));
  assert.deepEqual(mediaPayload(stored).map((m) => m.key), ['reviews/u1/photos/abc.webp', 'reviews/u1/video/def.mp4']);
  // A URL that is not the review door names no key — the edit then keeps the media as stored.
  const odd = slotsFromStored([{ url: 'https://cdn.example/x.jpg', kind: 'image' }]);
  assert.equal(keyOfStoredMedia({ url: 'https://cdn.example/x.jpg' }), null);
  assert.equal(storedKeysComplete(odd), false);
});
