/**
 * THE WORDS OF THE DAY TO PREPARE (DECISIONS row 322) — the row's day chip,
 * the board's note under its header and the order window's line.
 *
 * The board files each order on the day it must be packed and handed to the
 * courier at 7 pm — a day before the customer's own day, the same day for the
 * store's same-day methods — so the row says WHICH day it is naming:
 * «التوصيل: غدًا» is the customer's day, and «التجهيز: …» the day to pack
 * it, where the two differ.
 *
 * ONE TYPED TABLE, so a sentence missing a language does not compile; the
 * `ckb` slot is its own Sorani, never the Arabic pasted across (DECISIONS row
 * 183), and tests/orderPrepareDayUi.test.ts holds every entry to that.
 * `{day}` is a label the SERVER wrote (`due_label`, `prepare_label`), already
 * in the reader's language and digits; `dayLine` puts it in. Pure data.
 */
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export const PREPARE_DAY_STRINGS = {
  /** The row's day chip and the order window: the customer's delivery day. */
  delivery: { ar: 'التوصيل: {day}', en: 'Delivery: {day}', ckb: 'گەیاندن: {day}' },
  /** The day to pack it and hand it to the courier, where it is not the delivery day. */
  prepare: { ar: 'التجهيز: {day}', en: 'Prepare: {day}', ckb: 'ئامادەکردن: {day}' },
  /** One muted line under the board's header (the live board only). */
  boardNote: {
    ar: 'تظهر الطلبات في يوم تجهيزها وتسليمها للمندوب (الساعة ٧ مساءً)، لا في يوم وصولها للزبون.',
    en: 'Orders show on the day they must be packed and handed to the courier (7 pm), not the day they reach the customer.',
    ckb: 'داواکارییەکان لە ڕۆژی ئامادەکردن و ڕادەستکردنیان بە گەیەنەر (کاتژمێر ٧ی ئێوارە) دەردەکەون، نەک لە ڕۆژی گەیشتنیان بە کڕیار.',
  },
  /** «متأخر» on a box still on our shelf: its day to pack and hand over has passed. */
  overduePrepare: {
    ar: 'فات يوم تجهيزه وتسليمه للمندوب',
    en: 'Its day to pack and hand to the courier has passed',
    ckb: 'ڕۆژی ئامادەکردن و ڕادەستکردنی بە گەیەنەر تێپەڕیوە',
  },
  /** «متأخر» on a parcel already with the courier: its delivery day has passed. */
  overdueCourier: {
    ar: 'تجاوز يوم توصيله وهو مع المندوب',
    en: 'Past its delivery day and still with the courier',
    ckb: 'ڕۆژی گەیاندنی تێپەڕیوە و هێشتا لای گەیەنەرە',
  },
} satisfies Record<string, Tri>;

/** The reader's sentence through the screen's own `loc`, with the server's day label in it. */
export function dayLine(loc: (ar: string, en: string, ckb?: string) => string, entry: Tri, day = ''): string {
  // A function, so a `$` in a label is never read as a replacement pattern.
  return loc(entry.ar, entry.en, entry.ckb).replace('{day}', () => day);
}
