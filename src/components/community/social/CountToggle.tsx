/**
 * ONE PRESSABLE MARK WITH ITS NUMBER — what a like and a save have in common.
 *
 * OPTIMISTIC, THEN CORRECTED. The mark flips and the number moves the moment
 * the finger lands; the server's answer (idempotent, so a replay is harmless)
 * then sets both to what is true, and a refusal puts them back. A second tap
 * while the first is in flight is dropped rather than queued — the server
 * would answer the same either way.
 *
 * THE NUMBER ROLLS. The old count leaves upward and the new one arrives from
 * below (`AnimatePresence` popLayout inside a clipped box), on the `quick`
 * spring; with reduced motion `travel()` is 0 and the two cross-fade. The
 * icon itself grows to 1.15 and settles on the same spring when the mark
 * turns on; colour is a 150 ms CSS transition, never a spring.
 *
 * A 44 px round target that sits ABOVE a card's stretched link
 * (`relative z-10`), says its state (`aria-pressed`), and hides its number at
 * zero. A guest is taken to sign in and brought back here.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth } from '../../../AuthContext';
import { useSignInPrompt } from '../../../lib/guest';
import { useMotion } from '../../../lib/motion';
import { toast } from '../../ui/Toast';

export interface CountToggleProps {
  on: boolean;
  count: number;
  size?: 'sm' | 'md';
  /** Accessible names for the two states. */
  labelOn: string;
  labelOff: string;
  /** The counted noun for screen readers, e.g. «12 إعجابًا». */
  countLabel: (n: number) => string;
  icon: (on: boolean, className: string) => React.ReactNode;
  /** The write; resolves to what the server says is true now. */
  toggle: (next: boolean) => Promise<{ on: boolean; count: number }>;
  onChange?: (on: boolean, count: number) => void;
  /** Said when the write is refused. */
  failText: string;
  className?: string;
  'data-social'?: string;
}

export default function CountToggle({
  on: onProp,
  count: countProp,
  size = 'md',
  labelOn,
  labelOff,
  countLabel,
  icon,
  toggle,
  onChange,
  failText,
  className = '',
  'data-social': testAttr,
}: CountToggleProps) {
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const m = useMotion();
  const [on, setOn] = useState(onProp);
  const [count, setCount] = useState(countProp);
  const [pop, setPop] = useState(false);
  const busy = useRef(false);

  // The server (or a parent) may say something new about this post.
  useEffect(() => setOn(onProp), [onProp]);
  useEffect(() => setCount(countProp), [countProp]);

  const press = () => {
    if (!isAuthenticated) return signIn();
    if (busy.current) return;
    busy.current = true;
    const next = !on;
    const before = { on, count };
    setOn(next);
    setCount(Math.max(0, count + (next ? 1 : -1)));
    if (next && !m.reduced) setPop(true);
    toggle(next)
      .then((r) => {
        setOn(r.on);
        setCount(r.count);
        onChange?.(r.on, r.count);
      })
      .catch(() => {
        setOn(before.on);
        setCount(before.count);
        toast.error(failText);
      })
      .finally(() => {
        busy.current = false;
      });
  };

  const iconSize = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  return (
    <button
      type="button"
      onClick={press}
      aria-pressed={on}
      aria-label={`${on ? labelOn : labelOff}${count > 0 ? ` — ${countLabel(count)}` : ''}`}
      data-social={testAttr}
      data-on={on ? 'true' : 'false'}
      className={`press-scale relative z-10 inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        on ? 'text-gold' : 'text-text-secondary hover:text-text-primary'
      } ${size === 'sm' ? 'text-[12px]' : 'text-[13px]'} ${className}`}
    >
      <motion.span
        aria-hidden="true"
        className="inline-flex"
        animate={{ scale: pop ? 1.15 : 1 }}
        transition={m.spring('quick')}
        onAnimationComplete={() => {
          if (pop) setPop(false);
        }}
      >
        {icon(on, `${iconSize} transition-colors ${on ? 'fill-gold' : ''}`)}
      </motion.span>
      {count > 0 && (
        <span aria-hidden="true" className="relative inline-flex min-w-5 justify-center overflow-hidden font-semibold tabular-nums">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={count}
              initial={{ y: m.travel(6), opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: m.travel(-6), opacity: 0 }}
              transition={m.spring('quick')}
              className="inline-block"
            >
              {count}
            </motion.span>
          </AnimatePresence>
        </span>
      )}
    </button>
  );
}
