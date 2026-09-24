/**
 * The Levo card — drawn small, as the object it is.
 *
 * Two sizes of the same face. `CardArt` is the tier's card at a glance (the
 * tier cards, the checkout bar, the success state): the tier's own face, its
 * mark, a hairline where the number goes — no chip drawing, no glass layers,
 * no glow. `LevoCard` is the member's own card in the header: the same face
 * with their name, the twelve-digit Levo ID behind an eye toggle, and the tier.
 *
 * Cosmetic, and honest about it: the number is derived from the account id
 * (twelve digits in three groups — see cardNumber.ts), the tier comes from
 * the memberships ledger, and nothing here is sent anywhere.
 */
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Eye, EyeOff } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { cardNumberFor, maskCardNumber } from './cardNumber';
import { TIER_META, type PaidTier } from './tierMeta';

const ART_SIZE = {
  xs: 'w-9 h-[23px] rounded-[5px]',
  sm: 'w-14 h-[35px] rounded-[7px]',
  md: 'w-[4.5rem] h-[2.85rem] rounded-[9px]',
  lg: 'w-44 h-[6.95rem] rounded-[14px]',
} as const;

/**
 * THE MATERIAL. A Levo card is an object from a print shop, so its surface is
 * printed: fine horizontal layer lines — the grain every FDM part carries —
 * under a wash of the tier's colour from one corner and a single diagonal
 * sheen, on a near-black body. The same material draws the big cards on
 * /subscription and the member's own card, so the card you choose is the card
 * you get. The body stays dark in the light theme too: it is a physical card,
 * not a surface of the page.
 */
export function cardMaterial(tier: PaidTier): React.CSSProperties {
  const hex = TIER_META[tier].hex;
  return {
    backgroundColor: '#0f1012',
    backgroundImage: [
      'linear-gradient(115deg, transparent 34%, rgb(255 255 255 / 0.07) 47%, transparent 60%)',
      'repeating-linear-gradient(0deg, rgb(255 255 255 / 0.035) 0 1px, transparent 1px 4px)',
      `radial-gradient(130% 95% at 100% 0%, ${hex}66 0%, ${hex}1f 38%, transparent 62%)`,
      `radial-gradient(90% 80% at 0% 100%, ${hex}26 0%, transparent 58%)`,
      'linear-gradient(160deg, #1c1e21 0%, #0c0d0f 100%)',
    ].join(', '),
    borderColor: `${hex}4d`,
    boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.12), 0 24px 48px -28px rgb(0 0 0 / 0.85)',
  };
}

/** A tier's card face at a glance. Decorative: the name is always said beside it. */
export function CardArt({ tier, size = 'sm', className = '' }: { tier: PaidTier; size?: keyof typeof ART_SIZE; className?: string }) {
  const meta = TIER_META[tier];
  const big = size === 'lg';
  return (
    <span
      aria-hidden
      data-card-art={tier}
      className={`relative block shrink-0 overflow-hidden border ${ART_SIZE[size]} ${className}`}
      style={cardMaterial(tier)}
    >
      <meta.Icon className={`absolute ${big ? 'top-3 start-3 w-5 h-5' : 'top-[18%] start-[12%] w-[26%] h-[40%]'}`} style={{ color: meta.hex }} />
      {big && (
        // No dir here: on a positioned element `end` follows the element's own
        // direction, and an LTR label would land on the icon in Arabic.
        <span className="absolute top-3 end-3 text-[11px] font-extrabold text-white/85">{meta.label}</span>
      )}
      <span className="absolute bottom-[18%] start-[12%] end-[34%] h-[6%] min-h-[2px] rounded-full bg-white/20" />
    </span>
  );
}

export interface LevoCardProps {
  user: { id: string; name?: string | null; username?: string | null };
  tier: PaidTier;
}

/** The member's own card, compact. */
export function LevoCard({ user, tier }: LevoCardProps) {
  const { t } = useLanguage();
  const m = useMotion();
  const [show, setShow] = useState(false);
  const meta = TIER_META[tier];
  const full = cardNumberFor(user.id);
  const masked = maskCardNumber(full);

  return (
    <div
      data-levo-card={tier}
      className="relative shrink-0 w-[10.5rem] sm:w-[15.5rem] aspect-[1.586/1] rounded-[14px] sm:rounded-[18px] border p-3 sm:p-3.5 flex flex-col justify-between overflow-hidden"
      style={cardMaterial(tier)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <meta.Icon className="w-4 h-4 shrink-0" style={{ color: meta.hex }} aria-hidden />
          <span className="text-[13px] font-extrabold text-white" dir="ltr">
            {meta.label}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-pressed={show}
          aria-label={show ? t('hideCardNumber') : t('showCardNumber')}
          className="shrink-0 -m-2 w-11 h-11 flex items-center justify-center text-white/70 hover:text-white rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {show ? <EyeOff className="w-4 h-4" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
        </button>
      </div>

      <div>
        {/* Twelve digits in three groups: fits the card at 360px with room to spare. */}
        <div className="relative h-6" dir="ltr">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={show ? 'full' : 'masked'}
              data-card-number
              initial={{ opacity: 0, y: m.travel(6) }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: m.travel(-6) }}
              transition={m.spring('quick')}
              className="absolute inset-x-0 font-mono text-[13px] sm:text-[15px] whitespace-nowrap text-white tabular-nums"
            >
              {show ? full : masked}
            </motion.p>
          </AnimatePresence>
        </div>
        <p className="mt-0.5 text-[11px] text-white/60 truncate">
          {user.name || (user.username ? `@${user.username}` : t('levoId'))}
        </p>
      </div>
    </div>
  );
}

export default LevoCard;
