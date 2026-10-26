/**
 * THE PRINT JOB LIFECYCLE (docs/PRINT_CLOUD.md §7.4–7.7).
 *
 *   draft ─► uploaded ─► analyzing ─► ready ─► awaiting_confirmation ─► confirmed ─► queued
 *     ▲          ▲  ◄──────(slicer failed)       │  ◄──(edit)             (operator approves)
 *     └──────────┴──────────(edit settings)──────┘
 *   queued ─► preparing ─► printing ⇄ paused
 *   printing ─► completed           (verified consumption reconciled)
 *   preparing/printing/paused ─► failed ─► reprint_requested
 *   draft … queued (and preparing, by an operator) ─► cancelled
 *
 * EVERY transition is one conditional UPDATE that must match the status AND
 * the `op_token` the request read, sets a fresh token and is followed by a
 * fence on it, plus an append-only `pc_print_job_events` row naming the
 * actor. A completed job cannot restart, a cancelled job cannot stay
 * scheduled, and two operators clicking at once move it once.
 *
 * RESOURCES. Nothing is deducted on an estimate. Confirmation RESERVES the
 * estimated seconds and each material per variant (every colour and every
 * accessory independently); completion SETTLES each reservation against the
 * verified actual use — billed, released, and the physical grams taken off
 * the workshop shelf — in the same batch as the status flip. Cancellation
 * releases, exactly once. A failure settles by the configured policy for the
 * party responsible: a verified workshop failure costs the customer nothing.
 */
import { many, one, fence, planned, runBatch, type Stmt } from './db';
import { invalid, pcError } from './errors';
import { integrationEvent } from './adapters';
import { pcAudit } from './audit';
import { activeReservationForJob, expireDueCredits, releaseCredits, reserveCredits, settleCredits, creditAccountId } from './credits';
import { activeInventoryReservations, inventoryAccountId, releaseInventory, reserveInventory, settleInventory } from './inventory';
import { pcNotify, type PcNotice } from './notify';
import { fitsBuildVolume } from './files';
import { DEFAULT_SETTINGS, parseSettings, plateIssues, type PrintSettings } from './projects';
import type { PrintCloudConfig, Responsible } from './settings';
import { removePhysical, type BatchLots, type PhysicalMove } from './warehouse';
import { addSeconds, iso, parseJson, pcId, reqInt, reqString } from './util';

export const JOB_STATUSES = [
  'draft',
  'uploaded',
  'analyzing',
  'ready',
  'awaiting_confirmation',
  'confirmed',
  'queued',
  'preparing',
  'printing',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'reprint_requested',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  draft: ['uploaded', 'cancelled'],
  uploaded: ['analyzing', 'draft', 'cancelled'],
  analyzing: ['ready', 'uploaded', 'cancelled'],
  ready: ['awaiting_confirmation', 'draft', 'cancelled'],
  // No edge skips `confirmed`: confirmation is the only door that reserves, so nothing reaches the queue unreserved.
  awaiting_confirmation: ['confirmed', 'ready', 'draft', 'cancelled'],
  confirmed: ['queued', 'cancelled'],
  queued: ['preparing', 'cancelled'],
  preparing: ['printing', 'queued', 'failed', 'cancelled'],
  printing: ['paused', 'completed', 'failed'],
  paused: ['printing', 'failed'],
  completed: [],
  failed: ['reprint_requested'],
  cancelled: [],
  reprint_requested: [],
};

export const TERMINAL: readonly JobStatus[] = ['completed', 'cancelled', 'reprint_requested'];
/** States in which a job holds reserved resources. */
export const RESERVED_STATES: readonly JobStatus[] = ['confirmed', 'queued', 'preparing', 'printing', 'paused', 'failed'];
/** States a customer may cancel from (an operator may also cancel `preparing`). */
export const CUSTOMER_CANCELLABLE: readonly JobStatus[] = ['draft', 'uploaded', 'analyzing', 'ready', 'awaiting_confirmation', 'confirmed', 'queued'];

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type ActorType = 'customer' | 'operator' | 'admin' | 'agent' | 'system';
export interface Actor {
  type: ActorType;
  id: string;
}

export interface JobRow {
  id: string;
  user_id: string;
  project_id: string;
  plate_id: string | null;
  printer_model_id: string;
  tier_id: string;
  title: string;
  status: JobStatus;
  settings_json: string;
  copies: number;
  estimate_id: string | null;
  confirmation_expires_at: string | null;
  priority: number;
  needs_operator_approval: number;
  depends_on_job_id: string | null;
  parent_job_id: string | null;
  assigned_printer_id: string | null;
  operator_instructions_json: string;
  queued_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  billable_seconds: number | null;
  printed_seconds: number | null;
  failure_id: string | null;
  op_token: string;
  created_at: string;
  updated_at: string;
}

export interface EstimateRow {
  id: string;
  job_id: string;
  provenance: string;
  duration_seconds: number;
  layer_count: number | null;
  model_grams: number;
  support_grams: number;
  purge_grams: number;
  color_changes: number;
  compatible: number;
  warnings_json: string;
  created_at: string;
}

export async function loadJob(db: D1Database, jobId: string, userId?: string): Promise<JobRow> {
  const job = await one<JobRow>(db, `SELECT * FROM pc_print_jobs WHERE id = ? ${userId ? 'AND user_id = ?' : ''}`, ...(userId ? [jobId, userId] : [jobId]));
  if (!job) throw pcError('NOT_FOUND');
  return job;
}

/**
 * The status flip, fenced: matches only the status AND token this request
 * read, writes a fresh token, and records who did it. A caller that chains a
 * second flip in the same batch passes the token, so the second matches what
 * the first wrote.
 */
export function transition(
  db: D1Database,
  job: JobRow,
  to: JobStatus,
  actor: Actor,
  event: string,
  now: Date,
  detail: Record<string, unknown> = {},
  set: Record<string, unknown> = {},
  token: string = pcId('tok')
): Stmt[] {
  if (!canTransition(job.status, to)) throw pcError('INVALID_TRANSITION', { from: job.status, to });
  const cols = Object.keys(set);
  for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new Error(`bad column ${c}`);
  return [
    db
      .prepare(
        `UPDATE pc_print_jobs SET status = ?, op_token = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')}
          WHERE id = ? AND status = ? AND op_token = ?`
      )
      .bind(to, token, iso(now), ...cols.map((c) => set[c]), job.id, job.status, job.op_token),
    fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_print_jobs WHERE id = ?) = ?', [job.id, token]),
    db
      .prepare(
        `INSERT INTO pc_print_job_events (id, job_id, from_status, to_status, event, actor_type, actor_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(pcId('pcje'), job.id, job.status, to, event, actor.type, actor.id, JSON.stringify(detail).slice(0, 4000), iso(now)),
  ];
}

/** An event that is not a status change (a note, a reported completion awaiting verification). */
export function jobEvent(db: D1Database, job: JobRow, event: string, actor: Actor, now: Date, detail: Record<string, unknown> = {}): Stmt {
  return db
    .prepare(
      `INSERT INTO pc_print_job_events (id, job_id, from_status, to_status, event, actor_type, actor_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(pcId('pcje'), job.id, job.status, job.status, event, actor.type, actor.id, JSON.stringify(detail).slice(0, 4000), iso(now));
}

function notifyJob(db: D1Database, job: JobRow, notice: PcNotice, key: string): Stmt {
  return pcNotify(db, {
    userId: job.user_id,
    notice,
    entity: 'print_cloud_job',
    entityId: job.id,
    link: `/print-cloud/jobs/${job.id}`,
    vars: { title: job.title || job.id },
    eventKey: `${notice}:${job.id}:${key}`,
  });
}

// ------------------------------------------------------------------ creation

interface ModelInput {
  id: string;
  file_id: string | null;
  import_id: string | null;
  quantity: number;
  transform_json: string;
  material_assignments_json: string;
  file_status: string | null;
  size_x_um: number | null;
  size_y_um: number | null;
  size_z_um: number | null;
}

async function jobModels(db: D1Database, projectId: string): Promise<ModelInput[]> {
  return many<ModelInput>(
    db,
    `SELECT m.id, m.file_id, m.import_id, m.quantity, m.transform_json, m.material_assignments_json, f.status AS file_status,
            f.size_x_um, f.size_y_um, f.size_z_um
       FROM pc_project_models m
       LEFT JOIN pc_model_files f ON f.id = m.file_id AND f.deleted_at IS NULL
      WHERE m.project_id = ? ORDER BY m.created_at`,
    projectId
  );
}

const filesReady = (models: ModelInput[]): boolean => models.length > 0 && models.every((m) => m.file_id && m.file_status === 'ready');

async function parseAccessories(db: D1Database, raw: unknown): Promise<Array<{ variant_id: string; qty: number }>> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw invalid('accessories', 'array_required');
  const out: Array<{ variant_id: string; qty: number }> = [];
  for (const [i, a] of raw.entries()) {
    const o = (a ?? {}) as Record<string, unknown>;
    const variantId = reqString(o.variant_id, `accessories[${i}].variant_id`, { max: 120 });
    const qty = reqInt(o.qty, `accessories[${i}].qty`, { min: 1, max: 100000 });
    const v = await one<{ kind: string; active: number }>(
      db,
      `SELECT c.kind, v.active FROM pc_variants v JOIN pc_products p ON p.id = v.product_id
         JOIN pc_product_categories c ON c.code = p.category_code WHERE v.id = ?`,
      variantId
    );
    if (!v || !v.active) throw pcError('NOT_FOUND', { field: `accessories[${i}].variant_id` });
    if (v.kind === 'filament') throw invalid(`accessories[${i}].variant_id`, 'filament_is_not_an_accessory');
    if (out.some((x) => x.variant_id === variantId)) throw invalid(`accessories[${i}].variant_id`, 'duplicate');
    out.push({ variant_id: variantId, qty });
  }
  return out;
}

export interface CreateJobInput {
  project_id: string;
  printer_model_id: string;
  plate_id?: string | null;
  title?: string;
  settings?: unknown;
  profile_id?: string | null;
  copies?: number;
  accessories?: unknown;
  depends_on_job_id?: string | null;
}

export async function createJob(db: D1Database, userId: string, input: CreateJobInput, config: PrintCloudConfig, now: Date): Promise<{ job_id: string; status: JobStatus }> {
  const project = await one<{ id: string; name: string; settings_json: string; status: string }>(
    db,
    'SELECT id, name, settings_json, status FROM pc_projects WHERE id = ? AND user_id = ?',
    input.project_id,
    userId
  );
  if (!project) throw pcError('NOT_FOUND', { field: 'project_id' });
  const model = await one<{ id: string; tier_id: string; active: number; model_name: string }>(
    db,
    'SELECT id, tier_id, active, model_name FROM pc_printer_models WHERE id = ?',
    input.printer_model_id
  );
  if (!model || !model.active) throw pcError('NOT_FOUND', { field: 'printer_model_id' });
  let plateLabel = '';
  if (input.plate_id) {
    const plate = await one<{ printer_model_id: string; valid: number; label: string }>(
      db,
      'SELECT printer_model_id, valid, label FROM pc_plates WHERE id = ? AND project_id = ?',
      input.plate_id,
      project.id
    );
    if (!plate) throw pcError('NOT_FOUND', { field: 'plate_id' });
    if (plate.printer_model_id !== model.id) throw pcError('INCOMPATIBLE_PRINTER', { reason: 'plate_for_another_model' });
    if (!plate.valid || (await plateIssues(db, project.id, input.plate_id)).length) throw invalid('plate_id', 'plate_not_valid');
    plateLabel = plate.label;
  }
  if (input.depends_on_job_id) {
    const dep = await one<{ id: string }>(db, 'SELECT id FROM pc_print_jobs WHERE id = ? AND user_id = ?', input.depends_on_job_id, userId);
    if (!dep) throw pcError('NOT_FOUND', { field: 'depends_on_job_id' });
  }
  let base: PrintSettings = parseJson(project.settings_json, DEFAULT_SETTINGS);
  if (input.profile_id) {
    const prof = await one<{ settings_json: string }>(db, 'SELECT settings_json FROM pc_print_profiles WHERE id = ? AND user_id = ?', input.profile_id, userId);
    if (!prof) throw pcError('NOT_FOUND', { field: 'profile_id' });
    base = parseJson(prof.settings_json, DEFAULT_SETTINGS);
  }
  const settings = parseSettings(input.settings, base);
  if (input.plate_id && settings.orientation === 'auto') throw invalid('settings.orientation', 'plate_needs_fixed_orientation');
  const copies = input.copies === undefined ? 1 : reqInt(input.copies, 'copies', { min: 1, max: 500 });
  const accessories = await parseAccessories(db, input.accessories);
  const active = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM pc_print_jobs WHERE user_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'reprint_requested')`,
    userId
  );
  if (Number(active?.n ?? 0) >= config.max_active_jobs_per_customer) throw pcError('LIMIT_REACHED', { max_active_jobs: config.max_active_jobs_per_customer });
  const models = await jobModels(db, project.id);
  if (!models.length) throw invalid('project_id', 'project_has_no_models');
  const jobId = pcId('pcj');
  const status: JobStatus = filesReady(models) ? 'uploaded' : 'draft';
  const instructions = settings.pause_at_layers.map((layer) => ({ kind: 'pause_at_layer', layer, note: 'insert accessories' }));
  const title = (typeof input.title === 'string' && input.title.trim() ? input.title.trim() : [project.name, plateLabel].filter(Boolean).join(' — ')).slice(0, 120);
  const s: Stmt[] = [
    db
      .prepare(
        `INSERT INTO pc_print_jobs (id, user_id, project_id, plate_id, printer_model_id, tier_id, title, status, settings_json, copies,
           needs_operator_approval, depends_on_job_id, operator_instructions_json, op_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        jobId,
        userId,
        project.id,
        input.plate_id ?? null,
        model.id,
        model.tier_id,
        title,
        status,
        JSON.stringify(settings),
        copies,
        config.require_operator_approval ? 1 : 0,
        input.depends_on_job_id ?? null,
        JSON.stringify(instructions),
        pcId('tok'),
        iso(now),
        iso(now)
      ),
    db
      .prepare(
        `INSERT INTO pc_print_job_events (id, job_id, from_status, to_status, event, actor_type, actor_id, detail_json, created_at)
         VALUES (?, ?, NULL, ?, 'created', 'customer', ?, '{}', ?)`
      )
      .bind(pcId('pcje'), jobId, status, userId, iso(now)),
  ];
  for (const a of accessories) {
    s.push(
      db
        .prepare("INSERT INTO pc_job_requirements (id, job_id, variant_id, kind, source, qty, created_at) VALUES (?, ?, ?, 'accessory', 'customer', ?, ?)")
        .bind(pcId('pcjr'), jobId, a.variant_id, a.qty, iso(now))
    );
  }
  await runBatch(db, s);
  return { job_id: jobId, status };
}

// ------------------------------------------------------------------ analysis

export interface SlicingInput {
  job_id: string;
  printer_model: { id: string; code: string; brand: string; model_name: string };
  settings: PrintSettings;
  copies: number;
  plate: Array<{ project_model_id: string; instance_no: number; x_um: number; y_um: number; rotation_z_mdeg: number; scale_ppm: number; variant_id: string | null }> | null;
  models: Array<{ project_model_id: string; file_id: string; quantity: number; transform: Record<string, unknown>; material_assignments: Array<{ part: string; variant_id: string }> }>;
  variants: Array<{ variant_id: string; sku: string; material: string | null; color_name: string; color_hex: string; diameter_um: number | null }>;
}

/** Everything a slicer needs to measure this job, after checking the job can be sliced at all. */
export async function slicingInput(db: D1Database, job: JobRow): Promise<SlicingInput> {
  return (await measuredInput(db, job)).input;
}

/** The slicing input, and the model rows it was read from (what an analysis fences on). */
async function measuredInput(db: D1Database, job: JobRow): Promise<{ input: SlicingInput; models: ModelInput[] }> {
  const models = await jobModels(db, job.project_id);
  if (!filesReady(models)) throw pcError('FILE_NOT_READY');
  const printer = await one<{ id: string; code: string; brand: string; model_name: string; max_colors: number; supported_materials_json: string; build_x_mm: number; build_y_mm: number; build_z_mm: number }>(
    db,
    'SELECT id, code, brand, model_name, max_colors, supported_materials_json, build_x_mm, build_y_mm, build_z_mm FROM pc_printer_models WHERE id = ?',
    job.printer_model_id
  );
  if (!printer) throw pcError('NOT_FOUND', { field: 'printer_model_id' });
  const variantIds = new Set<string>();
  const out: SlicingInput['models'] = [];
  for (const m of models) {
    const assignments = parseJson<Array<{ part: string; variant_id: string }>>(m.material_assignments_json, []);
    if (!assignments.length) throw invalid('material_assignments', 'every_model_needs_a_material');
    for (const a of assignments) variantIds.add(a.variant_id);
    const fit = fitsBuildVolume(
      { x: Number(m.size_x_um), y: Number(m.size_y_um), z: Number(m.size_z_um) },
      { x: printer.build_x_mm * 1000, y: printer.build_y_mm * 1000, z: printer.build_z_mm * 1000 }
    );
    if (!fit.any_orientation) throw pcError('INCOMPATIBLE_PRINTER', { reason: 'model_exceeds_build_volume', project_model_id: m.id });
    out.push({ project_model_id: m.id, file_id: m.file_id as string, quantity: Number(m.quantity), transform: parseJson(m.transform_json, {}), material_assignments: assignments });
  }
  const settings: PrintSettings = parseJson(job.settings_json, DEFAULT_SETTINGS);
  let plate: SlicingInput['plate'] = null;
  if (job.plate_id) {
    // The plate is checked again against the models as they are now; a layout cannot survive auto-orientation.
    if (settings.orientation === 'auto') throw invalid('settings.orientation', 'plate_needs_fixed_orientation');
    if ((await plateIssues(db, job.project_id, job.plate_id)).length) throw invalid('plate_id', 'plate_not_valid');
    plate = await many(
      db,
      'SELECT project_model_id, instance_no, x_um, y_um, rotation_z_mdeg, scale_ppm, variant_id FROM pc_plate_items WHERE plate_id = ? ORDER BY project_model_id, instance_no',
      job.plate_id
    );
    for (const it of plate) if (it.variant_id) variantIds.add(it.variant_id);
  }
  if (variantIds.size > printer.max_colors) throw pcError('INCOMPATIBLE_PRINTER', { reason: 'too_many_colours', colours: variantIds.size, max: printer.max_colors });
  const supported = parseJson<string[]>(printer.supported_materials_json, []).map((x) => x.toUpperCase());
  const variants: SlicingInput['variants'] = [];
  for (const id of variantIds) {
    const v = await one<{ id: string; sku: string; material: string | null; color_name: string; color_hex: string; diameter_um: number | null }>(
      db,
      'SELECT v.id, v.sku, p.material, v.color_name, v.color_hex, v.diameter_um FROM pc_variants v JOIN pc_products p ON p.id = v.product_id WHERE v.id = ?',
      id
    );
    if (!v) throw pcError('NOT_FOUND', { field: 'variant_id' });
    if (supported.length && v.material && !supported.includes(v.material.toUpperCase())) {
      throw pcError('INCOMPATIBLE_PRINTER', { reason: 'material_not_supported', material: v.material });
    }
    variants.push({ variant_id: v.id, sku: v.sku, material: v.material, color_name: v.color_name, color_hex: v.color_hex, diameter_um: v.diameter_um });
  }
  const input: SlicingInput = {
    job_id: job.id,
    printer_model: { id: printer.id, code: printer.code, brand: printer.brand, model_name: printer.model_name },
    settings,
    copies: job.copies,
    plate,
    models: out,
    variants,
  };
  return { input, models };
}

/**
 * The batch guard that the project's models are still exactly the rows the
 * plan read: an edit that lands between reading them and committing the
 * analysis would leave the slicer measuring files the job no longer prints.
 */
function modelsUnchanged(db: D1Database, projectId: string, models: ModelInput[]): Stmt {
  const read = models.map((m) => ({
    id: m.id,
    file_id: m.file_id,
    quantity: Number(m.quantity),
    transform_json: m.transform_json,
    material_assignments_json: m.material_assignments_json,
  }));
  return fence(
    db,
    'STATE_CHANGED',
    `(SELECT COUNT(*) FROM pc_project_models WHERE project_id = ?) = ?
     AND NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (
       SELECT 1 FROM pc_project_models m
        WHERE m.id = json_extract(e.value, '$.id') AND m.project_id = ? AND m.file_id IS json_extract(e.value, '$.file_id')
          AND m.quantity = json_extract(e.value, '$.quantity') AND m.transform_json = json_extract(e.value, '$.transform_json')
          AND m.material_assignments_json = json_extract(e.value, '$.material_assignments_json')))`,
    [projectId, read.length, JSON.stringify(read), projectId]
  );
}

/**
 * Ask for a real estimate. The job moves to `analyzing` and a slicing
 * request waits for a slicer (the workshop agent running a slicer CLI, or an
 * operator entering a desktop slicer's figures). With no slicer connected
 * (`slicerConnected`: printers.ts `slicerAvailability`, a slicer agent heard
 * from lately — never a token alone) the job simply waits in `analyzing`,
 * `awaiting_slicer` — no figure is ever invented.
 */
export async function requestAnalysis(db: D1Database, job: JobRow, actor: Actor, now: Date, slicerConnected: boolean) {
  let current = job;
  if (current.status === 'draft') {
    const models = await jobModels(db, job.project_id);
    if (!filesReady(models)) throw pcError('FILE_NOT_READY');
    await runBatch(db, transition(db, current, 'uploaded', actor, 'files_ready', now));
    current = await loadJob(db, job.id);
  }
  if (current.status !== 'uploaded') throw pcError('INVALID_TRANSITION', { from: current.status, to: 'analyzing' });
  const { input, models } = await measuredInput(db, current);
  const requestId = pcId('pcsr');
  // From here the project's models are frozen (projects.ts); the fence closes the gap before that.
  await runBatch(db, [
    ...transition(db, current, 'analyzing', actor, 'analysis_requested', now, { slicing_request_id: requestId }),
    modelsUnchanged(db, current.project_id, models),
    db
      .prepare(
        `INSERT INTO pc_slicing_requests (id, job_id, adapter, status, input_json, attempts, created_at, updated_at)
         VALUES (?, ?, 'agent', 'queued', ?, 0, ?, ?)`
      )
      .bind(requestId, current.id, JSON.stringify(input), iso(now), iso(now)),
  ]);
  return { job_id: current.id, status: 'analyzing' as const, slicing_request_id: requestId, slicer: slicerConnected ? 'queued' : 'awaiting_slicer' };
}

export interface EstimateInput {
  duration_seconds: number;
  layer_count?: number | null;
  color_changes?: number;
  materials: Array<{ variant_id: string; model_grams: number; support_grams: number; purge_grams: number }>;
  slicer_name?: string;
  slicer_version?: string;
  printer_profile?: string;
  compatible?: boolean;
  warnings?: string[];
  generated_config?: Record<string, unknown>;
}

export function parseEstimate(raw: unknown): EstimateInput {
  if (!raw || typeof raw !== 'object') throw invalid('estimate', 'object_required');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.materials) || !r.materials.length || r.materials.length > 16) throw invalid('materials', 'array_required');
  // A slicer reports filament per slot; two slots loaded from one spool are one variant, so its lines are summed
  // (an estimate and a job hold one row per variant).
  const byVariant = new Map<string, EstimateInput['materials'][number]>();
  for (const [i, m] of r.materials.entries()) {
    const o = (m ?? {}) as Record<string, unknown>;
    const line = {
      variant_id: reqString(o.variant_id, `materials[${i}].variant_id`, { max: 120 }),
      model_grams: reqInt(o.model_grams, `materials[${i}].model_grams`, { min: 0, max: 1_000_000 }),
      support_grams: reqInt(o.support_grams ?? 0, `materials[${i}].support_grams`, { min: 0, max: 1_000_000 }),
      purge_grams: reqInt(o.purge_grams ?? 0, `materials[${i}].purge_grams`, { min: 0, max: 1_000_000 }),
    };
    const seen = byVariant.get(line.variant_id);
    if (!seen) {
      byVariant.set(line.variant_id, line);
      continue;
    }
    for (const k of ['model_grams', 'support_grams', 'purge_grams'] as const) {
      seen[k] += line[k];
      if (seen[k] > 1_000_000) throw invalid(`materials[${i}].${k}`, 'too_large');
    }
  }
  const materials = [...byVariant.values()];
  return {
    duration_seconds: reqInt(r.duration_seconds, 'duration_seconds', { min: 1, max: 60 * 24 * 3600 }),
    layer_count: r.layer_count === undefined || r.layer_count === null ? null : reqInt(r.layer_count, 'layer_count', { min: 1, max: 1_000_000 }),
    color_changes: r.color_changes === undefined ? 0 : reqInt(r.color_changes, 'color_changes', { min: 0, max: 100_000 }),
    materials,
    slicer_name: typeof r.slicer_name === 'string' ? r.slicer_name.slice(0, 60) : '',
    slicer_version: typeof r.slicer_version === 'string' ? r.slicer_version.slice(0, 40) : '',
    printer_profile: typeof r.printer_profile === 'string' ? r.printer_profile.slice(0, 120) : '',
    compatible: r.compatible === undefined ? true : r.compatible === true,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string').map((w) => w.slice(0, 120)).slice(0, 20) : [],
    generated_config: r.generated_config && typeof r.generated_config === 'object' ? (r.generated_config as Record<string, unknown>) : {},
  };
}

/**
 * Record a MEASURED estimate (provenance 'slicer' from the agent, 'operator'
 * from a person reading a desktop slicer) and move the job to `ready` — or
 * back to `uploaded` when the slicer found the job incompatible. The
 * filament requirements become the estimate's grams per variant.
 */
export async function recordEstimate(
  db: D1Database,
  job: JobRow,
  e: EstimateInput,
  p: { provenance: 'slicer' | 'operator'; submittedBy: string; actor: Actor; slicingRequestId?: string | null; now: Date }
) {
  if (job.status !== 'analyzing') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'ready' });
  const input = await slicingInput(db, job);
  const allowed = new Set(input.variants.map((v) => v.variant_id));
  for (const m of e.materials) if (!allowed.has(m.variant_id)) throw invalid('materials', 'variant_not_assigned_to_job');
  const estimateId = pcId('pce');
  const sum = (k: 'model_grams' | 'support_grams' | 'purge_grams') => e.materials.reduce((s, m) => s + m[k], 0);
  const s: Stmt[] = [
    db
      .prepare(
        `INSERT INTO pc_estimates (id, job_id, slicing_request_id, provenance, slicer_name, slicer_version, printer_profile, duration_seconds,
           layer_count, model_grams, support_grams, purge_grams, color_changes, compatible, warnings_json, generated_config_json, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        estimateId,
        job.id,
        p.slicingRequestId ?? null,
        p.provenance,
        e.slicer_name ?? '',
        e.slicer_version ?? '',
        e.printer_profile ?? '',
        e.duration_seconds,
        e.layer_count ?? null,
        sum('model_grams'),
        sum('support_grams'),
        sum('purge_grams'),
        e.color_changes ?? 0,
        e.compatible === false ? 0 : 1,
        JSON.stringify(e.warnings ?? []),
        JSON.stringify(e.generated_config ?? {}).slice(0, 20000),
        p.submittedBy,
        iso(p.now)
      ),
  ];
  for (const m of e.materials) {
    s.push(
      db
        .prepare('INSERT INTO pc_estimate_materials (id, estimate_id, variant_id, model_grams, support_grams, purge_grams) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(pcId('pcem'), estimateId, m.variant_id, m.model_grams, m.support_grams, m.purge_grams)
    );
  }
  if (p.slicingRequestId) {
    s.push(
      db.prepare("UPDATE pc_slicing_requests SET status = 'succeeded', updated_at = ? WHERE id = ? AND status IN ('queued', 'claimed')").bind(iso(p.now), p.slicingRequestId)
    );
  } else {
    s.push(db.prepare("UPDATE pc_slicing_requests SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('queued', 'claimed')").bind(iso(p.now), job.id));
  }
  if (e.compatible === false) {
    s.push(...transition(db, job, 'uploaded', p.actor, 'estimate_incompatible', p.now, { estimate_id: estimateId, warnings: e.warnings }));
    s.push(notifyJob(db, job, 'estimate_unavailable', estimateId));
  } else {
    s.push(db.prepare("DELETE FROM pc_job_requirements WHERE job_id = ? AND kind = 'filament'").bind(job.id));
    for (const m of e.materials) {
      const grams = m.model_grams + m.support_grams + m.purge_grams;
      if (grams <= 0) continue;
      s.push(
        db
          .prepare("INSERT INTO pc_job_requirements (id, job_id, variant_id, kind, source, qty, usage_note, created_at) VALUES (?, ?, ?, 'filament', 'estimate', ?, ?, ?)")
          .bind(pcId('pcjr'), job.id, m.variant_id, grams, `model ${m.model_grams} g + support ${m.support_grams} g + purge ${m.purge_grams} g`, iso(p.now))
      );
    }
    s.push(...transition(db, job, 'ready', p.actor, 'estimate_recorded', p.now, { estimate_id: estimateId, provenance: p.provenance }, { estimate_id: estimateId }));
    s.push(notifyJob(db, job, 'estimate_ready', estimateId));
  }
  await runBatch(db, s);
  return { estimate_id: estimateId, status: e.compatible === false ? 'uploaded' : 'ready' };
}

/** The slicer could not measure the job: back to `uploaded`, the customer told why. */
export async function slicingFailed(db: D1Database, requestId: string, errorCode: string, actor: Actor, now: Date) {
  const req = await one<{ id: string; job_id: string; status: string }>(db, 'SELECT id, job_id, status FROM pc_slicing_requests WHERE id = ?', requestId);
  if (!req) throw pcError('NOT_FOUND');
  if (req.status !== 'claimed' && req.status !== 'queued') throw pcError('STATE_CHANGED');
  const job = await loadJob(db, req.job_id);
  await runBatch(db, [
    db
      .prepare("UPDATE pc_slicing_requests SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'claimed')")
      .bind(errorCode.slice(0, 80), iso(now), requestId),
    ...transition(db, job, 'uploaded', actor, 'analysis_failed', now, { error_code: errorCode }),
    notifyJob(db, job, 'estimate_unavailable', requestId),
  ]);
}

// ------------------------------------------------------------------ review and confirmation

export interface Requirement {
  variant_id: string;
  kind: 'filament' | 'accessory';
  qty: number;
}

export async function jobRequirements(db: D1Database, jobId: string): Promise<Requirement[]> {
  return many<Requirement>(db, 'SELECT variant_id, kind, qty FROM pc_job_requirements WHERE job_id = ? ORDER BY kind, variant_id', jobId);
}

async function currentEstimate(db: D1Database, job: JobRow): Promise<EstimateRow> {
  if (!job.estimate_id) throw pcError('ESTIMATE_REQUIRED');
  const e = await one<EstimateRow>(db, 'SELECT * FROM pc_estimates WHERE id = ?', job.estimate_id);
  if (!e) throw pcError('ESTIMATE_REQUIRED');
  return e;
}

/**
 * What confirming would do to the customer's balances: the hours and every
 * material needed, what is available now, and what would remain — plus the
 * top-up that would cover any shortfall. Reads only.
 */
export async function projection(db: D1Database, job: JobRow) {
  const est = await currentEstimate(db, job);
  const reqs = await jobRequirements(db, job.id);
  const acct = await one<{ available_seconds: number }>(db, 'SELECT available_seconds FROM pc_credit_accounts WHERE id = ?', creditAccountId(job.user_id, job.tier_id));
  const available = Number(acct?.available_seconds ?? 0);
  const materials = [];
  for (const r of reqs) {
    const a = await one<{ available_qty: number; unit_code: string }>(
      db,
      'SELECT available_qty, unit_code FROM pc_inventory_accounts WHERE id = ?',
      inventoryAccountId(job.user_id, r.variant_id)
    );
    const have = Number(a?.available_qty ?? 0);
    materials.push({
      variant_id: r.variant_id,
      kind: r.kind,
      required: r.qty,
      available: have,
      remaining_after: have - r.qty,
      sufficient: have >= r.qty,
      shortfall: Math.max(0, r.qty - have),
    });
  }
  return {
    estimate: {
      id: est.id,
      provenance: est.provenance,
      duration_seconds: est.duration_seconds,
      layer_count: est.layer_count,
      model_grams: est.model_grams,
      support_grams: est.support_grams,
      purge_grams: est.purge_grams,
      color_changes: est.color_changes,
      warnings: parseJson(est.warnings_json, []),
    },
    credits: {
      tier_id: job.tier_id,
      required_seconds: est.duration_seconds,
      available_seconds: available,
      remaining_after_seconds: available - est.duration_seconds,
      sufficient: available >= est.duration_seconds,
      shortfall_seconds: Math.max(0, est.duration_seconds - available),
    },
    materials,
    sufficient: available >= est.duration_seconds && materials.every((m) => m.sufficient),
  };
}

/**
 * ready → awaiting_confirmation, with the projection the customer confirms
 * against. Reviewing a job that already awaits confirmation renews its window
 * with a fresh projection: the way on once the window has passed, without
 * throwing away the measured estimate.
 */
export async function reviewJob(db: D1Database, job: JobRow, actor: Actor, config: PrintCloudConfig, now: Date) {
  if (job.status !== 'ready' && job.status !== 'awaiting_confirmation') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'awaiting_confirmation' });
  const proj = await projection(db, job);
  const expires = iso(addSeconds(now, config.confirmation_ttl_minutes * 60));
  if (job.status === 'ready') {
    await runBatch(db, transition(db, job, 'awaiting_confirmation', actor, 'reviewed', now, { sufficient: proj.sufficient }, { confirmation_expires_at: expires }));
  } else {
    // Same status, so not a transition: the same compare-and-swap on the token, and its own event.
    const token = pcId('tok');
    await runBatch(db, [
      db
        .prepare('UPDATE pc_print_jobs SET confirmation_expires_at = ?, op_token = ?, updated_at = ? WHERE id = ? AND status = ? AND op_token = ?')
        .bind(expires, token, iso(now), job.id, job.status, job.op_token),
      fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_print_jobs WHERE id = ?) = ?', [job.id, token]),
      jobEvent(db, job, 'review_renewed', actor, now, { sufficient: proj.sufficient, previous_expiry: job.confirmation_expires_at }),
    ]);
  }
  return { ...proj, status: 'awaiting_confirmation' as const, confirmation_expires_at: expires };
}

/**
 * Confirm: reserve the estimated seconds and every required material, per
 * variant, in ONE batch with the transition. The balance CHECKs refuse an
 * overdraw, so a job is either fully reserved or not confirmed at all.
 */
export async function planConfirm(db: D1Database, job: JobRow, actor: Actor, now: Date) {
  if (job.status !== 'awaiting_confirmation') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'confirmed' });
  if (job.confirmation_expires_at && job.confirmation_expires_at <= iso(now)) throw pcError('QUOTE_EXPIRED', { reason: 'confirmation_window_passed', action: 'review_again' });
  const est = await currentEstimate(db, job);
  const reqs = await jobRequirements(db, job.id);
  // Hours whose package expired go first, so this reservation can only hold hours that are still good.
  await expireDueCredits(db, job.user_id, job.tier_id, now);
  const s: Stmt[] = [];
  s.push(...reserveCredits(db, { userId: job.user_id, tierId: job.tier_id, jobId: job.id, seconds: est.duration_seconds, actorId: actor.id, now }).statements);
  for (const r of reqs) {
    s.push(
      ...reserveInventory(db, { userId: job.user_id, variantId: r.variant_id, qty: r.qty, purpose: 'print_job', refId: job.id, actorId: actor.id, now }).statements
    );
  }
  const to: JobStatus = job.needs_operator_approval ? 'confirmed' : 'queued';
  const confirmedToken = pcId('tok');
  s.push(...transition(db, job, 'confirmed', actor, 'confirmed', now, { reserved_seconds: est.duration_seconds, materials: reqs }, {}, confirmedToken));
  if (to === 'queued') {
    // No operator approval needed: on to the queue in the same batch, through `confirmed` like every job.
    s.push(...transition(db, { ...job, status: 'confirmed', op_token: confirmedToken }, 'queued', actor, 'queued_without_approval', now, {}, { queued_at: iso(now) }));
    s.push(queueEntry(db, job, now));
    s.push(notifyJob(db, job, 'job_queued', 'confirm'));
  }
  s.push(...(await pcAudit(db, actor.id, 'job.confirm', job.id, { reserved_seconds: est.duration_seconds, materials: reqs })));
  return { statements: s, result: { job_id: job.id, status: to, reserved_seconds: est.duration_seconds, reserved_materials: reqs } };
}

export function queueEntry(db: D1Database, job: JobRow, now: Date): Stmt {
  return db
    .prepare("INSERT INTO pc_queue_entries (id, job_id, priority, enqueued_at, state, updated_at) VALUES (?, ?, ?, ?, 'waiting', ?)")
    .bind(pcId('pcqe'), job.id, job.priority, iso(now), iso(now));
}

/**
 * Operator approval: confirmed → queued. Only a CONFIRMED job — the customer
 * confirmed it and its hours and materials are reserved — is approved; the
 * batch also proves its hours are still held.
 */
export async function approveJob(db: D1Database, job: JobRow, actor: Actor, now: Date) {
  if (job.status !== 'confirmed') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'queued' });
  const s = [
    ...transition(db, job, 'queued', actor, 'approved', now, {}, { approved_by: actor.id, approved_at: iso(now), queued_at: iso(now) }),
    fence(db, 'STATE_CHANGED', "EXISTS (SELECT 1 FROM pc_credit_reservations WHERE job_id = ? AND state = 'active')", [job.id]),
    queueEntry(db, job, now),
    notifyJob(db, job, 'job_queued', 'approve'),
    ...(await pcAudit(db, actor.id, 'job.approve', job.id)),
  ];
  await runBatch(db, s);
}

/** Every release a job's reservations need — credits and each material — exactly once each. */
async function releaseAll(db: D1Database, job: JobRow, actor: Actor, now: Date, note: string): Promise<Stmt[]> {
  const s: Stmt[] = [];
  const credit = await activeReservationForJob(db, job.id);
  if (credit) s.push(...releaseCredits(db, credit, actor.id, now, note));
  for (const r of await activeInventoryReservations(db, 'print_job', job.id)) s.push(...releaseInventory(db, r, actor.id, now, note));
  return s;
}

/** Cancel: reservations released, queue entry removed, an assignment let go, the slicer told to stop. */
export async function cancelJob(db: D1Database, job: JobRow, actor: Actor, now: Date, reason: string) {
  if (actor.type === 'customer' && !CUSTOMER_CANCELLABLE.includes(job.status)) throw pcError('INVALID_TRANSITION', { from: job.status, to: 'cancelled' });
  const released = await releaseAll(db, job, actor, now, `cancelled: ${reason}`);
  const s: Stmt[] = [
    ...transition(db, job, 'cancelled', actor, 'cancelled', now, { reason }, { ended_at: iso(now) }),
    ...released,
    db.prepare("UPDATE pc_queue_entries SET state = 'removed', updated_at = ? WHERE job_id = ? AND state <> 'removed'").bind(iso(now), job.id),
    db.prepare("UPDATE pc_printer_assignments SET state = 'released', ended_at = ? WHERE job_id = ? AND state = 'active'").bind(iso(now), job.id),
    db.prepare("UPDATE pc_slicing_requests SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('queued', 'claimed')").bind(iso(now), job.id),
  ];
  if (released.length) s.push(notifyJob(db, job, 'job_cancelled', 'cancel'));
  s.push(...(await pcAudit(db, actor.id, 'job.cancel', job.id, { from: job.status, reason })));
  await runBatch(db, s);
}

/** Back to editing: an estimate no longer matches settings that changed. Only before anything is reserved. */
export async function editJob(db: D1Database, job: JobRow, actor: Actor, body: Record<string, unknown>, now: Date) {
  if (!['draft', 'uploaded', 'ready', 'awaiting_confirmation'].includes(job.status)) throw pcError('INVALID_TRANSITION', { from: job.status, to: 'draft' });
  const settings = parseSettings(body.settings, parseJson(job.settings_json, DEFAULT_SETTINGS));
  const copies = body.copies === undefined ? job.copies : reqInt(body.copies, 'copies', { min: 1, max: 500 });
  const accessories = body.accessories === undefined ? null : await parseAccessories(db, body.accessories);
  const s: Stmt[] = [];
  const set = { settings_json: JSON.stringify(settings), copies, estimate_id: null, confirmation_expires_at: null };
  if (job.status === 'draft') {
    const token = pcId('tok');
    s.push(
      db
        .prepare('UPDATE pc_print_jobs SET settings_json = ?, copies = ?, op_token = ?, updated_at = ? WHERE id = ? AND status = ? AND op_token = ?')
        .bind(set.settings_json, copies, token, iso(now), job.id, job.status, job.op_token),
      fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_print_jobs WHERE id = ?) = ?', [job.id, token]),
      jobEvent(db, job, 'edited', actor, now)
    );
  } else {
    s.push(...transition(db, job, 'draft', actor, 'edited', now, {}, set));
  }
  s.push(db.prepare("DELETE FROM pc_job_requirements WHERE job_id = ? AND kind = 'filament'").bind(job.id));
  if (accessories) {
    s.push(db.prepare("DELETE FROM pc_job_requirements WHERE job_id = ? AND kind = 'accessory'").bind(job.id));
    for (const a of accessories) {
      s.push(
        db
          .prepare("INSERT INTO pc_job_requirements (id, job_id, variant_id, kind, source, qty, created_at) VALUES (?, ?, ?, 'accessory', 'customer', ?, ?)")
          .bind(pcId('pcjr'), job.id, a.variant_id, a.qty, iso(now))
      );
    }
  }
  await runBatch(db, s);
}

// ------------------------------------------------------------------ the workshop floor

export async function startJob(db: D1Database, job: JobRow, actor: Actor, now: Date) {
  const assignment = await one<{ id: string; printer_id: string }>(db, "SELECT id, printer_id FROM pc_printer_assignments WHERE job_id = ? AND state = 'active'", job.id);
  if (!assignment) throw pcError('PRINTER_UNAVAILABLE', { reason: 'not_assigned' });
  await runBatch(db, [
    ...transition(db, job, 'printing', actor, 'started', now, { printer_id: assignment.printer_id }, { started_at: iso(now) }),
    notifyJob(db, job, 'job_started', 'start'),
    ...(await pcAudit(db, actor.id, 'job.start', job.id, { printer_id: assignment.printer_id })),
  ]);
}

export async function pauseJob(db: D1Database, job: JobRow, actor: Actor, now: Date, reason: string) {
  await runBatch(db, [...transition(db, job, 'paused', actor, 'paused', now, { reason }), ...(await pcAudit(db, actor.id, 'job.pause', job.id, { reason }))]);
}

export async function resumeJob(db: D1Database, job: JobRow, actor: Actor, now: Date) {
  await runBatch(db, [...transition(db, job, 'printing', actor, 'resumed', now), ...(await pcAudit(db, actor.id, 'job.resume', job.id))]);
}

export interface ConsumptionInput {
  printed_seconds: number;
  /** Actual units per variant. A reserved variant not listed is taken as used exactly as reserved. */
  materials: Array<{ variant_id: string; qty: number }>;
}

export function parseConsumption(raw: Record<string, unknown>): ConsumptionInput {
  const printed = reqInt(raw.printed_seconds, 'printed_seconds', { min: 0, max: 60 * 24 * 3600 });
  const list = raw.materials === undefined ? [] : raw.materials;
  if (!Array.isArray(list) || list.length > 32) throw invalid('materials', 'array_required');
  const materials = list.map((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>;
    return { variant_id: reqString(o.variant_id, `materials[${i}].variant_id`, { max: 120 }), qty: reqInt(o.qty, `materials[${i}].qty`, { min: 0, max: 10_000_000 }) };
  });
  if (new Set(materials.map((m) => m.variant_id)).size !== materials.length) throw invalid('materials', 'duplicate_variant');
  return { printed_seconds: printed, materials };
}

interface SettlementPlan {
  statements: Stmt[];
  billedSeconds: number;
  creditValue: number;
  materialValue: number;
  materials: Array<{ variant_id: string; actual: number; billed: number; released: number; workshop_absorbed: number }>;
}

/**
 * Settle every reservation of a job against what is billable, and take the
 * physical units off the shelf: billed units from the customer's allocation,
 * any unbilled units the workshop absorbs from its own stock.
 */
async function settleJob(
  db: D1Database,
  job: JobRow,
  billable: { seconds: number; physicalSeconds: number; materials: Map<string, { billable: number; physical: number }> },
  policy: { time: 'cap_at_reserved' | 'charge_from_balance'; material: 'cap_at_reserved' | 'charge_from_balance' },
  actor: Actor,
  now: Date,
  note: string
): Promise<SettlementPlan> {
  const s: Stmt[] = [];
  let billedSeconds = 0;
  let creditValue = 0;
  let materialValue = 0;
  const credit = await activeReservationForJob(db, job.id);
  if (credit) {
    const out = await settleCredits(db, credit, billable.seconds, policy.time, actor.id, now, note);
    s.push(...out.statements);
    billedSeconds = out.consumedFromReservation + out.overage;
    creditValue = out.value;
  }
  const materials: SettlementPlan['materials'] = [];
  // One plan of the shelf for the whole batch: a variant's billed grams and the grams the
  // workshop absorbs are drawn from its lots one after the other, never twice from one snapshot.
  const lots: BatchLots = new Map();
  const takeOffShelf = async (move: Omit<PhysicalMove, 'refType' | 'refId' | 'actorId' | 'now'>) => {
    s.push(...(await removePhysical(db, { ...move, refType: 'print_job', refId: job.id, actorId: actor.id, now }, lots)).statements);
  };
  const reservations = await activeInventoryReservations(db, 'print_job', job.id);
  const seen = new Set<string>();
  for (const r of reservations) {
    seen.add(r.variant_id);
    const use = billable.materials.get(r.variant_id) ?? { billable: r.qty_reserved, physical: r.qty_reserved };
    const out = await settleInventory(db, r, use.billable, { type: 'consume', policy: policy.material, projectId: job.project_id, actorId: actor.id, now, note });
    s.push(...out.statements);
    materialValue += out.value;
    if (out.billed > 0) {
      await takeOffShelf({
        variantId: r.variant_id,
        qty: out.billed,
        type: 'consume_customer',
        fromAllocated: true,
        userId: job.user_id,
        entryKey: `consume_customer:${job.id}:${r.variant_id}`,
      });
    }
    const absorbed = Math.max(0, use.physical - out.billed);
    if (absorbed > 0) {
      await takeOffShelf({ variantId: r.variant_id, qty: absorbed, type: 'consume_workshop', fromAllocated: false, entryKey: `consume_workshop:${job.id}:${r.variant_id}`, reason: note });
    }
    materials.push({ variant_id: r.variant_id, actual: use.physical, billed: out.billed, released: out.released, workshop_absorbed: absorbed });
  }
  // A variant used that was never reserved (an unplanned purge colour): the workshop's own stock, never the customer's.
  for (const [variantId, use] of billable.materials) {
    if (seen.has(variantId) || use.physical <= 0) continue;
    await takeOffShelf({
      variantId,
      qty: use.physical,
      type: 'consume_workshop',
      fromAllocated: false,
      entryKey: `consume_workshop:${job.id}:${variantId}`,
      reason: 'not reserved for this job',
    });
    materials.push({ variant_id: variantId, actual: use.physical, billed: 0, released: 0, workshop_absorbed: use.physical });
  }
  return { statements: s, billedSeconds, creditValue, materialValue, materials };
}

async function finishAssignment(db: D1Database, job: JobRow, printedSeconds: number, now: Date): Promise<Stmt[]> {
  const a = await one<{ id: string; printer_id: string }>(db, "SELECT id, printer_id FROM pc_printer_assignments WHERE job_id = ? AND state = 'active'", job.id);
  if (!a) return [];
  return [
    db.prepare("UPDATE pc_printer_assignments SET state = 'finished', ended_at = ? WHERE id = ? AND state = 'active'").bind(iso(now), a.id),
    db.prepare('UPDATE pc_printers SET operating_seconds = operating_seconds + ?, updated_at = ? WHERE id = ?').bind(printedSeconds, iso(now), a.printer_id),
    db.prepare("UPDATE pc_queue_entries SET state = 'removed', updated_at = ? WHERE job_id = ? AND state <> 'removed'").bind(iso(now), job.id),
  ];
}

/**
 * Completion with VERIFIED consumption: reservations settled (billed and
 * released), the shelf reduced, the printer freed, the customer told — one
 * batch. Re-sending the same completion finds the job already completed
 * (INVALID_TRANSITION) and every settlement fenced: nothing is billed twice.
 */
export async function completeJob(
  db: D1Database,
  job: JobRow,
  consumption: ConsumptionInput,
  actor: Actor,
  config: PrintCloudConfig,
  now: Date,
  recordId?: string
) {
  if (job.status !== 'printing') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'completed' });
  const mats = new Map(consumption.materials.map((m) => [m.variant_id, { billable: m.qty, physical: m.qty }]));
  const plan = await settleJob(
    db,
    job,
    { seconds: consumption.printed_seconds, physicalSeconds: consumption.printed_seconds, materials: mats },
    { time: config.time_overage_policy, material: config.material_overage_policy },
    actor,
    now,
    'print completed'
  );
  const consumptionId = recordId ?? pcId('pccr');
  const s: Stmt[] = [
    ...transition(db, job, 'completed', actor, 'completed', now, { billed_seconds: plan.billedSeconds, materials: plan.materials }, {
      ended_at: iso(now),
      billable_seconds: plan.billedSeconds,
      printed_seconds: consumption.printed_seconds,
    }),
    ...plan.statements,
    ...(await finishAssignment(db, job, consumption.printed_seconds, now)),
  ];
  if (recordId) {
    s.push(db.prepare('UPDATE pc_consumption_records SET verified = 1, verified_by = ?, verified_at = ? WHERE id = ? AND verified = 0').bind(actor.id, iso(now), recordId));
  } else {
    s.push(
      db
        .prepare(
          `INSERT INTO pc_consumption_records (id, job_id, reported_by_type, reported_by, printed_seconds, materials_json, verified, verified_by, verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .bind(consumptionId, job.id, actor.type === 'agent' ? 'agent' : actor.type === 'admin' ? 'admin' : 'operator', actor.id, consumption.printed_seconds, JSON.stringify(consumption.materials), actor.id, iso(now), iso(now))
    );
  }
  s.push(notifyJob(db, job, 'job_completed', 'complete'));
  s.push(
    integrationEvent(db, {
      adapter: 'accounting',
      kind: 'revenue.recognized',
      refId: job.id,
      payload: { credit_value_iqd: plan.creditValue, material_value_iqd: plan.materialValue, billed_seconds: plan.billedSeconds },
      now,
    })
  );
  s.push(...(await pcAudit(db, actor.id, 'job.complete', job.id, { billed_seconds: plan.billedSeconds, materials: plan.materials })));
  await runBatch(db, s);
  return { job_id: job.id, status: 'completed' as const, billed_seconds: plan.billedSeconds, materials: plan.materials };
}

/** An agent's completion report, held for an operator's verification when the setting asks for it. */
export async function reportCompletion(db: D1Database, job: JobRow, consumption: ConsumptionInput, actor: Actor, now: Date) {
  if (job.status !== 'printing') throw pcError('INVALID_TRANSITION', { from: job.status, to: 'completed' });
  // A report re-sent while the first waits for verification is the same report.
  const pending = await one<{ id: string }>(db, 'SELECT id FROM pc_consumption_records WHERE job_id = ? AND verified = 0 ORDER BY created_at LIMIT 1', job.id);
  if (pending) return { consumption_record_id: pending.id, status: 'awaiting_verification' as const };
  const id = pcId('pccr');
  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO pc_consumption_records (id, job_id, reported_by_type, reported_by, printed_seconds, materials_json, verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .bind(id, job.id, actor.type === 'agent' ? 'agent' : 'operator', actor.id, consumption.printed_seconds, JSON.stringify(consumption.materials), iso(now)),
    jobEvent(db, job, 'completion_reported', actor, now, { consumption_record_id: id }),
  ]);
  return { consumption_record_id: id, status: 'awaiting_verification' as const };
}

// ------------------------------------------------------------------ failures

export interface FailureReport {
  reason_code: string;
  responsible: Responsible;
  description: string;
  printed_seconds: number;
  failed_materials: Array<{ variant_id: string; qty: number }>;
}

export function parseFailure(raw: Record<string, unknown>): FailureReport {
  const c = parseConsumption({ printed_seconds: raw.printed_seconds ?? 0, materials: raw.failed_materials ?? [] });
  const responsible = (raw.responsible ?? 'undetermined') as Responsible;
  if (!['workshop', 'customer', 'model', 'undetermined'].includes(responsible)) throw invalid('responsible', 'not_allowed');
  return {
    reason_code: reqString(raw.reason_code, 'reason_code', { max: 60 }),
    responsible,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 2000) : '',
    printed_seconds: c.printed_seconds,
    failed_materials: c.materials,
  };
}

/** The print failed: the job stops, the printer is freed, the reservations wait for the failure to be resolved. */
export async function failJob(db: D1Database, job: JobRow, report: FailureReport, actor: Actor, now: Date) {
  if (!['preparing', 'printing', 'paused'].includes(job.status)) throw pcError('INVALID_TRANSITION', { from: job.status, to: 'failed' });
  const failureId = pcId('pcfl');
  const s: Stmt[] = [
    ...transition(db, job, 'failed', actor, 'failed', now, { reason_code: report.reason_code, responsible: report.responsible }, {
      ended_at: iso(now),
      failure_id: failureId,
      printed_seconds: report.printed_seconds,
    }),
    db
      .prepare(
        `INSERT INTO pc_failures (id, job_id, reason_code, responsible, description, printed_seconds, failed_materials_json, status, reported_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?)`
      )
      .bind(failureId, job.id, report.reason_code, report.responsible, report.description, report.printed_seconds, JSON.stringify(report.failed_materials), actor.id, iso(now)),
    ...(await finishAssignment(db, job, report.printed_seconds, now)),
    notifyJob(db, job, 'job_failed', failureId),
    ...(await pcAudit(db, actor.id, 'job.fail', job.id, { failure_id: failureId, ...report })),
  ];
  await runBatch(db, s);
  return { failure_id: failureId };
}

export interface FailureDecision {
  responsible: Responsible;
  /** For 'manual_review' only: the seconds and units the customer is charged. */
  billable_seconds?: number;
  billable_materials?: Array<{ variant_id: string; qty: number }>;
  reprint: boolean;
  note: string;
}

/**
 * Resolve a failure under the policy for the responsible party:
 *
 *   no_charge       nothing billed; every reservation released; the failed
 *                   grams come off the WORKSHOP's own stock (verified
 *                   workshop failure: the customer loses nothing);
 *   charge_printed  the printed seconds and the failed units billed (never
 *                   beyond what was reserved under the cap policy), the rest
 *                   released;
 *   manual_review   an administrator states what is billable.
 *
 * Optionally a reprint is created. The failure row's own status is fenced, so
 * a second resolution cannot settle anything again.
 */
export async function resolveFailure(db: D1Database, failureId: string, decision: FailureDecision, actor: Actor, config: PrintCloudConfig, now: Date) {
  const failure = await one<{ id: string; job_id: string; status: string; printed_seconds: number; failed_materials_json: string; reason_code: string }>(
    db,
    'SELECT id, job_id, status, printed_seconds, failed_materials_json, reason_code FROM pc_failures WHERE id = ?',
    failureId
  );
  if (!failure) throw pcError('NOT_FOUND');
  if (failure.status !== 'reported') throw pcError('INVALID_TRANSITION', { reason: 'already_resolved' });
  const job = await loadJob(db, failure.job_id);
  if (job.status !== 'failed') throw pcError('INVALID_TRANSITION', { from: job.status });
  const policy = config.failure_policy[decision.responsible];
  const failed = parseJson<Array<{ variant_id: string; qty: number }>>(failure.failed_materials_json, []);
  const physical = new Map(failed.map((m) => [m.variant_id, m.qty]));
  let billSeconds = 0;
  const billMaterials = new Map<string, number>();
  if (policy === 'charge_printed') {
    billSeconds = failure.printed_seconds;
    for (const [v, q] of physical) billMaterials.set(v, q);
  } else if (policy === 'manual_review') {
    if (decision.billable_seconds === undefined) throw invalid('billable_seconds', 'required_for_manual_review');
    billSeconds = decision.billable_seconds;
    for (const m of decision.billable_materials ?? []) billMaterials.set(m.variant_id, m.qty);
  }
  const variants = new Set([...physical.keys(), ...billMaterials.keys()]);
  const materials = new Map<string, { billable: number; physical: number }>();
  for (const v of variants) materials.set(v, { billable: billMaterials.get(v) ?? 0, physical: Math.max(physical.get(v) ?? 0, billMaterials.get(v) ?? 0) });
  // A reserved variant the failure report does not mention was not used: bill none, release it.
  for (const r of await activeInventoryReservations(db, 'print_job', job.id)) if (!materials.has(r.variant_id)) materials.set(r.variant_id, { billable: 0, physical: 0 });
  // Under a failure the customer is never charged beyond what was reserved.
  const plan = await settleJob(
    db,
    job,
    { seconds: billSeconds, physicalSeconds: failure.printed_seconds, materials },
    { time: 'cap_at_reserved', material: 'cap_at_reserved' },
    actor,
    now,
    `failure ${failure.reason_code} (${decision.responsible}, ${policy})`
  );
  const token = pcId('tok');
  const reprintEligible = decision.responsible === 'workshop' ? config.free_reprint_on_workshop_failure : true;
  const reprint = decision.reprint && reprintEligible;
  const s: Stmt[] = [
    db
      .prepare(
        `UPDATE pc_failures SET status = 'resolved', responsible = ?, policy = ?, billable_seconds = ?, reprint_eligible = ?, resolution_json = ?,
                resolved_by = ?, resolved_at = ?, reprint_job_id = ?
          WHERE id = ? AND status = 'reported'`
      )
      .bind(decision.responsible, policy, plan.billedSeconds, reprintEligible ? 1 : 0, JSON.stringify({ note: decision.note, token, materials: plan.materials }), actor.id, iso(now), null, failureId),
    fence(db, 'STATE_CHANGED', "(SELECT json_extract(resolution_json, '$.token') FROM pc_failures WHERE id = ?) = ?", [failureId, token]),
    ...plan.statements,
    db.prepare('UPDATE pc_print_jobs SET billable_seconds = ?, updated_at = ? WHERE id = ?').bind(plan.billedSeconds, iso(now), job.id),
    jobEvent(db, job, 'failure_resolved', actor, now, { failure_id: failureId, responsible: decision.responsible, policy, billed_seconds: plan.billedSeconds }),
  ];
  let reprintJobId: string | null = null;
  if (reprint) {
    reprintJobId = pcId('pcj');
    s.push(...(await reprintStatements(db, job, reprintJobId, decision.responsible === 'workshop', actor, now)));
    s.push(db.prepare('UPDATE pc_failures SET reprint_job_id = ? WHERE id = ?').bind(reprintJobId, failureId));
    s.push(...transition(db, job, 'reprint_requested', actor, 'reprint_created', now, { reprint_job_id: reprintJobId }));
    s.push(notifyJob(db, job, 'reprint_created', reprintJobId));
  }
  s.push(
    integrationEvent(db, {
      adapter: 'accounting',
      kind: 'revenue.recognized',
      refId: `${job.id}:failure`,
      payload: { credit_value_iqd: plan.creditValue, material_value_iqd: plan.materialValue, billed_seconds: plan.billedSeconds, policy },
      now,
    })
  );
  s.push(...(await pcAudit(db, actor.id, 'failure.resolve', failureId, { job_id: job.id, responsible: decision.responsible, policy, billed_seconds: plan.billedSeconds, reprint_job_id: reprintJobId })));
  await runBatch(db, s);
  return { failure_id: failureId, policy, billed_seconds: plan.billedSeconds, materials: plan.materials, reprint_job_id: reprintJobId };
}

/** A fresh job with the failed job's project, plate, settings and estimate, ready for confirmation. */
async function reprintStatements(db: D1Database, job: JobRow, newJobId: string, workshopFault: boolean, actor: Actor, now: Date): Promise<Stmt[]> {
  const s: Stmt[] = [];
  let estimateId: string | null = null;
  if (job.estimate_id) {
    const est = await one<Record<string, unknown>>(db, 'SELECT * FROM pc_estimates WHERE id = ?', job.estimate_id);
    if (est) {
      estimateId = pcId('pce');
      s.push(
        db
          .prepare(
            `INSERT INTO pc_estimates (id, job_id, slicing_request_id, provenance, slicer_name, slicer_version, printer_profile, duration_seconds, layer_count,
               model_grams, support_grams, purge_grams, color_changes, compatible, warnings_json, generated_config_json, submitted_by, created_at)
             SELECT ?, ?, slicing_request_id, provenance, slicer_name, slicer_version, printer_profile, duration_seconds, layer_count,
                    model_grams, support_grams, purge_grams, color_changes, compatible, warnings_json, generated_config_json, submitted_by, ?
               FROM pc_estimates WHERE id = ?`
          )
          .bind(estimateId, newJobId, iso(now), job.estimate_id)
      );
    }
  }
  s.splice(
    0,
    0,
    db
      .prepare(
        `INSERT INTO pc_print_jobs (id, user_id, project_id, plate_id, printer_model_id, tier_id, title, status, settings_json, copies, estimate_id,
           priority, needs_operator_approval, depends_on_job_id, parent_job_id, operator_instructions_json, op_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .bind(
        newJobId,
        job.user_id,
        job.project_id,
        job.plate_id,
        job.printer_model_id,
        job.tier_id,
        `${job.title}`.slice(0, 110),
        estimateId ? 'ready' : 'uploaded',
        job.settings_json,
        job.copies,
        workshopFault ? job.priority + 10 : job.priority,
        workshopFault ? 0 : job.needs_operator_approval,
        job.id,
        job.operator_instructions_json,
        pcId('tok'),
        iso(now),
        iso(now)
      )
  );
  if (estimateId) {
    s.push(
      db
        .prepare(
          `INSERT INTO pc_estimate_materials (id, estimate_id, variant_id, model_grams, support_grams, purge_grams)
           SELECT 'pcem_' || lower(hex(randomblob(10))), ?, variant_id, model_grams, support_grams, purge_grams FROM pc_estimate_materials WHERE estimate_id = ?`
        )
        .bind(estimateId, job.estimate_id),
      db.prepare('UPDATE pc_print_jobs SET estimate_id = ? WHERE id = ?').bind(estimateId, newJobId)
    );
  }
  s.push(
    db
      .prepare(
        `INSERT INTO pc_job_requirements (id, job_id, variant_id, kind, source, qty, usage_note, created_at)
         SELECT 'pcjr_' || lower(hex(randomblob(10))), ?, variant_id, kind, source, qty, usage_note, ? FROM pc_job_requirements WHERE job_id = ?`
      )
      .bind(newJobId, iso(now), job.id),
    db
      .prepare(
        `INSERT INTO pc_print_job_events (id, job_id, from_status, to_status, event, actor_type, actor_id, detail_json, created_at)
         VALUES (?, ?, NULL, ?, 'created_as_reprint', ?, ?, ?, ?)`
      )
      .bind(pcId('pcje'), newJobId, estimateId ? 'ready' : 'uploaded', actor.type, actor.id, JSON.stringify({ parent_job_id: job.id, workshop_fault: workshopFault }), iso(now))
  );
  return s;
}

/**
 * A free reprint after a verified workshop failure is confirmed on the
 * customer's behalf when their balance covers it; otherwise it waits in
 * `ready` for them (and they were told). Never forced through.
 */
export async function autoConfirmReprint(db: D1Database, jobId: string, config: PrintCloudConfig, now: Date): Promise<'queued' | 'confirmed' | 'waiting_for_customer'> {
  const actor: Actor = { type: 'system', id: 'system' };
  try {
    const job = await loadJob(db, jobId);
    if (job.status !== 'ready') return 'waiting_for_customer';
    // A balance that cannot cover it leaves the reprint where it is.
    if (!(await projection(db, job)).sufficient) return 'waiting_for_customer';
    await reviewJob(db, job, actor, config, now);
  } catch {
    return 'waiting_for_customer';
  }
  try {
    const result = await planned(db, async () => planConfirm(db, await loadJob(db, jobId), actor, now));
    return result.status === 'queued' ? 'queued' : 'confirmed';
  } catch {
    // Reviewed, then refused (the balance moved in between): back to `ready` for the customer.
    try {
      const job = await loadJob(db, jobId);
      if (job.status === 'awaiting_confirmation') {
        await runBatch(db, transition(db, job, 'ready', actor, 'auto_confirm_failed', now, {}, { confirmation_expires_at: null }));
      }
    } catch {
      // The customer moved it first; whatever they did stands.
    }
    return 'waiting_for_customer';
  }
}

// ------------------------------------------------------------------ reads

export async function jobView(db: D1Database, job: JobRow, staleSeconds: number, now: Date) {
  const events = await many<Record<string, unknown>>(
    db,
    // rowid keeps one batch's events (confirmed, then queued) in the order they were written.
    'SELECT from_status, to_status, event, actor_type, detail_json, created_at FROM pc_print_job_events WHERE job_id = ? ORDER BY created_at, rowid',
    job.id
  );
  const requirements = await jobRequirements(db, job.id);
  const estimate = job.estimate_id ? await one<EstimateRow>(db, 'SELECT * FROM pc_estimates WHERE id = ?', job.estimate_id) : null;
  const estimateMaterials = estimate ? await many<Record<string, unknown>>(db, 'SELECT variant_id, model_grams, support_grams, purge_grams FROM pc_estimate_materials WHERE estimate_id = ?', estimate.id) : [];
  const credit = await one<Record<string, unknown>>(
    db,
    'SELECT id, seconds_reserved, seconds_consumed, seconds_released, state FROM pc_credit_reservations WHERE job_id = ? ORDER BY created_at DESC LIMIT 1',
    job.id
  );
  const inventory = await many<Record<string, unknown>>(
    db,
    "SELECT variant_id, qty_reserved, qty_consumed, qty_released, state FROM pc_inventory_reservations WHERE purpose = 'print_job' AND ref_id = ? ORDER BY variant_id",
    job.id
  );
  const assignment = await one<{ printer_id: string; name: string; assigned_at: string }>(
    db,
    "SELECT a.printer_id, p.name, a.assigned_at FROM pc_printer_assignments a JOIN pc_printers p ON p.id = a.printer_id WHERE a.job_id = ? AND a.state = 'active'",
    job.id
  );
  let telemetry: Record<string, unknown> | null = null;
  if (assignment) {
    const t = await one<Record<string, unknown>>(
      db,
      'SELECT machine_state, job_id, progress_permille, layer, total_layers, remaining_seconds, nozzle_temp_dc, bed_temp_dc, received_at FROM pc_printer_telemetry WHERE printer_id = ?',
      assignment.printer_id
    );
    if (t) {
      const age = (now.getTime() - Date.parse(String(t.received_at))) / 1000;
      const live = age <= staleSeconds && t.job_id === job.id;
      telemetry = { ...t, stale: age > staleSeconds, live, age_seconds: Math.max(0, Math.floor(age)) };
    }
  }
  const failure = job.failure_id ? await one<Record<string, unknown>>(db, 'SELECT id, reason_code, responsible, status, policy, billable_seconds, reprint_job_id, created_at, resolved_at FROM pc_failures WHERE id = ?', job.failure_id) : null;
  return {
    id: job.id,
    project_id: job.project_id,
    plate_id: job.plate_id,
    printer_model_id: job.printer_model_id,
    tier_id: job.tier_id,
    title: job.title,
    status: job.status,
    settings: parseJson(job.settings_json, DEFAULT_SETTINGS),
    copies: job.copies,
    priority: job.priority,
    needs_operator_approval: !!job.needs_operator_approval,
    depends_on_job_id: job.depends_on_job_id,
    parent_job_id: job.parent_job_id,
    operator_instructions: parseJson(job.operator_instructions_json, []),
    confirmation_expires_at: job.confirmation_expires_at,
    queued_at: job.queued_at,
    started_at: job.started_at,
    ended_at: job.ended_at,
    billable_seconds: job.billable_seconds,
    printed_seconds: job.printed_seconds,
    estimate: estimate ? { ...estimate, warnings: parseJson(estimate.warnings_json, []), materials: estimateMaterials } : null,
    requirements,
    reservations: { credits: credit, materials: inventory },
    printer: assignment ? { printer_id: assignment.printer_id, name: assignment.name, assigned_at: assignment.assigned_at } : null,
    telemetry,
    failure,
    events: events.map((e) => ({ ...e, detail: parseJson(String(e.detail_json), {}), detail_json: undefined })),
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}
