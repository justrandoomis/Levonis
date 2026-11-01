/**
 * «ارفع لقطة أسعار» — THE OWNER'S FILE, READ IN THE BROWSER
 * (docs/SMART_PRICING.md §3.2, §3.4).
 *
 * The Worker never fetches a snapshot file: the owner's browser reads it,
 * checks it with the very parser the upload door uses
 * (packages/catalog/src/supplierPrices/format.ts `parseSupplierPriceFile`,
 * so a bad file is refused here, by path and reason, before anything is
 * sent), hashes its bytes with crypto.subtle (SHA-256) and posts its items in
 * chunks of at most 50 items and 256 KB of JSON — the server's own limits
 * (worker/lib/supplierPrices/upload.ts UPLOAD_CHUNK_ITEMS / UPLOAD_CHUNK_BYTES).
 *
 * The items travel exactly as the file writes them; the server parses every
 * chunk again with the same strict parser. Pure: no request, no React.
 */
import {
  SupplierPriceFormatError,
  parseSupplierPriceFile,
  skuCountOf,
  type SupplierPriceHeader,
} from '../../../packages/catalog/src/supplierPrices/format';

/** The most items one upload chunk carries (the server's UPLOAD_CHUNK_ITEMS). */
export const UPLOAD_CHUNK_ITEMS = 50;
/** The most bytes of JSON one upload chunk carries (the server's UPLOAD_CHUNK_BYTES). */
export const UPLOAD_CHUNK_BYTES = 256 * 1024;
/** The largest file the browser reads: twenty thousand items fit with room to spare. */
export const UPLOAD_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** `{"items":[` … `],"offset":NNNNN}` around the items. */
const BODY_OVERHEAD = 32;

export interface UploadChunk {
  /** The first item's index in the whole file (the server names refusals by it). */
  offset: number;
  items: unknown[];
}

export interface PreparedUpload {
  header: SupplierPriceHeader;
  itemCount: number;
  skuCount: number;
  sha256: string;
  chunks: UploadChunk[];
}

export type PrepareFailure =
  | { kind: 'too_big' }
  | { kind: 'not_utf8' }
  | { kind: 'format'; path: string; reason: string }
  | { kind: 'item_too_large'; index: number }
  | { kind: 'no_crypto' };

export class UploadPrepareError extends Error {
  constructor(readonly failure: PrepareFailure) {
    super(failure.kind);
    this.name = 'UploadPrepareError';
  }
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).byteLength;

/** The SHA-256 of the file's bytes, as 64 lower-case hex digits. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new UploadPrepareError({ kind: 'no_crypto' });
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The items in chunks, in file order: each at most `maxItems` items and
 * `maxBytes` of request JSON. An item that alone exceeds the byte limit
 * cannot be sent at all.
 */
export function planChunks(items: readonly unknown[], maxItems = UPLOAD_CHUNK_ITEMS, maxBytes = UPLOAD_CHUNK_BYTES): UploadChunk[] {
  const chunks: UploadChunk[] = [];
  let current: unknown[] = [];
  let offset = 0;
  let bytes = BODY_OVERHEAD;
  items.forEach((item, index) => {
    const size = utf8Length(JSON.stringify(item) ?? 'null');
    if (size + BODY_OVERHEAD > maxBytes) throw new UploadPrepareError({ kind: 'item_too_large', index });
    const extra = size + (current.length ? 1 : 0);
    if (current.length && (current.length >= maxItems || bytes + extra > maxBytes)) {
      chunks.push({ offset, items: current });
      current = [];
      offset = index;
      bytes = BODY_OVERHEAD;
    }
    current.push(item);
    bytes += size + (current.length > 1 ? 1 : 0);
  });
  if (current.length) chunks.push({ offset, items: current });
  return chunks;
}

/**
 * Reads, checks, hashes and chunks one file. Throws UploadPrepareError with
 * what is wrong; nothing has been sent when it throws.
 */
export async function prepareUpload(bytes: ArrayBuffer | Uint8Array): Promise<PreparedUpload> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > UPLOAD_FILE_MAX_BYTES) throw new UploadPrepareError({ kind: 'too_big' });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    throw new UploadPrepareError({ kind: 'not_utf8' });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let header: SupplierPriceHeader;
  let skuCount: number;
  try {
    const file = parseSupplierPriceFile(text);
    header = { source: file.source, currency: file.currency, price_basis: file.price_basis, capture: file.capture, captured_on: file.captured_on, captured_by: file.captured_by };
    skuCount = skuCountOf(file.items);
  } catch (e) {
    if (e instanceof SupplierPriceFormatError) throw new UploadPrepareError({ kind: 'format', path: e.path, reason: e.reason });
    throw e;
  }
  // The file's own items, exactly as written (the parser above proved them valid).
  const raw = (JSON.parse(text) as { items: unknown[] }).items;
  const chunks = planChunks(raw);
  return { header, itemCount: raw.length, skuCount, sha256: await sha256Hex(view), chunks };
}
