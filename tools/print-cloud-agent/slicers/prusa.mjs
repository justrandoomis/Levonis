/**
 * PRUSASLICER CLI.
 *
 *   prusa-slicer --export-gcode
 *     --load <printer.ini> --load <print.ini> --load <filament.ini>
 *     --layer-height 0.2 --fill-density 15% --perimeters 2
 *     --support-material --support-material-auto [--support-material-style organic] | --no-support-material
 *     --brim-width <mm> | --brim-width 0
 *     --output <work>/out/lv_<job>.gcode
 *     <model> <model> …                     (PrusaSlicer arranges them itself)
 *
 * v1 limits, refused with a code rather than sliced differently: one
 * filament per job (MULTI_MATERIAL_UNSUPPORTED — per-object extruders need a
 * project file), and no automatic orientation (AUTO_ORIENTATION_UNSUPPORTED —
 * the CLI has none). PrusaSlicer reports 0 g for a filament profile without a
 * density; gcode.mjs then refuses the weight as unknown.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const fail = (error_code, detail) => ({ ok: false, error_code, detail });

/** The argument list (pure: tested on its own). */
export function prusaArgs({ printerIni, printIni, filamentIni, settings, brimWidthMm, outPath, objectPaths }) {
  const args = ['--export-gcode', '--load', printerIni, '--load', printIni, '--load', filamentIni];
  const overrides = {};
  if (Number.isInteger(settings.layer_height_um)) overrides['layer-height'] = String(settings.layer_height_um / 1000);
  if (Number.isInteger(settings.infill_percent)) overrides['fill-density'] = `${settings.infill_percent}%`;
  if (Number.isInteger(settings.walls)) overrides.perimeters = String(settings.walls);
  for (const [k, v] of Object.entries(overrides)) args.push(`--${k}`, v);
  if (settings.supports === 'none') args.push('--no-support-material');
  else if (settings.supports) {
    args.push('--support-material', '--support-material-auto');
    if (settings.supports === 'tree') args.push('--support-material-style', 'organic');
  }
  if (typeof settings.brim === 'boolean') args.push('--brim-width', settings.brim ? String(brimWidthMm) : '0');
  args.push('--output', outPath, ...objectPaths);
  return { args, overrides: { ...overrides, supports: settings.supports ?? null, brim: settings.brim ?? null } };
}

export const prusa = {
  label: 'PrusaSlicer',
  layerMarkers: [';LAYER_CHANGE'],

  async command({ plan, files, workDir, outBase, cfg }) {
    if (plan.slots.length > 1) return fail('MULTI_MATERIAL_UNSUPPORTED', 'the PrusaSlicer CLI path slices one filament per job');
    if (plan.orientation === 'auto') return fail('AUTO_ORIENTATION_UNSUPPORTED', 'the PrusaSlicer CLI has no automatic orientation');
    const outDir = join(workDir, 'out');
    await mkdir(outDir, { recursive: true });
    const { args, overrides } = prusaArgs({
      printerIni: plan.machine.machine,
      printIni: plan.machine.process,
      filamentIni: plan.slots[0].profile,
      settings: plan.settings,
      brimWidthMm: cfg.brim_width_mm ?? 5,
      outPath: join(outDir, `${outBase}.gcode`),
      objectPaths: plan.objects.map((o) => files.get(o.file_id)),
    });
    return { ok: true, args, overrides };
  },

  async output({ workDir, outBase }) {
    const p = join(workDir, 'out', `${outBase}.gcode`);
    return existsSync(p) ? { path: p, format: 'gcode' } : null;
  },
};
