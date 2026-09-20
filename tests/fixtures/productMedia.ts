/**
 * Product-media bindings for route tests whose subject is not R2 itself.
 * Historical parity fixtures use local `/files/*.webp` rows without building
 * an object store; the production save gate now correctly reads those bytes.
 * This fixture supplies one small decoded-WebP object for those declared keys
 * so the tests keep exercising their own persistence concern.
 */

export function fixtureWebp(width = 640, height = 480): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255], 24);
  bytes.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 27);
  return bytes;
}

export class ProductMediaFixtureBucket {
  readonly objects = new Map<string, Uint8Array>();

  constructor(private readonly supplyDeclaredWebp = false) {}

  private bytes(key: string): Uint8Array | null {
    const stored = this.objects.get(key);
    if (stored) return stored;
    // Content-addressed names must never be faked: their digest is part of the
    // contract. Parity fixtures use human-readable legacy keys.
    if (this.supplyDeclaredWebp && key.toLowerCase().endsWith('.webp') && !/(?:^|\/)[0-9a-f]{64}\.webp$/i.test(key)) {
      return fixtureWebp();
    }
    return null;
  }

  async get(key: string) {
    const bytes = this.bytes(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.byteLength,
      body: new Blob([bytes]).stream(),
      arrayBuffer: () => new Blob([bytes]).arrayBuffer(),
      httpMetadata: { contentType: 'image/webp' },
    } as unknown as R2ObjectBody;
  }

  async head(key: string) {
    const bytes = this.bytes(key);
    return bytes ? ({ key, size: bytes.byteLength } as unknown as R2Object) : null;
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, bytes.slice());
    return { key, size: bytes.byteLength } as unknown as R2Object;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

export function productMediaFixtureEnv(opts: { supplyDeclaredWebp?: boolean } = {}) {
  const publicBucket = new ProductMediaFixtureBucket(opts.supplyDeclaredWebp ?? true);
  const legacyBucket = new ProductMediaFixtureBucket(false);
  const privateBucket = new ProductMediaFixtureBucket(false);
  const images = {
    async info(_stream: ReadableStream) {
      return { format: 'image/webp', fileSize: 30, width: 640, height: 480 };
    },
    input(_stream: ReadableStream) {
      return {
        async output() {
          return { response: () => new Response(fixtureWebp()) };
        },
      };
    },
  };
  return {
    publicBucket,
    legacyBucket,
    privateBucket,
    env: { BUCKET: legacyBucket, R2_PUBLIC: publicBucket, R2_PRIVATE: privateBucket, IMAGES: images },
  };
}
