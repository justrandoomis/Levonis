/**
 * THE ⚡ TOGGLE AND THE MORPHING MAIN BUTTON (docs/GIFTS_QUICK_BUY.md §3.5).
 *
 * The product page's only static Quick Buy code: the 48px toggle at the inline
 * end of «أضف إلى السلة», and the content swap that turns that button into
 * «⚡ شراء سريع» and back. Everything else — the activation sheet, the add
 * itself, its toasts and refusals — is a lazy chunk the toggle warms on
 * pointerdown and focus (src/pages/Product.tsx).
 *
 * THE MORPH. Both labels share ONE layout cell (a one-cell grid) and are
 * carried by the same spring from `useMotion()`: the outgoing one rolls up
 * and softens out of focus while the incoming one rises into place, so the
 * button never changes size and nothing beside it moves. A second tap
 * mid-flight reverses it from where it is (springs are interruptible). Under
 * reduced motion there is no travel and no blur — `m.spring()` collapses to
 * the house cross-fade and `m.travel()` to zero.
 *
 * THE TOGGLE is a real `aria-pressed` button with a constant name («وضع
 * الشراء السريع»): the pressed state says on or off, the tooltip says what
 * pressing it will do. Off, it is a quiet raised square with a gold outline
 * bolt; on, the gold-tinted accent square with the bolt filled — the accent at
 * the low intensity the design system asks for, next to a primary button that
 * stays the page's one solid fill.
 */
import React from 'react';
import * as Motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { Zap } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { MotionFeatures } from '../../lib/motionFeatures';
import { quickBuyChrome } from './chromeStrings';

export function QuickBuyToggle({
  on,
  onToggle,
  onWarm,
  busy = false,
}: {
  on: boolean;
  onToggle: () => void;
  /** Fetch the lazy Quick Buy chunks now: the finger is already on the button. */
  onWarm: () => void;
  /** A Quick Buy add is in flight: the mode cannot change under it. */
  busy?: boolean;
}) {
  const m = useMotion();
  const { lang } = useLanguage();
  const s = quickBuyChrome(lang);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={s.toggle}
      title={on ? s.toggleOffHint : s.toggleOnHint}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) onToggle();
      }}
      onPointerDown={onWarm}
      onFocus={onWarm}
      data-quick-buy-toggle={on ? 'on' : 'off'}
      className={`lv-button ${on ? 'lv-button-accent' : 'lv-button-secondary'} relative w-12 shrink-0 px-0 min-h-[50px] [touch-action:manipulation]`}
    >
      <MotionFeatures>
        <Motion.span
          aria-hidden="true"
          className="flex"
          initial={false}
          animate={m.reduced ? { scale: 1, rotate: 0 } : { scale: on ? 1.08 : 1, rotate: on ? -8 : 0 }}
          transition={m.spring('quick')}
        >
          <Zap className={`w-5 h-5 text-gold ${on ? 'fill-current' : ''}`} strokeWidth={1.9} />
        </Motion.span>
      </MotionFeatures>
    </button>
  );
}

/**
 * The main button's content, rolled between its two modes. `children` is the
 * content of the mode in force (icon + label); a change of label WITHIN a
 * mode — «جارٍ الإضافة…», «تمت الإضافة» — is not a mode change and does not
 * roll.
 */
export function QuickBuyCtaMorph({ quick, children }: { quick: boolean; children: React.ReactNode }) {
  const m = useMotion();
  const rise = m.travel(14);
  const soft = m.reduced ? 'blur(0px)' : 'blur(4px)';
  return (
    <span className="grid place-items-center w-full">
      <MotionFeatures>
        <AnimatePresence initial={false}>
          <Motion.span
            key={quick ? 'quick' : 'cart'}
            data-cta-mode={quick ? 'quick' : 'cart'}
            className="inline-flex items-center justify-center gap-2"
            style={{ gridArea: '1 / 1' }}
            initial={{ opacity: 0, y: rise, filter: soft }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -rise, filter: soft }}
            transition={m.spring('ui')}
          >
            {children}
          </Motion.span>
        </AnimatePresence>
      </MotionFeatures>
    </span>
  );
}

/** The bolt the main button carries in Quick Buy mode. */
export function QuickBuyBolt() {
  return <Zap aria-hidden="true" className="w-5 h-5 fill-current" strokeWidth={1.9} />;
}
