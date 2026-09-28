/**
 * Small pieces the community page's cards share.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Store } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { isExternal } from './api';

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
  const { loc } = useLanguage();
  if (isExternal(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
        {/* OWNER: Sorani to be written by hand. */}
        <span className="sr-only">{loc(' (يفتح في نافذة جديدة)', ' (opens in a new tab)')}</span>
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
      className={`${box} shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900 flex items-center justify-center ${className}`}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
      ) : (
        <Store className={size === 'xs' ? 'h-2.5 w-2.5 text-zinc-500' : 'h-5 w-5 text-zinc-500'} />
      )}
    </span>
  );
}

/** Mirrors StoreCard. */
export function StoreListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonGroup className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex items-start gap-3 rounded-2xl border border-zinc-800/60 bg-zinc-900/40 p-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-4 w-2/5" />
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
        <div key={i} aria-hidden="true" className="space-y-2.5 rounded-2xl border border-zinc-800/60 bg-zinc-900/40 p-4">
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
