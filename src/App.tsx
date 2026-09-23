import React, { Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation, useNavigationType } from 'react-router-dom';
import { StoreProvider, useStore } from './StoreContext';
import ChunkBoundary from './components/ChunkBoundary';
/**
 * THE MERCHANT STOREFRONT IS NOT ON THE APEX'S CRITICAL PATH, AND IT WAS IN
 * THE APEX'S ENTRY BUNDLE.
 *
 * These three were static imports, so every visitor to levonis-iq.com
 * downloaded, parsed and compiled all three before `#root` could paint —
 * although the apex renders none of them. Measured by rebuilding with only
 * these three lines changed: the entry chunk goes 289,427 -> 222,398 raw and
 * 88,829 -> 71,411 bytes gzipped. That is 17,418 fewer bytes on the wire and
 * 67,029 fewer bytes the main thread parses, on every first visit.
 *
 * AND THE MERCHANT CASE SURVIVES WITHOUT A PREFETCH, which is why there is
 * none. `Storefront` IS the first paint on a merchant subdomain, so it moves
 * from the entry into a chunk of its own — 11,767 gzipped, against an entry
 * that just shed 17,418. A merchant visitor downloads LESS than before, in two
 * requests instead of one, both issued by the same document.
 *
 * All three routes already sit inside the `Suspense` boundaries below, so
 * nothing else had to change.
 */
const Storefront = React.lazy(() => import('./pages/Storefront'));
const MerchantStart = React.lazy(() => import('./pages/MerchantStart'));
const StorefrontProduct = React.lazy(() => import('./pages/StorefrontProduct'));
import UpdateReadyToast from './components/pwa/UpdateReadyToast';
/**
 * THE ONE BLOCKING WAIT, and it is mounted here for the same reason the intro
 * is: an order is placed from the platform checkout and from a merchant's own
 * subdomain, so the layer that covers that wait has to sit above both route
 * trees. It is a STATIC import, not a lazy one — a takeover that has to
 * download a chunk before it can block anything would arrive after the taps it
 * exists to swallow. It draws nothing until something takes a hold.
 */
import AppBusy from './components/ui/AppBusy';
import HostAppleIdentity from './components/pwa/HostAppleIdentity';
/**
 * SPLIT OUT ON PURPOSE. The viewer is the only screen in the application that
 * pulls in `ogl`, a WebGL renderer and a mesh parser, and it is reached from a
 * token link rather than from navigation — nobody browsing the store passes
 * through it. Loading it eagerly would put a renderer nobody asked for into the
 * first byte of every page, so it arrives when the route does.
 */
const ModelViewer = React.lazy(() => import('./pages/ModelViewer'));

/**
 * ROUTE-LEVEL CODE SPLITTING (`01-TARGET.md` §10, plan slice 1.8).
 *
 * Every page below is reached by navigating to it, and none of them is on the
 * path a visitor takes to see a product: the admin console, the merchant
 * dashboard, the wallet, both checkouts, the request marketplace, chat, the
 * warranty centre, the investor pages, the calculator, points and referrals.
 * Loading them eagerly put the whole application — recharts, the phone-number
 * library, twenty admin panels — into the first byte of the storefront.
 *
 * NO API CHANGE AND NO BEHAVIOUR CHANGE: the routes, their guards, their
 * paths and what they render are untouched; only the moment their code is
 * fetched moves. `tests/bundleBudget.test.ts` is what keeps it that way.
 */
const MerchantDashboardPage = React.lazy(() => import('./pages/MerchantDashboardPage'));
const Requests = React.lazy(() => import('./pages/Requests'));
const Admin = React.lazy(() => import('./pages/Admin'));
const Invest = React.lazy(() => import('./pages/Invest'));
const InvestAdmin = React.lazy(() => import('./pages/InvestAdmin'));
const Warranty = React.lazy(() => import('./pages/Warranty'));
const WarrantyVerify = React.lazy(() => import('./pages/WarrantyVerify'));
const Checkout = React.lazy(() => import('./pages/Checkout'));
const StoreCheckout = React.lazy(() => import('./pages/StoreCheckout'));
const Chats = React.lazy(() => import('./pages/Chats'));
const Chat = React.lazy(() => import('./pages/Chat'));
const Tools = React.lazy(() => import('./pages/Tools'));
const Wallet = React.lazy(() => import('./pages/Wallet'));
const Rewards = React.lazy(() => import('./pages/Rewards'));
const Referrals = React.lazy(() => import('./pages/Referrals'));
/**
 * THE BUNDLES SURFACE IS ITS OWN CHUNK (docs/BUNDLES_MYSTERY.md §14).
 *
 * `Bundles` was an EAGER import, so its page, its countdown, its skeletons and
 * its trilingual copy sat in the entry chunk of every first visit — including
 * for the visitors who never open it. Moving it here shrinks the entry, and
 * `BundleDetail` (which the grid links to) arrives with the route rather than
 * with the storefront. `tests/bundleBudget.test.ts` pins both chunks.
 */
const Bundles = React.lazy(() => import('./pages/Bundles'));
const BundleDetail = React.lazy(() => import('./pages/BundleDetail'));

/**
 * The one fallback every lazy route shares. It is the same markup the two
 * route guards already render while the session is loading, so a chunk arriving
 * looks exactly like a session resolving and the page never flashes a second
 * kind of "loading".
 */
const RouteFallback = () => {
  useCharacterBusy(true);
  /**
   * AND IT TAKES THE SCREEN, not just the routed rectangle.
   *
   * This element is `min-h-dvh` and covers the page content — but BottomNav,
   * the header and the back gesture render OUTSIDE every Suspense boundary
   * below and stayed live and tappable while a chunk downloaded. A customer
   * on a slow connection could therefore queue three navigations into a route
   * that had not arrived yet.
   *
   * `route` is the lowest-ranked reason on purpose (src/lib/busy.ts): an
   * order or a re-quote in flight keeps its own sentence, and a chunk that
   * lands inside BUSY_DELAY_MS paints nothing at all. This is also the one
   * place the reason is taken — it was declared, ranked and given a label in
   * all three languages while nothing in the application ever held it.
   */
  useBusy(true, 'route');
  return (
    <div className="min-h-dvh bg-black" aria-busy="true" aria-live="polite">
      <span className="sr-only">…</span>
    </div>
  );
};

// -------------------------------------------------------------- prefetching


/**
 * A LAZY ROUTE THAT CAN BE FETCHED BEFORE IT IS NEEDED.
 *
 * `React.lazy` gives a component that downloads its chunk on first render —
 * which is the moment the user is already waiting. This wraps the same loader
 * so the chunk can also be requested EARLY, from idle time, and memoises the
 * promise so asking twice costs one request.
 *
 * The result is the best half of both: nothing extra in the entry bundle, and
 * nothing to wait for at the tap.
 */
function prefetchable<P extends object>(load: () => Promise<{ default: React.ComponentType<P> }>) {
  let started: Promise<{ default: React.ComponentType<P> }> | null = null;
  const once = () => (started ??= load());
  const Comp = React.lazy(once);
  (Comp as unknown as { preload: () => void }).preload = () => {
    void once().catch(() => {
      // A prefetch that fails is not an error the customer should ever see:
      // the route will simply fetch again, and report properly, when it is
      // actually rendered. Swallowing it here also stops an unhandled
      // rejection from a flaky network becoming a console error on every load.
      started = null;
    });
  };
  return Comp;
}

const preload = (c: unknown) => (c as { preload?: () => void }).preload?.();

/**
 * WHEN THE FIRST SCREEN IS DONE, FETCH WHERE THE CUSTOMER IS GOING NEXT.
 *
 * `requestIdleCallback` is the whole point: it runs only once the browser has
 * nothing more urgent to do, so this can never compete with the first paint,
 * the font, or the home page's own data. Safari has no `requestIdleCallback`,
 * hence the timeout fallback — deliberately long, for the same reason.
 *
 * The ORDER is the journey: a visitor looks at the catalogue, opens a product,
 * adds it, then checks out. The address book comes last because it is only
 * reached from checkout.
 */
function useIdlePrefetch() {
  React.useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      for (const route of [Products, Product, Cart, Addresses]) preload(route);
    };
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (typeof w.requestIdleCallback === 'function') {
      const handle = w.requestIdleCallback(run, { timeout: 3000 });
      return () => {
        cancelled = true;
        w.cancelIdleCallback?.(handle);
      };
    }
    const t = setTimeout(run, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);
}
import { LanguageProvider } from './LanguageContext';
import { WalletProvider } from './WalletContext';
import { CurrencyProvider } from './CurrencyContext';
import { AuthProvider, useAuth } from './AuthContext';
import { Navigate } from 'react-router-dom';
import Header from './components/Header';
import BottomNav, { isBottomNavHidden } from './components/BottomNav';
import Home from './pages/Home';

/**
 * THE STOREFRONT'S OWN PAGES ARE LAZY TOO — AND PREFETCHED (see `prefetchable`).
 *
 * `Product` (2,119 lines), `Cart` (1,749) and `Addresses` (575) were EAGER
 * imports, so the product page, the cart and the address book were downloaded,
 * parsed and executed by every visitor who opened the home page and never went
 * near any of them. Together with the account surfaces below that is the bulk
 * of a 942 KB entry chunk, on a store whose customers arrive on 3G.
 *
 * LAZY ALONE WOULD BE A TRADE, NOT A WIN: it moves the cost from "everyone,
 * up front" to "you, at the moment you tap", which on a slow connection is the
 * worse half of the deal — a spinner between the product card and the product.
 * So each of these is `prefetchable`: the chunk is fetched during the browser's
 * IDLE time after the first screen has painted, long before the tap. By the
 * time a finger moves, the code is already in the HTTP cache and the navigation
 * is a synchronous render.
 *
 * `Home` stays eager. It IS the first paint; deferring it would only add a
 * round trip to the one route that can never benefit from one.
 */
const Products = prefetchable(() => import('./pages/Products'));
const Product = prefetchable(() => import('./pages/Product'));
const Cart = prefetchable(() => import('./pages/Cart'));
const Addresses = prefetchable(() => import('./pages/Addresses'));
const Auth = prefetchable(() => import('./pages/Auth'));

/**
 * The account and community surfaces. None of them is on the path from
 * arriving to buying, so none of them is prefetched either — they arrive when
 * their route does.
 */
const Profile = React.lazy(() => import('./pages/Profile'));
const Orders = React.lazy(() => import('./pages/Orders'));
const OrderDetail = React.lazy(() => import('./pages/OrderDetail'));
const Community = React.lazy(() => import('./pages/Community'));
const CommunityStorePage = React.lazy(() => import('./pages/CommunityStorePage'));
const FollowedStores = React.lazy(() => import('./pages/FollowedStores'));
const SavedProducts = React.lazy(() => import('./pages/SavedProducts'));
const StockAlerts = React.lazy(() => import('./pages/StockAlerts'));
const EditProfile = React.lazy(() => import('./pages/EditProfile'));
const Settings = React.lazy(() => import('./pages/Settings'));
const Subscription = React.lazy(() => import('./pages/Subscription'));
const Welcome = React.lazy(() => import('./pages/Welcome'));
import CompleteProfileSheet from './components/profile/CompleteProfileSheet';
/**
 * THE GAMES SURFACE IS ITS OWN CHUNK. The Printer Farm (its isometric room,
 * sheets and trilingual strings) is reached from /games, not from browsing
 * the store, so none of it belongs in the first byte of the storefront. The
 * hub, the leaderboards and the two small game pages share that chunk's
 * strings, so they load lazily too; FarmSkeleton is the eager, tiny fallback
 * that keeps the layout from jumping while the chunk arrives.
 */
const Games = React.lazy(() => import('./pages/Games'));
const Leaderboards = React.lazy(() => import('./pages/Leaderboards'));
const PrinterFarm = React.lazy(() => import('./pages/farm/PrinterFarm'));
const GameProfile = React.lazy(() => import('./pages/games/GameProfile'));
const GameRedeem = React.lazy(() => import('./pages/games/GameRedeem'));
import FarmSkeleton, { GamesPageSkeleton } from './pages/farm/FarmSkeleton';
/**
 * THE GAME IS SHELVED — «قريبا — تحت التطوير» (worker/routes/farm.ts). The
 * gate asks GET /api/farm/status and replaces a customer onto /games, where
 * the hub says why, instead of rendering a page whose every call the server
 * refuses. Eager on purpose and text-free: it wraps the lazy routes from
 * outside, so it must not drag the game's chunk into the first bundle.
 */
import { FarmGate } from './pages/farm/shelved';
// The community's maintenance gate. Eagerly imported for the same reason
// FarmGate is: it wraps lazy routes, so it must exist before they load.
import { CommunityGate } from './pages/community/access';
import BrowseMissionTimer from './components/BrowseMissionTimer';
const Policies = React.lazy(() => import('./pages/Policies'));
const Support = React.lazy(() => import('./pages/Support'));
/**
 * THE COMPARISON IS LAZY, and not optionally so.
 *
 * `/compare` is reached from a button on a product page and from the assistant
 * — never from the home page, and never on the path from arriving to buying.
 * It carries its own six components, its own trilingual dictionary and the
 * whole spec-table machinery, all for the minority of visitors who ever open
 * it. Eager here would mean every first visit downloads a comparison nobody
 * asked for; `tests/bundleBudget.test.ts` measures exactly that closure.
 */
const Compare = React.lazy(() => import('./pages/Compare'));
/**
 * THE TWO SERVICES THE HOME RAIL NAMES AND THE ROUTER DID NOT SERVE.
 *
 * «طابعات مستعملة» and «استبدل القديمة بجديدة» are cards on the services rail
 * (src/components/home/ServicesGrid.tsx) and rows in the owner's icon list
 * (worker/lib/siteMedia.ts). A card is a promise; without these two routes the
 * promise resolved to the `*` fallback — the bare «Under Construction» panel
 * at the bottom of this table, with no header, no back button and nothing in
 * the customer's own language. tests/serviceSlots.test.ts now fails the build
 * if any service slot names a path this table does not serve, so the rail and
 * the router cannot drift apart again.
 *
 * Lazy, like every other off-the-buying-path page here: both are reached from
 * a card the visitor has to swipe to and tap, never from the first paint, so
 * neither belongs in the bundle everyone downloads.
 */
const UsedPrinters = React.lazy(() => import('./pages/UsedPrinters'));
const TradeIn = React.lazy(() => import('./pages/TradeIn'));
const MyGifts = React.lazy(() => import('./components/reviews/MyGifts'));
import EmailVerifyBanner from './components/auth/EmailVerifyBanner';
/**
 * THE MASCOT PAINTS AN OVERLAY, NOT THE PAGE — so it must not be in the way of
 * the page.
 *
 * `AppIntro` and its character engine were ~31.7 KB of minified code inside
 * the entry chunk (expressions, face, travel, body, interest, anchors), all
 * downloaded, parsed and compiled before `#root` could paint — for something
 * that renders ON TOP of the shop once the shop is ready.
 *
 * Deferring it is safe in a way that deferring a route is not: the component's
 * own prop is `ready`, so it deliberately shows nothing until the page beneath
 * it has settled. The chunk therefore has the whole of that wait to arrive,
 * and `Suspense fallback={null}` is the honest fallback — the mascot's absence
 * for a few hundred milliseconds is exactly what it looks like before `ready`
 * turns true anyway.
 *
 * Measured by rebuilding with only this line changed: the entry drops a
 * further 11.5 KB gzipped.
 *
 * The ChunkBoundary above covers it: if this chunk never arrives the shop is
 * unaffected, because nothing below the mascot depends on it.
 */
const AppIntro = React.lazy(() => import('./components/bloub/AppIntro'));
import { MotionCharacterFallbackHeader, useCharacterBusy } from './components/bloub/MotionCharacterAnchor';
import { homeCriticalReadyStore } from './lib/appBootstrap';
import { useBusy } from './lib/busy';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoaded } = useAuth();
  const location = useLocation();
  if (!isLoaded) return <RouteFallback />;
  // Carry the intended destination so Auth can return the user after login.
  // Auth.tsx sanitizes it via sanitizeNextPath (same-origin relative only).
  if (!isAuthenticated) return <Navigate to="/auth" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

// UX-level gate only — every admin API call is separately authorized on the
// server, so hiding the route is presentation, not the security boundary.
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoaded } = useAuth();
  const location = useLocation();
  if (!isLoaded) return <RouteFallback />;
  if (!isAuthenticated) return <Navigate to="/auth" replace state={{ from: location.pathname + location.search }} />;
  if (!user?.isAdmin) return <Navigate to="/" />;
  return <>{children}</>;
}

/**
 * When the hostname IS a store, the whole application is that store.
 *
 * This branch sits above every other route on purpose. A merchant subdomain
 * must not render the main site's header, bottom nav or homepage with a shop
 * embedded in it — the browser stays on ali3d.levonis-iq.com and what it
 * shows is that shop (§6, §10). The shared cookie means the visitor is
 * already signed in; nothing here re-authenticates.
 */
function StorefrontApp() {
  const { store } = useStore();
  return (
    <div className="h-[100dvh] flex flex-col bg-black text-white font-sans overflow-y-auto">
      {/* iOS reads `apple-touch-icon` and `<title>` out of the live document
          instead of the per-host manifest, and index.html is one shared file —
          so without this a merchant's shop installed on an iPhone as "LEVONIS"
          with the platform mark. It draws nothing and undoes itself on the way
          out; the whole argument is in the component. */}
      <HostAppleIdentity />
      <MotionCharacterFallbackHeader />
      <ChunkBoundary>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<Storefront store={store} />} />
        <Route path="/products" element={<Storefront store={store} />} />
        <Route path="/about" element={<Storefront store={store} />} />
        <Route path="/reviews" element={<Storefront store={store} />} />
        <Route path="/p/:productSlug" element={<StorefrontProduct />} />
        <Route path="/policy" element={<Policies />} />
          <Route path="/policies" element={<Policies />} />
        <Route path="/policies/:key" element={<Policies />} />
        {/* Account, cart and checkout are the PLATFORM's, reached from the
            shop. They are deliberately not re-implemented per store: one
            cart, one checkout, one order history (§94). */}
        <Route path="/cart" element={<ProtectedRoute><Cart /></ProtectedRoute>} />
        <Route path="/checkout" element={<ProtectedRoute><Checkout /></ProtectedRoute>} />
        <Route path="/store-checkout" element={<ProtectedRoute><StoreCheckout /></ProtectedRoute>} />
        <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
        <Route path="/orders/:id" element={<ProtectedRoute><OrderDetail /></ProtectedRoute>} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/admin" element={<ProtectedRoute><MerchantDashboardPage /></ProtectedRoute>} />
        <Route path="*" element={<Storefront store={store} />} />
      </Routes>
      </Suspense>
      </ChunkBoundary>
    </div>
  );
}

/**
 * Readiness belongs to the app shell, not to a timer. On Home we wait for its
 * critical request to settle (success or an actionable error); elsewhere the
 * authenticated shell and hostname resolution are the critical work. This
 * component is a sibling of AppContent so the SAME intro node survives the
 * unresolved-host fallback becoming the real application.
 */
function AppBootstrapLayer() {
  const location = useLocation();
  const { isLoaded } = useAuth();
  const { store, resolved, unknownStore } = useStore();
  const homeReady = React.useSyncExternalStore(
    homeCriticalReadyStore.subscribe,
    homeCriticalReadyStore.snapshot,
    homeCriticalReadyStore.serverSnapshot
  );
  const mainHomeNeedsData = !store && !unknownStore && location.pathname === '/';

  /**
   * ITS OWN BOUNDARY, BECAUSE IT IS A SIBLING OF THE ROUTES AND NOT A CHILD.
   *
   * `AppBootstrapLayer` sits OUTSIDE both route trees on purpose (see the note
   * above — the same intro node has to survive the unresolved-host fallback
   * becoming the real application), so neither of their ChunkBoundaries is
   * above it. Without this one, a mascot chunk that failed to download would
   * throw with no boundary in its path and unmount the entire shop — the exact
   * white page the boundary exists to prevent, reached through the one
   * component whose absence should cost nothing.
   */
  return (
    <ChunkBoundary>
      <Suspense fallback={null}>
        <AppIntro ready={resolved && isLoaded && (!mainHomeNeedsData || homeReady)} />
      </Suspense>
    </ChunkBoundary>
  );
}

function AppContent() {
  const location = useLocation();

  /**
   * A NEW PAGE STARTS AT ITS TOP. A PAGE YOU CAME BACK TO STARTS WHERE YOU
   * LEFT IT.
   *
   * The app scrolls inside `#main-scroll-container`, not the window, and
   * nothing in the app ever reset it — so a route change kept the previous
   * page's scroll offset. Tapping the cart from halfway down a long product
   * landed on a cart that was already scrolled to its own bottom, which on a
   * page showing three skeleton rows meant landing on empty black with the
   * loading state above the fold. That is what "the loading indicator appears
   * at the very bottom" was. The one `window.scrollTo` in the codebase
   * (Policies.tsx) targets the window and has always been a no-op here.
   *
   * THE SECOND HALF OF «الرجوع للوراء». Resetting to the top on EVERY
   * navigation included `back`, so returning to the shelf you were reading put
   * you at the start of it — the other half of what reads as "the page loaded
   * again", next to the skeleton that src/lib/pageCache.ts removes. The
   * distinction is the navigation TYPE, which the router already knows: POP is
   * back or forward and wants the offset that entry had; PUSH and REPLACE are
   * a new page and want its top.
   *
   * KEYED ON `location.key`, NOT ON THE PATH. Two visits to the same list at
   * different depths are two history entries and must not share an offset, and
   * the key is what the router hands out per entry. The map is capped because
   * a long session is an unbounded number of entries.
   *
   * A hash link is the one navigation that legitimately wants an offset of its
   * own, so it is left alone.
   */
  const offsetsRef = React.useRef(new Map<string, number>());
  const navigationType = useNavigationType();
  React.useEffect(() => {
    if (location.hash) return;
    const el = document.getElementById('main-scroll-container');
    if (!el) return;
    const key = location.key;
    const target = navigationType === 'POP' ? offsetsRef.current.get(key) ?? 0 : 0;

    // TWICE, ONE FRAME APART. The restore runs after this route's first commit,
    // and on a page whose rows are still arriving the container may not yet be
    // tall enough to hold the offset — the browser clamps it and the customer
    // lands at the top anyway. One re-apply after layout covers the pages that
    // grow by a row or two; nothing loops, so a page that never gets that tall
    // simply stays where it is.
    el.scrollTo({ top: target });
    const frame = requestAnimationFrame(() => el.scrollTo({ top: target }));

    const onScroll = () => {
      const offsets = offsetsRef.current;
      offsets.set(key, el.scrollTop);
      if (offsets.size > 40) {
        // Insertion order is oldest first, so the first key is the entry the
        // customer is least likely to walk back to.
        const oldest = offsets.keys().next().value;
        if (oldest !== undefined) offsets.delete(oldest);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
    };
  }, [location.key, location.hash, navigationType]);

  const { store, resolved, unknownStore } = useStore();
  // Fetch the catalogue, the product page, the cart and the address book once
  // the browser is idle, so a tap on a product card renders synchronously.
  useIdlePrefetch();

  // Hold the first paint until the host question is answered. It is a single
  // request and it decides which application this is — rendering the main
  // site first and swapping to a storefront would flash the wrong brand at
  // someone who opened a merchant's link.
  if (!resolved) return <RouteFallback />;
  if (store || unknownStore) return <StorefrontApp />;
  // Lower-cased on BOTH sides: react-router matches a path case-insensitively,
  // so /Points reaches the router while a case-sensitive test here would send
  // it to the other <Routes> block and render a different tree for the same
  // page. Comparing the way the router does keeps the two in step.
  const pathForShell = location.pathname.toLowerCase();
  const isFullScreenRoute = ['/admin', '/invest', '/admin/invest', '/auth', '/points', '/settings', '/addresses', '/checkout', '/store-checkout', '/games', '/leaderboards', '/support', '/chat', '/model-viewer'].some(p => pathForShell === p || pathForShell.startsWith(p + '/'));

  if (isFullScreenRoute) {
    return (
      <div className="h-[100dvh] min-h-0 flex flex-col font-sans overflow-hidden bg-canvas text-text-primary">
        <MotionCharacterFallbackHeader />
        <main className="flex-1 flex overflow-hidden">
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
          <Route path="/invest" element={<ProtectedRoute><Invest /></ProtectedRoute>} />
          <Route path="/admin/invest" element={<AdminRoute><InvestAdmin /></AdminRoute>} />

            <Route path="/auth" element={<Auth />} />
            {/* OPEN TO GUESTS. The points page is how someone finds out the
                programme exists; it already skips its own fetch and shows a
                sign-in panel when there is nobody to fetch for. (The second
                <Routes> block below also declares /points unguarded, but that
                line is unreachable — /points is a full-screen route and is
                always served from here.) */}
            <Route path="/points" element={<Rewards />} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/addresses" element={<ProtectedRoute><Addresses /></ProtectedRoute>} />
            <Route path="/checkout" element={<ProtectedRoute><Checkout /></ProtectedRoute>} />
            <Route path="/store-checkout" element={<ProtectedRoute><StoreCheckout /></ProtectedRoute>} />
            {/* OPEN TO GUESTS, AND THE ONE GAMES PAGE THAT STAYS OPEN. The
                hub shows a guest an honest sign-in panel and fetches nothing
                for them. While the farm is shelved it is also where every
                other games route lands: the hub keeps LISTING the game with
                the «قريبا — تحت التطوير» notice, so a redirect here explains
                itself instead of dead-ending. It is never wrapped in FarmGate —
                that would be a loop, and the notice would have nowhere to live.
                The farm itself is a member page: every /api/farm call is
                requireAuth behind the shelving guard. */}
            <Route
              path="/games"
              element={
                <Suspense fallback={<GamesPageSkeleton />}>
                  <Games />
                </Suspense>
              }
            />
            {/* The boards are the shelved game's own standings, so they wait
                with it: «في صفحة الألعاب» covered the page, not one card. */}
            <Route
              path="/leaderboards"
              element={
                <FarmGate fallback={<GamesPageSkeleton />}>
                  <Suspense fallback={<GamesPageSkeleton />}>
                    <Leaderboards />
                  </Suspense>
                </FarmGate>
              }
            />
            {/* THE PAGE THE OWNER ASKED NOT TO SHOW. A redirect, not an
                in-page notice: «ولا تعرض الصفحة للمستخدمين» means the page is
                not shown, and an in-page state would still be the farm page,
                with its chrome and its refused calls. `replace` leaves no
                history entry, so a stale link, a bookmark and the back button
                all end at the hub, which carries the «قريبا» card. */}
            <Route
              path="/games/printer-farm"
              element={
                <ProtectedRoute>
                  <FarmGate>
                    <Suspense fallback={<FarmSkeleton />}>
                      <PrinterFarm />
                    </Suspense>
                  </FarmGate>
                </ProtectedRoute>
              }
            />
            {/* The farm profile and the conversion rules read the same
                shelved API; they follow the game rather than showing a player
                an error box. */}
            <Route
              path="/games/profile"
              element={
                <FarmGate fallback={<GamesPageSkeleton />}>
                  <Suspense fallback={<GamesPageSkeleton />}>
                    <GameProfile />
                  </Suspense>
                </FarmGate>
              }
            />
            <Route
              path="/games/redeem"
              element={
                <FarmGate fallback={<GamesPageSkeleton />}>
                  <Suspense fallback={<GamesPageSkeleton />}>
                    <GameRedeem />
                  </Suspense>
                </FarmGate>
              }
            />
            <Route path="/support" element={<Support />} />
            {/* A conversation owns the mobile viewport: its message list is
                the one scroll region and its composer stays in normal flex
                flow above the keyboard/safe area. Keeping it in the regular
                page shell used to create two scroll owners and forced a fixed
                composer to cover the last messages. */}
            <Route path="/chat/:id" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
            {/* PUBLIC BY DESIGN, AND THAT IS THE WHOLE POINT OF THE TOKEN.
                A print model belongs to the customer, so the preview is not
                gated on being signed in — it is gated on holding a token that
                was minted for one file, expires, is stored hashed, and
                resolves to a DERIVED mesh rather than to the uploaded file
                (worker/routes/printRequests.ts §7). Putting a session check
                here instead would break the one case the viewer exists for:
                a merchant weighing a job, or a customer showing somebody the
                part on another device. */}
            <Route
              path="/model-viewer/:token"
              element={
                <Suspense
                  fallback={
                    <div className="min-h-screen w-full bg-black flex items-center justify-center text-zinc-400 text-sm">
                      …
                    </div>
                  }
                >
                  <ModelViewer />
                </Suspense>
              }
            />
          </Routes>
          </Suspense>
        </main>
      </div>
    );
  }

  // The scroll container reserves exactly the space the floating BottomNav
  // occupies (its bottom offset + its height + a small visual gap), instead of
  // an oversized fixed spacer. On routes where BottomNav does not render,
  // no artificial gap is reserved. Safe-area inset mirrors BottomNav's offset.
  //
  // A REAL ELEMENT, NOT PADDING. This used to be a padding-bottom on the
  // scroll container, and a scrolling FLEX container does not honour its own
  // padding-bottom at the end of the scroll — the last content ran straight
  // under the floating nav. Measured overlap was 7-35px across /profile,
  // /referrals, /wallet and the home page. A spacer is content, and content is
  // always scrolled to.
  const navHidden = isBottomNavHidden(location.pathname);


  return (
    <div className="h-[100dvh] flex flex-col bg-black text-white font-sans overflow-hidden">
      <Header />
      {navHidden && <MotionCharacterFallbackHeader />}
      {/* Single intentional background: uniform LEVONIS black (matches
          html/body/#root in index.css). The previous diagonal gradient into
          olive-green (hex 1a210e) painted an unintended glow in the bottom
          corner near the nav — removed at the source, not covered up. */}
      <main id="main-scroll-container" className="flex-1 flex flex-col overflow-y-auto bg-black">
        <EmailVerifyBanner />
        {/* Asks once, on the server's schedule, never on the routes where an
            interruption costs the person something. */}
        <CompleteProfileSheet />
        <ChunkBoundary>
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
          <Route path="/invest" element={<ProtectedRoute><Invest /></ProtectedRoute>} />
          <Route path="/admin/invest" element={<AdminRoute><InvestAdmin /></AdminRoute>} />

          <Route path="/profile" element={<Profile />} />
            <Route path="/edit-profile" element={<ProtectedRoute><EditProfile /></ProtectedRoute>} />
          {/* OPEN TO GUESTS. What a membership costs is the first thing
              someone weighing one wants to see, and GET /api/memberships/plans
              is public. The page skips /mine when there is no user, and
              subscribing itself asks for a sign-in. */}
          <Route path="/subscription" element={<Subscription />} />
          <Route path="/wallet" element={<ProtectedRoute><Wallet /></ProtectedRoute>} />
          <Route path="/cart" element={<ProtectedRoute><Cart /></ProtectedRoute>} />
          <Route path="/auth" element={<Auth />} />
          {/* Account setup after signup. Everything on it is skippable and
              the account already works without it, so it is a normal page
              rather than a gate — it redirects home for anyone who has
              already finished or skipped it. */}
          <Route path="/welcome" element={<ProtectedRoute><Welcome /></ProtectedRoute>} />
          {/* OPEN TO GUESTS. Browsing the community needs no account at all:
              worker/routes/community.ts leaves /products, /merchants,
              /requests and /store/:id public and puts requireAuth only on the
              writes and on the personal reads. The page reads `username`
              solely as an avatar seed with a fallback, and its one write
              (POST /api/community/requests) already invites a signed-out
              visitor to sign in rather than failing.
              (It previously sat behind RequireCommunityProfile too, which
              redirected to /edit-profile whenever `username` was unset — so
              Google and Telegram accounts, which have none, could not reach
              it either.)

              IT IS NOW BEHIND CommunityGate — and the sentence above still
              holds. The gate is not a PROFILE gate: it asks the server one
              question, «is Levo Community open to me?», and a guest is as
              welcome through an open one as a signed-in customer. What it
              adds is the owner's maintenance switch and the allow-list beside
              it (worker/lib/communityGate.ts), which is enforced on the
              server; this wrapper only spares a refused visitor a page whose
              every call would answer 503. */}
          <Route path="/community" element={<CommunityGate><Community /></CommunityGate>} />
          {/* Resolves slug / store id / merchant id to the SAME storefront
              profile the subdomain serves; profile-only merchants from the
              pre-store era fall through to the legacy page inside. */}
          <Route path="/community/store/:id" element={<CommunityGate><CommunityStorePage /></CommunityGate>} />
          {/* The subdomain-free way into a shop. Kept working forever so
              existing links, shared messages and search results never break
              (§57); the storefront reports its canonical subdomain URL. */}
          <Route path="/community/store/:slug/p/:productSlug" element={<CommunityGate><StorefrontProduct /></CommunityGate>} />
          {/* The customer-request marketplace. Browsable signed out; acting
              on it needs an account, which each control handles itself. */}
          <Route path="/requests" element={<Requests />} />
          <Route path="/merchant/start" element={<ProtectedRoute><MerchantStart /></ProtectedRoute>} />
          <Route path="/merchant" element={<ProtectedRoute><MerchantDashboardPage /></ProtectedRoute>} />
          <Route path="/merchant/*" element={<ProtectedRoute><MerchantDashboardPage /></ProtectedRoute>} />
          {/* Behind the gate too: the page is a list of COMMUNITY stores and it
              reads /api/community/followed, which the wall refuses. Without
              this wrapper a refused visitor got the server's refusal rendered
              as a red error box — honest, but not what «تحت الصيانة» should
              look like. */}
          <Route path="/followed-stores" element={<ProtectedRoute><CommunityGate><FollowedStores /></CommunityGate></ProtectedRoute>} />
          <Route path="/saved-items" element={<ProtectedRoute><SavedProducts /></ProtectedRoute>} />
          {/* «تنبيهاتي» — GATED, because /api/stock-alerts is behind requireAuth
              and a signed-out visitor would otherwise reach a page whose only
              possible content is a 401. ProtectedRoute carries the intended
              path in `state.from`, so signing in lands back here rather than
              on the home page. */}
          <Route path="/stock-alerts" element={<ProtectedRoute><StockAlerts /></ProtectedRoute>} />
          {/* §8 — /chats is NOT gated: the two permanent support entries (the
              automated assistant and the real ticket flow) must be reachable
              before signing in. The page itself renders an honest signed-out
              state for the private conversation list, and every /api/chats
              read is still authorised server-side. */}
          <Route path="/chats" element={<Chats />} />
          <Route path="/product/:slug" element={<Product />} />
          <Route path="/products" element={<Products />} />
          {/* The ids live in the query, not the path, so a comparison is one
              route and one link: /compare, /compare?ids=a, /compare?ids=a,b. */}
          <Route path="/compare" element={<Compare />} />
          {/* OPEN TO GUESTS, both of them. The graded shelf is catalogue —
              exactly as public as /products — and the trade-in page is where
              someone decides whether to ask at all; putting a sign-in in front
              of "what is my old printer worth" would lose the question before
              it is asked. The trade-in FORM asks for a sign-in at the point of
              submission, because the request has to belong to an account
              somebody can answer. */}
          <Route path="/used-printers" element={<UsedPrinters />} />
          <Route path="/trade-in" element={<TradeIn />} />
          <Route path="/bundles" element={<Bundles />} />
          <Route path="/bundles/:slug" element={<BundleDetail />} />
          <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
          <Route path="/orders/:id" element={<ProtectedRoute><OrderDetail /></ProtectedRoute>} />
          <Route path="/warranty" element={<ProtectedRoute><Warranty /></ProtectedRoute>} />
          {/* PUBLIC on purpose: whoever holds the printed receipt (or the
              device) must be able to check its coverage without an account.
              The response carries the status and the product — never the
              customer. The customer's own warranty centre stays at /warranty. */}
          <Route path="/warranty/:receiptNo" element={<WarrantyVerify />} />
          {/* OPEN TO GUESTS. A self-contained calculator: it makes no network
              call and reads no user object, so there was nothing for a
              sign-in to protect. */}
          <Route path="/tools" element={<Tools />} />
          <Route path="/policy" element={<Policies />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/policies/:key" element={<Policies />} />
          {/* §3.1 — referrals live on their own page, reached from the icon
              group under "My orders" in the profile (never the bottom nav). */}
          <Route path="/referrals" element={<ProtectedRoute><Referrals /></ProtectedRoute>} />
          <Route path="/gifts" element={<ProtectedRoute><div className="p-4"><MyGifts /></div></ProtectedRoute>} />
          <Route path="*" element={<div className="p-8 text-white text-center">Under Construction</div>} />
        </Routes>
        </Suspense>
        </ChunkBoundary>

        {/* Clearance for the floating BottomNav: its bottom offset plus its
            height plus a small visual gap. `shrink-0` so a flex column cannot
            collapse it away. Nothing is reserved on routes where the nav does
            not render. */}
        {!navHidden && (
          <div
            aria-hidden="true"
            data-nav-clearance
            className="nav-clearance"
          />
        )}
      </main>

      <BottomNav />
      <BrowseMissionTimer />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
        <WalletProvider>
          {/* INSIDE WalletProvider, because the rate it converts at is that
              provider's `exchangeRate` — the administrator's own setting,
              served to every visitor by /api/settings/public. Outside the
              Router, because a reading preference is not a route. */}
          <CurrencyProvider>
          <Router>
            <StoreProvider>
              {/* THE TWO THINGS THAT MUST RENDER ON EVERY SHELL are siblings
                  of AppContent rather than children of it: the intro, for the
                  reason written above AppBootstrapLayer, and the update line,
                  because a deploy reaches the main site, the full-screen
                  routes and a merchant's own subdomain alike and this is the
                  only place all three pass through. Neither draws anything
                  until it has something to say — the toast stays empty until
                  public/sw.js reports a worker waiting, which never happens on
                  a first visit. NOTHING MAY SIT BETWEEN THE TWO TAGS BELOW:
                  tests/bloubNavigation.test.ts pins them within 100
                  characters of each other, so the character survives the
                  unresolved-host fallback becoming the real application. */}
              <AppBootstrapLayer />
              <UpdateReadyToast />
              <AppBusy />
              <AppContent />
            </StoreProvider>
          </Router>
          </CurrencyProvider>
        </WalletProvider>
      </LanguageProvider>
    </AuthProvider>
  );
}
