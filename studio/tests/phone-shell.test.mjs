/**
 * THE PHONE SHELL (plan item C6, reference IMG_8466): what it may say, what it
 * measures, and what it must never drop.
 *
 *  - the readiness banner's decision table, run for real, including every
 *    case where a success would be easy to show by mistake;
 *  - the size readout and the orientation presets, on synthetic meshes;
 *  - the device-local theme, including the inline boot script itself;
 *  - every new string in ar, en and real Sorani (never the Arabic copied);
 *  - nothing the old bar and tray reached is unreachable now, and the AGPL
 *    source link is two taps from the main screen;
 *  - G-code is exportable only from a fresh result.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadAppModule } from "./lib/load-app-module.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// --------------------------------------------------------------- readiness

test("the readiness banner never shows a success it cannot stand behind", async () => {
  const { readinessOf, toneOf } = await loadAppModule("components/mobile/readiness");
  const ok = {
    objectCount: 1,
    importing: false,
    engineReady: true,
    profileLoading: false,
    profileVerified: true,
    slicing: false,
    errored: false,
    resultState: "none",
    preflightOk: true,
  };
  assert.equal(readinessOf(ok), "ready");
  assert.equal(toneOf("ready"), "success");

  // Nothing to judge: hidden, never a premature «جاهز».
  for (const hidden of [
    { objectCount: 0 },
    { importing: true },
    { engineReady: false },
    { profileLoading: true },
    { slicing: true },
    { errored: true },
  ]) {
    assert.equal(readinessOf({ ...ok, ...hidden }), null, JSON.stringify(hidden));
  }

  // A blocker beats everything, a fresh result included.
  assert.equal(readinessOf({ ...ok, preflightOk: false }), "blocked");
  assert.equal(readinessOf({ ...ok, preflightOk: false, resultState: "fresh" }), "blocked");
  assert.equal(readinessOf({ ...ok, resultState: "rejected-over-bed" }), "blocked");
  assert.equal(toneOf("blocked"), "danger");

  // A model off the bed is blocked before the slice the engine would refuse,
  // even over a fresh result; a caller that does not know reads as on the bed.
  assert.equal(readinessOf({ ...ok, offBedCount: 1 }), "blocked");
  assert.equal(readinessOf({ ...ok, offBedCount: 2, resultState: "fresh" }), "blocked");
  assert.equal(readinessOf({ ...ok, offBedCount: 0 }), "ready");

  // An outdated result is a warning, never «ready».
  assert.equal(readinessOf({ ...ok, resultState: "stale" }), "stale");
  assert.equal(toneOf("stale"), "warning");

  // Generic fallback settings are a warning, even over a fresh result.
  assert.equal(readinessOf({ ...ok, profileVerified: false }), "fallback");
  assert.equal(readinessOf({ ...ok, profileVerified: false, resultState: "fresh" }), "fallback");
  assert.equal(toneOf("fallback"), "warning");

  assert.equal(readinessOf({ ...ok, resultState: "fresh" }), "sliced");
  assert.equal(toneOf("sliced"), "success");

  // THE EMPTY CURRENT PLATE (c6-r2-ha-01): one model on plate 1, «+ Plate»,
  // and plate 2 is the current one. The slice acts on plate 2 and the engine
  // refuses it («Plate 2 has no objects»), so the banner is a warning that
  // says so, never «جاهز للتقطيع». A caller that cannot place the models
  // (no count) is not judged empty.
  assert.equal(readinessOf({ ...ok, objectCount: 1, plateObjectCount: 0 }), "empty");
  assert.equal(readinessOf({ ...ok, objectCount: 3, plateObjectCount: 0, resultState: "stale" }), "empty");
  assert.equal(readinessOf({ ...ok, objectCount: 1, plateObjectCount: 0, offBedCount: 1 }), "empty", "the slice of this plate is refused whatever the others hold");
  assert.equal(toneOf("empty"), "warning");
  assert.equal(readinessOf({ ...ok, objectCount: 2, plateObjectCount: 1 }), "ready");
  assert.equal(readinessOf({ ...ok, objectCount: 1 }), "ready", "an unknown plate count is not an empty plate");
  assert.equal(readinessOf({ ...ok, objectCount: 0, plateObjectCount: 0 }), null, "no model anywhere: hidden, the card says import");

  // Exhaustively: a success tone only ever comes with no blocker, a verified
  // profile, a result that is not stale and a model on the current plate.
  const bools = [true, false];
  for (const preflightOk of bools) for (const profileVerified of bools) {
    for (const resultState of ["none", "fresh", "stale", "rejected-over-bed"]) {
      for (const plateObjectCount of [undefined, 0, 1]) {
        const kind = readinessOf({ ...ok, preflightOk, profileVerified, resultState, plateObjectCount });
        if (kind && toneOf(kind) === "success") {
          assert.ok(preflightOk && profileVerified && plateObjectCount !== 0 && (resultState === "none" || resultState === "fresh"), `${kind} with ${JSON.stringify({ preflightOk, profileVerified, resultState, plateObjectCount })}`);
        }
      }
    }
  }
});

test("an over-bed rejection stops describing the plate once the scene or the settings move on", async () => {
  // c6-r2-ha-02: the engine rejected the slice of a tower at (140, 0); «ترتيب»
  // put it back on the bed and the banner still said «خارج حدود سطح الطباعة»,
  // because the rejection was cleared only by a new slice.
  const { rejectionHolds } = await loadAppModule("hooks/use-slicing-state");
  const rejected = { sceneFingerprint: "tower@140,0", settingsRevision: 3 };
  assert.equal(rejectionHolds(rejected, { sceneFingerprint: "tower@140,0", settingsRevision: 3 }), true, "nothing changed: still rejected");
  assert.equal(rejectionHolds(rejected, { sceneFingerprint: "tower@-116,116", settingsRevision: 3 }), false, "arranged: the rejection is about a scene that is gone");
  assert.equal(rejectionHolds(rejected, { sceneFingerprint: "tower@140,0", settingsRevision: 4 }), false, "a settings change (a brim, a skirt) may have been the cause");

  // After «ترتيب»: no rejection, no result, nothing off the bed: not blocked.
  const { readinessOf } = await loadAppModule("components/mobile/readiness");
  const base = { objectCount: 1, importing: false, engineReady: true, profileLoading: false, profileVerified: true, slicing: false, errored: false, preflightOk: true, plateObjectCount: 1 };
  assert.equal(readinessOf({ ...base, resultState: "rejected-over-bed", offBedCount: 1 }), "blocked", "before: rejected and off the bed");
  assert.equal(readinessOf({ ...base, resultState: "none", offBedCount: 0 }), "ready", "after arranging: the placement check decides");
  assert.equal(readinessOf({ ...base, resultState: "none", offBedCount: 1 }), "blocked", "moved, but still off the bed: still blocked");

  const hook = await read("../app/hooks/use-slicing-state.ts");
  assert.match(hook, /const rejected = overBedPlates\(\)\.get\(plate\);\s*if \(rejected && rejectionHolds\(rejected, \{/);
  assert.match(hook, /overBedPlates\(\)\.set\(payload\.plate, \{\s*sceneFingerprint: sliceStartFingerprintRef\.current \?\? currentFingerprint,\s*settingsRevision: sliceStartSettingsRevisionRef\.current,\s*\}\);/);
  assert.doesNotMatch(hook, /if \(overBedPlates\(\)\.has\(plate\)\) return "rejected-over-bed";/);
});

test("a blocked banner names the real cause: too big, or only misplaced", async () => {
  const { readinessTitleKey } = await loadAppModule("components/mobile/readiness");
  const { DICTIONARIES } = await loadAppModule("i18n/index");
  // An 8 x 8 x 90 mm tower beside an A1 bed is not «أكبر من حجم الطابعة».
  assert.equal(readinessTitleKey("blocked", 0), "outsideBedTitle");
  assert.equal(readinessTitleKey("blocked", 1), "tooBigTitle");
  assert.equal(DICTIONARIES.ar[readinessTitleKey("blocked", 0)], "خارج حدود سطح الطباعة");
  assert.equal(DICTIONARIES.en[readinessTitleKey("blocked", 0)], "Outside the build area");
  assert.equal(DICTIONARIES.ar[readinessTitleKey("blocked", 3)], "أكبر من حجم الطابعة");
  for (const [kind, key] of [["ready", "readyToSlice"], ["sliced", "printReady"], ["stale", "stale"], ["fallback", "presetFallbackTitle"], ["empty", "emptyPlateTitle"]]) {
    assert.equal(readinessTitleKey(kind, 0), key);
    assert.equal(readinessTitleKey(kind, 2), key, "the size count only matters for a block");
  }
  const banner = await read("../app/components/mobile/readiness-banner.tsx");
  assert.match(banner, /const title = t\[readinessTitleKey\(kind, oversizedCount\)\];/);
  assert.doesNotMatch(banner, /: t\.tooBigTitle;/, "no fall-through that calls every block too big");
});

test("models off the bed are found from where they are, not only how big they are", async () => {
  const { objectsOffBed, measureExtent } = await loadAppModule("model-dimensions");
  const one = { x: 1, y: 1, z: 1 };
  const zero = { x: 0, y: 0, z: 0 };
  const a1 = { width: 256, depth: 256 };
  // The reviewer's case: an 8 x 8 x 90 mm tower moved 140 mm off the centre of an A1.
  const tower = measureExtent({ id: 1, localPos: box(8, 90, 8), rot: zero, scale: one });
  assert.deepEqual([tower.minX, tower.maxX, tower.minZ, tower.maxZ], [-4, 4, -4, 4]);
  const at = (x, z, plateCentre = { x: 0, z: 0 }, extent = tower) => ({ id: 1, pos: { x, z }, extent, plateCentre });
  assert.deepEqual(objectsOffBed([at(0, 0)], a1), [], "centred: on the bed");
  assert.deepEqual(objectsOffBed([at(120, 0)], a1), [], "near the edge, still inside");
  assert.deepEqual(objectsOffBed([at(124, 0)], a1), [], "touching the edge is inside");
  assert.deepEqual(objectsOffBed([at(140, 0)], a1), [1], "wholly outside");
  assert.deepEqual(objectsOffBed([at(130, 0)], a1), [1], "partly outside is refused too");
  assert.deepEqual(objectsOffBed([at(0, -127)], a1), [1], "the depth axis counts as well");
  // Each object is judged on the bed of its own plate.
  assert.deepEqual(objectsOffBed([at(0, 296, { x: 0, z: 296 })], a1), [], "the middle of plate 2");
  assert.deepEqual(objectsOffBed([at(0, 296 + 130, { x: 0, z: 296 })], a1), [1]);
  // Unknown geometry is not judged, and a smaller bed is smaller.
  assert.deepEqual(objectsOffBed([at(500, 0, { x: 0, z: 0 }, null)], a1), []);
  assert.deepEqual(objectsOffBed([at(88, 0)], { width: 180, depth: 180 }), [1], "the A1 mini bed is 180 mm");
  // A rotation moves the reach: a quarter turn about Z lays the tower along X.
  const lying = measureExtent({ id: 2, localPos: box(8, 90, 8), rot: { x: 0, y: 0, z: Math.PI / 2 }, scale: one });
  assert.ok(Math.abs(lying.maxX - 45) < 1e-4, JSON.stringify(lying));
  assert.deepEqual(objectsOffBed([{ ...at(100, 0), extent: lying }], a1), [1], "lying down, it reaches 145 mm");
});

test("the shell drives the banner from the real preflight and the real result state", async () => {
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /import \{ runPreflight \} from "\.\/makerworld\/preflight";/);
  assert.match(client, /return runPreflight\(\{/);
  const call = client.slice(client.indexOf("const readiness = readinessOf({"), client.indexOf("});", client.indexOf("const readiness = readinessOf({")));
  for (const input of ["preflightOk: preflight.ok", "offBedCount", "plateObjectCount", "resultState: currentResultState", "profileVerified: profileLoadState?.verified", "slicing: status === \"slicing\"", "errored: status === \"error\"", "importing: Boolean(importProgress)"]) {
    assert.ok(call.includes(input), `readinessOf is not given ${input}`);
  }
  assert.match(client, /\{readiness && <ReadinessBanner t=\{t\} kind=\{readiness\} detail=\{readinessDetail\} oversizedCount=\{oversizedCount\} \/>\}/);
  // The placement is measured from the scene and the bed of each plate.
  assert.match(client, /objectsOffBed\(placed, \{ width: profile\.bedWidth, depth: profile\.bedDepth \}\)/);
  assert.match(client, /api\.platePos\(adapter\.plateOfSnapshot\(entry\.snapshot, plateCount\)\)/);
  // The empty-plate count is the selected plate's visible models, not every plate's.
  assert.match(client, /entry\.snapshot\.visible !== false && adapter\.plateOfSnapshot\(entry\.snapshot, plateCount\) === selectedPlate/);
  assert.match(client, /readiness === "empty"\s*\? templateText\(t\.emptyPlateHelp, \{ plate: selectedPlate \+ 1 \}\)/);
  // The second line says what is wrong: size, then place, then the engine.
  assert.match(client, /\? \(oversizedCount\s*\? templateText\(t\.tooBigHelp,[\s\S]*?: offBedCount\s*\? templateText\(t\.offBedHelp,[\s\S]*?: templateText\(t\.overBedError,/);
});

// --------------------------------------------------------------- the size readout

/** A box mesh (two corner vertices are enough for an extent) of w × h × d, Y up. */
const box = (w, h, d) => new Float32Array([-w / 2, -h / 2, -d / 2, w / 2, h / 2, d / 2, w / 2, -h / 2, d / 2, -w / 2, h / 2, -d / 2]);

test("the size readout measures the model as the printer sees it", async () => {
  const { measureSnapshot, formatDimensions, createDimensionCache } = await loadAppModule("model-dimensions");
  const one = { x: 1, y: 1, z: 1 };
  const zero = { x: 0, y: 0, z: 0 };
  // 80 wide (X), 30 tall (Y), 40 deep (Z) — the reference's numbers.
  const dims = measureSnapshot({ id: 1, localPos: box(80, 30, 40), rot: zero, scale: one });
  assert.deepEqual(dims, { width: 80, depth: 40, height: 30 });
  assert.equal(formatDimensions(dims), "80 × 40 × 30 mm");
  // Scale is applied before rotation; a quarter turn about X swaps height and depth.
  const turned = measureSnapshot({ id: 1, localPos: box(80, 30, 40), rot: { x: Math.PI / 2, y: 0, z: 0 }, scale: { x: 0.5, y: 1, z: 1 } });
  assert.ok(Math.abs(turned.width - 40) < 1e-4 && Math.abs(turned.height - 40) < 1e-4 && Math.abs(turned.depth - 30) < 1e-4, JSON.stringify(turned));
  // Nothing measurable is "unknown", never zero (a zero would fit any printer).
  assert.equal(measureSnapshot({ id: 2, localPos: new Float32Array(0), rot: zero, scale: one }), null);
  assert.equal(formatDimensions({ width: 12.34, depth: 120.4, height: 7 }), "12.3 × 120 × 7 mm");
  // The cache re-measures only when the rotation, the scale or the mesh changes.
  const cache = createDimensionCache();
  const snapshot = { id: 3, localPos: box(10, 10, 10), rot: { ...zero }, scale: { ...one } };
  const first = cache.measure(snapshot);
  assert.equal(cache.measure({ ...snapshot }), first, "a move is not a re-measure");
  assert.notEqual(cache.measure({ ...snapshot, scale: { x: 2, y: 1, z: 1 } }), first);
});

// --------------------------------------------------------------- orientation presets

test("the orientation chips are read from the scene, never remembered", async () => {
  const { currentPreset, sideEuler, sameRotation, IMPORTED_EULER } = await loadAppModule("auto-orient");
  const one = { x: 1, y: 1, z: 1 };
  const tall = box(10, 40, 20);
  // A tall part lies down on the side that leaves it lowest.
  const side = sideEuler(tall, one);
  assert.ok(sameRotation(side, { x: 0, y: 0, z: Math.PI / 2 }), JSON.stringify(side));
  const objects = (rot) => [{ id: 1, rot, localPos: tall, scale: one }];
  assert.equal(currentPreset(objects(IMPORTED_EULER), new Map()), "imported");
  assert.equal(currentPreset(objects(side), new Map()), "side");
  // Same rotation, other spelling: still recognised.
  assert.equal(currentPreset(objects({ x: 2 * Math.PI, y: 0, z: 0 }), new Map()), "imported");
  // What auto-orient wrote is «تلقائي» while the object stays there…
  const auto = { x: 0.3, y: 0.1, z: 0 };
  assert.equal(currentPreset(objects(auto), new Map([[1, auto]])), "auto");
  // …and a hand rotation leaves no chip pressed rather than a stale one.
  assert.equal(currentPreset(objects({ x: 0.31, y: 0.1, z: 0 }), new Map([[1, auto]])), null);
  // Objects that disagree leave no chip pressed either.
  assert.equal(currentPreset([...objects(IMPORTED_EULER), { id: 2, rot: side, localPos: tall, scale: one }], new Map()), null);
  assert.equal(currentPreset([], new Map()), null);
});

test("the orientation presets re-seat by difference and are undoable, like auto-orient", async () => {
  const adapter = await read("../app/engine-adapter.ts");
  const fn = adapter.slice(adapter.indexOf("export function applyOrientationPreset("), adapter.indexOf("// Plane cut"));
  assert.match(fn, /const captured = adapter\.captureSceneState\(/);
  assert.match(fn, /snapshot\.pos\.y \+= before - after;/);
  assert.match(fn, /api\.restoreScene\(snapshots\);/);
  assert.match(fn, /adapter\.notifySceneEdited\(\);/);
  assert.match(fn, /undo: captured && changedCount \? \(\) => adapter\.restoreSceneState\(captured\) : null/);
});

// --------------------------------------------------------------- the theme

test("the theme is a device-local system, light or dark choice, applied before first paint", async () => {
  const theme = await loadAppModule("theme");
  assert.deepEqual([...theme.THEME_PREFERENCES], ["system", "light", "dark"]);
  assert.equal(theme.resolveTheme("system", true), "dark");
  assert.equal(theme.resolveTheme("system", false), "light");
  assert.equal(theme.resolveTheme("light", true), "light");
  assert.equal(theme.resolveTheme("dark", false), "dark");
  assert.equal(theme.isThemePreference("sepia"), false);
  // The browser chrome follows each theme's page ground.
  const css = await read("../app/globals.css");
  assert.match(css, new RegExp(`--shell: ${theme.THEME_CHROME_COLORS.dark};`, "i"));
  assert.match(css, new RegExp(`--shell: ${theme.THEME_CHROME_COLORS.light};`, "i"));

  // Run the inline boot script itself against a fake document.
  const run = ({ stored, prefersDark }) => {
    const attrs = {};
    const metas = [{ content: "", setAttribute(_n, v) { this.content = v; } }, { content: "", setAttribute(_n, v) { this.content = v; } }];
    const env = {
      localStorage: { getItem: (key) => (key === theme.THEME_STORAGE_KEY ? stored : null) },
      window: { matchMedia: () => ({ matches: prefersDark }) },
      document: {
        documentElement: { setAttribute: (n, v) => { attrs[n] = v; }, style: {} },
        querySelectorAll: () => metas,
      },
    };
    // eslint-disable-next-line no-new-func
    new Function("localStorage", "window", "document", theme.THEME_BOOT_SCRIPT)(env.localStorage, env.window, env.document);
    return { theme: attrs["data-theme"], scheme: env.document.documentElement.style.colorScheme, metas: metas.map((m) => m.content) };
  };
  assert.deepEqual(run({ stored: null, prefersDark: true }), { theme: "dark", scheme: "dark", metas: ["", ""] }, "system: the media metas already answer");
  assert.deepEqual(run({ stored: null, prefersDark: false }).theme, "light");
  assert.deepEqual(run({ stored: "light", prefersDark: true }), { theme: "light", scheme: "light", metas: [theme.THEME_CHROME_COLORS.light, theme.THEME_CHROME_COLORS.light] });
  assert.deepEqual(run({ stored: "dark", prefersDark: false }).metas, [theme.THEME_CHROME_COLORS.dark, theme.THEME_CHROME_COLORS.dark]);
  assert.equal(run({ stored: "garbage", prefersDark: false }).theme, "light", "an unknown value means system");

  const layout = await read("../app/layout.tsx");
  assert.match(layout, /<script dangerouslySetInnerHTML=\{\{ __html: THEME_BOOT_SCRIPT \}\} \/>/);
  assert.match(layout, /media: "\(prefers-color-scheme: dark\)", color: THEME_CHROME_COLORS\.dark/);
  // The theme reaches the engine's shadow roots, and the canvas stays dark.
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /adapter\.setHostAttribute\("data-levo-theme", studioTheme\.resolved\)/);
  // No account column: the prefs API still stores the mode only.
  const prefs = await read("../worker/api/prefs.ts");
  assert.doesNotMatch(prefs, /theme/i);
});

// --------------------------------------------------------------- strings

const NEW_KEYS = [
  "subtitle", "import", "saveNow", "savedDraftGuest", "savedToAccount", "saveFailed", "backToSite", "leaveConfirm",
  "resetView", "expandView", "collapseView", "noModelYet", "transformTools", "toolRotate", "toolScale", "toolArrange",
  "printSettings", "material", "layerHeight", "infill", "customValue", "allSettings", "dimensions", "dimensionsPick",
  "orientation", "orientImported", "orientAuto", "orientSide", "orientPresetDone", "readyToSlice", "readyToSliceHelp",
  "tooBigTitle", "tooBigHelp", "presetFallbackTitle", "slicedSummary", "slicedEstimate", "durationHours", "durationMinutes",
  "sliceModel", "resliceModel", "exportFile", "export3mf", "exportGcode", "availableAfterSlice", "resliceFirst", "moreExport",
  "more", "moreTitle", "viewGroup", "accountGroup", "theme", "themeSystem", "themeLight", "themeDark",
  "outsideBedTitle", "offBedHelp", "emptyPlateTitle", "emptyPlateHelp",
];

test("every phone-shell string exists in ar, en and real Sorani", async () => {
  const { DICTIONARIES } = await loadAppModule("i18n/index");
  for (const key of NEW_KEYS) {
    const [en, ar, ckb] = ["en", "ar", "ckb"].map((locale) => DICTIONARIES[locale][key]);
    assert.ok(en && ar && ckb, `${key} must exist in all three`);
    assert.notEqual(ckb, ar, `${key}: the ckb slot must not carry the Arabic (row 183)`);
    if (!/^[\s{}A-Za-z0-9().,·%-]+$/.test(ckb)) assert.notEqual(ckb, en, `${key}: ckb must be translated`);
    // Placeholders survive translation (in Arabic, possibly as a counted block).
    for (const slot of en.match(/\{\w+\}/g) ?? []) {
      const counted = `${slot.slice(0, -1)}, plural,`;
      assert.ok((ar.includes(slot) || ar.includes(counted)) && ckb.includes(slot), `${key}: ${slot} is lost in a translation`);
    }
  }
  // The reference's words, in Arabic.
  const ar = DICTIONARIES.ar;
  assert.equal(ar.subtitle, "تجهيز ملفات الطباعة");
  assert.equal(ar.sliceModel, "تقطيع المجسم");
  assert.equal(ar.readyToSlice, "جاهز للتقطيع");
  assert.equal(ar.availableAfterSlice, "متاح بعد التقطيع");
  assert.equal(ar.modeSimple, "مبسط");
  assert.equal(ar.infill, "الملء");
});

test("Arabic counts say «دقيقتين», «6 دقائق» and «11 دقيقة», never «6 دقيقة» or «5 طبقة»", async () => {
  // c6-r2-ha-04: the sliced banner read «49 طبقة، نحو 6 دقيقة للطباعة.»
  const { DICTIONARIES, templateText } = await loadAppModule("i18n/index");
  const { ar, en, ckb } = DICTIONARIES;
  const minutes = (m, locale = "ar") => templateText(DICTIONARIES[locale].durationMinutes, { m }, locale);
  assert.deepEqual([1, 2, 3, 10, 11].map((m) => minutes(m)), ["دقيقة واحدة", "دقيقتين", "3 دقائق", "10 دقائق", "11 دقيقة"]);
  assert.equal(minutes(100), "100 دقيقة");
  const hours = (h, m) => templateText(ar.durationHours, { h, m }, "ar");
  assert.deepEqual([1, 2, 3, 10, 11].map((h) => hours(h, 5)), ["ساعة واحدة و5 دقائق", "ساعتين و5 دقائق", "3 ساعات و5 دقائق", "10 ساعات و5 دقائق", "11 ساعة و5 دقائق"]);
  assert.equal(hours(2, 1), "ساعتين ودقيقة واحدة");
  assert.equal(hours(2, 2), "ساعتين ودقيقتين");
  assert.equal(hours(3, 0), "3 ساعات", "a whole hour drops «و0 دقيقة»");
  const layers = (n) => templateText(ar.slicedSummary, { layers: n }, "ar");
  assert.deepEqual([1, 2, 3, 10, 11].map(layers), [
    "طبقة واحدة، جاهزة للتصدير.", "طبقتان، جاهزة للتصدير.", "3 طبقات، جاهزة للتصدير.", "10 طبقات، جاهزة للتصدير.", "11 طبقة، جاهزة للتصدير.",
  ]);
  assert.equal(layers("—"), "— طبقة، جاهزة للتصدير.", "an unknown count takes the general form");
  // The reviewer's two banners, now grammatical.
  assert.equal(templateText(ar.slicedEstimate, { layers: 49, time: minutes(6) }, "ar"), "49 طبقة، نحو 6 دقائق للطباعة.");
  assert.equal(templateText(ar.slicedEstimate, { layers: 82, time: minutes(10) }, "ar"), "82 طبقة، نحو 10 دقائق للطباعة.");
  assert.equal(templateText(ar.slicedEstimate, { layers: 5, time: minutes(2) }, "ar"), "5 طبقات، نحو دقيقتين للطباعة.");
  // English and Sorani stay as they were: the unit once, after the number.
  assert.deepEqual([1, 2, 3, 11].map((m) => minutes(m, "en")), ["1 min", "2 min", "3 min", "11 min"]);
  assert.deepEqual([1, 2, 3, 11].map((m) => minutes(m, "ckb")), ["1 خولەک", "2 خولەک", "3 خولەک", "11 خولەک"]);
  assert.equal(templateText(en.slicedSummary, { layers: 3 }, "en"), "3 layers, ready to export.");
  assert.equal(templateText(ckb.durationHours, { h: 2, m: 5 }, "ckb"), "2 کاتژمێر و 5 خولەک");
  // Every call site of the counted strings passes the locale.
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /templateText\(t\.slicedEstimate, \{ layers: slicedLayers \|\| "—", time: formatDuration\(estimateSeconds, t, locale\) \}, locale\)/);
  assert.match(client, /templateText\(t\.slicedSummary, \{ layers: slicedLayers \|\| "—" \}, locale\)/);
  assert.match(client, /templateText\(t\.durationHours, \{ h: hours, m: minutes % 60 \}, locale\)/);
  assert.match(client, /templateText\(t\.durationMinutes, \{ m: minutes \}, locale\)/);
});

test("«G-code» is one unbreakable token on the export tile", async () => {
  // C6-R2-FID-1: at 390 px the Sorani label wrapped as «هەناردەکردنی G-» over
  // «code», and the English one did at 320 px.
  const exp = await read("../app/components/mobile/export-section.tsx");
  const css = await read("../app/globals.css");
  const pattern = new RegExp(exp.match(/const HYPHENATED_TOKEN = \/(.+)\/;/)[1]);
  const { DICTIONARIES } = await loadAppModule("i18n/index");
  for (const locale of ["ar", "en", "ckb"]) {
    const parts = DICTIONARIES[locale].exportGcode.split(pattern);
    assert.deepEqual(parts.filter((_, index) => index % 2 === 1), ["G-code"], `${locale}: G-code is split out whole`);
    assert.equal(parts.join(""), DICTIONARIES[locale].exportGcode, `${locale}: nothing is lost`);
    assert.deepEqual(DICTIONARIES[locale].export3mf.split(pattern).length, 1, `${locale}: 3MF has no hyphen to guard`);
  }
  assert.match(exp, /<bdi key=\{index\} dir="ltr" className="m-export__token">\{part\}<\/bdi>/);
  assert.match(css, /\.m-export__token \{ white-space: nowrap; \}/);
});

test("every self-hosted font is credited, with its copyright and licence", async () => {
  // C6-R2-REG-3: the Sorani patch (a Vazirmatn subset) and the two Cairo
  // subsets ship in public/fonts, and the notices file named none of them.
  const { readdir } = await import("node:fs/promises");
  const notices = await read("../OPEN_SOURCE_NOTICES.md");
  const license = await read("../public/fonts/cairo/LICENSE");
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}${entry.name}/`);
      else if (/\.woff2?$/.test(entry.name)) files.push(`${dir}${entry.name}`.replace("../", ""));
    }
  };
  await walk("../public/fonts/");
  assert.deepEqual(files.sort(), ["public/fonts/cairo-kurdish-patch.woff2", "public/fonts/cairo/cairo-v31-arabic.woff2", "public/fonts/cairo/cairo-v31-latin.woff2"]);
  for (const file of files) assert.ok(notices.includes(`\`${file}\``), `${file} is not named in OPEN_SOURCE_NOTICES.md`);
  const fonts = notices.slice(notices.indexOf("## Fonts"), notices.indexOf("## Application dependencies"));
  assert.match(fonts, /### Cairo[\s\S]*Copyright 2009 The Cairo Project Authors[\s\S]*SIL Open Font License 1\.1 \(OFL-1\.1\)/);
  assert.match(fonts, /### Vazirmatn[\s\S]*Copyright 2015 The Vazirmatn Project Authors[\s\S]*SIL Open Font License 1\.1 \(OFL-1\.1\)/);
  assert.match(fonts, /public\/fonts\/cairo\/LICENSE/, "the notice points at the licence text");
  assert.match(license, /Copyright 2015 The Vazirmatn Project Authors/, "the licence file carries the patch copyright too");
  assert.match(license, /Copyright 2009 The Cairo Project Authors/);
});

// --------------------------------------------------------------- nothing dropped

test("everything the reference drops is still reachable, and the AGPL link is two taps away", async () => {
  const [client, overflow, about] = await Promise.all([
    read("../app/slicer-client.tsx"),
    read("../app/components/mobile/overflow-sheet.tsx"),
    read("../app/components/sheets/about.tsx"),
  ]);
  // Tap 1: «المزيد» is on the main screen and opens the overflow sheet.
  assert.match(client, /<button className="m-btn m-more" type="button" onClick=\{\(\) => setSheet\("more"\)\}/);
  assert.match(client, /sheet === "more" \? \(\s*<OverflowSheet/);
  // Tap 2: the source link is a plain anchor in that sheet, the same URL the
  // About sheet links.
  const url = /export const SOURCE_CODE_URL = "([^"]+)";/.exec(overflow)?.[1];
  assert.ok(url, "the source URL is declared");
  assert.ok(about.includes(`href="${url}"`), "the About sheet and the overflow sheet link the same source");
  assert.match(overflow, /<a href=\{SOURCE_CODE_URL\} target="_blank" rel="noreferrer" data-levo-more="source">/);

  // Every overflow action is wired in the shell.
  const union = /export type OverflowAction =([\s\S]*?);/.exec(overflow)?.[1] ?? "";
  const actions = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(actions.length >= 25, `expected the full overflow, saw ${actions.length}`);
  const runner = client.slice(client.indexOf("const runOverflow = useCallback("), client.indexOf("}, [canvasMode, clickControl"));
  for (const action of actions) {
    assert.ok(runner.includes(`action === "${action}"`), `the overflow action ${action} does nothing`);
  }
  // The controls the old phone bar and tray carried, by what they run.
  for (const reached of ['runTool("tool-duplicate")', 'runTool("tool-delete")', 'runTool("tool-split")', 'runTool("tool-onbed")', 'runTool("gizmo-paint")',
    "openCut()", "orientAll()", "deleteAll()", 'clickControl("plate-add")', "triggerSlice(true)", 'clickControl(canvasMode === "preview" ? "mode-prepare" : "mode-preview")',
    'shortcut("z")', 'shortcut("b")', 'clickControl("undo")', 'clickControl("redo")', "prepareForBambuHandy()", "shareCurrentGcode()",
    'clickControl("export-all")', "openPrintCenter()", 'setSheet("setup")', "openAllSettings()", 'setSheet("signout")', 'setSheet("connect")', 'setSheet("about")',
    "openProjects()", "newProject()"]) {
    assert.ok(runner.includes(reached), `${reached} is not reachable from the overflow`);
  }
  // Language, theme, sign-in and new files live in the sheet itself.
  assert.match(overflow, /LOCALES\.map/);
  assert.match(overflow, /className="theme-segments" role="radiogroup"/);
  assert.match(overflow, /href=\{SIGN_IN_HREF\}/);
  assert.match(overflow, /<FileSelectControl/);
});

// --------------------------------------------------------------- export honesty

test("G-code is exported only from a fresh result; 3MF needs no slice", async () => {
  const [client, section] = await Promise.all([read("../app/slicer-client.tsx"), read("../app/components/mobile/export-section.tsx")]);
  assert.match(section, /disabled=\{!props\.gcodeReady\}/);
  assert.match(section, /props\.gcodeReady \? props\.gcodeCaption : props\.stale \? t\.resliceFirst : t\.availableAfterSlice/);
  assert.match(client, /gcodeReady=\{printReady\}/);
  assert.match(client, /const printReady = status !== "slicing" && status !== "error" && currentResultState === "fresh";/);
  // The export path is the one that refuses a stale file on its own.
  assert.match(client, /onExportGcode=\{\(\) => \{ downloadCurrentGcode\(\); \}\}/);
  assert.match(client, /const file = currentGcodeFile\(\);\s*if \(!file\) \{/);
  // 3MF only needs something to save.
  assert.match(section, /onClick=\{props\.onExport3mf\} disabled=\{!props\.hasObjects\}/);
});

test("the gold primary and the sand selections are the owner's overrides, with a non-colour cue", async () => {
  const [css, tools, mode, model] = await Promise.all([
    read("../app/globals.css"),
    read("../app/components/mobile/transform-tool-bar.tsx"),
    read("../app/components/mobile/mode-segmented.tsx"),
    read("../app/components/mobile/model-info-card.tsx"),
  ]);
  // D-2: the sand gradient on the one primary.
  assert.match(css, /\.m-slice \{[^}]*background: var\(--gold-clay\);/);
  // D-3: solid sand on the current mode, tool and orientation, each stating
  // its state for assistive technology.
  assert.match(css, /\.m-sel\[aria-checked="true"\], \.m-sel\[aria-pressed="true"\] \{[^}]*background: var\(--gold-clay\);/);
  assert.match(mode, /className="m-sel"\s+aria-checked=\{mode === id\}/);
  assert.match(tools, /className="m-tool m-sel"\s+aria-pressed=\{active === tool\.id\}/);
  assert.match(model, /className="m-sel"\s+aria-pressed=\{props\.orientation === chip\.id\}/);
  // «استيراد» is gold outline, never a second gold fill.
  assert.match(css, /\.m-btn--outline \{ border: 1\.5px solid var\(--gold-line\); background: var\(--gold-outline-fill\); \}/);
});

// --------------------------------------------------------------- icon side, names, expanded focus

test("the icons sit at the end side of their labels, as the reference draws them", async () => {
  const [bar, slice, exp, card] = await Promise.all([
    read("../app/components/mobile/top-bar.tsx"),
    read("../app/components/mobile/primary-slice-button.tsx"),
    read("../app/components/mobile/export-section.tsx"),
    read("../app/components/mobile/viewport-card.tsx"),
  ]);
  // The label comes first in the source, so the icon lands on the end side:
  // left in Arabic and Sorani, trailing in English.
  assert.match(bar, /<span>\{t\.saveNow\}<\/span><Icon name="document" \/>/);
  assert.match(bar, /<span>\{t\.import\}<\/span><Icon name="upload" \/>/);
  assert.match(slice, /<span>\{label\}<\/span>\s*<Icon name=\{props\.printReady && !props\.slicing \? "print" : "layers"\} \/>/);
  assert.match(exp, /<span><b>\{keepTokensWhole\(t\.export3mf\)\}<\/b><\/span>\s*<Icon name="document" \/>/);
  assert.match(exp, /<b>\{keepTokensWhole\(t\.exportGcode\)\}<\/b>[\s\S]*?<\/span>\s*<Icon name="document" \/>/);
  assert.match(card, /<span>\{t\.noModelYet\}<\/span>\}\s*<Icon name="document" \/>/);
  for (const [name, source] of [["top bar", bar], ["slice", slice], ["export", exp], ["file chip", card]]) {
    assert.doesNotMatch(source, /<Icon name="(?:document|upload|layers)" \/>\s*<span>/, `${name}: an icon before its label`);
  }
  // The icons that are drawn on the start side stay there.
  assert.match(card, /<Icon name="resetView" \/><span>\{t\.resetView\}<\/span>/);
});

test("«إعادة العرض» keeps its name when its text is hidden on a narrow phone", async () => {
  const [card, css] = await Promise.all([read("../app/components/mobile/viewport-card.tsx"), read("../app/globals.css")]);
  // Under 350px the span goes; the button must still be named (WCAG 4.1.2).
  const narrow = css.slice(css.indexOf("@media (max-width: 350px) {"));
  assert.match(narrow.slice(0, narrow.indexOf("\n}")), /\.vp-tool > span \{ display: none; \}/);
  const reset = /<button[^>]*?data-levo-action="reset-view"[^>]*>/s.exec(card)?.[0] ?? "";
  assert.ok(reset, "the reset-view button is findable");
  assert.match(reset, /aria-label=\{t\.resetView\}/);
  assert.match(reset, /title=\{t\.resetView\}/);
});

test("with the viewport expanded, the page under it is inert, and Escape hands focus back", async () => {
  const client = await read("../app/slicer-client.tsx");
  assert.match(client, /<div className="studio-scroll" ref=\{scrollColumnRef\}>/);
  const effect = client.slice(client.indexOf("const column = scrollColumnRef.current;"), client.indexOf("const toggleViewportExpanded"));
  assert.ok(effect.includes("if (!column || !viewportExpanded) return;"), "only while expanded");
  // Every sibling of the card, including one that renders while expanded.
  assert.match(effect, /if \(child !== card\) \(child as HTMLElement\)\.inert = true;/);
  assert.match(effect, /new MutationObserver\(hide\)/);
  assert.match(effect, /observer\.observe\(column, \{ childList: true \}\)/);
  // And nothing is left inert after it collapses.
  assert.match(effect, /return \(\) => \{[\s\S]*?for \(const child of column\.children\) \(child as HTMLElement\)\.inert = false;/);
  // Focus never stays on a control that just went inert.
  assert.match(effect, /column\.contains\(active\) && !card\.contains\(active\)/);
  // Escape collapses and returns focus to the expand button.
  const escape = client.slice(client.indexOf("if (!viewportExpanded || sheet) return;"), client.indexOf("}, [sheet, viewportExpanded]);"));
  assert.match(escape, /setViewportExpanded\(false\);/);
  assert.match(escape, /querySelector<HTMLElement>\('\[data-levo-action="viewport-expand"\]'\)\?\.focus\(/);
});

// --------------------------------------------------------------- round 3 review

test("the empty screen's «إضافة» is the sand clay primary, and a message action is never a second gold fill", async () => {
  // c6-r3-fid-1: «إضافة» was the flat --accent, which the light theme turns
  // into #6F592B with cream ink, while the loaded screen's primary is the sand
  // gradient with near-black ink. Both are now the same recipe in both themes.
  const css = (await read("../app/globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${selector} is findable`);
    return css.slice(at, css.indexOf("}", at));
  };
  const empty = rule(".empty-upload-card > .file-select-control");
  const slice = rule(".m-slice");
  for (const declaration of ["background: var(--gold-clay);", "box-shadow: var(--clay-gold);", "color: var(--gold-ink);"]) {
    assert.ok(empty.includes(declaration), `«إضافة» lacks ${declaration}`);
    assert.ok(slice.includes(declaration), `the slice button lacks ${declaration}`);
  }
  assert.doesNotMatch(empty, /var\(--accent(?:-ink)?\)/, "no flat accent on the empty primary");
  // --clay-gold carries the rim, the base, the 1px --gold-edge ring (#7A5C30 in
  // light) and the cast, so the light theme gets its 3:1 edge from it.
  assert.match(css, /--clay-gold: inset 0 1px 0 var\(--gold-rim\), inset 0 -2px 0 var\(--gold-base\), 0 0 0 1px var\(--gold-edge\), 0 6px 14px -6px var\(--clay-ambient\);/);
  assert.match(css, /:root\[data-theme="light"\] \{[^}]*--gold-edge: #7A5C30;/);
  // The undo of an arrange, an orient or a cut is a secondary action: the gold
  // outline of «استيراد», never the accent fill.
  const action = rule(".editor-message button.message-action");
  assert.ok(action.includes("border: 1.5px solid var(--gold-line);"), "the message action draws the gold outline");
  assert.ok(action.includes("background: var(--gold-outline-fill);"), "on the outline fill");
  assert.ok(action.includes("color: var(--text);"), "with the body ink");
  assert.doesNotMatch(action, /var\(--accent(?:-ink)?\)|var\(--gold-clay\)/, "never a second gold fill");
});

test("the «الخامة» row and the sheet header say the filament T1 really prints with", async () => {
  // c6-r3-ha-01: an A1 project made for PETG Basic. The engine applies its
  // project settings, T1 is PETG and the G-code says M104 S255, while the row
  // said «PLA Basic» and the header «· PLA».
  const { unzipSync, strFromU8 } = await import("fflate");
  const fixture = await readFile(new URL("./fixtures/mini-project.3mf", import.meta.url));
  const project = JSON.parse(strFromU8(unzipSync(new Uint8Array(fixture))["Metadata/project_settings.config"]));
  Object.assign(project, {
    printer_model: "Bambu Lab A1",
    printer_settings_id: "Bambu Lab A1 0.4 nozzle",
    filament_settings_id: ["Bambu PETG Basic @BBL A1"],
    filament_type: ["PETG"],
    nozzle_temperature: ["255"],
  });
  const { PROFILES, MATERIALS, materialInForce, materialPresetFor } = await loadAppModule("printer-profiles");
  const a1 = PROFILES["bbl-a1-04"];
  // The map the PLA preset load built, then the project settings on top of it,
  // as the engine writes them after the import.
  const preset = { filament_settings_id: [materialPresetFor(a1, "pla")], filament_type: ["PLA"], nozzle_temperature: [220] };
  const sliced = { ...preset, ...project };
  const shown = materialInForce(a1, sliced, "pla");
  assert.equal(shown.id, "petg", "the row selects PETG Basic");
  assert.notEqual(shown.id, "pla", "never «PLA Basic» over a PETG print");
  assert.equal(MATERIALS[shown.id].label, "PETG Basic");
  assert.equal(shown.label, "PETG Basic");
  assert.equal(shown.type, "PETG", "the sheet header says PETG");
  // The preset the selector loaded still reads as itself.
  assert.deepEqual(materialInForce(a1, preset, "pla"), { id: "pla", name: "Bambu PLA Basic @BBL A1", label: "PLA Basic", type: "PLA" });
  // A filament the printer does not list (a generic one, PLA Matte, or PETG
  // on the P1P, which ships no PETG Basic) reads as its own short name, never
  // as a listed one.
  const generic = materialInForce(a1, { ...preset, filament_settings_id: ["Generic PETG @BBL A1"], filament_type: ["PETG"] }, "pla");
  assert.deepEqual(generic, { id: null, name: "Generic PETG @BBL A1", label: "Generic PETG", type: "PETG" });
  assert.equal(materialInForce(a1, { filament_settings_id: ["Bambu PLA Matte @BBL A1"], filament_type: ["PLA"] }, "pla").label, "PLA Matte");
  assert.equal(materialInForce(PROFILES["bbl-p1p-04"], { filament_settings_id: ["Bambu PETG Basic @BBL X1C"], filament_type: ["PETG"] }, "pla").id, null);
  // Before the first preset load there is no filament: the selector stands.
  assert.equal(materialInForce(a1, {}, "petg").id, "petg");

  const [card, client] = await Promise.all([read("../app/components/mobile/print-settings-card.tsx"), read("../app/slicer-client.tsx")]);
  // The row's value is T1, and a filament it does not list is a disabled
  // «<name> (مخصص)» option in all three languages (t.customValue), as the
  // layer and infill rows already do.
  assert.match(card, /const materialShown = props\.materialInForce\.id;/);
  assert.match(card, /value=\{materialShown \?\? CUSTOM\}/);
  assert.match(card, /\{materialShown === null && <option value=\{CUSTOM\} disabled>\{templateText\(t\.customValue, \{ value: props\.materialInForce\.label \}\)\}<\/option>\}/);
  assert.doesNotMatch(card, /value=\{props\.material\}/, "the selector is not what the row shows");
  assert.match(client, /const t1Material = useMemo\(\(\) => materialInForce\(profile, settings, material\), \[material, profile, settings\]\);/);
  assert.match(client, /materialInForce=\{t1Material\}/);
  assert.match(client, /\{profile\.shortName\} · \{profile\.nozzle\.toFixed\(1\)\} mm · \{t1Material\.type \|\| MATERIALS\[material\]\.type\}/);
  // Picking the material the selector already holds while T1 holds another
  // one takes T1 back: the reload is carried as a material change.
  assert.match(client, /onMaterial=\{chooseMaterial\}/);
  const choose = client.slice(client.indexOf("const chooseMaterial = useCallback("), client.indexOf("}, [material]);", client.indexOf("const chooseMaterial = useCallback(")));
  assert.match(choose, /if \(id !== material\) \{\s*setMaterial\(id\);\s*return;\s*\}/);
  assert.match(choose, /materialTakeBackRef\.current = true;\s*setMaterialTakeBack\(\(value\) => value \+ 1\);/);
  assert.match(client, /previousSelection: takeBack && loadedSelectionRef\.current\s*\? \{ \.\.\.loadedSelectionRef\.current, material: "t1-from-file" \}\s*: loadedSelectionRef\.current,/);
  assert.match(client, /\}, \[infill, material, materialTakeBack, profile, quality, requestedPresetKey, strength, support\]\);/);

  // And that carry really gives T1 back to the preset.
  const { carryUserEdits } = await loadAppModule("settings-carryover");
  const selection = { printerId: "bbl-a1-04", quality: "standard", strength: "standard", support: false, infill: "grid", material: "pla" };
  const loadedPla = { ...preset, layer_height: 0.2 };
  const carried = carryUserEdits({
    loaded: loadedPla,
    previous: sliced,
    editedKeys: new Set(),
    previousSelection: { ...selection, material: "t1-from-file" },
    nextSelection: selection,
    processKeys: [],
    filamentKeys: ["filament_settings_id", "filament_type", "nozzle_temperature"],
    previousFilamentKeys: ["filament_settings_id", "filament_type", "nozzle_temperature"],
    engineKeys: new Set(["filament_settings_id", "filament_type", "nozzle_temperature"]),
  });
  assert.equal(materialInForce(a1, carried.settings, "pla").id, "pla", "after the take-back the row and the G-code agree on PLA");
  assert.deepEqual(carried.settings.nozzle_temperature, [220]);
});

test("the sheets are modal: the page behind is inert, Tab wraps, and focus returns to the opener", async () => {
  // c6-r3-ha-04: Tab left the «المزيد» sheet 26 times in 60, and Escape put
  // focus on <body>.
  const client = await read("../app/slicer-client.tsx");
  const effect = client.slice(client.indexOf("const sheetOpenerRef = useRef"), client.indexOf("}, [sheetOpen]);"));
  assert.ok(effect.length > 200, "the modal effect is findable");
  assert.match(effect, /sheetOpenerRef\.current = active instanceof HTMLElement && active !== document\.body \? active : null;/, "the opener is remembered when a sheet opens");
  assert.match(effect, /sheetRef\.current\?\.closest<HTMLElement>\("\.sheet-backdrop"\)/);
  assert.match(effect, /if \(child !== backdrop\) \(child as HTMLElement\)\.inert = true;/, "every sibling of the backdrop goes inert");
  assert.match(effect, /new MutationObserver\(hide\)/, "including one that renders while the sheet is open");
  assert.match(effect, /for \(const child of page\.children\) \(child as HTMLElement\)\.inert = false;/, "nothing stays inert after it closes");
  assert.match(effect, /opener\?\.isConnected && !opener\.closest\("\[inert\]"\)\) opener\.focus\(/, "focus goes back to the opener");
  // It runs before the effect that moves focus into the sheet, so the opener
  // is still the focused element when it is read.
  assert.ok(client.indexOf("}, [sheetOpen]);") < client.indexOf("sheetRef.current?.focus();"), "the opener is read before focus moves into the sheet");
  // Tab and Shift+Tab wrap at the two ends of the sheet.
  const keys = client.slice(client.indexOf("sheetRef.current?.focus();"), client.indexOf("}, [sheet]);", client.indexOf("sheetRef.current?.focus();")));
  assert.match(keys, /if \(event\.key !== "Tab"\) return;/);
  assert.match(keys, /dialog\.querySelectorAll<HTMLElement>\(SHEET_TABBABLE\)/);
  assert.match(keys, /event\.preventDefault\(\);\s*last\.focus\(\);/);
  assert.match(keys, /event\.preventDefault\(\);\s*first\.focus\(\);/);
  assert.match(client, /<div className="sheet-backdrop"[\s\S]{0,200}?<section\s+ref=\{sheetRef\}/, "the sheet is the child of the backdrop");
});
