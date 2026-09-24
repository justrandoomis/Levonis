/**
 * Bindings for the store app-icon tests (worker/lib/storeIcons.ts): an R2
 * bucket that honours the conditional put, and an `env.IMAGES` stub that
 * answers each transform chain with a PNG whose IHDR carries the size the
 * chain asked for (`inner` + 2 × border) — so the module's own verification
 * (PNG signature, exact dimensions) runs against what the geometry produced.
 *
 * The stub does not draw pixels; the live binding is exercised after deploy.
 * What it pins is everything this repository decides: which transforms are
 * requested, in what order, with which colour, and what is done with the
 * answer.
 */
import { fixtureWebp } from './productMedia';

export { fixtureWebp };

/** A PNG signature + IHDR for width × height. Enough for `sniffImageBytes` and `rasterDimensions`. */
export function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

export class IconBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; cacheControl: string }>();
  puts = 0;

  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      key,
      size: o.bytes.byteLength,
      httpEtag: `"etag-${key.length}"`,
      body: new Blob([o.bytes]).stream(),
      arrayBuffer: () => new Blob([o.bytes]).arrayBuffer(),
      httpMetadata: { contentType: o.contentType },
      writeHttpMetadata: (h: Headers) => h.set('content-type', o.contentType),
    } as unknown as R2ObjectBody;
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? ({ key, size: o.bytes.byteLength } as unknown as R2Object) : null;
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: R2PutOptions) {
    const only = options?.onlyIf as { etagDoesNotMatch?: string } | undefined;
    if (only?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes =
      value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const meta = (options?.httpMetadata ?? {}) as { contentType?: string; cacheControl?: string };
    this.objects.set(key, { bytes: bytes.slice(), contentType: meta.contentType ?? '', cacheControl: meta.cacheControl ?? '' });
    this.puts += 1;
    return { key, size: bytes.byteLength } as unknown as R2Object;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  /** Store a source logo, as an upload would. */
  seed(key: string, bytes: Uint8Array, contentType = 'image/webp') {
    this.objects.set(key, { bytes, contentType, cacheControl: 'public, max-age=31536000, immutable' });
  }
}

export interface ImagesCall {
  transforms: Record<string, unknown>[];
  output: Record<string, unknown>;
}

export interface ImagesStubOptions {
  /** Called before each output resolves; may await (a gated render). */
  beforeOutput?: (callNumber: number) => void | Promise<void>;
  /** Answer every output with this size instead of the requested one. */
  forceSize?: number;
  /** Throw from output(). */
  fail?: boolean;
  /** What `info()` reports (only used for sources whose header is not parsed). */
  info?: { format: string; fileSize: number; width: number; height: number };
}

export function imagesStub(options: ImagesStubOptions = {}) {
  const calls: ImagesCall[] = [];
  const binding = {
    async info() {
      return options.info ?? { format: 'image/avif', fileSize: 100, width: 640, height: 640 };
    },
    input() {
      const transforms: Record<string, unknown>[] = [];
      const transformer = {
        transform(t: Record<string, unknown>) {
          transforms.push(t);
          return transformer;
        },
        draw() {
          return transformer;
        },
        async output(o: Record<string, unknown>) {
          calls.push({ transforms, output: o });
          await options.beforeOutput?.(calls.length);
          if (options.fail) throw new Error('images binding exploded');
          const first = transforms[0] as { width?: number };
          const border = (transforms[1] as { border?: { width?: number } } | undefined)?.border?.width ?? 0;
          const size = options.forceSize ?? (first.width ?? 0) + 2 * border;
          const png = pngOf(size, size);
          return {
            response: () => new Response(png, { headers: { 'content-type': 'image/png' } }),
            contentType: () => 'image/png',
            image: () => new Blob([png]).stream(),
          };
        },
      };
      return transformer;
    },
  };
  return { binding: binding as unknown as ImagesBinding, calls };
}

export function iconEnv(db: D1Database, images?: ImagesBinding) {
  const publicBucket = new IconBucket();
  const legacy = new IconBucket();
  const privateBucket = new IconBucket();
  return {
    env: {
      DB: db,
      R2_PUBLIC: publicBucket as unknown as R2Bucket,
      BUCKET: legacy as unknown as R2Bucket,
      R2_PRIVATE: privateBucket as unknown as R2Bucket,
      IMAGES: images,
    },
    publicBucket,
  };
}
