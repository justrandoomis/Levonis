/**
 * WHAT COUNTS AS AN IMAGE ADDRESS, AND WHAT A BROKEN PRIMARY MEANS.
 *
 * Two decisions the product form used to make implicitly, extracted here so
 * they are one rule each, testable without a browser, and identical everywhere
 * they are asked.
 *
 * SCOPE, STATED PLAINLY. This is the ADMIN EDITOR's rule, and it runs in the
 * browser. The server still accepts any string into `product_images.url`
 * (`productPersistence`, a length-capped TEXT column), so what is closed here
 * is the path a human types — not the column. Anything rendered from that
 * column still goes through `SafeImage`, which fails visibly rather than
 * silently.
 *
 * THE FIRST DEFECT. Anything non-empty was treated as a URL. `img.url` is a
 * TEXT column and the form only ever checked that the string had length, so
 * «صورة» typed into the URL box, a Windows path, or a `javascript:` scheme all
 * became an <img src> that silently rendered nothing. A string is not an
 * address, and the difference is worth stating once.
 *
 * THE SECOND DEFECT. The primary image is what the storefront leads with. If
 * its host stops serving the file — a vendor blocking hotlinks, a bucket key
 * renamed — the product page shows a broken box to every customer while the
 * admin screen shows the same broken box to nobody who is looking. The rule
 * below names that state; it does NOT repair it. Repair is an offered button,
 * because silently rewriting `is_primary` on load would mean opening a product
 * and closing it dirty, and a save nobody asked for is worse than a warning.
 */

export type UrlKind = 'r2' | 'absolute' | 'relative' | 'invalid';

export interface UrlVerdict {
  kind: UrlKind;
  ok: boolean;
  /** Arabic, customer-free: this is an admin screen. */
  reason?: string;
}

/** Schemes an <img> can render that are also safe to store and re-serve. */
const SAFE_SCHEMES = ['http:', 'https:'];

/**
 * Is this string an address a browser can load and the server can re-fetch?
 *
 * `data:` and `blob:` are refused deliberately: they render, but they are not
 * addresses — storing one puts an entire image inside a TEXT column that every
 * product read then carries, and it can never be re-fetched or copied to R2.
 * `javascript:` and every other scheme are refused outright.
 */
export function classifyImageUrl(raw: unknown): UrlVerdict {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { kind: 'invalid', ok: false, reason: 'الرابط فارغ' };

  // A site-relative path is how an uploaded R2 object is stored and served.
  if (s.startsWith('/')) {
    // `//host/x` is protocol-relative — and so is `/\host/x`, which browsers
    // resolve identically for http(s). Refusing one and accepting the other
    // would leave the stated rule with a hole.
    if (s.startsWith('//') || s.startsWith('/\\')) {
      return { kind: 'invalid', ok: false, reason: 'رابط بلا بروتوكول — اكتب https://' };
    }
    return { kind: s.startsWith('/api/') || s.startsWith('/media/') ? 'r2' : 'relative', ok: true };
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { kind: 'invalid', ok: false, reason: 'ليس رابطًا صالحًا — يبدأ بـ https:// أو /' };
  }
  if (!SAFE_SCHEMES.includes(u.protocol)) {
    // `new URL('C:\\pictures\\a.jpg')` parses happily, with protocol "c:".
    // Telling an admin their protocol "c" is unsupported is technically true
    // and useless; a one-letter scheme is a Windows drive letter.
    const scheme = u.protocol.replace(':', '');
    return {
      kind: 'invalid',
      ok: false,
      reason:
        scheme.length === 1
          ? 'يبدو مسارًا على جهازك — ارفع الصورة بدل لصق مسارها'
          : `بروتوكول غير مدعوم (${scheme})`,
    };
  }
  if (!u.hostname) return { kind: 'invalid', ok: false, reason: 'رابط بلا مضيف' };
  return { kind: 'absolute', ok: true };
}

/** Convenience for a boolean context. */
export const isUsableImageUrl = (raw: unknown): boolean => classifyImageUrl(raw).ok;

// ------------------------------------------------------- the broken primary

export interface PrimaryRepair {
  /** True only when the primary is broken AND something healthy could take
   *  over. A product whose every image is broken has nothing to repair — the
   *  answer there is to fix an image, not to move the star. */
  needed: boolean;
  /** The failed primary, when there is one. */
  brokenId: string | null;
  /** The first image, in display order, that actually loaded. */
  healthyId: string | null;
}

export interface PrimaryCandidate {
  id: string;
  url: string;
  is_primary: boolean;
}

/**
 * Should the star move, and to what?
 *
 * `failed` holds the ids whose <img> reported an error. An id NOT in the set is
 * not proof of health — a lazy image far down the grid may not have been asked
 * for yet — so a candidate must have been seen to LOAD before it is offered as
 * a replacement. That is what `loaded` is for, and why the two sets are
 * separate rather than one tri-state.
 */
export function primaryRepair(
  images: readonly PrimaryCandidate[],
  failed: ReadonlySet<string>,
  loaded: ReadonlySet<string>
): PrimaryRepair {
  const primary = images.find((i) => i.is_primary) ?? null;
  const broken = primary && failed.has(primary.id) ? primary : null;
  if (!broken) return { needed: false, brokenId: null, healthyId: null };
  const healthy = images.find((i) => i.id !== broken.id && loaded.has(i.id) && isUsableImageUrl(i.url));
  return { needed: !!healthy, brokenId: broken.id, healthyId: healthy?.id ?? null };
}
