/**
 * AN INCREMENTAL SHA-256 WITH NO DEPENDENCIES, shared by the hashing Web
 * Worker (sha256.worker.ts) and the main-thread fallback in
 * src/lib/uploadSession.ts. `crypto.subtle.digest` is one-shot — it wants the
 * whole file in memory, which is exactly what a 300 MB model on a phone cannot
 * afford — so the file is read in slices and fed through this instead. The
 * server verifies the same digest on complete (worker/routes/uploadSessions.ts).
 *
 * Dependency-free ON PURPOSE: the worker bundle must not pull the API client,
 * the cart store or anything that touches `window` at module scope.
 */
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private readonly h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly w = new Int32Array(64);
  private readonly buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;

  private block(p: Uint8Array, off: number): void {
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (p[j] << 24) | (p[j + 1] << 16) | (p[j + 2] << 8) | p[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  /** Feed the next slice. Slices may be any size, including one byte. */
  update(data: Uint8Array): this {
    let i = 0;
    this.total += data.length;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i));
      this.bufLen = data.length - i;
    }
    return this;
  }

  /** The digest as 64 lower-case hex characters. The hasher is spent afterwards. */
  digestHex(): string {
    const bits = this.total * 8;
    const padded = new Uint8Array((this.bufLen + 9 + 63) & ~63);
    padded.set(this.buf.subarray(0, this.bufLen));
    padded[this.bufLen] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padded.length - 4, bits >>> 0);
    for (let off = 0; off < padded.length; off += 64) this.block(padded, off);
    let out = '';
    for (let i = 0; i < 8; i++) out += (this.h[i] >>> 0).toString(16).padStart(8, '0');
    return out;
  }
}

/** One-shot convenience for bytes already in memory. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex();
}

/** How much of a file one slice reads: small enough for a phone, large enough that the loop is not the cost. */
export const HASH_SLICE_BYTES = 4 * 1024 * 1024;

/**
 * Hash a Blob slice by slice, reporting the bytes hashed so far. Shared by the
 * worker and the fallback so the two can never disagree about a digest.
 */
export async function sha256OfBlob(
  file: Blob,
  onProgress?: (loaded: number) => void,
  shouldStop?: () => boolean
): Promise<string> {
  const hasher = new Sha256();
  for (let off = 0; off < file.size; off += HASH_SLICE_BYTES) {
    if (shouldStop?.()) throw new Error('hash cancelled');
    const end = Math.min(off + HASH_SLICE_BYTES, file.size);
    hasher.update(new Uint8Array(await file.slice(off, end).arrayBuffer()));
    onProgress?.(end);
  }
  return hasher.digestHex();
}
