import React, { useState } from 'react';
import { Layers } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import PrintRequestWizard from '../components/print/PrintRequestWizard';
import MyRequestsList from '../components/print/MyRequestsList';

export default function Requests() {
  const { loc } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useState<'wizard' | 'list'>('wizard');

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-olive/20 border border-olive/40 text-olive">
              <Layers className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">
                {loc('خدمة الطباعة حسب الطلب', 'Custom 3D Printing', 'خزمەتگوزاری چاپی تایبەت')}
              </h1>
              <p className="text-xs text-zinc-400">
                {loc('ارفع تصميمك، اختر المواصفات، وسيتولى كبار الحرفيين تنفيذه', 'Upload 3D mesh, pick material, get instant offers', 'دیزاینەکەت بەرزبکەرەوە و داواکاری بنێرە')}
              </p>
            </div>
          </div>

          {isAuthenticated && (
            <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
              <button
                type="button"
                onClick={() => setTab('wizard')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  tab === 'wizard' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {loc('طلب جديد', 'New Request', 'داواکاری نوێ')}
              </button>
              <button
                type="button"
                onClick={() => setTab('list')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  tab === 'list' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {loc('طلباتي', 'My Requests', 'داواکارییەکانم')}
              </button>
            </div>
          )}
        </div>

        {tab === 'wizard' ? (
          <PrintRequestWizard
            onCreated={() => setTab('list')}
            onCancel={() => setTab('list')}
          />
        ) : (
          <MyRequestsList onOpen={(_id) => {}} />
        )}
      </div>
    </div>
  );
}
