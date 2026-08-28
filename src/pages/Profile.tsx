import React, { useState, useEffect } from 'react';
import { useLanguage } from '../LanguageContext';
import { useNavigate } from 'react-router-dom';
import {
  Headset, Settings, MapPin, QrCode, Store,
  Wallet, Package, Truck, MessageSquare, RefreshCcw,
  Star, Clock, Heart, Gamepad2, Coins, Leaf, Zap, Shield,
  ChevronRight, ChevronLeft, Gift, Copy, Check
} from 'lucide-react';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { api, ApiProduct, ApiOrder, usdCentsToIqd, formatIqd } from '../lib/api';

interface FavoriteItem {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  image: string;
  price_iqd: number;
  original_price_iqd: number | null;
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
    tier: 'free' | 'plus' | 'pro';
    active: boolean;
    expires_at: string | null;
    pending_launch: { tier: 'plus' | 'pro'; duration_months: number } | null;
  };
  referral: { code: string; rewards: ReferralReward[] };
  launch: { launch_at: string | null; activated: boolean };
}

export default function Profile() {
  const [suggestedProducts, setSuggestedProducts] = useState<ApiProduct[]>([]);
  const [bundles, setBundles] = useState<ApiProduct[]>([]);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [favoritesLoaded, setFavoritesLoaded] = useState(false);
  const [orderCounts, setOrderCounts] = useState<Record<string, number>>({});
  const [latestOrder, setLatestOrder] = useState<ApiOrder | null>(null);
  const [activeTab, setActiveTab] = useState('suggested');
  const [scrolled, setScrolled] = useState(false);
  const [mine, setMine] = useState<MembershipMine | null>(null);
  const [mineLoaded, setMineLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { t, dir, lang, loc } = useLanguage();
  const navigate = useNavigate();
  const { balanceUsdCents, pointBalance, exchangeRate } = useWallet();
  const { isAuthenticated, user } = useAuth();

  const now = Date.now();
  const planActive =
    !!user &&
    user.subscription_plan !== 'free' &&
    (user.subscription_expiry === 0 || user.subscription_expiry > now);
  const isPro = planActive && user?.subscription_plan === 'pro';
  const isPlus = planActive && user?.subscription_plan === 'plus';

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
    if (!isPro) { setBundles([]); return; }
    api
      .get<{ products: ApiProduct[] }>('/api/products?type=bundle&limit=4')
      .then((res) => setBundles(res.products || []))
      .catch(() => setBundles([]));
  }, [isPro]);

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
      setMineLoaded(true);
      return;
    }
    setMineLoaded(false);
    api
      .get<MembershipMine>('/api/memberships/mine')
      .then((res) => setMine(res))
      .catch(() => setMine(null))
      .finally(() => setMineLoaded(true));
  }, [isAuthenticated, user?.id]);

  // Membership from the ledger (authoritative once loaded); the legacy
  // users.* cache is only a fallback while /api/memberships/mine loads.
  const memTier: 'free' | 'plus' | 'pro' = mine
    ? (mine.status.active ? mine.status.tier : 'free')
    : (planActive ? (user?.subscription_plan ?? 'free') : 'free');
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

  const copyReferralLink = async () => {
    if (!referralLink) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(referralLink);
      } else {
        const ta = document.createElement('textarea');
        ta.value = referralLink;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  const rewardStateChip = (state: string): { label: string; cls: string } => {
    switch (state) {
      case 'pending':
        return { label: loc('قيد الانتظار', 'Pending', 'چاوەڕوانە'), cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
      case 'qualified':
        return { label: loc('مؤهلة', 'Qualified', 'شیاوە'), cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400' };
      case 'available':
        return { label: loc('متاحة', 'Available', 'بەردەستە'), cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' };
      case 'reserved':
        return { label: loc('محجوزة', 'Reserved', 'حیجزکراوە'), cls: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' };
      case 'fulfilled':
        return { label: loc('تم التسليم', 'Fulfilled', 'گەیەنراوە'), cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
      case 'cancelled':
        return { label: loc('ملغاة', 'Cancelled', 'هەڵوەشێنراوەتەوە'), cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' };
      default:
        return { label: state, cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' };
    }
  };

  const balanceIqd = usdCentsToIqd(balanceUsdCents, exchangeRate);
  const avatarUrl = user?.avatar_key
    ? `/files/${user.avatar_key}`
    : `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.username || 'Levonis'}&backgroundColor=fde047`;

  const orderStatusLabel = (status: ApiOrder['status']) => {
    const labels: Record<ApiOrder['status'], { en: string; ar: string }> = {
      pending: { en: 'Pending payment', ar: 'بانتظار الدفع' },
      confirmed: { en: 'To ship', ar: 'بانتظار الشحن' },
      processing: { en: 'To ship', ar: 'بانتظار الشحن' },
      shipped: { en: 'Shipped', ar: 'مشحونة' },
      delivered: { en: 'Delivered', ar: 'تم التوصيل' },
      cancelled: { en: 'Cancelled', ar: 'ملغية' },
    };
    return dir === 'rtl' ? labels[status].ar : labels[status].en;
  };

  return (
    <div className="w-full bg-[#f2f2f2] dark:bg-[#111] min-h-screen font-sans pb-[80px] text-[#333] dark:text-[#ddd] relative">

      {/* Top Background Gradient */}
      <div className="absolute top-0 left-0 right-0 h-[240px] bg-gradient-to-b from-[#ffe3cc] via-[#ffebd9] to-[#f2f2f2] dark:from-[#2a1a10] dark:via-[#1a0f08] dark:to-[#111] z-0 pointer-events-none"></div>

      {/* Sticky Header */}
      <div className={`fixed top-0 left-0 right-0 z-[110] transition-all duration-300 flex items-center justify-between ${scrolled ? 'bg-[#ffe3cc] dark:bg-[#2a1a10] shadow-md py-2 px-3 opacity-100 pointer-events-auto' : 'bg-transparent py-3 px-3 opacity-0 pointer-events-none'}`}>
        <div className="flex items-center gap-2">
           <div className="w-7 h-7 rounded-full bg-white overflow-hidden border border-black/10 shrink-0">
             <img referrerPolicy="no-referrer" src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
           </div>
           <span className="font-bold text-[13px] truncate max-w-[100px] text-black dark:text-white">{user?.username || user?.name || (dir === 'rtl' ? 'زائر' : 'Guest')}</span>
        </div>

        <div className="flex items-center gap-4 text-black dark:text-white">
          <div onClick={() => navigate('/addresses')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
            <MapPin className="w-5 h-5 mb-0.5" strokeWidth={1.5} />
          </div>
          <div onClick={() => navigate('/chat/2')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
            <Headset className="w-5 h-5 mb-0.5" strokeWidth={1.5} />
          </div>
          <div onClick={() => navigate('/settings')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
            <Settings className="w-5 h-5 mb-0.5" strokeWidth={1.5} />
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-3 relative z-10 pt-4">

        {/* User Info Header (In Flow) */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-[64px] h-[64px] rounded-full bg-[#fce5a1] border border-white/50 flex items-center justify-center overflow-hidden shrink-0 shadow-sm relative">
              <img referrerPolicy="no-referrer" src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 mb-1.5">
                <h1 className="font-bold text-[17px] leading-tight text-black dark:text-white">{user?.username || user?.name || (dir === 'rtl' ? 'زائر' : 'Guest')}</h1>
                <QrCode className="w-[14px] h-[14px] text-zinc-700 dark:text-zinc-300" strokeWidth={2} />
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {memTier !== 'free' ? (
                  <div onClick={() => navigate('/subscription')} className="bg-[#ebd197] text-[#5c3e03] text-[10px] px-1.5 py-0.5 rounded-[4px] flex items-center gap-1 font-bold shadow-sm cursor-pointer hover:opacity-80 transition-opacity">
                    <span>{memTier === 'pro' ? loc('عضو PRO', 'PRO Member', 'ئەندامی PRO') : loc('عضو PLUS', 'PLUS Member', 'ئەندامی PLUS')}</span>
                    {memExpiry && (
                      <span className="font-medium opacity-80">· {loc('حتى', 'until', 'تا')} {fmtDate(memExpiry)}</span>
                    )}
                  </div>
                ) : (
                  <div onClick={() => navigate('/subscription')} className="bg-white/50 dark:bg-black/30 text-[10px] px-1.5 py-0.5 rounded-[4px] flex items-center gap-0.5 font-bold shadow-sm text-black dark:text-white cursor-pointer hover:opacity-80 transition-opacity">
                    <span>{loc('عضو', 'Member', 'ئەندام')}</span>
                  </div>
                )}
                {memPendingLaunch && (
                  <div onClick={() => navigate('/subscription')} className="bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 text-[10px] px-1.5 py-0.5 rounded-[4px] flex items-center gap-0.5 font-bold shadow-sm cursor-pointer hover:opacity-80 transition-opacity">
                    <span>{(memPendingLaunch.tier === 'pro' ? 'PRO' : 'PLUS') + ' — ' + t('pendingLaunch')}</span>
                  </div>
                )}
                <div onClick={() => navigate('/followed-stores')} className="bg-white/50 dark:bg-black/30 backdrop-blur-sm text-[10px] px-1.5 py-0.5 rounded-[4px] flex items-center gap-1 font-medium shadow-sm text-black dark:text-white cursor-pointer hover:bg-white/70 dark:hover:bg-black/50 transition-colors">
                  <Store className="w-[10px] h-[10px]" strokeWidth={2} />
                  {dir === 'rtl' ? 'المتاجر التي يتابعها' : 'Followed Stores'}
                </div>
              </div>
            </div>
          </div>

          {/* Icons on top right */}
          <div className={`flex items-center gap-4 mt-2 text-black dark:text-white transition-opacity duration-300 ${scrolled ? 'opacity-0' : 'opacity-100'}`}>
            <div onClick={() => navigate('/addresses')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
              <MapPin className="w-6 h-6 mb-0.5" strokeWidth={1.5} />
              <span className="text-[10px] font-medium">{dir === 'rtl' ? 'العنوان' : 'Address'}</span>
            </div>
            <div onClick={() => navigate('/chat/2')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
              <Headset className="w-6 h-6 mb-0.5" strokeWidth={1.5} />
              <span className="text-[10px] font-medium">{dir === 'rtl' ? 'خدمة العملاء' : 'Support'}</span>
            </div>
            <div onClick={() => navigate('/settings')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
              <Settings className="w-6 h-6 mb-0.5" strokeWidth={1.5} />
              <span className="text-[10px] font-medium">{dir === 'rtl' ? 'الاعدادات' : 'Settings'}</span>
            </div>
          </div>
        </div>

        {/* First Card: Membership Center */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm">
          {/* Top section of the card */}
          <div className="flex justify-between items-center mb-3 pb-3 border-b border-black/5 dark:border-white/5 overflow-hidden">
            <div className="flex items-center gap-1 cursor-pointer shrink-0" onClick={() => navigate('/subscription')}>
              <span className="font-bold text-[10px] text-black dark:text-white whitespace-nowrap">
                {dir === 'rtl' ? 'الخطة الحالية' : 'Current plan'}
              </span>
              <span className="font-bold text-[10px] text-black dark:text-white whitespace-nowrap uppercase">
                {memTier !== 'free' ? memTier : loc('مجاني', 'Free', 'بێبەرامبەر')}
              </span>
              {memTier !== 'free' && memExpiry && (
                <span className="text-[9px] text-zinc-500 whitespace-nowrap">
                  {loc('حتى', 'until', 'تا')} {fmtDate(memExpiry)}
                </span>
              )}
              {dir === 'rtl' ? <ChevronLeft className="w-3 h-3 text-zinc-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" />}
            </div>
            <div className="flex gap-2 shrink-0">
              <div onClick={() => navigate('/subscription')} className="flex flex-col items-center relative rtl:pl-2 ltr:pr-2 after:content-[''] after:absolute rtl:after:left-0 ltr:after:right-0 after:top-1/2 after:-translate-y-1/2 after:w-[1px] after:h-4 after:bg-zinc-200 cursor-pointer">
                <span className="text-[#ff5000] font-bold text-[9px] whitespace-nowrap">{dir === 'rtl' ? 'مركز الأعضاء' : 'Member Center'}</span>
                <span className="text-[8px] text-zinc-500 whitespace-nowrap">{dir === 'rtl' ? 'استكشف المزايا' : 'Explore benefits'}</span>
              </div>
              <div onClick={() => navigate('/points')} className="flex flex-col items-center shrink-0 cursor-pointer">
                <span className="text-[#ff5000] font-bold text-[9px] whitespace-nowrap">{dir === 'rtl' ? 'المكافآت' : 'Rewards'}</span>
                <span className="text-[8px] text-zinc-500 whitespace-nowrap">{dir === 'rtl' ? 'اكسب النقاط' : 'Earn points'}</span>
              </div>
            </div>
          </div>

          {/* Middle row: Stats */}
          <div className="flex justify-between items-center mb-3 text-black dark:text-white">
            <div className="flex flex-col items-center flex-1" onClick={() => navigate('/points')}>
              <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{dir === 'rtl' ? 'النقاط' : 'Points'}</span>
              <span className="text-[12px] font-bold font-mono">{pointBalance || 0}</span>
            </div>
            <div className="flex flex-col items-center flex-1 relative pr-2 after:content-[''] after:absolute after:right-0 after:top-1/2 after:-translate-y-1/2 after:w-[1px] after:h-6 after:bg-zinc-200" onClick={() => navigate('/wallet')}>
              <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{dir === 'rtl' ? 'الرصيد' : 'Balance'}</span>
              <span className="text-[12px] font-bold font-mono">{dir === 'rtl' ? 'د.ع' : 'IQD'} {balanceIqd.toLocaleString()}</span>
            </div>
            <div className="flex flex-col items-center flex-1 relative pr-2 after:content-[''] after:absolute after:right-0 after:top-1/2 after:-translate-y-1/2 after:w-[1px] after:h-6 after:bg-zinc-200">
               <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{dir === 'rtl' ? 'الحماية' : 'Protection'}</span>
               <span className="text-[10px] font-bold whitespace-nowrap flex items-center gap-0.5 text-zinc-500"><Shield className="w-3 h-3" /> {dir === 'rtl' ? 'حماية المشتري' : 'Buyer protection'}</span>
            </div>
          </div>

          {/* Bottom game tickets row */}
          {planActive && (
            <div className="bg-[#fff6f5] dark:bg-[#2a1111] rounded-lg p-2 flex justify-between items-center mt-3">
               <div className="flex items-center gap-1.5">
                 <Gamepad2 className="w-4 h-4 text-[#ff5000]" />
                 <span className="text-[11px] text-[#ff5000] font-medium whitespace-nowrap">
                   {dir === 'rtl'
                     ? `${isPro ? 5 : 3} تذاكر ألعاب مجانية يومياً`
                     : `${isPro ? 5 : 3} Free daily game tickets`}
                 </span>
               </div>
               <button onClick={() => navigate('/games')} className="bg-gradient-to-r from-[#ff0036] to-[#ff5000] text-white text-[11px] px-3 py-1 rounded-full font-bold whitespace-nowrap">
                 {dir === 'rtl' ? 'العب الان' : 'Play Now'}
               </button>
            </div>
          )}
        </div>

        {/* Referral Card */}
        {isAuthenticated && (
          <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm text-black dark:text-white">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-bold text-[14px] flex items-center gap-1.5">
                <Gift className="w-4 h-4 text-[#ff5000]" strokeWidth={2} />
                {t('referralProgram')}
              </h2>
              {mine?.referral?.code && (
                <span className="text-[11px] text-zinc-500">
                  {t('referralCode')}: <span className="font-mono font-bold text-black dark:text-white">{mine.referral.code}</span>
                </span>
              )}
            </div>

            {!mineLoaded ? (
              <div className="flex justify-center py-6">
                <div className="w-6 h-6 border-2 border-[#ff5000]/20 border-t-[#ff5000] rounded-full animate-spin" />
              </div>
            ) : !mine ? (
              <p className="text-[12px] text-zinc-500 text-center py-4">
                {loc('تعذر تحميل بيانات الإحالة — حاول مرة أخرى لاحقًا', 'Could not load referral data — please try again later', 'داتای بانگهێشتکردن بار نەبوو — دواتر هەوڵ بدەرەوە')}
              </p>
            ) : (
              <>
                {/* Share link + copy */}
                <div className="flex items-center gap-2 bg-[#f7f7f7] dark:bg-[#222] rounded-lg p-2 mb-3">
                  <span dir="ltr" className="text-[11px] font-mono text-zinc-600 dark:text-zinc-400 truncate flex-1 min-w-0">
                    {referralLink}
                  </span>
                  <button
                    onClick={copyReferralLink}
                    className="flex items-center gap-1 bg-gradient-to-r from-[#ff0036] to-[#ff5000] text-white text-[11px] px-3 py-1.5 rounded-full font-bold whitespace-nowrap shrink-0"
                  >
                    {copied ? <Check className="w-3 h-3" strokeWidth={3} /> : <Copy className="w-3 h-3" strokeWidth={2.5} />}
                    {copied ? t('copied') : t('copyLink')}
                  </button>
                </div>

                {/* The two programs — two lines each */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                  <div className="rounded-lg border border-black/5 dark:border-white/10 p-2.5">
                    <p className="text-[11px] font-bold mb-1">
                      {loc('إحالة شراء طابعة', 'Printer referral', 'بانگهێشتکردن بۆ کڕینی پرینتەر')}
                    </p>
                    <p className="text-[10.5px] text-zinc-600 dark:text-zinc-400 leading-snug">
                      {loc('صديقك يشتري طابعة عبر رابطك ← يحصل على توصيل مجاني لطلبه.', 'Your friend buys a printer through your link → they get free delivery on that order.', 'هاوڕێکەت پرینتەرێک دەکڕێت لە ڕێگەی لینکەکەتەوە ← گەیاندنی بێبەرامبەر بۆ داواکاریەکەی وەردەگرێت.')}
                    </p>
                    <p className="text-[10.5px] text-zinc-600 dark:text-zinc-400 leading-snug">
                      {loc('أنت تحصل على بكرة فيلامنت بعد 7 أيام من التوصيل.', 'You get a filament spool 7 days after delivery.', 'تۆش بۆبینێکی فیلامێنت وەردەگریت ٧ ڕۆژ دوای گەیاندن.')}
                    </p>
                  </div>
                  <div className="rounded-lg border border-black/5 dark:border-white/10 p-2.5">
                    <p className="text-[11px] font-bold mb-1">
                      {loc('إحالة اشتراك PRO', 'PRO subscription referral', 'بانگهێشتکردن بۆ ئەندامێتی PRO')}
                    </p>
                    <p className="text-[10.5px] text-zinc-600 dark:text-zinc-400 leading-snug">
                      {loc('مشترك PRO جديد يدفع عبر رابطك.', 'A new PRO member subscribes and pays via your link.', 'ئەندامێکی نوێی PRO لە ڕێگەی لینکەکەتەوە بەشداری دەکات و پارە دەدات.')}
                    </p>
                    <p className="text-[10.5px] text-zinc-600 dark:text-zinc-400 leading-snug">
                      {loc('أنت تحصل على بكرة فيلامنت عشوائية.', 'You get a random filament spool.', 'تۆش بۆبینێکی فیلامێنتی هەڕەمەکی وەردەگریت.')}
                    </p>
                  </div>
                </div>

                {/* My rewards */}
                <p className="text-[12px] font-bold mb-1.5">{t('rewards')}</p>
                {mine.referral.rewards.length === 0 ? (
                  <p className="text-[11px] text-zinc-500 py-2 text-center">
                    {loc('لا توجد مكافآت بعد — شارك رابطك مع أصدقائك!', 'No rewards yet — share your link with friends!', 'هێشتا هیچ خەڵاتێک نییە — لینکەکەت لەگەڵ هاوڕێکانت بەشدار بکە!')}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {mine.referral.rewards.map((r) => {
                      const chip = rewardStateChip(r.state);
                      return (
                        <li key={r.id} className="flex items-center justify-between gap-2 bg-[#f7f7f7] dark:bg-[#222] rounded-lg px-2.5 py-2">
                          <div className="min-w-0">
                            <p className="text-[11px] font-bold truncate">
                              {r.campaign === 'printer'
                                ? loc('إحالة شراء طابعة', 'Printer referral', 'بانگهێشتکردنی پرینتەر')
                                : loc('إحالة اشتراك PRO', 'PRO referral', 'بانگهێشتکردنی PRO')}
                              {' · '}
                              <span className="font-medium text-zinc-500">{loc('بكرة فيلامنت', 'Filament spool', 'بۆبینی فیلامێنت')}</span>
                            </p>
                            <p className="text-[10px] text-zinc-500">
                              {r.state === 'pending' && r.eligible_at
                                ? `${loc('تصبح مؤهلة في', 'Eligible on', 'شیاو دەبێت لە')} ${fmtDate(r.eligible_at)}`
                                : fmtDate(r.created_at)}
                            </p>
                          </div>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${chip.cls}`}>
                            {chip.label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {/* Second Card: 4 Buttons */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-4 mb-3 shadow-sm flex justify-around items-center text-black dark:text-white">
          <div className="flex flex-col items-center gap-2 cursor-pointer hover:opacity-70" onClick={() => navigate('/orders?status=processing')}>
            <Package className="w-6 h-6" strokeWidth={1.5} />
            <span className="text-[11px] whitespace-nowrap">{dir === 'rtl' ? 'الشحن' : 'Shipping'}</span>
          </div>
          <div className="flex flex-col items-center gap-2 cursor-pointer hover:opacity-70" onClick={() => setActiveTab('collection')}>
            <Star className="w-6 h-6" strokeWidth={1.5} />
            <span className="text-[11px] whitespace-nowrap">{dir === 'rtl' ? 'المفضلة' : 'Favorites'}</span>
          </div>
          <div onClick={() => navigate('/followed-stores')} className="flex flex-col items-center gap-2 cursor-pointer hover:opacity-70">
            <Store className="w-6 h-6" strokeWidth={1.5} />
            <span className="text-[11px] whitespace-nowrap">{dir === 'rtl' ? 'متاجري' : 'Stores'}</span>
          </div>
          <div className="flex flex-col items-center gap-2 cursor-pointer hover:opacity-70" onClick={() => navigate('/orders')}>
            <Clock className="w-6 h-6" strokeWidth={1.5} />
            <span className="text-[11px] whitespace-nowrap">{dir === 'rtl' ? 'الطلبات السابقة' : 'History'}</span>
          </div>
        </div>

        {/* Third Card: My Orders */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm text-black dark:text-white">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-bold text-[14px]">{dir === 'rtl' ? 'طلباتي' : 'My Orders'}</h2>
            <div className="flex items-center text-[11px] text-zinc-500 cursor-pointer" onClick={() => navigate('/orders')}>
              {dir === 'rtl' ? 'الكل' : 'All'}
              {dir === 'rtl' ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </div>
          </div>
          <div className="flex justify-between items-start pt-1 pb-2 gap-1 overflow-hidden">
            {[
              { icon: Wallet, label: dir === 'rtl' ? 'بانتظار الدفع' : 'Pending Payment', badge: orderCounts.pending || 0, status: 'pending' },
              { icon: Package, label: dir === 'rtl' ? 'بانتظار الشحن' : 'To Ship', badge: (orderCounts.confirmed || 0) + (orderCounts.processing || 0), status: 'confirmed' },
              { icon: Truck, label: dir === 'rtl' ? 'مشحونة' : 'Shipped', badge: orderCounts.shipped || 0, status: 'shipped' },
              { icon: MessageSquare, label: dir === 'rtl' ? 'بانتظار المراجعة' : 'To Review', badge: orderCounts.delivered || 0, status: 'delivered' },
              { icon: RefreshCcw, label: dir === 'rtl' ? 'استرجاع/خدمات' : 'Returns', badge: orderCounts.cancelled || 0, status: 'cancelled' },
            ].map((item, i) => (
              <div key={i} onClick={() => navigate(`/orders?status=${item.status}`)} className="flex flex-col items-center gap-1.5 flex-1 cursor-pointer hover:opacity-70 relative">
                <div className="relative">
                  <item.icon className="w-[24px] h-[24px]" strokeWidth={1.5} />
                  {item.badge > 0 && (
                    <span className="absolute -top-1 -right-1 bg-[#ff5000] text-white text-[9px] font-bold px-1 min-w-[14px] h-[14px] rounded-full flex items-center justify-center border-2 border-white dark:border-[#1a1a1a]">
                      {item.badge}
                    </span>
                  )}
                </div>
                <span className="text-[9px] sm:text-[10px] text-center leading-tight mt-1 whitespace-nowrap">{item.label}</span>
              </div>
            ))}
          </div>
          {/* Order Status Banner — only when a real order exists */}
          {latestOrder && latestOrder.items.length > 0 && (
            <div onClick={() => navigate('/orders')} className="bg-[#f7f7f7] dark:bg-[#222] rounded-lg p-2.5 mt-2 flex items-center gap-2 cursor-pointer">
              <div className="w-8 h-8 rounded shrink-0 overflow-hidden bg-zinc-200 dark:bg-zinc-800">
                {latestOrder.items[0].image && (
                  <img referrerPolicy="no-referrer" src={latestOrder.items[0].image} alt={latestOrder.items[0].name} className="w-full h-full object-cover" />
                )}
              </div>
              <div className="flex items-center gap-2 text-[12px] min-w-0">
                <span className="font-bold whitespace-nowrap">{orderStatusLabel(latestOrder.status)}</span>
                <span className="text-zinc-600 dark:text-zinc-400 truncate">{latestOrder.items[0].name}</span>
              </div>
            </div>
          )}
        </div>

        {/* Fourth Card: Quick Tiles (Horizontal Scroll) */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-4 mb-3 shadow-sm overflow-hidden relative">
          <div className="flex overflow-x-auto gap-5 hide-scrollbar">
            {[
              { icon: Leaf, label: dir === 'rtl' ? 'المزرعة' : 'Farm', color: 'text-green-500', bg: 'bg-green-100 dark:bg-green-900/30', to: null },
              { icon: Coins, label: dir === 'rtl' ? 'جمع العملات' : 'Collect Coins', color: 'text-yellow-500', bg: 'bg-yellow-100 dark:bg-yellow-900/30', to: null },
              { icon: Zap, label: dir === 'rtl' ? 'تسجيل الدخول' : 'Daily Sign-in', color: 'text-red-500', bg: 'bg-red-100 dark:bg-red-900/30', to: '/points' },
              { icon: Gamepad2, label: dir === 'rtl' ? 'الالعاب' : 'Games', color: 'text-purple-500', bg: 'bg-purple-100 dark:bg-purple-900/30', to: '/games' },
              { icon: Star, label: dir === 'rtl' ? 'المكافآت' : 'Rewards', color: 'text-orange-500', bg: 'bg-orange-100 dark:bg-orange-900/30', to: '/points' },
            ].map((game, i) => (
              <div
                key={i}
                onClick={() => { if (game.to) navigate(game.to); }}
                className={`flex flex-col items-center gap-2 min-w-[56px] transition-transform ${game.to ? 'cursor-pointer hover:scale-105' : 'opacity-40 cursor-not-allowed'}`}
              >
                <div className={`w-[44px] h-[44px] rounded-full flex items-center justify-center ${game.bg}`}>
                  <game.icon className={`w-[22px] h-[22px] ${game.color}`} strokeWidth={2} />
                </div>
                <span className="text-[11px] text-black dark:text-white text-center whitespace-nowrap">
                  {game.to ? game.label : (dir === 'rtl' ? 'قريباً' : 'Coming soon')}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Fifth Card: Limited Time Pro Discounts (Bundles) */}
        {isPro && (
          <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm text-black dark:text-white">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-bold text-[14px] flex items-center gap-1 text-[#ff0036]">
                <span className="italic font-black text-base">PRO BUNDLE</span>
                <span className="text-black dark:text-white ml-1 text-[13px]">{dir === 'rtl' ? 'مركز الخصومات الحصرية' : 'Exclusive Discounts'}</span>
              </h2>
              <div className="text-[11px] text-zinc-500 cursor-pointer" onClick={() => navigate('/bundles')}>{dir === 'rtl' ? 'المزيد >' : 'More >'}</div>
            </div>
            <div className="flex gap-2.5 overflow-x-auto hide-scrollbar pb-1">
              {bundles.length > 0 ? bundles.map((bundle) => (
                <div key={bundle.id} onClick={() => navigate(`/product/${bundle.slug}`)} className="min-w-[85px] w-[85px] bg-[#fff0f2] dark:bg-[#331118] border border-[#ffb3c1] dark:border-[#801a2c] rounded-lg p-1.5 flex flex-col shrink-0 cursor-pointer">
                  <div className="w-full aspect-square bg-zinc-200 dark:bg-zinc-800 rounded mb-1.5 overflow-hidden">
                    {bundle.images?.[0] && (
                      <img referrerPolicy="no-referrer" src={bundle.images[0]} alt={bundle.name} className="w-full h-full object-cover" />
                    )}
                  </div>
                  <span className="text-[9px] font-bold text-black dark:text-white line-clamp-2 leading-tight mb-1">{lang === 'ar' && bundle.name_ar ? bundle.name_ar : bundle.name}</span>
                  <div className="text-[#ff0036] font-bold flex items-baseline gap-0.5 mt-auto">
                    <span className="text-[12px] leading-none">{formatIqd(bundle.price_iqd || 0)}</span>
                  </div>
                </div>
              )) : (
                <div className="text-[11px] text-zinc-500 py-4 w-full text-center">
                  {dir === 'rtl' ? 'لا توجد عروض حالياً' : 'No bundles available'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tabs for Bottom Section */}
        <div className="flex items-center gap-6 mt-4 mb-3 sticky top-[48px] z-40 bg-[#f2f2f2] dark:bg-[#111] py-2 px-1">
          {[
            { id: 'suggested', label: dir === 'rtl' ? 'المنتجات المقترحة' : 'Suggested' },
            { id: 'collection', label: dir === 'rtl' ? 'مجموعتي' : 'My Collection' },
            { id: 'reviews', label: dir === 'rtl' ? 'مراجعاتي' : 'My Reviews' },
          ].map(tab => (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`cursor-pointer font-bold text-[14px] relative transition-colors ${activeTab === tab.id ? 'text-[#ff5000]' : 'text-black dark:text-white'}`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-4 h-[3px] bg-[#ff5000] rounded-full"></div>
              )}
            </div>
          ))}
        </div>

        {/* Product Grid */}
        {activeTab === 'suggested' && (
          <div className="grid grid-cols-2 gap-2.5 mb-6">
            {suggestedProducts.length === 0 && (
              <div className="col-span-2 text-center text-[12px] text-zinc-500 py-8">
                {dir === 'rtl' ? 'لا توجد منتجات بعد' : 'No products yet'}
              </div>
            )}
            {suggestedProducts.map(p => {
              const firstImage = p.images?.[0] || '';
              const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;

              return (
                <div onClick={() => navigate('/product/' + p.slug)} key={p.id} className="bg-white dark:bg-[#1a1a1a] rounded-[10px] overflow-hidden flex flex-col cursor-pointer border border-black/5 dark:border-white/5 shadow-sm pb-2">
                  <div className="relative aspect-square overflow-hidden bg-zinc-100 dark:bg-zinc-800">
                    {firstImage && <img referrerPolicy="no-referrer" src={firstImage} alt={name} className="w-full h-full object-cover" />}
                  </div>
                  <div className="p-2.5 flex flex-col flex-1 text-black dark:text-white">
                    <h3 className="font-medium text-[13px] line-clamp-2 mb-2 leading-[1.3]">{name}</h3>

                    <div className="mt-auto flex items-baseline justify-between">
                       <span className="text-[#ff5000] font-bold text-[15px] flex items-baseline gap-0.5">
                         {formatIqd(p.price_iqd || 0)}
                       </span>
                       {p.original_price_iqd != null && p.original_price_iqd > p.price_iqd && (
                         <span className="text-[11px] text-zinc-500 line-through">{formatIqd(p.original_price_iqd)}</span>
                       )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Collection Tab */}
        {activeTab === 'collection' && (
          <div className="mb-6">
             {!isAuthenticated ? (
               <div className="text-center py-12 text-zinc-500">
                 <Heart className="w-8 h-8 mx-auto mb-2 opacity-40" />
                 <p className="text-[13px] font-medium">{dir === 'rtl' ? 'سجل الدخول لعرض مجموعتك' : 'Sign in to see your collection'}</p>
               </div>
             ) : !favoritesLoaded ? (
               <div className="flex justify-center py-12">
                 <div className="w-7 h-7 border-2 border-[#ff5000]/20 border-t-[#ff5000] rounded-full animate-spin" />
               </div>
             ) : favorites.length === 0 ? (
               <div className="text-center py-12 text-zinc-500">
                 <Heart className="w-8 h-8 mx-auto mb-2 opacity-40" />
                 <p className="text-[13px] font-medium">{dir === 'rtl' ? 'لا توجد عناصر محفوظة بعد' : 'No saved items yet'}</p>
               </div>
             ) : (
               <div className="flex flex-col gap-3">
                 {favorites.map((item) => {
                   const name = lang === 'ar' && item.name_ar ? item.name_ar : item.name;
                   return (
                     <div key={item.id} onClick={() => navigate(`/product/${item.slug}`)} className="bg-white dark:bg-[#1a1a1a] rounded-[10px] p-2.5 flex gap-3 shadow-sm border border-black/5 dark:border-white/5 relative cursor-pointer">
                       <div className="w-[110px] h-[110px] rounded-lg overflow-hidden shrink-0 bg-zinc-100 dark:bg-zinc-800">
                         {item.image && <img referrerPolicy="no-referrer" src={item.image} alt={name} className="w-full h-full object-cover" />}
                       </div>
                       <div className="flex flex-col flex-1 min-w-0">
                         <h3 className="font-bold text-[13px] leading-[1.3] mb-1.5 text-black dark:text-white line-clamp-2">
                           {name}
                         </h3>

                         <div className="flex items-baseline gap-1.5 text-[#ff0036] font-bold mb-1.5 mt-auto">
                           <span className="text-[15px] leading-none">{formatIqd(item.price_iqd || 0)}</span>
                           {item.original_price_iqd != null && item.original_price_iqd > item.price_iqd && (
                             <span className="text-[11px] text-zinc-500 line-through font-medium">{formatIqd(item.original_price_iqd)}</span>
                           )}
                         </div>

                         <div className="text-zinc-500 text-[11px] flex items-center gap-0.5">
                           {dir === 'rtl' ? 'عرض المنتج' : 'View product'} <ChevronRight className={`w-3 h-3 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
                         </div>
                       </div>
                     </div>
                   );
                 })}
               </div>
             )}
          </div>
        )}

        {/* Reviews Tab */}
        {activeTab === 'reviews' && (
          <div className="mb-6">
             <div className="text-center py-12 text-zinc-500">
               <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
               <p className="text-[13px] font-medium">
                 {dir === 'rtl' ? 'المراجعات غير متاحة بعد — قريباً' : 'Reviews are not available yet — coming soon'}
               </p>
             </div>
          </div>
        )}

      </div>
    </div>
  );
}
