/**
 * PROJECTS, MODELS, SAVED PROFILES AND BUILD PLATES (docs/PRINT_CLOUD.md §7).
 *
 *   Project → Models (a file or an imported link, a quantity, a printable
 *   configuration kept apart from the untouched source) → Plates (instances
 *   placed on one printer model's bed) → Print jobs.
 *
 * Every read and write is scoped to the owner: another customer's project,
 * model, file or plate answers NOT_FOUND, never FORBIDDEN, so ids leak nothing.
 */
import { many, one, runBatch, type Stmt } from './db';
import { invalid, pcError } from './errors';
import { shelfPack, validatePlacements, type Bed, type PackItem, type Placement, type PlateArranger } from './plates';
import { iso, optString, parseJson, pcId, reqInt, reqString } from './util';

export const PROJECT_TYPES = ['generic', 'keychain', 'medal', 'magnetic', 'nfc', 'led', 'nameplate', 'storage', 'holder', 'figure', 'mechanical'] as const;

export interface PrintSettings {
  layer_height_um: number;
  infill_percent: number;
  supports: 'none' | 'auto' | 'tree' | 'normal';
  nozzle_um: number;
  walls: number;
  brim: boolean;
  plate_type: string;
  orientation: 'as_uploaded' | 'auto';
  /** Pause at these layers (magnet / NFC insertion by an operator). */
  pause_at_layers: number[];
  notes: string;
}

export const DEFAULT_SETTINGS: PrintSettings = {
  layer_height_um: 200,
  infill_percent: 15,
  supports: 'auto',
  nozzle_um: 400,
  walls: 2,
  brim: false,
  plate_type: 'textured_pei',
  orientation: 'as_uploaded',
  pause_at_layers: [],
  notes: '',
};

/** Validate print settings; unknown keys are refused so a typo is not silently ignored. */
export function parseSettings(raw: unknown, base: PrintSettings = DEFAULT_SETTINGS): PrintSettings {
  if (raw === undefined || raw === null) return { ...base };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('settings', 'object_required');
  const r = raw as Record<string, unknown>;
  const known = new Set(Object.keys(DEFAULT_SETTINGS));
  for (const k of Object.keys(r)) if (!known.has(k)) throw invalid(`settings.${k}`, 'unknown_setting');
  const out: PrintSettings = { ...base };
  if (r.layer_height_um !== undefined) out.layer_height_um = reqInt(r.layer_height_um, 'settings.layer_height_um', { min: 40, max: 600 });
  if (r.infill_percent !== undefined) out.infill_percent = reqInt(r.infill_percent, 'settings.infill_percent', { min: 0, max: 100 });
  if (r.supports !== undefined) {
    if (!['none', 'auto', 'tree', 'normal'].includes(String(r.supports))) throw invalid('settings.supports', 'not_allowed');
    out.supports = r.supports as PrintSettings['supports'];
  }
  if (r.nozzle_um !== undefined) out.nozzle_um = reqInt(r.nozzle_um, 'settings.nozzle_um', { min: 100, max: 2000 });
  if (r.walls !== undefined) out.walls = reqInt(r.walls, 'settings.walls', { min: 1, max: 20 });
  if (r.brim !== undefined) {
    if (typeof r.brim !== 'boolean') throw invalid('settings.brim', 'boolean_required');
    out.brim = r.brim;
  }
  if (r.plate_type !== undefined) out.plate_type = reqString(r.plate_type, 'settings.plate_type', { max: 40 });
  if (r.orientation !== undefined) {
    if (r.orientation !== 'as_uploaded' && r.orientation !== 'auto') throw invalid('settings.orientation', 'not_allowed');
    out.orientation = r.orientation;
  }
  if (r.pause_at_layers !== undefined) {
    if (!Array.isArray(r.pause_at_layers) || r.pause_at_layers.length > 20) throw invalid('settings.pause_at_layers', 'array_required');
    out.pause_at_layers = r.pause_at_layers.map((l, i) => reqInt(l, `settings.pause_at_layers[${i}]`, { min: 1, max: 100000 }));
  }
  if (r.notes !== undefined) out.notes = optString(r.notes, 'settings.notes', 1000);
  return out;
}

export interface MaterialAssignment {
  part: string;
  variant_id: string;
}

async function parseAssignments(db: D1Database, raw: unknown): Promise<MaterialAssignment[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 16) throw invalid('material_assignments', 'array_required');
  const out: MaterialAssignment[] = [];
  for (const [i, a] of raw.entries()) {
    if (!a || typeof a !== 'object') throw invalid(`material_assignments[${i}]`, 'object_required');
    const o = a as Record<string, unknown>;
    const part = typeof o.part === 'string' && o.part.trim() ? o.part.trim().slice(0, 60) : 'default';
    const variantId = reqString(o.variant_id, `material_assignments[${i}].variant_id`, { max: 120 });
    const v = await one<{ kind: string; active: number }>(
      db,
      `SELECT c.kind, v.active FROM pc_variants v JOIN pc_products p ON p.id = v.product_id
         JOIN pc_product_categories c ON c.code = p.category_code WHERE v.id = ?`,
      variantId
    );
    if (!v || !v.active) throw pcError('NOT_FOUND', { field: `material_assignments[${i}].variant_id` });
    if (v.kind !== 'filament') throw invalid(`material_assignments[${i}].variant_id`, 'not_a_filament');
    if (out.some((x) => x.part === part)) throw invalid(`material_assignments[${i}].part`, 'duplicate');
    out.push({ part, variant_id: variantId });
  }
  return out;
}

function parseTransform(raw: unknown): Record<string, number | string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('transform', 'object_required');
  const r = raw as Record<string, unknown>;
  const out: Record<string, number | string> = {};
  for (const k of ['rotation_x_mdeg', 'rotation_y_mdeg', 'rotation_z_mdeg']) if (r[k] !== undefined) out[k] = reqInt(r[k], `transform.${k}`, { min: -360000, max: 360000 });
  if (r.scale_ppm !== undefined) out.scale_ppm = reqInt(r.scale_ppm, 'transform.scale_ppm', { min: 10_000, max: 10_000_000 });
  if (r.orientation !== undefined) {
    if (r.orientation !== 'as_uploaded' && r.orientation !== 'auto') throw invalid('transform.orientation', 'not_allowed');
    out.orientation = r.orientation;
  }
  for (const k of Object.keys(r)) if (!['rotation_x_mdeg', 'rotation_y_mdeg', 'rotation_z_mdeg', 'scale_ppm', 'orientation'].includes(k)) throw invalid(`transform.${k}`, 'unknown_field');
  return out;
}

export async function ownedProject(db: D1Database, userId: string, projectId: string) {
  const p = await one<Record<string, unknown>>(db, 'SELECT * FROM pc_projects WHERE id = ? AND user_id = ?', projectId, userId);
  if (!p) throw pcError('NOT_FOUND');
  return p;
}

export async function createProject(db: D1Database, userId: string, body: Record<string, unknown>, now: Date) {
  const id = pcId('pcpj');
  const type = body.project_type ?? 'generic';
  if (!(PROJECT_TYPES as readonly string[]).includes(String(type))) throw invalid('project_type', 'not_allowed');
  const settings = parseSettings(body.settings);
  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO pc_projects (id, user_id, name, description, project_type, status, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .bind(id, userId, reqString(body.name, 'name', { max: 120 }), optString(body.description, 'description', 2000), type, JSON.stringify(settings), iso(now), iso(now)),
    db
      .prepare("INSERT INTO pc_project_members (project_id, user_id, role, accepted_at, created_at) VALUES (?, ?, 'owner', ?, ?)")
      .bind(id, userId, iso(now), iso(now)),
  ]);
  return id;
}

export async function updateProject(db: D1Database, userId: string, projectId: string, body: Record<string, unknown>, now: Date) {
  const p = await ownedProject(db, userId, projectId);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.name !== undefined) {
    sets.push('name = ?');
    vals.push(reqString(body.name, 'name', { max: 120 }));
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    vals.push(optString(body.description, 'description', 2000));
  }
  if (body.project_type !== undefined) {
    if (!(PROJECT_TYPES as readonly string[]).includes(String(body.project_type))) throw invalid('project_type', 'not_allowed');
    sets.push('project_type = ?');
    vals.push(body.project_type);
  }
  if (body.settings !== undefined) {
    sets.push('settings_json = ?');
    vals.push(JSON.stringify(parseSettings(body.settings, parseJson(String(p.settings_json), DEFAULT_SETTINGS))));
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'archived') throw invalid('status', 'not_allowed');
    sets.push('status = ?');
    vals.push(body.status);
  }
  if (!sets.length) throw invalid('body', 'empty');
  await runBatch(db, [db.prepare(`UPDATE pc_projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`).bind(...vals, iso(now), projectId, userId)]);
}

export async function addProjectModel(db: D1Database, userId: string, projectId: string, body: Record<string, unknown>, now: Date) {
  await ownedProject(db, userId, projectId);
  const fileId = typeof body.file_id === 'string' ? body.file_id : null;
  const importId = typeof body.import_id === 'string' ? body.import_id : null;
  if (!fileId && !importId) throw invalid('file_id', 'required');
  let defaultName = 'model';
  if (fileId) {
    const f = await one<{ original_name: string; status: string; deleted_at: string | null }>(
      db,
      'SELECT original_name, status, deleted_at FROM pc_model_files WHERE id = ? AND user_id = ?',
      fileId,
      userId
    );
    if (!f || f.deleted_at) throw pcError('NOT_FOUND', { field: 'file_id' });
    if (f.status === 'rejected' || f.status === 'failed') throw pcError('FILE_REJECTED', { field: 'file_id' });
    defaultName = f.original_name;
  }
  if (importId) {
    const imp = await one<{ id: string; file_id: string | null; metadata_json: string }>(
      db,
      'SELECT id, file_id, metadata_json FROM pc_model_imports WHERE id = ? AND user_id = ?',
      importId,
      userId
    );
    if (!imp) throw pcError('NOT_FOUND', { field: 'import_id' });
    defaultName = String(parseJson<{ name?: string }>(imp.metadata_json, {}).name ?? 'imported model');
  }
  const id = pcId('pcpm');
  const quantity = body.quantity === undefined ? 1 : reqInt(body.quantity, 'quantity', { min: 1, max: 1000 });
  const assignments = await parseAssignments(db, body.material_assignments);
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase().slice(0, 40)).slice(0, 20) : [];
  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO pc_project_models (id, project_id, user_id, file_id, import_id, name, quantity, transform_json, material_assignments_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        projectId,
        userId,
        fileId,
        importId,
        body.name === undefined ? defaultName.slice(0, 120) : reqString(body.name, 'name', { max: 120 }),
        quantity,
        JSON.stringify(parseTransform(body.transform)),
        JSON.stringify(assignments),
        JSON.stringify(tags),
        iso(now),
        iso(now)
      ),
    db.prepare('UPDATE pc_projects SET updated_at = ? WHERE id = ?').bind(iso(now), projectId),
  ]);
  return id;
}

export async function updateProjectModel(db: D1Database, userId: string, modelId: string, body: Record<string, unknown>, now: Date) {
  const m = await one<{ id: string; project_id: string }>(db, 'SELECT id, project_id FROM pc_project_models WHERE id = ? AND user_id = ?', modelId, userId);
  if (!m) throw pcError('NOT_FOUND');
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.name !== undefined) {
    sets.push('name = ?');
    vals.push(reqString(body.name, 'name', { max: 120 }));
  }
  if (body.quantity !== undefined) {
    sets.push('quantity = ?');
    vals.push(reqInt(body.quantity, 'quantity', { min: 1, max: 1000 }));
  }
  if (body.transform !== undefined) {
    sets.push('transform_json = ?');
    vals.push(JSON.stringify(parseTransform(body.transform)));
  }
  if (body.material_assignments !== undefined) {
    sets.push('material_assignments_json = ?');
    vals.push(JSON.stringify(await parseAssignments(db, body.material_assignments)));
  }
  if (body.file_id !== undefined) {
    const f = await one<{ id: string }>(db, 'SELECT id FROM pc_model_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', body.file_id, userId);
    if (!f) throw pcError('NOT_FOUND', { field: 'file_id' });
    sets.push('file_id = ?');
    vals.push(f.id);
  }
  if (!sets.length) throw invalid('body', 'empty');
  await runBatch(db, [db.prepare(`UPDATE pc_project_models SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, iso(now), modelId)]);
}

/** A copy for printing again without re-uploading: same source files, same configuration, new ids. */
export async function duplicateProject(db: D1Database, userId: string, projectId: string, now: Date) {
  const p = await ownedProject(db, userId, projectId);
  const models = await many<Record<string, unknown>>(db, 'SELECT * FROM pc_project_models WHERE project_id = ?', projectId);
  const plates = await many<Record<string, unknown>>(db, 'SELECT * FROM pc_plates WHERE project_id = ?', projectId);
  const newId = pcId('pcpj');
  const modelMap = new Map<string, string>();
  const s: Stmt[] = [
    db
      .prepare(
        `INSERT INTO pc_projects (id, user_id, name, description, project_type, status, settings_json, duplicated_from, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .bind(newId, userId, `${String(p.name)}`.slice(0, 120), p.description, p.project_type, p.settings_json, projectId, iso(now), iso(now)),
    db.prepare("INSERT INTO pc_project_members (project_id, user_id, role, accepted_at, created_at) VALUES (?, ?, 'owner', ?, ?)").bind(newId, userId, iso(now), iso(now)),
  ];
  for (const m of models) {
    const id = pcId('pcpm');
    modelMap.set(String(m.id), id);
    s.push(
      db
        .prepare(
          `INSERT INTO pc_project_models (id, project_id, user_id, file_id, import_id, name, quantity, transform_json, material_assignments_json, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, newId, userId, m.file_id, m.import_id, m.name, m.quantity, m.transform_json, m.material_assignments_json, m.tags_json, iso(now), iso(now))
    );
  }
  for (const pl of plates) {
    const plateId = pcId('pcpl');
    s.push(
      db
        .prepare(
          `INSERT INTO pc_plates (id, project_id, user_id, printer_model_id, label, arrangement, algorithm, spacing_um, valid, issues_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(plateId, newId, userId, pl.printer_model_id, pl.label, pl.arrangement, pl.algorithm, pl.spacing_um, pl.valid, pl.issues_json, iso(now), iso(now))
    );
    const items = await many<Record<string, unknown>>(db, 'SELECT * FROM pc_plate_items WHERE plate_id = ?', pl.id);
    for (const it of items) {
      s.push(
        db
          .prepare(
            `INSERT INTO pc_plate_items (id, plate_id, project_model_id, instance_no, x_um, y_um, rotation_z_mdeg, scale_ppm, variant_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(pcId('pcpi'), plateId, modelMap.get(String(it.project_model_id)), it.instance_no, it.x_um, it.y_um, it.rotation_z_mdeg, it.scale_ppm, it.variant_id)
      );
    }
  }
  await runBatch(db, s);
  return newId;
}

export async function projectView(db: D1Database, userId: string, projectId: string) {
  const p = await ownedProject(db, userId, projectId);
  const models = await many<Record<string, unknown>>(
    db,
    `SELECT m.*, f.status AS file_status, f.size_x_um, f.size_y_um, f.size_z_um, f.original_name, i.status AS import_status
       FROM pc_project_models m
       LEFT JOIN pc_model_files f ON f.id = m.file_id
       LEFT JOIN pc_model_imports i ON i.id = m.import_id
      WHERE m.project_id = ? ORDER BY m.created_at`,
    projectId
  );
  const plates = await many<Record<string, unknown>>(db, 'SELECT * FROM pc_plates WHERE project_id = ? ORDER BY created_at', projectId);
  const items = await many<Record<string, unknown>>(
    db,
    'SELECT i.* FROM pc_plate_items i JOIN pc_plates p ON p.id = i.plate_id WHERE p.project_id = ? ORDER BY i.plate_id, i.project_model_id, i.instance_no',
    projectId
  );
  const jobs = await many<Record<string, unknown>>(
    db,
    'SELECT id, title, status, printer_model_id, plate_id, copies, created_at, updated_at FROM pc_print_jobs WHERE project_id = ? ORDER BY created_at DESC',
    projectId
  );
  return {
    ...p,
    settings: parseJson(String(p.settings_json), DEFAULT_SETTINGS),
    models: models.map((m) => ({
      ...m,
      transform: parseJson(String(m.transform_json), {}),
      material_assignments: parseJson(String(m.material_assignments_json), []),
      tags: parseJson(String(m.tags_json), []),
    })),
    plates: plates.map((pl) => ({ ...pl, issues: parseJson(String(pl.issues_json), []), items: items.filter((i) => i.plate_id === pl.id) })),
    jobs,
  };
}

// ------------------------------------------------------------------ plates

async function bedOf(db: D1Database, printerModelId: string): Promise<Bed> {
  const m = await one<{ build_x_mm: number; build_y_mm: number; build_z_mm: number; active: number }>(
    db,
    'SELECT build_x_mm, build_y_mm, build_z_mm, active FROM pc_printer_models WHERE id = ?',
    printerModelId
  );
  if (!m || !m.active) throw pcError('NOT_FOUND', { field: 'printer_model_id' });
  return { x_um: m.build_x_mm * 1000, y_um: m.build_y_mm * 1000, z_um: m.build_z_mm * 1000 };
}

async function modelFootprints(db: D1Database, projectId: string) {
  const rows = await many<{ id: string; quantity: number; transform_json: string; size_x_um: number | null; size_y_um: number | null; size_z_um: number | null; status: string | null }>(
    db,
    `SELECT m.id, m.quantity, m.transform_json, f.size_x_um, f.size_y_um, f.size_z_um, f.status
       FROM pc_project_models m LEFT JOIN pc_model_files f ON f.id = m.file_id WHERE m.project_id = ?`,
    projectId
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Create a plate. With `arrange: true` the models (each × its quantity, or
 * the `instances` given) are placed by the named arranger; otherwise the
 * caller's `placements` are validated as given. Either way the plate records
 * whether it is valid and why not.
 */
export async function createPlate(
  db: D1Database,
  userId: string,
  projectId: string,
  body: Record<string, unknown>,
  now: Date,
  arranger: PlateArranger = shelfPack
) {
  await ownedProject(db, userId, projectId);
  const printerModelId = reqString(body.printer_model_id, 'printer_model_id', { max: 120 });
  const bed = await bedOf(db, printerModelId);
  const spacing = body.spacing_um === undefined ? 5000 : reqInt(body.spacing_um, 'spacing_um', { min: 0, max: 50000 });
  const models = await modelFootprints(db, projectId);
  const footprintOf = (modelId: string) => {
    const m = models.get(modelId);
    if (!m) throw pcError('NOT_FOUND', { field: 'project_model_id' });
    if (m.status !== 'ready' || m.size_x_um === null) throw pcError('FILE_NOT_READY', { project_model_id: modelId });
    const t = parseJson<{ scale_ppm?: number }>(m.transform_json, {});
    return { footprint: { x_um: Number(m.size_x_um), y_um: Number(m.size_y_um), z_um: Number(m.size_z_um) }, scale: t.scale_ppm ?? 1_000_000 };
  };
  let placements: Placement[] = [];
  let arrangement: 'manual' | 'arranged' = 'manual';
  let algorithm = '';
  const unplaced: string[] = [];
  const variantOf = new Map<string, string | null>();
  if (body.arrange === true) {
    const items: PackItem[] = [];
    const wanted = Array.isArray(body.instances)
      ? (body.instances as unknown[]).map((x, i) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return { model: reqString(o.project_model_id, `instances[${i}].project_model_id`, { max: 120 }), count: reqInt(o.count ?? 1, `instances[${i}].count`, { min: 1, max: 200 }) };
        })
      : [...models.values()].map((m) => ({ model: m.id, count: Number(m.quantity) }));
    if (wanted.reduce((s, w) => s + w.count, 0) > 400) throw invalid('instances', 'too_many');
    for (const w of wanted) {
      const f = footprintOf(w.model);
      for (let n = 1; n <= w.count; n++) items.push({ key: `${w.model}#${n}`, footprint: f.footprint, scale_ppm: f.scale });
    }
    const res = arranger.arrange(items, bed, spacing);
    placements = res.placements;
    unplaced.push(...res.unplaced);
    arrangement = 'arranged';
    algorithm = arranger.name;
  } else {
    const raw = body.placements;
    if (!Array.isArray(raw) || !raw.length || raw.length > 400) throw invalid('placements', 'array_required');
    const counters = new Map<string, number>();
    placements = raw.map((x, i) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const modelId = reqString(o.project_model_id, `placements[${i}].project_model_id`, { max: 120 });
      const f = footprintOf(modelId);
      const n = (counters.get(modelId) ?? 0) + 1;
      counters.set(modelId, n);
      const key = `${modelId}#${n}`;
      variantOf.set(key, typeof o.variant_id === 'string' ? o.variant_id : null);
      return {
        key,
        x_um: reqInt(o.x_um, `placements[${i}].x_um`, { min: -10_000_000, max: 10_000_000 }),
        y_um: reqInt(o.y_um, `placements[${i}].y_um`, { min: -10_000_000, max: 10_000_000 }),
        rotation_z_mdeg: o.rotation_z_mdeg === undefined ? 0 : reqInt(o.rotation_z_mdeg, `placements[${i}].rotation_z_mdeg`, { min: -360000, max: 360000 }),
        scale_ppm: o.scale_ppm === undefined ? f.scale : reqInt(o.scale_ppm, `placements[${i}].scale_ppm`, { min: 10_000, max: 10_000_000 }),
        footprint: f.footprint,
      };
    });
  }
  const issues = [...validatePlacements(placements, bed, spacing), ...(unplaced.length ? [{ code: 'NOT_ARRANGEABLE' as const, keys: unplaced }] : [])];
  const plateId = pcId('pcpl');
  const s: Stmt[] = [
    db
      .prepare(
        `INSERT INTO pc_plates (id, project_id, user_id, printer_model_id, label, arrangement, algorithm, spacing_um, valid, issues_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(plateId, projectId, userId, printerModelId, optString(body.label, 'label', 80), arrangement, algorithm, spacing, issues.length ? 0 : 1, JSON.stringify(issues), iso(now), iso(now)),
  ];
  for (const pl of placements) {
    const [modelId, n] = pl.key.split('#');
    s.push(
      db
        .prepare(
          `INSERT INTO pc_plate_items (id, plate_id, project_model_id, instance_no, x_um, y_um, rotation_z_mdeg, scale_ppm, variant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(pcId('pcpi'), plateId, modelId, Number(n), pl.x_um, pl.y_um, pl.rotation_z_mdeg, pl.scale_ppm, variantOf.get(pl.key) ?? null)
    );
  }
  await runBatch(db, s);
  return { plate_id: plateId, valid: issues.length === 0, issues, arrangement, algorithm, placed: placements.length, unplaced };
}

// ------------------------------------------------------------------ saved print profiles

export async function saveProfile(db: D1Database, userId: string, body: Record<string, unknown>, now: Date, profileId?: string) {
  const settings = parseSettings(body.settings);
  const name = reqString(body.name, 'name', { max: 80 });
  if (profileId) {
    const row = await one<{ id: string }>(db, 'SELECT id FROM pc_print_profiles WHERE id = ? AND user_id = ?', profileId, userId);
    if (!row) throw pcError('NOT_FOUND');
    await runBatch(db, [db.prepare('UPDATE pc_print_profiles SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?').bind(name, JSON.stringify(settings), iso(now), profileId)]);
    return profileId;
  }
  const id = pcId('pcprof');
  await runBatch(db, [
    db
      .prepare('INSERT INTO pc_print_profiles (id, user_id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, userId, name, JSON.stringify(settings), iso(now), iso(now)),
  ]);
  return id;
}
