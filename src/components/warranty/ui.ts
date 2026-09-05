/**
 * Shared class strings for the warranty surface, so every button in the
 * section presses, focuses and disables the same way.
 */

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]';

/** The house secondary action: quiet zinc, full height, icon + label. */
export const BTN_SECONDARY = `inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border border-zinc-700/70 bg-zinc-800/70 hover:bg-zinc-800 text-zinc-100 text-[13px] font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`;

/** The one gold action per card/panel. */
export const BTN_PRIMARY = `inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-xl bg-[#BAA369] text-black text-[13px] font-bold hover:brightness-110 transition-[filter,opacity] disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS}`;

/** Destructive confirmation only — never on a card face. */
export const BTN_DANGER = `inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-xl bg-[#ef233c] text-white text-[13px] font-bold hover:brightness-110 transition-[filter,opacity] disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`;

/** Inline text action / navigation link inside a card. */
export const LINK_QUIET = `inline-flex items-center gap-1 min-h-[32px] text-[12px] font-medium text-zinc-400 hover:text-white underline-offset-2 hover:underline rounded transition-colors ${FOCUS}`;

export const INPUT = `w-full min-w-0 bg-zinc-950/70 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm placeholder:text-zinc-600 outline-none focus:border-[#BAA369]/50 transition-colors ${FOCUS}`;

export const CARD = 'rounded-2xl border border-zinc-800 bg-zinc-900/60';

export const ERROR_BOX = 'bg-red-500/10 border border-red-500/30 text-red-300 text-[13px] font-medium rounded-xl p-3';
export const OK_BOX = 'bg-[#BAA369]/10 border border-[#BAA369]/30 text-[#BAA369] text-[13px] font-medium rounded-xl p-3';
