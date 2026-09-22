/**
 * THE PRINTER IS ASKED FOR, AND THE ANSWER IS REMEMBERED.
 *
 * «خلي الشخص يختار طابعته اول ما يدخل، لان حاليا من دخلت اختارلي x2d مباشرة.»
 *
 * DEFAULT_PROFILE_ID has to exist — something must size the bed on the very
 * first frame — and that is exactly what made the bug invisible: the seed was
 * also, silently, the answer. This file runs the real module against a real
 * storage object and pins the three states it has to keep apart:
 *
 *   nothing stored     the question has never been asked. ASK IT.
 *   a ProfileId        the person picked that printer. USE IT, do not ask.
 *   the decline marker the person was asked and closed the sheet. DO NOT ASK
 *                      AGAIN, and do not pretend the marker is a printer.
 *
 * The third is the one a simpler implementation gets wrong: storing the seed
 * on dismissal would read back as "they chose the X2D", which is the original
 * bug wearing a localStorage key.
 *
 * Also pins the infill table against the engine's own kernel list, because a
 * pattern the kernel does not know is rewritten to rectilinear in silence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAppModule } from "./lib/load-app-module.mjs";

/** A localStorage that behaves like one, including the throwing kind. */
function fakeStorage({ throwOnWrite = false, throwOnRead = false } = {}) {
  const map = new Map();
  return {
    getItem(key) {
      if (throwOnRead) throw new Error("storage denied");
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throwOnWrite) throw new Error("storage denied");
      map.set(key, String(value));
    },
    raw: map,
  };
}

function withStorage(storage) {
  globalThis.window = { localStorage: storage };
  return () => { delete globalThis.window; };
}

const profiles = await loadAppModule("printer-profiles");

test("a first visit has no printer and an unanswered question", () => {
  const restore = withStorage(fakeStorage());
  try {
    assert.equal(profiles.readStoredProfileId(), null, "nothing was chosen");
    assert.equal(profiles.printerChoiceAnswered(), false, "so the chooser must open");
  } finally { restore(); }
});

test("a chosen printer comes back, and stops the question", () => {
  const storage = fakeStorage();
  const restore = withStorage(storage);
  try {
    profiles.storeProfileId("bbl-a1m-04");
    assert.equal(profiles.readStoredProfileId(), "bbl-a1m-04");
    assert.equal(profiles.printerChoiceAnswered(), true);
  } finally { restore(); }
});

test("a dismissal answers the question WITHOUT becoming a printer", () => {
  const storage = fakeStorage();
  const restore = withStorage(storage);
  try {
    profiles.storePrinterChoiceDeclined();
    assert.equal(profiles.printerChoiceAnswered(), true, "asking again on every visit is nagging");
    assert.equal(
      profiles.readStoredProfileId(),
      null,
      "a decline is not a choice — reading it back as one would be the original bug with a storage key",
    );
    assert.notEqual(storage.raw.get(profiles.PRINTER_STORAGE_KEY), profiles.DEFAULT_PROFILE_ID);
  } finally { restore(); }
});

test("a corrupted or stale value is ignored rather than trusted", () => {
  const storage = fakeStorage();
  const restore = withStorage(storage);
  try {
    storage.setItem(profiles.PRINTER_STORAGE_KEY, "bbl-printer-that-was-removed");
    assert.equal(profiles.readStoredProfileId(), null, "an id this build no longer ships is not a printer");
    assert.equal(profiles.printerChoiceAnswered(), true, "but something IS stored, so it was answered");
  } finally { restore(); }
});

test("storage being denied is survivable, and simply means the question returns", () => {
  const restore = withStorage(fakeStorage({ throwOnWrite: true, throwOnRead: true }));
  try {
    assert.doesNotThrow(() => profiles.storeProfileId("bbl-x2d-04"));
    assert.doesNotThrow(() => profiles.storePrinterChoiceDeclined());
    assert.equal(profiles.readStoredProfileId(), null);
    assert.equal(profiles.printerChoiceAnswered(), false);
  } finally { restore(); }
});

test("nothing explodes when there is no window at all (server render)", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(profiles.readStoredProfileId(), null);
  assert.equal(profiles.printerChoiceAnswered(), false);
  assert.doesNotThrow(() => profiles.storeProfileId("bbl-x2d-04"));
});

test("every offered infill pattern is one the kernel can actually fill with", async () => {
  const engine = await readFile(new URL("../node_modules/three-slicer/engine/src/settings.js", import.meta.url), "utf8");
  const declaration = /const\s+KERNEL_PATTERNS\s*=\s*\[([\s\S]*?)\]/.exec(engine);
  assert.ok(declaration, "the engine no longer declares KERNEL_PATTERNS");
  const supported = [...declaration[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const tiers = Object.keys(profiles.INFILL);
  assert.deepEqual(tiers, ["light", "balanced", "strong"], "one pattern per goal: «خفيف - متوسط - قوي»");
  for (const tier of tiers) {
    const { pattern, label } = profiles.INFILL[tier];
    assert.ok(supported.includes(pattern), `${tier} offers "${pattern}", which the kernel rewrites to rectilinear in silence`);
    assert.ok(label.length > 0, `${tier} must carry the engine's own pattern name`);
  }
  assert.ok(profiles.isInfillId(profiles.DEFAULT_INFILL_ID));
  assert.equal(profiles.isInfillId("cubic"), false, "a name the engine downgrades must not be selectable");
});
