/**
 * AN OWNER-WRITTEN NOTE WHOSE LINK CAN BE TAPPED (owner, 2026-11-20; DECISIONS row 365).
 *
 * `NoteText` draws a note in place: its words as text, each http(s) link (src/lib/noteLinks.ts) as an anchor
 * that says «افتح الخريطة» — a new tab, `rel="noopener noreferrer"`. `NoteLinkRow` draws the anchors alone,
 * for a note whose words sit inside a choice button (an anchor inside a button is not valid, and a tap on it
 * would choose the option): the button shows `noteWithoutLinks`, this row sits under the group.
 *
 * The note is the owner's text and is never interpreted: React escapes the words, and only an address that
 * `noteParts` accepted becomes an `href`.
 */
import { noteParts } from '../../lib/noteLinks';

const LINK =
  'font-medium text-gold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded';

function Anchor({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-note-link
      // Inside a <label> or a tappable card the tap is the link's alone.
      onClick={(e) => e.stopPropagation()}
      className={LINK}
    >
      {label}
    </a>
  );
}

/** The note in place: words, and each link as «label». */
export function NoteText({ text, label }: { text: string | null | undefined; label: string }) {
  return (
    <>
      {noteParts(text).map((p, i) => (p.kind === 'text' ? <span key={i}>{p.text}</span> : <Anchor key={i} href={p.href} label={label} />))}
    </>
  );
}

/** The links of a note alone, on their own row (44 px tall for a thumb); nothing when the note has none. */
export function NoteLinkRow({ text, label, lead }: { text: string | null | undefined; label: string; lead?: string }) {
  const links = noteParts(text).filter((p) => p.kind === 'link');
  if (links.length === 0) return null;
  return (
    <p className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-secondary" data-note-links>
      {lead ? <span>{lead}</span> : null}
      {links.map((p, i) => (p.kind === 'link' ? <Anchor key={i} href={p.href} label={label} /> : null))}
    </p>
  );
}
