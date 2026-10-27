/**
 * FLIPPING ONE SWITCH MUST NOT THROW AWAY EVERY OTHER SETTING.
 *
 * The second way the owner's settings disappeared. `machine-lock.ts` covers
 * the loud one (every edit re-applied the printer preset over itself). This
 * covers the quiet one: the coarse selectors — printer, quality, strength,
 * support, infill pattern — rebuilt the whole settings map from scratch, so turning
 * Support on discarded a hand-tuned infill density, every changed filament
 * temperature, and anything else, and then cleared the message line.
 *
 * The rule under test: a selector may overwrite the keys IT owns, and nothing
 * else. What it did take is reported, because the silence was half the bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadAppModule } from "./lib/load-app-module.mjs";

const { carryUserEdits, changedKeys, recordEdits, sameSetting, INFILL_KEYS, STRENGTH_KEYS, SUPPORT_KEYS } = await loadAppModule("settings-carryover");

const SELECTION = { printerId: "bbl-x2d-04", quality: "fine", strength: "standard", support: false, infill: "balanced" };

/** What `profile-loader.ts` builds: machine + process + filament + tiers. */
const loadedFor = (over = {}) => ({
  printer_model: "Bambu Lab X2D",
  layer_height: 0.12,
  initial_layer_height: 0.2,
  sparse_infill_density: 15,
  sparse_infill_pattern: "gyroid",
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

test("CHANGING THE INFILL PATTERN takes the pattern and nothing else", () => {
  // Strength is HOW MUCH goes inside; the pattern is WHAT SHAPE it takes.
  // Picking a new shape must not undo a density the owner tuned by hand.
  const out = carryUserEdits({
    loaded: loadedFor({ sparse_infill_pattern: "3dhoneycomb" }),
    previous: loadedFor({ sparse_infill_pattern: "gyroid", sparse_infill_density: 40, nozzle_temperature: [235] }),
    editedKeys: new Set(["sparse_infill_pattern", "sparse_infill_density", "nozzle_temperature"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, infill: "strong" },
    processKeys: ["layer_height"],
  });
  assert.equal(out.settings.sparse_infill_pattern, "3dhoneycomb", "choosing a pattern IS choosing that pattern");
  assert.equal(out.settings.sparse_infill_density, 40, "the density the owner tuned is not part of that choice");
  assert.deepEqual(out.settings.nozzle_temperature, [235]);
  assert.deepEqual(out.overwritten, ["sparse_infill_pattern"]);
  assert.deepEqual(INFILL_KEYS, ["sparse_infill_pattern"], "the owned set is the one profile-loader writes");
});

test("CHANGING STRENGTH leaves the infill PATTERN alone", () => {
  const out = carryUserEdits({
    loaded: loadedFor({ sparse_infill_density: 25, wall_loops: 3, sparse_infill_pattern: "gyroid" }),
    previous: loadedFor({ sparse_infill_pattern: "3dhoneycomb" }),
    editedKeys: new Set(["sparse_infill_pattern"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, strength: "strong" },
    processKeys: ["layer_height"],
  });
  assert.equal(out.settings.sparse_infill_pattern, "3dhoneycomb", "the amount changed, not the shape");
  assert.deepEqual(out.kept, ["sparse_infill_pattern"]);
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

test("CHANGING MATERIAL takes every key its new filament preset carries, and nothing else", () => {
  // PETG after PLA is a request for PETG's temperatures: a PLA nozzle
  // temperature typed by hand must not survive it, while a hand-tuned infill
  // density (the Strength row's) must.
  const previous = loadedFor({ nozzle_temperature: [235], sparse_infill_density: 22 });
  const out = carryUserEdits({
    loaded: loadedFor({ nozzle_temperature: [255] }),
    previous,
    editedKeys: new Set(["nozzle_temperature", "sparse_infill_density"]),
    previousSelection: { ...SELECTION, material: "pla" },
    nextSelection: { ...SELECTION, material: "petg" },
    processKeys: ["layer_height", "initial_layer_height"],
    filamentKeys: ["nozzle_temperature", "filament_flow_ratio"],
  });
  assert.deepEqual(out.settings.nozzle_temperature, [255], "the new filament's temperature applies");
  assert.equal(out.settings.sparse_infill_density, 22, "the infill is not the material's");
  assert.deepEqual(out.overwritten, ["nozzle_temperature"]);
  assert.deepEqual(out.kept, ["sparse_infill_density"]);

  // A selection recorded before the material row existed reads as PLA, so
  // nothing is taken on the first load after the upgrade.
  const legacy = carryUserEdits({
    loaded: loadedFor(),
    previous: loadedFor({ nozzle_temperature: [235] }),
    editedKeys: new Set(["nozzle_temperature"]),
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, material: "pla" },
    processKeys: [],
    filamentKeys: ["nozzle_temperature"],
  });
  assert.deepEqual(legacy.kept, ["nozzle_temperature"]);
});

test("AN ENGINE WRITE-BACK IS NOT AN EDIT: only a person counts, and only away from the preset", () => {
  // The reviewer's case: a fresh session, no hand edits, and the engine writes
  // its filament keys back after the preset load. Recorded as edits, they made
  // «الملء» say «تم الاحتفاظ بـ 12 من إعداداتك المعدّلة».
  const preset = loadedFor({ fan_max_speed: 100, filament_cost: 20, close_fan_the_first_x_layers: 1 });
  const engineWrite = { ...preset, fan_max_speed: [100], filament_cost: ["24.99"], close_fan_the_first_x_layers: [3] };
  const quiet = recordEdits({ before: preset, after: engineWrite, preset, edited: new Set(), byPerson: false });
  assert.deepEqual([...quiet], [], "no person, no edit");

  // Nothing recorded, so the next phone-row change has nothing to report.
  const carried = carryUserEdits({
    loaded: loadedFor({ sparse_infill_density: 25 }),
    previous: engineWrite,
    editedKeys: quiet,
    previousSelection: SELECTION,
    nextSelection: { ...SELECTION, strength: "strong" },
    processKeys: [],
  });
  assert.deepEqual(carried.kept, []);
  assert.deepEqual(carried.overwritten, []);

  // A person typing a value is an edit…
  const typed = recordEdits({ before: preset, after: { ...preset, layer_height: 0.16 }, preset, edited: new Set(), byPerson: true });
  assert.deepEqual([...typed], ["layer_height"]);
  // …a person's write that only re-spells the preset value is not…
  const respelled = recordEdits({ before: preset, after: { ...preset, fan_max_speed: ["100"] }, preset, edited: new Set(), byPerson: true });
  assert.deepEqual([...respelled], []);
  // …and setting a key back to the preset takes it off the list.
  const back = recordEdits({ before: { ...preset, layer_height: 0.16 }, after: preset, preset, edited: new Set(["layer_height"]), byPerson: true });
  assert.deepEqual([...back], []);
  // An engine write never removes what the person did.
  const kept = recordEdits({ before: preset, after: engineWrite, preset, edited: new Set(["layer_height"]), byPerson: false });
  assert.deepEqual([...kept], ["layer_height"]);
});

test("sameSetting reads one value the way the engine does, however it is spelled", () => {
  assert.ok(sameSetting(0.2, "0.2"));
  assert.ok(sameSetting([220], 220));
  assert.ok(sameSetting(["220"], [220]));
  assert.ok(sameSetting(true, "1"));
  assert.ok(sameSetting(false, "false"));
  assert.ok(sameSetting(undefined, null));
  assert.ok(sameSetting([220, 225], ["220", "225"]));
  assert.ok(!sameSetting(0.2, 0.16));
  assert.ok(!sameSetting([220, 225], [220]));
  assert.ok(!sameSetting("gyroid", "grid"));
});

test("only trusted input inside the engine marks a settings write as the person's", async () => {
  const { EngineAdapter } = await loadAppModule("engine-adapter");
  const adapter = new EngineAdapter();
  const listeners = {};
  const root = { addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); }, removeEventListener() {} };
  adapter.addEditListeners(root);
  for (const type of ["input", "change", "click"]) assert.ok(listeners[type]?.length, `${type} is listened for`);
  const fire = (type, isTrusted) => { for (const fn of listeners[type]) fn({ type, isTrusted }); };
  assert.equal(adapter.isPersonEditing(), false);
  fire("change", false);
  assert.equal(adapter.isPersonEditing(), false, "a synthetic event is not a person");
  fire("input", true);
  assert.equal(adapter.isPersonEditing(), true, "a person typing in a panel");
  // The flag lasts for the event, not after it: a write-back later is not theirs.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(adapter.isPersonEditing(), false);
});

test("the shell records an edit only for a write the person made", async () => {
  const { readFile } = await import("node:fs/promises");
  const client = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  const setter = client.slice(client.indexOf("const setEditorSettings"), client.indexOf("// -- adapter-backed controls"));
  // Asked when the write arrives, not later inside the updater.
  assert.ok(setter.indexOf("const byPerson = adapter.isPersonEditing();") < setter.indexOf("setSettings((current) => {"));
  assert.match(setter, /userEditedKeysRef\.current = recordEdits\(\{\s*before: current,\s*after: locked,\s*preset: loadedPresetRef\.current,\s*edited: userEditedKeysRef\.current,\s*byPerson,\s*\}\);/);
  assert.doesNotMatch(setter, /changedKeys\(current, locked\)/, "every changed key is no longer an edit");
  assert.match(client, /loadedPresetRef\.current = loaded\.settings;/);
});

// =========================================================================
// WHAT NOBODY TYPED: AN IMPORTED 3MF AND THE AMS FILAMENT SLOTS (C6 round 2)
// =========================================================================

const { recordEngineWrites, keysAwayFromPreset } = await loadAppModule("settings-carryover");

/** Run one settings write through both recorders, the way setEditorSettings does. */
const write = (state, after, byPerson) => ({
  settings: after,
  edited: recordEdits({ before: state.settings, after, preset: state.preset, edited: state.edited, byPerson }),
  engine: recordEngineWrites({ before: state.settings, after, preset: state.preset, engine: state.engine, byPerson }),
  preset: state.preset,
});

/** Run one selector change the way the preset effect does. */
const reload = (state, { loaded, from, to, processKeys = [], filamentKeys = [], previousFilamentKeys = [] }) => {
  const out = carryUserEdits({
    loaded,
    previous: state.settings,
    editedKeys: state.edited,
    engineKeys: state.engine,
    previousSelection: from,
    nextSelection: to,
    processKeys,
    filamentKeys,
    previousFilamentKeys,
  });
  return { out, state: { settings: out.settings, edited: new Set(out.kept), engine: new Set(out.engineKept), preset: loaded } };
};

test("AN IMPORTED 3MF KEEPS ITS SETTINGS when Support, Infill or a material-free row changes, and says nothing", () => {
  // The reviewer's fixture: a project whose own settings are layer 0.12,
  // infill 40 % and five walls. The engine applies them with no person's
  // event, so they are not edits; they were then reset by the Support switch
  // (0.2 / 15 / 2 in the draft and in the G-code, 49 layers instead of 82).
  const preset = loadedFor({ layer_height: 0.2, sparse_infill_density: 15, wall_loops: 2 });
  let state = { settings: preset, edited: new Set(), engine: new Set(), preset };
  state = write(state, { ...preset, layer_height: 0.12, sparse_infill_density: 40, wall_loops: 5 }, false);
  assert.deepEqual([...state.edited], [], "the import is not the person's edit");
  assert.deepEqual([...state.engine].sort(), ["layer_height", "sparse_infill_density", "wall_loops"]);

  const support = reload(state, {
    loaded: { ...preset, enable_support: true },
    from: SELECTION,
    to: { ...SELECTION, support: true },
    processKeys: ["layer_height", "initial_layer_height"],
  });
  assert.equal(support.out.settings.layer_height, 0.12, "the Support switch does not own the layer height");
  assert.equal(support.out.settings.sparse_infill_density, 40);
  assert.equal(support.out.settings.wall_loops, 5);
  assert.equal(support.out.settings.enable_support, true, "and the switch itself works");
  assert.deepEqual([support.out.overwritten, support.out.kept], [[], []], "no notice: nobody typed these");

  // The phone's infill pattern row, then a second Support change (its select): still 0.12.
  const pattern = reload(support.state, {
    loaded: { ...preset, enable_support: true, sparse_infill_pattern: "grid" },
    from: { ...SELECTION, support: true },
    to: { ...SELECTION, support: true, infill: "grid" },
  });
  assert.equal(pattern.out.settings.layer_height, 0.12);
  assert.equal(pattern.out.settings.sparse_infill_density, 40, "the pattern row does not own the density");
  const off = reload(pattern.state, {
    loaded: { ...preset, sparse_infill_pattern: "grid" },
    from: { ...SELECTION, support: true, infill: "grid" },
    to: { ...SELECTION, support: false, infill: "grid" },
  });
  assert.equal(off.out.settings.layer_height, 0.12, "a second flip keeps it too");

  // A selector still takes back what it owns: Strength the density and walls,
  // Quality the layer height.
  const strength = reload(off.state, {
    loaded: { ...preset, sparse_infill_density: 25, wall_loops: 3, sparse_infill_pattern: "grid" },
    from: { ...SELECTION, infill: "grid" },
    to: { ...SELECTION, infill: "grid", strength: "strong" },
  });
  assert.equal(strength.out.settings.sparse_infill_density, 25);
  assert.equal(strength.out.settings.wall_loops, 3);
  assert.equal(strength.out.settings.layer_height, 0.12);
  const quality = reload(strength.state, {
    loaded: { ...preset, layer_height: 0.16, sparse_infill_density: 25, wall_loops: 3, sparse_infill_pattern: "grid" },
    from: { ...SELECTION, infill: "grid", strength: "strong" },
    to: { ...SELECTION, infill: "grid", strength: "strong", quality: "standard" },
    processKeys: ["layer_height", "initial_layer_height"],
  });
  assert.equal(quality.out.settings.layer_height, 0.16, "choosing a quality is choosing its layer height");
  assert.deepEqual(quality.out.overwritten, [], "still no notice: the person never typed any of it");

  // A printer change starts over, the file's values included.
  const printer = reload(state, { loaded: preset, from: SELECTION, to: { ...SELECTION, printerId: "bbl-a1" } });
  assert.equal(printer.out.settings.layer_height, 0.2);
  assert.deepEqual(printer.out.engineKept, []);
});

/** The engine's AMS expansion on an X1C: four filament slots. */
const AMS = {
  filament_settings_id: ["Bambu PLA Basic @BBL X1C", "Bambu PLA Matte @BBL X1C", "Bambu PLA Matte @BBL X1C", "Bambu PLA Matte @BBL X1C"],
  filament_type: ["PLA", "PLA", "PLA", "PLA"],
  nozzle_temperature: [220, 220, 220, 220],
  filament_density: [1.26, 1.32, 1.32, 1.32],
  filament_cost: [24.99, 24.99, 24.99, 24.99],
};
const PLA_KEYS = ["filament_settings_id", "filament_type", "nozzle_temperature", "filament_density", "filament_cost"];

test("THE AMS FILAMENT LIST SURVIVES a Support, Infill or Quality change: T2 to T4 are not cut to «—»", () => {
  const preset = loadedFor({
    filament_settings_id: ["Bambu PLA Basic @BBL X1C"], filament_type: ["PLA"], nozzle_temperature: [220],
    filament_density: [1.26], filament_cost: [24.99],
  });
  let state = { settings: preset, edited: new Set(), engine: new Set(), preset };
  // The filament card spreads the keys over the four slots on its own.
  state = write(state, { ...preset, ...AMS }, false);
  assert.deepEqual([...state.edited], []);
  for (const [to, loaded, processKeys] of [
    [{ ...SELECTION, support: true }, { ...preset, enable_support: true }, []],
    [{ ...SELECTION, infill: "grid" }, { ...preset, sparse_infill_pattern: "grid" }, []],
    [{ ...SELECTION, quality: "standard" }, { ...preset, layer_height: 0.2 }, ["layer_height", "initial_layer_height"]],
    [{ ...SELECTION, strength: "strong" }, { ...preset, sparse_infill_density: 25 }, []],
  ]) {
    const { out } = reload(state, { loaded, from: SELECTION, to, processKeys, filamentKeys: PLA_KEYS, previousFilamentKeys: PLA_KEYS });
    assert.equal(out.settings.filament_settings_id.length, 4, `${JSON.stringify(to)}: the four slots stay`);
    assert.deepEqual(out.settings.filament_settings_id, AMS.filament_settings_id);
    assert.deepEqual(out.settings.nozzle_temperature, [220, 220, 220, 220]);
    assert.deepEqual(out.settings.filament_density, AMS.filament_density);
    assert.deepEqual(out.overwritten, [], "and no notice");
    assert.ok(out.engineKept.includes("filament_settings_id"), "still carried at the next change");
  }
});

test("A MATERIAL CHANGE with four slots replaces T1 only; T2 to T4 keep their filaments", () => {
  const preset = loadedFor({
    filament_settings_id: ["Bambu PLA Basic @BBL X1C"], filament_type: ["PLA"], nozzle_temperature: [220],
    filament_density: [1.26], filament_cost: [24.99],
  });
  let state = { settings: preset, edited: new Set(), engine: new Set(), preset };
  state = write(state, { ...preset, ...AMS }, false);
  const petg = loadedFor({
    filament_settings_id: ["Bambu PETG Basic @BBL X1C"], filament_type: ["PETG"], nozzle_temperature: [255],
    filament_density: [1.25], filament_cost: [24.99], filament_retraction_length: [0.4],
  });
  const PETG_KEYS = [...PLA_KEYS, "filament_retraction_length"];
  const { out, state: next } = reload(state, {
    loaded: petg,
    from: { ...SELECTION, material: "pla" },
    to: { ...SELECTION, material: "petg" },
    filamentKeys: PETG_KEYS,
    previousFilamentKeys: PLA_KEYS,
  });
  assert.deepEqual(out.settings.filament_settings_id, ["Bambu PETG Basic @BBL X1C", "Bambu PLA Matte @BBL X1C", "Bambu PLA Matte @BBL X1C", "Bambu PLA Matte @BBL X1C"]);
  assert.deepEqual(out.settings.nozzle_temperature, [255, 220, 220, 220], "T1 takes PETG's temperature");
  assert.deepEqual(out.settings.filament_type, ["PETG", "PLA", "PLA", "PLA"]);
  assert.deepEqual(out.settings.filament_density, [1.25, 1.32, 1.32, 1.32]);
  assert.deepEqual(out.settings.filament_retraction_length, [0.4, null, null, null], "a key only PETG has is T1's alone, as the engine writes it");
  assert.deepEqual(out.overwritten, [], "nothing the person typed was taken");

  // And back to PLA: the PETG-only key leaves T1 again, and is dropped when no slot has it.
  const back = reload(next, {
    loaded: preset,
    from: { ...SELECTION, material: "petg" },
    to: { ...SELECTION, material: "pla" },
    filamentKeys: PLA_KEYS,
    previousFilamentKeys: PETG_KEYS,
  });
  assert.deepEqual(back.out.settings.filament_settings_id, AMS.filament_settings_id);
  assert.deepEqual(back.out.settings.nozzle_temperature, [220, 220, 220, 220]);
  assert.equal("filament_retraction_length" in back.out.settings, false);

  // A person's own T1 temperature is still taken by the material, and said so.
  const typed = write(state, { ...state.settings, nozzle_temperature: [230, 220, 220, 220] }, true);
  const taken = reload(typed, {
    loaded: petg,
    from: { ...SELECTION, material: "pla" },
    to: { ...SELECTION, material: "petg" },
    filamentKeys: PETG_KEYS,
    previousFilamentKeys: PLA_KEYS,
  });
  assert.deepEqual(taken.out.settings.nozzle_temperature, [255, 220, 220, 220]);
  assert.deepEqual(taken.out.overwritten, ["nozzle_temperature"]);
});

test("recordEngineWrites keeps what nobody typed, and only while it differs from the preset", () => {
  const preset = loadedFor();
  const file = recordEngineWrites({ before: preset, after: { ...preset, layer_height: 0.08 }, preset, engine: new Set(), byPerson: false });
  assert.deepEqual([...file], ["layer_height"]);
  // A value the engine moves back to the preset leaves the set…
  const back = recordEngineWrites({ before: { ...preset, layer_height: 0.08 }, after: preset, preset, engine: file, byPerson: false });
  assert.deepEqual([...back], []);
  // …a respelling of the preset value never enters it…
  const respelled = recordEngineWrites({ before: preset, after: { ...preset, layer_height: "0.12" }, preset, engine: new Set(), byPerson: false });
  assert.deepEqual([...respelled], []);
  // …and a person typing over it makes it theirs (recordEdits), not the engine's.
  const typed = recordEngineWrites({ before: { ...preset, layer_height: 0.08 }, after: { ...preset, layer_height: 0.1 }, preset, engine: file, byPerson: true });
  assert.deepEqual([...typed], []);
  // A restored project brings what it holds beyond its preset.
  // (layer_height "0.12" is the preset's 0.12 respelled, so it is not one.)
  assert.deepEqual(
    keysAwayFromPreset(preset, { ...preset, layer_height: "0.12", wall_loops: 5, ...AMS }),
    ["filament_cost", "filament_density", "filament_settings_id", "filament_type", "nozzle_temperature", "wall_loops"],
  );
});

test("the shell feeds the engine set to every preset reload and fills it on every write", async () => {
  const { readFile } = await import("node:fs/promises");
  const client = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  const setter = client.slice(client.indexOf("const setEditorSettings"), client.indexOf("// -- adapter-backed controls"));
  assert.match(setter, /engineKeysRef\.current = recordEngineWrites\(\{\s*before: current,\s*after: locked,\s*preset: loadedPresetRef\.current,\s*engine: engineKeysRef\.current,\s*byPerson,\s*\}\);/);
  assert.match(client, /previousFilamentKeys: loadedFilamentKeysRef\.current,\s*engineKeys: engineKeysRef\.current,/);
  assert.match(client, /engineKeysRef\.current = new Set\(carried\.engineKept\);/);
  assert.match(client, /loadedFilamentKeysRef\.current = loaded\.filamentKeys;/);
  assert.match(client, /engineKeysRef\.current = new Set\(keysAwayFromPreset\(loaded\.settings, restored\)\);/);
});
