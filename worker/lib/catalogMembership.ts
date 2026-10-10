/**
 * WHICH PRODUCTS ARE IN A CATALOG — ONE ANSWER, ASSEMBLED FROM THE TWO PLACES
 * THE SHOP RECORDS IT.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The owner filled in the taxonomy — Printers,
 * FDM Printers, Resin Printers, Printing Materials, and eighteen more — put
 * three products in them, saw «الطابعات · 3» in the admin, and the storefront's
 * home page showed no categories at all. Not a thin strip: nothing.
 *
 * `/api/home` counted through `product_catalogs`:
 *
 *     SELECT COUNT(*) FROM product_catalogs pc JOIN products p ON p.id = pc.product_id
 *      WHERE pc.catalog_id = c.id AND p.status = 'active'
 *
 * and the admin counted through the column the product form actually writes:
 *
 *     SELECT category_id AS id, COUNT(*) FROM products WHERE category_id IS NOT NULL GROUP BY category_id
 *
 * `product_catalogs` was empty, so every catalog scored zero, the
 * `product_count > 0` filter dropped all of them, and `categories` came back
 * as `[]` — which is exactly what the live API returns today.
 *
 * AND IT WAS BEING ACTIVELY EMPTIED. `EditorDoc.catalog_ids` is initialised to
 * `[]` (src/components/adminProducts/types.ts) and the form never writes to it
 * when the owner picks a main or sub section — those two set `category_id` and
 * `sub_category_id`. So every save posted `catalog_ids: []`, and
 * `planCatalogs()` is a REPLACE: it deletes the placements that are not in the
 * list it was given. Saving a product deleted its shelf.
 *
 * WHY THIS IS NOT "TWO SOURCES OF TRUTH", WHICH WOULD BE THE WRONG FIX.
 *
 * They record two different facts that happen to overlap:
 *
 *   CLASSIFICATION — `products.category_id` / `products.sub_category_id`.
 *   Which branch of the tree this product IS. One main, one sub. It decides
 *   the template family, and with it which specification fields the form even
 *   shows. This is what the owner chooses in «القسم الرئيسي» / «القسم الفرعي».
 *
 *   PLACEMENT — `product_catalogs(product_id, catalog_id, position)`. Which
 *   shelves list this product, and in what order on each. Many-to-many, and
 *   the importer and the merchandising screens write it directly.
 *
 * A classification IMPLIES a placement — a product classified under FDM
 * Printers is on the FDM Printers shelf, necessarily — so the membership
 * relation is the union, and the union is complete rather than ambiguous.
 * `assertClassificationPlaced()` below is the other half: it stops a save
 * from removing a placement its own classification implies, so the two can
 * never disagree about the products they both describe.
 *
 * ANCESTORS COUNT. A product in "FDM Printers" is in "Printers". The owner's
 * request was «الأقسام الرئيسية ثم الأقسام الفرعية التي فيها المنتجات» — main
 * sections, then the sub-sections that hold products — and a main section whose
 * children hold everything would otherwise read as empty and be filtered off
 * the page, which is the same bug one level up.
 */

/**
 * Every (product, catalog) membership, as one relation.
 *
 * Deliberately NOT a view or a table: it is a CTE inlined into each query so
 * SQLite can push the callers' own predicates into it. The three branches are
 * the explicit placements and the two classification columns; `UNION` (not
 * `UNION ALL`) because a product classified under a catalog it is also
 * explicitly placed in is one membership, not two.
 *
 * Every branch filters on «listed to customers» (active, and not held by the
 * owner's «hide incomplete» switch — worker/lib/listing.ts) here rather than
 * at the caller, so a draft or held product can never inflate a shelf count.
 * `heldInstalled`: include the held clause (callers run the statement through `runListed`, worker/lib/listing.ts).
 */
export function membershipCte(heldInstalled: boolean): string {
  const listed = listedSql('p', heldInstalled);
  return `
  membership(product_id, catalog_id) AS (
    SELECT pc.product_id, pc.catalog_id
      FROM product_catalogs pc
      JOIN products p ON p.id = pc.product_id
     WHERE ${listed}
    UNION
    SELECT p.id, p.category_id
      FROM products p
     WHERE ${listed} AND p.category_id IS NOT NULL AND p.category_id <> ''
    UNION
    SELECT p.id, p.sub_category_id
      FROM products p
     WHERE ${listed} AND p.sub_category_id IS NOT NULL AND p.sub_category_id <> ''
  )`;
}

import { catalogImageUrl } from './siteMedia';
import { listedSql, listedWithoutHeld, runListed } from './listing';
import { isSchemaMissing } from './membershipBenefits';

/**
 * Each catalog paired with itself and every ancestor above it, so a count
 * grouped by `ancestor_id` is descendant-inclusive.
 *
 * `WITH RECURSIVE` walks UP from each node rather than down from each root:
 * the tree is at most a few levels deep and this direction needs no seed list.
 * `UNION` rather than `UNION ALL` terminates a cycle should one ever be
 * written — a catalog that is its own ancestor would otherwise recurse for
 * ever, and a taxonomy editor is a place where that can happen.
 */
export const ANCESTORS_CTE = `
  ancestors(node_id, ancestor_id) AS (
    SELECT id, id FROM catalogs
    UNION
    SELECT a.node_id, c.parent_id
      FROM ancestors a
      JOIN catalogs c ON c.id = a.ancestor_id
     WHERE c.parent_id IS NOT NULL
  )`;

/** A catalog row as the storefront reads it, with its own count. */
export interface CatalogNode {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sort: number;
  /** Active products in this catalog OR anywhere below it. */
  product_count: number;
  /**
   * The `/files/...` path of the cover an ADMIN set for this section, or ''.
   *
   * A URL and not the stored key, because this shape is serialised straight
   * into `/api/home`: the storefront draws category cards and has no business
   * knowing what `UiUx/MainPage/` is or how a media key is turned into a
   * request. Empty means the section has no authored picture, which is not an
   * error — CategoryBoard then borrows a product photo, and failing that draws
   * the monogram, exactly as it did before 0100 existed.
   *
   * Since 0149 it is the card's DARK picture for a LARGE screen, and the
   * three below complete the set — dark and light, large and phone — each ''
   * when not uploaded (src/lib/catalog/sectionPictures.ts fills the gaps).
   */
  image_url: string;
  light_image_url: string;
  mobile_image_url: string;
  light_mobile_image_url: string;
  /** Sub-catalogs that hold at least one product. Only set on a root. */
  children?: CatalogNode[];
}

interface CatalogCountRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sort: number;
  product_count: number;
  image_url: string;
  light_image_url: string;
  mobile_image_url: string;
  light_mobile_image_url: string;
}

/**
 * A section card's four pictures (0100 + 0149), by the column each is read
 * from and the field its URL leaves the worker as.
 */
const CARD_PICTURES = [
  { column: 'image_key', url: 'image_url' },
  { column: 'light_image_key', url: 'light_image_url' },
  { column: 'mobile_image_key', url: 'mobile_image_url' },
  { column: 'light_mobile_image_key', url: 'light_mobile_image_url' },
] as const;
type CardPictureColumn = (typeof CARD_PICTURES)[number]['column'];

/** Every picture read from its column. */
const ALL_COVERS = CARD_PICTURES.map((p) => `COALESCE(c.${p.column}, '')`);

/**
 * The tree query. The covers are spliced in rather than fixed, because the
 * first screen must still render on a database that has not had migration
 * 0100 (or 0149) yet — see `catalogTreeWithCounts` below. `covers` is one SQL
 * expression per entry of CARD_PICTURES, in its order.
 */
const treeSql = (covers: readonly string[], heldInstalled: boolean) => `WITH RECURSIVE ${ANCESTORS_CTE},
       ${membershipCte(heldInstalled)},
       counted AS (
         SELECT a.ancestor_id AS id, COUNT(DISTINCT m.product_id) AS n
           FROM membership m
           JOIN ancestors a ON a.node_id = m.catalog_id
           JOIN products p ON p.id = m.product_id AND p.composition = ''
          GROUP BY a.ancestor_id
       )
       SELECT c.id, c.parent_id, c.slug, c.name_ar, c.name_en, c.name_ckb, c.sort,
              COALESCE(k.n, 0) AS product_count,
              ${CARD_PICTURES.map((p, i) => `${covers[i]} AS ${p.column}`).join(',\n              ')}
         FROM catalogs c
         LEFT JOIN counted k ON k.id = c.id
        WHERE c.active = 1
        ORDER BY c.sort, COALESCE(NULLIF(c.name_en, ''), c.name_ar)`;

/**
 * Which of the card's picture columns does `catalogs` lack — when THAT, and
 * nothing else, is why the tree query failed? `null` means "re-throw".
 *
 * THE SAME SHAPE, AND THE SAME NARROWNESS, AS `isConditionColumnMissing`
 * (worker/lib/conditionProjection.ts), which exists because a Worker carrying
 * migration 0085 once reached production over a database still at 0083 and
 * `/api/home` answered HTTP 500 for the WHOLE first screen — products,
 * categories and brands included — over one unreadable optional shelf.
 * Migrations 0100 and 0149 create exactly that window again, and this is what
 * closes it: the code and the migration are deployed by two different
 * workflow steps and there is no ordering that removes the gap entirely.
 *
 * SUBSTITUTION, NOT DEGRADE, and the distinction is arithmetic rather than
 * judgement. Every picture column is declared `TEXT NOT NULL DEFAULT ''` and
 * `''` means "no authored picture", so a column that does not exist yet can
 * hold nothing else: the instant its migration runs, every pre-existing row
 * carries `''`. A section drawn with a borrowed product photo on a pre-0100
 * database is not a guess about what the owner chose — it is what they had
 * chosen, one migration early.
 *
 * Everything else re-throws. A missing `catalogs` TABLE must not render as a
 * shop with no departments, and any OTHER absent column could be hiding real
 * rows behind an empty answer — which is why, when every picture column is
 * present, the failure is somebody else's and is re-thrown.
 */
async function missingCardPictureColumns(db: D1Database, e: unknown): Promise<Set<CardPictureColumn> | null> {
  if (!isSchemaMissing(e)) return null;
  let cols: { name: string }[];
  try {
    const { results } = await db.prepare('PRAGMA table_info(catalogs)').all<{ name: string }>();
    cols = results ?? [];
  } catch {
    // If we cannot even ask, we do not get to assume. Re-throw.
    return null;
  }
  if (cols.length === 0) return null; // the TABLE is gone, not a column
  const have = new Set(cols.map((c) => String(c.name)));
  const missing = new Set(CARD_PICTURES.map((p) => p.column).filter((c) => !have.has(c)));
  if (missing.size === 0) return null; // something else failed
  console.error(
    `catalogs.${[...missing].join(', catalogs.')} ${missing.size === 1 ? 'is' : 'are'} behind the deployment ` +
      '(migration 0100 / 0149 has not been applied); those section pictures read as "none" until it is'
  );
  return missing;
}

/**
 * The whole active catalog tree with descendant-inclusive counts, in ONE read.
 *
 * One query rather than one per catalog: a taxonomy is tens of rows, and the
 * home page is the shop's first screen. Inactive catalogs are excluded from
 * the OUTPUT but not from the ancestor walk — deactivating a middle branch
 * must not detach its children's products from the root they belong to.
 *
 * The retry costs a correctly migrated database nothing: the second statement
 * is only ever prepared after the first has already refused for missing
 * schema, which on a migrated database never happens.
 */
export async function catalogTreeWithCounts(db: D1Database): Promise<CatalogCountRow[]> {
  type Row = Omit<CatalogCountRow, (typeof CARD_PICTURES)[number]['url']> & Partial<Record<CardPictureColumn, unknown>>;
  // Optimistic on the held clause (worker/lib/listing.ts `runListed`): no probe before the first screen's wave.
  const heldInstalled = !listedWithoutHeld(db);
  const read = async (covers: readonly string[]) =>
    (await runListed(db, treeSql(covers, heldInstalled), (q) => db.prepare(q).all<Row>())).results ?? [];

  let rows: Row[];
  try {
    rows = await read(ALL_COVERS);
  } catch (e) {
    const missing = await missingCardPictureColumns(db, e);
    if (!missing) throw e;
    rows = await read(CARD_PICTURES.map((p, i) => (missing.has(p.column) ? "''" : ALL_COVERS[i])));
  }

  // The keys are turned into URLs HERE and the keys themselves are dropped,
  // so the only representation that ever leaves the worker is the one the
  // storefront can use. `catalogImageUrl` re-validates on the way out: the
  // columns are written by one admin route but they are still text columns in
  // a database a future import could touch, and a bad value must degrade to
  // "no picture" rather than to a broken <img> on the first screen.
  return rows.map(({ image_key, light_image_key, mobile_image_key, light_mobile_image_key, ...r }) => ({
    ...r,
    product_count: Number(r.product_count) || 0,
    image_url: catalogImageUrl(image_key),
    light_image_url: catalogImageUrl(light_image_key),
    mobile_image_url: catalogImageUrl(mobile_image_key),
    light_mobile_image_url: catalogImageUrl(light_mobile_image_key),
  }));
}

/**
 * The display name a duplicate check groups on.
 *
 * THE LIVE DATABASE ONCE HELD SEVEN TOP-LEVEL CATALOGS CALLED "Printers" and
 * seven brands called "Bambu Lab", left behind by repeated seeding, and the
 * home page drew seven identical chips in a row. The duplicate ROWS are the
 * owner's to clean up; the storefront must not put them on the first screen
 * meanwhile, so one chip per distinct name survives — the one that actually
 * holds the most products.
 */
const displayKey = (r: { name_en: string; name_ar: string }) => (r.name_en?.trim() || r.name_ar || '').toLowerCase();

/** Keeps, per display name, the row with the largest count (ties: the first). */
function dedupeByName(rows: CatalogCountRow[]): CatalogCountRow[] {
  const best = new Map<string, CatalogCountRow>();
  for (const r of rows) {
    const key = displayKey(r);
    const have = best.get(key);
    if (!have || r.product_count > have.product_count) best.set(key, r);
  }
  // Map preserves insertion order, which is the query's ORDER BY — but a later
  // row can REPLACE an earlier one, so re-sort to keep `sort` authoritative.
  return [...best.values()].sort(
    (a, b) => a.sort - b.sort || (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar)
  );
}

export interface CategoryTreeOptions {
  /** Roots to return. Default 12 — the home strip, not the full taxonomy. */
  maxRoots?: number;
  /** Sub-sections shown under each root. Default 8. */
  maxChildrenPerRoot?: number;
  /**
   * Sections that must survive the caps when they hold something — the ones
   * the owner assigned to a square of the home bento (worker/lib/homeBento.ts),
   * which would otherwise vanish from the page for being the ninth child.
   */
  keep?: ReadonlySet<string>;
}

/**
 * The home page's category tree: main sections that hold something, each with
 * the sub-sections that hold something.
 *
 * A catalog with no active product is dropped at BOTH levels — a category card
 * that leads to an empty list is a dead end, and the owner has twenty-two
 * catalogs of which three currently hold anything.
 */
export async function homeCategoryTree(
  db: D1Database,
  opts: CategoryTreeOptions = {}
): Promise<CatalogNode[]> {
  const maxRoots = opts.maxRoots ?? 12;
  const maxChildren = opts.maxChildrenPerRoot ?? 8;
  const rows = await catalogTreeWithCounts(db);

  const keep = opts.keep ?? new Set<string>();
  const withProducts = rows.filter((r) => r.product_count > 0);
  // Cap, then put back any kept section the cap cut off.
  const capped = (list: CatalogCountRow[], max: number): CatalogCountRow[] => {
    const head = list.slice(0, max);
    return [...head, ...list.slice(max).filter((r) => keep.has(r.id))];
  };
  const roots = capped(dedupeByName(withProducts.filter((r) => r.parent_id === null)), maxRoots);

  // A child is anything whose ancestor chain reaches this root — not only a
  // direct child — so a three-level taxonomy still puts its leaves on the page
  // instead of hiding them behind a middle branch nobody would click.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rootOf = (r: CatalogCountRow): string | null => {
    let node: CatalogCountRow | undefined = r;
    const seen = new Set<string>();
    while (node && node.parent_id) {
      if (seen.has(node.id)) return null; // a cycle: refuse rather than hang
      seen.add(node.id);
      node = byId.get(node.parent_id);
    }
    return node ? node.id : null;
  };

  return roots.map((root) => ({
    ...root,
    children: capped(
      dedupeByName(withProducts.filter((r) => r.parent_id !== null && rootOf(r) === root.id)),
      maxChildren
    ),
  }));
}

/**
 * A `WHERE` fragment matching products in `catalogId` OR anywhere below it.
 *
 * The listing used to test `subcategory_id = ? OR id IN (SELECT ... FROM
 * product_catalogs WHERE catalog_id = ?)`, which missed two things at once:
 * the CLASSIFICATION columns, and every descendant — so tapping "Printers"
 * listed nothing while its FDM child held the whole shelf.
 *
 * `subcategory_id` (no underscore) is kept in the test on purpose: it is the
 * free-text legacy column from migration 0001, distinct from `sub_category_id`
 * added in 0018, and rows written before the taxonomy existed still carry it.
 *
 * Returns its own bindings rather than taking numbered `?N` placeholders: the
 * callers concatenate this into a larger statement that already carries plain
 * `?`, and SQLite's rule for mixing the two forms ("?" takes one more than the
 * highest number used so far) is a trap nobody should have to hold in mind.
 */
export function catalogSubtreeFilter(
  catalogId: string,
  productsAlias = 'products'
): { sql: string; params: string[] } {
  return {
    sql: `(
    ${productsAlias}.subcategory_id = ?
    OR ${productsAlias}.id IN (
      WITH RECURSIVE subtree(id) AS (
        SELECT ?
        UNION
        SELECT c.id FROM catalogs c JOIN subtree s ON c.parent_id = s.id
      )
      SELECT pc.product_id FROM product_catalogs pc JOIN subtree s ON s.id = pc.catalog_id
      UNION
      SELECT p2.id FROM products p2 JOIN subtree s ON s.id = p2.category_id
      UNION
      SELECT p3.id FROM products p3 JOIN subtree s ON s.id = p3.sub_category_id
    )
  )`,
    params: [catalogId, catalogId],
  };
}

/**
 * The placements a product's own classification implies.
 *
 * THE OTHER HALF OF THE FIX, and the half that keeps it fixed. The product
 * form posts `catalog_ids` and `planCatalogs` treats that list as the complete
 * set — anything absent is DELETED. The form initialises the list to `[]` and
 * never fills it from the two selects the owner actually uses, so every save
 * deleted the product's placements.
 *
 * Rather than trusting the client to remember, the server folds the
 * classification back in: whatever `catalog_ids` arrives, the main and sub
 * section the same request is saving are in it. A client that sends nothing
 * can no longer unshelve a product, and the importer — which writes
 * `catalog_ids` directly — is unaffected because its ids are already there.
 */
export function withClassificationPlacements(
  catalogIds: readonly string[],
  classification: { category_id?: unknown; sub_category_id?: unknown }
): string[] {
  const out = [...catalogIds];
  for (const value of [classification.category_id, classification.sub_category_id]) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
