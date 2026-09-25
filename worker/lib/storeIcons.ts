/**
 * A STORE'S OWN APP ICON — the PNG renditions its installed app is drawn with.
 *
 * ---------------------------------------------------------------------------
 * The defect (audit 01 §3.6, decision 11 of docs/MERCHANT_PLATFORM.md)
 * ---------------------------------------------------------------------------
 * «كل تاجر له متجر مستقل … وتطبيق يُثبَّت». The per-host manifest already named
 * the shop, but the only icon of the shop it could offer was the merchant's
 * RAW upload: one entry, no `sizes`, usually a WebP. Chromium chooses icons by
 * declared size, so it installed the platform's 192/512 PNGs; iOS does not
 * accept WebP for a home-screen icon, so it kept the platform PNG as well. A
 * merchant's customer installed the merchant's shop and got the LEVONIS mark.
 *
 * ---------------------------------------------------------------------------
 * What this module does
 * ---------------------------------------------------------------------------
 * It cuts the store's logo into the five PNGs every platform actually reads —
 * through the same `env.IMAGES` binding the uploads use (imageConvert.ts) —
 * stores them under content-addressed keys, and records them on
 * `merchant_store_icons` (migration 0123):
 *
 *   icon192 / icon512   `purpose: any` — Chrome, Edge, Samsung Internet and
 *                       Huawei require both sizes to consider a site
 *                       installable at all.
 *   maskable512         Android masks the icon to its launcher's shape.
 *   apple180            iOS reads `apple-touch-icon`, never the manifest, and
 *                       never a WebP.
 *   favicon32           the browser tab, per host.
 *
 * NEVER WEBP-ONLY. Every rendition is PNG — the one format all of those
 * readers decode — whatever the logo was uploaded as.
 *
 * THE GEOMETRY IS THE STOREFRONT'S OWN. `scripts/build-pwa-icons.mjs` cuts
 * the PLATFORM mark — a glyph trimmed of its margin — at 80% (any) and 56%
 * (maskable) of the tile. A merchant logo is a different kind of picture: the
 * storefront shows it as an AVATAR, `object-cover` inside a circle
 * (`Storefront.tsx`), so what a merchant has designed to be seen is the
 * logo's inscribed circle, and the square's corners are already cropped on
 * their own page. So:
 *
 *   any, apple, favicon  the whole logo fills the tile (`fit: pad`, never
 *                        cropped; a non-square logo is letterboxed on the
 *                        store's ground colour). iOS rounds the corners itself.
 *   maskable             the whole logo inside the centred 408 px square of a
 *                        512 tile, on the ground colour. Its inscribed circle
 *                        (radius 204 px) is inside the maskable safe zone (the
 *                        centred circle of 80% diameter, radius 204.8 px), so
 *                        every launcher mask keeps at least exactly the
 *                        circle the storefront itself shows.
 *
 * Every output is re-read before it is trusted: a PNG signature and an IHDR
 * of exactly the declared size, or the rendition is refused. A manifest entry
 * whose `sizes` does not match its pixels is worse than no entry.
 *
 * ---------------------------------------------------------------------------
 * When renditions are made (the backfill is lazy)
 * ---------------------------------------------------------------------------
 *   · on `PATCH /api/merchant/store` when the logo (or the preset) changes —
 *     after the response, in `waitUntil`;
 *   · on the first manifest, `/store-icon/*` or share-kit request for a store
 *     whose renditions are missing or stale — the same way. Existing stores
 *     are therefore backfilled by their first visitor, with no job to run and
 *     no work spent on a store nobody opens.
 *
 * Two requests never render the same logo twice: a lease is taken with one
 * conditional upsert, a NEWER logo takes it from an older one, and only the
 * lease holder may commit — re-checking that the store still has the logo it
 * rendered. A logo that cannot be rendered is recorded with a stable reason
 * and not retried before `retry_after`.
 *
 * WITHOUT `env.IMAGES` (local dev, tests, an account without the entitlement)
 * nothing is rendered and nothing pretends to have been: no row is written,
 * the state is `unavailable`, and every reader serves exactly what it served
 * before — the platform icons.
 *
 * STALE RENDITIONS ARE CLEANED, NEVER DELETED IN PLACE: replaced keys are
 * queued on `media_cleanup_jobs`, whose guarded drain re-checks every
 * reference (these columns are sources in worker/lib/mediaRefs.ts) before it
 * deletes anything.
 */

import type { Env } from './types';
import { randomToken } from './crypto';
import { GuardedFetchError, readResponseBytes } from './fetchGuard';
import { IMAGE_SOURCE_CAP, looksLikeMarkup, sniffImageBytes } from './imageConvert';
import { rasterDimensions, validRasterDimensions } from './imageMetadata';
import { enqueueMediaDetach } from './mediaRefs';
import {
  buildMediaKey,
  getMediaObject,
  isAnonymousPublicMediaKey,
  isSafeMediaKey,
  putMediaObjectIfAbsent,
} from './mediaStorage';

// ------------------------------------------------------------------ the roles

/**
 * Bump when the GEOMETRY or the FORMAT of a rendition changes. Every committed
 * set carries the recipe it was cut with; a set from an older recipe keeps
 * being served (it is still this store's logo) while the new one is cut on
 * the next request.
 */
export const STORE_ICON_RECIPE = 1;

export const STORE_ICON_ROLES = ['icon192', 'icon512', 'maskable512', 'apple180', 'favicon32'] as const;
export type StoreIconRole = (typeof STORE_ICON_ROLES)[number];

export interface StoreIconSpec {
  /** The tile, square, in pixels. */
  size: number;
  /** The square the whole logo is fitted into, centred; the rest is ground. */
  inner: number;
}

export const STORE_ICON_SPECS: Readonly<Record<StoreIconRole, StoreIconSpec>> = Object.freeze({
  icon192: { size: 192, inner: 192 },
  icon512: { size: 512, inner: 512 },
  // (512 − 408) / 2 = 52 px of ground on every side: see the header.
  maskable512: { size: 512, inner: 408 },
  apple180: { size: 180, inner: 180 },
  favicon32: { size: 32, inner: 32 },
});

/**
 * THE SMALLEST LOGO WORTH TURNING INTO AN ICON.
 *
 * The 192 px icon is the one a launcher draws most; a source whose shorter
 * side is under half of that is stretched more than 2× and reads as a blur.
 * Below this the store keeps the platform icon and the merchant is told why
 * (`SOURCE_TOO_SMALL`) — a true fallback, not a guess.
 */
export const STORE_ICON_MIN_SOURCE = 96;

/** A rendition PNG is small; this bounds a misbehaving binding, not a logo. */
const RENDITION_MAX_BYTES = 2 * 1024 * 1024;

/**
 * THE STABLE, PER-HOST PATHS a document can link to (`/store-icon/<name>`).
 *
 * `index.html` is ONE document served on the apex and on every store's host,
 * so it cannot name a store's content-addressed key. It names these instead,
 * and the Worker answers each with the host's own rendition — or, on the apex
 * and wherever a store has none, the platform's (worker/routes/manifest.ts).
 */
export const STORE_ICON_PATHS: Readonly<Record<string, StoreIconRole>> = Object.freeze({
  'apple-touch.png': 'apple180',
  '192.png': 'icon192',
  '512.png': 'icon512',
  'maskable-512.png': 'maskable512',
  'favicon-32.png': 'favicon32',
});

/**
 * The platform's own PNG for each role — the true fallback.
 *
 * MIRRORED from `PLATFORM_ICONS` in src/lib/siteLogo.ts (the Worker does not
 * import `src/`), and held to it by tests/storeIcons.test.ts: rename the
 * platform icons there and this table fails a test instead of serving the SPA
 * shell where a PNG was asked for.
 */
export const PLATFORM_ICON_REVISION = 'bc80fc2b';
export const PLATFORM_ICON_FOR_ROLE: Readonly<Record<StoreIconRole, string>> = Object.freeze({
  icon192: '/icons/icon-192.bc80fc2b.png',
  icon512: '/icons/icon-512.bc80fc2b.png',
  maskable512: '/icons/maskable-512.bc80fc2b.png',
  apple180: '/icons/apple-touch-icon.bc80fc2b.png',
  favicon32: '/icons/favicon-32.bc80fc2b.png',
});

// ------------------------------------------------------------ the store ground

/** The ground a store's app is painted on: its splash, its title bar, and the
 *  margin of its maskable icon. Always a `#rrggbb` string. */
export interface StoreSurface {
  background: string;
  theme: string;
}

/**
 * THE DOCUMENT'S BLACK. A storefront renders dark whatever the app's theme
 * (`[data-store-theme]` is a dark island — src/index.css, THE TWO THEMES), so
 * the splash a store's launcher paints from `background_color` stays the black
 * it always was. The PLATFORM's splash follows the app's default light theme
 * instead (worker/lib/webManifest.ts).
 */
const DOCUMENT_BLACK: StoreSurface = Object.freeze({ background: '#000000', theme: '#000000' });

/**
 * EVERY PRESET A STORE CAN CHOOSE TODAY, AND THE GROUND IT RENDERS ON.
 *
 * A store's presentation choice is a preset NAME (`merchant_stores.accent`,
 * allow-listed by `PATCH /api/merchant/store`); no merchant string ever
 * becomes a colour here. The seven accents tint chips, rings and the contact
 * button — none of them changes the ground: every storefront renders on the
 * document black. So each maps to that black, stated per preset rather than
 * assumed. An unknown name is the document black, never an error.
 *
 * THE STORE BUILDER'S THEMES DO NOT CHANGE THIS, and that was checked rather
 * than hoped. Its registry (packages/storeLayout `SURFACES`: glow, ink,
 * graphite, carbon, midnight) is dark by decision — every surface is a dark
 * ground — and the colour asked for here is the one a launcher paints BEFORE
 * the page: the splash (`background_color`) and the margin of the maskable
 * icon; a splash in a theme's lighter grey would flash grey → black → grey on
 * every cold start. A theme with a light ground would
 * be the day to add a row here — keyed by that preset — not a code path.
 */
const STORE_SURFACES: Readonly<Record<string, StoreSurface>> = Object.freeze({
  default: DOCUMENT_BLACK,
  olive: DOCUMENT_BLACK,
  gold: DOCUMENT_BLACK,
  slate: DOCUMENT_BLACK,
  plum: DOCUMENT_BLACK,
  teal: DOCUMENT_BLACK,
  blue: DOCUMENT_BLACK,
});

/** The preset names this table covers — pinned by a test against the server's allowlist. */
export const STORE_SURFACE_PRESETS = Object.freeze(Object.keys(STORE_SURFACES));

export function storeSurface(store: { accent?: unknown } | null | undefined): StoreSurface {
  const name = typeof store?.accent === 'string' ? store.accent : '';
  return Object.prototype.hasOwnProperty.call(STORE_SURFACES, name) ? STORE_SURFACES[name] : DOCUMENT_BLACK;
}

// ------------------------------------------------------------------- the keys

/**
 * The logo as an R2 key this module may read and hand to a crawler, or null.
 *
 * The store column holds a bare key (`ownedMediaKey` writes it); older rows
 * have been seen holding `/files/<key>`. Anything that is not an anonymously
 * public key is refused: a rendition is served to anyone, so its source must
 * already be.
 */
export function logoSourceKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 200) return null;
  const key = value.startsWith('/files/') ? value.slice('/files/'.length) : value;
  if (!isSafeMediaKey(key) || !isAnonymousPublicMediaKey(key)) return null;
  return key;
}

const REV = /^[0-9a-f]{16}$/;
const RENDITION_KEY = /^merchants\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/logos\/appicon-[0-9a-f]{16}-(icon192|icon512|maskable512|apple180|favicon32)\.png$/;

/**
 * `merchants/<owner user id>/logos/appicon-<rev>-<role>.png`.
 *
 * Under the owner's own media prefix, in the `logos` kind `/files/` already
 * serves anonymously — and NOT in `public/`, the kind `ownedMediaKey` accepts
 * from a merchant: a rendition can never be pasted back in as somebody's logo
 * or banner. `rev` is a digest of the source bytes, the recipe and the ground
 * colour, so identical inputs give identical keys (a re-render is idempotent)
 * and anything new is a new URL — which `/files/` may then serve `immutable`.
 */
export function renditionKey(ownerUserId: string, rev: string, role: StoreIconRole): string {
  if (!REV.test(rev)) throw new Error('Invalid store icon revision');
  return buildMediaKey({
    visibility: 'public',
    domain: 'merchants',
    entityId: ownerUserId,
    kind: 'logos',
    objectId: `appicon-${rev}-${role}`,
    extension: 'png',
  });
}

/** Is this a rendition key this module minted (optionally: for this role)? */
export function isRenditionKey(key: unknown, role?: StoreIconRole): key is string {
  if (typeof key !== 'string') return false;
  const match = RENDITION_KEY.exec(key);
  if (!match || !isSafeMediaKey(key) || !isAnonymousPublicMediaKey(key)) return false;
  return role ? match[1] === role : true;
}

// -------------------------------------------------------------------- the row

export interface StoreIconRow {
  store_id: string;
  source_key: string | null;
  source_sha256: string | null;
  recipe: number | null;
  tile_colour: string | null;
  rev: string | null;
  icon192_key: string | null;
  icon512_key: string | null;
  maskable512_key: string | null;
  apple180_key: string | null;
  favicon32_key: string | null;
  generated_at: string | null;
  failed_fingerprint: string | null;
  failure_reason: string;
  attempts: number;
  retry_after: string | null;
  lease_token: string | null;
  lease_fingerprint: string | null;
  lease_until: string | null;
  updated_at: string;
}

const ROW_COLUMNS = `store_id, source_key, source_sha256, recipe, tile_colour, rev,
  icon192_key, icon512_key, maskable512_key, apple180_key, favicon32_key, generated_at,
  failed_fingerprint, failure_reason, attempts, retry_after,
  lease_token, lease_fingerprint, lease_until, updated_at`;

export async function readStoreIcons(db: D1Database, storeId: string): Promise<StoreIconRow | null> {
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM merchant_store_icons WHERE store_id = ?`)
    .bind(storeId)
    .first<StoreIconRow>();
}

/**
 * The same read for the paths that must never fail because of it — the
 * manifest, the icon route, a share card. A database that predates 0123, a
 * D1 blip, a missing binding: all of them read as "no renditions", which is
 * exactly what those paths served before this module existed.
 */
export async function readStoreIconsQuietly(db: D1Database | undefined, storeId: string): Promise<StoreIconRow | null> {
  if (!db) return null;
  try {
    return await readStoreIcons(db, storeId);
  } catch {
    return null;
  }
}

/** Which rendition a lease or a failure is about: `<recipe>:<colour>:<logo key>`. */
export function iconFingerprint(sourceKey: string, colour: string, recipe: number = STORE_ICON_RECIPE): string {
  return `${recipe}:${colour}:${sourceKey}`;
}

// --------------------------------------------------------- what may be served

/** The fields of a store this module reads. Deliberately not `StoreRow`. */
export interface StoreIconSubject {
  id: string;
  user_id: string;
  logo_key: string | null;
  accent?: string | null;
}

export interface StoreIconSet {
  rev: string;
  keys: Readonly<Record<StoreIconRole, string>>;
  /** False while a set cut with an older recipe or ground is being replaced. */
  current: boolean;
}

/**
 * The renditions a reader may serve for this store right now, or null.
 *
 * SERVED ONLY FOR THE LOGO THEY WERE CUT FROM. A merchant who replaces their
 * logo sees their new one or, for the seconds it takes to cut it, the
 * platform's — never the logo they just removed. A set from an older recipe
 * or ground IS still this logo, so it keeps being served (`current: false`)
 * until its replacement is committed. Every key is re-validated: a row is a
 * database value, not a promise.
 */
export function servableStoreIcons(store: Pick<StoreIconSubject, 'logo_key' | 'accent'>, row: StoreIconRow | null): StoreIconSet | null {
  if (!row || !row.source_key || !row.rev || !REV.test(row.rev)) return null;
  const source = logoSourceKey(store.logo_key);
  if (!source || row.source_key !== source) return null;
  const keys = {} as Record<StoreIconRole, string>;
  for (const role of STORE_ICON_ROLES) {
    const key = row[`${role}_key` as const];
    if (!isRenditionKey(key, role) || !key.includes(`/appicon-${row.rev}-`)) return null;
    keys[role] = key;
  }
  const current = Number(row.recipe) === STORE_ICON_RECIPE && row.tile_colour === storeSurface(store).background;
  return { rev: row.rev, keys, current };
}

/** `/files/<key>` for each role — what a manifest or a page links to. */
export function storeIconUrls(set: StoreIconSet): Readonly<Record<StoreIconRole, string>> {
  const out = {} as Record<StoreIconRole, string>;
  for (const role of STORE_ICON_ROLES) out[role] = `/files/${set.keys[role]}`;
  return out;
}

// ------------------------------------------------------------------ the state

/** Stable codes: the merchant's screen maps them to words (never raw text). */
export type StoreIconFailure =
  | 'SOURCE_MISSING'
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_NOT_IMAGE'
  | 'SOURCE_TOO_SMALL'
  | 'SOURCE_UNREADABLE'
  | 'RENDITION_FAILED'
  | 'RENDITION_INVALID'
  | 'STORAGE_FAILED';

export type StoreIconState = 'ready' | 'pending' | 'failed' | 'unavailable' | 'none';

export interface StoreIconStatus {
  state: StoreIconState;
  /** Why it is not `ready`, as a stable code; null when there is nothing to say. */
  reason: StoreIconFailure | 'IMAGES_UNAVAILABLE' | 'NO_LOGO' | null;
  /** What may be served now (possibly an older recipe's set while a re-cut is due). */
  icons: StoreIconSet | null;
  /** Whether a refresh should be scheduled now. */
  due: boolean;
}

/**
 * WHERE A STORE'S APP ICON STANDS, and whether anything should be done about
 * it. Pure: every reader asks this, and only `refreshStoreIcons` acts on it.
 */
export function storeIconStatus(
  env: Pick<Env, 'IMAGES'>,
  store: Pick<StoreIconSubject, 'logo_key' | 'accent'>,
  row: StoreIconRow | null,
  now: Date = new Date()
): StoreIconStatus {
  const source = logoSourceKey(store.logo_key);
  if (!source) {
    // Nothing to render. A leftover row (the logo was removed) is due to be
    // cleared, so its renditions stop being referenced and can be collected.
    return { state: 'none', reason: 'NO_LOGO', icons: null, due: row !== null };
  }
  const icons = servableStoreIcons(store, row);
  if (icons?.current) return { state: 'ready', reason: null, icons, due: false };
  if (!env.IMAGES) {
    return { state: icons ? 'ready' : 'unavailable', reason: 'IMAGES_UNAVAILABLE', icons, due: false };
  }
  const fingerprint = iconFingerprint(source, storeSurface(store).background);
  const nowIso = now.toISOString();
  if (row?.failed_fingerprint === fingerprint && row.retry_after && row.retry_after > nowIso) {
    return { state: icons ? 'ready' : 'failed', reason: asFailure(row.failure_reason), icons, due: false };
  }
  const leased = !!row?.lease_until && row.lease_until > nowIso && row.lease_fingerprint === fingerprint;
  return { state: icons ? 'ready' : 'pending', reason: null, icons, due: !leased };
}

const FAILURES: readonly StoreIconFailure[] = [
  'SOURCE_MISSING',
  'SOURCE_TOO_LARGE',
  'SOURCE_NOT_IMAGE',
  'SOURCE_TOO_SMALL',
  'SOURCE_UNREADABLE',
  'RENDITION_FAILED',
  'RENDITION_INVALID',
  'STORAGE_FAILED',
];

function asFailure(value: unknown): StoreIconFailure {
  return FAILURES.includes(value as StoreIconFailure) ? (value as StoreIconFailure) : 'RENDITION_FAILED';
}

/**
 * HOW LONG A FAILED LOGO WAITS BEFORE IT IS TRIED AGAIN.
 *
 * A property of the SOURCE (not an image, too small, unreadable) will not
 * change under the same key — only a new logo fixes it, and a new logo is a
 * new fingerprint that is tried at once. So those wait a week. Everything
 * else may be transient (a binding hiccup, a bucket blip) and backs off from
 * fifteen minutes, doubling, to a day.
 */
export function retryDelayMs(reason: StoreIconFailure, attempts: number): number {
  const permanent: StoreIconFailure[] = ['SOURCE_NOT_IMAGE', 'SOURCE_TOO_SMALL', 'SOURCE_TOO_LARGE', 'SOURCE_UNREADABLE'];
  if (permanent.includes(reason)) return 7 * 24 * 60 * 60 * 1000;
  const base = 15 * 60 * 1000;
  const exponent = Math.min(Math.max(attempts - 1, 0), 10);
  return Math.min(base * 2 ** exponent, 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------- rendering

class RenditionError extends Error {
  constructor(readonly code: StoreIconFailure, detail: string) {
    super(detail);
    this.name = 'RenditionError';
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)));
}

async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text));
}

/**
 * One rendition through the Images binding, verified.
 *
 * `fit: 'pad'` fits the WHOLE logo into `inner`×`inner` — never cropped — and
 * paints `background` both into the letterbox and under any transparency (a
 * transparent icon is composited on whatever the launcher chooses, which is
 * white on most Android launchers). A maskable tile then gains its safe-zone
 * margin as a border of the same colour. The result must be a PNG of exactly
 * `size`×`size`, or it is refused.
 */
async function renderOne(images: ImagesBinding, source: Uint8Array, spec: StoreIconSpec, colour: string): Promise<Uint8Array> {
  let out: Uint8Array;
  try {
    let transformer = images
      .input(new Blob([source]).stream())
      .transform({ width: spec.inner, height: spec.inner, fit: 'pad', background: colour });
    const margin = (spec.size - spec.inner) / 2;
    if (margin > 0) transformer = transformer.transform({ border: { color: colour, width: margin } });
    const result = await transformer.output({ format: 'image/png', background: colour, anim: false });
    const response = result.response();
    if (!response.ok) throw new RenditionError('RENDITION_FAILED', `the Images binding answered HTTP ${response.status}`);
    out = await readResponseBytes(response, {
      maxBytes: RENDITION_MAX_BYTES,
      tooLargeMessage: `A ${spec.size}px icon exceeded ${RENDITION_MAX_BYTES} bytes`,
    });
  } catch (error) {
    if (error instanceof RenditionError) throw error;
    if (error instanceof GuardedFetchError) throw new RenditionError('RENDITION_INVALID', error.message);
    throw new RenditionError('RENDITION_FAILED', error instanceof Error ? error.message : String(error));
  }
  const kind = sniffImageBytes(out);
  const dimensions = kind?.mime === 'image/png' ? rasterDimensions(out, 'image/png') : null;
  if (kind?.mime !== 'image/png' || !dimensions || dimensions.width !== spec.size || dimensions.height !== spec.size) {
    throw new RenditionError(
      'RENDITION_INVALID',
      `expected a ${spec.size}x${spec.size} PNG, got ${kind?.mime ?? 'unknown bytes'} ${dimensions ? `${dimensions.width}x${dimensions.height}` : ''}`.trim()
    );
  }
  return out;
}

/** The logo's bytes and pixel size, or a stable refusal. */
async function readSource(
  env: StoreIconEnv,
  images: ImagesBinding,
  key: string
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const object = await getMediaObject(env, 'public', key);
  if (!object) throw new RenditionError('SOURCE_MISSING', `no object at ${key}`);
  if (typeof object.size === 'number' && object.size > IMAGE_SOURCE_CAP) {
    throw new RenditionError('SOURCE_TOO_LARGE', `${object.size} bytes`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength === 0) throw new RenditionError('SOURCE_MISSING', `empty object at ${key}`);
  if (bytes.byteLength > IMAGE_SOURCE_CAP) throw new RenditionError('SOURCE_TOO_LARGE', `${bytes.byteLength} bytes`);
  if (looksLikeMarkup(bytes)) throw new RenditionError('SOURCE_NOT_IMAGE', 'markup, not an image');
  const kind = sniffImageBytes(bytes);
  if (!kind) throw new RenditionError('SOURCE_NOT_IMAGE', 'no known image signature');

  let dimensions = rasterDimensions(bytes, kind.mime);
  if (!validRasterDimensions(dimensions)) {
    // AVIF (and any header the reader above does not parse): the binding's
    // own decoder answers, which also proves the bytes decode at all.
    try {
      const info = await images.info(new Blob([bytes]).stream());
      dimensions = 'width' in info ? { width: info.width, height: info.height } : null;
    } catch {
      dimensions = null;
    }
  }
  if (!validRasterDimensions(dimensions)) throw new RenditionError('SOURCE_UNREADABLE', 'no readable dimensions');
  if (Math.min(dimensions.width, dimensions.height) < STORE_ICON_MIN_SOURCE) {
    throw new RenditionError('SOURCE_TOO_SMALL', `${dimensions.width}x${dimensions.height}`);
  }
  return { bytes, width: dimensions.width, height: dimensions.height };
}

// ------------------------------------------------------------------ the lease

/** How long one render may hold the lease before another request may take it. */
export const STORE_ICON_LEASE_MS = 90_000;

async function claimLease(db: D1Database, storeId: string, fingerprint: string, token: string, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const until = new Date(now.getTime() + STORE_ICON_LEASE_MS).toISOString();
  /*
   * ONE STATEMENT DECIDES WHO RENDERS. The upsert takes the lease when there
   * is none, when it has expired, or when it is held for a DIFFERENT
   * fingerprint — a newer logo supersedes an older render, whose commit then
   * finds its token gone. RETURNING tells this caller whether the row now
   * carries ITS token; a lost race returns no row at all.
   */
  const row = await db
    .prepare(
      `INSERT INTO merchant_store_icons (store_id, lease_token, lease_fingerprint, lease_until, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(store_id) DO UPDATE SET
         lease_token = excluded.lease_token,
         lease_fingerprint = excluded.lease_fingerprint,
         lease_until = excluded.lease_until,
         updated_at = excluded.updated_at
       WHERE merchant_store_icons.lease_until IS NULL
          OR merchant_store_icons.lease_until < excluded.updated_at
          OR merchant_store_icons.lease_fingerprint IS NOT excluded.lease_fingerprint
       RETURNING lease_token`
    )
    .bind(storeId, token, fingerprint, until, nowIso)
    .first<{ lease_token: string | null }>();
  return row?.lease_token === token;
}

// ---------------------------------------------------------------- the refresh

export type StoreIconEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES'>;

export type StoreIconRefresh =
  /** Committed now (`fresh`) or already current. */
  | { outcome: 'ready'; fresh: boolean; icons: StoreIconSet }
  /** The logo was removed; the leftover row was deleted and its renditions queued for cleanup. */
  | { outcome: 'cleared' }
  /** No logo and nothing to clear. */
  | { outcome: 'none' }
  /** No Images binding on this deployment: nothing was rendered, nothing was written. */
  | { outcome: 'unavailable' }
  /** Another request holds the lease for this logo. */
  | { outcome: 'busy' }
  /** This logo failed recently and waits for `retry_after`. */
  | { outcome: 'deferred'; reason: StoreIconFailure }
  | { outcome: 'failed'; reason: StoreIconFailure; detail: string }
  /** A newer logo (or a removal) overtook this render; it committed nothing. */
  | { outcome: 'superseded' };

/**
 * MAKE THIS STORE'S RENDITIONS CURRENT, IF THEY ARE NOT.
 *
 * Safe to call from anywhere, any number of times, concurrently: it reads
 * first and does nothing when nothing is due, takes the lease before any
 * rendering, commits only under the lease AND only if the store still has the
 * logo it rendered, and queues whatever it replaced (or created in vain) for
 * the guarded media cleanup. It never throws for a bad logo — that is a
 * recorded `failed` — but it does let a database error propagate to the
 * caller's own catch (every caller runs it after its response).
 */
export async function refreshStoreIcons(
  env: StoreIconEnv,
  store: StoreIconSubject,
  options: { now?: Date } = {}
): Promise<StoreIconRefresh> {
  const now = options.now ?? new Date();
  const db = env.DB;
  const source = logoSourceKey(store.logo_key);
  if (!source) return (await clearStoreIcons(env, store.id)) ? { outcome: 'cleared' } : { outcome: 'none' };

  const row = await readStoreIcons(db, store.id);
  const status = storeIconStatus(env, store, row, now);
  if (!status.due) {
    if (status.icons?.current) return { outcome: 'ready', fresh: false, icons: status.icons };
    if (status.reason === 'IMAGES_UNAVAILABLE') return { outcome: 'unavailable' };
    // The only other reasons a due-less status carries are a recorded failure
    // still inside its back-off, and (with no reason) a lease held elsewhere.
    if (status.reason && status.reason !== 'NO_LOGO') return { outcome: 'deferred', reason: status.reason };
    return { outcome: 'busy' };
  }
  const images = env.IMAGES;
  if (!images) return { outcome: 'unavailable' };

  const colour = storeSurface(store).background;
  const fingerprint = iconFingerprint(source, colour);
  const token = randomToken(18);
  if (!(await claimLease(db, store.id, fingerprint, token, now))) return { outcome: 'busy' };

  // Re-read UNDER the lease: whatever is committed now is what this render
  // replaces, and nobody else can commit until the lease is released.
  const before = await readStoreIcons(db, store.id);
  const created: string[] = [];
  try {
    const { bytes } = await readSource(env, images, source);
    const sourceSha = await sha256Bytes(bytes);
    const rev = (await sha256Text(`${sourceSha}|${STORE_ICON_RECIPE}|${colour}`)).slice(0, 16);

    const keys = {} as Record<StoreIconRole, string>;
    for (const role of STORE_ICON_ROLES) {
      const spec = STORE_ICON_SPECS[role];
      const png = await renderOne(images, bytes, spec, colour);
      const key = renditionKey(store.user_id, rev, role);
      let write: { created_new: boolean };
      try {
        write = await putMediaObjectIfAbsent(
          env,
          {
            key,
            visibility: 'public',
            domain: 'merchants',
            mime: 'image/png',
            bytes: png.byteLength,
            ownerId: store.user_id,
            entityId: store.user_id,
            width: spec.size,
            height: spec.size,
            originalName: `appicon-${role}.png`,
          },
          png,
          // Content-addressed: the bytes behind this URL never change.
          { httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' } }
        );
      } catch (error) {
        throw new RenditionError('STORAGE_FAILED', error instanceof Error ? error.message : String(error));
      }
      if (write.created_new) created.push(key);
      keys[role] = key;
    }

    const committedAt = new Date().toISOString();
    const committed = await db
      .prepare(
        `UPDATE merchant_store_icons
            SET source_key = ?1, source_sha256 = ?2, recipe = ?3, tile_colour = ?4, rev = ?5,
                icon192_key = ?6, icon512_key = ?7, maskable512_key = ?8, apple180_key = ?9, favicon32_key = ?10,
                generated_at = ?11,
                failed_fingerprint = NULL, failure_reason = '', attempts = 0, retry_after = NULL,
                lease_token = NULL, lease_fingerprint = NULL, lease_until = NULL, updated_at = ?11
          WHERE store_id = ?12 AND lease_token = ?13
            AND EXISTS (SELECT 1 FROM merchant_stores s
                         WHERE s.id = ?12 AND s.logo_key IN (?1, '/files/' || ?1))
          RETURNING rev`
      )
      .bind(
        source,
        sourceSha,
        STORE_ICON_RECIPE,
        colour,
        rev,
        keys.icon192,
        keys.icon512,
        keys.maskable512,
        keys.apple180,
        keys.favicon32,
        committedAt,
        store.id,
        token
      )
      .first<{ rev: string }>();

    const fresh = Object.values(keys);
    if (!committed) {
      // Overtaken: a newer logo took the lease, or the logo was removed. What
      // this render created is referenced by nothing — unless the row that won
      // happens to name the same bytes, which the queue's own re-check sees.
      await queueForCleanup(db, created, store.id, await readStoreIcons(db, store.id));
      return { outcome: 'superseded' };
    }
    await queueForCleanup(db, committedKeys(before).filter((key) => !fresh.includes(key)), store.id, null);
    return { outcome: 'ready', fresh: true, icons: { rev, keys, current: true } };
  } catch (error) {
    if (!(error instanceof RenditionError)) throw error;
    const attempts = (before?.failed_fingerprint === fingerprint ? Number(before.attempts) || 0 : 0) + 1;
    const retryAfter = new Date(now.getTime() + retryDelayMs(error.code, attempts)).toISOString();
    await db
      .prepare(
        `UPDATE merchant_store_icons
            SET failed_fingerprint = ?1, failure_reason = ?2, attempts = ?3, retry_after = ?4,
                lease_token = NULL, lease_fingerprint = NULL, lease_until = NULL, updated_at = ?5
          WHERE store_id = ?6 AND lease_token = ?7`
      )
      .bind(fingerprint, error.code, attempts, retryAfter, new Date().toISOString(), store.id, token)
      .run();
    // A render that failed half-way may have stored some renditions already.
    await queueForCleanup(db, created, store.id, before);
    console.warn('store_icons_render_failed', JSON.stringify({ store: store.id, reason: error.code, detail: error.message.slice(0, 200) }));
    return { outcome: 'failed', reason: error.code, detail: error.message };
  }
}

/** The five keys of a committed set (none when nothing is committed). */
function committedKeys(row: StoreIconRow | null): string[] {
  if (!row) return [];
  return STORE_ICON_ROLES.map((role) => row[`${role}_key` as const]).filter((key): key is string => isRenditionKey(key));
}

/**
 * Queue renditions nothing references any more. Only keys this module mints,
 * never one the (re-read) committed row still names, and never fatal: the
 * work they belong to has already committed, and an unqueued object is merely
 * an orphan the media report will find.
 */
async function queueForCleanup(db: D1Database, keys: string[], storeId: string, live: StoreIconRow | null): Promise<void> {
  const keep = new Set(committedKeys(live));
  const doomed = [...new Set(keys)].filter((key) => isRenditionKey(key) && !keep.has(key));
  if (!doomed.length) return;
  try {
    await enqueueMediaDetach(db, doomed, `store-icons:${storeId}`);
  } catch (error) {
    console.warn('store_icons_cleanup_not_queued', JSON.stringify({ store: storeId, keys: doomed.length, error: String(error).slice(0, 200) }));
  }
}

/**
 * THE LOGO WAS REMOVED: the store has no icon of its own any more.
 *
 * The row goes in one statement that returns what it held, and its
 * renditions are queued for the guarded cleanup. A render still in flight for
 * the old logo then finds no row to commit to and cleans up after itself.
 */
export async function clearStoreIcons(env: Pick<Env, 'DB'>, storeId: string): Promise<boolean> {
  const gone = await env.DB
    .prepare(
      `DELETE FROM merchant_store_icons WHERE store_id = ?
       RETURNING store_id, source_key, source_sha256, recipe, tile_colour, rev,
                 icon192_key, icon512_key, maskable512_key, apple180_key, favicon32_key, generated_at,
                 failed_fingerprint, failure_reason, attempts, retry_after,
                 lease_token, lease_fingerprint, lease_until, updated_at`
    )
    .bind(storeId)
    .first<StoreIconRow>();
  if (!gone) return false;
  await queueForCleanup(env.DB, committedKeys(gone), storeId, null);
  return true;
}

// ------------------------------------------------------------- the scheduling

/** What a Hono context offers this module, without importing Hono's types. */
export interface IconRefreshContext {
  env: StoreIconEnv;
  /** Hono's own `ExecutionContext` type is narrower than workers-types', so only what is used. */
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Run a refresh AFTER the response, never in front of it.
 *
 * `c.executionCtx` THROWS in Hono when the request has no execution context
 * (a unit test calling a route without one), so it is read inside a try; the
 * work is then still started, merely not kept alive past the response. Its
 * failures are logged, never thrown: a customer's page load is not where an
 * icon problem surfaces — the merchant's share screen is.
 */
export function scheduleStoreIconRefresh(c: IconRefreshContext, store: StoreIconSubject): Promise<StoreIconRefresh | null> {
  const task = refreshStoreIcons(c.env, store).catch((error: unknown) => {
    console.error('store_icons_refresh_failed', JSON.stringify({ store: store.id, error: String(error).slice(0, 300) }));
    return null;
  });
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No execution context: the promise is already running.
  }
  return task;
}
