/**
 * THE ARROW KEYS OF THE SHELL'S OWN GROUPS STOP AT THE GROUP (c6-r4-ha-02).
 *
 * The engine nudges the selected model by 10 mm on every arrow key that
 * reaches `window` (three-slicer/viewer binds it there and skips only text
 * fields and selects). So an arrow pressed on the mode switch moved the model
 * as well as the mode, and an arrow pressed on «العربية» or «داكن» in the
 * «المزيد» sheet moved the model behind the modal: a fresh «نتيجة التقطيع
 * جاهزة» over a model that was no longer where it had been sliced.
 *
 * A key a group handles is therefore consumed there: `preventDefault` for the
 * page scroll, and `stopPropagation`, which stops the native event at React's
 * root listener before it bubbles on to `window`.
 *
 * The keys walk in the writing direction: left is "next" in Arabic and
 * Sorani, right in English; down and up are next and previous in every
 * language; Home and End jump to the ends. The walk stops at the ends rather
 * than wrapping, as the mode switch always did.
 */

import type { KeyboardEvent } from "react";

/** The option a key moves to, or -1 when the key is not the group's. */
export function rovingTarget(event: KeyboardEvent<HTMLElement>, index: number, count: number): number {
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const backward = rtl ? "ArrowRight" : "ArrowLeft";
  if (event.key === forward || event.key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (event.key === backward || event.key === "ArrowUp") return Math.max(0, index - 1);
  if (event.key === "Home") return 0;
  if (event.key === "End") return count - 1;
  return -1;
}

/**
 * Handles a key for a group of `count` options: returns the option to move
 * to, having consumed the key, or -1 (the key is left alone) when the group
 * does not use it.
 */
export function consumeRovingKey(event: KeyboardEvent<HTMLElement>, index: number, count: number): number {
  if (event.altKey || event.ctrlKey || event.metaKey) return -1;
  const next = rovingTarget(event, index, count);
  if (next < 0) return -1;
  event.preventDefault();
  event.stopPropagation();
  return next;
}
