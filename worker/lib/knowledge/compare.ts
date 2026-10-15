/**
 * THE COMPARISON READS THE KNOWLEDGE MODEL (the Bambu import spec §G.5
 * «Compare»): for the registry keys flagged `compare`, a product's typed fact
 * (0194 `product_spec_values`) answers the cell its template field would
 * otherwise answer from `spec_fields` — with its unit, its test method and,
 * where there is no value, the state's words instead of a blank («غير متوفر في
 * المصادر التي رُوجعت» …, never 0, never «No»).
 *
 * ONE EXTRA `IN` READ for ≤ 4 products, in the wave the route already spends on
 * the taxonomy and the pictures (tests/d1Waves.test.ts records the compare
 * route's measured ceiling). Without 0194 it answers nothing and every cell is
 * read from `spec_fields` exactly as before (CLAUDE.md rule 2).
 *
 * Public rows only, never the US 110 V table (a US value is not the product a
 * customer in Iraq compares), and per COLUMN: a column narrowed to an option
 * (`?ids=product:option`) takes that option's own fact first, then the
 * product's.
 */
import { SPEC_KEYS } from '@levonis/catalog/bambuImport/registry/specKeys';
import { allTemplateGroups } from '../templateFamilies';
import type { KnowledgeCell } from '../compareSpecs';
import { knowledgeRead } from './schema';
import { isSpecStatus, type SpecStatus } from './labels';

const TEMPLATE_FIELD_IDS: ReadonlySet<string> = new Set(allTemplateGroups().flatMap((g) => g.fields.map((f) => f.id)));

/** registry key → the template field whose row its fact answers (only keys flagged `compare`, only real fields). */
export const COMPARE_KEY_FIELDS: ReadonlyMap<string, string> = new Map(
  SPEC_KEYS.filter((k) => k.compare && k.templateField && TEMPLATE_FIELD_IDS.has(k.templateField)).map((k) => [k.key, k.templateField as string])
);

export interface CompareKnowledgeRow {
  product_id: string;
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
}

/** The compared products' typed facts, by product id; null on a database without 0194. */
export async function loadCompareKnowledge(db: D1Database, productIds: readonly string[]): Promise<Map<string, CompareKnowledgeRow[]> | null> {
  const ids = [...new Set(productIds)].filter(Boolean);
  if (ids.length === 0 || COMPARE_KEY_FIELDS.size === 0) return new Map();
  const rows = await knowledgeRead(db, async () =>
    (
      await db
        .prepare(
          `SELECT product_id, canonical_key, scope_kind, scope_id, region, value_text, value_num, value_num_max, unit, status, test_method
             FROM product_spec_values
            WHERE product_id IN (SELECT value FROM json_each(?)) AND canonical_key IN (SELECT value FROM json_each(?))
              AND visibility = 'public' AND region <> 'us_110v' AND scope_kind IN ('product', 'option_value')`
        )
        .bind(JSON.stringify(ids), JSON.stringify([...COMPARE_KEY_FIELDS.keys()]))
        .all<CompareKnowledgeRow>()
    ).results ?? []
  );
  if (!rows) return null;
  const out = new Map<string, CompareKnowledgeRow[]>();
  for (const r of rows) {
    const list = out.get(r.product_id);
    if (list) list.push(r);
    else out.set(r.product_id, [r]);
  }
  return out;
}

const ABSENT: ReadonlySet<SpecStatus> = new Set(['not_found', 'not_published', 'not_applicable', 'unknown']);

/** A column's cells by template field id: the option's own fact first, then the product's; 220 V before region-free. */
export function knowledgeCellsFor(rows: readonly CompareKnowledgeRow[], optionId: string | null): Record<string, KnowledgeCell> {
  const rank = (r: CompareKnowledgeRow): number => {
    const scope = r.scope_kind === 'option_value' ? (optionId && r.scope_id === optionId ? 0 : -1) : 2;
    if (scope < 0) return -1;
    return scope + (r.region === 'intl_220v' ? 0 : 1);
  };
  const best = new Map<string, CompareKnowledgeRow>();
  for (const r of rows) {
    if (!isSpecStatus(r.status) || !COMPARE_KEY_FIELDS.has(r.canonical_key)) continue;
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

/** True when a column's cells state at least one value (a sheet the comparison can stand on). */
export const hasKnowledgeValue = (cells: Record<string, KnowledgeCell>): boolean =>
  Object.values(cells).some((c) => !ABSENT.has(c.status) && (c.text !== '' || c.num !== null));
