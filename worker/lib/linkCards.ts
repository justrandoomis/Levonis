/**
 * LINK CARDS — what the server learns about a pasted URL, once, for everyone
 * (docs/COMMUNITY_ECOSYSTEM.md §9.4 "Link cards").
 *
 * A URL in a conversation, a request comment or a project body becomes a card:
 * the host, an Open Graph title and description, a picture RE-HOSTED under a
 * public key of ours, and what kind of page it is. Three rules shape it:
 *
 *   1. THE SERVER FETCHES, THE READER NEVER DOES. A reader's browser is never
 *      sent to the pasted address for a preview — the picture is ours or it is
 *      nothing — so a link cannot be used to make every reader of a thread
 *      call somebody's server, and a private address cannot be probed through
 *      a reader either.
 *
 *   2. ONLY THE HOSTS WE NAME ARE FETCHED. `validateOutboundUrl`
 *      (worker/lib/fetchGuard.ts) already refuses `javascript:`, `data:`,
 *      `file:`, credentials and every private address in every spelling; on
 *      top of it, a preview is fetched ONLY from the allow-list below. Every
 *      other host gets a BARE card — the host name — and no request at all.
 *      The bound is the fetch guard's: 5 s for the page, 2 MiB, `text/html`
 *      only, the Open Graph tags read from the first 256 KiB.
 *
 *   3. ONE ROW PER URL, REUSED. A link shared in a busy thread is fetched once
 *      and served to every reader for 24 h; a failed fetch is remembered for
 *      an hour so a dead page is not hammered by every screen that meets it.
 *
 * The card's shape is one thing everywhere it appears (`LinkCardPublic`); a
 * chat message carries it as `card_snapshot` `{type:'link', …}` (0150's
 * `card_type` CHECK does not admit 'link', and a rebuild is not allowed).
 */

import type { Env } from './types';
import { HttpError } from './http';
import { newId } from './crypto';
import { guardedFetchBytes, validateOutboundUrl } from './fetchGuard';
import { looksLikeMarkup, productImageToWebp, sniffImageBytes } from './imageConvert';
import { putMediaObject } from './mediaStorage';

export type LinkCardKind = 'model_page' | 'video' | 'article' | 'unknown';
export type LinkCardStatus = 'ok' | 'blocked' | 'failed';

/** `link_cards` as the database holds it (migration 0158). */
export interface LinkCardRow {
  id: string;
  url: string;
  host: string;
  title: string;
  description: string;
  image_key: string | null;
  kind: LinkCardKind;
  fetched_at: string;
  status: LinkCardStatus;
  created_at: string;
}

/**
 * The card as every screen reads it. `image_url` is `/files/<our key>` or
 * null — never the source's address. `reason` names the one state a composer
 * should explain («تعذّر جلب المعاينة») through src/lib/refusalStrings.ts;
 * a bare card for an unlisted host is not a failure and carries none.
 */
export interface LinkCardPublic {
  id: string;
  url: string;
  host: string;
  title: string;
  description: string;
  image_url: string | null;
  kind: LinkCardKind;
  status: LinkCardStatus;
  fetched_at: string;
  reason: 'LINK_FETCH_FAILED' | null;
}

/** What a chat message's `card_snapshot` holds for a link. */
export interface LinkSnapshot {
  type: 'link';
  card_id: string;
  url: string;
  host: string;
  title: string;
  description: string;
  image_url: string | null;
  kind: LinkCardKind;
}

/** The longest address accepted — 2 KB, the spec's own figure. */
export const LINK_URL_MAX = 2048;
/** The page fetch: one deadline for redirects and body, and the most bytes buffered. */
export const LINK_FETCH_TIMEOUT_MS = 5_000;
export const LINK_PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Only this much of the page is parsed — the tags live in `<head>`. */
export const LINK_PARSE_BYTES = 256 * 1024;
/** The picture: the same ceiling, sniffed as an image before a byte is kept. */
export const LINK_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** How long a fetched card is reused, and how soon a failed one is retried. */
export const LINK_REUSE_MS = 24 * 60 * 60 * 1000;
export const LINK_RETRY_MS = 60 * 60 * 1000;
/** The longest title and description kept. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 500;

/**
 * THE HOSTS A PREVIEW IS FETCHED FROM, and what a page there is. Exact host or
 * its `www.` form; a subdomain is not a listed host (a `pages.github.com`
 * site is somebody's page, not GitHub's). Everything else is a bare card.
 */
const PREVIEW_HOSTS: Readonly<Record<string, LinkCardKind>> = {
  'printables.com': 'model_page',
  'thingiverse.com': 'model_page',
  'makerworld.com': 'model_page',
  'cults3d.com': 'model_page',
  'youtube.com': 'video',
  'youtu.be': 'video',
  'instagram.com': 'video',
  'tiktok.com': 'video',
  'github.com': 'article',
};

/** The host without a trailing dot or a `www.` — what the card shows and what the allow-list is keyed by. */
export function displayHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** The kind a preview of this host would be, or null when the host is not previewed at all. */
export function previewKindFor(hostname: string): LinkCardKind | null {
  return PREVIEW_HOSTS[displayHost(hostname)] ?? null;
}

/**
 * WHERE A PICTURE MAY COME FROM: a listed host, or the picture hosts the
 * listed pages actually use (their CDNs), matched by suffix — so
 * `media.printables.com` and `i.ytimg.com` pass, and whatever host a page
 * writes into its `og:image` does not. Asked on every hop of the picture
 * fetch, like the page's own list; a picture elsewhere leaves the card
 * without one, never with a request.
 */
const IMAGE_HOSTS: readonly string[] = [
  ...Object.keys(PREVIEW_HOSTS),
  'bblmw.com', // makerworld's pictures
  'ytimg.com', // youtube's thumbnails
  'cdninstagram.com', 'fbcdn.net', // instagram's
  'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', // tiktok's
  'githubassets.com', 'githubusercontent.com', // github's social cards
];

export function imageHostAllowed(hostname: string): boolean {
  const h = displayHost(hostname);
  return IMAGE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Share-tracking parameters that make one page look like many URLs. */
const TRACKING_PARAM = /^(?:utm_[a-z]+|fbclid|gclid|igshid|igsh|mc_cid|mc_eid)$/i;

/**
 * THE ONE DOOR EVERY PASTED ADDRESS COMES THROUGH. A string, at most 2 KB,
 * `http(s)` only, no credentials, no private address — the fetch guard's own
 * rules, refused here with the two codes a composer can explain:
 * `LINK_URL_INVALID` for something that is not a web address at all
 * (`javascript:`, `data:`, `file:`, a bare word) and `LINK_HOST_BLOCKED` for a
 * well-formed address we will not touch (loopback, RFC 1918, link-local, the
 * metadata range). The fragment is dropped and share-tracking parameters
 * stripped so one page is one row.
 */
export function normalizeLinkUrl(raw: unknown): URL {
  if (typeof raw !== 'string') throw new HttpError(400, 'A web address is required', 'LINK_URL_INVALID');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > LINK_URL_MAX) {
    throw new HttpError(400, `A web address is 1–${LINK_URL_MAX} characters`, 'LINK_URL_INVALID');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError(400, 'That is not a web address', 'LINK_URL_INVALID');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new HttpError(400, 'Only http(s) addresses without credentials can be shared', 'LINK_URL_INVALID');
  }
  // Parsed, http(s), no credentials: anything the guard still refuses is the ADDRESS.
  try {
    validateOutboundUrl(url.toString());
  } catch {
    throw new HttpError(400, 'This address cannot be shared', 'LINK_HOST_BLOCKED');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  return url;
}

export function linkCardPublic(row: LinkCardRow): LinkCardPublic {
  return {
    id: row.id,
    url: row.url,
    host: row.host,
    title: row.title,
    description: row.description,
    image_url: row.image_key ? `/files/${row.image_key}` : null,
    kind: row.kind,
    status: row.status,
    fetched_at: row.fetched_at,
    reason: row.status === 'failed' ? 'LINK_FETCH_FAILED' : null,
  };
}

/** The snapshot a chat message keeps — the card as it was when sent. */
export function linkSnapshot(card: LinkCardPublic): LinkSnapshot {
  return {
    type: 'link',
    card_id: card.id,
    url: card.url,
    host: card.host,
    title: card.title,
    description: card.description,
    image_url: card.image_url,
    kind: card.kind,
  };
}

/** A message's `link`, read back from its `card_snapshot`; null for anything that is not a link snapshot. */
export function linkFromSnapshot(snapshot: unknown): Omit<LinkSnapshot, 'type'> | null {
  if (typeof snapshot !== 'string' || !snapshot) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'link') return null;
  const s = parsed as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const kind = text(s.kind);
  return {
    card_id: text(s.card_id),
    url: text(s.url),
    host: text(s.host),
    title: text(s.title),
    description: text(s.description),
    image_url: typeof s.image_url === 'string' && s.image_url.startsWith('/files/') ? s.image_url : null,
    kind: kind === 'model_page' || kind === 'video' || kind === 'article' ? kind : 'unknown',
  };
}

// ===========================================================================
//  THE STORE
// ===========================================================================

export async function readLinkCard(db: D1Database, url: string): Promise<LinkCardRow | null> {
  return (await db.prepare('SELECT * FROM link_cards WHERE url = ?').bind(url).first<LinkCardRow>()) ?? null;
}

type LinkCardWrite = Omit<LinkCardRow, 'created_at'>;

/**
 * One row per URL: the first writer inserts, a later refresh updates in place
 * and KEEPS the row's id (the picture's key is named after it). Two racing
 * first writers both land on the UNIQUE and the second simply updates.
 */
async function writeLinkCard(db: D1Database, row: LinkCardWrite): Promise<LinkCardRow> {
  await db
    .prepare(
      `INSERT INTO link_cards (id, url, host, title, description, image_key, kind, fetched_at, status)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(url) DO UPDATE SET
         host = excluded.host, title = excluded.title, description = excluded.description,
         image_key = excluded.image_key, kind = excluded.kind, fetched_at = excluded.fetched_at, status = excluded.status`
    )
    .bind(row.id, row.url, row.host, row.title, row.description, row.image_key, row.kind, row.fetched_at, row.status)
    .run();
  const stored = await readLinkCard(db, row.url);
  if (!stored) throw new Error('link card vanished after its own write');
  return stored;
}

/** Is a stored card still the answer, or is it time to look again? */
function stillFresh(row: LinkCardRow, kind: LinkCardKind | null, now: Date): boolean {
  // A bare card for an unlisted host is never fetched, so it never ages — unless
  // the host has since been added to the allow-list, when it is looked at.
  if (row.status === 'blocked') return kind === null;
  const age = now.getTime() - Date.parse(row.fetched_at);
  if (!Number.isFinite(age)) return false;
  return age < (row.status === 'ok' ? LINK_REUSE_MS : LINK_RETRY_MS);
}

// ===========================================================================
//  THE FETCH
// ===========================================================================

export type LinkEnv = Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE' | 'IMAGES'>;

/** Dependencies a test replaces: the network and the clock. Routes pass neither. */
export interface LinkCardDeps {
  fetcher?: typeof fetch;
  now?: () => Date;
}

const PAGE_HEADERS = {
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  'accept-language': 'en,ar;q=0.8',
  'user-agent': 'Mozilla/5.0 (compatible; LevonisLinkCard/1.0; +https://levonis-iq.com)',
};
const IMAGE_HEADERS = {
  accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8',
  'user-agent': PAGE_HEADERS['user-agent'],
};

/**
 * The page fetch admits `text/html` ONLY — decided from the response headers
 * BEFORE the body is read, so a 2 MiB PDF or a video at a listed host costs a
 * cancelled stream, not a buffer. Anything else fails the fetch, and the guard
 * turns the throw into its own `FETCH_FAILED`.
 */
function htmlOnly(fetcher: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, init);
    if (res.ok) {
      const type = (res.headers.get('content-type') ?? '').trim().toLowerCase();
      if (!type.startsWith('text/html') && !type.startsWith('application/xhtml+xml')) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`not an HTML page (${type || 'no content type'})`);
      }
    }
    return res;
  }) as typeof fetch;
}

interface Fetched {
  title: string;
  description: string;
  image_key: string | null;
  status: LinkCardStatus;
}

const FAILED: Fetched = { title: '', description: '', image_key: null, status: 'failed' };

async function fetchPreview(env: LinkEnv, url: string, cardId: string, fetcher: typeof fetch): Promise<Fetched> {
  let page: Awaited<ReturnType<typeof guardedFetchBytes>>;
  try {
    page = await guardedFetchBytes(url, {
      maxBytes: LINK_PAGE_MAX_BYTES,
      maxRedirects: 3,
      timeoutMs: LINK_FETCH_TIMEOUT_MS,
      headers: PAGE_HEADERS,
      fetcher: htmlOnly(fetcher),
      // The allow-list holds on EVERY hop: a listed host redirecting off it is
      // refused before the landing page is asked for, not after its body was read.
      allowHost: (h) => previewKindFor(h) !== null,
    });
  } catch {
    return FAILED;
  }
  // Belt and braces with `allowHost` above: a page in hand from a host outside
  // the list is somebody else's, and its tags are not read.
  let landed: URL;
  try {
    landed = new URL(page.url);
  } catch {
    return FAILED;
  }
  if (previewKindFor(landed.hostname) === null) return FAILED;

  const og = parseOpenGraph(page.bytes.subarray(0, LINK_PARSE_BYTES), page.url);
  const image_key = og.image ? await rehostImage(env, og.image, cardId, fetcher) : null;
  return { title: og.title, description: og.description, image_key, status: 'ok' };
}

/**
 * THE PICTURE BECOMES OURS OR IT IS NOTHING. Fetched under the same guard and
 * ceiling — and only from a listed host or one of the picture hosts the
 * listed pages use (`imageHostAllowed`, every hop): a page cannot send this
 * Worker to an arbitrary address by naming it as its picture. Sniffed as a
 * still image by its bytes (a page that names an HTML
 * file as its picture is refused here), decoded and re-encoded to WebP by the
 * IMAGES binding — the same strict path a product photo takes — and written
 * under `link-cards/<card id>.webp`, a public key. Every failure, including a
 * deployment without the binding, leaves the card without a picture and
 * otherwise intact.
 */
async function rehostImage(env: LinkEnv, imageUrl: string, cardId: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const target = validateOutboundUrl(imageUrl);
    const got = await guardedFetchBytes(target.toString(), {
      maxBytes: LINK_IMAGE_MAX_BYTES,
      maxRedirects: 3,
      timeoutMs: LINK_FETCH_TIMEOUT_MS,
      headers: IMAGE_HEADERS,
      fetcher,
      allowHost: imageHostAllowed,
    });
    if (looksLikeMarkup(got.bytes) || !sniffImageBytes(got.bytes)) return null;
    const out = await productImageToWebp(env, got.bytes);
    if (!out.ok) return null;
    const key = `link-cards/${cardId}.webp`;
    await putMediaObject(
      env,
      {
        key,
        visibility: 'public',
        domain: 'link-cards',
        mime: 'image/webp',
        bytes: out.bytes.byteLength,
        entityId: cardId,
        width: out.width,
        height: out.height,
      },
      out.bytes,
      { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' } }
    );
    return key;
  } catch {
    return null;
  }
}

// ===========================================================================
//  OPEN GRAPH, FROM THE FIRST 256 KiB
// ===========================================================================

export interface OpenGraph {
  title: string;
  description: string;
  /** An absolute http(s) address, resolved against the page; null when none was offered. */
  image: string | null;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** One attribute's value out of a tag's attribute list, whichever quoting it used. */
function attribute(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

/** Whitespace collapsed, control characters dropped, clipped to a length. */
function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The card's words and picture from the page's `<meta>` tags: Open Graph
 * first, Twitter's names second, the plain `<title>` and `description` last.
 * A regex over the tags rather than a parser — the tags are flat, the input
 * is bounded, and a parser's tolerance is not needed to read a title.
 */
export function parseOpenGraph(bytes: Uint8Array, baseUrl: string): OpenGraph {
  const html = new TextDecoder().decode(bytes);
  const metas = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    const key = attribute(attrs, 'property') ?? attribute(attrs, 'name');
    const content = attribute(attrs, 'content');
    if (!key || content === null) continue;
    const k = key.trim().toLowerCase();
    if (!metas.has(k)) metas.set(k, decodeEntities(content));
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = cleanText(
    metas.get('og:title') ?? metas.get('twitter:title') ?? (titleTag ? decodeEntities(titleTag) : ''),
    TITLE_MAX
  );
  const description = cleanText(
    metas.get('og:description') ?? metas.get('twitter:description') ?? metas.get('description') ?? '',
    DESCRIPTION_MAX
  );
  const imageRaw =
    metas.get('og:image:secure_url') ??
    metas.get('og:image') ??
    metas.get('og:image:url') ??
    metas.get('twitter:image') ??
    metas.get('twitter:image:src') ??
    '';
  let image: string | null = null;
  if (imageRaw.trim()) {
    try {
      const u = new URL(imageRaw.trim(), baseUrl);
      if (u.protocol === 'https:' || u.protocol === 'http:') image = u.toString();
    } catch {
      image = null;
    }
  }
  return { title, description, image };
}

// ===========================================================================
//  THE RESOLVER
// ===========================================================================

/**
 * The card for a pasted address — from the store when it is fresh, fetched
 * when it is not, never fetched at all for a host outside the allow-list.
 * Refuses only what `normalizeLinkUrl` refuses; a page that cannot be read is
 * a card with `status: 'failed'` (retried after an hour), not an error, so a
 * link is always sendable as at least its host.
 */
export async function resolveLinkCard(env: LinkEnv, rawUrl: unknown, deps: LinkCardDeps = {}): Promise<LinkCardPublic> {
  const url = normalizeLinkUrl(rawUrl);
  const canonical = url.toString();
  const host = displayHost(url.hostname);
  const kind = previewKindFor(url.hostname);
  const now = deps.now?.() ?? new Date();

  const existing = await readLinkCard(env.DB, canonical);
  if (existing && stillFresh(existing, kind, now)) return linkCardPublic(existing);

  const id = existing?.id ?? newId('lnk');
  const fetchedAt = now.toISOString();
  if (kind === null) {
    // NOT ON THE LIST: a bare card, and no request leaves this Worker.
    const bare = await writeLinkCard(env.DB, {
      id, url: canonical, host, title: '', description: '', image_key: null, kind: 'unknown', fetched_at: fetchedAt, status: 'blocked',
    });
    return linkCardPublic(bare);
  }

  const fetched = await fetchPreview(env, canonical, id, deps.fetcher ?? fetch);
  const row = await writeLinkCard(env.DB, {
    id,
    url: canonical,
    host,
    kind,
    fetched_at: fetchedAt,
    title: fetched.title,
    description: fetched.description,
    // A refresh that could not read the page keeps nothing from the last read:
    // the row says `failed` and the next reader retries in an hour.
    image_key: fetched.image_key,
    status: fetched.status,
  });
  return linkCardPublic(row);
}
