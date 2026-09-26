/**
 * THE SPECIALISED LISTING, AS DATA (docs/ux/CATALOG_DISCOVERY.md §7).
 *
 * Pure. The URL is the state (src/lib/catalog/listingQuery.ts, over the one
 * grammar in packages/catalog/src/discovery.ts that the Worker reads too); this
 * module turns that state and the server's facet counts into what the page
 * draws and what each control does:
 *
 *   - the quick chips for the section's type, shown only when they would
 *     change the list (or are already on);
 *   - the removable chips for what is applied, one per value;
 *   - the zero-results undo lines, one per active filter group;
 *   - the words for every sort, facet value and filter;
 *   - which filter-sheet sections exist for this section (a facet needs two
 *     distinct values to be worth a control);
 *   - which catalog a `/categories/:cat/:sub` URL names, and its canonical
 *     path;
 *   - the canonical path an old `/products?category=` link should replace to.
 *
 * Every transform returns a NEW state and never touches `q` or `sort` unless
 * that is its job, so «مسح الكل» clears filters and keeps the search.
 */
import {
  DEFAULT_LISTING,
  FACET_FIELD_IDS,
  readRangeToken,
} from './listingQuery';
import type { CatalogTreeNode, FacetField, FacetSet, ListingSort, ListingState } from './types';
import { groupedNumber } from '../localeNumber';
import type { CatalogLang } from './copy';

// OWNER: Sorani to be written by hand — every ar/en pair in this file falls
// back to Arabic in Sorani, except the words reused verbatim from existing
// hand-written copy (noted where they are).

const L = (lang: CatalogLang, ar: string, en: string) => (lang === 'en' ? en : ar);

export type SectionType = 'printer' | 'filament' | 'default';

export function sectionTypeOf(productType: string | null | undefined, isPrinterCatalog = false): SectionType {
  if (productType === 'printer' || (productType == null && isPrinterCatalog)) return 'printer';
  if (productType === 'filament') return 'filament';
  return 'default';
}

// ------------------------------------------------------------------- state ops

const copy = (s: ListingState): ListingState => ({
  ...s,
  brands: [...s.brands],
  specs: Object.fromEntries(Object.entries(s.specs).map(([k, v]) => [k, [...(v ?? [])]])),
});

/** Every filter off; the search text and the sort stay. */
export function clearFilters(s: ListingState): ListingState {
  return { ...DEFAULT_LISTING, brands: [], specs: {}, q: s.q, sort: s.sort };
}

export function setSpec(s: ListingState, field: FacetField, values: string[]): ListingState {
  const next = copy(s);
  const clean = [...new Set(values)].sort();
  if (clean.length) next.specs[field] = clean;
  else delete next.specs[field];
  return next;
}

export function toggleSpec(s: ListingState, field: FacetField, value: string): ListingState {
  const have = s.specs[field] ?? [];
  return setSpec(s, field, have.includes(value) ? have.filter((v) => v !== value) : [...have, value]);
}

export function toggleBrand(s: ListingState, slug: string): ListingState {
  const next = copy(s);
  next.brands = s.brands.includes(slug) ? s.brands.filter((b) => b !== slug) : [...s.brands, slug].sort();
  return next;
}

/** The filter groups a shopper can remove one at a time. */
export type FilterGroup = 'avail' | 'sale' | 'price' | 'brands' | 'offer' | 'member' | FacetField;

export function activeGroups(s: ListingState): FilterGroup[] {
  const out: FilterGroup[] = [];
  if (s.avail) out.push('avail');
  if (s.sale) out.push('sale');
  if (s.price) out.push('price');
  if (s.brands.length) out.push('brands');
  if (s.offer) out.push('offer');
  if (s.member) out.push('member');
  for (const f of FACET_FIELD_IDS) if (s.specs[f]?.length) out.push(f);
  return out;
}

export function withoutGroup(s: ListingState, g: FilterGroup): ListingState {
  const next = copy(s);
  switch (g) {
    case 'avail':
      next.avail = false;
      break;
    case 'sale':
      next.sale = null;
      break;
    case 'price':
      next.price = null;
      break;
    case 'brands':
      next.brands = [];
      break;
    case 'offer':
      next.offer = false;
      break;
    case 'member':
      next.member = false;
      break;
    default:
      delete next.specs[g];
  }
  return next;
}

// ------------------------------------------------------------------- the words

export function sortLabel(sort: ListingSort, lang: CatalogLang): string {
  switch (sort) {
    case 'newest':
      // «الأحدث» / «نوێترین» is existing hand-written copy; the caller passes ckb through loc().
      return L(lang, 'الأحدث', 'Newest');
    case 'price_asc':
      return L(lang, 'السعر: من الأقل', 'Price: low to high');
    case 'price_desc':
      return L(lang, 'السعر: من الأعلى', 'Price: high to low');
    case 'name':
      return L(lang, 'الاسم (A–Z)', 'Name (A–Z)');
    case 'available':
      return L(lang, 'المتوفر أولًا', 'Available first');
    case 'direct':
      return L(lang, 'البيع المباشر أولًا', 'Direct sale first');
    default:
      return L(lang, 'الأنسب', 'Best match');
  }
}

/** The quiet line at the end of the result count: what the order means. */
export function sortExplanation(sort: ListingSort, hasQuery: boolean, lang: CatalogLang): string {
  switch (sort) {
    case 'newest':
      return L(lang, 'الأحدث إضافةً أولًا', 'Newest additions first');
    case 'price_asc':
      return L(lang, 'الأقل سعرًا أولًا', 'Lowest price first');
    case 'price_desc':
      return L(lang, 'الأعلى سعرًا أولًا', 'Highest price first');
    case 'name':
      return L(lang, 'أبجديًا حسب الاسم', 'Alphabetical by name');
    case 'available':
      return L(lang, 'المتوفر الآن أولًا، ثم الأكثر كمية', 'Available now first, then by quantity');
    case 'direct':
      return L(lang, 'البيع المباشر أولًا، ثم الطلب المسبق', 'Direct sale first, then pre-order');
    default:
      return hasQuery
        ? L(lang, 'الأقرب لبحثك أولًا', 'Closest to your search first')
        : L(lang, 'المتوفر للبيع المباشر أولًا', 'Available for direct sale first');
  }
}

/** The sheet's seven orders, in the design's order. */
export const SORT_ORDER: ListingSort[] = ['relevance', 'newest', 'price_asc', 'price_desc', 'name', 'available', 'direct'];

const colorWord = (n: number, lang: CatalogLang) =>
  lang === 'en' ? (n === 1 ? 'colour' : 'colours') : n % 100 >= 11 && n % 100 <= 99 ? 'لونًا' : n <= 2 ? 'لون' : 'ألوان';

/** «حتى 4 ألوان», «16–20 لونًا», «24 لونًا فأكثر». */
export function colorsLabel(token: string, lang: CatalogLang): string {
  const r = readRangeToken(token);
  if (!r) return token;
  const lo = Number.isFinite(r.min) ? r.min : null;
  const hi = Number.isFinite(r.max) ? r.max : null;
  if (lo !== null && hi !== null && lo === hi) return `${lo} ${colorWord(lo, lang)}`;
  if (hi === null && lo !== null) return lang === 'en' ? `${lo}+ colours` : `${lo} ${colorWord(lo, lang)} فأكثر`;
  if (hi !== null && (lo === null || lo <= 1)) return lang === 'en' ? `Up to ${hi} colours` : `حتى ${hi} ${colorWord(hi, lang)}`;
  return lang === 'en' ? `${lo}–${hi} colours` : `${lo}–${hi} ${colorWord(hi ?? 0, lang)}`;
}

export function sizeLabel(token: string, lang: CatalogLang): string {
  switch (token) {
    case 'compact':
      return L(lang, 'مدمج · حتى 200 مم', 'Compact · up to 200 mm');
    case 'standard':
      return L(lang, 'قياسي · 200–300 مم', 'Standard · 200–300 mm');
    case 'large':
      return L(lang, 'كبير · 300 مم فأكثر', 'Large · 300 mm+');
    default:
      return token;
  }
}

export function levelLabel(token: string, lang: CatalogLang): string {
  switch (token) {
    case 'beginner':
      return L(lang, 'للمبتدئين', 'Beginner');
    case 'intermediate':
      return L(lang, 'متوسط', 'Intermediate');
    case 'advanced':
      return L(lang, 'متقدم', 'Advanced');
    case 'professional':
      return L(lang, 'للمحترفين', 'Professional');
    default:
      return token;
  }
}

/** A spec facet value in words. `label` is the admin's own text for free-text facets. */
export function specValueLabel(field: FacetField, token: string, lang: CatalogLang, label?: string): string {
  switch (field) {
    case 'technology':
      return token === 'resin' ? 'Resin' : token.toUpperCase();
    case 'max_colors':
      return colorsLabel(token, lang);
    case 'build_volume':
      return sizeLabel(token, lang);
    case 'enclosed':
      return token === '1' ? L(lang, 'هيكل مغلق', 'Enclosed') : L(lang, 'هيكل مفتوح', 'Open frame');
    case 'skill_level':
      return levelLabel(token, lang);
    case 'diameter':
      return lang === 'en' ? `${token} mm` : `${token} مم`;
    default: {
      const text = (label ?? '').trim();
      if (text) return text;
      return field === 'material_type' ? token.toUpperCase() : token;
    }
  }
}

/** The heading of a spec facet's section in the filter sheet. */
export function facetTitle(field: FacetField, lang: CatalogLang): string {
  switch (field) {
    case 'technology':
      return L(lang, 'التقنية', 'Technology');
    case 'max_colors':
      return L(lang, 'عدد الألوان', 'Colours per print');
    case 'build_volume':
      return L(lang, 'حجم الطباعة', 'Build size');
    case 'enclosed':
      return L(lang, 'الهيكل', 'Frame');
    case 'skill_level':
      return L(lang, 'مستوى الخبرة', 'Experience level');
    case 'material_type':
      return L(lang, 'المادة', 'Material');
    case 'diameter':
      return L(lang, 'القطر', 'Diameter');
    case 'color_name':
      return L(lang, 'اللون', 'Colour');
  }
}

export function priceRangeLabel(min: number | null, max: number | null, lang: CatalogLang): string {
  const cur = lang === 'en' ? 'IQD' : 'د.ع';
  const a = min !== null ? groupedNumber(min) : null;
  const b = max !== null ? groupedNumber(max) : null;
  if (a && b) return `${a} – ${b} ${cur}`;
  if (a) return L(lang, `من ${a} ${cur}`, `From ${a} ${cur}`);
  if (b) return L(lang, `حتى ${b} ${cur}`, `Up to ${b} ${cur}`);
  return '';
}

export interface LabelContext {
  lang: CatalogLang;
  /** The facet counts the page holds — for brand names and free-text labels. */
  facets: FacetSet | null;
}

export function brandLabel(slug: string, facets: FacetSet | null): string {
  const b = facets?.brands.find((x) => x.slug === slug);
  // Brand names are shown as the brand writes itself (English), as product names are.
  return b ? b.name_en || b.name_ar : slug;
}

function specOptionLabel(field: FacetField, token: string, ctx: LabelContext): string {
  const opt = ctx.facets?.specs[field]?.find((o) => o.value === token);
  return specValueLabel(field, token, ctx.lang, opt?.label);
}

/** What one filter group says as a sentence fragment («Bambu Lab، Snapmaker»). */
export function groupLabel(s: ListingState, g: FilterGroup, ctx: LabelContext): string {
  const { lang } = ctx;
  const sep = lang === 'en' ? ', ' : '، ';
  switch (g) {
    case 'avail':
      return L(lang, 'متوفر الآن', 'Available now');
    case 'sale':
      return s.sale === 'preorder' ? L(lang, 'طلب مسبق', 'Pre-order') : L(lang, 'بيع مباشر', 'Direct sale');
    case 'price':
      return s.price ? priceRangeLabel(s.price.min, s.price.max, lang) : '';
    case 'brands':
      return s.brands.map((b) => brandLabel(b, ctx.facets)).join(sep);
    case 'offer':
      return L(lang, 'عليها عرض', 'On offer');
    case 'member':
      return L(lang, 'سعر أقل للأعضاء', 'Lower member price');
    default:
      return (s.specs[g] ?? []).map((t) => specOptionLabel(g, t, ctx)).join(sep);
  }
}

// ------------------------------------------------------------ applied chips

export interface AppliedChip {
  id: string;
  label: string;
  next: ListingState;
}

/** One removable chip per applied value, in the URL's own order. */
export function appliedChips(s: ListingState, ctx: LabelContext): AppliedChip[] {
  const out: AppliedChip[] = [];
  for (const g of activeGroups(s)) {
    if (g === 'brands') {
      for (const b of s.brands) out.push({ id: `brand:${b}`, label: brandLabel(b, ctx.facets), next: toggleBrand(s, b) });
    } else if ((FACET_FIELD_IDS as readonly string[]).includes(g)) {
      const field = g as FacetField;
      for (const t of s.specs[field] ?? []) {
        out.push({ id: `${field}:${t}`, label: specOptionLabel(field, t, ctx), next: toggleSpec(s, field, t) });
      }
    } else {
      out.push({ id: g, label: groupLabel(s, g, ctx), next: withoutGroup(s, g) });
    }
  }
  return out;
}

// ------------------------------------------------------------- zero results

export interface UndoOption {
  group: FilterGroup;
  label: string;
  next: ListingState;
}

/** «أزل "24 لونًا فأكثر"» — one line per active filter group. */
export function undoOptions(s: ListingState, ctx: LabelContext): UndoOption[] {
  return activeGroups(s).map((g) => ({ group: g, label: groupLabel(s, g, ctx), next: withoutGroup(s, g) }));
}

// -------------------------------------------------------------- quick chips

export interface QuickChip {
  id: string;
  label: string;
  active: boolean;
  /** How many the list would hold with this chip toggled on; null when unknown. */
  count: number | null;
  next: ListingState;
}

const MULTICOLOR_TOKEN = '16-';

/** Products with ≥ 16 colours, from the bucketed facet counts. */
function multicolorCount(f: FacetSet): number {
  return (f.specs.max_colors ?? []).reduce((n, o) => {
    const r = readRangeToken(o.value);
    return r && r.min >= 16 ? n + o.count : n;
  }, 0);
}

const optionCount = (f: FacetSet, field: FacetField, value: string) =>
  f.specs[field]?.find((o) => o.value === value)?.count ?? 0;

/**
 * The one-tap filters for this section (§7 item 5). A chip is offered only
 * when it would change the list — some, but not all, of the products match —
 * or when it is already on (so it can be turned off where it was turned on).
 */
export function quickChips(type: SectionType, f: FacetSet | null, s: ListingState, lang: CatalogLang): QuickChip[] {
  if (!f) return [];
  const total = f.total;
  const out: QuickChip[] = [];
  const offer = (chip: QuickChip) => {
    if (chip.active || (chip.count !== null && chip.count > 0 && chip.count < total)) out.push(chip);
  };
  const flag = (id: 'avail' | 'offer', label: string, count: number) =>
    offer({ id, label, active: s[id], count, next: { ...copy(s), [id]: !s[id] } });

  flag('avail', L(lang, 'متوفر الآن', 'Available now'), f.avail.now);

  if (type === 'printer') {
    offer({
      id: 'preorder',
      label: L(lang, 'طلب مسبق', 'Pre-order'),
      active: s.sale === 'preorder',
      count: f.sale.preorder,
      next: { ...copy(s), sale: s.sale === 'preorder' ? null : 'preorder' },
    });
    offer({
      id: 'enclosed',
      label: L(lang, 'هيكل مغلق', 'Enclosed'),
      active: (s.specs.enclosed ?? []).includes('1'),
      count: optionCount(f, 'enclosed', '1'),
      next: toggleSpec(s, 'enclosed', '1'),
    });
    const multicolorOn = (s.specs.max_colors ?? []).includes(MULTICOLOR_TOKEN);
    offer({
      id: 'multicolor',
      label: L(lang, 'متعدد الألوان', 'Multicolour'),
      active: multicolorOn,
      count: multicolorCount(f),
      next: toggleSpec(s, 'max_colors', MULTICOLOR_TOKEN),
    });
  } else if (type === 'filament') {
    const materials = [...(f.specs.material_type ?? [])].sort((a, b) => b.count - a.count).slice(0, 2);
    for (const m of materials) {
      offer({
        id: `material:${m.value}`,
        label: specValueLabel('material_type', m.value, lang, m.label),
        active: (s.specs.material_type ?? []).includes(m.value),
        count: m.count,
        next: toggleSpec(s, 'material_type', m.value),
      });
    }
    if ((f.specs.diameter ?? []).some((o) => o.value === '1.75')) {
      offer({
        id: 'diameter:1.75',
        label: specValueLabel('diameter', '1.75', lang),
        active: (s.specs.diameter ?? []).includes('1.75'),
        count: optionCount(f, 'diameter', '1.75'),
        next: toggleSpec(s, 'diameter', '1.75'),
      });
    }
  } else {
    flag('offer', L(lang, 'عليها عرض', 'On offer'), f.offer);
  }

  // The top brand, for printers and the default set.
  if (type !== 'filament' && f.brands.length >= 2) {
    const top = f.brands[0];
    offer({
      id: `brand:${top.slug}`,
      label: top.name_en || top.name_ar,
      active: s.brands.includes(top.slug),
      count: top.count,
      next: toggleBrand(s, top.slug),
    });
  }
  // A chip turned on from here and hidden by the rule above would strand the
  // filter; applied chips cover that, so nothing else is added.
  return out;
}

// ------------------------------------------------------ filter sheet sections

export type SheetSection = 'availability' | 'price' | 'brands' | 'offers' | FacetField;

const PRINTER_FACETS: FacetField[] = ['technology', 'max_colors', 'build_volume', 'enclosed', 'skill_level'];
const FILAMENT_FACETS: FacetField[] = ['material_type', 'diameter', 'color_name'];

/** Does a facet offer a real choice here (≥ 2 values with products), or is it on? */
export function specDiscriminates(f: FacetSet, s: ListingState, field: FacetField): boolean {
  if (s.specs[field]?.length) return true;
  return (f.specs[field] ?? []).filter((o) => o.count > 0).length >= 2;
}

export function availabilityShows(f: FacetSet, s: ListingState): { avail: boolean; sale: boolean } {
  const discriminates = (n: number) => n > 0 && n < f.total;
  return {
    avail: s.avail || discriminates(f.avail.now),
    sale: s.sale !== null || discriminates(f.sale.direct) || discriminates(f.sale.preorder),
  };
}

export function offersShows(f: FacetSet, s: ListingState): { offer: boolean; member: boolean } {
  return {
    offer: s.offer || (f.offer > 0 && f.offer < f.total),
    // «only if it discriminates (count < total)».
    member: s.member || (f.member > 0 && f.member < f.total),
  };
}

/** The sections the filter sheet draws for this section and these counts, in order. */
export function sheetSections(type: SectionType, f: FacetSet, s: ListingState): SheetSection[] {
  const out: SheetSection[] = [];
  const a = availabilityShows(f, s);
  if (a.avail || a.sale) out.push('availability');
  if (s.price || (f.price.min !== null && f.price.max !== null && f.price.max > f.price.min)) out.push('price');
  if (s.brands.length || f.brands.filter((b) => b.count > 0).length >= 2) out.push('brands');
  const o = offersShows(f, s);
  if (o.offer || o.member) out.push('offers');
  const fields = type === 'printer' ? PRINTER_FACETS : type === 'filament' ? FILAMENT_FACETS : FACET_FIELD_IDS;
  for (const field of fields) if (specDiscriminates(f, s, field)) out.push(field);
  // A spec filter applied from a link (a smart shelf's «عرض الكل») that this
  // section type does not list must still be visible, so it can be removed.
  for (const field of FACET_FIELD_IDS) if (!out.includes(field) && s.specs[field]?.length) out.push(field);
  return out;
}

// ------------------------------------------------------------- price control

/** A round step for the price slider: about a hundred stops across the range. */
export function priceStep(min: number, max: number): number {
  const span = Math.max(0, max - min);
  for (const step of [1_000, 5_000, 10_000, 25_000, 50_000, 100_000]) if (span / step <= 120) return step;
  return 250_000;
}

/** Which histogram bins fall inside the chosen range (all of them with no range). */
export function binsInRange(bins: number, min: number, max: number, lo: number | null, hi: number | null): boolean[] {
  const span = max - min;
  return Array.from({ length: bins }, (_, i) => {
    if (span <= 0) return true;
    const from = min + (span * i) / bins;
    const to = min + (span * (i + 1)) / bins;
    return (lo === null || to >= lo) && (hi === null || from <= hi);
  });
}

// --------------------------------------------------------------- the route

export interface ListingRoute {
  node: CatalogTreeNode;
  root: CatalogTreeNode;
  /** `/categories/:cat/all` — the whole of a section. */
  all: boolean;
  /** The URL path this listing should have. */
  canonical: string;
}

/** A node anywhere in the tree by slug, with its root. */
export function findInTree(roots: readonly CatalogTreeNode[], slug: string): { node: CatalogTreeNode; root: CatalogTreeNode } | null {
  for (const root of roots) {
    const stack: CatalogTreeNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.slug === slug) return { node: n, root };
      stack.push(...(n.children ?? []));
    }
  }
  return null;
}

/**
 * What `/categories/:cat/:sub` lists. `sub` is a descendant's slug, or the
 * reserved `all` for the whole of `cat`. The server resolves by the LAST
 * segment, so a parent that does not match is a canonical redirect, never a
 * 404 (§2 «Why nested slugs»). Null when the tree does not know the slug —
 * the page then asks the category route, which also knows renamed slugs.
 */
export function resolveListingRoute(roots: readonly CatalogTreeNode[], cat: string, sub: string): ListingRoute | null {
  if (sub === 'all') {
    const hit = findInTree(roots, cat);
    if (!hit) return null;
    const isRoot = hit.node.id === hit.root.id;
    return { ...hit, all: true, canonical: isRoot ? `${hit.node.path}/all` : hit.node.path };
  }
  const hit = findInTree(roots, sub);
  if (!hit) return null;
  const isRoot = hit.node.id === hit.root.id;
  return { ...hit, all: isRoot, canonical: isRoot ? `${hit.node.path}/all` : hit.node.path };
}

/**
 * An old `/products?category=<id or slug>` link → the canonical category URL,
 * keeping every other query parameter. Null when the server resolved no
 * catalog (a legacy free-text token keeps listing as it always did).
 */
export function legacyCategoryTarget(category: { path?: string } | null | undefined, search: string): string | null {
  const path = category?.path;
  if (!path || !path.startsWith('/categories/')) return null;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.delete('category');
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}
