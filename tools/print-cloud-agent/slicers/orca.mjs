/**
 * ORCASLICER / BAMBU STUDIO CLI (the two share Bambu Studio's command line).
 *
 *   orca-slicer --slice 0 --arrange 1 --orient 0|1
 *     --load-settings "<machine.json>;<process.levonis.json>"
 *     --load-filaments "<filament 1>.json;<filament 2>.json"
 *     --load-filament-ids "1,2,1"          (the filament of each object, in load order)
 *     --outputdir <work>/out
 *     [--export-3mf lv_<job>.gcode.3mf]    (output "gcode.3mf"; else out/plate_1.gcode)
 *     <model> <model> …                    (each model × quantity × copies)
 *
 * The job's settings become a copy of the configured process profile with
 * these keys replaced — the profile must be a complete JSON export (no
 * `inherits` chain the CLI cannot resolve):
 *   layer_height ← layer_height_um / 1000      sparse_infill_density ← "<n>%"
 *   wall_loops ← walls                          enable_support ← supports ≠ none
 *   support_type ← tree(auto) | normal(auto)    brim_type ← outer_only | no_brim
 * ("auto" supports keep the profile's own support type.)
 *   gcode_label_objects ← "0", always: object names come from the customer's
 *   3MF, and OrcaSlicer writes them unescaped into `; printing object <name>`
 *   lines — a newline in a name would start a printer command. (OrcaSlicer's
 *   key; not verified against Bambu Studio, which is expected to ignore it.)
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The process-profile keys a job's settings replace (pure: tested on its own). */
export function orcaProcessOverrides(settings) {
  const o = {};
  if (Number.isInteger(settings.layer_height_um)) o.layer_height = String(settings.layer_height_um / 1000);
  if (Number.isInteger(settings.infill_percent)) o.sparse_infill_density = `${settings.infill_percent}%`;
  if (Number.isInteger(settings.walls)) o.wall_loops = String(settings.walls);
  if (settings.supports === 'none') o.enable_support = '0';
  else if (settings.supports === 'tree') Object.assign(o, { enable_support: '1', support_type: 'tree(auto)' });
  else if (settings.supports === 'normal') Object.assign(o, { enable_support: '1', support_type: 'normal(auto)' });
  else if (settings.supports === 'auto') o.enable_support = '1';
  if (typeof settings.brim === 'boolean') o.brim_type = settings.brim ? 'outer_only' : 'no_brim';
  // No object label: a customer's object name never reaches the G-code (see the header).
  o.gcode_label_objects = '0';
  return o;
}

/** The argument list (pure: tested on its own). */
export function orcaArgs({ machinePath, processPath, filamentPaths, objects, outDir, outBase, output, orient }) {
  const args = [
    '--slice', '0',
    '--arrange', '1',
    '--orient', orient ? '1' : '0',
    '--load-settings', `${machinePath};${processPath}`,
    '--load-filaments', filamentPaths.join(';'),
    '--load-filament-ids', objects.map((o) => o.filament).join(','),
    '--outputdir', outDir,
  ];
  if (output === 'gcode.3mf') args.push('--export-3mf', `${outBase}.gcode.3mf`);
  for (const o of objects) args.push(o.path);
  return args;
}

export const orca = {
  label: 'OrcaSlicer',
  layerMarkers: ['; CHANGE_LAYER', ';LAYER_CHANGE'],

  async command({ plan, files, workDir, outBase, cfg }) {
    const profile = JSON.parse(await readFile(plan.machine.process, 'utf8'));
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('the process profile is not a JSON object');
    const overrides = orcaProcessOverrides(plan.settings);
    const processPath = join(workDir, 'process.levonis.json');
    await writeFile(processPath, JSON.stringify({ ...profile, ...overrides }, null, 2));
    const outDir = join(workDir, 'out');
    await mkdir(outDir, { recursive: true });
    const args = orcaArgs({
      machinePath: plan.machine.machine,
      processPath,
      filamentPaths: plan.slots.map((s) => s.profile),
      objects: plan.objects.map((o) => ({ filament: o.filament, path: files.get(o.file_id) })),
      outDir,
      outBase,
      output: cfg.output ?? 'gcode',
      orient: plan.orientation === 'auto',
    });
    return { ok: true, args, overrides };
  },

  async output({ workDir, outBase, cfg }) {
    const outDir = join(workDir, 'out');
    if ((cfg.output ?? 'gcode') === 'gcode.3mf') {
      for (const p of [join(outDir, `${outBase}.gcode.3mf`), join(workDir, `${outBase}.gcode.3mf`)]) if (existsSync(p)) return { path: p, format: 'gcode.3mf' };
      return null;
    }
    const plates = existsSync(outDir) ? readdirSync(outDir).filter((n) => /^plate_\d+\.gcode$/.test(n)) : [];
    if (plates.length !== 1) return plates.length > 1 ? { error_code: 'OBJECTS_DO_NOT_FIT_ONE_PLATE', detail: `the slicer produced ${plates.length} plates` } : null;
    const target = join(outDir, `${outBase}.gcode`);
    await rename(join(outDir, plates[0]), target);
    return { path: target, format: 'gcode' };
  },
};
