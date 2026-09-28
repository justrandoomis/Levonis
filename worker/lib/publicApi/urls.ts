/**
 * ABSOLUTE URLS FOR THE PUBLIC API.
 *
 * Every link and every picture in a public answer is absolute, on the site's
 * canonical origin (`trustedOrigin`: APP_ORIGIN when set), so an agent can use
 * it as-is without knowing where the answer came from.
 *
 * PICTURES ARE THE ORIGINALS. The shop stores each image once, as the WebP it
 * was uploaded or converted to — there are no resized copies — so the
 * `/files/<key>` URL is already the highest quality the site has. A picture
 * is published ONLY when its key is one `/files` serves to an anonymous
 * visitor (`isAnonymousPublicMediaKey`, the same predicate the file route
 * authorises with); anything else — a private upload, a malformed value, a
 * path trick — becomes `null`, never a link that would 403.
 */
import type { Context } from 'hono';
import type { AppContext } from '../types';
import { trustedOrigin } from '../appOrigin';
import { isAnonymousPublicMediaKey } from '../mediaStorage';

export const API_PREFIX = '/api/public/v1';

export interface PublicUrls {
  origin: string;
  /** A page on the website: `web('/product/x')` → `https://levonis-iq.com/product/x`. */
  web(path: string): string;
  /** An endpoint of this API. */
  api(path: string): string;
  /** A public picture's absolute URL, or null when it is not one. */
  media(value: unknown): string | null;
}

export function publicUrls(c: Context<AppContext>): PublicUrls {
  return urlsForOrigin(trustedOrigin(c));
}

export function urlsForOrigin(origin: string): PublicUrls {
  const base = origin.replace(/\/+$/, '');
  return {
    origin: base,
    web: (path) => `${base}${path.startsWith('/') ? path : `/${path}`}`,
    api: (path) => `${base}${API_PREFIX}${path === '' || path.startsWith('/') || path.startsWith('?') ? path : `/${path}`}`,
    media: (value) => publicMediaUrl(base, value),
  };
}

export function publicMediaUrl(origin: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('/files/')) {
    const key = v.slice('/files/'.length).split(/[?#]/)[0];
    if (!key || key.includes('..') || key.includes('\\')) return null;
    return isAnonymousPublicMediaKey(key) ? `${origin}/files/${key}` : null;
  }
  // An owner-entered banner picture may be an external https image (homeContent
  // safeImage allows http(s)); publish it only over https.
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return v;
  return null;
}
