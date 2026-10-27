/**
 * WHAT SURVIVES A PRESET CHANGE, AND WHAT THE TIER IS ENTITLED TO TAKE BACK.
 *
 * THE SECOND HALF OF «الإعدادات لا تطبق». `app/machine-lock.ts` fixed the
 * first: every settings edit was re-applying the printer preset over itself,
 * so the layer height snapped back on every keystroke. This is the other way
 * the owner's edits disappeared, and it is quieter.
 *
 * The editor has six coarse selectors — printer, material, quality, strength,
 * support and infill pattern — and changing any of them rebuilt the settings map FROM
 * SCRATCH:
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
 *   infill    → `sparse_infill_pattern`
 *   quality   → every key the newly chosen PROCESS preset carries, because
 *               choosing "Draft" after "Fine" is asking for that whole preset;
 *               a hand-edited layer height must not survive it.
 *   material  → every key the newly chosen FILAMENT preset carries, for the
 *               same reason: PETG after PLA is a request for PETG's
 *               temperatures, and a PLA temperature must not survive it.
 *   printer   → everything. A different machine's presets are a different
 *               world, and carrying edits across is what the engine's own
 *               `printerKeys` list exists to prevent.
 *
 * Everything else the user changed by hand is carried over. And the keys that
 * are NOT carried are returned, so the shell can say which ones the selector
 * took — the silence was half the bug.
 *
 * WHAT NOBODY TYPED IS CARRIED TOO, SILENTLY. Not every value on screen that
 * differs from the preset is a person's edit: an imported 3MF brings its own
 * project settings (layer 0.12, infill 40 %, five walls), and on a printer
 * with an AMS the engine's filament card spreads the filament keys over four
 * slots (T1 to T4, `filament_settings_id`, `nozzle_temperature` and the rest
 * as four-entry arrays). Those writes are not edits, so they are not counted
 * in the notice (recordEdits), but they were then dropped by the next
 * selector change: flipping Support reset the imported layer height to 0.2
 * and cut the filament list to T1, with nothing said, and the G-code went
 * out with them. They are tracked as a second set (recordEngineWrites) and
 * carried by the same rule, without a notice: a selector still takes back the
 * keys it owns.
 *
 * A MATERIAL CHANGE OWNS T1, NOT T2 TO T4. With the filament keys spread over
 * several slots, the material row replaces the first slot of every key its
 * filament presets (the old and the new) carry, and leaves the other
 * extruders' slots as they were, the way picking a filament for T1 in the
 * engine's own card does. A single-slot map is replaced whole, as before.
 *
 * Pure, and takes every input explicitly, so `tests/settings-carryover.test
 * .mjs` can pin the behaviour without React, the engine, or a preset file.
 */

import type { SlicerSettings } from "three-slicer";

/** The selectors, as the shell holds them. */
export interface PresetSelection {
  printerId: string;
  quality: string;
  strength: string;
  support: boolean;
  infill: string;
  /** Absent in selections recorded before the material row existed. */
  material?: string;
}

/** Keys the Strength tier writes — `profile-loader.ts` sets exactly these. */
export const STRENGTH_KEYS: readonly string[] = ["sparse_infill_density", "wall_loops"];

/**
 * Keys the Infill pattern control writes.
 *
 * Separate from STRENGTH_KEYS on purpose: strength is HOW MUCH material goes
 * inside (density and wall count) and the pattern is WHAT SHAPE it takes.
 * Changing one must not discard a hand-tuned value belonging to the other —
 * which is the whole rule this module exists to enforce.
 */
export const INFILL_KEYS: readonly string[] = ["sparse_infill_pattern"];

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
  /** Keys the NEW material's filament preset carries (empty when unknown). */
  filamentKeys?: readonly string[];
  /** Keys the PREVIOUS material's filament preset carried (empty when unknown). */
  previousFilamentKeys?: readonly string[];
  /**
   * Keys the engine or an imported file set away from the preset, which the
   * person did not type (recordEngineWrites). Carried silently.
   */
  engineKeys?: ReadonlySet<string>;
}

export interface CarryOverResult {
  settings: SlicerSettings;
  /** User-edited keys the new selection overwrote, sorted, for the notice. */
  overwritten: string[];
  /** User-edited keys that survived. These stay "edited" for the next change. */
  kept: string[];
  /**
   * Keys not in `kept` that still differ from the new preset after the carry
   * (engine and file values, and merged filament slots): the shell keeps them
   * as its engine set for the next change.
   */
  engineKept: string[];
}

/**
 * Re-apply the user's own edits on top of a freshly loaded preset.
 *
 * A key is dropped only when the selector that changed owns it. A first load
 * (`previousSelection === null`) and a printer change both keep nothing, which
 * is not a special case so much as the general rule with an empty carry set.
 */
export function carryUserEdits(input: CarryOverInput): CarryOverResult {
  const {
    loaded,
    previous,
    editedKeys,
    previousSelection,
    nextSelection,
    processKeys,
    filamentKeys = [],
    previousFilamentKeys = [],
    engineKeys = new Set<string>(),
  } = input;
  const settings = { ...loaded } as Record<string, unknown>;
  const loadedRecord = loaded as unknown as Record<string, unknown>;
  const previousRecord = previous as unknown as Record<string, unknown>;
  const has = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key);

  const startingFresh = previousSelection === null
    || previousSelection.printerId !== nextSelection.printerId;

  const owned = new Set<string>();
  if (!startingFresh) {
    if (previousSelection.quality !== nextSelection.quality) for (const key of processKeys) owned.add(key);
    if (previousSelection.strength !== nextSelection.strength) for (const key of STRENGTH_KEYS) owned.add(key);
    if (previousSelection.support !== nextSelection.support) for (const key of SUPPORT_KEYS) owned.add(key);
    if (previousSelection.infill !== nextSelection.infill) for (const key of INFILL_KEYS) owned.add(key);
    if ((previousSelection.material ?? "pla") !== (nextSelection.material ?? "pla")) for (const key of filamentKeys) owned.add(key);
  }
  const materialChanged = !startingFresh
    && (previousSelection.material ?? "pla") !== (nextSelection.material ?? "pla");

  // The other extruders' filaments: on a material change with the filament
  // keys spread over several slots, only the first slot is the material row's.
  const slots = materialChanged ? filamentSlotCount(previousRecord) : 1;
  const slotKeys = new Set<string>(slots > 1 ? [...filamentKeys, ...previousFilamentKeys] : []);
  for (const key of slotKeys) {
    const merged = replaceFirstSlot(previousRecord[key], loadedRecord[key], slots);
    if (merged === undefined) delete settings[key];
    else settings[key] = merged;
  }

  const overwritten: string[] = [];
  const kept: string[] = [];
  for (const key of editedKeys) {
    // A key the user edited that is no longer in the map at all was edited on
    // a different printer's preset. Nothing to carry.
    if (!has(previousRecord, key)) continue;
    if (startingFresh || owned.has(key) || slotKeys.has(key)) {
      overwritten.push(key);
      continue;
    }
    settings[key] = previousRecord[key];
    kept.push(key);
  }

  // What the engine or a file set: carried by the same rule, never reported.
  for (const key of engineKeys) {
    if (editedKeys.has(key) || slotKeys.has(key) || !has(previousRecord, key)) continue;
    if (startingFresh || owned.has(key)) continue;
    settings[key] = previousRecord[key];
  }

  const keptSet = new Set(kept);
  const engineKept: string[] = [];
  for (const key of new Set([...engineKeys, ...slotKeys, ...editedKeys])) {
    if (keptSet.has(key) || !has(settings, key)) continue;
    if (sameSetting(settings[key], loadedRecord[key])) continue;
    engineKept.push(key);
  }

  overwritten.sort();
  kept.sort();
  engineKept.sort();
  return { settings: settings as unknown as SlicerSettings, overwritten, kept, engineKept };
}

/** How many filament slots the map holds: the length of `filament_settings_id`. */
function filamentSlotCount(record: Record<string, unknown>): number {
  const ids = record.filament_settings_id;
  return Array.isArray(ids) ? ids.length : 1;
}

/**
 * One filament key across `slots` extruders, with the first slot taken from
 * the new preset and the others kept. A slot the new preset has no value for
 * is null, as the engine writes it; a key with no value in any slot is
 * dropped (undefined), as the engine drops it.
 */
function replaceFirstSlot(previous: unknown, loaded: unknown, slots: number): unknown[] | undefined {
  const first = Array.isArray(loaded) ? loaded[0] : loaded;
  const before = Array.isArray(previous) ? previous : previous === undefined ? [] : [previous];
  const merged = Array.from({ length: slots }, (_, slot) => {
    if (slot === 0) return first ?? null;
    if (before.length === slots) return before[slot] ?? null;
    return before.length === 1 ? before[0] ?? null : null;
  });
  return merged.every((value) => value === null) ? undefined : merged;
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

/**
 * WHICH KEYS OF A SETTINGS WRITE ARE EDITS MADE BY THE PERSON.
 *
 * Not every write is an edit. The engine writes back on its own: after a
 * preset load its filament card re-derives the filament keys
 * (close_fan_the_first_x_layers, fan_max_speed, filament_cost and nine more)
 * and other panels normalise what they show. Each of those changed keys was
 * recorded as edited, so changing «الملء» in a fresh session told the person
 * «تم الاحتفاظ بـ 12 من إعداداتك المعدّلة» and «الخامة» told them a new preset
 * had replaced 12 of their edits. They had edited nothing.
 *
 * So a key counts only when both hold:
 *
 *  - `byPerson`: the write happened inside a person's own input in the
 *    engine's panels (the adapter tracks trusted input, change and click
 *    events there, see EngineAdapter#isPersonEditing). An engine write-back,
 *    an effect or a promise continuation is never one;
 *  - the new value differs from the freshly loaded preset, compared loosely
 *    (0.2 and "0.2", [220] and 220 are the same setting). Setting a key back
 *    to the preset value takes it off the list.
 *
 * Returns a new set; `edited` is not changed.
 */
export function recordEdits(input: {
  before: SlicerSettings;
  after: SlicerSettings;
  /** The map the last preset load built, before any carried edit. */
  preset: SlicerSettings | null;
  edited: ReadonlySet<string>;
  byPerson: boolean;
}): Set<string> {
  const next = new Set(input.edited);
  if (!input.byPerson) return next;
  const after = input.after as unknown as Record<string, unknown>;
  const preset = (input.preset ?? {}) as unknown as Record<string, unknown>;
  for (const key of changedKeys(input.before, input.after)) {
    if (input.preset && sameSetting(after[key], preset[key])) next.delete(key);
    else next.add(key);
  }
  return next;
}

/**
 * WHICH KEYS OF A SETTINGS WRITE THE ENGINE OR A FILE SET, NOT THE PERSON.
 *
 * The other half of recordEdits: a write that is not the person's (an
 * imported 3MF applying its project settings, the filament card spreading
 * the filament keys over the AMS slots, a panel normalising a value) puts
 * each key it moves away from the freshly loaded preset in this set, and one
 * it moves back to the preset out of it. A person's write takes the key out:
 * from then on it is theirs, in the edited set. carryUserEdits carries this
 * set silently across the next selector change, so those values are not
 * reset by a switch that does not own them.
 *
 * Returns a new set; `engine` is not changed.
 */
export function recordEngineWrites(input: {
  before: SlicerSettings;
  after: SlicerSettings;
  /** The map the last preset load built, before any carried value. */
  preset: SlicerSettings | null;
  engine: ReadonlySet<string>;
  byPerson: boolean;
}): Set<string> {
  const next = new Set(input.engine);
  const after = input.after as unknown as Record<string, unknown>;
  const preset = (input.preset ?? {}) as unknown as Record<string, unknown>;
  for (const key of changedKeys(input.before, input.after)) {
    if (input.byPerson || (input.preset && sameSetting(after[key], preset[key]))) next.delete(key);
    else next.add(key);
  }
  return next;
}

/**
 * The keys of `settings` that differ from `preset`: what a restored project
 * brings beyond the preset it was saved on, for the engine set.
 */
export function keysAwayFromPreset(preset: SlicerSettings, settings: SlicerSettings): string[] {
  const a = preset as unknown as Record<string, unknown>;
  const b = settings as unknown as Record<string, unknown>;
  return Object.keys(b).filter((key) => !sameSetting(a[key], b[key])).sort();
}

/** One setting, written two ways: equal when the engine would read the same value. */
export function sameSetting(a: unknown, b: unknown): boolean {
  return settingText(a) === settingText(b);
}

function settingText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 1 ? settingText(value[0]) : `[${value.map(settingText).join(",")}]`;
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value === "true") return "1";
  if (value === "false") return "0";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    return trimmed !== "" && Number.isFinite(numeric) ? String(numeric) : trimmed;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
