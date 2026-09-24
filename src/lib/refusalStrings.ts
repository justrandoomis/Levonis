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
 */
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
    // NO SORANI IS INVENTED HERE. The Kurdish for this sentence is the owner's
    // to write by hand; until they do, the ARABIC above is what a Kurdish
    // reader gets, which is this app's own documented fallback (`loc`) and the
    // same choice `Product.tsx`, `Cart.tsx` and `Checkout.tsx` make for the
    // rest of the 0075 copy. A machine translation of a refusal is not an
    // option in this repo.
    ckb: 'اكتملت حصة الطلب المسبق لهذا الاختيار — وهذا ليس نفادًا للمخزون. جرّب طريقة شحن أخرى أو عُد لاحقًا.',
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
  // what the customer or merchant can DO next. NO SORANI IS INVENTED HERE
  // (docs/DECISIONS.md row 11): until the owner writes it by hand, the ckb slot
  // carries the ARABIC — the app's documented fallback, the same choice
  // PREORDER_CAPACITY_EXHAUSTED above makes.
  // OWNER: Sorani to be written by hand for every entry in this block.
  OFFER_CHANGED: {
    ar: 'غيّر التاجر هذا العرض بعد أن فتحته. راجع الشروط الجديدة قبل القبول.',
    en: 'The merchant changed this offer after you opened it. Review the new terms before accepting.',
    ckb: 'غيّر التاجر هذا العرض بعد أن فتحته. راجع الشروط الجديدة قبل القبول.',
  },
  OFFER_STALE: {
    ar: 'عدّلتَ طلبك بعد أن قدّم التاجر هذا العرض، فلا يمكن قبوله حتى يؤكده التاجر من جديد.',
    en: 'You changed your request after this offer was made, so it can be accepted once the merchant re-confirms it.',
    ckb: 'عدّلتَ طلبك بعد أن قدّم التاجر هذا العرض، فلا يمكن قبوله حتى يؤكده التاجر من جديد.',
  },
  OFFER_EXPIRED: {
    ar: 'انتهت صلاحية هذا العرض. اختر عرضًا آخر أو اطلب من التاجر عرضًا جديدًا.',
    en: 'This offer has expired. Choose another offer, or ask the merchant for a new one.',
    ckb: 'انتهت صلاحية هذا العرض. اختر عرضًا آخر أو اطلب من التاجر عرضًا جديدًا.',
  },
  OFFER_NOT_AVAILABLE: {
    ar: 'هذا العرض لم يعد متاحًا — ربما سحبه التاجر. حدّث الصفحة.',
    en: 'This offer is no longer available — the merchant may have withdrawn it. Refresh the page.',
    ckb: 'هذا العرض لم يعد متاحًا — ربما سحبه التاجر. حدّث الصفحة.',
  },
  OFFER_EXISTS: {
    ar: 'لديك عرض قائم على هذا الطلب. اسحبه أولًا إن أردت تقديم عرض جديد.',
    en: 'You already have an active offer on this request. Withdraw it first to make a new one.',
    ckb: 'لديك عرض قائم على هذا الطلب. اسحبه أولًا إن أردت تقديم عرض جديد.',
  },
  OFFER_NOT_STALE: {
    ar: 'عرضك مطابق للطلب بصيغته الحالية، ولا يحتاج إلى تأكيد.',
    en: 'Your offer already matches the request as it is — there is nothing to re-confirm.',
    ckb: 'عرضك مطابق للطلب بصيغته الحالية، ولا يحتاج إلى تأكيد.',
  },
  OFFER_EXPIRY_INVALID: {
    ar: 'تاريخ صلاحية العرض غير صحيح. اختر تاريخًا قادمًا.',
    en: 'The offer validity date is not valid. Choose a future date.',
    ckb: 'تاريخ صلاحية العرض غير صحيح. اختر تاريخًا قادمًا.',
  },
  OWN_REQUEST: {
    ar: 'لا يمكنك تقديم عرض على طلبك.',
    en: 'You cannot make an offer on your own request.',
    ckb: 'لا يمكنك تقديم عرض على طلبك.',
  },
  REQUEST_NOT_OPEN: {
    ar: 'هذا الطلب لم يعد يستقبل عروضًا.',
    en: 'This request is no longer taking offers.',
    ckb: 'هذا الطلب لم يعد يستقبل عروضًا.',
  },
  REQUEST_EXPIRED: {
    ar: 'انتهت مدة هذا الطلب ولم يعد يستقبل عروضًا.',
    en: 'This request has expired and no longer takes offers.',
    ckb: 'انتهت مدة هذا الطلب ولم يعد يستقبل عروضًا.',
  },
  REQUEST_HAS_ORDER: {
    ar: 'لهذا الطلب تنفيذ مدفوع. ألغِ التنفيذ قبل أن يبدأ التاجر، أو افتح نزاعًا.',
    en: 'This request has a paid order. Cancel the order before the merchant starts, or open a dispute.',
    ckb: 'لهذا الطلب تنفيذ مدفوع. ألغِ التنفيذ قبل أن يبدأ التاجر، أو افتح نزاعًا.',
  },
  REQUEST_NOT_CANCELLABLE: {
    ar: 'لا يمكن إلغاء هذا الطلب في حالته الحالية.',
    en: 'This request cannot be cancelled in its current state.',
    ckb: 'لا يمكن إلغاء هذا الطلب في حالته الحالية.',
  },
  REQUEST_NOT_EDITABLE: {
    ar: 'لم يعد بالإمكان تعديل مرفقات هذا الطلب.',
    en: 'The attachments of this request can no longer change.',
    ckb: 'لم يعد بالإمكان تعديل مرفقات هذا الطلب.',
  },
  REQUEST_CHANGED: {
    ar: 'تغيّر هذا الطلب أثناء العملية. حدّث الصفحة وحاول مرة أخرى.',
    en: 'This request changed while you were working on it. Refresh the page and try again.',
    ckb: 'تغيّر هذا الطلب أثناء العملية. حدّث الصفحة وحاول مرة أخرى.',
  },
  ACCEPT_CONFLICT: {
    ar: 'تغيّر الطلب أثناء القبول. حدّث الصفحة وحاول مرة أخرى.',
    en: 'The request changed while you were accepting. Refresh the page and try again.',
    ckb: 'تغيّر الطلب أثناء القبول. حدّث الصفحة وحاول مرة أخرى.',
  },
  REQUEST_CLOSED: {
    ar: 'هذا الطلب مغلق، ولم تعد معاينة مجسّمه متاحة.',
    en: 'This request is closed, so its model can no longer be previewed.',
    ckb: 'هذا الطلب مغلق، ولم تعد معاينة مجسّمه متاحة.',
  },
  VIEWER_NOT_ALLOWED: {
    ar: 'المعاينة ثلاثية الأبعاد متاحة لصاحب الطلب وللتجار الذين يمكنهم تقديم عرض عليه.',
    en: 'The 3D preview is available to the request’s owner and to merchants who can make an offer on it.',
    ckb: 'المعاينة ثلاثية الأبعاد متاحة لصاحب الطلب وللتجار الذين يمكنهم تقديم عرض عليه.',
  },
  BAD_URL: {
    ar: 'الرابط غير صالح. الصق رابط التصميم كاملًا مع ‎https://‎.',
    en: 'That link is not valid. Paste the full design link, including https://.',
    ckb: 'الرابط غير صالح. الصق رابط التصميم كاملًا مع ‎https://‎.',
  },
  INSUFFICIENT_FUNDS: {
    ar: 'رصيد محفظتك لا يغطي هذا المبلغ. اشحن المحفظة ثم حاول مرة أخرى.',
    en: 'Your wallet balance does not cover this amount. Top up your wallet and try again.',
    ckb: 'رصيد محفظتك لا يغطي هذا المبلغ. اشحن المحفظة ثم حاول مرة أخرى.',
  },
  ESCROW_FAILED: {
    ar: 'تعذّر حجز المبلغ لهذا العرض. حاول مرة أخرى بعد قليل.',
    en: 'The money for this offer could not be reserved. Try again shortly.',
    ckb: 'تعذّر حجز المبلغ لهذا العرض. حاول مرة أخرى بعد قليل.',
  },
  ESCROW_RELEASE_FAILED: {
    ar: 'تعذّر تحويل المبلغ للتاجر الآن. حاول مرة أخرى أو تواصل مع الدعم.',
    en: 'The payment to the merchant could not be released right now. Try again, or contact support.',
    ckb: 'تعذّر تحويل المبلغ للتاجر الآن. حاول مرة أخرى أو تواصل مع الدعم.',
  },
  ESCROW_REFUND_FAILED: {
    ar: 'تعذّر إرجاع المبلغ الآن. حاول مرة أخرى أو تواصل مع الدعم.',
    en: 'The refund could not be made right now. Try again, or contact support.',
    ckb: 'تعذّر إرجاع المبلغ الآن. حاول مرة أخرى أو تواصل مع الدعم.',
  },
  ORDER_SETTLED: {
    ar: 'تمت تسوية هذا الطلب بالفعل. حدّث الصفحة.',
    en: 'This order has already been settled. Refresh the page.',
    ckb: 'تمت تسوية هذا الطلب بالفعل. حدّث الصفحة.',
  },
  // Why a merchant cannot make, edit or re-confirm an offer — the selling gate
  // in worker/lib/merchantAuth.ts, each sanction by its own code. The three the
  // store banner already words (src/components/merchant/StoreCta.tsx) carry
  // that banner's sentences, Sorani included, verbatim; the rest follow this
  // block's rule above.
  MERCHANT_RESTRICTED: {
    ar: 'قيّدت Levonis حساب التاجر: لا يمكنك تقديم عروض جديدة أو تأكيدها حتى يُرفع التقييد. أعمالك المقبولة مستمرة — تواصل مع الدعم.',
    en: 'Levonis has restricted your merchant account: you cannot make or re-confirm offers until the restriction is lifted. Your accepted work continues — contact support.',
    ckb: 'قيّدت Levonis حساب التاجر: لا يمكنك تقديم عروض جديدة أو تأكيدها حتى يُرفع التقييد. أعمالك المقبولة مستمرة — تواصل مع الدعم.',
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
    ckb: 'هذا التاجر لا يستقبل أعمالًا جديدة حاليًا. اختر عرضًا آخر.',
  },

  // ---- community-store cart, checkout and orders (merchant platform wave 1) --
  // Raised by worker/routes/cart.ts, storeOrders.ts, orders.ts, returns.ts and
  // the merchant's order door in merchant.ts. Same rule as the block above: NO
  // SORANI IS INVENTED — the ckb slot carries the ARABIC until the owner writes
  // it by hand (docs/DECISIONS.md row 11).
  // OWNER: Sorani to be written by hand for every entry in this block.
  CART_EMPTY: {
    ar: 'سلتك فارغة. أضف منتجًا ثم أكمل الطلب.',
    en: 'Your cart is empty. Add a product, then check out.',
    ckb: 'سلتك فارغة. أضف منتجًا ثم أكمل الطلب.',
  },
  CART_SELLER_CONFLICT: {
    ar: 'سلتك تضم منتجات من أكثر من بائع. أبقِ منتجات بائع واحد ثم أكمل الطلب.',
    en: 'Your cart holds items from more than one seller. Keep one seller’s items, then check out.',
    ckb: 'سلتك تضم منتجات من أكثر من بائع. أبقِ منتجات بائع واحد ثم أكمل الطلب.',
  },
  STORE_CLOSED: {
    ar: 'هذا المتجر لا يستقبل طلبات حاليًا. جرّب لاحقًا.',
    en: 'This store is not taking orders right now. Try again later.',
    ckb: 'هذا المتجر لا يستقبل طلبات حاليًا. جرّب لاحقًا.',
  },
  OWN_STORE_PURCHASE: {
    ar: 'لا يمكنك الشراء من متجرك.',
    en: 'You cannot buy from your own store.',
    ckb: 'لا يمكنك الشراء من متجرك.',
  },
  PRODUCT_UNAVAILABLE: {
    ar: 'أحد المنتجات لم يعد متاحًا. احذفه من السلة للمتابعة.',
    en: 'One of the items is no longer available. Remove it from the cart to continue.',
    ckb: 'أحد المنتجات لم يعد متاحًا. احذفه من السلة للمتابعة.',
  },
  OPTION_UNAVAILABLE: {
    ar: 'الخيار الذي اخترته لأحد المنتجات لم يعد متاحًا. احذف المنتج ثم أضفه من جديد.',
    en: 'An option you chose is no longer offered. Remove the item, then add it again.',
    ckb: 'الخيار الذي اخترته لأحد المنتجات لم يعد متاحًا. احذف المنتج ثم أضفه من جديد.',
  },
  OPTION_INVALID: {
    ar: 'هذا الخيار غير متاح لهذا المنتج. اختر من الخيارات المعروضة.',
    en: 'That option is not offered for this product. Choose one of the options shown.',
    ckb: 'هذا الخيار غير متاح لهذا المنتج. اختر من الخيارات المعروضة.',
  },
  COLOR_INVALID: {
    ar: 'هذا اللون غير متاح لهذا المنتج. اختر من الألوان المعروضة.',
    en: 'That colour is not offered for this product. Choose one of the colours shown.',
    ckb: 'هذا اللون غير متاح لهذا المنتج. اختر من الألوان المعروضة.',
  },
  COUPON_EXHAUSTED: {
    ar: 'نفد هذا الكوبون للتو. أزِله ثم أكّد الطلب.',
    en: 'This coupon has just run out. Remove it, then place the order.',
    ckb: 'نفد هذا الكوبون للتو. أزِله ثم أكّد الطلب.',
  },
  QUOTE_CHANGED: {
    ar: 'تغيّر السعر منذ أن عُرض عليك. راجع الإجمالي الجديد ثم أكّد مرة أخرى.',
    en: 'The price changed since it was shown to you. Review the new total, then confirm again.',
    ckb: 'تغيّر السعر منذ أن عُرض عليك. راجع الإجمالي الجديد ثم أكّد مرة أخرى.',
  },
  STORE_PREPAID_ONLY: {
    ar: 'طلبات متاجر المجتمع تُدفع من محفظتك قبل أن يشحنها المتجر.',
    en: 'Community-store orders are paid from your wallet before the store ships them.',
    ckb: 'طلبات متاجر المجتمع تُدفع من محفظتك قبل أن يشحنها المتجر.',
  },
  RECEIPT_NOT_APPLICABLE: {
    ar: 'تأكيد الاستلام خاص بطلبات متاجر المجتمع.',
    en: 'Confirming receipt applies to community-store orders only.',
    ckb: 'تأكيد الاستلام خاص بطلبات متاجر المجتمع.',
  },
  ORDER_NOT_DELIVERED: {
    ar: 'لم يُسلَّم هذا الطلب بعد. يمكنك ذلك بعد أن تصبح حالته «تم التسليم».',
    en: 'This order has not been delivered yet. You can do this once it is marked delivered.',
    ckb: 'لم يُسلَّم هذا الطلب بعد. يمكنك ذلك بعد أن تصبح حالته «تم التسليم».',
  },
  STORE_ORDER_RETURN_VIA_SUPPORT: {
    ar: 'إرجاع طلبات المتاجر يتم عبر الدعم. افتح تذكرة من صفحة الطلب.',
    en: 'Returns for store orders go through support. Open a ticket from the order page.',
    ckb: 'إرجاع طلبات المتاجر يتم عبر الدعم. افتح تذكرة من صفحة الطلب.',
  },
  ORDER_CHANGED: {
    ar: 'تغيّر هذا الطلب أثناء عملك عليه. حدّث الصفحة ثم حاول مرة أخرى.',
    en: 'This order changed while you were working on it. Refresh the page, then try again.',
    ckb: 'تغيّر هذا الطلب أثناء عملك عليه. حدّث الصفحة ثم حاول مرة أخرى.',
  },
  ORDER_TRANSITION_INVALID: {
    ar: 'لا يمكن نقل الطلب إلى هذه الحالة من حالته الحالية. حدّث الصفحة.',
    en: 'The order cannot move to that status from where it is now. Refresh the page.',
    ckb: 'لا يمكن نقل الطلب إلى هذه الحالة من حالته الحالية. حدّث الصفحة.',
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
