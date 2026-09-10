import { Hono } from 'hono';

type Bindings = {
  BUCKET: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

// Simple magic byte checker
function checkMagicBytes(buffer: Uint8Array): string | null {
  if (buffer.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  // WebP: RIFF ... WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'image/webp';
  return null;
}

app.post('/api/files/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400);
  }

  // Size limit (e.g. 10MB)
  if (file.size > 10 * 1024 * 1024) {
    return c.json({ error: 'File too large' }, 413);
  }

  const arrayBuffer = await file.arrayBuffer();
  const uint8View = new Uint8Array(arrayBuffer);
  
  // MIME/Byte content validation
  const actualMime = checkMagicBytes(uint8View);
  if (!actualMime) {
    return c.json({ error: 'Invalid or unsupported image format. Only PNG, JPG, WebP allowed.' }, 415);
  }

  const ext = actualMime === 'image/png' ? 'png' : actualMime === 'image/jpeg' ? 'jpg' : 'webp';
  const key = `upload-${crypto.randomUUID()}.${ext}`;

  if (c.env.BUCKET) {
    await c.env.BUCKET.put(key, arrayBuffer, {
      httpMetadata: { contentType: actualMime },
    });
  }

  return c.json({
    success: true,
    key,
    url: `/files/${key}`,
  });
});

app.get('/files/:key', async (c) => {
  const key = c.req.param('key');
  
  // Responsive delivery / Generate useful sizes (thumbnail, display, detail)
  // We can use Cloudflare Image Resizing in a real environment
  // e.g. /files/my-image.jpg?variant=thumbnail
  
  if (!c.env.BUCKET) {
    return c.text('Not found', 404);
  }

  const object = await c.env.BUCKET.get(key);
  if (!object) {
    return c.text('Not found', 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(object.body, { headers });
});

export default app;
