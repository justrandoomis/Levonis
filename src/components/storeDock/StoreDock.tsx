/**
 * THE STORE'S BOTTOM DOCK — a cart icon under the thumb on a community store.
 *
 * Owner, 2026-11-18 (second ruling of the day): «remove the bubble from the
 * store, and add a cart icon only, which shows a slide-up page (Apple design)
 * that contains products from this store only». So:
 *
 *   - NO BLOUB on a store's own address: the character layer is not mounted
 *     there (App.tsx AppBootstrapLayer) and the shell's top strip is gone. The
 *     first ruling's bubble (one tap home, three taps report) went with it.
 *   - The icon carries the number of THIS store's units in the cart and opens
 *     StoreCartSheet — an iOS-style sheet (grabber, half / full height, the
 *     body scrolls, drag from the handle) listing this store's lines only.
 *   - `children` (the product page's quantity and «أضف إلى السلة») are drawn
 *     joined to the icon in one bar — the page has no other buy bar.
 *
 * THE COUNT is this store's, never the whole cart's (route.tsx `storeUnits`).
 * Read once per mount for a signed-in visitor, and again whenever a page says
 * the cart changed (`STORE_CART_CHANGED`, the product page's add).
 */
import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ShoppingBag } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { STORE_CART_CHANGED, storeUnits, type StoreCartRead } from './route';

// The sheet (and the merchant cart client) is code nobody downloads until the first tap.
const StoreCartSheet = lazy(() => import('./StoreCartSheet'));

export default function StoreDock({
  storeId,
  children,
  above,
}: {
  /** The store whose lines the icon counts and the sheet lists. */
  storeId: string | null;
  /** Drawn joined to the icon (the product page's buy controls). */
  children?: ReactNode;
  /** A line over the bar (the product page's refusal). */
  above?: ReactNode;
}) {
  const { loc, dir } = useLanguage();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);

  const read = useCallback(() => {
    if (!user || !storeId) {
      setCount(0);
      return;
    }
    api
      .get<StoreCartRead>('/api/cart/merchant', { mascot: 'silent' })
      .then((d) => setCount(storeUnits(d, storeId)))
      .catch(() => {});
  }, [user, storeId]);
  useEffect(read, [read]);
  useEffect(() => {
    window.addEventListener(STORE_CART_CHANGED, read);
    return () => window.removeEventListener(STORE_CART_CHANGED, read);
  }, [read]);

  const label = loc('سلة هذا المتجر', "This store's cart") /* OWNER: Sorani to be written by hand. */;
  const cartButton = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={count > 0 ? `${label} (${count})` : label}
      aria-haspopup="dialog"
      data-store-dock-cart
      className="material relative flex size-14 shrink-0 items-center justify-center rounded-full border border-border-subtle shadow-lg text-text-primary pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <ShoppingBag className="w-6 h-6" strokeWidth={1.75} aria-hidden="true" />
      {count > 0 && (
        <span
          aria-hidden="true"
          data-store-dock-count
          className="absolute -top-1.5 -end-2 min-w-[16px] h-[16px] px-1 rounded-full bg-crimson text-snow text-[10px] font-black leading-[16px] text-center tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
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
            {cartButton}
            <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
          </div>
        ) : (
          <div className="flex justify-center">{cartButton}</div>
        )}
      </nav>
      {storeId && open && (
        <Suspense fallback={null}>
          <StoreCartSheet storeId={storeId} open={open} onClose={() => setOpen(false)} onCount={setCount} />
        </Suspense>
      )}
    </>
  );
}

export { StoreDockSpacer } from './route';
