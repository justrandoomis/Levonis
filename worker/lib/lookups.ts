/**
 * The "valid values" of the classification columns, read from the database:
 * the sections (with their parent and inherited template family), the
 * brands, the filters and the managed hashtags.
 *
 * One loader for three consumers, so they can never disagree about what the
 * import accepts:
 *   - the import template (CSV lookup block, ZIP lookups.csv, README);
 *   - GET /api/admin/import/lookups, which the import panel shows;
 *   - the product form's option lists are the same rows via the taxonomy API.
 *
 * Only ACTIVE rows are offered, because that is exactly what buildMaps in the
 * import resolves — an inactive brand in the list would be a value that fails.
 */
import { isTemplateFamily } from './templateFamilies';
import { sectionPath, sectionTreeOrder } from '@levonis/catalog/sectionTree';

export interface LookupSection {
  id: string;
  slug: string;
  name_en: string;
  name_ar: string;
  parent_id: string | null;
  parent_name_en: string;
  parent_slug: string | null;
  family: 'devices' | 'materials' | null;
  is_printer_catalog: boolean;
  /** 0 for a main section, 1 for a sub-section — the list is in TREE order.
   *  Optional so a hand-built lookup (a test, an older caller) still types. */
  depth?: number;
  /** The main section this one files under (itself, for a main section). */
  root_id?: string;
  /** «الطابعات › طابعات FDM» / «Printers › FDM Printers». */
  path_ar?: string;
  path_en?: string;
}

export interface LookupBrand {
  id: string;
  slug: string;
  name_en: string;
  name_ar: string;
}

export interface LookupFacet {
  id: string;
  slug: string;
  name_en: string;
  name_ar: string;
  kind: string;
}

export interface LookupHashtag {
  tag: string;
  name_ar: string;
}

export interface Lookups {
  sections: LookupSection[];
  brands: LookupBrand[];
  facets: LookupFacet[];
  hashtags: LookupHashtag[];
}

interface CatalogRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name_en: string;
  name_ar: string;
  template_family: string | null;
  is_printer_catalog: number;
  active: number;
}

export async function loadLookups(db: D1Database): Promise<Lookups> {
  const { results: catalogs } = await db
    .prepare(
      'SELECT id, parent_id, slug, name_en, name_ar, template_family, is_printer_catalog, active FROM catalogs ORDER BY sort, name_en, name_ar'
    )
    .all<CatalogRow>();
  const byId = new Map(catalogs.map((r) => [r.id, r]));
  const familyOf = (row: CatalogRow): 'devices' | 'materials' | null => {
    let node: CatalogRow | undefined = row;
    for (let hop = 0; node && hop < 12; hop++) {
      if (isTemplateFamily(node.template_family)) return node.template_family;
      node = node.parent_id ? byId.get(node.parent_id) : undefined;
    }
    return null;
  };
  // TREE ORDER, not `sort` across the whole table: every main section is
  // followed by its own sub-sections (packages/catalog/src/sectionTree.ts), so
  // the template's list and the import panel's read the way the tree does.
  const sections: LookupSection[] = sectionTreeOrder(catalogs)
    .filter((p) => p.row.active)
    .map((p) => {
      const r = p.row;
      const parent = r.parent_id ? byId.get(r.parent_id) : undefined;
      return {
        id: r.id,
        slug: r.slug,
        name_en: r.name_en,
        name_ar: r.name_ar,
        parent_id: r.parent_id,
        parent_name_en: parent ? parent.name_en || parent.slug : '',
        parent_slug: parent ? parent.slug : null,
        family: familyOf(r),
        is_printer_catalog: !!r.is_printer_catalog,
        depth: p.depth,
        root_id: p.root.id,
        path_ar: sectionPath(p, (x) => x.name_ar || x.name_en || x.slug),
        path_en: sectionPath(p, (x) => x.name_en || x.name_ar || x.slug),
      };
    });

  const { results: brands } = await db
    .prepare('SELECT id, slug, name_en, name_ar FROM brands WHERE active = 1 ORDER BY name_en, name_ar')
    .all<LookupBrand>();
  const { results: facets } = await db
    .prepare('SELECT id, slug, name_en, name_ar, kind FROM facets WHERE active = 1 ORDER BY kind, sort, name_en')
    .all<LookupFacet>();

  let hashtags: LookupHashtag[] = [];
  try {
    const { results } = await db
      .prepare('SELECT tag, name_ar FROM hashtags WHERE active = 1 ORDER BY sort, tag')
      .all<LookupHashtag>();
    hashtags = results;
  } catch (e) {
    // No vocabulary table yet (migration 0041 pending): the template simply
    // lists no hashtags rather than failing to download.
    console.error('hashtags lookup unavailable', e instanceof Error ? e.message : String(e));
  }

  return { sections, brands, facets, hashtags };
}
