/**
 * THE REWARDS AREA'S SHARED PIECES (rewards spec §2.2): the header every
 * screen wears, the states the frame draws around a screen, the per-screen
 * skeletons, and the recipes the screens build their rows from.
 *
 * - AreaHeader: back (useGoBack), the screen's h1, the compact mascot anchor
 *   (it registers the page's anchor, so the shell's fallback strip is not
 *   drawn), and an optional second row (the competitions tabs).
 * - CoinStar: the points coin's star, drawn here so nothing is imported from
 *   the /points page.
 * - StaleLine, SetupState, AreaNotFound, CompetitionNotFound, SectionGuest.
 * - RelatedDoors («المزيد في المكافآت»): fixed, titles only, no fetch.
 * - HubSkeleton … CompetitionSkeleton, at each screen's real geometry; never
 *   a fake figure. A screen draws its own while its read loads, so the bars
 *   the frame drew while the session loaded stay exactly where they were.
 * - PRESSABLE_ROW, ICON_DISC, SECTION_HEADING, GROUP_HEADING, INLINE_LINK,
 *   ForwardChevron, SectionHeading, GroupHeading, CountBadge: the recipes.
 *
 * Primitives and `lv-*` classes only: no hand-drawn button, no arbitrary
 * radius, no theme-specific colour (the clay census stays where it is).
 */
import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Coins, Gift, Hourglass, Star, Ticket, Trophy, type LucideIcon } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { EmptyState, NotFoundState, UnauthorizedState } from '../ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../ui/Skeleton';
import { MotionCharacterHome } from '../bloub/MotionCharacterAnchor';
import { formatFigure } from '../../lib/localeNumber';
import type { CopyKey } from './copy';
import type { Section } from './model';
import { useRewardsT } from './useT';

// ------------------------------------------------------------ the header

export interface AreaHeaderProps {
  /** The screen's title (the h1). */
  title: string;
  onBack: () => void;
  /** The competition's page follows its two columns at ≥ 1024 px. */
  wide?: boolean;
  /** The h1, focused on a PUSH into a screen. */
  titleRef?: React.Ref<HTMLHeadingElement>;
  /** A second row under the title: the competitions list's tabs. */
  children?: React.ReactNode;
}

export function AreaHeader({ title, onBack, wide = false, titleRef, children }: AreaHeaderProps) {
  const { t, dir } = useRewardsT();
  return (
    <header className="shrink-0 border-b border-border-subtle">
      <div className={`mx-auto flex w-full max-w-2xl ${wide ? 'lg:max-w-4xl' : ''} items-center gap-2 px-2 py-2`}>
        <IconButton
          variant="secondary"
          label={t('back')}
          icon={dir === 'rtl' ? <ArrowRight className="w-5 h-5" aria-hidden="true" /> : <ArrowLeft className="w-5 h-5" aria-hidden="true" />}
          onClick={onBack}
        />
        <h1 ref={titleRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-lg font-bold leading-6 text-text-primary focus:outline-none">
          {title}
        </h1>
        <MotionCharacterHome kind="top-header" compact />
      </div>
      {children && <div className="mx-auto w-full max-w-2xl px-2">{children}</div>}
    </header>
  );
}

// ------------------------------------------------------------ the coin

/** The four-pointed star of the points coin. Ink follows `currentColor`. */
export function CoinStar({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path fill="currentColor" d="M12 0C12 6.627 17.373 12 24 12C17.373 12 12 17.373 12 24C12 17.373 6.627 12 0 12C6.627 12 12 6.627 12 0Z" />
    </svg>
  );
}

// ------------------------------------------------------------ the states the frame draws

/** A re-read failed while older data is shown: say so, and offer to try again. */
export function StaleLine({ onRetry }: { onRetry: () => unknown }) {
  const { t } = useRewardsT();
  return (
    <div role="status" className="lv-alert lv-alert-warning flex items-center justify-between gap-3 text-[13px] text-text-primary">
      {t('stale')}
      <Button variant="ghost" size="sm" onClick={() => onRetry()}>
        {t('retry')}
      </Button>
    </div>
  );
}

/** `installed: false` (before migration 0220): coupons and competitions are being set up; points work. */
export function SetupState() {
  const { t } = useRewardsT();
  return (
    <EmptyState
      icon={<Hourglass className="w-6 h-6" aria-hidden="true" />}
      title={t('setup.title')}
      description={t('setup.body')}
      action={
        <Link to="/points" className="lv-button lv-button-secondary mt-1">
          {t('setup.points')}
        </Link>
      }
    />
  );
}

/** An address under /rewards that is none of the area's pages. */
export function AreaNotFound() {
  const { t } = useRewardsT();
  const navigate = useNavigate();
  return <NotFoundState title={t('notFound.title')} description={t('notFound.body')} onBack={() => navigate('/rewards', { replace: true })} />;
}

/** A competition id that is malformed, or that the server answered 404 for. */
export function CompetitionNotFound() {
  const { t } = useRewardsT();
  const navigate = useNavigate();
  return (
    <NotFoundState
      title={t('detail.notFound.title')}
      description={t('detail.notFound.body')}
      onBack={() => navigate('/rewards/competitions', { replace: true })}
    />
  );
}

/** The sections a guest is asked to sign in for (the hub has its own guest card). */
export type GuestSection = Exclude<Section, 'home' | 'unknown'>;

const GUEST: Readonly<Record<GuestSection, readonly [CopyKey, CopyKey]>> = {
  coupons: ['guest.coupons.title', 'guest.coupons.body'],
  shop: ['guest.shop.title', 'guest.shop.body'],
  rate: ['guest.rate.title', 'guest.rate.body'],
  competitions: ['guest.competitions.title', 'guest.competitions.body'],
  competition: ['guest.competition.title', 'guest.competition.body'],
};

/** A section's sign-in state; sign-in returns to this address (pathname + search). */
export function SectionGuest({ section }: { section: GuestSection }) {
  const { t } = useRewardsT();
  const [title, body] = GUEST[section];
  return <UnauthorizedState title={t(title)} description={t(body)} />;
}

// ------------------------------------------------------------ «المزيد في المكافآت»

/** The pages that end in RelatedDoors. */
export type RelatedSection = 'coupons' | 'competitions' | 'rate' | 'shop';

const RELATED: ReadonlyArray<{ section: RelatedSection; to: string; title: CopyKey; Icon: LucideIcon }> = [
  { section: 'coupons', to: '/rewards/coupons', title: 'title.coupons', Icon: Ticket },
  { section: 'competitions', to: '/rewards/competitions', title: 'title.competitions', Icon: Trophy },
  { section: 'rate', to: '/rewards/rate', title: 'title.rate', Icon: Star },
  { section: 'shop', to: '/rewards/shop', title: 'title.shop', Icon: Coins },
];

/** The section a page's RelatedDoors leaves out, or null for a page that has none. */
export function relatedSection(section: Section): RelatedSection | null {
  return RELATED.find((r) => r.section === section)?.section ?? null;
}

/** «كل المكافآت», then the three other sections — never the current one. Fixed height, no status, no fetch. */
export function RelatedDoors({ current }: { current: RelatedSection }) {
  const { t } = useRewardsT();
  const rows: ReadonlyArray<{ to: string; title: CopyKey; Icon: LucideIcon }> = [
    { to: '/rewards', title: 'more.all', Icon: Gift },
    ...RELATED.filter((r) => r.section !== current),
  ];
  return (
    <nav aria-labelledby="more-title">
      <h2 id="more-title" className="px-1 text-[15px] font-bold leading-6">
        {t('more.title')}
      </h2>
      <ul className="mt-2 lv-surface overflow-hidden divide-y divide-border-subtle">
        {rows.map(({ to, title, Icon }) => (
          <li key={to}>
            <Link
              to={to}
              className="flex min-h-12 items-center gap-3 px-4 py-2.5 text-[14px] font-semibold hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
            >
              <Icon className="w-5 h-5 shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t(title)}</span>
              <ForwardChevron />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ------------------------------------------------------------ skeletons (real geometry, no figures)

function Bars({ label, children }: { label: CopyKey; children: React.ReactNode }) {
  const { t } = useRewardsT();
  return (
    <SkeletonGroup label={t(label)} className="space-y-3">
      {children}
    </SkeletonGroup>
  );
}

const repeat = (n: number, className: string) => Array.from({ length: n }, (_, i) => <Skeleton key={i} className={className} />);

/** The hub: «بانتظارك», the points strip, four doors (two columns from `sm`). */
export function HubSkeleton() {
  return (
    <Bars label="loading.area">
      <Skeleton className="h-[188px] rounded-xl" />
      <Skeleton className="h-16 rounded-xl" />
      <div className="grid gap-2 sm:grid-cols-2">{repeat(4, 'h-[68px] rounded-xl')}</div>
    </Bars>
  );
}

/** «كوبوناتي»: the focal coupon and two flat ones. */
export function CouponsSkeleton() {
  return (
    <Bars label="loading.area">
      <Skeleton className="h-[248px] rounded-xl" />
      {repeat(2, 'h-[136px] rounded-xl')}
    </Bars>
  );
}

/** «استبدل نقاطك»: the balance row and two offers. */
export function ShopSkeleton() {
  return (
    <Bars label="loading.area">
      <Skeleton className="h-14 rounded-xl" />
      {repeat(2, 'h-[120px] rounded-xl')}
    </Bars>
  );
}

/** «قيّم طابعتك»: the focal printer, three rows, the how-to. */
export function RateSkeleton() {
  return (
    <Bars label="loading.area">
      <Skeleton className="h-[160px] rounded-xl" />
      {repeat(3, 'h-[72px] rounded-xl')}
      <Skeleton className="h-[180px] rounded-xl" />
    </Bars>
  );
}

/** «المسابقات»: a group heading and four rows. Inside the screen's TabPanels. */
export function CompetitionsSkeleton() {
  return (
    <Bars label="loading.list">
      <Skeleton className="h-4 w-28 rounded-xl" />
      {repeat(4, 'h-[84px] rounded-xl')}
    </Bars>
  );
}

/** A competition with no seed: the status card, three lines, a section. */
export function CompetitionSkeleton() {
  return (
    <Bars label="loading.detail">
      <Skeleton className="h-[176px] rounded-xl" />
      <Skeleton className="h-4 w-3/4 rounded-xl" />
      <Skeleton className="h-4 w-1/2 rounded-xl" />
      <Skeleton className="h-4 w-2/3 rounded-xl" />
      <Skeleton className="h-[200px] rounded-xl" />
    </Bars>
  );
}

/** The skeleton of a section's screen (nothing for an unknown address). */
export function SectionSkeleton({ section }: { section: Section }) {
  switch (section) {
    case 'home':
      return <HubSkeleton />;
    case 'coupons':
      return <CouponsSkeleton />;
    case 'shop':
      return <ShopSkeleton />;
    case 'rate':
      return <RateSkeleton />;
    case 'competitions':
      return <CompetitionsSkeleton />;
    case 'competition':
      return <CompetitionSkeleton />;
    default:
      return null;
  }
}

// ------------------------------------------------------------ the recipes

/** A pressable row or door (a Link). Holds no button height, so the census sees no hand-drawn button. */
export const PRESSABLE_ROW =
  'lv-surface flex min-h-16 items-center gap-3 p-3 hover:bg-surface-raised active:shadow-press transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

/** The 40 px disc a row's icon sits in; the lucide icon is `w-5 h-5`. */
export const ICON_DISC = 'size-10 shrink-0 rounded-full lv-well grid place-items-center text-text-secondary';

/** A section's h2. No gold icon, no scroll margin. */
export const SECTION_HEADING = 'px-1 text-[15px] font-bold leading-6 text-text-primary';

/** A list group's h2 («مفتوحة الآن 2»). */
export const GROUP_HEADING = 'px-1 text-[13px] font-bold text-text-secondary';

/** A small text link inside a line, its target grown to 44 px (`lv-hit`). */
export const INLINE_LINK =
  'relative lv-hit underline underline-offset-2 text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded';

/** The forward chevron: ‹ in Arabic and Sorani, › in English. */
export function ForwardChevron({ className = '' }: { className?: string }) {
  const { dir } = useRewardsT();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return <Chevron className={`w-4 h-4 shrink-0 text-text-muted ${className}`} aria-hidden="true" />;
}

export function SectionHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className={SECTION_HEADING}>
      {children}
    </h2>
  );
}

/** «مفتوحة الآن» and its count, the figure in the reader's digits. */
export function GroupHeading({ label, n }: { label: string; n: number }) {
  const { lang } = useRewardsT();
  return (
    <h2 className={GROUP_HEADING}>
      {label} <span className="tabular-nums text-text-muted">{formatFigure(n, lang)}</span>
    </h2>
  );
}

/** A neutral count badge, hidden from assistive tech (the same count is spelled in the row's text); nothing at 0. */
export function CountBadge({ n }: { n: number }) {
  if (!(n > 0)) return null;
  return (
    <span aria-hidden="true">
      <Badge tone="neutral">{n}</Badge>
    </span>
  );
}
