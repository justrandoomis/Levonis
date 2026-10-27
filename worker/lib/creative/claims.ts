/**
 * APPROVED SERVICE CLAIMS — the only words a service ad may use for warranty,
 * delivery, returns or anything "free" (spec §19; text.ts CLAIM_EVIDENCE).
 *
 * A claim is an identity (`creative_service_claims`: id + short key) with
 * versions (`creative_service_claim_versions`). Writing makes a new PENDING
 * version; nothing a pending version says reaches a design or a model.
 * Approving a version retires the approved one before it and marks every
 * design bound to an older version as needing review («claim_changed») — the
 * design itself is never edited behind the owner's back.
 *
 * The texts are the owner's, in three languages; an approved claim has its
 * title and summary in Arabic, English AND Sorani (CLAUDE.md), and a Sorani
 * slot is never a copy of the Arabic (DECISIONS row 183).
 */
import type { ClaimDto } from '../../../packages/creativeDoc/src/api';
import type { ClaimState } from '../../../packages/creativeDoc/src/quality';
import { cleanText } from '../../../packages/creativeDoc/src/text';
import type { Localized, ServiceClaimText } from '../../../packages/creativeDoc/src/snapshot';
import { newId } from '../crypto';
import { HttpError, badRequest } from '../http';
import { jsonObject, nowIso, stringList } from './db';

interface VersionRow {
  claim_id: string;
  key: string;
  version: number;
  status: 'pending' | 'approved' | 'retired';
  title_json: string;
  summary_json: string;
  conditions_json: string;
  details_path: string | null;
  product_ids_json: string;
  valid_from: string | null;
  valid_until: string | null;
  last_verified_at: string | null;
  source_note: string;
  approved_at: string | null;
}

const locOf = (json: string): Localized => {
  const o = jsonObject(json);
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return { ar: s(o.ar), en: s(o.en), ckb: s(o.ckb) };
};

export function claimDto(r: VersionRow): ClaimDto {
  return {
    id: r.claim_id,
    key: r.key,
    version: r.version,
    status: r.status,
    title: locOf(r.title_json),
    summary: locOf(r.summary_json),
    conditions: locOf(r.conditions_json),
    details_path: r.details_path,
    product_ids: stringList(r.product_ids_json),
    valid_from: r.valid_from,
    valid_until: r.valid_until,
    last_verified_at: r.last_verified_at,
    source_note: r.source_note,
    approved_at: r.approved_at,
  };
}

const SELECT = `SELECT v.*, c.key FROM creative_service_claim_versions v JOIN creative_service_claims c ON c.id = v.claim_id`;

/**
 * What the claims page lists: per claim, its approved version (if any) and a
 * newer pending one (if any) — the text in force and the text waiting.
 */
export async function listClaims(db: D1Database): Promise<ClaimDto[]> {
  const { results } = await db
    .prepare(
      `${SELECT}
        WHERE v.status = 'approved'
           OR (v.status = 'pending' AND v.version = (SELECT MAX(x.version) FROM creative_service_claim_versions x WHERE x.claim_id = v.claim_id))
        ORDER BY c.key, v.version DESC LIMIT 400`
    )
    .all<VersionRow>();
  return (results ?? []).map(claimDto);
}

/** The approved, current version of each claim id — for quality checks, evidence and models. */
export async function approvedClaims(db: D1Database, ids?: readonly string[]): Promise<Map<string, ClaimState & { product_ids: string[]; approved_at: string | null }>> {
  const out = new Map<string, ClaimState & { product_ids: string[]; approved_at: string | null }>();
  const q = ids
    ? db.prepare(`${SELECT} WHERE v.status = 'approved' AND v.claim_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids))
    : db.prepare(`${SELECT} WHERE v.status = 'approved' LIMIT 200`);
  const { results } = await q.all<VersionRow>();
  for (const r of results ?? []) {
    const dto = claimDto(r);
    out.set(r.claim_id, {
      id: dto.id,
      version: dto.version,
      title: dto.title,
      summary: dto.summary,
      conditions: dto.conditions,
      details_path: dto.details_path,
      approved: true,
      valid_until: dto.valid_until,
      product_ids: dto.product_ids,
      approved_at: dto.approved_at,
    });
  }
  return out;
}

/** An approved claim usable NOW (approved and not expired), as the text a design or a model may use. */
export function claimText(c: ClaimState): ServiceClaimText {
  return { id: c.id, version: c.version, title: c.title, summary: c.summary, conditions: c.conditions, details_path: c.details_path };
}

export function claimIsCurrent(c: ClaimState, now: string): boolean {
  return c.approved && (c.valid_until === null || c.valid_until >= now);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface ClaimInput {
  title: Localized;
  summary: Localized;
  conditions: Localized;
  details_path: string | null;
  product_ids: string[];
  valid_from: string | null;
  valid_until: string | null;
  last_verified_at: string | null;
  source_note: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/;
const PATH = /^\/(?!\/)[A-Za-z0-9/_\-.~?=&%]{0,200}$/;

function localizedInput(v: unknown, name: string, max: number, multiline = false): Localized {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out = { ar: cleanText(o.ar, max, multiline).value, en: cleanText(o.en, max, multiline).value, ckb: cleanText(o.ckb, max, multiline).value };
  if (out.ckb && out.ckb === out.ar) throw badRequest(`${name}.ckb is a copy of the Arabic; write the Sorani text`, 'INVALID_INPUT');
  return out;
}

/** A claim body → its clean fields, or a 400 naming the field. */
export function claimInput(body: Record<string, unknown>): ClaimInput {
  const title = localizedInput(body.title, 'title', 120);
  if (!title.ar && !title.en) throw badRequest('title is required', 'INVALID_INPUT');
  const details = typeof body.details_path === 'string' && body.details_path.trim() ? body.details_path.trim() : null;
  if (details !== null && (!PATH.test(details) || details.includes('..'))) throw badRequest('details_path must be a path on this site', 'INVALID_INPUT');
  const date = (v: unknown, name: string) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !DATE.test(v)) throw badRequest(`${name} must be a date`, 'INVALID_INPUT');
    return v;
  };
  const products = Array.isArray(body.product_ids)
    ? [...new Set(body.product_ids.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)))].slice(0, 100)
    : [];
  return {
    title,
    summary: localizedInput(body.summary, 'summary', 400, true),
    conditions: localizedInput(body.conditions, 'conditions', 800, true),
    details_path: details,
    product_ids: products,
    valid_from: date(body.valid_from, 'valid_from'),
    valid_until: date(body.valid_until, 'valid_until'),
    last_verified_at: date(body.last_verified_at, 'last_verified_at'),
    source_note: cleanText(body.source_note, 400, true).value,
  };
}

function insertVersion(db: D1Database, claimId: string, version: number, i: ClaimInput, actorId: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO creative_service_claim_versions
         (claim_id, version, status, title_json, summary_json, conditions_json, details_path, product_ids_json, valid_from, valid_until,
          last_verified_at, source_note, created_by, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      claimId, version, JSON.stringify(i.title), JSON.stringify(i.summary), JSON.stringify(i.conditions), i.details_path,
      JSON.stringify(i.product_ids), i.valid_from, i.valid_until, i.last_verified_at, i.source_note, actorId, now
    );
}

async function versionRow(db: D1Database, claimId: string, version: number): Promise<VersionRow | null> {
  return (await db.prepare(`${SELECT} WHERE v.claim_id = ? AND v.version = ?`).bind(claimId, version).first<VersionRow>()) ?? null;
}

export async function createClaim(db: D1Database, actorId: string, key: string, i: ClaimInput): Promise<ClaimDto> {
  if (!/^[a-z][a-z0-9_]{0,59}$/.test(key)) throw badRequest('key must be a short code (a-z, 0-9, _)', 'INVALID_INPUT');
  if (await db.prepare('SELECT 1 FROM creative_service_claims WHERE key = ?').bind(key).first()) {
    throw new HttpError(409, 'A claim with this key exists; edit it instead.', 'INVALID_INPUT');
  }
  const id = newId('cclm');
  const now = nowIso();
  await db.batch([
    db.prepare('INSERT INTO creative_service_claims (id, key, created_by, created_at) VALUES (?, ?, ?, ?)').bind(id, key, actorId, now),
    insertVersion(db, id, 1, i, actorId, now),
  ]);
  return claimDto((await versionRow(db, id, 1))!);
}

/** A new pending version of an existing claim. Null when the claim does not exist. */
export async function reviseClaim(db: D1Database, actorId: string, claimId: string, i: ClaimInput): Promise<ClaimDto | null> {
  const head = await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM creative_service_claim_versions WHERE claim_id = ?').bind(claimId).first<{ v: number }>();
  if (!head || head.v === 0) return null;
  const next = head.v + 1;
  await insertVersion(db, claimId, next, i, actorId, nowIso()).run();
  return claimDto((await versionRow(db, claimId, next))!);
}

/**
 * Approve the claim's newest pending version (or `version`): the older
 * approved one is retired, and designs bound to an older version are marked
 * «claim_changed». Returns the approved claim and how many designs were marked.
 */
export async function approveClaim(db: D1Database, actorId: string, claimId: string, version: number | null): Promise<{ claim: ClaimDto; marked: number } | null> {
  const target = version
    ? await versionRow(db, claimId, version)
    : await db.prepare(`${SELECT} WHERE v.claim_id = ? AND v.status = 'pending' ORDER BY v.version DESC LIMIT 1`).bind(claimId).first<VersionRow>();
  if (!target) return null;
  if (target.status === 'retired') throw new HttpError(409, 'A retired claim version cannot be approved again; write a new version.', 'INVALID_INPUT');
  const dto = claimDto(target);
  for (const field of ['title', 'summary'] as const) {
    const l = dto[field];
    if (!l.ar || !l.en || !l.ckb) throw badRequest(`${field} needs Arabic, English and Sorani before approval`, 'INVALID_INPUT');
  }
  const now = nowIso();
  if (target.status === 'pending') {
    await db.batch([
      db.prepare(`UPDATE creative_service_claim_versions SET status = 'retired' WHERE claim_id = ? AND status = 'approved'`).bind(claimId),
      db
        .prepare(`UPDATE creative_service_claim_versions SET status = 'approved', approved_by = ?, approved_at = ? WHERE claim_id = ? AND version = ? AND status = 'pending'`)
        .bind(actorId, now, claimId, target.version),
    ]);
  }
  const marked = await markDocumentsForClaim(db, claimId, target.version);
  return { claim: claimDto((await versionRow(db, claimId, target.version))!), marked };
}

/** Designs bound to an OLDER version of this claim: `needs_review` gains «claim_changed». The content is never edited. */
async function markDocumentsForClaim(db: D1Database, claimId: string, version: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, needs_review_json FROM creative_documents d
        WHERE d.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM json_each(d.content_json, '$.services') s
                       WHERE json_extract(s.value, '$.claim_id') = ? AND json_extract(s.value, '$.claim_version') < ?)
        LIMIT 200`
    )
    .bind(claimId, version)
    .all<{ id: string; needs_review_json: string }>();
  const rows = results ?? [];
  const statements = rows
    .filter((r) => !stringList(r.needs_review_json).includes('claim_changed'))
    .map((r) =>
      db.prepare('UPDATE creative_documents SET needs_review_json = ? WHERE id = ?').bind(JSON.stringify([...stringList(r.needs_review_json), 'claim_changed']), r.id)
    );
  if (statements.length) await db.batch(statements);
  return rows.length;
}

/** Ids of the designs that use a claim (any version), newest first. */
export async function documentsUsingClaim(db: D1Database, claimId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM creative_documents d
        WHERE EXISTS (SELECT 1 FROM json_each(d.content_json, '$.services') s WHERE json_extract(s.value, '$.claim_id') = ?)
        ORDER BY updated_at DESC LIMIT 100`
    )
    .bind(claimId)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

export async function claimExists(db: D1Database, claimId: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM creative_service_claims WHERE id = ?').bind(claimId).first());
}
