import React from 'react';
import { Trophy, Coins, Star } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { GamesPage, GamesHeader, GamesBody } from '../farm/PageChrome';
import { PANEL } from '../farm/ui';

export default function GameProfile() {
  const { dir } = useLanguage();

  return (
    <GamesPage>
      <GamesHeader title={dir === 'rtl' ? 'ملف اللاعب' : 'Game Profile'} back="Back" />
      <GamesBody>
        <div className={PANEL}>
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 font-black text-2xl">
              LV
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Pilot Maker</h2>
              <p className="text-sm text-zinc-400">Level 1 • Rookie Maker</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
              <Coins className="w-5 h-5 text-amber-400 mx-auto mb-1" />
              <div className="text-xs text-zinc-400">{dir === 'rtl' ? 'العملات' : 'Coins'}</div>
              <div className="font-bold text-white text-sm">0</div>
            </div>
            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
              <Star className="w-5 h-5 text-amber-400 mx-auto mb-1" />
              <div className="text-xs text-zinc-400">{dir === 'rtl' ? 'النجوم' : 'Stars'}</div>
              <div className="font-bold text-white text-sm">5.0</div>
            </div>
            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
              <Trophy className="w-5 h-5 text-amber-400 mx-auto mb-1" />
              <div className="text-xs text-zinc-400">{dir === 'rtl' ? 'الترتيب' : 'Rank'}</div>
              <div className="font-bold text-white text-sm">--</div>
            </div>
          </div>
        </div>
      </GamesBody>
    </GamesPage>
  );
}
