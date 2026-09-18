import { IMAGES_MAX_INPUT_BYTES, convertToWebp, extensionFor, isConvertibleToWebp } from '../lib/imageConvert';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, forbidden, notFound, oneOf, str, unavailable } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { rasterDimensions, validRasterDimensions } from '../lib/imageMetadata';
import {
  buildMediaKey,
  getMediaObject,
  isAnonymousPublicMediaKey,
  isSafeMediaKey,
  putMediaObject,
  type MediaDomain,
  type MediaVisibility,
} from '../lib/mediaStorage';

/**
 * Uploads go to R2 under purpose-scoped, owner-scoped keys. Content type is
 * sniffed from magic bytes — the client-declared MIME type is never trusted.
 *
 * New writes use the central taxonomy and logical public/private bindings.
 * Legacy keys remain readable while the migration inventory is verified.
 */

const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 40 * 1024 * 1024;

const MAGIC: Array<{ ext: string; mime: string; match: (b: Uint8Array) => boolean }> = [
  { ext: 'jpg', mime: 'image/jpeg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'gif', mime: 'image/gif', match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    ext: 'webp', mime: 'image/webp',
    match: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  /**
   * AVIF, before mp4 — both are ISO-BMFF and both carry `ftyp` at offset 4, so
   * the BRAND at 8..11 is what separates them. Modern vendor CDNs (Shopify and
   * Cloudflare Images among them) serve AVIF by default, so leaving it out
   * meant a perfectly good direct image URL from bambulab or creality was
   * refused as "not an image file".
   */
  {
    ext: 'avif', mime: 'image/avif',
    match: (b) =>
      b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
      b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && (b[11] === 0x66 || b[11] === 0x73),
  },
  {
    ext: 'mp4', mime: 'video/mp4',
    match: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  },
];

export function sniff(buf: Uint8Array): { ext: string; mime: string } | null {
  for (const m of MAGIC) {
    if (buf.length >= 12 && m.match(buf)) return { ext: m.ext, mime: m.mime };
  }
  return null;
}

export const uploadRoutes = new Hono<AppContext>();
uploadRoutes.use('*', requireAuth);

uploadRoutes.post('/', async (c) => {
  await rateLimit(c, 'upload', 60, 3600);
  const user = c.get('user')!;

  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const purpose = oneOf(form.get('purpose'), 'purpose', ['receipt', 'avatar', 'chat', 'product', 'community'] as const);
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');

  if (purpose === 'product' && user.role !== 'admin') {
    throw forbidden('Only administrators can upload product media');
  }

  /**
   * A CONVERSATION CARRIES VIDEO TOO.
   *
   * `purpose === 'product'` was the whole rule, so a customer trying to send a
   * short clip of a failed print — the single most useful thing they can send
   * a support agent — got «Videos are not allowed here». The owner named both
   * when they asked for the per-conversation layout: «الصور أو الفيديوهات التي
   * يرسلها داخل المحادثة».
   *
   * The 40 MB ceiling is the same one a product video has, and the image
   * ceiling below still applies to images regardless — a video allowance must
   * not become an 8 MB photo allowance of 40.
   */
  const allowVideo = purpose === 'product' || purpose === 'chat';
  const maxSize = allowVideo ? VIDEO_MAX : IMAGE_MAX;
  if (file.size > maxSize) {
    throw badRequest(`File is too large (max ${Math.round(maxSize / 1024 / 1024)} MB)`);
  }

  let buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind) throw badRequest('Unsupported file type — please upload a JPEG, PNG, WebP or GIF image' + (allowVideo ? ' or MP4 video' : ''));
  if (kind.mime.startsWith('video/') && !allowVideo) {
    throw badRequest('Videos are not allowed here');
  }
  if (kind.mime.startsWith('image/') && file.size > IMAGE_MAX) {
    throw badRequest(`Image is too large (max ${Math.round(IMAGE_MAX / 1024 / 1024)} MB)`);
  }

  /**
   * THE SERVER CONVERTS IT. IT DOES NOT ASK THE BROWSER TO.
   *
   * The previous version of this route REFUSED a PNG or a JPEG and told the
   * uploader to convert it first. That was the right rule in the wrong place:
   * the conversion ran on a canvas in the visitor's browser, and
   * `canvas.toBlob(cb, 'image/webp')` is specified to fall back to PNG on a
   * runtime with no WebP encoder — silently, with a valid Blob. So the format
   * depended on which phone was in the owner's hand, and on the wrong phone the
   * answer was either a refusal they could do nothing about or, before that, a
   * PNG stored under a claim that it had been converted.
   *
   * `env.IMAGES` takes the bytes this Worker is already holding and returns
   * WebP the same way for every device and every browser, including the ones
   * that do not exist yet. Nothing about the visitor decides the format any
   * more.
   *
   * GIF AND AVIF PASS THROUGH, and that is a decision rather than an oversight:
   * a transform keeps ONE frame, so re-encoding an animated GIF throws the
   * animation away — the same quiet damage as the fake conversion, pointing the
   * other way — and AVIF is already compressed, usually smaller than the WebP
   * it would become. Both are stored honestly under their own type.
   */
  let storedMime = kind.mime;
  let storedExt = kind.ext;
  if (isConvertibleToWebp(kind.mime)) {
    const converted = await convertToWebp(c.env, buf, kind.mime);
    if (converted.ok) {
      buf = converted.bytes;
      storedMime = converted.mime;
      storedExt = extensionFor(converted.mime);
    } else if (converted.reason === 'unavailable') {
      /**
       * NO BINDING ON THIS DEPLOYMENT. Storing the original would recreate the
       * exact defect this route was changed to remove — a JPEG in the
       * catalogue that something, somewhere, calls a WebP. Refusing says the
       * true thing, names the operator's fix, and is visible immediately
       * instead of in a database column nobody reads.
       */
      console.error('uploads: the Images binding is absent — server-side WebP conversion cannot run');
      throw unavailable(
        'تحويل الصور غير مفعّل على الخادم حالياً. راجع إعداد Cloudflare Images. / ' +
          'Server-side image conversion is not enabled on this deployment (Cloudflare Images binding missing).',
        'IMAGE_CONVERT_UNAVAILABLE'
      );
    } else if (converted.reason === 'too_large') {
      throw badRequest(
        `الصورة أكبر من أن تُحوَّل (الحد ${Math.round(IMAGES_MAX_INPUT_BYTES / 1024 / 1024)} ميغابايت). / ` +
          `Image is too large to convert (max ${Math.round(IMAGES_MAX_INPUT_BYTES / 1024 / 1024)} MB).`,
        'IMAGE_TOO_LARGE_TO_CONVERT'
      );
    } else if (converted.reason === 'failed') {
      console.error(`uploads: WebP conversion failed: ${converted.detail}`);
      throw badRequest(
        'تعذّر تحويل هذه الصورة. جرّب صورة أخرى. / This image could not be converted. Try another one.',
        'IMAGE_CONVERT_FAILED'
      );
    }
  }

  // Measured on the bytes that will actually be STORED, which after a
  // conversion are a fraction of what arrived.
  const dimensions = storedMime.startsWith('image/') ? rasterDimensions(buf, storedMime) : null;
  if (
    purpose === 'product' &&
    (kind.mime === 'image/webp' || kind.mime === 'image/png' || kind.mime === 'image/jpeg') &&
    !validRasterDimensions(dimensions)
  ) {
    throw badRequest('The image has invalid or unsupported dimensions', 'BAD_IMAGE_DIMENSIONS');
  }

  /**
   * A CHAT FILE BELONGS TO THE CONVERSATION, NOT TO WHOEVER SENT IT.
   *
   * It was filed under the UPLOADER — `chat/<userId>/attachments/…` — so one
   * thread's pictures were scattered across as many folders as it had
   * participants, and opening a conversation in the bucket browser was
   * impossible. The owner chose the other ordering explicitly, for exactly
   * that reason: «الثاني الاسهل في فتح المحادثه».
   *
   * It is also the stronger rule. Under the old layout the delivery route
   * granted the uploader access by prefix and everyone else by a lookup for a
   * MESSAGE carrying the key — so between the upload and the send, the file
   * belonged to nobody but its uploader, and the check had two branches that
   * could disagree. Keyed by chat, access is one question with one answer:
   * are you in this conversation.
   *
   * Participation is verified HERE, before a byte is stored, so the key cannot
   * name a conversation the uploader is not in.
   */
  let chatEntity = '';
  if (purpose === 'chat') {
    chatEntity = str(form.get('entity_id'), 'entity_id', { max: 64 });
    const member = await c.env.DB.prepare(
      'SELECT 1 AS x FROM chat_participants WHERE chat_id = ? AND user_id = ? LIMIT 1'
    )
      .bind(chatEntity, user.id)
      .first();
    if (!member) throw forbidden('Not a participant in this conversation');
  }

  const target: { visibility: MediaVisibility; domain: MediaDomain; entityId: string; keyKind: string } =
    purpose === 'receipt' ? { visibility: 'private', domain: 'receipts', entityId: user.id, keyKind: 'evidence' } :
    purpose === 'avatar' ? { visibility: 'public', domain: 'users', entityId: user.id, keyKind: 'avatar' } :
    purpose === 'chat' ? { visibility: 'private', domain: 'chat', entityId: chatEntity, keyKind: storedMime.startsWith('video/') ? 'video' : 'attachments' } :
    purpose === 'community' ? { visibility: 'public', domain: 'merchants', entityId: user.id, keyKind: 'public' } :
    { visibility: 'public', domain: 'products', entityId: 'catalog', keyKind: storedMime.startsWith('video/') ? 'video' : 'gallery' };
  // `storedMime` / `storedExt`, never the sniffed pair: after a conversion they
  // differ, and a key that says .jpg over WebP bytes is the same class of lie
  // this route was changed to stop telling.
  const key = buildMediaKey({ ...target, kind: target.keyKind, extension: storedExt, objectId: newId() });
  const cacheControl = target.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=300';

  await putMediaObject(
    c.env,
    {
      key,
      visibility: target.visibility,
      domain: target.domain,
      mime: storedMime,
      bytes: buf.byteLength,
      ownerId: user.id,
      entityId: target.entityId,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      originalName: String(form.get('originalName') || file.name),
    },
    buf,
    { httpMetadata: { contentType: storedMime, cacheControl } }
  );

  return c.json({
    success: true,
    key,
    url: `/files/${key}`,
    visibility: target.visibility,
    mime: storedMime,
    bytes: buf.byteLength,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  });
});

/**
 * File delivery with the access policy above. Mounted at /files/* (outside
 * /api) so URLs can be used directly in <img src>.
 */
export const fileRoutes = new Hono<AppContext>();

fileRoutes.get('/*', async (c) => {
  const key = c.req.path.replace(/^\/files\//, '');
  if (!isSafeMediaKey(key)) throw notFound();
  const user = c.get('user');

  const publicPrefix = isAnonymousPublicMediaKey(key);
  if (!publicPrefix) {
    if (!user) throw forbidden('Sign in to access this file');
    if (key.startsWith('receipts/')) {
      const isOwner = key.startsWith(`receipts/${user.id}/`);
      if (!isOwner && user.role !== 'admin') throw forbidden('Not your file');
    } else if (key.startsWith('chat/')) {
      /**
       * ONE QUESTION: ARE YOU IN THIS CONVERSATION.
       *
       * The key now names the chat, so the answer is a single membership
       * lookup. It replaces two branches that could disagree — the uploader
       * was granted access by key prefix, and everyone else by searching for a
       * MESSAGE carrying the key, which meant a file that had been uploaded
       * but not yet sent belonged to nobody else, and a file whose message was
       * deleted belonged to nobody at all while still being served to the one
       * who sent it.
       */
      const chatId = key.split('/')[1] ?? '';
      const row = await c.env.DB.prepare(
        'SELECT 1 AS x FROM chat_participants WHERE chat_id = ? AND user_id = ? LIMIT 1'
      )
        .bind(chatId, user.id)
        .first();
      if (!row && user.role !== 'admin') throw forbidden('Not your file');
    } else {
      throw notFound();
    }
  }

  /**
   * THE EDGE ANSWERS FOR A PUBLIC FILE BEFORE THE ORIGIN IS ASKED.
   *
   * Every cold hit on a storefront image was a Worker invocation plus an R2
   * GET — a twenty-tile home rail is twenty origin reads for every new visitor,
   * every new device, every cleared cache. `wrangler.jsonc` pins
   * `run_worker_first: ["/api/*", "/files/*"]`, so the Worker is guaranteed to
   * execute; the only thing that can make that cheap is participating in the
   * edge cache ourselves.
   *
   * PUBLIC KEYS ONLY, and that restriction is the whole safety argument.
   * `caches.default` is shared across every visitor to the colo, so anything
   * stored in it is readable by anyone who can guess the URL. An anonymous
   * public key is already served to anyone who asks — caching it changes
   * nothing about who can read it. A private key is authorised per request
   * above (receipt ownership, chat participation) and is never written here.
   */
  // `caches.default` is a Workers extension, and it is genuinely ABSENT in
  // some runtimes this handler is exercised in — the route tests run it under
  // Node, where `caches` is not defined at all. Referencing it unguarded threw
  // a ReferenceError before R2 was ever reached, so the cache is treated as an
  // optional capability: when it is missing the handler behaves exactly as it
  // did before, just without the edge hit.
  //
  // (The type assertion is separate: the worker tsconfig knows `default`, the
  // test tsconfig compiles these files against the DOM's `CacheStorage`, which
  // does not.)
  const cache =
    typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default ?? null : null;
  if (publicPrefix && cache) {
    const hit = await cache.match(c.req.raw);
    if (hit) return hit;
  }

  const obj = await getMediaObject(c.env, publicPrefix ? 'public' : 'private', key);
  if (!obj) throw notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  if (publicPrefix) {
    // Media keys are content-addressed, so a given URL's bytes never change —
    // a new upload is a new key. `immutable` is therefore honest, and it is
    // set HERE rather than relying on stored R2 httpMetadata, which objects
    // written before the media system carry nothing of.
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    headers.set('Cache-Control', 'private, max-age=300');
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");

  // A revalidation should cost a header, not a body. The etag is R2's own.
  if (c.req.header('If-None-Match') === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  const res = new Response(obj.body, { headers });
  if (publicPrefix && cache) {
    // `clone()` before the body is streamed to the client, and `waitUntil` so
    // the write never delays the response. `executionCtx` throws when there is
    // none (again, the Node test harness), and a cache write is never worth
    // failing a response that is otherwise complete.
    try {
      c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()));
    } catch {
      // No execution context: serve the response, skip the cache write.
    }
  }
  return res;
});
