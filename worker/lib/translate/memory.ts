/**
 * THE CATALOGUE TRANSLATION MEMORY, AT DISPLAY TIME (docs/bambu-import/
 * I18N-DESIGN.md §A.5; DECISIONS rows 2 and 183; migration 0196).
 *
 * The imported English of a product (its description, its usage guide, its
 * content blocks, its official spec values, the knowledge answer's values, box
 * items and document titles) reaches an Arabic or Sorani reader through the
 * rows of `catalog_translations` the product's refs name. The rows were written
 * by us and reviewed, committed under data/bambu-import/translations/ and
 * loaded through the import door (worker/lib/catalogImport/translations.ts):
 * no external service is ever asked (row 2).
 *
 * READ: one statement with one parameter, in the wave a route already spends
 * (`loadProductTranslationMap`; `loadProductsTranslationMaps` for the ≤ 4
 * compared products). Only `reviewed` and `machine` rows; English is the
 * fallback. The local dictionary is NOT consulted here for imported strings: it
 * localises units («0.4 مم») while this import keeps units Latin, and it cannot
 * cover marketing prose by design.
 *
 * APPLY (`overlayImportedText`): on the OUTGOING product body only — never a
 * stored row — line by line through the shared segmentation
 * (packages/catalog/src/bambuImport/i18n.ts `translateLines`): a line the
 * memory covers is its words, every other line keeps what the stored slot said
 * (the writer's dictionary line, or the English). It touches the
 * prose slots alone: the description, «طريقة الاستخدام», the usage steps, the
 * content blocks' bodies and the official spec group's values — never a name,
 * an option or colour name (mandate §3/§7), a lead time, a warranty or a label.
 * A slot a human approved keeps the human's text. With an empty map the body
 * is byte-identical to the one without this module.
 *
 * WITHOUT 0196 (CLAUDE.md rule 2): optimistic, never a probe first. A database
 * that refuses the statement for exactly these tables is remembered for a
 * minute per binding and answers the empty map; any other failure is logged
 * (error name only) and answers the empty map too — display text never fails
 * a page.
 */
import { normalizeSource, translateLines, type Tr } from '@levonis/catalog/bambuImport/i18n';
import type { TranslationMeta } from '../productModel';
import { localizableSlots } from '../translationSlots';

export type { Tr };

/** Normalized English → its Arabic and Sorani. */
export type TranslationMap = ReadonlyMap<string, Tr>;

export const EMPTY_TRANSLATIONS: TranslationMap = new Map();

// ---------------------------------------------------------------- presence

const PRESENT = new WeakMap<object, true>();
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

/** "no such table: catalog_translations" (or its refs): the deploy-ahead answer, and nothing else. */
export function isMissingTranslationSchema(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err ?? '');
  return /no such table/i.test(msg) && /catalog_translation(s|_refs)/i.test(msg);
}

/** Forget what this isolate learned about a binding (tests that migrate one database forward). */
export function forgetTranslationSchema(db: object): void {
  PRESENT.delete(db);
  ABSENT_UNTIL.delete(db);
}

/**
 * Runs a read of the 0196 tables. Without them (refused for exactly those
 * tables) it answers `fallback` and remembers it for a minute; any other
 * failure is logged by name and answers `fallback` as well.
 */
export async function translationRead<T>(db: object, read: () => Promise<T>, fallback: T): Promise<T> {
  if (!PRESENT.has(db) && (ABSENT_UNTIL.get(db) ?? 0) > Date.now()) return fallback;
  try {
    const out = await read();
    PRESENT.set(db, true);
    ABSENT_UNTIL.delete(db);
    return out;
  } catch (e) {
    if (isMissingTranslationSchema(e)) {
      PRESENT.delete(db);
      ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
      return fallback;
    }
    console.error('catalog_translations_read_failed', JSON.stringify({ name: e instanceof Error ? e.name : typeof e }));
    return fallback;
  }
}

// ---------------------------------------------------------------- the reads

interface TmDbRow {
  product_id?: string;
  en: string;
  ar: string;
  ckb: string;
}

const mapOf = (rows: readonly TmDbRow[]): Map<string, Tr> => {
  const out = new Map<string, Tr>();
  for (const r of rows) {
    const en = typeof r.en === 'string' ? r.en : '';
    if (!en || typeof r.ar !== 'string' || typeof r.ckb !== 'string' || !r.ar || !r.ckb) continue;
    // A Sorani slot never copies the Arabic (row 183): such a row is not shown in either language.
    if (r.ckb === r.ar) continue;
    out.set(en, { ar: r.ar, ckb: r.ckb });
  }
  return out;
};

/** The shown translations one product's refs name. One statement, one parameter. */
export async function loadProductTranslationMap(db: D1Database, productId: string): Promise<TranslationMap> {
  return translationRead(
    db,
    async () =>
      mapOf(
        (
          await db
            .prepare(
              `SELECT t.en, t.ar, t.ckb FROM catalog_translation_refs r JOIN catalog_translations t ON t.h = r.h
                WHERE r.product_id = ?1 AND t.status IN ('reviewed','machine')`
            )
            .bind(productId)
            .all<TmDbRow>()
        ).results ?? []
      ),
    EMPTY_TRANSLATIONS
  );
}

/** The shown translations of several products (the comparison's ≤ 4), by product id. One statement, one parameter. */
export async function loadProductsTranslationMaps(db: D1Database, ids: readonly string[]): Promise<Map<string, TranslationMap>> {
  const wanted = [...new Set(ids)].filter(Boolean);
  if (!wanted.length) return new Map();
  return translationRead(
    db,
    async () => {
      const rows =
        (
          await db
            .prepare(
              `SELECT r.product_id, t.en, t.ar, t.ckb FROM catalog_translation_refs r JOIN catalog_translations t ON t.h = r.h
                WHERE r.product_id IN (SELECT value FROM json_each(?1)) AND t.status IN ('reviewed','machine')`
            )
            .bind(JSON.stringify(wanted))
            .all<TmDbRow>()
        ).results ?? [];
      const byProduct = new Map<string, TmDbRow[]>();
      for (const r of rows) {
        const id = String(r.product_id ?? '');
        const list = byProduct.get(id);
        if (list) list.push(r);
        else byProduct.set(id, [r]);
      }
      return new Map([...byProduct].map(([id, list]) => [id, mapOf(list) as TranslationMap]));
    },
    new Map<string, TranslationMap>()
  );
}

/** A lookup over a map: the normalized English → its translation, or null. */
export const lookupIn =
  (tm: TranslationMap) =>
  (normEn: string): Tr | null =>
    tm.get(normEn) ?? null;

/** One whole value's translation (a spec value, an item, a title), or undefined. */
export function translationOf(tm: TranslationMap | undefined, text: unknown): Tr | undefined {
  if (!tm || tm.size === 0 || typeof text !== 'string') return undefined;
  const n = normalizeSource(text);
  return n ? tm.get(n) : undefined;
}

// ---------------------------------------------------------------- the overlay

/** The spec group only the import writes (worker/lib/catalogImport/writer.ts `OFFICIAL_SPEC_GROUP`). */
export const IMPORT_SPEC_GROUP_ID = 'sg_bambu_official';

/**
 * True when the import wrote this product: only then does the product page
 * read the memory. An ordinary product pays nothing.
 *
 * The import's writer (worker/lib/catalogImport/writer.ts step 10) marks each
 * slot it wrote `{ ar: imported, ckb: imported }` and never an `en` entry. The
 * admin form (worker/routes/adminProducts.ts, every saved product) and the
 * template import (worker/lib/template.ts) write `imported` too, but always
 * with `en` beside it — so `imported` alone is not the import's mark (it would
 * read the memory for nearly every product). An imported product the owner
 * later saves in the form gains `en` on its name and description only; its
 * other slots keep the writer's mark, and its official spec group (written by
 * the import alone) marks it as well.
 */
export function importedSlots(meta: TranslationMeta | null | undefined, specGroups?: ReadonlyArray<{ id?: unknown } | null> | null): boolean {
  if (Array.isArray(specGroups) && specGroups.some((g) => g?.id === IMPORT_SPEC_GROUP_ID)) return true;
  if (!meta || typeof meta !== 'object') return false;
  for (const entry of Object.values(meta)) {
    if (!entry || typeof entry !== 'object' || 'en' in entry) continue;
    if (entry.ar?.status === 'imported' || entry.ckb?.status === 'imported') return true;
  }
  return false;
}

/** The slots the overlay may write: prose only — never a name, an option, a colour, a lead time, a warranty or a label. */
export const OVERLAY_SLOTS: ReadonlyArray<RegExp> = [
  /^description$/,
  /^how_to_use$/,
  /^usage_step:[^:]+:(title|body)$/,
  /^block:[^:]+:body$/,
  /^spec:sg_bambu_official:[^:]+:value$/,
];

export const isOverlaySlot = (key: string): boolean => OVERLAY_SLOTS.some((re) => re.test(key));

/**
 * Writes the memory's Arabic and Sorani into the outgoing product body (the
 * shape `catalogOnlyCard` / `publicWithDisplayPrice` answer), slot by slot,
 * line by line. A slot whose language a human approved is left alone. The
 * keys and the shape never change; the legacy aliases that mirror a slot
 * (`description_ku`, `specifications[]`) follow it. Returns how many slot
 * languages changed.
 */
export function overlayImportedText(product: Record<string, unknown>, tm: TranslationMap, meta: TranslationMeta | null | undefined): number {
  if (!tm.size) return 0;
  const lookup = lookupIn(tm);
  let changed = 0;
  for (const slot of localizableSlots(product)) {
    if (!isOverlaySlot(slot.key) || !slot.en.trim()) continue;
    // A line the memory misses keeps what the slot already says (the writer's dictionary line, §A.6).
    const t = translateLines(slot.en, lookup, { ar: slot.ar, ckb: slot.ckb });
    if (t.hit === 0) continue;
    const m = meta?.[slot.key];
    for (const lang of ['ar', 'ckb'] as const) {
      if (m?.[lang]?.status === 'approved') continue;
      slot.set(lang, t[lang]);
      changed += 1;
    }
  }
  if (!changed) return 0;
  // The pre-v2 aliases (products.ts `legacyAliases`): the Sorani description and the flat spec view.
  if ('description_ku' in product) product.description_ku = product.description_ckb;
  // `specifications` is the document's own groups flattened; the projected `spec_groups` are those groups first, then
  // the ones derived from `spec_fields` — so entry i is row i, checked by its label before it is touched.
  if (Array.isArray(product.specifications) && Array.isArray(product.spec_groups)) {
    const flat = (product.spec_groups as Array<Record<string, unknown>>).flatMap((g) => (Array.isArray(g?.rows) ? (g.rows as Array<Record<string, unknown>>) : []));
    product.specifications = (product.specifications as Array<Record<string, unknown>>).map((entry, i) => {
      const r = flat[i];
      if (!r || !entry || typeof entry !== 'object' || entry.key !== (r.label_ar || r.label_en)) return entry;
      return { ...entry, value: String(r.value_ar || r.value_en || '') };
    });
  }
  return changed;
}
