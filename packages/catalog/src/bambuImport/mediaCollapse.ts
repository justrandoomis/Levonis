/**
 * THE CONTENT-DUPLICATE COLLAPSE OF A WRITTEN GALLERY (spec §C.4 step 1).
 *
 * Gallery entries whose stored WebP is the SAME object (byte-identical pictures
 * share one content-addressed R2 key) collapse into the earliest position. The
 * Worker applies it to the rows it writes (worker/lib/catalogImport/writer.ts,
 * on its own `catalog_import_media` keys) and the runner recomputes the same
 * rows when it has no /write answer at hand (scripts/bambu-import/gallery.ts),
 * so both read this one rule.
 *
 * Per key held by two or more gallery entries:
 *   - when any copy is bound, the general copies go and each binding is kept
 *     once; a later entry's row takes the earliest position. A representative
 *     keeps its rule and the variant whose hero it shows (R6), a reviewed
 *     override keeps its rule; any other binding inherited from the copy becomes
 *     `content_duplicate` (and names no via variant);
 *   - when none is bound, only the earliest general row stays.
 * The rows of ONE entry (a value set) never collapse into each other. Exactly
 * one primary is kept: the first one left, else the row in the earliest
 * position.
 *
 * Pure. Generic over the row shape, so the Worker's rows (`via_variant_id: ''`)
 * and the runner's payload images (`via_variant_id: null`, no colour) both pass.
 */

/** What the collapse reads of a row. */
export interface CollapsibleRow {
  id: string;
  source_media_id: string;
  r2_key: string;
  sort_order: number;
  is_primary: boolean;
  option_value_id: string | null;
  variant_id: string | null;
  color_id?: string | null;
  binding_rule: string;
  via_variant_id?: string | null;
}

const boundOf = (r: CollapsibleRow) => !!(r.option_value_id || r.variant_id || r.color_id);

/** The rules a moved row keeps: what it shows does not change with its position. */
const KEEPS_RULE: ReadonlySet<string> = new Set(['representative', 'reviewed_override']);

export function collapseContentDuplicates<T extends CollapsibleRow>(rows: readonly T[]): { rows: T[]; collapsed: number } {
  const byKey = new Map<string, T[]>();
  for (const r of rows) byKey.set(r.r2_key, [...(byKey.get(r.r2_key) ?? []), r]);
  const drop = new Set<string>();
  const changed = new Map<string, Partial<CollapsibleRow>>();
  for (const group of byKey.values()) {
    const sources = [...new Set(group.map((r) => r.source_media_id))];
    if (sources.length < 2) continue;
    const firstSort = (sid: string) => Math.min(...group.filter((r) => r.source_media_id === sid).map((r) => r.sort_order));
    const canonical = sources.reduce((a, b) => (firstSort(b) < firstSort(a) ? b : a));
    const earliest = firstSort(canonical);
    if (group.some(boundOf)) {
      const seen = new Set<string>();
      for (const r of group) {
        const binding = `${r.option_value_id ?? ''}|${r.variant_id ?? ''}|${r.color_id ?? ''}`;
        if (!boundOf(r) || seen.has(binding)) {
          drop.add(r.id);
          continue;
        }
        seen.add(binding);
        if (r.source_media_id === canonical) continue;
        changed.set(
          r.id,
          KEEPS_RULE.has(r.binding_rule)
            ? { sort_order: earliest }
            : { sort_order: earliest, binding_rule: 'content_duplicate', via_variant_id: r.via_variant_id === null || r.via_variant_id === undefined ? r.via_variant_id : '' }
        );
      }
    } else {
      const keep = group.find((r) => r.source_media_id === canonical && r.sort_order === earliest) ?? group[0];
      for (const r of group) if (r.id !== keep.id) drop.add(r.id);
    }
  }
  const out = rows.filter((r) => !drop.has(r.id)).map((r) => ({ ...r, ...(changed.get(r.id) ?? {}) }) as T);
  if (out.length && !out.some((r) => r.is_primary)) {
    const lead = [...out].sort((a, b) => a.sort_order - b.sort_order)[0];
    lead.is_primary = true;
  }
  let seenPrimary = false;
  for (const r of out) {
    if (r.is_primary && seenPrimary) r.is_primary = false;
    if (r.is_primary) seenPrimary = true;
  }
  return { rows: out, collapsed: rows.length - out.length };
}
