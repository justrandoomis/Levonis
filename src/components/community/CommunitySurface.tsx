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
 * Portals leave the root, so the pair travels with them through
 * ./scopePortals.ts: the windows and menus opened from inside the scope and
 * the shell toast stack wear it, and follow a theme switch. Nothing of this
 * is in the house primitives (ui/Overlay, ui/Toast, lib/toastStore), so a
 * storefront visit carries none of it (tests/bundleBudget.test.ts).
 *
 * The stylesheet is imported HERE and only here, so it rides in this lazy
 * module and never reaches a storefront visitor (tests/communityScope.test.ts).
 */
import React, { useLayoutEffect, useRef } from 'react';
import '../../styles/community.css';
import { useTheme } from '../../lib/theme';
import { carryScope } from './scopePortals';

export interface CommunitySurfaceProps {
  children: React.ReactNode;
  className?: string;
}

export default function CommunitySurface({ children, className = '' }: CommunitySurfaceProps) {
  const { theme } = useTheme();
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => (root.current ? carryScope(root.current) : undefined), []);
  return (
    <div ref={root} data-surface="community" data-theme={theme} className={`cm-surface bg-canvas text-text-primary ${className}`}>
      {children}
    </div>
  );
}
