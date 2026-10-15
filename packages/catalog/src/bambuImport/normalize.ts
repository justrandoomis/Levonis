/**
 * Text normalisation shared by every Bambu import module (spec §C.1, §C.5).
 *
 * Deterministic and locale-free: the runner and the Worker must normalise the
 * same source text to the same bytes, because ids (§B.8) and fingerprints
 * (§I.1) are computed from it.
 */

/** Unicode NFC — the form every stored source string is kept in. */
export function nfc(s: string): string {
  return s.normalize('NFC');
}

/** Collapses every run of whitespace (NBSP and zero-width breaks included) to one space, trimmed. */
export function collapseWs(s: string): string {
  return s.replace(/[\s\u00a0\u200b\u2028\u2029\ufeff]+/g, ' ').trim();
}

/** A source text field as stored: NFC, whitespace collapsed. */
export function cleanText(s: unknown): string {
  return typeof s === 'string' ? nfc(collapseWs(s)) : '';
}

/**
 * The handle of a product page: `P.seoCode` is stored percent-encoded with
 * uppercase hex for non-ASCII handles (`usb%E2%80%91c-…`). Decoded, then NFC.
 * A malformed escape keeps the raw text rather than throwing.
 */
export function decodeHandle(seoCode: string): string {
  let out = seoCode.trim();
  try {
    out = decodeURIComponent(out);
  } catch {
    /* keep the raw text */
  }
  return nfc(out);
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  sup1: '¹', sup2: '²', sup3: '³', deg: '°', mu: 'μ', micro: 'µ', times: '×', divide: '÷', plusmn: '±', le: '≤', ge: '≥',
  ne: '≠', asymp: '≈', minus: '−', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”',
  bdquo: '„', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', frac12: '½', frac14: '¼', frac34: '¾',
  ordm: 'º', ordf: 'ª', laquo: '«', raquo: '»', sect: '§', para: '¶', dagger: '†', Dagger: '‡', permil: '‰', prime: '′',
  Prime: '″', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', infin: '∞', ohm: 'Ω', Omega: 'Ω', alpha: 'α',
  beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', lambda: 'λ', pi: 'π', sigma: 'σ', phi: 'φ', theta: 'θ', eacute: 'é',
  egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö',
  Uuml: 'Ü', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ', oacute: 'ó', iacute: 'í', uacute: 'ú', shy: '', zwj: '\u200d',
  zwnj: '\u200c', lrm: '\u200e', rlm: '\u200f', cent: '¢', pound: '£', euro: '€', yen: '¥', curren: '¤', check: '✓',
};

/** Decodes HTML character references: named (a fixed set), decimal and hexadecimal. Unknown names stay as written. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    const v = NAMED[body];
    return v === undefined ? whole : v;
  });
}

/**
 * A label as the registries match it: lower case, NFKC (so `²`, `³`, full-width
 * forms fold), every run of non-alphanumerics one space. "Build Volume (W×D×H)"
 * and "build volume(w*d*h)" read the same.
 */
export function labelKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** An ASCII slug of a label: `x.<slug>` keys for unknown spec labels. ≤ 60 characters. */
export function slugOf(s: string, max = 60): string {
  const base = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (base || 'item').slice(0, max).replace(/_+$/g, '');
}

/** Removes the query string and the fragment of a URL; anything unparseable comes back trimmed. */
export function stripQuery(url: string): string {
  const u = url.trim();
  const cut = u.search(/[?#]/);
  return cut < 0 ? u : u.slice(0, cut);
}

/**
 * A link as the import keeps it: without its query and fragment — except a
 * YouTube watch link, whose video id IS the query (`?v=`). That one becomes
 * `https://www.youtube.com/watch?v=<id>`, and '' (no link) when it names no
 * video (review 4, finding 11: obxidian-high-flow-hotend kept the bare
 * https://www.youtube.com/watch). A tracker link is kept whole elsewhere.
 */
export function keptLinkUrl(url: string): string {
  const u = url.trim();
  const host = hostOf(absolutize(u));
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const path = /^(?:https?:)?\/\/[^/?#]+(\/[^?#]*)?/i.exec(u)?.[1] ?? '';
    if (path.replace(/\/+$/, '') === '/watch') {
      const id = /[?&]v=([A-Za-z0-9_-]{6,20})(?:[&#]|$)/.exec(u)?.[1];
      return id ? `https://www.youtube.com/watch?v=${id}` : '';
    }
  }
  return stripQuery(u);
}

/** `//host/path` → `https://host/path`; anything else unchanged. */
export function absolutize(url: string): string {
  const u = url.trim();
  return u.startsWith('//') ? `https:${u}` : u;
}

/** The host of an absolute http(s) URL, lower case, or '' when it has none. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : '';
}
