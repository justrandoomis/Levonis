/**
 * NO CUSTOMER CAN STALL THE BACKFILL SWEEP (found by the security verification
 * of DECISIONS row 226).
 *
 * `sweepImageVariants` pauses for six hours after five pictures in a row fail
 * BECAUSE OF THE BINDING (the Images allowance spent — 9422 — or an outage).
 * A picture the binding cannot read — a WebP whose header is valid and whose
 * payload is not, which `POST /api/uploads purpose=post` accepts from any
 * signed-in account — used to count the same, and the sweep walks R2 in key
 * order, so ten such posts under `users/<attacker>/posts/` paused the backfill
 * of every later prefix for twelve hours, again every pass. Now one tiny
 * known-good picture is cut after a failure: when that works the failure was
 * the picture's, which is marked `unreadable` (with its ETag) and skipped.
 * The upload's warm-up stops at its first failure instead of trying all widths.
 *
 * The undecodable picture is modelled by the IMAGES double refusing a source
 * whose header says 3333 px wide (the real binding answers 9412 for a WebP
 * whose VP8 payload is garbage). Everything else is the real code.
 *
 * LOCAL ONLY. Run: node --import tsx --test tests/imageSweepUnreadableUploads.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { asD1, ctx, freshDb, pending } from './fixtures/app';
import { R2Double, dimsOf, imagesDouble, webpBytes } from './fixtures/imageDoubles';
import { uploadRoutes } from '../worker/routes/uploads';
import { SWEEP_LIMITS, sweepImageVariants } from '../worker/lib/imageVariants';

const GARBAGE_WIDTH = 3333;

/** The IMAGES double, except that a source whose header says 3333 px cannot be decoded. */
function selectiveImages() {
  const base = imagesDouble();
  const refused = { n: 0 };
  const binding = {
    info: base.binding.info,
    input(stream: ReadableStream<Uint8Array>) {
      let transform: Record<string, unknown> | null = null;
      const handle = {
        transform(t: Record<string, unknown>) {
          transform = t;
          return handle;
        },
        async output(o: { format: string; quality?: number }) {
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          if (dimsOf(bytes)?.width === GARBAGE_WIDTH) {
            refused.n += 1;
            throw Object.assign(new Error('9412: the input image could not be decoded'), { code: 9412 });
          }
          const inner = base.binding.input(new Blob([bytes as unknown as BlobPart]).stream());
          return (transform ? inner.transform(transform as never) : inner).output(o);
        },
      };
      return handle;
    },
  };
  return { binding, refused };
}

const LEGACY = ['link-cards/lnk_old.webp', 'community/old-photo.webp', 'avatars/old-face.webp'];

async function scenario(attackerUploads: number) {
  let clock = Date.parse('2026-10-13T00:00:00.000Z');
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('eve','Eve','eve@x.co','h','customer')");
  const pub = new R2Double();
  pub.now = () => new Date(clock);
  const priv = new R2Double();
  const images = selectiveImages();
  // Pictures stored before the pipeline existed, in prefixes the sweep reaches after `users/`.
  for (const key of LEGACY) pub.seed(key, webpBytes(1200, 900, { pad: 200 }), { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });

  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.env = { DB: asD1(raw), BUCKET: pub, R2_PUBLIC: pub, R2_PRIVATE: priv, IMAGES: images.binding } as never;
    c.set('user', { id: 'eve', role: 'customer', email: 'eve@x.co', admin_scope: null, username: 'eve', email_verified_at: '2026-01-01T00:00:00.000Z' } as never);
    c.set('sessionCreatedAt', new Date().toISOString());
    await next();
  });
  app.route('/api/uploads', uploadRoutes);
  app.onError((error, c) => (error instanceof HttpError
    ? c.json({ success: false, code: error.code, error: error.message }, error.status as 400)
    : c.json({ success: false, error: String(error) }, 500)));

  // The attacker: an ordinary customer posting WebPs the binding cannot decode.
  for (let i = 0; i < attackerUploads; i++) {
    const form = new FormData();
    form.set('purpose', 'post');
    form.set('file', new File([webpBytes(GARBAGE_WIDTH, 2000, { pad: 64 + i }) as unknown as BlobPart], `p${i}.webp`, { type: 'image/webp' }));
    const res = await app.request('/api/uploads', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
    assert.equal(res.status, 200, await res.clone().text());
    await Promise.all(pending.splice(0));
  }

  // The quarter-hour cron, for twelve hours less one tick.
  const env = { BUCKET: pub, R2_PUBLIC: pub, IMAGES: images.binding };
  let firstCopyAt: number | null = null;
  let paused = 0;
  const start = clock;
  for (let tick = 0; tick < 47; tick++) {
    const report = await sweepImageVariants(env as never, { now: () => clock });
    if (report.paused) paused += 1;
    const done = LEGACY.filter((k) => pub.keys(`variants/v1/${k}/`).some((v) => v.endsWith('.avif'))).length;
    if (done > 0 && firstCopyAt === null) firstCopyAt = (clock - start) / 3_600_000;
    clock += 15 * 60 * 1000;
  }
  const copied = LEGACY.filter((k) => pub.objects.has(`variants/v1/${k}/done`)).length;
  const marked = pub.keys('variants/v1/users/eve/posts/').filter((k) => k.endsWith('/done')).map((k) => pub.objects.get(k)!.custom!);
  return { copied, firstCopyAt, paused, refused: images.refused.n, marked, pub, images, clock: () => clock };
}

test('control: with no attacker, the legacy pictures after users/ are copied in the first tick', async () => {
  const r = await scenario(0);
  assert.equal(r.copied, LEGACY.length);
  assert.equal(r.firstCopyAt, 0);
});

test('ten undecodable posts from one customer neither pause the sweep nor delay the later prefixes', async () => {
  const r = await scenario(10);
  assert.equal(r.paused, 0, 'never paused');
  assert.equal(r.copied, LEGACY.length);
  assert.equal(r.firstCopyAt, 0, 'in the first tick, as without them');
  // Each bad post: ONE refused cut at upload (the warm-up stops at its first
  // failure, not all widths) and one in the sweep, then it is marked.
  assert.equal(r.refused, 20);
  assert.equal(r.marked.length, 10);
  for (const m of r.marked) {
    assert.equal(m.skip, 'unreadable');
    assert.ok(m.src_etag, 'the marker names the bytes it judged');
  }
  // The next pass does not try them again.
  const env = { BUCKET: r.pub, R2_PUBLIC: r.pub, IMAGES: r.images.binding };
  const later = r.clock() + SWEEP_LIMITS.passGapMs + 60_000;
  const again = await sweepImageVariants(env as never, { now: () => later });
  assert.equal(again.transforms, 0);
  assert.equal(again.pass_done, true);
});
