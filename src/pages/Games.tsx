import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { Users, Trophy, User } from 'lucide-react';

export default function Games() {
  const navigate = useNavigate();
  const { t, dir } = useLanguage();

  const games = [
    {
      id: 1,
      title: 'SPEED RACER',
      subtitle: "Don't go out of fuel!",
      plays: '2,305,654',
      bg: 'bg-gradient-to-br from-[#4ae6ff] to-[#40d2f0]',
      shadow: 'shadow-[#4ae6ff]/30',
      iconUrl: 'https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=100&h=100&fit=crop',
      featured: true,
      extraUi: (
         <div className="absolute top-2 right-2 text-white">
            <span className="text-2xl drop-shadow-md">🏎️</span>
            <span className="text-2xl drop-shadow-md ml-1">🔥</span>
         </div>
      ),
      banner: {
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix',
        text: "You're the best!"
      }
    },
    {
      id: 2,
      title: 'ALIENS ATTACK',
      subtitle: 'Save the city from the invasion!',
      plays: '2,206,951',
      bg: 'bg-gradient-to-r from-[#8c3d70] to-[#e44c80]',
      shadow: 'shadow-[#e44c80]/30',
      iconUrl: 'https://images.unsplash.com/photo-1614036417651-1d73fdba8f4c?w=100&h=100&fit=crop',
      extraUi: (
         <div className="absolute top-3 right-3 text-white flex flex-col items-end gap-1">
            <div className="flex gap-1">
               <span className="text-xl drop-shadow-md opacity-80">👾</span>
               <span className="text-2xl drop-shadow-md">👽</span>
            </div>
            <span className="text-4xl drop-shadow-md mt-1 opacity-90">👾</span>
         </div>
      )
    },
    {
      id: 3,
      title: 'BIRDS RUSH',
      subtitle: 'Be the last to fly!',
      plays: '1,350,995',
      bg: 'bg-gradient-to-br from-[#4ae6ff] to-[#40d2f0]',
      shadow: 'shadow-[#4ae6ff]/30',
      iconUrl: 'https://images.unsplash.com/photo-1555169062-013468b47731?w=100&h=100&fit=crop',
      extraUi: (
         <div className="absolute top-2 right-4 text-white">
            <span className="text-2xl drop-shadow-md absolute -top-1 right-8 text-green-300">🐤</span>
            <span className="text-4xl drop-shadow-md absolute top-4 -right-2 text-pink-400">🐔</span>
            <span className="text-xl drop-shadow-md absolute top-6 right-10 text-purple-400">🐧</span>
         </div>
      )
    },
    {
      id: 4,
      title: 'SLICE FRUIT',
      subtitle: 'Fruit-slicing fingers!',
      plays: '1,171,056',
      bg: 'bg-gradient-to-r from-[#e65c00] to-[#f9d423]',
      shadow: 'shadow-[#e65c00]/30',
      iconUrl: 'https://images.unsplash.com/photo-1582281268112-92e9e68c0b29?w=100&h=100&fit=crop',
      extraUi: (
         <div className="absolute top-3 right-3 text-white flex flex-col items-end gap-2">
            <div className="flex gap-2">
               <span className="text-xl drop-shadow-md">🍊</span>
               <span className="text-xl drop-shadow-md">🍎</span>
            </div>
            <span className="text-4xl drop-shadow-md">🍉</span>
         </div>
      )
    }
  ];

  return (
    <div className="w-full min-h-screen bg-white dark:bg-black font-sans pb-10 pt-16">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-white dark:bg-black px-4 py-4 flex items-center justify-between shadow-sm">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-black dark:text-white">
          <Users className="w-6 h-6 fill-current" />
        </button>
        
        <h1 className="text-2xl font-black tracking-tight text-black dark:text-white lowercase">tribe</h1>
        
        <button onClick={() => navigate('/leaderboards')} className="p-2 -mr-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
          <Trophy className="w-6 h-6 text-yellow-400 fill-yellow-400" />
        </button>
      </div>

      {/* Game List */}
      <div className="px-4 flex flex-col gap-6 mt-2">
        {games.map((game) => (
          <div key={game.id} className="relative">
             <div className={`relative w-full rounded-[24px] overflow-hidden ${game.bg} shadow-lg ${game.shadow} cursor-pointer hover:scale-[1.02] active:scale-[0.98] transition-transform`}>
                
                {/* Content area */}
                <div className="p-5 pr-32 min-h-[140px] relative z-10">
                   <div className="flex items-start gap-4">
                      {/* Game Icon */}
                      <div className="w-[60px] h-[60px] rounded-full border-4 border-white/20 overflow-hidden shrink-0 shadow-inner">
                        <img referrerPolicy="no-referrer" src={game.iconUrl} alt={game.title} className="w-full h-full object-cover" />
                      </div>
                      
                      <div className="flex flex-col pt-1">
                        <h2 className="text-white font-black text-xl tracking-wide uppercase" style={{ fontFamily: 'Impact, sans-serif' }}>
                          {game.title}
                        </h2>
                        <p className="text-white/80 font-medium text-[13px] leading-tight mt-0.5">
                          {game.subtitle}
                        </p>
                      </div>
                   </div>
                </div>

                {/* Extra visual elements absolute positioned on the right */}
                {game.extraUi}

                {/* Bottom Bar */}
                <div className="absolute bottom-0 left-0 right-0 px-4 py-2 bg-white/20 backdrop-blur-[2px] flex justify-between items-center z-10">
                   {game.featured ? (
                     <span className="text-white font-bold text-[10px] tracking-wider uppercase opacity-90">Featured</span>
                   ) : <div></div>}
                   <span className="text-white font-bold text-[10px] tracking-wider uppercase opacity-90">{game.plays} Plays</span>
                </div>
             </div>

             {/* Optional Banner below */}
             {game.banner && (
               <div className="mx-4 -mt-2 pt-4 pb-2 px-3 bg-white border border-black/5 rounded-b-[16px] shadow-sm flex items-center justify-center gap-2 relative z-0">
                  <div className="w-6 h-6 rounded-full overflow-hidden bg-zinc-100 shrink-0">
                    <img referrerPolicy="no-referrer" src={game.banner.avatar} alt="Avatar" className="w-full h-full object-cover" />
                  </div>
                  <span className="text-[13px] font-bold text-black">{game.banner.text}</span>
               </div>
             )}
          </div>
        ))}
      </div>
    </div>
  );
}
