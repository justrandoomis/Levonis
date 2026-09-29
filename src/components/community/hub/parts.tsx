/**
 * Small pieces the community page's cards and sections share.
 */
import React, { useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion, useInView } from 'motion/react';
import { Store } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMotion } from '../../../lib/motion';
import { useRail } from '../../../lib/useRail';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { ArrowGlyph } from '../../home/v2/SectionHead';
import { isExternal } from './api';
import { sectionNumber, useHubStrings } from './strings';

type AnchorProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

/**
 * A REAL LINK, WHEREVER IT GOES. A shop with its own subdomain IS its own site,
 * so it opens in its own tab and leaves the directory where the visitor left
 * it (the shared cookie keeps the session across the hop) — what the directory
 * did before with `window.open` on a `<div onClick>`, which a keyboard could
 * not reach and a screen reader did not know was a link. Everything on this
 * host goes through the router.
 */
export function HubLink({ href, children, ...rest }: { href: string; children: React.ReactNode } & AnchorProps) {
  const s = useHubStrings();
  if (isExternal(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
        <span className="sr-only">{s.opensNewTab}</span>
      </a>
    );
  }
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

/** A store's logo, or a quiet store glyph when it has none. */
export function StoreMark({ src, size = 'md', className = '' }: { src?: string | null; size?: 'xs' | 'md'; className?: string }) {
  const box = size === 'xs' ? 'h-4 w-4' : 'h-12 w-12';
  return (
    <span
      aria-hidden="true"
      className={`${box} shrink-0 overflow-hidden rounded-full border border-border-subtle/60 bg-surface-selected flex items-center justify-center ${className}`}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
      ) : (
        <Store className={size === 'xs' ? 'h-2.5 w-2.5 text-text-muted' : 'h-5 w-5 text-text-muted'} />
      )}
    </span>
  );
}

/** A person's picture, or a quiet disc when they have none. */
export function Avatar({ src, className = 'h-9 w-9' }: { src?: string | null; className?: string }) {
  return (
    <span aria-hidden="true" className={`${className} block shrink-0 overflow-hidden rounded-full bg-surface-selected`}>
      {src && <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
    </span>
  );
}

// ------------------------------------------------------------ the sections

/**
 * THE HEAD OF A NUMBERED SECTION — the issue's kicker rule and number in gold,
 * the title, an optional dek, and «الكل» on the far side when there is a real
 * page to go to. The number reads in Arabic-Indic digits for the two
 * right-to-left readerships (hub/strings.ts sectionNumber).
 */
export function SectionHead({
  index,
  title,
  dek,
  to,
  linkLabel,
  id,
}: {
  index: number;
  title: string;
  dek?: string;
  to?: string;
  linkLabel?: string;
  id: string;
}) {
  const { lang } = useLanguage();
  const s = useHubStrings();
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[11px] font-semibold text-gold">
          <span aria-hidden="true" className="h-px w-4 bg-gold" />
          <span aria-hidden="true" className="tabular-nums" data-section-number>
            {sectionNumber(index, lang)}
          </span>
        </p>
        <h2 id={id} className="mt-1 text-[22px] font-black leading-tight text-text-primary">
          {title}
        </h2>
        {dek && <p className="mt-0.5 text-[12.5px] text-text-muted">{dek}</p>}
      </div>
      {to ? (
        <Link
          to={to}
          className="-me-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span>{linkLabel ?? s.all}</span>
          <ArrowGlyph />
        </Link>
      ) : null}
    </div>
  );
}

/**
 * A SECTION THAT ARRIVES ONCE — opacity and a short rise on the `ui` spring
 * the first time it comes into view; nothing on the way out, no stagger, no
 * scale. `amount: 'some'` so a section taller than the screen (the feed) still
 * counts as seen. Reduced motion collapses the travel to nothing and the
 * spring to a cross-fade (src/lib/motion.ts).
 */
export function Reveal({
  children,
  className = '',
  labelledBy,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  labelledBy: string;
} & Record<`data-${string}`, string | undefined>) {
  const ref = useRef<HTMLElement | null>(null);
  const inView = useInView(ref, { amount: 'some', once: true, margin: '0px 0px -40px 0px' });
  const m = useMotion();
  return (
    <motion.section
      ref={ref}
      aria-labelledby={labelledBy}
      initial={{ opacity: 0, y: m.travel(12) }}
      animate={inView ? { opacity: 1, y: 0 } : undefined}
      transition={m.spring('ui')}
      className={className}
      {...rest}
    >
      {children}
    </motion.section>
  );
}

/** A horizontal strip that bleeds to the screen's edges and snaps to its cards. */
export function Rail({ children, className = '', ...rest }: { children: React.ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  const rail = useRail();
  return (
    <div ref={rail.ref} className={`-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 hide-scrollbar ${className}`} {...rest}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------- skeletons

/** Mirrors StoreCard. */
export function StoreListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonGroup className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex items-start gap-3 rounded-2xl border border-border-subtle/60 bg-surface p-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-9 w-20 rounded-full" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Mirrors RequestCard. */
export function RequestListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonGroup className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="space-y-2.5 rounded-2xl border border-border-subtle/60 bg-surface p-4">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-14 rounded-full" />
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Mirrors a rail of compact ProjectCards: a 4:5 photograph and two lines. */
export function ProjectRailSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonGroup className="-mx-4 flex gap-3 overflow-hidden px-4 pb-1">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex w-[148px] shrink-0 flex-col gap-2 sm:w-[168px]">
          <Skeleton className="aspect-[4/5] w-full rounded-2xl" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Mirrors a feed PostCard: a 36 px disc, a 4:3 photograph and three lines. */
export function PostSkeleton({ count = 2 }: { count?: number }) {
  return (
    <SkeletonGroup className="divide-y divide-border-subtle/60">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="space-y-3 py-4">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          </div>
          <Skeleton className="aspect-[4/3] w-full rounded-xl" />
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Mirrors a rail of CreatorCards: a 64 px disc, a name and a pill. */
export function CreatorRailSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonGroup className="-mx-4 flex gap-3 overflow-hidden px-4 pb-1">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex w-[132px] shrink-0 flex-col items-center gap-2 rounded-2xl border border-border-subtle/60 bg-surface p-3">
          <Skeleton className="h-16 w-16 rounded-full" />
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-9 w-20 rounded-full" />
        </div>
      ))}
    </SkeletonGroup>
  );
}
