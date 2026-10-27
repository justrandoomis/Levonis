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
 * last kept one. At most 50 are kept per design; pruning never drops a version
 * that was approved or exported final.
 *
 * APPROVAL BELONGS TO ONE VERSION. Any content change after approval
 * invalidates it (`creative_reviews.invalidated_*`) and the design returns to
 * draft. Approving re-verifies every product binding NOW against the store and
 * re-runs every check the Worker can run without a canvas (data, product
 * binding, claims, safe area and overlap); the editor's measured checks (text
 * fit, fonts, pictures) can only add blockers, never remove one.
 */
import type { ApproveRequest, DocKind, DocStatus, DocumentDto, DocumentSummaryDto, ExportDto, ReviewDto, VersionDto, VersionOrigin } from '../../../packages/creativeDoc/src/api';
import type { BrandKit } from '../../../packages/creativeDoc/src/brand';
import { normalizeDocument, type DocIssue } from '../../../packages/creativeDoc/src/normalize';
import { qualityReport, type ClaimState, type QualityIssue, type QualityReport } from '../../../packages/creativeDoc/src/quality';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import { blockingChanges, canonicalJson, compareSnapshots, type Localized, type ProductSnapshot, type SnapshotChange } from '../../../packages/creativeDoc/src/snapshot';
import { newId } from '../crypto';
import { HttpError, badRequest, notFound } from '../http';
import { likePattern, sqlLikeClause } from '../sqlLike';
import { brandForDocument } from './brandStore';
import { approvedClaims } from './claims';
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

export async function documentDto(db: D1Database, r: DocRow): Promise<DocumentDto> {
  const [sum] = await summaries(db, [r]);
  const content = readContent(r);
  const names = await namesOf(db, [r.updated_by]);
  return { ...sum, content: content.doc, brand_version: r.brand_version, updated_by_name: r.updated_by ? names.get(r.updated_by) ?? null : null, issues: content.issues };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface DocFilters {
  status: DocStatus | null;
  product_id: string | null;
  format: string | null;
  campaign_id: string | null;
  q: string;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
}

export async function listDocuments(db: D1Database, f: DocFilters): Promise<{ documents: DocumentSummaryDto[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) { where.push('status = ?'); args.push(f.status); } else where.push("status <> 'archived'");
  if (f.product_id) { where.push('product_id = ?'); args.push(f.product_id); }
  if (f.format) { where.push('format_id = ?'); args.push(f.format); }
  if (f.campaign_id) { where.push('campaign_id = ?'); args.push(f.campaign_id); }
  if (f.from) { where.push('updated_at >= ?'); args.push(f.from); }
  if (f.to) { where.push('updated_at <= ?'); args.push(f.to); }
  const pattern = likePattern(f.q);
  if (pattern) { where.push(`(${sqlLikeClause(['title'])})`); args.push(pattern); }
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

function versionStatement(db: D1Database, documentId: string, version: number, content: string, origin: VersionOrigin, summary: string, jobId: string | null, actorId: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO creative_document_versions (document_id, version, content_json, origin, change_summary, job_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(documentId, version, content, origin, summary.slice(0, 300), jobId, actorId, now);
}

/** Keep the newest KEEP_VERSIONS rows; never drop a version that was approved or exported final. */
function pruneStatement(db: D1Database, documentId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM creative_document_versions
        WHERE document_id = ?1
          AND version < COALESCE((SELECT MIN(version) FROM (SELECT version FROM creative_document_versions WHERE document_id = ?1 ORDER BY version DESC LIMIT ?2)), 0)
          AND version NOT IN (SELECT version FROM creative_reviews WHERE document_id = ?1 AND decision = 'approved')
          AND version NOT IN (SELECT version FROM creative_exports WHERE document_id = ?1 AND final = 1)`
    )
    .bind(documentId, KEEP_VERSIONS);
}

/** The approval of this design stops counting: its review row says when and why; the design is a draft again. */
function invalidateStatements(db: D1Database, documentId: string, reason: string, now: string): D1PreparedStatement[] {
  return [
    db
      .prepare(`UPDATE creative_reviews SET invalidated_at = ?, invalidated_reason = ? WHERE document_id = ? AND decision = 'approved' AND invalidated_at IS NULL`)
      .bind(now, reason, documentId),
  ];
}

export interface CreateInput {
  title: string;
  content: unknown;
  kind: DocKind;
  campaign_id: string | null;
  parent_id: string | null;
  idempotency_key: string | null;
}

export async function createDocument(db: D1Database, actorId: string, input: CreateInput): Promise<DocRow> {
  if (input.idempotency_key) {
    const existing = await db.prepare('SELECT * FROM creative_documents WHERE idempotency_key = ?').bind(input.idempotency_key).first<DocRow>();
    if (existing) {
      if (existing.created_by !== actorId) throw new HttpError(409, 'This idempotency key was already used.', 'IDEMPOTENCY_KEY_REUSED');
      return existing;
    }
  }
  const doc = writeContent(input.content);
  const id = newId('cdoc');
  const now = nowIso();
  const content = JSON.stringify(doc);
  await db.batch([
    db
      .prepare(
        `INSERT INTO creative_documents (id, title, status, kind, campaign_id, parent_id, format_id, width, height, product_id, template_id, version,
                                         content_json, brand_version, idempotency_key, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, input.title, input.kind, input.campaign_id, input.parent_id, doc.format.id, doc.format.width, doc.format.height, mainProduct(doc), doc.template?.id ?? null, content, doc.brand_version, input.idempotency_key, actorId, now, actorId, now),
    versionStatement(db, id, 1, content, doc.template ? 'template' : 'manual', 'created', null, actorId, now),
  ]);
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

/**
 * Save a design. Refuses a stale base (VERSION_CONFLICT) and a fatal document;
 * a content change bumps the version, keeps a version row when meaningful,
 * and invalidates an approval. An AI result (`job_id`) is accepted only from a
 * succeeded, not cancelled, not yet applied job of this design — and it is
 * marked applied in the SAME batch, so a cancel can never slip between.
 */
export async function saveDocument(db: D1Database, actorId: string, id: string, input: SaveInput): Promise<DocRow> {
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
    return (await getDocRow(db, id))!;
  }
  const next = row.version + 1;
  const wasReviewed = row.status === 'approved' || row.status === 'in_review' || row.approved_version !== null;
  statements.push(
    db
      .prepare(
        `UPDATE creative_documents
            SET content_json = ?, version = ?, title = ?, format_id = ?, width = ?, height = ?, product_id = ?, template_id = ?, brand_version = ?,
                status = CASE WHEN status IN ('approved', 'in_review') THEN 'draft' ELSE status END,
                approved_version = NULL, updated_by = ?, updated_at = ?
          WHERE id = ? AND version = ?`
      )
      .bind(content, next, title, doc.format.id, doc.format.width, doc.format.height, mainProduct(doc), doc.template?.id ?? null, doc.brand_version, actorId, now, id, row.version)
  );
  if (wasReviewed) statements.push(...invalidateStatements(db, id, 'content_changed', now));
  const last = await db.prepare('SELECT MAX(created_at) AS at FROM creative_document_versions WHERE document_id = ?').bind(id).first<{ at: string | null }>();
  const stale = !last?.at || Date.parse(now) - Date.parse(last.at) >= CHECKPOINT_AFTER_MS;
  if (MEANINGFUL.has(input.origin) || input.checkpoint || stale || input.job_id) {
    statements.push(versionStatement(db, id, next, content, input.origin, input.change_summary, input.job_id, actorId, now));
    statements.push(pruneStatement(db, id));
  }
  if (input.job_id) {
    statements.push(
      db.prepare(`UPDATE creative_jobs SET applied_at = ?, applied_version = ? WHERE id = ? AND status = 'succeeded' AND applied_at IS NULL`).bind(now, next, input.job_id)
    );
  }
  const results = await db.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const current = await getDocRow(db, id);
    throw new HttpError(409, 'This design changed since you opened it.', 'VERSION_CONFLICT', { current_version: current?.version ?? null });
  }
  return (await getDocRow(db, id))!;
}

export async function restoreDocument(db: D1Database, actorId: string, id: string, version: number, baseVersion: number): Promise<DocRow> {
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

export async function setStatus(db: D1Database, actorId: string, id: string, status: 'draft' | 'in_review' | 'archived', baseVersion: number): Promise<DocRow> {
  const row = await requireDoc(db, id);
  if (baseVersion !== row.version) throw new HttpError(409, 'This design changed since you opened it.', 'VERSION_CONFLICT', { current_version: row.version });
  if (row.status === status) return row;
  if (!(TRANSITIONS[row.status] ?? []).includes(status)) throw badRequest(`A ${row.status} design cannot become ${status}`, 'INVALID_INPUT');
  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE creative_documents SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END,
                approved_version = CASE WHEN ? = 'archived' THEN approved_version ELSE NULL END, updated_by = ?, updated_at = ?
          WHERE id = ? AND version = ?`
      )
      .bind(status, status, now, status, actorId, now, id, row.version),
  ];
  // Taking an approved design back to draft withdraws its approval, on the record.
  if (row.status === 'approved' && status === 'draft') statements.push(...invalidateStatements(db, id, 'withdrawn', now));
  await db.batch(statements);
  return (await getDocRow(db, id))!;
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
}

/** Does the design show a bound price / availability? (A change to a field it does not show does not block.) */
export function shows(doc: CreativeDocument): { price: boolean; availability: boolean } {
  const texts = doc.layers.filter((l) => l.visible && l.type === 'text');
  const bound = (field: string) => texts.some((t) => t.type === 'text' && t.source.kind === 'product' && t.source.field === field);
  return { price: bound('price') || bound('price_note'), availability: bound('availability') };
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
  for (const b of doc.products) {
    const snap = bound.get(b.snapshot_id);
    if (!snap) continue;
    snapshots[b.slot] = { id: snap.id, data: snap.data, source: snap.source };
    const fresh = await buildSnapshotData(db, b.product_id, b.variant_key);
    changes[b.slot] = compareSnapshots(snap.data, fresh);
  }
  const blocking = [...new Set(Object.values(changes).flatMap((c) => blockingChanges(c, shows(doc))))];
  const claimsMap = await approvedClaims(db, doc.services.map((s) => s.claim_id));
  const claims: Record<string, ClaimState> = {};
  for (const [id, c] of claimsMap) claims[id] = c;
  return { snapshots, changes, blocking, claims, brand: await brandForDocument(db, doc.brand_version) };
}

export function serverReport(doc: CreativeDocument, v: Verification, final: boolean): QualityReport {
  return qualityReport(doc, { brand: v.brand, snapshots: v.snapshots, claims: v.claims, verification: v.changes, final, now: nowIso() });
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
  if (v.blocking.length) {
    throw new HttpError(409, 'The store data this design shows has changed; review it before approving.', 'SOURCE_CHANGED', { changes: v.blocking, by_slot: v.changes });
  }
  const report = serverReport(doc, v, true);
  const extra = clientBlockers(req.qa);
  const blockers = [...report.issues.filter((i) => i.severity === 'blocker'), ...extra];
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
  const results = await db.batch([
    db
      .prepare(`UPDATE creative_documents SET status = 'approved', approved_version = ?, needs_review_json = '[]', updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`)
      .bind(row.version, actorId, now, id, row.version),
    db
      .prepare(
        `INSERT INTO creative_reviews (id, document_id, version, decision, reasons_json, note, brand_version, export_ids_json, qa_json, actor_id, created_at)
         VALUES (?, ?, ?, 'approved', '[]', '', ?, ?, ?, ?, ?)`
      )
      .bind(reviewId, id, row.version, doc.brand_version, JSON.stringify(exportIds), JSON.stringify(qaRecord), actorId, now),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) throw new HttpError(409, 'The design changed while it was being approved.', 'APPROVAL_STALE');
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
  if (row.approved_version !== null || row.status === 'approved') statements.push(...invalidateStatements(db, id, 'rejected', now));
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
