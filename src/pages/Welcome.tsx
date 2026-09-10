import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, ArrowRight, ArrowLeft } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

export default function Welcome() {
  const navigate = useNavigate();
  const { dir, loc } = useLanguage();
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="max-w-md w-full p-8 rounded-3xl bg-zinc-900/80 border border-zinc-800 text-center shadow-2xl">
        <div className="w-16 h-16 rounded-2xl bg-olive/20 border border-olive/40 flex items-center justify-center text-olive mx-auto mb-4">
          <Sparkles className="w-8 h-8" />
        </div>

        <h1 className="text-2xl font-black text-white mb-2">
          {loc('أهلاً بك في عائلة ليفونيس!', 'Welcome to Levonis!', 'بەخێربێیت بۆ لێڤۆنیس!')}
        </h1>
        <p className="text-xs text-zinc-400 leading-relaxed mb-6">
          {loc(
            'تم تجهيز حسابك بنجاح. استكشف أكبر كتالوج لطابعات وخيوط ومستلزمات الطباعة ثلاثية الأبعاد في العراق.',
            'Your account is ready. Explore the premier 3D printing equipment and material catalog in Iraq.',
            'هەژمارەکەت ئامادەیە بۆ بەکارهێنان لە لێڤۆنیس.'
          )}
        </p>

        <button
          type="button"
          onClick={() => navigate('/')}
          className="w-full py-3 rounded-2xl bg-gradient-to-r from-olive to-emerald-600 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg"
        >
          <span>{loc('ابدأ التصفح', 'Start Browsing', 'دەستپێبکە')}</span>
          <Forward className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
