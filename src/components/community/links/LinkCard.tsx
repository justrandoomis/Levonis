/**
 * A LINK CARD (docs/COMMUNITY_ECOSYSTEM.md §9.4 "Link cards") — what a pasted
 * address becomes in a chat bubble, under a comment, in a post's body: the
 * page's title, its host, the kind as a glyph, and OUR copy of its picture.
 *
 *   THE PICTURE IS NEVER HOT-LINKED. `image_url` is drawn only when it is a
 *   `/files/…` address (the re-hosted `link-cards/<id>.webp`); anything else —
 *   a stale row, a hand-made message — is not a picture this card will show,
 *   so a reader's browser never calls the pasted host to render the card.
 *
 *   THE ANCHOR opens in a new tab with `rel="noopener noreferrer nofollow"`:
 *   the linked page gets no window handle, no referrer, and no endorsement.
 *
 *   «اطلب طباعته» — on a `model_page` kind only — is the second door: the
 *   request wizard with the link already in its source field
 *   (src/pages/Requests.tsx reads `?link=`); a guest goes through sign-in
 *   first with the wizard remembered, the way the feed's «اطلب طباعته» does.
 *
 *   TWO SIZES. `compact` is a row — glyph or thumbnail, title, host — for a
 *   chat bubble or under a comment; `full` puts the picture on top and adds
 *   the description, for a post's body.
 *
 *   A BARE CARD (a host outside the preview list, a fetch that failed) has no
 *   title: the host stands as the title and the kind as its kicker. It is
 *   still a card, because the address is still a door.
 *
 * `LinkRow` is the reader's convenience: give it a body, it finds the first
 * address, asks `useLinkCard` (one GET per address per page, memoised in
 * src/components/community/links/useLinkCard.ts), and draws the card — or
 * nothing at all when the server holds no row for it. A 404 is not an error
 * here; it is the common case for a link nobody resolved.
 */
import React from 'react';
import { Link } from 'react-router-dom';
// `m` + <MotionFeatures>, never the `motion` proxy: the card sits in the chat,
// the comments and the feed, and the proxy would carry the animation features
// chunk into every one of them for a row's arrival.
import * as Motion from 'motion/react-m';
import { Box, Link2, Newspaper, Play, Printer } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useMotion } from '../../../lib/motion';
import { MotionFeatures } from '../../../lib/motionFeatures';
import type { ChatLink, LinkCard as LinkCardData, LinkCardKind } from './api';
import { hostLine, useLinkStrings } from './strings';
import { firstLink, useLinkCard } from './useLinkCard';

/** What the card needs — a stored card, or the copy a chat message carries. */
export type LinkCardLike = Pick<LinkCardData, 'url' | 'host' | 'title' | 'description' | 'image_url' | 'kind'> | ChatLink;

const GLYPH: Record<LinkCardKind, React.ElementType> = { model_page: Box, video: Play, article: Newspaper, unknown: Link2 };

/** The re-hosted copy only: `/files/link-cards/<id>.webp`. Anything else is not a picture this card shows. */
export function ownImage(url: string | null | undefined): string | null {
  return url && url.startsWith('/files/') ? url : null;
}

/** Where «اطلب طباعته» leads: the request wizard with the link in its source field. */
export function printRequestPath(url: string): string {
  return `/requests?view=new&link=${encodeURIComponent(url)}`;
}

export interface LinkCardProps {
  card: LinkCardLike;
  /** `compact` a row (chat, comments) · `full` picture on top (a post's body). */
  variant?: 'compact' | 'full';
  className?: string;
  /** Offer «اطلب طباعته» on a model page. Default true. */
  printDoor?: boolean;
}

export function LinkCard({ card, variant = 'compact', className = '', printDoor = true }: LinkCardProps) {
  const s = useLinkStrings();
  const { isAuthenticated } = useAuth();
  const title = card.title.trim();
  const image = ownImage(card.image_url);
  const kind: LinkCardKind = card.kind in GLYPH ? card.kind : 'unknown';
  const Glyph = GLYPH[kind];
  const full = variant === 'full';
  const printPath = printRequestPath(card.url);
  const print = isAuthenticated ? { to: printPath, state: undefined } : { to: '/auth', state: { from: printPath } };

  return (
    <div
      data-link-card
      data-link-variant={variant}
      data-link-kind={kind}
      data-link-host={card.host}
      className={`min-w-0 overflow-hidden rounded-lg border border-border-subtle/60 bg-surface text-start ${className}`}
    >
      <a
        href={card.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        data-link-open
        className={`flex min-w-0 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${full ? 'flex-col' : 'items-center gap-3 p-2.5'}`}
      >
        {full && image && <img src={image} alt="" loading="lazy" decoding="async" className="aspect-video max-h-56 w-full object-cover" />}
        {!full &&
          (image ? (
            <img src={image} alt="" loading="lazy" decoding="async" className="size-12 shrink-0 rounded-md object-cover" />
          ) : (
            <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-md bg-surface-raised text-text-secondary">
              <Glyph className="h-5 w-5" strokeWidth={1.5} />
            </span>
          ))}
        <span className={`min-w-0 flex-1 ${full ? 'p-3' : ''}`}>
          <span className="flex items-center gap-1 text-[11px] text-text-muted">
            {full && <Glyph aria-hidden="true" className="h-3 w-3" strokeWidth={1.75} />}
            {s.kinds[kind]}
          </span>
          <span dir="auto" className={`line-clamp-2 block font-semibold leading-snug text-text-primary ${full ? 'text-[14.5px]' : 'text-[13.5px]'}`}>
            {title || card.host}
          </span>
          {full && card.description && (
            <span dir="auto" className="mt-0.5 line-clamp-2 block text-[12.5px] leading-relaxed text-text-secondary">
              {card.description}
            </span>
          )}
          {title && (
            <span dir="auto" className="mt-0.5 block truncate text-[11.5px] text-text-muted">
              {hostLine(s, card.host)}
            </span>
          )}
        </span>
        <span className="sr-only">{s.opensNewTab}</span>
      </a>
      {printDoor && kind === 'model_page' && (
        <div className="border-t border-border-subtle/60 px-2.5 py-1.5">
          <Link to={print.to} state={print.state} data-link-print className="lv-button lv-button-sm lv-button-secondary gap-1.5">
            <Printer aria-hidden="true" className="h-3.5 w-3.5" />
            {s.print}
          </Link>
        </div>
      )}
    </div>
  );
}

export default LinkCard;

export interface LinkRowProps {
  /** The body to look in — its first http(s) address is the card's. */
  text: string | null | undefined;
  variant?: 'compact' | 'full';
  className?: string;
  printDoor?: boolean;
}

/** The first link in a body as a card — or nothing, when the server holds no row for it. */
export function LinkRow({ text, variant = 'compact', className = '', printDoor }: LinkRowProps) {
  const url = firstLink(text);
  const card = useLinkCard(url);
  const m = useMotion();
  if (!card) return null;
  return (
    <MotionFeatures>
      <Motion.div initial={{ opacity: 0, y: m.travel(6) }} animate={{ opacity: 1, y: 0 }} transition={m.spring('ui')} className={className} data-link-row>
        <LinkCard card={card} variant={variant} printDoor={printDoor} />
      </Motion.div>
    </MotionFeatures>
  );
}
