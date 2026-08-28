import React, { useState } from 'react';
import { useLanguage } from '../LanguageContext';
import { Check, Zap, Eye, EyeOff, Printer, Info, Sparkles, Clock } from 'lucide-react';
import CircularGallery from "../components/CircularGallery";
import { motion, AnimatePresence } from 'motion/react';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { api, formatIqd, newIdempotencyKey } from '../lib/api';
import ScrollReveal from '../components/ScrollReveal';
import GooeyNav from '../components/GooeyNav';
import PixelCard from '../components/PixelCard';

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
  tier: 'plus' | 'pro';
  duration_months: number;
  price_iqd: number | null; // null = unpriced — honest "not purchasable yet"
  purchasable: boolean;
  sort: number;
}

interface LaunchInfo { launch_at: string | null; activated: boolean }

interface ApiMembership {
  id: string;
  plan_id: string;
  tier: 'plus' | 'pro';
  state: 'pending_payment' | 'prepaid_pending_launch' | 'active' | 'expired' | 'cancelled' | string;
  duration_months: number;
  price_paid_iqd: number;
  purchased_at: string;
  starts_at: string | null;
  expires_at: string | null;
  source: string;
}

interface TierStatus {
  tier: 'free' | 'plus' | 'pro';
  active: boolean;
  expires_at: string | null;
  pending_launch: { tier: 'plus' | 'pro'; duration_months: number } | null;
}

interface MineResponse {
  status: TierStatus;
  memberships: ApiMembership[];
  launch: LaunchInfo;
}

// -------------------------------------------------------- canvas plan card

interface CanvasPlan {
  badge: string | null;
  number: string;
  unit: string;
  perMonth: string | null; // priced plans only
  total: string | null;    // priced plans only
  tba: string | null;      // unpriced plans: "price to be announced"
  soonPill: string | null; // unpriced plans: "coming soon" pill
}

const generatePlanImage = (plan: CanvasPlan, activeTab: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const isPro = activeTab === 'pro';
  const primaryColor = isPro ? '#B03142' : '#8B9B7B';

  // Background
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#27272a');
  gradient.addColorStop(1, '#18181b');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Border
  ctx.lineWidth = 12;
  ctx.strokeStyle = primaryColor;
  ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);

  // Badge
  if (plan.badge) {
    ctx.fillStyle = primaryColor;
    ctx.fillRect(0, 0, canvas.width, 90);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(plan.badge.toUpperCase(), canvas.width / 2, 45);
  }

  // Number
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 220px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(plan.number, canvas.width / 2, 280);

  // Unit
  ctx.fillStyle = '#a1a1aa';
  ctx.font = 'bold 60px sans-serif';
  ctx.fillText(plan.unit, canvas.width / 2, 430);

  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(100, 520);
  ctx.lineTo(500, 520);
  ctx.stroke();

  if (plan.tba) {
    // Unpriced plan: honest "price to be announced" — no fabricated number.
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText(plan.tba, canvas.width / 2, 600);
    if (plan.soonPill) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      const rw = 260, rh = 70, rx = canvas.width / 2 - rw / 2, ry = 660, r = 35;
      ctx.beginPath();
      ctx.moveTo(rx + r, ry);
      ctx.lineTo(rx + rw - r, ry);
      ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
      ctx.lineTo(rx + rw, ry + rh - r);
      ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
      ctx.lineTo(rx + r, ry + rh);
      ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
      ctx.lineTo(rx, ry + r);
      ctx.quadraticCurveTo(rx, ry, rx + r, ry);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#e4e4e7';
      ctx.font = 'bold 34px sans-serif';
      ctx.fillText(plan.soonPill, canvas.width / 2, ry + rh / 2 + 2);
    }
  } else {
    // Price Per Unit
    if (plan.perMonth) {
      ctx.fillStyle = '#e4e4e7';
      ctx.font = '44px sans-serif';
      ctx.fillText(plan.perMonth, canvas.width / 2, 600);
    }
    // Total
    if (plan.total) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 44px sans-serif';
      ctx.fillText(plan.total, canvas.width / 2, 720);
    }
  }

  return canvas.toDataURL('image/png');
};

export default function Subscription() {
  const { t, lang, loc } = useLanguage();
  const [showCardDetails, setShowCardDetails] = useState(false);
  const [activeTab, setActiveTab] = useState<'plus' | 'pro'>('pro');
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
    user.subscription_plan !== 'free' &&
    (user.subscription_expiry === 0 || user.subscription_expiry > now);
  const currentPlan: 'free' | 'plus' | 'pro' = mine
    ? (mine.status.active ? mine.status.tier : 'free')
    : (legacyActive ? user!.subscription_plan : 'free');
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

  const galleryItems = React.useMemo(() => {
    return tierPlans.map((p) => {
      const priced = p.price_iqd !== null; // null = unpriced; 0 is a real explicit price
      const cp: CanvasPlan = {
        badge: p.tier === 'pro' ? 'PRO' : 'PLUS',
        number: String(p.duration_months),
        unit: p.duration_months === 1 ? t('month') : t('months'),
        perMonth: priced
          ? `${formatIqd(Math.round((p.price_iqd as number) / p.duration_months))} / ${t('month')}`
          : null,
        total: priced ? formatIqd(p.price_iqd as number) : null,
        tba: priced ? null : t('priceTBA'),
        soonPill: priced ? null : t('comingSoon'),
      };
      return { image: generatePlanImage(cp, activeTab), text: '' };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierPlans, activeTab, lang]);

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
    loc('الوصول إلى الأقسام الحصرية: العروض الخاصة، البندلات، الفيلامنت العشوائي', 'Access to exclusive sections: special offers, bundles, random filament', 'دەستگەیشتن بە بەشە تایبەتەکان: ئۆفەرەکان، پاکێجەکان، فیلامێنتی هەڕەمەکی'),
    t('benefitPlus5'),
  ];
  const plusSoon: string[] = [
    loc('اشترِ الآن وادفع لاحقًا (BNPL)', 'Buy now, pay later (BNPL)', 'ئێستا بکڕە و دواتر پارە بدە (BNPL)'),
    loc('كوبونات خصم خاصة', 'Exclusive discount coupons', 'کۆپۆنی داشکاندنی تایبەت'),
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

        <div className="w-full max-w-sm relative group perspective-[1000px]">

          <motion.div
            whileHover={{ rotateX: 5, rotateY: -5, scale: 1.02 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="w-full h-full cursor-pointer"
          >
            <PixelCard
              variant={currentPlan === 'pro' ? 'red' : currentPlan === 'plus' ? 'olive' : 'default'}
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
            </PixelCard>
          </motion.div>
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
      </motion.div>

      {/* 2. Middle Section - Subscription Plans */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1, ease: "easeOut" }}
        className="px-4 sm:px-6 mb-12 max-w-lg mx-auto relative z-10"
      >
        <h3 className="text-lg font-bold text-gold mb-5 text-center">{t('choosePlan')}</h3>

        {/* Tier Toggle */}
        <div className="mb-8 relative shadow-lg h-[60px] bg-zinc-900/60 backdrop-blur-xl border border-white/10 rounded-full flex items-center">
          <GooeyNav
            items={[
              { label: t('plus') },
              { label: <div className="flex items-center gap-1.5">{t('pro')} <Sparkles className="w-4 h-4" /></div> }
            ]}
            initialActiveIndex={activeTab === 'plus' ? 0 : 1}
            activeColor={activeTab === 'plus' ? '#8B9B7B' : '#B03142'}
            onChange={(index) => {
              setActiveTab(index === 0 ? 'plus' : 'pro');
              setSelectedPlanId('');
            }}
          />
        </div>
        {/* Circular Plans Gallery — driven by the server plan catalog */}
        {plans === null ? (
          <div className="py-16 flex justify-center">
            <div className="w-8 h-8 border-2 border-white/10 border-t-white/60 rounded-full animate-spin" />
          </div>
        ) : tierPlans.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 text-sm">
            {loc('لا توجد خطط متاحة حاليًا', 'No plans are available right now', 'لە ئێستادا هیچ پلانێک بەردەست نییە')}
          </div>
        ) : (
          <div className="pt-4 pb-4 min-h-[400px] w-screen relative left-1/2 -translate-x-1/2 mb-8">
            <div style={{ height: '450px', position: 'relative' }}>
              <CircularGallery
                key={activeTab + ':' + tierPlans.length}
                bend={3}
                textColor="#ffffff"
                borderRadius={0.1}
                scrollEase={0.08}
                fontUrl="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700&display=swap"
                font="bold 24px 'Plus Jakarta Sans'"
                scrollSpeed={3.5}
                onIndexChange={(index: number) => {
                  if (tierPlans[index]) {
                    setSelectedPlanId(tierPlans[index].id);
                  }
                }}
                items={galleryItems}
              />

              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center animate-bounce z-10 pointer-events-none">
                <div className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center shadow-[0_0_15px_rgba(255,255,255,0.1)] text-white mb-2">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        )}
      </motion.div>

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
              <div className="w-2.5 h-2.5 rounded-full bg-olive shadow-[0_0_10px_rgba(15,47,37,0.6)]"></div> {t('plusBenefits')}
            </h4>
            <ul className="space-y-4">
              {plusLive.map((text, i) => (
                <li key={`pl-${i}`} className="flex items-start gap-3 text-[14.5px] text-zinc-400">
                  <Check className="w-5 h-5 text-olive shrink-0 mt-0.5" strokeWidth={2.5} />
                  <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{text}</ScrollReveal>
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

          <div className="bg-zinc-900/60 backdrop-blur-xl border border-[#B03142]/20 rounded-[24px] p-6 relative overflow-hidden shadow-[0_10px_30px_-15px_rgba(176,49,66,0.2)]">
            <div className="absolute top-0 right-0 w-32 h-32 bg-[#B03142]/10 rounded-bl-[100px] pointer-events-none mix-blend-screen blur-xl"></div>
            <h4 className="text-[#B03142] font-bold mb-5 flex items-center gap-2 text-[16px] drop-shadow-sm">
              <Sparkles className="w-5 h-5" /> {t('proBenefits')}
            </h4>
            <ul className="space-y-4 relative z-10">
              {proLive.map((text, i) => (
                <li key={`prl-${i}`} className="flex items-start gap-3 text-[14.5px] text-zinc-300">
                  <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                  <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{text}</ScrollReveal>
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
