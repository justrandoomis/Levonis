/**
 * WHAT SURVIVES A PRESET CHANGE, AND WHAT THE TIER IS ENTITLED TO TAKE BACK.
 *
 * THE SECOND HALF OF «الإعدادات لا تطبق». `app/machine-lock.ts` fixed the
 * first: every settings edit was re-applying the printer preset over itself,
 * so the layer height snapped back on every keystroke. This is the other way
 * the owner's edits disappeared, and it is quieter.
 *
 * The editor has four coarse selectors — printer, quality, strength, support —
 * and changing any of them rebuilt the settings map FROM SCRATCH:
 *
 *     setSettings(restored ?? loaded.settings);   // then setNotice("")
 *
 * `loaded.settings` is `{ ...machine, ...process, ...filament, ...identity }`
 * plus the tier values. So flipping the Support switch — a checkbox that has
 * nothing to do with infill — threw away a hand-tuned infill density, a
 * changed wall count, every filament temperature, all of it, and then cleared
 * the message line so nothing said a word about it.
 *
 * THE RULE THIS MODULE IMPLEMENTS. A selector may overwrite the keys IT owns,
 * and nothing else:
 *
 *   support   → `enable_support`, `support_type`
 *   strength  → `sparse_infill_density`, `wall_loops`
 *   quality   → every key the newly chosen PROCESS preset carries, because
 *               choosing "Draft" after "Fine" is asking for that whole preset;
 *               a hand-edited layer height must not survive it.
 *   printer   → everything. A different machine's presets are a different
 *               world, and carrying edits across is what the engine's own
 *               `printerKeys` list exists to prevent.
 *
 * Everything else the user changed by hand is carried over. And the keys that
 * are NOT carried are returned, so the shell can say which ones the selector
 * took — the silence was half the bug.
 *
 * Pure, and takes every input explicitly, so `tests/settings-carryover.test
 * .mjs` can pin the behaviour without React, the engine, or a preset file.
 */

import type { SlicerSettings } from "three-slicer";

/** The four selectors, as the shell holds them. */
export interface PresetSelection {
  printerId: string;
  quality: string;
  strength: string;
  support: boolean;
}

/** Keys the Strength tier writes — `profile-loader.ts` sets exactly these. */
export const STRENGTH_KEYS: readonly string[] = ["sparse_infill_density", "wall_loops"];

/** Keys the Support switch writes. */
export const SUPPORT_KEYS: readonly string[] = ["enable_support", "support_type"];

export interface CarryOverInput {
  /** The freshly built preset map for the NEW selection. */
  loaded: SlicerSettings;
  /** What was on screen — the old preset plus the user's edits. */
  previous: SlicerSettings;
  /** Keys the user changed by hand since the last preset load. */
  editedKeys: ReadonlySet<string>;
  /** The selection `previous` was built for, or null on the first load. */
  previousSelection: PresetSelection | null;
  nextSelection: PresetSelection;
  /** Keys the NEW quality's process preset carries. */
  processKeys: readonly string[];
}

export interface CarryOverResult {
  settings: SlicerSettings;
  /** User-edited keys the new selection overwrote, sorted, for the notice. */
  overwritten: string[];
  /** User-edited keys that survived. These stay "edited" for the next change. */
  kept: string[];
}

/**
 * Re-apply the user's own edits on top of a freshly loaded preset.
 *
 * A key is dropped only when the selector that changed owns it. A first load
 * (`previousSelection === null`) and a printer change both keep nothing, which
 * is not a special case so much as the general rule with an empty carry set.
 */
export function carryUserEdits(input: CarryOverInput): CarryOverResult {
  const { loaded, previous, editedKeys, previousSelection, nextSelection, processKeys } = input;
  const settings = { ...loaded } as Record<string, unknown>;
  const previousRecord = previous as unknown as Record<string, unknown>;

  const startingFresh = previousSelection === null
    || previousSelection.printerId !== nextSelection.printerId;

  const owned = new Set<string>();
  if (!startingFresh) {
    if (previousSelection.quality !== nextSelection.quality) for (const key of processKeys) owned.add(key);
    if (previousSelection.strength !== nextSelection.strength) for (const key of STRENGTH_KEYS) owned.add(key);
    if (previousSelection.support !== nextSelection.support) for (const key of SUPPORT_KEYS) owned.add(key);
  }

  const overwritten: string[] = [];
  const kept: string[] = [];
  for (const key of editedKeys) {
    // A key the user edited that is no longer in the map at all was edited on
    // a different printer's preset. Nothing to carry.
    if (!Object.prototype.hasOwnProperty.call(previousRecord, key)) continue;
    if (startingFresh || owned.has(key)) {
      overwritten.push(key);
      continue;
    }
    settings[key] = previousRecord[key];
    kept.push(key);
  }

  overwritten.sort();
  kept.sort();
  return { settings: settings as unknown as SlicerSettings, overwritten, kept };
}

/**
 * The keys a settings write actually changed.
 *
 * Called on every edit to keep the "the user touched this" set, so it must be
 * cheap and must not mistake a re-render for an edit. Values are compared with
 * `Object.is` after a JSON round trip for arrays and objects, because a lot of
 * the engine's options are arrays (`nozzle_temperature: [220]`) that the panel
 * rebuilds on every change whether or not a number in them moved.
 */
export function changedKeys(before: SlicerSettings, after: SlicerSettings): string[] {
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (sameValue(a[key], b[key])) continue;
    changed.push(key);
  }
  return changed;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
