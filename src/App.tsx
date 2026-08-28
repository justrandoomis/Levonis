import React from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import { LanguageProvider } from './LanguageContext';
import { WalletProvider } from './WalletContext';
import { AuthProvider, useAuth } from './AuthContext';
import { Navigate } from 'react-router-dom';
import Header from './components/Header';
import BottomNav from './components/BottomNav';
import GradualBlur from './components/GradualBlur';
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
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import Community from './pages/Community';
import MerchantStore from './pages/MerchantStore';
import FollowedStores from './pages/FollowedStores';
import Chats from './pages/Chats';
import Chat from './pages/Chat';
import Tools from './pages/Tools';
import EditProfile from './pages/EditProfile';
import Settings from './pages/Settings';
import Addresses from './pages/Addresses';
import Subscription from './pages/Subscription';
import Wallet from './pages/Wallet';
import Auth from './pages/Auth';
import Rewards from './pages/Rewards';
import Games from './pages/Games';
import Leaderboards from './pages/Leaderboards';
import BrowseMissionTimer from './components/BrowseMissionTimer';
import RequireCommunityProfile from './components/auth/RequireCommunityProfile';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoaded } = useAuth();
  if (!isLoaded) return <div className="min-h-screen bg-black flex items-center justify-center text-white">Loading...</div>;
  if (!isAuthenticated) return <Navigate to="/auth" />;
  return <>{children}</>;
}

function AppContent() {
  const location = useLocation();
  const isFullScreenRoute = ['/admin', '/invest', '/admin/invest', '/auth', '/points', '/settings', '/addresses', '/checkout', '/games', '/leaderboards'].some(p => location.pathname === p || location.pathname.startsWith(p + '/'));

  if (isFullScreenRoute) {
    return (
      <div className="h-[100dvh] flex flex-col font-sans overflow-hidden bg-white dark:bg-black">
        <main className="flex-1 flex overflow-hidden">
          <Routes>
            <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="/invest" element={<ProtectedRoute><Invest /></ProtectedRoute>} />
          <Route path="/admin/invest" element={<ProtectedRoute><InvestAdmin /></ProtectedRoute>} />

            <Route path="/auth" element={<Auth />} />
            <Route path="/points" element={<ProtectedRoute><Rewards /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/addresses" element={<ProtectedRoute><Addresses /></ProtectedRoute>} />
            <Route path="/checkout" element={<ProtectedRoute><Checkout /></ProtectedRoute>} />
            <Route path="/games" element={<ProtectedRoute><Games /></ProtectedRoute>} />
            <Route path="/leaderboards" element={<ProtectedRoute><Leaderboards /></ProtectedRoute>} />
          </Routes>
        
        </main>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-black text-white font-sans overflow-hidden">
      <Header />
      <main id="main-scroll-container" className="flex-1 flex flex-col overflow-y-auto bg-gradient-to-br from-black via-black to-[#1a210e]">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="/invest" element={<ProtectedRoute><Invest /></ProtectedRoute>} />
          <Route path="/admin/invest" element={<ProtectedRoute><InvestAdmin /></ProtectedRoute>} />

          <Route path="/profile" element={<Profile />} />
            <Route path="/edit-profile" element={<ProtectedRoute><EditProfile /></ProtectedRoute>} />
          <Route path="/subscription" element={<ProtectedRoute><Subscription /></ProtectedRoute>} />
          <Route path="/wallet" element={<ProtectedRoute><Wallet /></ProtectedRoute>} />
          <Route path="/cart" element={<ProtectedRoute><Cart /></ProtectedRoute>} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/points" element={<Rewards />} />
          <Route path="/community" element={<RequireCommunityProfile><Community /></RequireCommunityProfile>} />
          <Route path="/community/store/:id" element={<MerchantStore />} />
          <Route path="/followed-stores" element={<ProtectedRoute><FollowedStores /></ProtectedRoute>} />
          <Route path="/chats" element={<ProtectedRoute><Chats /></ProtectedRoute>} />
          <Route path="/chat/:id" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
          <Route path="/product/:slug" element={<Product />} />
          <Route path="/products" element={<Products />} />
          <Route path="/bundles" element={<Bundles />} />
          <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
          <Route path="/warranty" element={<ProtectedRoute><Warranty /></ProtectedRoute>} />
          <Route path="/tools" element={<ProtectedRoute><Tools /></ProtectedRoute>} />
          <Route path="*" element={<div className="p-8 text-white text-center">Under Construction</div>} />
        </Routes>
        
        <div className="h-36 shrink-0"></div>
      </main>
      
      <GradualBlur target="page" position="bottom" height="120px" strength={2} divCount={10} curve="bezier" exponential={true} opacity={1} zIndex={10} />
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
            <AppContent />
          </Router>
        </WalletProvider>
      </LanguageProvider>
    </AuthProvider>
  );
}
