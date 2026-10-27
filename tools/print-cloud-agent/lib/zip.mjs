/**
 * A MINIMAL ZIP READER for the slicer's own `.gcode.3mf` output (a 3MF is a
 * ZIP): the central directory, then stored (0) or deflated (8) entries
 * through node:zlib. No ZIP64, no encryption, no multi-disk — none of which
 * a slicer writes for a printable plate — and every inflate is capped, so a
 * malformed archive costs a bounded amount of memory.
 */
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/** Is this buffer a ZIP archive (local file header magic)? */
export const isZip = (buf) => buf.length >= 4 && buf.readUInt32LE(0) === LOCAL;

/**
 * @param {Buffer} buf
 * @param {{ maxEntryBytes?: number }} [opts]
 * @returns {{ names: string[], read: (name: string) => Buffer | null }}
 */
export function readZip(buf, opts = {}) {
  const maxEntryBytes = opts.maxEntryBytes ?? 512 * 1024 * 1024;
  let eocd = -1;
  // The end record is 22 bytes plus a comment of at most 65535.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new ZipError('ZIP64 archives are not supported');
  if (cdOffset + cdSize > buf.length) throw new ZipError('central directory outside the archive');
  /** @type {Map<string, { method: number, compressed: number, size: number, offset: number }>} */
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('corrupt central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    if (flags & 0x1) throw new ZipError(`encrypted entry: ${name}`);
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('ZIP64 entries are not supported');
    entries.set(name, { method, compressed, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.size > maxEntryBytes) throw new ZipError(`${name} is larger than ${maxEntryBytes} bytes`);
      if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== LOCAL) throw new ZipError(`corrupt local header: ${name}`);
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const data = buf.subarray(start, start + e.compressed);
      if (data.length !== e.compressed) throw new ZipError(`truncated entry: ${name}`);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) {
        const out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
        if (out.length !== e.size) throw new ZipError(`size mismatch in ${name}`);
        return out;
      }
      throw new ZipError(`unsupported compression method ${e.method} in ${name}`);
    },
  };
}
