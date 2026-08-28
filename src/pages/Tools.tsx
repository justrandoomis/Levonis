import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, Wrench } from 'lucide-react';

export default function Tools() {
  const navigate = useNavigate();
  const { dir } = useLanguage();

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">Tools</h1>
      </div>
      <div className="p-4">
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-8 text-center">
          <Wrench className="w-12 h-12 text-olive mx-auto mb-4" />
          <h2 className="text-white font-bold mb-2">قريباً / Tools are coming soon</h2>
          <p className="text-zinc-400 text-sm">
            {dir === 'rtl'
              ? 'نعمل على مجموعة أدوات مفيدة — تحقق مرة أخرى لاحقاً.'
              : 'We are working on a set of useful tools — check back later.'}
          </p>
        </div>
      </div>
    </div>
  );
}
