/**
 * The membership card at the top of /subscription.
 *
 * Cosmetic, and honest about it: the number is derived from the account id
 * (twelve digits in three groups — see cardNumber.ts), the tier and the
 * expiry come from the memberships ledger, and a guest's card carries no name
 * and no number so it cannot look like an account they already have.
 */
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Eye, EyeOff } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { dateLocale } from '../orders/format';
import { cardNumberFor, maskCardNumber, CARD_PLACEHOLDER } from './cardNumber';
import { FREE_FACE, TIER_META, isPaidTier, type AnyTier } from './tierMeta';

export interface LevoCardProps {
  user: { id: string; name?: string | null; username?: string | null } | null;
  tier: AnyTier;
  expiresAt: string | null;
}

export function LevoCard({ user, tier, expiresAt }: LevoCardProps) {
  const { t, loc, lang } = useLanguage();
  const m = useMotion();
  const [show, setShow] = useState(false);

  const full = user ? cardNumberFor(user.id) : CARD_PLACEHOLDER;
  const masked = user ? maskCardNumber(full) : CARD_PLACEHOLDER;
  const meta = isPaidTier(tier) ? TIER_META[tier] : null;
  const face = meta ? meta.cardFace : FREE_FACE.cardFace;
  const dot = meta ? meta.dot : FREE_FACE.dot;

  const validThru = (() => {
    if (!expiresAt || !meta) return '';
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(dateLocale(lang), { month: '2-digit', year: '2-digit' }).format(d);
  })();

  return (
    <div className="w-full max-w-sm">
      <div
        data-levo-card={tier}
        className={`relative border border-white/20 rounded-[24px] p-5 sm:p-6 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.5)] overflow-hidden aspect-[1.58/1] flex flex-col justify-between w-full ${face}`}
        style={meta ? { boxShadow: `0 20px 40px -15px rgba(0,0,0,0.5), 0 0 0 1px ${meta.hex}22 inset` } : undefined}
      >
        {/* Glass reflections */}
        <div className="absolute inset-0 bg-gradient-to-tr from-white/5 to-transparent pointer-events-none" />
        <div className="absolute top-0 inset-x-0 h-1/2 bg-gradient-to-b from-white/10 to-transparent opacity-50 rounded-t-[24px] pointer-events-none" />

        <div className="flex justify-between items-start z-10 gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-full bg-gradient-to-br from-olive-light to-black flex items-center justify-center text-white font-bold text-sm shadow-[inset_0_2px_4px_rgba(255,255,255,0.2)]">
              {user?.name ? user.name.charAt(0).toUpperCase() : 'L'}
            </div>
            {/* A guest reads this page to decide whether to join, so the card
                must not wear a name — an invented handle looks like an account
                they already have. */}
            <span className="font-bold text-white text-[17px] drop-shadow-sm truncate">
              {user?.name || loc('بطاقة العضوية', 'Membership card', 'کارتی ئەندامێتی')}
            </span>
          </div>
          {user && (
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-pressed={show}
              aria-label={show ? t('hideCardNumber') : t('showCardNumber')}
              className="shrink-0 w-10 h-10 flex items-center justify-center text-zinc-300 hover:text-white transition-colors rounded-full bg-white/5 hover:bg-white/10 press-scale focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
            >
              {show ? <EyeOff className="w-5 h-5" aria-hidden /> : <Eye className="w-5 h-5" aria-hidden />}
            </button>
          )}
        </div>

        <div className="z-10 mt-3 flex items-center justify-between">
          <svg viewBox="0 0 40 30" className="w-10 h-8 opacity-80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect width="40" height="30" rx="4" fill="#D4AF37" fillOpacity="0.8" />
            <path d="M10 0V30 M20 0V30 M30 0V30 M0 10H40 M0 20H40" stroke="#B8860B" strokeWidth="1" />
            <path d="M5 5 H15 V15 H5 Z" stroke="#B8860B" strokeWidth="1" fill="none" />
          </svg>
        </div>

        {/* Twelve digits in three groups: fits the card at 360px with room to spare. */}
        <div className="z-10 mt-3 relative h-8 flex items-center" dir="ltr">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={show ? 'full' : 'masked'}
              data-card-number
              initial={{ opacity: 0, y: m.travel(8) }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: m.travel(-8) }}
              transition={m.spring('quick')}
              className="font-mono text-[clamp(17px,5.2vw,22px)] tracking-[0.12em] whitespace-nowrap text-white absolute inset-x-0 drop-shadow-md tabular-nums"
            >
              {show ? full : masked}
            </motion.p>
          </AnimatePresence>
        </div>
        <p className="text-zinc-400 text-[10px] font-bold uppercase tracking-[0.2em] mt-1 z-10" dir="ltr">
          {t('levoId')}
        </p>

        <div className="flex justify-between items-end z-10 mt-auto gap-3">
          <div className="min-w-0">
            <p className="text-white font-bold text-[15px] mb-1 drop-shadow-sm truncate">
              {user?.username ? `@${user.username}` : loc('لست مشتركًا بعد', 'Not a member yet', 'هێشتا ئەندام نیت')}
            </p>
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full shadow-[0_0_8px_currentColor] ${dot}`} aria-hidden />
              <p className="text-xs text-zinc-400 font-medium">
                {t('tierWord')}: <span className={meta ? `${meta.text} font-bold` : 'text-zinc-300'}>{meta ? meta.label : t('freeLabel')}</span>
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            {validThru && (
              <div className="flex flex-col items-end">
                <p className="text-zinc-400 text-[9px] font-bold uppercase tracking-[0.1em] mb-0.5 opacity-80">{t('validThru')}</p>
                <p className="text-white font-mono text-[11px] tracking-wider tabular-nums" dir="ltr">{validThru}</p>
              </div>
            )}
            <div className="flex flex-col items-end">
              <p className="text-zinc-400 text-[9px] font-bold uppercase tracking-[0.2em] mb-0.5">{t('status')}</p>
              <p
                className={`text-[11px] font-bold px-2 py-0.5 rounded-md border shadow-sm ${
                  meta ? 'bg-white/10 text-white border-white/20' : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50'
                }`}
              >
                {meta ? t('active') : t('freeLabel')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LevoCard;
