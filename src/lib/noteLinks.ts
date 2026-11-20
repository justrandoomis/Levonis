/**
 * A LINK INSIDE AN OWNER-WRITTEN NOTE (owner, 2026-11-20; DECISIONS row 365).
 *
 * The warehouse pickup note of the printer services is one line the owner types — and on the live site it is
 * «مخزن Levonis — الموقع على الخريطة: https://maps.app.goo.gl/…». Drawn as text, the address could not be
 * tapped. `noteParts` splits a note into its words and its links, so a screen draws the words as text and each
 * link as an anchor (src/components/ui/NoteLinks.tsx) — never as HTML.
 *
 * WHAT IS A LINK: an absolute `http://` or `https://` address with a host and no credentials, written in the
 * characters an address is made of. Nothing else — `javascript:`, `data:`, `tel:`, a bare `www.` — is ever a
 * link: it stays the text the owner typed. The address ends at whitespace, at a quote or an angle bracket, at
 * any letter that is not ASCII (Arabic or Kurdish words written straight after it), and before the sentence
 * punctuation that closes it. `href` is the address exactly as written, so the parts put back together are
 * the note, character for character.
 *
 * Pure, no DOM: tests/noteLinks.test.ts.
 */
export type NotePart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

/** An http(s) address: scheme, a host that starts with a letter or digit, then address characters only. */
const ADDRESS = /https?:\/\/[A-Za-z0-9][A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]*/gi;
/** Sentence punctuation that ends up glued to an address: it belongs to the sentence. */
const TRAILING = /[.,;:!?\]]+$/;

function linkOf(candidate: string): string | null {
  let href = candidate.replace(TRAILING, '');
  // «(https://…)» — a closing bracket with no opening one inside the address is the sentence's.
  while (href.endsWith(')') && !href.includes('(')) href = href.slice(0, -1).replace(TRAILING, '');
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return href;
  } catch {
    return null;
  }
}

/** The note as text and link parts, in order. Empty for an empty note. */
export function noteParts(note: string | null | undefined): NotePart[] {
  const text = typeof note === 'string' ? note : '';
  if (!text) return [];
  const parts: NotePart[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === 'text') last.text += t;
    else parts.push({ kind: 'text', text: t });
  };
  let at = 0;
  for (const m of text.matchAll(ADDRESS)) {
    const start = m.index ?? 0;
    const href = linkOf(m[0]);
    if (!href) continue; // not a link: it stays in the text around it
    push(text.slice(at, start));
    parts.push({ kind: 'link', href });
    at = start + href.length;
  }
  push(text.slice(at));
  return parts;
}

/** The links of a note, in order. */
export function noteLinks(note: string | null | undefined): string[] {
  return noteParts(note).flatMap((p) => (p.kind === 'link' ? [p.href] : []));
}

/**
 * The note's words alone, for a place where an anchor cannot be drawn (inside a choice button — the link is
 * then drawn beside it). The lead-in a removed link leaves dangling at the end («…على الخريطة:») is trimmed.
 */
export function noteWithoutLinks(note: string | null | undefined): string {
  return noteParts(note)
    .flatMap((p) => (p.kind === 'text' ? [p.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s:：،,\-–—(]+$/, '')
    .trim();
}

/** What the anchor says: the note's link is the way to the pickup place. */
export const OPEN_MAP_LABEL: Record<'ar' | 'en' | 'ckb', string> = {
  ar: 'افتح الخريطة',
  en: 'Open the map',
  ckb: 'نەخشەکە بکەرەوە',
};
