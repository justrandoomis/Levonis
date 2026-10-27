/**
 * THE FEATURED PROJECT (community UI plan C1 R4 and D3 (b); IMG_8487, IMG_8462):
 * the one focal card of the home. The pick is automatic and says so: the
 * first trending project of the last 30 days whose cover is wide enough
 * (800px and more), under the kicker «مشروع رائج» (plan R9: «مميز» would claim
 * an editorial pick that does not exist, D-15).
 *
 *   phone  a split card: the photograph fills the inline end (62%), the words
 *          sit at the inline start on the raised surface, and a gradient from
 *          that surface keeps them off the raw photograph in both themes
 *   lg     the photograph fills the card and the words cover its start third
 *
 * Kicker, title, excerpt, then «material | author» with the author picture,
 * and «استكشف المشروع ‹», the one stretched link of the card.
 *
 * Fallbacks: the workshops newest work (its title and its store, the link to
 * the store), else the typeset card (the community line alone).
 *
 * It arrives with no motion: it is the page largest contentful paint.
 */
import { Link } from 'react-router-dom';
import SafeImage from '../../ui/SafeImage';
import { useLanguage } from '../../../LanguageContext';
import { coverStorySizes, mediaAspect } from '../../../../packages/contracts/src/imageSizes';
import type { PostCard } from '../projects/api';
import { ProjectMeta } from '../projects/ProjectFeatureCard';
import { OnwardChevron, kitButtonClass } from '../kit/buttons';
import type { CommunityWork } from './api';
import { HubLink } from './parts';
import { useHubStrings } from './strings';

export type Featured = { kind: 'post'; post: PostCard } | { kind: 'work'; work: CommunityWork } | { kind: 'typeset' };

/** Which project leads the home. */
export function pickFeatured(trending: PostCard[] | null, works: CommunityWork[] | null): Featured {
  const post = (trending ?? []).find((p) => p.cover && p.cover.kind === 'image' && (p.cover.width ?? 0) >= 800);
  if (post) return { kind: 'post', post };
  const work = (works ?? []).find((w) => !!w.imageUrl);
  if (work) return { kind: 'work', work };
  return { kind: 'typeset' };
}

/** The stretched call: the link whose ::after covers the card (static, so the card is its containing block). */
const CTA = `${kitButtonClass('secondary')} static mt-1 self-start whitespace-nowrap px-3 after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none`;

export default function FeaturedProject({ featured, wide }: { featured: Featured; wide: boolean }) {
  const s = useHubStrings();
  const { dir } = useLanguage();
  if (featured.kind === 'typeset') {
    return (
      <div data-community-featured="typeset" className="cm-card-raised rounded-xl bg-surface-raised px-4 py-8 shadow-lg lg:p-10">
        <p className="max-w-2xl text-balance text-[24px] font-black leading-tight text-text-primary">{s.dek}</p>
      </div>
    );
  }
  // The words stay on the surface: opaque at the inline start of the photograph, clear by the middle.
  const toEnd = dir === 'rtl' ? 'left' : 'right';
  const veil = `linear-gradient(to ${toEnd}, var(--color-surface-raised) ${wide ? '30%' : '16%'}, transparent ${wide ? '62%' : '44%'})`;
  const work = featured.kind === 'work' ? featured.work : null;
  const post = featured.kind === 'post' ? featured.post : null;
  const title = post ? post.title : work!.title;
  const photo = (
    <div className={`absolute top-1 bottom-1 end-1 overflow-hidden rounded-lg ${wide ? 'start-1' : ''}`} style={wide ? undefined : { inlineSize: '58%' }}>
      <SafeImage
        sizes={post ? coverStorySizes(mediaAspect(post.cover)) : coverStorySizes(null)}
        src={post ? (post.cover?.url ?? null) : work!.imageUrl}
        alt={title}
        aspect="auto"
        eager
        className="h-full w-full"
        bgClassName="bg-surface-selected"
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: veil }} />
    </div>
  );
  const big = wide ? 'text-4xl' : 'text-[22px]';
  return (
    <article
      data-community-featured={featured.kind}
      data-project-card={post?.id}
      className="cm-card-raised relative isolate overflow-hidden rounded-xl bg-surface-raised shadow-lg has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
      style={{ minHeight: wide ? 334 : 200 }}
    >
      {photo}
      <div className={`relative flex flex-col items-start justify-center gap-1.5 ${wide ? 'p-8' : 'p-3'}`} style={{ minHeight: wide ? 334 : 200, inlineSize: wide ? '40%' : '52%' }}>
        <p className={`font-semibold text-gold ${wide ? 'text-lg' : 'text-[12px]'}`}>{work ? s.fromWorkshops : s.trendingKicker}</p>
        <h2 dir="auto" className={`line-clamp-2 text-start font-black leading-tight text-text-primary ${big}`}>
          {title}
        </h2>
        {post?.excerpt && (
          <p dir="auto" className={`line-clamp-2 text-start text-text-secondary ${wide ? 'text-lg' : 'text-[13px]'}`}>
            {post.excerpt}
          </p>
        )}
        <ProjectMeta material={post?.material.name ?? null} name={post ? post.author.name : work!.store.name} avatar={post ? post.author.avatarUrl : work!.store.logoUrl} wide={wide} />
        {post ? (
          <Link to={post.url} className={CTA} aria-label={`${s.exploreProject}: ${post.title}`}>
            {s.exploreProject}
            <OnwardChevron className="h-4 w-4" />
          </Link>
        ) : (
          <HubLink href={work!.store.url} className={CTA} aria-label={`${s.visitStore}: ${work!.store.name}`}>
            {s.visitStore}
            <OnwardChevron className="h-4 w-4" />
          </HubLink>
        )}
      </div>
    </article>
  );
}
