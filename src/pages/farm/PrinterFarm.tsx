import React, { useEffect, useState } from 'react';
import { Coins, Play, Printer, RefreshCw } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { farmApi, type FarmState } from '../../lib/farmApi';
import { GamesPage, GamesHeader, GamesBody } from './PageChrome';
import { formatCoins } from './format';
import { PANEL, BTN_PRIMARY } from './ui';

export default function PrinterFarm() {
  const { dir } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [state, setState] = useState<FarmState | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (isAuthenticated) {
      farmApi
        .getState()
        .then((res) => {
          if (active && res.ok && res.farm) {
            setState(res.farm);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      setLoading(false);
    }
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  const showNotification = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  };

  return (
    <GamesPage>
      <GamesHeader title={dir === 'rtl' ? 'مزرعة الطابعات' : 'Printer Farm'} back="Back" />
      <GamesBody>
        <div className={PANEL}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-black text-white">{state?.farm_name || 'My 3D Farm'}</h2>
              <p className="text-xs text-zinc-400">Level {state?.level || 1}</p>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 font-bold">
              <Coins className="w-4 h-4" />
              <span>{formatCoins(state?.coins || 0)}</span>
            </div>
          </div>

          {notice && (
            <div className="p-3 mb-4 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs">
              {notice}
            </div>
          )}

          {loading ? (
            <div className="text-center py-8 text-zinc-500 text-xs">Loading farm state...</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800">
                <div className="flex items-center gap-2 text-zinc-300 font-semibold mb-2">
                  <Printer className="w-5 h-5 text-amber-400" />
                  <span>{dir === 'rtl' ? 'طابعة بامبو X1-Carbon' : 'Bambu Lab X1-Carbon'}</span>
                </div>
                <div className="text-xs text-emerald-400 font-medium mb-3">
                  {dir === 'rtl' ? 'جاهزة للطباعة' : 'Ready to print'}
                </div>
                <button
                  type="button"
                  className={BTN_PRIMARY + ' w-full'}
                  onClick={() => showNotification(dir === 'rtl' ? 'بدأ تنفيذ أمر الطباعة!' : 'Print job queued!')}
                >
                  <Play className="w-4 h-4" />
                  <span>{dir === 'rtl' ? 'طباعة نموذج' : 'Start Print Job'}</span>
                </button>
              </div>

              <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800">
                <div className="flex items-center gap-2 text-zinc-300 font-semibold mb-2">
                  <Printer className="w-5 h-5 text-amber-400" />
                  <span>{dir === 'rtl' ? 'طابعة كرياليتي K1 Max' : 'Creality K1 Max'}</span>
                </div>
                <div className="text-xs text-zinc-400 font-medium mb-3">
                  {dir === 'rtl' ? 'في انتظار خيط الطباعة' : 'Waiting for filament'}
                </div>
                <button
                  type="button"
                  className={BTN_PRIMARY + ' w-full'}
                  onClick={() => showNotification(dir === 'rtl' ? 'تم تزويد الطابعة بالخيط!' : 'Filament loaded!')}
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>{dir === 'rtl' ? 'تلقيم الخيط' : 'Load Spool'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </GamesBody>
    </GamesPage>
  );
}
