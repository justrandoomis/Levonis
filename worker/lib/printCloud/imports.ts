/**
 * MODEL IMPORT BY URL (docs/PRINT_CLOUD.md §6.2): MakerWorld, Printables,
 * Thingiverse and any provider the owner configures.
 *
 * The rules, in the order they bite:
 *
 *   1. ALLOW-LIST. Only https links on an ENABLED provider's hosts are taken.
 *      Everything else is URL_NOT_ALLOWED before a single request is made.
 *   2. SSRF. Every outbound request goes through `guardedFetchBytes`: the
 *      address guard on every hop (no private, loopback or link-local
 *      address), manual redirects re-checked against the allow-list, one
 *      deadline, a hard byte cap.
 *   3. PERMISSION, NOT SCRAPING. Metadata comes only from a provider's own JSON
 *      API the owner configured (`api_url`); no HTML is parsed. A FILE is
 *      downloaded only when that API answers with a file URL on one of the
 *      provider's `download_hosts` — i.e. a download the provider itself
 *      authorises. Paywalls, logins and protected files are never attempted.
 *   4. HONESTY. When no file could be imported the import is `link_saved`
 *      with `MANUAL_UPLOAD_REQUIRED`: the link (and any metadata) is kept and
 *      the customer is asked to upload the file. It is NEVER reported as an
 *      imported file.
 *
 * Every step is logged in `pc_model_import_logs`.
 */
import { parseModelLink, type LinkProviderConfig } from '../externalModels';
import { GuardedFetchError, guardedFetchBytes, validateOutboundUrl } from '../fetchGuard';
import { HttpError } from '../http';
import type { Env } from '../types';
import { one, runBatch, type Stmt } from './db';
import { pcError } from './errors';
import { storeModelFile, validateUpload } from './files';
import type { ImportProvider, PrintCloudConfig } from './settings';
import { enqueueTask } from './tasks';
import { iso, pcId } from './util';

export const PROVIDER_API_MAX_BYTES = 512 * 1024;

function logStmt(db: D1Database, importId: string, level: 'info' | 'warning' | 'error', code: string, detail: Record<string, unknown>, now: Date): Stmt {
  return db
    .prepare('INSERT INTO pc_model_import_logs (id, import_id, level, code, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(pcId('pcmil'), importId, level, code, JSON.stringify(detail).slice(0, 2000), iso(now));
}

const asLinkProviders = (providers: ImportProvider[]): LinkProviderConfig[] =>
  providers.map((p) => ({ id: p.id, hosts: p.hosts, api_url: p.api_url, enabled: p.enabled }));

/** Which enabled provider claims this https URL, and the model id its permalink names. */
export function matchProvider(rawUrl: string, providers: ImportProvider[]): { provider: ImportProvider; externalId: string; canonical: string } {
  let url: URL;
  try {
    url = validateOutboundUrl(rawUrl.trim());
  } catch {
    throw pcError('URL_NOT_ALLOWED', { reason: 'invalid_or_private_address' });
  }
  if (url.protocol !== 'https:') throw pcError('URL_NOT_ALLOWED', { reason: 'https_required' });
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const provider = providers.find((p) => p.enabled && p.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  if (!provider) throw pcError('URL_NOT_ALLOWED', { reason: 'provider_not_supported', host });
  const parsed = parseModelLink(url.toString(), asLinkProviders([provider]));
  return { provider, externalId: parsed?.external_id ?? '', canonical: parsed?.canonical_url ?? url.toString() };
}

/** The request side: validate, record 'pending', queue the work. No network here. */
export async function startImport(db: D1Database, p: { userId: string; url: string; config: PrintCloudConfig; now: Date }) {
  if (p.url.length > 2000) throw pcError('URL_NOT_ALLOWED', { reason: 'too_long' });
  const match = matchProvider(p.url, p.config.import_providers);
  const id = pcId('pcmi');
  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO pc_model_imports (id, user_id, url, canonical_url, provider, external_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(id, p.userId, p.url.trim(), match.canonical, match.provider.id, match.externalId, iso(p.now), iso(p.now)),
    logStmt(db, id, 'info', 'LINK_ACCEPTED', { provider: match.provider.id, external_id: match.externalId }, p.now),
    enqueueTask(db, { kind: 'import_model_url', payload: { import_id: id }, dedupeKey: `import:${id}`, now: p.now }),
  ]);
  return { import_id: id, status: 'pending', provider: match.provider.id, external_id: match.externalId, canonical_url: match.canonical };
}

/** Tolerant reads of somebody else's JSON: the first value of the right type under any of the names. */
function findString(v: unknown, keys: string[], depth = 0): string | undefined {
  if (!v || typeof v !== 'object' || depth > 4) return undefined;
  const o = v as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
  for (const child of Object.values(o)) {
    const found = findString(child, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findStrings(v: unknown, keys: string[], limit = 8): string[] {
  const out: string[] = [];
  const walk = (x: unknown, depth: number) => {
    if (!x || typeof x !== 'object' || depth > 4 || out.length >= limit) return;
    const o = x as Record<string, unknown>;
    for (const k of keys) {
      const val = o[k];
      if (typeof val === 'string' && /^https:\/\//.test(val)) out.push(val);
      if (Array.isArray(val)) for (const item of val) if (typeof item === 'string' && /^https:\/\//.test(item)) out.push(item);
    }
    for (const child of Object.values(o)) walk(child, depth + 1);
  };
  walk(v, 0);
  return [...new Set(out)].slice(0, limit);
}

export interface ImportMetadata {
  name?: string;
  creator?: string;
  description?: string;
  license?: string;
  images: string[];
  recommended_settings?: string;
  /** Present only when the provider's API itself offered a file. */
  download_url?: string;
  download_name?: string;
}

export function extractMetadata(json: unknown): ImportMetadata {
  return {
    name: findString(json, ['title', 'name', 'modelName']),
    creator: findString(json, ['creator', 'author', 'designer', 'username', 'creatorName']),
    description: findString(json, ['description', 'summary'])?.slice(0, 2000),
    license: findString(json, ['license', 'licence', 'licenseName', 'license_name']),
    images: findStrings(json, ['cover', 'coverUrl', 'image', 'images', 'thumbnail', 'thumbnails']),
    recommended_settings: findString(json, ['print_settings', 'printSettings', 'profile', 'recommended_settings'])?.slice(0, 2000),
    download_url: findString(json, ['download_url', 'downloadUrl', 'file_url', 'fileUrl']),
    download_name: findString(json, ['file_name', 'fileName', 'filename']),
  };
}

type ImportEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>;

/**
 * The background side of one import. Idempotent: only a 'pending' import is
 * processed, and its terminal status is written once.
 */
export async function processImport(
  env: ImportEnv,
  importId: string,
  config: PrintCloudConfig,
  now: Date,
  fetcher?: typeof fetch
): Promise<string> {
  const db = env.DB;
  const row = await one<{ id: string; user_id: string; status: string; provider: string; external_id: string; canonical_url: string }>(
    db,
    'SELECT id, user_id, status, provider, external_id, canonical_url FROM pc_model_imports WHERE id = ?',
    importId
  );
  if (!row || row.status !== 'pending') return 'skipped';
  const finish = async (status: 'link_saved' | 'file_imported' | 'failed' | 'rejected', fields: Record<string, unknown>, logs: Stmt[], extra: Stmt[] = []) => {
    await runBatch(db, [
      ...extra,
      db
        .prepare(
          `UPDATE pc_model_imports SET status = ?, metadata_json = ?, license = ?, attribution = ?, file_id = ?, error_code = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`
        )
        .bind(
          status,
          JSON.stringify(fields.metadata ?? {}),
          String(fields.license ?? ''),
          String(fields.attribution ?? ''),
          (fields.file_id as string | null) ?? null,
          (fields.error_code as string | null) ?? null,
          iso(now),
          importId
        ),
      ...logs,
    ]);
    return status;
  };
  const provider = config.import_providers.find((p) => p.id === row.provider && p.enabled);
  if (!provider) {
    return finish('link_saved', { error_code: 'MANUAL_UPLOAD_REQUIRED' }, [logStmt(db, importId, 'warning', 'PROVIDER_DISABLED', {}, now)]);
  }
  if (!provider.api_url || !row.external_id) {
    return finish('link_saved', { error_code: 'MANUAL_UPLOAD_REQUIRED' }, [
      logStmt(db, importId, 'info', provider.api_url ? 'NO_MODEL_ID_IN_LINK' : 'NO_PROVIDER_API_CONFIGURED', { provider: provider.id }, now),
    ]);
  }
  let apiUrl: URL;
  try {
    apiUrl = validateOutboundUrl(provider.api_url.replace('{id}', encodeURIComponent(row.external_id)));
  } catch {
    return finish('link_saved', { error_code: 'MANUAL_UPLOAD_REQUIRED' }, [logStmt(db, importId, 'error', 'PROVIDER_API_URL_INVALID', {}, now)]);
  }
  let metadata: ImportMetadata;
  try {
    const res = await guardedFetchBytes(apiUrl.toString(), {
      maxBytes: PROVIDER_API_MAX_BYTES,
      timeoutMs: 8000,
      maxRedirects: 2,
      fetcher,
      allowUrl: (u) => u.protocol === 'https:' && u.hostname === apiUrl.hostname,
      headers: { accept: 'application/json' },
    });
    if (!res.response.ok) throw new GuardedFetchError('FETCH_FAILED', `HTTP ${res.response.status}`, res.response.status);
    metadata = extractMetadata(JSON.parse(new TextDecoder().decode(res.bytes)));
  } catch (e) {
    const code = e instanceof GuardedFetchError ? e.code : 'PROVIDER_ANSWER_UNREADABLE';
    return finish('link_saved', { error_code: 'MANUAL_UPLOAD_REQUIRED' }, [logStmt(db, importId, 'warning', 'PROVIDER_API_FAILED', { code }, now)]);
  }
  const fields = {
    metadata: { name: metadata.name, creator: metadata.creator, description: metadata.description, images: metadata.images, recommended_settings: metadata.recommended_settings },
    license: metadata.license ?? '',
    attribution: metadata.creator ? `${metadata.name ?? ''} — ${metadata.creator}`.trim() : '',
  };
  const download = metadata.download_url;
  let downloadUrl: URL | null = null;
  if (download) {
    try {
      downloadUrl = validateOutboundUrl(download);
    } catch {
      downloadUrl = null;
    }
  }
  const authorised =
    downloadUrl !== null &&
    downloadUrl.protocol === 'https:' &&
    provider.download_hosts.some((h) => downloadUrl!.hostname === h || downloadUrl!.hostname.endsWith(`.${h}`));
  if (!authorised || !downloadUrl) {
    return finish('link_saved', { ...fields, error_code: 'MANUAL_UPLOAD_REQUIRED' }, [
      logStmt(db, importId, 'info', 'METADATA_SAVED', { has_download: !!download, authorised: false }, now),
    ]);
  }
  try {
    const file = await guardedFetchBytes(downloadUrl.toString(), {
      maxBytes: config.max_upload_bytes,
      timeoutMs: 20000,
      maxRedirects: 3,
      fetcher,
      allowUrl: (u) => u.protocol === 'https:' && provider.download_hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)),
    });
    if (!file.response.ok) throw new GuardedFetchError('FETCH_FAILED', `HTTP ${file.response.status}`, file.response.status);
    const name = metadata.download_name || decodeURIComponent(downloadUrl.pathname.split('/').pop() ?? 'model.stl');
    const validated = await validateUpload(file.bytes, name, config.max_upload_bytes);
    const stored = await storeModelFile(env, db, { userId: row.user_id, bytes: file.bytes, originalName: name, validated, source: 'url_import', importId, now });
    return finish('file_imported', { ...fields, file_id: stored.fileId }, [logStmt(db, importId, 'info', 'FILE_IMPORTED', { size: validated.size }, now)], [
      stored.statement,
      enqueueTask(db, { kind: 'analyze_model_file', payload: { file_id: stored.fileId }, dedupeKey: `analyze:${stored.fileId}`, now }),
    ]);
  } catch (e) {
    if (e instanceof HttpError) {
      return finish('rejected', { ...fields, error_code: e.code ?? 'FILE_REJECTED' }, [
        logStmt(db, importId, 'warning', 'DOWNLOADED_FILE_REJECTED', { code: e.code, reason: (e.details as Record<string, unknown> | undefined)?.reason ?? '' }, now),
      ]);
    }
    const code = e instanceof GuardedFetchError ? e.code : 'DOWNLOAD_FAILED';
    return finish('link_saved', { ...fields, error_code: 'MANUAL_UPLOAD_REQUIRED' }, [logStmt(db, importId, 'warning', 'DOWNLOAD_FAILED', { code }, now)]);
  }
}
