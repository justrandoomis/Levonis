import React, { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../LanguageContext';
import { tierLabel } from '../components/subscription/tierMeta';
import { useNavigate } from 'react-router-dom';
import {
  Headset, Settings, MapPin, QrCode, Store,
  Wallet, Package, Truck, MessageSquare, RefreshCcw,
  Star, Clock, Heart, Gamepad2, Coins, Zap, Shield,
  ChevronRight, ChevronLeft, Gift, UserRound, UserPlus, Download, BellRing
} from 'lucide-react';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { api, ApiProduct, ApiOrder, usdCentsToIqd, formatIqd } from '../lib/api';
import ProfileIconGrid, { ProfileIconAction } from '../components/profile/ProfileIconGrid';
import GuestCard from '../components/profile/GuestCard';
import MyReviewsTab from '../components/profile/MyReviewsTab';
import QrCodeModal from '../components/profile/QrCodeModal';
import DirectStockEdge from '../components/DirectStockEdge';
import InstallAppButton from '../components/pwa/InstallAppButton';

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
  const [followedStoreCount, setFollowedStoreCount] = useState<number | null>(null);
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
      setFollowedStoreCount(null);
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
    api
      .get<{ merchants: unknown[] }>('/api/community/followed')
      .then((res) => setFollowedStoreCount(Array.isArray(res.merchants) ? res.merchants.length : 0))
      .catch(() => setFollowedStoreCount(null));
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
      .catch(() => setMine(null));
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

      {/* A restrained warm wash keeps Levonis' identity without competing
          with the actual profile information. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[180px] bg-gradient-to-b from-[#f2e6d7] to-transparent dark:from-[#1c1711] dark:to-transparent" />

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
           <span dir="auto" title={displayName} className="max-w-[min(48vw,220px)] truncate text-start text-[13px] font-semibold text-black dark:text-white">{displayName}</span>
        </div>
        <ProfileIconGrid items={iconActions} compact />
      </div>

      <div className="max-w-3xl mx-auto px-3 relative z-10 pt-4">

        {/* Identity keeps the full first row; shortcuts follow below instead
            of squeezing mixed-direction usernames into only their suffix. */}
        <section data-profile-header className="mb-4 flex min-w-0 flex-col gap-2">
          <div className="flex w-full min-w-0 items-center gap-3">
            <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#e7d9b2] ring-1 ring-black/5 dark:bg-[#25271e] dark:ring-white/10">
              {avatarUrl ? (
                <img referrerPolicy="no-referrer" src={avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <UserRound className="h-7 w-7 text-zinc-500" aria-hidden="true" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-0.5">
                <h1 dir="auto" title={displayName} data-profile-username className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-start text-[17px] font-semibold leading-6 text-black dark:text-white">{displayName}</h1>
                {isAuthenticated && (
                  <button
                    type="button"
                    onClick={() => setQrOpen(true)}
                    aria-label={loc('عرض رمز QR للدعوة', 'Show invite QR code', 'پیشاندانی کۆدی QR بانگهێشت')}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-600 hover:bg-black/5 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-zinc-300 dark:hover:bg-white/[0.06]"
                  >
                    <QrCode className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden">
                {!isAuthenticated ? (
                  /* Honest guest badge — never a member chip for a guest. */
                  <span className="rounded-sm bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-black dark:bg-white/[0.07] dark:text-white">
                    {loc('زائر', 'Guest', 'میوان')}
                  </span>
                ) : (
                  <>
                    {memTier !== 'free' ? (
                      <button type="button" onClick={() => navigate('/subscription')} className="flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-sm bg-gold/10 px-1.5 text-[10px] font-semibold text-gold hover:bg-gold/15 active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                        <span>{loc(`عضو ${tierLabel(memTier)}`, `${tierLabel(memTier)} Member`, `ئەندامی ${tierLabel(memTier)}`)}</span>
                        {memExpiry && (
                          <span className="hidden font-normal opacity-75 sm:inline">· {loc('حتى', 'until', 'تا')} {fmtDate(memExpiry)}</span>
                        )}
                      </button>
                    ) : (
                      <button type="button" onClick={() => navigate('/subscription')} className="flex h-6 shrink-0 items-center rounded-sm bg-black/5 px-1.5 text-[10px] font-semibold text-black hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:bg-white/[0.07] dark:text-white dark:hover:bg-white/10">
                        <span>{loc('عضو', 'Member', 'ئەندام')}</span>
                      </button>
                    )}
                    {memPendingLaunch && (
                      <button type="button" onClick={() => navigate('/subscription')} className="hidden h-6 items-center rounded-sm bg-sky-500/10 px-1.5 text-[10px] font-semibold text-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-sky-300 sm:flex">
                        <span>{tierLabel(memPendingLaunch.tier) + ' — ' + t('pendingLaunch')}</span>
                      </button>
                    )}
                    <button type="button" onClick={() => navigate('/followed-stores')} className="flex h-6 min-w-0 items-center gap-1 rounded-sm px-1 text-[10px] font-medium text-zinc-600 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-zinc-400 dark:hover:bg-white/[0.06]">
                      <Store className="h-3 w-3 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                      {followedStoreCount !== null && <span className="shrink-0 font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">{followedStoreCount}</span>}
                      <span className="truncate whitespace-nowrap">{loc('متاجر أتابعها', 'Following', 'شوێنکەوتن')}</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className={`w-full border-t border-black/[0.06] pt-1 transition-opacity duration-300 dark:border-white/[0.07] ${scrolled ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
            <ProfileIconGrid items={iconActions} />
          </div>
        </section>

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

        {/*
          TWO SIGNPOSTS, ONE ROW — «برنامج الإحالة وتنبيهاته اجعلها في سطر واحد
          زرين في سطر واحد وليس في سطرين».

          They were two full-width rows, stacked, each with a title, a subtitle
          and a chevron: 112px of a phone screen spent on two links, pushing the
          quick actions people actually come here for below the fold. They are
          peers — both are "go and see the list of a thing you have" — so they
          read as a pair rather than as a sequence, and a pair belongs side by
          side.

          The subtitle goes with the second row. At half the width it would
          truncate to a few characters and say nothing, and a truncated
          explanation is worse than none: the title and the icon already say
          what the destination is. The referral CODE is the one subtitle worth
          keeping, because it is a fact the customer may want to read without
          opening anything — so it stays, under its own title, at 11px.

          The referral programme still lives on /referrals and the alerts on
          /stock-alerts, and ONLY there. These are signposts, never a copy.
        */}
        {isAuthenticated && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            <button
              type="button"
              data-profile-referrals
              onClick={() => navigate('/referrals')}
              className="min-w-0 bg-white dark:bg-[#1a1a1a] rounded-xl p-3 shadow-sm text-black dark:text-white flex items-center gap-2.5 min-h-[56px] text-start active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
            >
              <Gift className="w-5 h-5 text-[#ff5000] shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="flex-1 min-w-0">
                <span className="block font-bold text-[13px] leading-4 truncate">{t('referralProgram')}</span>
                {mine?.referral?.code ? (
                  <span dir="ltr" className="block text-[11px] leading-4 text-zinc-500 truncate text-start">
                    {mine.referral.code}
                  </span>
                ) : null}
              </span>
            </button>

            {/* «تنبيهاتي» — the standing restock requests. Until this row
                existed a customer could arm an alert on a product page and then
                had no way on earth to see what they were waiting for, or to
                read that one had been cancelled because the option was deleted.
                Member-only: a guest holds no alerts and the row would do
                nothing but bounce them through /auth to an empty list. */}
            <button
              type="button"
              data-profile-stock-alerts
              onClick={() => navigate('/stock-alerts')}
              className="min-w-0 bg-white dark:bg-[#1a1a1a] rounded-xl p-3 shadow-sm text-black dark:text-white flex items-center gap-2.5 min-h-[56px] text-start active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
            >
              <BellRing className="w-5 h-5 text-[#BAA369] shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="flex-1 min-w-0">
                <span className="block font-bold text-[13px] leading-4 truncate">
                  {loc('تنبيهاتي', 'My alerts', 'ئاگادارکردنەوەکانم')}
                </span>
              </span>
            </button>
          </div>
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
          {/*
            WHY THE LABELS USED TO COLLIDE.

            Each tile was `min-w-[56px]` with no `shrink-0`, and its label was
            `whitespace-nowrap`. `min-width` stops the BOX at 56px; it does not
            stop the TEXT. So in a flex row whose contents are wider than the
            screen, every tile was compressed to 56px while «تسجيل الدخول
            اليومي» (~95px at 11px) kept its full width and simply painted
            outside its own box — on top of «مزرعة الطباعة» to one side and
            «الالعاب» to the other. The horizontal scroller never engaged,
            because shrinking had already made the row "fit".

            The fix is to let the tiles keep their real width (`shrink-0`) so
            the row genuinely scrolls, and to give the label a fixed column it
            wraps inside instead of a single unbreakable line. Two lines, hard
            clamped, so a long Arabic label and a short Kurdish one produce the
            same tile height and the icons stay on one baseline.
          */}
          <div className="flex overflow-x-auto gap-4 hide-scrollbar -mx-1 px-1 py-0.5">
            {[
              /* §3.1: the referrals page gets ONE of the five slots under
                 "My Orders" — it replaces a "coming soon" placeholder, so no
                 working button was removed and the five-cell grid keeps its
                 sizes, spacing and alignment exactly as before. */
              { icon: UserPlus, label: loc('الإحالات', 'Referrals', 'بانگهێشتکردن'), color: 'text-sky-500', bg: 'bg-sky-100 dark:bg-sky-900/30', to: '/referrals' },
              /* The Printer Farm is the real game behind the former "Collect
                 Coins" placeholder: Farm Coins are earned there, on the server. */
              /* `soon` marks a destination the app will not actually serve
                 yet: /games is behind a feature gate and /games/printer-farm
                 is bounced by FarmGate, so tapping either used to look like a
                 dead button. The tile says so up front instead. Points and
                 missions stay live — they pay real balances today. */
              { icon: Coins, label: loc('مزرعة الطباعة', 'Printer Farm', 'کێڵگەی چاپکەر'), color: 'text-yellow-500', bg: 'bg-yellow-100 dark:bg-yellow-900/30', to: '/games/printer-farm', soon: true },
              { icon: Zap, label: loc('تسجيل الدخول اليومي', 'Daily Sign-in', 'چوونەژوورەوەی ڕۆژانە'), color: 'text-red-500', bg: 'bg-red-100 dark:bg-red-900/30', to: '/points', soon: false },
              { icon: Gamepad2, label: loc('الالعاب', 'Games', 'یارییەکان'), color: 'text-purple-500', bg: 'bg-purple-100 dark:bg-purple-900/30', to: '/games', soon: true },
              { icon: Star, label: loc('المكافآت', 'Rewards', 'خەڵاتەکان'), color: 'text-orange-500', bg: 'bg-orange-100 dark:bg-orange-900/30', to: '/points', soon: false },
            ].map((game, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { if (!game.soon) navigate(game.to); }}
                aria-disabled={game.soon || undefined}
                title={game.soon ? `${game.label} — ${t('comingSoon')}` : undefined}
                className={`group flex w-[74px] shrink-0 flex-col items-center gap-2 rounded-lg py-1 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] ${
                  game.soon ? 'cursor-default' : 'press-scale sm:hover:scale-105'
                }`}
              >
                <span className="relative" aria-hidden="true">
                  <span className={`w-[44px] h-[44px] rounded-full flex items-center justify-center ${game.bg} ${game.soon ? 'opacity-45' : ''}`}>
                    <game.icon className={`w-[22px] h-[22px] ${game.color}`} strokeWidth={2} />
                  </span>
                </span>
                <span className="flex flex-col items-center gap-1">
                  <span className={`text-[11px] leading-[1.35] text-center line-clamp-2 ${
                    game.soon ? 'text-zinc-500 dark:text-zinc-500' : 'text-black dark:text-white'
                  }`}>
                    {game.label}
                  </span>
                  {game.soon && (
                    <span className="text-[9px] font-bold leading-none px-1.5 py-[3px] rounded-full bg-[#BAA369]/15 text-[#BAA369] whitespace-nowrap">
                      {t('comingSoon')}
                    </span>
                  )}
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
                <button type="button" onClick={() => navigate('/product/' + p.slug)} key={p.id} className="relative bg-white dark:bg-[#1a1a1a] rounded-[10px] overflow-hidden flex flex-col text-start border border-black/5 dark:border-white/5 shadow-sm pb-2 active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]">
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
                  <DirectStockEdge product={p} />
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

        {/*
          «تحميل التطبيق», AT THE BOTTOM, AND WHY IT MOVED THERE.

          «تحميل التطبيق في مكانه غير مناسب في /profile». It was the FIRST
          card on this page, above the membership centre — the most valuable
          slot on the screen, spent on a promotion nobody asked for. A
          customer opening their profile is looking for their orders, their
          wallet or their plan; an install offer at the top pushes all three
          below the fold to advertise something they may already have done.

          It still has to be HERE and not only in Settings, and that part is
          not a preference. `src/hooks/useInstallApp.ts` calls
          `preventDefault()` on `beforeinstallprompt`, which suppresses
          Chrome's own install banner for every visitor on Android — the
          browser most of this shop's customers use. `/settings` is a
          `<ProtectedRoute>`, so before this row existed the feature was
          strictly negative: the browser's promotion was gone and ours was
          behind a login wall. `/profile` is the first item in BottomNav and is
          NOT protected, which is the whole reason the offer lives on this
          page. Moving it down keeps that reachability and stops it competing
          with the reason people came.

          `offered`, because nobody asked for it: it goes quiet for a month
          after «ليس الآن», and for good after «التطبيق مثبّت على هذا الجهاز».
          The Settings row does not, because that one the customer went looking
          for — and it is the way back if they answer here too soon.

          It renders for members and guests alike (an installed app is not a
          member benefit) and `InstallAppButton` returns null on its own once
          the shop IS installed, so this whole block disappears inside the app
          rather than offering to install what the customer is standing in.
        */}
        <div className="mb-6 rounded-xl border border-black/5 dark:border-white/5 px-4 py-3 text-black dark:text-white">
          <p className="text-[13px] font-bold flex items-center gap-2">
            <Download aria-hidden="true" className="w-4 h-4 text-zinc-400" />
            {t('pwaInstallTitle')}
          </p>
          <p className="mt-0.5 text-[12px] text-zinc-500 leading-relaxed">{t('pwaSettingsNote')}</p>
          <InstallAppButton offered />
        </div>

      </div>

      {qrOpen && <QrCodeModal link={referralLink || null} onClose={() => setQrOpen(false)} />}
    </div>
  );
}
