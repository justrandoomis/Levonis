/**
 * WHICH SETTINGS BELONG TO THE PRINTER, AND WHICH BELONG TO THE PRINT.
 *
 * THE BUG THIS FILE EXISTS FOR. The owner reported «الإعدادات جميعها لا تعمل
 * لا تطبق فعليا على المشروع» — nothing you change in the settings actually
 * applies. It was true, and it was one list used for the wrong job.
 *
 * `slicer-client.tsx` re-applied the machine preset over every settings edit:
 *
 *     for (const key of machineKeysRef.current) {
 *       if (hasOwn(machineRecord, key)) lockedRecord[key] = machineRecord[key];
 *       else delete lockedRecord[key];
 *     }
 *
 * and `machineKeysRef` was `three-slicer`'s `printerKeys`. That list is 44
 * entries and its own documentation says what it is for:
 *
 *     "Every option key a printer profile can set. DELETE THESE FROM THE
 *      SETTINGS MAP BEFORE APPLYING A DIFFERENT PRINTER — a profile only
 *      carries the keys it sets, so without the clear the previous machine's
 *      values survive."
 *
 * A list of "keys a profile MAY set" is the right tool for clearing on a
 * printer switch and the wrong tool for freezing a user's edits, because a
 * printer profile may legitimately seed an ordinary print setting. And it
 * does: `printerKeys` contains **layer_height**, `z_hop`, and all sixteen
 * `machine_max_*` motion limits.
 *
 * So changing the layer height snapped straight back to the profile's value —
 * which is why the owner's screenshots both read "X2D 0.20" — and every
 * `machine_max_*` motion limit was frozen with it.
 *
 * (Unlocking those was necessary and not sufficient: the shell's "motion" slot
 * was rendering `TabPrinter::build_fff`, which is the printer's *Basic
 * information* page, while the `machine_max_*` controls live on
 * `TabPrinter::build_kinematics_page` — "Motion ability", groups Speed /
 * Acceleration / Jerk limitation. So they were unlocked and still on no page.
 * `slicer-client.tsx` now renders both.)
 *
 * WHAT IS ACTUALLY WORTH LOCKING, and why anything is. The shop sells specific
 * printers and this editor picks one from its own profile list. If the bed
 * size, the printable height or the nozzle could drift away from the machine
 * that will print the job, a customer would slice something their printer
 * cannot make and find out at the printer. That is the whole of the concern,
 * and it is about the PHYSICAL MACHINE — not about how fast it may accelerate
 * or how thick the layers are, both of which a person is entitled to change.
 *
 * SO THE LIST IS EXPLICIT AND EVERY KEY IS CLASSIFIED. `tests/machine-lock
 * .test.mjs` asserts that every one of `printerKeys` appears in exactly one of
 * the two lists below. A three-slicer upgrade that adds a key therefore FAILS
 * A TEST instead of silently freezing a control, which is the failure that
 * produced this file.
 */

import type { SlicerSettings } from "three-slicer";

/**
 * The machine itself: what it is and what it can physically fit.
 *
 * These stay pinned to the loaded printer preset. A value here that drifted
 * would let somebody slice for a bed that is not their printer's.
 */
export const MACHINE_IDENTITY_KEYS: readonly string[] = [
  // Which printer this is. The app, not the user, chooses from its profiles.
  "printer_model",
  "printer_settings_id",
  "printer_technology",
  // The bed and the space above it — the two the over-bed check is judged on.
  "printable_area",
  "printable_height",
  // The hardware that decides what a line can be.
  "nozzle_diameter",
  "extruder_offset",
  // Resin display geometry: the physical panel, not a print choice.
  "display_width",
  "display_height",
  "display_pixels_x",
  "display_pixels_y",
];

/**
 * Keys a printer profile happens to SEED but a person may change.
 *
 * Listed, rather than simply "everything not above", so that the classification
 * is a decision somebody made and a test can prove none was forgotten.
 *
 * `layer_height` is the headline: it is the first thing anybody changes in a
 * slicer, the header prints it beside the printer name, and it was frozen.
 * The `machine_max_*` block is the entire Motion panel. The SLA rows are the
 * resin equivalents — exposure and support tuning are the job, not the
 * machine.
 */
export const PROFILE_SEEDED_EDITABLE_KEYS: readonly string[] = [
  "layer_height",
  "initial_layer_height",
  "z_hop",
  "machine_max_speed_x",
  "machine_max_speed_y",
  "machine_max_speed_z",
  "machine_max_speed_e",
  "machine_max_acceleration_x",
  "machine_max_acceleration_y",
  "machine_max_acceleration_z",
  "machine_max_acceleration_e",
  "machine_max_acceleration_extruding",
  "machine_max_acceleration_retracting",
  "machine_max_acceleration_travel",
  "machine_max_jerk_x",
  "machine_max_jerk_y",
  "machine_max_jerk_z",
  "machine_max_jerk_e",
  "machine_max_junction_deviation",
  // SLA: the print, not the printer.
  "supports_enable",
  "support_head_front_diameter",
  "support_head_penetration",
  "support_head_width",
  "support_pillar_diameter",
  "support_pillar_connection_mode",
  "support_base_diameter",
  "support_base_height",
  "support_critical_angle",
  "support_max_bridge_length",
  "support_object_elevation",
  "support_points_density_relative",
  "pad_enable",
  "exposure_time",
  "initial_exposure_time",
  "sla_material_settings_id",
];

/**
 * Apply a settings edit, keeping the machine's own keys pinned to its preset.
 *
 * Pure, and takes the machine map explicitly, so `tests/machine-lock.test.mjs`
 * can pin the behaviour without a React tree or an engine — the same reason
 * `worker/platform.ts` was pulled out of the Cloudflare worker.
 *
 * A key in `MACHINE_IDENTITY_KEYS` that the preset does not carry is DELETED
 * rather than left alone, which is the original code's behaviour and the right
 * one: a leftover `printable_area` from a previously selected printer is worse
 * than none, because the engine would believe it.
 */
export function applyMachineLock(
  proposed: SlicerSettings,
  machine: SlicerSettings,
  lockedKeys: readonly string[] = MACHINE_IDENTITY_KEYS
): SlicerSettings {
  const locked = { ...proposed } as Record<string, unknown>;
  const machineRecord = machine as unknown as Record<string, unknown>;
  for (const key of lockedKeys) {
    if (Object.prototype.hasOwnProperty.call(machineRecord, key)) locked[key] = machineRecord[key];
    else delete locked[key];
  }
  return locked as unknown as SlicerSettings;
}
