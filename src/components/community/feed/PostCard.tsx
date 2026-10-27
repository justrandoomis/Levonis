/**
 * ONE POST IN THE FEED, card v2 (community UI plan C2.1; IMG_8486). Shared by
 * «أتابعهم» and «أحدث المشاريع» on the home.
 *
 *   a boxed card (`cm-card`, the scope radius-xl)
 *   the author row: 48px picture, the name (the one link to the maker), the
 *     time; at the end the gold kind badge and «⋯» (PostMenu), and under the
 *     badge the small follow button
 *   the title (22/800) and the first lines of the story, then the first link
 *     in the words as a card (LinkRow, drawn only when the server holds it)
 *   the cover, inset, 16:9
 *   two chips: the first tag, and «material · printer» (a door to the
 *     catalogue when the material or the printer is a product there)
 *   a hairline, «عرض المشروع ‹» in gold: THE card's one stretched link, named
 *     with the title so every card's link has its own name
 *   a hairline, then the four labelled cells (ActionRow `labelled`)
 *
 * Every pressable thing beside the stretched link is a sibling with
 * `relative z-10`, never inside it, and a 44 px target. The commerce verbs
 * are the project page's (plan D-10), not the card's.
 *
 * Memoised: the feed appends a page by re-rendering the list, and thirty
 * cards that did not change must not re-render with it.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Box, Play, Tag } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useAuth } from '../../../AuthContext';
import SafeImage from '../../ui/SafeImage';
import ActionRow from '../social/ActionRow';
import PostMenu from '../social/PostMenu';
import FollowUserButton from '../social/FollowUserButton';
import { creatorHref, type PostCard as PostCardData } from '../projects/api';
import { KindIcon } from '../projects/kindIcons';
import { useProjectStrings } from '../projects/strings';
import { KitAvatar } from '../kit/display';
import { OnwardChevron } from '../kit/buttons';
import { HubLink } from '../hub/parts';
import { timeAgo } from '../hub/copy';
import { useHubStrings } from '../hub/strings';
import { LinkRow } from '../links/LinkCard';
import { feedCoverSizes } from '../../../../packages/contracts/src/imageSizes';

const CHIP_LOOK =
  'inline-flex min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-3 text-[13px] text-text-secondary';
const CHIP = `${CHIP_LOOK} lv-hit relative z-10 transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`;

/** What a press on the card changed: the counts, the viewer's own marks. */
export interface PostPatch {
  counts?: Partial<PostCardData['counts']>;
  viewer?: { liked?: boolean; saved?: boolean };
}

export default React.memo(PostCard);

function PostCard({ post: p, eager = false, onPatch }: { post: PostCardData; eager?: boolean; onPatch?: (id: string, change: PostPatch) => void }) {
  const { lang } = useLanguage();
  const { user } = useAuth();
  const s = useHubStrings();
  const ps = useProjectStrings();
  const author = p.author.username ? creatorHref(p.author.username) : null;
  const mine = !!user && user.id === p.author.id;

  // «PLA Matte · Bambu A1»: the author's words, else the catalogue product's name.
  const material = p.material.name || p.material.product?.name || '';
  const printer = p.printer.name || p.printer.product?.name || '';
  const spec = [material, printer].filter(Boolean).join(' · ');
  const specHref = p.material.product?.url ?? p.printer.product?.url ?? null;
  const tag = p.tags[0];
  const specInner = (
    <>
      <Box aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      <bdi className="truncate">{spec}</bdi>
    </>
  );

  return (
    <article
      data-post-card={p.id}
      data-post-kind={p.kind}
      className="cm-card relative flex flex-col gap-3 rounded-xl p-3 shadow-sm has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
    >
      <header className="flex items-start gap-3">
        <KitAvatar src={p.author.avatarUrl} name={p.author.name} size={48} />
        <div className="min-w-0 flex-1 pt-1">
          <p className="truncate text-[17px] font-bold leading-tight text-text-primary">
            {author ? (
              <Link to={author} className="lv-hit relative z-10 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                <bdi>{p.author.name}</bdi>
              </Link>
            ) : (
              <bdi>{p.author.name}</bdi>
            )}
          </p>
          {p.published_at && (
            <p className="mt-1 text-[13px] text-text-muted">
              <time dateTime={p.published_at}>{timeAgo(p.published_at, lang)}</time>
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-start gap-1">
          <div className="flex items-center">
            <span
              data-post-kind-badge
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold"
              style={{ background: 'var(--cm-wait-bg, var(--color-gold-fill))', color: 'var(--cm-wait-ink, var(--color-onyx))' }}
            >
              <KindIcon kind={p.kind} />
              {ps.kinds[p.kind]}
            </span>
            <PostMenu post={p} mine={mine} className="-me-2" />
          </div>
          <FollowUserButton userId={p.author.id} size="sm" name={p.author.name} />
        </div>
      </header>

      <div className="min-w-0">
        <h3 dir="auto" className="text-start text-[22px] font-extrabold leading-snug text-text-primary">
          {p.title}
        </h3>
        {p.excerpt && (
          <p dir="auto" className="mt-1 line-clamp-2 text-start text-[14px] leading-relaxed text-text-secondary">
            {p.excerpt}
          </p>
        )}
        {/* The first link in the words as a card (§9.4) — a sibling of the
            stretched link, so its two doors are pressable; drawn only when
            the server already holds the card, never fetched for a reader. */}
        <LinkRow text={p.excerpt} variant="compact" className="relative z-10 mt-2" />
      </div>

      {p.cover && (
        <div className="relative aspect-video overflow-hidden rounded-lg">
          <SafeImage sizes={feedCoverSizes(p.cover)} src={p.cover.url} alt="" aspect="auto" eager={eager} className="h-full w-full" bgClassName="bg-surface-selected" />
          {p.cover.kind === 'video' && (
            <span className="absolute start-3 top-3 flex size-8 items-center justify-center rounded-full bg-onyx/80 text-snow">
              <Play aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
              <span className="sr-only">{s.video}</span>
            </span>
          )}
        </div>
      )}

      {(tag || spec) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {tag && (
            <HubLink href={`/community/projects?tag=${encodeURIComponent(tag)}`} className={CHIP} data-post-tag>
              <Tag aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              <bdi className="truncate">{tag}</bdi>
            </HubLink>
          )}
          {spec &&
            (specHref ? (
              <HubLink href={specHref} className={CHIP} data-post-spec>
                {specInner}
              </HubLink>
            ) : (
              <span className={CHIP_LOOK} data-post-spec>
                {specInner}
              </span>
            ))}
        </div>
      )}

      <div className="border-t border-border-subtle">
        <Link
          to={p.url}
          aria-label={`${ps.viewProject}: ${p.title}`}
          data-post-open
          className="flex min-h-11 items-center gap-1 text-[15px] font-semibold text-gold after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none"
        >
          <span>{ps.viewProject}</span>
          <OnwardChevron className="h-4 w-4" />
        </Link>
      </div>

      <ActionRow post={p} viewer={p.viewer} mine={mine} variant="labelled" className="-mt-3 border-t border-border-subtle pt-1"
        onCounts={(counts) => onPatch?.(p.id, { counts })}
        onViewer={(viewer) => onPatch?.(p.id, { viewer })}
      />
    </article>
  );
}
