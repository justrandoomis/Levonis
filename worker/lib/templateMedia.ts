import type { Env } from './types';
import type { ProductDoc } from './productModel';
import { badRequest } from './http';
import { newId } from './crypto';
import { ownedMediaKeys } from './productDeletion';
import { getMediaObject, isSafeMediaKey, isAnonymousPublicMediaKey, putMediaObject } from './mediaStorage';

const PREFIX = '# levonis_asset_v1=';
export const MAX_TEMPLATE_CHARS = 40 * 1024 * 1024;
export const MAX_TEMPLATE_BODY_BYTES = 48 * 1024 * 1024;
const MAX_ASSET_BYTES = 24 * 1024 * 1024;
const MIME = /^(image\/(webp|png|jpeg|gif|avif)|video\/mp4|application\/(pdf|octet-stream)|model\/(stl|3mf))$/;
interface Asset { key: string; mime: string; bytes: number; sha256: string; data: string }
interface Upload { key: string; mime: string; bytes: Uint8Array }
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('');
function encode(bytes: Uint8Array): string {
  let out = ''; for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}

/** A TXT export is a portable backup, including first-party bytes. Never fetch
 * arbitrary URLs, silently omit a missing object, or export private attachments. */
export async function exportTemplateMedia(env: Env, doc: ProductDoc, text: string): Promise<string> {
  let total = 0; const lines: string[] = [];
  for (const key of ownedMediaKeys(doc, env.APP_ORIGIN)) {
    if (!isAnonymousPublicMediaKey(key)) throw badRequest('A product references a private media key');
    const object = await getMediaObject(env, 'public', key);
    if (!object) throw badRequest(`Cannot make a complete export: missing media ${key}`, 'MEDIA_MISSING');
    total += object.size;
    if (total > MAX_ASSET_BYTES) throw badRequest('The self-contained TXT media exceeds 24 MiB', 'TEMPLATE_MEDIA_TOO_LARGE');
    const bytes = new Uint8Array(await object.arrayBuffer());
    const asset: Asset = { key, mime: object.httpMetadata?.contentType ?? 'application/octet-stream', bytes: bytes.length, sha256: await hash(bytes), data: encode(bytes) };
    if (!MIME.test(asset.mime)) throw badRequest(`Unsupported product media type: ${asset.mime}`);
    lines.push(PREFIX + JSON.stringify(asset));
  }
  return `${text}\n# Portable internal media. Keep these lines to restore after permanent deletion.\n${lines.join('\n')}\n`;
}

/** Read/validate first. Allocate fresh immutable keys only for media that needs
 * restoration; an ordinary update keeps an unchanged, still-live object. */
export async function prepareTemplateMedia(env: Env, doc: ProductDoc, text: string): Promise<{ doc: ProductDoc; uploads: Upload[] }> {
  const used = ownedMediaKeys(doc, env.APP_ORIGIN); const seen = new Set<string>();
  const map = new Map<string, string>(); const uploads: Upload[] = []; let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(PREFIX)) continue;
    let a: Asset;
    try { a = JSON.parse(line.slice(PREFIX.length)) as Asset; } catch { throw badRequest('Invalid embedded media manifest'); }
    if (!isSafeMediaKey(a.key) || !isAnonymousPublicMediaKey(a.key) || !used.has(a.key) || seen.has(a.key) || !MIME.test(a.mime) || !Number.isSafeInteger(a.bytes) || a.bytes < 0 || typeof a.data !== 'string') throw badRequest('Invalid or unreferenced embedded media');
    seen.add(a.key); total += a.bytes;
    if (total > MAX_ASSET_BYTES || a.data.length > Math.ceil(a.bytes / 3) * 4 + 4) throw badRequest('Embedded media exceeds size limit');
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0)); } catch { throw badRequest('Invalid embedded media encoding'); }
    if (bytes.length !== a.bytes || await hash(bytes) !== a.sha256) throw badRequest(`Embedded media checksum failed: ${a.key}`);
    const locked = await env.DB.prepare('SELECT 1 FROM media_cleanup_locks WHERE object_key=?').bind(a.key).first();
    const existing = locked ? null : await getMediaObject(env, 'public', a.key);
    if (existing && existing.size === a.bytes && await hash(new Uint8Array(await existing.arrayBuffer())) === a.sha256) continue;
    const extension = a.key.split('.').pop()?.toLowerCase() ?? 'bin';
    if (!/^(webp|png|jpg|jpeg|gif|avif|mp4|pdf|stl|3mf)$/.test(extension)) throw badRequest('Unsupported embedded media extension');
    const key = `products/${doc.id}/restored/${newId()}.${extension}`;
    map.set(a.key, key); uploads.push({ key, mime: a.mime, bytes });
  }
  const replace = (value: unknown, field = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => replace(v, field));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v, k)]));
    if (typeof value !== 'string') return value;
    for (const key of ownedMediaKeys(value, env.APP_ORIGIN, field)) {
      const next = map.get(key); if (next) return value === key ? next : `/files/${next}`;
    }
    return value;
  };
  return { doc: replace(doc) as ProductDoc, uploads };
}

/** The outbox precedes uploads. If this request dies before the product batch
 * commits, the scheduled cleanup sees no references and removes only these new
 * keys. The grace period prevents collection while the import is in flight. */
export async function uploadTemplateMedia(env: Env, productId: string, actorId: string, uploads: Upload[]): Promise<string | null> {
  if (!uploads.length) return null;
  const id = newId('pdel');
  await env.DB.batch([
    env.DB.prepare("INSERT INTO product_deletion_jobs(id,product_id,slug,actor_id,status) VALUES (?,?,'template-media-recovery',?,'committed')").bind(id,productId,actorId),
    ...uploads.map((u) => env.DB.prepare("INSERT INTO media_cleanup_jobs(id,deletion_job_id,object_key,not_before) VALUES (?,?,?,datetime('now','+1 hour'))").bind(newId('mclean'),id,u.key)),
  ]);
  for (const u of uploads) await putMediaObject(env, { key:u.key, visibility:'public', domain:'products', mime:u.mime, bytes:u.bytes.length, ownerId:actorId, entityId:productId }, u.bytes, { httpMetadata:{contentType:u.mime,cacheControl:'no-store'} });
  return id;
}
