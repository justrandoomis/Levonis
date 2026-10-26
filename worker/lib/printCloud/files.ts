/**
 * MODEL FILES (docs/PRINT_CLOUD.md §6): private storage, validation and the
 * geometry a future 3D preview reads.
 *
 * UPLOAD (in the request, cheap and bounded):
 *   - size within the configured limit, extension STL / 3MF / OBJ;
 *   - the BYTES must be that format (magic numbers / structure via
 *     `sniffFormat`); a renamed file is refused, not trusted;
 *   - a 3MF is a ZIP: its entry list is read WITHOUT inflating anything and
 *     refused on path traversal, absolute paths, executables or scripts,
 *     nested archives, too many entries, or a missing 3D model part;
 *   - SHA-256 of the content; stored in the PRIVATE bucket under
 *     `print-cloud/<owner>/models/<file>.<ext>`, which /files never serves.
 *
 * ANALYSIS (a durable background job, never the upload request): the
 * repository's mesh parser (`analyseModel`, with its zip-bomb inflate cap and
 * triangle hard cap) measures the bounding box, volume and mesh health. A
 * file the parser cannot measure is REJECTED with its reason; nothing is
 * estimated from it.
 *
 * Source files are never deleted automatically. The owner may delete a file
 * no live job depends on; the row stays (deleted_at) so history keeps its name.
 */
import { unzipSync } from 'fflate';
import { analyseModel, sniffFormat, type ModelAnalysis } from '../modelGeometry';
import { buildMediaKey, mediaBucket } from '../mediaStorage';
import type { Env } from '../types';
import { many, one, type Stmt } from './db';
import { pcError } from './errors';
import { iso, pcId } from './util';

export const SUPPORTED_EXTENSIONS = ['stl', '3mf', 'obj'] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

const MAX_ARCHIVE_ENTRIES = 1000;
const FORBIDDEN_ENTRY = /\.(exe|dll|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|jar|sh|bash|py|php|pl|rb|app|apk|lnk|zip|rar|7z|gz|tar)$/i;

export interface ArchiveInspection {
  ok: boolean;
  entries: number;
  reason?: 'ARCHIVE_UNREADABLE' | 'ARCHIVE_TOO_MANY_ENTRIES' | 'ARCHIVE_PATH_TRAVERSAL' | 'ARCHIVE_DANGEROUS_ENTRY' | 'ARCHIVE_NO_MODEL';
  detail?: string;
}

/**
 * Read a 3MF's central directory only. `filter` returning false skips every
 * entry, so nothing is decompressed: a zip bomb costs nothing here.
 */
export function inspect3mfArchive(bytes: Uint8Array): ArchiveInspection {
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter: (f) => {
        names.push(f.name);
        return false;
      },
    });
  } catch {
    return { ok: false, entries: names.length, reason: 'ARCHIVE_UNREADABLE' };
  }
  if (names.length > MAX_ARCHIVE_ENTRIES) return { ok: false, entries: names.length, reason: 'ARCHIVE_TOO_MANY_ENTRIES' };
  for (const n of names) {
    const norm = n.replace(/\\/g, '/');
    if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').some((seg) => seg === '..')) {
      return { ok: false, entries: names.length, reason: 'ARCHIVE_PATH_TRAVERSAL', detail: n.slice(0, 120) };
    }
    if (FORBIDDEN_ENTRY.test(norm)) return { ok: false, entries: names.length, reason: 'ARCHIVE_DANGEROUS_ENTRY', detail: n.slice(0, 120) };
  }
  if (!names.some((n) => /\.model$/i.test(n))) return { ok: false, entries: names.length, reason: 'ARCHIVE_NO_MODEL' };
  return { ok: true, entries: names.length };
}

export interface ValidatedUpload {
  extension: SupportedExtension;
  format: string;
  sha256: string;
  size: number;
}

/**
 * The format the bytes prove: a binary or ASCII STL, a ZIP (3MF), or text
 * whose first lines are OBJ statements. OBJ has no magic number, so it is
 * accepted only as printable text that reads like OBJ — never as «unknown».
 */
export function detectFormat(bytes: Uint8Array): string {
  const sniffed = sniffFormat(bytes, '');
  if (sniffed !== 'unknown') return sniffed;
  const n = Math.min(bytes.length, 512);
  let head = '';
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0 || (b < 9 && b !== 0) || (b > 13 && b < 32)) return 'unknown';
    head += String.fromCharCode(b);
  }
  return /^\s*(v|vn|vt|f|o|g|mtllib|usemtl|#)\s/m.test(head) ? 'obj' : 'unknown';
}

/** Everything the upload request itself checks. Throws the refusal; never stores. */
export async function validateUpload(bytes: Uint8Array, originalName: string, maxBytes: number): Promise<ValidatedUpload> {
  if (bytes.byteLength === 0) throw pcError('FILE_REJECTED', { reason: 'EMPTY_FILE' });
  if (bytes.byteLength > maxBytes) throw pcError('FILE_TOO_LARGE', { max_bytes: maxBytes });
  const ext = (originalName.split('.').pop() ?? '').toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) throw pcError('FILE_TYPE_NOT_SUPPORTED', { extension: ext.slice(0, 10) });
  const expected = ext === 'stl' ? 'stl' : ext === '3mf' ? '3mf' : 'obj';
  // An extension is a claim; the bytes are the evidence. `sniffFormat` is
  // asked WITHOUT the name, so it can only answer from a signature.
  const sniffed = detectFormat(bytes);
  if (sniffed !== expected) throw pcError('FILE_TYPE_NOT_SUPPORTED', { reason: 'CONTENT_DOES_NOT_MATCH_EXTENSION', detected: sniffed });
  if (expected === '3mf') {
    const archive = inspect3mfArchive(bytes);
    if (!archive.ok) throw pcError('FILE_REJECTED', { reason: archive.reason, detail: archive.detail ?? '' });
  }
  return { extension: expected as SupportedExtension, format: sniffed, sha256: await sha256OfBytes(bytes), size: bytes.byteLength };
}

/** The standard SHA-256 of the file's bytes, hex. */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A filename safe to keep and show: no path, no control characters, bounded. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'model';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
  return cleaned || 'model';
}

type StorageEnv = Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;

/** Store validated bytes privately and return the row's INSERT (status 'uploaded'). */
export async function storeModelFile(
  env: StorageEnv,
  db: D1Database,
  p: { userId: string; bytes: Uint8Array; originalName: string; validated: ValidatedUpload; source: 'upload' | 'url_import'; importId?: string | null; now: Date }
): Promise<{ fileId: string; storageKey: string; statement: Stmt }> {
  const bucket = mediaBucket(env, 'private');
  if (!bucket) throw pcError('STORAGE_NOT_CONFIGURED');
  const fileId = pcId('pcf');
  const storageKey = buildMediaKey({
    visibility: 'private',
    domain: 'print-cloud',
    entityId: p.userId,
    kind: 'models',
    extension: p.validated.extension,
    objectId: fileId,
  });
  await bucket.put(storageKey, p.bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
  return {
    fileId,
    storageKey,
    statement: db
      .prepare(
        `INSERT INTO pc_model_files (id, user_id, original_name, extension, format, type_check, size_bytes, storage_key, content_sha256, source,
           import_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'matched', ?, ?, ?, ?, ?, 'uploaded', ?, ?)`
      )
      .bind(
        fileId,
        p.userId,
        cleanFileName(p.originalName),
        p.validated.extension,
        p.validated.format,
        p.validated.size,
        storageKey,
        p.validated.sha256,
        p.source,
        p.importId ?? null,
        iso(p.now),
        iso(p.now)
      ),
  };
}

export interface FileRow {
  id: string;
  user_id: string;
  original_name: string;
  extension: string;
  format: string;
  size_bytes: number;
  storage_key: string;
  content_sha256: string;
  status: string;
  rejection_code: string | null;
  analysis_json: string;
  size_x_um: number | null;
  size_y_um: number | null;
  size_z_um: number | null;
  volume_mm3: number | null;
  triangle_count: number | null;
  source: string;
  import_id: string | null;
  deleted_at: string | null;
  created_at: string;
}

const um = (mm: number): number => Math.round(mm * 1000);

/** Why an analysis means rejection, or null when the file is printable input. */
export function rejectionFor(a: ModelAnalysis): string | null {
  if (!a.measured) return a.reason ?? 'NOT_MEASURABLE';
  const blocking = a.warnings.find((w) => w.severity === 'blocking');
  if (blocking) return blocking.code;
  if (a.triangle_count <= 0) return 'EMPTY_MESH';
  if (a.dimensions_mm.x <= 0 || a.dimensions_mm.y <= 0 || a.dimensions_mm.z <= 0) return 'ZERO_DIMENSION';
  return null;
}

/**
 * The background analysis of one stored file. Idempotent: a file already
 * 'ready' or 'rejected' is left alone; the status flip is conditional.
 */
export async function analyseStoredFile(env: StorageEnv & { DB: D1Database }, fileId: string, now: Date): Promise<'ready' | 'rejected' | 'skipped' | 'missing'> {
  const db = env.DB;
  const file = await one<FileRow>(db, 'SELECT * FROM pc_model_files WHERE id = ?', fileId);
  if (!file || file.deleted_at) return 'missing';
  if (file.status !== 'uploaded' && file.status !== 'processing') return 'skipped';
  await db.prepare("UPDATE pc_model_files SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'uploaded'").bind(iso(now), fileId).run();
  const obj = await mediaBucket(env, 'private').get(file.storage_key);
  if (!obj) {
    await db
      .prepare("UPDATE pc_model_files SET status = 'failed', rejection_code = 'OBJECT_MISSING', updated_at = ? WHERE id = ? AND status = 'processing'")
      .bind(iso(now), fileId)
      .run();
    return 'missing';
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let analysis: ModelAnalysis;
  try {
    analysis = analyseModel(bytes, file.original_name);
  } catch (e) {
    // The parser's own caps (inflate limit, triangle cap) throw: a refusal, recorded with its reason.
    const reason = e instanceof Error && /ARCHIVE_TOO_DEEP/.test(e.message) ? 'ARCHIVE_TOO_LARGE_WHEN_INFLATED' : 'PARSE_ERROR';
    await db
      .prepare("UPDATE pc_model_files SET status = 'rejected', rejection_code = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
      .bind(reason, iso(now), fileId)
      .run();
    return 'rejected';
  }
  const rejection = rejectionFor(analysis);
  await db
    .prepare(
      `UPDATE pc_model_files SET status = ?, rejection_code = ?, analysis_json = ?, size_x_um = ?, size_y_um = ?, size_z_um = ?, volume_mm3 = ?,
              triangle_count = ?, updated_at = ?
        WHERE id = ? AND status = 'processing'`
    )
    .bind(
      rejection ? 'rejected' : 'ready',
      rejection,
      JSON.stringify(analysis).slice(0, 20000),
      um(analysis.dimensions_mm.x),
      um(analysis.dimensions_mm.y),
      um(analysis.dimensions_mm.z),
      Math.round(analysis.volume_mm3),
      analysis.triangle_count,
      iso(now),
      fileId
    )
    .run();
  return rejection ? 'rejected' : 'ready';
}

/** Does a bounding box fit a build volume — as oriented, and in any axis-aligned orientation? */
export function fitsBuildVolume(
  size: { x: number; y: number; z: number },
  build: { x: number; y: number; z: number }
): { as_oriented: boolean; any_orientation: boolean } {
  const as = size.x <= build.x && size.y <= build.y && size.z <= build.z;
  const s = [size.x, size.y, size.z].sort((a, b) => a - b);
  const b = [build.x, build.y, build.z].sort((a, c) => a - c);
  return { as_oriented: as, any_orientation: s[0] <= b[0] && s[1] <= b[1] && s[2] <= b[2] };
}

/** The file as its owner reads it: metadata, geometry and per-model build-volume fit. */
export async function fileView(db: D1Database, file: FileRow) {
  const analysis = JSON.parse(file.analysis_json || '{}') as Partial<ModelAnalysis>;
  const size = file.size_x_um !== null ? { x: file.size_x_um / 1000, y: Number(file.size_y_um) / 1000, z: Number(file.size_z_um) / 1000 } : null;
  let compatibility: Array<{ printer_model_id: string; code: string; as_oriented: boolean; any_orientation: boolean }> = [];
  if (size) {
    const models = await many<{ id: string; code: string; build_x_mm: number; build_y_mm: number; build_z_mm: number }>(
      db,
      'SELECT id, code, build_x_mm, build_y_mm, build_z_mm FROM pc_printer_models WHERE active = 1 ORDER BY code'
    );
    compatibility = models.map((m) => ({
      printer_model_id: m.id,
      code: m.code,
      ...fitsBuildVolume(size, { x: m.build_x_mm, y: m.build_y_mm, z: m.build_z_mm }),
    }));
  }
  return {
    id: file.id,
    original_name: file.original_name,
    extension: file.extension,
    format: file.format,
    size_bytes: file.size_bytes,
    content_sha256: file.content_sha256,
    status: file.status,
    rejection_code: file.rejection_code,
    source: file.source,
    import_id: file.import_id,
    created_at: file.created_at,
    deleted: !!file.deleted_at,
    geometry: file.status === 'ready'
      ? {
          unit: 'mm',
          unit_source: analysis.unit_source ?? null,
          dimensions_mm: size,
          bbox_min_mm: analysis.bbox_min_mm ?? null,
          bbox_max_mm: analysis.bbox_max_mm ?? null,
          volume_mm3: file.volume_mm3,
          surface_area_mm2: analysis.surface_area_mm2 ?? null,
          triangle_count: file.triangle_count,
          shell_count: analysis.shell_count ?? null,
          watertight: analysis.watertight ?? null,
          overhang_ratio: analysis.overhang_ratio ?? null,
          warnings: analysis.warnings ?? [],
          title: analysis.title ?? null,
          suggested_material: analysis.suggested_material ?? null,
          suggested_colors: analysis.suggested_colors ?? [],
        }
      : null,
    printer_compatibility: compatibility,
  };
}

/** The live jobs that still need a file — it cannot be deleted under them. */
export async function liveJobsUsingFile(db: D1Database, fileId: string): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    // A failed job whose failure is still undecided may yet be reprinted from this file.
    `SELECT COUNT(*) AS n FROM pc_print_jobs j
      WHERE (j.status NOT IN ('completed', 'failed', 'cancelled', 'reprint_requested')
             OR (j.status = 'failed' AND EXISTS (SELECT 1 FROM pc_failures f WHERE f.id = j.failure_id AND f.status = 'reported')))
        AND EXISTS (SELECT 1 FROM pc_project_models m WHERE m.project_id = j.project_id AND m.file_id = ?)`,
    fileId
  );
  return Number(row?.n ?? 0);
}

// ------------------------------------------------------------------ signed download links

const enc = new TextEncoder();

async function hmacB64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A short-lived link to one file for one user. Needs PRINT_CLOUD_FILE_URL_SECRET (≥ 32 chars). */
export async function signFileToken(secret: string | undefined, fileId: string, userId: string, expiresAt: Date): Promise<string> {
  if (!secret || secret.length < 32) throw pcError('STORAGE_NOT_CONFIGURED', { reason: 'signing_secret_missing' });
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const payload = `${fileId}.${userId}.${exp}`;
  return `${payload}.${await hmacB64(secret, payload)}`;
}

export async function verifyFileToken(secret: string | undefined, token: string, now: Date): Promise<{ fileId: string; userId: string } | null> {
  if (!secret || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [fileId, userId, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp < Math.floor(now.getTime() / 1000)) return null;
  const expected = await hmacB64(secret, `${fileId}.${userId}.${exp}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { fileId, userId } : null;
}
