import React from 'react';
import { Gift, Award, Sparkles } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

export default function Rewards() {
  const { loc } = useLanguage();

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-2xl bg-amber-500/20 border border-amber-500/40 text-amber-400">
            <Award className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {loc('برنامج المكافآت والولاء', 'Rewards & Perks', 'بەرنامەی پاداشتەکان')}
            </h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              {loc('اجمع النقاط مع كل طلب واستبدلها بخصومات حصرية', 'Earn points on every purchase and unlock tier discounts', 'خاڵ کۆبکەرەوە و داشکاندن وەربگرە')}
            </p>
          </div>
        </div>

        <div className="p-6 rounded-3xl bg-gradient-to-br from-zinc-900 to-zinc-950 border border-zinc-800 shadow-xl mb-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-zinc-400">{loc('رصيد نقاط الولاء', 'Reward Points', 'خاڵەکانت')}</div>
              <div className="text-3xl font-black text-amber-400 font-mono mt-1">250 Pts</div>
            </div>
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Sparkles className="w-6 h-6" />
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-bold text-zinc-300">{loc('المكافآت المتاحة', 'Available Rewards', 'پاداشتە بەردەستەکان')}</h2>
          <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Gift className="w-5 h-5 text-amber-400" />
              <div>
                <div className="text-xs font-bold text-white">{loc('كوبون خصم 10%', '10% Off Coupon', 'کۆپۆنی داشکاندنی 10%')}</div>
                <div className="text-[11px] text-zinc-500">{loc('يتطلب 500 نقطة', 'Requires 500 points', '500 خاڵ پێویستە')}</div>
              </div>
            </div>
            <button
              type="button"
              disabled
              className="px-3 py-1.5 rounded-xl bg-zinc-800 text-zinc-500 text-xs font-semibold"
            >
              {loc('غير مكتمل', 'Locked', 'داخراوە')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
