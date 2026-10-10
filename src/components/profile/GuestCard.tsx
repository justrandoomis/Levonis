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
    <div className="lv-surface p-5 mb-3 text-center text-text-primary">
      <div className="w-14 h-14 rounded-full mx-auto flex items-center justify-center mb-3 bg-white/10" aria-hidden="true">
        <UserRound className="w-7 h-7 text-text-muted" strokeWidth={1.5} />
      </div>
      <h2 className="font-bold text-[15px] mb-1">{s.title}</h2>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">{s.body}</p>
      <button
        type="button"
        onClick={() => navigate('/auth?next=%2Fprofile')}
        className="lv-button lv-button-primary w-full"
      >
        <LogIn className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
        {s.signIn}
      </button>
      <button
        type="button"
        onClick={() => navigate('/support')}
        className="lv-button lv-button-secondary mt-2 w-full"
      >
        <Headset className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
        {s.support}
      </button>
    </div>
  );
}
