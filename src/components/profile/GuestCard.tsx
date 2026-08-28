import React from 'react';
import { useNavigate } from 'react-router-dom';
import { UserRound, LogIn, Headset } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * Honest signed-out state for the profile page. A guest sees exactly this —
 * never member balances, order counters, membership tiers or referral data.
 * The sign-in CTA preserves the destination (?next=/profile) so the user
 * lands back here after authenticating.
 */

const STRINGS = {
  ar: {
    title: 'أنت تتصفح كزائر',
    body: 'سجّل الدخول لعرض طلباتك ورصيدك ونقاطك ومفضلتك وعضويتك.',
    signIn: 'تسجيل الدخول / إنشاء حساب',
    support: 'خدمة العملاء',
  },
  en: {
    title: 'You are browsing as a guest',
    body: 'Sign in to see your orders, balance, points, favorites and membership.',
    signIn: 'Sign in / create account',
    support: 'Customer service',
  },
  ckb: {
    title: 'وەک میوان دەگەڕێیت',
    body: 'بچۆ ژوورەوە بۆ بینینی داواکارییەکانت، باڵانس، خاڵەکان، دڵخوازەکان و ئەندامێتیت.',
    signIn: 'چوونەژوورەوە / دروستکردنی هەژمار',
    support: 'خزمەتگوزاری کڕیاران',
  },
};

export default function GuestCard() {
  const navigate = useNavigate();
  const { lang } = useLanguage();
  const s = STRINGS[lang] ?? STRINGS.ar;

  return (
    <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-5 mb-3 shadow-sm text-black dark:text-white text-center">
      <div className="w-14 h-14 rounded-full bg-black/5 dark:bg-white/10 mx-auto flex items-center justify-center mb-3" aria-hidden="true">
        <UserRound className="w-7 h-7 text-zinc-500" strokeWidth={1.5} />
      </div>
      <h2 className="font-bold text-[15px] mb-1">{s.title}</h2>
      <p className="text-[12px] text-zinc-500 mb-4 leading-relaxed">{s.body}</p>
      <button
        type="button"
        onClick={() => navigate('/auth?next=%2Fprofile')}
        className="w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl bg-[#0F2F25] text-[#BAA369] text-[13px] font-bold hover:opacity-90 active:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-opacity"
      >
        <LogIn className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
        {s.signIn}
      </button>
      <button
        type="button"
        onClick={() => navigate('/support')}
        className="mt-2 w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl border border-black/10 dark:border-white/15 text-[13px] font-bold text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5 active:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-colors"
      >
        <Headset className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
        {s.support}
      </button>
    </div>
  );
}
