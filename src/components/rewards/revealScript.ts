/**
 * THE ANALYSIS' SCRIPT (owner, 2026-11-05; DECISIONS row 301): which step comes
 * when, what each step's bar fills to, where a returning customer lands. No React
 * and no DOM, so tests/giftRevealScript.test.ts runs it as it is.
 *
 * It DECIDES NOTHING the server owns and invents no figure: every step reads the
 * answer of POST /api/rewards/program/gift-code. A part is shown at its real score,
 * a missing video at its real 0, and when the final score is not the parts' sum the
 * difference is one step of its own. The clock below only says how long to dwell.
 */
import type { GiftReveal } from './types';
import type { GiftStatus, GiftView } from '../reviews/gifts/GiftCard';

export type RevealStepKey = 'download' | 'text' | 'images' | 'video' | 'story' | 'stars' | 'adjust' | 'total' | 'level' | 'settle';

export interface RevealStep {
  key: RevealStepKey;
  /** How long the step holds before the next one starts. */
  ms: number;
  /** For a 'level' step: which level lights. */
  level?: number;
}

/** The dwell of each step, in milliseconds. Between them, about 7 to 9 seconds whatever the review says. */
export const REVEAL_MS = {
  download: 1350,
  text: 1000,
  images: 800,
  video: 800,
  story: 800,
  stars: 450,
  adjust: 450,
  total: 1100,
  level: 280,
  settle: 420,
} as const;

/** The steps of one review, in order. */
export function revealScript(data: Pick<GiftReveal, 'levels' | 'breakdown'>): RevealStep[] {
  const steps: RevealStep[] = [
    { key: 'download', ms: REVEAL_MS.download },
    { key: 'text', ms: REVEAL_MS.text },
    { key: 'images', ms: REVEAL_MS.images },
    { key: 'video', ms: REVEAL_MS.video },
    { key: 'story', ms: REVEAL_MS.story },
    { key: 'stars', ms: REVEAL_MS.stars },
  ];
  if (data.breakdown.adjustment !== 0) steps.push({ key: 'adjust', ms: REVEAL_MS.adjust });
  steps.push({ key: 'total', ms: REVEAL_MS.total });
  for (const level of data.levels) steps.push({ key: 'level', ms: REVEAL_MS.level, level });
  steps.push({ key: 'settle', ms: REVEAL_MS.settle });
  return steps;
}

export const scriptDuration = (steps: readonly RevealStep[]): number => steps.reduce((sum, s) => sum + s.ms, 0);

/** How far a part's bar fills: its real share, from 0 to 1. */
export function fillOf(score: number, max: number): number {
  if (!(max > 0) || !(score > 0)) return 0;
  return Math.min(1, score / max);
}

/** The rail's fill when `lit` levels are lit: the first disc is its start, the fifth its end. */
export const railFill = (lit: number): number => (lit <= 1 ? 0 : Math.min(1, (lit - 1) / 4));

/** The next figure of the count-up: quick at first, settling on the real score. Never past it. */
export function countAt(to: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return to;
  if (elapsed <= 0) return 0;
  const t = elapsed / duration;
  return Math.min(to, Math.round(to * (1 - (1 - t) ** 3)));
}

// ------------------------------------------------------------------ the motion

/**
 * EVERY MOVE OF THE SHEET, AS DATA. Web Animations with these frames, on `transform`
 * and `opacity` and nothing else, so the compositor runs them and a phone keeps its
 * frames; no animation library and no stylesheet of its own (the shop's 60 KB CSS
 * gate has no room for one, and nobody who never writes a code should pay for it).
 * A bar is a full-width block slid into view, never a width that grows or a scaleX
 * that squashes its round end; `sign` turns that slide around on a right-to-left page.
 * tests/giftRevealScript.test.ts reads these frames.
 */
export interface RevealMotion {
  frames: Array<{ transform?: string; opacity?: number }>;
  options: { duration: number; delay?: number; easing: string; fill?: 'backwards' };
  /** Runs until the step that needs it is over. */
  loop?: boolean;
}

export const REVEAL_EASE = 'cubic-bezier(0.22, 0.8, 0.2, 1)';

/** Which way a bar's block slides in: from the start of the line, in either direction of reading. */
export type RevealSign = 1 | -1;
export const signOf = (dir: string): RevealSign => (dir === 'rtl' ? -1 : 1);

/** Where a bar's block rests when it shows `fill` of the bar. */
export const fillTransform = (fill: number, sign: RevealSign): string => `translateX(${(fill - 1) * 100 * sign}%)`;

/** A bar filling from `from` to `to`. */
export const fillMotion = (from: number, to: number, sign: RevealSign, duration: number, delay = 0): RevealMotion => ({
  frames: [{ transform: fillTransform(from, sign) }, { transform: fillTransform(to, sign) }],
  options: { duration, delay, easing: REVEAL_EASE, fill: 'backwards' },
});

/** The band of light that crosses a bar while it fills. Once, and quiet. */
export const sheenMotion = (sign: RevealSign): RevealMotion => ({
  frames: [{ transform: `translateX(${-100 * sign}%)` }, { transform: `translateX(${250 * sign}%)` }],
  options: { duration: 800, delay: 180, easing: 'ease-out', fill: 'backwards' },
});

export const MOTION = {
  /** A row, the total or the result arriving. */
  rise: { frames: [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }], options: { duration: 260, easing: REVEAL_EASE, fill: 'backwards' } },
  /** A part's figure, once its bar has nearly filled. */
  fade: { frames: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 240, delay: 480, easing: 'ease-out', fill: 'backwards' } },
  /** A level coming on. */
  settle: { frames: [{ opacity: 0.4, transform: 'scale(0.82)' }, { opacity: 1, transform: 'scale(1)' }], options: { duration: 340, easing: REVEAL_EASE, fill: 'backwards' } },
  /** A soft band of the accent passing over the card: the review being read. */
  scan: { frames: [{ transform: 'translateY(-70%)' }, { transform: 'translateY(100%)' }], options: { duration: 1700, easing: 'ease-in-out' }, loop: true },
  /** The status line's dot, while the reading goes on. */
  breathe: { frames: [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], options: { duration: 1100, easing: 'ease-in-out' }, loop: true },
} as const satisfies Record<string, RevealMotion>;

/** How long a part's bar takes to fill, and when it starts. */
export const PART_FILL = { duration: 640, delay: 130 } as const;

/** What the sheet shows of a gift: its chooser, its one step left, or how it ended. */
export type RevealStage = 'choose' | 'add' | 'done' | 'ordered' | 'fulfilled' | 'cancelled';

const STAGE: Readonly<Record<GiftStatus, RevealStage>> = {
  GRANTED: 'choose',
  READY_TO_REDEEM: 'choose',
  REDEEMED: 'add',
  ADDED_TO_ORDER: 'done',
  ORDERED: 'ordered',
  FULFILLED: 'fulfilled',
  CANCELLED: 'cancelled',
  LEGACY: 'cancelled',
};

/** Where the gift stands, read from the server's status. */
export const stageOf = (gift: Pick<GiftView, 'status'>): RevealStage => STAGE[gift.status] ?? 'cancelled';

/**
 * Does the analysis play? Only when it was asked for, and never under reduced
 * motion: then the sheet opens on the result, with nothing moving. A customer
 * coming back with a gift they already opened lands on the result too and has
 * «شاهد التحليل» to play it.
 */
export const opensOnAnalysis = (asked: boolean, reduced: boolean): boolean => asked && !reduced;

/** The level the customer's pick came from, for the confirm dialog's words. */
export function itemOfChoice(gift: Pick<GiftView, 'choices'>, itemId: string) {
  return (gift.choices ?? []).find((c) => (c.item_id ?? c.product_id) === itemId) ?? null;
}

/**
 * What the sheet opens with picked: a gift chosen earlier while it is still offered,
 * else a lone choice, else nothing. An item withdrawn since it was chosen is no
 * longer a pick: nothing on the page would be selected, and the confirm would name no gift.
 */
export function initialPick(gift: Pick<GiftView, 'chosen' | 'choices'>): string {
  const choices = gift.choices ?? [];
  const chosen = gift.chosen?.item_id ?? '';
  if (chosen && itemOfChoice(gift, chosen)) return chosen;
  return choices.length === 1 ? (choices[0].item_id ?? choices[0].product_id) : '';
}

/**
 * What a step of the track says: its level once it has lit, until then the score it
 * opens at, whichever levels this review will reach. While the figure is still
 * counting the captions must not tell how it ends.
 */
export function trackCaption(step: { level: number; threshold: number }, lit: boolean): { key: 'rate.level' | 'reveal.opensAt'; n: number } {
  return lit ? { key: 'rate.level', n: step.level } : { key: 'reveal.opensAt', n: step.threshold };
}
