import React from 'react';
import { useLanguage } from '../LanguageContext';
import { Clock, ArrowRight, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function ComingSoon({ title, titleAr }: { title: string; titleAr: string }) {
  const { dir } = useLanguage();
  const navigate = useNavigate();
  const BackIcon = dir === 'rtl' ? ArrowRight : ArrowLeft;
  
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center text-center p-6" dir={dir}>
      <div className="w-24 h-24 bg-zinc-900 rounded-full flex items-center justify-center mb-6 border border-zinc-800 shadow-xl shadow-black/50 relative overflow-hidden">
        <div className="absolute inset-0 bg-olive/10 blur-xl rounded-full" />
        <Clock className="w-10 h-10 text-olive relative z-10" />
      </div>
      <h1 className="text-3xl font-bold text-white mb-3 tracking-tight">
        {dir === 'rtl' ? titleAr : title}
      </h1>
      <h2 className="text-xl font-medium text-olive mb-4">
        {dir === 'rtl' ? 'قريباً' : 'Coming Soon'}
      </h2>
      <p className="text-zinc-400 max-w-md mb-8 leading-relaxed text-base">
        {dir === 'rtl' 
          ? 'نحن نعمل بجد لإطلاق هذه الميزة في أقرب وقت. ترقبوا التحديثات القادمة!' 
          : 'We are working hard to bring this feature to you shortly. Stay tuned for updates!'}
      </p>
      <button 
        onClick={() => navigate('/')}
        className="flex items-center gap-2 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-full text-sm font-medium transition-all active:scale-95"
      >
        <BackIcon className="w-4 h-4" />
        <span>{dir === 'rtl' ? 'العودة للرئيسية' : 'Back to Home'}</span>
      </button>
    </div>
  );
}
