/**
 * «لك» — THE COMMUNITY HOME (community UI plan C1; IMG_8487, IMG_8462).
 *
 * One tree for both layouts, in three parts the page places (src/pages/
 * Community.tsx): the main column, the aside and what follows them. A phone
 * reads it top to bottom: the sections and, for a merchant, the workshop
 * board (the page own, so they stay mounted while this chunk arrives), the
 * featured project, «الرائج هذا الشهر», «طلبات الطباعة», «صنّاع مميزون»
 * and Levo Studio. From `lg` the same order is a grid: the main column holds
 * the sections track, the featured project and three trending cards; the
 * aside beside it holds the requests, the makers and Studio, its top level
 * with the track. Below both: the featured stores, the community products,
 * the latest projects (the feed, mounted as it approaches), the «وسوم رائجة»
 * row, the maker tools and the colophon.
 *
 * Every section but the feed is one read of ./useHomeData.ts (trending is the
 * last 30 days, so the head says «هذا الشهر», plan R9) and hides itself when
 * its read failed or came back empty; the feed alone says when it could not
 * load. Nothing arrives later to push the first screen down: the layout is
 * decided from the one composite, and the skeleton has the cards heights.
 *
 * A lazy chunk of the page (src/pages/Community.tsx): the kit modules it uses
 * are named by that chunk, not by the entry (plan R6).
 *
 * A request row is the shared public card (requests/RequestListCard.tsx),
 * handed the public whitelist only: never a budget, a person or a request
 * picture (plan R2, R3, R10).
 */
import React, { Suspense, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useInView } from 'motion/react';
import { Box, Users } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { EmptyState } from '../../ui/AsyncStates';
import ProjectFeatureCard from '../projects/ProjectFeatureCard';
import RequestListCard, { type PublicRequestCard } from '../requests/RequestListCard';
import { SectionHead } from '../kit/display';
import { useSocial } from '../social/SocialContext';
import TrendingTags from '../search/TrendingTags';
import type { CommunityRequest } from './api';
import AsideCard from './AsideCard';
import FeaturedProject, { pickFeatured } from './FeaturedProject';
import { AsideSkeleton, MainSkeleton } from './HomeSkeleton';
import type { DoorLink } from './HubActions';
import MakerRow from './MakerRow';
import ProductTile from './ProductTile';
import StudioCard from './StudioCard';
import { PostSkeleton, Reveal } from './parts';
import { StoresRail } from './rails';
import { colophon, hubLang, useHubStrings } from './strings';
import { useHomeData } from './useHomeData';

const FeedList = React.lazy(() => import('../feed/FeedList'));

/** What a public row may carry: the whitelist, copied field by field, so no budget can ride along (plan R2). */
export function publicCard(r: CommunityRequest): PublicRequestCard {
  return {
    id: r.id,
    title: r.title,
    quantity: r.quantity,
    material: r.material,
    governorate: r.governorate,
    state: r.state,
    offer_count: r.offer_count,
    file_count: r.file_count,
    deadline: r.deadline,
    created_at: r.created_at,
    summary: r.summary ? { parts_count: r.summary.parts_count, pieces_per_set: r.summary.pieces_per_set } : null,
  };
}


/** The main column after the sections: the featured project and «الرائج هذا الشهر». */
export function HomeMain({ viewer, wide }: { viewer: string; wide: boolean }) {
  const s = useHubStrings();
  const { data } = useHomeData(viewer);
  if (!data) return <MainSkeleton wide={wide} />;
  const featured = pickFeatured(data.trending, data.works);
  const featuredId = featured.kind === 'post' ? featured.post.id : null;
  const trending = (data.trending ?? []).filter((p) => p.id !== featuredId).slice(0, wide ? 3 : 2);
  return (
    <>
      <FeaturedProject featured={featured} wide={wide} />
      {trending.length > 0 && (
        <section aria-labelledby="community-s-trending" data-community-section="trending">
          <SectionHead id="community-s-trending" title={s.trending} to="/community/projects" />
          <div className={`grid ${wide ? 'grid-cols-3 gap-4' : 'grid-cols-2 gap-3'}`}>
            {trending.map((p, i) => (
              <ProjectFeatureCard key={p.id} post={p} wide={wide} eager={i < 2} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** The aside from `lg` (after the trending cards on a phone): the requests, the makers, Levo Studio. */
export function HomeAside({ viewer, wide }: { viewer: string; wide: boolean }) {
  const s = useHubStrings();
  const social = useSocial();
  const { data } = useHomeData(viewer);
  if (!data) return <AsideSkeleton />;
  const requests = (data.requests ?? []).slice(0, 2).map(publicCard);
  const makers = (data.creators ?? []).filter((c) => !social.blocked.has(c.id)).slice(0, wide ? 3 : 2);
  return (
    <>
      {requests.length > 0 &&
        (wide ? (
          <AsideCard id="community-s-requests" title={s.printRequests} icon={<Box className="h-[22px] w-[22px]" strokeWidth={1.75} />} footer={{ to: '/requests', label: s.browseRequests }} data-community-section="requests">
            <ul className="divide-y divide-border-subtle px-3">
              {requests.map((r) => (
                <li key={r.id} className="py-1.5">
                  <RequestListCard variant="aside" request={r} />
                </li>
              ))}
            </ul>
          </AsideCard>
        ) : (
          <section aria-labelledby="community-s-requests" data-community-section="requests">
            <SectionHead id="community-s-requests" title={s.printRequests} to="/requests" />
            <ul className="flex flex-col gap-2">
              {requests.map((r) => (
                <li key={r.id}>
                  <RequestListCard variant="row" request={r} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      {makers.length > 0 &&
        (wide ? (
          <AsideCard id="community-s-creators" title={s.featuredCreators} icon={<Users className="h-[22px] w-[22px]" strokeWidth={1.75} />} data-community-section="creators">
            <ul className="divide-y divide-border-subtle pb-2">
              {makers.map((c) => (
                <MakerRow key={c.id} creator={c} wide />
              ))}
            </ul>
          </AsideCard>
        ) : (
          <section aria-labelledby="community-s-creators" data-community-section="creators">
            <SectionHead id="community-s-creators" title={s.featuredCreators} />
            <ul className="cm-card divide-y divide-border-subtle rounded-xl shadow-sm">
              {makers.map((c) => (
                <MakerRow key={c.id} creator={c} />
              ))}
            </ul>
          </section>
        ))}
      <StudioCard wide={wide} />
    </>
  );
}

/** Below the grid: the featured stores, the community products, the feed, the tags, the tools, the colophon. */
export function HomeBelow({ viewer, composerLink, tools }: { viewer: string; composerLink: DoorLink; tools: React.ReactNode }) {
  const { lang } = useLanguage();
  const s = useHubStrings();
  const { data } = useHomeData(viewer);
  if (!data) return <PostSkeleton />;
  const totals = data.totals;
  return (
    <>
      {data.merchants && data.merchants.length > 0 && (
        <Reveal labelledBy="community-s-stores" data-community-section="stores">
          <SectionHead id="community-s-stores" title={s.featuredStores} to="/community/stores" />
          <StoresRail stores={data.merchants} works={data.works} />
        </Reveal>
      )}

      {data.products && data.products.length > 0 && (
        <Reveal labelledBy="community-s-products" data-community-section="products">
          <SectionHead id="community-s-products" title={s.communityProducts} to="/community?list=products" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {data.products.map((p) => (
              <ProductTile key={p.id} product={p} />
            ))}
          </div>
        </Reveal>
      )}

      <FeedSection composerLink={composerLink} />

      <TrendingTags tags={data.tags} />

      <Reveal labelledBy="community-s-tools" data-community-section="tools">
        <SectionHead id="community-s-tools" title={s.makerTools} />
        {tools}
      </Reveal>

      {totals.projects !== null && totals.merchants !== null && (
        <p data-community-colophon className="lv-section text-center text-[12px] tabular-nums text-text-muted">
          {colophon(totals.projects, totals.merchants, hubLang(lang))}
        </p>
      )}
    </>
  );
}

/** «أحدث المشاريع» — the feed, mounted as its section approaches. */
function FeedSection({ composerLink }: { composerLink: DoorLink }) {
  const s = useHubStrings();
  const ref = useRef<HTMLDivElement | null>(null);
  const near = useInView(ref, { once: true, margin: '400px 0px' });
  return (
    <section ref={ref} aria-labelledby="community-s-feed" data-community-section="feed">
      <SectionHead id="community-s-feed" title={s.latestProjects} to="/community/projects" />
      {near ? (
        <Suspense fallback={<PostSkeleton />}>
          {/* A reading column on a wide screen: a post is not a banner. */}
          <div className="lg:max-w-2xl">
            <FeedList scope="foryou" dock={composerLink} empty={<FeedEmpty composerLink={composerLink} />} />
          </div>
        </Suspense>
      ) : (
        <PostSkeleton />
      )}
    </section>
  );
}

export function FeedEmpty({ composerLink }: { composerLink: DoorLink }) {
  const s = useHubStrings();
  return (
    <EmptyState
      title={s.feedEmpty}
      description={s.feedEmptyHint}
      action={
        <Link to={composerLink.to} state={composerLink.state} className="lv-button lv-button-primary mt-1">
          {s.shareProject}
        </Link>
      }
    />
  );
}
