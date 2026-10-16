/**
 * EVERY SMALL COPY IS MADE ONCE AND KEPT (owner 2026-10-13: «أريد تحويل الصور
 * كلها وضغطها بتكون بحجم صغير وليس بحجمها الأصلي الكبير»).
 *
 * `/files/<key>?w=` already answered a public still picture at one of the
 * widths of packages/contracts/src/imageSizing.ts, cut by the `IMAGES` binding.
 * But the copy lived only in `caches.default`, which is per data centre: each
 * data centre that had not served it cut it AGAIN — measured on the live site
 * at 0.85–2.3 s to first byte, while the full original answered in 0.2–0.27 s.
 * For a small shop most visits land on a cold pair, so the small picture often
 * appeared LATER than the big one would have.
 *
 * Now a copy is stored in R2 the first time it is cut, and read from R2 by
 * every later request from anywhere (worker/routes/uploads.ts). Three things
 * make the copies, and none needs the owner:
 *
 *  1. ON FIRST REQUEST — the read path stores what it cuts.
 *  2. AT UPLOAD — `scheduleVariantWarm`, after the response, from the four
 *     doors the owner uses (product pictures, the public upload purposes,
 *     home media and brand marks, section pictures): the AVIF rungs up to
 *     the picture's own width.
 *  3. FOR EVERY PICTURE ALREADY STORED — `sweepImageVariants`, a bounded step
 *     of the existing quarter-hour cron. It lists R2 itself (not D1), so
 *     legacy keys and the owner's hand uploads in the brand folder are
 *     covered; it runs no D1 statement at all, so the tick's statement budget
 *     (worker/lib/quarterHourBudget.ts) is untouched.
 *
 * WHAT A STORED COPY CARRIES. `customMetadata` is exactly `{src, src_etag, w,
 * width, height, fmt, q, ver}`: the original's key and ETag, the rung, the
 * copy's own size, its format, quality and store version. Never a supplier
 * URL, a file name, an owner or anything read from D1 — the copy is derived
 * from the public picture and says nothing the picture does not.
 *
 * THE WASM ALTERNATIVE WAS MEASURED AND REJECTED (docs/DECISIONS.md, the
 * images row): resizing in the isolate costs 52–98 MB for one 1254² photo and
 * over the 128 MB limit from 2048² up, in the isolate that serves the API.
 */
import type { Env } from './types';
import { IMAGE_VARIANT_WIDTHS, type ImageVariantWidth } from '../../packages/contracts/src/imageSizing';
import {
  IMAGES_MAX_INPUT_BYTES,
  VARIANT_QUALITY,
  isAnimatedWebp,
  renderImageVariant,
  variantExtension,
  variantSourceMime,
  type ImageVariantFormat,
  type VariantOutcome,
} from './imageConvert';
import { avifDimensions, rasterDimensions, validRasterDimensions, type RasterDimensions } from './imageMetadata';
import {
  getMediaObject,
  headMediaObject,
  isAnonymousPublicMediaKey,
  isSafeMediaKey,
  mediaBucket,
  publicMediaCacheControl,
} from './mediaStorage';
import {
  VARIANT_ROOT,
  VARIANT_STORE_VERSION,
  VARIANT_SWEEP_STATE_KEY,
  isVariantStoreKey,
  variantDoneKey,
  variantObjectKey,
  variantPrefix,
} from './variantKeys';

type VariantEnv = Pick<Env, 'IMAGES' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;

/** The ETag without its quotes or weak prefix — what a copy records and what its own ETag is built from. */
export const bareEtag = (etag: string | null | undefined): string => String(etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');

/** A copy's ETag: the original's, the rung and the format — the same shape the route has always sent. */
export const variantEtag = (sourceEtag: string, width: number, format: ImageVariantFormat): string =>
  `"${sourceEtag}-w${width}-${format.slice('image/'.length)}"`;

/**
 * THE RUNGS A PICTURE NEEDS: every rung narrower than it, and the first at or
 * above its width (that one is the picture at its own size, re-encoded small).
 * A 1254 px photo needs 160–1280 (seven); a 512 px avatar 160–640 (four).
 * An unknown width needs nothing made ahead — the read path still cuts lazily.
 */
export function rungsFor(width: number | null | undefined): ImageVariantWidth[] {
  const w = Number(width);
  if (!Number.isFinite(w) || w < 1) return [];
  const out: ImageVariantWidth[] = [];
  for (const rung of IMAGE_VARIANT_WIDTHS) {
    out.push(rung);
    if (rung >= w) break;
  }
  return out;
}

/** The metadata a stored copy carries — this list and nothing else (see the header). */
export function variantMetadata(input: {
  key: string;
  sourceEtag: string;
  width: number;
  format: ImageVariantFormat;
  out: RasterDimensions & { mime?: ImageVariantFormat };
  version?: number;
}): Record<string, string> {
  // The format of the BYTES: a rung the binding could not cut in AVIF is kept, in WebP, in its AVIF place (`cutVariant`).
  const bytesFormat = input.out.mime ?? input.format;
  return {
    src: input.key,
    src_etag: input.sourceEtag,
    w: String(input.width),
    width: String(input.out.width),
    height: String(input.out.height),
    fmt: variantExtension(bytesFormat),
    q: String(VARIANT_QUALITY[bytesFormat] ?? ''),
    ver: String(input.version ?? VARIANT_STORE_VERSION),
  };
}

/** The format of a stored copy's bytes: its `fmt`, else the format of the place it is kept in. */
export function storedVariantFormat(stored: Pick<R2Object, 'customMetadata'>, slot: ImageVariantFormat): ImageVariantFormat {
  const fmt = stored.customMetadata?.fmt;
  return fmt === 'webp' ? 'image/webp' : fmt === 'avif' ? 'image/avif' : fmt === 'jpg' ? 'image/jpeg' : fmt === 'png' ? 'image/png' : slot;
}

/**
 * THE RUNG A REQUEST NEEDS FROM AN ORIGINAL THIS WIDE: the one asked for, or —
 * past the picture's own size — the first rung at or above it (`rungsFor`'s
 * last), whose copy IS the picture at its own size. `?w=1600` of a 1254 px
 * photo is its `?w=1280`: the same bytes, kept once. An unknown width clamps nothing.
 */
export function clampRung(asked: ImageVariantWidth, sourceWidth: number | null | undefined): ImageVariantWidth {
  const rungs = rungsFor(sourceWidth);
  const top = rungs[rungs.length - 1];
  return top !== undefined && asked > top ? top : asked;
}

/**
 * ONE RUNG, IN THE FORMAT ASKED — OR, WHERE THE BINDING CANNOT ENCODE THAT
 * PICTURE IN AVIF AT THAT SIZE, IN WEBP (speed audit 2026-10-16, «?w=1280 and
 * ?w=1600 return the untouched original»).
 *
 * Seen live: the binding answers no AVIF for a large picture at a large rung —
 * a 1254² photo at its own size, a 2992² one at 1280 and 1600 — while a
 * 1920×1080 at 1280 and every rung up to 1080 are fine, and the same rung in
 * WebP is fine too (89.5 KB against a 146 KB original). The copy was refused,
 * the ORIGINAL served, nothing kept, and the binding asked again by every
 * request and every sweep pass, which marked the whole picture unreadable.
 * Now that rung is cut in WebP at its full size — only the codec changes, never
 * the pixels the visitor gets — and kept in the AVIF place (`fmt: webp` and its
 * own Content-Type), so no request and no sweep asks the binding for it again.
 * `webpFallback` only when the asker takes WebP (every AVIF browser does).
 *
 * `source` is called once per attempt: a Blob is read afresh, a stream is
 * fetched again (the route re-reads the original from its edge copy).
 */
export async function cutVariant(
  env: Pick<Env, 'IMAGES'>,
  source: () => Promise<Blob | Uint8Array | ReadableStream<Uint8Array> | null>,
  variant: { width: ImageVariantWidth; format: ImageVariantFormat; sourceWidth?: number | null },
  options: { webpFallback?: boolean } = {}
): Promise<{ outcome: VariantOutcome; attempts: number }> {
  const first = await source();
  if (!first) return { outcome: { ok: false, reason: 'failed', detail: 'the original is gone' }, attempts: 0 };
  const outcome = await renderImageVariant(env, first, variant);
  // Only an answer in the wrong format: a refusal, an HTTP error or a throw (9412, 9422) is the picture's or the binding's.
  if (outcome.ok || outcome.reason !== 'failed' || !outcome.unencodable || variant.format !== 'image/avif' || !options.webpFallback) return { outcome, attempts: 1 };
  const again = await source();
  if (!again) return { outcome, attempts: 1 };
  const webp = await renderImageVariant(env, again, { ...variant, format: 'image/webp' });
  return { outcome: webp.ok ? webp : outcome, attempts: 2 };
}

/** One stored copy, or null when there is none (or the bucket could not be read: the caller cuts instead). */
export async function readStoredVariant(
  env: VariantEnv,
  key: string,
  width: ImageVariantWidth,
  format: ImageVariantFormat
): Promise<R2ObjectBody | null> {
  const vkey = variantObjectKey(key, width, variantExtension(format));
  if (!isSafeMediaKey(vkey)) return null;
  try {
    return await mediaBucket(env, 'public').get(vkey);
  } catch (error) {
    console.warn('image_variant_read_failed', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}

/**
 * Store one copy. Put-if-absent, so two first requests racing for the same
 * copy cannot overwrite each other; `replace` (a fixed-name picture the owner
 * replaced, whose old copy is stale) overwrites. Returns whether it was written.
 */
export async function storeVariant(
  env: VariantEnv,
  input: {
    key: string;
    width: ImageVariantWidth;
    format: ImageVariantFormat;
    /** The bytes; `mime` when they are not in the place's own format (a WebP kept in the AVIF place). */
    out: { bytes: Uint8Array; width: number; height: number; mime?: ImageVariantFormat };
    sourceEtag: string;
    cacheControl: string;
    replace?: boolean;
    version?: number;
  }
): Promise<boolean> {
  const version = input.version ?? VARIANT_STORE_VERSION;
  const vkey = variantObjectKey(input.key, input.width, variantExtension(input.format), version);
  if (!isSafeMediaKey(vkey)) return false;
  const written = await mediaBucket(env, 'public').put(vkey, input.out.bytes, {
    ...(input.replace ? {} : { onlyIf: { etagDoesNotMatch: '*' } }),
    httpMetadata: { contentType: input.out.mime ?? input.format, cacheControl: input.cacheControl },
    customMetadata: variantMetadata({ ...input, version }),
  });
  return written !== null;
}

/** Header dimensions of a stored original (every still format a copy is cut from). */
function sourceDimensions(bytes: Uint8Array, mime: string): RasterDimensions | null {
  const d = mime === 'image/avif' ? avifDimensions(bytes) : rasterDimensions(bytes, mime);
  return validRasterDimensions(d) ? d : null;
}

/** The width of an original: from its header, else from the binding's decoder (free), else null. */
async function sourceWidthOf(env: VariantEnv, head: Uint8Array, mime: string, whole: Blob): Promise<number | null> {
  const header = sourceDimensions(head, mime);
  if (header) return header.width;
  const images = env.IMAGES as (ImagesBinding & { info?: ImagesBinding['info'] }) | undefined;
  if (!images || typeof images.info !== 'function') return null;
  try {
    const info = await images.info(whole.stream());
    return 'width' in info && info.width > 0 ? info.width : null;
  } catch {
    return null;
  }
}

/** Enough of an original's first bytes for its header (a JPEG's frame follows up to 64 KB of EXIF). */
const HEAD_BYTES = 256 * 1024;

/**
 * IS THE BINDING WORKING, OR WAS IT THIS PICTURE?
 *
 * A failed cut is either the binding's (the Images allowance spent — 9422 —
 * or an outage), which every later cut will hit too, or the picture's: a
 * WebP whose header is fine and whose payload is not, which any signed-in
 * customer can post. Counting both alike let ten such posts pause the whole
 * backfill for twelve hours, and retry them every pass. So after a failure
 * one tiny known-good picture is cut: if that works, the failure was the
 * picture's alone.
 */
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAA1BMVEXIeCjqlaEmAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQY02NgGAXIAAABEAAB7JfjegAAAABJRU5ErkJggg==';
async function bindingWorks(env: VariantEnv): Promise<boolean> {
  const probe = Uint8Array.from(atob(PROBE_PNG), (ch) => ch.charCodeAt(0));
  const out = await renderImageVariant(env, probe, { width: IMAGE_VARIANT_WIDTHS[0], format: 'image/avif', sourceWidth: 16 });
  return out.ok;
}

async function putDoneMarker(bucket: R2Bucket, key: string, version: number, meta: Record<string, string> = {}): Promise<void> {
  const done = variantDoneKey(key, version);
  if (!isSafeMediaKey(done)) return;
  await bucket.put(done, new Uint8Array(0), { customMetadata: { src: key, ver: String(version), ...meta } });
}

export interface VariantWarmInput {
  /** The public original's key. */
  key: string;
  /** The stored bytes, when the caller still holds them (no R2 read then). */
  bytes?: Uint8Array | null;
  /** The stored picture's width, when known. */
  width?: number | null;
  /** The stored object's ETag, when known. */
  etag?: string | null;
}

export interface VariantWarmReport {
  made: number;
  failed: number;
  skipped: string | null;
}

/**
 * CUT A NEW PICTURE'S COPIES NOW, so its first visitor reads them from R2.
 *
 * AVIF only (what nearly every browser asks for; WebP copies stay lazy), every
 * rung up to the picture's own width, two at a time from the bytes already in
 * memory. Writes the `done` marker the sweep skips by when every rung was
 * made. Never throws: a warm-up failure is logged and the upload it follows
 * has already succeeded.
 */
export async function warmImageVariants(env: VariantEnv, input: VariantWarmInput): Promise<VariantWarmReport> {
  const report: VariantWarmReport = { made: 0, failed: 0, skipped: null };
  try {
    const mime = variantSourceMime(input.key);
    if (!env.IMAGES) return { ...report, skipped: 'unavailable' };
    if (!mime || !isAnonymousPublicMediaKey(input.key) || isVariantStoreKey(input.key)) return { ...report, skipped: 'not_public_still' };
    let bytes = input.bytes ?? null;
    let etag = input.etag ? bareEtag(input.etag) : '';
    let cacheControl: string | null = null;
    if (!bytes) {
      const object = await getMediaObject(env, 'public', input.key);
      if (!object) return { ...report, skipped: 'missing' };
      bytes = new Uint8Array(await object.arrayBuffer());
      etag ||= bareEtag(object.httpEtag);
      cacheControl = object.httpMetadata?.cacheControl ?? null;
    } else if (!etag) {
      const head = await headMediaObject(env, 'public', input.key);
      if (!head) return { ...report, skipped: 'missing' };
      etag = bareEtag(head.httpEtag);
      cacheControl = head.httpMetadata?.cacheControl ?? null;
    }
    if (bytes.byteLength > IMAGES_MAX_INPUT_BYTES) return { ...report, skipped: 'too_large' };
    const home = mediaBucket(env, 'public');
    if (isAnimatedWebp(bytes)) {
      await putDoneMarker(home, input.key, VARIANT_STORE_VERSION, { skip: 'animated' });
      return { ...report, skipped: 'animated' };
    }
    // ONE Blob for every width (renderImageVariant reads it afresh each time).
    const source = new Blob([bytes]);
    const width = Number(input.width) > 0 ? Number(input.width) : await sourceWidthOf(env, bytes.subarray(0, HEAD_BYTES), mime, source);
    const rungs = rungsFor(width);
    if (!rungs.length) return { ...report, skipped: 'unknown_width' };
    // A minted key is immutable; a fixed name in the brand folder follows its own object.
    const policy = publicMediaCacheControl(input.key, cacheControl ?? 'immutable');
    const queue = [...rungs];
    const worker = async (most = Infinity) => {
      for (let n = 0; n < most && queue.length; n++) {
        const rung = queue.shift()!;
        const { outcome: out } = await cutVariant(env, async () => source, { width: rung, format: 'image/avif', sourceWidth: width }, { webpFallback: true });
        if (!out.ok) {
          report.failed += 1;
          console.warn('image_variant_warm_failed', JSON.stringify({ reason: out.reason, w: rung }));
          // One failure ends the warm-up: a picture the binding cannot read fails
          // at every width, and the sweep or the first visitor will try again.
          queue.length = 0;
          return;
        }
        await storeVariant(env, { key: input.key, width: rung, format: 'image/avif', out, sourceEtag: etag, cacheControl: policy });
        report.made += 1;
      }
    };
    // The first width alone, so a picture the binding cannot read costs one cut.
    await worker(1);
    await Promise.all([worker(), worker()]);
    if (report.failed === 0) await putDoneMarker(home, input.key, VARIANT_STORE_VERSION, { src_etag: etag });
    return report;
  } catch (error) {
    console.warn('image_variant_warm_failed', JSON.stringify({ reason: error instanceof Error ? error.name : 'unknown' }));
    return { ...report, skipped: report.skipped ?? 'error' };
  }
}

/**
 * Hand a warm-up to the runtime AFTER the response — the upload's answer never
 * waits for it and is never changed by it. Without an execution context (the
 * Node test harness) nothing is started.
 */
export function scheduleVariantWarm(
  executionCtx: () => Pick<ExecutionContext, 'waitUntil'>,
  env: VariantEnv,
  input: VariantWarmInput
): void {
  if (!env.IMAGES || !isAnonymousPublicMediaKey(input.key) || !variantSourceMime(input.key)) return;
  try {
    executionCtx().waitUntil(warmImageVariants(env, input).then(() => undefined, () => undefined));
  } catch {
    // No execution context: the copies will be cut on first request instead.
  }
}

// ------------------------------------------------------------- the sweep

/** Where the sweep looks, in priority order: catalogue pictures first. */
export const SWEEP_PREFIXES = [
  'products/',
  'UiUx/',
  'UIUx/',
  'ui/',
  'brands/',
  'services/',
  'merchants/',
  'users/',
  'link-cards/',
  'community/',
  'avatars/',
] as const;

/**
 * ONE TICK'S BUDGET. 72 cuts, three at a time, in at most 45 s: the live
 * shop's ~300 public originals × ~6 rungs (~1,800 copies, once) are done in
 * about six hours after a release instead of a day — the resize runs in the
 * Images service, not in this isolate, so a cut costs the Worker a few
 * milliseconds of CPU, and a quarter-hour cron may run far longer than 45 s.
 * The one-time backfill stays inside the Images Free plan's 5,000 a month
 * even if that is the plan the account is on. Five cuts in a row that fail
 * BECAUSE OF THE BINDING (the probe below fails too — 9422, an outage) pause
 * the sweep for six hours; a picture the binding cannot read is marked and
 * skipped instead. Nothing breaks meanwhile: the site serves the original
 * whenever a copy cannot be had.
 */
export const SWEEP_LIMITS = {
  transforms: 72,
  concurrency: 3,
  operations: 400,
  wallMs: 45_000,
  failureStreak: 5,
  pauseMs: 6 * 60 * 60 * 1000,
  passGapMs: 7 * 24 * 60 * 60 * 1000,
  pageSize: 50,
};

export interface SweepState {
  v: 1;
  /** Index into the buckets swept: [R2_PUBLIC, BUCKET (legacy)], each only when bound. */
  bucket: number;
  /** Index into SWEEP_PREFIXES. */
  prefix: number;
  /** The listing cursor of the page being worked on (re-listed next tick if unfinished). */
  cursor: string | null;
  pass_started: string | null;
  pass_done: string | null;
  paused_until: string | null;
  /** Consecutive pictures whose cut failed because the binding did. */
  failures: number;
}

export interface SweepReport {
  skipped: string | null;
  /** Cuts asked of the binding, the health probe included. */
  transforms: number;
  operations: number;
  stored: number;
  completed: number;
  /** Cuts that failed because the binding did (each picture counted once). */
  failures: number;
  /** Pictures the binding works for and cannot read: marked and skipped. */
  unreadable: number;
  paused: boolean;
  pass_done: boolean;
  removed_old: number;
}

const freshState = (): SweepState => ({
  v: 1, bucket: 0, prefix: 0, cursor: null, pass_started: null, pass_done: null, paused_until: null, failures: 0,
});

async function readSweepState(bucket: R2Bucket): Promise<SweepState> {
  try {
    const object = await bucket.get(VARIANT_SWEEP_STATE_KEY);
    if (!object) return freshState();
    const parsed = JSON.parse(await object.text()) as Partial<SweepState>;
    if (parsed?.v !== 1) return freshState();
    return { ...freshState(), ...parsed };
  } catch {
    return freshState();
  }
}

/**
 * THE BACKFILL: copies for every public still picture already in R2.
 *
 * One bounded step per quarter-hour tick, resuming from the cursor kept in
 * `variants/_state/sweep-v1.json`. For each original: one listing of its copy
 * prefix (a `done` marker of the same bytes means skip — the marker and every
 * copy record the original's ETag, so a picture rewritten in place is cut
 * again), one GET, its width from its header, then the missing AVIF rungs,
 * three at a time, then the marker. When a pass ends the next starts seven
 * days later, and costs one listing and a marker check per picture; copies of
 * an older `VARIANT_STORE_VERSION` are deleted then.
 *
 * NO D1. Not one statement — the tick's shared D1 budget is not touched
 * (tests/imageVariantSweep.test.ts counts them). Never throws.
 */
export async function sweepImageVariants(
  env: VariantEnv,
  options: { now?: () => number; limits?: Partial<typeof SWEEP_LIMITS>; version?: number } = {}
): Promise<SweepReport> {
  const limits = { ...SWEEP_LIMITS, ...(options.limits ?? {}) };
  const now = options.now ?? Date.now;
  const version = options.version ?? VARIANT_STORE_VERSION;
  const started = now();
  const report: SweepReport = {
    skipped: null, transforms: 0, operations: 0, stored: 0, completed: 0, failures: 0, unreadable: 0, paused: false, pass_done: false, removed_old: 0,
  };
  try {
    if (!env.IMAGES) return { ...report, skipped: 'unavailable' };
    const home = env.R2_PUBLIC ?? env.BUCKET;
    if (!home || typeof home.list !== 'function') return { ...report, skipped: 'no_bucket' };
    const sources: R2Bucket[] = [];
    for (const b of [env.R2_PUBLIC, env.BUCKET]) if (b && typeof b.list === 'function' && !sources.includes(b)) sources.push(b);

    const op = (n = 1) => { report.operations += n; };
    const opsLeft = () => limits.operations - report.operations;
    const timeLeft = () => now() - started < limits.wallMs;

    let state = await readSweepState(home);
    op();
    if (state.paused_until && Date.parse(state.paused_until) > started) {
      report.paused = true;
      return report;
    }
    if (state.pass_done) {
      if (started - Date.parse(state.pass_done) < limits.passGapMs) return report;
      state = freshState();
    }
    state.paused_until = null;
    state.pass_started ??= new Date(started).toISOString();

    outer: while (opsLeft() > 1 && timeLeft()) {
      const bucket = sources[state.bucket];
      if (!bucket) {
        // The pass is complete: drop the copies of an older store version, then rest.
        for (let old = 1; old < version && opsLeft() > 2; old++) {
          const page = await home.list({ prefix: `${VARIANT_ROOT}v${old}/`, limit: 1000 });
          op();
          const keys = page.objects.map((o) => o.key);
          if (keys.length) {
            await home.delete(keys);
            op();
            report.removed_old += keys.length;
          }
          if (page.truncated) break outer;
        }
        state = { ...freshState(), pass_done: new Date(now()).toISOString() };
        report.pass_done = true;
        break;
      }
      const prefix = SWEEP_PREFIXES[state.prefix];
      if (prefix === undefined) {
        state.bucket += 1;
        state.prefix = 0;
        state.cursor = null;
        continue;
      }
      const page = await bucket.list({ prefix, cursor: state.cursor ?? undefined, limit: limits.pageSize });
      op();
      for (const object of page.objects) {
        const key = object.key;
        const mime = variantSourceMime(key);
        if (!mime || isVariantStoreKey(key) || !isAnonymousPublicMediaKey(key) || Number(object.size) > IMAGES_MAX_INPUT_BYTES) continue;
        // A listing, a GET, a copy and a marker at the very least.
        if (opsLeft() < 4 || !timeLeft() || report.transforms >= limits.transforms) break outer;
        const listing = await home.list({ prefix: variantPrefix(key, version), include: ['customMetadata'] });
        op();
        const existing = new Map(listing.objects.map((o) => [o.key, o] as const));
        // The original's ETag, from the listing (free). A copy or a marker of
        // OTHER bytes — a link card's refreshed picture, a fixed name the owner
        // replaced — is stale and cut again; one of these bytes is kept.
        const listedEtag = bareEtag(object.etag ?? object.httpEtag);
        const ofTheseBytes = (o: R2Object | undefined): boolean => !!o && (!listedEtag || !o.customMetadata?.src_etag || o.customMetadata.src_etag === listedEtag);
        const done = existing.get(variantDoneKey(key, version));
        // The legacy bucket's copy of a key is never the one rewritten in place
        // (new writes go to the dedicated bucket, which is listed first and is
        // what the route serves): a marked key there is done whatever its ETag.
        if (done && (bucket !== sources[0] || ofTheseBytes(done))) continue;

        const original = await bucket.get(key);
        op();
        if (!original) continue;
        // ONE copy of the original in memory, as a Blob every cut reads afresh,
        // and only its first bytes as an array (the header, the animation flag).
        const blob = typeof (original as Partial<R2ObjectBody>).blob === 'function' ? await original.blob() : new Blob([await original.arrayBuffer()]);
        const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
        const etag = bareEtag(original.httpEtag);
        if (isAnimatedWebp(head)) {
          await putDoneMarker(home, key, version, { skip: 'animated', src_etag: etag });
          op();
          report.completed += 1;
          continue;
        }
        const width = await sourceWidthOf(env, head, mime, blob);
        if (!width) {
          await putDoneMarker(home, key, version, { skip: 'unreadable', src_etag: etag });
          op();
          continue;
        }
        const policy = publicMediaCacheControl(key, original.httpMetadata?.cacheControl ?? null);
        const queue = rungsFor(width).filter((rung) => !ofTheseBytes(existing.get(variantObjectKey(key, rung, 'avif', version))));
        let verdict: Promise<boolean> | null = null;
        let pictureFailed = false;
        let bindingFailed = false;
        let outOfBudget = false;
        let inFlight = 0;
        const cut = async (most = Infinity) => {
          for (let n = 0; n < most && queue.length && !pictureFailed && !bindingFailed; n++) {
            // Out of budget mid-picture: the copies made so far stay; the next tick re-lists and finishes it.
            // Each cut in flight will spend an operation on its copy, and the picture one on its marker.
            if (report.transforms >= limits.transforms || opsLeft() - inFlight < 3 || !timeLeft()) {
              outOfBudget = true;
              return;
            }
            const rung = queue.shift()!;
            report.transforms += 1;
            inFlight += 1;
            try {
              // A rung the binding cannot cut in AVIF is cut in WebP (`cutVariant`): only a picture it can
              // cut in NEITHER is the picture's failure — before, the top rung of every large photo marked
              // the whole picture unreadable and was never made.
              const { outcome: out, attempts } = await cutVariant(env, async () => blob, { width: rung, format: 'image/avif', sourceWidth: width }, { webpFallback: true });
              report.transforms += Math.max(0, attempts - 1);
              if (!out.ok) {
                console.warn('image_variant_sweep_failed', JSON.stringify({ reason: out.reason, w: rung }));
                // Asked once per picture, however many cuts were in flight.
                if (!verdict) {
                  report.transforms += 1;
                  verdict = bindingWorks(env);
                }
                if (await verdict) pictureFailed = true;
                else bindingFailed = true;
                return;
              }
              await storeVariant(env, { key, width: rung, format: 'image/avif', out, sourceEtag: etag, cacheControl: policy, version, replace: true });
              op();
              report.stored += 1;
            } finally {
              inFlight -= 1;
            }
          }
        };
        // The first width alone: a picture the binding cannot read costs one cut, not one per worker.
        await cut(1);
        await Promise.all(Array.from({ length: Math.max(1, limits.concurrency) }, () => cut()));
        if (bindingFailed) {
          // Not the picture's fault: no marker, so it is tried again once the binding works.
          report.failures += 1;
          state.failures += 1;
          if (state.failures >= limits.failureStreak) {
            state.failures = 0;
            state.paused_until = new Date(now() + limits.pauseMs).toISOString();
            report.paused = true;
            break outer;
          }
          continue;
        }
        state.failures = 0;
        if (pictureFailed) {
          // The binding works and cannot read THIS picture: skipped for good, until
          // its bytes change (a new ETag) or the store version does. Its copies
          // are still tried when a visitor asks, and the original served if not.
          report.unreadable += 1;
          await putDoneMarker(home, key, version, { skip: 'unreadable', src_etag: etag });
          op();
          continue;
        }
        if (outOfBudget) break outer;
        await putDoneMarker(home, key, version, { src_etag: etag });
        op();
        report.completed += 1;
      }
      if (page.truncated && page.cursor) state.cursor = page.cursor;
      else {
        state.prefix += 1;
        state.cursor = null;
      }
    }
    await home.put(VARIANT_SWEEP_STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
    op();
    return report;
  } catch (error) {
    console.warn('image_variant_sweep_failed', JSON.stringify({ reason: error instanceof Error ? error.name : 'unknown' }));
    return { ...report, skipped: report.skipped ?? 'error' };
  }
}
