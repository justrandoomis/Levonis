import React from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import { StoreProvider, useStore } from './StoreContext';
import Storefront from './pages/Storefront';
import MerchantStart from './pages/MerchantStart';
import MerchantDashboardPage from './pages/MerchantDashboardPage';
import StorefrontProduct from './pages/StorefrontProduct';
import Requests from './pages/Requests';
import { LanguageProvider } from './LanguageContext';
import { WalletProvider } from './WalletContext';
import { AuthProvider, useAuth } from './AuthContext';
import { Navigate } from 'react-router-dom';
import Header from './components/Header';
import BottomNav, { isBottomNavHidden } from './components/BottomNav';
import Home from './pages/Home';
import Products from './pages/Products';
import Product from './pages/Product';
import Bundles from './pages/Bundles';
import Admin from './pages/Admin';
import Invest from './pages/Invest';
import InvestAdmin from './pages/InvestAdmin';

import Profile from './pages/Profile';
import Orders from './pages/Orders';
import Warranty from './pages/Warranty';
import WarrantyVerify from './pages/WarrantyVerify';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import StoreCheckout from './pages/StoreCheckout';
import Community from './pages/Community';
import CommunityStorePage from './pages/CommunityStorePage';
import FollowedStores from './pages/FollowedStores';
import SavedProducts from './pages/SavedProducts';
import Chats from './pages/Chats';
import Chat from './pages/Chat';
import Tools from './pages/Tools';
import EditProfile from './pages/EditProfile';
import Settings from './pages/Settings';
import Addresses from './pages/Addresses';
import Subscription from './pages/Subscription';
import Wallet from './pages/Wallet';
import Auth from './pages/Auth';
import Welcome from './pages/Welcome';
import CompleteProfileSheet from './components/profile/CompleteProfileSheet';
import Rewards from './pages/Rewards';
import Referrals from './pages/Referrals';
import Games from './pages/Games';
import Leaderboards from './pages/Leaderboards';
import BrowseMissionTimer from './components/BrowseMissionTimer';
import Policies from './pages/Policies';
import Support from './pages/Support';
import MyGifts from './components/reviews/MyGifts';
import EmailVerifyBanner from './components/auth/EmailVerifyBanner';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoaded } = useAuth();
  const location = useLocation();
  if (!isLoaded) return <div className="min-h-screen bg-black flex items-center justify-center text-white">Loading...</div>;
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
  if (!isLoaded) return <div className="min-h-screen bg-black flex items-center justify-center text-white">Loading...</div>;
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
      <Routes>
        <Route path="/" element={<Storefront store={store} />} />
        <Route path="/products" element={<Storefront store={store} />} />
        <Route path="/about" element={<Storefront store={store} />} />
        <Route path="/reviews" element={<Storefront store={store} />} />
        <Route path="/p/:productSlug" element={<StorefrontProduct />} />
        {/* Account, cart and checkout are the PLATFORM's, reached from the
            shop. They are deliberately not re-implemented per store: one
            cart, one checkout, one order history (§94). */}
        <Route path="/cart" element={<ProtectedRoute><Cart /></ProtectedRoute>} />
        <Route path="/checkout" element={<ProtectedRoute><Checkout /></ProtectedRoute>} />
        <Route path="/store-checkout" element={<ProtectedRoute><StoreCheckout /></ProtectedRoute>} />
        <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/admin" element={<ProtectedRoute><MerchantDashboardPage /></ProtectedRoute>} />
        <Route path="*" element={<Storefront store={store} />} />
      </Routes>
    </div>
  );
}

function AppContent() {
  const location = useLocation();
  const { store, resolved, unknownStore } = useStore();

  // Hold the first paint until the host question is answered. It is a single
  // request and it decides which application this is — rendering the main
  // site first and swapping to a storefront would flash the wrong brand at
  // someone who opened a merchant's link.
  if (!resolved) {
    return <div className="min-h-screen bg-black flex items-center justify-center text-white">Loading...</div>;
  }
  if (store || unknownStore) return <StorefrontApp />;
  // Lower-cased on BOTH sides: react-router matches a path case-insensitively,
  // so /Points reaches the router while a case-sensitive test here would send
  // it to the other <Routes> block and render a different tree for the same
  // page. Comparing the way the router does keeps the two in step.
  const pathForShell = location.pathname.toLowerCase();
  const isFullScreenRoute = ['/admin', '/invest', '/admin/invest', '/auth', '/points', '/settings', '/addresses', '/checkout', '/store-checkout', '/games', '/leaderboards', '/support'].some(p => pathForShell === p || pathForShell.startsWith(p + '/'));

  if (isFullScreenRoute) {
    return (
      <div className="h-[100dvh] flex flex-col font-sans overflow-hidden bg-white dark:bg-black">
        <main className="flex-1 flex overflow-hidden">
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
            {/* OPEN TO GUESTS. Games makes no network call and reads no user
                at all; Leaderboards already draws a guest avatar and falls
                back on every name it shows. */}
            <Route path="/games" element={<Games />} />
            <Route path="/leaderboards" element={<Leaderboards />} />
            <Route path="/support" element={<Support />} />
          </Routes>
        
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
      {/* Single intentional background: uniform LEVONIS black (matches
          html/body/#root in index.css). The previous diagonal gradient into
          olive-green (hex 1a210e) painted an unintended glow in the bottom
          corner near the nav — removed at the source, not covered up. */}
      <main id="main-scroll-container" className="flex-1 flex flex-col overflow-y-auto bg-black">
        <EmailVerifyBanner />
        {/* Asks once, on the server's schedule, never on the routes where an
            interruption costs the person something. */}
        <CompleteProfileSheet />
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
              it either.) */}
          <Route path="/community" element={<Community />} />
          {/* Resolves slug / store id / merchant id to the SAME storefront
              profile the subdomain serves; profile-only merchants from the
              pre-store era fall through to the legacy page inside. */}
          <Route path="/community/store/:id" element={<CommunityStorePage />} />
          {/* The subdomain-free way into a shop. Kept working forever so
              existing links, shared messages and search results never break
              (§57); the storefront reports its canonical subdomain URL. */}
          <Route path="/community/store/:slug/p/:productSlug" element={<StorefrontProduct />} />
          {/* The customer-request marketplace. Browsable signed out; acting
              on it needs an account, which each control handles itself. */}
          <Route path="/requests" element={<Requests />} />
          <Route path="/merchant/start" element={<ProtectedRoute><MerchantStart /></ProtectedRoute>} />
          <Route path="/merchant" element={<ProtectedRoute><MerchantDashboardPage /></ProtectedRoute>} />
          <Route path="/merchant/*" element={<ProtectedRoute><MerchantDashboardPage /></ProtectedRoute>} />
          <Route path="/followed-stores" element={<ProtectedRoute><FollowedStores /></ProtectedRoute>} />
          <Route path="/saved-items" element={<ProtectedRoute><SavedProducts /></ProtectedRoute>} />
          {/* §8 — /chats is NOT gated: the two permanent support entries (the
              automated assistant and the real ticket flow) must be reachable
              before signing in. The page itself renders an honest signed-out
              state for the private conversation list, and every /api/chats
              read is still authorised server-side. */}
          <Route path="/chats" element={<Chats />} />
          <Route path="/chat/:id" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
          <Route path="/product/:slug" element={<Product />} />
          <Route path="/products" element={<Products />} />
          <Route path="/bundles" element={<Bundles />} />
          <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
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
          <Route path="/policies" element={<Policies />} />
          <Route path="/policies/:key" element={<Policies />} />
          {/* §3.1 — referrals live on their own page, reached from the icon
              group under "My orders" in the profile (never the bottom nav). */}
          <Route path="/referrals" element={<ProtectedRoute><Referrals /></ProtectedRoute>} />
          <Route path="/gifts" element={<ProtectedRoute><div className="p-4"><MyGifts /></div></ProtectedRoute>} />
          <Route path="*" element={<div className="p-8 text-white text-center">Under Construction</div>} />
        </Routes>

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
          <Router>
            <StoreProvider>
              <AppContent />
            </StoreProvider>
          </Router>
        </WalletProvider>
      </LanguageProvider>
    </AuthProvider>
  );
}
