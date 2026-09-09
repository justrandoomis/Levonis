/**
 * SPLITTING A LIST OF ADDRESSES, ONCE.
 *
 * A comma is a LEGAL CHARACTER IN A URL PATH and vendor CDNs use it constantly:
 * a Cloudinary transform reads `/upload/w_800,h_600,c_fill/a1.jpg`, and the
 * IIIF Image API's "scale to width" size is literally `400,`. Splitting a list
 * of URLs on every comma therefore turns one working address into several
 * broken ones — silently, and on every round trip.
 *
 * THE RULE. Whitespace always separates: a bare space cannot occur inside a
 * valid URL, so it is unambiguous. A comma separates ONLY when what follows it
 * begins a new address AND what precedes it does not look like the middle of
 * one. "Begins a new address" is `http://`, `https://`, or a site-relative `/`
 * — and the last of those needs the second condition, because `400,/0/default`
 * is one IIIF path, not two addresses.
 *
 * THE TIE-BREAK, and it is not optimistic. `,/` is genuinely ambiguous:
 * `…/full/400,/0/default.jpg` is ONE IIIF address, while
 * `…/a.jpg,/api/media/b.jpg` is two. A comma before `/` is therefore a
 * separator only when the text before it ends in something that looks like a
 * FILE — its last path segment contains a dot. `400` does not; `a.jpg` does.
 *
 * And a comma inside a QUERY STRING is never a separator, in either form: query
 * values carry commas routinely (`?w=1,/b`, `?next=https://x`), and there is no
 * way to tell one from a boundary. Whitespace is the canonical separator now,
 * so nothing is lost by refusing to guess there.
 *
 * Two callers share this: the TXT template's `usage_steps.N.images` field and
 * the admin image box's paste field. They had the same bug for the same reason,
 * and one implementation is how they stop drifting.
 */

/** `http(s)://…` or a site-relative `/…` that is not protocol-relative. */
const looksAbsolute = (s: string): boolean => /^https?:\/\/[^/\s]/i.test(s);
const looksRelative = (s: string): boolean => s.startsWith('/') && !s.startsWith('//');

/** Would this piece stand on its own as an address? */
export const looksLikeUrl = (s: string): boolean => looksAbsolute(s) || looksRelative(s);

/**
 * Split a human-typed or file-authored list of image addresses.
 *
 * Whitespace is always a separator. A comma is a separator only where both
 * sides agree it is one: a complete address before it, and the start of an
 * address after it.
 */
export function splitUrlList(raw: string): string[] {
  const out: string[] = [];
  for (const chunk of raw.split(/\s+/)) {
    if (!chunk) continue;
    let rest = chunk;
    // Walk the commas left to right, cutting only where both sides agree.
    for (;;) {
      const at = nextBoundary(rest);
      if (at < 0) break;
      const head = rest.slice(0, at);
      if (head) out.push(head);
      rest = rest.slice(at + 1);
    }
    if (rest) out.push(rest);
  }
  // A trailing comma on the LAST piece is punctuation, not part of the address
  // — but only when what remains is still a usable address without it.
  return out
    .map((s) => (s.endsWith(',') && looksLikeUrl(s.slice(0, -1)) ? s.slice(0, -1) : s))
    .filter(Boolean);
}

/** The index of the first comma that is genuinely a separator, or -1. */
function nextBoundary(s: string): number {
  for (let i = s.indexOf(','); i >= 0; i = s.indexOf(',', i + 1)) {
    const before = s.slice(0, i);
    const after = s.slice(i + 1);
    // Inside a query string, a comma is data. `?w=1,/b` and `?next=https://x`
    // are both one address, and nothing distinguishes them from a boundary.
    if (before.includes('?')) return -1;
    if (looksAbsolute(after)) return i;
    // `,/` splits only when what precedes it ends in a filename-looking
    // segment. `…/full/400` does not; `…/a.jpg` does.
    if (looksRelative(after) && looksLikeUrl(before) && lastSegmentLooksLikeFile(before)) return i;
  }
  return -1;
}

const lastSegmentLooksLikeFile = (url: string): boolean => {
  const last = url.split('/').pop() ?? '';
  return last.includes('.');
};
