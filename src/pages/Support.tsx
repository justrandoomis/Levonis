import React from 'react';
import { HelpCircle, MessageCircle, Phone, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';

export default function Support() {
  const { loc } = useLanguage();

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-2xl bg-olive/20 border border-olive/40 text-olive">
            <HelpCircle className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {loc('مركز المساعدة والدعم الفني', 'Support Center', 'ناوەندی یارمەتی')}
            </h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              {loc('نحن هنا لمساعدتك في أي استفسار حول الطابعات والطلبات', 'We are here to assist with printers, orders, and services', 'ئێمە لێرەین بۆ هاوکاری')}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <Link
            to="/chats"
            className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 flex items-center gap-4 transition-colors"
          >
            <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-400">
              <MessageCircle className="w-6 h-6" />
            </div>
            <div>
              <div className="font-bold text-white text-sm">
                {loc('المحادثة المباشرة مع الدعم', 'Live Support Chat', 'چاتی ڕاستەوخۆ')}
              </div>
              <div className="text-xs text-zinc-400">
                {loc('تحدث مباشرة مع فريق المهندسين', 'Connect directly with our 3D tech team', 'پەیوەندی ڕاستەوخۆ')}
              </div>
            </div>
          </Link>

          <a
            href="tel:+9647700000000"
            className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 flex items-center gap-4 transition-colors"
          >
            <div className="p-3 rounded-xl bg-amber-500/10 text-amber-400">
              <Phone className="w-6 h-6" />
            </div>
            <div>
              <div className="font-bold text-white text-sm">
                {loc('الهاتف المباشر', 'Phone Support', 'پەیوەندی تەلەفۆنی')}
              </div>
              <div className="text-xs text-zinc-400" dir="ltr">
                +964 770 000 0000
              </div>
            </div>
          </a>

          <Link
            to="/warranty"
            className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 flex items-center gap-4 transition-colors"
          >
            <div className="p-3 rounded-xl bg-purple-500/10 text-purple-400">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div>
              <div className="font-bold text-white text-sm">
                {loc('مطالبات الضمان والصيانة', 'Warranty & Repair Claims', 'گەرەنتی و چاککردنەوە')}
              </div>
              <div className="text-xs text-zinc-400">
                {loc('فتح تذكرة صيانة لجهازك المسجل', 'Submit a maintenance claim for your unit', 'داواکاری چاککردنەوە')}
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
