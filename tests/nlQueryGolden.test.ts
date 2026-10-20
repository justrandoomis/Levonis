/**
 * THE GOLDEN CORPUS of the words-as-constraints parser (smart search 1.6/1.7,
 * packages/catalog/src/nlQuery.ts): one table, one row per query, each row the
 * answer the parser owes — not the answer it gives today. Every case the
 * review verifiers found is here, with acceptance rows 9 to 12, in Arabic,
 * English and Sorani.
 *
 * The rows are written to the fixed policy (it is not re-opened here):
 *
 *  (a) a bare number below 1,000 is thousands, from 1,000 it is dinars as
 *      written — an upper and a lower bound alike; a grouped number
 *      («30,000», «٣٠٬٠٠٠») is literal;
 *  (b) a range — with an opener (between, «بين», «من … الى», «لە نێوان», «لە … تا»)
 *      or as two bounds («اكثر من X واقل من Y») — is never inverted: when
 *      reading both ends by (a) inverts the order written, the smaller written
 *      end is read as written too; a bare end below 1,000 beside a money word
 *      shares that word, whichever side the word is on;
 *  (c) a negation carried by a list word («ولا», «والا», «او», "or", "nor",
 *      «یان») reaches exclusions only (a colour, a material, a word, AMS/combo),
 *      never a price bound, the sale mode or the spool facet; a function word
 *      («بس», «حتى», "just", "only", «لەگەڵ», «مع», "with", «تەنها» …) is
 *      never excluded;
 *  (d) a chip's removal text, read again, is the same answer less exactly that
 *      chip (removing the first exclusion of a negation list keeps the negation
 *      for the rest);
 *  (e) a per-unit word makes a price only before a unit things are sold by
 *      (kg, g, piece, roll, spool, litre, ml, metre, their Arabic and Sorani
 *      forms, the Sorani indefinite «ێک/یەک» forms too); a measure (length,
 *      temperature, power, time, Sorani indefinite forms included) never
 *      becomes a price; «N کیلۆی» after a number stays a quantity.
 *
 * How a row reads. `expect` lists the constraints the query carries; a
 * constraint it does not list is one the query must NOT carry (the chips are
 * compared as a set: price, sale, spool, sort, diameter:x, color:x, color!:x,
 * material:x, material!:x, exclude:x). `price` is [min, max] in dinars, or in
 * dollars with `usd`. `exHas` / `notEx` say only which words are and are not
 * excluded, where the policy fixes no more than that. Every row also holds
 * the removal contract (d) for each of its chips, except the few marked
 * `contract: false`: there a material is the only filament word beside a
 * diameter or a bare spool word, the documented exception pinned in
 * tests/assistUnderstand.test.ts, which this corpus does not decide.
 *
 * Deterministic: nothing here asks a model.
 *
 * Run: node --import tsx --test tests/nlQueryGolden.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nlChipKey, nlFold, parseNlQuery, type NlChip } from '../packages/catalog/src/nlQuery';

type Lang = 'ar' | 'en' | 'ckb';

interface Expect {
  /** [min, max]; null: no price at all. Omitted: no price either. */
  price?: [number | null, number | null] | null;
  /** The price is in dollars as typed (the route converts it). */
  usd?: true;
  /** The words left for the ranked search, exactly. */
  text?: string;
  /** Words the search text must still hold (where the policy fixes no more). */
  textHas?: string[];
  /** exclude.words, exactly (folded, in order). */
  ex?: string[];
  /** Words that must be excluded / must never be, when the rest is not fixed by the policy. */
  exHas?: string[];
  notEx?: string[];
  exC?: string[];
  exM?: string[];
  colours?: string[];
  materials?: string[];
  diameters?: string[];
  sale?: 'direct' | 'preorder';
  spool?: 'refill' | 'spool';
  sort?: 'price_asc';
  /** The removal text of these chips (nlChipKey → text), exactly. */
  drop?: Record<string, string>;
  /** false: the removal contract (d) is not checked on this row (see the header). */
  contract?: false;
}

interface Row {
  q: string;
  lang: Lang;
  expect: Expect;
}

const ROWS: Row[] = [
  // ======================================================================
  // ACCEPTANCE ROW 9 — «فلامنت اسود اقل من 30 الف»: filament, black, at most 30,000
  // ======================================================================
  { q: 'فلامنت اسود اقل من 30 الف', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'], drop: { price: 'فلامنت اسود', 'color:black': 'فلامنت اقل من 30 الف' } } },
  { q: 'فلامنت أسود أقل من ٣٠ ألف', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'] } },
  { q: 'فلامنت اسود اقل من ۳۰ الف', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'] } },
  { q: 'فلامنت اسود اقل من ثلاثين الف', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'] } },
  { q: 'فلامنت اسود تحت 30 الف', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'] } },
  { q: 'فلامنت اسود 30 الف واقل', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'] } },
  { q: 'فلامنت اسود بحدود 30 الف', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'] } },
  { q: 'فلامنت الاسود اقل من 30,000 دينار', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'] } },
  { q: 'فلامنت اسود اقل من 30', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', colours: ['black'] } },
  { q: 'filament black under 30k', lang: 'en', expect: { price: [null, 30_000], text: 'filament', colours: ['black'] } },
  { q: 'black filament below 30,000', lang: 'en', expect: { price: [null, 30_000], text: 'filament', colours: ['black'] } },
  { q: 'filament black thirty thousand or less', lang: 'en', expect: { price: [null, 30_000], text: 'filament', colours: ['black'] } },
  { q: 'black filament under 30', lang: 'en', expect: { price: [null, 30_000], text: 'filament', colours: ['black'] } },
  { q: 'فیلامێنت ڕەش کەمتر لە 30 هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'فیلامێنت', colours: ['black'] } },
  { q: 'فیلامێنت ڕەش لە ٣٠ هەزار کەمتر', lang: 'ckb', expect: { price: [null, 30_000], text: 'فیلامێنت', colours: ['black'] } },
  { q: 'فیلامێنت ڕەش کەمتر لە سی هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'فیلامێنت', colours: ['black'] } },
  { q: 'فیلامێنت ڕەش کەمتر لە 30', lang: 'ckb', expect: { price: [null, 30_000], text: 'فیلامێنت', colours: ['black'] } },

  // ======================================================================
  // ACCEPTANCE ROW 10 — a negation is an exclusion
  // ======================================================================
  { q: 'طابعة بدون AMS', lang: 'ar', expect: { text: 'طابعة', ex: ['ams'], drop: { 'exclude:ams': 'طابعة' } } },
  { q: 'طابعة بلا AMS', lang: 'ar', expect: { text: 'طابعة', ex: ['ams'] } },
  { q: 'طابعة ما بيه AMS', lang: 'ar', expect: { text: 'طابعة', ex: ['ams'] } },
  { q: 'طابعة مو كومبو', lang: 'ar', expect: { text: 'طابعة', ex: ['combo'] } },
  { q: 'X1C بدون AMS', lang: 'ar', expect: { text: 'X1C', ex: ['ams'] } },
  { q: 'فلامنت مو اسود', lang: 'ar', expect: { text: 'فلامنت', exC: ['black'], drop: { 'color!:black': 'فلامنت' } } },
  { q: 'فلامنت بدون PLA', lang: 'ar', expect: { text: 'فلامنت', exM: ['pla'] } },
  { q: 'printer without AMS', lang: 'en', expect: { text: 'printer', ex: ['ams'] } },
  { q: 'printer no combo', lang: 'en', expect: { text: 'printer', ex: ['combo'] } },
  { q: 'non-combo printer', lang: 'en', expect: { text: 'printer', ex: ['combo'] } },
  { q: 'non-AMS printer', lang: 'en', expect: { text: 'printer', ex: ['ams'] } },
  { q: 'P1S without AMS', lang: 'en', expect: { text: 'P1S', ex: ['ams'] } },
  { q: 'non-combo A1', lang: 'en', expect: { text: 'A1', ex: ['combo'] } },
  { q: 'non-black PLA', lang: 'en', expect: { text: 'PLA', exC: ['black'], materials: ['pla'] } },
  { q: 'non-PLA filament', lang: 'en', expect: { text: 'filament', exM: ['pla'] } },
  { q: 'non-slip mat', lang: 'en', expect: { price: null, text: 'non-slip mat' } },
  { q: 'Non-Stick Glue', lang: 'en', expect: { text: 'Non-Stick Glue' } },
  { q: 'non-laser H2C', lang: 'en', expect: { text: 'non-laser H2C' } },
  { q: 'چاپکەر بێ AMS', lang: 'ckb', expect: { text: 'چاپکەر', ex: ['ams'], drop: { 'exclude:ams': 'چاپکەر' } } },
  { q: 'چاپکەر بەبێ AMS', lang: 'ckb', expect: { text: 'چاپکەر', ex: ['ams'] } },
  { q: 'چاپکەر نەک کۆمبۆ', lang: 'ckb', expect: { text: 'چاپکەر', ex: ['combo'] } },
  { q: 'A1 mini بێ AMS', lang: 'ckb', expect: { text: 'A1 mini', ex: ['ams'] } },

  // ======================================================================
  // ACCEPTANCE ROW 11 — refill vs with spool; a bare spool word is a product
  // ======================================================================
  { q: 'ريفل', lang: 'ar', expect: { text: '', spool: 'refill', drop: { spool: '' } } },
  { q: 'ريفيل', lang: 'ar', expect: { text: '', spool: 'refill' } },
  { q: 'بدون بكرة', lang: 'ar', expect: { text: '', spool: 'refill' } },
  { q: 'عبوة بدون بكرة', lang: 'ar', expect: { text: '', spool: 'refill' } },
  { q: 'فلامنت بدون بكرة', lang: 'ar', expect: { text: 'فلامنت', spool: 'refill', drop: { spool: 'فلامنت' } } },
  { q: 'بكرة كاملة', lang: 'ar', expect: { text: '', spool: 'spool' } },
  { q: 'مع بكرة', lang: 'ar', expect: { text: '', spool: 'spool' } },
  { q: 'فلامنت بكرة', lang: 'ar', expect: { text: 'فلامنت', spool: 'spool' } },
  { q: 'بكرة فارغة', lang: 'ar', expect: { text: 'بكرة فارغة' } },
  { q: 'حامل بكرة', lang: 'ar', expect: { text: 'حامل بكرة' } },
  { q: 'طابعة بكرة', lang: 'ar', expect: { text: 'طابعة بكرة' } },
  { q: 'refill', lang: 'en', expect: { text: '', spool: 'refill' } },
  { q: 'with spool', lang: 'en', expect: { text: '', spool: 'spool' } },
  { q: 'full spool', lang: 'en', expect: { text: '', spool: 'spool' } },
  { q: 'PLA refill', lang: 'en', expect: { text: 'PLA', materials: ['pla'], spool: 'refill' } },
  { q: 'refill PLA', lang: 'en', expect: { text: 'PLA', materials: ['pla'], spool: 'refill' } },
  { q: 'PLA spool', lang: 'en', expect: { text: 'PLA', materials: ['pla'], spool: 'spool', contract: false } },
  { q: 'empty spool', lang: 'en', expect: { text: 'empty spool' } },
  { q: 'spool holder', lang: 'en', expect: { text: 'spool holder' } },
  { q: 'Bambu Reusable Spool', lang: 'en', expect: { text: 'Bambu Reusable Spool' } },
  { q: 'PTFE 1.75', lang: 'en', expect: { text: 'PTFE 1.75' } },
  { q: 'ڕیفیل', lang: 'ckb', expect: { text: '', spool: 'refill' } },
  { q: 'بێ ماسوورە', lang: 'ckb', expect: { text: '', spool: 'refill' } },
  { q: 'لەگەڵ ماسوورە', lang: 'ckb', expect: { text: '', spool: 'spool' } },
  { q: 'فیلامێنت ماسوورە', lang: 'ckb', expect: { text: 'فیلامێنت', spool: 'spool' } },
  { q: 'PLA ڕیفیل', lang: 'ckb', expect: { text: 'PLA', materials: ['pla'], spool: 'refill' } },
  { q: 'ماسوورە', lang: 'ckb', expect: { text: 'ماسوورە' } },

  // ======================================================================
  // ACCEPTANCE ROW 12 — «متوفر هسه» is direct, «حجز» pre-order
  // ======================================================================
  { q: 'متوفر هسه', lang: 'ar', expect: { text: '', sale: 'direct' } },
  { q: 'متوفر', lang: 'ar', expect: { text: '', sale: 'direct' } },
  { q: 'موجود الان', lang: 'ar', expect: { text: '', sale: 'direct' } },
  { q: 'بدون حجز', lang: 'ar', expect: { text: '', sale: 'direct' } },
  { q: 'حجز', lang: 'ar', expect: { text: '', sale: 'preorder' } },
  { q: 'حجز مسبق', lang: 'ar', expect: { text: '', sale: 'preorder' } },
  { q: 'مو متوفر', lang: 'ar', expect: { text: '', sale: 'preorder' } },
  { q: 'PLA متوفر هسه', lang: 'ar', expect: { text: 'PLA', materials: ['pla'], sale: 'direct' } },
  { q: 'طابعة هسه', lang: 'ar', expect: { text: 'طابعة هسه' } },
  { q: 'طابعة دفع مباشر', lang: 'ar', expect: { text: 'طابعة دفع مباشر' } },
  { q: 'in stock', lang: 'en', expect: { text: '', sale: 'direct' } },
  { q: 'available now', lang: 'en', expect: { text: '', sale: 'direct' } },
  { q: 'pre-order', lang: 'en', expect: { text: '', sale: 'preorder' } },
  { q: 'in stock PLA', lang: 'en', expect: { text: 'PLA', materials: ['pla'], sale: 'direct' } },
  { q: 'direct drive printer', lang: 'en', expect: { text: 'direct drive printer' } },
  { q: 'AMS ready printer', lang: 'en', expect: { text: 'AMS ready printer' } },
  { q: 'بەردەستە', lang: 'ckb', expect: { text: '', sale: 'direct' } },
  { q: 'ئێستا بەردەستە', lang: 'ckb', expect: { text: '', sale: 'direct' } },
  { q: 'پێشوەختە', lang: 'ckb', expect: { text: '', sale: 'preorder' } },
  { q: 'فرۆشتنی ڕاستەوخۆ', lang: 'ckb', expect: { text: '', sale: 'direct' } },
  { q: 'فیلامێنت سپی بەردەستە', lang: 'ckb', expect: { text: 'فیلامێنت', colours: ['white'], sale: 'direct' } },

  // ======================================================================
  // (a) ONE BARE-NUMBER RULE — below 1,000 thousands, from 1,000 as written; grouped literal
  // ======================================================================
  { q: 'اقل من 30', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'طابعة تحت 500', lang: 'ar', expect: { price: [null, 500_000], text: 'طابعة' } },
  { q: 'اقل من 1000', lang: 'ar', expect: { price: [null, 1_000], text: '' } },
  { q: 'اقل من 1500', lang: 'ar', expect: { price: [null, 1_500], text: '' } },
  { q: 'اقل من 30000', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'اقل من ٣٠٠٠٠', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'اقل من 15000000', lang: 'ar', expect: { price: [null, 15_000_000], text: '' } },
  { q: 'اكثر من 500', lang: 'ar', expect: { price: [500_000, null], text: '' } },
  { q: 'اكثر من 9999', lang: 'ar', expect: { price: [9_999, null], text: '' } },
  { q: 'اكثر من 20000', lang: 'ar', expect: { price: [20_000, null], text: '' } },
  { q: 'طابعة 30000 او اكثر', lang: 'ar', expect: { price: [30_000, null], text: 'طابعة' } },
  { q: '30000 واقل', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'اقل من 30,000', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'اقل من ٣٠٬٠٠٠', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'اقل من 1,500,000', lang: 'ar', expect: { price: [null, 1_500_000], text: '' } },
  { q: 'اكثر من 20,000', lang: 'ar', expect: { price: [20_000, null], text: '' } },
  { q: 'اقل من 30 الف', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'اقل من 1500 الف', lang: 'ar', expect: { price: [null, 1_500_000], text: '' } },
  { q: 'اقل من 30000 دينار', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'طابعة اقل من 1000 الف', lang: 'ar', expect: { price: [null, 1_000_000], text: 'طابعة' } },
  { q: 'under 1', lang: 'en', expect: { price: [null, 1_000], text: '' } },
  { q: 'under 999', lang: 'en', expect: { price: [null, 999_000], text: '' } },
  { q: 'under 1000', lang: 'en', expect: { price: [null, 1_000], text: '' } },
  { q: 'under 9999', lang: 'en', expect: { price: [null, 9_999], text: '' } },
  { q: 'under 10000', lang: 'en', expect: { price: [null, 10_000], text: '' } },
  { q: 'printer below 1000', lang: 'en', expect: { price: [null, 1_000], text: 'printer' } },
  { q: 'printer 1000 or less', lang: 'en', expect: { price: [null, 1_000], text: 'printer' } },
  { q: 'printer max 500', lang: 'en', expect: { price: [null, 500_000], text: 'printer' } },
  { q: 'above 999', lang: 'en', expect: { price: [999_000, null], text: '' } },
  { q: 'above 1000', lang: 'en', expect: { price: [1_000, null], text: '' } },
  { q: 'over 50000', lang: 'en', expect: { price: [50_000, null], text: '' } },
  { q: 'more than 15000', lang: 'en', expect: { price: [15_000, null], text: '' } },
  { q: '30000 or less', lang: 'en', expect: { price: [null, 30_000], text: '' } },
  { q: '30000 and up', lang: 'en', expect: { price: [30_000, null], text: '' } },
  { q: 'under 30,000', lang: 'en', expect: { price: [null, 30_000], text: '' } },
  { q: 'under 1.500.000', lang: 'en', expect: { price: [null, 1_500_000], text: '' } },
  { q: 'under 12,000,000', lang: 'en', expect: { price: [null, 12_000_000], text: '' } },
  { q: 'under 500k', lang: 'en', expect: { price: [null, 500_000], text: '' } },
  { q: 'over 1.5m', lang: 'en', expect: { price: [1_500_000, null], text: '' } },
  { q: 'کەمتر لە 30', lang: 'ckb', expect: { price: [null, 30_000], text: '' } },
  { q: 'کەمتر لە 999', lang: 'ckb', expect: { price: [null, 999_000], text: '' } },
  { q: 'کەمتر لە 1000', lang: 'ckb', expect: { price: [null, 1_000], text: '' } },
  { q: 'زیاتر لە 500', lang: 'ckb', expect: { price: [500_000, null], text: '' } },
  { q: 'فیلامێنت زیاتر لە 30000', lang: 'ckb', expect: { price: [30_000, null], text: 'فیلامێنت' } },
  { q: 'لە 30000 کەمتر', lang: 'ckb', expect: { price: [null, 30_000], text: '' } },
  { q: 'کەمتر لە ۳۰۰۰۰', lang: 'ckb', expect: { price: [null, 30_000], text: '' } },
  { q: 'کەمتر لە 30,000', lang: 'ckb', expect: { price: [null, 30_000], text: '' } },
  { q: 'لە 30 هەزار کەمتر', lang: 'ckb', expect: { price: [null, 30_000], text: '' } },
  // The Arabic comma «،» (the comma key of an Arabic keyboard) between digits groups thousands too: written in full.
  { q: 'اقل من ١،٥٠٠،٠٠٠', lang: 'ar', expect: { price: [null, 1_500_000], text: '' } },
  { q: 'اقل من 30،000', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'بين ٢٠،٠٠٠ و ٣٠،٠٠٠', lang: 'ar', expect: { price: [20_000, 30_000], text: '' } },
  { q: 'کەمتر لە ٣٠،٠٠٠', lang: 'ckb', expect: { price: [null, 30_000], text: '' } },

  // ======================================================================
  // (b) A RANGE WITH AN OPENER — never inverted; a bare end beside a money word shares it
  // ======================================================================
  { q: 'بين 5000 و 15000', lang: 'ar', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'من 5000 الى 20000', lang: 'ar', expect: { price: [5_000, 20_000], text: '' } },
  { q: 'بين 500 و 900', lang: 'ar', expect: { price: [500_000, 900_000], text: '' } },
  { q: 'بين 25 و 50', lang: 'ar', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'بين 9 و 15000', lang: 'ar', expect: { price: [9_000, 15_000], text: '' } },
  { q: 'بين 1 و 50000', lang: 'ar', expect: { price: [1_000, 50_000], text: '' } },
  { q: 'من 5 الى 10000', lang: 'ar', expect: { price: [5_000, 10_000], text: '' } },
  { q: 'بين 500 و 1200', lang: 'ar', expect: { price: [500, 1_200], text: '' } },
  { q: 'بين 500 و 1500', lang: 'ar', expect: { price: [500, 1_500], text: '' } },
  { q: 'من 500 الى 1500', lang: 'ar', expect: { price: [500, 1_500], text: '' } },
  { q: 'بين 500 و 9999', lang: 'ar', expect: { price: [500, 9_999], text: '' } },
  { q: 'بين 999 و 1000', lang: 'ar', expect: { price: [999, 1_000], text: '' } },
  { q: 'طابعة بين 500 و 1000', lang: 'ar', expect: { price: [500, 1_000], text: 'طابعة' } },
  { q: 'بين 50 و 20000', lang: 'ar', expect: { price: [50, 20_000], text: '' } },
  { q: 'بين 9999 و 10000', lang: 'ar', expect: { price: [9_999, 10_000], text: '' } },
  { q: 'بين 9000 و 9999', lang: 'ar', expect: { price: [9_000, 9_999], text: '' } },
  { q: 'بين 5,000 و 15', lang: 'ar', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'بين 500 و 1,200', lang: 'ar', expect: { price: [500, 1_200], text: '' } },
  { q: 'بين 50 و 25', lang: 'ar', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'بين 15000 و 5000', lang: 'ar', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'بين 25 و 50 الف', lang: 'ar', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'بين 2 و 3 مليون', lang: 'ar', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'بين 50 و 25 الف', lang: 'ar', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'بين 50 و 25 الف دينار', lang: 'ar', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'بين 3 و 2 مليون', lang: 'ar', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'بين 3 و 2 مليون دينار', lang: 'ar', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'بين 2 و 1 مليون', lang: 'ar', expect: { price: [1_000_000, 2_000_000], text: '' } },
  { q: 'بين 900 و 500 الف', lang: 'ar', expect: { price: [500_000, 900_000], text: '' } },
  { q: 'بين 600 و 400 الف', lang: 'ar', expect: { price: [400_000, 600_000], text: '' } },
  { q: 'بين 7 و 5 الاف', lang: 'ar', expect: { price: [5_000, 7_000], text: '' } },
  // A count ten times the other's or more is not one written high-to-low: 500,000 to a million, like «بين 500 و مليون».
  { q: 'بين 500 و 1 مليون', lang: 'ar', expect: { price: [500_000, 1_000_000], text: '' } },
  { q: 'بين 500 الف و 400', lang: 'ar', expect: { price: [400_000, 500_000], text: '' } },
  { q: 'بين 500 الف و مليون', lang: 'ar', expect: { price: [500_000, 1_000_000], text: '' } },
  { q: '250-400 الف', lang: 'ar', expect: { price: [250_000, 400_000], text: '' } },
  { q: 'بين 5 الف و 9000', lang: 'ar', expect: { price: [5_000, 9_000], text: '' } },
  { q: 'بين 1500 و 2 مليون', lang: 'ar', expect: { price: [1_500, 2_000_000], text: '' } },
  { q: 'بين 100 و 200 دولار', lang: 'ar', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'فلامنت ابيض بين 20 و 30 الف', lang: 'ar', expect: { price: [20_000, 30_000], text: 'فلامنت', colours: ['white'] } },
  { q: 'from 2000 to 20000', lang: 'en', expect: { price: [2_000, 20_000], text: '' } },
  { q: 'between 5000 and 15000', lang: 'en', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'between 500 and 900', lang: 'en', expect: { price: [500_000, 900_000], text: '' } },
  { q: 'between 500 and 1200', lang: 'en', expect: { price: [500, 1_200], text: '' } },
  { q: 'from 500 to 1200', lang: 'en', expect: { price: [500, 1_200], text: '' } },
  { q: 'between 500 and 1500', lang: 'en', expect: { price: [500, 1_500], text: '' } },
  { q: 'between 50 and 20000', lang: 'en', expect: { price: [50, 20_000], text: '' } },
  { q: 'between 9000 and 9999', lang: 'en', expect: { price: [9_000, 9_999], text: '' } },
  { q: 'between 15000 and 5000', lang: 'en', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'between 5 and 15,000', lang: 'en', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'between 25 and 50k', lang: 'en', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'between 2 and 3 million', lang: 'en', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'between 50 and 25k', lang: 'en', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'between 3 and 2 million', lang: 'en', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'between 900 and 500k', lang: 'en', expect: { price: [500_000, 900_000], text: '' } },
  { q: 'between 600 and 400k', lang: 'en', expect: { price: [400_000, 600_000], text: '' } },
  { q: 'between 500 and 1 million', lang: 'en', expect: { price: [500_000, 1_000_000], text: '' } },
  { q: 'between 500k and 1m', lang: 'en', expect: { price: [500_000, 1_000_000], text: '' } },
  { q: '$100 to 200', lang: 'en', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'between $5 and $10', lang: 'en', expect: { price: [5, 10], usd: true, text: '' } },
  { q: 'between 100 and 200 dollars', lang: 'en', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'white PLA between 20 and 30k', lang: 'en', expect: { price: [20_000, 30_000], text: 'PLA', colours: ['white'], materials: ['pla'] } },
  { q: 'لە نێوان 5000 و 15000', lang: 'ckb', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'لە 5000 تا 20000', lang: 'ckb', expect: { price: [5_000, 20_000], text: '' } },
  { q: 'لە نێوان 500 و 900', lang: 'ckb', expect: { price: [500_000, 900_000], text: '' } },
  { q: 'لە نێوان 500 و 1200', lang: 'ckb', expect: { price: [500, 1_200], text: '' } },
  { q: 'لە 500 تا 1500', lang: 'ckb', expect: { price: [500, 1_500], text: '' } },
  { q: 'لە نێوان 50 و 20000', lang: 'ckb', expect: { price: [50, 20_000], text: '' } },
  { q: 'لە نێوان 25 و 50 هەزار', lang: 'ckb', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'لە نێوان 2 و 3 ملیۆن', lang: 'ckb', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'لە نێوان 50 و 25 هەزار', lang: 'ckb', expect: { price: [25_000, 50_000], text: '' } },
  { q: 'لە نێوان 3 و 2 ملیۆن', lang: 'ckb', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'لە نێوان 900 و 500 هەزار', lang: 'ckb', expect: { price: [500_000, 900_000], text: '' } },
  { q: 'لە نێوان 600 و 400 هەزار', lang: 'ckb', expect: { price: [400_000, 600_000], text: '' } },
  { q: 'لە نێوان 500 هەزار و ملیۆن', lang: 'ckb', expect: { price: [500_000, 1_000_000], text: '' } },
  { q: 'PLA سپی لە نێوان 20 و 30 هەزار', lang: 'ckb', expect: { price: [20_000, 30_000], text: 'PLA', colours: ['white'], materials: ['pla'] } },
  // The mirror of «بين 500 و 1 مليون»: the money word first, a bare end ten times its count or more is thousands.
  { q: 'between 1 million and 500', lang: 'en', expect: { price: [500_000, 1_000_000], text: '' } },
  { q: 'بين مليون و 500', lang: 'ar', expect: { price: [500_000, 1_000_000], text: '' } },
  { q: 'لە نێوان ملیۆن و 500', lang: 'ckb', expect: { price: [500_000, 1_000_000], text: '' } },
  { q: 'بين 1.5 مليون و 800', lang: 'ar', expect: { price: [800_000, 1_500_000], text: '' } },
  { q: 'between 2 million and 900', lang: 'en', expect: { price: [900_000, 2_000_000], text: '' } },
  { q: 'بين مليونين و 500', lang: 'ar', expect: { price: [500_000, 2_000_000], text: '' } },
  // Two number words with «و» between them are a range's two ends, never one sum; the opener is consumed.
  { q: 'بين عشرين وثلاثين الف', lang: 'ar', expect: { price: [20_000, 30_000], text: '' } },
  { q: 'بين مية وميتين الف', lang: 'ar', expect: { price: [100_000, 200_000], text: '' } },
  { q: 'بين ثلاثمية واربعمية الف', lang: 'ar', expect: { price: [300_000, 400_000], text: '' } },
  { q: 'بين خمسة وعشرة الاف', lang: 'ar', expect: { price: [5_000, 10_000], text: '' } },
  { q: 'between twenty and thirty thousand', lang: 'en', expect: { price: [20_000, 30_000], text: '' } },
  { q: 'لە نێوان بیست و سی هەزار', lang: 'ckb', expect: { price: [20_000, 30_000], text: '' } },
  { q: 'لە نێوان سەد و دوو سەد هەزار', lang: 'ckb', expect: { price: [100_000, 200_000], text: '' } },
  { q: 'لە نێوان سێ سەد و چوار سەد هەزار', lang: 'ckb', expect: { price: [300_000, 400_000], text: '' } },
  // One number still joins its places: hundreds, tens and units, in either order of tens and units.
  { q: 'اقل من ثلاثمية وخمسين الف', lang: 'ar', expect: { price: [null, 350_000], text: '' } },
  { q: 'اقل من عشرين وخمسة الف', lang: 'ar', expect: { price: [null, 25_000], text: '' } },
  { q: 'کەمتر لە سێ سەد و پەنجا هەزار', lang: 'ckb', expect: { price: [null, 350_000], text: '' } },
  { q: 'less than one million and two hundred thousand', lang: 'en', expect: { price: [null, 1_200_000], text: '' } },
  // Written high-to-low and read ascending by the rule: the smaller end, the second, as written too.
  { q: 'between 1000 and 500', lang: 'en', expect: { price: [500, 1_000], text: '' } },
  { q: 'between 1500 and 999', lang: 'en', expect: { price: [999, 1_500], text: '' } },
  { q: 'between 1000 and 999', lang: 'en', expect: { price: [999, 1_000], text: '' } },
  { q: 'from 1500 to 500', lang: 'en', expect: { price: [500, 1_500], text: '' } },
  { q: 'بين 1200 و 500', lang: 'ar', expect: { price: [500, 1_200], text: '' } },
  { q: 'من 1500 الى 500', lang: 'ar', expect: { price: [500, 1_500], text: '' } },
  { q: 'بين ١٬٥٠٠ و ٥٠٠', lang: 'ar', expect: { price: [500, 1_500], text: '' } },
  { q: 'لە نێوان 1500 و 500', lang: 'ckb', expect: { price: [500, 1_500], text: '' } },
  { q: 'لە ١٥٠٠ تا ٥٠٠', lang: 'ckb', expect: { price: [500, 1_500], text: '' } },
  // A bare count beside «ورقة» shares it, either side, in either order.
  { q: 'بين 3 و 5 ورقات', lang: 'ar', expect: { price: [300, 500], usd: true, text: '' } },
  { q: 'من 3 الى 5 ورقات', lang: 'ar', expect: { price: [300, 500], usd: true, text: '' } },
  { q: '3-5 ورقات', lang: 'ar', expect: { price: [300, 500], usd: true, text: '' } },
  { q: 'بين 3 ورقات و 5', lang: 'ar', expect: { price: [300, 500], usd: true, text: '' } },
  { q: 'بين 5 و 3 ورقات', lang: 'ar', expect: { price: [300, 500], usd: true, text: '' } },
  { q: 'لە نێوان 500 هەزار و ملیۆنێک', lang: 'ckb', expect: { price: [500_000, 1_000_000], text: '' } },

  // ======================================================================
  // (b) A RANGE AS TWO BOUNDS — the same rule: never inverted
  // ======================================================================
  { q: 'اكثر من 500 واقل من 1500', lang: 'ar', expect: { price: [500, 1_500], text: '' } },
  { q: 'اقل من 1500 واكثر من 500', lang: 'ar', expect: { price: [500, 1_500], text: '' } },
  { q: 'اكثر من 50 واقل من 20000', lang: 'ar', expect: { price: [50, 20_000], text: '' } },
  { q: 'اكثر من 900 واقل من 1000', lang: 'ar', expect: { price: [900, 1_000], text: '' } },
  { q: 'اكثر من 10 واقل من 30 الف', lang: 'ar', expect: { price: [10_000, 30_000], text: '' } },
  { q: 'اقل من 30 الف واكثر من 10', lang: 'ar', expect: { price: [10_000, 30_000], text: '' } },
  { q: 'اكثر من 5000 واقل من 15000', lang: 'ar', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'اكثر من 20 واقل من 50', lang: 'ar', expect: { price: [20_000, 50_000], text: '' } },
  { q: 'طابعة اكثر من 500 الف واقل من مليون', lang: 'ar', expect: { price: [500_000, 1_000_000], text: 'طابعة' } },
  // Two bounds share a money word as a range with an opener does.
  { q: 'اكثر من 2 واقل من 3 مليون', lang: 'ar', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'اقل من 3 مليون واكثر من 2', lang: 'ar', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'اكثر من 10 واقل من 30 الف PLA', lang: 'ar', expect: { price: [10_000, 30_000], text: 'PLA', materials: ['pla'], drop: { price: 'PLA', 'material:pla': 'اكثر من 10 واقل من 30 الف' } } },
  { q: 'over 500 and under 1500', lang: 'en', expect: { price: [500, 1_500], text: '' } },
  { q: 'under 1500 and over 500', lang: 'en', expect: { price: [500, 1_500], text: '' } },
  { q: 'more than 50 and less than 20000', lang: 'en', expect: { price: [50, 20_000], text: '' } },
  { q: 'over 999 and under 1000', lang: 'en', expect: { price: [999, 1_000], text: '' } },
  { q: 'more than 10 and less than 30k', lang: 'en', expect: { price: [10_000, 30_000], text: '' } },
  { q: 'under 30k and over 10', lang: 'en', expect: { price: [10_000, 30_000], text: '' } },
  { q: 'over 5000 and under 15000', lang: 'en', expect: { price: [5_000, 15_000], text: '' } },
  { q: 'over 20 and under 50', lang: 'en', expect: { price: [20_000, 50_000], text: '' } },
  { q: 'printer over 500k and under 1m', lang: 'en', expect: { price: [500_000, 1_000_000], text: 'printer' } },
  { q: 'more than 2 and less than 3 million', lang: 'en', expect: { price: [2_000_000, 3_000_000], text: '' } },
  { q: 'زیاتر لە 500 و کەمتر لە 1500', lang: 'ckb', expect: { price: [500, 1_500], text: '' } },
  { q: 'کەمتر لە 1500 و زیاتر لە 500', lang: 'ckb', expect: { price: [500, 1_500], text: '' } },
  { q: 'زیاتر لە 50 و کەمتر لە 20000', lang: 'ckb', expect: { price: [50, 20_000], text: '' } },
  { q: 'زیاتر لە 900 و کەمتر لە 1000', lang: 'ckb', expect: { price: [900, 1_000], text: '' } },
  { q: 'زیاتر لە 10 و کەمتر لە 30 هەزار', lang: 'ckb', expect: { price: [10_000, 30_000], text: '' } },
  { q: 'کەمتر لە 30 هەزار و زیاتر لە 10', lang: 'ckb', expect: { price: [10_000, 30_000], text: '' } },
  { q: 'زیاتر لە 20 و کەمتر لە 50', lang: 'ckb', expect: { price: [20_000, 50_000], text: '' } },
  { q: 'چاپکەر زیاتر لە 500 هەزار و کەمتر لە ملیۆن', lang: 'ckb', expect: { price: [500_000, 1_000_000], text: 'چاپکەر' } },
  { q: 'زیاتر لە 2 و کەمتر لە 3 ملیۆن', lang: 'ckb', expect: { price: [2_000_000, 3_000_000], text: '' } },
  // A bare bound beside a bound with a money word: one range in that money word, whichever comes first.
  { q: 'over 100 and under 200 dollars', lang: 'en', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'under 200 dollars and over 100', lang: 'en', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'more than $100 and less than 200', lang: 'en', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'over $300 and under 500', lang: 'en', expect: { price: [300, 500], usd: true, text: '' } },
  { q: 'اكثر من 100 واقل من 200 دولار', lang: 'ar', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'اقل من 200 دولار واكثر من 100', lang: 'ar', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'اكثر من 3 واقل من 5 ورقات', lang: 'ar', expect: { price: [300, 500], usd: true, text: '' } },
  { q: 'زیاتر لە 100 و کەمتر لە 200 دۆلار', lang: 'ckb', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'کەمتر لە 200 دۆلار و زیاتر لە 100', lang: 'ckb', expect: { price: [100, 200], usd: true, text: '' } },
  { q: 'زیاتر لە 300 دۆلار و کەمتر لە 500', lang: 'ckb', expect: { price: [300, 500], usd: true, text: '' } },

  // ======================================================================
  // (c) + (d) A NEGATION CARRIED BY A LIST WORD — exclusions only; the removal keeps the negation
  // ======================================================================
  // Exclusions: every listed term is left out, and removing the first keeps the rest left out.
  { q: 'طابعة بدون AMS ولا كومبو', lang: 'ar', expect: { text: 'طابعة', ex: ['ams', 'combo'] } },
  { q: 'طابعة بدون AMS والا كومبو', lang: 'ar', expect: { text: 'طابعة', ex: ['ams', 'combo'] } },
  { q: 'طابعة بدون AMS او كومبو', lang: 'ar', expect: { text: 'طابعة', ex: ['ams', 'combo'] } },
  { q: 'بدون AMS او كومبو', lang: 'ar', expect: { text: '', ex: ['ams', 'combo'] } },
  { q: 'بدون كومبو ولا AMS', lang: 'ar', expect: { text: '', ex: ['combo', 'ams'] } },
  { q: 'بدون AMS ولا P1S', lang: 'ar', expect: { text: '', ex: ['ams', 'p1s'] } },
  { q: 'مو اسود ولا ابيض', lang: 'ar', expect: { text: '', exC: ['black', 'white'] } },
  { q: 'مو اسود والا ابيض', lang: 'ar', expect: { text: '', exC: ['black', 'white'] } },
  { q: 'بدون اسود والا ابيض PLA', lang: 'ar', expect: { text: 'PLA', exC: ['black', 'white'], materials: ['pla'] } },
  { q: 'بدون PLA ولا PETG', lang: 'ar', expect: { text: '', exM: ['pla', 'petg'] } },
  { q: 'مو PLA ولا PETG', lang: 'ar', expect: { text: '', exM: ['pla', 'petg'] } },
  { q: 'بدون اسود ولا PLA', lang: 'ar', expect: { text: '', exC: ['black'], exM: ['pla'] } },
  { q: 'بدون AMS ولا كومبو ولا اسود', lang: 'ar', expect: { text: '', ex: ['ams', 'combo'], exC: ['black'] } },
  { q: 'طابعة اقل من 500 الف بدون AMS ولا كومبو', lang: 'ar', expect: { price: [null, 500_000], text: 'طابعة', ex: ['ams', 'combo'] } },
  { q: 'بدون AMS PLA والا PETG', lang: 'ar', expect: { text: 'PLA PETG', ex: ['ams'], materials: ['pla', 'petg'] } },
  { q: 'printer without AMS or combo', lang: 'en', expect: { text: 'printer', ex: ['ams', 'combo'] } },
  { q: 'printer without AMS nor combo', lang: 'en', expect: { text: 'printer', ex: ['ams', 'combo'] } },
  { q: 'printer no AMS or combo', lang: 'en', expect: { text: 'printer', ex: ['ams', 'combo'] } },
  { q: 'without AMS or combo', lang: 'en', expect: { text: '', ex: ['ams', 'combo'] } },
  { q: 'without PLA or PETG', lang: 'en', expect: { text: '', exM: ['pla', 'petg'] } },
  { q: 'PLA without black or white', lang: 'en', expect: { text: 'PLA', exC: ['black', 'white'], materials: ['pla'] } },
  { q: 'without black or PLA', lang: 'en', expect: { text: '', exC: ['black'], exM: ['pla'] } },
  { q: 'without AMS or combo or black', lang: 'en', expect: { text: '', ex: ['ams', 'combo'], exC: ['black'] } },
  { q: 'printer under 500k without AMS or combo', lang: 'en', expect: { price: [null, 500_000], text: 'printer', ex: ['ams', 'combo'] } },
  { q: 'without AMS printer or combo', lang: 'en', expect: { text: 'printer combo', ex: ['ams'] } },
  { q: 'چاپکەر بێ AMS یان کۆمبۆ', lang: 'ckb', expect: { text: 'چاپکەر', ex: ['ams', 'combo'] } },
  { q: 'چاپکەر بەبێ AMS یان کۆمبۆ', lang: 'ckb', expect: { text: 'چاپکەر', ex: ['ams', 'combo'] } },
  { q: 'بێ AMS یان کۆمبۆ', lang: 'ckb', expect: { text: '', ex: ['ams', 'combo'] } },
  { q: 'فیلامێنت بێ PLA یان PETG', lang: 'ckb', expect: { text: 'فیلامێنت', exM: ['pla', 'petg'] } },
  { q: 'بێ ڕەش یان سپی', lang: 'ckb', expect: { text: '', exC: ['black', 'white'] } },
  { q: 'بێ ڕەش یان PLA', lang: 'ckb', expect: { text: '', exC: ['black'], exM: ['pla'] } },
  { q: 'بێ AMS یان کۆمبۆ یان ڕەش', lang: 'ckb', expect: { text: '', ex: ['ams', 'combo'], exC: ['black'] } },
  { q: 'چاپکەر کەمتر لە 500 هەزار بێ AMS یان کۆمبۆ', lang: 'ckb', expect: { price: [null, 500_000], text: 'چاپکەر', ex: ['ams', 'combo'] } },
  // A second negation after the list starts its own: removing «كومبو» leaves «بدون AMS مو اسود».
  { q: 'بدون AMS ولا كومبو ولا مو اسود', lang: 'ar', expect: { text: '', ex: ['ams', 'combo'], exC: ['black'] } },
  // A direct negation of the spool, then a listed exclusion: removing the spool keeps the AMS left out.
  { q: 'بدون بكرة ولا AMS', lang: 'ar', expect: { text: '', spool: 'refill', ex: ['ams'] } },
  { q: 'without spool or AMS', lang: 'en', expect: { text: '', spool: 'refill', ex: ['ams'] } },
  { q: 'بێ ماسوورە یان AMS', lang: 'ckb', expect: { text: '', spool: 'refill', ex: ['ams'] } },
  // A bare spool word after the list word is neither left out nor the facet (no filament word): a product word.
  { q: 'بدون AMS ولا بكرة', lang: 'ar', expect: { text: 'بكرة', ex: ['ams'] } },
  // A price bound after the list word is never negated.
  { q: 'طابعة بدون AMS او اقل من 500 الف', lang: 'ar', expect: { price: [null, 500_000], text: 'طابعة', ex: ['ams'] } },
  { q: 'بدون AMS او اكثر من 500 الف', lang: 'ar', expect: { price: [500_000, null], text: '', ex: ['ams'] } },
  { q: 'فلامنت بدون اسود ولا اقل من 20 الف', lang: 'ar', expect: { price: [null, 20_000], text: 'فلامنت', exC: ['black'] } },
  { q: 'printer without AMS or under 500k', lang: 'en', expect: { price: [null, 500_000], text: 'printer', ex: ['ams'] } },
  { q: 'without AMS or more than 500k', lang: 'en', expect: { price: [500_000, null], text: '', ex: ['ams'] } },
  { q: 'filament without black or under 20k', lang: 'en', expect: { price: [null, 20_000], text: 'filament', exC: ['black'] } },
  { q: 'چاپکەر بێ AMS یان کەمتر لە 500 هەزار', lang: 'ckb', expect: { price: [null, 500_000], text: 'چاپکەر', ex: ['ams'] } },
  { q: 'بێ AMS یان زیاتر لە 500 هەزار', lang: 'ckb', expect: { price: [500_000, null], text: '', ex: ['ams'] } },
  { q: 'فیلامێنت بێ ڕەش یان کەمتر لە 20 هەزار', lang: 'ckb', expect: { price: [null, 20_000], text: 'فیلامێنت', exC: ['black'] } },
  { q: 'بدون AMS ولا 500 الف', lang: 'ar', expect: { price: [null, 500_000], text: '', ex: ['ams'] } },
  // Nor the sale mode.
  { q: 'بدون AMS ولا متوفر', lang: 'ar', expect: { text: '', ex: ['ams'], sale: 'direct' } },
  { q: 'بدون AMS ولا حجز', lang: 'ar', expect: { text: '', ex: ['ams'], sale: 'preorder' } },
  { q: 'without AMS or in stock', lang: 'en', expect: { text: '', ex: ['ams'], sale: 'direct' } },
  { q: 'without AMS or pre-order', lang: 'en', expect: { text: '', ex: ['ams'], sale: 'preorder' } },
  { q: 'without combo nor in stock', lang: 'en', expect: { text: '', ex: ['combo'], sale: 'direct' } },
  { q: 'بێ AMS یان بەردەستە', lang: 'ckb', expect: { text: '', ex: ['ams'], sale: 'direct' } },
  // Nor the spool facet.
  { q: 'بدون AMS او بكرة كاملة', lang: 'ar', expect: { text: '', ex: ['ams'], spool: 'spool' } },
  { q: 'فلامنت بدون اسود ولا ريفل', lang: 'ar', expect: { text: 'فلامنت', exC: ['black'], spool: 'refill' } },
  { q: 'بدون PLA ولا ريفل', lang: 'ar', expect: { text: '', exM: ['pla'], spool: 'refill' } },
  { q: 'بدون كومبو ولا مع بكرة', lang: 'ar', expect: { text: '', ex: ['combo'], spool: 'spool' } },
  { q: 'without AMS or with spool', lang: 'en', expect: { text: '', ex: ['ams'], spool: 'spool' } },
  { q: 'without black or refill', lang: 'en', expect: { text: '', exC: ['black'], spool: 'refill' } },
  { q: 'without PETG or refill', lang: 'en', expect: { text: '', exM: ['petg'], spool: 'refill' } },
  { q: 'بێ ڕەش یان ڕیفیل', lang: 'ckb', expect: { text: '', exC: ['black'], spool: 'refill' } },
  { q: 'بێ PLA یان ڕیفیل', lang: 'ckb', expect: { text: '', exM: ['pla'], spool: 'refill' } },
  { q: 'بێ AMS یان لەگەڵ ماسوورە', lang: 'ckb', expect: { text: '', ex: ['ams'], spool: 'spool' } },
  // The list runs on past a price, the sale mode, the spool or the order to the next exclusion: white, PETG and
  // combo are left out too, never wanted. Removing the first exclusion moves the negation to the next one.
  { q: 'بدون اسود ولا اقل من 30 ولا ابيض', lang: 'ar', expect: { price: [null, 30_000], text: '', exC: ['black', 'white'], drop: { price: 'بدون اسود ولا ابيض', 'color!:black': 'اقل من 30 بدون ابيض', 'color!:white': 'بدون اسود ولا اقل من 30' } } },
  { q: 'فلامنت مو اسود ولا اقل من 30 ولا ابيض', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت', exC: ['black', 'white'] } },
  { q: 'بدون PLA ولا اقل من 25 للكيلو ولا PETG', lang: 'ar', expect: { price: [null, 25_000], text: '', exM: ['pla', 'petg'] } },
  { q: 'بدون AMS ولا اقل من 500 الف ولا كومبو', lang: 'ar', expect: { price: [null, 500_000], text: '', ex: ['ams', 'combo'] } },
  { q: 'بدون AMS ولا اقل من 20 الف ولا كومبو', lang: 'ar', expect: { price: [null, 20_000], text: '', ex: ['ams', 'combo'] } },
  { q: 'بدون AMS ولا متوفر ولا كومبو', lang: 'ar', expect: { text: '', sale: 'direct', ex: ['ams', 'combo'], drop: { sale: 'بدون AMS ولا كومبو', 'exclude:ams': 'متوفر بدون كومبو' } } },
  { q: 'بدون اسود ولا ريفل ولا ابيض', lang: 'ar', expect: { text: '', spool: 'refill', exC: ['black', 'white'] } },
  { q: 'بدون AMS ولا ريفل ولا كومبو', lang: 'ar', expect: { text: '', spool: 'refill', ex: ['ams', 'combo'], drop: { spool: 'بدون AMS ولا كومبو' } } },
  { q: 'بدون AMS ولا بكرة ولا كومبو', lang: 'ar', expect: { text: 'بكرة', ex: ['ams', 'combo'] } },
  { q: 'بدون AMS ولا كومبو ولا اقل من 20 الف رخيص', lang: 'ar', expect: { price: [null, 20_000], text: '', ex: ['ams', 'combo'], sort: 'price_asc', drop: { price: 'بدون AMS ولا كومبو رخيص' } } },
  { q: 'without black or between 20 and 30k or white', lang: 'en', expect: { price: [20_000, 30_000], text: '', exC: ['black', 'white'], drop: { 'color!:black': 'between 20 and 30k without white' } } },
  { q: 'without AMS or under 500k or combo', lang: 'en', expect: { price: [null, 500_000], text: '', ex: ['ams', 'combo'] } },
  { q: 'without AMS or in stock or combo', lang: 'en', expect: { text: '', sale: 'direct', ex: ['ams', 'combo'], drop: { sale: 'without AMS or combo' } } },
  { q: 'without AMS or cheapest or combo', lang: 'en', expect: { text: '', sort: 'price_asc', ex: ['ams', 'combo'] } },
  { q: 'بێ ڕەش یان لە نێوان 20 و 30 هەزار یان سپی', lang: 'ckb', expect: { price: [20_000, 30_000], text: '', exC: ['black', 'white'] } },
  { q: 'بێ ڕەش یان 30 هەزار یان سپی', lang: 'ckb', expect: { price: [null, 30_000], text: '', exC: ['black', 'white'] } },
  { q: 'بێ AMS یان کەمتر لە 500 هەزار یان کۆمبۆ', lang: 'ckb', expect: { price: [null, 500_000], text: '', ex: ['ams', 'combo'] } },
  { q: 'بێ AMS یان بەردەستە یان کۆمبۆ', lang: 'ckb', expect: { text: '', sale: 'direct', ex: ['ams', 'combo'] } },
  { q: 'بێ AMS یان لە 30 هەزار زیاتر نەبێت یان کۆمبۆ', lang: 'ckb', expect: { price: [null, 30_000], text: '', ex: ['ams', 'combo'] } },
  { q: 'بێ AMS یان ملیۆنێک', lang: 'ckb', expect: { price: [null, 1_000_000], text: '', ex: ['ams'] } },
  // A bound word is never left out, even when what follows is a measure: the measure stays searched as typed.
  { q: 'without AMS or under 300mm', lang: 'en', expect: { text: 'under 300mm', ex: ['ams'] } },
  { q: 'بدون AMS ولا اقل من 30 سم', lang: 'ar', expect: { text: 'اقل من 30 سم', ex: ['ams'] } },
  { q: 'بدون AMS ولا اكثر من 2 كيلو', lang: 'ar', expect: { text: 'اكثر من 2 كيلو', ex: ['ams'] } },
  { q: 'بێ ڕەش یان هەرزانتر لە 20 هەزار', lang: 'ckb', expect: { price: [null, 20_000], text: '', exC: ['black'] } },
  // A diameter has no opposite: a negated one is no facet, and the words stay searched.
  { q: 'filament without 1.75', lang: 'en', expect: { text: 'filament without 1.75' } },
  { q: 'فیلامێنت بێ 1.75', lang: 'ckb', expect: { text: 'فیلامێنت بێ 1.75' } },
  // A function word is never excluded.
  { q: 'بدون AMS او بس كومبو', lang: 'ar', expect: { exHas: ['ams'], notEx: ['بس'], textHas: ['كومبو'] } },
  { q: 'بدون AMS او حتى كومبو', lang: 'ar', expect: { exHas: ['ams'], notEx: ['حتى'] } },
  { q: 'طابعة بدون AMS ولا حتى كومبو', lang: 'ar', expect: { exHas: ['ams'], notEx: ['حتى'], textHas: ['طابعة'] } },
  { q: 'بدون AMS او مع كومبو', lang: 'ar', expect: { exHas: ['ams'], notEx: ['مع'], textHas: ['كومبو'] } },
  { q: 'بدون AMS ولا مع كومبو', lang: 'ar', expect: { exHas: ['ams'], notEx: ['مع'], textHas: ['كومبو'] } },
  { q: 'فلامنت بدون اسود بس ابيض', lang: 'ar', expect: { exC: ['black'], colours: ['white'], notEx: ['بس'], textHas: ['فلامنت'] } },
  { q: 'without AMS or just combo', lang: 'en', expect: { exHas: ['ams'], notEx: ['just'], textHas: ['combo'] } },
  { q: 'without AMS or only combo', lang: 'en', expect: { exHas: ['ams'], notEx: ['only'], textHas: ['combo'] } },
  { q: 'without AMS or with combo', lang: 'en', expect: { exHas: ['ams'], notEx: ['with'], textHas: ['combo'] } },
  { q: 'filament without black just white', lang: 'en', expect: { exC: ['black'], colours: ['white'], notEx: ['just'], textHas: ['filament'] } },
  { q: 'بێ AMS یان لەگەڵ کۆمبۆ', lang: 'ckb', expect: { exHas: ['ams'], notEx: ['لەگەڵ'], textHas: ['کۆمبۆ'] } },
  { q: 'بێ AMS یان تەنها کۆمبۆ', lang: 'ckb', expect: { exHas: ['ams'], notEx: ['تەنها'], textHas: ['کۆمبۆ'] } },
  { q: 'فیلامێنت بێ ڕەش تەنها سپی', lang: 'ckb', expect: { exC: ['black'], colours: ['white'], notEx: ['تەنها'], textHas: ['فیلامێنت'] } },
  { q: 'without AMS or even combo', lang: 'en', expect: { exHas: ['ams'], notEx: ['even'], textHas: ['combo'] } },
  { q: 'بدون AMS او فقط كومبو', lang: 'ar', expect: { exHas: ['ams'], notEx: ['فقط'], textHas: ['كومبو'] } },
  { q: 'بێ AMS یان تەنانەت کۆمبۆ', lang: 'ckb', expect: { exHas: ['ams'], notEx: ['تەنانەت'], textHas: ['کۆمبۆ'] } },
  { q: 'بێ AMS یان بەس کۆمبۆ', lang: 'ckb', expect: { exHas: ['ams'], notEx: ['بەس'], textHas: ['کۆمبۆ'] } },
  // Without a negation, "or" is "or": both are wanted, nothing is left out.
  { q: 'طابعة AMS او كومبو', lang: 'ar', expect: { text: 'طابعة AMS او كومبو' } },
  { q: 'PLA ولا PETG', lang: 'ar', expect: { text: 'PLA PETG', materials: ['pla', 'petg'] } },
  { q: 'PLA والا PETG', lang: 'ar', expect: { text: 'PLA PETG', materials: ['pla', 'petg'] } },
  { q: 'اسود ولا ابيض', lang: 'ar', expect: { text: '', colours: ['black', 'white'] } },
  { q: 'A1 ولا A1 mini', lang: 'ar', expect: { text: 'A1 ولا A1 mini' } },
  { q: 'printer AMS or combo', lang: 'en', expect: { text: 'printer AMS or combo' } },
  { q: 'PLA or PETG', lang: 'en', expect: { text: 'PLA PETG', materials: ['pla', 'petg'] } },
  { q: 'چاپکەر AMS یان کۆمبۆ', lang: 'ckb', expect: { text: 'چاپکەر AMS یان کۆمبۆ' } },

  // ======================================================================
  // (e) A PRICE PER UNIT SOLD — before kg, g, piece, roll, spool, litre, ml, metre
  // ======================================================================
  { q: 'فلامنت اقل من 25 للكيلو', lang: 'ar', expect: { price: [null, 25_000], text: 'فلامنت' } },
  { q: 'فلامنت اقل من 25 الف للكيلو', lang: 'ar', expect: { price: [null, 25_000], text: 'فلامنت' } },
  { q: 'فلامنت اقل من 25 لكل كيلو', lang: 'ar', expect: { price: [null, 25_000], text: 'فلامنت' } },
  { q: 'فلامنت اقل من 25 بالكيلو', lang: 'ar', expect: { price: [null, 25_000], text: 'فلامنت' } },
  { q: 'فلامنت 25 للكيلو او اقل', lang: 'ar', expect: { price: [null, 25_000], text: 'فلامنت' } },
  { q: 'فلامنت بين 20 و 30 للكيلو', lang: 'ar', expect: { price: [20_000, 30_000], text: 'فلامنت' } },
  { q: 'اقل من 3 للقطعة', lang: 'ar', expect: { price: [null, 3_000], text: '' } },
  { q: 'اقل من 5 للغرام', lang: 'ar', expect: { price: [null, 5_000], text: '' } },
  { q: 'PLA اقل من 25 للبكرة', lang: 'ar', expect: { price: [null, 25_000], text: 'PLA', materials: ['pla'] } },
  { q: 'اقل من 25 للرول', lang: 'ar', expect: { price: [null, 25_000], text: '' } },
  { q: 'ريزن اقل من 30 للتر', lang: 'ar', expect: { price: [null, 30_000], text: 'ريزن', materials: ['resin'] } },
  { q: 'PTFE اقل من 5 للمتر', lang: 'ar', expect: { price: [null, 5_000], text: 'PTFE' } },
  { q: 'filament under 25 per kg', lang: 'en', expect: { price: [null, 25_000], text: 'filament' } },
  { q: 'filament under 25/kg', lang: 'en', expect: { price: [null, 25_000], text: 'filament' } },
  { q: 'filament under 25 / kg', lang: 'en', expect: { price: [null, 25_000], text: 'filament' } },
  { q: 'filament under 25k/kg', lang: 'en', expect: { price: [null, 25_000], text: 'filament' } },
  { q: 'filament 25k or less per kg', lang: 'en', expect: { price: [null, 25_000], text: 'filament' } },
  { q: 'between 20 and 30 per kg', lang: 'en', expect: { price: [20_000, 30_000], text: '' } },
  { q: 'under 3 per piece', lang: 'en', expect: { price: [null, 3_000], text: '' } },
  { q: 'PLA under 25 per spool', lang: 'en', expect: { price: [null, 25_000], text: 'PLA', materials: ['pla'] } },
  { q: 'under 25 per roll', lang: 'en', expect: { price: [null, 25_000], text: '' } },
  { q: 'resin under 30 per litre', lang: 'en', expect: { price: [null, 30_000], text: 'resin', materials: ['resin'] } },
  { q: 'under 5 per ml', lang: 'en', expect: { price: [null, 5_000], text: '' } },
  { q: 'under 5/g', lang: 'en', expect: { price: [null, 5_000], text: '' } },
  { q: 'under 5 per gram', lang: 'en', expect: { price: [null, 5_000], text: '' } },
  { q: 'PTFE under 5 per meter', lang: 'en', expect: { price: [null, 5_000], text: 'PTFE' } },
  { q: 'فیلامێنت کەمتر لە 25 هەزار بۆ هەر کیلۆ', lang: 'ckb', expect: { price: [null, 25_000], text: 'فیلامێنت' } },
  { q: 'فیلامێنت کەمتر لە 25 هەزار بۆ هەر کیلۆیەک', lang: 'ckb', expect: { price: [null, 25_000], text: 'فیلامێنت' } },
  { q: 'فیلامێنت کەمتر لە 25 بۆ کیلۆیەک', lang: 'ckb', expect: { price: [null, 25_000], text: 'فیلامێنت' } },
  { q: 'فیلامێنت کیلۆی کەمتر لە 25 هەزار', lang: 'ckb', expect: { price: [null, 25_000], text: 'فیلامێنت' } },
  { q: 'فیلامێنت لە 25 هەزار کەمتر بۆ هەر کیلۆیەک', lang: 'ckb', expect: { price: [null, 25_000], text: 'فیلامێنت' } },
  { q: 'ڕێزن کەمتر لە 30 هەزار بۆ هەر لیترێک', lang: 'ckb', expect: { price: [null, 30_000], text: 'ڕێزن', materials: ['resin'] } },
  { q: 'PTFE کەمتر لە 5 هەزار بۆ هەر مەترێک', lang: 'ckb', expect: { price: [null, 5_000], text: 'PTFE' } },
  { q: 'PTFE مەتری کەمتر لە 5 هەزار', lang: 'ckb', expect: { price: [null, 5_000], text: 'PTFE' } },
  { q: 'کەمتر لە 3 هەزار بۆ هەر دانەیەک', lang: 'ckb', expect: { price: [null, 3_000], text: '' } },
  { q: 'کەمتر لە 5 هەزار بۆ هەر گرامێک', lang: 'ckb', expect: { price: [null, 5_000], text: '' } },
  { q: 'کەمتر لە 25 هەزار بۆ هەر ماسوورەیەک', lang: 'ckb', expect: { price: [null, 25_000], text: '' } },
  { q: 'کەمتر لە 25 هەزار بۆ هەر ڕۆڵێک', lang: 'ckb', expect: { price: [null, 25_000], text: '' } },
  { q: 'کەمتر لە 5 هەزار بۆ هەر ملیلیترێک', lang: 'ckb', expect: { price: [null, 5_000], text: '' } },
  { q: 'کەمتر لە 5 هەزار بۆ هەر ملیلیتر', lang: 'ckb', expect: { price: [null, 5_000], text: '' } },
  { q: 'resin under 5 per millilitre', lang: 'en', expect: { price: [null, 5_000], text: 'resin', materials: ['resin'] } },

  // ======================================================================
  // (e) A MEASURE IS NEVER A PRICE — length, temperature, power, time; a quantity stays searched
  // ======================================================================
  { q: 'اقل من 30 للسم', lang: 'ar', expect: { price: null, text: 'اقل من 30 للسم' } },
  { q: 'اقل من 300 بالدرجة', lang: 'ar', expect: { price: null, text: 'اقل من 300 بالدرجة' } },
  { q: 'اكثر من 300 لدرجة', lang: 'ar', expect: { price: null, text: 'اكثر من 300 لدرجة' } },
  { q: 'اقل من 40 للواط', lang: 'ar', expect: { price: null, text: 'اقل من 40 للواط' } },
  { q: 'اقل من 50 بالساعة', lang: 'ar', expect: { price: null, text: 'اقل من 50 بالساعة' } },
  { q: 'اقل من 30 لسنة', lang: 'ar', expect: { price: null, text: 'اقل من 30 لسنة' } },
  { q: 'فلامنت اقل من 1 كيلو', lang: 'ar', expect: { price: null, text: 'فلامنت اقل من 1 كيلو' } },
  { q: 'اكثر من 2 كيلو', lang: 'ar', expect: { price: null, text: 'اكثر من 2 كيلو' } },
  { q: 'اقل من 3 قطع', lang: 'ar', expect: { price: null, text: 'اقل من 3 قطع' } },
  { q: 'اقل من 2 لتر', lang: 'ar', expect: { price: null, text: 'اقل من 2 لتر' } },
  { q: 'طابعة اقل من 300 ملم', lang: 'ar', expect: { price: null, text: 'طابعة اقل من 300 ملم' } },
  { q: 'heater under 50 per hour', lang: 'en', expect: { price: null, text: 'heater under 50 per hour' } },
  { q: 'under 30 per cm', lang: 'en', expect: { price: null, text: 'under 30 per cm' } },
  { q: 'under 300 per degree', lang: 'en', expect: { price: null, text: 'under 300 per degree' } },
  { q: 'under 40 per watt', lang: 'en', expect: { price: null, text: 'under 40 per watt' } },
  { q: 'filament under 1kg', lang: 'en', expect: { price: null, text: 'filament under 1kg' } },
  { q: 'printer under 300mm', lang: 'en', expect: { price: null, text: 'printer under 300mm' } },
  { q: 'printer under 300 mm', lang: 'en', expect: { price: null, text: 'printer under 300 mm' } },
  { q: 'printer under 300mm/s', lang: 'en', expect: { price: null, text: 'printer under 300mm/s' } },
  { q: 'nozzle up to 300°C', lang: 'en', expect: { price: null, text: 'nozzle up to 300°C' } },
  { q: 'کەمتر لە 25 بۆ هەر کاتژمێر', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 25 بۆ هەر کاتژمێر' } },
  { q: 'کەمتر لە 25 بۆ هەر کاتژمێرێک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 25 بۆ هەر کاتژمێرێک' } },
  { q: 'کەمتر لە 50 بۆ کاتژمێرێک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 50 بۆ کاتژمێرێک' } },
  { q: 'کەمتر لە 50 بۆ هەر سەعاتێک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 50 بۆ هەر سەعاتێک' } },
  { q: 'کەمتر لە 25 بۆ هەر خولەکێک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 25 بۆ هەر خولەکێک' } },
  { q: 'کەمتر لە 30 بۆ هەر سم', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 30 بۆ هەر سم' } },
  { q: 'کەمتر لە 30 بۆ هەر سانتیمێترێک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 30 بۆ هەر سانتیمێترێک' } },
  { q: 'کەمتر لە 300 بۆ هەر ملم', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 300 بۆ هەر ملم' } },
  { q: 'کەمتر لە 300 بۆ هەر پلەیەک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 300 بۆ هەر پلەیەک' } },
  { q: 'کەمتر لە 40 بۆ هەر واتێک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 40 بۆ هەر واتێک' } },
  { q: 'کەمتر لە 30 بۆ هەر سانتیمەترێک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 30 بۆ هەر سانتیمەترێک' } },
  { q: 'کەمتر لە 10 بۆ هەر دەقیقەیەک', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 10 بۆ هەر دەقیقەیەک' } },
  { q: 'اقل من 10 بالدقيقة', lang: 'ar', expect: { price: null, text: 'اقل من 10 بالدقيقة' } },
  { q: 'under 10 per minute', lang: 'en', expect: { price: null, text: 'under 10 per minute' } },
  { q: 'فیلامێنت کەمتر لە 1 کیلۆ', lang: 'ckb', expect: { price: null, text: 'فیلامێنت کەمتر لە 1 کیلۆ' } },
  { q: 'زیاتر لە 2 کیلۆ', lang: 'ckb', expect: { price: null, text: 'زیاتر لە 2 کیلۆ' } },
  { q: 'کەمتر لە 3 دانە', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 3 دانە' } },
  { q: 'چاپکەر کەمتر لە 300 ملم', lang: 'ckb', expect: { price: null, text: 'چاپکەر کەمتر لە 300 ملم' } },
  { q: 'کەمتر لە 2 کیلۆی PLA', lang: 'ckb', expect: { price: null, text: 'کەمتر لە 2 کیلۆی PLA', materials: ['pla'] } },
  // Time, length and power in every short and spoken form, the Sorani indefinite «ێک / یەک» too.
  ...[
    'under 10 seconds', 'under 50 per second', 'under 3 weeks', 'under 3 months', 'under 100 per month', 'under 10 min',
    'under 10 mins', 'under 2 hr', 'under 2 hrs', 'under 30 ft', 'under 30 feet', 'under 1kw', 'under 2 kw', 'under 1.5 kW',
  ].map((q): Row => ({ q, lang: 'en', expect: { price: null, text: q } })),
  ...['اقل من 30 ثانية', 'اقل من 30 ثواني', 'اقل من 30 بالثانية', 'اقل من 2 اسابيع', 'اقل من 50 بالاسبوع'].map(
    (q): Row => ({ q, lang: 'ar', expect: { price: null, text: q } })
  ),
  ...['کەمتر لە 30 چرکە', 'کەمتر لە 50 بۆ هەر چرکەیەک', 'کەمتر لە 2 هەفتە', 'کەمتر لە 50 بۆ هەر هەفتەیەک'].map(
    (q): Row => ({ q, lang: 'ckb', expect: { price: null, text: q } })
  ),
  // A quantity beside a real price: the quantity stays in the search, the price is the bound.
  { q: 'فلامنت 2 کیلۆی کەمتر لە 30 هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'فلامنت 2 کیلۆی' } },
  { q: 'فیلامێنت 2 کیلۆی کەمتر لە 30 هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'فیلامێنت 2 کیلۆی' } },
  { q: 'PLA ٢ کیلۆی کەمتر لە ٣٠ هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'PLA ٢ کیلۆی', materials: ['pla'] } },
  { q: 'فیلامێنت 2 کیلۆی لە 30 هەزار کەمتر', lang: 'ckb', expect: { price: [null, 30_000], text: 'فیلامێنت 2 کیلۆی' } },
  { q: 'فیلامێنت 2 کیلۆی بە 30 هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'فیلامێنت 2 کیلۆی' } },
  { q: 'دوو کیلۆی کەمتر لە 30 هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'دوو کیلۆی' } },
  { q: 'فیلامێنت 1 کیلۆیی کەمتر لە 30 هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'فیلامێنت 1 کیلۆیی' } },
  { q: 'PLA 1 کیلۆ کەمتر لە 30 هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'PLA 1 کیلۆ', materials: ['pla'] } },
  { q: 'فلامنت 2 كيلو اقل من 30 الف', lang: 'ar', expect: { price: [null, 30_000], text: 'فلامنت 2 كيلو' } },
  { q: 'اقل من 30 الف 1 كيلو', lang: 'ar', expect: { price: [null, 30_000], text: '1 كيلو' } },
  { q: 'filament 2 kg under 30k', lang: 'en', expect: { price: [null, 30_000], text: 'filament 2 kg' } },
  { q: 'PLA 1kg under 30', lang: 'en', expect: { price: [null, 30_000], text: 'PLA 1kg', materials: ['pla'] } },

  // ======================================================================
  // A NUMBER WITHOUT A MONEY WORD OR A BOUND IS NOT A PRICE — model names, identifiers, sizes
  // ======================================================================
  { q: 'X1C', lang: 'en', expect: { price: null, text: 'X1C' } },
  { q: 'A1 mini', lang: 'en', expect: { text: 'A1 mini' } },
  { q: 'H2D', lang: 'en', expect: { text: 'H2D' } },
  { q: 'FAP035', lang: 'en', expect: { text: 'FAP035' } },
  { q: '10102', lang: 'en', expect: { text: '10102' } },
  { q: 'PLA 10101', lang: 'en', expect: { text: 'PLA 10101', materials: ['pla'] } },
  { q: '1000g', lang: 'en', expect: { text: '1000g' } },
  { q: '24v', lang: 'en', expect: { text: '24v' } },
  { q: 'nozzle 0.4', lang: 'en', expect: { text: 'nozzle 0.4' } },
  { q: 'Kobra 3 Max', lang: 'en', expect: { text: 'Kobra 3 Max' } },
  { q: 'Kobra 2 Plus', lang: 'en', expect: { text: 'Kobra 2 Plus' } },
  { q: 'K1 Max', lang: 'en', expect: { text: 'K1 Max' } },
  { q: 'Creality K2 Plus', lang: 'en', expect: { text: 'Creality K2 Plus' } },
  { q: '3+ colors', lang: 'en', expect: { text: '3+ colors' } },
  { q: 'Kobra 3 Max under 900 الف', lang: 'en', expect: { price: [null, 900_000], text: 'Kobra 3 Max' } },
  { q: '30k max', lang: 'en', expect: { price: [null, 30_000], text: '' } },
  { q: 'P1S 500k+', lang: 'en', expect: { price: [500_000, null], text: 'P1S' } },
  { q: 'نوزل ٠.٤', lang: 'ar', expect: { text: 'نوزل ٠.٤' } },
  { q: 'نوزل 1.75', lang: 'ar', expect: { text: 'نوزل 1.75' } },
  { q: 'مغناطيس 6×2', lang: 'ar', expect: { text: 'مغناطيس 6×2' } },
  { q: 'طابعة ريزن 8K', lang: 'ar', expect: { text: 'طابعة ريزن 8K', materials: ['resin'] } },
  { q: 'اكس ون سي', lang: 'ar', expect: { text: 'اكس ون سي' } },
  { q: 'طابعة 3 max', lang: 'ar', expect: { text: 'طابعة 3 max' } },
  { q: '500 الف plus', lang: 'ar', expect: { price: [500_000, null], text: '' } },
  { q: 'طابعة 500 الف وفوق', lang: 'ar', expect: { price: [500_000, null], text: 'طابعة' } },

  // ======================================================================
  // NUMBER WORDS AND DOLLARS
  // ======================================================================
  { q: 'طابعة بمليون ونص', lang: 'ar', expect: { price: [null, 1_500_000], text: 'طابعة' } },
  { q: 'نص مليون', lang: 'ar', expect: { price: [null, 500_000], text: '' } },
  { q: 'ربع مليون', lang: 'ar', expect: { price: [null, 250_000], text: '' } },
  { q: 'مليونين', lang: 'ar', expect: { price: [null, 2_000_000], text: '' } },
  { q: 'مليون و 250', lang: 'ar', expect: { price: [null, 1_250_000], text: '' } },
  { q: 'خمسة وعشرين الف', lang: 'ar', expect: { price: [null, 25_000], text: '' } },
  { q: 'ب 500 الف', lang: 'ar', expect: { price: [null, 500_000], text: '' } },
  { q: 'اكثر من مليون', lang: 'ar', expect: { price: [1_000_000, null], text: '' } },
  { q: 'مو اكثر من مليون', lang: 'ar', expect: { price: [null, 1_000_000], text: '' } },
  { q: 'طابعة دون مليون', lang: 'ar', expect: { price: [null, 1_000_000], text: 'طابعة' } },
  { q: 'اقل من 5 ورقات', lang: 'ar', expect: { price: [null, 500], usd: true, text: '' } },
  { q: 'اقل من 700 دولار', lang: 'ar', expect: { price: [null, 700], usd: true, text: '' } },
  { q: 'ميزانية مليونين، ABS', lang: 'ar', expect: { price: [null, 2_000_000], text: 'ABS', materials: ['abs'] } },
  { q: 'half a million', lang: 'en', expect: { price: [null, 500_000], text: '' } },
  { q: 'under $500', lang: 'en', expect: { price: [null, 500], usd: true, text: '' } },
  { q: 'filament black under $20', lang: 'en', expect: { price: [null, 20], usd: true, text: 'filament', colours: ['black'], drop: { price: 'filament black', 'color:black': 'filament under $20' } } },
  { q: 'نیو ملیۆن', lang: 'ckb', expect: { price: [null, 500_000], text: '' } },
  // A lower bound in the words people use for it, never read as the upper one.
  { q: 'لا يقل عن 20 الف', lang: 'ar', expect: { price: [20_000, null], text: '' } },
  { q: 'حد ادنى 20 الف', lang: 'ar', expect: { price: [20_000, null], text: '' } },
  { q: 'بالحد الادنى 20 الف', lang: 'ar', expect: { price: [20_000, null], text: '' } },
  { q: 'اقل شي 20 الف', lang: 'ar', expect: { price: [20_000, null], text: '' } },
  { q: 'لانی کەم 20 هەزار', lang: 'ckb', expect: { price: [20_000, null], text: '' } },
  { q: 'کەمترین 20 هەزار', lang: 'ckb', expect: { price: [20_000, null], text: '' } },
  { q: 'سەروو 500 هەزار', lang: 'ckb', expect: { price: [500_000, null], text: '' } },
  // A Sorani bound written last and negated: «not more than» is an upper bound, «not less than» a lower one.
  { q: 'لە 30 هەزار زیاتر نەبێت', lang: 'ckb', expect: { price: [null, 30_000], text: '' } },
  { q: 'نرخی لە 30 هەزار زیاتر نەبێت', lang: 'ckb', expect: { price: [null, 30_000], text: '' } },
  { q: 'لە 30 هەزار کەمتر نەبێت', lang: 'ckb', expect: { price: [30_000, null], text: '' } },
  { q: 'هەرزانتر لە 20 هەزار', lang: 'ckb', expect: { price: [null, 20_000], text: '' } },
  // The Sorani indefinite money word: «ملیۆنێک» a million, «نیوێک» a half.
  { q: 'کەمتر لە ملیۆنێک', lang: 'ckb', expect: { price: [null, 1_000_000], text: '' } },
  { q: 'زیاتر لە ملیۆنێک', lang: 'ckb', expect: { price: [1_000_000, null], text: '' } },
  { q: 'کەمتر لە ملیۆن و نیوێک', lang: 'ckb', expect: { price: [null, 1_500_000], text: '' } },
  // The Arabic article on the amount after a bound: «تحت المليون» is under a million.
  { q: 'طابعة تحت المليون', lang: 'ar', expect: { price: [null, 1_000_000], text: 'طابعة' } },
  { q: 'اقل من المليون', lang: 'ar', expect: { price: [null, 1_000_000], text: '' } },
  { q: 'اكثر من المليون', lang: 'ar', expect: { price: [1_000_000, null], text: '' } },
  { q: 'تحت الالف', lang: 'ar', expect: { price: [null, 1_000], text: '' } },
  { q: 'تحت ال30', lang: 'ar', expect: { price: [null, 30_000], text: '' } },
  { q: 'تحت ال 500', lang: 'ar', expect: { price: [null, 500_000], text: '' } },
  { q: 'اقل من ال500 الف', lang: 'ar', expect: { price: [null, 500_000], text: '' } },
  { q: 'اقل من ال 30 الف', lang: 'ar', expect: { price: [null, 30_000], text: '' } },

  // ======================================================================
  // EVERYTHING TOGETHER — diameter, sort, sale, colour, exclusion, price
  // ======================================================================
  { q: 'PLA 1.75', lang: 'en', expect: { text: 'PLA', materials: ['pla'], diameters: ['1.75'], contract: false } },
  { q: 'PETG ٢٫٨٥', lang: 'en', expect: { text: 'PETG', materials: ['petg'], diameters: ['2.85'], contract: false } },
  { q: 'PLA 1.75 under 25k', lang: 'en', expect: { price: [null, 25_000], text: 'PLA', materials: ['pla'], diameters: ['1.75'], contract: false } },
  { q: 'filament 1.75 under 25k', lang: 'en', expect: { price: [null, 25_000], text: 'filament', diameters: ['1.75'] } },
  { q: 'cheapest printer', lang: 'en', expect: { text: 'printer', sort: 'price_asc' } },
  { q: 'PLA white in stock under 30k', lang: 'en', expect: { price: [null, 30_000], text: 'PLA', colours: ['white'], materials: ['pla'], sale: 'direct' } },
  { q: 'printer under 30k without AMS', lang: 'en', expect: { price: [null, 30_000], text: 'printer', ex: ['ams'] } },
  { q: 'printer without AMS cheapest', lang: 'en', expect: { text: 'printer', ex: ['ams'], sort: 'price_asc' } },
  { q: 'فلامنت 2.85', lang: 'ar', expect: { text: 'فلامنت', diameters: ['2.85'] } },
  { q: 'فلامنت 1.75 اقل من 25 الف', lang: 'ar', expect: { price: [null, 25_000], text: 'فلامنت', diameters: ['1.75'] } },
  { q: 'طابعة رخيصة', lang: 'ar', expect: { text: 'طابعة', sort: 'price_asc' } },
  { q: 'PLA اسود و رخيص', lang: 'ar', expect: { text: 'PLA', colours: ['black'], materials: ['pla'], sort: 'price_asc', drop: { sort: 'PLA اسود' } } },
  { q: 'PLA ابيض متوفر اقل من 30 الف', lang: 'ar', expect: { price: [null, 30_000], text: 'PLA', colours: ['white'], materials: ['pla'], sale: 'direct' } },
  { q: 'PLA اسود بدون AMS متوفر', lang: 'ar', expect: { text: 'PLA', colours: ['black'], materials: ['pla'], ex: ['ams'], sale: 'direct' } },
  { q: 'طابعة اقل من 500 دولار بدون AMS', lang: 'ar', expect: { price: [null, 500], usd: true, text: 'طابعة', ex: ['ams'] } },
  { q: 'فلامنت بدون بكرة رخيص', lang: 'ar', expect: { text: 'فلامنت', spool: 'refill', sort: 'price_asc' } },
  { q: 'چاپکەری هەرزان', lang: 'ckb', expect: { text: 'چاپکەری', sort: 'price_asc' } },
  { q: 'چاپکەر بێ AMS هەرزان', lang: 'ckb', expect: { text: 'چاپکەر', ex: ['ams'], sort: 'price_asc' } },
  { q: 'PLA سپی بەردەستە کەمتر لە 30 هەزار', lang: 'ckb', expect: { price: [null, 30_000], text: 'PLA', colours: ['white'], materials: ['pla'], sale: 'direct' } },
  { q: 'چاپکەر بێ AMS و ڕەش', lang: 'ckb', expect: { text: 'چاپکەر', ex: ['ams'], colours: ['black'] } },
  { q: 'فیلامێنت 1.75 ڕەش', lang: 'ckb', expect: { text: 'فیلامێنت', colours: ['black'], diameters: ['1.75'] } },
  // A diameter before a Sorani bound is the diameter; the price is what follows «لە».
  { q: 'فیلامێنت 1.75 کەمتر لە 25 هەزار', lang: 'ckb', expect: { price: [null, 25_000], text: 'فیلامێنت', diameters: ['1.75'] } },
  { q: 'فیلامێنت 1.75 کەمتر لە 25', lang: 'ckb', expect: { price: [null, 25_000], text: 'فیلامێنت', diameters: ['1.75'] } },
  { q: 'فیلامێنت ڕەش 1.75 کەمتر لە 25 هەزار', lang: 'ckb', expect: { price: [null, 25_000], text: 'فیلامێنت', colours: ['black'], diameters: ['1.75'] } },
  { q: 'فیلامێنت 1.75 زیاتر لە 20 هەزار', lang: 'ckb', expect: { price: [20_000, null], text: 'فیلامێنت', diameters: ['1.75'] } },
  { q: 'PLA 1.75 کەمتر لە 25 هەزار', lang: 'ckb', expect: { price: [null, 25_000], text: 'PLA', materials: ['pla'], diameters: ['1.75'], contract: false } },
];

// ------------------------------------------------------------------ the check

/** The chip keys a row's constraints make, as nlChipKey writes them. */
function chipsOf(e: Expect): string[] {
  const keys: string[] = [];
  if (e.price) keys.push('price');
  if (e.sale) keys.push('sale');
  if (e.spool) keys.push('spool');
  if (e.sort) keys.push('sort');
  for (const d of e.diameters ?? []) keys.push(`diameter:${d}`);
  for (const c of e.colours ?? []) keys.push(`color:${c}`);
  for (const c of e.exC ?? []) keys.push(`color!:${c}`);
  for (const m of e.materials ?? []) keys.push(`material:${m}`);
  for (const m of e.exM ?? []) keys.push(`material!:${m}`);
  for (const w of e.ex ?? []) keys.push(`exclude:${w}`);
  return keys.sort();
}

function check(row: Row): void {
  const { q, expect: e } = row;
  const at = `«${q}» (${row.lang})`;
  const nl = parseNlQuery(q);
  const exclusionsOpen = e.exHas !== undefined || e.notEx !== undefined;

  const price = e.price ? { min: e.price[0], max: e.price[1], currency: e.usd ? 'USD' : 'IQD' } : null;
  assert.deepEqual(nl.price, price, `${at}: price`);
  if (e.text !== undefined) assert.equal(nl.text, e.text, `${at}: search text`);
  for (const w of e.textHas ?? []) assert.ok(nl.text.includes(w), `${at}: the search keeps «${w}» (${JSON.stringify(nl.text)})`);
  assert.deepEqual(nl.colours, e.colours ?? [], `${at}: colours`);
  assert.deepEqual(nl.materials, e.materials ?? [], `${at}: materials`);
  assert.deepEqual(nl.diameters, e.diameters ?? [], `${at}: diameters`);
  assert.equal(nl.sale, e.sale ?? null, `${at}: sale`);
  assert.equal(nl.spool, e.spool ?? null, `${at}: spool`);
  assert.equal(nl.sort, e.sort ?? null, `${at}: sort`);
  assert.deepEqual(nl.exclude.colours, e.exC ?? [], `${at}: excluded colours`);
  assert.deepEqual(nl.exclude.materials, e.exM ?? [], `${at}: excluded materials`);
  if (exclusionsOpen) {
    for (const w of e.exHas ?? []) assert.ok(nl.exclude.words.includes(nlFold(w)), `${at}: «${w}» is left out (${JSON.stringify(nl.exclude.words)})`);
    for (const w of e.notEx ?? []) {
      assert.ok(!nl.exclude.words.includes(nlFold(w)), `${at}: the function word «${w}» is never excluded (${JSON.stringify(nl.exclude.words)})`);
    }
  } else {
    assert.deepEqual(nl.exclude.words, e.ex ?? [], `${at}: excluded words`);
  }

  // The chips: exactly the constraints above (the exclusion words as far as the row fixes them).
  const got = nl.understood.map(nlChipKey);
  const want = chipsOf(e);
  if (exclusionsOpen) {
    assert.deepEqual(got.filter((k) => !k.startsWith('exclude:')).sort(), want, `${at}: chips`);
  } else {
    assert.deepEqual([...got].sort(), want, `${at}: chips`);
  }

  for (const [key, text] of Object.entries(e.drop ?? {})) assert.equal(nl.without[key], text, `${at}: the removal text of ${key}`);

  // (d) Each chip's removal text, read again, is the same answer less exactly that chip.
  if (e.contract !== false) {
    for (const chip of nl.understood) {
      const key = nlChipKey(chip);
      const rest = nl.without[key];
      assert.equal(typeof rest, 'string', `${at}: ${key} has a removal text`);
      const again = parseNlQuery(rest).understood;
      const less: NlChip[] = nl.understood.filter((c) => nlChipKey(c) !== key);
      assert.deepEqual(again, less, `${at}: less ${key} is «${rest}», read again ${JSON.stringify(again.map(nlChipKey))}`);
    }
  }
}

test('the corpus: one row per query, every language, at least 150 rows', () => {
  const seen = new Set<string>();
  for (const r of ROWS) {
    assert.ok(!seen.has(r.q), `«${r.q}» is in the corpus twice`);
    seen.add(r.q);
  }
  assert.ok(ROWS.length >= 150, `${ROWS.length} rows`);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(ROWS.filter((r) => r.lang === lang).length >= 40, `${lang}: rows`);
});

ROWS.forEach((row, i) => {
  test(`golden ${String(i + 1).padStart(3, '0')} ${row.lang} «${row.q}»`, () => check(row));
});
