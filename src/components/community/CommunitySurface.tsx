/**
 * THE COMMUNITY SCOPE ROOT (community UI plan B1; tokens.md §4).
 *
 * One element per community page root, carrying `data-surface="community"`
 * AND the current `data-theme`: the scoped tokens of src/styles/community.css
 * are written for that pair, and the clay composites resolve on every
 * `[data-theme]`, so the cards, buttons and wells inside re-resolve with the
 * reference palette. The element paints its own canvas (`.cm-surface`).
 *
 * It is stamped on the community PAGE roots, never on `CommunityGate`: the
 * gate also wraps `/community/store/:slug/p/:productSlug`, which renders the
 * storefront product page and must keep the storefront palette (plan R17).
 *
 * Portals leave the root, so the stamp travels with them: `SurfaceContext`
 * (src/components/ui/Overlay.tsx) for Overlay and Anchored (sheets, menus,
 * dialogs opened from inside), and the toast store (src/lib/toastStore.ts)
 * for the shell Toaster: the root publishes its stamp while it is mounted,
 * again on a theme switch, and withdraws it when it leaves.
 *
 * The stylesheet is imported HERE and only here, so it rides in this lazy
 * module and never reaches a storefront visitor (tests/communityScope.test.ts).
 */
import React, { useLayoutEffect, useMemo } from 'react';
import '../../styles/community.css';
import { useTheme } from '../../lib/theme';
import { publishToastSurface } from '../../lib/toastStore';
import { SurfaceContext, type SurfaceStamp } from '../ui/Overlay';

export interface CommunitySurfaceProps {
  children: React.ReactNode;
  className?: string;
}

export default function CommunitySurface({ children, className = '' }: CommunitySurfaceProps) {
  const { theme } = useTheme();
  const stamp = useMemo<SurfaceStamp>(() => ({ 'data-surface': 'community', 'data-theme': theme }), [theme]);
  useLayoutEffect(() => publishToastSurface(stamp), [stamp]);
  return (
    <SurfaceContext.Provider value={stamp}>
      <div {...stamp} className={`cm-surface bg-canvas text-text-primary ${className}`}>
        {children}
      </div>
    </SurfaceContext.Provider>
  );
}
