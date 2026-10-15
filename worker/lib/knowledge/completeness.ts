/**
 * INFORMATION COMPLETENESS (the Bambu import spec §H.2 «Information
 * completeness», §G.1 `completeness`; the brief's §18A).
 *
 * How much of what a product of its TYPE should state is actually stated, read
 * from the knowledge model (0194 `product_spec_values`) and nothing else. It is
 * not the commercial `product_completeness` (0184: the required fields that hold
 * a product back from sale) and never feeds it: it says how well a product is
 * DESCRIBED, never whether it may be sold.
 *
 *   expected     the registry's keys flagged `expectedFor` the product's type
 *   applicable   expected minus the keys the source says do not apply
 *   ratio        (verified + unverified) / applicable — null when nothing applies
 *   missing      not_found + not_published («ناقص»), shown apart from
 *   unknown      no fact at all, or one marked unknown («غير معروف»), and
 *   unverified   stated, but not by an official source the run could confirm
 *
 * THE TYPE. An imported product carries its source route (`product_source_refs
 * .source_route`), which names the type exactly as the import decided it
 * (registry/types.ts `productTypeOf`). A product with knowledge rows and no
 * source route (hand-entered later) is typed by the expected-key set its rows
 * cover best — the import writes a row, `not_found` included, for every
 * expected key of the product's type, so a full cover is the type's signature.
 *
 * Pure: no D1. The readers are the knowledge answer (worker/lib/knowledge/
 * productKnowledge.ts, public rows only) and the staff column and card
 * (worker/lib/knowledge/infoCompleteness.ts, every row).
 */
import { expectedKeys, specKey, type SpecKey } from '@levonis/catalog/bambuImport/registry/specKeys';
import { productTypeOf, type ProductType } from '@levonis/catalog/bambuImport/registry/types';
import { isSpecStatus, type SpecStatus, type Tri } from './labels';

/** The types a key can be expected for, in the registry's own order of appearance. */
const EXPECTING_TYPES: readonly ProductType[] = ((): ProductType[] => {
  const all: ProductType[] = ['printer', 'laser_machine', 'ams', 'filament', 'plate', 'hotend', 'tool', 'accessory', 'part', 'makers_supply', 'laser_material', 'other'];
  return all.filter((t) => expectedKeys(t).length > 0);
})();

/** Every key the registry expects of some type — the only keys completeness ever reads. */
export const EXPECTED_KEY_UNION: readonly string[] = [...new Set(EXPECTING_TYPES.flatMap((t) => expectedKeys(t).map((k) => k.key)))];

/**
 * The best status a key reaches across its rows (scopes and regions): one
 * verified row states the fact; `not_applicable` wins only when every row says it.
 */
const RANK: Record<SpecStatus, number> = { verified: 5, unverified: 4, not_published: 3, not_found: 2, unknown: 1, not_applicable: 0 };

export function bestStatusByKey(rows: ReadonlyArray<{ key: string; status: string }>): Map<string, SpecStatus> {
  const out = new Map<string, SpecStatus>();
  for (const r of rows) {
    if (!isSpecStatus(r.status)) continue;
    const have = out.get(r.key);
    if (!have || RANK[r.status] > RANK[have]) out.set(r.key, r.status);
  }
  return out;
}

/** The product's type for completeness: its source route when it has one, else the best-covered expected set. */
export function knowledgeTypeOf(sourceRoute: string | null | undefined, keys: ReadonlySet<string>): ProductType | null {
  if (typeof sourceRoute === 'string' && sourceRoute.trim() !== '') return productTypeOf(sourceRoute);
  let best: { type: ProductType; ratio: number; size: number } | null = null;
  for (const type of EXPECTING_TYPES) {
    const want = expectedKeys(type);
    const covered = want.filter((k) => keys.has(k.key)).length;
    if (covered === 0) continue;
    const ratio = covered / want.length;
    if (!best || ratio > best.ratio || (ratio === best.ratio && want.length > best.size)) best = { type, ratio, size: want.length };
  }
  return best?.type ?? null;
}

export interface CompletenessCounts {
  applicable: number;
  verified: number;
  unverified: number;
  not_found: number;
  not_published: number;
  unknown: number;
}

export interface CompletenessDetail extends CompletenessCounts {
  /** The import's product type the expected keys came from; null when none could be told. */
  type: ProductType | null;
  /** not_found + not_published («ناقص» / Missing / «کەم»). */
  missing: number;
  /** (verified + unverified) / applicable, 0..1; null when nothing applies. */
  ratio: number | null;
  /** Each expected key with its status, in registry order — the form card names them. */
  keys: Array<{ key: string; label: Tri; status: SpecStatus }>;
}

/** Completeness of one product from its rows (any visibility the caller chose) and its source route. */
export function completenessOf(
  rows: ReadonlyArray<{ key: string; status: string }>,
  sourceRoute: string | null | undefined
): CompletenessDetail {
  const best = bestStatusByKey(rows);
  const type = knowledgeTypeOf(sourceRoute, new Set(best.keys()));
  const expected: SpecKey[] = type ? expectedKeys(type) : [];
  const counts: CompletenessCounts = { applicable: 0, verified: 0, unverified: 0, not_found: 0, not_published: 0, unknown: 0 };
  const keys: CompletenessDetail['keys'] = [];
  for (const k of expected) {
    const status: SpecStatus = best.get(k.key) ?? 'unknown';
    keys.push({ key: k.key, label: k.labels, status });
    if (status === 'not_applicable') continue;
    counts.applicable += 1;
    counts[status] += 1;
  }
  return {
    type,
    ...counts,
    missing: counts.not_found + counts.not_published,
    ratio: counts.applicable > 0 ? (counts.verified + counts.unverified) / counts.applicable : null,
    keys,
  };
}

/** The registry label of a key (the completeness card's names), or the key itself for an `x.*` key. */
export function keyLabel(key: string): Tri {
  return specKey(key)?.labels ?? { ar: key, en: key, ckb: key };
}
