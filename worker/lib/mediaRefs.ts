/**
 * Which image references a merchant is allowed to point at.
 *
 * A merchant supplies their logo, banner and product pictures as strings, and
 * a string the merchant controls that ends up in `<img src>` is a request the
 * VISITOR'S browser makes to wherever the merchant chose. That is:
 *
 *   - an off-platform tracking pixel — every visitor's IP and User-Agent
 *     handed to a third party the visitor never chose to talk to;
 *   - a shop that breaks when someone else's host goes away;
 *   - and, with a `data:` or `javascript:` scheme, an attempt at something
 *     worse.
 *
 * `MERCHANT_STORES.md` §10 already says no merchant string reaches the
 * stylesheet. This is the same rule for the other place a merchant string can
 * reach the page. A reference is accepted only if it addresses an object THIS
 * platform issued to THIS merchant — which is what makes "linked to a real
 * record" true rather than "a key someone typed in".
 *
 * New uploads use `merchants/<user id>/public/<id>.<ext>`. The previous
 * `community/<user id>/<id>.<ext>` shape stays accepted while stored products
 * migrate, so editing an old listing never strips its working media.
 */

/** `<hex id>.<ext>` — exactly what `newId()` + the sniffer produce. */
const OBJECT_RE = /^[a-z0-9]{4,40}\.(jpg|jpeg|png|gif|webp|avif)$/;

/**
 * The storage key behind a reference, if it belongs to `userId`.
 *
 * Accepts either the key (`community/u1/ab.jpg`) or the delivery path
 * (`/files/community/u1/ab.jpg`), because both forms exist in the codebase
 * already — the store columns hold keys and the product array holds paths.
 * Returns `null` for anything else, including an absolute URL, a `data:` URI,
 * a traversal, and another merchant's object.
 */
export function ownedMediaKey(value: unknown, userId: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 200) return null;
  // A scheme or a protocol-relative prefix means it is not ours. Checked
  // before any stripping, so `//evil.example/x` cannot slip through as a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;

  const key = raw.startsWith('/files/') ? raw.slice('/files/'.length) : raw;
  if (key.includes('..') || key.includes('\\')) return null;

  const parts = key.split('/');
  const legacy = parts.length === 3 && parts[0] === 'community' && parts[1] === userId;
  const canonical = parts.length === 4 && parts[0] === 'merchants' && parts[1] === userId && parts[2] === 'public';
  if (!legacy && !canonical) return null;
  const object = parts[parts.length - 1];
  if (!OBJECT_RE.test(object)) return null;
  return key;
}

/** The same check, returning the `/files/...` path the frontend renders. */
export function ownedMediaUrl(value: unknown, userId: string): string | null {
  const key = ownedMediaKey(value, userId);
  return key ? `/files/${key}` : null;
}

/**
 * Filter a list of product images down to the ones this merchant owns.
 *
 * Silent, not an error: a merchant re-saving a product whose image was
 * removed should not be blocked from fixing the price. What they cannot do is
 * introduce a reference to something that is not theirs.
 */
export function ownedMediaUrls(value: unknown, userId: string, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const url = ownedMediaUrl(item, userId);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
