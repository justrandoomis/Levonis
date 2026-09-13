import type { BloubState } from './BloubHome';
export const BLOUB_EVENT = 'levonis:bloub-state';
const states = new Set<BloubState>(['idle', 'thinking', 'navigation', 'success', 'notify', 'tap', 'error']);
export function isBloubState(value: unknown): value is BloubState {
  return typeof value === 'string' && states.has(value as BloubState);
}
export function bloubDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(5000, Math.max(180, value)) : 650;
}
export function signalBloub(state: BloubState, durationMs = 650): void {
  if (typeof window === 'undefined' || !isBloubState(state)) return;
  window.dispatchEvent(new CustomEvent(BLOUB_EVENT, { detail: { state, durationMs: bloubDuration(durationMs) } }));
}
