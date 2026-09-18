/**
 * THE SETTINGS THE OWNER COULD NOT CHANGE.
 *
 * «الإعدادات جميعها لا تعمل لا تطبق فعليا على المشروع» — nothing you change in
 * the settings actually applies. It was true: the editor re-applied the
 * printer preset over every settings edit, using three-slicer's `printerKeys`
 * as the list of what to re-apply. That list is documented as the keys to
 * DELETE when switching printers — "every option key a printer profile CAN
 * set" — and it contains `layer_height`, `z_hop` and all sixteen
 * `machine_max_*` motion limits.
 *
 * So the layer height snapped back to the profile's value on every edit (both
 * of the owner's screenshots read "X2D 0.20"), and every `machine_max_*`
 * motion limit was frozen with it.
 *
 * The last test here is the second half of that: unlocking the motion limits
 * achieved nothing while the shell's motion slot rendered the wrong page of
 * the engine's option tree, so they were editable and on no screen.
 *
 * The first test below is the regression: it fails against the old list and
 * passes against the new one. The parity test under THE ONE THAT KEEPS IT
 * FIXED is the guard — it refuses to let a three-slicer upgrade introduce a
 * key nobody classified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  MACHINE_IDENTITY_KEYS,
  PROFILE_SEEDED_EDITABLE_KEYS,
  applyMachineLock,
} from "../app/machine-lock.ts";

const require = createRequire(import.meta.url);
/** The engine's own list, read from the package rather than restated here. */
const printerKeys = require("three-slicer/data/printers.json").keys;

// =========================================================================
// THE REGRESSION
// =========================================================================

test("LAYER HEIGHT is editable — the setting the owner changed and watched snap back", () => {
  const machine = { layer_height: 0.2, printable_height: 250, nozzle_diameter: [0.4] };
  const edited = applyMachineLock({ ...machine, layer_height: 0.16 }, machine);
  assert.equal(edited.layer_height, 0.16, "the owner's layer height must survive the edit");
});

test("the MOTION panel is not inert — machine_max_* are the controls it draws", () => {
  const machine = { machine_max_acceleration_x: [10000, 10000], printable_height: 250 };
  const edited = applyMachineLock(
    { ...machine, machine_max_acceleration_x: [4000, 4000] },
    machine
  );
  assert.deepEqual(
    edited.machine_max_acceleration_x,
    [4000, 4000],
    "the Motion ability page's Speed/Acceleration/Jerk groups write these keys"
  );
});

test("z_hop is editable too — it rode in on the same list", () => {
  const machine = { z_hop: 0.4 };
  assert.equal(applyMachineLock({ z_hop: 0.2 }, machine).z_hop, 0.2);
});

// =========================================================================
// WHAT MUST STILL BE PINNED
// =========================================================================

test("the BED cannot be edited away from the printer that will print the job", () => {
  // The whole reason a lock exists: slicing for a bed that is not your
  // printer's is a failure you discover at the printer.
  const machine = { printable_area: ["0x0", "256x0", "256x256", "0x256"], printable_height: 250 };
  const edited = applyMachineLock(
    { printable_area: ["0x0", "999x0", "999x999", "0x999"], printable_height: 999 },
    machine
  );
  assert.deepEqual(edited.printable_area, machine.printable_area, "the bed shape is the machine's");
  assert.equal(edited.printable_height, 250, "and so is the height above it");
});

test("the machine's identity and its nozzle stay pinned", () => {
  const machine = {
    printer_model: "X2D",
    printer_settings_id: "Levonis X2D 0.4 nozzle",
    printer_technology: "FFF",
    nozzle_diameter: [0.4],
    extruder_offset: ["0x0"],
  };
  const edited = applyMachineLock(
    {
      printer_model: "Something Else",
      printer_settings_id: "hacked",
      printer_technology: "SLA",
      nozzle_diameter: [0.8],
      extruder_offset: ["10x10"],
    },
    machine
  );
  for (const [key, value] of Object.entries(machine)) {
    assert.deepEqual(edited[key], value, `${key} must not drift from the machine preset`);
  }
});

test("a locked key the preset does NOT carry is removed, not left behind", () => {
  // A leftover printable_area from a previously selected printer is worse than
  // none: the engine would believe it.
  const edited = applyMachineLock({ printable_area: ["stale"], layer_height: 0.16 }, {});
  assert.equal("printable_area" in edited, false, "the stale machine value is cleared");
  assert.equal(edited.layer_height, 0.16, "and the print setting beside it is untouched");
});

test("applyMachineLock does not mutate what it is given", () => {
  const proposed = { layer_height: 0.16, printable_height: 999 };
  const machine = { printable_height: 250 };
  const out = applyMachineLock(proposed, machine);
  assert.equal(proposed.printable_height, 999, "the caller's object is left alone");
  assert.equal(out.printable_height, 250);
  assert.notEqual(out, proposed);
});

// =========================================================================
// THE ONE THAT KEEPS IT FIXED
// =========================================================================

test("EVERY key three-slicer can set from a printer profile is classified exactly once", () => {
  // This is the test that matters most. The bug was a list used for the wrong
  // job; the repair is only safe while every key in that list is a decision
  // somebody made. An upgrade that adds a key now fails HERE — loudly — instead
  // of silently freezing a control the way `layer_height` was frozen.
  const identity = new Set(MACHINE_IDENTITY_KEYS);
  const editable = new Set(PROFILE_SEEDED_EDITABLE_KEYS);

  const unclassified = printerKeys.filter((k) => !identity.has(k) && !editable.has(k));
  assert.deepEqual(
    unclassified,
    [],
    `three-slicer's printerKeys gained ${unclassified.length} key(s) nobody has classified: ` +
      `${unclassified.join(", ")}. Decide for each whether it describes the MACHINE (add to ` +
      `MACHINE_IDENTITY_KEYS) or the PRINT (add to PROFILE_SEEDED_EDITABLE_KEYS).`
  );

  const both = printerKeys.filter((k) => identity.has(k) && editable.has(k));
  assert.deepEqual(both, [], "a key cannot be both pinned and editable");
});

test("the identity list names only keys the engine actually has", () => {
  // Except the two the app adds itself, which are not in printers.json.
  const appOwned = new Set(["printer_model", "printer_settings_id"]);
  const known = new Set(printerKeys);
  const strays = MACHINE_IDENTITY_KEYS.filter((k) => !known.has(k) && !appOwned.has(k));
  assert.deepEqual(strays, [], "a pinned key the engine never sets pins nothing");
});

test("the lock is far smaller than the list it replaced — that IS the fix", () => {
  assert.ok(
    MACHINE_IDENTITY_KEYS.length < printerKeys.length / 2,
    `locking ${MACHINE_IDENTITY_KEYS.length} of ${printerKeys.length} keys, not all of them`
  );
  assert.equal(printerKeys.includes("layer_height"), true, "the list really did contain layer_height");
});

// =========================================================================
// UNLOCKED IS NOT THE SAME AS REACHABLE
// =========================================================================

test("the motion limits are rendered on a page — the slot names the kinematics builder", async () => {
  /**
   * `machine_max_*` being editable is worth nothing if no control writes it.
   * The shell's `motionPanel` used to render `TabPrinter::build_fff`, which is
   * the printer's "Basic information" page; three-slicer's own type for the
   * slot says what belongs there:
   *
   *     motionPanel?: React.ReactNode
   *       Motion-limits editor, folded into the printer card — usually
   *       `<SettingsPanel only={{builder:'TabPrinter::build_kinematics_page'}}/>`
   *
   * Both builders are checked against the engine's live uiTree rather than
   * named from memory, because the point is which one CARRIES the keys.
   */
  const { readFile } = await import("node:fs/promises");
  const uiTree = require("three-slicer/data/ui-tree.json");
  const optionsOf = (builder) =>
    (uiTree[builder] ?? []).flatMap((page) => (page.groups ?? []).flatMap((group) => group.options ?? []));

  const kinematics = optionsOf("TabPrinter::build_kinematics_page");
  const basic = optionsOf("TabPrinter::build_fff");
  const motionKeys = PROFILE_SEEDED_EDITABLE_KEYS.filter((k) => k.startsWith("machine_max_"));
  assert.ok(motionKeys.length >= 16, "the motion limits are the block this is about");
  for (const key of motionKeys) {
    assert.ok(kinematics.includes(key), `${key} lives on the kinematics page`);
    assert.ok(!basic.includes(key), `${key} is NOT on the Basic information page`);
  }

  const app = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  const slot = /const motionPanel = useMemo\(([\s\S]*?)\n  \) : null/.exec(app)?.[1] ?? "";
  assert.ok(slot, "motionPanel should still be a useMemo");
  assert.match(slot, /builder="TabPrinter::build_kinematics_page"/, "the motion slot must render the motion page");
  // Kept, not swapped: those 35 options had nowhere else to be reached from.
  assert.match(slot, /builder="TabPrinter::build_fff"/, "and must not drop Basic information to do it");
});
