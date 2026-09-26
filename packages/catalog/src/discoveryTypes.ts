/**
 * CATALOG DISCOVERY — THE WIRE SHAPES (docs/ux/CATALOG_DISCOVERY.md §11).
 *
 * Written once for both programs. The Worker builds these objects
 * (worker/routes/catalog.ts, worker/routes/printerFinder.ts,
 * worker/lib/compareLenses.ts, the `/api/products` listing) and the SPA reads
 * them through `src/lib/catalog/types.ts`, which pins `Card` to its `ApiProduct`.
 * A card is generic here because the package cannot know the storefront's
 * product type, and the Worker only ever produces the `cardShape` projection.
 *
 * Every piece of copy is a CODE plus VALUES — never a sentence. The client owns
 * the words (ar/en, with Sorani written by hand), so the server can never put
 * a machine-written phrase in front of a customer.
 */
import type { FacetField, FinderAnswers, FinderPriority, ListingSort } from './discovery';

export interface Trilingual {
  ar: string;
  en: string;
  ckb: string;
}

/** One catalog as the explorer and the category page draw it. */
export interface CatalogTreeNode {
  id: string;
  slug: string;
  parent_id: string | null;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  /** Admin-written (migration 0136). '' means none — never invented. */
  description_ar: string;
  description_en: string;
  description_ckb: string;
  /** The home-tile cover (0100) as a URL, or ''. */
  image_url: string;
  /** The banner/hero photo (0136) as a URL, or ''. The client falls back to `image_url`, then a product photo. */
  hero_image_url: string;
  /** Active, non-composition products here or anywhere below. */
  product_count: number;
  /** Of those, how many sell direct with units available now. `null` when the
   *  catalogue was too large to resolve inside one request (never a guess). */
  available_count: number | null;
  is_printer_catalog: boolean;
  /** The product type this branch resolves to (`printer`, `filament`, …), or null. */
  product_type: string | null;
  sort: number;
  /** The canonical storefront path: `/categories/printers[/fdm-printers]`. */
  path: string;
  /** Non-empty children, in `sort` order. */
  children: CatalogTreeNode[];
}

export interface CatalogTreeResponse {
  success: true;
  roots: CatalogTreeNode[];
  totals: { products: number; available: number | null };
}

export type ShelfKind = 'child' | 'available' | 'multicolor' | 'material' | 'brand';

export interface ShelfChip {
  value: string;
  count: number;
  see_all: string;
}

/**
 * One rail on a category page. `title_key` names the copy the client renders
 * («جاهزة للتسليم الآن» is `available`); a child shelf carries its catalog
 * instead, whose own names and description are the title.
 */
export interface Shelf<Card = unknown> {
  /** `child:<catalog id>` | `available` | `multicolor` | `material` | `brand`. */
  id: string;
  kind: ShelfKind;
  title_key: ShelfKind;
  catalog?: Pick<CatalogTreeNode, 'id' | 'slug' | 'name_ar' | 'name_en' | 'name_ckb' | 'description_ar' | 'description_en' | 'description_ckb' | 'path'>;
  count: number;
  /** Where «عرض الكل» goes: a canonical listing path with its preset filter. */
  see_all: string;
  /** At most 10, available-now first. Empty for chip-only shelves. */
  products: Card[];
  /** `material` shelves: one chip per value. */
  chips?: ShelfChip[];
}

export interface BrandCount {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  count: number;
}

/** `listing` = the page IS the listing (≤ 1 non-empty child and < 8 products). */
export type CategoryLayout = 'shelves' | 'listing';

export interface CategoryPayload<Card = unknown> {
  success: true;
  node: CatalogTreeNode;
  /** Root … node, for the breadcrumb. */
  path: Array<Pick<CatalogTreeNode, 'id' | 'slug' | 'name_ar' | 'name_en' | 'name_ckb' | 'path'>>;
  /** True when the request named an old slug (renamed in the admin): the client
   *  should `replace` to `node.path`. */
  moved: boolean;
  layout: CategoryLayout;
  children: CatalogTreeNode[];
  shelves: Shelf<Card>[];
  brands: BrandCount[];
  /** Other roots that hold products, for «يكمّل طابعتك». */
  related: CatalogTreeNode[];
  /** True when the subtree held more than the page reads (200); counts stay exact. */
  truncated: boolean;
}

// -------------------------------------------------------------- listing facets

export interface FacetOption {
  /** The canonical token the URL carries (`facetToken`). */
  value: string;
  /** The value as the admin typed it (English by house rule) — for free-text facets. */
  label?: string;
  count: number;
}

/**
 * Facet counts for the listing's filter sheet. DISJUNCTIVE: each facet's counts
 * are computed with every OTHER active filter applied and its own ignored, so a
 * shopper sees what switching would give. A zero is returned, not omitted, so
 * options stay stable while tapping.
 */
export interface FacetSet {
  total: number;
  avail: { now: number };
  sale: { direct: number; preorder: number };
  price: {
    /** The viewer's resolved prices, before the price filter itself. */
    min: number | null;
    max: number | null;
    /** Equal-width bins between min and max (12), for the histogram. */
    histogram: number[];
  };
  brands: Array<{ slug: string; id: string; name_ar: string; name_en: string; name_ckb: string; count: number }>;
  offer: number;
  member: number;
  specs: Partial<Record<FacetField, FacetOption[]>>;
}

/** The additive envelope `/api/products` returns when any listing parameter is used. */
export interface ListingMeta {
  /** Matches after every filter, before paging. */
  total: number;
  /** The candidate set hit its cap (300); totals and facets describe the cap. */
  truncated: boolean;
  sort: ListingSort;
  facets?: FacetSet;
}

// ------------------------------------------------------------- printer finder

export type FinderCriterion = 'speed' | 'colors' | 'quality' | 'quiet' | 'ease' | 'size' | 'durable' | 'reliability' | 'use_fit';

/** Why a result is relaxed: the step that let it in. */
export type FinderRelaxation = 'budget_plus_20' | 'allow_preorder' | 'any_tech';

/**
 * A reason is a criterion the product is strong on, or one of two special codes.
 * `value_text` is the compare engine's own reading of the field (same parser,
 * same units), so the finder and the compare page can never disagree.
 */
export interface FinderReason {
  code: FinderCriterion | 'in_stock' | 'in_budget';
  /** The spec field the claim rests on; '' for the special codes. */
  field_id: string;
  value_text: string;
  /** Best among the candidates on this criterion. */
  top: boolean;
  /** `in_stock`: the units available now. */
  units?: number;
}

export type FinderCaveat =
  | { code: 'missing'; criterion: FinderCriterion; field_id: string }
  | { code: 'weak'; criterion: FinderCriterion; field_id: string; value_text: string }
  | { code: 'relaxed'; relaxation: FinderRelaxation }
  | { code: 'professional' };

export interface FinderResult<Card = unknown> {
  card: Card;
  rank: number;
  /** 0..1 plus the stated adjustments; for ordering, not for display. */
  score: number;
  relaxed: FinderRelaxation[];
  reasons: FinderReason[];
  caveats: FinderCaveat[];
}

export interface FinderExcluded {
  budget: string[];
  tech: string[];
  sale: string[];
  ranked_lower: string[];
}

export interface FinderCoverage {
  criterion: FinderPriority;
  field_id: string;
  known: number;
  total: number;
}

export interface FinderResponse<Card = unknown> {
  success: true;
  answers: FinderAnswers;
  /** Printers considered before any hard filter. */
  total: number;
  /** How many matched the chosen technology before relaxation (0 → support first). */
  tech_matches: number;
  results: FinderResult<Card>[];
  excluded: FinderExcluded;
  coverage: FinderCoverage[];
}

export interface FinderMeta {
  success: true;
  techs: { fdm: number; resin: number; laser: number };
  budgets: Array<{ range: string; count: number }>;
  total: number;
}

// ---------------------------------------------------------------- compare lenses

export type CompareLensId = 'beginners' | 'business' | 'value' | 'multicolor' | 'precision';

export interface CompareLens {
  id: CompareLensId;
  /** Index into `products`, or null. */
  winner: number | null;
  state: 'winner' | 'tie' | 'no_data';
  /** Per product, 0..1 within this comparison (value: points per million IQD, normalised); null = no data. */
  scores: Array<number | null>;
  /** The claim behind the winner, in the finder's reason vocabulary. Null unless `state === 'winner'`. */
  reason: { code: string; field_id: string; value_text: string } | null;
}
