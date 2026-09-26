import type React from 'react';

/**
 * ROVING FOCUS for the finder's option groups (WAI-ARIA radio group pattern,
 * minus "arrow selects": selecting advances the finder, so arrows only move
 * focus and Space/Enter chooses). One option is tabbable — the chosen one, or
 * the first — so Tab leaves the group in one press.
 *
 * Arrow keys follow the SCREEN: in RTL, ArrowLeft moves to the next option.
 */
export function onGroupKeyDown(e: React.KeyboardEvent<HTMLElement>, dir: 'rtl' | 'ltr') {
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const group = e.currentTarget;
  const items = Array.from(group.querySelectorAll<HTMLElement>('[data-choice]:not([aria-disabled="true"])'));
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next = at;
  const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  if (e.key === 'ArrowDown' || e.key === forward) next = at < 0 ? 0 : (at + 1) % items.length;
  else if (e.key === 'ArrowUp' || e.key === backward) next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  e.preventDefault();
  items[next]?.focus();
}

/** A click from the keyboard (Enter/Space) has `detail === 0`; it must not auto-advance. */
export const fromPointer = (e: React.MouseEvent): boolean => e.detail > 0;
