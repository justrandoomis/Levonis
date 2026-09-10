import React from 'react';
import { Settings as SettingsIcon, Globe, LogOut } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';

export default function Settings() {
  const { lang, setLang, loc } = useLanguage();
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-2xl bg-zinc-800 border border-zinc-700 text-zinc-300">
            <SettingsIcon className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {loc('الإعدادات', 'Settings', 'ڕێکخستنەکان')}
            </h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              {loc('تفضيلات الحساب واللغة والعرض', 'Account, language and app preferences', 'ڕێکخستنی هەژمار و زمان')}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Language Selector */}
          <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
            <div className="flex items-center gap-3 mb-3">
              <Globe className="w-5 h-5 text-olive" />
              <div className="text-sm font-bold text-white">{loc('اللغة', 'Language', 'زمان')}</div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setLang('ar')}
                className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${
                  lang === 'ar' ? 'bg-olive text-black' : 'bg-zinc-800/80 text-zinc-300 hover:text-white'
                }`}
              >
                العربية
              </button>
              <button
                type="button"
                onClick={() => setLang('en')}
                className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${
                  lang === 'en' ? 'bg-olive text-black' : 'bg-zinc-800/80 text-zinc-300 hover:text-white'
                }`}
              >
                English
              </button>
              <button
                type="button"
                onClick={() => setLang('ckb')}
                className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${
                  lang === 'ckb' ? 'bg-olive text-black' : 'bg-zinc-800/80 text-zinc-300 hover:text-white'
                }`}
              >
                کوردی
              </button>
            </div>
          </div>

          {/* Account & Logout */}
          <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
            <div>
              <div className="text-sm font-bold text-white">{user?.displayName || user?.email || 'Levonis User'}</div>
              <div className="text-xs text-zinc-500">{user?.phone || user?.email || ''}</div>
            </div>
            <button
              type="button"
              onClick={() => logout()}
              className="px-3.5 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 font-bold text-xs flex items-center gap-1.5 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>{loc('تسجيل الخروج', 'Log Out', 'چوونەدەرەوە')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
