import React, { useState } from 'react';
import { useLanguage } from '../LanguageContext';
import { Check, Zap, Eye, EyeOff, Printer, Info, Sparkles } from 'lucide-react';
import CircularGallery from "../components/CircularGallery";
import { motion, AnimatePresence } from 'motion/react';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';
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

type ServerPlanOption = { id: string; cost_iqd: number; days: number };
type ServerPlans = { plus: ServerPlanOption[]; pro: ServerPlanOption[] };


const generatePlanImage = (plan: any, activeTab: string) => {
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
  
  // Price Per Unit
  ctx.fillStyle = '#e4e4e7';
  ctx.font = '48px sans-serif';
  ctx.fillText(plan.pricePerUnit, canvas.width / 2, 600);
  
  // Savings
  if (plan.savings) {
    ctx.fillStyle = isPro ? 'rgba(176, 49, 66, 0.8)' : 'rgba(139, 155, 123, 0.5)';
    const rw = 220, rh = 70, rx = canvas.width / 2 - rw / 2, ry = 640, r = 35;
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
    
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText(plan.savings, canvas.width / 2, ry + rh / 2 + 2);
  }
  
  // Total
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText('Total: ' + plan.total, canvas.width / 2, 750);
  
  return canvas.toDataURL('image/png');
};

export default function Subscription() {
  const { t, dir } = useLanguage();
  const [showCardDetails, setShowCardDetails] = useState(false);
  const [activeTab, setActiveTab] = useState<'plus' | 'pro'>('pro');
  const [selectedDuration, setSelectedDuration] = useState<string>('6mo');
  const { currency, exchangeRate, refreshWallet } = useWallet();
  const { user, refreshUser } = useAuth();
  const [purchaseMsg, setPurchaseMsg] = useState('');
  const [serverPlans, setServerPlans] = useState<ServerPlans | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<{ plans: ServerPlans }>('/api/subscription/plans')
      .then((data) => { if (!cancelled) setServerPlans(data.plans); })
      .catch(() => { /* keep the local display table; the server still prices the charge */ });
    return () => { cancelled = true; };
  }, []);

  const now = Date.now();
  const planIsActive =
    !!user &&
    user.subscription_plan !== 'free' &&
    (user.subscription_expiry === 0 || user.subscription_expiry > now);
  const currentPlan = planIsActive ? user!.subscription_plan : 'free';
  const subExpiration = user?.subscription_expiry || 0;


  const formatPrice = (amountIQD: number) => {
    if (currency === 'USD') {
      const amountUSD = amountIQD / exchangeRate;
      // if it's perfectly round we don't need decimals, otherwise 2 decimals
      return `$${amountUSD.toFixed(amountUSD % 1 === 0 ? 0 : 2)}`;
    }
    return `${amountIQD.toLocaleString()} د.ع`;
  };

  const plans = {
    plus: [
      { id: '1mo', number: '1', unit: t('month'), pricePerUnitIQD: 4500, savings: null, badge: null, cost: 4500, days: 30 },
      { id: '3mo', number: '3', unit: t('months'), pricePerUnitIQD: 3900, savings: '-13%', badge: null, cost: 11700, days: 90 },
      { id: '6mo', number: '6', unit: t('months'), pricePerUnitIQD: 3300, savings: '-26%', badge: t('mostPopular'), cost: 19800, days: 180 },
      { id: '1yr', number: '1', unit: t('year'), pricePerUnitIQD: 2800, savings: '-37%', badge: null, cost: 33600, days: 365 },
    ],
    pro: [
      { id: '6mo', number: '6', unit: t('months'), pricePerUnitIQD: 45000, savings: null, badge: null, cost: 270000, days: 180 },
      { id: '1yr', number: '1', unit: t('year'), pricePerUnitIQD: 37500, savings: '-16%', badge: t('mostPopular'), cost: 450000, days: 365 },
    ]
  };

  // Overlay the server-authoritative catalog when it has loaded; the local
  // table mirrors it and only drives the visuals — the charge is server-side.
  const activePlans = plans[activeTab].map(p => {
    const sp = serverPlans?.[activeTab]?.find(s => s.id === p.id);
    const cost = sp ? sp.cost_iqd : p.cost;
    const days = sp ? sp.days : p.days;
    const perMonthIqd = sp && sp.cost_iqd !== p.cost ? Math.round((cost / days) * 30) : p.pricePerUnitIQD;
    return {
      ...p,
      cost,
      days,
      pricePerUnit: `${formatPrice(perMonthIqd)}/mo`,
      total: formatPrice(cost)
    };
  });

  const galleryItems = React.useMemo(() => {
    return activePlans.map((plan) => {
      return {
        image: generatePlanImage(plan, activeTab),
        text: ''
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, serverPlans, currency]);
  
  const handleSubscribe = async () => {
    if (isSubscribing) return;
    if (!user) {
      setPurchaseMsg('Please sign in to subscribe.');
      setTimeout(() => setPurchaseMsg(''), 4000);
      return;
    }
    setIsSubscribing(true);
    try {
      // The server validates the plan, applies any upgrade credit, and
      // charges the wallet — the client only reports the result.
      const res = await api.post<{ plan: string; expiry: number; charged_iqd: number }>(
        '/api/subscription/subscribe',
        { plan: activeTab, durationId: selectedDuration }
      );
      await Promise.all([refreshUser(), refreshWallet()]);
      setPurchaseMsg(`Successfully subscribed to ${activeTab.toUpperCase()} for ${formatPrice(res.charged_iqd)}!`);
      setTimeout(() => setPurchaseMsg(''), 5000);
    } catch (err: any) {
      setPurchaseMsg(err?.message || 'Subscription failed — please try again');
      setTimeout(() => setPurchaseMsg(''), 5000);
    } finally {
      setIsSubscribing(false);
    }
  };

  // Cosmetic membership number derived from the user id (never stored).
  const cardNumber = user ? generateConsistentNumber(user.id) : '---- ---- ---- ----';
  const fullNumber = cardNumber;
  const maskedNumber = user ? `**** **** **** ${cardNumber.slice(-4)}` : '---- ---- ---- ----';


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
                {subExpiration > 0 && currentPlan !== 'free' && (
                  <div className="flex flex-col items-end">
                    <p className="text-zinc-400 text-[9px] font-bold uppercase tracking-[0.1em] mb-0.5 opacity-80">Valid Thru</p>
                    <p className="text-white font-mono text-[11px] tracking-wider">{new Date(subExpiration).toLocaleDateString('en-GB', { month: '2-digit', year: '2-digit' })}</p>
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
              if (index === 0) {
                setActiveTab('plus');
                setSelectedDuration(plans.plus[0].id);
              } else {
                setActiveTab('pro');
                setSelectedDuration(plans.pro[0].id);
              }
            }}
          />
        </div>
        {/* Circular Plans Gallery */}
        <div className="pt-4 pb-4 min-h-[400px] w-screen relative left-1/2 -translate-x-1/2 mb-8">
          <div style={{ height: '450px', position: 'relative' }}>
            <CircularGallery
              key={activeTab}
              bend={3}
              textColor="#ffffff"
              borderRadius={0.1}
              scrollEase={0.08}
              fontUrl="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700&display=swap"
              font="bold 24px 'Plus Jakarta Sans'"
              scrollSpeed={3.5}
              onIndexChange={(index: number) => {
                if (activePlans[index]) {
                  setSelectedDuration(activePlans[index].id);
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
      </motion.div>

      {/* 3. Bottom Section - Physical 3D Card Promo */}
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
              className="absolute -top-12 left-0 right-0 p-3 bg-zinc-800 text-white text-sm text-center rounded-xl font-medium border border-white/10 z-20 shadow-lg"
            >
              {purchaseMsg}
            </motion.div>
          )}
        </AnimatePresence>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleSubscribe}
          disabled={isSubscribing}
          className="w-full h-14 rounded-2xl bg-white text-black font-black text-[17px] hover:bg-zinc-200 transition-all shadow-[0_0_20px_rgba(255,255,255,0.15)] tracking-wide mb-6 disabled:opacity-60 disabled:cursor-wait"
        >
          {isSubscribing ? '…' : t('subscribeNow')}
        </motion.button>

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
              <li className="flex items-start gap-3 text-[14.5px] text-zinc-400">
                <Check className="w-5 h-5 text-olive shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{t('benefitPlus1')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-zinc-400">
                <Check className="w-5 h-5 text-olive shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{t('benefitPlus2')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-zinc-400">
                <Check className="w-5 h-5 text-olive shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{t('benefitPlus3')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-zinc-400">
                <Check className="w-5 h-5 text-olive shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{t('benefitPlus4')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-zinc-400">
                <Check className="w-5 h-5 text-olive shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{t('benefitPlus5')}</ScrollReveal>
              </li>
            </ul>
          </div>

          <div className="bg-zinc-900/60 backdrop-blur-xl border border-[#B03142]/20 rounded-[24px] p-6 relative overflow-hidden shadow-[0_10px_30px_-15px_rgba(176,49,66,0.2)]">
            <div className="absolute top-0 right-0 w-32 h-32 bg-[#B03142]/10 rounded-bl-[100px] pointer-events-none mix-blend-screen blur-xl"></div>
            <h4 className="text-[#B03142] font-bold mb-5 flex items-center gap-2 text-[16px] drop-shadow-sm">
              <Sparkles className="w-5 h-5" /> {t('proBenefits')}
            </h4>
            <ul className="space-y-4 relative z-10">
              <li className="flex items-start gap-3 text-[14.5px] text-zinc-300">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{t('benefitPro1')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-zinc-300">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{t('benefitPro2')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-zinc-300">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal">{t('benefitPro3')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-white">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] font-bold tracking-wide m-0 p-0">{t('benefitPro4')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-white">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] font-bold tracking-wide m-0 p-0">{t('benefitPro5')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-white">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] font-bold tracking-wide m-0 p-0">{t('benefitPro6')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-white">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] font-bold tracking-wide m-0 p-0">{t('benefitPro7')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-white">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] font-bold tracking-wide m-0 p-0">{t('benefitPro8')}</ScrollReveal>
              </li>
              <li className="flex items-start gap-3 text-[14.5px] text-white">
                <Check className="w-5 h-5 text-[#B03142] shrink-0 mt-0.5" strokeWidth={2.5} />
                <ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="m-0 p-0 inline-flex" textClassName="text-[14.5px] font-bold tracking-wide m-0 p-0">{t('benefitPro9')}</ScrollReveal>
              </li>
            </ul>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
