/**
 * CAMPAIGNS AND THE INTERNAL CALENDAR (spec §21, §25, §26; migration 0216).
 *
 * A campaign is a named group of designs (`creative_documents.campaign_id`,
 * a column 0215 already has). A planned date is the Asia/Baghdad calendar day
 * a person means to post a design BY HAND: nothing here publishes, and no
 * design's status, version or approval changes when it is planned or moved
 * between campaigns. Only `creative_*` tables are written.
 *
 * DEPLOY-AHEAD: the routes wrap every call in readOr / writeOr503, so a
 * database without 0216 answers an empty list and a 503 on a write.
 */
import type { CampaignDto, DocumentSummaryDto, PlanItemDto } from '../../../packages/creativeDoc/src/api';
import { HttpError, badRequest, notFound } from '../http';
import { newId } from '../crypto';
import { nowIso } from './db';
import { requireDoc, summaries, type DocRow } from './documents';

export const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface CampaignRow {
  id: string;
  name: string;
  notes: string;
  starts_on: string | null;
  ends_on: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  n?: number;
}

function campaignDto(r: CampaignRow): CampaignDto {
  return {
    id: r.id, name: r.name, notes: r.notes, starts_on: r.starts_on, ends_on: r.ends_on, archived: !!r.archived_at,
    document_count: r.n ?? 0, created_at: r.created_at, updated_at: r.updated_at,
  };
}

/** A real calendar day ('2026-02-30' is refused), or null. */
export function dayOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DAY.test(v)) throw badRequest(`${field} must be YYYY-MM-DD`, 'INVALID_INPUT');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw badRequest(`${field} is not a calendar day`, 'INVALID_INPUT');
  return v;
}

export interface CampaignInput {
  name?: string;
  notes?: string;
  starts_on?: string | null;
  ends_on?: string | null;
  archived?: boolean;
}

function checkRange(starts: string | null, ends: string | null): void {
  if (starts && ends && ends < starts) throw badRequest('ends_on is before starts_on', 'INVALID_INPUT');
}

export async function listCampaigns(db: D1Database): Promise<CampaignDto[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM creative_documents d WHERE d.campaign_id = c.id AND d.status <> 'archived') AS n
         FROM creative_campaigns c ORDER BY c.archived_at IS NOT NULL, c.updated_at DESC LIMIT 200`
    )
    .all<CampaignRow>();
  return (results ?? []).map(campaignDto);
}

async function campaignRow(db: D1Database, id: string): Promise<CampaignRow | null> {
  return (await db.prepare('SELECT * FROM creative_campaigns WHERE id = ?').bind(id).first<CampaignRow>()) ?? null;
}

export async function getCampaign(db: D1Database, id: string): Promise<CampaignDto | null> {
  const r = await campaignRow(db, id);
  if (!r) return null;
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM creative_documents WHERE campaign_id = ? AND status <> 'archived'`).bind(id).first<{ n: number }>();
  return campaignDto({ ...r, n: n?.n ?? 0 });
}

export async function createCampaign(db: D1Database, actorId: string, input: Required<Pick<CampaignInput, 'name'>> & CampaignInput): Promise<CampaignDto> {
  checkRange(input.starts_on ?? null, input.ends_on ?? null);
  const id = newId('ccmp');
  const now = nowIso();
  await db
    .prepare('INSERT INTO creative_campaigns (id, name, notes, starts_on, ends_on, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, input.name, input.notes ?? '', input.starts_on ?? null, input.ends_on ?? null, actorId, now, actorId, now)
    .run();
  return (await getCampaign(db, id))!;
}

export async function updateCampaign(db: D1Database, actorId: string, id: string, input: CampaignInput): Promise<CampaignDto> {
  const r = await campaignRow(db, id);
  if (!r) throw notFound('Campaign not found');
  const starts = input.starts_on === undefined ? r.starts_on : input.starts_on;
  const ends = input.ends_on === undefined ? r.ends_on : input.ends_on;
  checkRange(starts, ends);
  const now = nowIso();
  const archivedAt = input.archived === undefined ? r.archived_at : input.archived ? r.archived_at ?? now : null;
  await db
    .prepare('UPDATE creative_campaigns SET name = ?, notes = ?, starts_on = ?, ends_on = ?, archived_at = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(input.name ?? r.name, input.notes ?? r.notes, starts, ends, archivedAt, actorId, now, id)
    .run();
  return (await getCampaign(db, id))!;
}

/** Moves a design into a campaign (or out of every campaign): no new version, an approval stands. */
export async function setDocumentCampaign(db: D1Database, actorId: string, id: string, campaignId: string | null): Promise<DocumentSummaryDto> {
  await requireDoc(db, id);
  if (campaignId) {
    const c = await campaignRow(db, campaignId);
    if (!c) throw notFound('Campaign not found');
    if (c.archived_at) throw new HttpError(409, 'This campaign is archived.', 'INVALID_INPUT');
  }
  await db.prepare('UPDATE creative_documents SET campaign_id = ?, updated_by = ?, updated_at = ? WHERE id = ?').bind(campaignId, actorId, nowIso(), id).run();
  const [sum] = await summaries(db, [(await requireDoc(db, id))]);
  return sum!;
}

/** Sets (or, with null, removes) a design's planned day. Its status, version and approval are untouched. */
export async function setPlan(db: D1Database, actorId: string, id: string, day: string | null, note: string): Promise<{ planned_for: string; note: string } | null> {
  const row = await requireDoc(db, id);
  if (row.status === 'archived' && day) throw new HttpError(409, 'An archived design cannot be planned.', 'INVALID_INPUT');
  if (!day) {
    await db.prepare('DELETE FROM creative_document_plans WHERE document_id = ?').bind(id).run();
    return null;
  }
  await db
    .prepare(
      `INSERT INTO creative_document_plans (document_id, planned_for, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(document_id) DO UPDATE SET planned_for = excluded.planned_for, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
    .bind(id, day, note, actorId, nowIso())
    .run();
  return { planned_for: day, note };
}

/** The planned designs between two days (both included), earliest first; archived designs are left out. */
export async function planBetween(db: D1Database, from: string, to: string): Promise<PlanItemDto[]> {
  const { results } = await db
    .prepare(
      `SELECT d.*, p.planned_for AS plan_day, p.note AS plan_note FROM creative_document_plans p
         JOIN creative_documents d ON d.id = p.document_id
        WHERE p.planned_for >= ? AND p.planned_for <= ? AND d.status <> 'archived'
        ORDER BY p.planned_for, d.updated_at DESC LIMIT 300`
    )
    .bind(from, to)
    .all<DocRow & { plan_day: string; plan_note: string }>();
  const rows = results ?? [];
  const sums = await summaries(db, rows);
  return rows.map((r, i) => ({ planned_for: r.plan_day, note: r.plan_note, document: sums[i]! }));
}
