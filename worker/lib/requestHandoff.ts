/**
 * A FILE COPIED INTO A REQUEST FROM ELSEWHERE ON LEVONIS — a project's
 * downloadable files and its cover picture, a store product's cover picture
 * (plan P1-06, docs/DECISIONS.md row 268; GAP-MAP conflict 5).
 *
 * THE REQUEST OWNS ITS COPY. Every file becomes a NEW private object under
 * `requests/<customer>/`, a new `file_objects` row carrying its sha256 and
 * `purpose = 'request'`, a request file row, and a source row whose `origin_*`
 * says where it came from (`origin_id` the post or product, `origin_ref` the
 * file, `origin_hash` the sha256 it was copied with). `origin_*` is provenance
 * and nothing more: nothing ever follows it to read a byte, so the author
 * renaming, replacing or deleting the file — or the post — leaves the request
 * exactly as it was (acceptance 20).
 *
 * THE SAME RULES AS THE UPLOAD DOORS (worker/routes/marketplace.ts whole-body,
 * worker/routes/uploadSessions.ts session), asked before a byte is written:
 *   the name's extension is one a request takes (`requestFileKind`) and is
 *   what the bytes are (the head classified as the session classifies it);
 *   the size fits the kind's ceiling;
 *   the customer's request-storage quota (`assertQuota`);
 *   the request still takes files and has room (`assertRequestTakesFiles`),
 *   and the row itself is written by the guarded insert in one batch with its
 *   ledger row and its source row, so a seventh file never lands.
 *
 * STREAMED, NEVER HELD. The object is piped into the bucket through a
 * `FixedLengthStream` (R2 refuses a stream of unknown length), then hashed
 * from the bucket with the session door's streaming `sha256OfObject` and
 * compared with the digest the source's own ledger row holds. A difference
 * (the author replaced the file mid-copy) deletes the copy and its ledger row
 * and answers COPY_CHANGED. Outside the Worker (unit tests) the stream is
 * buffered instead, the only place it is.
 *
 * A REFUSAL IS A SKIP, NOT A FAILURE. Each file answers ok or the code it was
 * skipped for (COPY_MISSING, COPY_KIND, COPY_TOO_LARGE, COPY_CHANGED,
 * REQUEST_FILES_FULL, UPLOAD_QUOTA_EXCEEDED…), so one file never stops the
 * others and the editor can name each one with «أعد المحاولة».
 */
import type { Env } from './types';
import { HttpError } from './http';
import { newId } from './crypto';
import { deleteMediaObject, getMediaObject, headMediaObject, putMediaObject, type MediaVisibility } from './mediaStorage';
import { canonicalExtension, classifyAttachmentHead, classifyRequestFile, storedRequestFileName } from './attachments';
import { assertQuota } from './uploadEntity';
import { assertRequestTakesFiles } from './requestFileRoom';
import { afterRequestFileAdded, insertRequestFile, outliveClient } from './requestFileHooks';
import { sha256OfObject } from '../routes/uploadSessions';
import { requestFileExtension, requestFileKind, requestFileMaxBytes } from '../../packages/contracts/src/requestFiles';

/** How much of the head the kind is read from — the session door's own window. */
const HEAD_BYTES = 64 * 1024;

export interface CopySource {
  visibility: MediaVisibility;
  key: string;
  /** The name it is stored and shown under (its extension is asked like an upload's). */
  name: string;
  /** The source's own sha256, from its ledger row; '' when it has none (then the copy's digest is recorded unchecked). */
  expectedSha256: string;
  /** `project_post` for a project's file or cover; `file` for a product's cover (a reference picture). */
  sourceKind: 'project_post' | 'file';
  origin: { id: string; ref: string; meta: Record<string, string> };
}

export type CopyOutcome =
  | { ok: true; fileId: string; sourceId: string; sha256: string; kind: string; name: string }
  | { ok: false; code: string };

type FixedLengthStreamCtor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

/** The ledger digest of a stored object, '' when it has none or the column does not exist. */
export async function ledgerSha256(db: D1Database, key: string): Promise<string> {
  try {
    const row = await db.prepare('SELECT sha256 FROM file_objects WHERE object_key = ?').bind(key).first<{ sha256: string | null }>();
    const v = String(row?.sha256 ?? '');
    return /^[0-9a-f]{64}$/.test(v) ? v : '';
  } catch {
    return '';
  }
}

const codeOf = (e: unknown, fallback: string): string => (e instanceof HttpError && e.code ? e.code : fallback);

/**
 * Copy one object into one request (see the header). `waitUntil` carries the
 * hooks of a new file (revision, notices, re-match) past a dropped client.
 */
export async function copyIntoRequest(
  env: Env,
  p: {
    requestId: string;
    customerId: string;
    source: CopySource;
    position: number;
    primary?: boolean;
    waitUntil?: (work: Promise<unknown>) => void;
    actor: { id: string; name?: string | null; username?: string | null };
  }
): Promise<CopyOutcome> {
  const src = p.source;
  const named = requestFileKind(src.name);
  if (!named) return { ok: false, code: 'COPY_KIND' };
  const head = await headMediaObject(env, src.visibility, src.key).catch(() => null);
  if (!head) return { ok: false, code: 'COPY_MISSING' };
  const size = Number(head.size ?? 0);
  if (!(size > 0)) return { ok: false, code: 'COPY_MISSING' };
  if (size > requestFileMaxBytes(named)) return { ok: false, code: 'COPY_TOO_LARGE' };

  // THE BYTES NAME THE FORMAT, as the session door decides it from the head.
  const first = await getMediaObject(env, src.visibility, src.key, { range: { offset: 0, length: Math.min(HEAD_BYTES, size) } });
  if (!first) return { ok: false, code: 'COPY_MISSING' };
  const headBytes = new Uint8Array(await first.arrayBuffer());
  const cls = classifyAttachmentHead(headBytes, src.name, size) ?? classifyRequestFile(headBytes, src.name);
  if (!cls || cls.ext !== canonicalExtension(requestFileExtension(src.name))) return { ok: false, code: 'COPY_KIND' };

  try {
    await assertQuota(env.DB, p.customerId, 'request', size);
    await assertRequestTakesFiles(env.DB, p.requestId, p.customerId);
  } catch (e) {
    return { ok: false, code: codeOf(e, 'COPY_FAILED') };
  }

  const key = `requests/${p.customerId}/${newId()}.${cls.ext}`;
  const whole = await getMediaObject(env, src.visibility, src.key);
  if (!whole) return { ok: false, code: 'COPY_MISSING' };
  const FixedLengthStream = (globalThis as unknown as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
  const body: ReadableStream | Uint8Array = FixedLengthStream
    ? whole.body.pipeThrough(new FixedLengthStream(size))
    : new Uint8Array(await whole.arrayBuffer());
  const name = storedRequestFileName(src.name, cls.ext);
  const dropCopy = async () => {
    await deleteMediaObject(env, 'private', key).catch(() => undefined);
    await env.DB.prepare('DELETE FROM file_objects WHERE object_key = ?').bind(key).run().catch(() => undefined);
  };
  try {
    await putMediaObject(
      env,
      { key, visibility: 'private', domain: 'requests', mime: cls.mime, bytes: size, ownerId: p.customerId, entityId: p.requestId, originalName: name },
      body,
      { httpMetadata: { contentType: cls.mime, cacheControl: 'private, max-age=0' } }
    );
  } catch {
    await dropCopy();
    return { ok: false, code: 'COPY_FAILED' };
  }

  // THE COPY IS WHAT WAS PUBLISHED, or it is not kept.
  let sha256: string;
  try {
    sha256 = await sha256OfObject(env, 'private', key);
  } catch {
    await dropCopy();
    return { ok: false, code: 'COPY_FAILED' };
  }
  if (src.expectedSha256 && sha256 !== src.expectedSha256) {
    await dropCopy();
    return { ok: false, code: 'COPY_CHANGED' };
  }

  const kind = cls.mime.startsWith('image/') ? 'reference' : cls.mime === 'application/pdf' ? 'document' : 'model';
  const fileId = newId('crf');
  const sourceId = `rps_${fileId}`;
  const added = { id: fileId, requestId: p.requestId, ownerId: p.customerId, key, name, mime: cls.mime, bytes: size, kind };
  // The session door's ledger upsert (uploadSessions.ts): the row `putMediaObject`
  // wrote gains the digest and the purpose, so the bytes count against the quota.
  const ledger = env.DB.prepare(
    `INSERT INTO file_objects
       (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, original_name, sha256, purpose)
     VALUES (?, 'private', 'requests', ?, ?, ?, ?, ?, ?, 'request')
     ON CONFLICT(object_key) DO UPDATE SET
       visibility = excluded.visibility, domain = excluded.domain, mime_type = excluded.mime_type,
       byte_size = excluded.byte_size, sha256 = excluded.sha256, purpose = excluded.purpose, deleted_at = NULL`
  ).bind(key, p.customerId, p.requestId, cls.mime, size, name, sha256);
  const sourceRow = env.DB.prepare(
    `INSERT INTO community_request_sources
       (id, request_id, kind, file_id, sha256, role, origin_id, origin_ref, origin_hash, origin_meta, is_primary, position)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`
  ).bind(
    sourceId, p.requestId, src.sourceKind, fileId, sha256,
    src.origin.id, src.origin.ref, sha256, JSON.stringify(src.origin.meta),
    p.primary ? 1 : 0, Math.max(0, p.position)
  );
  try {
    await insertRequestFile(env.DB, added, [ledger, sourceRow]);
  } catch (e) {
    await dropCopy();
    return { ok: false, code: codeOf(e, 'COPY_FAILED') };
  }
  // The same hooks as both upload doors, out of a dropped client's reach.
  await outliveClient(p.waitUntil, afterRequestFileAdded(env, added, p.actor, null));
  return { ok: true, fileId, sourceId, sha256, kind, name };
}
