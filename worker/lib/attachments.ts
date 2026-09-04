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
