import React, { ReactNode, useState, useRef, useEffect } from 'react';
import { Bell, Menu, User, ArrowLeft, ArrowRight, Globe, LogOut, Settings as SettingsIcon } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';

interface SidebarItem {
  id: string;
  icon: React.ElementType;
  label: string;
}

interface DashboardLayoutProps {
  title?: string;
  sidebarItems: SidebarItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children: ReactNode;
}

export default function DashboardLayout({ title = "LEVO", sidebarItems, activeTab, onTabChange, children }: DashboardLayoutProps) {
  const { dir, lang, setLang } = useLanguage();
  const navigate = useNavigate();
  const { isAuthenticated, logout } = useAuth();
  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [myStoreId, setMyStoreId] = useState<string | null>(null);

  const userMenuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);

  // The user-menu "Settings" entry only makes sense when this shell actually
  // has a settings tab; the admin shell calls it 'store_settings'.
  const settingsTabId =
    sidebarItems.find(i => i.id === 'settings')?.id ??
    sidebarItems.find(i => i.id === 'store_settings')?.id ??
    null;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
      if (langRef.current && !langRef.current.contains(event.target as Node)) {
        setShowLangMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Resolve the signed-in user's real community store id (if any) so the
  // "My Store" links can point at the actual page.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api
      .get<{ merchant: { id: string } | null }>('/api/community/my-store')
      .then((data) => {
        if (!cancelled && data.merchant) setMyStoreId(data.merchant.id);
      })
      .catch(() => { /* no store or transient error — fall back below */ });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const goToMyStore = () => {
    if (myStoreId) {
      navigate(`/community/store/${myStoreId}`);
    } else {
      navigate('/edit-profile');
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      navigate('/auth');
    }
  };

  return (
    <div className="flex h-screen w-full bg-[#18181b] overflow-hidden font-sans" dir={dir}>
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex flex-col w-[260px] bg-[#09090b] text-zinc-300 shrink-0 shadow-[4px_0_24px_rgba(0,0,0,0.3)] z-20 border-r border-zinc-800">
        <div className="p-8 flex items-center gap-4 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/')}>
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#708238] to-[#9fae63] flex items-center justify-center font-bold text-lg text-white shadow-lg">
            L
          </div>
          <span className="font-bold text-sm tracking-widest uppercase border border-zinc-700 px-3 py-1 rounded-lg text-white">{title}</span>
        </div>

        <div className="px-8 py-2 text-[10px] font-bold text-zinc-500 tracking-widest uppercase mb-2">
          {dir === 'rtl' ? 'القائمة الرئيسية' : 'MAIN MENU'}
        </div>

        <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
          {sidebarItems.map(item => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center gap-4 px-6 py-4 rounded-xl transition-all duration-300 font-medium ${
                activeTab === item.id
                  ? 'bg-[#708238] text-white shadow-[0_4px_15px_rgba(112,130,56,0.3)]'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
              } ${dir === 'rtl' ? 'flex-row-reverse' : ''}`}
            >
              <item.icon className="w-5 h-5 shrink-0" />
              <span className={`text-[13px] ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-6 mt-auto">
           <div onClick={goToMyStore} className="cursor-pointer w-full aspect-square rounded-[24px] bg-gradient-to-br from-zinc-800 to-zinc-900 border border-zinc-700 shadow-lg flex flex-col items-center justify-center p-6 relative overflow-hidden group hover:border-[#D4AF37] transition-all">
             <User className="w-12 h-12 text-[#D4AF37] mb-3 group-hover:scale-110 transition-transform" />
             <div className="text-[11px] font-bold text-white text-center">
               {myStoreId
                 ? (dir === 'rtl' ? 'عرض صفحتي في ليفو' : 'View My Levo Page')
                 : (dir === 'rtl' ? 'إعداد صفحتي في ليفو' : 'Set Up My Levo Page')}
             </div>
           </div>
        </div>
      </div>

      {/* Mobile Drawer Overlay */}
      {showMobileSidebar && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowMobileSidebar(false)}></div>
          <div className="relative w-72 max-w-[80%] bg-[#09090b] text-zinc-300 h-full flex flex-col z-10 p-6 border-r border-zinc-800 shadow-2xl">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3" onClick={() => navigate('/')}>
                <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#708238] to-[#9fae63] flex items-center justify-center font-bold text-lg text-white">
                  L
                </div>
                <span className="font-bold text-sm uppercase text-white">{title}</span>
              </div>
              <button onClick={() => setShowMobileSidebar(false)} className="p-2 text-zinc-400 hover:text-white">✕</button>
            </div>

            <nav className="flex-1 space-y-2 overflow-y-auto">
              {sidebarItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => { onTabChange(item.id); setShowMobileSidebar(false); }}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-colors ${
                    activeTab === item.id ? 'bg-[#708238] text-white' : 'text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  <item.icon className="w-5 h-5 shrink-0" />
                  <span className="text-sm">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative bg-[#18181b]">
        {/* Topbar */}
        <div className="h-[70px] sm:h-[90px] flex items-center justify-between px-4 sm:px-10 shrink-0 z-10 w-full bg-[#18181b]/90 backdrop-blur-md border-b border-zinc-800/50">
           <div className="lg:hidden">
              <button onClick={() => setShowMobileSidebar(true)} className="p-2.5 bg-zinc-800 rounded-xl shadow-sm text-zinc-300 hover:text-white transition-colors">
                <Menu className="w-5 h-5" />
              </button>
           </div>

           <div className="hidden lg:flex gap-14 text-[13px] font-semibold text-zinc-400 pl-4">
             <button onClick={() => navigate('/community')} className="cursor-pointer hover:text-white transition-colors flex items-center gap-2">
               {dir === 'rtl' ? <ArrowRight className="w-4 h-4"/> : <ArrowLeft className="w-4 h-4"/>}
               {dir === 'rtl' ? 'مجتمع ليفو' : 'Levo Community'}
             </button>
             <div className="relative">
               <span className="cursor-pointer text-white font-bold">{dir === 'rtl' ? 'لوحة التحكم' : 'Dashboard'}</span>
               <div className="absolute -bottom-[33px] left-0 right-0 h-0.5 bg-[#D4AF37]"></div>
             </div>
           </div>

           <div className="flex items-center gap-6 ml-auto text-zinc-400">
             {/* Language Dropdown */}
             <div className="relative" ref={langRef}>
               <button onClick={() => setShowLangMenu(!showLangMenu)} className="hover:text-[#D4AF37] transition-colors flex items-center gap-2">
                 <Globe className="w-5 h-5 stroke-[2]" />
                 <span className="text-xs font-bold uppercase hidden sm:block">{lang}</span>
               </button>
               {showLangMenu && (
                 <div className={`absolute top-12 ${dir === 'rtl' ? 'left-0' : 'right-0'} w-32 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl py-2 z-50`}>
                   {(['en', 'ar', 'ckb'] as const).map(l => (
                     <button key={l} onClick={() => { setLang(l); setShowLangMenu(false); }} className={`w-full text-left px-4 py-2 text-sm hover:bg-zinc-800 ${lang === l ? 'text-[#D4AF37] font-bold' : 'text-zinc-400'}`}>
                       {l === 'en' ? 'English' : l === 'ar' ? 'العربية' : 'Kurdish'}
                     </button>
                   ))}
                 </div>
               )}
             </div>

             {/* Notifications — no notification backend exists, so no fake badge */}
             <div className="relative" ref={notifRef}>
               <button onClick={() => setShowNotifications(!showNotifications)} className="hover:text-[#D4AF37] transition-colors relative">
                 <Bell className="w-5 h-5 stroke-[2]" />
               </button>
               {showNotifications && (
                 <div className={`absolute top-12 ${dir === 'rtl' ? 'left-0' : 'right-0'} w-72 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl py-2 z-50`}>
                   <div className="px-4 py-3 border-b border-zinc-800 font-bold text-white text-sm">{dir === 'rtl' ? 'الإشعارات' : 'Notifications'}</div>
                   <div className="px-4 py-6 text-center text-sm text-zinc-500">
                     {dir === 'rtl' ? 'لا توجد إشعارات' : 'No notifications'}
                   </div>
                 </div>
               )}
             </div>

             {/* User Menu */}
             <div className="relative" ref={userMenuRef}>
               <div onClick={() => setShowUserMenu(!showUserMenu)} className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center cursor-pointer overflow-hidden ml-2 shadow-sm border border-zinc-600 hover:border-[#D4AF37] transition-colors">
                 <User className="w-5 h-5 text-zinc-400" />
               </div>
               {showUserMenu && (
                 <div className={`absolute top-12 ${dir === 'rtl' ? 'left-0' : 'right-0'} w-48 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl py-2 z-50`}>
                   <button onClick={() => { setShowUserMenu(false); goToMyStore(); }} className="w-full text-left px-4 py-2.5 text-sm hover:bg-zinc-800 text-zinc-300 flex items-center gap-2">
                     <User className="w-4 h-4" /> {dir === 'rtl' ? 'متجري' : 'My Store'}
                   </button>
                   {settingsTabId && (
                     <button onClick={() => { setShowUserMenu(false); onTabChange(settingsTabId); }} className="w-full text-left px-4 py-2.5 text-sm hover:bg-zinc-800 text-zinc-300 flex items-center gap-2">
                       <SettingsIcon className="w-4 h-4" /> {dir === 'rtl' ? 'الإعدادات' : 'Settings'}
                     </button>
                   )}
                   <div className="h-px bg-zinc-800 my-1"></div>
                   <button onClick={handleLogout} className="w-full text-left px-4 py-2.5 text-sm hover:bg-zinc-800 text-red-400 flex items-center gap-2">
                     <LogOut className="w-4 h-4" /> {dir === 'rtl' ? 'تسجيل الخروج' : 'Logout'}
                   </button>
                 </div>
               )}
             </div>
           </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 md:px-10 py-8 custom-scrollbar relative z-0">
          {children}
        </div>
      </div>
    </div>
  );
}
