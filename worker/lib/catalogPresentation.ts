/**
 * THE CATALOG AS A MAP OF THE SHOP — the explorer's tree, the category page's
 * shelves and its brands (docs/ux/CATALOG_DISCOVERY.md §5, §6, §11;
 * IMPLEMENTATION_PLAN.md S1).
 *
 * ONE MEMBERSHIP RELATION. Which products a section holds is decided exactly
 * where the home page and the listing already decide it —
 * worker/lib/catalogMembership.ts: the classification columns plus the explicit
 * placements, rolled up through every ancestor, drafts and compositions never
 * counted. This file adds no second definition; it reads that relation ONCE per
 * request and does the rest in memory (a taxonomy is tens of rows).
 *
 * NO CAPS ON THE TREE. `homeCategoryTree` cuts at 12 roots and 8 children
 * because it feeds one strip on the home page; the explorer is the whole map,
 * so nothing non-empty is dropped here.
 *
 * NOTHING EMPTY IS EVER DRAWN (§1 principle 4). A section with no product is
 * absent from the tree; a smart shelf needs at least 3 items and must say
 * something a child shelf does not already say.
 */
import { MEMBERSHIP_CTE } from './catalogMembership';
import { catalogImageUrl } from './siteMedia';
import { isSchemaMissing } from './membershipBenefits';
import { isTemplateFamily, productTypeForBranch, type SectionRef } from './templateFamilies';
import { readNumber } from './compareSpecs';
import type {
  BrandCount,
  CatalogTreeNode,
  CategoryLayout,
  Shelf,
  ShelfChip,
} from '@levonis/catalog/discoveryTypes';

/** A `catalogs` row as this module reads it (0136 columns optional, see below). */
export interface CatalogRecord {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  description_ar: string;
  description_en: string;
  description_ckb: string;
  image_key: string;
  hero_image_key: string;
  sort: number;
  active: boolean;
  is_printer_catalog: boolean;
  template_family: string | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/**
 * The whole taxonomy. `SELECT *` on purpose: a Worker carrying this code can
 * reach a database that has not run 0136 yet (the deploy and the migration are
 * two steps), and a missing description column must read as "no description" —
 * which is exactly what the column's default is — not take the explorer down.
 */
export async function loadCatalogRecords(db: D1Database): Promise<CatalogRecord[]> {
  const { results } = await db.prepare('SELECT * FROM catalogs').all<Record<string, unknown>>();
  return (results ?? []).map((r) => ({
    id: text(r.id),
    parent_id: r.parent_id ? text(r.parent_id) : null,
    slug: text(r.slug),
    name_ar: text(r.name_ar),
    name_en: text(r.name_en),
    name_ckb: text(r.name_ckb),
    description_ar: text(r.description_ar),
    description_en: text(r.description_en),
    description_ckb: text(r.description_ckb),
    image_key: text(r.image_key),
    hero_image_key: text(r.hero_image_key),
    sort: Number(r.sort) || 0,
    active: Number(r.active ?? 1) === 1,
    is_printer_catalog: Number(r.is_printer_catalog ?? 0) === 1,
    template_family: r.template_family ? text(r.template_family) : null,
  }));
}

/**
 * Every (product, catalog) membership of an active, non-composition product —
 * the same relation `catalogTreeWithCounts` counts through. Three compound
 * terms (the CTE), far under D1's five.
 */
export async function loadMemberships(db: D1Database): Promise<Array<{ product_id: string; catalog_id: string }>> {
  const { results } = await db
    .prepare(
      `WITH ${MEMBERSHIP_CTE}
       SELECT m.product_id, m.catalog_id
         FROM membership m
         JOIN products p ON p.id = m.product_id AND p.composition = ''`
    )
    .all<{ product_id: string; catalog_id: string }>();
  return results ?? [];
}

/** A slug an admin renamed away from (0136), or null. Degrades on a pre-0136 database. */
export async function catalogIdForRetiredSlug(db: D1Database, slug: string): Promise<string | null> {
  try {
    const row = await db
      .prepare('SELECT catalog_id FROM catalog_slug_history WHERE slug = ?')
      .bind(slug)
      .first<{ catalog_id: string }>();
    return row?.catalog_id ?? null;
  } catch (e) {
    if (isSchemaMissing(e)) return null;
    throw e;
  }
}

// ------------------------------------------------------------------- the index

export interface CatalogIndex {
  byId: Map<string, CatalogRecord>;
  bySlug: Map<string, CatalogRecord>;
  /** The node and its ancestors, nearest first (cycle-safe, 12 hops). */
  branch(id: string): CatalogRecord[];
  root(id: string): CatalogRecord | null;
  /** Every catalog id at or below `id`. */
  subtree(id: string): Set<string>;
  childrenOf(id: string): CatalogRecord[];
  /** `/categories/<root>` or `/categories/<root>/<node>`. */
  path(id: string): string;
  productType(id: string): string | null;
}

const bySort = (a: CatalogRecord, b: CatalogRecord) =>
  a.sort - b.sort || (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar);

export function indexCatalogs(rows: CatalogRecord[]): CatalogIndex {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const kids = new Map<string, CatalogRecord[]>();
  for (const r of rows) {
    if (!r.parent_id || !byId.has(r.parent_id)) continue;
    const list = kids.get(r.parent_id) ?? [];
    list.push(r);
    kids.set(r.parent_id, list);
  }
  for (const list of kids.values()) list.sort(bySort);

  const branch = (id: string): CatalogRecord[] => {
    const out: CatalogRecord[] = [];
    const seen = new Set<string>();
    let node = byId.get(id);
    for (let hop = 0; node && hop < 12 && !seen.has(node.id); hop++) {
      seen.add(node.id);
      out.push(node);
      node = node.parent_id ? byId.get(node.parent_id) : undefined;
    }
    return out;
  };
  const root = (id: string) => {
    const b = branch(id);
    return b.length ? b[b.length - 1] : null;
  };
  const subtree = (id: string): Set<string> => {
    const out = new Set<string>();
    const walk = (n: string) => {
      if (out.has(n)) return;
      out.add(n);
      for (const k of kids.get(n) ?? []) walk(k.id);
    };
    if (byId.has(id)) walk(id);
    return out;
  };
  const path = (id: string): string => {
    const node = byId.get(id);
    const top = root(id);
    if (!node || !top) return '/categories';
    const enc = encodeURIComponent;
    return top.id === node.id ? `/categories/${enc(node.slug)}` : `/categories/${enc(top.slug)}/${enc(node.slug)}`;
  };
  const types = new Map<string, string | null>();
  const productType = (id: string): string | null => {
    if (types.has(id)) return types.get(id) ?? null;
    const b = branch(id);
    const family = b.map((n) => n.template_family).find((f) => isTemplateFamily(f)) ?? null;
    const refs: SectionRef[] = b.map((n) => ({ id: n.id, slug: n.slug }));
    const t = isTemplateFamily(family) ? productTypeForBranch(family, refs) : null;
    types.set(id, t);
    return t;
  };
  return { byId, bySlug, branch, root, subtree, childrenOf: (id) => kids.get(id) ?? [], path, productType };
}

/**
 * The product type a PRODUCT resolves to — the compare page's rule exactly
 * (worker/routes/compare.ts `place`): the product's own `template_family` wins,
 * else the family its branch inherits; then `productTypeForBranch` on the branch
 * of its sub-section (else its main section). Null when nothing names a family.
 */
export function productTypeOf(
  row: { template_family?: unknown; category_id?: unknown; sub_category_id?: unknown },
  idx: CatalogIndex
): string | null {
  const leaf = text(row.sub_category_id) || text(row.category_id);
  const b = leaf ? idx.branch(leaf) : [];
  const own = text(row.template_family);
  const family = isTemplateFamily(own) ? own : b.map((n) => n.template_family).find((f) => isTemplateFamily(f)) ?? null;
  if (!isTemplateFamily(family)) return null;
  return productTypeForBranch(family, b.map((n) => ({ id: n.id, slug: n.slug })));
}

/**
 * The taxonomy index, read once per isolate and kept for a minute.
 *
 * Every card on a listing carries `compare_type`, and deriving it needs the
 * whole `catalogs` table — a few dozen rows that change when an admin edits the
 * taxonomy, i.e. rarely. Re-reading it on every listing request would add a
 * round trip to the busiest public route for nothing. Keyed by the D1 binding
 * (a WeakMap, so a test's fresh database is never served another's taxonomy),
 * refreshed after 60 s, and dropped at once by the admin taxonomy routes in the
 * isolate that made the edit (`forgetCatalogIndex`).
 */
const INDEX_TTL_MS = 60_000;
const indexMemo = new WeakMap<object, { at: number; idx: Promise<CatalogIndex> }>();

export function catalogIndexFor(db: D1Database, nowMs = Date.now()): Promise<CatalogIndex> {
  const hit = indexMemo.get(db);
  if (hit && nowMs - hit.at < INDEX_TTL_MS) return hit.idx;
  const idx = loadCatalogRecords(db).then(indexCatalogs);
  indexMemo.set(db, { at: nowMs, idx });
  // A failed read must not be remembered as the taxonomy for a minute.
  idx.catch(() => indexMemo.delete(db));
  return idx;
}

export function forgetCatalogIndex(db: D1Database): void {
  indexMemo.delete(db);
}

/** Which catalogs (with ancestors) each product is in. */
export function membershipByProduct(
  memberships: Array<{ product_id: string; catalog_id: string }>,
  idx: CatalogIndex
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of memberships) {
    const set = out.get(m.product_id) ?? new Set<string>();
    // Ancestors count — «طابعات FDM» is in «الطابعات». Inactive middle nodes are
    // walked through, never cut: deactivating a branch must not detach its
    // children's products from the root they belong to.
    for (const n of idx.branch(m.catalog_id)) set.add(n.id);
    out.set(m.product_id, set);
  }
  return out;
}

// -------------------------------------------------------------------- the tree

export function treeNode(
  r: CatalogRecord,
  idx: CatalogIndex,
  counts: Map<string, { products: number; available: number }>,
  availableKnown: boolean
): CatalogTreeNode {
  const c = counts.get(r.id) ?? { products: 0, available: 0 };
  return {
    id: r.id,
    slug: r.slug,
    parent_id: r.parent_id,
    name_ar: r.name_ar,
    name_en: r.name_en,
    name_ckb: r.name_ckb,
    description_ar: r.description_ar,
    description_en: r.description_en,
    description_ckb: r.description_ckb,
    image_url: catalogImageUrl(r.image_key),
    hero_image_url: catalogImageUrl(r.hero_image_key),
    product_count: c.products,
    available_count: availableKnown ? c.available : null,
    is_printer_catalog: r.is_printer_catalog,
    product_type: idx.productType(r.id),
    sort: r.sort,
    path: idx.path(r.id),
    children: [],
  };
}

/** Roll-up counts per catalog: distinct products, and those available now. */
export function rollUpCounts(
  byProduct: Map<string, Set<string>>,
  availableIds: Set<string> | null
): Map<string, { products: number; available: number }> {
  const out = new Map<string, { products: number; available: number }>();
  for (const [pid, catalogs] of byProduct) {
    const avail = availableIds?.has(pid) ?? false;
    for (const cid of catalogs) {
      const c = out.get(cid) ?? { products: 0, available: 0 };
      c.products += 1;
      if (avail) c.available += 1;
      out.set(cid, c);
    }
  }
  return out;
}

/**
 * The explorer's tree: active roots that hold products, each with its active,
 * non-empty descendants nested under the nearest ACTIVE ancestor (an inactive
 * middle branch lifts its children up rather than hiding them).
 */
type Counts = Map<string, { products: number; available: number }>;

const visibleIn = (counts: Counts) => (r: CatalogRecord) => r.active && (counts.get(r.id)?.products ?? 0) > 0;

/** A section's active, non-empty descendants, nested (inactive middles lifted). */
export function visibleChildren(r: CatalogRecord, idx: CatalogIndex, counts: Counts, availableKnown: boolean): CatalogTreeNode[] {
  const visible = visibleIn(counts);
  const out: CatalogTreeNode[] = [];
  for (const k of idx.childrenOf(r.id)) {
    if (visible(k)) {
      const node = treeNode(k, idx, counts, availableKnown);
      node.children = visibleChildren(k, idx, counts, availableKnown);
      out.push(node);
    } else if (!k.active) {
      out.push(...visibleChildren(k, idx, counts, availableKnown));
    }
  }
  return out;
}

export function buildTree(idx: CatalogIndex, counts: Counts, availableKnown: boolean): CatalogTreeNode[] {
  const roots = [...idx.byId.values()].filter((r) => !r.parent_id || !idx.byId.has(r.parent_id)).sort(bySort);
  return roots.filter(visibleIn(counts)).map((r) => {
    const node = treeNode(r, idx, counts, availableKnown);
    node.children = visibleChildren(r, idx, counts, availableKnown);
    return node;
  });
}

// ----------------------------------------------------------------- the shelves

export interface ShelfCandidate {
  id: string;
  card: Record<string, unknown>;
  /** Units available now. */
  available: number;
  brandId: string | null;
  /** The catalog ids (with ancestors) this product is in. */
  catalogs: Set<string>;
  specs: Record<string, unknown>;
  /** SQL order (display_order, newest). */
  rank: number;
}

export const SHELF_RAIL_MAX = 10;
export const SMART_SHELF_MIN = 3;
/** §6 / §15.2: ≤ 1 non-empty child AND fewer than 8 products → the page is the listing. */
export const LISTING_LAYOUT_BELOW = 8;
/** «للطباعة بأكثر من لون»: 16 colours or more in one print. */
export const MULTICOLOR_MIN = 16;

const availableFirst = (a: ShelfCandidate, b: ShelfCandidate) =>
  Number(b.available > 0) - Number(a.available > 0) || a.rank - b.rank;

const rail = (items: ShelfCandidate[]) => items.slice().sort(availableFirst).slice(0, SHELF_RAIL_MAX).map((i) => i.card);

const sameSet = (a: ShelfCandidate[], b: ShelfCandidate[]) =>
  a.length === b.length && a.every((x) => b.some((y) => y.id === x.id));

export interface ShelfPlan {
  layout: CategoryLayout;
  shelves: Shelf<Record<string, unknown>>[];
  brands: BrandCount[];
}

/**
 * The category page, as data. `children` are the node's non-empty children in
 * `sort` order; `items` the node's resolved products; `kind` the product type
 * the node resolves to (decides the printer-only and filament-only shelves).
 * `total` is the node's true product count — `items` may be capped.
 */
export function planShelves(input: {
  node: CatalogTreeNode;
  children: CatalogTreeNode[];
  items: ShelfCandidate[];
  total: number;
  brands: Map<string, { id: string; slug: string; name_ar: string; name_en: string; name_ckb: string }>;
}): ShelfPlan {
  const { node, children, items, total } = input;
  const base = node.path;
  const layout: CategoryLayout = children.length <= 1 && total < LISTING_LAYOUT_BELOW ? 'listing' : 'shelves';
  const shelves: Shelf<Record<string, unknown>>[] = [];

  // 1. One shelf per non-empty child, in `sort` order.
  const childShelves: ShelfCandidate[][] = [];
  for (const child of children) {
    const members = items.filter((i) => i.catalogs.has(child.id));
    if (members.length === 0) continue;
    childShelves.push(members);
    shelves.push({
      id: `child:${child.id}`,
      kind: 'child',
      title_key: 'child',
      catalog: {
        id: child.id,
        slug: child.slug,
        name_ar: child.name_ar,
        name_en: child.name_en,
        name_ckb: child.name_ckb,
        description_ar: child.description_ar,
        description_en: child.description_en,
        description_ckb: child.description_ckb,
        path: child.path,
      },
      count: child.product_count,
      see_all: child.path,
      products: rail(members),
    });
  }

  const isPrinter = node.product_type === 'printer' || (node.is_printer_catalog && node.product_type !== 'laser');
  const isFilament = node.product_type === 'filament';
  const allPath = `${base}/all`;
  const smart = (id: 'available' | 'multicolor', members: ShelfCandidate[], seeAll: string) => {
    if (members.length < SMART_SHELF_MIN) return;
    // «not identical to a child shelf»: a shelf that repeats one says nothing.
    if (childShelves.some((c) => sameSet(c, members))) return;
    if (members.length === items.length && children.length === 0) return;
    shelves.push({ id, kind: id, title_key: id, count: members.length, see_all: seeAll, products: rail(members) });
  };

  // 2. Smart shelves.
  smart('available', items.filter((i) => i.available > 0), `${allPath}?avail=1`);
  if (isPrinter) {
    smart(
      'multicolor',
      items.filter((i) => {
        const n = readNumber(text(i.specs.max_colors));
        return n !== null && n >= MULTICOLOR_MIN;
      }),
      `${allPath}?colors=${MULTICOLOR_MIN}-`
    );
  }
  if (isFilament) {
    const byMaterial = new Map<string, { label: string; count: number }>();
    for (const i of items) {
      const raw = text(i.specs.material_type).trim();
      if (!raw) continue;
      const key = raw.toLowerCase().replace(/\s+/g, ' ');
      const have = byMaterial.get(key) ?? { label: raw, count: 0 };
      have.count += 1;
      byMaterial.set(key, have);
    }
    if (byMaterial.size >= 2) {
      const chips: ShelfChip[] = [...byMaterial]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([value, v]) => ({ value: v.label, count: v.count, see_all: `${allPath}?material=${encodeURIComponent(value)}` }));
      shelves.push({ id: 'material', kind: 'material', title_key: 'material', count: items.length, see_all: allPath, products: [], chips });
    }
  }

  // 3. Brands: counted over the node's products, drawn as a shelf when ≥ 2.
  const brandCounts = new Map<string, number>();
  for (const i of items) if (i.brandId) brandCounts.set(i.brandId, (brandCounts.get(i.brandId) ?? 0) + 1);
  const brands: BrandCount[] = [...brandCounts]
    .map(([id, count]) => {
      const b = input.brands.get(id);
      return b ? { id: b.id, slug: b.slug, name_ar: b.name_ar, name_en: b.name_en, name_ckb: b.name_ckb, count } : null;
    })
    .filter((b): b is BrandCount => b !== null)
    .sort((a, b) => b.count - a.count || (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar));
  if (brands.length >= 2) {
    shelves.push({ id: 'brand', kind: 'brand', title_key: 'brand', count: brands.length, see_all: allPath, products: [] });
  }

  return { layout, shelves, brands };
}
