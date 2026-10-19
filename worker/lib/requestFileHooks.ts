/**
 * ONE FILE ON A REQUEST, WHICHEVER DOOR IT CAME THROUGH (Community V3 R2,
 * docs/DECISIONS.md row 258).
 *
 * A request's attachment arrives through one of two doors: the whole-body
 * route (`POST /api/marketplace/requests/:id/files`, worker/routes/
 * marketplace.ts) and the resumable session's `complete` (worker/routes/
 * uploadSessions.ts). Until row 258 only the first did what a new file on a
 * PUBLISHED job means — revise it, supersede the offers priced without the
 * file, tell the workshops, decide the match again — and neither re-checked
 * the request at the moment the row was written. Both doors now run THESE
 * functions, so they cannot drift again:
 *
 *   assertRequestTakesFiles  (worker/lib/uploadEntity.ts) the request is the
 *                            caller's, still takes files and has room
 *   insertRequestFile        the row, GUARDED in SQL by the same three facts,
 *                            in one batch with the revision, the supersede
 *                            and the re-match's queue row
 *   afterRequestFileAdded    record the revision, notify, re-match, and only
 *                            THEN measure a model (stored the way /analyze
 *                            stores it) — never throws: the file has landed
 *   outliveClient            the chain under `waitUntil` AND awaited, so a
 *                            dropped connection cannot cut it off
 *   measureAfterResponse     the whole-body door's measurement, after its
 *                            answer, holding one copy of the bytes
 *   measureRequestModel      the measurement and the viewer mesh on the file
 *                            row — /analyze's own writer
 *   readModelWithin          a stored model's bytes, or null past the cap,
 *                            without ever buffering more than the cap (R3)
 */
import type { Env } from './types';
import { conflict } from './http';
import { putMediaObject } from './mediaStorage';
import { analyseModel, viewerMesh, type ModelAnalysis } from './modelGeometry';
import { MAX_FILES_PER_REQUEST, REQUEST_FILE_STATES, assertRequestTakesFiles } from './requestFileRoom';
import { offerCountStatement, staleOfferNotifications } from './communityRequests';
import { composeSnapshot, recordRevisionStatement, reviseIfOfferedStatement, supersedeStatement } from './requestRevisions';
import { notifyGrouped, peopleAr, stampGroupedCkb } from './notifications';
import { enqueuePublishedRequestStatement, rematchNow } from './printMatchingStore';
import { merchantHref } from '@levonis/contracts/merchantRoutes';
import { merchantPublicSql, withApprovalSchema } from './merchantApproval';
import { writeRequestSystemUpdate } from '../routes/requestDiscussion';

const MiB = 1024 * 1024;
const nowIso = () => new Date().toISOString();

/**
 * THE LARGEST MODEL MEASURED IN A WORKER (R3). The session door has always
 * stopped here; `/analyze` read whatever the object held — up to the 300 MB
 * session ceiling — into a 128 MB Worker. Above it a model is kept and sent to
 * the workshops as a reference, and the customer types an approximate size.
 */
export const MEASURE_MAX_BYTES = 40 * MiB;

/** What `/analyze` answers above the cap: a clean «measure later — reference only», never a 500. */
export const MEASURE_LATER_CODE = 'MODEL_MEASURE_LATER';

/**
 * A PUBLISHED JOB'S ATTACHMENTS CHANGED (migrations 0116, 0130). If a merchant
 * has a pending offer on the current revision, the revision moves and those
 * offers are superseded — in the same batch as the file row. If nobody has
 * priced it, the revision stays and its snapshot is rewritten afterwards
 * (`recordFilesRevision`). Conditional on the request taking offers, so a
 * DRAFT (the wizard uploading its files) revises nothing.
 */
export function reviseStatements(db: D1Database, requestId: string, ts: string): D1PreparedStatement[] {
  return [
    reviseIfOfferedStatement(db, requestId, ts),
    supersedeStatement(db, requestId, ts),
    offerCountStatement(db, requestId),
  ];
}

/**
 * After an attachment change on a published job: record the revision as it
 * now stands, and tell every merchant whose offer it superseded. Never throws —
 * the file change itself has already committed.
 */
export async function afterFilesChanged(db: D1Database, requestId: string, userId: string): Promise<void> {
  try {
    const row = await db
      .prepare(`SELECT revision FROM community_requests WHERE id = ? AND state IN ('open','receiving_offers')`)
      .bind(requestId)
      .first<{ revision: number }>();
    if (!row) return;
    const snap = await composeSnapshot(db, requestId);
    const stmts = await staleOfferNotifications(db, requestId, Number(row.revision));
    if (snap) stmts.unshift(recordRevisionStatement(db, requestId, snap, 'files', userId, nowIso()));
    if (stmts.length) await db.batch(stmts);
    // «تغيّر الطلب» in the discussion (§9.5) — after the revision committed.
    if (snap) await writeRequestSystemUpdate(db, requestId, 'revised', { change: 'files', revision: Number(row.revision) });
  } catch (e) {
    console.error('revision after a file change not recorded for', requestId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * A PUBLISHED JOB'S FILES CHANGED: its verdicts are decided again (W5-B) — a
 * new model may be bigger than it was, and a new revision retires the old
 * verdicts. Inline and bounded, with a queue row the sweep finishes if this
 * pass cannot; never throws.
 */
export async function rematchAfterFiles(env: Env, requestId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM community_requests WHERE id = ? AND state IN ('open','receiving_offers')`)
    .bind(requestId)
    .first()
    .catch(() => null);
  if (row) await rematchNow(env, 'request', requestId, 'files');
}

/**
 * «أضاف سارة ملفات إلى الطلب» — GROUPED FILE NOTIFICATIONS TO THE WORKSHOPS
 * (0158, docs/COMMUNITY_ECOSYSTEM.md §9.4). The merchants ON A REQUEST'S
 * MATCHES hear that its files changed: the owners of the workshops the
 * eligibility engine marked eligible (`community_request_matches`) and of
 * those standing behind a live offer — never the whole workshop list, and
 * never the customer's own account. ONE row per owner keyed
 * `request_files:<requestId>` (`notifyGrouped`, counted by people like every
 * grouped kind), the Sorani stamped into `meta` after the count is known.
 * Never throws: the file is stored whatever the bell does.
 */
export async function notifyRequestFiles(
  db: D1Database,
  requestId: string,
  actor: { id: string; name?: string | null; username?: string | null }
): Promise<void> {
  try {
    const req = await db.prepare('SELECT title FROM community_requests WHERE id = ?').bind(requestId).first<{ title: string }>();
    // E7 (push 1.4): a MATCH alone tells only a workshop the public may see and
    // that is active — a verdict row from before the gate still reads eligible
    // for a merchant no reviewer approved, and the re-match leaves it alone. An
    // OFFER is existing work: its merchant is told whatever their approval.
    // On a database without 0204 the match branch is closed (C11).
    const { results } = await withApprovalSchema((schema) =>
      db
        .prepare(
          `SELECT DISTINCT m.user_id FROM community_merchants m
            WHERE m.user_id <> ?1 AND (
              (m.status = 'active' AND ${merchantPublicSql('m', schema)}
                AND m.id IN (SELECT rm.merchant_id FROM community_request_matches rm WHERE rm.request_id = ?2 AND rm.eligible = 1))
              OR m.id IN (SELECT o.merchant_id FROM community_offers o WHERE o.request_id = ?2 AND o.state IN ('pending','superseded','accepted'))
            )`
        )
        .bind(actor.id, requestId)
        .all<{ user_id: string }>()
    );
    const title = String(req?.title ?? '').trim();
    const name = actor.name || actor.username || '';
    const aboutAr = title ? ` «${title}»` : '';
    const aboutEn = title ? ` “${title}”` : '';
    for (const r of results ?? []) {
      const written = await notifyGrouped(db, {
        userId: String(r.user_id),
        kind: 'request_files',
        groupKey: `request_files:${requestId}`,
        actor: { id: actor.id, name },
        title: (n, a) => ({
          ar: n === 1 ? `أضاف ${a} ملفات إلى الطلب${aboutAr}` : `أضاف ${peopleAr(n)} ملفات إلى الطلب${aboutAr}`,
          en: n === 1 ? `${a} added files to the request${aboutEn}` : `${n} people added files to the request${aboutEn}`,
        }),
        body: { ar: 'راجع الملفات الجديدة قبل تأكيد عرضك.', en: 'Review the new files before you confirm your offer.' },
        link: merchantHref.request(requestId),
        entity_type: 'request',
        entity_id: requestId,
      });
      if (written) {
        await stampGroupedCkb(db, written.id, {
          title_ckb:
            written.count === 1
              ? `${name} فایلی زیاد کرد بۆ داواکارییەکە${aboutAr}`
              : `${written.count} کەس فایلیان زیاد کرد بۆ داواکارییەکە${aboutAr}`,
          body_ckb: 'پێش پشتڕاستکردنەوەی ئۆفەرەکەت فایلە نوێیەکان بپشکنە.',
        });
      }
    }
  } catch (e) {
    console.error('request file notice not written for', requestId, e instanceof Error ? e.message : String(e));
  }
}

/** One attachment row, as either door has proven it. */
export interface NewRequestFile {
  id: string;
  requestId: string;
  /** The uploader — who must still be the request's customer when the row lands. */
  ownerId: string;
  key: string;
  name: string;
  mime: string;
  bytes: number;
  kind: string;
}

/**
 * THE ROW, GUARDED WHERE IT IS WRITTEN. The request must still be the
 * uploader's, still take files (`REQUEST_FILE_STATES`) and still have room
 * (`MAX_FILES_PER_REQUEST`) — asked in the INSERT itself, so a session opened
 * before an acceptance, or two doors racing for the sixth slot, cannot slip a
 * file past the check the route ran a moment earlier. When any of the three
 * fails, `request_id` is NULL, its NOT NULL constraint aborts the WHOLE batch
 * (the revision, the supersede and whatever the caller added go with it) and
 * the refusal is read back by `assertRequestTakesFiles`.
 */
/** The abort the guard raises: the NULL it writes into `request_id`. */
const GUARD_ABORT = /NOT NULL constraint failed: community_request_files\.request_id/i;

function guardedInsertStatement(db: D1Database, f: NewRequestFile): D1PreparedStatement {
  const states = [...REQUEST_FILE_STATES].map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  return db
    .prepare(
      `INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind)
       VALUES (?1,
               CASE WHEN EXISTS (SELECT 1 FROM community_requests r
                                  WHERE r.id = ?2 AND r.customer_id = ?3 AND r.state IN (${states}))
                     AND (SELECT COUNT(*) FROM community_request_files x WHERE x.request_id = ?2) < ?4
                    THEN ?2 END,
               ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(f.id, f.requestId, f.ownerId, MAX_FILES_PER_REQUEST, f.key, f.name, f.mime, f.bytes, f.kind);
}

/**
 * Write one attachment row — and, in the SAME batch, revise a published job
 * so every offer priced without this file is superseded until its merchant
 * re-confirms. `alongside` rides in the batch too (the session door's ledger
 * row and its «completed»), so a refusal leaves none of it behind. Throws
 * REQUEST_NOT_EDITABLE, REQUEST_FILES_FULL or 404 when the request no longer
 * takes the file; the caller deletes the object it stored.
 *
 * The re-match's queue row rides in the same batch (published jobs only): once
 * the offers are superseded, the sweep finishes the re-match even if this
 * invocation never reaches `rematchNow` (DECISIONS row 258).
 */
export async function insertRequestFile(
  db: D1Database,
  f: NewRequestFile,
  alongside: D1PreparedStatement[] = []
): Promise<void> {
  const ts = nowIso();
  try {
    await db.batch([
      guardedInsertStatement(db, f),
      ...alongside,
      ...reviseStatements(db, f.requestId, ts),
      enqueuePublishedRequestStatement(db, f.requestId, 'files', ts),
    ]);
  } catch (e) {
    // Only the GUARD's own abort is read as a refusal; any other failure (a
    // ledger CHECK, an outage) is what it is, and the caller cleans up.
    if (!GUARD_ABORT.test(e instanceof Error ? e.message : String(e))) throw e;
    await assertRequestTakesFiles(db, f.requestId, f.ownerId);
    // The guard failed and the facts read back fine: the request moved
    // between the two reads. The caller refreshes and tries again.
    throw conflict('This request changed while the file was arriving — try again', 'REQUEST_CHANGED');
  }
}

/**
 * MEASURE A MODEL AND STORE THE ANSWER ON ITS FILE ROW — what `/analyze` has
 * always written: the analysis, the format, and the viewer mesh derived once
 * and stored beside the original under a prefix `/files/*` refuses, so the
 * viewer route never parses and never touches the customer's file. `analysis`
 * is the one already computed (the session door measured while proving the
 * file), so a model is never parsed twice.
 */
export async function measureRequestModel(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  p: { requestId: string; fileId: string; fileName: string; ownerId: string; bytes: Uint8Array; analysis?: ModelAnalysis }
): Promise<ModelAnalysis> {
  const analysis = p.analysis ?? analyseModel(p.bytes, p.fileName);
  let previewKey = '';
  if (analysis.capability.previewable) {
    const mesh = viewerMesh(p.bytes, p.fileName);
    if (mesh) {
      previewKey = `request-previews/${p.requestId}/${p.fileId}.lvm`;
      await putMediaObject(
        env,
        {
          key: previewKey,
          visibility: 'private',
          domain: 'print-requests',
          mime: 'application/octet-stream',
          bytes: mesh.byteLength,
          ownerId: p.ownerId,
          entityId: p.requestId,
        },
        mesh,
        { httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, max-age=0' } }
      );
    }
  }
  await env.DB.prepare(
    `UPDATE community_request_files
        SET analysis = ?, model_format = ?, preview_key = ?,
            analysed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND request_id = ?`
  )
    .bind(JSON.stringify(analysis), analysis.format, previewKey, p.fileId, p.requestId)
    .run();
  return analysis;
}

type AddedRequestFile = Pick<NewRequestFile, 'id' | 'requestId' | 'ownerId' | 'name' | 'kind'>;
type MeasureEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;
type WaitUntil = ((p: Promise<unknown>) => void) | undefined;

/**
 * A model that came with its bytes (≤ MEASURE_MAX_BYTES) is measured and its
 * answer stored on the row, so the wizard's `/analyze` answers from the row.
 * Never throws: `/analyze` measures it on the wizard's next pass.
 */
export async function measureOnArrival(
  env: MeasureEnv,
  f: AddedRequestFile,
  model?: { bytes: Uint8Array; analysis?: ModelAnalysis } | null
): Promise<void> {
  if (f.kind !== 'model' || !model || model.bytes.byteLength > MEASURE_MAX_BYTES) return;
  try {
    await measureRequestModel(env, {
      requestId: f.requestId,
      fileId: f.id,
      fileName: f.name,
      ownerId: f.ownerId,
      bytes: model.bytes,
      analysis: model.analysis,
    });
  } catch (e) {
    console.error('request model not measured on upload for', f.requestId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * EVERYTHING A NEW ATTACHMENT MEANS, after its row committed — the same for
 * both doors, in the same order, what the commit means FIRST:
 *   1. a published job records the revision and tells the merchants whose
 *      offers it superseded (`afterFilesChanged`);
 *   2. the workshops on its matches hear «أضاف … ملفات», grouped (0158) —
 *      BEFORE the re-match: the ones who were weighing the job as it stood
 *      are the ones the change concerns; a workshop the new file makes
 *      eligible gets the engine's own «طلب يناسب ورشتك» from the re-match;
 *   3. the re-match (its queue row committed with the file, so the sweep
 *      finishes it if this pass never ends);
 *   4. LAST, the measurement — the slowest step, and the only one a memory
 *      limit can kill outright. Nothing above needs it: the revision and the
 *      matcher read the request's own analysis, never the file row's.
 * Never throws: the file is stored whatever the bell or the parser does.
 */
export async function afterRequestFileAdded(
  env: Env,
  f: AddedRequestFile,
  actor: { id: string; name?: string | null; username?: string | null },
  model?: { bytes: Uint8Array; analysis?: ModelAnalysis } | null
): Promise<void> {
  await afterFilesChanged(env.DB, f.requestId, f.ownerId);
  await notifyRequestFiles(env.DB, f.requestId, actor);
  await rematchAfterFiles(env, f.requestId);
  await measureOnArrival(env, f, model);
}

/**
 * THE HOOKS OUTLIVE THE CLIENT. A request's pending work is cancelled when
 * its client disconnects — a customer on mobile data, the case the session
 * door exists for — unless it was handed to `waitUntil`. Once the batch has
 * committed (the revision moved, the offers superseded) the chain is handed
 * there AND awaited: the answer still reports a file whose notices are sent,
 * and a dropped connection cannot leave a superseded offer with nobody told.
 * Without an execution context (a unit test) it is simply awaited.
 */
export async function outliveClient(waitUntil: WaitUntil, work: Promise<void>): Promise<void> {
  waitUntil?.(work);
  await work;
}

/**
 * THE WHOLE-BODY DOOR MEASURES AFTER ITS ANSWER. While its handler runs it
 * holds the upload twice — the multipart File and the copy it classified —
 * and a 40 MiB model parsed on top of both (twice: the analysis and the
 * viewer mesh) passes a Worker's 128 MB, a kill no try/catch sees. So the
 * door answers first, and this runs under `waitUntil` a timer turn after the
 * handler returned, holding nothing but `bytes` — /analyze's own footprint.
 * Without an execution context nothing is measured here; `/analyze` does it
 * when it is asked.
 */
export function measureAfterResponse(waitUntil: WaitUntil, env: MeasureEnv, f: AddedRequestFile, bytes: Uint8Array): void {
  if (!waitUntil || f.kind !== 'model' || bytes.byteLength > MEASURE_MAX_BYTES) return;
  waitUntil(
    (async () => {
      // A timer, not a microtask: the parse starts once the handler — and the
      // FormData only it referenced — is gone.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await measureOnArrival(env, f, { bytes });
    })()
  );
}

/**
 * A STORED MODEL'S BYTES, OR NULL PAST THE CAP (R3) — the object's declared
 * size (R2's Content-Length) is asked first and the body is cancelled unread;
 * then the stream is counted as it arrives and cancelled the moment it passes
 * the cap, so a size that lied still never buffers more than `cap` bytes.
 */
export async function readModelWithin(object: R2ObjectBody, cap: number): Promise<Uint8Array | null> {
  const declared = Number((object as { size?: unknown }).size);
  const body = (object as { body?: ReadableStream<Uint8Array> | null }).body ?? null;
  if (Number.isFinite(declared) && declared > cap) {
    await body?.cancel().catch(() => undefined);
    return null;
  }
  if (!body) {
    // No stream to count: only a declared size within the cap is read whole.
    if (!(Number.isFinite(declared) && declared <= cap)) return null;
    return new Uint8Array(await object.arrayBuffer());
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
