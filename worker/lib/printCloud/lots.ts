/**
 * FIFO lot draws, shared by the three ledgers that value what they move:
 * printing-hour credit lots (what a second was bought for), customer material
 * lots (what a gram was bought for) and workshop stock lots (what a gram cost).
 *
 * VALUES ARE CUMULATIVE, NOT PER DRAW. Drawing k units from a lot of `total`
 * units bought for `paid` is valued as
 *
 *     round(paid × (drawnBefore + k) / total) − round(paid × drawnBefore / total)
 *
 * so however a lot is drawn — one gram at a time or all at once — the values
 * of its draws sum to exactly `paid`, never a dinar more or less.
 */
import { mulDivRound } from './util';

export interface LotState {
  id: string;
  /** Units the lot started with. */
  total: number;
  /** Units not yet drawn. */
  remaining: number;
  /** What the whole lot was worth (paid, or cost), integer dinars. */
  value: number;
}

export interface LotDraw {
  lotId: string;
  qty: number;
  value: number;
  /** The lot's remaining units the plan read; the batch fences on it. */
  expectedRemaining: number;
}

export function drawValue(lot: LotState, qty: number): number {
  if (lot.total <= 0) return 0;
  const before = lot.total - lot.remaining;
  return mulDivRound(lot.value, before + qty, lot.total) - mulDivRound(lot.value, before, lot.total);
}

/** Draw `qty` units from `lots` in the order given. `shortfall` > 0 means the lots could not cover it. */
export function planDraws(lots: LotState[], qty: number): { draws: LotDraw[]; shortfall: number; value: number } {
  const draws: LotDraw[] = [];
  let left = qty;
  let value = 0;
  for (const lot of lots) {
    if (left <= 0) break;
    if (lot.remaining <= 0) continue;
    const k = Math.min(lot.remaining, left);
    const v = drawValue(lot, k);
    draws.push({ lotId: lot.id, qty: k, value: v, expectedRemaining: lot.remaining });
    value += v;
    left -= k;
  }
  return { draws, shortfall: Math.max(0, left), value };
}

/**
 * Take a plan's draws out of the lot states it was made from, in place. A
 * batch that draws the same lots twice plans the second draw from what the
 * first left: its fences then expect the quantities the first draw's UPDATEs
 * leave behind, and its values continue each lot's cumulative count.
 */
export function applyDraws(lots: LotState[], draws: LotDraw[]): void {
  for (const d of draws) {
    const lot = lots.find((l) => l.id === d.lotId);
    if (lot) lot.remaining -= d.qty;
  }
}

/** The value of `qty` units taken from `lots` in order, without drawing (an estimate for a buyback request). */
export function previewValue(lots: LotState[], qty: number): number {
  return planDraws(lots, qty).value;
}
