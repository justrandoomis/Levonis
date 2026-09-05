/**
 * A callout that carries ONE fact the customer should read before acting —
 * the printer home-delivery amount, a pricing rule that just changed the
 * total — and nothing that could be mistaken for a control or a total.
 *
 * It is a `role="note"`: a screen reader announces it as an aside, not as an
 * alert, because nothing has gone wrong. The tones are the house tints —
 * gold for the store's own terms (the PRO strip on the warranty page uses the
 * same pair), amber for something to weigh before continuing, zinc for a
 * quiet aside inside a receipt-like column. Every one keeps a hairline on the
 * START edge so the block reads as a margin note in both writing directions
 * (`border-s`, a logical property), rather than as a card that competes with
 * the price beside it.
 *
 * Motion: a note that appears because the quote changed (a printer line came
 * back, a payment method switched) rises a few pixels on the house `quick`
 * spring; under reduced motion `useMotion` collapses that to a cross-fade.
 * `animate={false}` renders it inert for surfaces that mount with the page.
 */
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { useMotion } from '../../lib/motion';

export type NoteTone = 'gold' | 'amber' | 'zinc';

const TONES: Record<NoteTone, { box: string; icon: string; edge: string }> = {
  gold: {
    box: 'border-[#BAA369]/30 bg-[#BAA369]/10 text-zinc-100',
    icon: 'text-[#BAA369]',
    edge: 'border-s-[#BAA369]',
  },
  amber: {
    box: 'border-amber-500/25 bg-amber-500/10 text-amber-100',
    icon: 'text-amber-300',
    edge: 'border-s-amber-400',
  },
  zinc: {
    box: 'border-white/10 bg-white/[0.03] text-zinc-300',
    icon: 'text-zinc-400',
    edge: 'border-s-zinc-500',
  },
};

export interface NoteProps {
  tone?: NoteTone;
  /** A lucide icon element; sized by the caller (w-4 h-4 reads best). */
  icon?: ReactNode;
  children: ReactNode;
  /** `compact` tightens the padding for a note inside a list row. */
  compact?: boolean;
  animate?: boolean;
  className?: string;
  testId?: string;
}

export default function Note({
  tone = 'zinc',
  icon,
  children,
  compact = false,
  animate = true,
  className = '',
  testId,
}: NoteProps) {
  const m = useMotion();
  const t = TONES[tone];
  const shape = compact
    ? 'rounded-xl ps-3 pe-3 py-2 text-[12.5px]'
    : 'rounded-2xl ps-3.5 pe-4 py-3 text-[13px]';
  return (
    <motion.div
      role="note"
      data-testid={testId}
      data-note-tone={tone}
      initial={animate ? { opacity: 0, y: m.travel(6) } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={m.spring('quick')}
      className={`flex items-start gap-2.5 border border-s-2 leading-snug ${t.box} ${t.edge} ${shape} ${className}`}
    >
      {icon ? <span aria-hidden="true" className={`mt-0.5 shrink-0 ${t.icon}`}>{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </motion.div>
  );
}
