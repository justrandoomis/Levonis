/**
 * Printer profile catalogue for LEVO Studio.
 *
 * Extracted from the slicer-client monolith (S4 editor-core). This module is
 * data only: the honest mapping between a printer the UI offers and the
 * three-slicer/Orca preset names the engine is asked to load. Whether a preset
 * actually exists inside the installed engine build is decided at load time by
 * `profile-loader.ts`, which reports missing presets explicitly instead of
 * silently falling back — a profile listed here is a *request*, not a claim
 * that the engine ships it.
 *
 * `settingId` is a display label only (it is shown in the printer grid); it has
 * no effect on slicing and must never be presented as a verification state.
 */

export type QualityId = "fine" | "standard" | "draft";
export type StrengthId = "light" | "standard" | "strong";
export type InfillId = "light" | "balanced" | "strong";

export interface PrinterProfile {
  id: string;
  shortName: string;
  model: string;
  /** three-slicer machine preset name requested from the engine. */
  presetName: string;
  /** Display label only — cosmetic, not a verification state. */
  settingId: string;
  nozzle: number;
  /** Human-readable bed description (display only). */
  bed: string;
  bedWidth: number;
  bedDepth: number;
  bedHeight: number;
  /** three-slicer filament preset name requested from the engine. */
  materialPreset: string;
  /** three-slicer process preset name per quality tier. */
  processPresets: Record<QualityId, string>;
}

export const QUALITY: Record<QualityId, { label: string; layer: number }> = {
  fine: { label: "Fine", layer: 0.12 },
  standard: { label: "Standard", layer: 0.2 },
  draft: { label: "Draft", layer: 0.24 },
};

export const STRENGTH: Record<StrengthId, { label: string; infill: number; walls: number }> = {
  light: { label: "Light", infill: 10, walls: 2 },
  standard: { label: "Standard", infill: 15, walls: 2 },
  strong: { label: "Strong", infill: 25, walls: 3 },
};

/**
 * THE INFILL PATTERN, AS THREE CHOICES THE ENGINE CAN ACTUALLY PRINT.
 *
 * «تظيف قائمة اسفل قائمة "القوة" بيها انواع الحشو، وتخلي اشهر ثلاث مثل gyroid
 *  Cubic Lightning او غيرها ... كل واحد يغطي هدف من الثلاث "خفيف - متوسط - قوي".»
 *
 * Two of the three names the owner reached for do not survive this engine —
 * and, worse, they LOOK supported. `types/settings-keys.d.ts` lists both
 * `cubic` and `lightning` in the schema union, so TypeScript accepts either
 * one without a murmur. The kernel is where the truth is:
 * `engine/src/settings.js` declares the patterns it can actually fill with:
 *
 *   rectilinear, grid, triangles, zigzag, gyroid, gyroid_approx,
 *   honeycomb, 3dhoneycomb, crosshatch, concentric
 *
 * and anything outside that list is rewritten to `rectilinear` WITHOUT a word
 * to the user. So offering "Cubic" and "Lightning" would have shipped a menu
 * whose two outer choices quietly printed the same plain zig-zag as each
 * other — a UI that lies about what the machine is doing, which is the one
 * thing this codebase does not do.
 *
 * These three are real, and they are genuinely the light / balanced / strong
 * ends of what the kernel offers:
 *
 *   zigzag       one continuous back-and-forth line per layer. The least
 *                material and the least travel of anything here, and the
 *                weakest — the honest "light and fast".
 *   gyroid       the TPMS surface. Equal strength in every direction and no
 *                self-crossing, which is why it is the modern default. The
 *                owner named this one and it is kept exactly as named.
 *   3dhoneycomb  a honeycomb that also varies with height, so the walls carry
 *                load across layers instead of only within one. The stiffest
 *                of the set, and the most material and time.
 *
 * `label` is the pattern's own technical name and stays Latin in all three
 * locales — the same precedent the Quality and Strength tiers already follow.
 * The purpose word beside it ("light and fast" and so on) IS translated; those
 * are the `infill*` keys in the dictionaries.
 */
export const INFILL = {
  light: { label: "Zigzag", pattern: "zigzag" },
  balanced: { label: "Gyroid", pattern: "gyroid" },
  strong: { label: "3D Honeycomb", pattern: "3dhoneycomb" },
} as const satisfies Record<InfillId, { label: string; pattern: string }>;

export const DEFAULT_INFILL_ID: InfillId = "balanced";

export function isInfillId(value: string): value is InfillId {
  return Object.prototype.hasOwnProperty.call(INFILL, value);
}

export const PROFILES = {
  "bbl-x2d-04": {
    id: "bbl-x2d-04",
    shortName: "X2D",
    model: "Bambu Lab X2D",
    presetName: "Bambu Lab X2D 0.4 nozzle",
    settingId: "GM045",
    nozzle: 0.4,
    bed: "256 × 256 × 260 mm",
    bedWidth: 256,
    bedDepth: 256,
    bedHeight: 260,
    materialPreset: "Bambu PLA Basic @BBL X2D 0.4 nozzle",
    processPresets: {
      fine: "0.12mm High Quality @BBL X2D",
      standard: "0.20mm Standard @BBL X2D",
      draft: "0.24mm Standard @BBL X2D",
    },
  },
  "bbl-h2d-04": {
    id: "bbl-h2d-04",
    shortName: "H2D",
    model: "Bambu Lab H2D",
    presetName: "Bambu Lab H2D 0.4 nozzle",
    settingId: "GM033",
    nozzle: 0.4,
    bed: "350 × 320 × 325 mm",
    bedWidth: 350,
    bedDepth: 320,
    bedHeight: 325,
    materialPreset: "Bambu PLA Basic @BBL H2D",
    processPresets: {
      fine: "0.12mm Fine @BBL H2D",
      standard: "0.20mm Standard @BBL H2D",
      draft: "0.24mm Standard @BBL H2D",
    },
  },
  "bbl-h2c-04": {
    id: "bbl-h2c-04", shortName: "H2C", model: "Bambu Lab H2C",
    presetName: "Bambu Lab H2C 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "330 × 320 × 325 mm", bedWidth: 330, bedDepth: 320, bedHeight: 325,
    materialPreset: "Bambu PLA Basic @BBL H2C",
    processPresets: { fine: "0.12mm High Quality @BBL H2C", standard: "0.20mm Standard @BBL H2C", draft: "0.24mm Standard @BBL H2C" },
  },
  "bbl-h2s-04": {
    id: "bbl-h2s-04", shortName: "H2S", model: "Bambu Lab H2S",
    presetName: "Bambu Lab H2S 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "340 × 320 × 340 mm", bedWidth: 340, bedDepth: 320, bedHeight: 340,
    materialPreset: "Bambu PLA Basic @BBL H2S",
    processPresets: { fine: "0.12mm High Quality @BBL H2S", standard: "0.20mm Standard @BBL H2S", draft: "0.24mm Standard @BBL H2S" },
  },
  "bbl-h2dp-04": {
    id: "bbl-h2dp-04", shortName: "H2D Pro", model: "Bambu Lab H2D Pro",
    presetName: "Bambu Lab H2D Pro 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "350 × 320 × 325 mm", bedWidth: 350, bedDepth: 320, bedHeight: 325,
    materialPreset: "Bambu PLA Basic @BBL H2DP",
    processPresets: { fine: "0.12mm Fine @BBL H2DP", standard: "0.20mm Standard @BBL H2DP", draft: "0.24mm Standard @BBL H2DP" },
  },
  "bbl-p2s-04": {
    id: "bbl-p2s-04", shortName: "P2S", model: "Bambu Lab P2S",
    presetName: "Bambu Lab P2S 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "256 × 256 × 256 mm", bedWidth: 256, bedDepth: 256, bedHeight: 256,
    materialPreset: "Bambu PLA Basic @BBL P2S",
    processPresets: { fine: "0.12mm High Quality @BBL P2S", standard: "0.20mm Standard @BBL P2S", draft: "0.24mm Standard @BBL P2S" },
  },
  "bbl-p1s-04": {
    id: "bbl-p1s-04", shortName: "P1S", model: "Bambu Lab P1S",
    presetName: "Bambu Lab P1S 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "256 × 256 × 250 mm", bedWidth: 256, bedDepth: 256, bedHeight: 250,
    materialPreset: "Bambu PLA Basic @BBL X1C",
    processPresets: { fine: "0.12mm Fine @BBL X1C", standard: "0.20mm Standard @BBL X1C", draft: "0.24mm Draft @BBL X1C" },
  },
  "bbl-p1p-04": {
    id: "bbl-p1p-04", shortName: "P1P", model: "Bambu Lab P1P",
    presetName: "Bambu Lab P1P 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "256 × 256 × 250 mm", bedWidth: 256, bedDepth: 256, bedHeight: 250,
    materialPreset: "Bambu PLA Basic @BBL P1P",
    processPresets: { fine: "0.12mm Fine @BBL P1P", standard: "0.20mm Standard @BBL P1P", draft: "0.24mm Draft @BBL P1P" },
  },
  "bbl-x1c-04": {
    id: "bbl-x1c-04", shortName: "X1C", model: "Bambu Lab X1 Carbon",
    presetName: "Bambu Lab X1 Carbon 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "256 × 256 × 250 mm", bedWidth: 256, bedDepth: 256, bedHeight: 250,
    materialPreset: "Bambu PLA Basic @BBL X1C",
    processPresets: { fine: "0.12mm Fine @BBL X1C", standard: "0.20mm Standard @BBL X1C", draft: "0.24mm Draft @BBL X1C" },
  },
  "bbl-x1-04": {
    id: "bbl-x1-04", shortName: "X1", model: "Bambu Lab X1",
    presetName: "Bambu Lab X1 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "256 × 256 × 250 mm", bedWidth: 256, bedDepth: 256, bedHeight: 250,
    materialPreset: "Bambu PLA Basic @BBL X1",
    processPresets: { fine: "0.12mm Fine @BBL X1C", standard: "0.20mm Standard @BBL X1C", draft: "0.24mm Draft @BBL X1C" },
  },
  "bbl-x1e-04": {
    id: "bbl-x1e-04", shortName: "X1E", model: "Bambu Lab X1E",
    presetName: "Bambu Lab X1E 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "256 × 256 × 250 mm", bedWidth: 256, bedDepth: 256, bedHeight: 250,
    materialPreset: "Bambu PLA Basic @BBL X1C",
    processPresets: { fine: "0.12mm Fine @BBL X1C", standard: "0.20mm Standard @BBL X1C", draft: "0.24mm Draft @BBL X1C" },
  },
  "bbl-a1-04": {
    id: "bbl-a1-04", shortName: "A1", model: "Bambu Lab A1",
    presetName: "Bambu Lab A1 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "256 × 256 × 256 mm", bedWidth: 256, bedDepth: 256, bedHeight: 256,
    materialPreset: "Bambu PLA Basic @BBL A1",
    processPresets: { fine: "0.12mm Fine @BBL A1", standard: "0.20mm Standard @BBL A1", draft: "0.24mm Draft @BBL A1" },
  },
  "bbl-a1m-04": {
    id: "bbl-a1m-04", shortName: "A1 mini", model: "Bambu Lab A1 mini",
    presetName: "Bambu Lab A1 mini 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "180 × 180 × 180 mm", bedWidth: 180, bedDepth: 180, bedHeight: 180,
    materialPreset: "Bambu PLA Basic @BBL A1M",
    processPresets: { fine: "0.12mm Fine @BBL A1M", standard: "0.20mm Standard @BBL A1M", draft: "0.24mm Draft @BBL A1M" },
  },
  "bbl-a2l-04": {
    id: "bbl-a2l-04", shortName: "A2L", model: "Bambu Lab A2L",
    presetName: "Bambu Lab A2L 0.4 nozzle", settingId: "Orca BBL", nozzle: 0.4,
    bed: "330 × 320 × 325 mm", bedWidth: 330, bedDepth: 320, bedHeight: 325,
    materialPreset: "Bambu PLA Basic @BBL A2L 0.4 nozzle",
    processPresets: { fine: "0.12mm High Quality @BBL A2L", standard: "0.20mm Standard @BBL A2L", draft: "0.24mm Standard @BBL A2L" },
  },
} as const satisfies Record<string, PrinterProfile>;

export type ProfileId = keyof typeof PROFILES;

export const PROFILE_IDS = Object.keys(PROFILES) as ProfileId[];

export const DEFAULT_PROFILE_ID: ProfileId = "bbl-x2d-04";

export function isProfileId(value: string): value is ProfileId {
  return Object.prototype.hasOwnProperty.call(PROFILES, value);
}

/**
 * THE MATERIAL, AS ONLY THE PRESETS THE ENGINE ACTUALLY SHIPS.
 *
 * The reference screen has a «الخامة» row reading "PETG". Until now there was
 * no material choice at all: every printer loaded its PLA Basic filament
 * preset, and the sheet header said "· PLA" because that was the only truth.
 *
 * A row that offers a material must not offer one the engine cannot load, so
 * the table below lists, per printer, the filament preset that really exists
 * in the installed engine's `data/filaments.js` (tests/printer-choice.test.mjs
 * reads that file and fails if a name here is missing from it). PLA Basic is
 * each printer's existing `materialPreset`. PETG Basic is offered where the
 * engine has a Bambu PETG Basic preset for that machine or for the family the
 * profile already borrows its process presets from (the X1 and X1E use the
 * X1C's, as the P1S does for PLA). The P1P has no PETG Basic preset in this
 * engine build, so it is not offered there: the row lists PLA only.
 *
 * Should a preset still fail to load, profile-loader.ts reports it as a
 * missing preset and the readiness banner says so: never a silent fallback.
 */
export type MaterialId = "pla" | "petg";

export const MATERIALS = {
  pla: { label: "PLA Basic", type: "PLA" },
  petg: { label: "PETG Basic", type: "PETG" },
} as const satisfies Record<MaterialId, { label: string; type: string }>;

export const DEFAULT_MATERIAL_ID: MaterialId = "pla";

export function isMaterialId(value: unknown): value is MaterialId {
  return value === "pla" || value === "petg";
}

/** PETG Basic, per printer: an engine preset name, or absent when none ships. */
export const PETG_PRESETS: Partial<Record<ProfileId, string>> = {
  "bbl-x2d-04": "Bambu PETG Basic @BBL X2D 0.4 nozzle",
  "bbl-h2d-04": "Bambu PETG Basic @BBL H2D 0.4 nozzle",
  "bbl-h2c-04": "Bambu PETG Basic @BBL H2C 0.4 nozzle",
  "bbl-h2s-04": "Bambu PETG Basic @BBL H2S",
  "bbl-h2dp-04": "Bambu PETG Basic @BBL H2DP 0.4 nozzle",
  "bbl-p2s-04": "Bambu PETG Basic @BBL P2S 0.4 nozzle",
  "bbl-p1s-04": "Bambu PETG Basic @BBL X1C",
  "bbl-x1c-04": "Bambu PETG Basic @BBL X1C",
  "bbl-x1-04": "Bambu PETG Basic @BBL X1C",
  "bbl-x1e-04": "Bambu PETG Basic @BBL X1C",
  "bbl-a1-04": "Bambu PETG Basic @BBL A1",
  "bbl-a1m-04": "Bambu PETG Basic @BBL A1M 0.4 nozzle",
  "bbl-a2l-04": "Bambu PETG Basic @BBL A2L 0.4 nozzle",
};

/** The filament preset a printer loads for a material, or null when none ships. */
export function materialPresetFor(profile: PrinterProfile, material: MaterialId): string | null {
  if (material === "pla") return profile.materialPreset;
  return isProfileId(profile.id) ? PETG_PRESETS[profile.id] ?? null : null;
}

/** The materials a printer can really load, in display order. */
export function materialsFor(profileId: ProfileId): MaterialId[] {
  return (Object.keys(MATERIALS) as MaterialId[]).filter((id) => materialPresetFor(PROFILES[profileId], id) !== null);
}

/** A material the printer can load: the one asked for, or PLA when it has none. */
export function availableMaterial(profileId: ProfileId, material: MaterialId): MaterialId {
  return materialsFor(profileId).includes(material) ? material : DEFAULT_MATERIAL_ID;
}

/** The filament in force for T1, as the «الخامة» row and the sheet header state it. */
export interface MaterialInForce {
  /** The listed material whose preset T1 holds, or null for any other filament. */
  id: MaterialId | null;
  /** The preset name the kernel loads for T1 (filament_settings_id[0]). */
  name: string;
  /**
   * What the row prints: the listed label, or for any other filament its name
   * without the vendor and the printer suffix («Bambu PLA Matte @BBL A1»
   * reads «PLA Matte»), so the custom mark after it fits a phone row.
   */
  label: string;
  /** Its filament type (filament_type[0]), for the sheet header. */
  type: string;
}

/** «Bambu PLA Matte @BBL A1» → «PLA Matte»: the name a row has room for. */
export function shortFilamentName(name: string): string {
  const short = name.replace(/\s*@.*$/, "").replace(/^Bambu\s+/, "").trim();
  return short || name;
}

/**
 * WHAT T1 WILL REALLY PRINT WITH, READ FROM THE MAP THE KERNEL SLICES.
 *
 * The row used to show the material SELECTOR. An imported 3MF brings its own
 * filament (a project made for PETG Basic on the A1), the engine puts it on
 * T1 and the G-code is made with it, while the row still said «PLA Basic»
 * and the sheet header «PLA». So the answer comes from
 * `filament_settings_id[0]` and `filament_type[0]`: one of the listed
 * materials when T1 holds the preset of that material for this printer,
 * otherwise the name of the filament itself (the row then says it is
 * custom, as the layer and infill rows do). A map with no filament yet
 * (before the first preset load) reads as the selector.
 */
export function materialInForce(profile: PrinterProfile, settings: unknown, selected: MaterialId): MaterialInForce {
  const record = (settings ?? {}) as Record<string, unknown>;
  const first = (value: unknown) => String((Array.isArray(value) ? value[0] : value) ?? "").trim();
  const name = first(record.filament_settings_id);
  const type = first(record.filament_type);
  if (!name) {
    return { id: selected, name: materialPresetFor(profile, selected) ?? profile.materialPreset, label: MATERIALS[selected].label, type: type || MATERIALS[selected].type };
  }
  const listed = isProfileId(profile.id) ? materialsFor(profile.id) : [];
  const id = listed.find((material) => materialPresetFor(profile, material) === name) ?? null;
  return { id, name, label: id ? MATERIALS[id].label : shortFilamentName(name), type: type || (id ? MATERIALS[id].type : "") };
}

/**
 * THE PRINTER IS ASKED FOR, NOT ASSUMED.
 *
 * «خلي الشخص يختار طابعته اول ما يدخل، لان حاليا من دخلت اختارلي x2d مباشرة.»
 *
 * DEFAULT_PROFILE_ID above is a seed for the very first render — the shell
 * needs SOME machine to size the bed with before anything is chosen — and it
 * was also, silently, the answer. A person who owns an A1 mini got an X2D's
 * bed, an X2D's presets and an X2D's printable height without being asked.
 *
 * So the choice is stored, and the absence of a stored choice is what opens
 * the first-run chooser. The value is one of two things:
 *
 *   a ProfileId   the person picked that printer.
 *   DECLINED      the person was asked and closed the sheet without picking.
 *                 The seed stays in force, but the question is not asked
 *                 again on every visit; the Setup sheet is always there.
 *
 * A printer is not a secret, so localStorage is the right place; storage
 * failures (private browsing, storage-denied) are non-fatal exactly as they
 * are for the locale, and simply mean the question is asked again.
 */
export const PRINTER_STORAGE_KEY = "levo-studio-printer";

/** Written when the chooser is dismissed without a pick. Never a ProfileId. */
const PRINTER_CHOICE_DECLINED = "-";

function readPrinterChoice(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PRINTER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The stored printer, when one was actually picked; null otherwise. */
export function readStoredProfileId(): ProfileId | null {
  const stored = readPrinterChoice();
  return stored && isProfileId(stored) ? stored : null;
}

/** True once the first-run question has been answered — by a pick OR a dismissal. */
export function printerChoiceAnswered(): boolean {
  return readPrinterChoice() !== null;
}

export function storeProfileId(id: ProfileId): void {
  writePrinterChoice(id);
}

export function storePrinterChoiceDeclined(): void {
  writePrinterChoice(PRINTER_CHOICE_DECLINED);
}

function writePrinterChoice(value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRINTER_STORAGE_KEY, value);
  } catch {
    // Storage-denied environments keep the in-memory choice for this session.
  }
}
