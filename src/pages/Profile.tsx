import React, { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../LanguageContext';
import { tierLabel } from '../components/subscription/tierMeta';
import { useNavigate } from 'react-router-dom';
import {
  Headset, Settings, MapPin, QrCode, Store,
  Wallet, Package, Truck, MessageSquare, RefreshCcw,
  Star, Clock, Heart, Gamepad2, Coins, Zap, Shield,
  ChevronRight, ChevronLeft, Gift, UserRound, UserPlus
} from 'lucide-react';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { api, ApiProduct, ApiOrder, usdCentsToIqd, formatIqd } from '../lib/api';
import ProfileIconGrid, { ProfileIconAction } from '../components/profile/ProfileIconGrid';
import GuestCard from '../components/profile/GuestCard';
import MyReviewsTab from '../components/profile/MyReviewsTab';
import QrCodeModal from '../components/profile/QrCodeModal';

interface FavoriteItem {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  image: string;
  price_iqd: number;
}

interface ReferralReward {
  id: string;
  campaign: 'printer' | 'pro_sub';
  state: 'pending' | 'qualified' | 'available' | 'reserved' | 'fulfilled' | 'cancelled' | string;
  eligible_at: string | null;
  created_at: string;
}

interface MembershipMine {
  status: {
    tier: 'free' | 'plus' | 'pro' | 'prime';
    active: boolean;
    expires_at: string | null;
    pending_launch: { tier: 'plus' | 'pro'; duration_months: number } | null;
  };
  referral: { code: string; rewards: ReferralReward[] };
  launch: { launch_at: string | null; activated: boolean };
}

/**
 * The subset of a `/api/bundles` card this shelf reads. The full card is
 * documented in docs/BUNDLES_MYSTERY.md §10; a LOCKED one is the §9 allow-list
 * and carries no `display_price_iqd` at all.
 */
interface BundleShelfCard {
  id: string;
  product_slug?: string;
  name: string;
  image: string;
  locked?: boolean;
  display_price_iqd?: number | null;
  display_regular_iqd?: number | null;
}

/** The price to show, or null — never a rendered 0, which is what reading a
 *  field the payload no longer carries produces. */
const bundleShelfPrice = (b: BundleShelfCard): number | null => {
  const price = b.display_price_iqd ?? b.display_regular_iqd;
  return typeof price === 'number' && price > 0 ? price : null;
};

export default function Profile() {
  const [suggestedProducts, setSuggestedProducts] = useState<ApiProduct[]>([]);
  // Bundle cards from /api/bundles. The card shape changed with the
  // composition model (docs/BUNDLES_MYSTERY.md §10): the listing is light on
  // purpose and carries the `display_*` price block, `product_slug` and a
  // coarse state — never a `total_display_iqd` and never the component list.
  // A LOCKED card carries only `display_regular_iqd`, and only when the offer
  // allows a teaser, so the price is optional here and is not rendered as 0.
  const [bundles, setBundles] = useState<BundleShelfCard[]>([]);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [favoritesLoaded, setFavoritesLoaded] = useState(false);
  const [orderCounts, setOrderCounts] = useState<Record<string, number>>({});
  const [latestOrder, setLatestOrder] = useState<ApiOrder | null>(null);
  const [activeTab, setActiveTab] = useState('suggested');
  const [scrolled, setScrolled] = useState(false);
  const [mine, setMine] = useState<MembershipMine | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const { t, dir, lang, loc } = useLanguage();
  const navigate = useNavigate();
  const { balanceUsdCents, pointBalance, exchangeRate } = useWallet();
  const { isAuthenticated, user, isLoaded } = useAuth();

  const now = Date.now();
  const planActive =
    !!user &&
    user.membership_tier !== 'free' &&
    (user.subscription_expiry === 0 || user.subscription_expiry > now);

  /**
   * Auth-aware navigation: a signed-out tap on a member-only destination
   * goes to /auth with the destination preserved (?next=), so the user
   * lands on the feature they asked for after signing in. Auth.tsx
   * sanitizes the value (components/auth/nextPath.ts).
   */
  const go = (path: string) => {
    if (isAuthenticated) navigate(path);
    else navigate(`/auth?next=${encodeURIComponent(path)}`);
  };

  useEffect(() => {
    api
      .get<{ products: ApiProduct[] }>('/api/products?limit=6')
      .then((res) => setSuggestedProducts(res.products || []))
      .catch(() => setSuggestedProducts([]));

    const handleScroll = () => {
      const mainContainer = document.getElementById('main-scroll-container');
      if (mainContainer) {
        setScrolled(mainContainer.scrollTop > 40);
      } else {
        setScrolled(window.scrollY > 40);
      }
    };

    // Check initial scroll position
    setTimeout(handleScroll, 100);

    const container = document.getElementById('main-scroll-container');
    if (container) {
      container.addEventListener('scroll', handleScroll, { passive: true });
      return () => container.removeEventListener('scroll', handleScroll);
    } else {
      window.addEventListener('scroll', handleScroll, { passive: true });
      return () => window.removeEventListener('scroll', handleScroll);
    }
  }, []);

  useEffect(() => {
    // Any active paid tier sees bundles now (PLUS/PRIME/PRO) — the server
    // route re-checks the entitlement, this only skips a pointless call.
    if (!planActive) { setBundles([]); return; }
    api
      .get<{ entitled: boolean; bundles: BundleShelfCard[] }>('/api/bundles')
      .then((res) => setBundles(res.entitled ? (res.bundles || []).slice(0, 4) : []))
      .catch(() => setBundles([]));
  }, [planActive]);

  useEffect(() => {
    if (!isAuthenticated) {
      setOrderCounts({});
      setLatestOrder(null);
      setFavorites([]);
      setFavoritesLoaded(true);
      return;
    }
    setFavoritesLoaded(false);
    api
      .get<{ counts: Record<string, number> }>('/api/orders/counts')
      .then((res) => setOrderCounts(res.counts || {}))
      .catch(() => setOrderCounts({}));
    api
      .get<{ orders: ApiOrder[] }>('/api/orders')
      .then((res) => setLatestOrder(res.orders?.[0] || null))
      .catch(() => setLatestOrder(null));
    api
      .get<{ favorites: FavoriteItem[] }>('/api/profile/favorites')
      .then((res) => setFavorites(res.favorites || []))
      .catch(() => setFavorites([]))
      .finally(() => setFavoritesLoaded(true));
  }, [isAuthenticated, user?.id]);

  // Real membership + referral state from the memberships ledger.
  useEffect(() => {
    if (!isAuthenticated) {
      setMine(null);
      return;
    }
    api
      .get<MembershipMine>('/api/memberships/mine')
      .then((res) => setMine(res))
      .catch(() => setMine(null))
      .catch(() => {});
  }, [isAuthenticated, user?.id]);

  // Membership from the ledger (authoritative once loaded); the legacy
  // users.* cache is only a fallback while /api/memberships/mine loads.
  const memTier: 'free' | 'plus' | 'pro' | 'prime' = mine
    ? (mine.status.active ? mine.status.tier : 'free')
    : (planActive ? (user?.membership_tier ?? 'free') : 'free');
  const memExpiry: string | null = mine
    ? mine.status.expires_at
    : (planActive && user?.subscription_expiry ? new Date(user.subscription_expiry).toISOString() : null);
  const memPendingLaunch = mine?.status.pending_launch ?? null;

  const dateLocale = lang === 'ar' ? 'ar-IQ' : lang === 'ckb' ? 'ckb' : 'en-GB';
  const fmtDate = (iso: string | null | undefined) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return d.toLocaleDateString('en-GB');
    }
  };

  const referralLink = mine?.referral?.code
    ? `${window.location.origin}/auth?ref=${mine.referral.code}`
    : '';

  const balanceIqd = usdCentsToIqd(balanceUsdCents, exchangeRate);
  // Fabricating an avatar for a guest would suggest a signed-in identity —
  // guests get a neutral placeholder icon instead.
  const avatarUrl = isAuthenticated
    ? (user?.avatar_key
        ? `/files/${user.avatar_key}`
        : `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.username || 'Levonis'}&backgroundColor=fde047`)
    : '';

  const displayName = isAuthenticated
    ? (user?.username || user?.name || user?.email || '')
    : loc('زائر', 'Guest', 'میوان');

  const orderStatusLabel = (status: ApiOrder['status']) => {
    const labels: Record<ApiOrder['status'], string> = {
      pending: loc('بانتظار الدفع', 'Pending payment', 'چاوەڕێی پارەدان'),
      confirmed: loc('بانتظار الشحن', 'To ship', 'چاوەڕێی ناردن'),
      processing: loc('بانتظار الشحن', 'To ship', 'چاوەڕێی ناردن'),
      shipped: loc('مشحونة', 'Shipped', 'نێردراوە'),
      delivered: loc('تم التوصيل', 'Delivered', 'گەیەنراوە'),
      cancelled: loc('ملغية', 'Cancelled', 'هەڵوەشێنراوەتەوە'),
    };
    return labels[status];
  };

  /**
   * Header utility actions. Customer service opens the REAL support
   * assistant page (/support — public, no duplicate chat creation); the
   * previous target was a hardcoded dead chat route (/chat/2). Addresses
   * and settings are member features: a guest is routed through /auth with
   * the destination preserved.
   */
  const iconActions: ProfileIconAction[] = [
    {
      key: 'address',
      icon: MapPin,
      label: loc('العنوان', 'Address', 'ناونیشان'),
      onClick: () => go('/addresses'),
    },
    {
      key: 'support',
      icon: Headset,
      label: loc('خدمة العملاء', 'Customer service', 'خزمەتگوزاری کڕیاران'),
      onClick: () => navigate('/support'),
    },
    {
      key: 'settings',
      icon: Settings,
      label: loc('الاعدادات', 'Settings', 'ڕێکخستنەکان'),
      onClick: () => go('/settings'),
    },
  ];

  const showFavoritesTab = () => {
    setActiveTab('collection');
    // Bring the tab strip into view so the tap has a visible effect.
    setTimeout(() => tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  /**
   * Order-status chips. Every status value here is one Orders.tsx actually
   * applies: single server statuses (pending / shipped) pass through
   * GET /api/orders?status=…; 'to_ship' merges confirmed+processing and
   * 'review' / 'returns' open the delivered list (reviews and the 7-day
   * ReturnsSection both live on delivered orders). The returns chip shows
   * NO count — there is no returns-count endpoint, and the previous badge
   * (cancelled orders) was wrong data.
   */
  const orderChips = [
    { key: 'pending', icon: Wallet, label: loc('بانتظار الدفع', 'Pending payment', 'چاوەڕێی پارەدان'), badge: orderCounts.pending || 0, status: 'pending' },
    { key: 'to_ship', icon: Package, label: loc('بانتظار الشحن', 'To ship', 'چاوەڕێی ناردن'), badge: (orderCounts.confirmed || 0) + (orderCounts.processing || 0), status: 'to_ship' },
    { key: 'shipped', icon: Truck, label: loc('مشحونة', 'Shipped', 'نێردراوە'), badge: orderCounts.shipped || 0, status: 'shipped' },
    { key: 'review', icon: MessageSquare, label: loc('المراجعة', 'To review', 'پێداچوونەوە'), badge: orderCounts.delivered || 0, status: 'review' },
    { key: 'returns', icon: RefreshCcw, label: loc('الاسترجاع', 'Returns', 'گەڕاندنەوە'), badge: 0, status: 'returns' },
  ];

  if (!isLoaded) {
    return (
      <div className="w-full bg-[#f2f2f2] dark:bg-[#111] min-h-screen flex items-center justify-center" role="status" aria-busy="true">
        <div className="w-7 h-7 border-2 border-[#BAA369]/20 border-t-[#BAA369] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="w-full bg-[#f2f2f2] dark:bg-[#111] min-h-screen font-sans pb-[80px] text-[#333] dark:text-[#ddd] relative">

      {/* Top Background Gradient */}
      <div className="absolute top-0 left-0 right-0 h-[240px] bg-gradient-to-b from-[#ffe3cc] via-[#ffebd9] to-[#f2f2f2] dark:from-[#2a1a10] dark:via-[#1a0f08] dark:to-[#111] z-0 pointer-events-none"></div>

      {/* Sticky Header */}
      <div className={`fixed top-0 left-0 right-0 z-[110] transition-all duration-300 flex items-center justify-between ${scrolled ? 'bg-[#ffe3cc] dark:bg-[#2a1a10] shadow-md py-1 px-3 opacity-100 pointer-events-auto' : 'bg-transparent py-3 px-3 opacity-0 pointer-events-none'}`}>
        <div className="flex items-center gap-2 min-w-0">
           <div className="w-7 h-7 rounded-full bg-white overflow-hidden border border-black/10 shrink-0 flex items-center justify-center">
             {avatarUrl ? (
               <img referrerPolicy="no-referrer" src={avatarUrl} alt="" className="w-full h-full object-cover" />
             ) : (
               <UserRound className="w-4 h-4 text-zinc-500" aria-hidden="true" />
             )}
           </div>
           <span className="font-bold text-[13px] truncate max-w-[100px] text-black dark:text-white">{displayName}</span>
        </div>
        <ProfileIconGrid items={iconActions} compact />
      </div>

      <div className="max-w-3xl mx-auto px-3 relative z-10 pt-4">

        {/* User Info Header (In Flow) */}
        <div className="flex items-start justify-between mb-4 gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-[64px] h-[64px] rounded-full bg-[#fce5a1] border border-white/50 flex items-center justify-center overflow-hidden shrink-0 shadow-sm relative">
              {avatarUrl ? (
                <img referrerPolicy="no-referrer" src={avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <UserRound className="w-8 h-8 text-zinc-500" aria-hidden="true" />
              )}
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-0.5 mb-1.5">
                <h1 className="font-bold text-[17px] leading-tight text-black dark:text-white truncate">{displayName}</h1>
                {isAuthenticated && (
                  <button
                    type="button"
                    onClick={() => setQrOpen(true)}
                    aria-label={loc('عرض رمز QR للدعوة', 'Show invite QR code', 'پیشاندانی کۆدی QR بانگهێشت')}
                    className="w-11 h-11 -my-2 flex items-center justify-center rounded-full text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-transform shrink-0"
                  >
                    <QrCode className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {!isAuthenticated ? (
                  /* Honest guest badge — never a member chip for a guest. */
                  <span className="bg-white/50 dark:bg-black/30 text-[10px] px-1.5 py-0.5 rounded-[4px] font-bold shadow-sm text-black dark:text-white">
                    {loc('زائر', 'Guest', 'میوان')}
                  </span>
                ) : (
                  <>
                    {memTier !== 'free' ? (
                      <button type="button" onClick={() => navigate('/subscription')} className="bg-[#ebd197] text-[#5c3e03] text-[10px] px-1.5 py-1 rounded-[4px] flex items-center gap-1 font-bold shadow-sm hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-opacity">
                        <span>{loc(`عضو ${tierLabel(memTier)}`, `${tierLabel(memTier)} Member`, `ئەندامی ${tierLabel(memTier)}`)}</span>
                        {memExpiry && (
                          <span className="font-medium opacity-80">· {loc('حتى', 'until', 'تا')} {fmtDate(memExpiry)}</span>
                        )}
                      </button>
                    ) : (
                      <button type="button" onClick={() => navigate('/subscription')} className="bg-white/50 dark:bg-black/30 text-[10px] px-1.5 py-1 rounded-[4px] flex items-center gap-0.5 font-bold shadow-sm text-black dark:text-white hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-opacity">
                        <span>{loc('عضو', 'Member', 'ئەندام')}</span>
                      </button>
                    )}
                    {memPendingLaunch && (
                      <button type="button" onClick={() => navigate('/subscription')} className="bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 text-[10px] px-1.5 py-1 rounded-[4px] flex items-center gap-0.5 font-bold shadow-sm hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-opacity">
                        <span>{tierLabel(memPendingLaunch.tier) + ' — ' + t('pendingLaunch')}</span>
                      </button>
                    )}
                    <button type="button" onClick={() => navigate('/followed-stores')} className="bg-white/50 dark:bg-black/30 backdrop-blur-sm text-[10px] px-1.5 py-1 rounded-[4px] flex items-center gap-1 font-medium shadow-sm text-black dark:text-white hover:bg-white/70 dark:hover:bg-black/50 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-colors">
                      <Store className="w-[10px] h-[10px]" strokeWidth={2} aria-hidden="true" />
                      {loc('المتاجر التي يتابعها', 'Followed Stores', 'فرۆشگا شوێنکەوتووەکان')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Utility icons — aligned grid (fixed icon box + clamped 2-line labels) */}
          <div className={`mt-1 transition-opacity duration-300 shrink-0 ${scrolled ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
            <ProfileIconGrid items={iconActions} />
          </div>
        </div>

        {/* Guest: honest signed-out card, no member fabrications below. */}
        {!isAuthenticated && <GuestCard />}

        {/* First Card: Membership Center — members only (real ledger data). */}
        {isAuthenticated && (
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm">
          {/* Top section of the card */}
          <div className="flex justify-between items-center mb-3 pb-3 border-b border-black/5 dark:border-white/5 overflow-hidden">
            <button type="button" className="flex items-center gap-1 shrink-0 min-h-[44px] rounded-lg px-1 -mx-1 hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]" onClick={() => navigate('/subscription')}>
              <span className="font-bold text-[10px] text-black dark:text-white whitespace-nowrap">
                {loc('الخطة الحالية', 'Current plan', 'پلانی ئێستا')}
              </span>
              <span className="font-bold text-[10px] text-black dark:text-white whitespace-nowrap uppercase">
                {memTier !== 'free' ? memTier : loc('مجاني', 'Free', 'بێبەرامبەر')}
              </span>
              {memTier !== 'free' && memExpiry && (
                <span className="text-[9px] text-zinc-500 whitespace-nowrap">
                  {loc('حتى', 'until', 'تا')} {fmtDate(memExpiry)}
                </span>
              )}
              {dir === 'rtl' ? <ChevronLeft className="w-3 h-3 text-zinc-400 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" aria-hidden="true" />}
            </button>
            <div className="flex gap-2 shrink-0">
              <button type="button" onClick={() => navigate('/subscription')} className="flex flex-col items-center justify-center relative rtl:pl-2 ltr:pr-2 min-h-[44px] after:content-[''] after:absolute rtl:after:left-0 ltr:after:right-0 after:top-1/2 after:-translate-y-1/2 after:w-[1px] after:h-4 after:bg-zinc-200 dark:after:bg-zinc-700 hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded-lg">
                <span className="text-[#ff5000] font-bold text-[9px] whitespace-nowrap">{loc('مركز الأعضاء', 'Member Center', 'ناوەندی ئەندامان')}</span>
                <span className="text-[8px] text-zinc-500 whitespace-nowrap">{loc('استكشف المزايا', 'Explore benefits', 'سوودەکان ببینە')}</span>
              </button>
              <button type="button" onClick={() => navigate('/points')} className="flex flex-col items-center justify-center shrink-0 min-h-[44px] hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded-lg px-1">
                <span className="text-[#ff5000] font-bold text-[9px] whitespace-nowrap">{loc('المكافآت', 'Rewards', 'خەڵاتەکان')}</span>
                <span className="text-[8px] text-zinc-500 whitespace-nowrap">{loc('اكسب النقاط', 'Earn points', 'خاڵ بەدەست بهێنە')}</span>
              </button>
            </div>
          </div>

          {/* Middle row: Stats — REAL wallet/points values; the protection
              cell opens the warranty center (linked printers, coverage, claims). */}
          <div className="grid grid-cols-3 mb-3 text-black dark:text-white">
            <button type="button" className="flex flex-col items-center justify-center min-h-[48px] border-e border-zinc-200 dark:border-zinc-700 hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded-s-lg" onClick={() => navigate('/points')}>
              <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{loc('النقاط', 'Points', 'خاڵەکان')}</span>
              <span className="text-[12px] font-bold font-mono">{pointBalance || 0}</span>
            </button>
            <button type="button" className="flex flex-col items-center justify-center min-h-[48px] border-e border-zinc-200 dark:border-zinc-700 hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]" onClick={() => navigate('/wallet')}>
              <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{loc('الرصيد', 'Balance', 'باڵانس')}</span>
              <span className="text-[12px] font-bold font-mono">{dir === 'rtl' ? 'د.ع' : 'IQD'} {balanceIqd.toLocaleString()}</span>
            </button>
            <button type="button" className="flex flex-col items-center justify-center min-h-[48px] hover:opacity-80 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded-e-lg" onClick={() => navigate('/warranty')}>
               <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{loc('الحماية', 'Protection', 'پاراستن')}</span>
               <span className="text-[10px] font-bold whitespace-nowrap flex items-center gap-0.5 text-zinc-500"><Shield className="w-3 h-3" aria-hidden="true" /> {loc('حماية المشتري', 'Buyer protection', 'پاراستنی کڕیار')}</span>
            </button>
          </div>

        </div>
        )}

        {/* The referral programme lives on /referrals, and ONLY there.
            It used to be duplicated here as a full card — the link, both
            campaigns explained, and the reward list — which is a whole second
            place to maintain the same thing and a long block between the
            member card and the actions people actually come to this page for.
            The single row below is a signpost, not a copy. */}
        {isAuthenticated && (
          <button
            type="button"
            data-profile-referrals
            onClick={() => navigate('/referrals')}
            className="w-full bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm text-black dark:text-white flex items-center gap-3 min-h-[56px] text-start active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
          >
            <Gift className="w-5 h-5 text-[#ff5000] shrink-0" strokeWidth={2} aria-hidden="true" />
            <span className="flex-1 min-w-0">
              <span className="block font-bold text-[14px]">{t('referralProgram')}</span>
              <span className="block text-[11px] text-zinc-500 truncate">
                {mine?.referral?.code
                  ? `${t('referralCode')}: ${mine.referral.code}`
                  : loc('شارك رابطك واكسب مكافآت', 'Share your link and earn rewards', 'لینکەکەت بەشدار بکە و خەڵات وەربگرە')}
              </span>
            </span>
            {dir === 'rtl' ? (
              <ChevronLeft className="w-4 h-4 shrink-0 text-zinc-400" aria-hidden="true" />
            ) : (
              <ChevronRight className="w-4 h-4 shrink-0 text-zinc-400" aria-hidden="true" />
            )}
          </button>
        )}

        {/* Second Card: quick actions. Real destinations; guests are routed
            through /auth with the destination preserved. Aligned like the
            header grid: fixed icon box + consistent label area. */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl px-2 py-3 mb-3 shadow-sm grid grid-flow-col auto-cols-fr items-start text-black dark:text-white">
          {[
            { key: 'shipping', icon: Package, label: loc('الشحن', 'Shipping', 'گەیاندن'), onClick: () => go('/orders?status=to_ship') },
            { key: 'favorites', icon: Star, label: loc('المفضلة', 'Favorites', 'دڵخوازەکان'), onClick: showFavoritesTab },
            { key: 'stores', icon: Store, label: loc('متاجري', 'My stores', 'فرۆشگاکانم'), onClick: () => go('/followed-stores') },
            { key: 'saved', icon: Heart, label: loc('المحفوظات', 'Saved', 'پاشەکەوتەکان'), onClick: () => go('/saved-items') },
            { key: 'history', icon: Clock, label: loc('الطلبات السابقة', 'Order history', 'داواکارییە پێشووەکان'), onClick: () => go('/orders') },
          ].map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              className="flex flex-col items-center min-h-[56px] px-1 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-transform"
            >
              <span className="h-7 w-7 flex items-center justify-center shrink-0" aria-hidden="true">
                <a.icon className="w-6 h-6" strokeWidth={1.5} />
              </span>
              <span className="mt-1 w-full text-[11px] leading-[13px] min-h-[26px] text-center line-clamp-2 break-words">{a.label}</span>
            </button>
          ))}
        </div>

        {/* Third Card: My Orders — members only (real counts; a guest has
            no orders and must never see fabricated ones). */}
        {isAuthenticated && (
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm text-black dark:text-white">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-bold text-[14px]">{loc('طلباتي', 'My Orders', 'داواکارییەکانم')}</h2>
            <button type="button" className="flex items-center text-[11px] text-zinc-500 min-h-[44px] px-2 -mx-2 hover:text-zinc-700 dark:hover:text-zinc-300 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded-lg" onClick={() => navigate('/orders')}>
              {loc('الكل', 'All', 'هەموو')}
              {dir === 'rtl' ? <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
            </button>
          </div>
          <div className="grid grid-flow-col auto-cols-fr items-start pt-1 pb-1 overflow-hidden">
            {orderChips.map((item) => (
              <button key={item.key} type="button" onClick={() => navigate(`/orders?status=${item.status}`)} className="flex flex-col items-center min-h-[56px] px-0.5 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-transform relative">
                <span className="relative h-7 w-7 flex items-center justify-center shrink-0">
                  <item.icon className="w-[24px] h-[24px]" strokeWidth={1.5} aria-hidden="true" />
                  {item.badge > 0 && (
                    <span className="absolute -top-1 -right-1 bg-[#ff5000] text-white text-[9px] font-bold px-1 min-w-[14px] h-[14px] rounded-full flex items-center justify-center border-2 border-white dark:border-[#1a1a1a]">
                      {item.badge}
                    </span>
                  )}
                </span>
                <span className="mt-1 w-full text-[9px] sm:text-[10px] leading-[12px] min-h-[24px] text-center line-clamp-2 break-words">{item.label}</span>
              </button>
            ))}
          </div>
          {/* Order Status Banner — only when a real order exists */}
          {latestOrder && latestOrder.items.length > 0 && (
            <button type="button" onClick={() => navigate('/orders')} className="w-full bg-[#f7f7f7] dark:bg-[#222] rounded-lg p-2.5 mt-2 flex items-center gap-2 text-start hover:bg-[#efefef] dark:hover:bg-[#2a2a2a] active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]">
              <div className="w-8 h-8 rounded shrink-0 overflow-hidden bg-zinc-200 dark:bg-zinc-800">
                {latestOrder.items[0].image && (
                  <img referrerPolicy="no-referrer" src={latestOrder.items[0].image} alt={latestOrder.items[0].name} className="w-full h-full object-cover" />
                )}
              </div>
              <div className="flex items-center gap-2 text-[12px] min-w-0">
                <span className="font-bold whitespace-nowrap">{orderStatusLabel(latestOrder.status)}</span>
                <span className="text-zinc-600 dark:text-zinc-400 truncate">{latestOrder.items[0].name}</span>
              </div>
            </button>
          )}
        </div>
        )}

        {/* Fourth Card: Quick Tiles — members only (all targets need auth;
            every tile leads to a real page). */}
        {isAuthenticated && (
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-4 mb-3 shadow-sm overflow-hidden relative">
          <div className="flex overflow-x-auto gap-5 hide-scrollbar">
            {[
              /* §3.1: the referrals page gets ONE of the five slots under
                 "My Orders" — it replaces a "coming soon" placeholder, so no
                 working button was removed and the five-cell grid keeps its
                 sizes, spacing and alignment exactly as before. */
              { icon: UserPlus, label: loc('الإحالات', 'Referrals', 'بانگهێشتکردن'), color: 'text-sky-500', bg: 'bg-sky-100 dark:bg-sky-900/30', to: '/referrals' },
              /* The Printer Farm is the real game behind the former "Collect
                 Coins" placeholder: Farm Coins are earned there, on the server. */
              { icon: Coins, label: loc('مزرعة الطباعة', 'Printer Farm', 'کێڵگەی چاپکەر'), color: 'text-yellow-500', bg: 'bg-yellow-100 dark:bg-yellow-900/30', to: '/games/printer-farm' },
              { icon: Zap, label: loc('تسجيل الدخول اليومي', 'Daily Sign-in', 'چوونەژوورەوەی ڕۆژانە'), color: 'text-red-500', bg: 'bg-red-100 dark:bg-red-900/30', to: '/points' },
              { icon: Gamepad2, label: loc('الالعاب', 'Games', 'یارییەکان'), color: 'text-purple-500', bg: 'bg-purple-100 dark:bg-purple-900/30', to: '/games' },
              { icon: Star, label: loc('المكافآت', 'Rewards', 'خەڵاتەکان'), color: 'text-orange-500', bg: 'bg-orange-100 dark:bg-orange-900/30', to: '/points' },
            ].map((game, i) => (
              <button
                key={i}
                type="button"
                onClick={() => navigate(game.to)}
                className="flex flex-col items-center gap-2 min-w-[56px] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded-lg hover:scale-105 active:scale-95"
              >
                <span className={`w-[44px] h-[44px] rounded-full flex items-center justify-center ${game.bg}`} aria-hidden="true">
                  <game.icon className={`w-[22px] h-[22px] ${game.color}`} strokeWidth={2} />
                </span>
                <span className="text-[11px] text-black dark:text-white text-center whitespace-nowrap">
                  {game.label}
                </span>
              </button>
            ))}
          </div>
        </div>
        )}

        {/* Fifth Card: member bundles (PLUS/PRIME/PRO — server-gated) */}
        {planActive && (
          <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm text-black dark:text-white">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-bold text-[14px] flex items-center gap-1 text-[#ff0036]">
                <span className="italic font-black text-base">BUNDLES</span>
                <span className="text-black dark:text-white ml-1 text-[13px]">{loc('مركز الخصومات الحصرية', 'Exclusive Discounts', 'داشکاندنە تایبەتەکان')}</span>
              </h2>
              <button type="button" className="text-[11px] text-zinc-500 min-h-[44px] px-2 -mx-2 hover:text-zinc-700 dark:hover:text-zinc-300 active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded-lg" onClick={() => navigate('/bundles')}>{loc('المزيد', 'More', 'زیاتر')} {dir === 'rtl' ? '‹' : '›'}</button>
            </div>
            <div className="flex gap-2.5 overflow-x-auto hide-scrollbar pb-1">
              {bundles.length > 0 ? bundles.map((bundle) => (
                <button key={bundle.id} type="button" onClick={() => navigate(bundle.product_slug ? `/bundles/${bundle.product_slug}` : '/bundles')} className="min-w-[85px] w-[85px] bg-[#fff0f2] dark:bg-[#331118] border border-[#ffb3c1] dark:border-[#801a2c] rounded-lg p-1.5 flex flex-col shrink-0 text-start active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]">
                  <div className="w-full aspect-square bg-zinc-200 dark:bg-zinc-800 rounded mb-1.5 overflow-hidden">
                    {bundle.image && (
                      <img referrerPolicy="no-referrer" src={bundle.image} alt={bundle.name} className="w-full h-full object-cover" />
                    )}
                  </div>
                  <span className="text-[9px] font-bold text-black dark:text-white line-clamp-2 leading-tight mb-1">{bundle.name}</span>
                  {bundleShelfPrice(bundle) !== null && (
                    <div className="text-[#ff0036] font-bold flex items-baseline gap-0.5 mt-auto">
                      <span className="text-[12px] leading-none">{formatIqd(bundleShelfPrice(bundle)!)}</span>
                    </div>
                  )}
                </button>
              )) : (
                <div className="text-[11px] text-zinc-500 py-4 w-full text-center">
                  {loc('لا توجد عروض حالياً', 'No bundles available', 'ئێستا هیچ ئۆفەرێک نییە')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tabs for Bottom Section */}
        <div ref={tabsRef} role="tablist" className="flex items-center gap-4 mt-4 mb-3 sticky top-[48px] z-40 bg-[#f2f2f2] dark:bg-[#111] py-1 px-1 scroll-mt-14">
          {[
            { id: 'suggested', label: loc('المنتجات المقترحة', 'Suggested', 'بەرهەمە پێشنیارکراوەکان') },
            { id: 'collection', label: loc('مجموعتي', 'My Collection', 'کۆکراوەکانم') },
            { id: 'reviews', label: loc('مراجعاتي', 'My Reviews', 'پێداچوونەوەکانم') },
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`font-bold text-[14px] relative transition-colors min-h-[44px] px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded-lg ${activeTab === tab.id ? 'text-[#ff5000]' : 'text-black dark:text-white'}`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-4 h-[3px] bg-[#ff5000] rounded-full" aria-hidden="true"></span>
              )}
            </button>
          ))}
        </div>

        {/* Product Grid */}
        {activeTab === 'suggested' && (
          <div className="grid grid-cols-2 gap-2.5 mb-6">
            {suggestedProducts.length === 0 && (
              <div className="col-span-2 text-center text-[12px] text-zinc-500 py-8">
                {loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا هیچ بەرهەمێک نییە')}
              </div>
            )}
            {suggestedProducts.map(p => {
              const firstImage = p.images?.[0] || '';
              // §3/§12: the product name is English in every language and is never translated.
              const name = p.name;

              return (
                <button type="button" onClick={() => navigate('/product/' + p.slug)} key={p.id} className="bg-white dark:bg-[#1a1a1a] rounded-[10px] overflow-hidden flex flex-col text-start border border-black/5 dark:border-white/5 shadow-sm pb-2 active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]">
                  <div className="relative aspect-square overflow-hidden bg-zinc-100 dark:bg-zinc-800 w-full">
                    {firstImage && <img referrerPolicy="no-referrer" src={firstImage} alt={name} className="w-full h-full object-cover" />}
                  </div>
                  <div className="p-2.5 flex flex-col flex-1 text-black dark:text-white w-full">
                    <h3 className="font-medium text-[13px] line-clamp-2 mb-2 leading-[1.3]">{name}</h3>

                    <div className="mt-auto flex items-baseline justify-between">
                       <span className="text-[#ff5000] font-bold text-[15px] flex items-baseline gap-0.5">
                         {formatIqd(p.price_iqd || 0)}
                       </span>
                       {p.display_regular_iqd != null && p.display_regular_iqd > (p.display_price_iqd ?? p.price_iqd) && (
                         <span className="text-[11px] text-zinc-500 line-through">{formatIqd(p.display_regular_iqd)}</span>
                       )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Collection Tab */}
        {activeTab === 'collection' && (
          <div className="mb-6">
             {!isAuthenticated ? (
               <div className="text-center py-12 text-zinc-500">
                 <Heart className="w-8 h-8 mx-auto mb-2 opacity-40" aria-hidden="true" />
                 <p className="text-[13px] font-medium mb-3">{loc('سجل الدخول لعرض مجموعتك', 'Sign in to see your collection', 'بچۆ ژوورەوە بۆ بینینی کۆکراوەکانت')}</p>
                 <button
                   type="button"
                   onClick={() => navigate('/auth?next=%2Fprofile')}
                   className="min-h-[44px] px-6 rounded-xl bg-olive text-[#BAA369] text-[13px] font-bold hover:opacity-90 active:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                 >
                   {loc('تسجيل الدخول', 'Sign in', 'چوونەژوورەوە')}
                 </button>
               </div>
             ) : !favoritesLoaded ? (
               <div className="flex justify-center py-12" role="status" aria-busy="true">
                 <div className="w-7 h-7 border-2 border-[#ff5000]/20 border-t-[#ff5000] rounded-full animate-spin" />
               </div>
             ) : favorites.length === 0 ? (
               <div className="text-center py-12 text-zinc-500">
                 <Heart className="w-8 h-8 mx-auto mb-2 opacity-40" aria-hidden="true" />
                 <p className="text-[13px] font-medium">{loc('لا توجد عناصر محفوظة بعد', 'No saved items yet', 'هێشتا هیچ شتێکی پاشەکەوتکراو نییە')}</p>
               </div>
             ) : (
               <div className="flex flex-col gap-3">
                 {favorites.map((item) => {
                   // §3/§12: the product name is English in every language and is never translated.
                   const name = item.name;
                   return (
                     <button type="button" key={item.id} onClick={() => navigate(`/product/${item.slug}`)} className="bg-white dark:bg-[#1a1a1a] rounded-[10px] p-2.5 flex gap-3 shadow-sm border border-black/5 dark:border-white/5 relative text-start active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]">
                       <div className="w-[110px] h-[110px] rounded-lg overflow-hidden shrink-0 bg-zinc-100 dark:bg-zinc-800">
                         {item.image && <img referrerPolicy="no-referrer" src={item.image} alt={name} className="w-full h-full object-cover" />}
                       </div>
                       <div className="flex flex-col flex-1 min-w-0">
                         <h3 className="font-bold text-[13px] leading-[1.3] mb-1.5 text-black dark:text-white line-clamp-2">
                           {name}
                         </h3>

                         <div className="flex items-baseline gap-1.5 text-[#ff0036] font-bold mb-1.5 mt-auto">
                           <span className="text-[15px] leading-none">{formatIqd(item.price_iqd || 0)}</span>
                         </div>

                         <div className="text-zinc-500 text-[11px] flex items-center gap-0.5">
                           {loc('عرض المنتج', 'View product', 'بینینی بەرهەم')} <ChevronRight className={`w-3 h-3 ${dir === 'rtl' ? 'rotate-180' : ''}`} aria-hidden="true" />
                         </div>
                       </div>
                     </button>
                   );
                 })}
               </div>
             )}
          </div>
        )}

        {/* Reviews Tab — REAL data from GET /api/reviews/mine */}
        {activeTab === 'reviews' && (
          <div className="mb-6">
            <MyReviewsTab isAuthenticated={isAuthenticated} />
          </div>
        )}

      </div>

      {qrOpen && <QrCodeModal link={referralLink || null} onClose={() => setQrOpen(false)} />}
    </div>
  );
}
