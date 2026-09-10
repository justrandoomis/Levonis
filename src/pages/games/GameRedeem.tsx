import React from 'react';
import { Gift } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { GamesPage, GamesHeader, GamesBody } from '../farm/PageChrome';
import { PANEL, BTN_PRIMARY } from '../farm/ui';

export default function GameRedeem() {
  const { dir } = useLanguage();

  return (
    <GamesPage>
      <GamesHeader title={dir === 'rtl' ? 'استبدال العملات' : 'Redeem Coins'} back="Back" />
      <GamesBody>
        <div className={PANEL}>
          <div className="flex items-center gap-3 mb-6">
            <Gift className="w-8 h-8 text-amber-400" />
            <div>
              <h2 className="text-lg font-bold text-white">
                {dir === 'rtl' ? 'استبدال نقاط المزرعة بجوائز' : 'Farm Rewards Catalog'}
              </h2>
              <p className="text-xs text-zinc-400">
                {dir === 'rtl'
                  ? 'حوّل عملاتك إلى قسائم شراء وخصومات على الطابعات والخيوط'
                  : 'Convert your coins into vouchers and filament discounts'}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800 flex items-center justify-between">
              <div>
                <div className="font-bold text-white text-sm">
                  {dir === 'rtl' ? 'قسيمة خصم 5,000 د.ع' : '5,000 IQD Discount Voucher'}
                </div>
                <div className="text-xs text-zinc-400">500 Farm Coins</div>
              </div>
              <button type="button" className={BTN_PRIMARY}>
                {dir === 'rtl' ? 'استبدال' : 'Redeem'}
              </button>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800 flex items-center justify-between">
              <div>
                <div className="font-bold text-white text-sm">
                  {dir === 'rtl' ? 'بكرة خيط PLA مجانية' : 'Free PLA Filament Spool'}
                </div>
                <div className="text-xs text-zinc-400">2,500 Farm Coins</div>
              </div>
              <button type="button" className={BTN_PRIMARY}>
                {dir === 'rtl' ? 'استبدال' : 'Redeem'}
              </button>
            </div>
          </div>
        </div>
      </GamesBody>
    </GamesPage>
  );
}
