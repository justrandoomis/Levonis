import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ChevronLeft, ChevronRight, 
  Settings as SettingsIcon, 
  MapPin, 
  Puzzle, 
  Sparkles, 
  Bell, 
  SlidersHorizontal, 
  Globe 
} from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';

export default function Settings() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { lang, setLang } = useLanguage();
  
  const [pushEnabled, setPushEnabled] = useState(() => typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted');
  const [appearance, setAppearance] = useState(localStorage.getItem('theme') || 'System');
  const [contentFiltering, setContentFiltering] = useState(true);

  const handlePushNotifications = async () => {
    if (!('Notification' in window)) {
      alert('Push notifications are not supported in this browser.');
      return;
    }
    if (Notification.permission === 'granted') {
      alert('Push notifications are already active!');
    } else if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      setPushEnabled(permission === 'granted');
    } else {
      alert('You have denied push notifications in your browser settings. Please enable them to use this feature.');
    }
  };

  const toggleLanguage = () => {
    setLang(lang === 'en' ? 'ar' : 'en');
  };

  const toggleAppearance = () => {
    const nextTheme = appearance === 'System' ? 'Light' : appearance === 'Light' ? 'Dark' : 'System';
    setAppearance(nextTheme);
    localStorage.setItem('theme', nextTheme);
  };

  const handleAction = (actionName: string) => {
    alert(`${actionName} settings opened (Simulation)`);
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
                src="https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=100&h=100&fit=crop" 
                alt="Avatar" 
                className="w-full h-full object-cover"
              />
            </div>
            <h2 className="font-bold text-[16px] truncate">{user?.username || 'Alex Smith'}</h2>
            <p className="text-zinc-400 text-[13px] mt-0.5">Edit profile</p>
          </div>
          <div 
            onClick={() => handleAction('Elements')}
            className="flex-1 bg-gold rounded-3xl p-4 shadow-sm flex flex-col justify-between cursor-pointer hover:bg-zinc-50 transition-colors"
          >
            <div className="w-[50px] h-[50px] rounded-xl overflow-hidden mb-3 bg-zinc-800 grid grid-cols-2 gap-[1px]">
              <img referrerPolicy="no-referrer" src="https://images.unsplash.com/photo-1550684848-fac1c5b4e853?w=50&h=50&fit=crop" className="w-full h-full object-cover" />
              <img referrerPolicy="no-referrer" src="https://images.unsplash.com/photo-1522204523234-8729aa6e3d5f?w=50&h=50&fit=crop" className="w-full h-full object-cover" />
              <img referrerPolicy="no-referrer" src="https://images.unsplash.com/photo-1491553895911-0055eca6402d?w=50&h=50&fit=crop" className="w-full h-full object-cover" />
              <img referrerPolicy="no-referrer" src="https://images.unsplash.com/photo-1518770660439-4636190af475?w=50&h=50&fit=crop" className="w-full h-full object-cover" />
            </div>
            <div>
              <h2 className="font-bold text-[16px]">All elements</h2>
              <p className="text-zinc-400 text-[13px] mt-0.5">11 Saves</p>
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
              onClick={() => handleAction('Setup Extension')}
              className="flex items-center justify-between p-4 py-4.5 active:bg-gold/5 hover:bg-gold/5 transition-colors"
            >
              <div className="flex items-center gap-4">
                <Puzzle className="w-5 h-5 text-white" strokeWidth={2.2} />
                <span className="font-bold text-[16px]">Setup extension</span>
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
                <span className="text-zinc-400 text-[15px] font-medium">{pushEnabled ? 'Working' : 'Disabled'}</span>
                <ChevronLeft className="w-5 h-5 text-zinc-500 rotate-180" />
              </div>
            </button>
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
      </div>
    </div>
  );
}
