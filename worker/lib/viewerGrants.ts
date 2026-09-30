/**
 * THE ONE VIEWER'S LINKS FOR PRODUCT AND POST FILES (§9.4 "The shared viewer").
 *
 * A request file's viewer link lives in `model_view_tokens` and is judged by
 * the request's own access rules (worker/lib/requestFilePolicy.ts). A product
 * preview and a post attachment have no request behind them, so their links
 * live in `viewer_grants` (0157) and are judged here — by the same shape of
 * rule the request viewer keeps:
 *
 *   · the client holds a 32-byte random token; the row holds its SHA-256;
 *   · a link lives VIEWER_GRANT_TTL_MINUTES from its minting, whatever
 *     `expires_at` might one day say;
 *   · it is BOUND — to the account that minted it, or, for a guest reading a
 *     public post or shopfront, to an anonymous session hash (IP + user agent
 *     + UTC day), so a link pasted elsewhere opens nothing;
 *   · it grants no more than the source still allows AT THE MOMENT OF READING:
 *     a product hidden or archived, a post archived, made private or hidden by
 *     Levonis, a store suspended — the link stops with the thing it showed,
 *     even before the revoke statement that the hide path also runs;
 *   · what it opens is the derived LVM mesh, never the file (`preview_key`).
 *
 * `null` from `resolveViewerGrant` is ONE answer for "wrong", "expired",
 * "revoked", "not yours" and "the source closed": the route turns it into the
 * same 404 the request viewer gives (VIEWER_TOKEN_INVALID).
 */

import type { Context } from 'hono';
import type { AppContext, Env, SessionUser } from './types';
import { randomToken, sha256Hex } from './crypto';
import { getMediaObject, headMediaObject, putMediaObject, type MediaDomain } from './mediaStorage';
import { analyseModel, viewerMesh, type ModelAnalysis } from './modelGeometry';
import { MODEL_MAX_BYTES } from './attachments';
import type { PreviewGrant } from './requestFilePolicy';
import type { FileKind } from './fileOwnership';
import { blockedEither } from './userBlocks';

export type ViewerSourceType = 'product' | 'post';

/** The same lifetime as a request viewer link (printRequests.ts VIEWER_TOKEN_TTL_MINUTES). */
export const VIEWER_GRANT_TTL_MINUTES = 60;

export interface ViewerSessionInput {
  ip: string;
  ua: string;
}

/**
 * What identifies a guest's browser for the day: the request's IP and user
 * agent. `CF-Connecting-IP` only — the one header Cloudflare sets and a client
 * cannot choose (worker/lib/ratelimit.ts trusts the same); where it is missing
 * the binding is deliberately `'unknown'` rather than a value the guest could
 * write into `X-Forwarded-For` to make a pasted link open elsewhere.
 */
export function viewerSessionInput(c: Context<AppContext>): ViewerSessionInput {
  return {
    ip: c.req.header('CF-Connecting-IP') || 'unknown',
    ua: (c.req.header('User-Agent') || '').slice(0, 512),
  };
}

const utcDay = (offsetDays: number): string => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

/**
 * SHA-256(IP + UA + UTC day). Hashed so the row never stores who opened a
 * shopfront; day-scoped so a link is worth nothing tomorrow. The resolve
 * accepts today's and yesterday's hash, so a link minted at 23:58 does not
 * die at midnight inside its own hour.
 */
export async function anonymousSessionHash(input: ViewerSessionInput, dayOffset = 0): Promise<string> {
  return sha256Hex(`${input.ip}\n${input.ua}\n${utcDay(dayOffset)}`);
}

export interface MintViewerGrantInput {
  sourceType: ViewerSourceType;
  /** product_files.id or community_post_files.id */
  sourceId: string;
  fileKey: string;
  grant: PreviewGrant;
  user: SessionUser | null | undefined;
  session: ViewerSessionInput;
}

export interface MintedViewerGrant {
  token: string;
  url: string;
  expires_at: string;
  grant: PreviewGrant;
}

/** A fresh link. The caller has already decided the source may be previewed by this viewer. */
export async function mintViewerGrant(db: D1Database, input: MintViewerGrantInput): Promise<MintedViewerGrant> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const expires = new Date(Date.now() + VIEWER_GRANT_TTL_MINUTES * 60_000).toISOString();
  const boundUser = input.user?.id ?? null;
  const boundSession = boundUser ? null : await anonymousSessionHash(input.session);
  await db
    .prepare(
      `INSERT INTO viewer_grants (token_hash, source_type, source_id, file_key, grant_level, bound_user, bound_session, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .bind(hash, input.sourceType, input.sourceId, input.fileKey, input.grant, boundUser, boundSession, expires)
    .run();
  return { token, url: `/model-viewer/${token}`, expires_at: expires, grant: input.grant };
}

export interface ResolvedViewerGrant {
  token_hash: string;
  source_type: ViewerSourceType;
  source_id: string;
  grant: PreviewGrant;
  expires_at: string;
  /** The file's listed name — public on a shopfront and a project page, unlike a request file's. */
  name: string;
  kind: FileKind;
  mime: string;
  analysis: ModelAnalysis | null;
  preview_key: string;
}

interface GrantRow {
  token_hash: string;
  source_type: string;
  source_id: string;
  file_key: string;
  grant_level: string;
  bound_user: string | null;
  bound_session: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

interface ProductSourceRow {
  file_key: string; name: string; kind: string; mime: string; analysis: string | null; preview_key: string;
  lifecycle: string; status: string; audience_user_id: string | null; store_status: string; owner_id: string;
}

interface PostSourceRow {
  file_key: string; name: string; kind: string; mime: string; analysis: string | null; preview_key: string;
  author_id: string; state: string; visibility: string; admin_hidden_at: string | null; consent_status: string;
}

function parseAnalysis(raw: string | null | undefined): ModelAnalysis | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ModelAnalysis;
  } catch {
    return null;
  }
}

/**
 * The link, judged now. See the file header for the rules; `null` for every
 * way a link can have stopped working.
 */
export async function resolveViewerGrant(
  env: Env,
  rawToken: string,
  viewer: SessionUser | null | undefined,
  session: ViewerSessionInput
): Promise<ResolvedViewerGrant | null> {
  const token = String(rawToken ?? '').trim();
  if (token.length < 20 || token.length > 120) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT * FROM viewer_grants WHERE token_hash = ?').bind(hash).first<GrantRow>();
  if (!row || row.revoked_at) return null;
  if (!(Date.parse(row.expires_at) > Date.now())) return null;
  const minted = Date.parse(row.created_at);
  if (!(Number.isFinite(minted) && minted + VIEWER_GRANT_TTL_MINUTES * 60_000 > Date.now())) return null;

  // BOUND: to the account, or to the guest's day-scoped session.
  if (row.bound_user) {
    if (!viewer || viewer.id !== row.bound_user) return null;
  } else {
    const today = await anonymousSessionHash(session, 0);
    const yesterday = await anonymousSessionHash(session, 1);
    if (row.bound_session !== today && row.bound_session !== yesterday) return null;
  }

  if (row.source_type === 'product') {
    const src = await env.DB
      .prepare(
        `SELECT f.file_key, f.name, f.kind, f.mime, f.analysis, f.preview_key,
                p.lifecycle, p.status, p.audience_user_id, s.status AS store_status, s.user_id AS owner_id
           FROM product_files f
           JOIN community_products p ON p.id = f.product_id
           JOIN merchant_stores s ON s.id = f.store_id
          WHERE f.id = ?`
      )
      .bind(row.source_id)
      .first<ProductSourceRow>();
    if (!src || src.file_key !== row.file_key) return null;
    const owner = !!row.bound_user && row.bound_user === src.owner_id;
    if (!owner) {
      // The shopfront's own visibility rule (worker/routes/storefront.ts), re-asked now.
      if (src.lifecycle !== 'active' || src.status !== 'active' || src.store_status === 'suspended') return null;
      if (src.audience_user_id && src.audience_user_id !== row.bound_user) return null;
    }
    return shape(row, src);
  }

  const src = await env.DB
    .prepare(
      `SELECT f.file_key, f.name, f.kind, f.mime, f.analysis, f.preview_key,
              p.author_id, p.state, p.visibility, p.admin_hidden_at, p.consent_status
         FROM community_post_files f
         JOIN community_posts p ON p.id = f.post_id
        WHERE f.id = ?`
    )
    .bind(row.source_id)
    .first<PostSourceRow>();
  if (!src || src.file_key !== row.file_key) return null;
  const author = !!row.bound_user && row.bound_user === src.author_id;
  if (!author) {
    // communityPosts.ts `mayRead` for a non-author, re-asked now: not hidden,
    // published, public or unlisted, and the customer's part shown with consent —
    // and, for a link bound to an account, that neither side has since blocked
    // the other (`readablePostForFile` refused it before minting; a block a
    // minute later must not leave the mesh open for the rest of the hour).
    if (src.admin_hidden_at || src.state !== 'published') return null;
    if (src.visibility !== 'public' && src.visibility !== 'unlisted') return null;
    if (src.consent_status !== 'not_needed' && src.consent_status !== 'granted') return null;
    if (row.bound_user && (await blockedEither(env.DB, row.bound_user, src.author_id))) return null;
  }
  return shape(row, src);
}

function shape(row: GrantRow, src: { name: string; kind: string; mime: string; analysis: string | null; preview_key: string }): ResolvedViewerGrant {
  return {
    token_hash: row.token_hash,
    source_type: row.source_type as ViewerSourceType,
    source_id: row.source_id,
    grant: row.grant_level === 'full' ? 'full' : 'preview',
    expires_at: row.expires_at,
    name: String(src.name ?? ''),
    kind: (src.kind as FileKind) ?? 'model',
    mime: String(src.mime ?? ''),
    analysis: parseAnalysis(src.analysis),
    preview_key: String(src.preview_key ?? ''),
  };
}

/** One more read through this link. */
export function countViewerGrantUseStatement(db: D1Database, tokenHash: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE viewer_grants SET uses = uses + 1, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?`
    )
    .bind(tokenHash);
}

// ------------------------------------------------------------------ revoking

/** Every live link on every file of these products stops working. Runs BEFORE a delete, whose cascade would hide the files from the subquery. */
export function revokeProductViewerGrantsStatement(db: D1Database, productIds: readonly string[], ts: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE viewer_grants SET revoked_at = ?2
        WHERE source_type = 'product' AND revoked_at IS NULL
          AND source_id IN (SELECT id FROM product_files WHERE product_id IN (SELECT value FROM json_each(?1)))`
    )
    .bind(JSON.stringify([...productIds]), ts);
}

/** Every live link on these product files. */
export function revokeProductFileViewerGrantsStatement(db: D1Database, fileIds: readonly string[], ts: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE viewer_grants SET revoked_at = ?2
        WHERE source_type = 'product' AND revoked_at IS NULL AND source_id IN (SELECT value FROM json_each(?1))`
    )
    .bind(JSON.stringify([...fileIds]), ts);
}

/** Every live link on every file of these posts. Same ordering rule as the product form. */
export function revokePostViewerGrantsStatement(db: D1Database, postIds: readonly string[], ts: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE viewer_grants SET revoked_at = ?2
        WHERE source_type = 'post' AND revoked_at IS NULL
          AND source_id IN (SELECT id FROM community_post_files WHERE post_id IN (SELECT value FROM json_each(?1)))`
    )
    .bind(JSON.stringify([...postIds]), ts);
}

/** Every live link on these post files. */
export function revokePostFileViewerGrantsStatement(db: D1Database, fileIds: readonly string[], ts: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE viewer_grants SET revoked_at = ?2
        WHERE source_type = 'post' AND revoked_at IS NULL AND source_id IN (SELECT value FROM json_each(?1))`
    )
    .bind(JSON.stringify([...fileIds]), ts);
}

// ------------------------------------------------------------- the preview

export interface DerivedPreview {
  preview_key: string;
  analysis: ModelAnalysis | null;
}

/**
 * THE MESH THE VIEWER SERVES, derived once from the stored model — the same
 * path the request analyse route takes (printRequests.ts: `analyseModel` +
 * `viewerMesh`, written private under a prefix `/files/*` refuses).
 *
 * BEST EFFORT, BY DESIGN. A model over the analysable size, a format with no
 * previewable geometry, a bucket that cannot be read right now: the file is
 * attached without a preview (`has_preview: false`) rather than refused. The
 * attach is the merchant's or the maker's act; the preview is a courtesy the
 * platform adds when it can.
 */
export async function deriveModelPreview(
  env: Env,
  input: { fileKey: string; name: string; previewKey: string; domain: MediaDomain; ownerId: string; entityId: string }
): Promise<DerivedPreview> {
  const none: DerivedPreview = { preview_key: '', analysis: null };
  try {
    const head = await headMediaObject(env, 'private', input.fileKey);
    if (!head || head.size > MODEL_MAX_BYTES) return none;
    const object = await getMediaObject(env, 'private', input.fileKey);
    if (!object) return none;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > MODEL_MAX_BYTES) return none;
    const analysis = analyseModel(bytes, input.name);
    if (!analysis.capability.previewable) return { preview_key: '', analysis };
    const mesh = viewerMesh(bytes, input.name);
    if (!mesh) return { preview_key: '', analysis };
    await putMediaObject(
      env,
      {
        key: input.previewKey,
        visibility: 'private',
        domain: input.domain,
        mime: 'application/octet-stream',
        bytes: mesh.byteLength,
        ownerId: input.ownerId,
        entityId: input.entityId,
      },
      mesh,
      { httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, max-age=0' } }
    );
    return { preview_key: input.previewKey, analysis };
  } catch (e) {
    console.error('model preview not derived', input.fileKey, e instanceof Error ? e.message : String(e));
    return none;
  }
}
