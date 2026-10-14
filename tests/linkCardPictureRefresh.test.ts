/**
 * A LINK CARD'S PICTURE IS REWRITTEN IN PLACE, AND SO ARE ITS SMALL COPIES
 * (found by the security verification of DECISIONS row 226).
 *
 * worker/lib/linkCards.ts re-reads a card after 24 h and KEEPS the row id, so
 * the refreshed og:image is written over the same public key
 * `link-cards/<card id>.webp`. `isRewritableMediaKey` lists `link-cards/`, so
 * the route checks a stored copy against the original's ETag before serving
 * it, and the sweep records and compares that ETag too: after the linked page
 * changes its picture, `?w=` answers a copy of the NEW one — never the old
 * picture, from R2, `immutable`, for good.
 *
 * LOCAL ONLY: in-memory R2 and IMAGES doubles, a stub fetcher, no network.
 * Run: node --import tsx --test tests/linkCardPictureRefresh.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, ctx, freshDb, pending, stubApp } from './fixtures/app';
import { R2Double, dimsOf, imagesDouble, webpBytes } from './fixtures/imageDoubles';
import { fileRoutes } from '../worker/routes/uploads';
import { resolveLinkCard, type LinkEnv } from '../worker/lib/linkCards';
import { sweepImageVariants } from '../worker/lib/imageVariants';

const MODEL_URL = 'https://www.printables.com/model/12345-articulated-dragon';
const IMAGE_URL = 'https://www.printables.com/images/dragon.webp';
const PAGE = `<!doctype html><html><head><meta property="og:title" content="Dragon"><meta property="og:image" content="/images/dragon.webp"></head><body></body></html>`;
const T0 = new Date('2026-10-01T10:00:00.000Z');
const at = (ms: number) => () => new Date(T0.getTime() + ms);
const HOUR = 60 * 60 * 1000;
const AVIF = { Accept: 'image/avif,image/webp,*/*' };

function network(state: { picture: Uint8Array }) {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === MODEL_URL) return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url === IMAGE_URL) return new Response(state.picture as unknown as BodyInit, { headers: { 'content-type': 'image/webp' } });
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

test('a refreshed link card answers ?w= with a copy of its NEW picture, and its pictures revalidate', async () => {
  const raw = freshDb();
  const bucket = new R2Double();
  const images = imagesDouble();
  const env = { DB: asD1(raw), BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket, IMAGES: images.binding };
  const app = stubApp(asD1(raw), null, (a) => a.route('/files', fileRoutes), { env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket, IMAGES: images.binding } });
  const fetchIt = async (path: string, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { headers }, undefined, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };

  // Day 0: the page's picture is a 1200 × 630 banner.
  const state = { picture: webpBytes(1200, 630, { pad: 300 }) };
  const card = await resolveLinkCard(env as unknown as LinkEnv, MODEL_URL, { fetcher: network(state), now: at(0) });
  assert.equal(card.status, 'ok');
  const key = `link-cards/${card.id}.webp`;
  assert.equal(card.image_url, `/files/${key}`);
  const first = await fetchIt(`/files/${key}?w=640`, AVIF);
  assert.equal(first.status, 200);
  assert.deepEqual(dimsOf(new Uint8Array(await first.arrayBuffer())), { format: 'image/avif', width: 640, height: 336 });
  assert.ok(bucket.objects.has(`variants/v1/${key}/w640.avif`), 'the copy of picture A is now stored in R2');

  // Day 2: the page changed its picture (a square photo). The card is refreshed in place.
  state.picture = webpBytes(800, 800, { pad: 500 });
  const refreshed = await resolveLinkCard(env as unknown as LinkEnv, MODEL_URL, { fetcher: network(state), now: at(25 * HOUR) });
  assert.equal(refreshed.id, card.id, 'same row id');
  assert.equal(refreshed.image_url, `/files/${key}`, 'same public key, overwritten');
  const plain = await fetchIt(`/files/${key}`);
  assert.deepEqual(dimsOf(new Uint8Array(await plain.arrayBuffer())), { format: 'image/webp', width: 800, height: 800 }, 'the original is the NEW picture');
  const currentEtag = bucket.objects.get(key)!.etag;

  // The quarter-hour sweep does not repair it either.
  await sweepImageVariants(env as never, { now: () => T0.getTime() + 26 * HOUR });

  // Another data centre (empty edge) asks for the copy the card's <img srcset> names.
  const copy = await fetchIt(`/files/${key}?w=640`, AVIF);
  const evidence = {
    source: copy.headers.get('X-Variant-Source'),
    cacheControl: copy.headers.get('Cache-Control'),
    etag: copy.headers.get('etag'),
    originalEtag: currentEtag,
    dims: dimsOf(new Uint8Array(await copy.arrayBuffer())),
  };
  assert.deepEqual(evidence.dims, { format: 'image/avif', width: 640, height: 640 }, `?w=640 must be a copy of the CURRENT picture; got ${JSON.stringify(evidence)}`);
  assert.equal(evidence.etag, `"${currentEtag}-w640-avif"`, 'the copy must derive from the current original');
  // Rewritten in place, so neither the picture nor its copies promise `immutable`.
  assert.equal(plain.headers.get('Cache-Control'), 'public, max-age=300, must-revalidate');
  assert.equal(evidence.cacheControl, 'public, max-age=300, must-revalidate');
  // The stored copy was replaced, not left beside the new one.
  assert.equal(bucket.objects.get(`variants/v1/${key}/w640.avif`)!.custom!.src_etag, currentEtag);
});
