/**
 * THE COMMUNITY LISTS' FILTERS (plan B3; worker/routes/communityPosts.ts,
 * communitySocial.ts, community.ts, marketplace.ts, printRequests.ts).
 *
 * Every filter a community list takes is a CLOSED list: the server refuses a
 * value outside it (`oneOf`, 400) instead of reading it into SQL, and the SPA
 * builds its filter sheets from the same constants, so a chip can never ask
 * for something the server does not know. Each filter is ANDed into the
 * list's one `where`, so the first page's `total` counts exactly the rows the
 * filter lets through.
 *
 * Pure data, no runtime dependency: the Worker and the SPA both import it.
 */

/** «الرائج»: the window a trending read looks back over, in days. */
export const TRENDING_WINDOWS = ['7', '30'] as const;
export type TrendingWindow = (typeof TRENDING_WINDOWS)[number];

/** «أتابعهم»: both halves of the following feed, or one of them. */
export const FEED_FROM = ['all', 'makers', 'stores'] as const;
export type FeedFrom = (typeof FEED_FROM)[number];

/** The projects list's order: newest first, or by engagement. */
export const POST_SORTS = ['newest', 'popular'] as const;
export type PostSort = (typeof POST_SORTS)[number];

/**
 * A MATERIAL FAMILY, matched as a whole word in the post's material (the
 * author's own words, or the catalogue product's name): «PLA Matte», «PLA+»
 * and «Silk PLA» are all `pla`. The words beside each id are what the family
 * is also called; nothing else reads them.
 */
export const POST_MATERIAL_FAMILIES = {
  pla: ['pla'],
  petg: ['petg'],
  abs: ['abs'],
  asa: ['asa'],
  tpu: ['tpu', 'tpe'],
  nylon: ['nylon', 'pa', 'pa6', 'pa12', 'نايلون'],
  pc: ['pc', 'polycarbonate'],
  resin: ['resin', 'راتنج', 'ريزن'],
} as const satisfies Record<string, readonly string[]>;
export type PostMaterialFamily = keyof typeof POST_MATERIAL_FAMILIES;
export const POST_MATERIAL_IDS = Object.keys(POST_MATERIAL_FAMILIES) as PostMaterialFamily[];

/**
 * A PRINTER BRAND, matched inside the post's printer (the author's words, or
 * the catalogue product's name): «Bambu Lab A1 mini» is `bambu`, «Ender 3 V3»
 * is `creality`.
 */
export const POST_PRINTER_BRANDS = {
  bambu: ['bambu'],
  prusa: ['prusa'],
  creality: ['creality', 'ender'],
  elegoo: ['elegoo'],
  anycubic: ['anycubic'],
  flashforge: ['flashforge'],
  qidi: ['qidi'],
  sovol: ['sovol'],
  voron: ['voron'],
  snapmaker: ['snapmaker'],
} as const satisfies Record<string, readonly string[]>;
export type PostPrinterBrand = keyof typeof POST_PRINTER_BRANDS;
export const POST_PRINTER_IDS = Object.keys(POST_PRINTER_BRANDS) as PostPrinterBrand[];

/** A project's comments: oldest first (the thread), or newest first (a preview). */
export const COMMENT_ORDERS = ['oldest', 'newest'] as const;
export type CommentOrder = (typeof COMMENT_ORDERS)[number];

/** The stores directory: what a workshop prints with, and the one service it can be asked for. */
export const DIRECTORY_TECHS = ['fdm', 'resin'] as const;
export type DirectoryTech = (typeof DIRECTORY_TECHS)[number];
export const DIRECTORY_SERVICES = ['design'] as const;
export type DirectoryService = (typeof DIRECTORY_SERVICES)[number];

/** The makers directory's order. `featured` is the old `featured=1`. */
export const CREATOR_SORTS = ['recent', 'featured', 'followers'] as const;
export type CreatorSort = (typeof CREATOR_SORTS)[number];

/** The request board: the process a request asks for, and whether it has offers yet. */
export const REQUEST_PROCESSES = ['fdm', 'resin'] as const;
export type RequestProcessFilter = (typeof REQUEST_PROCESSES)[number];
export const REQUEST_OFFER_STATES = ['none', 'some'] as const;
export type RequestOffersFilter = (typeof REQUEST_OFFER_STATES)[number];

/** How many works a directory card carries (a store's showcase, a maker's public projects). */
export const DIRECTORY_WORKS_MAX = 3;
