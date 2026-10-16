/**
 * THE GALLERY AS WRITTEN (Bambu import spec §C.4 step 1, §I.1.2, §I.1.7).
 *
 * The Worker collapses gallery entries whose stored WebP is the SAME object
 * (byte-identical pictures share one content-addressed R2 key) into the
 * earliest position before it writes (worker/lib/catalogImport/writer.ts
 * `collapseContentDuplicates`). The product page therefore shows fewer image
 * rows than the payload sent, and a later bound copy may lead from an earlier
 * position. VERIFY's expected projection and counts (verify.ts) and the
 * browser's expected gallery (selection.ts) are built from the rows the
 * Worker WROTE, never from the payload's pre-collapse images. They come from,
 * in this order:
 *
 *   1. this job's `/write` answer (`images`): the rows themselves;
 *   2. a resume after `/write` (no answer in this job): `stage_data.images`
 *      of the lease, WHEN the Worker records it there — it records counts
 *      only today (`stage_data.written`, `payload_counts`, `readback`), and
 *      `/readback` answers counts too;
 *   3. otherwise the same collapse, recomputed here from the inputs the
 *      Worker used: the payload (VERIFY only runs on a payload whose digest is
 *      the one written, run.ts) and the stored keys `/media` answers (the
 *      Worker's own `catalog_import_media` rows).
 *
 * A written row is the payload image of the same id with the written
 * position, primary and binding. A content-duplicate row no longer names a
 * representative's source variant (the Worker clears it). The stored
 * evidence still counts the PAYLOAD's images (`edge_evidence.counts` must
 * equal `stage_data.payload_counts`, worker/lib/catalogImport/complete.ts).
 *
 * Pure.
 */
import type { ImportPayload } from '@levonis/catalog/bambuImport/payload';
import type { MediaAnswerRow, WrittenImage } from './opsClient';

export type GalleryImage = ImportPayload['images'][number];
export type GallerySource = 'write' | 'stage_data' | 'recomputed';

export interface Gallery {
  /** The rows the page shows, as payload images (written position, primary and binding). */
  images: GalleryImage[];
  source: GallerySource;
}

/** A gallery row on its stored object, as the collapse reads it. */
export type StoredGalleryRow = GalleryImage & { r2_key: string };

const boundOf = (r: StoredGalleryRow) => !!(r.option_value_id || r.variant_id);

/**
 * The Worker's content-duplicate collapse (writer.ts `collapseContentDuplicates`, §C.4 step 1), over rows with
 * their stored keys: per key held by two or more gallery entries, when any copy is bound the general copies go and
 * each binding is kept once, a later entry's row taking the earliest position with rule `content_duplicate`; when
 * none is bound, only the earliest general row stays. The rows of ONE entry (a value set) never collapse into each
 * other. Exactly one primary is kept: the first one left, else the row in the earliest position. An import row never
 * binds a colour (the Worker writes `color_id` null), so a binding is a value or a variant.
 */
// TODO(W4): import the package's collapseContentDuplicates once the writer lane moves it there (this is a hand copy).
export function collapseContentDuplicates(rows: readonly StoredGalleryRow[]): { rows: StoredGalleryRow[]; collapsed: number } {
  const byKey = new Map<string, StoredGalleryRow[]>();
  for (const r of rows) byKey.set(r.r2_key, [...(byKey.get(r.r2_key) ?? []), r]);
  const drop = new Set<string>();
  const moved = new Map<string, number>();
  for (const group of byKey.values()) {
    const sources = [...new Set(group.map((r) => r.source_media_id))];
    if (sources.length < 2) continue;
    const firstSort = (sid: string) => Math.min(...group.filter((r) => r.source_media_id === sid).map((r) => r.sort_order));
    const canonical = sources.reduce((a, b) => (firstSort(b) < firstSort(a) ? b : a));
    const earliest = firstSort(canonical);
    if (group.some(boundOf)) {
      const seen = new Set<string>();
      for (const r of group) {
        const binding = `${r.option_value_id ?? ''}|${r.variant_id ?? ''}`;
        if (!boundOf(r) || seen.has(binding)) {
          drop.add(r.id);
          continue;
        }
        seen.add(binding);
        if (r.source_media_id !== canonical) moved.set(r.id, earliest);
      }
    } else {
      const keep = group.find((r) => r.source_media_id === canonical && r.sort_order === earliest) ?? group[0];
      for (const r of group) if (r.id !== keep.id) drop.add(r.id);
    }
  }
  const out = rows
    .filter((r) => !drop.has(r.id))
    .map((r) => (moved.has(r.id) ? { ...r, sort_order: moved.get(r.id)!, binding_rule: 'content_duplicate', via_variant_id: null } : { ...r }));
  if (out.length && !out.some((r) => r.is_primary)) [...out].sort((a, b) => a.sort_order - b.sort_order)[0].is_primary = true;
  let seenPrimary = false;
  for (const r of out) {
    if (r.is_primary && seenPrimary) r.is_primary = false;
    if (r.is_primary) seenPrimary = true;
  }
  return { rows: out, collapsed: rows.length - out.length };
}

/** The gallery from the Worker's own rows: each the payload image of its id, with what the write made of it. */
export function galleryFromWritten(payload: Pick<ImportPayload, 'images'>, written: readonly WrittenImage[]): GalleryImage[] {
  const byId = new Map(payload.images.map((i) => [i.id, i]));
  return written.map((w) => {
    const img = byId.get(w.id);
    const base: GalleryImage = img ?? { id: w.id, source_media_id: w.source_media_id, source_url: '', sort_order: w.sort_order, is_primary: false, option_value_id: null, variant_id: null, via_variant_id: null, binding_rule: '', alt_en: '', alt_ar: '', alt_ckb: '' };
    const rule = w.binding_rule || base.binding_rule;
    return {
      ...base,
      source_media_id: w.source_media_id,
      sort_order: w.sort_order,
      is_primary: w.is_primary,
      option_value_id: w.option_value_id,
      variant_id: w.variant_id,
      // Only a representative row names the variant whose hero it shows; a content duplicate no longer does.
      via_variant_id: rule === 'representative' && img ? img.via_variant_id : null,
      binding_rule: rule,
    };
  });
}

/** The gallery recomputed from the payload and the stored keys of /media (a resume with no written rows at hand). */
export function recomputedGallery(payload: Pick<ImportPayload, 'images'>, media: ReadonlyMap<string, MediaAnswerRow>): GalleryImage[] {
  const rows: StoredGalleryRow[] = [];
  for (const i of payload.images) {
    const m = media.get(i.source_media_id);
    if (m && m.status === 'stored' && m.r2_key) rows.push({ ...i, r2_key: m.r2_key });
  }
  return collapseContentDuplicates(rows).rows.map((r) => {
    const img: Partial<StoredGalleryRow> = { ...r };
    delete img.r2_key;
    return img as GalleryImage;
  });
}

/** The gallery VERIFY expects: the written rows when the Worker gave them (its answer, or what it recorded), else recomputed. */
export function writtenGallery(
  payload: Pick<ImportPayload, 'images'>,
  media: ReadonlyMap<string, MediaAnswerRow>,
  written: { rows: readonly WrittenImage[]; source: 'write' | 'stage_data' } | null
): Gallery {
  if (written) return { images: galleryFromWritten(payload, written.rows), source: written.source };
  return { images: recomputedGallery(payload, media), source: 'recomputed' };
}
