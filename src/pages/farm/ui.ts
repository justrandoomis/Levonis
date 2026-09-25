/**
 * The farm's class tokens. Buttons, focus and cards come from the warranty
 * surface so every control across the store presses the same way; the farm
 * adds only its own palette — industrial dark with a warm gold for money and
 * live machines, olive for a good outcome, amber for a machine that wants
 * attention, red for a failure. Type stays restrained: nothing above ~22px
 * except the coins chip.
 */
export { FOCUS, BTN_PRIMARY, BTN_SECONDARY, BTN_DANGER, INPUT, CARD, ERROR_BOX, OK_BOX } from '../../components/warranty/ui';

export const GOLD = '#BAA369';
/** A readable olive for text and fills — the `olive` token is a surface colour. */
export const OLIVE_TEXT = '#A6B283';
export const AMBER_TEXT = '#E4B363';
export const RED_TEXT = '#E06070';

/** Section panel: hairline rule, no glass. */
export const PANEL = 'rounded-2xl border border-zinc-800/80 bg-black';
/** Sub-row inside a panel. */
export const ROW = 'rounded-xl border border-zinc-800/60 bg-zinc-900/40';
/** Small status chip. */
export const CHIP = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold leading-4 whitespace-nowrap';
/** Mono spec labels (Latin, LTR). */
export const SPEC = 'text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-500';
/** A 44px icon-only control. */
export const ICON_BTN = 'inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xl border border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed';

export const STATE_TEXT: Record<string, string> = {
  idle: 'text-zinc-400',
  printing: 'text-gold',
  done: 'text-sage',
  maintenance: 'text-honey',
  broken: 'text-coral',
};

export const STATE_CHIP: Record<string, string> = {
  idle: 'border-zinc-700 text-zinc-300 bg-zinc-800/60',
  printing: 'border-gold/40 text-gold bg-gold/10',
  done: 'border-sage/40 text-sage bg-sage/10',
  maintenance: 'border-honey/40 text-honey bg-honey/10',
  broken: 'border-coral/40 text-coral bg-coral/10',
};

export const JOB_CHIP: Record<string, string> = {
  accepted: 'border-zinc-700 text-zinc-300 bg-zinc-800/60',
  printing: 'border-gold/40 text-gold bg-gold/10',
  ready: 'border-sage/40 text-sage bg-sage/10',
  delivered: 'border-sage/40 text-sage bg-sage/10',
  late: 'border-honey/40 text-honey bg-honey/10',
  cancelled: 'border-coral/40 text-coral bg-coral/10',
};

export const URGENCY_CHIP: Record<string, string> = {
  urgent: 'border-coral/40 text-coral bg-coral/10',
  tight: 'border-honey/40 text-honey bg-honey/10',
  relaxed: 'border-zinc-700 text-zinc-400 bg-zinc-800/60',
};

/** Health → tint. ≥70 olive, ≥40 amber, else red. */
export function healthTone(health: number): 'good' | 'warn' | 'bad' {
  if (health >= 70) return 'good';
  if (health >= 40) return 'warn';
  return 'bad';
}

export const HEALTH_BAR: Record<'good' | 'warn' | 'bad', string> = {
  good: 'bg-[#A6B283]',
  warn: 'bg-[#E4B363]',
  bad: 'bg-[#E06070]',
};

export const HEALTH_HEX: Record<'good' | 'warn' | 'bad', string> = {
  good: OLIVE_TEXT,
  warn: AMBER_TEXT,
  bad: RED_TEXT,
};
