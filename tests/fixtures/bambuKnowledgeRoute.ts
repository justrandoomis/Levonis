/**
 * THE KNOWLEDGE ROUTE'S ANSWER FOR A WRITTEN PAYLOAD, as the live Worker gives
 * it (`GET /api/products/<slug>/knowledge`), for the runner's tests: the rows
 * the import's writer stores — written here from the writer's own mapping
 * (worker/lib/catalogImport/writer.ts: box items on their stored objects, a
 * store row's address owner-side, a document's checked state, every group,
 * value and variant active), apart from the runner's verify.ts — read the way
 * worker/lib/knowledge/productKnowledge.ts reads them (public, active, a live
 * scope), then the route's own assembly (worker/lib/knowledge/answer.ts) with
 * the Worker's picture rule (worker/lib/productModel.ts).
 *
 * Knobs model what D1 can hold that the payload does not say, one at a time.
 */
import type { ImportPayload } from '../../packages/catalog/src/bambuImport/payload';
import { assembleKnowledge, type ProductKnowledge, type SpecValueDbRow } from '../../worker/lib/knowledge/answer';
import { canonicalProductMediaUrl } from '../../worker/lib/productModel';

export interface StoredKnowledgeKnobs {
  /** Values (or whole groups' values) the owner switched off since: their facts leave the answer. */
  inactiveValues?: ReadonlySet<string>;
  inactiveVariants?: ReadonlySet<string>;
  /** Documents stored inactive (a dead link, §C.7). */
  inactiveDocuments?: ReadonlySet<string>;
  /** A relation's state as D1 holds it now (default: the payload's). */
  relationState?: (r: ImportPayload['relations'][number]) => string;
  /** What a writer stores for a spec row, when it is not the payload's (a wrong writer). */
  storeSpec?: (row: SpecValueDbRow) => SpecValueDbRow;
  /** Rows D1 holds beside the payload's. */
  extraSpecs?: readonly SpecValueDbRow[];
  /** The store page's address (owner-only: a store row's `source_ref`). */
  canonicalUrl?: string;
}

export function routeKnowledge(
  payload: ImportPayload,
  media: ReadonlyMap<string, { r2_key: string; status?: string }>,
  knobs: StoredKnowledgeKnobs = {}
): ProductKnowledge {
  const key = (id: string) => {
    const m = media.get(id);
    return m && (m.status === undefined || m.status === 'stored') ? m.r2_key : '';
  };
  const values = new Set(payload.groups.flatMap((g) => g.values.map((v) => v.id)).filter((id) => !knobs.inactiveValues?.has(id)));
  const variants = new Set(payload.variants.map((v) => v.id).filter((id) => !knobs.inactiveVariants?.has(id)));
  // productKnowledge.ts scopeLive: the product, an active value of an active group, an active variant of this product.
  const live = (kind: string, id: string) => (kind === 'option_value' ? values.has(id) : kind === 'variant' ? variants.has(id) : true);
  // The route's statement reads `visibility = 'public'` rows only.
  const stored: SpecValueDbRow[] = payload.specs.filter((s) => s.visibility === 'public').map((s) => ({
    canonical_key: s.key,
    group_key: s.group,
    scope_kind: s.scope_kind,
    scope_id: s.scope_id,
    region: s.region,
    data_type: s.data_type,
    original_label: s.original_label,
    value_text: s.value_text,
    value_num: s.value_num,
    value_num_max: s.value_num_max,
    value_bool: s.value_bool,
    value_list: JSON.stringify(
      s.value_list.map((x) => {
        if (!x || typeof x !== 'object') return x;
        const k = x.source_media_id ? key(x.source_media_id) : '';
        return { text: x.text, qty: x.qty, ...(k ? { media_key: k } : {}), ...(x.section ? { section: x.section } : {}) };
      })
    ),
    unit: s.unit,
    status: s.status,
    source_kind: s.source_kind,
    source_ref: s.source_kind === 'store_page' || s.source_kind === 'store_messages' ? (knobs.canonicalUrl ?? 'https://us.store.bambulab.com/products/x') : (s.checked_sources[0]?.url ?? ''),
    source_title: s.source_title,
    source_locator: s.source_locator.slice(0, 200),
    source_excerpt: s.source_excerpt.slice(0, 200),
    test_method: s.test_method,
    test_condition: s.test_condition,
    checked_sources: JSON.stringify(s.checked_sources),
    conflict: s.conflict,
    sort: s.sort,
  }));
  const specs = [...stored.map((r) => (knobs.storeSpec ? knobs.storeSpec(r) : r)), ...(knobs.extraSpecs ?? [])]
    .filter((r) => live(r.scope_kind, r.scope_id))
    .sort((a, b) => a.sort - b.sort || (a.canonical_key < b.canonical_key ? -1 : a.canonical_key > b.canonical_key ? 1 : 0));
  return assembleKnowledge(
    {
      specs,
      documents: payload.documents
        .filter((d) => !knobs.inactiveDocuments?.has(d.id) && live(d.scope_kind, d.scope_id))
        .map((d) => ({ kind: d.kind, title_en: d.title_en, title_ar: d.title_ar, title_ckb: d.title_ckb, url: d.url, host: d.host, scope_kind: d.scope_kind, scope_id: d.scope_id })),
      relations: payload.relations
        .filter((r) => live(r.scope_kind, r.scope_id))
        .map((r) => ({ relation: r.relation, target_kind: r.target_kind, target_label: r.target_label, state: knobs.relationState ? knobs.relationState(r) : r.state, scope_kind: r.scope_kind, scope_id: r.scope_id })),
      swatches: payload.swatches
        .filter((w) => values.has(w.value_id) && key(w.source_media_id))
        .map((w) => ({ option_value_id: w.value_id, url: `/files/${key(w.source_media_id)}`, width: 128, height: 128, published_hex: '' })),
      sourceRoute: payload.route,
    },
    { url: canonicalProductMediaUrl }
  );
}
