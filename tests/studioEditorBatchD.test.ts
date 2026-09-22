/**
 * LEVO STUDIO, THE OWNER'S SIX ITEMS (batch D, 9–13).
 *
 * «9- لاستوديو ليفو السلايسر خلي الشخص يختار طابعته اول ما يدخل، لان حاليا من
 *     دخلت اختارلي x2d مباشرة … و تظيف قائمة اسفل قائمة "القوة" بيها انواع الحشو.
 *  10- اضافة زر تقصير وتطويل قائمة الادوات … رؤية ما خلف القائمة.
 *  11- عند اضافة سرير طباعة جديد يبقيني على السرير الاول بدل ان ينقلني للسرير
 *      الذي انشأته (كما في بامبو سلايسر).
 *  12- عندما اضغط على زر الاعدادات قائمه اختار الملف تصير امام الاعدادات.
 *  13- توضيح بالحد الاقصى لرفع الملف واضافه انتظار لتحميل الملف للاستوديو
 *      وكذلك توضيح بان هذا ليس تطبيق وانما موقع الإمكانيات محدوده.»
 *
 * The strongest assertion here is the FIRST one, and it is not about the UI at
 * all: it reads the engine's own kernel source and proves that every pattern
 * this menu offers is one the kernel can actually fill with. The engine's
 * TypeScript declarations accept `cubic` and `lightning`; the kernel silently
 * rewrites both to `rectilinear`. A menu whose three choices printed the same
 * thing would typecheck, build, deploy and lie, and nothing else in this repo
 * would have caught it.
 *
 * Everything else is pinned at the source, because these are shell behaviours
 * inside a component that needs a WebGL canvas and a WASM slicer to mount.
 * studio/tests/ carries the live-module half (npm --prefix studio test).
 *
 * Run: node scripts/test-all.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PROFILES_TS = read('studio/app/printer-profiles.ts');
const LOADER_TS = read('studio/app/profile-loader.ts');
const CLIENT_TSX = read('studio/app/slicer-client.tsx');
const SETUP_TSX = read('studio/app/components/sheets/setup.tsx');
const CHOOSER_TSX = read('studio/app/components/sheets/printer-choice.tsx');
const GLOBALS_CSS = read('studio/app/globals.css');
const THEME_TS = read('studio/app/editor-theme.ts');
const CARRYOVER_TS = read('studio/app/settings-carryover.ts');

/** Block and line comments removed, so prose can never satisfy a match. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

// =========================================================================
// 9b — THE INFILL MENU OFFERS ONLY PATTERNS THE KERNEL CAN PRINT
// =========================================================================

/** The kernel's own list, parsed out of the installed engine build. */
function kernelPatterns(): string[] {
  const engine = read('studio/node_modules/three-slicer/engine/src/settings.js');
  const declaration = /const\s+KERNEL_PATTERNS\s*=\s*\[([\s\S]*?)\]/.exec(engine);
  assert.ok(declaration, 'the engine no longer declares KERNEL_PATTERNS — re-read settings.js before trusting this menu');
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The three patterns the Studio offers, read from the catalogue. */
function offeredPatterns(): string[] {
  const table = /export const INFILL = \{([\s\S]*?)\} as const/.exec(PROFILES_TS);
  assert.ok(table, 'INFILL is no longer a literal table — this test can no longer read what is offered');
  return [...table[1].matchAll(/pattern:\s*"([^"]+)"/g)].map((m) => m[1]);
}

test('every infill pattern offered is one the engine kernel actually fills with', () => {
  const supported = kernelPatterns();
  const offered = offeredPatterns();
  assert.equal(offered.length, 3, 'the owner asked for exactly three: «تختار ثلاث انفلات»');
  for (const pattern of offered) {
    assert.ok(
      supported.includes(pattern),
      `"${pattern}" is not in KERNEL_PATTERNS — settings.js rewrites it to rectilinear in silence, so this menu entry would print the same as every other`,
    );
  }
  assert.equal(new Set(offered).size, 3, 'two tiers pointing at one pattern is three buttons with two outcomes');
});

test('cubic and lightning are not offered — the schema accepts them, the kernel does not', () => {
  const supported = kernelPatterns();
  for (const absent of ['cubic', 'lightning']) {
    assert.ok(!supported.includes(absent), `${absent} is now in KERNEL_PATTERNS — it can be offered, and the note in printer-profiles.ts needs correcting`);
    assert.ok(!offeredPatterns().includes(absent), `${absent} is offered but the kernel cannot print it`);
  }
  // The engine's own .d.ts is what makes this trap quiet: it accepts both.
  const declared = read('studio/node_modules/three-slicer/types/settings-keys.d.ts');
  assert.match(declared, /sparse_infill_pattern\?:[^\n]*'cubic'/, 'the schema union no longer lists cubic — the warning in printer-profiles.ts is stale');
});

test('the chosen pattern reaches the engine settings map', () => {
  assert.match(code(LOADER_TS), /sparse_infill_pattern:\s*INFILL\[infill\]\.pattern/);
  assert.match(code(LOADER_TS), /infill:\s*InfillId/, 'loadPrinterProfile must take the tier, not assume one');
});

test('the infill tier owns its own key and takes nothing else back', () => {
  const body = code(CARRYOVER_TS);
  assert.match(body, /INFILL_KEYS[^=]*=\s*\["sparse_infill_pattern"\]/);
  assert.match(body, /previousSelection\.infill !== nextSelection\.infill/);
  // Strength must not claim the pattern, or changing the amount would reset
  // the shape the person picked.
  const strengthKeys = /STRENGTH_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(body);
  assert.ok(strengthKeys);
  assert.ok(!strengthKeys[1].includes('sparse_infill_pattern'));
});

test('the infill control sits under Strength in the setup sheet', () => {
  const body = SETUP_TSX;
  const strengthAt = body.indexOf('{t.strength}');
  const infillAt = body.indexOf('{t.infillPattern}');
  assert.ok(strengthAt > 0 && infillAt > 0, 'both legends must be present');
  assert.ok(infillAt > strengthAt, '«تظيف قائمة اسفل قائمة "القوة"» — under it, not above it');
  assert.match(code(body), /onInfill\(id\)/, 'the buttons must actually change the tier');
});

// =========================================================================
// 9a — THE PRINTER IS ASKED FOR, NOT ASSUMED
// =========================================================================

test('the first-run chooser opens only when nothing was ever answered', () => {
  const body = code(CLIENT_TSX);
  assert.match(body, /const stored = readStoredProfileId\(\);/);
  assert.match(body, /if \(printerChoiceAnswered\(\)\) return;/);
  assert.match(body, /setPrinterAsk\(true\);\s*setSheet\("printer"\);/);
});

test('the chooser arrives with nothing selected', () => {
  const body = code(CHOOSER_TSX);
  // A card is active only against the DRAFT — what the person tapped — never
  // against a current profile. That is the whole fix for «اختارلي x2d مباشرة».
  assert.ok(!/profileId/.test(body), 'the chooser must not receive a current printer at all');
  assert.match(body, /draft === id \? "active" : ""/);
  assert.match(body, /disabled=\{!draft\}/, 'the confirm must be unpressable until a real choice exists');
  // No re-sorting: the grid must not move under a finger mid-read.
  assert.ok(!/\.sort\(/.test(body), 'the first-run grid must keep declaration order');
});

test('every path that sets a printer goes through chooseProfile', () => {
  const body = code(CLIENT_TSX);
  const setters = [...body.matchAll(/setProfileId\(/g)];
  // Exactly two: the useState declaration, and the one inside chooseProfile,
  // plus the restore of an already-stored choice. Anything else is a printer
  // taking effect without being remembered.
  const chooseProfile = /const chooseProfile = useCallback\(\(id: ProfileId\) => \{([\s\S]*?)\}, \[\]\);/.exec(body);
  assert.ok(chooseProfile, 'chooseProfile must exist');
  assert.match(chooseProfile[1], /setProfileId\(id\);/);
  assert.match(chooseProfile[1], /storeProfileId\(id\);/);
  assert.match(chooseProfile[1], /setPrinterAsk\(false\);/);
  assert.ok(setters.length <= 3, `setProfileId is called ${setters.length} times — every caller outside chooseProfile is a printer that is not remembered`);
  assert.match(body, /onProfile=\{chooseProfile\}/, 'the Setup sheet must remember the change too');
  assert.match(body, /chooseProfile\(restoredProfile\);/, 'opening a project names a printer');
});

test('closing the chooser answers the question instead of repeating it forever', () => {
  const body = code(CLIENT_TSX);
  assert.match(body, /if \(!printerAsk \|\| sheet === "printer"\) return;\s*storePrinterChoiceDeclined\(\);/);
  // And a decline is never mistaken for a pick.
  assert.match(code(PROFILES_TS), /return stored && isProfileId\(stored\) \? stored : null;/);
});

// =========================================================================
// 10 — THE TOOL TRAY SHORTENS SO THE BED SHOWS
// =========================================================================

test('the tray carries a shrink/grow control that keeps every tool reachable', () => {
  const body = code(CLIENT_TSX);
  assert.match(body, /data-levo-action="tray-height"/);
  assert.match(body, /setTrayCompact\(\(value\) => !value\)/);
  assert.match(body, /aria-label=\{trayCompact \? t\.expand : t\.collapse\}/);
  assert.match(body, /className=\{`mobile-tooltray\$\{trayCompact \? " compact" : ""\}`\}/);
});

test('shrinking changes the height and hides nothing', () => {
  assert.match(GLOBALS_CSS, /\.mobile-tooltray\.compact \{ max-height: min\(28dvh, 190px\); \}/);
  // The tray must still scroll at the smaller height, or shortening it WOULD
  // hide tools.
  assert.match(GLOBALS_CSS, /\.mobile-tooltray \{[^}]*overflow-y: auto;/s);
  // And the control that grows it back must stay on screen.
  assert.match(GLOBALS_CSS, /\.mobile-tooltray > header \{ position: sticky;/);
  assert.ok(
    !/\.mobile-tooltray\.compact[^{]*\{[^}]*display:\s*none/.test(GLOBALS_CSS),
    'compact must never remove a group — the owner asked for a shorter list, not a smaller one',
  );
});

// =========================================================================
// 11 — A NEW PLATE BECOMES THE ACTIVE PLATE
// =========================================================================

test('adding a plate moves the camera to it, from either add control', () => {
  const body = code(CLIENT_TSX);
  assert.match(body, /const before = plateCountRef\.current;/);
  assert.match(body, /if \(before > 0 && event\.value === before \+ 1\) adapter\.selectPlate\(event\.value - 1\);/);
  // Reacting to the count, not to our own button: on a desktop the engine's
  // own `+` in the plate bar is the only add control there is.
  const trayAdd = /clickControl\("plate-add"\);[^\n]*/.exec(body);
  assert.ok(trayAdd, 'the tray still has its own add-plate button');
  assert.ok(!/selectPlate/.test(trayAdd[0]), 'the follow must not be bolted onto one of the two buttons');
});

// =========================================================================
// 12 — THE FILES CARD NO LONGER COVERS THE SETTINGS PANEL
// =========================================================================

test('the settings panel outranks the empty-bed card and the tool tray', () => {
  const sidebar = /\.sidebar \{ position: absolute; z-index: (\d+);/.exec(THEME_TS);
  assert.ok(sidebar, 'the mobile sidebar rule moved — re-check the stacking order');
  const panelZ = Number(sidebar[1]);
  const cardZ = Number(/\.empty-upload-card \{[^}]*z-index: (\d+);/s.exec(GLOBALS_CSS)![1]);
  const trayZ = Number(/\.mobile-tooltray \{[^}]*z-index: (\d+);/s.exec(GLOBALS_CSS)![1]);
  const progressZ = Number(/\.import-progress \{[^}]*z-index: (\d+);/s.exec(GLOBALS_CSS)![1]);
  assert.ok(panelZ > cardZ, `settings (${panelZ}) must sit above the empty-bed Files card (${cardZ})`);
  assert.ok(panelZ > trayZ, `settings (${panelZ}) must sit above the tool tray (${trayZ})`);
  assert.ok(panelZ < progressZ, `the import row (${progressZ}) must stay above settings (${panelZ}) — it is the only sign a file is loading`);
});

// =========================================================================
// 13 — THE LIMITS ARE STATED, THE WAIT IS SHOWN, THE APP IS NOT CLAIMED
// =========================================================================

test('the file limit states the real ceilings instead of denying they exist', () => {
  const en = read('studio/app/i18n/en.ts');
  const limit = /fileLimit: "([^"]+)"/.exec(en)![1];
  assert.match(limit, /500 MB/, 'MODEL_FILE_BYTES_CEILING refuses a model above 500 MB at selection');
  assert.match(limit, /64 MB/, 'the worker holds a saved project to 64 MiB per file');
  assert.match(limit, /200 MB/, 'and to 200 MiB per account');
  assert.ok(!/no fixed/i.test(limit), 'the old copy promised no cap, which was false in three places at once');
});

test('the import row stays up until the engine really has the model', () => {
  const body = code(CLIENT_TSX);
  // Started after the import call resolves — which is when dispatchFiles has
  // fired the change event, NOT when the mesh is built.
  assert.match(body, /beginImportWait\(objects\.length, textRef\.current\.importBuilding\);/);
  // The orchestrator's own "done" must not clear a row we are still holding.
  assert.match(body, /if \(!progress\) \{ if \(!importWaitRef\.current\) setImportProgress\(null\); return; \}/);
  // Ended by the objects event, and by a ceiling so it can never stick.
  assert.match(body, /if \(importWaitRef\.current && event\.value\.length > importWaitRef\.current\.baselineObjects\) endImportWait\(\);/);
  assert.match(body, /IMPORT_WAIT_CEILING_MS/);
});

test('no percentage is printed for a stretch that has no percentage', () => {
  const body = code(CLIENT_TSX);
  assert.match(body, /\{!importProgress\.indeterminate && \(/, 'the percent must be withheld, not invented');
  assert.match(body, /importProgress\.indeterminate\s*\?\s*<progress max="1" \/>/);
});

test('every locale says plainly that this is a website and an app is coming', () => {
  for (const locale of ['en', 'ar', 'ckb'] as const) {
    const source = read(`studio/app/i18n/${locale}.ts`);
    const notice = /webLimitsNotice: "([^"]+)"/.exec(source);
    assert.ok(notice, `${locale} is missing webLimitsNotice`);
    assert.ok(notice[1].length > 40, `${locale}'s notice is too short to say anything`);
    assert.match(notice[1], /LEVONIS/, `${locale} must name the app that is coming`);
  }
  // And it is where a first-time user meets it, not only in a status sheet.
  assert.match(CHOOSER_TSX, /\{t\.webLimitsNotice\}/);
  assert.match(SETUP_TSX, /\{t\.webLimitsNotice\}/);
});

test('the three dictionaries stay key-for-key identical', () => {
  const keysOf = (locale: string) => {
    const source = code(read(`studio/app/i18n/${locale}.ts`));
    return new Set([...source.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s/gm)].map((m) => m[1]));
  };
  const en = keysOf('en');
  for (const locale of ['ar', 'ckb']) {
    const other = keysOf(locale);
    const missing = [...en].filter((key) => !other.has(key));
    assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(', ')}`);
  }
  for (const key of ['infillPattern', 'infillLight', 'infillBalanced', 'infillStrong', 'choosePrinter', 'webLimitsNotice', 'collapse', 'expand', 'importBuilding']) {
    assert.ok(en.has(key), `en is missing the new key ${key}`);
  }
});
