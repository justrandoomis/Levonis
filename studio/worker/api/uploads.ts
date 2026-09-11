/**
 * PUT /api/uploads/:fileId — the UPLOAD step of the revision protocol
 * (docs/STUDIO_PLAN.md decision 4, step 2).
 *
 * The file row was created at OPEN with a server-generated R2 key and the
 * client's declared sha256/size. This endpoint:
 *   1. resolves fileId → revision → project and verifies the SESSION OWNER
 *      (an unguessable id is not an authorization — T3),
 *   2. requires the revision to still be 'pending',
 *   3. streams the body into R2 while hashing it (Cloudflare DigestStream +
 *      FixedLengthStream when available; a buffered fallback keeps the same
 *      semantics on runtimes without them, e.g. the node test harness),
 *   4. flips the row to 'verified' ONLY when both size and sha256 match the
 *      OPEN declaration; a mismatched object is deleted, never kept.
 *
 * Retries are safe/idempotent: re-PUT of an already-verified file returns
 * 200 without touching the stored object; a failed attempt leaves the row
 * 'pending' so the client can try again (or the cleanup cron reclaims it).
 */
import type { StudioSession } from "../auth/session";
import { type StudioApiEnv, apiError, jsonResponse, isValidId, methodNotAllowed, toHex } from "./router";
import type { FileRow } from "./projects";

interface DigestStreamLike extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
}
type DigestStreamCtor = new (algorithm: string) => DigestStreamLike;
type FixedLengthStreamCtor = new (length: number) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

function cfStreamPrimitives(): { Digest: DigestStreamCtor; Fixed: FixedLengthStreamCtor } | null {
  const g = globalThis as unknown as { FixedLengthStream?: FixedLengthStreamCtor };
  const c = crypto as unknown as { DigestStream?: DigestStreamCtor };
  if (typeof g.FixedLengthStream === "function" && typeof c.DigestStream === "function") {
    return { Digest: c.DigestStream, Fixed: g.FixedLengthStream };
  }
  return null;
}

type StoreResult = "ok" | "size" | "hash";

/**
 * Streams `body` into `key` while hashing; verifies size + sha256 against the
 * OPEN declaration. On any mismatch the R2 object is removed and the verdict
 * reported — a wrong object is never left behind as if it were verified.
 */
async function storeVerified(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array> | null,
  expectedSize: number,
  expectedSha256: string,
  contentType: string | null
): Promise<StoreResult> {
  const httpMetadata = contentType ? { contentType } : undefined;
  const cf = cfStreamPrimitives();

  if (cf && body) {
    const digest = new cf.Digest("SHA-256");
    const fixed = new cf.Fixed(expectedSize);
    const putPromise = bucket.put(key, fixed.readable, { httpMetadata });
    const digestWriter = digest.getWriter();
    const fixedWriter = fixed.writable.getWriter();
    const reader = body.getReader();
    let total = 0;
    let failed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > expectedSize) {
          failed = true;
          break;
        }
        await Promise.all([digestWriter.write(value), fixedWriter.write(value)]);
      }
    } catch {
      failed = true;
    }
    if (failed || total !== expectedSize) {
      await Promise.allSettled([
        digestWriter.abort("aborted"),
        fixedWriter.abort("aborted"),
        reader.cancel("aborted"),
        putPromise.catch(() => {}),
      ]);
      await bucket.delete(key).catch(() => {});
      return "size";
    }
    await Promise.all([digestWriter.close(), fixedWriter.close()]);
    try {
      await putPromise;
    } catch {
      await bucket.delete(key).catch(() => {});
      return "size";
    }
    const actual = toHex(await digest.digest);
    if (actual !== expectedSha256) {
      await bucket.delete(key).catch(() => {});
      return "hash";
    }
    return "ok";
  }

  // Fallback path (no CF stream primitives): buffer, verify, then store —
  // nothing reaches R2 before verification here.
  const buf = new Uint8Array(await new Response(body).arrayBuffer());
  if (buf.byteLength !== expectedSize) return "size";
  const actual = toHex(await crypto.subtle.digest("SHA-256", buf));
  if (actual !== expectedSha256) return "hash";
  await bucket.put(key, buf, { httpMetadata });
  return "ok";
}

interface UploadTargetRow extends FileRow {
  revision_state: "pending" | "committed" | "abandoned";
  project_id: string;
  owner_id: string;
  deleted_at: string | null;
}

export async function handleUploadRoute(
  request: Request,
  env: StudioApiEnv,
  session: StudioSession,
  fileId: string
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed("PUT");
  if (!isValidId(fileId)) return apiError(404, "NOT_FOUND", "Not found");
  if (!env.BUCKET) {
    return apiError(503, "STORAGE_NOT_CONFIGURED", "Project file storage (R2) is not configured on this deployment.");
  }

  // Ownership is checked on the WRITE path too — the fileId being hard to
  // guess is not an authorization (mandate §4, T3).
  const row = await env.DB.prepare(
    `SELECT f.*, r.state AS revision_state, r.project_id AS project_id, p.owner_id AS owner_id, p.deleted_at AS deleted_at
       FROM project_files f
       JOIN project_revisions r ON r.id = f.revision_id
       JOIN projects p ON p.id = r.project_id
      WHERE f.id = ?`
  )
    .bind(fileId)
    .first<UploadTargetRow>();
  if (!row || row.owner_id !== session.user.id || row.deleted_at) {
    return apiError(404, "NOT_FOUND", "Not found");
  }

  // Idempotent retry: the file already completed a verified upload.
  if (row.state === "verified") {
    try {
      await request.body?.cancel();
    } catch {
      /* ignore */
    }
    return jsonResponse({ success: true, already: true, file_id: fileId, state: "verified" });
  }

  if (row.revision_state !== "pending") {
    return apiError(409, "REVISION_NOT_OPEN", "This revision no longer accepts uploads", {
      revision_state: row.revision_state,
    });
  }

  // Fast size guard before consuming the body.
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declared = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(declared) || declared !== row.size_bytes) {
      return apiError(400, "SIZE_MISMATCH", "Content-Length does not match the declared size_bytes", {
        expected: row.size_bytes,
      });
    }
  }

  const verdict = await storeVerified(
    env.BUCKET,
    row.r2_key,
    request.body,
    row.size_bytes,
    row.sha256,
    row.content_type
  );
  if (verdict === "size") {
    return apiError(400, "SIZE_MISMATCH", "Uploaded bytes do not match the declared size_bytes", {
      expected: row.size_bytes,
    });
  }
  if (verdict === "hash") {
    // 422: well-formed request, wrong content. Row stays 'pending' for retry.
    return apiError(422, "HASH_MISMATCH", "Uploaded content does not match the declared sha256");
  }

  await env.DB.prepare(`UPDATE project_files SET state = 'verified' WHERE id = ? AND state = 'pending'`)
    .bind(fileId)
    .run();

  return jsonResponse({ success: true, file_id: fileId, state: "verified", size_bytes: row.size_bytes });
}
