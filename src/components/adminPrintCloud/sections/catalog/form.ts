/**
 * The catalogue form's arithmetic: a row read into form values, the values
 * checked the way catalog.ts `validateField` and `crossCheck` will check them,
 * and the body a create or an update sends.
 *
 *   CREATE sends what the admin may write and filled in (the database
 *   defaults the rest — the form shows those defaults, it does not invent
 *   them: `CREATE_DEFAULTS` are migration 0215's column defaults).
 *   UPDATE sends only the fields whose value changed, and never an immutable
 *   one, a price without money scope, or a cost without the owner.
 */
import type { Row } from '../../api';
import { parseJsonColumn } from '../../api';
import { CODE_RE, HEX_RE, MATERIAL_RE, REF_RE, SCOPE_RE, type ClientEntity, type ClientField } from '../../catalogFields';
import { fromLocalInput, toLocalInput } from '../../format';
import type { BundleLine } from './fieldInputs';

export type FormValue = string | number | null | boolean | string[] | number[] | BundleLine[] | Row;
export type FormValues = Record<string, FormValue>;

export interface Access {
  money: boolean;
  costRead: boolean;
  costWrite: boolean;
}

/** Migration 0215's column defaults, shown on a new row so the admin sees what the database will store. */
export const CREATE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, FormValue>>>> = {
  tiers: { custom_hours_enabled: false, min_custom_seconds: 3600, custom_step_seconds: 3600, active: true },
  printer_models: { nozzle_options_um: [400], extruder_config: 'single', max_colors: 1, enclosed: false, camera: false, average_power_w: 0, quality_rank: 0, active: true },
  printers: { nozzle_um: 400, ams_slots: 0, camera: false, status: 'active', adapter: 'manual', maintenance_reserve_iqd_per_hour: 0 },
  packages: { kind: 'standard', min_quantity: 1, max_quantity: 10, sort: 0, active: true },
  conversion_rules: { enabled: false },
  products: { active: true },
  variants: { min_purchase_qty: 1, purchase_step_qty: 1, max_purchase_qty: 100000, fulfillment_modes_json: ['inventory', 'delivery', 'project'], low_stock_threshold_qty: 0, active: true },
  promotions: { percent_bps: 0, amount_off_iqd: 0, min_subtotal_iqd: 0, active: true },
  locations: { active: true },
  accessory_rules: { qty_per_item: 1, needs_pause_at_layer: false, active: true },
};

/** May this admin write `f` at all? */
export const writable = (f: ClientField, a: Access): boolean => (!f.cost || a.costWrite) && (!f.money || a.money);
/** Is `f` drawn for this admin? A cost field is not even drawn for a reader who may not see it. */
export const visible = (f: ClientField, a: Access): boolean => !f.cost || a.costRead;

function emptyOf(f: ClientField): FormValue {
  switch (f.kind) {
    case 'int':
      return null;
    case 'bool':
      return false;
    case 'json_array':
      return [];
    case 'json_object':
      return f.editor === 'json' ? '{}' : {};
    default:
      return '';
  }
}

/** The form values of a new row. */
export function formDefaults(entity: ClientEntity): FormValues {
  const out: FormValues = {};
  const defaults = CREATE_DEFAULTS[entity.key] ?? {};
  for (const f of entity.fields) out[f.name] = f.name in defaults ? defaults[f.name] : emptyOf(f);
  return out;
}

/** The form values of a stored row. */
export function rowToForm(entity: ClientEntity, row: Row): FormValues {
  const out: FormValues = {};
  for (const f of entity.fields) {
    const v = row[f.name];
    switch (f.kind) {
      case 'int':
        out[f.name] = typeof v === 'number' ? v : v === null || v === undefined ? null : Number(v);
        break;
      case 'bool':
        out[f.name] = v === 1 || v === true;
        break;
      case 'iso':
        out[f.name] = toLocalInput(typeof v === 'string' ? v : null);
        break;
      case 'json_array':
        out[f.name] = parseJsonColumn<unknown[]>(v, []) as FormValue;
        break;
      case 'json_object': {
        const obj = parseJsonColumn<Row>(v, {});
        out[f.name] = f.editor === 'json' ? JSON.stringify(obj, null, 2) : obj;
        break;
      }
      default:
        out[f.name] = v === null || v === undefined ? '' : String(v);
    }
  }
  return out;
}

/** A form value as the API wants it, or `undefined` when there is nothing to send. */
function wire(f: ClientField, v: FormValue): unknown {
  switch (f.kind) {
    case 'string':
    case 'text': {
      const s = String(v ?? '').trim();
      return s === '' && f.nullable ? null : s;
    }
    case 'code':
    case 'ref':
    case 'enum': {
      const s = String(v ?? '').trim();
      return s === '' ? (f.nullable ? null : undefined) : s;
    }
    case 'int':
      return v === null || v === '' ? (f.nullable ? null : undefined) : v;
    case 'bool':
      return v === true;
    case 'iso': {
      const s = String(v ?? '');
      return s === '' ? (f.nullable ? null : undefined) : fromLocalInput(s);
    }
    case 'json_array':
      if (f.editor === 'bundle') {
        return (v as BundleLine[]).map((b) => ({ variant_id: b.variant_id, qty: b.qty, value_iqd: b.value_iqd ?? 0 }));
      }
      return v;
    case 'json_object':
      if (f.editor === 'json') {
        try {
          return JSON.parse(String(v || '{}')) as unknown;
        } catch {
          return undefined;
        }
      }
      return v;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The body to send. On create: every writable, filled field. On update: every
 * writable, mutable field whose value differs from the stored row's.
 */
export function formToBody(entity: ClientEntity, values: FormValues, original: FormValues | null, a: Access): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of entity.fields) {
    if (!writable(f, a)) continue;
    if (original && f.immutable) continue;
    const v = wire(f, values[f.name]);
    if (v === undefined) continue;
    if (original) {
      if (same(v, wire(f, original[f.name]))) continue;
    } else if (v === null || v === '') {
      // An empty optional field on a new row: the database default is the answer.
      continue;
    }
    body[f.name] = v;
  }
  return body;
}

export type Reason =
  | 'required'
  | 'too_small'
  | 'too_large'
  | 'too_long'
  | 'code_format'
  | 'reference'
  | 'not_allowed'
  | 'array_required'
  | 'object_required'
  | 'iso_date_required'
  | 'format'
  | 'no_discount'
  | 'below_min'
  | 'null_not_allowed';

/** What catalog.ts would refuse, field by field — checked before the request. */
export function validateForm(entity: ClientEntity, values: FormValues, original: FormValues | null, a: Access): Record<string, Reason> {
  const errors: Record<string, Reason> = {};
  for (const f of entity.fields) {
    if (!visible(f, a) || (original && f.immutable)) continue;
    const v = values[f.name];
    const touched = !original || !same(wire(f, v), wire(f, original[f.name]));
    if (!touched && original) continue;
    switch (f.kind) {
      case 'string':
      case 'text': {
        const s = String(v ?? '').trim();
        if (f.required && !s) errors[f.name] = 'required';
        else if (s.length > (f.max ?? 200)) errors[f.name] = 'too_long';
        break;
      }
      case 'code': {
        const s = String(v ?? '');
        if (!s) {
          if (f.required) errors[f.name] = 'required';
        } else if (!CODE_RE.test(s)) errors[f.name] = 'code_format';
        break;
      }
      case 'ref':
      case 'enum': {
        const s = String(v ?? '');
        if (!s) {
          if (f.required) errors[f.name] = 'required';
        } else if (f.kind === 'ref' && !REF_RE.test(s)) errors[f.name] = 'reference';
        else if (f.kind === 'enum' && !(f.values ?? []).includes(s)) errors[f.name] = 'not_allowed';
        break;
      }
      case 'int': {
        if (v === null || v === '' || (typeof v === 'number' && Number.isNaN(v))) {
          if (f.required) errors[f.name] = 'required';
          else if (original && !f.nullable && original[f.name] !== null) errors[f.name] = 'null_not_allowed';
          break;
        }
        const n = Number(v);
        if (!Number.isSafeInteger(n)) errors[f.name] = 'required';
        else if (f.min !== undefined && n < f.min) errors[f.name] = 'too_small';
        else if (f.max !== undefined && n > f.max) errors[f.name] = 'too_large';
        break;
      }
      case 'iso': {
        const s = String(v ?? '');
        if (s && !fromLocalInput(s)) errors[f.name] = 'iso_date_required';
        break;
      }
      case 'json_array': {
        const arr = wire(f, v);
        if (!Array.isArray(arr) || arr.length > 200 || JSON.stringify(arr).length > 20000) errors[f.name] = 'array_required';
        break;
      }
      case 'json_object': {
        const obj = wire(f, v);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj) || JSON.stringify(obj).length > 20000) errors[f.name] = 'object_required';
        break;
      }
    }
  }
  // catalog.ts `crossCheck`, on the row as it would be stored.
  const val = (name: string) => values[name];
  if (entity.key === 'variants') {
    const modes = val('fulfillment_modes_json') as string[];
    if (!modes.length) errors.fulfillment_modes_json = 'not_allowed';
    const hex = String(val('color_hex') ?? '');
    if (hex && !HEX_RE.test(hex)) errors.color_hex = 'format';
  }
  if (entity.key === 'printer_models') {
    const nozzles = val('nozzle_options_um') as number[];
    if (!nozzles.length || nozzles.some((n) => !Number.isSafeInteger(n) || n < 100 || n > 2000)) errors.nozzle_options_um = 'not_allowed';
    if ((val('supported_materials_json') as string[]).some((m) => !MATERIAL_RE.test(m))) errors.supported_materials_json = 'not_allowed';
  }
  if (entity.key === 'printers' && (val('materials_json') as string[]).some((m) => !MATERIAL_RE.test(m))) errors.materials_json = 'not_allowed';
  if (entity.key === 'packages') {
    const lo = val('min_quantity');
    const hi = val('max_quantity');
    if (typeof lo === 'number' && typeof hi === 'number' && hi < lo) errors.max_quantity = 'below_min';
    const bundle = val('bundle_json') as BundleLine[];
    if (bundle.some((b) => !b.variant_id || !b.qty || b.qty <= 0 || (b.value_iqd ?? 0) < 0)) errors.bundle_json = 'not_allowed';
  }
  if (entity.key === 'promotions') {
    if (!SCOPE_RE.test(String(val('scope') ?? ''))) errors.scope = 'format';
    if (!val('percent_bps') && !val('amount_off_iqd')) errors.percent_bps = 'no_discount';
  }
  if (entity.key === 'accessory_rules' && !String(val('keyword') ?? '').trim() && !String(val('project_type') ?? '').trim()) errors.keyword = 'required';
  return errors;
}
