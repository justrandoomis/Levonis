import React, { useState } from 'react';
import { useLanguage } from '../LanguageContext';
import { Check, Zap, Eye, EyeOff, Printer, Info, Sparkles, Clock, Crown, Truck } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { api, formatIqd, newIdempotencyKey } from '../lib/api';
import StoreCta from '../components/merchant/StoreCta';
import KycSection from '../components/kyc/KycSection';

/** Display-only membership number derived deterministically from the user id — cosmetic, never stored. */
function generateConsistentNumber(seed: string): string {
  if (!seed) return '---- ---- ---- ----';
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const num = Math.abs(hash).toString().padStart(12, '0');
  return `4521 ${num.substring(0, 4)} ${num.substring(4, 8)} ${num.substring(8, 12)}`;
}

// ------------------------------------------------- server response shapes

interface ApiPlan {
  id: string;
  tier: 'plus' | 'pro' | 'prime';
  duration_months: number;
  price_iqd: number | null; // null = unpriced — honest "not purchasable yet"
  purchasable: boolean;
  sort: number;
}

interface LaunchInfo { launch_at: string | null; activated: boolean }

interface ApiMembership {
  id: string;
  plan_id: string;
  tier: 'plus' | 'pro' | 'prime';
  state: 'pending_payment' | 'prepaid_pending_launch' | 'active' | 'expired' | 'cancelled' | string;
  duration_months: number;
  price_paid_iqd: number;
  purchased_at: string;
  starts_at: string | null;
  expires_at: string | null;
  source: string;
}

interface TierStatus {
  tier: 'free' | 'plus' | 'pro' | 'prime';
  active: boolean;
  expires_at: string | null;
  pending_launch: { tier: 'plus' | 'pro'; duration_months: number } | null;
}

interface MineResponse {
  status: TierStatus;
  memberships: ApiMembership[];
  launch: LaunchInfo;
}

// ------------------------------------------------------------ tier styling
//
// The plan gallery used to be a WebGL carousel (CircularGallery) fed by
// canvas-rendered images of each card. It was replaced by ordinary DOM cards
// in a responsive grid, for two reasons the owner hit directly:
//
//   * RATIO. The carousel was laid out in world units with a fixed 450px
//     stage and `bend`, so the cards kept their own proportions regardless of
//     the viewport and spilled off the sides of a tablet in portrait. A grid
//     of `aspect-[3/4]` cards fits any width by construction.
//   * ANIMATION. It span, tilted and bounced. Plain cards do not.
//
// Dropping it also removes a canvas rasterisation per plan per tier switch,
// and an OGL/WebGL context on a page that only ever needed three prices.

interface TierStyle {
  ring: string;
  chip: string;
  accentText: string;
  glow: string;
  Icon: typeof Sparkles;
}

const TIER_STYLE: Record<'plus' | 'pro' | 'prime', TierStyle> = {
  plus: {
    ring: 'border-olive/60 bg-olive/10',
    chip: 'bg-olive/20 text-olive border-olive/40',
    accentText: 'text-olive',
    glow: 'bg-olive/15',
    Icon: Zap,
  },
  prime: {
    ring: 'border-gold/60 bg-gold/10',
    chip: 'bg-gold/20 text-gold border-gold/40',
    accentText: 'text-gold',
    glow: 'bg-gold/10',
    Icon: Crown,
  },
  pro: {
    ring: 'border-[#B03142]/70 bg-[#B03142]/10',
    chip: 'bg-[#B03142]/20 text-[#e06070] border-[#B03142]/40',
    accentText: 'text-[#e06070]',
    glow: 'bg-[#B03142]/15',
    Icon: Sparkles,
  },
};

export default function Subscription() {
  const { t, lang, loc } = useLanguage();
  const [showCardDetails, setShowCardDetails] = useState(false);
  const [activeTab, setActiveTab] = useState<'plus' | 'pro' | 'prime'>('pro');
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const { refreshWallet } = useWallet();
  const { user, refreshUser } = useAuth();
  const [purchaseMsg, setPurchaseMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [launch, setLaunch] = useState<LaunchInfo | null>(null);
  const [mine, setMine] = useState<MineResponse | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);

  const loadMine = React.useCallback(() => {
    if (!user) { setMine(null); return; }
    api
      .get<MineResponse>('/api/memberships/mine')
      .then((data) => setMine(data))
      .catch(() => setMine(null));
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<{ plans: ApiPlan[]; launch: LaunchInfo }>('/api/memberships/plans')
      .then((data) => {
        if (cancelled) return;
        setPlans(data.plans || []);
        setLaunch(data.launch || null);
      })
      .catch(() => { if (!cancelled) setPlans([]); });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => { loadMine(); }, [loadMine]);

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

  // Current tier: the memberships ledger is authoritative once loaded;
  // fall back to the session's legacy cache while it loads.
  const now = Date.now();
  const legacyActive =
    !!user &&
    user.membership_tier !== 'free' &&
    (user.subscription_expiry === 0 || user.subscription_expiry > now);
  const currentPlan: 'free' | 'plus' | 'pro' | 'prime' = mine
    ? (mine.status.active ? mine.status.tier : 'free')
    : (legacyActive ? user!.membership_tier : 'free');
  const currentExpiry = mine
    ? mine.status.expires_at
    : (legacyActive && user?.subscription_expiry ? new Date(user.subscription_expiry).toISOString() : null);
  const pendingLaunch = mine?.status.pending_launch ?? null;

  const tierPlans = React.useMemo(
    () => (plans || []).filter((p) => p.tier === activeTab).sort((a, b) => a.sort - b.sort || a.duration_months - b.duration_months),
    [plans, activeTab]
  );

  // Keep the selection valid for the visible tier.
  React.useEffect(() => {
    if (tierPlans.length === 0) { setSelectedPlanId(''); return; }
    if (!tierPlans.some((p) => p.id === selectedPlanId)) setSelectedPlanId(tierPlans[0].id);
  }, [tierPlans, selectedPlanId]);

  const selectedPlan = tierPlans.find((p) => p.id === selectedPlanId) || null;

  /** Tier order follows the server's own `sort` column, so the owner reorders
   *  the tabs from the memberships admin without a code change. */
  const tiers = React.useMemo(() => {
    const firstSort = new Map<string, number>();
    for (const p of plans || []) {
      const cur = firstSort.get(p.tier);
      if (cur === undefined || p.sort < cur) firstSort.set(p.tier, p.sort);
    }
    return (['plus', 'prime', 'pro'] as const).filter((x) => firstSort.has(x)).sort(
      (a, b) => (firstSort.get(a) ?? 0) - (firstSort.get(b) ?? 0)
    );
  }, [plans]);

  // Never leave the page on a tab the catalog does not offer.
  React.useEffect(() => {
    if (tiers.length && !tiers.includes(activeTab)) setActiveTab(tiers[0]);
  }, [tiers, activeTab]);

  const stateChip = (state: string): { label: string; cls: string } => {
    switch (state) {
      case 'active':
        return { label: loc('فعالة', 'Active', 'چالاکە'), cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' };
      case 'prepaid_pending_launch':
        return { label: loc('محجوزة حتى الإطلاق', 'Reserved until launch', 'پارێزراوە تا دەستپێک'), cls: 'bg-sky-500/15 text-sky-400 border-sky-500/30' };
      case 'pending_payment':
        return { label: loc('بانتظار الدفع', 'Pending payment', 'چاوەڕێی پارەدان'), cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' };
      case 'expired':
        return { label: loc('منتهية', 'Expired', 'بەسەرچووە'), cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40' };
      case 'cancelled':
        return { label: loc('ملغاة', 'Cancelled', 'هەڵوەشێنراوەتەوە'), cls: 'bg-red-500/15 text-red-400 border-red-500/30' };
      default:
        return { label: state, cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40' };
    }
  };

  const showMsg = (kind: 'ok' | 'err', text: string, ms = 8000) => {
    setPurchaseMsg({ kind, text });
    window.setTimeout(() => setPurchaseMsg(null), ms);
  };

  const handleSubscribe = async () => {
    if (isSubscribing || !selectedPlan) return;
    if (!user) {
      showMsg('err', loc('يرجى تسجيل الدخول للاشتراك.', 'Please sign in to subscribe.', 'تکایە بچۆ ژوورەوە بۆ بەشداریکردن.'), 4000);
      return;
    }
    if (!selectedPlan.purchasable) return; // honest disabled state — never a fake purchase
    setIsSubscribing(true);
    try {
      // The server validates the plan, applies any upgrade credit, and
      // charges the wallet — the client only reports the REAL result.
      const res = await api.post<{
        replay: boolean;
        membership: ApiMembership;
        charged_iqd: number;
        credit_iqd: number;
      }>('/api/memberships/subscribe', {
        planId: selectedPlan.id,
        idempotencyKey: newIdempotencyKey(),
      });
      await Promise.all([refreshUser(), refreshWallet()]);
      loadMine();
      const m = res.membership;
      const tierName = m.tier === 'pro' ? 'PRO' : 'PLUS';
      if (m.state === 'active') {
        showMsg('ok', loc(
          `تم تفعيل اشتراك ${tierName} — ${t('activeUntil')} ${fmtDate(m.expires_at)}`,
          `${tierName} membership is now active — ${t('activeUntil').toLowerCase()} ${fmtDate(m.expires_at)}`,
          `ئەندامێتی ${tierName} چالاک کرا — ${t('activeUntil')} ${fmtDate(m.expires_at)}`
        ) + (res.credit_iqd > 0 ? ` (${loc('خُصم رصيد ترقية', 'upgrade credit applied', 'کرێدیتی نوێکردنەوە هەژمار کرا')}: ${formatIqd(res.credit_iqd)})` : ''));
      } else if (m.state === 'prepaid_pending_launch') {
        showMsg('ok', t('launchNote') + (launch?.launch_at ? ` — ${fmtDate(launch.launch_at)}` : ''));
      } else {
        // Any other state is reported verbatim — no fabricated success.
        showMsg('ok', `${t('status')}: ${stateChip(m.state).label}`);
      }
    } catch (err: any) {
      // Server errors (INSUFFICIENT_BALANCE, PLAN_UNPRICED, ALREADY_SUBSCRIBED…)
      // arrive with bilingual messages — surface them verbatim.
      showMsg('err', err?.message || loc('فشل الاشتراك — حاول مرة أخرى', 'Subscription failed — please try again', 'بەشداریکردن سەرکەوتوو نەبوو — دووبارە هەوڵ بدەرەوە'));
    } finally {
      setIsSubscribing(false);
    }
  };

  // Cosmetic membership number derived from the user id (never stored).
  const cardNumber = user ? generateConsistentNumber(user.id) : '---- ---- ---- ----';
  const fullNumber = cardNumber;
  const maskedNumber = user ? `**** **** **** ${cardNumber.slice(-4)}` : '---- ---- ---- ----';

  const SoonChip = () => (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30 whitespace-nowrap shrink-0">
      {t('comingSoon')}
    </span>
  );

  // Benefit lists — live benefits come from what the backend actually
  // enforces (entitlements); unshipped ones are marked "coming soon".
  const plusLive: string[] = [
    loc('ملف تاجر احترافي في مجتمع ليفو', 'Professional merchant profile in the Levo community', 'پڕۆفایلی بازرگانی پیشەیی لە کۆمەڵگەی Levo'),
    // The store benefits. Every one of these is backed by a server-side
    // entitlement check and a working screen — none is an advertised promise
    // with nothing behind it.
    loc('متجرك الخاص في مجتمع ليفو', 'Your own store in the Levo community', 'فرۆشگای تایبەتی خۆت لە کۆمەڵگەی Levo'),
    loc('رابط فرعي خاص بمتجرك (اسمك.levonis-iq.com)', 'Your own store address (yourname.levonis-iq.com)', 'ناونیشانی تایبەتی فرۆشگاکەت (ناوەکەت.levonis-iq.com)'),
    loc('لوحة تحكم كاملة: منتجات، طلبات، رسائل، تحليلات', 'A full dashboard: products, orders, messages, analytics', 'داشبۆردی تەواو: بەرهەم، داواکاری، نامە، شیکاری'),
    loc('استقبال الطلبات والدفع عبر منصة ليفونيس', 'Take orders and payments through the LEVONIS platform', 'وەرگرتنی داواکاری و پارەدان لە ڕێگەی پلاتفۆرمی LEVONIS'),
    loc('تقديم عروض على طلبات العملاء المخصصة', 'Submit offers on custom customer requests', 'پێشکەشکردنی ئۆفەر بۆ داواکارییە تایبەتەکانی کڕیاران'),
    loc('متابعون وتقييمات وسمعة تاجر', 'Followers, reviews and merchant reputation', 'شوێنکەوتوان، هەڵسەنگاندن و ناوبانگی بازرگان'),
    loc('الوصول إلى الأقسام الحصرية: العروض الخاصة، البندلات، الفيلامنت العشوائي', 'Access to exclusive sections: special offers, bundles, random filament', 'دەستگەیشتن بە بەشە تایبەتەکان: ئۆفەرەکان، پاکێجەکان، فیلامێنتی هەڕەمەکی'),
    loc('أهلية كوبونات PLUS الحصرية', 'Eligibility for PLUS-only coupons', 'شیاوی کۆپۆنە تایبەتەکانی PLUS'),
    t('benefitPlus5'),
  ];
  // What is left. BNPL is not a screen that has not been built — it is a set
  // of business rules (eligibility, ceilings, what happens when someone does
  // not pay) that the owner has not decided, and inventing them would be
  // worse than saying so.
  const plusSoon: string[] = [
    loc('اشترِ الآن وادفع لاحقًا (BNPL)', 'Buy now, pay later (BNPL)', 'ئێستا بکڕە و دواتر پارە بدە (BNPL)'),
  ];
  const proLive: string[] = [
    t('benefitPro1'),
    loc('أسعار PRO خاصة على المنتجات التي حُدد لها سعر PRO', 'PRO prices on products with an explicit PRO price', 'نرخی تایبەتی PRO بۆ ئەو بەرهەمانەی نرخی PRO یان بۆ دانراوە'),
    loc('توصيل مجاني (آخر ميل) لجميع الطلبات', 'Free last-mile delivery on all orders', 'گەیاندنی بێبەرامبەر بۆ هەموو داواکاریەکان'),
    loc('إعفاء من عمولة النقل للطلبات المسبقة (جوي / بحري / بري)', 'Preorder transport commission waived (air / sea / land)', 'لێبوردن لە کۆمیشنی گواستنەوەی پێش-داواکاری (ئاسمانی / دەریایی / وشکانی)'),
    loc('شارة تاجر موثّق وأهلية الإعلانات', 'Verified merchant badge and advertising eligibility', 'نیشانەی بازرگانی پشتڕاستکراو و شیاوی ڕیکلام'),
    loc('أولوية في تجهيز الطلبات والدعم', 'Priority in order preparation and support', 'پێشینە لە ئامادەکردنی داواکاری و پشتیوانی'),
    loc('منتجات وعروض حصرية لأعضاء PRO', 'PRO-only products and offers', 'بەرهەم و ئۆفەری تایبەت بە ئەندامانی PRO'),
    t('benefitPro4'),
  ];
  // LEVO PRIME — exactly what the server enforces, and nothing more. §5 is
  // explicit that PRIME grants no other PRO benefit automatically, so the list
  // stays short on purpose rather than borrowing PRO's lines.
  const primeLive: string[] = [
    loc(
      'توصيل مجاني عندما تتجاوز قيمة البضاعة 150,000 د.ع بعد الخصومات والكوبونات والنقاط',
      'Free delivery when merchandise exceeds 150,000 IQD after discounts, coupons and points',
      'گەیاندنی خۆڕایی کاتێک نرخی کاڵاکان لە ١٥٠,٠٠٠ د.ع تێدەپەڕێت دوای داشکاندن و کۆپۆن و خاڵ',
    ),
    loc(
      'أسعار PRIME على المنتجات التي حُدد لها سعر PRIME',
      'PRIME prices on products with an explicit PRIME price',
      'نرخی PRIME بۆ ئەو بەرهەمانەی نرخی PRIME یان بۆ دانراوە',
    ),
    loc(
      'اشتراك سنوي واحد — لا تجديد شهري',
      'A single annual subscription — no monthly renewal',
      'یەک بەشداریی ساڵانە — نوێکردنەوەی مانگانە نییە',
    ),
  ];

  const proSoon: string[] = [
    loc('اشترِ الآن وادفع لاحقًا (BNPL)', 'Buy now, pay later (BNPL)', 'ئێستا بکڕە و دواتر پارە بدە (BNPL)'),
    loc('توصيل خلال 12 ساعة', '12-hour delivery', 'گەیاندن لە ماوەی ١٢ کاتژمێردا'),
    loc('نطاق خاص لمتجرك', 'Custom domain for your store', 'دۆمەینی تایبەت بۆ فرۆشگاکەت'),
    loc('كوبونات خصم خاصة', 'Exclusive discount coupons', 'کۆپۆنی داشکاندنی تایبەت'),
  ];

  return (
    <div className="w-full text-zinc-300 pb-24 overflow-y-auto min-h-screen bg-[#0a0a0a] relative">
      {/* Background ambient light */}
      <div className={`fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg h-[600px] ${activeTab === 'pro' ? 'bg-[#B03142]/15' : 'bg-olive/15'} rounded-full blur-[120px] pointer-events-none z-0 transition-colors duration-700`}></div>

      {/* 1. Top Section - ID Card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="pt-8 px-4 sm:px-6 mb-10 flex flex-col items-center relative z-10"
      >
        <h2 className="text-xl font-bold text-gold mb-6 text-center tracking-tight">{t('yourLevoCard')}</h2>

        {/* The card no longer tilts on hover and no longer runs PixelCard's
            animated canvas: the owner asked for the animation to go, and a
            membership card that reacts to a pointer is meaningless on the
            iPad this is mostly read on. */}
        <div className="w-full max-w-sm relative">

          <div className="w-full h-full">
            <div
              className={`relative backdrop-blur-2xl border border-white/20 rounded-[24px] p-6 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.5)] overflow-hidden aspect-[1.58/1] flex flex-col justify-between w-full h-full ${
                currentPlan === 'pro'
                  ? 'bg-gradient-to-br from-red-900/40 via-black/80 to-black/90'
                  : currentPlan === 'plus'
                  ? 'bg-gradient-to-br from-olive/40 via-black/80 to-black/90'
                  : 'bg-gradient-to-br from-zinc-800/80 to-zinc-900/90'
              }`}
            >
            {/* Glass reflections */}

            <div className="absolute inset-0 bg-gradient-to-tr from-white/5 to-transparent pointer-events-none"></div>
            <div className="absolute top-0 left-0 right-0 h-1/2 bg-gradient-to-b from-white/10 to-transparent opacity-50 rounded-t-[24px] pointer-events-none"></div>

            <div className="flex justify-between items-start z-10">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-olive to-black flex items-center justify-center text-white font-bold text-sm shadow-[inset_0_2px_4px_rgba(255,255,255,0.2)]">
                  {user?.name ? user.name.charAt(0).toUpperCase() : 'L'}
                </div>
                <span className="font-bold text-white tracking-wide text-lg drop-shadow-sm">{user?.name || 'Levo User'}</span>
              </div>
              <button
                onClick={() => setShowCardDetails(!showCardDetails)}
                className="text-zinc-400 hover:text-white transition-colors p-2 rounded-full bg-white/5 hover:bg-white/10 backdrop-blur-md"
              >
                {showCardDetails ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>


            <div className="z-10 mt-4 flex items-center justify-between">
              <svg viewBox="0 0 40 30" className="w-10 h-8 opacity-80" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="40" height="30" rx="4" fill="#D4AF37" fillOpacity="0.8"/>
                <path d="M10 0V30 M20 0V30 M30 0V30 M0 10H40 M0 20H40" stroke="#B8860B" strokeWidth="1"/>
                <path d="M5 5 H15 V15 H5 Z" stroke="#B8860B" strokeWidth="1" fill="none"/>
              </svg>
            </div>
            <div className="z-10 mt-4 relative h-8 flex items-center">
              <AnimatePresence mode="wait">
                <motion.p
                  key={showCardDetails ? 'full' : 'masked'}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="font-mono text-[19px] sm:text-[22px] tracking-[0.1em] whitespace-nowrap text-white absolute w-full drop-shadow-md"
                >
                  {showCardDetails ? fullNumber : maskedNumber}
                </motion.p>
              </AnimatePresence>
            </div>
            <p className="text-zinc-400 text-[10px] font-bold uppercase tracking-[0.2em] mt-1 z-10">Levo ID</p>

            <div className="flex justify-between items-end z-10 mt-auto">
              <div>
                <p className="text-white font-bold text-[15px] tracking-wide mb-1 drop-shadow-sm">@{user?.username || 'username'}</p>
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full shadow-[0_0_8px_currentColor] ${
                    currentPlan === 'pro' ? 'bg-[#B03142] text-[#B03142]' :
                    currentPlan === 'plus' ? 'bg-olive text-olive' : 'bg-zinc-400 text-zinc-400'
                  }`}></span>
                  <p className="text-xs text-zinc-400 font-medium capitalize">{currentPlan} Tier</p>
                </div>
              </div>
              <div className="text-right flex flex-col items-end gap-2">
                {currentExpiry && currentPlan !== 'free' && (
                  <div className="flex flex-col items-end">
                    <p className="text-zinc-400 text-[9px] font-bold uppercase tracking-[0.1em] mb-0.5 opacity-80">Valid Thru</p>
                    <p className="text-white font-mono text-[11px] tracking-wider">{new Date(currentExpiry).toLocaleDateString('en-GB', { month: '2-digit', year: '2-digit' })}</p>
                  </div>
                )}
                <div className="flex flex-col items-end">
                  <p className="text-zinc-400 text-[9px] font-bold uppercase tracking-[0.2em] mb-0.5">{t('status')}</p>
                  <p className={`text-[11px] font-bold px-2 py-0.5 rounded-md backdrop-blur-md border shadow-sm ${
                    currentPlan !== 'free'
                      ? 'bg-white/10 text-white border-white/20'
                      : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50'
                  }`}>
                    {currentPlan !== 'free' ? t('active') : 'Free'}
                  </p>
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>

        {/* Prepaid-pending-launch state on the card holder's account */}
        {pendingLaunch && (
          <div className="mt-4 w-full max-w-sm bg-sky-500/10 border border-sky-500/30 rounded-2xl px-4 py-3 text-center">
            <p className="text-sky-300 text-[13px] font-bold mb-0.5">
              {(pendingLaunch.tier === 'pro' ? 'PRO' : 'PLUS') + ` — ${pendingLaunch.duration_months} ${t('months')}`}
            </p>
            <p className="text-sky-200/80 text-[12px]">
              {t('launchNote')}{launch?.launch_at ? ` — ${fmtDate(launch.launch_at)}` : ''}
            </p>
          </div>
        )}

        {/* PRO identity verification (KYC) — deliberately here in the
            membership area, never in the public profile (final phase §9). */}
        {(currentPlan === 'pro' || pendingLaunch?.tier === 'pro') && (
          <div className="mt-4 w-full max-w-sm">
            <KycSection />
          </div>
        )}
      </motion.div>

      {/* 2. Middle Section - Subscription Plans */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1, ease: "easeOut" }}
        className="px-4 sm:px-6 mb-12 max-w-lg mx-auto relative z-10"
      >
        <h3 className="text-lg font-bold text-gold mb-5 text-center">{t('choosePlan')}</h3>

        {/* Tier tabs. A plain segmented control: it holds three tiers instead
            of two, it is keyboard- and screen-reader-addressable, and it does
            not animate. Widths are equal fractions so PLUS / PRIME / PRO fit
            a 360px phone without wrapping. */}
        <div
          role="tablist"
          aria-label={t('choosePlan')}
          className="mb-6 grid gap-1 p-1 bg-zinc-900/60 backdrop-blur-xl border border-white/10 rounded-2xl"
          style={{ gridTemplateColumns: `repeat(${Math.max(tiers.length, 1)}, minmax(0, 1fr))` }}
        >
          {tiers.map((tier) => {
            const st = TIER_STYLE[tier];
            const on = activeTab === tier;
            return (
              <button
                key={tier}
                role="tab"
                aria-selected={on}
                data-tier-tab={tier}
                onClick={() => { setActiveTab(tier); setSelectedPlanId(''); }}
                className={`min-h-11 min-w-0 rounded-xl px-2 flex items-center justify-center gap-1.5 text-[13px] font-black tracking-wide transition-colors ${
                  on ? `${st.chip} border` : 'text-zinc-400 border border-transparent hover:text-white'
                }`}
              >
                <st.Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{tier.toUpperCase()}</span>
              </button>
            );
          })}
        </div>

        {/* Plan cards. A responsive grid, so the layout is decided by the
            viewport rather than by a fixed WebGL stage: one column on a phone,
            two from 400px, three from 640px, each card a fixed 3:4 so the
            proportions hold at every width. */}
        {plans === null ? (
          <div className="py-16 flex justify-center">
            <div className="w-8 h-8 border-2 border-white/10 border-t-white/60 rounded-full animate-spin" />
          </div>
        ) : tierPlans.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 text-sm">
            {loc('لا توجد خطط متاحة حاليًا', 'No plans are available right now', 'لە ئێستادا هیچ پلانێک بەردەست نییە')}
          </div>
        ) : (
          <div
            className="grid gap-3 mb-8 justify-items-center"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 9.5rem), 1fr))' }}
          >
            {tierPlans.map((p) => {
              const st = TIER_STYLE[p.tier];
              const priced = p.price_iqd !== null; // null = unpriced; 0 is a real price
              const on = selectedPlanId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-plan={p.id}
                  aria-pressed={on}
                  onClick={() => setSelectedPlanId(p.id)}
                  // Capped, not stretched: each tier now sells a single annual
                  // plan, and a lone card allowed to fill a 390px phone would
                  // be ~490px tall of mostly empty space.
                  className={`w-full max-w-[13rem] min-w-0 aspect-[3/4] rounded-2xl border p-3 flex flex-col items-center justify-between text-center transition-colors ${
                    on ? st.ring : 'border-white/10 bg-zinc-900/40 hover:border-white/25'
                  }`}
                >
                  <span className={`text-[10px] font-black tracking-widest ${on ? st.accentText : 'text-zinc-500'}`}>
                    {p.tier.toUpperCase()}
                  </span>

                  <span className="flex flex-col items-center min-w-0">
                    <span className="text-white font-black leading-none text-[clamp(1.75rem,9vw,2.75rem)]" dir="ltr">
                      {p.duration_months}
                    </span>
                    <span className="text-zinc-400 text-[12px] mt-1">
                      {p.duration_months === 1 ? t('month') : t('months')}
                    </span>
                  </span>

                  <span className="flex flex-col items-center min-w-0 w-full">
                    {priced ? (
                      <>
                        <span className="text-white font-bold text-[13px] truncate max-w-full" dir="ltr">
                          {formatIqd(p.price_iqd as number)}
                        </span>
                        <span className="text-zinc-500 text-[10.5px] truncate max-w-full" dir="ltr">
                          {formatIqd(Math.round((p.price_iqd as number) / p.duration_months))} / {t('month')}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-amber-400 font-bold text-[12px] truncate max-w-full">{t('priceTBA')}</span>
                        <span className="text-[10px] text-amber-500/80">{t('comingSoon')}</span>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </motion.div>

      <StoreCta />

      {/* 3. Subscribe action + honest launch note */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
        className="px-4 sm:px-6 mb-12 max-w-lg mx-auto relative z-10"
      >
        <AnimatePresence>
          {purchaseMsg && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={`p-3 mb-4 text-sm text-center rounded-xl font-medium border z-20 shadow-lg ${
                purchaseMsg.kind === 'ok'
                  ? 'bg-emerald-900/40 text-emerald-200 border-emerald-500/30'
                  : 'bg-red-900/40 text-red-200 border-red-500/30'
              }`}
            >
              {purchaseMsg.text}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Selected plan summary */}
        {selectedPlan && (
          <div className="mb-4 flex items-center justify-between bg-zinc-900/50 border border-white/10 rounded-2xl px-4 py-3">
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-black px-2 py-0.5 rounded-md ${selectedPlan.tier === 'pro' ? 'bg-[#B03142]/20 text-[#e06070]' : 'bg-olive/20 text-olive'}`}>
                {selectedPlan.tier.toUpperCase()}
              </span>
              <span className="text-white font-bold text-[14px]">
                {selectedPlan.duration_months} {selectedPlan.duration_months === 1 ? t('month') : t('months')}
              </span>
            </div>
            <span className={`font-bold text-[14px] ${selectedPlan.price_iqd !== null ? 'text-white' : 'text-amber-400'}`}>
              {selectedPlan.price_iqd !== null ? formatIqd(selectedPlan.price_iqd) : t('priceTBA')}
            </span>
          </div>
        )}

        <motion.button
          whileHover={selectedPlan?.purchasable ? { scale: 1.02 } : undefined}
          whileTap={selectedPlan?.purchasable ? { scale: 0.98 } : undefined}
          onClick={handleSubscribe}
          disabled={isSubscribing || !selectedPlan || !selectedPlan.purchasable}
          className={`w-full h-14 rounded-2xl font-black text-[17px] transition-all tracking-wide mb-3 ${
            selectedPlan && !selectedPlan.purchasable
              ? 'bg-zinc-800 text-zinc-500 border border-zinc-700 cursor-not-allowed'
              : 'bg-white text-black hover:bg-zinc-200 shadow-[0_0_20px_rgba(255,255,255,0.15)] disabled:opacity-60 disabled:cursor-wait'
          }`}
        >
          {isSubscribing
            ? '…'
            : selectedPlan && !selectedPlan.purchasable
            ? `${t('subscribeDisabled')} — ${t('priceTBA')}`
            : t('subscribeNow')}
        </motion.button>

        {/* Honest pre-launch note: paid cards are reserved, not started */}
        {launch && !launch.activated && (
          <p className="text-center text-[12px] text-sky-300/80 mb-6 flex items-center justify-center gap-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            {t('launchNote')}{launch.launch_at ? ` — ${fmtDate(launch.launch_at)}` : ''}
          </p>
        )}

        {/* My memberships ledger with real state chips */}
        {user && mine && mine.memberships.length > 0 && (
          <div className="mb-8 bg-zinc-900/40 backdrop-blur-xl border border-white/10 rounded-[24px] p-5">
            <h4 className="text-white font-bold text-[15px] mb-4">{t('membership')}</h4>
            <ul className="space-y-3">
              {mine.memberships.map((m) => {
                const chip = stateChip(m.state);
                return (
                  <li key={m.id} className="flex items-center justify-between gap-2 text-[13px]">
                    <div className="min-w-0">
                      <span className="text-white font-bold">
                        {(m.tier === 'pro' ? 'PRO' : 'PLUS')} · {m.duration_months} {m.duration_months === 1 ? t('month') : t('months')}
                      </span>
                      <p className="text-zinc-500 text-[11px] truncate">
                        {m.state === 'active' && m.expires_at
                          ? `${t('activeUntil')} ${fmtDate(m.expires_at)}`
                          : m.state === 'prepaid_pending_launch'
                          ? t('pendingLaunch')
                          : fmtDate(m.purchased_at)}
                      </p>
                    </div>
                    <span className={`text-[11px] font-bold px-2 py-1 rounded-full border whitespace-nowrap shrink-0 ${chip.cls}`}>
                      {chip.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="relative rounded-[24px] overflow-hidden bg-zinc-900/40 backdrop-blur-xl border border-white/10 shadow-2xl group">
          <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-olive/20 via-olive/5 to-transparent rounded-bl-full pointer-events-none mix-blend-screen transition-opacity group-hover:opacity-100 opacity-60"></div>

          <div className="p-6 flex flex-col items-center text-center relative z-10">
            <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-md border border-white/10 flex items-center justify-center mb-4 text-white shadow-xl group-hover:scale-110 group-hover:border-olive/50 transition-all duration-500 ease-out">
              <Printer className="w-8 h-8 text-olive group-hover:text-white transition-colors" />
            </div>
            <h3 className="text-[20px] font-bold text-white mb-2 tracking-tight">{t('tangiblePhysicalCard')}</h3>
            <p className="text-[14px] text-zinc-400 mb-6 max-w-[280px] leading-relaxed">
              {t('levoIdSubtext')}
            </p>
            <div className="inline-flex items-center gap-1.5 bg-black/40 backdrop-blur-md border border-white/10 rounded-full px-4 py-2 shadow-inner">
              <Zap className="w-4 h-4 text-[#B03142]" fill="currentColor" />
              <span className="text-[11px] font-bold text-[#B03142] uppercase tracking-[0.1em]">{t('unlockedWithAnnual')}</span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* 4. Benefits Breakdown */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.3, ease: "easeOut" }}
        className="px-4 sm:px-6 max-w-lg mx-auto relative z-10"
      >
        <h3 className="text-[17px] font-bold text-white mb-6 flex items-center justify-center gap-2 px-1">
          {t('planComparisons')} <Info className="w-4 h-4 text-zinc-500" />
        </h3>

        <div className="space-y-4">
          <div className="bg-zinc-900/30 backdrop-blur-xl border border-white/5 rounded-[24px] p-6 shadow-lg">
            <h4 className="text-white font-bold mb-5 flex items-center gap-2.5 text-[16px]">
              <div className="w-2.5 h-2.5 rounded-full bg-olive shadow-[0_0_10px_var(--color-olive)]"></div> {t('plusBenefits')}
            </h4>
            <ul className="space-y-4">
              {plusLive.map((text, i) => (
                <li key={`pl-${i}`} className="flex items-start gap-3 text-[14.5px] text-zinc-400">
                  <Check className="w-5 h-5 text-olive shrink-0 mt-0.5" strokeWidth={2.5} />
                  <span className="text-[14.5px] font-normal leading-normal">{text}</span>
                </li>
              ))}
              {plusSoon.map((text, i) => (
                <li key={`ps-${i}`} className="flex items-start gap-3 text-[14.5px] text-zinc-500">
                  <Clock className="w-5 h-5 text-amber-500/70 shrink-0 mt-0.5" strokeWidth={2.5} />
                  <span className="leading-normal">{text}</span>
                  <SoonChip />
                </li>
              ))}
            </ul>
          </div>

          {/* LEVO PRIME */}
          <div className="bg-zinc-900/30 backdrop-blur-xl border border-gold/20 rounded-[24px] p-6 shadow-lg">
            <h4 className="text-gold font-bold mb-5 flex items-center gap-2.5 text-[16px]">
              <Crown className="w-5 h-5" />
              {loc('مزايا LEVO PRIME', 'LEVO PRIME benefits', 'تایبەتمەندییەکانی LEVO PRIME')}
            </h4>
            <ul className="space-y-4">
              {primeLive.map((text, i) => (
                <li key={`pm-${i}`} className="flex items-start gap-3 text-[14.5px] text-zinc-400">
                  <Check className="w-5 h-5 text-gold shrink-0 mt-0.5" strokeWidth={2.5} />
                  <span className="text-[14.5px] font-normal leading-normal">{text}</span>
                </li>
              ))}
            </ul>
            {/* The exact threshold, said plainly rather than rounded in prose:
                150,000 is NOT free, 150,001 is. */}
            <p className="mt-5 pt-4 border-t border-white/5 text-[11.5px] text-zinc-500 leading-relaxed flex items-start gap-2">
              <Truck className="w-4 h-4 shrink-0 mt-0.5 text-zinc-600" />
              {loc(
                'الإعفاء يشمل رسوم التوصيل الاعتيادية فقط، ويبدأ فوق 150,000 د.ع تمامًا — طلب بقيمة 150,000 لا يُعفى.',
                'The waiver covers ordinary delivery only, and starts strictly above 150,000 IQD — an order of exactly 150,000 is not waived.',
                'لێبوردنەکە تەنها گەیاندنی ئاسایی دەگرێتەوە، و بە تەواوی لە سەرووی ١٥٠,٠٠٠ د.ع دەست پێدەکات — داواکاریی ١٥٠,٠٠٠ لێی نابوردرێت.',
              )}
            </p>
          </div>

          <div className="bg-zinc-900/60 backdrop-blur-xl border border-[#B03142]/20 rounded-[24px] p-6 relative overflow-hidden shadow-[0_10px_30px_-15px_rgba(176,49,66,0.2)]">
            <div className="absolute top-0 right-0 w-32 h-32 bg-[#B03142]/10 rounded-bl-[100px] pointer-events-none mix-blend-screen blur-xl"></div>
            <h4 className="text-[#B03142] font-bold mb-5 flex items-center gap-2 text-[16px] drop-shadow-sm">
              <Sparkles className="w-5 h-5" /> {t('proBenefits')}
            </h4>
            <ul className="space-y-4 relative z-10">
              {proLive.map((text, i) => (
                <li key={`prl-${i}`} className="flex items-start gap-3 text-[14.5px] text-zinc-300">
                  <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                  <span className="text-[14.5px] font-normal leading-normal">{text}</span>
                </li>
              ))}
              {proSoon.map((text, i) => (
                <li key={`prs-${i}`} className="flex items-start gap-3 text-[14.5px] text-zinc-500">
                  <Clock className="w-5 h-5 text-amber-500/70 shrink-0 mt-0.5" strokeWidth={2.5} />
                  <span className="leading-normal">{text}</span>
                  <SoonChip />
                </li>
              ))}
            </ul>
            {/* Honest fine print: warranty fees are never waived for any tier */}
            <p className="mt-5 pt-4 border-t border-white/5 text-[11.5px] text-zinc-500 leading-relaxed relative z-10">
              {loc(
                'ملاحظة: رسوم الضمان تُضاف دائمًا ولا تُعفى لأي فئة عضوية.',
                'Note: warranty fees are always added and are never waived for any membership tier.',
                'تێبینی: کرێی گەرەنتی هەمیشە زیاد دەکرێت و بۆ هیچ ئاستێکی ئەندامێتی نابەخشرێت.'
              )}
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
