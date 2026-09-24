/**
 * EVERYTHING IN A LAYOUT THAT POINTS SOMEWHERE: pictures, videos, products,
 * collections, coupons and links.
 *
 * A layout is the one place a merchant arranges what every visitor's browser
 * will fetch and follow, so a reference is accepted only in a TYPED form that
 * cannot be read two ways:
 *
 *   media        a storage KEY this platform issued to the store's owner —
 *                never a URL. The renderer is what turns it into `/files/<key>`,
 *                so an off-platform tracking pixel, a `data:` image or a path
 *                traversal has no spelling that survives.
 *   ids          products, collections and coupons are ids; which of them
 *                belong to THIS store is decided by the server against the
 *                database (worker/lib/storeLayout.ts), and every public read is
 *                scoped by the store in SQL besides.
 *   links        an internal route from a closed list, one of this store's
 *                product/collection ids, or an https:// address. No other
 *                scheme — `javascript:`, `data:`, `http:`, `//host` — has a
 *                representation, and a string that tries one is REFUSED, not
 *                cleaned, because there is no honest link it could have meant.
 *   social       a provider from a closed list plus a handle. The address is
 *                BUILT from the provider's own template when rendered, so a
 *                link labelled Instagram cannot lead anywhere but Instagram.
 */

// ------------------------------------------------------------------ media

export type MediaKind = 'image' | 'video';

/** The owner segment of a key: a user id as `newId()` and the tests write them. */
const OWNER_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
/** `<id>.<ext>` exactly as the upload route names objects (worker/lib/mediaRefs.ts OBJECT_RE). */
const OBJECT_NAME: Record<MediaKind, RegExp> = {
  image: /^[a-z0-9]{4,40}\.(?:jpg|jpeg|png|gif|webp|avif)$/,
  video: /^[a-z0-9]{4,40}\.(?:mp4|webm)$/,
};
const MAX_MEDIA_REF = 200;

export type MediaVerdict =
  | { ok: true; key: string }
  /** Not a key at all: a URL, a scheme, a traversal, a wrong extension. */
  | { ok: false; code: 'invalid_media' }
  /** A well-formed key under SOMEONE ELSE's prefix. */
  | { ok: false; code: 'foreign_media' };

/**
 * A media reference, as the canonical storage key, or why it is refused.
 * `null` means "no media" (an empty or absent value), which is not an error.
 *
 * `ownerUserId`:
 *   - a user id: the key must live under that owner's prefix;
 *   - `''`: matches nothing, so every key is foreign (the safe reading of a
 *     caller that forgot to supply the owner);
 *   - `null`: shape only. Used to RENDER a layout the server already verified,
 *     never to accept one.
 */
export function mediaKey(raw: unknown, kind: MediaKind, ownerUserId: string | null): MediaVerdict | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return { ok: false, code: 'invalid_media' };
  const v = raw.trim();
  if (!v) return null;
  if (v.length > MAX_MEDIA_REF) return { ok: false, code: 'invalid_media' };
  // Any scheme, or a protocol-relative prefix, is somebody else's address.
  // Checked BEFORE the /files/ prefix is removed, so `//evil/x` is never a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) return { ok: false, code: 'invalid_media' };
  const key = v.startsWith('/files/') ? v.slice('/files/'.length) : v;
  if (/[\\%?#\s]|\.\./.test(key)) return { ok: false, code: 'invalid_media' };
  const parts = key.split('/');
  const canonical = parts.length === 4 && parts[0] === 'merchants' && parts[2] === 'public';
  const legacy = parts.length === 3 && parts[0] === 'community';
  if (!canonical && !legacy) return { ok: false, code: 'invalid_media' };
  const owner = parts[1];
  if (!OWNER_SEGMENT.test(owner) || !OBJECT_NAME[kind].test(parts[parts.length - 1])) {
    return { ok: false, code: 'invalid_media' };
  }
  if (ownerUserId !== null && owner !== ownerUserId) return { ok: false, code: 'foreign_media' };
  return { ok: true, key };
}

/** The delivery path for a key that passed `mediaKey`, or '' for anything else. */
export function mediaSrc(key: string | null | undefined, kind: MediaKind = 'image'): string {
  const v = mediaKey(key, kind, null);
  return v && v.ok ? `/files/${v.key}` : '';
}

// -------------------------------------------------------------------- ids

/** Product, collection and coupon ids: the shape `newId()` produces, capped. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function refId(raw: unknown): string | null {
  return typeof raw === 'string' && ID.test(raw) ? raw : null;
}

// ------------------------------------------------------------------ links

/** Where an internal link may go. Mapped to a real path by the renderer. */
export const LINK_ROUTES = ['home', 'products', 'deals', 'collections', 'services', 'showcase', 'about', 'reviews', 'cart'] as const;
export type LinkRoute = (typeof LINK_ROUTES)[number];

export type LinkTarget =
  | { kind: 'none' }
  | { kind: 'route'; route: LinkRoute }
  | { kind: 'product'; id: string }
  | { kind: 'collection'; id: string }
  | { kind: 'external'; url: string };

export const NO_LINK: LinkTarget = Object.freeze({ kind: 'none' }) as LinkTarget;

const MAX_URL = 500;

/**
 * An outbound address a storefront may put in an `href`, normalised, or null.
 *
 * https only. The string must SAY `https://` before the URL parser is asked
 * anything, because the parser is lenient in ways that are dangerous here
 * (it drops tabs and newlines inside the scheme, so `java\tscript:` parses as
 * `javascript:`). No whitespace or control character anywhere, no
 * credentials, no IP literal, no non-default port, a dotted host name.
 * Every address this accepts is also accepted by the server's `safeLink`
 * (worker/lib/homeContent.ts) — a strictly narrower rule, pinned by
 * tests/storeLayoutSchema.test.ts.
 */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > MAX_URL) return null;
  if (!/^https:\/\//i.test(v)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007F-\u009F\\]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host || !host.includes('.') || host.endsWith('.') || host.startsWith('[')) return null;
  if (/^[0-9.]+$/.test(host)) return null;
  if (u.port && u.port !== '443') return null;
  const href = u.href;
  return href.length <= MAX_URL ? href : null;
}

export type LinkVerdict = { link: LinkTarget; issue?: 'unsafe_link' | 'invalid_value' | 'invalid_ref' };

/**
 * A link setting, typed. A bare string is read as an attempted address: an
 * https one is accepted as external, anything carrying another scheme is an
 * `unsafe_link` (fatal on write), and a relative path is refused as a value —
 * internal destinations are routes and ids, never a path the merchant types.
 */
export function linkTarget(raw: unknown): LinkVerdict {
  if (raw === undefined || raw === null || raw === '') return { link: NO_LINK };
  if (typeof raw === 'string') {
    const url = safeExternalUrl(raw);
    if (url) return { link: { kind: 'external', url } };
    return { link: NO_LINK, issue: looksLikeForeignAddress(raw) ? 'unsafe_link' : 'invalid_value' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { link: NO_LINK, issue: 'invalid_value' };
  const o = raw as Record<string, unknown>;
  const kind = own(o, 'kind');
  switch (kind) {
    case 'none':
      return { link: NO_LINK };
    case 'route': {
      const route = own(o, 'route');
      return typeof route === 'string' && (LINK_ROUTES as readonly string[]).includes(route)
        ? { link: { kind: 'route', route: route as LinkRoute } }
        : { link: NO_LINK, issue: 'invalid_value' };
    }
    case 'product':
    case 'collection': {
      const id = refId(own(o, 'id'));
      return id ? { link: { kind, id } } : { link: NO_LINK, issue: 'invalid_ref' };
    }
    case 'external': {
      const rawUrl = own(o, 'url');
      if (rawUrl === undefined || rawUrl === null || (typeof rawUrl === 'string' && !rawUrl.trim())) {
        return { link: NO_LINK, issue: 'invalid_value' };
      }
      const url = safeExternalUrl(rawUrl);
      return url ? { link: { kind: 'external', url } } : { link: NO_LINK, issue: 'unsafe_link' };
    }
    default:
      return { link: NO_LINK, issue: 'invalid_value' };
  }
}

/**
 * Does this string try to name an address somewhere — a scheme or a
 * protocol-relative host — once the whitespace and control characters a URL
 * parser would silently drop are taken out? (`java\tscript:` is `javascript:`
 * to a browser, so it is `javascript:` here too.)
 */
function looksLikeForeignAddress(raw: string): boolean {
  // eslint-disable-next-line no-control-regex
  const compact = raw.replace(/[\s\u0000-\u001F\u007F-\u009F]/g, '').toLowerCase();
  return /^[a-z][a-z0-9+.-]*:/.test(compact) || compact.startsWith('//') || compact.startsWith('\\\\');
}

// ----------------------------------------------------------------- social

interface SocialProvider {
  /** Host names a pasted profile address may use (without `www.`/`m.`). */
  hosts: readonly string[];
  handle: RegExp;
  /** The ONLY way an address is made: this template around a validated handle. */
  href: (handle: string) => string;
}

export const SOCIAL_PROVIDERS = {
  instagram: { hosts: ['instagram.com'], handle: /^[A-Za-z0-9._]{1,30}$/, href: (h: string) => `https://www.instagram.com/${h}` },
  facebook: { hosts: ['facebook.com', 'fb.com'], handle: /^[A-Za-z0-9.-]{2,80}$/, href: (h: string) => `https://www.facebook.com/${h}` },
  tiktok: { hosts: ['tiktok.com'], handle: /^[A-Za-z0-9._]{2,24}$/, href: (h: string) => `https://www.tiktok.com/@${h}` },
  telegram: { hosts: ['t.me', 'telegram.me'], handle: /^[A-Za-z][A-Za-z0-9_]{3,31}$/, href: (h: string) => `https://t.me/${h}` },
  whatsapp: { hosts: ['wa.me'], handle: /^[1-9][0-9]{7,14}$/, href: (h: string) => `https://wa.me/${h}` },
  youtube: { hosts: ['youtube.com'], handle: /^[A-Za-z0-9._-]{3,30}$/, href: (h: string) => `https://www.youtube.com/@${h}` },
  x: { hosts: ['x.com', 'twitter.com'], handle: /^[A-Za-z0-9_]{1,15}$/, href: (h: string) => `https://x.com/${h}` },
  snapchat: { hosts: ['snapchat.com'], handle: /^[A-Za-z][A-Za-z0-9._-]{2,14}$/, href: (h: string) => `https://www.snapchat.com/add/${h}` },
} as const satisfies Record<string, SocialProvider>;

export type SocialProviderName = keyof typeof SOCIAL_PROVIDERS;
export const SOCIAL_PROVIDER_NAMES = Object.keys(SOCIAL_PROVIDERS) as SocialProviderName[];

export interface SocialItem {
  provider: SocialProviderName;
  handle: string;
}

export function isSocialProvider(v: unknown): v is SocialProviderName {
  return typeof v === 'string' && Object.hasOwn(SOCIAL_PROVIDERS, v);
}

/**
 * The handle a merchant meant, from a handle (`@ali3d`, `ali3d`) or from a
 * profile address on the provider's own host. Anything else is null.
 */
export function socialHandle(provider: SocialProviderName, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p: SocialProvider = SOCIAL_PROVIDERS[provider];
  let v = raw.trim();
  if (!v || v.length > 200) return null;
  if (/^https:\/\//i.test(v)) {
    const url = safeExternalUrl(v);
    if (!url) return null;
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
    if (!p.hosts.includes(host)) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (provider === 'snapchat' && segs[0] === 'add') segs.shift();
    if (provider === 'facebook' && segs[0] === 'profile.php') v = u.searchParams.get('id') ?? '';
    else v = segs[0] ?? '';
  }
  if (provider === 'whatsapp') v = v.replace(/[\s+\-().]/g, '');
  v = v.replace(/^@/, '');
  return p.handle.test(v) ? v : null;
}

/** The profile address for a provider and a handle `socialHandle` accepted. */
export function socialHref(item: SocialItem): string {
  if (!isSocialProvider(item.provider)) return '';
  const handle = socialHandle(item.provider, item.handle);
  return handle ? SOCIAL_PROVIDERS[item.provider].href(handle) : '';
}

// ----------------------------------------------------------------- helper

/** An OWN property of a parsed object — never one inherited from its prototype. */
export function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}
