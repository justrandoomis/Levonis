/**
 * THE KNOWLEDGE ANSWER — `GET /api/products/:slug/knowledge` (the Bambu import
 * spec §G.1, §G.2, §G.4, §B.2; docs/DECISIONS.md rows 239 and 241).
 *
 * What a customer may read about a product beyond its page body: the typed
 * specifications with their provenance and status, the logistics facts, what is
 * in the box, compatibility, the official documents and how complete the
 * picture is. Loaded by the product page's lazy tabs when they near the
 * viewport — never on first paint.
 *
 * AN ALLOW-LIST, BUILT FIELD BY FIELD. Nothing is spread from a row. What never
 * leaves (row 241, the brief's money and privacy rule):
 *   - a row with `visibility = 'owner'`, and the registry's owner-only keys
 *     (manufacturer warranty notes, CBM `package.volume_m3`) even if a row
 *     forgot its visibility (L-4, L-19);
 *   - a `store_page` / `store_messages` reference (`source_ref`): the store's
 *     own page address is owner provenance. Only a public DOCUMENT gets a URL —
 *     a manual, TDS, SDS, wiki page or store-CDN document on an allow-listed
 *     host — and the store's own pages lose their title too (no store word
 *     reaches a customer);
 *   - `canonical_url`, a swatch's `source_url` / `hex_source_ref`, a document's
 *     tracker link, a relation's source handle or evidence, a conflict's text
 *     (only `conflict: true`), `derived_from`, `original_value`;
 *   - a resolved relation's product unless that product is VISIBLE (§B.6):
 *     otherwise the label alone.
 *
 * THE SHAPING IS ./answer.ts (`assembleKnowledge`, pure): this module only
 * reads the rows that may show — public, active, on a live scope — and hands
 * them over with the Worker's picture rule. The import's runner hands the same
 * function the rows its payload makes, so VERIFY expects this very answer.
 *
 * WITHOUT 0194 the answer is empty (CLAUDE.md rule 2): every read goes through
 * `knowledgeRead`, and a missing table answers `EMPTY_KNOWLEDGE`.
 *
 * EVERY PUBLIC ROW IS IN THE ANSWER ONCE. The import's live check (§I.1.2,
 * packages/catalog/src/bambuImport/fingerprint.ts `KnowledgeAnswer`) rebuilds
 * the public facts from it: `specs[].rows` hold every row but logistics and the
 * box, `logistics.*` the logistics rows (same row shape), `in_the_box` the box
 * items with their row's scope, region and status, plus `swatches`, `documents`
 * and the relations under `compatibility`.
 */
import { canonicalProductMediaUrl } from '../productModel';
import { optimisticVisible, runListed } from '../listing';
import { productImageFromRelations } from '../productSelectionImage';
import type { ImageRow } from '../productOverlay';
import { isMissingKnowledgeSchema, knowledgeRead } from './schema';
import { assembleKnowledge, boxItemsWith, emptyKnowledge, type InTheBoxItem, type ProductKnowledge, type SpecValueDbRow } from './answer';

/*
 * The answer's shape and every rule that shapes it live in ./answer.ts (pure: the import's runner builds its
 * expectation with the same functions). Re-exported here for the callers that know this module.
 */
export {
  assembleKnowledge,
  boxItemsWith,
  compatibilityBucketOf,
  emptyKnowledge,
  isOwnerOnlyKey,
  knowledgeRowOf,
  publicDocumentUrl,
  type CheckedSource,
  type CompatibilityBucket,
  type CompatibilityItem,
  type InTheBoxItem,
  type KnowledgeDocument,
  type KnowledgeGroup,
  type KnowledgeRow,
  type KnowledgeScope,
  type KnowledgeSource,
  type KnowledgeSwatch,
  type ProductKnowledge,
  type Region,
  type ScopeKind,
  type SpecValueDbRow,
} from './answer';

/** The box items of one `package.contents` row, each picture on its canonical `/files/…webp` address. */
export function boxItemsOf(r: SpecValueDbRow): InTheBoxItem[] {
  return boxItemsWith(r, canonicalProductMediaUrl);
}

const SPEC_COLUMNS = `canonical_key, group_key, scope_kind, scope_id, region, data_type, original_label, value_text, value_num,
       value_num_max, value_bool, value_list, unit, status, source_kind, source_ref, source_title, source_locator,
       source_excerpt, test_method, test_condition, checked_sources, conflict, sort`;

/**
 * A row's scope is LIVE: the product itself, or a value of an active group /
 * an active variant of this very product. The page body drops an inactive
 * group, an inactive value and an inactive variant (productOverlay.ts
 * `relationsBlock`), so a fact scoped to one of them — or to one deleted since —
 * is off-screen everywhere: it never reaches the answer, the edge or a tab's
 * «إصدارات أخرى». A condition on the same statement: no new wave.
 */
const scopeLive = (a: string) => `CASE ${a}.scope_kind
      WHEN 'option_value' THEN EXISTS (SELECT 1 FROM product_option_values lv JOIN product_option_groups lg ON lg.id = lv.group_id
                                        WHERE lv.id = ${a}.scope_id AND lv.product_id = ${a}.product_id AND lv.active = 1 AND lg.active = 1)
      WHEN 'variant' THEN EXISTS (SELECT 1 FROM product_variants lx WHERE lx.id = ${a}.scope_id AND lx.product_id = ${a}.product_id AND lx.active = 1)
      ELSE 1 END`;

// ------------------------------------------------------------------ the read

/**
 * Everything `/knowledge` answers for one VISIBLE product (the route checked
 * that). ONE WAVE of six statements — the pictures of the relation targets
 * ride it too, their ids a subquery of the relation read's own rule, so an
 * imported printer linking its AMS, plates and filaments costs no dependent
 * round trip (tests/d1Waves.test.ts measures that path). Empty without 0194.
 * A fact scoped to a value or variant the page body no longer shows is left
 * out (`scopeLive`).
 */
export async function loadProductKnowledge(db: D1Database, productId: string): Promise<ProductKnowledge> {
  const visibleTarget = optimisticVisible(db, 't');
  const [specRows, docRows, relationRows, swatchRows, sourceRows, targetImages] = await Promise.all([
    knowledgeRead(db, async () =>
      (
        await db
          .prepare(`SELECT ${SPEC_COLUMNS} FROM product_spec_values s WHERE s.product_id = ? AND s.visibility = 'public' AND ${scopeLive('s')}
                     ORDER BY sort, canonical_key, scope_kind, scope_id, region`)
          .bind(productId)
          .all<SpecValueDbRow>()
      ).results ?? []
    ),
    knowledgeRead(db, async () =>
      (
        await db
          .prepare(`SELECT d.kind, d.title_en, d.title_ar, d.title_ckb, d.url, d.host, d.scope_kind, d.scope_id FROM product_documents d
                     WHERE d.product_id = ? AND d.active = 1 AND ${scopeLive('d')} ORDER BY d.sort, d.kind, d.url`)
          .bind(productId)
          .all<Record<string, unknown>>()
      ).results ?? []
    ),
    knowledgeRead(db, async () =>
      (
        await runListed(
          db,
          `SELECT r.relation, r.target_kind, r.target_label, r.state, r.scope_kind, r.scope_id,
                  t.id AS t_id, t.slug AS t_slug, t.name AS t_name, t.name_ar AS t_name_ar, t.name_ku AS t_name_ku
             FROM product_relations r
             LEFT JOIN products t ON t.id = r.target_product_id AND r.state = 'resolved' AND COALESCE(t.composition, '') = '' AND ${visibleTarget}
            WHERE r.product_id = ? AND ${scopeLive('r')}
            ORDER BY r.relation, r.scope_kind, r.scope_id, r.target_label`,
          (q) => db.prepare(q).bind(productId).all<Record<string, unknown>>()
        )
      ).results ?? []
    ),
    knowledgeRead(db, async () =>
      (
        await db
          .prepare(`SELECT s.option_value_id, s.url, s.width, s.height, s.published_hex
                      FROM product_option_value_swatches s
                      JOIN product_option_values v ON v.id = s.option_value_id AND v.product_id = s.product_id AND v.active = 1
                      JOIN product_option_groups g ON g.id = v.group_id AND g.active = 1
                     WHERE s.product_id = ? ORDER BY s.option_value_id`)
          .bind(productId)
          .all<Record<string, unknown>>()
      ).results ?? []
    ),
    // The route is read only to know the product's TYPE (its expected keys); it never leaves the Worker.
    knowledgeRead(db, async () =>
      (
        await db
          .prepare('SELECT source_route FROM product_source_refs WHERE product_id = ? ORDER BY source, source_product_id LIMIT 1')
          .bind(productId)
          .all<{ source_route: string }>()
      ).results ?? []
    ),
    // The pictures of the targets a customer may follow (resolved, VISIBLE, not a composition, a live
    // scope): every image row, the picture chosen below exactly as every card's. A failure that is not
    // a missing 0194 costs the pictures, never the answer (as loadAuthoritativeProductImages).
    knowledgeRead(db, async () => {
      try {
        return (
          (
            await runListed(
              db,
              `SELECT i.* FROM product_images i
                WHERE i.product_id IN (SELECT r.target_product_id FROM product_relations r
                                         JOIN products t ON t.id = r.target_product_id AND COALESCE(t.composition, '') = '' AND ${visibleTarget}
                                        WHERE r.product_id = ? AND r.state = 'resolved' AND ${scopeLive('r')})
                ORDER BY i.product_id, i.sort_order, i.id`,
              (q) => db.prepare(q).bind(productId).all<ImageRow>()
            )
          ).results ?? []
        );
      } catch (e) {
        if (isMissingKnowledgeSchema(e)) throw e;
        console.error(`knowledge: relation target pictures unavailable: ${e instanceof Error ? e.message : String(e)}`);
        return [] as ImageRow[];
      }
    }),
  ]);
  if (!specRows || !docRows || !relationRows || !swatchRows || !sourceRows || !targetImages) return emptyKnowledge();
  const imagesOf = new Map<string, ImageRow[]>();
  for (const image of targetImages) imagesOf.set(image.product_id, [...(imagesOf.get(image.product_id) ?? []), image]);
  const pictures = new Map([...imagesOf].map(([id, rows]) => [id, productImageFromRelations(rows)]));
  return assembleKnowledge(
    { specs: specRows, documents: docRows, relations: relationRows, swatches: swatchRows, sourceRoute: sourceRows[0]?.source_route ?? null },
    { url: canonicalProductMediaUrl, targetPicture: (id) => pictures.get(id) ?? '' }
  );
}
