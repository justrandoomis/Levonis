/**
 * What a customer may attach to a community request, and what it actually is.
 *
 * A 3D-printing request is mostly useless without the thing to print, so this
 * accepts model files as well as pictures. That raises a problem the existing
 * image-only sniffer did not have: STL and OBJ have no magic number to check.
 *
 * THE RULE THIS FILE IS BUILT AROUND: a declared type is a claim, not a fact.
 * `file.type` comes from the browser and the extension comes from whoever
 * named the file, so neither decides anything on its own. Every format here
 * is either recognised from its BYTES, or accepted only after a STRUCTURAL
 * check that a wrong file would fail:
 *
 *   images, PDF, 3MF   magic bytes
 *   GLB                magic bytes ('glTF'), so the name is not consulted
 *   binary STL         84 + 50 x triangleCount must equal the file size —
 *                      a renamed .exe does not satisfy that identity
 *   ASCII STL / OBJ    valid UTF-8 whose first meaningful line is the token
 *   AMF / glTF / STEP  the format requires. STEP is accepted as a REFERENCE:
 *                      Levonis cannot measure boundary-representation CAD
 *                      without a geometry kernel, and says so rather than
 *                      pricing a guess (worker/lib/modelGeometry.ts)
 *
 * And whatever survives that, nothing but an image is ever served inline.
 * A model file comes back as an attachment with `nosniff`, so even a file
 * that fooled every check above cannot be interpreted as script by a browser.
 */

export type AttachmentKind = 'reference' | 'model' | 'document';

export interface Attachment {
  ext: string;
  /** What we will serve it back as — derived from the bytes, not the upload. */
  mime: string;
  kind: AttachmentKind;
  /** May a browser render it in place? Only pictures. */
  inline: boolean;
}

/** 8 MB for a picture, 40 MB for a model. A print model is genuinely large. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const MODEL_MAX_BYTES = 40 * 1024 * 1024;

const starts = (b: Uint8Array, sig: number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * A binary STL declares its own triangle count at byte 80, and every triangle
 * is exactly 50 bytes. If that arithmetic does not reproduce the file's
 * length, it is not a binary STL, whatever it is called.
 */
function isBinaryStl(b: Uint8Array): boolean {
  if (b.length < 84) return false;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const triangles = view.getUint32(80, true);
  // Guard the multiplication before doing it: a hostile header can claim
  // four billion triangles purely to overflow the arithmetic.
  if (triangles > 20_000_000) return false;
  return 84 + triangles * 50 === b.length;
}

/** UTF-8 that decodes cleanly, so a text-format check is looking at text. */
function utf8(b: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b.subarray(0, 4096));
  } catch {
    return null;
  }
}

function firstMeaningfulLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return '';
}

/**
 * Identify an upload from its bytes. `fileName` is used ONLY to choose
 * between formats the bytes cannot tell apart (an ASCII STL and an OBJ are
 * both plain text), never to accept something the bytes rejected.
 */
export function classifyAttachment(buf: Uint8Array, fileName = ''): Attachment | null {
  const name = fileName.toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

  // ---- pictures, by magic bytes
  if (starts(buf, [0xff, 0xd8, 0xff])) {
    return { ext: 'jpg', mime: 'image/jpeg', kind: 'reference', inline: true };
  }
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47])) {
    return { ext: 'png', mime: 'image/png', kind: 'reference', inline: true };
  }
  if (starts(buf, [0x47, 0x49, 0x46, 0x38])) {
    return { ext: 'gif', mime: 'image/gif', kind: 'reference', inline: true };
  }
  if (starts(buf, [0x52, 0x49, 0x46, 0x46]) && starts(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { ext: 'webp', mime: 'image/webp', kind: 'reference', inline: true };
  }

  // ---- documents
  if (starts(buf, [0x25, 0x50, 0x44, 0x46])) {
    return { ext: 'pdf', mime: 'application/pdf', kind: 'document', inline: false };
  }

  // ---- models
  // A 3MF is a ZIP container. So is a .docx and so is a .jar, which is why
  // the extension has to agree before we call it a model — the ZIP magic
  // alone says only "this is a zip".
  if (starts(buf, [0x50, 0x4b, 0x03, 0x04]) && ext === '3mf') {
    return { ext: '3mf', mime: 'model/3mf', kind: 'model', inline: false };
  }
  // A zipped AMF, same reasoning: the extension has to agree with the ZIP.
  if (starts(buf, [0x50, 0x4b, 0x03, 0x04]) && ext === 'amf') {
    return { ext: 'amf', mime: 'application/x-amf', kind: 'model', inline: false };
  }
  // glTF binary declares itself in its first four bytes — a real magic number,
  // so the extension is not consulted at all.
  if (starts(buf, [0x67, 0x6c, 0x54, 0x46])) {
    return { ext: 'glb', mime: 'model/gltf-binary', kind: 'model', inline: false };
  }
  if (isBinaryStl(buf) && (ext === 'stl' || ext === '')) {
    return { ext: 'stl', mime: 'model/stl', kind: 'model', inline: false };
  }

  const text = utf8(buf);
  if (text) {
    const line = firstMeaningfulLine(text);
    if (ext === 'stl' && /^solid\b/i.test(line)) {
      return { ext: 'stl', mime: 'model/stl', kind: 'model', inline: false };
    }
    if (ext === 'obj' && /^(v|vn|vt|f|o|g|mtllib|usemtl)\s/i.test(line)) {
      return { ext: 'obj', mime: 'model/obj', kind: 'model', inline: false };
    }
    // STEP names itself on its first line: the ISO part number is the format's
    // own signature, and no other file begins that way by accident.
    if ((ext === 'step' || ext === 'stp') && /^ISO-10303-21/i.test(line)) {
      return { ext: 'step', mime: 'model/step', kind: 'model', inline: false };
    }
    // AMF and glTF-JSON are XML and JSON respectively, so the first meaningful
    // token is checked rather than trusted from the name.
    if (ext === 'amf' && /^<\?xml|^<\s*amf/i.test(line)) {
      return { ext: 'amf', mime: 'application/x-amf', kind: 'model', inline: false };
    }
    if (ext === 'gltf' && /^\{/.test(line) && /"asset"/.test(text)) {
      return { ext: 'gltf', mime: 'model/gltf+json', kind: 'model', inline: false };
    }
  }

  return null;
}

/** The ceiling that applies to this kind of file. */
export function maxBytesFor(kind: AttachmentKind): number {
  return kind === 'reference' ? IMAGE_MAX_BYTES : MODEL_MAX_BYTES;
}

/**
 * A stored filename, made safe to put in a Content-Disposition header and to
 * show in a list.
 *
 * The original name is the customer's, so it can contain a newline, a quote,
 * a path separator or four kilobytes of nothing. A newline in this header is
 * response splitting; a quote breaks out of the filename parameter; a `/`
 * invites a reader to treat the name as a path.
 */
export function safeFileName(raw: unknown, fallbackExt: string): string {
  const s = typeof raw === 'string' ? raw : '';
  const cleaned = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')     // control characters, always
    .replace(/[\\/]/g, '_')                    // never a path
    .replace(/["']/g, '')                      // never breaks out of the header
    .trim()
    .slice(0, 120);
  return cleaned || `attachment.${fallbackExt}`;
}

// --------------------------------------------- the asset platform (§9.4)

/**
 * The five ceilings the admin sets (`uploadLimits`), and what a file name
 * says it is going to be. The name decides only which CEILING and which key
 * prefix a session is opened under; what the bytes actually are is decided on
 * complete, by the sniff, and a mismatch is refused (UPLOAD_KIND_NOT_ALLOWED).
 */
export type UploadKind = 'image' | 'video' | 'model' | 'document' | 'archive';

const KIND_BY_EXTENSION: Record<string, UploadKind> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image',
  mp4: 'video', webm: 'video',
  stl: 'model', obj: 'model', '3mf': 'model', amf: 'model', glb: 'model', gltf: 'model', step: 'model', stp: 'model',
  pdf: 'document',
  // A plain archive is named so the ceiling exists; `buildMediaKey` does not
  // admit `.zip` yet, so a session for one is refused at creation.
  zip: 'archive',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm',
  stl: 'model/stl', obj: 'model/obj', '3mf': 'model/3mf', amf: 'application/x-amf', glb: 'model/gltf-binary',
  gltf: 'model/gltf+json', step: 'model/step', pdf: 'application/pdf', zip: 'application/zip',
};

/** The lower-case extension of a file name, '' when it has none. */
export function extensionOf(fileName: string): string {
  const name = fileName.toLowerCase().trim();
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
}

/** `jpeg` → `jpg`, `stp` → `step`: the one spelling every key and every sniff uses. */
export function canonicalExtension(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpeg') return 'jpg';
  if (e === 'stp') return 'step';
  return e;
}

/** What a file name claims to be, or null when the extension is not one this shop stores. */
export function uploadKindForName(fileName: string): { ext: string; kind: UploadKind } | null {
  const raw = extensionOf(fileName);
  const kind = KIND_BY_EXTENSION[raw];
  return kind ? { ext: canonicalExtension(raw), kind } : null;
}

/** The content type an extension is served as. */
export function mimeForExtension(ext: string): string {
  return MIME_BY_EXTENSION[canonicalExtension(ext)] ?? 'application/octet-stream';
}

/** Which ceiling a sniffed MIME falls under. */
export function uploadKindForMime(mime: string): UploadKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  if (mime === 'application/zip') return 'archive';
  return 'model';
}

/**
 * THE SAME CLASSIFICATION, FROM THE FIRST 64 KiB OF A STORED OBJECT.
 *
 * `classifyAttachment` proves a binary STL by `84 + 50 × triangles = length`,
 * and a head slice never has that length. The total is known — the session
 * declared it and every part was counted — so the identity is checked against
 * THAT. Everything else the head answers on its own: the magic bytes, the
 * ZIP signature with its extension, the first meaningful line of a text
 * format.
 */
export function classifyAttachmentHead(head: Uint8Array, fileName: string, totalBytes: number): Attachment | null {
  const direct = classifyAttachment(head, fileName);
  if (direct) return direct;
  const ext = extensionOf(fileName);
  if ((ext === 'stl' || ext === '') && head.length >= 84 && head.length < totalBytes) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const triangles = view.getUint32(80, true);
    if (triangles <= 20_000_000 && 84 + triangles * 50 === totalBytes) {
      return { ext: 'stl', mime: 'model/stl', kind: 'model', inline: false };
    }
  }
  return null;
}

/**
 * THE ZIP BOMB BOUND. A 3MF and a zipped AMF are ZIP archives, and a ZIP's
 * central directory declares every entry's inflated size before a byte is
 * inflated. These three numbers are the whole defence: more entries than a
 * model could need, an inflation ratio no mesh XML reaches, or a total above
 * what the analyser may hold — and the archive is refused unopened
 * (ARCHIVE_TOO_DEEP). The slack keeps a tiny, highly repetitive file — a
 * 2 KB cube whose XML deflates twelve-fold — from tripping the ratio.
 */
export const ZIP_MAX_ENTRIES = 2000;
export const ZIP_MAX_RATIO = 8;
export const ZIP_RATIO_SLACK_BYTES = 1024 * 1024;
/** What `parse3mf`/`parseAmf` may inflate in total when no smaller ceiling is given. */
export const ARCHIVE_INFLATE_CAP = 512 * 1024 * 1024;

export interface ZipTotals {
  entries: number;
  compressed: number;
  uncompressed: number;
}

export function zipWithinBounds(t: ZipTotals, maxTotalBytes: number): boolean {
  if (t.entries > ZIP_MAX_ENTRIES) return false;
  if (t.uncompressed > maxTotalBytes) return false;
  return t.uncompressed <= t.compressed * ZIP_MAX_RATIO + ZIP_RATIO_SLACK_BYTES;
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/**
 * The end-of-central-directory record, found by scanning the TAIL of the file
 * backwards (the record is the last 22 bytes plus a comment of up to 64 KiB).
 * `cd_offset` is what the record declares: the directory's offset from the
 * START of the file. `'zip64'` when the counts overflow the classic fields —
 * an archive this shop has no reason to accept — and null when no record is
 * there at all.
 */
export function zipEndOfDirectory(tail: Uint8Array): { entries: number; cd_offset: number; cd_size: number } | 'zip64' | null {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] !== 0x50 || tail[i + 1] !== 0x4b || tail[i + 2] !== 0x05 || tail[i + 3] !== 0x06) continue;
    const commentLen = u16(tail, i + 20);
    if (i + 22 + commentLen !== tail.length) continue;
    const entries = u16(tail, i + 10);
    const cdSize = u32le(tail, i + 12);
    const cdOffset = u32le(tail, i + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return 'zip64';
    return { entries, cd_offset: cdOffset, cd_size: cdSize };
  }
  return null;
}

/**
 * Walk a central directory and add up what it declares. Null when the bytes
 * are not a central directory, when an entry is cut short, or when a size
 * overflows into ZIP64 — every one of those is an archive that cannot be
 * bounded, and an archive that cannot be bounded is refused.
 */
export function zipDirectoryTotals(cd: Uint8Array, entries: number): ZipTotals | null {
  let at = 0;
  let compressed = 0;
  let uncompressed = 0;
  let seen = 0;
  while (seen < entries) {
    if (at + 46 > cd.length) return null;
    if (cd[at] !== 0x50 || cd[at + 1] !== 0x4b || cd[at + 2] !== 0x01 || cd[at + 3] !== 0x02) return null;
    const c = u32le(cd, at + 20);
    const u = u32le(cd, at + 24);
    if (c === 0xffffffff || u === 0xffffffff) return null;
    compressed += c;
    uncompressed += u;
    at += 46 + u16(cd, at + 28) + u16(cd, at + 30) + u16(cd, at + 32);
    seen += 1;
  }
  return { entries: seen, compressed, uncompressed };
}

/**
 * The same bound as an `unzipSync` filter, for the analyser's own inflation:
 * fflate calls it per central-directory entry BEFORE inflating, so a bomb
 * throws here and never expands. Thrown rather than skipped, because a model
 * whose parts were silently dropped would measure as an empty mesh.
 */
export function zipBombFilter(
  maxTotalBytes = ARCHIVE_INFLATE_CAP
): (f: { name: string; size: number; originalSize: number }) => boolean {
  let entries = 0;
  let compressed = 0;
  let uncompressed = 0;
  return (f) => {
    entries += 1;
    compressed += f.size;
    uncompressed += f.originalSize;
    if (!zipWithinBounds({ entries, compressed, uncompressed }, maxTotalBytes)) {
      throw new Error('ARCHIVE_TOO_DEEP');
    }
    return true;
  };
}
