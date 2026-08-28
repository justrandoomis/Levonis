import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  Settings as SettingsIcon,
  MapPin,
  Puzzle,
  Sparkles,
  Bell,
  SlidersHorizontal,
  Globe,
  LayoutGrid,
  LogOut
} from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import TelegramLink from '../components/security/TelegramLink';

type PushStatus = 'unsupported' | 'blocked' | 'granted' | 'off';

function getPushStatus(): PushStatus {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'blocked';
  return 'off';
}

const PUSH_LABELS: Record<PushStatus, string> = {
  unsupported: 'Not supported',
  blocked: 'Blocked',
  granted: 'Permission granted',
  off: 'Off',
};

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { lang, setLang } = useLanguage();

  const [pushStatus, setPushStatus] = useState<PushStatus>(getPushStatus);
  // Appearance is a pure UI preference — localStorage is fine for it.
  const [appearance, setAppearance] = useState(localStorage.getItem('theme') || 'System');
  const [signingOut, setSigningOut] = useState(false);

  const avatarUrl = user?.avatar_key
    ? `/files/${user.avatar_key}`
    : `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(user?.username || user?.name || 'guest')}`;

  const handlePushNotifications = async () => {
    if (pushStatus === 'unsupported') return;
    if (pushStatus === 'blocked') {
      alert('Notifications are blocked in your browser settings. Enable them there to grant permission.');
      return;
    }
    if (pushStatus === 'off') {
      await Notification.requestPermission();
    }
    setPushStatus(getPushStatus());
  };

  const toggleLanguage = () => {
    setLang(lang === 'en' ? 'ar' : 'en');
  };

  const toggleAppearance = () => {
    const nextTheme = appearance === 'System' ? 'Light' : appearance === 'Light' ? 'Dark' : 'System';
    setAppearance(nextTheme);
    localStorage.setItem('theme', nextTheme);
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      navigate('/auth');
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white w-full font-sans">
      {/* Header */}
      <div className="flex items-center justify-between p-4 pt-12 bg-[#0a0a0a]/80 sticky top-0 z-10">
        <button
          onClick={() => navigate(-1)}
          className="w-11 h-11 bg-gold/5 rounded-full flex items-center justify-center shadow-sm hover:bg-gold/10 active:scale-95 border border-white/5 transition-all"
        >
          <ChevronLeft className="w-6 h-6 text-white" />
        </button>
        <h1 className="text-[18px] font-bold absolute left-1/2 -translate-x-1/2">Settings</h1>
        <div className="w-11"></div> {/* Spacer for centering */}
      </div>

      <div className="px-4 pb-8 pt-4 space-y-6 max-w-md mx-auto">
        {/* Top Cards */}
        <div className="flex gap-4">
          <div
            onClick={() => navigate('/edit-profile')}
            className="flex-1 bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-3xl p-4 shadow-sm cursor-pointer hover:bg-zinc-800 transition-colors"
          >
            <div className="w-[50px] h-[50px] rounded-full overflow-hidden mb-3 bg-zinc-800">
              <img referrerPolicy="no-referrer"
                src={avatarUrl}
                alt="Avatar"
                className="w-full h-full object-cover"
              />
            </div>
            <h2 className="font-bold text-[16px] truncate">{user?.username || user?.name || 'Guest'}</h2>
            <p className="text-zinc-400 text-[13px] mt-0.5">Edit profile</p>
          </div>
          <div
            className="flex-1 bg-gold rounded-3xl p-4 shadow-sm flex flex-col justify-between opacity-60 cursor-not-allowed"
            aria-disabled="true"
          >
            <div className="w-[50px] h-[50px] rounded-xl overflow-hidden mb-3 bg-zinc-800 flex items-center justify-center">
              <LayoutGrid className="w-6 h-6 text-zinc-400" />
            </div>
            <div>
              <h2 className="font-bold text-[16px]">All elements</h2>
              <p className="text-zinc-400 text-[13px] mt-0.5">قريباً / Coming soon</p>
            </div>
          </div>
        </div>

        {/* General */}
        <div>
          <h3 className="text-zinc-400 text-[13px] font-semibold mb-2 ml-1">General</h3>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-3xl shadow-sm overflow-hidden flex flex-col">
            <button
              onClick={() => navigate('/edit-profile')}
              className="flex items-center justify-between p-4 py-4.5 border-b border-zinc-800 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <SettingsIcon className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">Account details</span>
              </div>
              <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
            </button>
            <button
              onClick={() => navigate('/addresses')}
              className="flex items-center justify-between p-4 py-4.5 border-b border-zinc-800 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <MapPin className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">My Addresses</span>
              </div>
              <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
            </button>
            <button
              disabled
              className="flex items-center justify-between p-4 py-4.5 opacity-50 cursor-not-allowed"
            >
              <div className="flex items-center gap-4">
                <Puzzle className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">Setup extension</span>
              </div>
              <span className="text-zinc-400 text-[13px] font-medium">قريباً / Coming soon</span>
            </button>
          </div>
        </div>

        {/* Security — verified contact channels */}
        <div>
          <h3 className="text-zinc-400 text-[13px] font-semibold mb-2 ml-1">
            {lang === 'ar' ? 'الأمان وقنوات التحقق' : lang === 'ckb' ? 'ئاسایش و پشتڕاستکردنەوە' : 'Security & verification'}
          </h3>
          <TelegramLink />
        </div>

        {/* Support */}
        <div>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-3xl shadow-sm overflow-hidden flex flex-col">
            <button
              onClick={() => navigate('/support')}
              className="flex items-center justify-between p-4 py-4.5 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <Bell className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">{lang === 'ar' ? 'مساعد الدعم' : lang === 'ckb' ? 'یاریدەدەری پشتگیری' : 'Support assistant'}</span>
              </div>
              <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
            </button>
            <button
              onClick={() => navigate('/gifts')}
              className="flex items-center justify-between p-4 py-4.5 border-t border-zinc-800 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <Sparkles className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">{lang === 'ar' ? 'مراجعاتي وهداياي' : lang === 'ckb' ? 'پێداچوونەوە و دیارییەکانم' : 'My reviews & gifts'}</span>
              </div>
              <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
            </button>
            <button
              onClick={() => navigate('/policies')}
              className="flex items-center justify-between p-4 py-4.5 border-t border-zinc-800 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <SettingsIcon className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">{lang === 'ar' ? 'السياسات والشروط' : lang === 'ckb' ? 'سیاسەت و مەرجەکان' : 'Policies & terms'}</span>
              </div>
              <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
            </button>
          </div>
        </div>

        {/* Upgrade */}
        <div>
          <h3 className="text-zinc-400 text-[13px] font-semibold mb-2 ml-1">Upgrade</h3>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-3xl shadow-sm overflow-hidden flex flex-col">
            <button
              onClick={() => navigate('/subscription')}
              className="flex items-center justify-between p-4 py-4.5 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <Sparkles className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">Upgrade to premium</span>
              </div>
              <div className="bg-gold/10 text-white px-4 py-1.5 rounded-full border border-white/5 text-[13px] font-bold">
                Learn more
              </div>
            </button>
          </div>
        </div>

        {/* Permissions */}
        <div>
          <h3 className="text-zinc-400 text-[13px] font-semibold mb-2 ml-1">Permissions</h3>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-3xl shadow-sm overflow-hidden flex flex-col">
            <button
              onClick={handlePushNotifications}
              className="flex items-center justify-between p-4 py-4.5 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <Bell className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">Push notifications</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 text-[15px] font-medium">{PUSH_LABELS[pushStatus]}</span>
                <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
              </div>
            </button>
            <p className="px-4 pb-3 -mt-1 text-[12px] text-zinc-500">
              Granting permission only prepares your browser — push delivery isn't configured on our side yet.
            </p>
          </div>
        </div>

        {/* Other */}
        <div>
          <h3 className="text-zinc-400 text-[13px] font-semibold mb-2 ml-1">Other</h3>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-3xl shadow-sm overflow-hidden flex flex-col">
            <button
              onClick={toggleAppearance}
              className="flex items-center justify-between p-4 py-4.5 border-b border-zinc-800 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <SlidersHorizontal className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">Appearance</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 text-[15px] font-medium">{appearance}</span>
                <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
              </div>
            </button>
            <button
              onClick={toggleLanguage}
              className="flex items-center justify-between p-4 py-4.5 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <Globe className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">Language</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 text-[15px] font-medium">{lang === 'en' ? 'English' : 'العربية'}</span>
                <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
              </div>
            </button>
          </div>
        </div>

        {/* Sign out */}
        {user && (
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-3xl shadow-sm overflow-hidden flex flex-col">
            <button
              onClick={handleSignOut}
              disabled={signingOut}
              className="flex items-center justify-between p-4 py-4.5 active:bg-red-500/10 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-4">
                <LogOut className="w-5 h-5 text-red-400" strokeWidth={2.2} />
                <span className="font-bold text-[16px] text-red-400">{signingOut ? 'Signing out…' : 'Sign out / تسجيل الخروج'}</span>
              </div>
              <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
