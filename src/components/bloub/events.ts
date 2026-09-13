import { isMascotState, type MascotState } from '../../lib/mascot';
/** Compatibility for the already-integrated Home controls/custom events. */
export type BloubState = MascotState | 'thinking' | 'navigation';
export const BLOUB_EVENT = 'levonis:bloub-state';
export function isBloubState(value: unknown): value is BloubState {
  return value === 'thinking' || value === 'navigation' || isMascotState(value);
}
export function canonicalBloubState(state: BloubState): MascotState {
  return state === 'thinking' ? 'loading' : state === 'navigation' ? 'navigating' : state;
}
export function bloubDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(5000, Math.max(180, value)) : 650;
}
export function signalBloub(state: BloubState, durationMs = 650): void {
  if (typeof window === 'undefined' || !isBloubState(state)) return;
  window.dispatchEvent(new CustomEvent(BLOUB_EVENT, { detail: { state, durationMs: bloubDuration(durationMs) } }));
}
