/**
 * A PROJECT IN THE GRID of /community/projects (community UI plan C2.1;
 * IMG_8485). Two columns on a phone:
 *
 *   a boxed card (`cm-card`), the photo inset 6px at 4:3 with the video and
 *     print-time badges
 *   the title (one line), the author (24px picture and the name, the link to
 *     the maker), the material with the gold cube (omitted when not given)
 *   a hairline, then the footer: the like (with its number, shown at zero),
 *     the comments count, and the save at the end
 *
 * ONE stretched link (the title); the like, the save and the author are
 * `relative z-10` siblings, never inside it, each a 44px target.
 * The ProjectCard rail (ProjectCard.tsx) is a different card and unchanged.
 */
import { Link } from 'react-router-dom';
import { Box, Clock, MessageCircle, Play } from 'lucide-react';
import SafeImage from '../../ui/SafeImage';
import { useLanguage } from '../../../LanguageContext';
import { KitAvatar } from '../kit/display';
import LikeButton from '../social/LikeButton';
import SaveButton from '../social/SaveButton';
import { commentsLabel, socialLang } from '../social/strings';
import { useHubStrings } from '../hub/strings';
import { creatorHref, type PostCard } from './api';
import { printTimeLabel, useProjectStrings } from './strings';

const BADGE = 'absolute inline-flex items-center rounded-full bg-onyx/80 text-snow';

export interface GridCardPatch {
  counts?: Partial<PostCard['counts']>;
  viewer?: { liked?: boolean; saved?: boolean };
}

export default function ProjectGridCard({ post: p, eager = false, onPatch }: { post: PostCard; eager?: boolean; onPatch?: (id: string, change: GridCardPatch) => void }) {
  const s = useProjectStrings();
  const hs = useHubStrings();
  const { lang } = useLanguage();
  const author = p.author.username ? creatorHref(p.author.username) : null;
  const material = p.material.name || p.material.product?.name || '';
  const comments = p.counts.comments;
  return (
    <article
      data-project-card={p.id}
      className="cm-card relative flex min-w-0 flex-col rounded-xl p-1.5 shadow-sm has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
    >
      <div className="relative overflow-hidden rounded-lg">
        <SafeImage
          sizes="(min-width: 1024px) 280px, (min-width: 640px) 33vw, 50vw"
          src={p.cover?.url ?? null}
          alt=""
          aspect="auto"
          eager={eager}
          className="aspect-[4/3] w-full"
          bgClassName="bg-surface-selected"
        />
        {p.cover?.kind === 'video' && (
          <span className={`${BADGE} start-2 top-2 size-6 justify-center`}>
            <Play aria-hidden="true" className="h-3 w-3 fill-current" />
            <span className="sr-only">{hs.video}</span>
          </span>
        )}
        {p.print_time_minutes ? (
          <span className={`${BADGE} bottom-2 end-2 gap-1 px-2 py-0.5 text-[11px] font-medium tabular-nums`}>
            <Clock aria-hidden="true" className="h-3 w-3" />
            {printTimeLabel(p.print_time_minutes, s)}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-1 px-1.5 pt-2">
        <h3 dir="auto" className="truncate text-start text-[16px] font-extrabold leading-snug text-text-primary">
          <Link to={p.url} className="after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none">
            {p.title}
          </Link>
        </h3>
        <p className="flex min-w-0 items-center gap-2 text-[13px] text-text-secondary">
          <KitAvatar src={p.author.avatarUrl} name={p.author.name} size={24} />
          {author ? (
            <Link to={author} className="lv-hit relative z-10 min-w-0 truncate rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <bdi>{p.author.name}</bdi>
            </Link>
          ) : (
            <bdi className="min-w-0 truncate">{p.author.name}</bdi>
          )}
        </p>
        {material && (
          <p className="flex min-w-0 items-center gap-2 text-[13px] text-text-secondary" data-project-material>
            <Box aria-hidden="true" className="h-4 w-4 shrink-0 text-gold" strokeWidth={1.75} />
            <bdi className="truncate">{material}</bdi>
          </p>
        )}
      </div>

      <div className="mx-1.5 mt-2 flex items-center border-t border-border-subtle" data-action-row={p.id}>
        <LikeButton
          postId={p.id}
          liked={!!p.viewer?.liked}
          count={p.counts.likes}
          size="sm"
          zero
          className="-ms-2"
          onChange={(liked, likes) => onPatch?.(p.id, { counts: { likes }, viewer: { liked } })}
        />
        <span className="inline-flex min-h-11 items-center gap-1 px-1 text-[12px] text-text-secondary" data-count="comments">
          <MessageCircle aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
          <span aria-hidden="true" className="font-semibold tabular-nums">
            {comments}
          </span>
          <span className="sr-only">{commentsLabel(comments, socialLang(lang))}</span>
        </span>
        <SaveButton
          postId={p.id}
          saved={!!p.viewer?.saved}
          count={p.counts.saves}
          size="sm"
          className="-me-2 ms-auto"
          onChange={(saved, saves) => onPatch?.(p.id, { counts: { saves }, viewer: { saved } })}
        />
      </div>
    </article>
  );
}

/** The card's shape while it loads: the same box and photo, so nothing jumps. */
export function ProjectGridCardSkeleton() {
  return (
    <div aria-hidden="true" className="cm-card flex min-w-0 flex-col gap-2 rounded-xl p-1.5 shadow-sm">
      <div className="aspect-[4/3] w-full animate-pulse rounded-lg bg-surface-selected motion-reduce:animate-none" />
      <div className="mx-1.5 h-3.5 w-4/5 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
      <div className="mx-1.5 h-3 w-1/2 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
      <div className="h-11" />
    </div>
  );
}
