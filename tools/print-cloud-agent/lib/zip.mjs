/**
 * A MINIMAL ZIP READER (and the one rewrite the agent needs) for 3MF archives
 * — a 3MF is a ZIP: the slicer's own `.gcode.3mf` output, and a customer's
 * model before it reaches the slicer (slicers/model3mf.mjs). The central
 * directory, then stored (0) or deflated (8) entries through node:zlib. No
 * ZIP64, no encryption, no multi-disk — none of which a slicer writes for a
 * printable plate, and an archive that uses them is refused, never guessed
 * at — and every inflate is capped, so a malformed archive costs a bounded
 * amount of memory.
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
 * Every entry of the central directory, with where its data starts.
 * @param {Buffer} buf
 */
function centralDirectory(buf) {
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
  const entries = [];
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
    const record = buf.subarray(p, p + 46 + nameLen + extraLen + commentLen);
    if (record.length !== 46 + nameLen + extraLen + commentLen) throw new ZipError('corrupt central directory');
    entries.push({ name, flags, method, compressed, size, offset, record, nameBytes: buf.subarray(p + 46, p + 46 + nameLen) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Where an entry's data starts, checked against its local header. */
function dataStart(buf, e) {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== LOCAL) throw new ZipError(`corrupt local header: ${e.name}`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  if (start + e.compressed > buf.length) throw new ZipError(`truncated entry: ${e.name}`);
  return start;
}

/**
 * @param {Buffer} buf
 * @param {{ maxEntryBytes?: number }} [opts]
 * @returns {{ names: string[], read: (name: string) => Buffer | null }}
 */
export function readZip(buf, opts = {}) {
  const maxEntryBytes = opts.maxEntryBytes ?? 512 * 1024 * 1024;
  /** @type {Map<string, { method: number, compressed: number, size: number, offset: number, name: string }>} */
  const entries = new Map(centralDirectory(buf).map((e) => [e.name, e]));
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.size > maxEntryBytes) throw new ZipError(`${name} is larger than ${maxEntryBytes} bytes`);
      const start = dataStart(buf, e);
      const data = buf.subarray(start, start + e.compressed);
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

/**
 * The same archive without the entries named in `drop`. Each kept entry's
 * compressed bytes are copied as they are — nothing is inflated or
 * recompressed — under a local header rebuilt from the central directory (its
 * CRC, sizes, method and time: no trailing data descriptor is needed), and the
 * central directory is copied with the new offsets.
 * @param {Buffer} buf
 * @param {Set<string>} drop
 * @returns {Buffer}
 */
export function zipWithout(buf, drop) {
  const parts = [];
  const central = [];
  let at = 0;
  for (const e of centralDirectory(buf)) {
    if (drop.has(e.name)) continue;
    const start = dataStart(buf, e);
    const flags = e.flags & ~0x0008;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    e.record.copy(local, 4, 6, 16); // version needed, (flags), method, time, date
    local.writeUInt16LE(flags, 6);
    e.record.copy(local, 14, 16, 28); // CRC-32, compressed size, uncompressed size
    local.writeUInt16LE(e.nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const record = Buffer.from(e.record);
    record.writeUInt16LE(flags, 8);
    record.writeUInt32LE(at, 42);
    central.push(record);
    parts.push(local, e.nameBytes, buf.subarray(start, start + e.compressed));
    at += 30 + e.nameBytes.length + e.compressed;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, cd, end]);
}
