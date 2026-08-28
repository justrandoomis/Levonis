import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, forbidden, notFound, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';

/**
 * Uploads go to R2 under purpose-scoped, owner-scoped keys. Content type is
 * sniffed from magic bytes — the client-declared MIME type is never trusted.
 *
 * Key layout and access policy (enforced in the /files handler below):
 *   products/...            public   (admin-uploaded product media)
 *   avatars/<uid>/...       public
 *   receipts/<uid>/...      private  (owner or admin only)
 *   chat/<uid>/...          private  (participants of a chat that references it)
 *   community/<uid>/...     public   (merchant product images)
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

  const allowVideo = purpose === 'product';
  const maxSize = allowVideo ? VIDEO_MAX : IMAGE_MAX;
  if (file.size > maxSize) {
    throw badRequest(`File is too large (max ${Math.round(maxSize / 1024 / 1024)} MB)`);
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind) throw badRequest('Unsupported file type — please upload a JPEG, PNG, WebP or GIF image' + (allowVideo ? ' or MP4 video' : ''));
  if (kind.mime.startsWith('video/') && !allowVideo) {
    throw badRequest('Videos are not allowed here');
  }

  const prefix =
    purpose === 'receipt' ? `receipts/${user.id}` :
    purpose === 'avatar' ? `avatars/${user.id}` :
    purpose === 'chat' ? `chat/${user.id}` :
    purpose === 'community' ? `community/${user.id}` :
    'products';
  const key = `${prefix}/${newId()}.${kind.ext}`;

  await c.env.BUCKET.put(key, buf, {
    httpMetadata: { contentType: kind.mime, cacheControl: 'public, max-age=31536000, immutable' },
  });

  return c.json({ success: true, key, url: `/files/${key}` });
});

/**
 * File delivery with the access policy above. Mounted at /files/* (outside
 * /api) so URLs can be used directly in <img src>.
 */
export const fileRoutes = new Hono<AppContext>();

fileRoutes.get('/*', async (c) => {
  const key = c.req.path.replace(/^\/files\//, '');
  if (!key || key.includes('..')) throw notFound();
  const user = c.get('user');

  const publicPrefix = key.startsWith('products/') || key.startsWith('avatars/') || key.startsWith('community/');
  if (!publicPrefix) {
    if (!user) throw forbidden('Sign in to access this file');
    if (key.startsWith('receipts/')) {
      const isOwner = key.startsWith(`receipts/${user.id}/`);
      if (!isOwner && user.role !== 'admin') throw forbidden('Not your file');
    } else if (key.startsWith('chat/')) {
      const isOwner = key.startsWith(`chat/${user.id}/`);
      if (!isOwner) {
        // A non-uploader may view a chat image only if they participate in a
        // chat whose message references this file.
        const row = await c.env.DB.prepare(
          `SELECT 1 AS x FROM chat_messages m
             JOIN chat_participants p ON p.chat_id = m.chat_id AND p.user_id = ?
            WHERE m.file_key = ? LIMIT 1`
        )
          .bind(user.id, key)
          .first();
        if (!row) throw forbidden('Not your file');
      }
    } else {
      throw notFound();
    }
  }

  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  if (!publicPrefix) headers.set('Cache-Control', 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(obj.body, { headers });
});
