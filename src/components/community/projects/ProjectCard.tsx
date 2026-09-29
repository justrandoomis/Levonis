/**
 * A PROJECT IN A LIST — the compact card of the rails and grids.
 *
 * One stretched link (the title's `after:` pseudo covers the card) so a card
 * is one Tab stop and a long press knows where it goes; anything pressable
 * beside it is a sibling with `relative z-10`. The photograph sits on the
 * canvas with the same corner as every community card; the facts under it
 * are the ones a maker scans a feed for — who, on what, how long.
 */
import { Link } from 'react-router-dom';
import { Clock, Heart, Play } from 'lucide-react';
import SafeImage from '../../ui/SafeImage';
import { useLanguage } from '../../../LanguageContext';
import { creatorHref, type PostCard } from './api';
import { printTimeLabel, useProjectStrings } from './strings';

export default function ProjectCard({
  post: p,
  variant = 'grid',
  eager = false,
}: {
  post: PostCard;
  /** `rail`: a fixed-width tile in a horizontal strip; `grid`: fluid. */
  variant?: 'rail' | 'grid';
  eager?: boolean;
}) {
  const { loc } = useLanguage();
  const s = useProjectStrings();
  const width = variant === 'rail' ? 'w-[148px] sm:w-[168px] shrink-0 snap-start' : 'min-w-0';
  const author = p.author.username ? creatorHref(p.author.username) : null;
  return (
    <article
      data-project-card={p.id}
      className={`group relative flex flex-col gap-2 ${width} has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus rounded-2xl`}
    >
      <div className="relative overflow-hidden rounded-2xl border border-border-subtle/60">
        <SafeImage
          src={p.cover?.url ?? null}
          alt=""
          aspect="auto"
          eager={eager}
          className="aspect-[4/5] w-full"
          bgClassName="bg-surface-selected"
          imgClassName="transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none"
        />
        {p.cover?.kind === 'video' && (
          <span aria-hidden="true" className="absolute start-2 top-2 flex size-6 items-center justify-center rounded-full bg-black/60 text-snow">
            <Play className="h-3 w-3 fill-current" />
          </span>
        )}
        {p.print_time_minutes ? (
          <span className="absolute bottom-2 end-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-snow">
            <Clock aria-hidden="true" className="h-3 w-3" />
            {printTimeLabel(p.print_time_minutes, s)}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 px-0.5">
        <h3 dir="auto" className="line-clamp-2 text-start text-[13.5px] font-semibold leading-snug text-text-primary">
          <Link to={p.url} className="after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none">
            {p.title}
          </Link>
        </h3>
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-text-muted">
          <span aria-hidden="true" className="size-4 shrink-0 overflow-hidden rounded-full bg-surface-selected">
            {p.author.avatarUrl && <img src={p.author.avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
          </span>
          {author ? (
            <Link to={author} className="relative z-10 min-w-0 truncate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded">
              <bdi>{p.author.name}</bdi>
            </Link>
          ) : (
            <bdi className="min-w-0 truncate">{p.author.name}</bdi>
          )}
          {p.counts.likes > 0 && (
            <span className="ms-auto inline-flex shrink-0 items-center gap-0.5 tabular-nums">
              <Heart aria-hidden="true" className="h-3 w-3" />
              <bdi>{p.counts.likes}</bdi>
              <span className="sr-only">{loc('إعجاب', 'likes', 'لایک')}</span>
            </span>
          )}
        </p>
      </div>
    </article>
  );
}

/** The card's shape while it loads — the same height, so nothing jumps. */
export function ProjectCardSkeleton({ variant = 'grid' }: { variant?: 'rail' | 'grid' }) {
  const width = variant === 'rail' ? 'w-[148px] sm:w-[168px] shrink-0 snap-start' : 'min-w-0';
  return (
    <div aria-hidden="true" className={`flex flex-col gap-2 ${width}`}>
      <div className="aspect-[4/5] w-full animate-pulse rounded-2xl bg-surface-selected motion-reduce:animate-none" />
      <div className="h-3.5 w-4/5 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
    </div>
  );
}
