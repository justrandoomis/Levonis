import type { Language } from '../../translations';
import { PAGE_STRINGS, type PageStrings } from './copy/page';
import { ADD_STRINGS, type AddStrings } from './copy/add';
import { CLAIM_STRINGS, type ClaimStrings } from './copy/claims';

/**
 * Every visible string on the warranty surface, in the three UI languages.
 * The words live in four tables by subject (./copy): the page and the printer
 * card, «إضافة طابعة», the requests and their conversation, and Levo Care. Each
 * is one interface and three literal tables, so a key missing from any language
 * is a type error, not a blank label in production.
 *
 * `WARRANTY_STRINGS[lang]` is the first three joined — what every component of
 * the page takes as `s`; `CARE_STRINGS[lang]` stays its own table.
 */
export type WarrantyStrings = PageStrings & AddStrings & ClaimStrings;

const join = (lang: Language): WarrantyStrings => ({ ...PAGE_STRINGS[lang], ...ADD_STRINGS[lang], ...CLAIM_STRINGS[lang] });

export const WARRANTY_STRINGS: Record<Language, WarrantyStrings> = { ar: join('ar'), en: join('en'), ckb: join('ckb') };

export { CARE_STRINGS, type CareStrings } from './copy/care';
