/**
 * THE FOLLOW BUTTON (community UI plan B2; tokens.md §6 row 4). One look for
 * a person (social/FollowUserButton) and for a store (hub/useStoreFollow), so
 * a maker card and a store card answer the same press the same way.
 *
 *   rest       raised clay, the UserPlus glyph and «متابعة»; `tone="gold"`
 *              draws the rest state in the sand-gold gradient of the primary
 *              verb instead, as the directory references do (IMG_8476,
 *              IMG_8469); the screen that uses it decides
 *   following  pressed into the card (the dent, the well fill), the gold
 *              check and «تتابعه» (plan R12: one form, no gender stored)
 *   busy       held in the dent while the write is in flight, a second press
 *              refused, the width kept (no spinner: the label already moved)
 *
 * The state is `aria-pressed`, so it is never the colour alone, and the
 * label cross-fades on the `quick` spring (a plain swap under reduced
 * motion). It sits above the stretched link of a card (`relative z-10`).
 * `sm` is drawn 36px inside a 44px hit (`lv-hit`), `md` is 44px
 * (`min-h-11`). Every look is a class the app already ships: `.lv-button`
 * and the scope sheet (`cm-btn-clay`, `cm-btn-gold`, `cm-btn-compact`).
 */
import { AnimatePresence, motion } from 'motion/react';
import { Check, UserPlus } from 'lucide-react';
import { useMotion } from '../../../lib/motion';
import { useKitStrings } from './strings';

export interface FollowButtonProps {
  following: boolean;
  onToggle: () => void;
  /** A write in flight: held in the dent, presses refused. */
  busy?: boolean;
  size?: 'sm' | 'md';
  /** The rest look: raised clay (default) or the sand-gold gradient. */
  tone?: 'clay' | 'gold';
  /** Who is followed, so two buttons on one page never share a name («متابعة: سارة حسن»). */
  name?: string;
  className?: string;
  /** A marker for probes and tests (`data-social="follow"`, `data-community-follow`). */
  'data-social'?: string;
}

export default function FollowButton({ following, onToggle, busy = false, size = 'md', tone = 'clay', name, className = '', 'data-social': testAttr }: FollowButtonProps) {
  const s = useKitStrings();
  const m = useMotion();
  const label = following ? s.following : s.follow;
  const look = following
    ? 'lv-button-secondary cm-btn-clay bg-[var(--clay-well-bg)] shadow-press text-text-secondary hover:text-text-primary'
    : tone === 'gold'
      ? 'cm-btn-gold'
      : 'lv-button-secondary cm-btn-clay';
  const geometry = size === 'sm' ? 'lv-button-sm cm-btn-compact lv-hit text-[14px]' : 'min-h-11 text-[15px]';
  const glyph = size === 'sm' ? 'h-4 w-4' : 'h-[18px] w-[18px]';
  return (
    <button
      type="button"
      onClick={() => {
        if (!busy) onToggle();
      }}
      aria-pressed={following}
      aria-label={name ? `${label}: ${name}` : undefined}
      aria-busy={busy || undefined}
      data-busy={busy || undefined}
      data-social={testAttr}
      data-on={following ? 'true' : 'false'}
      data-tone={tone}
      className={`lv-button ${look} ${geometry} relative z-10 shrink-0 whitespace-nowrap ${className}`}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={following ? 'on' : 'off'}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={m.spring('quick')}
          className="inline-flex items-center gap-1.5"
        >
          {following ? <Check aria-hidden="true" className={`${glyph} text-gold`} strokeWidth={2.5} /> : <UserPlus aria-hidden="true" className={glyph} strokeWidth={2} />}
          {label}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
