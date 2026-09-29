/**
 * «لك» — THE ISSUE. The cover, then the numbered sections in the owner's
 * order: the week's trending projects, three print requests (the ones that
 * suit a merchant's workshop when the viewer runs one), featured makers,
 * featured stores, six community products, the feed of latest projects, the
 * maker's tools, and the colophon. Every section but the feed is one read of
 * hub/useHomeData.ts and hides itself when its read failed or came back
 * empty; the feed alone says when it could not load.
 *
 * The feed is a lazy chunk (feed/FeedList.tsx), mounted when its section
 * comes within 400 px of the screen, so the first paint carries the issue
 * and not the river.
 */
import React, { Suspense, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useInView } from 'motion/react';
import { useLanguage } from '../../../LanguageContext';
import type { MerchantMe } from '../../../lib/merchant';
import { EmptyState } from '../../ui/AsyncStates';
import { Skeleton } from '../../ui/Skeleton';
import ProjectCard from '../projects/ProjectCard';
import CoverStory, { pickCover } from './CoverStory';
import ProductTile from './ProductTile';
import RequestCard from './RequestCard';
import type { DoorLink } from './QuickActions';
import { CreatorRailSkeleton, PostSkeleton, ProjectRailSkeleton, Rail, Reveal, SectionHead } from './parts';
import { CreatorsRail, StoresRail } from './rails';
import { colophon, hubLang, useHubStrings } from './strings';
import { useHomeData, type HomeData } from './useHomeData';

const FeedList = React.lazy(() => import('../feed/FeedList'));

export const NEW_PROJECT_PATH = '/community/projects/new';

export default function ForYouPanel({
  viewer,
  me,
  composerLink,
  tools,
}: {
  viewer: string;
  me: MerchantMe | null;
  composerLink: DoorLink;
  /** «أدوات الصانع» — the page's own, because the Studio anchor is pinned there. */
  tools: React.ReactNode;
}) {
  const { lang } = useLanguage();
  const s = useHubStrings();
  const { data } = useHomeData(viewer);

  if (!data) return <IssueSkeleton />;

  const cover = pickCover(data.trending, data.works);
  const sections = visibleSections(data);
  const number = (key: string) => sections.indexOf(key) + 1;
  const totals = data.totals;

  return (
    <div data-community-panel="foryou" className="flex flex-col gap-8">
      <CoverStory cover={cover} />

      {sections.includes('trending') && (
        <Reveal labelledBy="community-s-trending" data-community-section="trending">
          <SectionHead index={number('trending')} id="community-s-trending" title={s.trending} to="/community?tab=projects" />
          <Rail>
            {data.trending!.map((p, i) => (
              <ProjectCard key={p.id} post={p} variant="rail" eager={i < 2} />
            ))}
          </Rail>
        </Reveal>
      )}

      {sections.includes('requests') && (
        <Reveal labelledBy="community-s-requests" data-community-section="requests">
          <SectionHead index={number('requests')} id="community-s-requests" title={me?.store ? s.requestsForYou : s.printRequests} to="/requests" />
          <div>
            {data.requests!.map((r) => (
              <RequestCard key={r.id} request={r} compact />
            ))}
          </div>
        </Reveal>
      )}

      {sections.includes('creators') && (
        <Reveal labelledBy="community-s-creators" data-community-section="creators">
          <SectionHead index={number('creators')} id="community-s-creators" title={s.featuredCreators} to="/community?tab=creators" />
          <CreatorsRail creators={data.creators!} />
        </Reveal>
      )}

      {sections.includes('stores') && (
        <Reveal labelledBy="community-s-stores" data-community-section="stores">
          <SectionHead index={number('stores')} id="community-s-stores" title={s.featuredStores} to="/community?tab=stores" />
          <StoresRail stores={data.merchants!} works={data.works} />
        </Reveal>
      )}

      {sections.includes('products') && (
        <Reveal labelledBy="community-s-products" data-community-section="products">
          <SectionHead index={number('products')} id="community-s-products" title={s.communityProducts} to="/community?tab=foryou&list=products" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {data.products!.map((p) => (
              <ProductTile key={p.id} product={p} />
            ))}
          </div>
        </Reveal>
      )}

      <FeedSection index={number('feed')} composerLink={composerLink} />

      <Reveal labelledBy="community-s-tools" data-community-section="tools">
        <SectionHead index={number('tools')} id="community-s-tools" title={s.makerTools} />
        {tools}
      </Reveal>

      {totals.projects !== null && totals.merchants !== null && (
        <p data-community-colophon className="lv-section text-center text-[12px] tabular-nums text-text-muted">
          {colophon(totals.projects, totals.merchants, hubLang(lang))}
        </p>
      )}
    </div>
  );
}

/** The sections with something to show, in the owner's order — the numbering follows. */
function visibleSections(d: HomeData): string[] {
  const out: string[] = [];
  if (d.trending && d.trending.length > 0) out.push('trending');
  if (d.requests && d.requests.length > 0) out.push('requests');
  if (d.creators && d.creators.length > 0) out.push('creators');
  if (d.merchants && d.merchants.length > 0) out.push('stores');
  if (d.products && d.products.length > 0) out.push('products');
  out.push('feed', 'tools');
  return out;
}

/** «أحدث المشاريع» — the feed, mounted as its section approaches. */
function FeedSection({ index, composerLink }: { index: number; composerLink: DoorLink }) {
  const s = useHubStrings();
  const ref = useRef<HTMLDivElement | null>(null);
  const near = useInView(ref, { once: true, margin: '400px 0px' });
  return (
    <section ref={ref} aria-labelledby="community-s-feed" data-community-section="feed">
      <SectionHead index={index} id="community-s-feed" title={s.latestProjects} to="/community?tab=projects" />
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

/** The issue's shape while its first pages are on their way: cover, a rail, a rail, the feed. */
function IssueSkeleton() {
  return (
    <div data-community-panel="foryou" aria-busy="true" className="flex flex-col gap-8">
      <Skeleton className="-mx-4 aspect-video rounded-none lg:mx-0 lg:aspect-[12/5] lg:rounded-2xl" />
      <div>
        <Skeleton className="mb-3 h-6 w-1/2" />
        <ProjectRailSkeleton />
      </div>
      <div>
        <Skeleton className="mb-3 h-6 w-1/2" />
        <CreatorRailSkeleton />
      </div>
      <PostSkeleton />
    </div>
  );
}
