import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { ShieldCheck, CheckCircle2 } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

export default function WarrantyVerify() {
  const { receiptNo } = useParams();
  const { loc } = useLanguage();

  return (
    <div className="min-h-screen bg-black text-white p-6 max-w-md mx-auto">
      <div className="text-center mb-6">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 mx-auto mb-3">
          <ShieldCheck className="w-8 h-8" />
        </div>
        <h1 className="text-xl font-bold text-white">
          {loc('التحقق من صحة الضمان', 'Warranty Verification', 'پشکنینی دروستی گەرەنتی')}
        </h1>
        <p className="text-xs text-zinc-400 mt-1">
          {loc('رقم الإيصال: ', 'Receipt: ', 'ژمارەی پسوولە: ')} {receiptNo}
        </p>
      </div>

      <div className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4">
        <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
          <CheckCircle2 className="w-5 h-5" />
          <span>{loc('شهادة ضمان معتمدة من ليفونيس', 'Official Levonis Warranty', 'بڕوانامەی فەرمی')}</span>
        </div>
        <div className="text-xs text-zinc-300 leading-relaxed">
          {loc(
            'هذا الجهاز مسجل رسمياً لدى نظام الضمان المركزي لشركة ليفونيس، ويغطي كافة أجزاء الهيكل والإلكترونيات وفق سياسة الضمان المعتمدة.',
            'This unit is officially registered in Levonis central warranty registry, covering structural and electronic components under official terms.',
            'ئەم ئامێرە بە فەرمی تۆمارکراوە لە سیستەمی گەرەنتی لێڤۆنیس.'
          )}
        </div>
      </div>

      <div className="mt-6 text-center">
        <Link
          to="/"
          className="text-xs text-zinc-400 hover:text-white underline underline-offset-4"
        >
          {loc('العودة للرئيسية', 'Return to Home', 'گەڕانەوە بۆ سەرەکی')}
        </Link>
      </div>
    </div>
  );
}
