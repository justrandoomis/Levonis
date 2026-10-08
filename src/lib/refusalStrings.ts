/**
 * EVERY CUSTOMER-FACING REFUSAL CODE, IN ALL THREE LANGUAGES
 * (docs/BUNDLES_MYSTERY.md §15.3).
 *
 * WHY THIS FILE EXISTS. `HttpError` carries ONE untranslated sentence
 * (`worker/lib/http.ts`), the cart renders `err.message` verbatim, and the
 * product page maps a code through `reasonText`, whose fallback is
 * `map[code] || code` — so a code nobody translated is printed to an Iraqi
 * customer as the literal string `BUNDLE_OPTIONAL_UNAVAILABLE`. That is not a
 * hypothetical: it is what the existing decoders do today with anything new.
 *
 * `tests/refusalStrings.test.ts` walks the contract's own table and fails if
 * any customer-facing code lacks an `ar`, an `en` AND a `ckb` string, so the
 * table in the contract and the strings in the app cannot drift apart.
 *
 * The sentences say what the customer can DO about it wherever there is
 * something to do — un-tick the optional part, choose again, come back when the
 * offer opens — because a refusal that only states a fact leaves them stuck on
 * the screen it appeared on.
 *
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183); the test walks the whole table for copies.
 *
 * The pricing programme's refusals (owner decision 2: cost is the owner's
 * alone; the engine, batch and profit codes after it) live in their own
 * contract, `packages/contracts/src/costRefusals.ts`, so the server's
 * `serverMessage(code)` and this table read the very same three sentences.
 * It is spread in at the end of the table.
 */
import { COST_REFUSALS } from '../../packages/contracts/src/costRefusals';

export interface RefusalStrings {
  ar: string;
  en: string;
  ckb: string;
}

export const REFUSAL_STRINGS: Record<string, RefusalStrings> = {
  // ---- PRO Buy Now, Pay Later --------------------------------------------
  PRO_REQUIRED: {
    ar: 'الدفع لاحقًا متاح حصريًا لعضوية PRO الفعّالة.',
    en: 'Buy Now, Pay Later is available exclusively with an active PRO membership.',
    ckb: 'ئێستا بکڕە و دواتر بدە تەنها بۆ ئەندامێتی چالاکی PRO بەردەستە.',
  },
  BNPL_RESTRICTED: {
    ar: 'ميزة الدفع لاحقًا موقوفة مؤقتًا على هذا الحساب. تواصل مع الدعم لمراجعتها.',
    en: 'Buy Now, Pay Later is temporarily paused on this account. Contact support for a review.',
    ckb: 'خزمەتی ئێستا بکڕە و دواتر بدە بۆ ئەم هەژمارە کاتی ڕاگیراوە. بۆ پێداچوونەوە پەیوەندی بە پشتگیری بکە.',
  },
  BNPL_DISABLED: {
    ar: 'خدمة الدفع لاحقًا غير متاحة حاليًا.',
    en: 'Buy Now, Pay Later is currently unavailable.',
    ckb: 'خزمەتی ئێستا بکڕە و دواتر بدە لە ئێستادا بەردەست نییە.',
  },
  BNPL_NOT_APPROVED: {
    ar: 'يجب اعتماد حد الدفع لاحقًا لحسابك قبل استخدامه.',
    en: 'Your Buy Now, Pay Later limit must be approved before you can use it.',
    ckb: 'پێویستە سنووری ئێستا بکڕە و دواتر بدە بۆ هەژمارەکەت پەسەند بکرێت پێش بەکارهێنان.',
  },
  IDENTITY_VERIFICATION_REQUIRED: {
    ar: 'أكمل توثيق الهوية أولًا لاستخدام الدفع لاحقًا.',
    en: 'Complete identity verification before using Buy Now, Pay Later.',
    ckb: 'پێش بەکارهێنانی ئێستا بکڕە و دواتر بدە، پشتڕاستکردنەوەی ناسنامە تەواو بکە.',
  },
  APPROVED_ADDRESS_REQUIRED: {
    ar: 'اختر عنوانك الافتراضي المعتمد لاستخدام الدفع لاحقًا.',
    en: 'Use your approved default address for Buy Now, Pay Later.',
    ckb: 'بۆ ئێستا بکڕە و دواتر بدە، ناونیشانی بنەڕەتی پەسەندکراوت بەکاربهێنە.',
  },
  BNPL_AMOUNT_TOO_LOW: {
    ar: 'قيمة الطلب أقل من الحد الأدنى المعتمد للدفع لاحقًا.',
    en: 'The order total is below the approved minimum for Buy Now, Pay Later.',
    ckb: 'کۆی داواکارییەکە لە کەمترین سنووری پەسەندکراو بۆ ئێستا بکڕە و دواتر بدە کەمترە.',
  },
  BNPL_AMOUNT_TOO_HIGH: {
    ar: 'قيمة الطلب أعلى من الحد المعتمد للدفع لاحقًا.',
    en: 'The order total is above the approved Buy Now, Pay Later maximum.',
    ckb: 'کۆی داواکارییەکە لە زۆرترین سنووری پەسەندکراو بۆ ئێستا بکڕە و دواتر بدە زیاترە.',
  },
  BNPL_LIMIT_EXCEEDED: {
    ar: 'المبلغ يتجاوز الرصيد المتاح من حد الدفع لاحقًا.',
    en: 'The amount exceeds your available Buy Now, Pay Later limit.',
    ckb: 'بڕەکە لە سنووری بەردەستی ئێستا بکڕە و دواتر بدە زیاترە.',
  },
  BNPL_NOT_ELIGIBLE: {
    ar: 'هذا الطلب غير مؤهل للدفع لاحقًا. راجع العنوان والمبلغ ثم أعد المحاولة.',
    en: 'This order is not eligible for Buy Now, Pay Later. Review the address and amount, then try again.',
    ckb: 'ئەم داواکارییە بۆ ئێستا بکڕە و دواتر بدە گونجاو نییە. ناونیشان و بڕەکە بپشکنەوە و دووبارە هەوڵ بدە.',
  },
  BNPL_REPAYMENT_EXCEEDS_DEBT: {
    ar: 'مبلغ السداد أكبر من الرصيد المستحق. حدّث البيانات واختر مبلغًا أقل.',
    en: 'The repayment is larger than the outstanding balance. Refresh and choose a smaller amount.',
    ckb: 'بڕی دانەوە لە قەرزی ماوە زیاترە. زانیارییەکان نوێ بکەرەوە و بڕێکی کەمتر هەڵبژێرە.',
  },
  BNPL_REPAYMENT_CONFLICT: {
    ar: 'تغيّر رصيد المحفظة أو الدين. حدّث البيانات ثم أعد السداد.',
    en: 'Your wallet or debt balance changed. Refresh and submit the repayment again.',
    ckb: 'باڵانسی جزدان یان قەرزەکە گۆڕاوە. زانیارییەکان نوێ بکەرەوە و دووبارە دانەوە بنێرە.',
  },

  // ---- eligibility and scheduling (§9) ------------------------------------
  MEMBERSHIP_REQUIRED: {
    ar: 'هذا العرض للأعضاء فقط. اشترك للوصول إليه.',
    en: 'This offer is for members only. Subscribe to unlock it.',
    ckb: 'ئەم ئۆفەرە تەنها بۆ ئەندامانە. بەشداری بکە بۆ کردنەوەی.',
  },
  OFFER_INACTIVE: {
    ar: 'هذا العرض غير متاح حاليًا.',
    en: 'This offer is not available right now.',
    ckb: 'ئەم ئۆفەرە ئێستا بەردەست نییە.',
  },
  OFFER_WINDOW_NOT_STARTED: {
    ar: 'لم يبدأ هذا العرض بعد.',
    en: 'This offer has not started yet.',
    ckb: 'ئەم ئۆفەرە هێشتا دەستی پێنەکردووە.',
  },
  OFFER_WINDOW_EXPIRED: {
    ar: 'انتهى هذا العرض.',
    en: 'This offer has ended.',
    ckb: 'ئەم ئۆفەرە کۆتایی هات.',
  },
  PER_USER_LIMIT_REACHED: {
    ar: 'لقد استخدمت هذا العرض بالحد الأقصى المسموح لك.',
    en: 'You have already used this offer the maximum number of times.',
    ckb: 'تۆ ئەم ئۆفەرەت بە زۆرترین ژمارەی ڕێپێدراو بەکارهێناوە.',
  },
  GLOBAL_LIMIT_REACHED: {
    ar: 'وصل هذا العرض إلى حده الأقصى.',
    en: 'This offer has reached its limit.',
    ckb: 'ئەم ئۆفەرە گەیشتە سنووری خۆی.',
  },

  // ---- composition (§15.3) -----------------------------------------------
  BUNDLE_QTY_LIMIT: {
    ar: 'تجاوزت الحد الأقصى لعدد هذه الحزمة في الطلب الواحد.',
    en: 'That is more of this bundle than one order may hold.',
    ckb: 'لە ژمارەی ڕێپێدراوی ئەم پاکێجە زیاترە بۆ یەک داواکاری.',
  },
  BUNDLE_CHOICE_INVALID: {
    ar: 'أحد اختياراتك لم يعد متاحًا — افتح الحزمة واختر من جديد.',
    en: 'One of your choices is no longer offered — reopen the bundle and choose again.',
    ckb: 'یەکێک لە هەڵبژاردەکانت چیتر بەردەست نییە — پاکێجەکە بکەرەوە و دیسان هەڵبژێرە.',
  },
  BUNDLE_CHOICE_NOT_ALLOWED: {
    ar: 'هذا الجزء محدَّد مسبقًا في الحزمة ولا يمكن تغييره.',
    en: 'That part is fixed by the bundle and cannot be changed.',
    ckb: 'ئەم بەشە لەلایەن پاکێجەکەوە دیاریکراوە و ناگۆڕدرێت.',
  },
  BUNDLE_COMPOSITION_CHANGED: {
    ar: 'تغيّرت محتويات هذه الحزمة — افتحها واختر من جديد.',
    en: 'This bundle’s contents changed — reopen it and choose again.',
    ckb: 'ناوەڕۆکی ئەم پاکێجە گۆڕا — بیکەرەوە و دیسان هەڵبژێرە.',
  },
  BUNDLE_OPTIONAL_UNAVAILABLE: {
    ar: 'القطعة الاختيارية التي أضفتها غير متوفرة — أزلها ثم أعد المحاولة.',
    en: 'The optional item you added is not available — remove it and try again.',
    ckb: 'ئەو پارچە ئارەزوومەندانەیەی زیادت کرد بەردەست نییە — لایبە و دووبارە هەوڵ بدە.',
  },
  BUNDLE_SHIPPING_MIXED: {
    ar: 'قطع هذه الحزمة لا تشترك في طريقة شحن واحدة.',
    en: 'The items in this bundle do not share one shipping method.',
    ckb: 'پارچەکانی ئەم پاکێجە یەک شێوازی گەیاندنیان نییە.',
  },
  // The checkout key. Globally unique before migration 0064, per-user after
  // it: a key another account had spent used to fail this account's checkout
  // with an untranslatable "please try again" it could never escape.
  IDEMPOTENCY_KEY_REUSED: {
    ar: 'انتهت صلاحية جلسة الدفع هذه. ارجع إلى السلة وابدأ الدفع من جديد.',
    en: 'This checkout session has expired. Go back to the cart and start the checkout again.',
    ckb: 'ئەم دانیشتنی پارەدانە بەسەرچووە. بگەڕێوە بۆ سەبەتەکە و پارەدان لە سەرەتاوە دەست پێ بکەوە.',
  },
  // The refusal is COMMERCIAL only (owner decision 3): a change of mind about
  // one part of a bundle is refused, a faulty part is not — so the sentence
  // has to say both, or a customer with a broken spool reads "no" and stops.
  BUNDLE_PARTIAL_RETURN_NOT_ALLOWED: {
    ar: 'يمكن إرجاع الحزمة كاملة فقط. أمّا القطعة المعطوبة فيمكن المطالبة بها وحدها.',
    en: 'A bundle can only be returned whole. A faulty part can be claimed on its own.',
    ckb: 'پاکێج تەنها بە تەواوی دەگەڕێتەوە. بەڵام پارچەی تێکچووی دەکرێت بە تەنها داوا بکرێت.',
  },
  BUNDLE_COMPONENT_ALREADY_CLAIMED: {
    ar: 'إحدى قطع هذه الحزمة عليها طلب مفتوح — أكمِله أولًا ثم أعد المحاولة.',
    en: 'One part of this bundle already has an open case — finish that one first, then try again.',
    ckb: 'یەکێک لە پارچەکانی ئەم پاکێجە داواکاریەکی کراوەی هەیە — سەرەتا ئەوە تەواو بکە.',
  },
  COMPOSITION_TOO_LARGE: {
    ar: 'هذا الطلب يحتوي على قطع أكثر مما يمكن معالجته — قسّمه إلى طلبين.',
    en: 'This order holds more individual items than one order may carry — please split it in two.',
    ckb: 'ئەم داواکارییە پارچەی زیاتری تێدایە لەوەی دەکرێت — تکایە بیکە بە دوو داواکاری.',
  },
  COMPOSITION_NOT_ELIGIBLE: {
    ar: 'الحزمة نفسها غير مشمولة بحماية السعر — قطعها مشمولة كلٌّ على حدة.',
    en: 'A bundle is not price-protected as a whole — its parts are covered individually.',
    ckb: 'پاکێج بە تەواوی پارێزراو نییە لە نرخدا — پارچەکانی بە جیا پارێزراون.',
  },

  // ---- the mystery offer (§15.3) -----------------------------------------
  MYSTERY_NO_ELIGIBLE_STOCK: {
    ar: 'لا يوجد مخزون متاح لهذا العرض الآن.',
    en: 'There is no eligible stock for this offer right now.',
    ckb: 'ئێستا هیچ کۆگایەکی گونجاو بۆ ئەم ئۆفەرە نییە.',
  },
  MYSTERY_NOT_ENOUGH_VARIETY: {
    ar: 'لا يمكن تجهيز هذا العدد بخيارات مختلفة الآن — جرّب عددًا أقل.',
    en: 'That many different choices cannot be filled right now — try a smaller quantity.',
    ckb: 'ئەو هەموو هەڵبژاردە جیاوازە ئێستا ناکرێت — ژمارەیەکی کەمتر تاقی بکەرەوە.',
  },
  MYSTERY_MODE_NOT_AVAILABLE: {
    ar: 'طريقة الشراء المطلوبة غير متاحة لهذا العرض.',
    en: 'That way of buying is not available for this offer.',
    ckb: 'ئەو شێوازی کڕینە بۆ ئەم ئۆفەرە بەردەست نییە.',
  },
  MYSTERY_NOT_REVEALED: {
    ar: 'لم يُكشف محتوى هذا العرض بعد.',
    en: 'What you received has not been revealed yet.',
    ckb: 'ئەوەی وەرتگرتووە هێشتا ئاشکرا نەکراوە.',
  },
  MYSTERY_REVEALED_NO_CANCEL: {
    ar: 'لا يمكن إلغاء طلب ظهر محتواه — تواصل مع الدعم.',
    en: 'An order whose contents have been revealed cannot be cancelled — contact support.',
    ckb: 'داواکارییەک کە ناوەڕۆکی ئاشکرا بووە هەڵناوەشێتەوە — پەیوەندی بە پشتگیری بکە.',
  },

  /**
   * SOLD OUT, IN THE CUSTOMER'S OWN LANGUAGE.
   *
   * «يجب التاكد بان المخزون يتحدث ويعطيه اشعارا بان المتبقي فقط 2.»
   *
   * This code was deliberately absent from this table, on the premise stated
   * at the bottom of this file: a reused code "already has a sentence
   * elsewhere". For OUT_OF_STOCK that premise was FALSE in Arabic — the
   * server's sentence is English with the product name interpolated into it
   * (`Only 2 of "بي إل إيه" left in stock`), so an Arabic customer racing
   * another buyer for the last unit read English at the moment they lost.
   *
   * THIS ENTRY IS THE COUNT-FREE ONE. When the server sends a remainder,
   * `stockRefusal` below builds the counted sentence instead; this is what a
   * mystery-pool member gets, where naming the count would be an oracle on the
   * draw (docs/BUNDLES_MYSTERY.md §8.2 row 18), and what any caller with no
   * details to read gets.
   */
  OUT_OF_STOCK: {
    ar: 'الكمية المتاحة لا تكفي لهذا الطلب. قلّل الكمية أو أزل المنتج من السلة.',
    en: 'There is not enough stock for this order. Lower the quantity or remove the item.',
    ckb: 'بڕی بەردەست بۆ ئەم داواکارییە بەس نییە. بڕەکە کەم بکەرەوە یان بەرهەمەکە لاببە.',
  },

  /**
   * THE SAME RACE, ONE SCREEN EARLIER — THE DOOR INTO THE CART.
   *
   * `OUT_OF_STOCK` is "there are none"; this is "there are not that many".
   * `worker/routes/cart.ts` raises it from BOTH cart write doors (add an item,
   * change a quantity) and it carried the same defect for the same reason: it
   * was listed in docs/BUNDLES_MYSTERY.md §15.3 as a "reused code, unchanged in
   * meaning", on the premise that a reused code already has a sentence
   * somewhere. It did not. The server's sentence is `Only 2 left`, in English,
   * and `src/pages/Cart.tsx` appended its Arabic counter note to it — so the
   * customer who lost the race read one line in two languages.
   *
   * THIS ENTRY IS THE COUNT-FREE ONE, exactly as OUT_OF_STOCK's is. When the
   * server sends a remainder, `stockRefusal` below builds the counted sentence
   * instead; this is what a mystery-pool member gets, and what the per-order
   * ceiling gets, where there is no remainder to name at all.
   */
  QTY_UNAVAILABLE: {
    ar: 'الكمية المطلوبة غير متاحة حاليًا. قلّل الكمية.',
    en: 'The requested quantity is not available right now. Lower the quantity.',
    ckb: 'ژمارەی داواکراو ئێستا بەردەست نییە. بڕەکە کەم بکەرەوە.',
  },

  // ---- the two counters behind one basket (migration 0075) ----------------
  /**
   * THE ONE REFUSAL A CUSTOMER MUST NOT READ AS "SOLD OUT".
   *
   * 0075 put a second counter behind a model: the shelf a direct sale comes
   * off, and the import quota a pre-order consumes. `PREORDER_CAPACITY_EXHAUSTED`
   * says the QUOTA is full while the shelf may be untouched — a different wait,
   * not a different shop — so the sentence has to say so, and has to point at
   * the thing the customer can still do (another route, or later).
   *
   * It was the only customer-facing code this work added and the only one that
   * never reached this table: `Product.tsx` carries its own Arabic, so the same
   * refusal printed in Arabic on the product page and in the server's raw
   * English on the cart and the checkout, which both decode through
   * `apiRefusal`. In an Arabic-first shop that is the worst sentence to leave
   * in English.
   */
  PREORDER_CAPACITY_EXHAUSTED: {
    ar: 'اكتملت حصة الطلب المسبق لهذا الاختيار — وهذا ليس نفادًا للمخزون. جرّب طريقة شحن أخرى أو عُد لاحقًا.',
    en: 'The pre-order quota for this selection is full — this is not a sold-out shelf. Try another shipping route, or come back later.',
    ckb: 'پشکی پێشداواکاری بۆ ئەم هەڵبژاردەیە تەواو بووە — ئەمە بە واتای نەمانی بەرهەم لە کۆگا نییە. ڕێگایەکی تری ناردن تاقی بکەرەوە، یان دواتر بگەڕێوە.',
  },

  /**
   * THE OTHER THREE WAYS A PRE-ORDER CAN BE REFUSED, and none of them is a
   * shelf either.
   *
   * `saleAvailability` (worker/routes/products.ts) reports exactly four codes
   * for a pre-order it cannot sell: the quota above, plus «the route nobody
   * priced», «no route offered at all» and «pre-order is switched off». The
   * cart printed «نفد المخزون» over all three, which is a sentence about a
   * SHELF said of a line that does not come off one — the same untruth the
   * quota entry above exists to stop, arriving by three other doors. A
   * pre-order line whose admin unprices its route is not a sold-out product,
   * and telling the customer it is makes them give up on something the shop
   * still has.
   *
   * THE WORDING IS NOT NEW AND NOT MACHINE-TRANSLATED. These are the sentences
   * src/pages/Product.tsx has carried by hand in all three languages since
   * 0073 (its `REASONS` tables) — the product page and the cart now say one
   * thing about one refusal, out of one table, rather than two screens each
   * keeping their own copy to drift.
   */
  PREORDER_NOT_ENABLED: {
    ar: 'الطلب المسبق غير مفعّل لهذا المنتج.',
    en: 'Pre-order is not enabled for this product.',
    ckb: 'پێشداواکاری بۆ ئەم بەرهەمە چالاک نەکراوە.',
  },
  NO_TRANSPORT_OFFERED: {
    ar: 'الطلب المسبق مفعّل لكن لا توجد وسيلة نقل معروضة.',
    en: 'Pre-order is enabled but no transport option is offered.',
    ckb: 'پێشداواکاری چالاکە بەڵام هیچ شێوازی گواستنەوە پێشکەش نەکراوە.',
  },
  TRANSPORT_COMMISSION_UNCONFIGURED: {
    ar: 'طريقة الشحن هذه غير متاحة حاليًا.',
    en: 'This shipping route is not available right now.',
    ckb: 'ئەم ڕێگای ناردنە لە ئێستادا بەردەست نییە.',
  },

  // ---- delivery address ---------------------------------------------------
  // Both are raised by `worker/routes/addresses.ts` and reach the customer
  // inside a form they are filling in, so each says what to change.
  INVALID_PHONE: {
    ar: 'رقم الهاتف غير صحيح. اكتب رقمًا يمكن للمندوب الاتصال به، مثال: 07701234567.',
    en: 'That phone number is not valid. Enter a number the courier can call, e.g. 07701234567.',
    ckb: 'ژمارەی تەلەفۆن دروست نییە. ژمارەیەک بنووسە کە گەیێنەر بتوانێت پەیوەندی پێوە بکات، نموونە: 07701234567.',
  },
  GOVERNORATE_REQUIRED: {
    ar: 'اختر المحافظة — التوصيل يُوجَّه على أساسها.',
    en: 'Choose a governorate — delivery is routed by it.',
    ckb: 'پارێزگا هەڵبژێرە — گەیاندن بەپێی ئەو ئاڕاستە دەکرێت.',
  },

  // ---- «وجدتها بمكان أرخص» ------------------------------------------------
  // `worker/routes/priceReports.ts` raises these with an Arabic and an English
  // sentence joined by a slash on ONE line, because the route has no language
  // to answer in. Without an entry here that whole pair is what the customer
  // reads, in the sheet, whichever language they chose — the same defect the
  // cancel sheet records for `MYSTERY_REVEALED_NO_CANCEL`.
  REPORT_ALREADY_OPEN: {
    ar: 'بلاغك عن سعر هذا المنتج وصلنا وقيد المراجعة.',
    en: 'We already have your price report for this product and it is being reviewed.',
    ckb: 'ڕاپۆرتەکەت دەربارەی نرخی ئەم بەرهەمە گەیشتووە و لە پێداچوونەوەدایە.',
  },
  REPORT_BAD_URL: {
    ar: 'الرابط مو صحيح. الصقه كامل مع ‎https://‎ أو اتركه فارغ.',
    en: 'That link is not a valid address. Paste the whole link including https://, or leave it empty.',
    ckb: 'بەستەرەکە دروست نییە. بە تەواوی لەگەڵ ‎https://‎ بیلکێنە، یان بەتاڵی جێبهێڵە.',
  },
  REPORT_BAD_URL_SCHEME: {
    ar: 'نقبل روابط http أو https فقط.',
    en: 'Only http and https links are accepted.',
    ckb: 'تەنها بەستەری http یان https قبوڵ دەکرێت.',
  },

  // ---- custom requests, offers and their escrow (merchant platform wave 1) --
  // Raised by worker/routes/marketplace.ts and printRequests.ts. Each says
  // what the customer or merchant can DO next.
  OFFER_CHANGED: {
    ar: 'غيّر التاجر هذا العرض بعد أن فتحته. راجع الشروط الجديدة قبل القبول.',
    en: 'The merchant changed this offer after you opened it. Review the new terms before accepting.',
    ckb: 'بازرگانەکە دوای ئەوەی کردتەوە ئەم ئۆفەرەی گۆڕی. پێش قبوڵکردن سەیری مەرجە نوێیەکان بکە.',
  },
  OFFER_STALE: {
    ar: 'عدّلتَ طلبك بعد أن قدّم التاجر هذا العرض، فلا يمكن قبوله حتى يؤكده التاجر من جديد.',
    en: 'You changed your request after this offer was made, so it can be accepted once the merchant re-confirms it.',
    ckb: 'دوای ئەوەی بازرگانەکە ئەم ئۆفەرەی پێشکەش کرد داواکارییەکەت دەستکاری کرد، بۆیە تا بازرگانەکە دووبارە پشتڕاستی نەکاتەوە قبوڵ ناکرێت.',
  },
  OFFER_EXPIRED: {
    ar: 'انتهت صلاحية هذا العرض. اختر عرضًا آخر أو اطلب من التاجر عرضًا جديدًا.',
    en: 'This offer has expired. Choose another offer, or ask the merchant for a new one.',
    ckb: 'ماوەی ئەم ئۆفەرە بەسەرچووە. ئۆفەرێکی تر هەڵبژێرە یان داوای ئۆفەرێکی نوێ لە بازرگانەکە بکە.',
  },
  OFFER_NOT_AVAILABLE: {
    ar: 'هذا العرض لم يعد متاحًا — ربما سحبه التاجر. حدّث الصفحة.',
    en: 'This offer is no longer available — the merchant may have withdrawn it. Refresh the page.',
    ckb: 'ئەم ئۆفەرە چیتر بەردەست نییە — لەوانەیە بازرگانەکە کشاندبێتیەوە. پەڕەکە نوێ بکەرەوە.',
  },
  OFFER_EXISTS: {
    ar: 'لديك عرض قائم على هذا الطلب. اسحبه أولًا إن أردت تقديم عرض جديد.',
    en: 'You already have an active offer on this request. Withdraw it first to make a new one.',
    ckb: 'ئۆفەرێکی چالاکت لەسەر ئەم داواکارییە هەیە. ئەگەر دەتەوێت ئۆفەرێکی نوێ بنێریت، سەرەتا بیکشێنەرەوە.',
  },
  OFFER_NOT_STALE: {
    ar: 'عرضك مطابق للطلب بصيغته الحالية، ولا يحتاج إلى تأكيد.',
    en: 'Your offer already matches the request as it is — there is nothing to re-confirm.',
    ckb: 'ئۆفەرەکەت لەگەڵ داواکارییەکە بەم شێوەیەی ئێستای دەگونجێت و پێویستی بە پشتڕاستکردنەوە نییە.',
  },
  OFFER_EXPIRY_INVALID: {
    ar: 'تاريخ صلاحية العرض غير صحيح. اختر تاريخًا قادمًا.',
    en: 'The offer validity date is not valid. Choose a future date.',
    ckb: 'بەرواری کارابوونی ئۆفەرەکە دروست نییە. بەروارێکی داهاتوو هەڵبژێرە.',
  },
  OWN_REQUEST: {
    ar: 'لا يمكنك تقديم عرض على طلبك.',
    en: 'You cannot make an offer on your own request.',
    ckb: 'ناتوانیت ئۆفەر لەسەر داواکاریی خۆت پێشکەش بکەیت.',
  },
  REQUEST_NOT_OPEN: {
    ar: 'هذا الطلب لم يعد يستقبل عروضًا.',
    en: 'This request is no longer taking offers.',
    ckb: 'ئەم داواکارییە چیتر ئۆفەر وەرناگرێت.',
  },
  REQUEST_EXPIRED: {
    ar: 'انتهت مدة هذا الطلب ولم يعد يستقبل عروضًا.',
    en: 'This request has expired and no longer takes offers.',
    ckb: 'ماوەی ئەم داواکارییە بەسەرچووە و چیتر ئۆفەر وەرناگرێت.',
  },
  REQUEST_HAS_ORDER: {
    ar: 'لهذا الطلب تنفيذ مدفوع. ألغِ التنفيذ قبل أن يبدأ التاجر، أو افتح نزاعًا.',
    en: 'This request has a paid order. Cancel the order before the merchant starts, or open a dispute.',
    ckb: 'ئەم داواکارییە جێبەجێکردنێکی پارەدراوی هەیە. پێش ئەوەی بازرگانەکە دەست پێ بکات هەڵیبوەشێنەرەوە، یان ناکۆکییەک بکەرەوە.',
  },
  REQUEST_NOT_CANCELLABLE: {
    ar: 'لا يمكن إلغاء هذا الطلب في حالته الحالية.',
    en: 'This request cannot be cancelled in its current state.',
    ckb: 'لە دۆخی ئێستایدا ئەم داواکارییە هەڵناوەشێتەوە.',
  },
  REQUEST_NOT_EDITABLE: {
    ar: 'لم يعد بالإمكان تعديل مرفقات هذا الطلب.',
    en: 'The attachments of this request can no longer change.',
    ckb: 'چیتر ناتوانرێت پاشکۆکانی ئەم داواکارییە بگۆڕدرێن.',
  },
  REQUEST_CHANGED: {
    ar: 'تغيّر هذا الطلب أثناء العملية. حدّث الصفحة وحاول مرة أخرى.',
    en: 'This request changed while you were working on it. Refresh the page and try again.',
    ckb: 'ئەم داواکارییە لە کاتی کارەکەدا گۆڕا. پەڕەکە نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  },
  ACCEPT_CONFLICT: {
    ar: 'تغيّر الطلب أثناء القبول. حدّث الصفحة وحاول مرة أخرى.',
    en: 'The request changed while you were accepting. Refresh the page and try again.',
    ckb: 'داواکارییەکە لە کاتی قبوڵکردندا گۆڕا. پەڕەکە نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  },
  REQUEST_CLOSED: {
    ar: 'هذا الطلب مغلق، ولم تعد معاينة مجسّمه متاحة.',
    en: 'This request is closed, so its model can no longer be previewed.',
    ckb: 'ئەم داواکارییە داخراوە، بۆیە چیتر پێشبینینی مۆدێلەکەی بەردەست نییە.',
  },
  VIEWER_NOT_ALLOWED: {
    ar: 'المعاينة ثلاثية الأبعاد متاحة لصاحب الطلب وللتجار الذين يمكنهم تقديم عرض عليه.',
    en: 'The 3D preview is available to the request’s owner and to merchants who can make an offer on it.',
    ckb: 'پێشبینینی سێ ڕەهەندی تەنها بۆ خاوەنی داواکارییەکە و ئەو بازرگانانە بەردەستە کە دەتوانن ئۆفەری لەسەر پێشکەش بکەن.',
  },
  // ---- print requests v2 (stream W5-A).
  SOURCE_FILE_REQUIRED: {
    ar: 'أرفق ملف المجسم الذي يدور حوله الطلب، أو اختر مصدرًا آخر.',
    en: 'Attach the model file this request is about, or choose another source.',
    ckb: 'فایلی ئەو مۆدێلەی داواکارییەکە دەربارەیەتی هاوپێچ بکە، یان سەرچاوەیەکی تر هەڵبژێرە.',
  },
  SOURCE_LINK_REQUIRED: {
    ar: 'أضف رابط المجسم، أو اختر مصدرًا آخر.',
    en: 'Add the link to the model, or choose another source.',
    ckb: 'بەستەری مۆدێلەکە زیاد بکە، یان سەرچاوەیەکی تر هەڵبژێرە.',
  },
  SOURCE_IMAGES_REQUIRED: {
    ar: 'أرفق صورة واحدة على الأقل لما تريد طباعته، أو اختر مصدرًا آخر.',
    en: 'Attach at least one picture of what you want printed, or choose another source.',
    ckb: 'لانیکەم یەک وێنە لەوەی دەتەوێت چاپ بکرێت هاوپێچ بکە، یان سەرچاوەیەکی تر هەڵبژێرە.',
  },
  DEADLINE_INVALID: {
    ar: 'اختر موعدًا من اليوم حتى سنة قادمة.',
    en: 'Choose a deadline from today to a year ahead.',
    ckb: 'وادەیەک هەڵبژێرە لە ئەمڕۆوە تا ساڵێکی تر.',
  },
  DIMENSIONS_INVALID: {
    ar: 'كل بُعد بين 1 و5000 ملم. اترك الثلاثة فارغة إن لم تكن متأكدًا.',
    en: 'Each dimension must be between 1 and 5000 mm. Leave all three empty if unsure.',
    ckb: 'هەر ڕەهەندێک دەبێت لە نێوان 1 و 5000 ملم بێت. ئەگەر دڵنیا نیت، هەر سێکیان بەتاڵ جێبهێڵە.',
  },
  REQUEST_NOT_DRAFT: {
    ar: 'نُشر هذا الطلب بالفعل. حدّث الصفحة وعدّله من صفحته.',
    en: 'This request is already published. Refresh and edit it from its page.',
    ckb: 'ئەم داواکارییە پێشتر بڵاوکراوەتەوە. پەڕەکە نوێ بکەرەوە و لە پەڕەکەی خۆیەوە دەستکاری بکە.',
  },
  OFFER_DELIVERY_INVALID: {
    ar: 'اختر طريقة التسليم من القائمة.',
    en: 'Choose the handover method from the list.',
    ckb: 'ڕێگای ڕادەستکردن لە لیستەکە هەڵبژێرە.',
  },
  OFFER_MATERIAL_INVALID: {
    ar: 'اختر حتى 5 مواد من القائمة.',
    en: 'Choose up to 5 materials from the list.',
    ckb: 'هەتا 5 ماددە لە لیستەکە هەڵبژێرە.',
  },
  BAD_URL: {
    ar: 'الرابط غير صالح. الصق رابط التصميم كاملًا مع ‎https://‎.',
    en: 'That link is not valid. Paste the full design link, including https://.',
    ckb: 'بەستەرەکە دروست نییە. بەستەری تەواوی دیزاینەکە لەگەڵ ‎https://‎ بلکێنە.',
  },
  INSUFFICIENT_FUNDS: {
    ar: 'رصيد محفظتك لا يغطي هذا المبلغ. اشحن المحفظة ثم حاول مرة أخرى.',
    en: 'Your wallet balance does not cover this amount. Top up your wallet and try again.',
    ckb: 'باڵانسی جزدانەکەت ئەم بڕە داناپۆشێت. جزدانەکەت پڕ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  },
  ESCROW_FAILED: {
    ar: 'تعذّر حجز المبلغ لهذا العرض. حاول مرة أخرى بعد قليل.',
    en: 'The money for this offer could not be reserved. Try again shortly.',
    ckb: 'نەتوانرا پارەی ئەم ئۆفەرە ڕابگیرێت. کەمێکی تر دووبارە هەوڵ بدەرەوە.',
  },
  ESCROW_RELEASE_FAILED: {
    ar: 'تعذّر تحويل المبلغ للتاجر الآن. حاول مرة أخرى أو تواصل مع الدعم.',
    en: 'The payment to the merchant could not be released right now. Try again, or contact support.',
    ckb: 'ئێستا نەتوانرا پارەکە بۆ بازرگانەکە بنێردرێت. دووبارە هەوڵ بدەرەوە یان پەیوەندی بە پشتگیری بکە.',
  },
  ESCROW_REFUND_FAILED: {
    ar: 'تعذّر إرجاع المبلغ الآن. حاول مرة أخرى أو تواصل مع الدعم.',
    en: 'The refund could not be made right now. Try again, or contact support.',
    ckb: 'ئێستا نەتوانرا پارەکە بگەڕێنرێتەوە. دووبارە هەوڵ بدەرەوە یان پەیوەندی بە پشتگیری بکە.',
  },
  ORDER_SETTLED: {
    ar: 'تمت تسوية هذا الطلب بالفعل. حدّث الصفحة.',
    en: 'This order has already been settled. Refresh the page.',
    ckb: 'ئەم داواکارییە پێشتر یەکلایی کراوەتەوە. پەڕەکە نوێ بکەرەوە.',
  },
  // Wave 1 review (F2, the older NO_PREVIEW): the merchant's «ابدأ العمل» on an
  // order whose money is not held, and a model with no 3D preview.
  ESCROW_NOT_HELD: {
    ar: 'المبلغ غير محجوز لهذا الطلب، لذلك لا يمكن بدء العمل. تواصل مع الدعم.',
    en: 'The money for this order is not held, so work cannot start. Contact support.',
    ckb: 'پارەی ئەم داواکارییە ڕانەگیراوە، بۆیە ناتوانرێت کار دەست پێ بکات. پەیوەندی بە پشتگیری بکە.',
  },
  NO_PREVIEW: {
    ar: 'لا تتوفر معاينة ثلاثية الأبعاد لهذا الملف.',
    en: 'This file has no 3D preview.',
    ckb: 'ئەم فایلە پێشبینینی سێ ڕەهەندیی نییە.',
  },
  // Why a merchant cannot make, edit or re-confirm an offer — the selling gate
  // in worker/lib/merchantAuth.ts, each sanction by its own code. The three the
  // store banner already words (src/components/merchant/StoreCta.tsx) carry
  // that banner's sentences, Sorani included, verbatim; the rest follow this
  // block's rule above.
  MERCHANT_RESTRICTED: {
    ar: 'قيّدت Levonis حساب التاجر: لا يمكنك تقديم عروض جديدة أو تأكيدها حتى يُرفع التقييد. أعمالك المقبولة مستمرة — تواصل مع الدعم.',
    en: 'Levonis has restricted your merchant account: you cannot make or re-confirm offers until the restriction is lifted. Your accepted work continues — contact support.',
    ckb: 'Levonis هەژماری بازرگانییەکەتی سنووردار کردووە: تا سنووردارکردنەکە لانەبرێت ناتوانیت ئۆفەری نوێ پێشکەش بکەیت یان پشتڕاستیان بکەیتەوە. کارە قبوڵکراوەکانت بەردەوام دەبن — پەیوەندی بە پشتگیری بکە.',
  },
  MERCHANT_SUSPENDED: {
    ar: 'المتجر موقوف من إدارة Levonis. تواصل مع الدعم لمعرفة التفاصيل.',
    en: 'This store is suspended by Levonis. Contact support for details.',
    ckb: 'فرۆشگاکە لەلایەن LEVONIS ڕاگیراوە. پەیوەندی بە پشتیوانییەوە بکە.',
  },
  STORE_SUSPENDED: {
    ar: 'المتجر موقوف من إدارة Levonis. تواصل مع الدعم لمعرفة التفاصيل.',
    en: 'This store is suspended by Levonis. Contact support for details.',
    ckb: 'فرۆشگاکە لەلایەن LEVONIS ڕاگیراوە. پەیوەندی بە پشتیوانییەوە بکە.',
  },
  // Store settings (review of the settings screen, 2026-09-28): the screen
  // marks the field itself; these are the sentence any other door shows.
  STORE_FIELD_INVALID: {
    ar: 'أحد الحقول غير صالح أو أطول من المسموح. راجعه ثم احفظ.',
    en: 'One of the fields is not valid or is longer than allowed. Check it, then save.',
    ckb: 'یەکێک لە خانەکان دروست نییە یان لە ڕێگەپێدراو درێژترە. بیپشکنە و پاشان پاشەکەوت بکە.',
  },
  MEDIA_NOT_OWNED: {
    ar: 'اختر صورة رفعتها أنت لهذا المتجر.',
    en: 'Choose a picture you uploaded to this store.',
    ckb: 'وێنەیەک هەڵبژێرە کە خۆت بۆ ئەم فرۆشگایە بارت کردووە.',
  },
  STORE_PAUSED: {
    ar: 'متجرك متوقّف مؤقتًا بطلبك. أعِد فتحه من إعدادات المتجر.',
    en: 'You paused your store. Re-open it from store settings.',
    ckb: 'فرۆشگاکەت لەلایەن خۆتەوە ڕاگیراوە. لە ڕێکخستنەکانەوە بیکەرەوە.',
  },
  SUBSCRIPTION_INACTIVE: {
    ar: 'اشتراك PLUS غير فعّال. متجرك وسجلّه محفوظان — جدّد الاشتراك للبيع من جديد.',
    en: 'Your PLUS subscription is not active. Your store and its history are kept — renew to sell again.',
    ckb: 'ئەندامێتی PLUS چالاک نییە. فرۆشگا و مێژووەکەی پارێزراون — نوێی بکەرەوە بۆ فرۆشتنەوە.',
  },
  // The customer's side: a standing offer from a merchant Levonis has since
  // restricted or suspended cannot be accepted (worker/routes/marketplace.ts).
  MERCHANT_UNAVAILABLE: {
    ar: 'هذا التاجر لا يستقبل أعمالًا جديدة حاليًا. اختر عرضًا آخر.',
    en: 'This merchant is not taking new work right now. Choose another offer.',
    ckb: 'ئەم بازرگانە ئێستا کاری نوێ وەرناگرێت. ئۆفەرێکی تر هەڵبژێرە.',
  },

  // ---- community-store cart, checkout and orders (merchant platform wave 1) --
  // Raised by worker/routes/cart.ts, storeOrders.ts, orders.ts, returns.ts and
  // the merchant's order door in merchant.ts.
  // The store's conversation (docs/COMMUNITY_COMMERCE_CHAT.md): a card names an
  // entity of THIS thread or it is refused.
  CARD_NOT_IN_THREAD: {
    ar: 'هذا العنصر ليس من هذه المحادثة، فلا يمكن إرساله هنا.',
    en: 'This item is not part of this conversation, so it cannot be sent here.',
    ckb: 'ئەم بابەتە بەشێک نییە لەم گفتوگۆیە، بۆیە لێرە نانێردرێت.',
  },
  CARD_NOT_ALLOWED_HERE: {
    ar: 'البطاقات تُرسل في المحادثة مع متجر فقط.',
    en: 'Cards can only be sent in a conversation with a store.',
    ckb: 'کارتەکان تەنها لە گفتوگۆ لەگەڵ فرۆشگایەک دەنێردرێن.',
  },
  CARD_NOT_ALLOWED: {
    ar: 'لا يرسل البطاقات هنا إلا الزبون والمتجر.',
    en: 'Only the customer and the store send cards here.',
    ckb: 'لێرە تەنها کڕیار و فرۆشگاکە کارت دەنێرن.',
  },
  CARD_TYPE_UNSUPPORTED: {
    ar: 'لا يمكن إرسال هذه البطاقة بهذه الطريقة.',
    en: 'That card cannot be sent this way.',
    ckb: 'ئەم کارتە بەم شێوەیە نانێردرێت.',
  },
  CUSTOM_PRODUCT_LOCKED: {
    ar: 'هذا منتج خاص صُنع لزبون واحد، ولا يُعدَّل. ألغه من المحادثة وأرسل منتجًا جديدًا.',
    en: 'This is a private product made for one customer and cannot be changed. Cancel it from the conversation and send a new one.',
    ckb: 'ئەمە بەرهەمێکی تایبەتە کە بۆ یەک کڕیار دروستکراوە و دەستکاری ناکرێت. لە گفتوگۆکەوە هەڵیبوەشێنەرەوە و بەرهەمێکی نوێ بنێرە.',
  },
  QUOTE_ALREADY_ACCEPTED: {
    ar: 'قبل الزبون هذا العرض وطلبه قيد التنفيذ، فلا يتحول إلى منتج خاص.',
    en: 'The customer accepted this quote and its order is under way, so it cannot become a private product.',
    ckb: 'کڕیارەکە ئەم ئۆفەرەی قبوڵ کردووە و داواکارییەکەی لە جێبەجێکردندایە، بۆیە ناکرێت بە بەرهەمی تایبەت.',
  },
  STORE_NOT_SELLING: {
    ar: 'متجرك لا يبيع المنتجات الآن. فعّل البيع من إعدادات المتجر أولًا.',
    en: 'Your store is not selling products right now. Turn selling on in the store settings first.',
    ckb: 'فرۆشگاکەت ئێستا بەرهەم نافرۆشێت. سەرەتا لە ڕێکخستنەکانی فرۆشگاوە فرۆشتن چالاک بکە.',
  },
  STORE_NO_CUSTOM_REQUESTS: {
    ar: 'هذا المتجر لا يستقبل طلبات الطباعة المخصصة حاليًا.',
    en: 'This store is not taking custom print requests right now.',
    ckb: 'ئەم فرۆشگایە ئێستا داواکاریی چاپی تایبەت وەرناگرێت.',
  },
  IMAGE_NOT_OWNED: {
    ar: 'اختر صورة رفعتها إلى متجرك.',
    en: 'Choose a picture you uploaded to your store.',
    ckb: 'وێنەیەک هەڵبژێرە کە بۆ فرۆشگاکەت بارت کردووە.',
  },
  CLIENT_ID_REUSED: {
    ar: 'هذا الإرسال استُخدم لرسالة أخرى. أغلق النافذة وافتحها من جديد.',
    en: 'This send was already used for another message. Close the window and open it again.',
    ckb: 'ئەم ناردنە پێشتر بۆ نامەیەکی تر بەکارهاتووە. پەنجەرەکە دابخە و دووبارە بیکەرەوە.',
  },
  PRODUCT_NOT_PUBLISHED: {
    ar: 'هذا المنتج غير منشور الآن، فلا يمكن إرساله.',
    en: 'This product is not published right now, so it cannot be sent.',
    ckb: 'ئەم بەرهەمە ئێستا بڵاو نەکراوەتەوە، بۆیە نانێردرێت.',
  },
  CART_EMPTY: {
    ar: 'سلتك فارغة. أضف منتجًا ثم أكمل الطلب.',
    en: 'Your cart is empty. Add a product, then check out.',
    ckb: 'سەبەتەکەت بەتاڵە. بەرهەمێک زیاد بکە و پاشان داواکارییەکە تەواو بکە.',
  },
  CART_SELLER_CONFLICT: {
    ar: 'سلتك تضم منتجات من أكثر من بائع. أبقِ منتجات بائع واحد ثم أكمل الطلب.',
    en: 'Your cart holds items from more than one seller. Keep one seller’s items, then check out.',
    ckb: 'سەبەتەکەت بەرهەمی زیاتر لە فرۆشیارێکی تێدایە. تەنها بەرهەمەکانی یەک فرۆشیار بهێڵەرەوە و پاشان داواکارییەکە تەواو بکە.',
  },
  STORE_CLOSED: {
    ar: 'هذا المتجر لا يستقبل طلبات حاليًا. جرّب لاحقًا.',
    en: 'This store is not taking orders right now. Try again later.',
    ckb: 'ئەم فرۆشگایە ئێستا داواکاری وەرناگرێت. دواتر هەوڵ بدەرەوە.',
  },
  OWN_STORE_PURCHASE: {
    ar: 'لا يمكنك الشراء من متجرك.',
    en: 'You cannot buy from your own store.',
    ckb: 'ناتوانیت لە فرۆشگاکەی خۆت بکڕیت.',
  },
  PRODUCT_UNAVAILABLE: {
    ar: 'أحد المنتجات لم يعد متاحًا. احذفه من السلة للمتابعة.',
    en: 'One of the items is no longer available. Remove it from the cart to continue.',
    ckb: 'یەکێک لە بەرهەمەکان چیتر بەردەست نییە. بۆ بەردەوامبوون لە سەبەتەکە لایببە.',
  },
  OPTION_UNAVAILABLE: {
    ar: 'الخيار الذي اخترته لأحد المنتجات لم يعد متاحًا. احذف المنتج ثم أضفه من جديد.',
    en: 'An option you chose is no longer offered. Remove the item, then add it again.',
    ckb: 'هەڵبژاردەیەک کە هەڵتبژاردووە چیتر پێشکەش ناکرێت. بەرهەمەکە لاببە و پاشان دووبارە زیادی بکەرەوە.',
  },
  OPTION_INVALID: {
    ar: 'هذا الخيار غير متاح لهذا المنتج. اختر من الخيارات المعروضة.',
    en: 'That option is not offered for this product. Choose one of the options shown.',
    ckb: 'ئەم هەڵبژاردەیە بۆ ئەم بەرهەمە پێشکەش ناکرێت. یەکێک لە هەڵبژاردە پیشاندراوەکان هەڵبژێرە.',
  },
  COLOR_INVALID: {
    ar: 'هذا اللون غير متاح لهذا المنتج. اختر من الألوان المعروضة.',
    en: 'That colour is not offered for this product. Choose one of the colours shown.',
    ckb: 'ئەم ڕەنگە بۆ ئەم بەرهەمە پێشکەش ناکرێت. یەکێک لە ڕەنگە پیشاندراوەکان هەڵبژێرە.',
  },
  COUPON_EXHAUSTED: {
    ar: 'نفد هذا الكوبون للتو. أزِله ثم أكّد الطلب.',
    en: 'This coupon has just run out. Remove it, then place the order.',
    ckb: 'ئەم کۆپۆنە تازە تەواو بوو. لایببە و پاشان داواکارییەکە بنێرە.',
  },
  QUOTE_CHANGED: {
    ar: 'تغيّر السعر منذ أن عُرض عليك. راجع الإجمالي الجديد ثم أكّد مرة أخرى.',
    en: 'The price changed since it was shown to you. Review the new total, then confirm again.',
    ckb: 'نرخەکە لەو کاتەوەی پیشانت درا گۆڕاوە. کۆی گشتیی نوێ ببینە و پاشان دووبارە پشتڕاستی بکەرەوە.',
  },
  STORE_PREPAID_ONLY: {
    ar: 'طلبات متاجر المجتمع تُدفع من محفظتك قبل أن يشحنها المتجر.',
    en: 'Community-store orders are paid from your wallet before the store ships them.',
    ckb: 'داواکارییەکانی فرۆشگاکانی کۆمەڵگا پێش ئەوەی فرۆشگاکە بیاننێرێت لە جزدانەکەتەوە پارەیان دەدرێت.',
  },
  RECEIPT_NOT_APPLICABLE: {
    ar: 'تأكيد الاستلام خاص بطلبات متاجر المجتمع.',
    en: 'Confirming receipt applies to community-store orders only.',
    ckb: 'پشتڕاستکردنەوەی وەرگرتن تەنها بۆ داواکارییەکانی فرۆشگاکانی کۆمەڵگایە.',
  },
  ORDER_NOT_DELIVERED: {
    ar: 'لم يُسلَّم هذا الطلب بعد. يمكنك ذلك بعد أن تصبح حالته «تم التسليم».',
    en: 'This order has not been delivered yet. You can do this once it is marked delivered.',
    ckb: 'ئەم داواکارییە هێشتا نەگەیەندراوە. کاتێک دۆخەکەی بوو بە «گەیەندرا» دەتوانیت ئەمە بکەیت.',
  },
  STORE_ORDER_RETURN_VIA_SUPPORT: {
    ar: 'إرجاع طلبات المتاجر يتم عبر الدعم. افتح تذكرة من صفحة الطلب.',
    en: 'Returns for store orders go through support. Open a ticket from the order page.',
    ckb: 'گەڕاندنەوەی داواکارییەکانی فرۆشگاکان لە ڕێگەی پشتگیرییەوە دەکرێت. لە پەڕەی داواکارییەکەوە تیکێتێک بکەرەوە.',
  },
  ORDER_CHANGED: {
    ar: 'تغيّر هذا الطلب أثناء عملك عليه. حدّث الصفحة ثم حاول مرة أخرى.',
    en: 'This order changed while you were working on it. Refresh the page, then try again.',
    ckb: 'ئەم داواکارییە لە کاتی کارکردنت لەسەری گۆڕا. پەڕەکە نوێ بکەرەوە و پاشان دووبارە هەوڵ بدەرەوە.',
  },
  ORDER_TRANSITION_INVALID: {
    ar: 'لا يمكن نقل الطلب إلى هذه الحالة من حالته الحالية. حدّث الصفحة.',
    en: 'The order cannot move to that status from where it is now. Refresh the page.',
    ckb: 'ناتوانرێت داواکارییەکە لە دۆخی ئێستایەوە بۆ ئەم دۆخە بگوازرێتەوە. پەڕەکە نوێ بکەرەوە.',
  },
  // The orders list's bulk move and the ship-with-tracking sheet (merchant
  // platform v2 §4.2; worker/routes/merchantOrders.ts, merchant.ts).
  BULK_TOO_MANY: {
    ar: 'حدّد 50 طلبًا على الأكثر في المرة الواحدة.',
    en: 'Select at most 50 orders at a time.',
    ckb: 'لە هەر جارێکدا زۆرترین ٥٠ داواکاری هەڵبژێرە.',
  },
  BULK_CANCEL_NOT_ALLOWED: {
    ar: 'الإلغاء يُعيد المال للزبون، لذا يتم طلبًا طلبًا من صفحة الطلب.',
    en: 'A cancellation refunds the customer, so it is done one order at a time from the order page.',
    ckb: 'هەڵوەشاندنەوە پارە بۆ کڕیار دەگەڕێنێتەوە، بۆیە یەک بە یەک لە پەڕەی داواکارییەکەوە دەکرێت.',
  },
  TRACKING_NO_TOO_LONG: {
    ar: 'رقم التتبع طويل — 60 حرفًا على الأكثر.',
    en: 'The tracking number is too long — at most 60 characters.',
    ckb: 'ژمارەی بەدواداچوون درێژە — زۆرترین ٦٠ پیت.',
  },
  // Wave 1 review: the store cart's own "gone" (the merchant-line quantity
  // door), the wallet reservation a checkout could not make, and a cart another
  // tab already checked out (F7).
  UNAVAILABLE: {
    ar: 'هذا المنتج لم يعد متاحًا. احذفه من السلة للمتابعة.',
    en: 'This product is no longer available. Remove it from the cart to continue.',
    ckb: 'ئەم بەرهەمە چیتر بەردەست نییە. بۆ بەردەوامبوون لە سەبەتەکە لایببە.',
  },
  WALLET_ERROR: {
    ar: 'تعذّر حجز المبلغ من محفظتك الآن. لم يُخصم شيء — حاول مرة أخرى بعد قليل.',
    en: 'The payment could not be reserved from your wallet right now. Nothing was charged — try again shortly.',
    ckb: 'ئێستا نەتوانرا پارەکە لە جزدانەکەت ڕابگیرێت. هیچ پارەیەک نەبڕدرا — کەمێکی تر دووبارە هەوڵ بدەرەوە.',
  },
  CART_CHANGED: {
    ar: 'تغيّرت سلتك أثناء إتمام الطلب — ربما أُكمل الطلب من نافذة أخرى. راجع «طلباتي» قبل المحاولة مجددًا.',
    en: 'Your cart changed while you were checking out — it may have been ordered from another tab. Check your orders before trying again.',
    ckb: 'سەبەتەکەت لە کاتی تەواوکردنی داواکارییەکەدا گۆڕا — لەوانەیە لە پەنجەرەیەکی ترەوە داواکرابێت. پێش ئەوەی دووبارە هەوڵ بدەیتەوە «داواکارییەکانم» ببینە.',
  },
  // Wave 2 (W2-A): the store's delivery is priced from the customer's SAVED
  // address (worker/lib/merchantDelivery.ts). The checkout draws its own panel
  // for these three; these sentences are for any other door that meets them.
  ADDRESS_REQUIRED: {
    ar: 'أضف عنوان التوصيل لإكمال الطلب.',
    en: 'Add a delivery address to finish the order.',
    ckb: 'بۆ تەواوکردنی داواکارییەکە ناونیشانی گەیاندن زیاد بکە.',
  },
  ADDRESS_GOVERNORATE_REQUIRED: {
    ar: 'هذا العنوان بلا محافظة. أضف المحافظة لنعرف أجرة التوصيل.',
    en: 'This address has no governorate. Add it so the delivery can be priced.',
    ckb: 'ئەم ناونیشانە پارێزگای نییە. پارێزگاکە زیاد بکە تا کرێی گەیاندن دیاری بکرێت.',
  },
  DELIVERY_UNAVAILABLE: {
    ar: 'هذا المتجر لا يوصل إلى محافظة هذا العنوان. اختر عنوانًا آخر أو الاستلام من المتجر إن كان متاحًا.',
    en: 'This store does not deliver to that governorate. Choose another address, or pickup if the store offers it.',
    ckb: 'ئەم فرۆشگایە بۆ پارێزگای ئەم ناونیشانە ناگەیەنێت. ناونیشانێکی تر هەڵبژێرە، یان وەرگرتن لە فرۆشگاکە ئەگەر بەردەست بێت.',
  },
  ADDRESS_NOT_FOUND: {
    ar: 'لم نجد هذا العنوان في دفتر عناوينك. اختر عنوانًا آخر.',
    en: 'That address is not in your address book. Choose another.',
    ckb: 'ئەم ناونیشانە لە ناونیشانەکانتدا نییە. ناونیشانێکی تر هەڵبژێرە.',
  },
  // Wave 2 (W2-F): a product sold by VARIANT is added as one of its variants
  // (worker/routes/cart.ts). The storefront product page picks one before the
  // add, so these meet a stale page or another door.
  VARIANT_REQUIRED: {
    ar: 'اختر من خيارات المنتج أولًا (المقاس أو اللون…).',
    en: 'Choose from the product’s options first (size, colour…).',
    ckb: 'سەرەتا لە هەڵبژاردەکانی بەرهەمەکە هەڵبژێرە (قەبارە، ڕەنگ…).',
  },
  VARIANT_INVALID: {
    ar: 'هذا الاختيار لا يخص هذا المنتج. حدّث الصفحة واختر من جديد.',
    en: 'That choice does not belong to this product. Refresh the page and choose again.',
    ckb: 'ئەم هەڵبژاردنە هی ئەم بەرهەمە نییە. پەڕەکە نوێ بکەرەوە و دووبارە هەڵبژێرە.',
  },
  VARIANT_UNAVAILABLE: {
    ar: 'هذا الاختيار لم يعد معروضًا للبيع. اختر خيارًا آخر.',
    en: 'That choice is no longer for sale. Choose another option.',
    ckb: 'ئەم هەڵبژاردنە چیتر بۆ فرۆشتن نییە. هەڵبژاردەیەکی تر هەڵبژێرە.',
  },
  // Wave 3 (W3-B): the analytics page, the order screen and the customers
  // screen (worker/routes/merchantAnalytics.ts, merchantOrders.ts,
  // merchantCustomers.ts). Merchant-facing.
  ORDER_NOT_FOUND: {
    ar: 'لا يوجد طلب بهذا الرقم في متجرك.',
    en: 'There is no order with this number in your store.',
    ckb: 'هیچ داواکارییەک بەم ژمارەیە لە فرۆشگاکەتدا نییە.',
  },
  CUSTOMER_NOT_FOUND: {
    ar: 'هذا الشخص ليس من زبائن متجرك.',
    en: 'This person is not a customer of your store.',
    ckb: 'ئەم کەسە کڕیاری فرۆشگاکەت نییە.',
  },
  BAD_CURSOR: {
    ar: 'تغيّرت القائمة. حدّث الصفحة وحاول مرة أخرى.',
    en: 'The list changed. Refresh the page and try again.',
    ckb: 'لیستەکە گۆڕا. پەڕەکە نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  },
  BAD_RANGE: {
    ar: 'هذه الفترة غير صالحة: اختر بدايةً قبل النهاية، وبحدّ أقصى 366 يومًا.',
    en: 'That range is not valid: choose a start before the end, at most 366 days.',
    ckb: 'ئەم ماوەیە دروست نییە: سەرەتایەک پێش کۆتایی هەڵبژێرە، بە زۆرترین 366 ڕۆژ.',
  },
  ANALYTICS_NOT_INCLUDED: {
    ar: 'الأرقام جزء من LEVO PLUS. جدّد الاشتراك لتعود.',
    en: 'The figures are part of LEVO PLUS. Renew to see them again.',
    ckb: 'ژمارەکان بەشێکن لە LEVO PLUS. بەشداریکردنەکەت نوێ بکەرەوە بۆ ئەوەی دووبارە بیانبینیت.',
  },
  SEARCH_QUERY_TOO_SHORT: {
    ar: 'اكتب حرفين على الأقل للبحث.',
    en: 'Type at least 2 characters to search.',
    ckb: 'بۆ گەڕان لانیکەم 2 پیت بنووسە.',
  },
  // Shared by the workspace searches and the community's unified search
  // (worker/routes/communitySearch.ts, docs/COMMUNITY_ECOSYSTEM.md §9.3 — a
  // community string carries real Sorani, D6).
  SEARCH_QUERY_TOO_LONG: {
    ar: 'نص البحث طويل جدًا — 60 حرفًا على الأكثر.',
    en: 'The search is too long — at most 60 characters.',
    ckb: 'دەقی گەڕان زۆر درێژە — زۆرترین 60 پیت.',
  },
  // «قد يعجبك» asked for something that is not post:<id>, store:<id> or
  // product:<id> (the community search, §9.3).
  RECOMMEND_ANCHOR_INVALID: {
    ar: 'تعذّر اقتراح ما يشبه هذا العنصر.',
    en: 'Nothing to recommend from: that item reference is not valid.',
    ckb: 'نەتوانرا شتی هاوشێوەی ئەم بابەتە پێشنیار بکرێت.',
  },
  // Review W2-5 (admin payout queue): approve / paid refused while a claw-back
  // left the merchant owing the platform. Admin-facing.
  // Review W2-5 p3: public store media (uploads purpose=community). Merchant-
  // facing.
  STORE_REQUIRED: {
    ar: 'افتح متجرك أولًا — صور المتجر وفيديوهاته تخصّ متجرًا.',
    en: 'Open your store first — store pictures and videos belong to a store.',
    ckb: 'سەرەتا فرۆشگاکەت بکەرەوە — وێنە و ڤیدیۆکانی فرۆشگا هی فرۆشگایەکن.',
  },
  // A WARNING, NOT A REFUSAL (perf plan §B.1 #9): the upload succeeded and
  // the file is stored; the MP4's index sits after its frames, so it starts
  // playing only once fully downloaded. The pickers show this as a hint.
  VIDEO_NOT_FASTSTART: {
    ar: 'رُفع الفيديو، لكنه سيبدأ التشغيل بعد تنزيله كاملًا. لتشغيلٍ فوري صدّره من برنامجك بخيار «Fast start» (محسَّن للويب) ثم ارفعه من جديد.',
    en: 'The video was uploaded, but it will start playing only after it has fully downloaded. For instant playback, export it from your editor with “Fast start” (web optimized) and upload it again.',
    ckb: 'ڤیدیۆکە بارکرا، بەڵام تەنها دوای داگرتنی تەواوی دەست بە لێدان دەکات. بۆ لێدانی دەستبەجێ، لە بەرنامەکەتەوە بە هەڵبژاردەی «Fast start» (باشکراو بۆ وێب) هەناردەی بکە و دووبارە باری بکە.',
  },
  VIDEO_QUOTA_EXCEEDED: {
    ar: 'بلغ متجرك حدّ مساحة الفيديو (1 غيغابايت). احذف فيديو لم تعد تستخدمه ثم أعد المحاولة.',
    en: 'Your store has reached its video storage limit (1 GB). Remove a video you no longer use and try again.',
    ckb: 'فرۆشگاکەت گەیشتووەتە سنووری بیرگەی ڤیدیۆ (1 گیگابایت). ڤیدیۆیەک بسڕەوە کە چیتر بەکاری ناهێنیت و دووبارە هەوڵ بدەرەوە.',
  },
  // Owner decision 2026-09-25 (review W2-5 finding 2): a published product
  // costs something, and a store's delivery fee has a platform maximum.
  // PRODUCT_PRICE_REQUIRED reaches a customer at checkout (a product left at
  // 0 IQD is not for sale) and a merchant in the editor.
  PRODUCT_PRICE_REQUIRED: {
    ar: 'هذا المنتج بلا سعر حاليًا فلا يمكن شراؤه. أزله من السلة للمتابعة.',
    en: 'This product has no price right now, so it cannot be bought. Remove it from the cart to continue.',
    ckb: 'ئەم بەرهەمە ئێستا نرخی نییە، بۆیە ناکڕدرێت. بۆ بەردەوامبوون لە سەبەتەکە لایببە.',
  },
  DELIVERY_FEE_ABOVE_MAX: {
    ar: 'أجرة التوصيل أعلى من الحد الذي تسمح به Levonis. خفّضها ثم احفظ.',
    en: 'The delivery fee is above the maximum Levonis allows. Lower it, then save.',
    ckb: 'کرێی گەیاندن لە زۆرترین سنووری ڕێگەپێدراوی Levonis زیاترە. کەمی بکەرەوە و پاشان پاشەکەوت بکە.',
  },
  MERCHANT_IN_DEBT: {
    ar: 'على هذا التاجر دين للمنصة (استُرد مبلغ بعد تحويله إلى رصيده). لا يُوافَق على التحويل ولا يُسجَّل حتى يُغطّى الدين — أو ارفض الطلب ليعود المبلغ إلى رصيده.',
    en: 'This merchant owes the platform (a credit was clawed back). The payout cannot be approved or recorded until the debt is covered — or fail it to return the amount to their balance.',
    ckb: 'ئەم بازرگانە قەرزاری پلاتفۆرمەکەیە (بڕێک دوای خستنە سەر باڵانسەکەی گەڕێنرایەوە). تا قەرزەکە پڕ نەکرێتەوە ناردنی پارەکە پەسەند یان تۆمار ناکرێت — یان داواکارییەکە ڕەت بکەرەوە تا بڕەکە بگەڕێتەوە بۆ باڵانسەکەی.',
  },
  OFFER_NOT_ELIGIBLE: {
    ar: 'ورشتك لا تستطيع تنفيذ هذا الطلب كما هو الآن — راجع الأسباب في بطاقة «ورشتك».',
    en: 'Your workshop cannot make this request as it stands — see the reasons on the “Your workshop” card.',
    ckb: 'وۆرکشۆپەکەت ناتوانێت ئەم داواکارییە وەک ئێستا هەیە جێبەجێ بکات — هۆکارەکان لە کارتی «وۆرکشۆپەکەت» ببینە.',
  },
  FILE_ORIGINAL_RESTRICTED: {
    ar: 'الملف الأصلي يصلك بعد قبول عرضك. قبل ذلك تستطيع معاينة المجسم.',
    en: 'The original file is yours once your offer is accepted. Until then you can preview the model.',
    ckb: 'فایلە ڕەسەنەکە دوای قبوڵکردنی ئۆفەرەکەت دەگاتە دەستت. تا ئەو کاتە دەتوانیت پێشبینینی مۆدێلەکە بکەیت.',
  },
  FILE_NOT_ALLOWED: {
    ar: 'هذا الملف للعميل وللورش التي تستطيع تنفيذ الطلب فقط.',
    en: 'This file is only for the customer and the workshops that can make the request.',
    ckb: 'ئەم فایلە تەنها بۆ کڕیار و ئەو وۆرکشۆپانەیە کە دەتوانن داواکارییەکە جێبەجێ بکەن.',
  },
  COSTING_NOT_ELIGIBLE: {
    ar: 'تحسب الورشة تكلفة طلب تستطيع تنفيذه فقط.',
    en: 'A workshop can only cost a request it can make.',
    ckb: 'وۆرکشۆپ تەنها دەتوانێت تێچووی ئەو داواکارییە حیساب بکات کە دەتوانێت جێبەجێی بکات.',
  },
  COSTING_NO_MODEL: {
    ar: 'لا يوجد مجسم ثلاثي الأبعاد في هذا الطلب لحساب تكلفته.',
    en: 'This request has no 3D model to cost.',
    ckb: 'ئەم داواکارییە هیچ مۆدێلێکی سێ ڕەهەندیی نییە بۆ حیسابکردنی تێچوو.',
  },
  COSTING_NO_PRINTER: {
    ar: 'أضف طابعة أولًا لتحسب التكلفة عليها.',
    en: 'Add a printer first to cost on it.',
    ckb: 'سەرەتا چاپکەرێک زیاد بکە بۆ ئەوەی تێچووی لەسەر حیساب بکەیت.',
  },
  COSTING_RESIN_UNSUPPORTED: {
    ar: 'حساب تكلفة الريزن من الملف غير متاح بعد — اختر طابعة FDM.',
    en: 'Costing resin from the file is not available yet — pick an FDM printer.',
    ckb: 'حیسابکردنی تێچووی ڕێزن لە فایلەکەوە هێشتا بەردەست نییە — چاپکەرێکی FDM هەڵبژێرە.',
  },
  COSTING_MATERIAL_REQUIRED: {
    ar: 'اختر الخامة التي ستطبع بها لتُحسب التكلفة.',
    en: 'Choose the material you will print it in to cost it.',
    ckb: 'ئەو کەرەستەیە هەڵبژێرە کە پێی چاپ دەکەیت بۆ ئەوەی تێچووەکەی حیساب بکرێت.',
  },
  PRINTER_MODEL_UNKNOWN: {
    ar: 'هذه الطابعة غير موجودة في القائمة.',
    en: 'That printer is not in the list.',
    ckb: 'ئەم چاپکەرە لە لیستەکەدا نییە.',
  },
  PRINTER_NOZZLE_INVALID: {
    ar: 'هذه الفوهة لا تركب على هذه الطابعة.',
    en: 'That nozzle does not fit this printer.',
    ckb: 'ئەم نۆزڵە لەگەڵ ئەم چاپکەرە ناگونجێت.',
  },
  PRINTER_HARDENED_UNAVAILABLE: {
    ar: 'هذه الطابعة لا تقبل فوهة مقوّاة.',
    en: 'This printer cannot take a hardened nozzle.',
    ckb: 'ئەم چاپکەرە نۆزڵی پتەوکراو وەرناگرێت.',
  },
  PRINTER_MULTICOLOR_UNAVAILABLE: {
    ar: 'هذه الطابعة لا تطبع أكثر من خامة في المرة.',
    en: 'This printer cannot print several materials at once.',
    ckb: 'ئەم چاپکەرە ناتوانێت لە یەک کاتدا چەند کەرەستەیەک چاپ بکات.',
  },
  PRINTER_MATERIAL_INVALID: {
    ar: 'إحدى الخامات لا تناسب تقنية هذه الطابعة.',
    en: 'One of the materials does not suit this printer’s technology.',
    ckb: 'یەکێک لە کەرەستەکان لەگەڵ تەکنەلۆژیای ئەم چاپکەرە ناگونجێت.',
  },
  PRINTER_DATE_INVALID: {
    ar: 'اكتب تاريخ الشراء بصيغة تاريخ.',
    en: 'Enter the purchase date as a date.',
    ckb: 'بەرواری کڕین بە شێوەی بەروار بنووسە.',
  },
  STOCK_INVALID: {
    ar: 'تعذّر قراءة أسطر المخزون.',
    en: 'The stock lines could not be read.',
    ckb: 'نەتوانرا دێڕەکانی کۆگا بخوێندرێنەوە.',
  },
  STOCK_TOO_MANY: {
    ar: 'عدد أسطر المخزون أكثر من المسموح.',
    en: 'There are more stock lines than allowed.',
    ckb: 'ژمارەی دێڕەکانی کۆگا لە ڕێگەپێدراو زیاترە.',
  },
  STOCK_UNTRACK_CONFIRM: {
    ar: 'تفريغ المخزون يوقف تتبّعه — أكّد ذلك أولًا.',
    en: 'Emptying the stock stops tracking it — confirm that first.',
    ckb: 'بەتاڵکردنی کۆگا بەدواداچوونی ڕادەگرێت — سەرەتا ئەمە پشتڕاست بکەرەوە.',
  },
  STOCK_MATERIAL_INVALID: {
    ar: 'خامة غير معروفة في المخزون.',
    en: 'An unknown material in the stock.',
    ckb: 'کەرەستەیەکی نەناسراو لە کۆگادا هەیە.',
  },
  STOCK_COLOR_INVALID: {
    ar: 'لون غير صالح في المخزون.',
    en: 'An invalid colour in the stock.',
    ckb: 'ڕەنگێکی نادروست لە کۆگادا هەیە.',
  },
  STOCK_GRAMS_INVALID: {
    ar: 'الغرامات يجب أن تكون عددًا صحيحًا.',
    en: 'Grams must be a whole number.',
    ckb: 'گرامەکان دەبێت ژمارەیەکی تەواو بن.',
  },
  STOCK_DUPLICATE: {
    ar: 'الخامة واللون نفسهما مكرران في المخزون.',
    en: 'The same material and colour appear twice.',
    ckb: 'هەمان کەرەستە و ڕەنگ دوو جار هاتوون.',
  },
  // Review of the live merchant platform (F12): the coupon form's refusals,
  // the custom order's lifecycle doors and a customer's cancel after the
  // order moved on.
  BAD_COUPON_CODE: {
    ar: 'رمز الكوبون من 3 إلى 30 حرفًا: أحرف إنجليزية وأرقام وشرطات فقط.',
    en: 'A coupon code is 3–30 characters: letters, numbers and hyphens only.',
    ckb: 'کۆدی کۆپۆن لە 3 تا 30 پیتە: تەنها پیتی ئینگلیزی، ژمارە و هێڵی کورت (-).',
  },
  COUPON_CODE_TAKEN: {
    ar: 'لديك كوبون بهذا الرمز بالفعل. اختر رمزًا آخر.',
    en: 'You already have a coupon with this code. Choose another code.',
    ckb: 'پێشتر کۆپۆنێکت بەم کۆدە هەیە. کۆدێکی تر هەڵبژێرە.',
  },
  CUSTOM_ORDER_CANNOT_START: {
    ar: 'لا يمكن بدء العمل على هذا الطلب في حالته الحالية. حدّث الصفحة.',
    en: 'Work cannot start on this order in its current state. Refresh the page.',
    ckb: 'لە دۆخی ئێستایدا ناتوانرێت کار لەسەر ئەم داواکارییە دەست پێ بکرێت. پەڕەکە نوێ بکەرەوە.',
  },
  CUSTOM_ORDER_CANNOT_DELIVER: {
    ar: 'لا يمكن تسجيل تسليم هذا الطلب في حالته الحالية. حدّث الصفحة.',
    en: 'This order cannot be marked delivered in its current state. Refresh the page.',
    ckb: 'لە دۆخی ئێستایدا ناتوانرێت گەیاندنی ئەم داواکارییە تۆمار بکرێت. پەڕەکە نوێ بکەرەوە.',
  },
  CUSTOM_ORDER_CANNOT_CONFIRM: {
    ar: 'لا يمكن تأكيد استلام هذا الطلب الآن — لم تسلّمه الورشة بعد أو تغيّرت حالته. حدّث الصفحة.',
    en: 'This order cannot be confirmed now — the workshop has not delivered it, or it changed. Refresh the page.',
    ckb: 'ئێستا ناتوانرێت وەرگرتنی ئەم داواکارییە پشتڕاست بکرێتەوە — وۆرکشۆپەکە هێشتا نەیگەیاندووە یان دۆخەکەی گۆڕاوە. پەڕەکە نوێ بکەرەوە.',
  },
  CUSTOM_ORDER_NO_ESCROW: {
    ar: 'لا يوجد مبلغ محجوز لهذا الطلب. تواصل مع الدعم.',
    en: 'There is no held payment for this order. Contact support.',
    ckb: 'هیچ پارەیەکی ڕاگیراو بۆ ئەم داواکارییە نییە. پەیوەندی بە پشتگیری بکە.',
  },
  CUSTOM_ORDER_CANCEL_NEEDS_DISPUTE: {
    ar: 'بدأ العمل على هذا الطلب، فلا يُلغى مباشرة. افتح نزاعًا وستقرّر Levonis.',
    en: 'Work on this order has started, so it cannot simply be cancelled. Open a dispute and Levonis will decide.',
    ckb: 'کار لەسەر ئەم داواکارییە دەستی پێکردووە، بۆیە ڕاستەوخۆ هەڵناوەشێتەوە. ناکۆکییەک بکەرەوە و Levonis بڕیار دەدات.',
  },
  CUSTOM_ORDER_CANNOT_CANCEL: {
    ar: 'لا يمكن إلغاء هذا الطلب في حالته الحالية. حدّث الصفحة.',
    en: 'This order cannot be cancelled in its current state. Refresh the page.',
    ckb: 'لە دۆخی ئێستایدا ناتوانرێت ئەم داواکارییە هەڵبوەشێنرێتەوە. پەڕەکە نوێ بکەرەوە.',
  },
  ORDER_NOT_CANCELLABLE: {
    ar: 'يمكن إلغاء الطلب بنفسك ما دام بانتظار التأكيد فقط. بعد ذلك تواصل مع الدعم.',
    en: 'You can cancel an order yourself only while it is waiting for confirmation. After that, contact support.',
    ckb: 'تەنها تا ئەو کاتەی داواکارییەکە چاوەڕێی پشتڕاستکردنەوەیە دەتوانیت خۆت هەڵیبوەشێنیتەوە. دوای ئەوە پەیوەندی بە پشتگیری بکە.',
  },
  // Catalog discovery (docs/ux/CATALOG_DISCOVERY.md §6, §2): a category link
  // that names no section holding products, and the admin choosing the slug
  // the listing reserves.
  CATALOG_NOT_FOUND: {
    ar: 'هذه الفئة غير موجودة أو لا تحتوي منتجات حاليًا. تصفّح كل الفئات.',
    en: 'This category does not exist or has no products right now. Browse all categories.',
    ckb: 'ئەم پۆلە بوونی نییە یان ئێستا هیچ بەرهەمێکی تێدا نییە. سەیری هەموو پۆلەکان بکە.',
  },
  CATALOG_SLUG_RESERVED: {
    ar: 'الرابط «all» محجوز لصفحة «كل المنتجات» داخل القسم. اختر رابطًا آخر.',
    en: 'The slug “all” is reserved for a section’s “all products” page. Choose another slug.',
    ckb: 'بەستەری «all» بۆ پەڕەی «هەموو بەرهەمەکان»ی ناو بەشەکە تەرخان کراوە. بەستەرێکی تر هەڵبژێرە.',
  },
  // «تعديل السعر النهائي» (migration 0140, worker/lib/orderPriceAdjust.ts).
  PRICE_APPROVAL_PENDING: {
    ar: 'الطلب بانتظار موافقة الزبون على السعر الجديد. اسحب الاقتراح أو انتظر قرار الزبون.',
    en: 'This order is waiting for the customer to approve a new price. Withdraw the proposal or wait for their decision.',
    ckb: 'ئەم داواکارییە چاوەڕێی پەسەندکردنی نرخی نوێیە لەلایەن کڕیارەوە. پێشنیارەکە بکشێنەرەوە یان چاوەڕێی بڕیاری کڕیار بکە.',
  },
  PRICE_ADJUST_STAGE: {
    ar: 'يمكن تعديل السعر قبل شحن الطلب فقط.',
    en: 'The price can only be changed before the order ships.',
    ckb: 'نرخ تەنها پێش ناردنی داواکارییەکە دەگۆڕدرێت.',
  },
  PRICE_ADJUST_FINANCED: {
    ar: 'لا يمكن تعديل سعر طلب بالأقساط (BNPL أو جني).',
    en: 'An instalment order (BNPL or Gini) cannot be re-priced.',
    ckb: 'نرخی داواکارییەکی قیستی (BNPL یان Gini) ناگۆڕدرێت.',
  },
  PRICE_ADJUST_STORE_ORDER: {
    ar: 'هذا طلب من متجر مجتمعي ويسعّره التاجر.',
    en: 'This is a community store order; its merchant sets the price.',
    ckb: 'ئەمە داواکارییەکی فرۆشگای کۆمەڵگایە؛ نرخەکەی بازرگانەکە دیاری دەکات.',
  },
  PRICE_ADJUST_COURIER_BOOKED: {
    ar: 'أُنشئت شحنة التوصيل بمبلغها. ألغِ الشحنة أولًا ثم عدّل السعر.',
    en: 'A courier shipment already carries the amount. Cancel the shipment first, then change the price.',
    ckb: 'باری گەیێنەر پێشتر بەم بڕە تۆمار کراوە. سەرەتا بارەکە هەڵبوەشێنەرەوە و پاشان نرخەکە بگۆڕە.',
  },
  PRICE_ADJUST_INVALID_TOTAL: {
    ar: 'أدخل مبلغًا صحيحًا بالدينار أكبر من صفر.',
    en: 'Enter a whole number of dinars above zero.',
    ckb: 'بڕێکی تەواو بە دینار بنووسە کە لە سفر زیاتر بێت.',
  },
  PRICE_ADJUST_SAME_TOTAL: {
    ar: 'السعر الجديد يساوي السعر الحالي.',
    en: 'The new price is the same as the current one.',
    ckb: 'نرخە نوێیەکە هەمان نرخی ئێستایە.',
  },
  PRICE_ADJUST_UNSUPPORTED_PAYMENT: {
    ar: 'طريقة دفع هذا الطلب لا تسمح بتعديل تلقائي للسعر.',
    en: 'This order’s payment split cannot be re-priced automatically.',
    ckb: 'شێوازی پارەدانی ئەم داواکارییە ڕێگە نادات نرخەکەی بە خۆکاری بگۆڕدرێت.',
  },
  PRICE_ADJUST_NOT_PENDING: {
    ar: 'حُسم اقتراح السعر هذا أو سُحب. حدّث الصفحة.',
    en: 'This price proposal was already decided or withdrawn. Refresh the page.',
    ckb: 'بڕیار لەسەر ئەم پێشنیاری نرخە دراوە یان کشێنراوەتەوە. پەڕەکە نوێ بکەرەوە.',
  },
  PRICE_ADJUST_STALE: {
    ar: 'تغيّر الطلب قبل حفظ القرار. حدّث الصفحة وحاول مرة أخرى.',
    en: 'The order changed before your decision was saved. Refresh and try again.',
    ckb: 'داواکارییەکە پێش پاشەکەوتکردنی بڕیارەکەت گۆڕا. پەڕەکە نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  },
  // «الاستبدال» (migration 0143, worker/lib/tradeIn.ts).
  TRADE_IN_NOT_DELIVERED: {
    ar: 'يمكن استبدال الأجهزة من الطلبات المستلَمة فقط.',
    en: 'Only devices from delivered orders can be traded in.',
    ckb: 'تەنها ئامێرەکانی داواکارییە گەیەندراوەکان دەگۆڕدرێنەوە.',
  },
  TRADE_IN_NOT_ELIGIBLE: {
    ar: 'هذا المنتج غير مشمول بالاستبدال. الاستبدال للطابعات وأجهزة الليزر وAMS والملحقات المشتراة من LEVONIS.',
    en: 'This item is not eligible. Trade-in covers printers, lasers, AMS units and accessories bought from LEVONIS.',
    ckb: 'ئەم بەرهەمە بۆ گۆڕینەوە گونجاو نییە. گۆڕینەوە تەنها بۆ ئەو چاپکەر و ئامێری لەیزەر و AMS و ئێکسسوارانەیە کە لە LEVONIS کڕدراون.',
  },
  TRADE_IN_ALREADY_CLAIMED: {
    ar: 'هذا الجهاز ضمن طلب استبدال آخر. افتح طلباتك للاستبدال لمتابعته.',
    en: 'This device is already part of a trade-in. Open your trade-in requests to follow it.',
    ckb: 'ئەم ئامێرە پێشتر بەشێکە لە داواکارییەکی گۆڕینەوە. داواکارییەکانی گۆڕینەوەت بکەرەوە بۆ بەدواداچوونی.',
  },
  TRADE_IN_RETURN_OPEN: {
    ar: 'على هذا المنتج طلب إرجاع، فلا يمكن استبداله.',
    en: 'This item has a return case, so it cannot be traded in.',
    ckb: 'ئەم بەرهەمە داواکاریی گەڕاندنەوەی لەسەرە، بۆیە ناگۆڕدرێتەوە.',
  },
  TRADE_IN_BELOW_MINIMUM: {
    ar: 'قيمة هذا المنتج أقل من الحد الأدنى للاستبدال.',
    en: 'This item is below the minimum value for a trade-in.',
    ckb: 'بەهای ئەم بەرهەمە لە کەمترین سنووری گۆڕینەوە کەمترە.',
  },
  TRADE_IN_GIFT: {
    ar: 'وصلك هذا الجهاز هدية، والاستبدال للأجهزة التي اشتريتها من LEVONIS.',
    en: 'This device came to you as a gift. Trade-in is for devices you bought from LEVONIS.',
    ckb: 'ئەم ئامێرە وەک دیاری پێت گەیشتووە. گۆڕینەوە بۆ ئەو ئامێرانەیە کە لە LEVONIS کڕیوتن.',
  },
  TRADE_IN_SCOPE_UNAVAILABLE: {
    ar: 'لا يمكن استبدال هذا الجزء وحده لهذا الجهاز. اختر «الجهاز كاملاً».',
    en: 'This part cannot be traded on its own for this device. Choose “the whole device”.',
    ckb: 'ئەم بەشە بە تەنها بۆ ئەم ئامێرە ناگۆڕدرێتەوە. «هەموو ئامێرەکە» هەڵبژێرە.',
  },
  TRADE_IN_DRAFT_LIMIT: {
    ar: 'لديك طلبات استبدال غير مكتملة كثيرة. أكمل أحدها أو ألغه أولاً.',
    en: 'You have too many unfinished trade-in requests. Finish or cancel one first.',
    ckb: 'داواکارییە تەواونەکراوەکانی گۆڕینەوەت زۆرن. سەرەتا یەکێکیان تەواو بکە یان هەڵیبوەشێنەرەوە.',
  },
  TRADE_IN_NOT_EDITABLE: {
    ar: 'أُرسل هذا الطلب ولا يمكن تعديله الآن.',
    en: 'This request was already sent and can no longer be edited.',
    ckb: 'ئەم داواکارییە نێردراوە و چیتر دەستکاری ناکرێت.',
  },
  TRADE_IN_INPUTS_INVALID: {
    ar: 'بعض إجابات حالة الجهاز ناقصة أو غير صحيحة. راجعها ثم أعد المحاولة.',
    en: 'Some answers about the device are missing or invalid. Check them and try again.',
    ckb: 'هەندێک لە وەڵامەکانی دۆخی ئامێرەکە کەمن یان نادروستن. بیانپشکنە و دووبارە هەوڵ بدەرەوە.',
  },
  TRADE_IN_PHOTOS_MISSING: {
    ar: 'بعض الصور الإلزامية ناقصة. ارفع كل الزوايا المطلوبة.',
    en: 'Some required photos are missing. Upload every required angle.',
    ckb: 'هەندێک لە وێنە پێویستەکان کەمن. وێنەی هەموو گۆشە داواکراوەکان بار بکە.',
  },
  TRADE_IN_PHOTO_LIMIT: {
    ar: 'وصلت للحد الأقصى من الصور لهذه الزاوية أو لهذا الطلب. احذف صورة لتضيف غيرها.',
    en: 'You reached the photo limit for this angle or request. Remove one to add another.',
    ckb: 'گەیشتیتە زۆرترین ژمارەی وێنە بۆ ئەم گۆشەیە یان ئەم داواکارییە. یەکێک بسڕەوە بۆ زیادکردنی یەکێکی تر.',
  },
  TRADE_IN_PHOTO_ANGLE: {
    ar: 'هذه الزاوية لا تخص هذا الجهاز.',
    en: 'That photo angle does not apply to this device.',
    ckb: 'ئەم گۆشەی وێنەیە پەیوەندی بەم ئامێرەوە نییە.',
  },
  TRADE_IN_TARGET_REQUIRED: {
    ar: 'اختر الجهاز الجديد أولاً.',
    en: 'Choose the new device first.',
    ckb: 'سەرەتا ئامێرە نوێیەکە هەڵبژێرە.',
  },
  TRADE_IN_TARGET_UNAVAILABLE: {
    ar: 'الجهاز الجديد الذي اخترته غير متاح للبيع المباشر الآن. اختر موديلاً أو جهازاً آخر.',
    en: 'The new device you chose is not available for direct sale right now. Choose another model or device.',
    ckb: 'ئەو ئامێرە نوێیەی هەڵتبژاردووە ئێستا بۆ فرۆشتنی ڕاستەوخۆ بەردەست نییە. مۆدێل یان ئامێرێکی تر هەڵبژێرە.',
  },
  TRADE_IN_BAD_STATE: {
    ar: 'حالة الطلب لا تسمح بهذا الإجراء. حدّث الصفحة.',
    en: 'This request’s status does not allow this action. Refresh the page.',
    ckb: 'دۆخی ئەم داواکارییە ڕێگە بەم کارە نادات. پەڕەکە نوێ بکەرەوە.',
  },
  TRADE_IN_OFFER_STALE: {
    ar: 'تغيّرت القيمة منذ فتحت هذه الصفحة. حدّثها ثم قرّر من جديد.',
    en: 'The value changed since this screen was opened. Refresh and decide again.',
    ckb: 'بەهاکە لەو کاتەوەی ئەم پەڕەیەت کردەوە گۆڕاوە. پەڕەکە نوێ بکەرەوە و دووبارە بڕیار بدە.',
  },
  TRADE_IN_ORDER_ACTIVE: {
    ar: 'استُخدم رصيد هذا الاستبدال في طلب شراء قائم. ألغِ ذلك الطلب أولاً.',
    en: 'An order already used this trade-in credit. Cancel that order first.',
    ckb: 'باڵانسی ئەم گۆڕینەوەیە لە داواکارییەکی کڕینی کراوەدا بەکارهاتووە. سەرەتا ئەو داواکارییە هەڵبوەشێنەرەوە.',
  },
  TRADE_IN_NO_ORDER: {
    ar: 'لم يُنشئ الزبون طلب شراء الجهاز الجديد بعد.',
    en: 'The customer has not placed the order for the new device yet.',
    ckb: 'کڕیارەکە هێشتا داواکاریی کڕینی ئامێرە نوێیەکەی نەناردووە.',
  },
  TRADE_IN_INVALID_VALUE: {
    ar: 'أدخل قيمة صحيحة بالدينار.',
    en: 'Enter a whole number of dinars.',
    ckb: 'بەهایەکی تەواو بە دینار بنووسە.',
  },
  TRADE_IN_RULES_INVALID: {
    ar: 'بعض قيم القواعد غير صحيحة. راجع الحقول المعلَّمة.',
    en: 'Some rule values are invalid. Check the highlighted fields.',
    ckb: 'هەندێک لە بەهاکانی ڕێساکان نادروستن. خانە دیاریکراوەکان بپشکنە.',
  },
  TRADE_IN_COUPON_MISMATCH: {
    ar: 'رصيد الاستبدال يُطبَّق فقط على الجهاز الجديد المختار، بالبيع المباشر، ولصاحب الطلب. تأكد أنه في سلتك.',
    en: 'This trade-in credit applies only to the chosen new device, bought directly, by its owner. Make sure it is in your cart.',
    ckb: 'باڵانسی گۆڕینەوە تەنها بۆ ئامێرە نوێ هەڵبژێردراوەکە بەکاردێت، بە فرۆشتنی ڕاستەوخۆ و بۆ خاوەنی داواکارییەکە. دڵنیابە کە لە سەبەتەکەتدایە.',
  },
  TRADE_IN_STALE: {
    ar: 'تغيّر الطلب أثناء عملك عليه. حدّث الصفحة وحاول مرة أخرى.',
    en: 'The request changed while you were working on it. Refresh and try again.',
    ckb: 'داواکارییەکە لە کاتی کارکردنت لەسەری گۆڕا. پەڕەکە نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  },
  // ---- Community projects (worker/routes/communityPosts.ts) ----------------
  POST_MEDIA_NOT_OWNED: {
    ar: 'هذه الصورة ليست من صورك. ارفع الصورة من جهازك ثم أضفها.',
    en: 'That picture is not one of yours. Upload it from your device, then add it.',
    ckb: 'ئەم وێنەیە هی تۆ نییە. لە ئامێرەکەتەوە باری بکە و پاشان زیادی بکە.',
  },
  POST_MEDIA_TOO_MANY: {
    ar: 'الحد 12 صورة أو فيديو للمشروع الواحد. احذف واحدة لتضيف أخرى.',
    en: 'A project holds up to 12 pictures or videos. Remove one to add another.',
    ckb: 'پڕۆژەیەک تا ١٢ وێنە یان ڤیدیۆ هەڵدەگرێت. یەکێک بسڕەوە بۆ زیادکردنی یەکێکی تر.',
  },
  POST_MEDIA_KIND: {
    ar: 'هذا الملف ليس صورة ولا فيديو مدعومًا.',
    en: 'That file is not a supported picture or video.',
    ckb: 'ئەم فایلە وێنە یان ڤیدیۆیەکی پشتگیریکراو نییە.',
  },
  POST_LINK_NOT_OWNED: {
    ar: 'يمكنك ربط المشروع بمتجرك ومنتجاتك وطلباتك أنت فقط.',
    en: 'A project can link only to your own store, products and jobs.',
    ckb: 'پڕۆژە تەنها دەتوانرێت بە فرۆشگا و بەرهەم و کارەکانی خۆت ببەسترێتەوە.',
  },
  POST_LINK_NOT_FOUND: {
    ar: 'الطابعة أو الخامة المختارة غير موجودة في الكتالوج. اختر من القائمة أو اكتب الاسم.',
    en: 'That printer or material is not in the catalogue. Pick one from the list or type its name.',
    ckb: 'ئەو چاپکەر یان کەرەستەیە لە کەتەلۆگدا نییە. لە لیستەکە هەڵبژێرە یان ناوەکەی بنووسە.',
  },
  POST_SETTING_INVALID: {
    ar: 'أحد إعدادات الطباعة خارج النطاق المعقول. راجع ارتفاع الطبقة ونسبة الملء وقطر الفوهة.',
    en: 'A print setting is out of range. Check the layer height, infill and nozzle size.',
    ckb: 'یەکێک لە ڕێکخستنەکانی چاپ لە دەرەوەی سنوورە. بەرزی چین و ڕێژەی پڕکردنەوە و قەبارەی نۆزڵ بپشکنە.',
  },
  POST_NEEDS_MEDIA: {
    ar: 'أضف صورة واحدة على الأقل قبل النشر.',
    en: 'Add at least one picture before publishing.',
    ckb: 'پێش بڵاوکردنەوە لانیکەم یەک وێنە زیاد بکە.',
  },
  POST_ARCHIVED: {
    ar: 'هذا المشروع مؤرشف. أعِده أولًا لتعدّله.',
    en: 'This project is archived. Restore it first to edit it.',
    ckb: 'ئەم پڕۆژەیە ئەرشیف کراوە. سەرەتا بیگەڕێنەوە بۆ دەستکاریکردنی.',
  },
  POST_PUBLISHED: {
    ar: 'المشروع منشور، فلا يمكن حذفه مباشرة. أرشِفه أولًا ثم احذفه.',
    en: 'A published project cannot be deleted outright. Archive it first, then delete it.',
    ckb: 'پڕۆژەی بڵاوکراوە ڕاستەوخۆ ناسڕدرێتەوە. سەرەتا ئەرشیفی بکە و پاشان بیسڕەوە.',
  },
  POST_HIDDEN_BY_ADMIN: {
    ar: 'أخفت Levonis هذا المشروع، فلا يمكن نشره الآن. راجع السبب في صفحة المشروع.',
    en: 'Levonis hid this project, so it cannot be published now. See the reason on the project page.',
    ckb: 'Levonis ئەم پڕۆژەیەی شاردووەتەوە، بۆیە ئێستا بڵاو ناکرێتەوە. هۆکارەکە لە پەڕەی پڕۆژەکە ببینە.',
  },
  CONSENT_REQUIRED: {
    ar: 'هذه القطعة طُبعت لزبون. ينشر المشروع بعد موافقته — أُرسل إليه طلب الموافقة.',
    en: 'This part was printed for a customer. The project goes public once they allow it — they have been asked.',
    ckb: 'ئەم پارچەیە بۆ کڕیارێک چاپ کراوە. پڕۆژەکە دوای ڕەزامەندی ئەو بڵاو دەبێتەوە — داوای لێکراوە.',
  },
  CONSENT_DECLINED: {
    ar: 'رفض الزبون عرض قطعته. يمكنك نشر المشروع بدون ربطه بطلبه.',
    en: 'The customer declined to have their part shown. You can publish the project without linking it to their job.',
    ckb: 'کڕیارەکە ڕەزامەند نەبوو پارچەکەی پیشان بدرێت. دەتوانیت پڕۆژەکە بەبێ بەستنەوە بە کارەکەی بڵاو بکەیتەوە.',
  },
  CONSENT_NOT_NEEDED: {
    ar: 'هذا المشروع لا يحتاج موافقتك.',
    en: 'This project does not need your consent.',
    ckb: 'ئەم پڕۆژەیە پێویستی بە ڕەزامەندی تۆ نییە.',
  },
  // ---- The social graph (0154; docs/COMMUNITY_ECOSYSTEM.md Phase 2) ------
  // Written from worker/routes/communitySocial.ts (and BLOCKED from the DM
  // door in worker/routes/chats.ts). Real Sorani, per decision D6.
  BLOCKED: {
    ar: 'لا يمكن التفاعل مع هذا الحساب.',
    en: 'You cannot interact with this account.',
    ckb: 'ناتوانیت لەگەڵ ئەم هەژمارە کارلێک بکەیت.',
  },
  CANNOT_FOLLOW_SELF: {
    ar: 'لا يمكنك متابعة نفسك.',
    en: 'You cannot follow yourself.',
    ckb: 'ناتوانیت شوێن خۆت بکەویت.',
  },
  CANNOT_BLOCK_SELF: {
    ar: 'لا يمكنك حظر نفسك أو كتم صوتك.',
    en: 'You cannot block or mute yourself.',
    ckb: 'ناتوانیت خۆت ئاستەنگ بکەیت یان بێدەنگ بکەیت.',
  },
  COMMENT_INDECENT: {
    ar: 'عدّل صياغة التعليق قبل نشره.',
    en: 'Please reword your comment before posting it.',
    ckb: 'تکایە پێش بڵاوکردنەوە دەربڕینی کۆمێنتەکەت بگۆڕە.',
  },
  COMMENT_TOO_FAST: {
    ar: 'انتظر لحظات قبل إرسال تعليق آخر.',
    en: 'Wait a few seconds before commenting again.',
    ckb: 'چەند چرکەیەک چاوەڕێ بکە پێش ئەوەی کۆمێنتێکی تر بنووسیت.',
  },
  REPORT_TARGET_NOT_FOUND: {
    ar: 'لم نجد ما تريد الإبلاغ عنه.',
    en: 'We could not find what you are reporting.',
    ckb: 'ئەوەی دەتەوێت ڕاپۆرتی بکەیت نەدۆزرایەوە.',
  },
  // ---- Resumable uploads (docs/COMMUNITY_ECOSYSTEM.md §9.4, Phase 4a) -------
  // worker/routes/uploadSessions.ts and worker/routes/uploads.ts. The tile
  // (src/components/upload/UploadTile.tsx) shows these under the file name.
  UPLOAD_SESSION_NOT_FOUND: {
    ar: 'انتهت جلسة الرفع أو لم نجدها — ابدأ الرفع من جديد.',
    en: 'This upload session has expired or could not be found — start the upload again.',
    ckb: 'دانیشتنی بارکردن بەسەرچووە یان نەدۆزرایەوە — بارکردنەکە لە سەرەتاوە دەست پێ بکەرەوە.',
  },
  UPLOAD_PART_TOO_LARGE: {
    ar: 'جزء الملف أكبر من الحجم المسموح — حدّث الصفحة وأعد المحاولة.',
    en: 'A part of the file is larger than allowed — refresh the page and try again.',
    ckb: 'بەشێکی فایلەکە لە قەبارەی ڕێگەپێدراو گەورەترە — پەڕەکە نوێ بکەرەوە و دووبارە هەوڵبدەوە.',
  },
  UPLOAD_INCOMPLETE: {
    ar: 'لم تصل كل أجزاء الملف بعد — أكمل الرفع ثم أعد المحاولة.',
    en: 'Not every part of the file has arrived yet — finish uploading and try again.',
    ckb: 'هێشتا هەموو بەشەکانی فایلەکە نەگەیشتوون — بارکردنەکە تەواو بکە و دووبارە هەوڵبدەوە.',
  },
  CHECKSUM_MISMATCH: {
    ar: 'تغيّر الملف أثناء الرفع ولم يُحفظ — أعد رفعه.',
    en: 'The file changed during the upload and was not saved — upload it again.',
    ckb: 'فایلەکە لە کاتی بارکردندا گۆڕا و پاشەکەوت نەکرا — دووبارە باری بکە.',
  },
  ARCHIVE_TOO_DEEP: {
    ar: 'هذا الملف المضغوط كبير جدًا عند فكّه أو يحوي ملفات كثيرة — صدّر المجسّم بملف أصغر.',
    en: 'This archive expands too far or holds too many files — export the model as a smaller file.',
    ckb: 'ئەم فایلە پەستێنراوە کاتێک دەکرێتەوە زۆر گەورە دەبێت یان فایلی زۆری تێدایە — مۆدێلەکە بە فایلێکی بچووکتر دەربکە.',
  },
  UPLOAD_QUOTA_EXCEEDED: {
    ar: 'بلغت حدّ مساحة التخزين لهذا النوع من الملفات — احذف ملفًا لم تعد تحتاجه ثم أعد المحاولة.',
    en: 'You have reached the storage limit for this kind of file — remove a file you no longer need and try again.',
    ckb: 'گەیشتیتە سنووری بیرگەی ئەم جۆرە فایلانە — فایلێک بسڕەوە کە پێویستت پێی نییە و دووبارە هەوڵبدەوە.',
  },
  UPLOAD_TOO_LARGE: {
    ar: 'الملف أكبر من الحد المسموح لهذا النوع من الملفات.',
    en: 'The file is larger than the limit for this kind of file.',
    ckb: 'فایلەکە لە سنووری ڕێگەپێدراوی ئەم جۆرە فایلانە گەورەترە.',
  },
  UPLOAD_KIND_NOT_ALLOWED: {
    ar: 'هذا النوع من الملفات غير مقبول هنا، أو أن محتواه لا يطابق امتداده.',
    en: 'This kind of file is not accepted here, or its contents do not match its name.',
    ckb: 'ئەم جۆرە فایلە لێرە قبوڵ ناکرێت، یان ناوەڕۆکەکەی لەگەڵ ناوەکەی ناگونجێت.',
  },
  // ---- Files on products and posts (§9.4; worker/routes/productFiles.ts,
  //      worker/routes/communityPosts.ts, worker/routes/printRequests.ts) -----
  PRODUCT_FILE_NOT_FOUND: {
    ar: 'لم نجد هذا الملف. ربما أزاله المتجر.',
    en: 'We could not find this file. The store may have removed it.',
    ckb: 'ئەم فایلە نەدۆزرایەوە. لەوانەیە فرۆشگاکە لایبردبێت.',
  },
  PRODUCT_FILE_NOT_GRANTED: {
    ar: 'هذا الملف متاح بعد شراء المنتج. أكمل الشراء ثم عد لتنزيله.',
    en: 'This file is available after you buy the product. Complete the purchase, then come back to download it.',
    ckb: 'ئەم فایلە دوای کڕینی بەرهەمەکە بەردەست دەبێت. کڕینەکە تەواو بکە و پاشان بگەڕێوە بۆ داگرتنی.',
  },
  PRODUCT_FILE_NOT_OWNED: {
    ar: 'هذا الملف ليس من ملفاتك المرفوعة. ارفعه من جهازك ثم أضفه.',
    en: 'That file is not one of your uploads. Upload it from your device, then add it.',
    ckb: 'ئەم فایلە لە بارکراوەکانی تۆ نییە. لە ئامێرەکەتەوە باری بکە و پاشان زیادی بکە.',
  },
  PRODUCT_FILE_LIMIT: {
    ar: 'الحد 12 ملفًا للمنتج الواحد. احذف ملفًا لتضيف آخر.',
    en: 'A product holds up to 12 files. Remove one to add another.',
    ckb: 'بەرهەمێک تا ١٢ فایل هەڵدەگرێت. یەکێک بسڕەوە بۆ زیادکردنی یەکێکی تر.',
  },
  PRODUCT_FILE_ROLE_INVALID: {
    ar: 'اختر دور الملف: معاينة، تنزيل بعد الشراء، مرجع، تعليمات، أو ملف المصدر.',
    en: 'Choose the file’s role: preview, download after purchase, reference, instructions, or source model.',
    ckb: 'ڕۆڵی فایلەکە هەڵبژێرە: پێشبینین، داگرتن دوای کڕین، سەرچاوە، ڕێنمایی، یان فایلی سەرچاوەی مۆدێل.',
  },
  PRODUCT_FILE_ORDER_INVALID: {
    ar: 'أرسل معرّفات الملفات بترتيبها الجديد.',
    en: 'Send the file ids in their new order.',
    ckb: 'ناسنامەی فایلەکان بە ڕیزبەندی نوێیان بنێرە.',
  },
  POST_FILE_LIMIT: {
    ar: 'الحد 3 ملفات للمشروع الواحد. احذف ملفًا لتضيف آخر.',
    en: 'A project holds up to 3 files. Remove one to add another.',
    ckb: 'پڕۆژەیەک تا ٣ فایل هەڵدەگرێت. یەکێک بسڕەوە بۆ زیادکردنی یەکێکی تر.',
  },
  POST_FILE_NOT_OWNED: {
    ar: 'هذا الملف ليس من ملفاتك المرفوعة. ارفعه من جهازك ثم أضفه.',
    en: 'That file is not one of your uploads. Upload it from your device, then add it.',
    ckb: 'ئەم فایلە لە بارکراوەکانی تۆ نییە. لە ئامێرەکەتەوە باری بکە و پاشان زیادی بکە.',
  },
  POST_FILE_KIND: {
    ar: 'ملف المشروع يكون مجسمًا ثلاثي الأبعاد أو مستندًا. الصور تُضاف مع الوسائط.',
    en: 'A project file is a 3D model or a document. Pictures go with the media.',
    ckb: 'فایلی پڕۆژە مۆدێلی سێ ڕەهەندی یان بەڵگەنامەیە. وێنەکان لەگەڵ میدیا زیاد دەکرێن.',
  },
  POST_FILE_NOT_FOUND: {
    ar: 'لم نجد هذا الملف. ربما أزاله صاحب المشروع.',
    en: 'We could not find this file. The maker may have removed it.',
    ckb: 'ئەم فایلە نەدۆزرایەوە. لەوانەیە دروستکەرەکە لایبردبێت.',
  },
  POST_FILE_NOT_DOWNLOADABLE: {
    ar: 'صاحب المشروع لم يُتح تنزيل هذا الملف. يمكنك عرضه ثلاثي الأبعاد فقط.',
    en: 'The maker did not make this file downloadable. You can view it in 3D only.',
    ckb: 'دروستکەرەکە ڕێگەی بە داگرتنی ئەم فایلە نەداوە. تەنها دەتوانیت بە سێ ڕەهەندی بیبینیت.',
  },
  VIEWER_TOKEN_INVALID: {
    ar: 'انتهت صلاحية رابط العرض أو أُغلق. افتح المعاينة من صفحتها مرة أخرى.',
    en: 'This viewer link has expired or was closed. Open the preview from its page again.',
    ckb: 'ماوەی ئەم لینکی بینینە تەواو بووە یان داخراوە. پێشبینینەکە دووبارە لە پەڕەکەیەوە بکەرەوە.',
  },
  // ---- Link cards (§9.4; worker/lib/linkCards.ts, worker/routes/linkCards.ts,
  //      worker/routes/chats.ts) -------------------------------------------------
  LINK_URL_INVALID: {
    ar: 'هذا ليس رابط صفحة ويب. الصق رابطًا يبدأ بـ http أو https.',
    en: 'That is not a web page link. Paste a link that starts with http or https.',
    ckb: 'ئەمە لینکی پەڕەی وێب نییە. لینکێک بلکێنە کە بە http یان https دەست پێ بکات.',
  },
  LINK_HOST_BLOCKED: {
    ar: 'لا يمكن مشاركة هذا العنوان هنا. جرّب رابط الصفحة العامة بدلًا منه.',
    en: 'This address cannot be shared here. Try the public page’s link instead.',
    ckb: 'ئەم ناونیشانە لێرە هاوبەش ناکرێت. لە جیاتی ئەوە لینکی پەڕە گشتییەکە تاقی بکەرەوە.',
  },
  LINK_FETCH_FAILED: {
    ar: 'تعذّر جلب معاينة الصفحة الآن. سيُرسل الرابط باسم موقعه، وتُعاد المحاولة لاحقًا.',
    en: 'The page preview could not be fetched right now. The link is sent with its site’s name and tried again later.',
    ckb: 'پێشبینینی پەڕەکە ئێستا نەهێنرا. لینکەکە بە ناوی ماڵپەڕەکەی دەنێردرێت و دواتر دووبارە هەوڵ دەدرێتەوە.',
  },
  // ---- The request's discussion and the order's timeline (0160; docs/
  //      COMMUNITY_ECOSYSTEM.md §9.5; worker/routes/requestDiscussion.ts,
  //      worker/routes/communityOrderTimeline.ts). Real Sorani, per D6. --------
  COMMENT_KIND_NOT_ALLOWED: {
    ar: 'لا يمكنك إضافة هذا النوع من التعليقات هنا. الأسئلة للورش المؤهلة، والإجابات لصاحب الطلب، والتعليقات ما دام الطلب على اللوحة.',
    en: 'You cannot post this kind of comment here. Questions are for eligible workshops, answers for the request’s owner, and comments while the request is on the board.',
    ckb: 'ناتوانیت ئەم جۆرە کۆمێنتە لێرە بنووسیت. پرسیارەکان بۆ وۆرکشۆپە شیاوەکانن، وەڵامەکان بۆ خاوەنی داواکارییەکە، و کۆمێنتەکان تا داواکارییەکە لەسەر تابلۆکەیە.',
  },
  COMMENT_TOO_LONG: {
    ar: 'التعليق أطول من المسموح (1000 حرف). اختصره ثم أعد الإرسال.',
    en: 'The comment is longer than allowed (1,000 characters). Shorten it and send again.',
    ckb: 'کۆمێنتەکە لە ڕێگەپێدراو درێژترە (١٠٠٠ پیت). کورتی بکەرەوە و دووبارە بینێرە.',
  },
  COMMENT_PARENT_INVALID: {
    ar: 'التعليق الذي تردّ عليه ليس في هذه المناقشة. حدّث الصفحة ثم حاول مجددًا.',
    en: 'The comment you are replying to is not in this discussion. Refresh the page and try again.',
    ckb: 'ئەو کۆمێنتەی وەڵامی دەدەیتەوە لەم گفتوگۆیەدا نییە. پەڕەکە نوێ بکەرەوە و دووبارە هەوڵبدەوە.',
  },
  COMMENT_NOT_FOUND: {
    ar: 'لم نجد هذا التعليق. ربما حُذف.',
    en: 'We could not find this comment. It may have been removed.',
    ckb: 'ئەم کۆمێنتە نەدۆزرایەوە. لەوانەیە سڕابێتەوە.',
  },
  ORDER_UPDATE_KIND_NOT_ALLOWED: {
    ar: 'لا يمكن إضافة هذا التحديث من طرفك الآن. الورشة تكتب التقدّم والصور و«جاهز»، والزبون يطلب التعديل.',
    en: 'This update cannot be posted from your side right now. The workshop posts progress, photos and “ready”; the customer asks for changes.',
    ckb: 'ئەم نوێکردنەوەیە ئێستا لە لایەن تۆوە زیاد ناکرێت. وۆرکشۆپەکە پێشکەوتن و وێنە و «ئامادەیە» دەنووسێت، کڕیارەکە داوای گۆڕانکاری دەکات.',
  },
  ORDER_UPDATE_TOO_LATE: {
    ar: 'فات وقت هذا التحديث: الطلب سُلِّم أو أُغلق. أكّد الاستلام أو افتح نزاعًا إن كانت هناك مشكلة.',
    en: 'It is too late for this update: the order was delivered or closed. Confirm receipt, or open a dispute if something is wrong.',
    ckb: 'کاتی ئەم نوێکردنەوەیە بەسەرچووە: داواکارییەکە گەیەنراوە یان داخراوە. وەرگرتن پشتڕاست بکەرەوە یان ئەگەر کێشەیەک هەیە ناکۆکییەک بکەرەوە.',
  },
  ORDER_UPDATE_TOO_LONG: {
    ar: 'التحديث أطول من المسموح (1000 حرف). اختصره ثم أعد الإرسال.',
    en: 'The update is longer than allowed (1,000 characters). Shorten it and send again.',
    ckb: 'نوێکردنەوەکە لە ڕێگەپێدراو درێژترە (١٠٠٠ پیت). کورتی بکەرەوە و دووبارە بینێرە.',
  },
  ORDER_UPDATE_FILE_NOT_OWNED: {
    ar: 'هذه الصورة ليست من ملفاتك المرفوعة لهذا الطلب. ارفعها من جهازك ثم أضفها.',
    en: 'That picture is not one of your uploads for this order. Upload it from your device, then add it.',
    ckb: 'ئەم وێنەیە لە بارکراوەکانی تۆ بۆ ئەم داواکارییە نییە. لە ئامێرەکەتەوە باری بکە و پاشان زیادی بکە.',
  },
  // ---- Offers V2 and the workshop profile (0159; docs/COMMUNITY_ECOSYSTEM.md
  // §9.5, Phase 5a). Raised by worker/routes/marketplace.ts (the offer
  // composer: fee, files, drafts, send) and worker/routes/merchantPrinters.ts
  // (the workshop's turnaround and intro). Written Sorani, per D6.
  OFFER_FEE_INVALID: {
    ar: 'رسوم التوصيل يجب أن تكون رقمًا صحيحًا بالدينار، صفرًا أو أكثر.',
    en: 'The delivery fee must be a whole number of dinars, zero or more.',
    ckb: 'کرێی گەیاندن دەبێت ژمارەیەکی تەواو بێت بە دینار، سفر یان زیاتر.',
  },
  // A pickup carries no delivery fee (review 2026-09-30) — the composer's rule, held on the server.
  OFFER_PICKUP_FEE: {
    ar: 'الاستلام من الورشة لا يحمل رسوم توصيل — اجعل الرسوم صفرًا أو اختر طريقة توصيل.',
    en: 'A pickup from the workshop carries no delivery fee — set the fee to zero or choose a delivery method.',
    ckb: 'وەرگرتن لە وۆرکشۆپەکە کرێی گەیاندنی نییە — کرێکە بکە بە سفر یان ڕێگایەکی گەیاندن هەڵبژێرە.',
  },
  OFFER_FILE_LIMIT: {
    ar: 'يمكن إرفاق ستة ملفات على الأكثر بالعرض. احذف ملفًا قبل إضافة آخر.',
    en: 'An offer can carry at most six files. Remove one before adding another.',
    ckb: 'زۆرترین شەش فایل دەکرێت لەگەڵ ئۆفەرەکە بنێردرێت. یەکێک بسڕەوە پێش ئەوەی یەکێکی تر زیاد بکەیت.',
  },
  OFFER_FILE_NOT_OWNED: {
    ar: 'هذا الملف ليس من ملفاتك المرفوعة للعرض. ارفعه من جديد من نموذج العرض.',
    en: 'This file is not one you uploaded for an offer. Upload it again from the offer form.',
    ckb: 'ئەم فایلە لە فایلە بارکراوەکانی تۆ بۆ ئەم ئۆفەرە نییە. لە فۆڕمی ئۆفەرەکەوە دووبارە باری بکە.',
  },
  OFFER_DRAFT_EXISTS: {
    ar: 'لديك مسودة عرض محفوظة على هذا الطلب. افتحها وعدّلها بدل إنشاء مسودة جديدة.',
    en: 'You already have a saved draft offer on this request. Open and edit it instead of starting another.',
    ckb: 'پێشتر ڕەشنووسێکی ئۆفەرت لەسەر ئەم داواکارییە پاشەکەوت کراوە. بیکەرەوە و دەستکاری بکە لە جیاتی دروستکردنی ڕەشنووسێکی نوێ.',
  },
  OFFER_REQUEST_CLOSED: {
    ar: 'لم يعد هذا الطلب يستقبل عروضًا، فبقيت مسودتك محفوظة دون إرسال.',
    en: 'This request no longer takes offers, so your draft was kept but not sent.',
    ckb: 'ئەم داواکارییە چیتر ئۆفەر وەرناگرێت، بۆیە ڕەشنووسەکەت پاشەکەوت کرا بەڵام نەنێردرا.',
  },
  OFFER_NOT_DRAFT: {
    ar: 'هذا العرض مُرسل بالفعل وليس مسودة. عدّله أو اسحبه من قائمة عروضك.',
    en: 'This offer was already sent and is not a draft. Edit or withdraw it from your offers.',
    ckb: 'ئەم ئۆفەرە پێشتر نێردراوە و ڕەشنووس نییە. لە لیستی ئۆفەرەکانتەوە دەستکاری بکە یان بیکشێنەرەوە.',
  },
  PREFS_TURNAROUND_INVALID: {
    ar: 'مدة التنفيذ المعتادة يجب أن تكون بين يوم واحد و٦٠ يومًا.',
    en: 'The usual turnaround must be between 1 and 60 days.',
    ckb: 'ماوەی ئاسایی جێبەجێکردن دەبێت لە نێوان ١ و ٦٠ ڕۆژدا بێت.',
  },
  PREFS_INTRO_TOO_LONG: {
    ar: 'نبذة الورشة طويلة؛ الحد ٣٠٠ حرف.',
    en: 'The workshop intro is too long; the limit is 300 characters.',
    ckb: 'ناساندنی وۆرکشۆپەکە زۆر درێژە؛ سنوورەکە ٣٠٠ پیتە.',
  },
  // ---- Media everywhere in the store page (P5; docs/MERCHANT_PLATFORM_V2.md
  //      storefront §4.7, sentences verbatim). Raised by
  //      worker/routes/storeLayout.ts: a media slot's weight cap, the poster a
  //      hero / background video needs, a library file still in use. The
  //      {size} / {max} / {where} figures arrive as `details` and the builder
  //      (src/components/merchant/storeDesign/refusal.ts) fills them in.
  LAYOUT_MEDIA_TOO_HEAVY: {
    ar: 'الملف {size} يتجاوز حدّ هذا الموضع ({max}). اضغطه أو اختر ملفًا أخف.',
    en: 'The file is {size}, over this slot\'s {max} limit. Compress it or pick a lighter one.',
    ckb: 'فایلەکە {size}ـە و لە سنووری ئەم شوێنە ({max}) زیاترە. بچووکی بکەرەوە یان فایلێکی سووکتر هەڵبژێرە.',
  },
  LAYOUT_POSTER_REQUIRED: {
    ar: 'اختر صورة ملصق للفيديو حتى يظهر شيء قبل التشغيل.',
    en: 'Pick a poster image so something shows before the video plays.',
    ckb: 'وێنەی پۆستەر بۆ ڤیدیۆکە هەڵبژێرە تا پێش لێدان شتێک دەربکەوێت.',
  },
  MEDIA_IN_USE: {
    ar: 'هذا الملف مستخدم في: {where}. أزله من هناك أولًا.',
    en: 'This file is used in: {where}. Remove it there first.',
    ckb: 'ئەم فایلە بەکارهاتووە لە: {where}. سەرەتا لەوێ لایبە.',
  },
  MEDIA_NOT_FOUND: {
    ar: 'هذا الملف لم يعد في مكتبة متجرك.',
    en: 'This file is no longer in your store\'s library.',
    ckb: 'ئەم فایلە چیتر لە کتێبخانەی فرۆشگاکەتدا نییە.',
  },

  // ---- Gifts (0175, docs/GIFTS_QUICK_BUY.md §1) ----------------------------
  // The gift card on «هداياي», the cart's gift line and the checkout. A gift
  // moves «اختر» → «استرداد» → «أضف إلى السلة» → «تم الطلب»; each sentence
  // names the step the customer can take next.
  GIFT_NOT_FOUND: {
    ar: 'لم نجد هذه الهدية في حسابك.',
    en: 'We could not find this gift on your account.',
    ckb: 'ئەم دیارییە لە هەژمارەکەتدا نەدۆزرایەوە.',
  },
  GIFT_STATE: {
    ar: 'تغيّرت حالة هذه الهدية. حدّث الصفحة لترى حالتها الآن.',
    en: 'This gift has changed. Refresh the page to see where it stands now.',
    ckb: 'دۆخی ئەم دیارییە گۆڕاوە. پەڕەکە نوێ بکەرەوە بۆ بینینی دۆخی ئێستای.',
  },
  GIFT_CHOICE_REQUIRED: {
    ar: 'اختر هديتك أولًا، ثم استردها.',
    en: 'Choose your gift first, then redeem it.',
    ckb: 'سەرەتا دیارییەکەت هەڵبژێرە، پاشان وەریبگرەوە.',
  },
  GIFT_ITEM_UNAVAILABLE: {
    ar: 'هذه الهدية غير متاحة الآن. اختر هدية أخرى من القائمة.',
    en: 'This gift is not available right now. Pick another one from the list.',
    ckb: 'ئەم دیارییە ئێستا بەردەست نییە. دیارییەکی تر لە لیستەکە هەڵبژێرە.',
  },
  GIFT_NOT_REDEEMED: {
    ar: 'استرد الهدية أولًا، ثم أضفها إلى السلة.',
    en: 'Redeem the gift first, then add it to your cart.',
    ckb: 'سەرەتا دیارییەکە وەربگرەوە، پاشان زیادی بکە بۆ سەبەتەکە.',
  },
  GIFT_ALREADY_ORDERED: {
    ar: 'طُلبت هذه الهدية بالفعل ولا يمكن طلبها مرة أخرى.',
    en: 'This gift has already been ordered and cannot be ordered again.',
    ckb: 'ئەم دیارییە پێشتر داواکراوە و ناتوانرێت دووبارە داوا بکرێتەوە.',
  },
  GIFT_NOT_AVAILABLE: {
    ar: 'هذه الهدية لم تعد متاحة. تواصل مع الدعم إن كان ذلك خطأ.',
    en: 'This gift is no longer available. Contact support if this is a mistake.',
    ckb: 'ئەم دیارییە ئیتر بەردەست نییە. ئەگەر هەڵەیە پەیوەندی بە پشتگیرییەوە بکە.',
  },
  GIFT_NOT_ORDERABLE: {
    ar: 'لا يمكن طلب الهدية الآن. حدّث صفحة الهدايا ثم حاول مرة أخرى.',
    en: 'The gift cannot be ordered right now. Refresh your gifts page and try again.',
    ckb: 'ئێستا ناتوانرێت دیارییەکە داوا بکرێت. پەڕەی دیارییەکان نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  },
  GIFT_LINE_LOCKED: {
    ar: 'سطر الهدية ثابت: لا يمكن تغيير كميته أو خياراته. يمكنك حذفه فقط.',
    en: 'A gift line is fixed: its quantity and options cannot change. You can only remove it.',
    ckb: 'هێڵی دیاری جێگیرە: بڕ و هەڵبژاردنەکانی ناگۆڕدرێن. تەنها دەتوانیت لایببەیت.',
  },
  GIFT_SALE_TYPE_UNAVAILABLE: {
    ar: 'نوع البيع المحدد لهذه الهدية غير متاح حاليًا. تواصل مع الدعم.',
    en: 'The sale type set for this gift is not available right now. Contact support.',
    ckb: 'جۆری فرۆشتنی دیاریکراو بۆ ئەم دیارییە ئێستا بەردەست نییە. پەیوەندی بە پشتگیرییەوە بکە.',
  },
  // ---- the pricing programme's refusal contract (S1, master plan §6.1) -----
  ...COST_REFUSALS,
  // ---- Serials at order preparation (0177; owner brief 2026-10-07) ---------
  // Admin screens: the order's «Scan Serial» slots, the camera sheet, the
  // §19 gate and the serial page. The Arabic is the brief's own (§31, §19);
  // worker/lib/serialAssignments.ts sends the code. OWNER_ONLY and
  // IDEMPOTENCY_MISMATCH are the programme contract's codes (COST_REFUSALS,
  // spread above): the serial doors raise them and the client renders the
  // contract's three sentences, so they are not redefined here.
  SERIAL_LINKED: {
    ar: 'تم ربط الرقم التسلسلي بالطلب.',
    en: 'Serial number linked to the order.',
    ckb: 'ژمارە زنجیرەییەکە بە داواکارییەکەوە بەسترا.',
  },
  SERIAL_EXISTING_LINKED: {
    ar: 'الرقم موجود مسبقاً وتم ربطه بهذا الطلب.',
    en: 'This serial was already on record and is now linked to this order.',
    ckb: 'ژمارەکە پێشتر تۆمارکرابوو و ئێستا بەم داواکارییەوە بەسترا.',
  },
  SERIAL_IN_USE: {
    ar: 'هذا الرقم التسلسلي مرتبط بطلب آخر.',
    en: 'This serial number is linked to another order.',
    ckb: 'ئەم ژمارە زنجیرەییە بە داواکارییەکی ترەوە بەستراوە.',
  },
  SERIAL_DELIVERED: {
    ar: 'هذا الجهاز تم تسليمه مسبقاً.',
    en: 'This device has already been delivered.',
    ckb: 'ئەم ئامێرە پێشتر گەیەنراوە.',
  },
  SERIAL_PRODUCT_MISMATCH: {
    ar: 'الرقم التسلسلي لا يطابق هذا المنتج.',
    en: 'This serial number does not match this product.',
    ckb: 'ژمارە زنجیرەییەکە لەگەڵ ئەم بەرهەمە ناگونجێت.',
  },
  SERIALS_REQUIRED: {
    ar: 'تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.',
    en: 'Some units of this order still have no serial number linked.',
    ckb: 'هێشتا ژمارەی زنجیرەیی بە هەندێک یەکەی ئەم داواکارییەوە نەبەستراون.',
  },
  SERIAL_OPTION_MISMATCH: {
    ar: 'الرقم التسلسلي لا يطابق الخيار المطلوب من هذا المنتج.',
    en: 'This serial belongs to a different option of this product.',
    ckb: 'ئەم ژمارە زنجیرەییە هی جۆرێکی تری ئەم بەرهەمەیە.',
  },
  SERIAL_MODEL_MISMATCH: {
    ar: 'الرقم التسلسلي يعود لطراز آخر غير هذا المنتج.',
    en: 'This serial belongs to a different model than this product.',
    ckb: 'ئەم ژمارە زنجیرەییە هی مۆدێلێکی ترە، نەک ئەم بەرهەمە.',
  },
  SERIAL_BATCH_MISMATCH: {
    ar: 'هذا الجهاز من دفعة غير الدفعة المصروفة لهذا الطلب — خذ القطعة من الدفعة المحددة.',
    en: 'This device is from a different batch than the one issued to this order — take the unit from the batch shown.',
    ckb: 'ئەم ئامێرە لە وەجبەیەکی ترە، نەک ئەو وەجبەیەی بۆ ئەم داواکارییە دەرکراوە — یەکەکە لە وەجبە دیاریکراوەکە هەڵبگرە.',
  },
  SERIAL_IN_USE_THIS_ORDER: {
    ar: 'هذا الرقم مربوط بوحدة أخرى في الطلب نفسه.',
    en: 'This serial is already on another unit of this order.',
    ckb: 'ئەم ژمارەیە پێشتر بە یەکەیەکی تری هەمان داواکارییەوە بەستراوە.',
  },
  UNIT_ALREADY_LINKED: {
    ar: 'هذه الوحدة مربوطة برقم آخر — استخدم «تغيير».',
    en: 'This unit already has a serial — use Change.',
    ckb: 'ئەم یەکەیە پێشتر ژمارەیەکی پێوە بەستراوە — «گۆڕین» بەکاربهێنە.',
  },
  ORDER_NOT_PREPARABLE: {
    ar: 'لا يمكن ربط الأرقام التسلسلية في هذه المرحلة من الطلب.',
    en: "Serials can't be linked at this stage of the order.",
    ckb: 'لەم قۆناغەی داواکارییەکەدا ناتوانرێت ژمارەی زنجیرەیی ببەسترێت.',
  },
  SERIAL_NOT_REQUIRED: {
    ar: 'هذا المنتج لا يحتاج رقمًا تسلسليًا.',
    en: "This product doesn't need a serial number.",
    ckb: 'ئەم بەرهەمە پێویستی بە ژمارەی زنجیرەیی نییە.',
  },
  SERIAL_INVALID: {
    ar: 'هذا ليس رقمًا تسلسليًا صالحًا — امسح «Product SN» أو اكتبه كما هو مطبوع.',
    en: "That isn't a valid serial number — scan the Product SN or type it as printed.",
    ckb: 'ئەمە ژمارەیەکی زنجیرەیی دروست نییە — «Product SN» سکان بکە یان وەک چاپکراوە بینووسە.',
  },
  SERIAL_NOT_AVAILABLE: {
    ar: 'هذا الجهاز غير متاح للبيع (ملغى أو في الحجر أو مستبدل).',
    en: "This device isn't available for sale (voided, quarantined or replaced).",
    ckb: 'ئەم ئامێرە بۆ فرۆشتن بەردەست نییە (هەڵوەشێنراوە، لە کەرەنتینەدایە یان گۆڕدراوەتەوە).',
  },
  SERIAL_UNLINKED: {
    ar: 'أُزيل الرقم التسلسلي من الوحدة.',
    en: 'Serial removed from the unit.',
    ckb: 'ژمارە زنجیرەییەکە لە یەکەکە لابرا.',
  },
  SERIAL_ALREADY_ACTIVATED: {
    ar: 'سُلّم هذا الجهاز وبدأ ضمانه — الطريق الآن مرتجع أو استثناء المالك.',
    en: 'This device was delivered and its warranty has started — use a return or an owner override.',
    ckb: 'ئەم ئامێرە گەیەنراوە و گەرەنتییەکەی دەستی پێکردووە — گەڕاندنەوە یان ڕێگەپێدانی خاوەن بەکاربهێنە.',
  },
  SERIAL_ASSIGNMENT_NOT_FOUND: {
    ar: 'لم يُعثر على هذا الربط في الطلب.',
    en: 'This serial link was not found on the order.',
    ckb: 'ئەم بەستنەوەیە لە داواکارییەکەدا نەدۆزرایەوە.',
  },
  SERIAL_LINK_RELEASED: {
    ar: 'أُزيل هذا الربط بعد المسح — امسح الرقم مجددًا.',
    en: 'This link was removed after the scan — scan the serial again.',
    ckb: 'ئەم بەستنەوەیە دوای سکانەکە لابرا — ژمارەکە دووبارە سکان بکە.',
  },
  OVERRIDE_REASON_REQUIRED: {
    ar: 'اكتب سبب الاستثناء (5 أحرف على الأقل).',
    en: 'Write the reason for the override (at least 5 characters).',
    ckb: 'هۆکاری ئەم ڕێگەپێدانە بنووسە (لانیکەم ٥ پیت).',
  },
  OVERRIDE_UNAVAILABLE: {
    ar: 'هذا الاستثناء غير متاح لهذه الحالة.',
    en: "This override isn't available in this case.",
    ckb: 'ئەم ڕێگەپێدانە بۆ ئەم حاڵەتە بەردەست نییە.',
  },
  SERIAL_RACE: {
    ar: 'تغيّر الطلب أثناء المسح — أعد المحاولة.',
    en: 'The order changed while scanning — try again.',
    ckb: 'داواکارییەکە لە کاتی سکانکردندا گۆڕا — دووبارە هەوڵ بدەوە.',
  },
  SERIALS_NOT_INSTALLED: {
    ar: 'ميزة ربط الأرقام التسلسلية لم تُفعّل على قاعدة البيانات بعد.',
    en: "Serial linking isn't installed on the database yet.",
    ckb: 'تایبەتمەندی بەستنی ژمارەی زنجیرەیی هێشتا لەسەر بنکەدراوەکە دانەمەزراوە.',
  },
  WARRANTY_CLOSED: {
    ar: 'أُغلق ضمان هذه الوحدة (مرتجع) — لا يُصدر لها وصل.',
    en: "This unit's warranty was closed (returned) — no receipt can be issued.",
    ckb: 'گەرەنتی ئەم یەکەیە داخراوە (گەڕێنراوەتەوە) — پسووڵەی بۆ دەرناکرێت.',
  },
  RETURN_SERIAL_MISMATCH: {
    ar: 'هذا الرقم التسلسلي ليس جهازًا من هذا البند لدى هذا الزبون.',
    en: "This serial isn't a device of this line for this customer.",
    ckb: 'ئەم ژمارە زنجیرەییە ئامێرێکی ئەم بەندەی ئەم کڕیارە نییە.',
  },
  RETURN_UNIT_MISMATCH: {
    ar: 'هذه الوحدة ليست وحدة مفتوحة من هذا البند.',
    en: "This unit isn't an open unit of this line.",
    ckb: 'ئەم یەکەیە یەکەیەکی کراوەی ئەم بەندە نییە.',
  },
  ITEM_NOT_IN_ORDER: {
    ar: 'هذا المنتج ليس ضمن هذا الطلب.',
    en: 'This item is not part of this order.',
    ckb: 'ئەم بەرهەمە بەشێک نییە لەم داواکارییە.',
  },
};

export type Lang = 'ar' | 'en' | 'ckb';

/**
 * The customer's sentence for a refusal code, or the server's own message when
 * the code is one this table does not own (every reused code — `OUT_OF_STOCK`,
 * `CART_SHIPPING_CONFLICT`, … — already has a sentence elsewhere). Never the
 * bare identifier: that is the failure this table exists to prevent.
 */
export function refusalText(code: string | null | undefined, lang: Lang, fallback = ''): string {
  if (!code) return fallback;
  const entry = REFUSAL_STRINGS[code];
  if (!entry) return fallback;
  return entry[lang] || entry.en;
}

/**
 * THE SAME ANSWER, FOR ANY DOOR THAT CATCHES AN `ApiError`.
 *
 * `refusalText` was wired to exactly one call site, so every other customer
 * door rendered the server's raw sentence: an Arabic or Sorani customer at the
 * last screen before payment read English prose wrapped around an Arabic
 * product name, with the machine code in parentheses. This is the helper each
 * of those doors calls instead — the checkout, the cancel sheet, the returns
 * and price-protection screens, and the bundle page's add-to-cart.
 *
 * It duck-types the error rather than importing `ApiError`, so this module
 * stays dependency-free and cannot introduce an import cycle with `api.ts`.
 */
export function apiRefusal(err: unknown, lang: Lang, fallback = ''): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = e && typeof e.code === 'string' ? e.code : '';
  const message = e && typeof e.message === 'string' && e.message ? e.message : fallback;
  const counted = stockRefusal(err, lang);
  if (counted) return counted;
  return refusalText(code, lang, message || fallback);
}

/** The codes whose refusal can carry a remainder worth naming. `QTY_UNAVAILABLE`
 *  is the cart door's "not that many" and carries `details.available` for the
 *  same reason the order door's `OUT_OF_STOCK` does — see the table entry. */
const COUNTED_STOCK_CODES = new Set(['OUT_OF_STOCK', 'PREORDER_CAPACITY_EXHAUSTED', 'QTY_UNAVAILABLE']);

/**
 * «بقي 2 فقط» — THE NUMBER, IN THE CUSTOMER'S LANGUAGE.
 *
 * The owner's scenario: stock is 3, one customer takes 1, and the second —
 * who put 3 in their basket — presses confirm. The door refuses, and it must
 * say how many are actually left so the customer can lower the quantity
 * rather than guess.
 *
 * The server sends that number as DATA (`details.available`), because a count
 * baked into an English sentence cannot be translated. Returns null whenever
 * there is no number to name — a different code, a `coarse` refusal where
 * naming it would leak a mystery pool's contents, or an older server that
 * sends no details at all — and the caller falls back to the table entry
 * above, which says the same thing without a figure.
 *
 * ZERO IS A REAL ANSWER and reads differently from two: nothing left is an
 * item to remove, some left is a quantity to lower. `available` is checked
 * with `typeof` rather than truthiness for exactly that reason.
 */
export function stockRefusal(err: unknown, lang: Lang): string | null {
  const e = err as { code?: unknown; details?: unknown } | null;
  const code = e && typeof e.code === 'string' ? e.code : '';
  if (!COUNTED_STOCK_CODES.has(code)) return null;
  const details = e && typeof e.details === 'object' && e.details !== null
    ? (e.details as Record<string, unknown>)
    : null;
  if (!details || details.coarse === true) return null;
  const available = details.available;
  if (typeof available !== 'number' || !Number.isFinite(available) || available < 0) return null;
  const n = Math.trunc(available);
  // WHICH COUNTER THE NUMBER CAME OFF, not which code was raised. A pre-order
  // is limited by its IMPORT QUOTA and never by the shelf, so `QTY_UNAVAILABLE`
  // on a pre-order line must not be read out as «لم يبقَ سوى n من هذا المنتج»
  // about a product whose shelf may be full — the same distinction
  // `refuseQty` in worker/routes/cart.ts makes when it picks the counter.
  const preorder = code === 'PREORDER_CAPACITY_EXHAUSTED' || details.preorder === true;
  if (n === 0) {
    if (preorder) {
      return lang === 'en'
        ? 'The pre-order quota for this selection is full — this is not a sold-out shelf.'
        : 'اكتملت حصة الطلب المسبق لهذا الاختيار — وهذا ليس نفادًا للمخزون.';
    }
    return lang === 'en'
      ? 'This item is out of stock. Remove it from the cart to continue.'
      : lang === 'ckb'
        ? 'ئەم بەرهەمە لە کۆگا نەماوە. لە سەبەتەکە لایببە بۆ بەردەوامبوون.'
        : 'نفد مخزون هذا المنتج. أزله من السلة للمتابعة.';
  }
  if (preorder) {
    return lang === 'en'
      ? `Only ${n} pre-order place(s) left — lower the quantity to ${n}.`
      : `بقي ${n} فقط من حصة الطلب المسبق — قلّل الكمية إلى ${n}.`;
  }
  return lang === 'en'
    ? `Only ${n} left in stock — lower the quantity to ${n}.`
    : lang === 'ckb'
      ? `تەنها ${n} لە کۆگا ماوە — بڕەکە بکە بە ${n}.`
      : `لم يبقَ سوى ${n} من هذا المنتج — قلّل الكمية إلى ${n}.`;
}
