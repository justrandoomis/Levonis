/**
 * Doubles for the picture pipeline (worker/lib/imageVariants.ts,
 * worker/routes/uploads.ts `?w=`): an R2 bucket that keeps metadata, honours
 * `onlyIf`, lists by prefix with a cursor and records every operation; an
 * `IMAGES` binding that really "resizes" — it reads the source's header, never
 * enlarges (`fit: scale-down`) and answers with bytes whose own header says
 * the format and size it produced; and the byte builders both use.
 *
 * Nothing here touches a network or a real bucket.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

/** A WebP header (VP8X) of `width × height`; `animated` sets the animation flag. */
export function webpBytes(width: number, height: number, opts: { animated?: boolean; pad?: number } = {}): Uint8Array {
  const body = [
    ...enc('RIFF'), 0, 0, 0, 0, ...enc('WEBP'), ...enc('VP8X'), 10, 0, 0, 0,
    opts.animated ? 0x02 : 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1),
  ];
  return new Uint8Array([...body, ...new Array(opts.pad ?? 16).fill(7)]);
}

/** An AVIF header (ftyp avif + one `ispe`) of `width × height`. */
export function avifBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0, 0, 0, 20, ...enc('ftyp'), ...enc('avif'), 0, 0, 0, 0, ...enc('avif'),
    0, 0, 0, 20, ...enc('ispe'), 0, 0, 0, 0, ...u32be(width), ...u32be(height),
    ...new Array(16).fill(9),
  ]);
}

/** A PNG header (signature + IHDR) of `width × height`. */
export function pngBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...enc('IHDR'), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0,
    ...new Array(16).fill(5),
  ]);
}

/** A JPEG with one SOF0 segment of `width × height`. */
export function jpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, ...enc('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0, 17, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9, ...new Array(8).fill(3),
  ]);
}

/** Width × height read back from any of the four builders above. */
export function dimsOf(bytes: Uint8Array): { width: number; height: number; format: string } | null {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    return { format: 'image/webp', width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
  }
  if (tag(4) === 'ftyp') {
    const i = bytes.findIndex((_, k) => tag(k) === 'ispe');
    const r = (at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    return { format: 'image/avif', width: r(i + 8), height: r(i + 12) };
  }
  if (bytes[0] === 0x89 && tag(12) === 'IHDR') {
    const r = (at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    return { format: 'image/png', width: r(16), height: r(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const i = bytes.findIndex((b, k) => b === 0xff && bytes[k + 1] === 0xc0);
    return { format: 'image/jpeg', height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
  }
  return null;
}

function build(format: string, width: number, height: number): Uint8Array {
  if (format === 'image/avif') return avifBytes(width, height);
  if (format === 'image/png') return pngBytes(width, height);
  if (format === 'image/jpeg') return jpegBytes(width, height);
  return webpBytes(width, height);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ImagesCall {
  width?: number;
  height?: number;
  fit?: string;
  format: string;
  quality?: number;
  sourceWidth: number;
}

export type ImagesMode = 'ok' | 'http500' | 'throw9422' | 'wrongFormat' | 'tooWide';

/** The `IMAGES` binding: scale-down by the source's own header, bytes that say what they are. */
export function imagesDouble(initial: ImagesMode = 'ok') {
  const calls: ImagesCall[] = [];
  const infos: number[] = [];
  /**
   * `avifMaxPixels`: as the live binding behaves (speed audit 2026-10-16), an AVIF
   * asked for an output larger than this answers in another format — a 1254² photo
   * at its own size, 1280 and 1600 of a 2992² one — while WebP of the same size works.
   */
  const state: { mode: ImagesMode; avifMaxPixels: number | null } = { mode: initial, avifMaxPixels: null };
  const binding = {
    async info(stream: ReadableStream<Uint8Array>) {
      const d = dimsOf(await drain(stream));
      infos.push(d?.width ?? 0);
      if (!d) throw Object.assign(new Error('not an image'), { code: 9412 });
      return { format: d.format, width: d.width, height: d.height, fileSize: 1 };
    },
    input(stream: ReadableStream<Uint8Array>) {
      const transform: { width?: number; height?: number; fit?: string } = {};
      const handle = {
        transform(t: { width?: number; height?: number; fit?: string }) {
          Object.assign(transform, t);
          return handle;
        },
        async output(o: { format: string; quality?: number }) {
          const source = dimsOf(await drain(stream));
          calls.push({ ...transform, ...o, sourceWidth: source?.width ?? 0 });
          if (state.mode === 'throw9422') throw Object.assign(new Error('9422: monthly transformation limit'), { code: 9422 });
          const sw = source?.width ?? 1;
          const sh = source?.height ?? 1;
          // scale-down: never enlarge; a box (width AND height) keeps the aspect inside both.
          let scale = 1;
          if (transform.width) scale = Math.min(scale, transform.width / sw);
          if (transform.height) scale = Math.min(scale, transform.height / sh);
          let w = Math.max(1, Math.round(sw * scale));
          const h = Math.max(1, Math.round(sh * scale));
          if (state.mode === 'tooWide') w = (transform.width ?? sw) + 40;
          const overAvif = o.format === 'image/avif' && state.avifMaxPixels !== null && w * h > state.avifMaxPixels;
          const format = state.mode === 'wrongFormat' || overAvif ? (o.format === 'image/avif' ? 'image/webp' : 'image/avif') : o.format;
          const bytes = build(format, w, h);
          return { response: () => (state.mode === 'http500' ? new Response('no', { status: 500 }) : new Response(bytes as unknown as BodyInit)) };
        },
      };
      return handle;
    },
  };
  return { binding, calls, infos, state };
}

interface Stored {
  bytes: Uint8Array;
  etag: string;
  contentType?: string;
  cacheControl?: string;
  custom?: Record<string, string>;
  uploaded: Date;
}

let etagSeq = 0;
const etagOf = (bytes: Uint8Array) => {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  etagSeq += 1;
  return `${h.toString(16)}${etagSeq.toString(16)}`;
};

/** An R2 bucket: metadata, conditional puts, prefix listing with cursors, and a log of every call. */
export class R2Double {
  objects = new Map<string, Stored>();
  ops: string[] = [];
  puts: Array<{ key: string; onlyIf?: unknown; custom?: Record<string, string>; cacheControl?: string }> = [];
  now = () => new Date();

  seed(key: string, bytes: Uint8Array, meta: { contentType?: string; cacheControl?: string; custom?: Record<string, string> } = {}) {
    this.objects.set(key, { bytes, etag: etagOf(bytes), contentType: meta.contentType, cacheControl: meta.cacheControl, custom: meta.custom, uploaded: this.now() });
  }

  private view(key: string, o: Stored) {
    const bytes = o.bytes;
    return {
      key,
      size: bytes.byteLength,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      uploaded: o.uploaded,
      customMetadata: o.custom ?? {},
      httpMetadata: { contentType: o.contentType, cacheControl: o.cacheControl },
      writeHttpMetadata(headers: Headers) {
        if (o.contentType) headers.set('Content-Type', o.contentType);
        if (o.cacheControl) headers.set('Cache-Control', o.cacheControl);
      },
    };
  }

  async get(key: string) {
    this.ops.push(`get ${key}`);
    const o = this.objects.get(key);
    if (!o) return null;
    const copy = o.bytes.slice();
    return {
      ...this.view(key, o),
      body: new Blob([copy as unknown as BlobPart]).stream(),
      async arrayBuffer() { return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength); },
      async text() { return new TextDecoder().decode(copy); },
    };
  }

  async head(key: string) {
    this.ops.push(`head ${key}`);
    const o = this.objects.get(key);
    return o ? this.view(key, o) : null;
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options: { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> } = {}
  ) {
    this.ops.push(`put ${key}`);
    this.puts.push({ key, onlyIf: options.onlyIf, custom: options.customMetadata, cacheControl: options.httpMetadata?.cacheControl });
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes =
      typeof value === 'string' ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0))
          : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.seed(key, bytes, { contentType: options.httpMetadata?.contentType, cacheControl: options.httpMetadata?.cacheControl, custom: options.customMetadata });
    return this.view(key, this.objects.get(key)!);
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      this.ops.push(`delete ${k}`);
      this.objects.delete(k);
    }
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number; include?: string[] } = {}) {
    this.ops.push(`list ${options.prefix ?? ''}${options.cursor ? `@${options.cursor}` : ''}`);
    const all = [...this.objects.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const page = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return {
      objects: page.map((k) => this.view(k, this.objects.get(k)!)),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
      delimitedPrefixes: [],
    };
  }

  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** `caches.default` as the Workers runtime provides it: keyed by URL, whole responses. */
export class MemCache {
  store = new Map<string, { status: number; headers: [string, string][]; bytes: Uint8Array }>();
  async match(req: Request) {
    const e = this.store.get(req.url);
    return e ? new Response(e.bytes.slice() as unknown as BodyInit, { status: e.status, headers: e.headers }) : undefined;
  }
  async put(req: Request, res: Response) {
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    this.store.set(req.url, { status: res.status, headers, bytes: new Uint8Array(await res.arrayBuffer()) });
  }
}
