import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Settings, Trophy, Gamepad2 } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';

export default function Leaderboards() {
  const navigate = useNavigate();
  const { dir } = useLanguage();
  const { user } = useAuth();
  const { signIn } = useSignInPrompt();

  const avatarUrl = user?.avatar_key
    ? `/files/${user.avatar_key}`
    : `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(user?.username || user?.name || 'guest')}`;

  return (
    <div className="w-full min-h-screen bg-white dark:bg-black font-sans pb-10 pt-16">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-white dark:bg-black px-4 py-4 flex items-center justify-between shadow-sm">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-black dark:text-white">
          <ChevronLeft className={`w-7 h-7 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
        </button>

        <h1 className="text-[16px] font-black tracking-widest text-black dark:text-white uppercase" style={{ fontFamily: 'Impact, sans-serif' }}>
          LEADERBOARDS
        </h1>

        {/* Settings is a member page. A guest tapping the gear used to be
            bounced to sign-in with no way back; now the way back rides along
            and they return here. */}
        <button onClick={() => (user ? navigate('/settings') : signIn())} className="p-2 -mr-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-black dark:text-white">
          <Settings className="w-6 h-6 fill-current" />
        </button>
      </div>

      {/* User Profile */}
      <div className="px-6 py-6 flex flex-col items-center border-b border-black/5 dark:border-white/5">
         <div className="flex items-center gap-4 w-full">
            <div className="w-[84px] h-[84px] rounded-full border-4 border-[#4ae6ff] p-1 shrink-0 relative shadow-sm">
               <div className="w-full h-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex items-center justify-center">
                  {user ? (
                    <img referrerPolicy="no-referrer" src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <svg className="w-12 h-12 text-white" viewBox="0 0 24 24" fill="currentColor">
                       <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                    </svg>
                  )}
               </div>
            </div>
            <div className="flex flex-col pt-1">
               <h2 className="text-[22px] font-bold text-black dark:text-white leading-none mb-1">{user?.name || user?.username || (dir === 'rtl' ? 'زائر' : 'Guest')}</h2>
               <span className="text-[15px] font-medium text-zinc-400">{user?.username ? `@${user.username}` : ''}</span>
            </div>
         </div>
      </div>

      {/* Trophies Section */}
      <div className="px-6 py-5 border-b border-black/5 dark:border-white/5">
        <div className="flex items-center gap-2 mb-4">
          <Trophy className="w-4 h-4 text-yellow-400 fill-yellow-400" />
          <h3 className="font-bold text-[13px] tracking-wider text-yellow-400 uppercase">TROPHIES</h3>
        </div>

        <p className="text-zinc-400 text-sm py-3">
          {dir === 'rtl'
            ? 'لا توجد جوائز بعد — ستظهر الجوائز عند إطلاق الألعاب.'
            : 'No trophies yet — trophies will appear when games launch.'}
        </p>
      </div>

      {/* Games Section */}
      <div className="py-2">
        <div className="px-6 py-4 flex items-center gap-2">
          <svg className="w-4 h-4 text-[#4ae6ff]" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21.58 16.09l-1.09-7.66C20.21 6.46 18.52 5 16.53 5H7.47C5.48 5 3.79 6.46 3.51 8.43l-1.09 7.66C2.2 17.63 3.39 19 4.94 19c.68 0 1.32-.27 1.8-.75L9 16h6l2.25 2.25c.48.48 1.13.75 1.8.75 1.56 0 2.75-1.37 2.53-2.91zM11 11H9v2H8v-2H6v-1h2V8h1v2h2v1zm4-1c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm2 3c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z" />
          </svg>
          <h3 className="font-bold text-[13px] tracking-wider text-[#4ae6ff] uppercase">GAMES</h3>
        </div>

        <div className="px-6 pb-6">
          <div className="bg-zinc-100 dark:bg-zinc-900 border border-black/5 dark:border-white/10 rounded-[20px] p-8 text-center">
            <Gamepad2 className="w-10 h-10 text-[#4ae6ff] mx-auto mb-3" />
            <p className="text-black dark:text-white font-bold mb-1">
              {dir === 'rtl' ? 'لم تُلعب أي ألعاب بعد' : 'No games played yet'}
            </p>
            <p className="text-zinc-500 text-sm">
              {dir === 'rtl'
                ? 'ستظهر لوحات المتصدرين عند إطلاق الألعاب.'
                : 'Leaderboards will appear when games launch.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
