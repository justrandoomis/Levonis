/**
 * THE COVER — one photograph on the canvas: the week's first trending project
 * whose cover is wide enough (≥ 800 px), else the workshops' newest work,
 * else the typeset cover (the masthead grown large on `bg-surface`). The
 * whole thing is one link; the caption sits on the photograph over the home
 * banners' own scrim (`lv-bleed-scrim-deep`), in snow, never gold — light
 * theme gold is bronze and unreadable on a picture.
 *
 * It arrives with no motion: it is the page's largest contentful paint.
 */
import { Link } from 'react-router-dom';
import SafeImage from '../../ui/SafeImage';
import type { PostCard } from '../projects/api';
import type { CommunityWork } from './api';
import { HubLink } from './parts';
import { useHubStrings } from './strings';

export type Cover = { kind: 'post'; post: PostCard } | { kind: 'work'; work: CommunityWork } | { kind: 'typeset' };

/** Which picture heads the issue. */
export function pickCover(trending: PostCard[] | null, works: CommunityWork[] | null): Cover {
  const post = (trending ?? []).find((p) => p.cover && p.cover.kind === 'image' && (p.cover.width ?? 0) >= 800);
  if (post) return { kind: 'post', post };
  const work = (works ?? []).find((w) => !!w.imageUrl);
  if (work) return { kind: 'work', work };
  return { kind: 'typeset' };
}

const FRAME = 'group relative isolate -mx-4 block aspect-video overflow-hidden lv-bleed-ground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:mx-0 lg:aspect-[12/5] lg:rounded-2xl';

export default function CoverStory({ cover }: { cover: Cover }) {
  const s = useHubStrings();
  if (cover.kind === 'typeset') {
    return (
      <div data-community-cover="typeset" className="-mx-4 bg-surface px-4 py-8 lg:mx-0 lg:rounded-2xl lg:p-10">
        <p className="flex items-center gap-2 text-[11px] font-semibold text-gold">
          <span aria-hidden="true" className="h-px w-4 bg-gold" />
          {s.coverKicker}
        </p>
        <p className="mt-2 text-balance text-[36px] font-black leading-tight text-text-primary">{s.title}</p>
        <p className="mt-2 max-w-2xl text-balance text-[14.5px] leading-relaxed text-text-secondary">{s.dek}</p>
      </div>
    );
  }

  if (cover.kind === 'work') {
    const w = cover.work;
    return (
      <HubLink href={w.store.url} data-community-cover="work" className={FRAME}>
        <div className="absolute inset-0">
          <SafeImage src={w.imageUrl} alt={w.title} aspect="auto" eager className="h-full w-full" bgClassName="bg-surface-selected" imgClassName="transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none" />
        </div>
        <div aria-hidden="true" className="lv-bleed-scrim-deep pointer-events-none absolute inset-0" />
        <Caption kicker={s.coverKicker} title={w.title} by={w.store.name} />
      </HubLink>
    );
  }

  const p = cover.post;
  const facts = [p.author.name, p.printer.name, p.material.name].filter(Boolean);
  return (
    <Link to={p.url} data-community-cover="post" data-project-card={p.id} className={FRAME}>
      {/* The photograph in its own absolute box: SafeImage's wrapper is `relative`, so it cannot be the one taken out of flow. */}
      <div className="absolute inset-0">
        <SafeImage src={p.cover?.url ?? null} alt={p.title} aspect="auto" eager className="h-full w-full" bgClassName="bg-surface-selected" imgClassName="transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none" />
      </div>
      <div aria-hidden="true" className="lv-bleed-scrim-deep pointer-events-none absolute inset-0" />
      <Caption kicker={s.coverKicker} title={p.title} by={facts.join(' · ')} />
    </Link>
  );
}

function Caption({ kicker, title, by }: { kicker: string; title: string; by: string }) {
  return (
    <div className="relative flex h-full flex-col items-start justify-end p-4 sm:p-6 lg:max-w-[50%] lg:p-7">
      <p className="text-[11px] font-semibold text-snow/80">{kicker}</p>
      <h2 dir="auto" className="mt-1 line-clamp-2 text-start text-[22px] font-black leading-tight text-snow [text-shadow:0_1px_8px_rgb(0_0_0/0.35)] sm:text-[28px] lg:text-[32px]">
        {title}
      </h2>
      {by && (
        <p className="mt-1.5 line-clamp-1 text-[12.5px] text-snow/80">
          <bdi>{by}</bdi>
        </p>
      )}
    </div>
  );
}
