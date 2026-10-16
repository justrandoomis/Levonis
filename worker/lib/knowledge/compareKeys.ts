/**
 * WHICH FACTS A COMPARISON COLUMN STANDS ON (the Bambu import spec §G.5
 * «Compare», §I.1.11) — ONE rule for the compare route and the import's runner.
 *
 * The compare route (worker/routes/compare.ts) refuses a column with nothing to
 * compare on (`COMPARE_NO_SPECS`) unless its typed sheet or its knowledge cells
 * state a value; the runner (scripts/bambu-import/verify.ts `compareKeysOf`)
 * accepts that refusal for an imported product only while the facts the route
 * would read number fewer than three. Both read the cells through
 * `knowledgeCellsFor` here, so the runner can never count a fact the route
 * does not read: a fact counts only when it is
 *   - public, and never the US 110 V table (a US value is not the product a
 *     customer in Iraq compares);
 *   - the product's own or the column's option's own (a bare product id — the
 *     single-id answer — reads product facts only; a variant's never);
 *   - a registry key flagged `compare` whose template field the comparison
 *     draws, never a filter's code (`FILTER_ONLY_FIELDS`, the family);
 *   - in a state that states a value, with a value.
 *
 * Pure: the shared package, the template definitions (no imports) and this
 * directory's vocabulary — nothing that needs a binding, so the runner imports
 * it as it is.
 */
import { SPEC_KEYS } from '@levonis/catalog/bambuImport/registry/specKeys';
import type { KnowledgeCell } from '../compareSpecs';
import { allTemplateGroups, FILTER_ONLY_FIELDS } from '../templateFamilies';
import { isSpecStatus, type SpecStatus } from './labels';

const TEMPLATE_FIELD_IDS: ReadonlySet<string> = new Set(allTemplateGroups().flatMap((g) => g.fields.map((f) => f.id)));

/** registry key → the template field whose row its fact answers (keys flagged `compare`, real fields, no filter code). */
export const COMPARE_KEY_FIELDS: ReadonlyMap<string, string> = new Map(
  SPEC_KEYS.filter((k) => k.compare && k.templateField && TEMPLATE_FIELD_IDS.has(k.templateField) && !FILTER_ONLY_FIELDS.has(k.templateField)).map((k) => [
    k.key,
    k.templateField as string,
  ])
);

/** The region a comparison never reads (the route's statement says `region <> 'us_110v'` too). */
export const COMPARE_EXCLUDED_REGION = 'us_110v';

/** One fact as the comparison reads it (0194 `product_spec_values`, or an import payload's spec row). */
export interface CompareFact {
  canonical_key: string;
  scope_kind: string;
  scope_id: string;
  region: string;
  value_text: string;
  value_num: number | null;
  value_num_max: number | null;
  unit: string;
  status: string;
  test_method: string;
  /** The route's statement reads public rows only; a fact from anywhere else says its visibility here. */
  visibility?: string;
}

/** Does a comparison read this fact at all (before the column's option and the state are weighed)? */
export function isCompareFact(r: CompareFact): boolean {
  if (r.visibility !== undefined && r.visibility !== 'public') return false;
  if (r.region === COMPARE_EXCLUDED_REGION) return false;
  if (r.scope_kind !== 'product' && r.scope_kind !== 'option_value') return false;
  return isSpecStatus(r.status) && COMPARE_KEY_FIELDS.has(r.canonical_key);
}

const ABSENT: ReadonlySet<SpecStatus> = new Set(['not_found', 'not_published', 'not_applicable', 'unknown']);

/** A column's cells by template field id: the option's own fact first, then the product's; 220 V before region-free. */
export function knowledgeCellsFor(rows: readonly CompareFact[], optionId: string | null): Record<string, KnowledgeCell> {
  const rank = (r: CompareFact): number => {
    const scope = r.scope_kind === 'option_value' ? (optionId && r.scope_id === optionId ? 0 : -1) : 2;
    if (scope < 0) return -1;
    return scope + (r.region === 'intl_220v' ? 0 : 1);
  };
  const best = new Map<string, CompareFact>();
  for (const r of rows) {
    if (!isCompareFact(r)) continue;
    const at = rank(r);
    if (at < 0) continue;
    const have = best.get(r.canonical_key);
    if (!have || at < rank(have)) best.set(r.canonical_key, r);
  }
  const out: Record<string, KnowledgeCell> = {};
  for (const [key, r] of best) {
    const field = COMPARE_KEY_FIELDS.get(key)!;
    const status = r.status as SpecStatus;
    out[field] = {
      key,
      status,
      text: ABSENT.has(status) ? '' : String(r.value_text ?? '').trim(),
      num: ABSENT.has(status) ? null : typeof r.value_num === 'number' && Number.isFinite(r.value_num) ? r.value_num : null,
      num_max: ABSENT.has(status) ? null : typeof r.value_num_max === 'number' && Number.isFinite(r.value_num_max) ? r.value_num_max : null,
      unit: String(r.unit ?? '').trim(),
      test_method: String(r.test_method ?? '').trim().slice(0, 200),
    };
  }
  return out;
}

/** A cell that states a value (not merely why there is none). */
export const cellHasValue = (c: KnowledgeCell): boolean => !ABSENT.has(c.status) && (c.text !== '' || c.num !== null);

/** True when a column's cells state at least one value (a sheet the comparison can stand on). */
export const hasKnowledgeValue = (cells: Record<string, KnowledgeCell>): boolean => Object.values(cells).some(cellHasValue);

/**
 * The template fields a column's facts state a value on. With `optionId` null
 * this is what the compare route's single-id answer (`?ids=<product>`) stands
 * on; the import's runner counts it against §I.1.11's three.
 */
export function comparedFields(rows: readonly CompareFact[], optionId: string | null): string[] {
  return Object.entries(knowledgeCellsFor(rows, optionId))
    .filter(([, c]) => cellHasValue(c))
    .map(([field]) => field)
    .sort();
}
