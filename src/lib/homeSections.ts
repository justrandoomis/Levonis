/**
 * «ترتيب وإظهار الأقسام» — THE SECTIONS THE HOME PAGE ACTUALLY DRAWS.
 *
 * The owner (2026-09-26): «في قسم إعدادات الصفحة الرئيسية أجعل القسم يتبع
 * التقسيم الحالي». The admin list still offered the shelves of the home page
 * before v2 — coupons, discounts, top brands, best sellers, combos… — none of
 * which src/pages/Home.tsx mounts any more, so hiding one did nothing and the
 * sections that ARE drawn could not be moved. This module is the one list both
 * sides read: the admin edits it and the page renders from it.
 *
 * THE STORED SHAPE IS UNCHANGED — `homeSections`, an array of
 * `{ id, titleEn, titleAr, isVisible }` in the owner's order — so no migration
 * and no worker change. Old rows are read like this:
 *   - an id that is still drawn keeps its id (`ads_panel` is the ticker,
 *     `categories` the bento, `editorial_banners` the two banners), so the
 *     owner's hide choice and relative order carry over untouched;
 *   - `first_banner` / `second_banner` were never sections of their own: they
 *     are the two groups of hero SLIDES. Their switch keeps meaning what it
 *     always meant — whether that group's slides join the carousel — and is
 *     edited in the hero slides tab (`slideGroupVisible`);
 *   - every other old id (coupons, discounts, brands, the old shelves) has no
 *     equivalent on the page and is dropped on the next save.
 *
 * `hero` and `ads_panel` are PINNED to the top: the fixed header is drawn over
 * the hero and the ticker is the cap that overlaps its bottom edge, so moving
 * either would break the page rather than reorder it. They can still be hidden.
 */

export type HomeSectionId =
  | 'hero'
  | 'ads_panel'
  | 'categories'
  | 'printer_finder'
  | 'latest_products'
  | 'editorial_banners'
  | 'services';

export interface HomeSectionDef {
  id: HomeSectionId;
  titleAr: string;
  titleEn: string;
  /** Always first, in this order; can be hidden, cannot be moved. */
  pinned?: boolean;
}

/** In the order of the owner's spec board — the default when nothing is stored. */
export const HOME_SECTIONS: readonly HomeSectionDef[] = [
  { id: 'hero', titleAr: 'الواجهة الرئيسية (الهيرو)', titleEn: 'Hero', pinned: true },
  { id: 'ads_panel', titleAr: 'الشريط المتحرك (الإعلانات)', titleEn: 'Announcement ticker', pinned: true },
  { id: 'categories', titleAr: 'تسوق حسب الفئة', titleEn: 'Shop by category' },
  { id: 'printer_finder', titleAr: 'محتار أي طابعة تناسبك؟', titleEn: 'Printer finder' },
  { id: 'latest_products', titleAr: 'أحدث المنتجات', titleEn: 'Latest products' },
  { id: 'editorial_banners', titleAr: 'البانرات التحريرية', titleEn: 'Editorial banners' },
  { id: 'services', titleAr: 'الخدمات', titleEn: 'Services' },
] as const;

/** The two groups of hero slides (`homeBanners.first_banner` / `second_banner`). */
export const HERO_SLIDE_GROUPS = ['first_banner', 'second_banner'] as const;
export type HeroSlideGroup = (typeof HERO_SLIDE_GROUPS)[number];

/**
 * Old ids with no counterpart on the page. Listed so the decision is visible:
 * `open_box` was the graded-stock shelf, whose successor is the bento's
 * «المنتجات المستعملة» tile — part of `categories`, so it is deliberately NOT
 * aliased (hiding the old shelf must not hide every category tile).
 */
export const RETIRED_SECTION_IDS = [
  'coupons_offers',
  'discounts_offers',
  'top_brands',
  'open_box',
  'bundles',
  'best_sellers',
  'flash_deals',
  'spotlight',
  'combos',
  'filament',
] as const;

export interface StoredSection {
  id: string;
  titleEn?: string;
  titleAr?: string;
  isVisible?: boolean;
}

export interface HomeSectionRow extends HomeSectionDef {
  isVisible: boolean;
}

const DEFS = new Map(HOME_SECTIONS.map((d) => [d.id, d]));

function rows(stored: unknown): StoredSection[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (s): s is StoredSection => typeof s === 'object' && s !== null && typeof (s as StoredSection).id === 'string'
  );
}

/**
 * The stored list, read as the CURRENT sections: pinned ones first in their
 * fixed order, then the movable ones in the owner's stored order, then any
 * section the owner has never saved (appended in spec order, visible).
 */
export function normalizeHomeSections(stored: unknown): HomeSectionRow[] {
  const seen = new Map<HomeSectionId, boolean>();
  const order: HomeSectionId[] = [];
  for (const s of rows(stored)) {
    const id = s.id as HomeSectionId;
    if (!DEFS.has(id) || seen.has(id)) continue;
    seen.set(id, s.isVisible !== false);
    order.push(id);
  }
  for (const d of HOME_SECTIONS) if (!seen.has(d.id)) order.push(d.id);
  const pinned = HOME_SECTIONS.filter((d) => d.pinned).map((d) => d.id);
  const movable = order.filter((id) => !DEFS.get(id)!.pinned);
  return [...pinned, ...movable].map((id) => ({ ...DEFS.get(id)!, isVisible: seen.get(id) ?? true }));
}

/** Is this hero slide group switched on? A group never saved is on. */
export function slideGroupVisible(stored: unknown, group: HeroSlideGroup): boolean {
  const row = rows(stored).find((s) => s.id === group);
  return row ? row.isVisible !== false : true;
}

/**
 * What the admin writes back: the current sections in order, plus the two
 * slide-group switches (so a hidden group stays hidden). Old ids with no
 * equivalent are not written — they controlled nothing.
 */
export function serializeHomeSections(
  sections: readonly HomeSectionRow[],
  slideGroups: Readonly<Record<HeroSlideGroup, boolean>>
): Array<{ id: string; titleEn: string; titleAr: string; isVisible: boolean }> {
  return [
    ...sections.map(({ id, titleEn, titleAr, isVisible }) => ({ id, titleEn, titleAr, isVisible })),
    { id: 'first_banner', titleEn: 'Hero slides — group 1', titleAr: 'شرائح الهيرو — المجموعة الأولى', isVisible: slideGroups.first_banner },
    { id: 'second_banner', titleEn: 'Hero slides — group 2', titleAr: 'شرائح الهيرو — المجموعة الثانية', isVisible: slideGroups.second_banner },
  ];
}
