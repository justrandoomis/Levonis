/**
 * THE STORE'S BOTTOM DOCK — the bubble under the thumb on a community store.
 *
 * Owner, 2026-11-18: «the bubble should be on the bottom bar, not the top bar;
 * the add-to-cart button only on the bottom, stuck to the bubble; a tap on the
 * bubble goes to the supplier's home page, and 3 taps report the store».
 *
 *   - One or two taps: the store's own home (`/` on its own address,
 *     `/community/store/<slug>` on the main site). Already there: back to the top.
 *   - Three RAPID taps (the same 700 ms gap as the main bar's bloub → /support,
 *     src/components/BottomNav.tsx): the «إبلاغ» sheet for this store, the one
 *     report door every community target already uses (POST
 *     /api/community/reports, target `store`). Rapid is the whole distinction:
 *     three visits to the store's home over an afternoon must never report it.
 *   - `children` (the product page's quantity and «أضف إلى السلة») are drawn
 *     joined to the bubble in one bar — the page has no other buy bar.
 *
 * THE TAP RUN IS MODULE STATE, not component state: the first tap on a product
 * page navigates to the store's home, which mounts a different dock, and the
 * second and third taps land there. A ref would start the count again at 1.
 *
 * The bubble is the shared character's `bottom-home` anchor, so the bloub flies
 * down into it and the shell's top fallback strip (MotionCharacterFallbackHeader)
 * steps aside on its own — no second bubble at the top.
 */
import React, { Suspense, lazy, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import { MotionCharacterAnchor } from '../bloub/MotionCharacterAnchor';
import { signalBloub } from '../bloub/events';

// The sheet is code nobody downloads until the third tap.
const ReportSheet = lazy(() => import('../community/social/ReportSheet'));

import { STORE_DOCK_TAPS_FOR_REPORT, countDockTap } from './route';

export default function StoreDock({
  storeId,
  homePath,
  children,
  above,
}: {
  /** The store's id, for the report. A profile-only page (no store row) has none: no report. */
  storeId: string | null;
  /** The store's home on this host. */
  homePath: string;
  /** Drawn joined to the bubble (the product page's buy controls). */
  children?: ReactNode;
  /** A line over the bar (the product page's refusal). */
  above?: ReactNode;
}) {
  const { loc, dir } = useLanguage();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [reporting, setReporting] = useState(false);
  const atHome = pathname === homePath || pathname === `${homePath}/`;

  const onBubble = () => {
    signalBloub('tap', 210);
    if (countDockTap(Date.now()) && storeId) {
      setReporting(true);
      return;
    }
    if (atHome) {
      document.getElementById('store-host-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else navigate(homePath);
  };

  const bubble = (
    <button
      type="button"
      onClick={onBubble}
      aria-label={loc('الصفحة الرئيسية للمتجر', 'Store home') /* OWNER: Sorani to be written by hand. */}
      // OWNER: Sorani of the hint to be written by hand.
      title={loc('الصفحة الرئيسية للمتجر — ٣ ضغطات للإبلاغ', 'Store home — tap 3 times to report')}
      data-store-dock-bubble
      data-store-dock-report-taps={STORE_DOCK_TAPS_FOR_REPORT}
      className="lv-character-bottom-home relative shrink-0 rounded-xl pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <MotionCharacterAnchor kind="bottom-home" />
    </button>
  );

  return (
    <>
      <nav
        aria-label={loc('شريط المتجر', 'Store bar') /* OWNER: Sorani to be written by hand. */}
        data-store-dock
        dir={dir}
        className="fixed bottom-[max(0.625rem,env(safe-area-inset-bottom))] inset-x-0 z-[120] px-2 pointer-events-none"
      >
        {/* The page fades out under the bar instead of colliding with it — the main bar's scrim, class for class (no new CSS: the public sheet is at its 60 KB gate). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-[calc(-1*max(0.625rem,env(safe-area-inset-bottom)))] h-[calc(100%+max(0.625rem,env(safe-area-inset-bottom))+20px)] -z-10 bg-gradient-to-t from-black via-black/94 to-transparent"
        />
        {above && <div className="max-w-2xl mx-auto mb-2 pointer-events-auto">{above}</div>}
        {children ? (
          <div
            data-store-dock-buy
            className="material max-w-2xl mx-auto flex items-center gap-2 rounded-2xl border border-border-subtle p-1.5 shadow-lg pointer-events-auto"
          >
            {bubble}
            <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
          </div>
        ) : (
          <div className="flex justify-center">{bubble}</div>
        )}
      </nav>
      {storeId && reporting && (
        <Suspense fallback={null}>
          <ReportSheet open={reporting} onClose={() => setReporting(false)} target={{ type: 'store', id: storeId }} />
        </Suspense>
      )}
    </>
  );
}

export { StoreDockSpacer } from './route';

export type StoreDockProps = React.ComponentProps<typeof StoreDock>;
