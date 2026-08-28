import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Settings, Trophy, Lock } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

export default function Leaderboards() {
  const navigate = useNavigate();
  const { dir } = useLanguage();

  const games = [
    {
      id: 1,
      title: 'SPEED RACER',
      bg: 'bg-gradient-to-r from-[#4ae6ff] to-[#40d2f0]',
      iconUrl: 'https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=100&h=100&fit=crop',
      rank: 91,
      rankBg: 'bg-white/30',
      subtitle: {
        text: "You're the best!",
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix'
      }
    },
    {
      id: 2,
      title: 'ALIENS ATTACK',
      bg: 'bg-gradient-to-r from-[#5a2e58] to-[#ab376c]',
      iconUrl: 'https://images.unsplash.com/photo-1614036417651-1d73fdba8f4c?w=100&h=100&fit=crop',
      rank: '-',
      rankBg: 'bg-white/20'
    },
    {
      id: 3,
      title: 'BATTLE MUSIC',
      bg: 'bg-gradient-to-r from-[#32cd8b] to-[#4ceea8]',
      iconUrl: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=100&h=100&fit=crop',
      rank: '-',
      rankBg: 'bg-white/20'
    },
    {
      id: 4,
      title: 'BIRD RUSH!',
      bg: 'bg-gradient-to-r from-[#40d2f0] to-[#5aebff]',
      iconUrl: 'https://images.unsplash.com/photo-1555169062-013468b47731?w=100&h=100&fit=crop',
      rank: '-',
      rankBg: 'bg-white/20'
    },
    {
      id: 5,
      title: 'SCREAM!',
      bg: 'bg-gradient-to-r from-[#f1c40f] to-[#e74c3c]',
      iconUrl: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=100&h=100&fit=crop',
      rank: '-',
      rankBg: 'bg-white/20'
    }
  ];

  return (
    <div className="w-full min-h-screen bg-white dark:bg-black font-sans pb-10 pt-16">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-white dark:bg-black px-4 py-4 flex items-center justify-between shadow-sm">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-black dark:text-white">
          <ChevronLeft className="w-7 h-7" />
        </button>
        
        <h1 className="text-[16px] font-black tracking-widest text-black dark:text-white uppercase" style={{ fontFamily: 'Impact, sans-serif' }}>
          LEADERBOARDS
        </h1>
        
        <button className="p-2 -mr-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-black dark:text-white">
          <Settings className="w-6 h-6 fill-current" />
        </button>
      </div>

      {/* User Profile */}
      <div className="px-6 py-6 flex flex-col items-center border-b border-black/5 dark:border-white/5">
         <div className="flex items-center gap-4 w-full">
            <div className="w-[84px] h-[84px] rounded-full border-4 border-[#4ae6ff] p-1 shrink-0 relative shadow-sm">
               <div className="w-full h-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex items-center justify-center">
                  <svg className="w-12 h-12 text-white" viewBox="0 0 24 24" fill="currentColor">
                     <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
               </div>
               <div className="absolute -bottom-2 -right-1 text-2xl drop-shadow-sm">🏎️</div>
            </div>
            <div className="flex flex-col pt-1">
               <h2 className="text-[22px] font-bold text-black dark:text-white leading-none mb-1">Mobbie Des</h2>
               <span className="text-[15px] font-medium text-zinc-400">@mobbiedesign</span>
            </div>
         </div>
      </div>

      {/* Trophies Section */}
      <div className="px-6 py-5 border-b border-black/5 dark:border-white/5">
        <div className="flex items-center gap-2 mb-4">
          <Trophy className="w-4 h-4 text-yellow-400 fill-yellow-400" />
          <h3 className="font-bold text-[13px] tracking-wider text-yellow-400 uppercase">TROPHIES</h3>
        </div>

        <div className="flex gap-4 overflow-x-auto hide-scrollbar pb-2">
           {/* Active Trophy */}
           <div className="w-[84px] h-[84px] rounded-[20px] bg-[#4ae6ff] shrink-0 flex items-center justify-center shadow-lg shadow-[#4ae6ff]/30">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-3H8v-3h3v-3h3v3h3v3h-3v3h-3z" />
              </svg>
           </div>
           
           {/* Locked Trophies */}
           {['bg-gradient-to-br from-[#d478ff] to-[#a74bff]', 'bg-gradient-to-br from-[#40d2f0] to-[#25a6c1]', 'bg-gradient-to-br from-[#ffb347] to-[#ff9900]', 'bg-gradient-to-br from-[#333] to-[#111]'].map((bg, i) => (
             <div key={i} className={`w-[84px] h-[84px] rounded-[20px] ${bg} shrink-0 flex items-center justify-center shadow-sm opacity-90`}>
                <Lock className="w-6 h-6 text-white" />
             </div>
           ))}
        </div>
      </div>

      {/* Games Section */}
      <div className="py-2">
        <div className="px-6 py-4 flex items-center gap-2">
          <svg className="w-4 h-4 text-[#4ae6ff]" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21.58 16.09l-1.09-7.66C20.21 6.46 18.52 5 16.53 5H7.47C5.48 5 3.79 6.46 3.51 8.43l-1.09 7.66C2.2 17.63 3.39 19 4.94 19c.68 0 1.32-.27 1.8-.75L9 16h6l2.25 2.25c.48.48 1.13.75 1.8.75 1.56 0 2.75-1.37 2.53-2.91zM11 11H9v2H8v-2H6v-1h2V8h1v2h2v1zm4-1c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm2 3c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z" />
          </svg>
          <h3 className="font-bold text-[13px] tracking-wider text-[#4ae6ff] uppercase">GAMES</h3>
        </div>

        <div className="flex flex-col">
          {games.map((game) => (
            <div key={game.id} className={`${game.bg} py-4 px-6 flex items-center cursor-pointer hover:brightness-110 transition-all`}>
               <div className="flex flex-1 items-center gap-4">
                  <div className="w-[52px] h-[52px] rounded-full border-2 border-white/20 overflow-hidden shrink-0 shadow-sm relative">
                    <img referrerPolicy="no-referrer" src={game.iconUrl} alt={game.title} className="w-full h-full object-cover" />
                  </div>
                  
                  <div className="flex flex-col">
                    <h4 className="text-white font-black text-[18px] tracking-wide uppercase" style={{ fontFamily: 'Impact, sans-serif' }}>
                      {game.title}
                    </h4>
                    {game.subtitle && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <div className="w-[18px] h-[18px] rounded-full bg-white overflow-hidden opacity-90">
                           <img referrerPolicy="no-referrer" src={game.subtitle.avatar} alt="Avatar" className="w-full h-full object-cover" />
                        </div>
                        <span className="text-white/80 font-medium text-[12px]">{game.subtitle.text}</span>
                      </div>
                    )}
                  </div>
               </div>

               <div className="flex items-center gap-3">
                 <div className={`${game.rankBg} backdrop-blur-sm rounded-lg px-2.5 py-1 min-w-[32px] text-center`}>
                    <span className="text-white font-bold text-[15px]">{game.rank}</span>
                 </div>
                 <ChevronLeft className={`w-5 h-5 text-white opacity-80 ${dir === 'rtl' ? '' : 'rotate-180'}`} />
               </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
