/**
 * A CUSTOMER'S 3MF BEFORE IT REACHES A SLICER (docs/PRINT_CLOUD_AGENT.md
 * §Security). A 3MF is a ZIP of parts, and some parts are not geometry: the
 * slicer turns them into commands for the printer. The agent hands the slicer
 * the customer's geometry and the workshop's own profiles — nothing else:
 *
 *   REFUSED (UNSUPPORTED_MODEL_CONTENT) — per-layer custom G-code:
 *     Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml (PrusaSlicer writes a
 *     «custom» entry's text verbatim at its layer — checked with PrusaSlicer
 *     2.7.2), Metadata/custom_gcode_per_layer.xml (Bambu Studio / OrcaSlicer),
 *     and any G-code file inside the archive (a sliced plate).
 *   REMOVED — the slicer configuration saved in the project:
 *     Metadata/Slic3r_PE.config (PrusaSlicer), Metadata/project_settings.config
 *     (Bambu Studio / OrcaSlicer). Every key the workshop's profiles leave
 *     unset is taken from it: its start_gcode, layer_gcode … become printer
 *     commands, its post_process a program run on this computer (PrusaSlicer
 *     2.7.2 printed a customer's start_gcode and layer_gcode under a partial
 *     workshop .ini). Without it the slicer reads the archive as geometry.
 *
 * Names are matched as the slicers match them and wider: case-blind, `\` read
 * as `/`, in any folder. An archive this reader cannot read (ZIP64,
 * encryption, a corrupt directory) is refused, never passed on: the slicer may
 * read what this reader cannot. The cloud refuses the same carriers at upload
 * (worker/lib/printCloud/files.ts, MODEL_CONTAINS_GCODE); this guard also
 * covers files stored before that check existed.
 *
 * Object NAMES are customer text too: the slicer adapters turn object labels
 * off, so no name is ever written into the G-code (prusa.mjs, orca.mjs).
 */
import { readZip, zipWithout } from '../lib/zip.mjs';

const GCODE_PARTS = new Set(['prusa_slicer_custom_gcode_per_print_z.xml', 'custom_gcode_per_layer.xml']);
const GCODE_FILE = /\.(gcode|gco|g|bgcode|bgc)$/;
const CONFIG_PARTS = new Set(['slic3r_pe.config', 'project_settings.config']);

/** An entry's file name as a slicer would compare it: `\` as `/`, the last segment, lower case. */
const baseName = (name) => (name.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '').toLowerCase();

/**
 * @param {Buffer} bytes  the 3MF as downloaded
 * @returns {{ ok: true, bytes: Buffer, removed: string[] } | { ok: false, error_code: 'UNSUPPORTED_MODEL_CONTENT', detail: string }}
 */
export function screen3mf(bytes) {
  const refuse = (detail) => ({ ok: /** @type {const} */ (false), error_code: /** @type {const} */ ('UNSUPPORTED_MODEL_CONTENT'), detail });
  let names;
  try {
    names = readZip(bytes).names;
  } catch (e) {
    return refuse(`unreadable 3MF archive (${e instanceof Error ? e.message : String(e)})`);
  }
  const carrier = names.find((n) => GCODE_PARTS.has(baseName(n)) || GCODE_FILE.test(baseName(n)));
  if (carrier) return refuse(`the 3MF carries printer commands (${carrier.slice(0, 120)}): custom G-code from a model is never run on the workshop's printers`);
  const removed = names.filter((n) => CONFIG_PARTS.has(baseName(n)));
  if (!removed.length) return { ok: true, bytes, removed };
  return { ok: true, bytes: zipWithout(bytes, new Set(removed)), removed };
}
