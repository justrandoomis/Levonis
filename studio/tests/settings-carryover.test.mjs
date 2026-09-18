/**
 * FLIPPING ONE SWITCH MUST NOT THROW AWAY EVERY OTHER SETTING.
 *
 * The second way the owner's settings disappeared. `machine-lock.ts` covers
 * the loud one (every edit re-applied the printer preset over itself). This
 * covers the quiet one: the four coarse selectors — printer, quality,
 * strength, support — rebuilt the whole settings map from scratch, so turning
 * Support on discarded a hand-tuned infill density, every changed filament
 * temperature, and anything else, and then cleared the message line.
 *
 * The rule under test: a selector may overwrite the keys IT owns, and nothing
 * else. What it did take is reported, because the silence was half the bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadAppModule } from "./lib/load-app-module.mjs";

const { carryUserEdits, changedKeys, STRENGTH_KEYS, SUPPORT_KEYS } = await loadAppModule("settings-carryover");

const SELECTION = { printerId: "bbl-x2d-04", quality: "fine", strength: "standard", support: false };

/** What `profile-loader.ts` builds: machine + process + filament + tiers. */
const loadedFor = (over = {}) => ({
  printer_model: "Bambu Lab X2D",
  layer_height: 0.12,
  initial_layer_height: 0.2,
  sparse_infill_density: 15,
  wall_loops: 2,
  enable_support: false,
  support_type: "normal(auto)",
  nozzle_temperature: [220],
  filament_flow_ratio: [0.98],
  ...over,
});

// =========================================================================
// THE REGRESSION
// =========================================================================

test("TURNING SUPPORT ON keeps the infill the owner tuned", () => {
  const previous = loadedFor({ sparse_infill_density: 40, nozzle_temperature: [235] });
  const out = carryUserEdits({
    loaded: loadedFor({ enable_support: true }),
    previous,
    editedKeys: new Set(["sparse_infill_density", "nozzle_temperature"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, support: true },
    processKeys: ["layer_height", "initial_layer_height"],
  });
  assert.equal(out.settings.sparse_infill_density, 40, "the Support switch does not own the infill");
  assert.deepEqual(out.settings.nozzle_temperature, [235], "nor the filament temperature");
  assert.equal(out.settings.enable_support, true, "and the switch itself still works");
  assert.deepEqual(out.overwritten, [], "nothing of the owner's was taken");
  assert.deepEqual(out.kept, ["nozzle_temperature", "sparse_infill_density"]);
});

test("CHANGING STRENGTH takes back its own two keys and leaves the rest alone", () => {
  const out = carryUserEdits({
    loaded: loadedFor({ sparse_infill_density: 25, wall_loops: 3 }),
    previous: loadedFor({ sparse_infill_density: 40, wall_loops: 5, nozzle_temperature: [235] }),
    editedKeys: new Set(["sparse_infill_density", "wall_loops", "nozzle_temperature"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, strength: "strong" },
    processKeys: ["layer_height"],
  });
  assert.equal(out.settings.sparse_infill_density, 25, "choosing Strong IS choosing its infill");
  assert.equal(out.settings.wall_loops, 3);
  assert.deepEqual(out.settings.nozzle_temperature, [235], "the temperature was not part of that choice");
  assert.deepEqual(out.overwritten, ["sparse_infill_density", "wall_loops"]);
  assert.deepEqual(STRENGTH_KEYS, ["sparse_infill_density", "wall_loops"], "the owned set is the one profile-loader writes");
});

test("CHANGING QUALITY takes every key its new process preset carries", () => {
  // Picking Draft after Fine is a request for that whole preset. A hand-edited
  // layer height surviving it would be the opposite of what was asked for.
  const out = carryUserEdits({
    loaded: loadedFor({ layer_height: 0.24, initial_layer_height: 0.28 }),
    previous: loadedFor({ layer_height: 0.1, nozzle_temperature: [235] }),
    editedKeys: new Set(["layer_height", "nozzle_temperature"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, quality: "draft" },
    processKeys: ["layer_height", "initial_layer_height", "sparse_infill_density"],
  });
  assert.equal(out.settings.layer_height, 0.24, "the new quality's layer height wins");
  assert.deepEqual(out.settings.nozzle_temperature, [235], "the filament is not the process preset");
  assert.deepEqual(out.overwritten, ["layer_height"]);
});

test("CHANGING PRINTER keeps nothing — a different machine is a different world", () => {
  const out = carryUserEdits({
    loaded: loadedFor({ printer_model: "Bambu Lab A1" }),
    previous: loadedFor({ sparse_infill_density: 40, nozzle_temperature: [235] }),
    editedKeys: new Set(["sparse_infill_density", "nozzle_temperature"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, printerId: "bbl-a1-04" },
    processKeys: ["layer_height"],
  });
  assert.equal(out.settings.sparse_infill_density, 15, "the new printer's preset is the whole answer");
  assert.deepEqual(out.overwritten, ["nozzle_temperature", "sparse_infill_density"]);
  assert.deepEqual(out.kept, []);
});

test("the FIRST load carries nothing, and says nothing was taken from a user who edited nothing", () => {
  const out = carryUserEdits({
    loaded: loadedFor(),
    previous: {},
    editedKeys: new Set(),
    previousSelection: null,
    nextSelection: SELECTION,
    processKeys: ["layer_height"],
  });
  assert.deepEqual(out.settings, loadedFor());
  assert.deepEqual(out.overwritten, []);
  assert.deepEqual(out.kept, []);
});

// =========================================================================
// THE EDGES
// =========================================================================

test("two selectors changing at once own the union of their keys", () => {
  const out = carryUserEdits({
    loaded: loadedFor({ wall_loops: 3, sparse_infill_density: 25, enable_support: true }),
    previous: loadedFor({ wall_loops: 5, enable_support: false, nozzle_temperature: [235] }),
    editedKeys: new Set(["wall_loops", "enable_support", "nozzle_temperature"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, strength: "strong", support: true },
    processKeys: [],
  });
  assert.equal(out.settings.wall_loops, 3);
  assert.equal(out.settings.enable_support, true);
  assert.deepEqual(out.settings.nozzle_temperature, [235]);
  assert.deepEqual(out.overwritten, ["enable_support", "wall_loops"]);
  assert.deepEqual(SUPPORT_KEYS, ["enable_support", "support_type"]);
});

test("an edited key the previous map no longer has is not resurrected as undefined", () => {
  const out = carryUserEdits({
    loaded: loadedFor(),
    previous: loadedFor(),
    editedKeys: new Set(["a_key_from_a_past_life"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, support: true },
    processKeys: [],
  });
  assert.equal("a_key_from_a_past_life" in out.settings, false, "writing undefined into the map would reach the kernel");
  assert.deepEqual(out.kept, []);
  assert.deepEqual(out.overwritten, []);
});

test("carryUserEdits does not mutate what it is given", () => {
  const loaded = loadedFor();
  const previous = loadedFor({ sparse_infill_density: 40 });
  const out = carryUserEdits({
    loaded,
    previous,
    editedKeys: new Set(["sparse_infill_density"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, support: true },
    processKeys: [],
  });
  assert.equal(loaded.sparse_infill_density, 15, "the loaded preset is left alone");
  assert.equal(previous.sparse_infill_density, 40);
  assert.equal(out.settings.sparse_infill_density, 40);
  assert.notEqual(out.settings, loaded);
});

// =========================================================================
// WHAT COUNTS AS AN EDIT
// =========================================================================

test("changedKeys sees a real change and ignores a rebuilt array with the same numbers", () => {
  // A great many engine options are arrays the panel rebuilds on every write.
  // Counting those as edits would make the carry-over set grow to everything,
  // and then a quality change would appear to take settings nobody touched.
  const before = { layer_height: 0.2, nozzle_temperature: [220], filament_type: ["PLA"] };
  const after = { layer_height: 0.2, nozzle_temperature: [220], filament_type: ["PLA"] };
  assert.deepEqual(changedKeys(before, after), []);
  assert.deepEqual(changedKeys(before, { ...after, nozzle_temperature: [235] }), ["nozzle_temperature"]);
  assert.deepEqual(changedKeys(before, { ...after, layer_height: 0.16 }), ["layer_height"]);
});

test("changedKeys reports a key that appeared or disappeared", () => {
  assert.deepEqual(changedKeys({ a: 1 }, { a: 1, b: 2 }), ["b"]);
  assert.deepEqual(changedKeys({ a: 1, b: 2 }, { a: 1 }), ["b"]);
});
