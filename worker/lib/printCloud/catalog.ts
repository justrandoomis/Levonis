/**
 * THE PRINT CLOUD CATALOGUE: credit tiers, printer models, physical printers,
 * credit packages, conversion rules, materials and accessories, promotions,
 * warehouse locations and accessory rules (docs/PRINT_CLOUD.md §2).
 *
 * Every editable entity is described ONCE by an `EntitySpec`: its fields,
 * how each is validated, and which are MONEY (prices — a full admin's act,
 * recorded in `pc_price_changes`) or COST (what the workshop paid — the
 * owner's alone, stripped from every other reader). The admin routes, the
 * OpenAPI document and the cost projection all read the same specs, so a
 * field cannot be priced in one place and leak in another.
 *
 * Nothing here is a hardcoded printer: «X2D Combo» is a row an admin creates.
 */
import { many, one, type Stmt } from './db';
import { invalid, pcError } from './errors';
import { iso, optIso, pcId } from './util';

export type FieldKind = 'string' | 'text' | 'code' | 'int' | 'bool' | 'enum' | 'iso' | 'json_array' | 'json_object' | 'ref';

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  required?: boolean;
  min?: number;
  max?: number;
  values?: readonly string[];
  /** A price: changing it is a money act and is recorded in pc_price_changes. */
  money?: boolean;
  /** What the workshop paid: owner-only to read and write. */
  cost?: boolean;
  /** May be set on create only. */
  immutable?: boolean;
}

export interface EntitySpec {
  key: string;
  table: string;
  idPrefix: string;
  fields: readonly FieldSpec[];
  /** The ORDER BY of the admin list. */
  order: string;
}

const NAME_FIELDS: FieldSpec[] = [
  { name: 'name_ar', kind: 'string', required: true, max: 200 },
  { name: 'name_en', kind: 'string', required: true, max: 200 },
  { name: 'name_ckb', kind: 'string', required: true, max: 200 },
];

export const ENTITIES = {
  tiers: {
    key: 'tiers',
    table: 'pc_credit_tiers',
    idPrefix: 'pct',
    order: 'code',
    fields: [
      { name: 'code', kind: 'code', required: true, immutable: true },
      ...NAME_FIELDS,
      { name: 'description_json', kind: 'json_object' },
      { name: 'hourly_rate_iqd', kind: 'int', required: true, min: 0, max: 100_000_000, money: true },
      { name: 'custom_hours_enabled', kind: 'bool', money: true },
      { name: 'min_custom_seconds', kind: 'int', min: 60, max: 10_000_000, money: true },
      { name: 'custom_step_seconds', kind: 'int', min: 60, max: 10_000_000, money: true },
      { name: 'active', kind: 'bool' },
    ],
  },
  printer_models: {
    key: 'printer_models',
    table: 'pc_printer_models',
    idPrefix: 'pcpm',
    order: 'brand, model_name',
    fields: [
      { name: 'tier_id', kind: 'ref', required: true },
      { name: 'code', kind: 'code', required: true, immutable: true },
      { name: 'brand', kind: 'string', required: true, max: 80 },
      { name: 'model_name', kind: 'string', required: true, max: 120 },
      { name: 'build_x_mm', kind: 'int', required: true, min: 1, max: 5000 },
      { name: 'build_y_mm', kind: 'int', required: true, min: 1, max: 5000 },
      { name: 'build_z_mm', kind: 'int', required: true, min: 1, max: 5000 },
      { name: 'nozzle_options_um', kind: 'json_array' },
      { name: 'extruder_config', kind: 'enum', values: ['single', 'dual', 'idex', 'toolchanger'] },
      { name: 'ams_systems_json', kind: 'json_array' },
      { name: 'max_colors', kind: 'int', min: 1, max: 64 },
      { name: 'supported_materials_json', kind: 'json_array' },
      { name: 'max_nozzle_temp_c', kind: 'int', min: 0, max: 600 },
      { name: 'max_bed_temp_c', kind: 'int', min: 0, max: 300 },
      { name: 'enclosed', kind: 'bool' },
      { name: 'camera', kind: 'bool' },
      { name: 'average_power_w', kind: 'int', min: 0, max: 10000 },
      { name: 'quality_rank', kind: 'int', min: 0, max: 100 },
      { name: 'spec_json', kind: 'json_object' },
      { name: 'levonis_product_id', kind: 'string', max: 80 },
      { name: 'active', kind: 'bool' },
    ],
  },
  printers: {
    key: 'printers',
    table: 'pc_printers',
    idPrefix: 'pcpr',
    order: 'name',
    fields: [
      { name: 'model_id', kind: 'ref', required: true },
      { name: 'name', kind: 'string', required: true, max: 120 },
      { name: 'serial_number', kind: 'string', required: true, max: 120 },
      { name: 'equipment_code', kind: 'string', required: true, max: 80 },
      { name: 'location', kind: 'string', max: 200 },
      { name: 'nozzle_um', kind: 'int', min: 100, max: 2000 },
      { name: 'ams_slots', kind: 'int', min: 0, max: 64 },
      { name: 'materials_json', kind: 'json_array' },
      { name: 'camera', kind: 'bool' },
      { name: 'status', kind: 'enum', values: ['active', 'maintenance', 'retired'] },
      { name: 'adapter', kind: 'enum', values: ['manual', 'agent'] },
      { name: 'connection_ref', kind: 'string', max: 200 },
      { name: 'agent_id', kind: 'ref' },
      { name: 'acquisition_cost_iqd', kind: 'int', min: 0, max: 10_000_000_000, cost: true },
      { name: 'acquired_at', kind: 'iso', cost: true },
      { name: 'expected_life_hours', kind: 'int', min: 1, max: 1_000_000, cost: true },
      { name: 'residual_value_iqd', kind: 'int', min: 0, max: 10_000_000_000, cost: true },
      { name: 'maintenance_reserve_iqd_per_hour', kind: 'int', min: 0, max: 10_000_000, cost: true },
      { name: 'notes', kind: 'text', max: 2000 },
    ],
  },
  packages: {
    key: 'packages',
    table: 'pc_credit_packages',
    idPrefix: 'pcpk',
    order: 'tier_id, sort, seconds',
    fields: [
      { name: 'tier_id', kind: 'ref', required: true, immutable: true },
      { name: 'code', kind: 'code', required: true, immutable: true },
      ...NAME_FIELDS,
      { name: 'kind', kind: 'enum', values: ['standard', 'promotional', 'bundle'] },
      // The hours of a package are what customers bought; never changed under them.
      { name: 'seconds', kind: 'int', required: true, min: 60, max: 100_000_000, immutable: true },
      { name: 'price_iqd', kind: 'int', required: true, min: 0, max: 1_000_000_000, money: true },
      { name: 'min_quantity', kind: 'int', min: 1, max: 1000 },
      { name: 'max_quantity', kind: 'int', min: 1, max: 1000 },
      { name: 'max_per_customer', kind: 'int', min: 1, max: 100_000 },
      { name: 'expires_after_days', kind: 'int', min: 1, max: 3650, money: true },
      { name: 'bundle_json', kind: 'json_array', money: true },
      { name: 'valid_from', kind: 'iso' },
      { name: 'valid_until', kind: 'iso' },
      { name: 'sort', kind: 'int', min: -1000, max: 1000 },
      { name: 'active', kind: 'bool' },
    ],
  },
  conversion_rules: {
    key: 'conversion_rules',
    table: 'pc_credit_conversion_rules',
    idPrefix: 'pccv',
    order: 'from_tier_id, to_tier_id',
    fields: [
      { name: 'from_tier_id', kind: 'ref', required: true, immutable: true },
      { name: 'to_tier_id', kind: 'ref', required: true, immutable: true },
      { name: 'ratio_num', kind: 'int', required: true, min: 1, max: 1_000_000, money: true },
      { name: 'ratio_den', kind: 'int', required: true, min: 1, max: 1_000_000, money: true },
      { name: 'enabled', kind: 'bool', money: true },
    ],
  },
  products: {
    key: 'products',
    table: 'pc_products',
    idPrefix: 'pcp',
    order: 'category_code, name_en',
    fields: [
      { name: 'category_code', kind: 'ref', required: true },
      { name: 'brand', kind: 'string', max: 80 },
      ...NAME_FIELDS,
      { name: 'description_json', kind: 'json_object' },
      { name: 'material', kind: 'string', max: 40 },
      { name: 'grade', kind: 'string', max: 40 },
      { name: 'tags_json', kind: 'json_array' },
      { name: 'levonis_product_id', kind: 'string', max: 80 },
      { name: 'active', kind: 'bool' },
    ],
  },
  variants: {
    key: 'variants',
    table: 'pc_variants',
    idPrefix: 'pcv',
    order: 'product_id, sku',
    fields: [
      { name: 'product_id', kind: 'ref', required: true, immutable: true },
      { name: 'sku', kind: 'code', required: true, immutable: true },
      ...NAME_FIELDS,
      { name: 'color_name', kind: 'string', max: 80 },
      { name: 'color_hex', kind: 'string', max: 9 },
      { name: 'diameter_um', kind: 'int', min: 100, max: 5000 },
      // A variant's base unit is what every balance of it is counted in: fixed at creation.
      { name: 'unit_code', kind: 'ref', required: true, immutable: true },
      { name: 'min_purchase_qty', kind: 'int', min: 1, max: 10_000_000 },
      { name: 'purchase_step_qty', kind: 'int', min: 1, max: 10_000_000 },
      { name: 'max_purchase_qty', kind: 'int', min: 1, max: 10_000_000 },
      { name: 'max_per_customer_qty', kind: 'int', min: 1, max: 100_000_000 },
      { name: 'fulfillment_modes_json', kind: 'json_array' },
      { name: 'low_stock_threshold_qty', kind: 'int', min: 0, max: 100_000_000 },
      { name: 'attributes_json', kind: 'json_object' },
      { name: 'levonis_variant_ref', kind: 'string', max: 120 },
      { name: 'active', kind: 'bool' },
    ],
  },
  promotions: {
    key: 'promotions',
    table: 'pc_promotions',
    idPrefix: 'pcpromo',
    order: 'created_at',
    fields: [
      { name: 'code', kind: 'code', immutable: true },
      ...NAME_FIELDS,
      { name: 'scope', kind: 'string', required: true, max: 80, money: true },
      { name: 'percent_bps', kind: 'int', min: 0, max: 10000, money: true },
      { name: 'amount_off_iqd', kind: 'int', min: 0, max: 100_000_000, money: true },
      { name: 'min_subtotal_iqd', kind: 'int', min: 0, max: 1_000_000_000, money: true },
      { name: 'membership', kind: 'string', max: 40, money: true },
      { name: 'starts_at', kind: 'iso' },
      { name: 'ends_at', kind: 'iso' },
      { name: 'max_redemptions', kind: 'int', min: 1, max: 10_000_000 },
      { name: 'active', kind: 'bool' },
    ],
  },
  locations: {
    key: 'locations',
    table: 'pc_warehouse_locations',
    idPrefix: 'pcloc',
    order: 'code',
    fields: [
      { name: 'code', kind: 'code', required: true, immutable: true },
      { name: 'name', kind: 'string', required: true, max: 120 },
      { name: 'active', kind: 'bool' },
    ],
  },
  accessory_rules: {
    key: 'accessory_rules',
    table: 'pc_accessory_rules',
    idPrefix: 'pcar',
    order: 'keyword, project_type',
    fields: [
      { name: 'keyword', kind: 'string', max: 60 },
      { name: 'project_type', kind: 'string', max: 40 },
      { name: 'variant_id', kind: 'ref', required: true },
      { name: 'qty_per_item', kind: 'int', min: 1, max: 1000 },
      { name: 'needs_pause_at_layer', kind: 'bool' },
      { name: 'note_ar', kind: 'text', max: 500 },
      { name: 'note_en', kind: 'text', max: 500 },
      { name: 'note_ckb', kind: 'text', max: 500 },
      { name: 'active', kind: 'bool' },
    ],
  },
} as const satisfies Record<string, EntitySpec>;

export type EntityKey = keyof typeof ENTITIES;

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Entities whose rows carry no created_at/updated_at pair of their own. */
const NO_UPDATED_AT = new Set(['pc_warehouse_locations', 'pc_accessory_rules']);

function validateField(f: FieldSpec, v: unknown): unknown {
  if (v === null) {
    if (f.required) throw invalid(f.name, 'required');
    return null;
  }
  switch (f.kind) {
    case 'string':
    case 'text': {
      if (typeof v !== 'string') throw invalid(f.name, 'not_a_string');
      const s = v.trim();
      if (f.required && !s) throw invalid(f.name, 'required');
      if (s.length > (f.max ?? 200)) throw invalid(f.name, 'too_long');
      return s;
    }
    case 'code':
      if (typeof v !== 'string' || !CODE_RE.test(v)) throw invalid(f.name, 'code_format');
      return v;
    case 'ref':
      if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(v)) throw invalid(f.name, 'reference');
      return v;
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalid(f.name, 'integer_required');
      if (f.min !== undefined && v < f.min) throw invalid(f.name, 'too_small');
      if (f.max !== undefined && v > f.max) throw invalid(f.name, 'too_large');
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw invalid(f.name, 'boolean_required');
      return v ? 1 : 0;
    case 'enum':
      if (typeof v !== 'string' || !(f.values ?? []).includes(v)) throw invalid(f.name, 'not_allowed');
      return v;
    case 'iso':
      return optIso(v, f.name);
    case 'json_array':
      if (!Array.isArray(v) || v.length > 200) throw invalid(f.name, 'array_required');
      return JSON.stringify(v).length > 20000 ? (() => { throw invalid(f.name, 'too_large'); })() : JSON.stringify(v);
    case 'json_object':
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(f.name, 'object_required');
      return JSON.stringify(v).length > 20000 ? (() => { throw invalid(f.name, 'too_large'); })() : JSON.stringify(v);
  }
}

/** Entity-specific rules the field specs cannot say alone. */
function crossCheck(spec: EntitySpec, row: Record<string, unknown>): void {
  if (spec.key === 'variants') {
    const modes = JSON.parse(String(row.fulfillment_modes_json ?? '["inventory","delivery","project"]')) as unknown[];
    if (!modes.length || modes.some((m) => !['inventory', 'delivery', 'project'].includes(String(m)))) {
      throw invalid('fulfillment_modes_json', 'not_allowed');
    }
    if (row.color_hex && !/^#[0-9A-Fa-f]{6}$/.test(String(row.color_hex))) throw invalid('color_hex', 'format');
  }
  if (spec.key === 'printer_models') {
    const nozzles = JSON.parse(String(row.nozzle_options_um ?? '[400]')) as unknown[];
    if (!nozzles.length || nozzles.some((n) => !Number.isSafeInteger(n) || (n as number) < 100 || (n as number) > 2000)) {
      throw invalid('nozzle_options_um', 'not_allowed');
    }
    const mats = JSON.parse(String(row.supported_materials_json ?? '[]')) as unknown[];
    if (mats.some((m) => typeof m !== 'string' || !/^[A-Za-z0-9+_-]{1,20}$/.test(m))) throw invalid('supported_materials_json', 'not_allowed');
  }
  if (spec.key === 'printers') {
    const mats = JSON.parse(String(row.materials_json ?? '[]')) as unknown[];
    if (mats.some((m) => typeof m !== 'string' || !/^[A-Za-z0-9+_-]{1,20}$/.test(m))) throw invalid('materials_json', 'not_allowed');
  }
  if (spec.key === 'promotions') {
    if (!/^(all|credits|materials|tier:[A-Za-z0-9_.:-]+|variant:[A-Za-z0-9_.:-]+|category:[a-z_]+)$/.test(String(row.scope ?? ''))) {
      throw invalid('scope', 'format');
    }
    if (!row.percent_bps && !row.amount_off_iqd) throw invalid('percent_bps', 'no_discount');
  }
  if (spec.key === 'packages' && row.min_quantity !== undefined && row.max_quantity !== undefined) {
    if (Number(row.max_quantity) < Number(row.min_quantity)) throw invalid('max_quantity', 'below_min');
  }
  if (spec.key === 'accessory_rules') {
    if (!row.keyword && !row.project_type) throw invalid('keyword', 'required');
    if (row.keyword) row.keyword = String(row.keyword).toLowerCase();
  }
}

export interface FieldAccess {
  canWriteCost: boolean;
  canMoveMoney: boolean;
}

function assertWritable(f: FieldSpec, access: FieldAccess): void {
  if (f.cost && !access.canWriteCost) throw pcError('FORBIDDEN', { field: f.name, reason: 'cost_owner_only' }, 403);
  if (f.money && !access.canMoveMoney) throw pcError('FORBIDDEN', { field: f.name, reason: 'financial_scope_required' }, 403);
}

/** Validate a create body against the spec and build its INSERT. */
export function createEntity(
  db: D1Database,
  spec: EntitySpec,
  body: Record<string, unknown>,
  access: FieldAccess,
  now: Date
): { id: string; statements: Stmt[]; row: Record<string, unknown> } {
  const known = new Set(spec.fields.map((f) => f.name));
  for (const k of Object.keys(body)) if (!known.has(k) && k !== 'id') throw invalid(k, 'unknown_field');
  const row: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (body[f.name] === undefined) {
      if (f.required) throw invalid(f.name, 'required');
      continue;
    }
    assertWritable(f, access);
    row[f.name] = validateField(f, body[f.name]);
  }
  crossCheck(spec, row);
  const id = pcId(spec.idPrefix);
  const cols = ['id', ...Object.keys(row)];
  const values: unknown[] = [id, ...Object.values(row)];
  cols.push('created_at');
  values.push(iso(now));
  if (!NO_UPDATED_AT.has(spec.table)) {
    cols.push('updated_at');
    values.push(iso(now));
  }
  const statements = [db.prepare(`INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...values)];
  return { id, statements, row: { id, ...row } };
}

/**
 * Validate a patch and build its UPDATE. A changed MONEY field writes a
 * `pc_price_changes` row in the same batch. Prices already paid live on the
 * order lines and lots, so nothing here can change a purchased balance.
 */
export async function updateEntity(
  db: D1Database,
  spec: EntitySpec,
  id: string,
  body: Record<string, unknown>,
  access: FieldAccess,
  actorId: string,
  now: Date
): Promise<{ statements: Stmt[]; before: Record<string, unknown>; changed: string[] }> {
  const before = await one<Record<string, unknown>>(db, `SELECT * FROM ${spec.table} WHERE id = ?`, id);
  if (!before) throw pcError('NOT_FOUND');
  const byName = new Map(spec.fields.map((f) => [f.name, f]));
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const f = byName.get(k);
    if (!f) throw invalid(k, 'unknown_field');
    if (f.immutable) throw invalid(k, 'immutable');
    assertWritable(f, access);
    patch[k] = validateField(f, v);
  }
  if (!Object.keys(patch).length) throw invalid('body', 'empty');
  crossCheck(spec, { ...before, ...patch });
  const changed = Object.keys(patch).filter((k) => before[k] !== patch[k]);
  const sets = Object.keys(patch).map((k) => `${k} = ?`);
  const values = Object.values(patch);
  if (!NO_UPDATED_AT.has(spec.table)) {
    sets.push('updated_at = ?');
    values.push(iso(now));
  }
  const statements: Stmt[] = [db.prepare(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id)];
  const moneyChanged = changed.filter((k) => byName.get(k)?.money);
  if (moneyChanged.length) {
    statements.push(
      priceChangeStmt(
        db,
        spec.key,
        id,
        Object.fromEntries(moneyChanged.map((k) => [k, before[k]])),
        Object.fromEntries(moneyChanged.map((k) => [k, patch[k]])),
        actorId,
        now
      )
    );
  }
  return { statements, before, changed };
}

export function priceChangeStmt(
  db: D1Database,
  entityType: string,
  entityId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  actorId: string,
  now: Date
): Stmt {
  return db
    .prepare('INSERT INTO pc_price_changes (id, entity_type, entity_id, before_json, after_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(pcId('pcpc'), entityType, entityId, JSON.stringify(before), JSON.stringify(after), actorId, iso(now));
}

/** The names of an entity's cost fields — removed from every reader but the owner. */
export const costFields = (spec: EntitySpec): string[] => spec.fields.filter((f) => f.cost).map((f) => f.name);

export function stripCost<T extends Record<string, unknown>>(spec: EntitySpec, row: T, canViewCost: boolean): T {
  if (canViewCost) return row;
  const out: Record<string, unknown> = { ...row };
  for (const k of costFields(spec)) delete out[k];
  return out as T;
}

export async function listEntity(db: D1Database, spec: EntitySpec, limit = 500): Promise<Record<string, unknown>[]> {
  return many<Record<string, unknown>>(db, `SELECT * FROM ${spec.table} ORDER BY ${spec.order} LIMIT ?`, limit);
}

// ------------------------------------------------------------------ price tiers

export interface PriceTierInput {
  mode: 'pack' | 'bracket';
  min_qty: number;
  pack_price_iqd?: number;
  unit_price_milli_iqd?: number;
}

/**
 * Replace a variant's active price tiers. The old tiers are deactivated (not
 * deleted) and the change is recorded, so the history of what a gram cost is
 * never lost — and no quote or order reads the tier table after it is made.
 */
export async function replacePriceTiers(
  db: D1Database,
  variantId: string,
  tiers: unknown,
  actorId: string,
  now: Date
): Promise<{ statements: Stmt[]; tiers: PriceTierInput[] }> {
  const variant = await one<{ id: string; purchase_step_qty: number; min_purchase_qty: number }>(
    db,
    'SELECT id, purchase_step_qty, min_purchase_qty FROM pc_variants WHERE id = ?',
    variantId
  );
  if (!variant) throw pcError('NOT_FOUND');
  if (!Array.isArray(tiers) || !tiers.length || tiers.length > 30) throw invalid('tiers', 'array_required');
  const parsed: PriceTierInput[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of tiers.entries()) {
    if (!raw || typeof raw !== 'object') throw invalid(`tiers[${i}]`, 'object_required');
    const t = raw as Record<string, unknown>;
    const mode = t.mode;
    if (mode !== 'pack' && mode !== 'bracket') throw invalid(`tiers[${i}].mode`, 'not_allowed');
    const minQty = t.min_qty;
    if (typeof minQty !== 'number' || !Number.isSafeInteger(minQty) || minQty < 1 || minQty > 100_000_000) throw invalid(`tiers[${i}].min_qty`, 'integer_required');
    const key = `${mode}:${minQty}`;
    if (seen.has(key)) throw invalid(`tiers[${i}]`, 'duplicate');
    seen.add(key);
    if (mode === 'pack') {
      const price = t.pack_price_iqd;
      if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0 || price > 1_000_000_000) throw invalid(`tiers[${i}].pack_price_iqd`, 'integer_required');
      parsed.push({ mode, min_qty: minQty, pack_price_iqd: price });
    } else {
      const unit = t.unit_price_milli_iqd;
      if (typeof unit !== 'number' || !Number.isSafeInteger(unit) || unit < 0 || unit > 1_000_000_000) throw invalid(`tiers[${i}].unit_price_milli_iqd`, 'integer_required');
      parsed.push({ mode, min_qty: minQty, unit_price_milli_iqd: unit });
    }
  }
  const before = await many<Record<string, unknown>>(
    db,
    'SELECT mode, min_qty, pack_price_iqd, unit_price_milli_iqd FROM pc_price_tiers WHERE variant_id = ? AND active = 1 ORDER BY mode, min_qty',
    variantId
  );
  const statements: Stmt[] = [db.prepare('UPDATE pc_price_tiers SET active = 0, updated_at = ? WHERE variant_id = ? AND active = 1').bind(iso(now), variantId)];
  for (const t of parsed) {
    statements.push(
      db
        .prepare(
          `INSERT INTO pc_price_tiers (id, variant_id, mode, min_qty, pack_price_iqd, unit_price_milli_iqd, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(pcId('pcpt'), variantId, t.mode, t.min_qty, t.pack_price_iqd ?? null, t.unit_price_milli_iqd ?? null, iso(now), iso(now))
    );
  }
  statements.push(priceChangeStmt(db, 'price_tiers', variantId, { tiers: before }, { tiers: parsed }, actorId, now));
  return { statements, tiers: parsed };
}

// ------------------------------------------------------------------ public reads

export async function publicPrinterModels(db: D1Database) {
  return many<Record<string, unknown>>(
    db,
    `SELECT m.id, m.code, m.brand, m.model_name, m.tier_id, t.code AS tier_code, t.name_ar AS tier_name_ar, t.name_en AS tier_name_en,
            t.name_ckb AS tier_name_ckb, m.build_x_mm, m.build_y_mm, m.build_z_mm, m.nozzle_options_um, m.extruder_config,
            m.ams_systems_json, m.max_colors, m.supported_materials_json, m.max_nozzle_temp_c, m.max_bed_temp_c, m.enclosed, m.camera,
            m.quality_rank, m.spec_json,
            (SELECT COUNT(*) FROM pc_printers p WHERE p.model_id = m.id AND p.status = 'active') AS machines_active,
            (SELECT COUNT(*) FROM pc_printers p WHERE p.model_id = m.id AND p.status = 'active'
               AND NOT EXISTS (SELECT 1 FROM pc_printer_assignments a WHERE a.printer_id = p.id AND a.state = 'active')) AS machines_idle
       FROM pc_printer_models m JOIN pc_credit_tiers t ON t.id = m.tier_id
      WHERE m.active = 1 AND t.active = 1
      ORDER BY m.brand, m.model_name`
  );
}

export async function publicPackages(db: D1Database, now: Date, tierId?: string | null) {
  return many<Record<string, unknown>>(
    db,
    `SELECT id, tier_id, code, name_ar, name_en, name_ckb, kind, seconds, price_iqd, min_quantity, max_quantity, max_per_customer,
            expires_after_days, bundle_json, valid_from, valid_until, sort
       FROM pc_credit_packages
      WHERE active = 1 AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)
        ${tierId ? 'AND tier_id = ?' : ''}
      ORDER BY tier_id, sort, seconds`,
    ...(tierId ? [iso(now), iso(now), tierId] : [iso(now), iso(now)])
  );
}

export async function publicStoreCatalog(db: D1Database, category?: string | null) {
  const variants = await many<Record<string, unknown>>(
    db,
    `SELECT v.id, v.product_id, v.sku, v.name_ar, v.name_en, v.name_ckb, v.color_name, v.color_hex, v.diameter_um, v.unit_code,
            v.min_purchase_qty, v.purchase_step_qty, v.max_purchase_qty, v.max_per_customer_qty, v.fulfillment_modes_json,
            p.category_code, p.brand, p.material, p.grade, p.name_ar AS product_name_ar, p.name_en AS product_name_en,
            p.name_ckb AS product_name_ckb, p.tags_json,
            MAX(0, COALESCE(s.on_hand_qty, 0) - COALESCE(s.reserved_qty, 0) - COALESCE(s.allocated_qty, 0)) AS sellable_qty
       FROM pc_variants v
       JOIN pc_products p ON p.id = v.product_id
       LEFT JOIN pc_stock_positions s ON s.variant_id = v.id
      WHERE v.active = 1 AND p.active = 1 ${category ? 'AND p.category_code = ?' : ''}
      ORDER BY p.category_code, p.name_en, v.name_en`,
    ...(category ? [category] : [])
  );
  const tiers = await many<{ variant_id: string; mode: string; min_qty: number; pack_price_iqd: number | null; unit_price_milli_iqd: number | null }>(
    db,
    `SELECT t.variant_id, t.mode, t.min_qty, t.pack_price_iqd, t.unit_price_milli_iqd
       FROM pc_price_tiers t JOIN pc_variants v ON v.id = t.variant_id
      WHERE t.active = 1 AND v.active = 1 ORDER BY t.variant_id, t.mode, t.min_qty`
  );
  const byVariant = new Map<string, typeof tiers>();
  for (const t of tiers) byVariant.set(t.variant_id, [...(byVariant.get(t.variant_id) ?? []), t]);
  return variants.map((v) => ({ ...v, price_tiers: byVariant.get(String(v.id)) ?? [] }));
}

export async function categories(db: D1Database) {
  return many<Record<string, unknown>>(
    db,
    'SELECT code, kind, name_ar, name_en, name_ckb, buyback_enabled, buyback_rate_bps, storable, sort FROM pc_product_categories ORDER BY sort'
  );
}

/** A category's buyback switch and rate: a money act, recorded like a price. */
export async function updateCategoryBuyback(
  db: D1Database,
  code: string,
  body: Record<string, unknown>,
  actorId: string,
  now: Date
): Promise<Stmt[]> {
  const before = await one<{ buyback_enabled: number; buyback_rate_bps: number }>(
    db,
    'SELECT buyback_enabled, buyback_rate_bps FROM pc_product_categories WHERE code = ?',
    code
  );
  if (!before) throw pcError('NOT_FOUND');
  const enabled = body.buyback_enabled === undefined ? before.buyback_enabled : body.buyback_enabled === true ? 1 : body.buyback_enabled === false ? 0 : -1;
  if (enabled === -1) throw invalid('buyback_enabled', 'boolean_required');
  const rate = body.buyback_rate_bps === undefined ? before.buyback_rate_bps : body.buyback_rate_bps;
  if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate < 0 || rate > 10000) throw invalid('buyback_rate_bps', 'integer_required');
  return [
    db.prepare('UPDATE pc_product_categories SET buyback_enabled = ?, buyback_rate_bps = ? WHERE code = ?').bind(enabled, rate, code),
    priceChangeStmt(db, 'category_buyback', code, { ...before }, { buyback_enabled: enabled, buyback_rate_bps: rate }, actorId, now),
  ];
}
