/**
 * THE ENGINE'S OWN SENTENCES, IN THE PERSON'S LANGUAGE (c6-r4-ha-04).
 *
 * The vendored engine reports in English: "Imported this project's 8
 * settings and 1 plates.", "Select an object to duplicate first", "Memory
 * pressure — finished in economy mode (no preview, G-code can still be
 * downloaded)". The shell passed those strings straight into its message
 * row, so an Arabic or Sorani reader got English sentences under an Arabic
 * or Sorani interface (docs/DECISIONS.md row 183: every user-facing string
 * exists in ar, en and ckb).
 *
 * Every sentence the engine can send through its error and notice setters is
 * listed below (they were read out of three-slicer/viewer, the build the
 * Studio ships) and mapped to a key of the Studio dictionary, with its
 * numbers and names carried over. A sentence that is not listed (a kernel
 * message, a resin-only path, a newer engine) is never shown raw in Arabic or
 * Sorani: it falls back to a generic line in that language, and only English
 * keeps the engine's own words, which are already English.
 *
 * Pure and dependency-free apart from the dictionary helper, so
 * tests/phone-shell.test.mjs runs every rule.
 */

// The index file by name, so the plain Node tests can load this module too.
import { templateText, type Locale, type StudioDictionary } from "./i18n/index";

export type EngineMessageKind = "notice" | "error";

type Key = keyof StudioDictionary;
type Values = Record<string, string | number>;

interface Rule {
  pattern: RegExp;
  key: Key;
  values?: (match: RegExpExecArray) => Values;
}

const count = (index: number) => (match: RegExpExecArray): Values => ({ count: Number(match[index]) });

/** One rule per engine sentence; the first that matches wins. */
export const ENGINE_MESSAGE_RULES: readonly Rule[] = [
  // Editing the selection.
  { pattern: /^Select an object to duplicate first$/, key: "engineSelectToDuplicate" },
  { pattern: /^Select an object to copy first$/, key: "engineSelectToCopy" },
  { pattern: /^Select an object to delete first$/, key: "engineSelectToDelete" },
  { pattern: /^Select an object to split first$/, key: "engineSelectToSplit" },
  { pattern: /^Nothing selected — click an object first$/, key: "engineNothingSelected" },
  { pattern: /^Nothing to export — load a model first$/, key: "engineNothingToExport" },
  { pattern: /^Upload an STL first$/, key: "engineLoadModelFirst" },
  { pattern: /^Object copied \(paste with Ctrl\+V\)$/, key: "engineCopied" },
  { pattern: /^Deleted all (\d+) object\(s\)$/, key: "engineDeletedAll", values: count(1) },
  { pattern: /^Split into (\d+) objects$/, key: "engineSplitDone", values: count(1) },
  { pattern: /^No separate parts to split — this is a single connected mesh$/, key: "engineSplitSingle" },
  { pattern: /^Split failed: /, key: "engineSplitFailed" },

  // Slicing.
  { pattern: /^Memory pressure — finished in economy mode/, key: "engineEconomy" },
  { pattern: /^Memory pressure — some plates finished in economy mode/, key: "engineEconomySomePlates" },
  { pattern: /^Arachne wall generation failed/, key: "engineClassicWalls" },
  { pattern: /^Support generation failed \([\s\S]*\) — the slice contains the model only$/, key: "engineSupportFailed" },
  { pattern: /^Slice canceled$/, key: "engineSliceCanceled" },
  { pattern: /^Plate (\d+) has no objects$/, key: "enginePlateEmpty", values: (match) => ({ plate: match[1] }) },
  { pattern: /^All plates failed to slice/, key: "engineAllPlatesFailed" },
  {
    pattern: /^Plate ([\d, ]+) failed — the (\d+) finished result\(s\) are kept/,
    key: "enginePlatesFailed",
    values: (match) => ({ plates: match[1].trim(), kept: Number(match[2]) }),
  },
  { pattern: /^Slice failed/, key: "engineSliceFailed" },
  { pattern: /^Worker (?:terminated|message error)/, key: "engineWorkerStopped" },

  // Saving and exporting.
  { pattern: /^Saved (\d+) (?:selected )?object\(s\) as a 3mf project/, key: "engineSaved3mf", values: count(1) },
  { pattern: /^Exported (\d+) (?:selected )?object\(s\) as STL/, key: "engineExportedStl", values: count(1) },
  { pattern: /^Export failed: /, key: "engineExportFailed" },
  { pattern: /^Every sliced plate extends beyond the bed — nothing exported$/, key: "engineExportAllOverBed" },
  { pattern: /^No slice results to export — slice first$/, key: "engineNothingSliced" },

  // Files.
  { pattern: /^Failed to (?:load|import) ([\s\S]+?): /, key: "engineFileFailed", values: (match) => ({ name: match[1] }) },
  { pattern: /^Supported formats: /, key: "importFailed" },
  { pattern: /^(?:No printable moves found in the G-code|G-code parse failed: )/, key: "engineGcodeUnreadable" },

  // Painting.
  { pattern: /^Only T1 was painted\./, key: "enginePaintOnlyT1" },
  { pattern: /^Support is on and T2 is painted\./, key: "enginePaintSupportT2" },
  { pattern: /^The model changed, so the painted regions were reset/, key: "enginePaintReset" },
  { pattern: /^This project paints both material and support\./, key: "enginePaintBothImported" },

  // Preset files (the engine's own panels, in Advanced).
  { pattern: /^Saved "([\s\S]+)" as (?:an OrcaSlicer machine preset|a printer bundle)/, key: "enginePresetSaved", values: (match) => ({ name: match[1] }) },
  { pattern: /^Could not save the printer preset: /, key: "enginePresetSaveFailed" },
  { pattern: /^(?:Could not read that preset file: |No presets found in that file$)/, key: "enginePresetFileUnreadable" },
  { pattern: /^Loaded ([^—]+?)(?: — \d+ warning\(s\): [\s\S]*)?$/, key: "enginePresetsLoaded", values: (match) => ({ names: match[1].trim() }) },
];

/** "Imported this project's 8 settings and 1 plates." with what it left out. */
const IMPORT_SUMMARY = /^Imported this project's ([\s\S]+?)\.(?: Not supported by this slicer, so left out: ([\s\S]+)\.)?$/;

const LEFT_OUT: ReadonlyArray<{ pattern: RegExp; key: Key; values?: (match: RegExpExecArray) => Values }> = [
  { pattern: /^seam painting$/, key: "engineSkipSeam" },
  { pattern: /^fuzzy-skin painting$/, key: "engineSkipFuzzy" },
  { pattern: /^variable layer height$/, key: "engineSkipVariableLayer" },
  { pattern: /^per-layer custom G-code$/, key: "engineSkipLayerGcode" },
  { pattern: /^per-object setting overrides$/, key: "engineSkipObjectOverrides" },
  { pattern: /^(\d+) object\(s\) on plates past this viewer's limit$/, key: "engineSkipPlatesPastLimit", values: count(1) },
];

/** The list comma of the language: «، » in Arabic and Sorani. */
const listSeparator = (locale: Locale) => (locale === "en" ? ", " : "، ");

function importSummary(match: RegExpExecArray, t: StudioDictionary, locale: Locale): string {
  const separator = listSeparator(locale);
  const parts = match[1].split(" and ").map((part) => {
    const counted = /^(\d+) (settings|filaments|plates)$/.exec(part.trim());
    if (!counted) return t.engineImportedGeometry;
    const key: Key = counted[2] === "settings" ? "engineImportedSettings" : counted[2] === "filaments" ? "engineImportedFilaments" : "engineImportedPlates";
    return templateText(t[key], { count: Number(counted[1]) }, locale);
  });
  let text = templateText(t.engineImportedProject, { parts: parts.join(separator) }, locale);
  if (match[2]) {
    const items: string[] = [];
    for (const raw of match[2].split(", ")) {
      const rule = LEFT_OUT.map((entry) => ({ entry, found: entry.pattern.exec(raw.trim()) })).find((candidate) => candidate.found);
      const item = rule?.found ? templateText(t[rule.entry.key], rule.entry.values?.(rule.found) ?? {}, locale) : t.engineSkipOther;
      if (!items.includes(item)) items.push(item);
    }
    text += ` ${templateText(t.engineImportLeftOut, { items: items.join(separator) }, locale)}`;
  }
  return text;
}

/** "Exported 3 plate(s)", with " — skipped 1 that extend beyond the bed" when some were. */
const PLATES_EXPORTED = /^Exported (\d+) plate\(s\)(?: — skipped (\d+) that extend beyond the bed)?$/;

function platesExported(match: RegExpExecArray, t: StudioDictionary, locale: Locale): string {
  const text = templateText(t.engineExportedPlates, { count: Number(match[1]) }, locale);
  return match[2] ? `${text} ${templateText(t.engineExportSkippedPlates, { count: Number(match[2]) }, locale)}` : text;
}

/** The dictionary key a sentence maps to, or null when the engine sentence is not listed. */
export function engineMessageKey(raw: string): Key | null {
  const text = raw.trim();
  if (IMPORT_SUMMARY.test(text)) return "engineImportedProject";
  if (PLATES_EXPORTED.test(text)) return "engineExportedPlates";
  return ENGINE_MESSAGE_RULES.find((rule) => rule.pattern.test(text))?.key ?? null;
}

/**
 * The sentence the message row shows for an engine notice or error. An empty
 * value stays empty: that is the engine clearing its own message.
 */
export function localizeEngineMessage(raw: string, kind: EngineMessageKind, t: StudioDictionary, locale: Locale): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const summary = IMPORT_SUMMARY.exec(text);
  if (summary) return importSummary(summary, t, locale);
  const plates = PLATES_EXPORTED.exec(text);
  if (plates) return platesExported(plates, t, locale);
  for (const rule of ENGINE_MESSAGE_RULES) {
    const match = rule.pattern.exec(text);
    if (match) return templateText(t[rule.key], rule.values?.(match) ?? {}, locale);
  }
  if (locale === "en") return text;
  return kind === "error" ? t.engineErrorGeneric : t.engineNoticeGeneric;
}
