import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react';

export default function Warranty() {
  const navigate = useNavigate();
  const { dir } = useLanguage();

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">
          مركز الضمان (Warranty Center)
        </h1>
      </div>
      <div className="p-4">
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6 text-center">
          <ShieldCheck className="w-12 h-12 text-olive mx-auto mb-4" />
          <h2 className="text-white font-bold mb-2">No Active Claims</h2>
          <p className="text-zinc-400 text-sm mb-4">You do not have any active warranty claims.</p>
          <button className="bg-olive/20 text-olive px-4 py-2 rounded-lg font-bold border border-olive/30">
            Submit New Claim
          </button>
        </div>
      </div>
    </div>
  );
}
