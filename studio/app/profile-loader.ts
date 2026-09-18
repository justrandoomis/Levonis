/**
 * Honest engine-preset loader (S4 editor-core).
 *
 * Replaces the monolith's `loadVerifiedProfile`, whose `?? fallbackSettings(...)`
 * / `?? {}` chain silently dropped to generic settings whenever the installed
 * three-slicer build was missing a preset — while the UI kept telling the user
 * the "verified" profile was active (gap table, settings section, row
 * "السقوط الصامت للـ preset").
 *
 * The loader still returns usable settings in every case (the editor must not
 * dead-end), but it never hides what happened:
 *
 * - `verified` is true ONLY when the machine, process and filament presets all
 *   came from the engine's bundled preset files.
 * - Every preset that could not be found is listed in `missingPresets`, and the
 *   substituted source is named in `presetStatus`. The UI must surface this as
 *   a needs-attention state; it must not show a "verified profile applied"
 *   claim while `verified` is false.
 */

import type { SlicerSettings } from "three-slicer";
import { STRENGTH, type PrinterProfile, type QualityId, type StrengthId } from "./printer-profiles";

/** Where each of the three preset layers actually came from. */
export type PresetSource = "engine" | "fallback";

export type PresetKind = "machine" | "process" | "filament";

export interface MissingPreset {
  kind: PresetKind;
  /** The preset name that was requested from the engine and not found. */
  presetName: string;
}

export interface LoadedProfileResult {
  /** Combined settings handed to the engine (machine + process + filament + tier overrides). */
  settings: SlicerSettings;
  /** The locked machine layer (re-applied over user edits by the shell). */
  machine: SlicerSettings;
  /** Keys the shell must keep locked to the machine layer. */
  /**
   * The engine's own `printerKeys` plus the two identity keys the app adds.
   *
   * ITS DOCUMENTED PURPOSE IS CLEARING, NOT LOCKING: "every option key a
   * printer profile can set … delete these from the settings map before
   * applying a different printer". Using it to re-apply the preset over a
   * user's edit is what froze `layer_height` and the whole Motion panel — see
   * app/machine-lock.ts. Nothing consumes this today (a profile change
   * replaces the settings object wholesale, which clears by construction); it
   * is kept because it is the engine's answer to a real question and the next
   * caller should get it from here rather than re-deriving it.
   */
  machineKeys: string[];
  /**
   * Keys the chosen QUALITY's process preset carries.
   *
   * These are the keys the Quality selector owns: picking "Draft" after "Fine"
   * is a request for that whole preset, so a hand-edited `layer_height` must
   * not survive it — while a hand-edited filament temperature must, because
   * Quality has nothing to say about it. `app/settings-carryover.ts` is where
   * that distinction is made; this is the list it needs and the only place it
   * can be read honestly (a fallback preset carries no keys at all, and then
   * there is nothing for Quality to take).
   */
  processKeys: string[];
  /** True only when machine, process and filament presets all loaded from the engine. */
  verified: boolean;
  /** Explicit needs-attention list — empty when `verified` is true. */
  missingPresets: MissingPreset[];
  presetStatus: Record<PresetKind, PresetSource>;
}

/**
 * Generic machine settings derived from the profile's published bed/nozzle
 * numbers. This is a *fallback*, not a verified preset — callers receive it
 * only together with an explicit `missingPresets` entry.
 */
export function fallbackMachineSettings(profile: PrinterProfile): SlicerSettings {
  return {
    printer_model: profile.model,
    printer_settings_id: profile.presetName,
    nozzle_diameter: [profile.nozzle],
    printable_area: [[0, 0], [profile.bedWidth, 0], [profile.bedWidth, profile.bedDepth], [0, profile.bedDepth]],
    printable_height: profile.bedHeight,
    layer_height: 0.2,
    filament_type: ["PLA"],
    filament_diameter: [1.75],
    filament_flow_ratio: [0.98],
    nozzle_temperature: [220],
    eng_plate_temp: [55],
    sparse_infill_density: 15,
    wall_loops: 2,
  };
}

/**
 * Loads the engine presets for a profile/quality/strength/support selection.
 * Never throws for a merely *missing* preset — missing presets are reported in
 * the result. Rejects only when the engine's settings module itself cannot be
 * imported.
 */
export async function loadPrinterProfile(
  profile: PrinterProfile,
  quality: QualityId,
  strength: StrengthId,
  support: boolean,
): Promise<LoadedProfileResult> {
  const api = await import("three-slicer/settings");
  const missingPresets: MissingPreset[] = [];
  const presetStatus: Record<PresetKind, PresetSource> = {
    machine: "engine",
    process: "engine",
    filament: "engine",
  };

  const engineMachine = api.printerSettings(profile.presetName);
  if (!engineMachine) {
    missingPresets.push({ kind: "machine", presetName: profile.presetName });
    presetStatus.machine = "fallback";
  }
  const machine = engineMachine ?? fallbackMachineSettings(profile);

  const [processApi, filamentApi] = await Promise.all([api.processPresets(), api.filamentPresets()]);

  const processName = profile.processPresets[quality];
  const engineProcess = processApi.settingsFor(processName);
  if (!engineProcess) {
    missingPresets.push({ kind: "process", presetName: processName });
    presetStatus.process = "fallback";
  }
  const process = engineProcess ?? {};

  const engineFilament = filamentApi.settingsFor(profile.materialPreset);
  if (!engineFilament) {
    missingPresets.push({ kind: "filament", presetName: profile.materialPreset });
    presetStatus.filament = "fallback";
  }
  const filament = engineFilament ?? {};

  const identity: SlicerSettings = {
    printer_model: profile.model,
    printer_settings_id: profile.presetName,
    print_settings_id: processName,
    filament_settings_id: [profile.materialPreset],
  };
  const lockedMachine = { ...machine, ...identity };
  const combined: SlicerSettings = {
    ...machine,
    ...process,
    ...filament,
    ...identity,
    sparse_infill_density: STRENGTH[strength].infill,
    wall_loops: STRENGTH[strength].walls,
    enable_support: support,
    support_type: "normal(auto)",
  };
  combined.printable_height = profile.bedHeight;

  return {
    settings: combined,
    machine: lockedMachine,
    machineKeys: [...api.printerKeys, "printer_model", "printer_settings_id"],
    processKeys: Object.keys(process),
    verified: missingPresets.length === 0,
    missingPresets,
    presetStatus,
  };
}
