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
 * Every branch filters on `status = 'active'` here rather than at the caller,
 * so a draft product can never inflate a shelf count.
 */
export const MEMBERSHIP_CTE = `
  membership(product_id, catalog_id) AS (
    SELECT pc.product_id, pc.catalog_id
      FROM product_catalogs pc
      JOIN products p ON p.id = pc.product_id
     WHERE p.status = 'active'
    UNION
    SELECT p.id, p.category_id
      FROM products p
     WHERE p.status = 'active' AND p.category_id IS NOT NULL AND p.category_id <> ''
    UNION
    SELECT p.id, p.sub_category_id
      FROM products p
     WHERE p.status = 'active' AND p.sub_category_id IS NOT NULL AND p.sub_category_id <> ''
  )`;

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
}

/**
 * The whole active catalog tree with descendant-inclusive counts, in ONE read.
 *
 * One query rather than one per catalog: a taxonomy is tens of rows, and the
 * home page is the shop's first screen. Inactive catalogs are excluded from
 * the OUTPUT but not from the ancestor walk — deactivating a middle branch
 * must not detach its children's products from the root they belong to.
 */
export async function catalogTreeWithCounts(db: D1Database): Promise<CatalogCountRow[]> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE ${ANCESTORS_CTE},
       ${MEMBERSHIP_CTE},
       counted AS (
         SELECT a.ancestor_id AS id, COUNT(DISTINCT m.product_id) AS n
           FROM membership m
           JOIN ancestors a ON a.node_id = m.catalog_id
           JOIN products p ON p.id = m.product_id AND p.composition = ''
          GROUP BY a.ancestor_id
       )
       SELECT c.id, c.parent_id, c.slug, c.name_ar, c.name_en, c.name_ckb, c.sort,
              COALESCE(k.n, 0) AS product_count
         FROM catalogs c
         LEFT JOIN counted k ON k.id = c.id
        WHERE c.active = 1
        ORDER BY c.sort, COALESCE(NULLIF(c.name_en, ''), c.name_ar)`
    )
    .all<CatalogCountRow>();
  return (results ?? []).map((r) => ({ ...r, product_count: Number(r.product_count) || 0 }));
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

  const withProducts = rows.filter((r) => r.product_count > 0);
  const roots = dedupeByName(withProducts.filter((r) => r.parent_id === null)).slice(0, maxRoots);

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
    children: dedupeByName(
      withProducts.filter((r) => r.parent_id !== null && rootOf(r) === root.id)
    ).slice(0, maxChildren),
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
