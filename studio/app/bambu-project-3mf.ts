/**
 * A BAMBU-STUDIO-SHAPED PROJECT .3MF, BUILT FROM THE ENGINE'S OWN OUTPUT.
 *
 * WHY THIS EXISTS
 *
 * The owner configures a project in LEVO Studio and wants a file they can
 * upload to MakerWorld. The engine (three-slicer) already writes a real 3MF —
 * geometry, plate layout, `Metadata/model_settings.config` in Bambu's own
 * grammar, and the user's settings in `Metadata/project_settings.config`. What
 * it does NOT write is the envelope that makes the package a *Bambu project*
 * rather than a bare model:
 *
 *   1. `project_settings.config` has no header, and BambuStudio decides a JSON
 *      config is project settings by reading `"name": "project_settings"`
 *      (Config.cpp `is_project_settings`). Without it the user's carefully
 *      chosen layer height, walls, infill and support settings are ignored on
 *      open — the geometry arrives, the setup does not.
 *   2. No `xmlns:BambuStudio` declaration and no `BambuStudio:3mfVersion`
 *      metadata, the two schema markers upstream writes.
 *   3. No thumbnails, so the package has nothing to preview with, and
 *      `_rels/.rels` names neither a cover nor an OPC thumbnail.
 *   4. No `Metadata/slice_info.config`.
 *
 * This module adds exactly those, by unpacking the engine's ZIP and repacking
 * it. It deliberately does NOT re-serialize the mesh: the engine's geometry
 * writer already round-trips through OrcaSlicer, and re-deriving vertex data
 * would put a second, weaker mesh serializer in the codebase for no gain.
 *
 * WHAT IT WILL NOT DO, AND WHY
 *
 * BambuStudio marks a file as its own from one string: the importer sets
 * `m_is_bbl_3mf` when `<metadata name="Application">` starts with
 * "BambuStudio-" (bbs_3mf.cpp:4234). Writing that string here would be a false
 * statement of origin — this file was produced by LEVO Studio, not by Bambu
 * Studio — made to pass someone else's origin check. So `Application` names
 * LEVO Studio truthfully, and the honest route to a Bambu-Studio-generated
 * file is the one the UI points at: open this project in Bambu Studio and save
 * it there.
 *
 * The BambuStudio namespace and `3mfVersion` marker ARE written, because those
 * describe the SCHEMA the file uses, which is true, rather than who wrote it.
 *
 * Format reference: /home/user/bambulab/bambustudio/src/libslic3r/Format/bbs_3mf.cpp
 * (`_BBS_3MF_Exporter`), read for this work. AGPL-3.0; LEVO Studio is
 * AGPL-3.0-or-later, so the derivation sits under the same licence.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

/** Archive paths, matching upstream's constants (bbs_3mf.cpp:165-175). */
export const MODEL_FILE = "3D/3dmodel.model";
export const CONTENT_TYPES_FILE = "[Content_Types].xml";
export const RELS_FILE = "_rels/.rels";
export const PROJECT_SETTINGS_FILE = "Metadata/project_settings.config";
export const MODEL_SETTINGS_FILE = "Metadata/model_settings.config";
export const SLICE_INFO_FILE = "Metadata/slice_info.config";
export const PLATE_THUMBNAIL_FILE = "Metadata/plate_1.png";
export const PLATE_THUMBNAIL_SMALL_FILE = "Metadata/plate_1_small.png";

/** The BambuStudio 3MF schema version upstream stamps (VERSION_BBS_3MF). */
export const BBS_3MF_VERSION = "1";
export const BBS_NAMESPACE = "http://schemas.bambulab.com/package/2021";

/**
 * The three header keys `Config::save_to_json` writes and
 * `ConfigBase::is_project_settings` reads back (bbs_3mf.cpp:8099,
 * Config.cpp:919). `name` is the one that decides whether the settings are
 * treated as a project's own; the other two are recorded alongside it.
 */
export const PROJECT_SETTINGS_NAME = "project_settings";
export const PROJECT_SETTINGS_FROM = "project";

export interface BambuProjectOptions {
  /** Shown as the project's Title metadata. */
  projectName: string;
  /** Honest producer string, e.g. "LEVO Studio-1.0.0". Never "BambuStudio-…". */
  application: string;
  /** Recorded as the settings' `version`. */
  version: string;
  /** ISO date for the CreationDate metadata; caller supplies it so this is pure. */
  createdAt: string;
  /** Full-size plate preview PNG. Omitted when the capture came back blank. */
  thumbnailPng?: Uint8Array | null;
  /** Small plate preview PNG. */
  thumbnailSmallPng?: Uint8Array | null;
  /** Printer model id for slice_info, e.g. "C11". Empty when unknown. */
  printerModelId?: string;
  /** Nozzle diameters, serialized as upstream does ("0.4" or "0.4,0.4"). */
  nozzleDiameters?: string;
}

export interface BambuProjectResult {
  bytes: Uint8Array;
  /** What was actually added, so the UI can report honestly. */
  added: string[];
  /** Entries that were already correct and left alone. */
  kept: string[];
  /** Honest warnings — e.g. a missing thumbnail. */
  warnings: string[];
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Matches upstream's xml_escape for the five predefined entities. */
export function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * Upstream's [Content_Types].xml, verbatim: 7 lines, four Default entries, and
 * deliberately NO trailing newline after </Types> (bbs_3mf.cpp:6944-6952).
 */
export function contentTypesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    ' <Default Extension="png" ContentType="image/png"/>\n' +
    ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n' +
    "</Types>"
  );
}

/**
 * `_rels/.rels`. rel-1 is the model; rel-2 is the OPC thumbnail; rel-4 and
 * rel-5 are Bambu's cover-thumbnail-middle/small. There is no rel-3 upstream
 * and none is invented here.
 *
 * A relationship is only written when its target exists in the archive — a
 * dangling rel is a malformed OPC package, and a thumbnail capture can
 * legitimately fail (thumbnail.ts refuses to hand back a blank square).
 */
export function relsXml(hasThumbnail: boolean, hasSmallThumbnail: boolean): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n',
    ` <Relationship Target="/${MODEL_FILE}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n`,
  ];
  if (hasThumbnail) {
    lines.push(
      ` <Relationship Target="/${PLATE_THUMBNAIL_FILE}" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n`,
      ` <Relationship Target="/${PLATE_THUMBNAIL_FILE}" Id="rel-4" Type="${BBS_NAMESPACE}/cover-thumbnail-middle"/>\n`
    );
  }
  if (hasSmallThumbnail) {
    lines.push(
      ` <Relationship Target="/${PLATE_THUMBNAIL_SMALL_FILE}" Id="rel-5" Type="${BBS_NAMESPACE}/cover-thumbnail-small"/>\n`
    );
  }
  lines.push("</Relationships>\n");
  return lines.join("");
}

/**
 * `Metadata/slice_info.config` — the header block only, plus the plate facts
 * LEVO actually knows.
 *
 * Upstream fills each plate with slice RESULTS: predicted time, weight, first
 * layer time, whether the toolpath left the bed. LEVO has none of those unless
 * a slice has run, and writing plausible numbers into a file the customer will
 * publish would be inventing data. So the plate block carries its index and
 * the printer it was set up for, and nothing that would have to be guessed.
 */
export function sliceInfoXml(opts: { application: string; printerModelId?: string; nozzleDiameters?: string }): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    "<config>\n",
    "  <header>\n",
    `    <header_item key="X-BBL-Client-Type" value="slicer"/>\n`,
    `    <header_item key="X-BBL-Client-Version" value="${xmlEscape(opts.application)}"/>\n`,
    "  </header>\n",
    "  <plate>\n",
    `    <metadata key="index" value="1"/>\n`,
  ];
  if (opts.printerModelId) {
    lines.push(`    <metadata key="printer_model_id" value="${xmlEscape(opts.printerModelId)}"/>\n`);
  }
  if (opts.nozzleDiameters) {
    lines.push(`    <metadata key="nozzle_diameters" value="${xmlEscape(opts.nozzleDiameters)}"/>\n`);
  }
  lines.push("  </plate>\n", "</config>\n");
  return lines.join("");
}

/**
 * Adds the BambuStudio namespace and the schema markers to `3dmodel.model`,
 * and replaces the Application value with an honest one.
 *
 * Text surgery rather than a DOM parse, on purpose: the model file holds every
 * vertex of every object and is routinely tens of megabytes. Parsing it to
 * change four lines of the header would cost a full DOM of the mesh on a
 * device the whole studio is tuned to keep off the swap.
 */
export function stampModelXml(
  xml: string,
  opts: { application: string; projectName: string; createdAt: string }
): { xml: string; changed: boolean } {
  const openTag = /<model\b[^>]*>/.exec(xml);
  if (!openTag) return { xml, changed: false };

  let head = openTag[0];
  if (!head.includes("xmlns:BambuStudio")) {
    head = head.replace(/\s*>$/, ` xmlns:BambuStudio="${BBS_NAMESPACE}">`);
  }

  let out = xml.slice(0, openTag.index) + head + xml.slice(openTag.index + openTag[0].length);

  // The Application value states who produced the file. It is replaced, not
  // appended to: two Application metadata items would be ambiguous, and the
  // engine's own value ("ThreeSlicer") names the library rather than the app
  // the customer used.
  const appTag = /<metadata name="Application">[^<]*<\/metadata>/;
  const honestApp = `<metadata name="Application">${xmlEscape(opts.application)}</metadata>`;
  out = appTag.test(out)
    ? out.replace(appTag, honestApp)
    : out.replace(/(<model\b[^>]*>\n?)/, `$1 ${honestApp}\n`);

  const extras: string[] = [];
  if (!out.includes('name="BambuStudio:3mfVersion"')) {
    extras.push(` <metadata name="BambuStudio:3mfVersion">${BBS_3MF_VERSION}</metadata>\n`);
  }
  if (!out.includes('name="Title"') && opts.projectName) {
    extras.push(` <metadata name="Title">${xmlEscape(opts.projectName)}</metadata>\n`);
  }
  if (!out.includes('name="CreationDate"') && opts.createdAt) {
    extras.push(` <metadata name="CreationDate">${xmlEscape(opts.createdAt)}</metadata>\n`);
  }
  if (extras.length > 0) {
    const anchor = out.indexOf(honestApp);
    const insertAt = anchor >= 0 ? out.indexOf("\n", anchor) + 1 : -1;
    if (insertAt > 0) out = out.slice(0, insertAt) + extras.join("") + out.slice(insertAt);
  }

  return { xml: out, changed: true };
}

/**
 * Gives `project_settings.config` the header BambuStudio identifies it by.
 *
 * NOTHING ELSE IS TOUCHED, and that restraint is the whole point.
 * `ConfigBase::load_from_json` (Config.cpp:848) has no per-key recovery: one
 * key the running BambuStudio does not know throws, and the WHOLE config is
 * discarded. So this adds the three header keys upstream writes and passes
 * every engine-produced key through untouched. Translating or "improving" a
 * key here would risk silently costing the user every setting in the file.
 */
export function stampProjectSettings(
  json: string,
  opts: { version: string }
): { json: string; changed: boolean; keyCount: number } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { json, changed: false, keyCount: 0 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { json, changed: false, keyCount: 0 };
  }
  const already = parsed.name === PROJECT_SETTINGS_NAME;
  // Header first, so a human opening the file sees what it is on line 2.
  const stamped: Record<string, unknown> = {
    name: PROJECT_SETTINGS_NAME,
    from: PROJECT_SETTINGS_FROM,
    version: opts.version,
    ...parsed,
  };
  stamped.name = PROJECT_SETTINGS_NAME;
  stamped.from = PROJECT_SETTINGS_FROM;
  if (typeof parsed.version !== "string" || !parsed.version) stamped.version = opts.version;

  return {
    json: JSON.stringify(stamped, null, 4) + "\n",
    changed: !already,
    keyCount: Object.keys(stamped).length,
  };
}

/**
 * Turns the engine's 3MF into a Bambu-shaped project package.
 *
 * Pure: it takes bytes and options and returns bytes, so the whole conversion
 * is testable in Node without a browser, an engine or a canvas.
 */
export function toBambuProject(input: Uint8Array, opts: BambuProjectOptions): BambuProjectResult {
  const entries = unzipSync(input);
  const added: string[] = [];
  const kept: string[] = [];
  const warnings: string[] = [];

  if (!entries[MODEL_FILE]) {
    throw new Error(`not a 3MF: ${MODEL_FILE} is missing`);
  }

  const out: Record<string, Uint8Array> = { ...entries };

  // 1. The model header.
  const stamped = stampModelXml(strFromU8(entries[MODEL_FILE]), {
    application: opts.application,
    projectName: opts.projectName,
    createdAt: opts.createdAt,
  });
  if (stamped.changed) {
    out[MODEL_FILE] = strToU8(stamped.xml);
    added.push("model metadata (BambuStudio namespace, 3mfVersion, Title, CreationDate)");
  } else {
    warnings.push("the model file had no <model> element to stamp");
  }

  // 2. The project settings header.
  if (entries[PROJECT_SETTINGS_FILE]) {
    const settings = stampProjectSettings(strFromU8(entries[PROJECT_SETTINGS_FILE]), { version: opts.version });
    if (settings.changed) {
      out[PROJECT_SETTINGS_FILE] = strToU8(settings.json);
      added.push(`project_settings header (${settings.keyCount} keys carried through)`);
    } else {
      kept.push(PROJECT_SETTINGS_FILE);
    }
  } else {
    // Honest: the engine only writes this file once a setting differs from the
    // preset, so an untouched project genuinely has no settings to carry.
    warnings.push("no project settings were written — the project uses the preset unchanged");
  }

  if (entries[MODEL_SETTINGS_FILE]) kept.push(MODEL_SETTINGS_FILE);

  // 3. Thumbnails, and only if the capture actually produced pixels.
  const hasBig = !!opts.thumbnailPng && opts.thumbnailPng.length > 0;
  const hasSmall = !!opts.thumbnailSmallPng && opts.thumbnailSmallPng.length > 0;
  if (hasBig) {
    out[PLATE_THUMBNAIL_FILE] = opts.thumbnailPng as Uint8Array;
    added.push(PLATE_THUMBNAIL_FILE);
  }
  if (hasSmall) {
    out[PLATE_THUMBNAIL_SMALL_FILE] = opts.thumbnailSmallPng as Uint8Array;
    added.push(PLATE_THUMBNAIL_SMALL_FILE);
  }
  if (!hasBig) warnings.push("no preview image could be captured — MakerWorld will ask for images at upload");

  // 4. The package envelope.
  out[RELS_FILE] = strToU8(relsXml(hasBig, hasSmall));
  out[CONTENT_TYPES_FILE] = strToU8(contentTypesXml());
  out[SLICE_INFO_FILE] = strToU8(
    sliceInfoXml({
      application: opts.application,
      printerModelId: opts.printerModelId,
      nozzleDiameters: opts.nozzleDiameters,
    })
  );
  added.push(SLICE_INFO_FILE, RELS_FILE, CONTENT_TYPES_FILE);

  return { bytes: zipSync(out, { level: 6 }), added, kept, warnings };
}
