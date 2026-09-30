/**
 * RESUMABLE UPLOADS — /api/uploads/sessions (docs/COMMUNITY_ECOSYSTEM.md §9.4).
 *
 * `POST /api/uploads` reads a whole body into memory, which is fine for a
 * photograph and impossible for a 300 MB print model over Iraqi mobile data.
 * A SESSION is one R2 multipart upload with a ledger row (0156):
 *
 *   POST   /                  declare the file — purpose, entity, name, size,
 *                             MIME (a hint), SHA-256 — get a session, a part
 *                             size and an expiry
 *   PUT    /:id/parts/:n      one fixed-size part (the last may be smaller);
 *                             idempotent per n, so a retry simply replaces
 *   GET    /:id               the resume point: which parts are in
 *   POST   /:id/complete      assemble, then PROVE the file before a row is
 *                             written: every part present and the sizes add
 *                             up; the quota asked again (open sessions count
 *                             towards it, this one excluded);
 *                             the head sniffed (a forged name is refused);
 *                             a ZIP's central directory bounded before it is
 *                             ever inflated; the object streamed through
 *                             SHA-256 and compared with what was declared —
 *                             a mismatch deletes the object
 *   DELETE /:id               abort
 *
 * Every step is owner-only and answers 404 for anyone else, so a session id
 * reveals nothing. The entity checks are the SAME functions the whole-body
 * route runs (worker/lib/uploadEntity.ts); the ceilings and the part size are
 * the admin's `uploadLimits`; the quotas are `uploadQuotas`.
 *
 * WHAT A CLIENT NEVER DECIDES: the key (built here from the purpose), the
 * visibility, the content type (from the bytes), whether the file lands.
 */
import { Hono } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { HttpError, requireAuth, badRequest, conflict, int, oneOf, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { getSetting, type UploadLimits } from '../lib/settings';
import { buildMediaKey, deleteMediaObject, getMediaObject, mediaBucket, type MediaDomain, type MediaVisibility } from '../lib/mediaStorage';
import {
  ZIP_MAX_ENTRIES,
  classifyAttachmentHead,
  extensionOf,
  mimeForExtension,
  safeFileName,
  uploadKindForMime,
  uploadKindForName,
  zipDirectoryTotals,
  zipEndOfDirectory,
  zipWithinBounds,
} from '../lib/attachments';
import { mp4IsFastStart, sniffVideo } from '../lib/videoSniff';
import { rasterDimensions } from '../lib/imageMetadata';
import { analyseModel } from '../lib/modelGeometry';
import { HEIF_REFUSAL, isHeifBytes, sniff } from './uploads';
import {
  KEY_PURPOSES,
  MiB,
  SESSION_PURPOSES,
  assertQuota,
  assertRequestFileRoom,
  assertUploadEntity,
  chunkBytesFor,
  kindLimitBytes,
  placementFor,
  purposeAdmits,
  visibilityForKey,
} from '../lib/uploadEntity';

/** The head and the tail read for sniffing: enough for every magic number, a JPEG's SOF and a ZIP's end record plus its longest comment. */
const HEAD_BYTES = 64 * 1024;
/** A central directory of 2 000 entries with long names fits in a fraction of this. */
const CENTRAL_DIRECTORY_CAP = 4 * MiB;
/** A glTF's JSON is parsed whole, so it has a ceiling of its own. */
const GLTF_JSON_CAP = 4 * MiB;
/** `analyseModel` holds the mesh in memory; above this the file is stored unmeasured. */
const ANALYSIS_MAX_BYTES = 40 * MiB;
/** R2's own ceiling on parts per upload. */
const MAX_PARTS = 10_000;
const SHA256_RE = /^[0-9a-f]{64}$/;

interface SessionRow {
  id: string;
  owner_id: string;
  purpose: string;
  entity_id: string;
  file_name: string;
  declared_bytes: number;
  declared_mime: string;
  sha256: string;
  chunk_bytes: number;
  r2_upload_id: string;
  object_key: string;
  parts_json: string;
  state: 'open' | 'completed' | 'aborted' | 'expired';
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface PartRecord {
  n: number;
  etag: string;
  bytes: number;
}

const nowIso = () => new Date().toISOString();

function parseParts(json: string): PartRecord[] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (p): p is PartRecord =>
        !!p && typeof p === 'object' && Number.isInteger((p as PartRecord).n) && typeof (p as PartRecord).etag === 'string' && Number.isInteger((p as PartRecord).bytes)
    );
  } catch {
    return [];
  }
}

const partsTotal = (s: Pick<SessionRow, 'declared_bytes' | 'chunk_bytes'>) => Math.ceil(s.declared_bytes / s.chunk_bytes);
const expectedPartBytes = (s: Pick<SessionRow, 'declared_bytes' | 'chunk_bytes'>, n: number) => {
  const total = partsTotal(s);
  return n < total ? s.chunk_bytes : s.declared_bytes - (total - 1) * s.chunk_bytes;
};
const bytesOf = (parts: PartRecord[]) => parts.reduce((sum, p) => sum + p.bytes, 0);

const sessionNotFound = () => new HttpError(404, 'Upload session not found or no longer open', 'UPLOAD_SESSION_NOT_FOUND');
const tooDeep = (details: Record<string, unknown>) =>
  badRequest('This archive expands too far or holds too many files', 'ARCHIVE_TOO_DEEP', details);

function resumeUpload(env: Env, s: Pick<SessionRow, 'object_key' | 'r2_upload_id'>) {
  return mediaBucket(env, visibilityForKey(s.object_key)).resumeMultipartUpload(s.object_key, s.r2_upload_id);
}

async function markSession(db: D1Database, id: string, state: SessionRow['state'], from: SessionRow['state'] = 'open'): Promise<boolean> {
  const r = await db
    .prepare('UPDATE upload_sessions SET state = ?, updated_at = ? WHERE id = ? AND state = ?')
    .bind(state, nowIso(), id, from)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Expire an open session: the multipart upload is aborted so its parts stop costing storage. */
async function expireSession(env: Env, s: SessionRow): Promise<void> {
  try {
    await resumeUpload(env, s).abort();
  } catch {
    // an upload R2 has already dropped: nothing left to abort
  }
  await markSession(env.DB, s.id, 'expired');
}

/** The session, if it is this owner's — 404 otherwise, whoever asked. */
async function loadSession(db: D1Database, id: string, ownerId: string): Promise<SessionRow> {
  const s = await db.prepare('SELECT * FROM upload_sessions WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<SessionRow>();
  if (!s) throw sessionNotFound();
  return s;
}

/** The session, if it is this owner's AND still open. An expired one is expired on the spot. */
async function loadOpenSession(env: Env, id: string, ownerId: string): Promise<SessionRow> {
  const s = await loadSession(env.DB, id, ownerId);
  if (s.state !== 'open') throw sessionNotFound();
  if (s.expires_at <= nowIso()) {
    await expireSession(env, s);
    throw sessionNotFound();
  }
  return s;
}

function sessionPublic(s: SessionRow) {
  const parts = parseParts(s.parts_json);
  return {
    session_id: s.id,
    state: s.state,
    received: parts.map((p) => p.n).sort((a, b) => a - b),
    bytes_so_far: bytesOf(parts),
    declared_bytes: s.declared_bytes,
    chunk_bytes: s.chunk_bytes,
    parts_total: partsTotal(s),
    expires_at: s.expires_at,
  };
}

/**
 * Record one received part. Two parts in flight at once must not lose each
 * other's record, so the write is a compare-and-swap on `parts_json` and the
 * loser re-reads and tries again — never a blind read-modify-write.
 */
async function recordPart(db: D1Database, s: SessionRow, part: PartRecord): Promise<PartRecord[]> {
  let current = s;
  for (let attempt = 0; attempt < 8; attempt++) {
    const parts = parseParts(current.parts_json).filter((p) => p.n !== part.n);
    parts.push(part);
    parts.sort((a, b) => a.n - b.n);
    const r = await db
      .prepare(`UPDATE upload_sessions SET parts_json = ?, updated_at = ? WHERE id = ? AND state = 'open' AND parts_json = ?`)
      .bind(JSON.stringify(parts), nowIso(), current.id, current.parts_json)
      .run();
    if ((r.meta?.changes ?? 0) > 0) return parts;
    const fresh = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?').bind(current.id).first<SessionRow>();
    if (!fresh || fresh.state !== 'open') throw sessionNotFound();
    current = fresh;
  }
  throw conflict('The upload changed while this part was being recorded — send it again');
}

// ------------------------------------------------------------ SHA-256

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * AN INCREMENTAL SHA-256, for the runtime that has no `DigestStream`.
 * Workers verify through the native `crypto.DigestStream`; the unit tests run
 * on Node, where `crypto.subtle.digest` is one-shot and would need the whole
 * object in memory — the very thing a streamed verify exists to avoid.
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

class Sha256 {
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

  digestHex(): string {
    const bits = this.total * 8;
    const padded = new Uint8Array((this.bufLen + 9 + 63) & ~63);
    padded.set(this.buf.subarray(0, this.bufLen));
    padded[this.bufLen] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padded.length - 4, bits >>> 0);
    for (let off = 0; off < padded.length; off += 64) this.block(padded, off);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = this.h[i] >>> 24; out[i * 4 + 1] = (this.h[i] >>> 16) & 0xff; out[i * 4 + 2] = (this.h[i] >>> 8) & 0xff; out[i * 4 + 3] = this.h[i] & 0xff;
    }
    return hex(out);
  }
}

type DigestStreamCtor = new (algorithm: string) => WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };

/** The object's SHA-256, streamed: never more than one chunk of it in memory. */
async function sha256OfObject(env: Env, visibility: MediaVisibility, key: string): Promise<string> {
  const obj = await getMediaObject(env, visibility, key);
  if (!obj) throw new Error('the assembled object vanished before it could be verified');
  const DigestStream = (crypto as unknown as { DigestStream?: DigestStreamCtor }).DigestStream;
  if (DigestStream) {
    const stream = new DigestStream('SHA-256');
    await obj.body.pipeTo(stream);
    return hex(new Uint8Array(await stream.digest));
  }
  const hasher = new Sha256();
  const reader = obj.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digestHex();
}

async function readRange(env: Env, visibility: MediaVisibility, key: string, offset: number, length: number): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  const obj = await getMediaObject(env, visibility, key, { range: { offset, length } });
  if (!obj) throw new Error('the assembled object vanished before it could be read');
  return new Uint8Array(await obj.arrayBuffer());
}

// ------------------------------------------------------------ the proof

interface Verdict {
  mime: string;
  ext: string;
  width: number | null;
  height: number | null;
  warnings: string[];
  analysis?: unknown;
}

/**
 * EVERYTHING THE FILE HAS TO PROVE BEFORE IT IS A FILE. Throws the refusal;
 * the caller deletes the object and closes the session on any throw.
 */
async function inspectStoredObject(env: Env, s: SessionRow, visibility: MediaVisibility, limits: UploadLimits): Promise<Verdict> {
  const key = s.object_key;
  const size = s.declared_bytes;
  const keyExt = extensionOf(key);
  const headLen = Math.min(HEAD_BYTES, size);
  const head = await readRange(env, visibility, key, 0, headLen);
  const tailOffset = Math.max(0, size - HEAD_BYTES);
  const tail = tailOffset === 0 ? head : await readRange(env, visibility, key, tailOffset, size - tailOffset);
  const warnings: string[] = [];

  // 1. THE BYTES NAME THE FORMAT. The extension the session was opened under
  //    only chose a ceiling and a key; the sniff decides, and a disagreement
  //    is a forged name (UPLOAD_KIND_NOT_ALLOWED, naming what was detected).
  let mime: string;
  let ext: string;
  const ebml = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  const base = sniff(head);
  if ((base && base.mime === 'video/mp4') || ebml) {
    const video = sniffVideo(head);
    if (video.ok) {
      mime = video.mime;
      ext = video.ext;
    } else if (video.reason === 'image_container' || video.reason === 'audio_only' || video.reason === 'not_video') {
      throw badRequest(
        'This video cannot be played in a browser — upload an MP4 (H.264, HEVC or AV1) or a WebM (VP8, VP9 or AV1) video.',
        'VIDEO_UNSUPPORTED',
        { reason: video.reason }
      );
    } else {
      // The head alone cannot always reach the track table (a phone's MP4
      // writes its index LAST); the container itself is proven, so the file is
      // stored as the video it declares and the fast-start hint says the rest.
      mime = ebml ? 'video/webm' : 'video/mp4';
      ext = ebml ? 'webm' : 'mp4';
    }
    if (mime === 'video/mp4' && !mp4IsFastStart(head)) warnings.push('VIDEO_NOT_FASTSTART');
  } else if (base) {
    mime = base.mime;
    ext = base.ext;
  } else {
    const cls = classifyAttachmentHead(head, s.file_name, size);
    if (!cls) {
      if (isHeifBytes(head)) throw badRequest(HEIF_REFUSAL, 'IMAGE_HEIC_UNSUPPORTED');
      throw badRequest('This file is not one of the formats accepted here', 'UPLOAD_KIND_NOT_ALLOWED', { declared: keyExt, detected: null });
    }
    mime = cls.mime;
    ext = cls.ext;
  }
  if (ext !== keyExt) {
    throw badRequest('The file\'s contents do not match its name', 'UPLOAD_KIND_NOT_ALLOWED', { declared: keyExt, detected: mime });
  }

  // 2. A ZIP IS BOUNDED BEFORE IT IS OPENED. The central directory declares
  //    every entry's inflated size; more entries than a model needs, a ratio
  //    no mesh reaches, or a total past the model ceiling, and the archive is
  //    refused without a byte of it inflated. ZIP64 is refused outright.
  if (ext === '3mf' || (ext === 'amf' && head[0] === 0x50 && head[1] === 0x4b)) {
    const eocd = zipEndOfDirectory(tail);
    if (eocd === null) throw tooDeep({ reason: 'no_directory' });
    if (eocd === 'zip64') throw tooDeep({ reason: 'zip64' });
    if (eocd.entries > ZIP_MAX_ENTRIES) throw tooDeep({ entries: eocd.entries, max_entries: ZIP_MAX_ENTRIES });
    if (eocd.cd_size > CENTRAL_DIRECTORY_CAP || eocd.cd_offset + eocd.cd_size > size) throw tooDeep({ reason: 'directory_out_of_bounds' });
    const directory = await readRange(env, visibility, key, eocd.cd_offset, eocd.cd_size);
    const totals = zipDirectoryTotals(directory, eocd.entries);
    if (!totals) throw tooDeep({ reason: 'directory_unreadable' });
    if (!zipWithinBounds(totals, kindLimitBytes(limits, 'model'))) throw tooDeep({ ...totals, max_entries: ZIP_MAX_ENTRIES });
  }

  // 3. A glTF IS JSON, PARSED WHOLE UNDER A CEILING OF ITS OWN.
  if (ext === 'gltf') {
    if (size > GLTF_JSON_CAP) throw badRequest('A glTF document may be at most 4 MB', 'UPLOAD_TOO_LARGE', { limit_bytes: GLTF_JSON_CAP });
    let ok = false;
    try {
      const doc = JSON.parse(new TextDecoder().decode(await readRange(env, visibility, key, 0, size))) as unknown;
      ok = !!doc && typeof doc === 'object' && 'asset' in (doc as Record<string, unknown>);
    } catch {
      ok = false;
    }
    if (!ok) throw badRequest('This glTF document cannot be read', 'UPLOAD_KIND_NOT_ALLOWED', { declared: 'gltf', detected: 'invalid json' });
  }

  // 4. THE CHECKSUM. The client hashed the file it chose; the object is what
  //    arrived. A difference — a file edited mid-upload, a part from another
  //    file, a corrupted transfer — is not stored under any name.
  const digest = await sha256OfObject(env, visibility, key);
  if (digest !== s.sha256) {
    throw badRequest('The file changed during the upload — its checksum does not match', 'CHECKSUM_MISMATCH', { declared: s.sha256, actual: digest });
  }

  // 5. WHAT THE CONSUMERS WANT TO KNOW: a picture's size, a model's measurements.
  let width: number | null = null;
  let height: number | null = null;
  if (mime.startsWith('image/')) {
    try {
      const dims = rasterDimensions(head, mime);
      width = dims?.width ?? null;
      height = dims?.height ?? null;
    } catch {
      // a JPEG whose frame header sits past the head: stored without dimensions
    }
  }
  let analysis: unknown;
  if (uploadKindForMime(mime) === 'model' && size <= ANALYSIS_MAX_BYTES) {
    try {
      analysis = analyseModel(await readRange(env, visibility, key, 0, size), s.file_name);
    } catch {
      analysis = undefined;
    }
  }
  return { mime, ext, width, height, warnings, analysis };
}

// ------------------------------------------------------------ the routes

export const uploadSessionRoutes = new Hono<AppContext>();
uploadSessionRoutes.use('*', requireAuth);

uploadSessionRoutes.post('/', async (c) => {
  await rateLimit(c, 'upload-session', 30, 3600);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const purpose = oneOf(body.purpose, 'purpose', SESSION_PURPOSES);
  const fileName = str(body.file_name, 'file_name', { min: 1, max: 200 });
  const declaredBytes = int(body.bytes, 'bytes', { min: 1, max: 1024 * 1024 * 1024 * 1024 });
  const declaredMime = typeof body.mime === 'string' ? body.mime.trim().slice(0, 120) : '';
  const sha256 = String(body.sha256 ?? '').trim().toLowerCase();
  if (!SHA256_RE.test(sha256)) throw badRequest('sha256 must be the 64 hex characters of the file\'s SHA-256 digest');

  // The name chooses a ceiling and a key prefix — nothing else. What the
  // bytes are is decided on complete.
  const named = uploadKindForName(fileName);
  if (!named || named.kind === 'archive' || !purposeAdmits(purpose, named.kind)) {
    throw badRequest('This kind of file is not accepted here', 'UPLOAD_KIND_NOT_ALLOWED', {
      extension: named?.ext ?? extensionOf(fileName),
      purpose,
    });
  }
  const limits = await getSetting(c.env.DB, 'uploadLimits');
  const limitBytes = kindLimitBytes(limits, named.kind);
  if (declaredBytes > limitBytes) {
    throw badRequest(`File is too large (max ${Math.round(limitBytes / MiB)} MB)`, 'UPLOAD_TOO_LARGE', { limit_bytes: limitBytes, kind: named.kind });
  }

  const entityId = await assertUploadEntity(c.env.DB, user, purpose, body.entity_id);
  if (purpose === 'request') await assertRequestFileRoom(c.env.DB, entityId);
  await assertQuota(c.env.DB, user.id, purpose, declaredBytes);

  const mime = mimeForExtension(named.ext);
  const placement = placementFor(purpose, named.kind, { userId: user.id, entityId, mime });
  const key = buildMediaKey({
    visibility: placement.visibility,
    domain: placement.domain,
    entityId: placement.entityId,
    kind: placement.kind,
    extension: named.ext,
    objectId: newId(),
  });
  const chunk = chunkBytesFor(limits);
  const partsTotalCount = Math.ceil(declaredBytes / chunk);
  if (partsTotalCount > MAX_PARTS) {
    throw badRequest('File is too large for this part size', 'UPLOAD_TOO_LARGE', { limit_bytes: MAX_PARTS * chunk, kind: named.kind });
  }
  const cacheControl = placement.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=300';
  const upload = await mediaBucket(c.env, placement.visibility).createMultipartUpload(key, {
    httpMetadata: { contentType: mime, cacheControl },
  });

  const id = newId('ups');
  const ts = nowIso();
  const expiresAt = new Date(Date.now() + Math.max(1, Math.floor(limits.session_hours)) * 3_600_000).toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO upload_sessions
         (id, owner_id, purpose, entity_id, file_name, declared_bytes, declared_mime, sha256, chunk_bytes,
          r2_upload_id, object_key, parts_json, state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'open', ?, ?, ?)`
    )
      .bind(id, user.id, purpose, entityId, safeFileName(fileName, named.ext), declaredBytes, declaredMime, sha256, chunk, upload.uploadId, key, expiresAt, ts, ts)
      .run();
  } catch (error) {
    // No row, no sweep will ever find this upload: it is aborted here, on the spot.
    await upload.abort().catch(() => undefined);
    throw error;
  }

  return c.json({ success: true, session_id: id, chunk_bytes: chunk, parts_total: partsTotalCount, expires_at: expiresAt }, 201);
});

uploadSessionRoutes.put('/:id/parts/:n', async (c) => {
  // A part is an R2 write and up to 40 MiB of ingress; the ceiling is the
  // hourly sessions × a 300 MB model's parts × a retry allowance.
  await rateLimit(c, 'upload-part', 3600, 3600);
  const user = c.get('user')!;
  const s = await loadOpenSession(c.env, c.req.param('id'), user.id);
  const n = int(c.req.param('n'), 'part number', { min: 1, max: MAX_PARTS });
  const total = partsTotal(s);
  if (n > total) throw badRequest(`This upload has ${total} part(s)`);
  const expected = expectedPartBytes(s, n);
  const partTooLarge = () =>
    badRequest(`Part ${n} must be ${expected} bytes`, 'UPLOAD_PART_TOO_LARGE', { chunk_bytes: s.chunk_bytes, expected_bytes: expected, part: n });

  // Refused on the declared length BEFORE the body is read, so an oversized
  // part is never buffered; the real length is checked again after.
  const declaredLen = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declaredLen) && declaredLen > s.chunk_bytes) throw partTooLarge();
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > expected) throw partTooLarge();
  if (body.byteLength !== expected) throw badRequest(`Part ${n} must be exactly ${expected} bytes`);

  let uploaded: { etag: string };
  try {
    uploaded = await resumeUpload(c.env, s).uploadPart(n, body);
  } catch (error) {
    // The upload is gone on the bucket's side — a `complete` that landed while
    // this part was in flight, or a sweep — so the session is closed to this
    // caller too: the same 404 every other closed-session path answers.
    const again = await c.env.DB.prepare('SELECT state FROM upload_sessions WHERE id = ?').bind(s.id).first<{ state: string }>();
    if (!again || again.state !== 'open') throw sessionNotFound();
    throw error;
  }
  const parts = await recordPart(c.env.DB, s, { n, etag: uploaded.etag, bytes: body.byteLength });
  return c.json({ success: true, received: parts.map((p) => p.n), bytes_so_far: bytesOf(parts), parts_total: total });
});

uploadSessionRoutes.get('/:id', async (c) => {
  await rateLimit(c, 'upload-session-read', 600, 3600);
  const user = c.get('user')!;
  const s = await loadSession(c.env.DB, c.req.param('id'), user.id);
  if (s.state === 'aborted' || s.state === 'expired') throw sessionNotFound();
  if (s.state === 'open' && s.expires_at <= nowIso()) {
    await expireSession(c.env, s);
    throw sessionNotFound();
  }
  return c.json({ success: true, ...sessionPublic(s) });
});

uploadSessionRoutes.post('/:id/complete', async (c) => {
  await rateLimit(c, 'upload-session-close', 120, 3600);
  const user = c.get('user')!;
  const s = await loadOpenSession(c.env, c.req.param('id'), user.id);
  const parts = parseParts(s.parts_json);
  const total = partsTotal(s);
  const have = new Set(parts.map((p) => p.n));
  const missing: number[] = [];
  for (let i = 1; i <= total; i++) if (!have.has(i)) missing.push(i);
  const bytesSoFar = bytesOf(parts);
  if (missing.length > 0 || bytesSoFar !== s.declared_bytes) {
    throw badRequest('Not every part of the file has arrived', 'UPLOAD_INCOMPLETE', {
      missing,
      bytes_so_far: bytesSoFar,
      declared_bytes: s.declared_bytes,
    });
  }

  const visibility = visibilityForKey(s.object_key);
  try {
    await resumeUpload(c.env, s).complete(parts.map((p) => ({ partNumber: p.n, etag: p.etag })));
  } catch (error) {
    throw badRequest('The storage could not assemble the parts — send the missing parts again', 'UPLOAD_INCOMPLETE', {
      missing: [],
      bytes_so_far: bytesSoFar,
      declared_bytes: s.declared_bytes,
      reason: String(error instanceof Error ? error.message : error).slice(0, 200),
    });
  }

  // FROM HERE THE OBJECT EXISTS, AND ANY REFUSAL DELETES IT: nothing below is
  // allowed to leave bytes in the bucket that no ledger row names.
  const limits = await getSetting(c.env.DB, 'uploadLimits');
  let verdict: Verdict;
  try {
    // The quota, asked again with this session left out of the count: two
    // sessions opened in the same instant both passed it once; only the first
    // to complete may land (UPLOAD_QUOTA_EXCEEDED for the other).
    await assertQuota(c.env.DB, s.owner_id, s.purpose, s.declared_bytes, { excludeSessionId: s.id });
    verdict = await inspectStoredObject(c.env, s, visibility, limits);
  } catch (error) {
    await deleteMediaObject(c.env, visibility, s.object_key).catch(() => undefined);
    await markSession(c.env.DB, s.id, 'aborted');
    throw error;
  }

  const domain = s.object_key.split('/')[0] as MediaDomain;
  const originalName = safeFileName(s.file_name, verdict.ext);
  await c.env.DB.prepare(
    `INSERT INTO file_objects
       (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, width, height, original_name, sha256, purpose)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET
       visibility = excluded.visibility, domain = excluded.domain, mime_type = excluded.mime_type,
       byte_size = excluded.byte_size, width = excluded.width, height = excluded.height,
       sha256 = excluded.sha256, purpose = excluded.purpose, deleted_at = NULL`
  )
    .bind(
      s.object_key, visibility, domain, s.owner_id, s.entity_id || s.owner_id, verdict.mime, s.declared_bytes,
      verdict.width, verdict.height, originalName, s.sha256, s.purpose
    )
    .run();

  // A request answers with its FILE ROW, the way the marketplace route does,
  // so the wizard lists it without ever holding a key.
  let file: Record<string, unknown> | null = null;
  if (s.purpose === 'request') {
    const kind = verdict.mime.startsWith('image/') ? 'reference' : verdict.mime === 'application/pdf' ? 'document' : 'model';
    const fileId = newId('crf');
    await c.env.DB.prepare(
      `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(fileId, s.entity_id, s.object_key, originalName, verdict.mime, s.declared_bytes, kind)
      .run();
    file = { id: fileId, file_name: originalName, content_type: verdict.mime, size_bytes: s.declared_bytes, kind };
  }

  await markSession(c.env.DB, s.id, 'completed');
  return c.json({
    success: true,
    ...(KEY_PURPOSES.has(s.purpose) ? { key: s.object_key } : {}),
    url: `/files/${s.object_key}`,
    visibility,
    mime: verdict.mime,
    bytes: s.declared_bytes,
    sha256: s.sha256,
    width: verdict.width,
    height: verdict.height,
    ...(verdict.analysis !== undefined ? { analysis: verdict.analysis } : {}),
    ...(verdict.warnings.length ? { warnings: verdict.warnings } : {}),
    ...(file ? { file } : {}),
  });
});

uploadSessionRoutes.delete('/:id', async (c) => {
  await rateLimit(c, 'upload-session-close', 120, 3600);
  const user = c.get('user')!;
  const s = await loadSession(c.env.DB, c.req.param('id'), user.id);
  if (s.state === 'open') {
    try {
      await resumeUpload(c.env, s).abort();
    } catch {
      // already gone on the bucket's side
    }
    await markSession(c.env.DB, s.id, 'aborted');
    return c.json({ success: true, state: 'aborted' });
  }
  return c.json({ success: true, state: s.state });
});

// ------------------------------------------------------------ the sweep

/**
 * THE CRON'S SHARE (worker/index.ts `scheduled`): open sessions past
 * `expires_at` are aborted on the bucket — their parts stop costing storage —
 * and expired in the ledger, at most `limit` per tick; rows nobody can resume
 * any more are deleted a week after they closed. Idempotent under overlap:
 * an abort of an upload already gone is a no-op, and the expire is fenced on
 * `state = 'open'`.
 */
export async function sweepExpiredUploadSessions(
  env: Env,
  now: string = nowIso(),
  limit = 200
): Promise<{ expired: number; deleted: number }> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM upload_sessions WHERE state = 'open' AND expires_at <= ? ORDER BY expires_at LIMIT ?`
  )
    .bind(now, limit)
    .all<SessionRow>();
  let expired = 0;
  for (const s of results) {
    try {
      await resumeUpload(env, s).abort();
    } catch {
      // an upload R2 has already dropped
    }
    if (await markSession(env.DB, s.id, 'expired')) expired += 1;
  }
  const cutoff = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const deleted = await env.DB.prepare(
    `DELETE FROM upload_sessions WHERE id IN (
       SELECT id FROM upload_sessions WHERE state IN ('completed', 'aborted', 'expired') AND updated_at < ? LIMIT ?)`
  )
    .bind(cutoff, limit)
    .run();
  return { expired, deleted: deleted.meta?.changes ?? 0 };
}
