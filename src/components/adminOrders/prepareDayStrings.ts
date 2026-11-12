/**
 * THE WORDS OF THE DAY TO PREPARE (DECISIONS row 322) — the row's day chip,
 * its «متأخر», the board's note under its header and the order window's line.
 *
 * The board files each order on the day it must be packed and handed to the
 * courier at 7 pm — a day before the customer's own day, the same day for the
 * store's same-day methods — so the row says WHICH day it is naming:
 * «التوصيل: غدًا» is the customer's day, and «التجهيز: …» the day to pack
 * it, where the two differ.
 *
 * «متأخر» SAYS WHICH LATENESS IT IS, IN WORDS (the review, 2026-11-12): a
 * tooltip cannot be opened on a phone, so a parcel with the courier — or booked
 * with the delivery company, which the owner counts as handed over — carries a
 * short visible reason («متأخر · مع المندوب»), and every reason's full
 * sentence is the mark's title and its screen-reader text.
 *
 * NO-BREAK SPACES, ON PURPOSE (`\u00a0`): between a label and its day
 * («التوصيل: غدًا» never splits into «التوصيل:» over «غدًا» inside its pill on
 * a 320 px phone) and inside the hand-over time («٧ مساءً», "7 pm").
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
  delivery: { ar: 'التوصيل:\u00a0{day}', en: 'Delivery:\u00a0{day}', ckb: 'گەیاندن:\u00a0{day}' },
  /**
   * The day to pack it and hand it to the courier, where it is not the
   * delivery day. A date's label, not an instruction: not the row's «تجهيز» /
   * "Prepare" button's word in English, nor its «ئامادەکردن» in Sorani.
   */
  prepare: { ar: 'التجهيز:\u00a0{day}', en: 'Prepare on:\u00a0{day}', ckb: 'ڕۆژی ئامادەکردن:\u00a0{day}' },
  /** One muted line under the board's header (the live board's day groups only). */
  boardNote: {
    ar: 'تظهر الطلبات في يوم تجهيزها وتسليمها للمندوب (الساعة\u00a0٧\u00a0مساءً)، لا في يوم وصولها للزبون؛ والطرد الذي صار مع المندوب يظهر في يوم وصوله.',
    en: 'Orders show on the day they must be packed and handed to the courier (7\u00a0pm), not the day they reach the customer; a parcel already with the courier shows on its delivery day.',
    ckb: 'داواکارییەکان لە ڕۆژی ئامادەکردن و ڕادەستکردنیان بە گەیەنەر (کاتژمێر\u00a0٧ی\u00a0ئێوارە) دەردەکەون، نەک لە ڕۆژی گەیشتنیان بە کڕیار؛ ئەو پاکەتەی لای گەیەنەرە لە ڕۆژی گەیاندنی دەردەکەوێت.',
  },
  /** The one red word: the row's day to pack, or to deliver, is before today. */
  late: { ar: 'متأخر', en: 'Overdue', ckb: 'دواکەوتوو' },
  /** «متأخر» on a box still on our shelf: its day to pack and hand over has passed. */
  overduePrepare: {
    ar: 'فات يوم تجهيزه وتسليمه للمندوب',
    en: 'Its day to pack and hand to the courier has passed',
    ckb: 'ڕۆژی ئامادەکردن و ڕادەستکردنی بە گەیەنەر تێپەڕیوە',
  },
  /** «متأخر» on a parcel with the courier, or booked with it (the owner: a booking is the hand-over): its delivery day has passed. */
  overdueCourier: {
    ar: 'تجاوز يوم توصيله وهو مع المندوب',
    en: 'Past its delivery day and still with the courier',
    ckb: 'ڕۆژی گەیاندنی تێپەڕیوە و هێشتا لای گەیەنەرە',
  },
  /**
   * The visible reason after «متأخر ·» for a parcel with the courier — one
   * unbreakable phrase, so a narrow row breaks after the «·», never inside it.
   */
  lateCourier: { ar: 'مع\u00a0المندوب', en: 'with\u00a0the\u00a0courier', ckb: 'لای\u00a0گەیەنەر' },
} satisfies Record<string, Tri>;

/** The reader's sentence through the screen's own `loc`, with the server's day label in it. */
export function dayLine(loc: (ar: string, en: string, ckb?: string) => string, entry: Tri, day = ''): string {
  // A function, so a `$` in a label is never read as a replacement pattern.
  return loc(entry.ar, entry.en, entry.ckb).replace('{day}', () => day);
}
