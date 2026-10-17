/**
 * WHAT A MERGE KEEPS, AND WHEN IT IS WRITTEN AGAIN — one rule for the Worker's writer
 * (worker/lib/catalogImport/writer.ts) and the runner (scripts/bambu-import/verify.ts, run.ts), so the
 * two can never disagree about it again (Bambu import spec §E.2, §I.1 check 4, §B.5).
 *
 * THE MERGED SELECTIONS. The reviewed `value_map` says which of the store's variants are one of the
 * existing product's own selections. A variant it maps (to ids the product has) is merged; a value is
 * merged when every variant carrying it is. Everything else is `variant_not_merged`: the product does
 * not sell it.
 *
 * THE EXTERNAL IDS A MERGE STORES are the product's own and those of its merged values and variants —
 * a colour code, a SKU code. Where one row of the product stands for the value or variant the id is
 * stored there; where none does (a `product_colors` colour, which migration 0194 cannot scope) it is
 * stored at product scope (the writer's choice of row). The live PLA Basic merge stored none of its 72
 * searchable ids because only the first half of that rule existed, and VERIFY expected all 72 because
 * it read the payload instead of this rule.
 */
import type { ImportPayload, PayloadExternalId } from './payload';

/** One `value_map` entry: the existing option values and/or the existing `product_colors` colour. */
export interface MergeEntry {
  option_value_ids?: string[];
  color_id?: string;
}

/** The reviewed match a merge maps through (data/bambu-import/existing-matches.json). */
export interface MergeMatch {
  value_map: Readonly<Record<string, MergeEntry>>;
  unmapped_variants: readonly string[];
}

export interface MergedSelections {
  /** payload variant id → its value_map entry, for every merged variant. */
  entryOf: Map<string, MergeEntry>;
  /** The source variant ids not merged: the reviewed ones, then each variant the map does not merge. */
  unmapped: string[];
  /** Payload value ids every one of whose variants is merged. */
  values: Set<string>;
  /** Payload variant ids that are merged (the keys of `entryOf`). */
  variants: Set<string>;
}

/**
 * The merged selections. `has` answers whether the existing product holds an option value or colour id:
 * the writer asks its stored rows; a caller without them (the runner) leaves it out, and every id the
 * reviewed map names counts as present — a map naming an id the product lacks then makes VERIFY expect
 * more than the writer stored, which fails closed.
 */
export function mergedSelections(
  payload: Pick<ImportPayload, 'groups' | 'variants'>,
  match: MergeMatch,
  has?: { value(id: string): boolean; colour(id: string): boolean }
): MergedSelections {
  const entryOf = new Map<string, MergeEntry>();
  const unmapped: string[] = [...match.unmapped_variants];
  for (const v of payload.variants) {
    const e = match.value_map[v.source_id];
    const ok =
      !!e &&
      (e.option_value_ids ?? []).every((id) => !has || has.value(id)) &&
      (!e.color_id || !has || has.colour(e.color_id));
    if (ok) entryOf.set(v.id, e);
    else if (!unmapped.includes(v.source_id)) unmapped.push(v.source_id);
  }
  const values = new Set<string>();
  for (const g of payload.groups) {
    for (const val of g.values) {
      const carriers = payload.variants.filter((v) => v.value_ids.includes(val.id));
      if (carriers.length > 0 && carriers.every((v) => entryOf.has(v.id))) values.add(val.id);
    }
  }
  return { entryOf, unmapped, values, variants: new Set(entryOf.keys()) };
}

/** The payload's external ids a write stores: all of a create's (`merged` null); a merge's own and its merged selections'. */
export function storedExternalIds<E extends Pick<PayloadExternalId, 'scope_kind' | 'scope_id'>>(ids: readonly E[], merged: MergedSelections | null): E[] {
  if (!merged) return [...ids];
  return ids.filter((e) =>
    e.scope_kind === 'product' ? true : e.scope_kind === 'option_value' ? merged.values.has(e.scope_id) : e.scope_kind === 'variant' ? merged.variants.has(e.scope_id) : false
  );
}

/**
 * A RESUMED VERIFY FAILURE OF A MERGE IS WRITTEN AGAIN (§B.5): a BLOCKED item whose block is a VERIFY_FAILED*
 * code, of a merge (the item's product is the reviewed existing one) that was written (the last completed
 * stage is PUBLISHING), resumes at WRITING instead of VERIFYING_LIVE. A merge write is idempotent and its
 * protected fields are proven unchanged (before_fp_equal), so writing it again is what applies a writer fix
 * to an item already written; VERIFY alone would only fail again on the same rows. A create is never written
 * twice (IMPORT_DUPLICATE_CREATE) and keeps resuming at VERIFYING_LIVE. Migration 0199's trigger admits
 * exactly this edge.
 */
export function rewritesOnResume(item: { blocker_code: string; last_completed_stage: string; merge: boolean; product_id: string }): boolean {
  return item.merge && item.product_id !== '' && item.last_completed_stage === 'PUBLISHING' && item.blocker_code.startsWith('VERIFY_FAILED');
}
