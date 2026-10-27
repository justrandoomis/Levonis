/**
 * BRAND-KIT VERSIONS (spec §5, §6).
 *
 * A save is always a NEW version (`creative_brand_versions`, never an UPDATE of
 * an old kit), so a design keeps the kit it was made with and an approved
 * design never changes under its approver. The kit in force is the latest
 * APPROVED version; before the owner approves one, the latest pending version;
 * before anything is saved, `defaultBrandKit()` — itself marked as pending
 * («افتراضي، بانتظار اعتماد المالك»), built only from what the repository has.
 *
 * Every kit passes `normalizeBrandKit` on save AND on read: a hand-edited row
 * can never put an unregistered font or a non-hex colour in front of the
 * editor.
 */
import type { BrandDto, BrandVersionDto } from '../../../packages/creativeDoc/src/api';
import { defaultBrandKit, normalizeBrandKit, type BrandKit } from '../../../packages/creativeDoc/src/brand';
import { isMissingSchema, namesOf, nowIso } from './db';

/** The site's master logo (src/lib/siteLogo.ts: 1254×1254 WebP), drawn as `{kind:'logo', ref:'site'}`. */
export const SITE_LOGO = Object.freeze({ width: 1254, height: 1254 });

interface BrandRow {
  version: number;
  kit_json: string;
  status: 'pending' | 'approved';
  note: string;
  created_by: string | null;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

function kitOf(json: string): BrandKit {
  try {
    return normalizeBrandKit(JSON.parse(json)).kit;
  } catch {
    return defaultBrandKit();
  }
}

/** The kit in force (see the header), with `migrated: false` on a database without 0215. */
export async function currentBrand(db: D1Database): Promise<BrandDto> {
  try {
    const row =
      (await db.prepare(`SELECT * FROM creative_brand_versions WHERE status = 'approved' ORDER BY version DESC LIMIT 1`).first<BrandRow>()) ??
      (await db.prepare(`SELECT * FROM creative_brand_versions ORDER BY version DESC LIMIT 1`).first<BrandRow>());
    if (!row) return { migrated: true, version: null, status: 'default', kit: defaultBrandKit(), site_logo: { ...SITE_LOGO } };
    return { migrated: true, version: row.version, status: row.status, kit: kitOf(row.kit_json), site_logo: { ...SITE_LOGO } };
  } catch (e) {
    if (isMissingSchema(e)) return { migrated: false, version: null, status: 'default', kit: defaultBrandKit(), site_logo: { ...SITE_LOGO } };
    throw e;
  }
}

/** The kit a document was made with (its `brand_version`), else the kit in force. */
export async function brandForDocument(db: D1Database, version: number | null): Promise<BrandKit> {
  if (version !== null) {
    const row = await db.prepare('SELECT kit_json FROM creative_brand_versions WHERE version = ?').bind(version).first<{ kit_json: string }>();
    if (row) return kitOf(row.kit_json);
  }
  return (await currentBrand(db)).kit;
}

export async function brandVersions(db: D1Database): Promise<BrandVersionDto[]> {
  const { results } = await db.prepare('SELECT * FROM creative_brand_versions ORDER BY version DESC LIMIT 100').all<BrandRow>();
  const rows = results ?? [];
  const names = await namesOf(db, rows.map((r) => r.created_by));
  return rows.map((r) => versionDto(r, names));
}

function versionDto(r: BrandRow, names: Map<string, string>): BrandVersionDto {
  return {
    version: r.version,
    status: r.status,
    note: r.note,
    created_at: r.created_at,
    created_by_name: r.created_by ? names.get(r.created_by) ?? null : null,
    approved_at: r.approved_at,
  };
}

/** Save a kit as a new version (pending, or approved at once when the owner says so). */
export async function saveBrandVersion(db: D1Database, actorId: string, kit: BrandKit, note: string, approve: boolean): Promise<BrandVersionDto> {
  const now = nowIso();
  const next = ((await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM creative_brand_versions').first<{ v: number }>())?.v ?? 0) + 1;
  await db
    .prepare(
      `INSERT INTO creative_brand_versions (version, kit_json, status, note, created_by, created_at, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(next, JSON.stringify(kit), approve ? 'approved' : 'pending', note, actorId, now, approve ? actorId : null, approve ? now : null)
    .run();
  const row = (await db.prepare('SELECT * FROM creative_brand_versions WHERE version = ?').bind(next).first<BrandRow>())!;
  return versionDto(row, await namesOf(db, [actorId]));
}

/** Approve one saved version. Null when it does not exist. */
export async function approveBrandVersion(db: D1Database, actorId: string, version: number): Promise<BrandVersionDto | null> {
  const row = await db.prepare('SELECT * FROM creative_brand_versions WHERE version = ?').bind(version).first<BrandRow>();
  if (!row) return null;
  if (row.status !== 'approved') {
    await db
      .prepare(`UPDATE creative_brand_versions SET status = 'approved', approved_by = ?, approved_at = ? WHERE version = ? AND status = 'pending'`)
      .bind(actorId, nowIso(), version)
      .run();
  }
  const fresh = (await db.prepare('SELECT * FROM creative_brand_versions WHERE version = ?').bind(version).first<BrandRow>())!;
  return versionDto(fresh, await namesOf(db, [fresh.created_by]));
}
