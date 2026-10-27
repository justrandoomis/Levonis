/**
 * DESIGN DOCUMENTS — versions, conflicts, approval and its invalidation
 * (spec §15, §22, §24, §25, §30).
 *
 * THE ONE GATE, BOTH WAYS. Every write passes `normalizeDocument`: a fatal
 * issue (a foreign picture URL, an invented font, a duplicate id, a future
 * schema, an oversize document) refuses the save with INVALID_DOCUMENT; the
 * cleaned document is what is stored. Every read passes it again and returns
 * its non-fatal issues, so a row edited by hand can never reach the editor
 * unchecked.
 *
 * NEVER OVERWRITE NEWER WORK. A save names the version it was made from
 * (`base_version`); a mismatch is 409 VERSION_CONFLICT with the current
 * version, and nothing is written. The version counter moves only when the
 * CONTENT changes (a title is metadata).
 *
 * VERSIONS AT MEANINGFUL POINTS, NOT EVERY KEYSTROKE (spec §30). A version row
 * is kept for an AI edit, a restore, a template change, a re-layout, an
 * import, an explicit checkpoint, or when ten minutes have passed since the
 * last kept one — and ALWAYS for the version that is approved or exported
 * final, written in the same batch as the approval or the export from the
 * design row at that version. At most 50 are kept per design; pruning never
 * drops a version that was approved or exported final.
 *
 * THE LOSING WRITER WRITES NOTHING. A D1 batch does not stop at an UPDATE
 * that matched no row, so every side effect of a save or an approval (its
 * version row, its job's "applied" mark, its review row, the invalidation of
 * an approval) is guarded by "the design is still at the base version" and
 * runs BEFORE the version-fenced document UPDATE: inside the batch's
 * transaction they all happen, or none does. An AI result's document write is
 * also conditional on this save holding the job's mark, so a cancel that lands
 * after the job check can never let the cancelled answer in.
 *
 * APPROVAL BELONGS TO ONE VERSION. Any content change after approval
 * invalidates it (`creative_reviews.invalidated_*`) and the design returns to
 * draft. Approving re-verifies every product binding NOW against the store and
 * re-runs every check the Worker can run without a canvas (data, product
 * binding, claims, safe area and overlap, a discount or limited-time claim
 * with no live offer, a studio picture nobody approved); the editor's measured
 * checks (text fit, fonts, pictures) can only add blockers, never remove one.
 *
 * STALE AFTER RELEASE (spec §25, acceptance 12). An approved or final-exported
 * design whose store data changed is marked in `needs_review` (the change
 * codes, once each) — by the catalogue watch, by a snapshot re-verification,
 * by an approval or final export that was refused for it, and when the design
 * is opened. The content is never touched; approving again clears the mark.
 */
import type { ApproveRequest, DocKind, DocStatus, DocumentDto, DocumentSummaryDto, ExportDto, ReviewDto, VersionDto, VersionOrigin } from '../../../packages/creativeDoc/src/api';
import type { BrandKit } from '../../../packages/creativeDoc/src/brand';
import { normalizeDocument, type DocIssue } from '../../../packages/creativeDoc/src/normalize';
import { qualityReport, type ClaimState, type QualityIssue, type QualityReport } from '../../../packages/creativeDoc/src/quality';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import { blockingChanges, canonicalJson, compareSnapshots, type Localized, type ProductSnapshot, type SnapshotChange } from '../../../packages/creativeDoc/src/snapshot';
import { claimsIn } from '../../../packages/creativeDoc/src/text';
import { newId } from '../crypto';
import { HttpError, badRequest, notFound } from '../http';
import { likePattern, sqlLikeClause } from '../sqlLike';
import { brandForDocument } from './brandStore';
import { approvedClaims } from './claims';
import { watchEvidence } from './evidence';
import { intOrNull, jsonObject, namesOf, nowIso, stringList } from './db';
import { getSnapshots } from './snapshots';
import { buildSnapshotData } from './store';

export const KEEP_VERSIONS = 50;
const CHECKPOINT_AFTER_MS = 10 * 60_000;
const MEANINGFUL: ReadonlySet<VersionOrigin> = new Set(['ai', 'restore', 'template', 'relayout', 'import']);

export interface DocRow {
  id: string;
  title: string;
  status: DocStatus;
  kind: DocKind;
  campaign_id: string | null;
  parent_id: string | null;
  format_id: string;
  width: number;
  height: number;
  product_id: string | null;
  template_id: string | null;
  version: number;
  content_json: string;
  brand_version: number | null;
  approved_version: number | null;
  needs_review_json: string;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  archived_at: string | null;
}

export async function getDocRow(db: D1Database, id: string): Promise<DocRow | null> {
  return (await db.prepare('SELECT * FROM creative_documents WHERE id = ?').bind(id).first<DocRow>()) ?? null;
}

export async function requireDoc(db: D1Database, id: string): Promise<DocRow> {
  const row = await getDocRow(db, id);
  if (!row) throw notFound('Design not found');
  return row;
}

/** The stored content through the gate (read side). */
export function readContent(row: Pick<DocRow, 'content_json'>): { doc: CreativeDocument; issues: DocIssue[]; ok: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    raw = null;
  }
  return normalizeDocument(raw);
}

/** The write side of the gate: a fatal issue is a 400 that names the issues. */
export function writeContent(raw: unknown): CreativeDocument {
  const n = normalizeDocument(raw);
  if (!n.ok) {
    throw new HttpError(400, 'The design was refused by the document checks.', 'INVALID_DOCUMENT', { issues: n.issues.filter((i) => i.fatal).slice(0, 20) });
  }
  return n.doc;
}

const mainProduct = (doc: CreativeDocument) => (doc.products.find((p) => p.slot === 'main') ?? doc.products[0])?.product_id ?? null;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

async function productNames(db: D1Database, ids: Array<string | null>): Promise<Map<string, Localized>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, Localized>();
  if (!wanted.length) return out;
  const { results } = await db.prepare('SELECT id, name, name_ar, name_ku FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(wanted)).all<Record<string, unknown>>();
  const t = (v: unknown) => (typeof v === 'string' ? v : '');
  for (const r of results ?? []) out.set(String(r.id), { ar: t(r.name_ar), en: t(r.name), ckb: t(r.name_ku) });
  return out;
}

async function latestExports(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare(
      `SELECT e.document_id, e.id FROM creative_exports e
        WHERE e.document_id IN (SELECT value FROM json_each(?)) AND e.kind IN ('png', 'jpeg', 'webp')
          AND e.created_at = (SELECT MAX(x.created_at) FROM creative_exports x WHERE x.document_id = e.document_id AND x.kind IN ('png', 'jpeg', 'webp'))`
    )
    .bind(JSON.stringify(ids))
    .all<{ document_id: string; id: string }>();
  for (const r of results ?? []) out.set(r.document_id, r.id);
  return out;
}

function summaryOf(r: DocRow, names: Map<string, Localized>, thumbs: Map<string, string>): DocumentSummaryDto {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    kind: r.kind,
    format: { id: r.format_id as DocumentSummaryDto['format']['id'], width: r.width, height: r.height },
    product_id: r.product_id,
    product_name: r.product_id ? names.get(r.product_id) ?? null : null,
    template_id: r.template_id,
    version: r.version,
    approved_version: r.approved_version,
    needs_review: stringList(r.needs_review_json),
    campaign_id: r.campaign_id,
    parent_id: r.parent_id,
    updated_at: r.updated_at,
    created_at: r.created_at,
    thumb_export_id: thumbs.get(r.id) ?? null,
  };
}

export async function summaries(db: D1Database, rows: DocRow[]): Promise<DocumentSummaryDto[]> {
  const [names, thumbs] = await Promise.all([productNames(db, rows.map((r) => r.product_id)), latestExports(db, rows.map((r) => r.id))]);
  return rows.map((r) => summaryOf(r, names, thumbs));
}

/** One design for the editor, with the kit of its pinned brand version — the kit its bound text is rendered with, never a newer one. */
export async function documentDto(db: D1Database, r: DocRow): Promise<DocumentDto> {
  const [sum] = await summaries(db, [r]);
  const content = readContent(r);
  const [names, brandKit] = await Promise.all([namesOf(db, [r.updated_by]), brandForDocument(db, content.doc.brand_version)]);
  return {
    ...sum, content: content.doc, brand_version: r.brand_version, brand_kit: brandKit,
    updated_by_name: r.updated_by ? names.get(r.updated_by) ?? null : null, issues: content.issues,
  };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface DocFilters {
  status: DocStatus | null;
  product_id: string | null;
  format: string | null;
  campaign_id: string | null;
  /** 'slide' lists carousel slides (spec §20); absent = every kind. */
  kind?: DocKind | null;
  q: string;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
}

/**
 * The archive (spec §22). `to` as a bare date includes that whole day (the
 * column holds full timestamps, and '2026-10-27T13:00Z' sorts after
 * '2026-10-27'). `q` looks in the title, in the words of the design's visible
 * text layers (its headline, features, the rendered product name…) and in the
 * current names of the products it binds — one bound LIKE pattern
 * (`likePattern`: escaped, at most 48 bytes), never SQL built from the text.
 */
export async function listDocuments(db: D1Database, f: DocFilters): Promise<{ documents: DocumentSummaryDto[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) { where.push('status = ?'); args.push(f.status); } else where.push("status <> 'archived'");
  if (f.product_id) { where.push('product_id = ?'); args.push(f.product_id); }
  if (f.format) { where.push('format_id = ?'); args.push(f.format); }
  if (f.campaign_id) { where.push('campaign_id = ?'); args.push(f.campaign_id); }
  if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
  if (f.from) { where.push('updated_at >= ?'); args.push(f.from); }
  if (f.to) { where.push('updated_at <= ?'); args.push(/^\d{4}-\d{2}-\d{2}$/.test(f.to) ? `${f.to}T23:59:59.999Z` : f.to); }
  const pattern = likePattern(f.q);
  if (pattern) {
    where.push(
      `(${sqlLikeClause(['title'])}
        OR EXISTS (SELECT 1 FROM json_each(creative_documents.content_json, '$.layers') l
                    WHERE json_extract(l.value, '$.type') = 'text' AND json_extract(l.value, '$.visible') = 1
                      AND ${sqlLikeClause(["json_extract(l.value, '$.text')"])})
        OR EXISTS (SELECT 1 FROM json_each(creative_documents.content_json, '$.products') b
                     JOIN products p ON p.id = json_extract(b.value, '$.product_id')
                    WHERE ${sqlLikeClause(['p.name', 'p.name_ar', 'p.name_ku'])}))`
    );
    args.push(pattern, pattern, pattern, pattern, pattern);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, count] = await Promise.all([
    db.prepare(`SELECT * FROM creative_documents ${clause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).bind(...args, f.limit, f.offset).all<DocRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM creative_documents ${clause}`).bind(...args).first<{ n: number }>(),
  ]);
  return { documents: await summaries(db, rows.results ?? []), total: count?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A guard every side effect of one write shares: `sql` is a condition, `args`
 * its values. A statement carrying it does nothing unless the design is still
 * at the version the write started from (and, for an AI result, this write
 * holds the job's mark) — so a write that loses its race leaves no trace.
 */
interface Guard {
  sql: string;
  args: unknown[];
}

const atVersion = (documentId: string, version: number): Guard => ({ sql: 'EXISTS (SELECT 1 FROM creative_documents WHERE id = ? AND version = ?)', args: [documentId, version] });

function versionStatement(db: D1Database, documentId: string, version: number, content: string, origin: VersionOrigin, summary: string, jobId: string | null, actorId: string, now: string, guard: Guard): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO creative_document_versions (document_id, version, content_json, origin, change_summary, job_id, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`
    )
    .bind(documentId, version, content, origin, summary.slice(0, 300), jobId, actorId, now, ...guard.args);
}

/**
 * The version a design is at, kept as a version row FROM THE DESIGN ROW
 * itself (spec §22, §25, §30): an approval and a final export put their
 * version in the history in the same batch, so the approved or exported
 * content can always be viewed and restored. A row that already exists (an AI
 * save, a checkpoint) keeps its own origin. Nothing is written when the
 * design has moved past `version`.
 */
export function keepVersionStatement(db: D1Database, documentId: string, version: number, summary: string, actorId: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO creative_document_versions (document_id, version, content_json, origin, change_summary, job_id, created_by, created_at)
       SELECT id, version, content_json, 'manual', ?, NULL, ?, ? FROM creative_documents WHERE id = ? AND version = ?`
    )
    .bind(summary, actorId, now, documentId, version);
}

/** Keep the newest KEEP_VERSIONS rows; never drop a version that was approved or exported final. */
function pruneStatement(db: D1Database, documentId: string, guard: Guard): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM creative_document_versions
        WHERE document_id = ?
          AND version < COALESCE((SELECT MIN(version) FROM (SELECT version FROM creative_document_versions WHERE document_id = ? ORDER BY version DESC LIMIT ?)), 0)
          AND version NOT IN (SELECT version FROM creative_reviews WHERE document_id = ? AND decision = 'approved')
          AND version NOT IN (SELECT version FROM creative_exports WHERE document_id = ? AND final = 1)
          AND ${guard.sql}`
    )
    .bind(documentId, documentId, KEEP_VERSIONS, documentId, documentId, ...guard.args);
}

/** The approval of this design stops counting: its review row says when and why; the design is a draft again. A no-op when nothing is approved. */
function invalidateStatement(db: D1Database, documentId: string, reason: string, now: string, guard?: Guard): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE creative_reviews SET invalidated_at = ?, invalidated_reason = ?
        WHERE document_id = ? AND decision = 'approved' AND invalidated_at IS NULL${guard ? ` AND ${guard.sql}` : ''}`
    )
    .bind(now, reason, documentId, ...(guard?.args ?? []));
}

export interface CreateInput {
  title: string;
  content: unknown;
  kind: DocKind;
  campaign_id: string | null;
  parent_id: string | null;
  idempotency_key: string | null;
  /** How the design came to be; absent = from its template, or by hand. 'restore' is never a creation. */
  origin?: Exclude<VersionOrigin, 'restore'> | null;
  /** With origin 'ai': the compose or ideas job whose answer the design was built from. */
  job_id?: string | null;
}

/**
 * Create a design; version 1 records how it came to be (spec §22, §27, §28).
 *
 * A design built from Claude's answer (origin 'ai') names that job, and the
 * job must be a SUCCEEDED, not cancelled result of a composition or of ideas.
 * A composition is this actor's own and is applied once: it is marked applied
 * to version 1 of the new design (`document_id`, `applied_version` 1) in the
 * SAME batch, and the design is inserted only when this create holds that
 * mark — a cancel or a second create racing it inserts nothing. An ideas
 * answer is shared by the studio (the ideas list is everyone's) and one answer
 * offers several ideas, so the first design built from it marks it applied
 * and later ones cite it without a second mark. A carousel plan is this
 * actor's own and becomes several slides: the first marks it, the rest cite it.
 */
export async function createDocument(db: D1Database, actorId: string, input: CreateInput): Promise<DocRow> {
  if (input.idempotency_key) {
    const existing = await db.prepare('SELECT * FROM creative_documents WHERE idempotency_key = ?').bind(input.idempotency_key).first<DocRow>();
    if (existing) {
      if (existing.created_by !== actorId) throw new HttpError(409, 'This idempotency key was already used.', 'IDEMPOTENCY_KEY_REUSED');
      return existing;
    }
  }
  const doc = writeContent(input.content);
  // A template origin for a design with no template would be a false record.
  const origin: VersionOrigin = !input.origin || (input.origin === 'template' && !doc.template) ? (doc.template ? 'template' : 'manual') : input.origin;
  const jobId = input.job_id ?? null;
  if (jobId && origin !== 'ai') throw badRequest("job_id goes with origin 'ai'", 'INVALID_INPUT');
  if (origin === 'ai') {
    if (!jobId) throw badRequest("origin 'ai' needs the job_id of the answer the design was built from", 'INVALID_INPUT');
    const job = await db.prepare('SELECT task, status, actor_id, applied_at FROM creative_jobs WHERE id = ?').bind(jobId).first<{ task: string; status: string; actor_id: string | null; applied_at: string | null }>();
    if (!job || (job.task !== 'compose' && job.task !== 'ideas' && job.task !== 'carousel') || (job.task !== 'ideas' && job.actor_id !== actorId)) {
      throw badRequest('job_id is not one of your compositions or carousel plans, nor an ideas answer', 'INVALID_INPUT');
    }
    if (job.status === 'cancelled') throw new HttpError(409, 'This job was cancelled; its result is never applied.', 'JOB_CANCELLED');
    if (job.status !== 'succeeded') throw new HttpError(409, 'This job has no result to apply.', 'INVALID_INPUT');
    if (job.task === 'compose' && job.applied_at) throw new HttpError(409, 'This result was already applied.', 'JOB_ALREADY_APPLIED');
  }
  const id = newId('cdoc');
  const now = nowIso();
  const content = JSON.stringify(doc);
  const values = [id, input.title, input.kind, input.campaign_id, input.parent_id, doc.format.id, doc.format.width, doc.format.height, mainProduct(doc), doc.template?.id ?? null, content, doc.brand_version, input.idempotency_key, actorId, now, actorId, now];
  const columns = `INSERT INTO creative_documents (id, title, status, kind, campaign_id, parent_id, format_id, width, height, product_id, template_id, version,
                                         content_json, brand_version, idempotency_key, created_by, created_at, updated_by, updated_at)`;
  const statements: D1PreparedStatement[] = [];
  if (jobId) {
    statements.push(
      db
        .prepare(
          `UPDATE creative_jobs SET applied_at = ?, applied_version = 1, document_id = ?
            WHERE id = ? AND status = 'succeeded' AND applied_at IS NULL AND document_id IS NULL AND (task = 'ideas' OR (task IN ('compose', 'carousel') AND actor_id = ?))`
        )
        .bind(now, id, jobId, actorId),
      db
        .prepare(
          `${columns} SELECT ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM creative_jobs WHERE id = ? AND status = 'succeeded' AND (document_id = ? OR task IN ('ideas', 'carousel')))`
        )
        .bind(...values, jobId, id)
    );
  } else {
    statements.push(db.prepare(`${columns} VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).bind(...values));
  }
  statements.push(versionStatement(db, id, 1, content, origin, 'created', jobId, actorId, now, { sql: 'EXISTS (SELECT 1 FROM creative_documents WHERE id = ?)', args: [id] }));
  const results = await db.batch(statements);
  if ((results[jobId ? 1 : 0]?.meta?.changes ?? 0) !== 1) {
    const job = await db.prepare('SELECT status FROM creative_jobs WHERE id = ?').bind(jobId).first<{ status: string }>();
    if (job?.status === 'cancelled') throw new HttpError(409, 'This job was cancelled; its result is never applied.', 'JOB_CANCELLED');
    throw new HttpError(409, 'This result was already applied.', 'JOB_ALREADY_APPLIED');
  }
  return (await getDocRow(db, id))!;
}

export interface SaveInput {
  base_version: number;
  content: unknown;
  title: string | null;
  change_summary: string;
  origin: VersionOrigin;
  job_id: string | null;
  checkpoint: boolean;
}

export interface SaveOutcome {
  row: DocRow;
  /** True when this save withdrew a standing approval (the caller audits who). */
  invalidated: boolean;
}

/**
 * Save a design. Refuses a stale base (VERSION_CONFLICT) and a fatal document;
 * a content change bumps the version, keeps a version row when meaningful,
 * and invalidates an approval. An AI result (`job_id`) is accepted only from a
 * succeeded, not cancelled, not yet applied job of this design. In the batch
 * the job is marked applied FIRST (only while the design is at the base
 * version), and the document write is conditional on that mark — so a cancel
 * that lands after the check below leaves the design untouched and answers
 * JOB_CANCELLED. Every other side effect carries the same guard (see the
 * header), so the loser of a race writes nothing at all.
 */
export async function saveDocument(db: D1Database, actorId: string, id: string, input: SaveInput): Promise<SaveOutcome> {
  const row = await requireDoc(db, id);
  if (input.base_version !== row.version) {
    throw new HttpError(409, 'This design changed since you opened it.', 'VERSION_CONFLICT', { current_version: row.version });
  }
  const doc = writeContent(input.content);
  const content = JSON.stringify(doc);
  const before = readContent(row).doc;
  const changed = canonicalJson(doc) !== canonicalJson(before);
  const title = input.title ?? row.title;
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (input.job_id) {
    const job = await db.prepare('SELECT status, document_id, applied_at FROM creative_jobs WHERE id = ?').bind(input.job_id).first<{ status: string; document_id: string | null; applied_at: string | null }>();
    if (!job || (job.document_id !== null && job.document_id !== id)) throw badRequest('job_id is not a result for this design', 'INVALID_INPUT');
    if (job.status === 'cancelled') throw new HttpError(409, 'This job was cancelled; its result is never applied.', 'JOB_CANCELLED');
    if (job.applied_at) throw new HttpError(409, 'This result was already applied.', 'JOB_ALREADY_APPLIED');
    if (job.status !== 'succeeded') throw new HttpError(409, 'This job has no result to apply.', 'INVALID_INPUT');
  }
  if (!changed) {
    if (title !== row.title) await db.prepare('UPDATE creative_documents SET title = ?, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?').bind(title, actorId, now, id, row.version).run();
    return { row: (await getDocRow(db, id))!, invalidated: false };
  }
  const next = row.version + 1;
  const base = atVersion(id, row.version);
  // An AI result: the job is marked applied only while the design is at the base version, and only this save's mark lets the rest through.
  const marked: Guard | null = input.job_id
    ? { sql: 'EXISTS (SELECT 1 FROM creative_jobs WHERE id = ? AND applied_at = ? AND applied_version = ?)', args: [input.job_id, now, next] }
    : null;
  const guard: Guard = marked ? { sql: `${base.sql} AND ${marked.sql}`, args: [...base.args, ...marked.args] } : base;
  if (input.job_id) {
    statements.push(
      db
        .prepare(
          `UPDATE creative_jobs SET applied_at = ?, applied_version = ?
            WHERE id = ? AND status = 'succeeded' AND applied_at IS NULL AND (document_id IS NULL OR document_id = ?) AND ${base.sql}`
        )
        .bind(now, next, input.job_id, id, ...base.args)
    );
  }
  const last = await db.prepare('SELECT MAX(created_at) AS at FROM creative_document_versions WHERE document_id = ?').bind(id).first<{ at: string | null }>();
  const stale = !last?.at || Date.parse(now) - Date.parse(last.at) >= CHECKPOINT_AFTER_MS;
  if (MEANINGFUL.has(input.origin) || input.checkpoint || stale || input.job_id) {
    statements.push(versionStatement(db, id, next, content, input.origin, input.change_summary, input.job_id, actorId, now, guard));
    statements.push(pruneStatement(db, id, guard));
  }
  // Always: an approval committed after the read above is withdrawn too (a no-op when nothing is approved).
  const invalidateAt = statements.push(invalidateStatement(db, id, 'content_changed', now, guard)) - 1;
  statements.push(
    db
      .prepare(
        `UPDATE creative_documents
            SET content_json = ?, version = ?, title = ?, format_id = ?, width = ?, height = ?, product_id = ?, template_id = ?, brand_version = ?,
                status = CASE WHEN status IN ('approved', 'in_review') THEN 'draft' ELSE status END,
                approved_version = NULL, updated_by = ?, updated_at = ?
          WHERE id = ? AND version = ?${marked ? ` AND ${marked.sql}` : ''}`
      )
      .bind(content, next, title, doc.format.id, doc.format.width, doc.format.height, mainProduct(doc), doc.template?.id ?? null, doc.brand_version, actorId, now, id, row.version, ...(marked?.args ?? []))
  );
  const results = await db.batch(statements);
  if ((results[results.length - 1]?.meta?.changes ?? 0) !== 1) {
    const current = await getDocRow(db, id);
    if (input.job_id) {
      const job = await db.prepare('SELECT status, applied_at FROM creative_jobs WHERE id = ?').bind(input.job_id).first<{ status: string; applied_at: string | null }>();
      if (job?.status === 'cancelled') throw new HttpError(409, 'This job was cancelled; its result is never applied.', 'JOB_CANCELLED');
      if (current?.version === row.version && job?.applied_at) throw new HttpError(409, 'This result was already applied.', 'JOB_ALREADY_APPLIED');
    }
    throw new HttpError(409, 'This design changed since you opened it.', 'VERSION_CONFLICT', { current_version: current?.version ?? null });
  }
  return { row: (await getDocRow(db, id))!, invalidated: (results[invalidateAt]?.meta?.changes ?? 0) > 0 };
}

/**
 * Rename a design. A title is not design content (spec §25 ties an approval to
 * the content of one version), so a rename makes no new version, needs no base
 * version and leaves an approval standing.
 */
export async function renameDocument(db: D1Database, actorId: string, id: string, title: string): Promise<DocRow> {
  await requireDoc(db, id);
  await db.prepare('UPDATE creative_documents SET title = ?, updated_by = ?, updated_at = ? WHERE id = ?').bind(title, actorId, nowIso(), id).run();
  return (await getDocRow(db, id))!;
}

export async function restoreDocument(db: D1Database, actorId: string, id: string, version: number, baseVersion: number): Promise<SaveOutcome> {
  const row = await requireDoc(db, id);
  if (baseVersion !== row.version) throw new HttpError(409, 'This design changed since you opened it.', 'VERSION_CONFLICT', { current_version: row.version });
  const v = await db.prepare('SELECT content_json FROM creative_document_versions WHERE document_id = ? AND version = ?').bind(id, version).first<{ content_json: string }>();
  if (!v) throw notFound('Version not found');
  let content: unknown;
  try {
    content = JSON.parse(v.content_json);
  } catch {
    throw new HttpError(400, 'The stored version cannot be read.', 'INVALID_DOCUMENT');
  }
  // A restore is a NEW version: bound data is re-verified at approval and at a final export like any other.
  return saveDocument(db, actorId, id, { base_version: baseVersion, content, title: null, change_summary: `restored version ${version}`, origin: 'restore', job_id: null, checkpoint: true });
}

export async function duplicateDocument(db: D1Database, actorId: string, id: string): Promise<DocRow> {
  const row = await requireDoc(db, id);
  const content = readContent(row).doc;
  return createDocument(db, actorId, { title: row.title, content, kind: row.kind, campaign_id: row.campaign_id, parent_id: row.id, idempotency_key: null });
}

const TRANSITIONS: Readonly<Record<string, readonly DocStatus[]>> = {
  draft: ['in_review', 'archived'],
  idea: ['draft', 'archived'],
  in_review: ['draft', 'archived'],
  approved: ['draft', 'archived'],
  failed: ['draft', 'archived'],
  archived: ['draft'],
  scheduled: ['draft', 'archived'],
  published: ['archived'],
};

/**
 * Move a design between draft, in review and archived. Answers the status it
 * came `from` and whether an approval was withdrawn, so the route audits who
 * did it (spec §32). The status must still be what was read: a write that
 * loses a race is VERSION_CONFLICT and leaves no trace.
 */
export async function setStatus(db: D1Database, actorId: string, id: string, status: 'draft' | 'in_review' | 'archived', baseVersion: number): Promise<{ row: DocRow; from: DocStatus; invalidated: boolean }> {
  const row = await requireDoc(db, id);
  if (baseVersion !== row.version) throw new HttpError(409, 'This design changed since you opened it.', 'VERSION_CONFLICT', { current_version: row.version });
  if (row.status === status) return { row, from: row.status, invalidated: false };
  if (!(TRANSITIONS[row.status] ?? []).includes(status)) throw badRequest(`A ${row.status} design cannot become ${status}`, 'INVALID_INPUT');
  const now = nowIso();
  const guard: Guard = { sql: 'EXISTS (SELECT 1 FROM creative_documents WHERE id = ? AND version = ? AND status = ?)', args: [id, row.version, row.status] };
  const statements: D1PreparedStatement[] = [];
  // Taking an approved design back to draft withdraws its approval, on the record.
  const withdraws = row.status === 'approved' && status === 'draft';
  if (withdraws) statements.push(invalidateStatement(db, id, 'withdrawn', now, guard));
  statements.push(
    db
      .prepare(
        `UPDATE creative_documents SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END,
                approved_version = CASE WHEN ? = 'archived' THEN approved_version ELSE NULL END, updated_by = ?, updated_at = ?
          WHERE id = ? AND version = ? AND status = ?`
      )
      .bind(status, status, now, status, actorId, now, id, row.version, row.status)
  );
  const results = await db.batch(statements);
  if ((results[results.length - 1]?.meta?.changes ?? 0) !== 1) {
    const current = await getDocRow(db, id);
    throw new HttpError(409, 'This design changed since you opened it.', 'VERSION_CONFLICT', { current_version: current?.version ?? null });
  }
  return { row: (await getDocRow(db, id))!, from: row.status, invalidated: withdraws && (results[0]?.meta?.changes ?? 0) > 0 };
}

// ---------------------------------------------------------------------------
// Versions and reviews
// ---------------------------------------------------------------------------

export async function versions(db: D1Database, id: string): Promise<VersionDto[]> {
  const { results } = await db
    .prepare('SELECT version, origin, change_summary, created_at, created_by, job_id FROM creative_document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 100')
    .bind(id)
    .all<{ version: number; origin: VersionOrigin; change_summary: string; created_at: string; created_by: string | null; job_id: string | null }>();
  const rows = results ?? [];
  const names = await namesOf(db, rows.map((r) => r.created_by));
  return rows.map((r) => ({ version: r.version, origin: r.origin, change_summary: r.change_summary, created_at: r.created_at, created_by_name: r.created_by ? names.get(r.created_by) ?? null : null, job_id: r.job_id }));
}

export async function versionContent(db: D1Database, id: string, version: number): Promise<{ version: VersionDto; content: CreativeDocument; issues: DocIssue[] } | null> {
  const r = await db
    .prepare('SELECT version, origin, change_summary, created_at, created_by, job_id, content_json FROM creative_document_versions WHERE document_id = ? AND version = ?')
    .bind(id, version)
    .first<{ version: number; origin: VersionOrigin; change_summary: string; created_at: string; created_by: string | null; job_id: string | null; content_json: string }>();
  if (!r) return null;
  const names = await namesOf(db, [r.created_by]);
  const content = readContent(r);
  return {
    version: { version: r.version, origin: r.origin, change_summary: r.change_summary, created_at: r.created_at, created_by_name: r.created_by ? names.get(r.created_by) ?? null : null, job_id: r.job_id },
    content: content.doc,
    issues: content.issues,
  };
}

interface ReviewRow {
  id: string;
  version: number;
  decision: 'approved' | 'rejected';
  reasons_json: string;
  note: string;
  brand_version: number | null;
  export_ids_json: string;
  actor_id: string | null;
  created_at: string;
  invalidated_at: string | null;
  invalidated_reason: string | null;
}

export async function reviews(db: D1Database, id: string): Promise<ReviewDto[]> {
  const { results } = await db.prepare('SELECT * FROM creative_reviews WHERE document_id = ? ORDER BY created_at DESC LIMIT 100').bind(id).all<ReviewRow>();
  const rows = results ?? [];
  const names = await namesOf(db, rows.map((r) => r.actor_id));
  return rows.map((r) => reviewDto(r, names));
}

function reviewDto(r: ReviewRow, names: Map<string, string>): ReviewDto {
  return {
    id: r.id,
    version: r.version,
    decision: r.decision,
    reasons: stringList(r.reasons_json) as ReviewDto['reasons'],
    note: r.note,
    brand_version: r.brand_version,
    export_ids: stringList(r.export_ids_json),
    actor_name: r.actor_id ? names.get(r.actor_id) ?? null : null,
    created_at: r.created_at,
    invalidated_at: r.invalidated_at,
    invalidated_reason: r.invalidated_reason,
  };
}

// ---------------------------------------------------------------------------
// Re-verification and the server's quality report
// ---------------------------------------------------------------------------

export interface Verification {
  /** Bound snapshots by slot (what the design was built from). */
  snapshots: Record<string, Pick<ProductSnapshot, 'id' | 'data' | 'source'>>;
  /** Fresh vs bound, by slot. */
  changes: Record<string, SnapshotChange[]>;
  /** The changes that block what THIS design shows. */
  blocking: SnapshotChange[];
  claims: Record<string, ClaimState>;
  brand: BrandKit;
  /** A bound product has a live PUBLIC offer in the store NOW (fresh data, never the bound snapshot). */
  offerLive: boolean;
  /**
   * Documented arrival / back-in-stock for the bound products (the catalogue
   * watch's recent events), so the checks can judge those words in free text.
   * Absent when the watch could not be read: the checks then report the claim
   * check as skipped rather than guess.
   */
  claimEvidence?: { arrival: boolean; backInStock: boolean };
}

/** Does the design show a bound price / availability? (A change to a field it does not show does not block.) */
export function shows(doc: CreativeDocument): { price: boolean; availability: boolean } {
  const texts = doc.layers.filter((l) => l.visible && l.type === 'text');
  const bound = (field: string) => texts.some((t) => t.type === 'text' && t.source.kind === 'product' && t.source.field === field);
  return { price: bound('price') || bound('price_amount') || bound('price_note'), availability: bound('availability') };
}

/**
 * Read every product binding's snapshot and the store's answer NOW, and the
 * claims the design uses. A bound snapshot that is missing stays missing
 * (the quality report says `snapshot_missing`).
 */
export async function verifyDocument(db: D1Database, doc: CreativeDocument): Promise<Verification> {
  const bound = await getSnapshots(db, doc.products.map((p) => p.snapshot_id));
  const snapshots: Verification['snapshots'] = {};
  const changes: Verification['changes'] = {};
  let offerLive = false;
  for (const b of doc.products) {
    const snap = bound.get(b.snapshot_id);
    if (!snap) continue;
    snapshots[b.slot] = { id: snap.id, data: snap.data, source: snap.source };
    const fresh = await buildSnapshotData(db, b.product_id, b.variant_key);
    changes[b.slot] = compareSnapshots(snap.data, fresh);
    if (fresh && fresh.price.offer !== null) offerLive = true;
  }
  const blocking = [...new Set(Object.values(changes).flatMap((c) => blockingChanges(c, shows(doc))))];
  const claimsMap = await approvedClaims(db, doc.services.map((s) => s.claim_id));
  const claims: Record<string, ClaimState> = {};
  for (const [id, c] of claimsMap) claims[id] = c;
  const claimEvidence = await watchEvidence(db, doc.products.map((p) => p.product_id)).catch(() => undefined);
  return { snapshots, changes, blocking, claims, brand: await brandForDocument(db, doc.brand_version), offerLive, ...(claimEvidence ? { claimEvidence } : {}) };
}

export function serverReport(doc: CreativeDocument, v: Verification, final: boolean): QualityReport {
  return qualityReport(doc, { brand: v.brand, snapshots: v.snapshots, claims: v.claims, verification: v.changes, ...(v.claimEvidence ? { claimEvidence: v.claimEvidence } : {}), final, now: nowIso() });
}

/**
 * A blocker only the Worker can find — it reads the store now and the asset
 * library — in the shape of a QualityIssue:
 *   unsupported_claim   a visible free text layer, the caption or the alt text
 *                       claims a discount or a limited time (`claimsIn`) while
 *                       no bound product has a live public offer NOW
 *   asset_not_approved  a visible picture is a studio asset (or logo) that is
 *                       not approved — waiting for review, rejected, deleted
 *                       or unknown (`detail` says which)
 */
export type ServerIssue = Omit<QualityIssue, 'code'> & { code: QualityIssue['code'] | 'unsupported_claim' | 'asset_not_approved' };

const OFFER_CLAIMS = new Set(['discount', 'limited_time']);

/** Words that promise an offer, with no live offer behind them (spec §9, §25): the edit-time evidence may be weeks old. */
export function offerClaimIssues(doc: CreativeDocument, offerLive: boolean): ServerIssue[] {
  if (offerLive) return [];
  const kinds = (text: string) => claimsIn(text).filter((k) => OFFER_CLAIMS.has(k));
  const out: ServerIssue[] = [];
  for (const l of doc.layers) {
    if (!l.visible || l.type !== 'text' || l.source.kind !== 'free') continue;
    const k = kinds(l.text);
    if (k.length) out.push({ code: 'unsupported_claim', severity: 'blocker', layer_ids: [l.id], detail: k.join(',') });
  }
  for (const [field, text] of [['caption', doc.caption], ['alt_text', doc.alt_text]] as const) {
    const k = kinds(text);
    if (k.length) out.push({ code: 'unsupported_claim', severity: 'blocker', layer_ids: [], detail: `${field}:${k.join(',')}` });
  }
  return out;
}

/** Visible pictures from the studio library that nobody approved (spec §6, §13): only an approved asset reaches a final file. */
async function assetIssues(db: D1Database, doc: CreativeDocument): Promise<ServerIssue[]> {
  const layers = doc.layers.filter((l) => l.visible && l.type === 'image' && (l.asset.kind === 'asset' || (l.asset.kind === 'logo' && l.asset.ref !== 'site')));
  if (!layers.length) return [];
  const { results } = await db
    .prepare('SELECT id, review, deleted_at FROM creative_assets WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(layers.map((l) => (l.type === 'image' ? l.asset.ref : '')))]))
    .all<{ id: string; review: string; deleted_at: string | null }>();
  const state = new Map((results ?? []).map((r) => [r.id, r.deleted_at ? 'deleted' : r.review]));
  return layers.flatMap((l) => {
    const s = l.type === 'image' ? state.get(l.asset.ref) ?? 'unknown' : 'unknown';
    return s === 'approved' ? [] : [{ code: 'asset_not_approved' as const, severity: 'blocker' as const, layer_ids: [l.id], detail: s }];
  });
}

/** Every blocker the Worker finds at approval or a final export: the report's, then the store's and the library's. */
export async function serverBlockers(db: D1Database, doc: CreativeDocument, v: Verification, report: QualityReport): Promise<ServerIssue[]> {
  return [...report.issues.filter((i) => i.severity === 'blocker'), ...offerClaimIssues(doc, v.offerLive), ...(await assetIssues(db, doc))];
}

// ---------------------------------------------------------------------------
// Stale after release — `needs_review` (spec §25, acceptance 12)
// ---------------------------------------------------------------------------

/** A design that left the studio: approved, or exported final (any version) — and not archived. */
const RELEASED = `archived_at IS NULL AND (approved_version IS NOT NULL OR EXISTS (SELECT 1 FROM creative_exports e WHERE e.document_id = creative_documents.id AND e.final = 1))`;

/** The change codes that make a released design stale: what blocks it now, and an offer claim whose offer is gone. */
export function staleCodes(doc: CreativeDocument, v: Verification): string[] {
  return [...new Set<string>([...v.blocking, ...(offerClaimIssues(doc, v.offerLive).length ? ['offer_changed'] : [])])];
}

/** Add `code` to a released design's needs_review once; nothing else moves (not the content, not updated_at). */
function markStatement(db: D1Database, documentId: string, code: string): D1PreparedStatement {
  const list = `CASE WHEN json_valid(needs_review_json) AND json_type(needs_review_json) = 'array' THEN needs_review_json ELSE '[]' END`;
  return db
    .prepare(
      `UPDATE creative_documents SET needs_review_json = json_insert(${list}, '$[#]', ?)
        WHERE id = ? AND ${RELEASED} AND NOT EXISTS (SELECT 1 FROM json_each(${list}) n WHERE n.value = ?)`
    )
    .bind(code, documentId, code);
}

/** Mark one design (when it is released). True when a code was added. */
export async function markNeedsReview(db: D1Database, documentId: string, codes: readonly string[]): Promise<boolean> {
  if (!codes.length) return false;
  const results = await db.batch(codes.map((code) => markStatement(db, documentId, code)));
  return results.some((r) => (r.meta?.changes ?? 0) > 0);
}

/**
 * The catalogue watch saw these products' card change (codes per product id):
 * the statements that mark every released design binding one of them.
 */
export async function staleStatementsForProducts(db: D1Database, byProduct: ReadonlyMap<string, readonly string[]>): Promise<D1PreparedStatement[]> {
  if (!byProduct.size) return [];
  const { results } = await db
    .prepare(
      `SELECT DISTINCT creative_documents.id AS id, json_extract(p.value, '$.product_id') AS product_id
         FROM creative_documents, json_each(creative_documents.content_json, '$.products') p
        WHERE ${RELEASED} AND json_extract(p.value, '$.product_id') IN (SELECT value FROM json_each(?))
        LIMIT 400`
    )
    .bind(JSON.stringify([...byProduct.keys()]))
    .all<{ id: string; product_id: string }>();
  const pairs = new Set<string>();
  for (const r of results ?? []) for (const code of byProduct.get(r.product_id) ?? []) pairs.add(JSON.stringify([r.id, code]));
  return [...pairs].map((p) => {
    const [id, code] = JSON.parse(p) as [string, string];
    return markStatement(db, id, code);
  });
}

/** A snapshot was re-verified with these changes: mark the released designs bound to it for what each one SHOWS. */
export async function markForSnapshot(db: D1Database, snapshotId: string, changes: readonly SnapshotChange[]): Promise<void> {
  if (!changes.length) return;
  const { results } = await db
    .prepare(
      `SELECT id, content_json FROM creative_documents
        WHERE ${RELEASED} AND EXISTS (SELECT 1 FROM json_each(creative_documents.content_json, '$.products') p WHERE json_extract(p.value, '$.snapshot_id') = ?)
        LIMIT 100`
    )
    .bind(snapshotId)
    .all<{ id: string; content_json: string }>();
  const statements = (results ?? []).flatMap((r) => blockingChanges(changes, shows(readContent(r).doc)).map((code) => markStatement(db, r.id, code)));
  if (statements.length) await db.batch(statements);
}

/**
 * Opening a released design re-verifies it, so the editor and the archive say
 * «needs review» as soon as anyone looks — not only after the next approval
 * or watch pass. It costs one store read per bound product, and only for an
 * approved or final-exported design; a draft is checked at approval as
 * before. A failure here never stops the design from opening.
 */
export async function recheckReleased(db: D1Database, row: DocRow): Promise<DocRow> {
  if (row.archived_at) return row;
  try {
    if (row.approved_version === null && !(await db.prepare('SELECT 1 FROM creative_exports WHERE document_id = ? AND final = 1 LIMIT 1').bind(row.id).first())) return row;
    const { doc, ok } = readContent(row);
    if (!ok) return row;
    const v = await verifyDocument(db, doc);
    if (await markNeedsReview(db, row.id, staleCodes(doc, v))) return (await getDocRow(db, row.id)) ?? row;
  } catch {
    console.error('creative studio: the open-time re-verification failed');
  }
  return row;
}

/** The client's blockers from checks the Worker cannot run (text fit, fonts, pictures) — they can only ADD blockers. */
function clientBlockers(qa: unknown): QualityIssue[] {
  const r = jsonObject(JSON.stringify(qa ?? {}));
  const issues = Array.isArray(r.issues) ? r.issues : [];
  const canvasOnly = new Set(['text_overflow', 'font_not_loaded', 'asset_missing', 'missing_glyph', 'small_text']);
  return issues
    .filter((i): i is QualityIssue => !!i && typeof i === 'object' && (i as QualityIssue).severity === 'blocker' && canvasOnly.has((i as QualityIssue).code))
    .slice(0, 20)
    .map((i) => ({ code: i.code, severity: 'blocker', layer_ids: Array.isArray(i.layer_ids) ? i.layer_ids.filter((x) => typeof x === 'string').slice(0, 20) : [] }));
}

/** Approve one version of a design (see the header). */
export async function approveDocument(db: D1Database, actorId: string, id: string, req: ApproveRequest): Promise<{ row: DocRow; review: ReviewDto; qa: QualityReport }> {
  const row = await requireDoc(db, id);
  if (req.version !== row.version) {
    throw new HttpError(409, 'The design changed after this version was checked; check the current version.', 'APPROVAL_STALE', { current_version: row.version });
  }
  if (row.status === 'archived') throw badRequest('An archived design cannot be approved', 'INVALID_INPUT');
  const { doc, ok } = readContent(row);
  if (!ok) throw new HttpError(400, 'The stored design no longer passes the document checks.', 'INVALID_DOCUMENT');
  const v = await verifyDocument(db, doc);
  // A released design (approved before, or exported final) that is stale now is marked, whatever this attempt's answer.
  await markNeedsReview(db, id, staleCodes(doc, v));
  if (v.blocking.length) {
    throw new HttpError(409, 'The store data this design shows has changed; review it before approving.', 'SOURCE_CHANGED', { changes: v.blocking, by_slot: v.changes });
  }
  const report = serverReport(doc, v, true);
  const extra = clientBlockers(req.qa);
  const blockers = [...(await serverBlockers(db, doc, v, report)), ...extra];
  if (blockers.length) throw new HttpError(409, 'The design has quality blockers.', 'QA_BLOCKERS', { issues: blockers.slice(0, 30) });
  const exportIds = [...new Set((req.export_ids ?? []).filter((x): x is string => typeof x === 'string'))].slice(0, 20);
  if (exportIds.length) {
    const { results } = await db
      .prepare('SELECT id FROM creative_exports WHERE document_id = ? AND version = ? AND id IN (SELECT value FROM json_each(?))')
      .bind(id, row.version, JSON.stringify(exportIds))
      .all<{ id: string }>();
    if ((results ?? []).length !== exportIds.length) throw badRequest('export_ids must be exports of this version of this design', 'INVALID_INPUT');
  }
  const now = nowIso();
  const reviewId = newId('crev');
  const qaRecord = { server: report, client_blockers: extra.length, client_ran: Array.isArray((req.qa as { ran?: unknown })?.ran) ? (req.qa as { ran: unknown[] }).ran.slice(0, 12) : [] };
  // The approved version enters the history and the review is recorded only while the design is still
  // at this version and not archived; both run before the fenced UPDATE (see the header).
  const results = await db.batch([
    keepVersionStatement(db, id, row.version, 'approved', actorId, now),
    db
      .prepare(
        `INSERT INTO creative_reviews (id, document_id, version, decision, reasons_json, note, brand_version, export_ids_json, qa_json, actor_id, created_at)
         SELECT ?, ?, ?, 'approved', '[]', '', ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM creative_documents WHERE id = ? AND version = ? AND status <> 'archived')`
      )
      .bind(reviewId, id, row.version, doc.brand_version, JSON.stringify(exportIds), JSON.stringify(qaRecord), actorId, now, id, row.version),
    db
      .prepare(`UPDATE creative_documents SET status = 'approved', approved_version = ?, needs_review_json = '[]', updated_by = ?, updated_at = ? WHERE id = ? AND version = ? AND status <> 'archived'`)
      .bind(row.version, actorId, now, id, row.version),
  ]);
  if ((results[2]?.meta?.changes ?? 0) !== 1) throw new HttpError(409, 'The design changed while it was being approved.', 'APPROVAL_STALE');
  const review = (await reviews(db, id)).find((r) => r.id === reviewId)!;
  return { row: (await getDocRow(db, id))!, review, qa: report };
}

export const REJECT_REASONS = ['product_small', 'crowded', 'text_long', 'background_off', 'wrong_variant_image', 'unclear', 'other'] as const;

export async function rejectDocument(db: D1Database, actorId: string, id: string, reasons: string[], note: string): Promise<{ row: DocRow; review: ReviewDto }> {
  const row = await requireDoc(db, id);
  const now = nowIso();
  const reviewId = newId('crev');
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO creative_reviews (id, document_id, version, decision, reasons_json, note, brand_version, actor_id, created_at)
         VALUES (?, ?, ?, 'rejected', ?, ?, ?, ?, ?)`
      )
      .bind(reviewId, id, row.version, JSON.stringify(reasons), note, row.brand_version, actorId, now),
    // The reasons are also the studio's visual memory (spec §22).
    db
      .prepare(`INSERT INTO creative_feedback (id, document_id, kind, reasons_json, note, scope, created_by, created_at) VALUES (?, ?, 'reject', ?, ?, 'document', ?, ?)`)
      .bind(newId('cfbk'), id, JSON.stringify(reasons), note, actorId, now),
    db
      .prepare(`UPDATE creative_documents SET status = CASE WHEN status IN ('approved', 'in_review') THEN 'draft' ELSE status END, approved_version = NULL, updated_at = ? WHERE id = ?`)
      .bind(now, id),
  ];
  if (row.approved_version !== null || row.status === 'approved') statements.push(invalidateStatement(db, id, 'rejected', now));
  await db.batch(statements);
  const review = (await reviews(db, id)).find((r) => r.id === reviewId)!;
  return { row: (await getDocRow(db, id))!, review };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface ExportRow {
  id: string;
  document_id: string;
  version: number;
  kind: ExportDto['kind'];
  r2_key: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  final: number;
  source_check: ExportDto['source_check'];
  created_by: string | null;
  created_at: string;
}

export function exportDto(r: ExportRow, apiBase: string): ExportDto {
  return {
    id: r.id,
    document_id: r.document_id,
    version: r.version,
    kind: r.kind,
    width: intOrNull(r.width),
    height: intOrNull(r.height),
    bytes: r.bytes,
    final: r.final === 1,
    source_check: r.source_check,
    created_at: r.created_at,
    url: `${apiBase}/exports/${r.id}/file`,
  };
}

export async function exportsOf(db: D1Database, documentId: string): Promise<ExportRow[]> {
  const { results } = await db.prepare('SELECT * FROM creative_exports WHERE document_id = ? ORDER BY created_at DESC LIMIT 100').bind(documentId).all<ExportRow>();
  return results ?? [];
}
