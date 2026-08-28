import React from 'react';
import { Home, Users, MessageCircle, ShoppingCart, User } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { Link, useLocation } from 'react-router-dom';

export default function BottomNav() {
  const { t } = useLanguage();
  const location = useLocation();

  const navItems = [
    { icon: Users, label: t('community'), path: '/community' },
    { icon: MessageCircle, label: t('webCenter'), path: '/chats' },
    { icon: Home, label: t('home'), path: '/' },
    { icon: ShoppingCart, label: t('cart'), path: '/cart' },
    { icon: User, label: t('profile' as any), path: '/profile' },
  ];

  const leftItems = navItems.slice(0, 2);
  const homeItem = navItems[2];
  const rightItems = navItems.slice(3, 5);

  if (location.pathname === '/admin' || location.pathname === '/edit-profile' || location.pathname.startsWith('/product/') || location.pathname.startsWith('/chat/')) return null;

  return (
    <nav className="fixed bottom-4 sm:bottom-6 left-0 right-0 z-[120] flex items-center justify-center gap-1.5 sm:gap-3 px-2 sm:px-4 pointer-events-none">
      {/* Left Pill */}
      <div className="bg-black/20 backdrop-blur-2xl border border-white/10 rounded-[36px] p-1 sm:p-2 flex items-center shadow-xl h-[60px] sm:h-[72px] pointer-events-auto flex-1 max-w-[160px] sm:max-w-[180px] justify-between">
        {leftItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link 
              key={item.path} 
              to={item.path}
              className={`flex flex-col items-center justify-center flex-1 h-full rounded-full transition-all ${
                isActive ? 'bg-olive/20 text-gold shadow-sm' : 'text-zinc-500 hover:text-gold'
              }`}
            >
              <item.icon 
                className={`w-[18px] h-[18px] sm:w-[22px] sm:h-[22px] mb-0.5 sm:mb-1 ${isActive ? 'text-gold' : ''}`} 
                strokeWidth={isActive ? 2.5 : 2} 
              />
              <span className={`text-[9px] sm:text-[11px] font-medium whitespace-nowrap ${isActive ? 'text-gold font-bold' : ''}`}>{item.label}</span>
            </Link>
          );
        })}
      </div>

      {/* Center Home Circle */}
      <Link 
        to={homeItem.path}
        className={`w-[60px] h-[60px] sm:w-[72px] sm:h-[72px] rounded-full flex items-center justify-center shadow-xl transition-transform hover:scale-105 border border-white/10 shrink-0 pointer-events-auto ${
          location.pathname === homeItem.path 
            ? 'bg-olive text-gold border-olive/50 shadow-olive/20' 
            : 'bg-black/20 backdrop-blur-2xl text-zinc-500 hover:text-gold border-white/10'
        }`}
      >
        <homeItem.icon 
          className="w-6 h-6 sm:w-7 sm:h-7" 
          strokeWidth={location.pathname === homeItem.path ? 2.5 : 2} 
        />
      </Link>

      {/* Right Pill */}
      <div className="bg-black/20 backdrop-blur-2xl border border-white/10 rounded-[36px] p-1 sm:p-2 flex items-center shadow-xl h-[60px] sm:h-[72px] pointer-events-auto flex-1 max-w-[160px] sm:max-w-[180px] justify-between">
        {rightItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link 
              key={item.path} 
              to={item.path}
              className={`flex flex-col items-center justify-center flex-1 h-full rounded-full transition-all ${
                isActive ? 'bg-olive/20 text-gold shadow-sm' : 'text-zinc-500 hover:text-gold'
              }`}
            >
              <item.icon 
                className={`w-[18px] h-[18px] sm:w-[22px] sm:h-[22px] mb-0.5 sm:mb-1 ${isActive ? 'text-gold' : ''}`} 
                strokeWidth={isActive ? 2.5 : 2} 
              />
              <span className={`text-[9px] sm:text-[11px] font-medium whitespace-nowrap ${isActive ? 'text-gold font-bold' : ''}`}>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
