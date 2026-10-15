/**
 * THE WORDS OF THE IMPORT'S LISTING FACETS (the Bambu import spec §G.5
 * «Filters»; docs/DECISIONS.md rows 2, 183 and 241).
 *
 * The listing's grammar (./discovery.ts) carries tokens; the page draws them
 * in the reader's language from here:
 *
 *   «العائلة» / Family / «خێزان»     `product_family` — the family code the
 *                                    importer mirrors (`bambu_filament` …);
 *   «البكرة» / Spool / «ماسوورە»     `spool_type` — `refill` or `spool`;
 *   the base colours                 `color_name` — the importer mirrors a
 *                                    colour group's base colours ("white |
 *                                    black"); an admin's own colour words are
 *                                    shown as typed.
 *
 * Every Sorani slot is real Sorani and never a copy of the Arabic (row 183;
 * tests/listingFacetsImport.test.ts walks them). Pure data.
 */
import { BASE_COLOURS, type BaseColour } from './bambuImport/registry/colours';
import type { SpoolFacet } from './discovery';

export interface FacetWords {
  ar: string;
  en: string;
  ckb: string;
}

/** The headings of the two new facets. */
export const IMPORT_FACET_TITLES: Readonly<Record<'product_family' | 'spool_type', FacetWords>> = {
  product_family: { ar: 'العائلة', en: 'Family', ckb: 'خێزان' },
  spool_type: { ar: 'البكرة', en: 'Spool', ckb: 'ماسوورە' },
};

/** `spool_type`'s two values (§G.5). */
export const SPOOL_LABELS: Readonly<Record<SpoolFacet, FacetWords>> = {
  refill: { ar: 'عبوة بدون بكرة', en: 'Refill', ckb: 'پڕکردنەوە بەبێ ماسوورە' },
  spool: { ar: 'مع بكرة', en: 'With spool', ckb: 'لەگەڵ ماسوورە' },
};

/**
 * The families the reviewed identity map names (docs/bambu-import/p0/
 * identity-map.json). A family the import adds later is shown by its code in
 * words (`familyLabel`) until it is given a name here.
 */
export const FAMILY_LABELS: Readonly<Record<string, FacetWords>> = {
  bambu_lab_3d_printers: { ar: 'طابعات Bambu Lab ثلاثية الأبعاد', en: 'Bambu Lab 3D printers', ckb: 'چاپکەرە سێ ڕەهەندییەکانی Bambu Lab' },
  bambu_filament: { ar: 'فلامنت Bambu', en: 'Bambu filament', ckb: 'فیلامێنتی Bambu' },
  bambu_lab_ams: { ar: 'أنظمة AMS من Bambu Lab', en: 'Bambu Lab AMS', ckb: 'سیستەمەکانی AMSی Bambu Lab' },
  bambu_lab_laser_cutters: { ar: 'أجهزة ليزر Bambu Lab', en: 'Bambu Lab laser cutters', ckb: 'ئامێرەکانی لەیزەری Bambu Lab' },
};

/** A family token in words: its authored name, else the code with spaces (Latin in every language). */
export function familyLabel(token: string): FacetWords {
  const known = FAMILY_LABELS[token];
  if (known) return known;
  const words = token.replace(/_/g, ' ').trim();
  return { ar: words, en: words, ckb: words };
}

/** A base colour token in words, or null when the token is an admin's own colour text. */
export function baseColourLabel(token: string): FacetWords | null {
  return Object.prototype.hasOwnProperty.call(BASE_COLOURS, token) ? BASE_COLOURS[token as BaseColour] : null;
}
