/**
 * THE GALLERY AS WRITTEN (Bambu import spec §C.4 step 1, §I.1.2, §I.1.7).
 *
 * The Worker collapses gallery entries whose stored WebP is the SAME object
 * (byte-identical pictures share one content-addressed R2 key) into the
 * earliest position before it writes. The rule is the shared package's
 * (packages/catalog/src/bambuImport/mediaCollapse.ts
 * `collapseContentDuplicates`, which worker/lib/catalogImport/writer.ts
 * applies), and the runner uses that very function. The product page
 * therefore shows fewer image rows than the payload sent, and a later bound
 * copy may lead from an earlier position. VERIFY's expected projection and
 * counts (verify.ts) and the browser's expected gallery (selection.ts) are
 * built from the rows the Worker WROTE, never from the payload's pre-collapse
 * images. They come from, in this order:
 *
 *   1. this job's `/write` answer (`images`): the rows themselves;
 *   2. a resume after `/write` (no answer in this job): `stage_data.images`
 *      of the lease, which the Worker records at the WRITTEN checkpoint;
 *   3. otherwise the same collapse, recomputed here from the inputs the
 *      Worker used: the payload (VERIFY only runs on a payload whose digest is
 *      the one written, run.ts) and the stored keys `/media` answers (the
 *      Worker's own `catalog_import_media` rows).
 *
 * A written row is the payload image of the same id with the written
 * position, primary and binding. A moved copy keeps its rule when it is a
 * representative or a reviewed override (R6); any other moved copy becomes
 * `content_duplicate`. The source variant a row names is what the Worker
 * STORES and the page reads: a representative's only (writer.ts writes the
 * image source refs with `via_variant_id` for rule `representative`, '' for
 * every other rule). The stored evidence still counts the PAYLOAD's images
 * (`edge_evidence.counts` must equal `stage_data.payload_counts`,
 * worker/lib/catalogImport/complete.ts).
 *
 * Pure.
 */
import { collapseContentDuplicates } from '@levonis/catalog/bambuImport/mediaCollapse';
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

/**
 * The Worker's content-duplicate collapse (§C.4 step 1): the shared package's function, the one the writer applies,
 * over rows on their stored keys. Re-exported here for the runner's callers.
 */
export { collapseContentDuplicates };

/** The source variant the page reads for a row: a representative's own, else none (what writer.ts stores). */
const storedVia = (rule: string, via: string | null | undefined): string | null => (rule === 'representative' && via ? via : null);

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
      via_variant_id: storedVia(rule, img?.via_variant_id),
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
    const img: Partial<StoredGalleryRow> = { ...r, via_variant_id: storedVia(r.binding_rule, r.via_variant_id) };
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
